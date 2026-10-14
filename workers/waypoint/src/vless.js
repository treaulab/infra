// vless.js — VLESS over WebSocket for waypoint.
//
// Adapted from the amclubs reference worker in ~/Safe/cloudflareproxyworker
// ("_worker (copy 1).js": websvcExecutor + websvcStream + handleRequestHeader +
// TCP via cloudflare:sockets + UDP/DNS via DoH). Stripped to VLESS-only:
//   - kept: WS<->stream queue, batched TCP upload, chunked downlink, VLESS
//     header parse, UUID check, early-data (sec-websocket-protocol), DNS(53)
//     over HTTPS.
//   - dropped: Trojan sniffing/dial, SOCKS5 outbound, NAT64/p64 routing,
//     paddr failover/retry, login HTML, KV panels, embedded sha256 blob.
// Outbound policy (blocked/allowed hosts) mirrors worker.js relay guards so
// VLESS cannot be used to bypass them.

import { connect } from "cloudflare:sockets";

// ---- tunables (module scope, env-overridable per call) ----
const WS_OPEN = 1;
const WS_CLOSING = 2;
const UPLOAD_BATCH_TARGET = 20 * 1024;
const UPLOAD_QUEUE_MAX_BYTES = 16 * 1024 * 1024;
const UPLOAD_QUEUE_MAX_ITEMS = 4096;
const DOWNLOAD_CHUNK_MAX = 32 * 1024;
const DOWNLOAD_FLUSH_DELAY_MS = 1;
const UPLOAD_DRAIN_TIMEOUT_MS = 1000;

// Strict v4 (cf. EDT reference): version nibble 4, variant 8/9/a/b.
// Rejects non-conforming UUIDs at config load, so a typo'd VLESS_UUID
// disables VLESS (fail closed) instead of silently never matching.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- config

export function isValidUuid(v) {
  return UUID_RE.test(String(v || "").trim());
}

// Comma-separated UUID allowlist. Empty = VLESS disabled (fail closed).
export function getVlessIds(env) {
  return String(env?.VLESS_UUID || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(isValidUuid);
}

function customPath(env) {
  return String(env?.VLESS_PATH || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
}

// Allowed WS paths: custom VLESS_PATH if set, else /<uuid> for each
// configured id plus a convenience /vless (UUID header is still the auth).
export function vlessPathAllowed(url, env, ids) {
  const path = url.pathname;
  const custom = customPath(env);
  if (custom) return path === `/${custom}`;
  if (path === "/vless") return true;
  const p = path.replace(/^\/+|\/+$/g, "").toLowerCase();
  return ids.includes(p);
}

export function isVlessWsRequest(request, env) {
  const up = request.headers.get("Upgrade") || request.headers.get("upgrade");
  if (String(up || "").toLowerCase() !== "websocket") return false;
  const ids = getVlessIds(env);
  if (!ids.length) return false;
  try {
    return vlessPathAllowed(new URL(request.url), env, ids);
  } catch {
    return false;
  }
}

function dohUrl(env) {
  return (
    env?.VLESS_DOH || env?.DNS_URL || "https://1.1.1.1/dns-query"
  );
}

function connectTimeoutMs(env) {
  const n = parseInt(env?.VLESS_CONNECT_TIMEOUT_MS || "5000", 10);
  if (!Number.isFinite(n)) return 5000;
  return Math.min(Math.max(n, 1000), 10000);
}

function dialConcurrency(env) {
  const n = parseInt(env?.VLESS_DIAL_CONCURRENCY || "2", 10);
  if (!Number.isFinite(n)) return 2;
  return Math.min(Math.max(n, 1), 4);
}

// Opt-in NAT64 fallback for TCP dials (env NAT64_FALLBACK=1). When a direct
// dial fails — or connects but goes silent (e.g. handshake dropped for
// Cloudflare-sourced egress) — the target is re-dialed once via an IPv6
// NAT64 gateway: the gatekeeper sees non-CF IPv6, and the origin sees the
// gateway's exit IP instead of Cloudflare's. Adapted from the amclubs
// reference (P64/p64Prefix); TCP only, single retry, off by default.
// Caveats: third-party gateway dependency (+latency, metadata-visible),
// gateway exit IPs may be refused just the same. Disabled = zero behavior change.
function nat64Enabled(env) {
  return ["1", "true"].includes(String(env?.NAT64_FALLBACK || "").toLowerCase());
}

function nat64Prefix(env) {
  const p = String(env?.NAT64_PREFIX || "2602:fc59:b0:64::").trim();
  return p.includes("::") ? p : "2602:fc59:b0:64::";
}

function parseIpv4(host) {
  const parts = String(host || "").split(".");
  if (parts.length !== 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

// Embed an IPv4 literal into the NAT64 prefix: "1.2.3.4" -> full IPv6 string.
function embedNat64(ipv4, prefix) {
  const nums = parseIpv4(ipv4);
  if (!nums) throw new Error(`invalid IPv4 for NAT64: ${ipv4}`);
  const hex = nums.map((n) => n.toString(16).padStart(2, "0"));
  return `${prefix}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}`.toLowerCase();
}

// Resolve a domain to its first A record via DNS-JSON on the configured DoH.
async function resolveA(host, doh) {
  const sep = doh.includes("?") ? "&" : "?";
  const resp = await fetch(
    `${doh}${sep}name=${encodeURIComponent(host)}&type=A`,
    { headers: { accept: "application/dns-json" } },
  );
  if (!resp.ok) throw new Error(`A-resolve status ${resp.status}`);
  const body = await resp.json();
  const rec = body?.Answer?.find((r) => r.type === 1 && r.data && parseIpv4(r.data));
  if (!rec) throw new Error(`no A record for ${host}`);
  return rec.data;
}

// Map a VLESS target to its NAT64 IPv6 dial address (or throw if ineligible:
// IPv6 targets are already v6; domains need a resolvable A record).
async function nat64DialAddress(host, atyp, doh, prefix) {
  if (atyp === 3) throw new Error("NAT64 inapplicable to IPv6 target");
  const v4 = atyp === 1 ? host : await resolveA(host, doh);
  if (atyp === 1 && !parseIpv4(v4)) throw new Error(`invalid IPv4 target: ${host}`);
  return embedNat64(v4, prefix);
}

// vless:// links for clients (v2rayNG / Nekoray / sing-box import).
// host defaults to the request's own hostname (workers.dev), port 443 + tls.
export function buildVlessLinks(request, env) {
  const ids = getVlessIds(env);
  const url = new URL(request.url);
  const host =
    String(url.searchParams.get("host") || "").trim() || url.hostname;
  const custom = customPath(env);
  const sni = host;
  return ids.map((id) => {
    const path = custom || id;
    const frag = `${url.hostname}-vless`;
    const q = new URLSearchParams({
      encryption: "none",
      security: "tls",
      sni,
      fp: "chrome",
      type: "ws",
      host,
      path: `/${path}`,
    });
    return `vless://${id}@${host}:443?${q.toString()}#${encodeURIComponent(frag)}`;
  });
}

// ---------------------------------------------------------------- entry

// Handles an upgraded VLESS/WebSocket session. Returns the 101 response.
// Throws/closes on auth or policy failure; caller maps that to 401/403/500
// for the initial handshake only (post-accept failures just close the WS).
export async function handleVlessWs(request, env, ctx, opts = {}) {
  const ids = getVlessIds(env);
  if (!ids.length) {
    return new Response("vless disabled", { status: 404 });
  }
  const url = new URL(request.url);
  if (!vlessPathAllowed(url, env, ids)) {
    return new Response("not found", { status: 404 });
  }

  const cfg = opts.cfg || { allowedHosts: [], extraBlockedHosts: [] };
  const selfHost = opts.selfHost || url.hostname;
  const audit = opts.audit || (() => {});
  const debug =
    url.searchParams.get("log") === "1" || env?.ENABLE_LOG === "1";
  const log = (...a) => {
    if (debug) console.log("[vless]", ...a);
  };

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.binaryType = "arraybuffer";
  try {
    server.accept({ allowHalfOpen: true });
  } catch {
    server.accept();
  }

  let dest = "";
  const remote = createRemoteSocketWrapper(log, () =>
    closeDataStream(server),
  );
  let udpHandler = null;
  const early = request.headers.get("sec-websocket-protocol") || "";
  const inbound = wsToStream(server, early, log, (reason) => {
    try {
      udpHandler?.close(reason);
    } catch {}
    remote.close(reason);
  });

  let headerBuf = new Uint8Array(0);
  let authed = false;

  inbound
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          if (udpHandler) return udpHandler.write(chunk);
          if (remote.value || remote.connectingPromise) {
            await remote.write(chunk);
            return;
          }
          const data =
            chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          if (headerBuf.byteLength + data.byteLength > 64 * 1024) {
            throw new Error("vless header too large");
          }
          const merged = new Uint8Array(
            headerBuf.byteLength + data.byteLength,
          );
          merged.set(headerBuf);
          merged.set(data, headerBuf.byteLength);
          headerBuf = merged;

          const parsed = parseVlessHeader(headerBuf, ids);
          if (parsed.needMore) return;
          if (parsed.hasError) throw new Error(parsed.message);
          headerBuf = new Uint8Array(0);
          authed = true;

          const { addressRemote, portRemote, rawDataIndex, version, isUDP, addressType } =
            parsed;
          dest = `${addressRemote}:${portRemote}`;

          if (isUDP) {
            if (portRemote !== 53) {
              throw new Error("UDP proxy only enabled for DNS (port 53)");
            }
            audit({ ok: true, via: "vless-udp", host: addressRemote });
            const respHeader = new Uint8Array([version[0], 0]);
            udpHandler = await handleUdpOut(
              server,
              respHeader,
              dohUrl(env),
              log,
            );
            await udpHandler.write(parsed.rawClientData);
            return;
          }

          if (
            isBlockedHost(addressRemote, selfHost, cfg) ||
            !isAllowedHost(addressRemote, cfg)
          ) {
            audit({
              ok: false,
              via: "vless",
              reason: "blocked",
              host: addressRemote,
            });
            throw new Error("blocked host");
          }
          audit({ ok: true, via: "vless", host: addressRemote });
          log(`dial ${addressRemote}:${portRemote}`);
          const respHeader = new Uint8Array([version[0], 0]);
          const initial = parsed.rawClientData;
          await dialTcpOut(
            remote,
            addressRemote,
            portRemote,
            initial,
            server,
            respHeader,
            log,
            {
              timeoutMs: connectTimeoutMs(env),
              concurrency: dialConcurrency(env),
            },
            nat64Enabled(env)
              ? {
                  prefix: nat64Prefix(env),
                  doh: dohUrl(env),
                  atyp: addressType,
                  onNat64: () =>
                    audit({ ok: true, via: "vless-nat64", host: addressRemote }),
                }
              : null,
          );
        },
        async close() {
          log(`inbound close dest=${dest} authed=${authed}`);
          try {
            await udpHandler?.close();
          } catch {}
          await remote.closeGracefully();
        },
        async abort(reason) {
          log(`inbound abort dest=${dest}`, JSON.stringify(reason));
          try {
            await udpHandler?.close(reason);
          } catch {}
          remote.close(reason);
        },
      }),
    )
    .catch((err) => {
      log(`pipe error dest=${dest}`, err?.message || err);
      try {
        remote.close(err);
      } catch {}
      closeDataStream(server);
    });

  void ctx;
  return new Response(null, { status: 101, webSocket: client });
}

// ---------------------------------------------------------------- guards
// Same literal/hostname policy as worker.js relay (not a full SSRF fix:
// hostnames that resolve to private IPs can't be checked at the edge
// without resolving DNS — keep ALLOWED_HOSTS tight).

function isBlockedHost(hostname, selfHost, cfg) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (h === String(selfHost || "").toLowerCase()) return true;
  if (h.endsWith(".workers.dev")) return true;
  if (h === "localhost" || h === "metadata.google.internal") return true;
  if (h === "169.254.169.254" || h === "[::ffff:169.254.169.254]") return true;
  if (/^127\./.test(h) || h === "::1" || h === "[::1]") return true;
  // expanded ::1 form as produced by the VLESS ipv6 parser
  if (h === "0:0:0:0:0:0:0:1") return true;
  if (
    /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|31)\.\d+\.\d+)$/.test(
      h,
    )
  )
    return true;
  const extra = cfg?.extraBlockedHosts || [];
  if (extra.some((b) => h === b || h.endsWith(`.${b}`))) return true;
  return false;
}

function isAllowedHost(hostname, cfg) {
  const allow = cfg?.allowedHosts || [];
  if (!allow.length) return true;
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return allow.some((a) => h === a || h.endsWith(`.${a}`));
}

// ------------------------------------------------------------ WS bridge

function b64ToBuf(header) {
  if (!header) return { earlyData: null, error: null };
  try {
    const b64 = header.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    return {
      earlyData: Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer,
      error: null,
    };
  } catch (error) {
    return { earlyData: null, error };
  }
}

function wsToStream(ws, earlyHeader, log, onClose) {
  let streamClosed = false;
  let sourceClosed = false;
  let draining = false;
  let queuedBytes = 0;
  let ctl = null;
  const queue = [];

  const sizeOf = (m) => {
    if (m instanceof ArrayBuffer || m instanceof Uint8Array)
      return m.byteLength;
    if (typeof m === "string")
      return new TextEncoder().encode(m).byteLength;
    return 0;
  };
  const normalize = async (m) => {
    if (m instanceof ArrayBuffer) return new Uint8Array(m);
    if (m instanceof Uint8Array)
      return new Uint8Array(m.buffer, m.byteOffset, m.byteLength);
    if (typeof m === "string") return new TextEncoder().encode(m);
    throw new Error(`unknown WS message type: ${typeof m}`);
  };
  const fail = (err) => {
    if (streamClosed) return;
    streamClosed = true;
    queue.length = 0;
    queuedBytes = 0;
    try {
      onClose?.(err);
    } catch {}
    try {
      ctl?.error(err);
    } catch {}
  };
  const drain = async () => {
    if (draining || streamClosed || !ctl) return;
    draining = true;
    try {
      while (queue.length && !streamClosed && ctl.desiredSize > 0) {
        const item = queue.shift();
        const msg = await normalize(item.message);
        queuedBytes = Math.max(0, queuedBytes - item.size);
        if (!streamClosed) ctl.enqueue(msg);
      }
      if (sourceClosed && !queue.length && !streamClosed) {
        streamClosed = true;
        ctl.close();
      }
    } catch (err) {
      fail(err);
    } finally {
      draining = false;
    }
  };
  const enqueue = (message) => {
    if (streamClosed || sourceClosed) return;
    const size = sizeOf(message);
    if (
      queuedBytes + size > UPLOAD_QUEUE_MAX_BYTES ||
      queue.length + 1 > UPLOAD_QUEUE_MAX_ITEMS
    ) {
      fail(
        new Error(
          `WebSocket input queue overflow: ${queuedBytes + size}B/${queue.length + 1}`,
        ),
      );
      closeDataStream(ws);
      return;
    }
    queuedBytes += size;
    queue.push({ message, size });
    drain();
  };

  return new ReadableStream({
    start(controller) {
      ctl = controller;
      ws.addEventListener("message", (ev) => enqueue(ev.data));
      ws.addEventListener("close", () => {
        if (streamClosed) return;
        sourceClosed = true;
        drain();
      });
      ws.addEventListener("error", (err) => {
        log("ws error");
        fail(err);
      });
      const { earlyData, error } = b64ToBuf(earlyHeader);
      if (error) fail(error);
      else if (earlyData) enqueue(earlyData);
    },
    pull() {
      return drain();
    },
    cancel(reason) {
      log(`ws stream canceled: ${reason}`);
      if (streamClosed) return;
      streamClosed = true;
      queue.length = 0;
      queuedBytes = 0;
      try {
        onClose?.(reason);
      } catch {}
      closeDataStream(ws);
    },
  });
}

// ------------------------------------------------------- TCP machinery

function createRemoteSocketWrapper(log, onError) {
  return {
    value: null,
    writer: null,
    connectingPromise: null,
    uploadQueue: [],
    uploadTimer: null,
    draining: false,
    activeBatchBytes: 0,
    activeBatchItems: 0,
    idleResolvers: [],
    queuedBytes: 0,
    generation: 0,
    closed: false,
    lastError: null,
    setSocket(socket) {
      if (this.closed) {
        try {
          socket.close();
        } catch {}
        throw new Error("remote socket wrapper is closed");
      }
      const old = this.value;
      if (this.writer) {
        try {
          this.writer.releaseLock();
        } catch {}
      }
      this.writer = null;
      this.value = socket;
      this.generation++;
      if (old && old !== socket) {
        try {
          old.close();
        } catch {}
      }
      return this.generation;
    },
    write(chunk) {
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (!data.byteLength) return;
      if (
        this.queuedBytes + data.byteLength > UPLOAD_QUEUE_MAX_BYTES ||
        this.uploadQueue.length + this.activeBatchItems + 1 >
          UPLOAD_QUEUE_MAX_ITEMS
      ) {
        const err = new Error(
          `upload queue overflow: ${this.queuedBytes + data.byteLength}B`,
        );
        this.close(err);
        throw err;
      }
      this.queuedBytes += data.byteLength;
      this.uploadQueue.push(data);
      if (this.queuedBytes >= UPLOAD_BATCH_TARGET) {
        if (this.uploadTimer) clearTimeout(this.uploadTimer);
        this.uploadTimer = null;
        this.drain();
      } else if (!this.uploadTimer && !this.draining) {
        this.uploadTimer = setTimeout(() => {
          this.uploadTimer = null;
          this.drain();
        }, 1);
      }
    },
    async drain() {
      if (this.draining || this.closed) return;
      this.draining = true;
      try {
        while (this.uploadQueue.length && !this.closed) {
          if (this.connectingPromise) await this.connectingPromise;
          if (this.closed || !this.value)
            throw new Error("remote socket is not available");
          if (!this.writer) this.writer = this.value.writable.getWriter();
          let batchBytes = 0;
          let batchItems = 0;
          while (batchItems < this.uploadQueue.length) {
            const n = this.uploadQueue[batchItems].byteLength;
            if (batchItems > 0 && batchBytes + n > UPLOAD_BATCH_TARGET) break;
            batchBytes += n;
            batchItems++;
            if (batchBytes >= UPLOAD_BATCH_TARGET) break;
          }
          let batch;
          if (batchItems === 1) batch = this.uploadQueue.shift();
          else {
            batch = new Uint8Array(batchBytes);
            let off = 0;
            for (let i = 0; i < batchItems; i++) {
              const item = this.uploadQueue.shift();
              batch.set(item, off);
              off += item.byteLength;
            }
          }
          this.activeBatchBytes = batchBytes;
          this.activeBatchItems = batchItems;
          await this.writer.write(batch);
          this.queuedBytes = Math.max(0, this.queuedBytes - batchBytes);
          this.activeBatchBytes = 0;
          this.activeBatchItems = 0;
        }
      } catch (err) {
        this.close(err);
      } finally {
        this.draining = false;
        if (this.uploadQueue.length && !this.closed) this.drain();
        else this.resolveIdle();
      }
    },
    resolveIdle() {
      if (this.uploadQueue.length || this.draining || this.activeBatchItems)
        return;
      const rs = this.idleResolvers;
      this.idleResolvers = [];
      for (const r of rs) r();
    },
    waitForIdle() {
      if (this.uploadQueue.length || this.draining || this.activeBatchItems) {
        return new Promise((r) => this.idleResolvers.push(r));
      }
      if (this.lastError) throw this.lastError;
      return Promise.resolve();
    },
    async closeGracefully() {
      if (this.closed) return;
      if (this.uploadTimer) clearTimeout(this.uploadTimer);
      this.uploadTimer = null;
      this.drain();
      let timer;
      try {
        await Promise.race([
          this.waitForIdle(),
          new Promise((r) => {
            timer = setTimeout(r, UPLOAD_DRAIN_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        this.close();
      }
    },
    async writeInitial(chunk) {
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (this.closed || !this.value)
        throw new Error("remote socket is not available");
      if (!this.writer) this.writer = this.value.writable.getWriter();
      if (data.byteLength) await this.writer.write(data);
    },
    close(reason) {
      if (this.closed) return;
      this.closed = true;
      this.generation++;
      if (reason) {
        this.lastError ||=
          reason instanceof Error ? reason : new Error(String(reason));
        log(`remote close: ${reason.message || reason}`);
        try {
          onError?.(reason);
        } catch {}
      }
      if (this.uploadTimer) clearTimeout(this.uploadTimer);
      this.uploadTimer = null;
      this.uploadQueue = [];
      this.queuedBytes = 0;
      this.activeBatchBytes = 0;
      this.activeBatchItems = 0;
      if (this.writer) {
        try {
          this.writer.releaseLock();
        } catch {}
      }
      this.writer = null;
      if (this.value) {
        try {
          this.value.close();
        } catch {}
      }
      this.value = null;
      this.connectingPromise = null;
      this.resolveIdle();
    },
  };
}

async function waitSocketOpened(socket, timeoutMs) {
  if (!socket.opened) return socket;
  let timer;
  try {
    await Promise.race([
      socket.opened,
      new Promise((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`TCP timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return socket;
  } catch (err) {
    try {
      socket.close();
    } catch {}
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function connectTcpSocket(address, port, concurrency, timeoutMs, log) {
  const n = Math.max(1, Math.floor(Number(concurrency) || 1));
  const attempts = Array.from({ length: n }, async () => {
    const sock = connect({ hostname: address, port }, { allowHalfOpen: true });
    await waitSocketOpened(sock, timeoutMs);
    return sock;
  });
  let winner;
  try {
    winner = await Promise.any(attempts);
    return winner;
  } catch (err) {
    const list = Array.isArray(err?.errors) ? err.errors : [err];
    const detail = list
      .map((e, i) => `#${i + 1} ${e?.message || e}`)
      .join("; ");
    log?.(`dial ${address}:${port} failed (${n}x): ${detail}`);
    throw new Error(`TCP connect failed for ${address}:${port}: ${detail}`);
  } finally {
    if (winner) {
      for (const a of attempts) {
        a.then((s) => {
          if (s !== winner) {
            try {
              s.close();
            } catch {}
          }
        }).catch(() => {});
      }
    }
  }
}

async function dialTcpOut(
  remote,
  host,
  port,
  initial,
  ws,
  respHeader,
  log,
  { timeoutMs, concurrency },
  nat = null, // { prefix, doh, atyp, onNat64 } or null (disabled)
) {
  const attempt = async (addr, tag) => {
    const task = connectTcpSocket(addr, port, concurrency, timeoutMs, log);
    remote.connectingPromise = task;
    let sock;
    try {
      sock = await task;
      if (!sock) throw new Error("TCP connection failed");
      remote.setSocket(sock);
      try {
        sock.closed.catch((e) => log(`tcp closed: ${e?.message || e}`));
      } catch {}
      log(`connected ${tag} ${addr}:${port}`);
      await remote.writeInitial(initial);
    } finally {
      if (remote.connectingPromise === task) remote.connectingPromise = null;
    }
    return sock;
  };

  const attemptNat64 = async (why) => {
    if (!nat) throw new Error(`no nat64 fallback (${why})`);
    const v6 = await nat64DialAddress(host, nat.atyp, nat.doh, nat.prefix);
    log(`nat64 ${why}: ${host} -> [${v6}]:${port}`);
    try {
      nat.onNat64?.(v6);
    } catch {}
    return attempt(v6.replace(/^\[|\]$/g, ""), "nat64");
  };

  let sock;
  try {
    sock = await attempt(host, "direct");
  } catch (err) {
    log(`direct dial failed: ${err?.message || err}`);
    sock = await attemptNat64("dial-failed");
  }
  const gen = remote.generation;
  // Silent direct connection (connected, zero bytes back — the dropped-
  // handshake shape): one NAT64 retry, then give up and close as usual.
  // Nothing was sent downlink yet, so the retry reuses respHeader.
  const onEmpty = nat
    ? async () => {
        try {
          const nsock = await attemptNat64("silent-close");
          const ngen = remote.generation;
          transferDownlink(nsock, ws, respHeader, log, remote, ngen).catch((err) => {
            log(`nat64 downlink error: ${err?.message || err}`);
            remote.close(err);
            closeDataStream(ws);
          });
          return true;
        } catch (err) {
          log(`nat64 retry failed: ${err?.message || err}`);
          return false;
        }
      }
    : null;
  transferDownlink(sock, ws, respHeader, log, remote, gen, { onEmpty }).catch((err) => {
    log(`downlink error: ${err?.message || err}`);
    remote.close(err);
    closeDataStream(ws);
  });
}

function createDownlinkSender(ws, respHeader, isActive) {
  let header = respHeader;
  const buf = new Uint8Array(DOWNLOAD_CHUNK_MAX);
  let len = 0;
  let timer = null;
  let chain = Promise.resolve();
  let failed = null;

  const sendRaw = (chunk) => {
    if (failed) throw failed;
    if (!isActive() || ws.readyState !== WS_OPEN)
      throw new Error("ws is not open");
    if (header) {
      const out = new Uint8Array(header.byteLength + chunk.byteLength);
      out.set(header, 0);
      out.set(chunk, header.byteLength);
      header = null;
      ws.send(out);
    } else {
      ws.send(chunk);
    }
  };
  const queueSend = (chunk) => {
    const t = chain.then(() => sendRaw(chunk)).catch((err) => {
      failed ||= err;
      throw err;
    });
    chain = t.catch(() => {});
    return t;
  };
  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!len) return chain;
    const chunk = buf.slice(0, len);
    len = 0;
    return queueSend(chunk);
  };
  const schedule = () => {
    if (timer || !len) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => closeDataStream(ws));
    }, DOWNLOAD_FLUSH_DELAY_MS);
  };
  return {
    async send(data) {
      if (failed) throw failed;
      const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
      let off = 0;
      while (off < chunk.byteLength) {
        const rem = chunk.byteLength - off;
        if (!len && rem >= DOWNLOAD_CHUNK_MAX) {
          await queueSend(chunk.subarray(off, off + DOWNLOAD_CHUNK_MAX));
          off += DOWNLOAD_CHUNK_MAX;
          continue;
        }
        const n = Math.min(DOWNLOAD_CHUNK_MAX - len, rem);
        buf.set(chunk.subarray(off, off + n), len);
        len += n;
        off += n;
        if (len === DOWNLOAD_CHUNK_MAX) await flush();
      }
      schedule();
    },
    async stopAndFlush() {
      if (timer) clearTimeout(timer);
      timer = null;
      await flush();
      await chain;
      if (failed) throw failed;
    },
  };
}

async function transferDownlink(
  sock,
  ws,
  respHeader,
  log,
  wrapper,
  generation,
  { onEmpty = null } = {}, // optional () => Promise<bool>: silent close recovered?
) {
  let gotData = false;
  let reader;
  let byob = false;
  let readErr = null;
  const current = () => !wrapper || wrapper.generation === generation;
  const sender = createDownlinkSender(ws, respHeader, current);
  try {
    try {
      reader = sock.readable.getReader({ mode: "byob" });
      byob = true;
    } catch {
      reader = sock.readable.getReader();
    }
    if (byob) {
      let backing = new ArrayBuffer(64 * 1024);
      while (true) {
        const { done, value } = await reader.read(new Uint8Array(backing));
        if (!current()) return;
        if (done) break;
        if (!value?.byteLength) {
          backing = new ArrayBuffer(64 * 1024);
          continue;
        }
        gotData = true;
        await sender.send(value);
        backing =
          value.buffer.byteLength >= 64 * 1024
            ? value.buffer
            : new ArrayBuffer(64 * 1024);
      }
    } else {
      while (true) {
        const { done, value } = await reader.read();
        if (!current()) return;
        if (done) break;
        if (!value?.byteLength) continue;
        gotData = true;
        await sender.send(value);
      }
    }
    if (current()) await sender.stopAndFlush();
    log(`tcp closed (hadData=${gotData})`);
  } catch (err) {
    readErr = err;
  } finally {
    if (current() && ws.readyState === WS_OPEN) {
      try {
        await sender.stopAndFlush();
      } catch (err) {
        readErr ||= err;
      }
    }
    try {
      await reader?.cancel();
    } catch {}
    try {
      reader?.releaseLock();
    } catch {}
    if (current()) {
      try {
        sock.close();
      } catch {}
    }
  }
  if (!current()) return;
  if (!gotData && !readErr && onEmpty) {
    try {
      if (await onEmpty()) return; // retry owns the lifecycle now
    } catch (err) {
      readErr ||= err;
    }
  }
  if (!gotData && !readErr) readErr = new Error("remote closed without data");
  if (readErr) log(`downlink end: ${readErr.message || readErr}`);
  wrapper?.close(readErr);
  closeDataStream(ws);
}

// ------------------------------------------------------------------ UDP
// VLESS UDP framing: each datagram is [len(2) + dnsmsg]. Only DNS (port 53)
// is proxied, via DNS-over-HTTPS POST.

async function handleUdpOut(ws, respHeader, doh, log) {
  let sentHeader = false;
  let pending = new Uint8Array(0);
  let closed = false;
  let done = null;
  const active = new Set();

  const transform = new TransformStream({
    transform(chunk, controller) {
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      if (data.byteLength) {
        const m = new Uint8Array(pending.byteLength + data.byteLength);
        m.set(pending, 0);
        m.set(data, pending.byteLength);
        pending = m;
      }
      let i = 0;
      while (i < pending.byteLength) {
        if (pending.byteLength - i < 2) break;
        const plen = (pending[i] << 8) | pending[i + 1];
        if (!plen) throw new Error("invalid empty UDP packet");
        if (pending.byteLength - i < plen + 2) break;
        controller.enqueue({
          payload: pending.slice(i + 2, i + 2 + plen),
        });
        i += plen + 2;
      }
      pending = i ? pending.slice(i) : pending;
    },
    flush() {
      if (pending.byteLength)
        throw new Error(`incomplete UDP packet: ${pending.byteLength}B`);
    },
  });

  const pump = transform.readable
    .pipeTo(
      new WritableStream({
        async write({ payload }) {
          if (closed) throw new Error("DNS stream is closed");
          const ctl = new AbortController();
          active.add(ctl);
          const timer = setTimeout(
            () => ctl.abort(new Error("DoH timeout")),
            10000,
          );
          try {
            const resp = await fetch(doh, {
              method: "POST",
              headers: {
                "content-type": "application/dns-message",
                accept: "application/dns-message",
              },
              body: payload,
              signal: ctl.signal,
            });
            if (!resp.ok) {
              try {
                await resp.body?.cancel();
              } catch {}
              throw new Error(`DoH status ${resp.status}`);
            }
            const msg = await resp.arrayBuffer();
            if (!msg.byteLength || msg.byteLength > 65535)
              throw new Error(`bad DoH length: ${msg.byteLength}`);
            const lb = new Uint8Array([
              (msg.byteLength >> 8) & 0xff,
              msg.byteLength & 0xff,
            ]);
            let out;
            if (sentHeader) {
              out = new Uint8Array(lb.byteLength + msg.byteLength);
              out.set(lb, 0);
              out.set(new Uint8Array(msg), lb.byteLength);
            } else {
              out = new Uint8Array(
                respHeader.byteLength + lb.byteLength + msg.byteLength,
              );
              out.set(respHeader, 0);
              out.set(lb, respHeader.byteLength);
              out.set(
                new Uint8Array(msg),
                respHeader.byteLength + lb.byteLength,
              );
              sentHeader = true;
            }
            if (!closed && ws.readyState === WS_OPEN) {
              log(`doh ok (${msg.byteLength}B)`);
              ws.send(out);
            }
          } finally {
            clearTimeout(timer);
            active.delete(ctl);
          }
        },
      }),
    )
    .catch((err) => {
      log(`doh pump error: ${err?.message || err}`);
      closeDataStream(ws);
    });

  const writer = transform.writable.getWriter();
  return {
    write(chunk) {
      if (closed) return Promise.reject(new Error("DNS stream is closed"));
      return writer.write(chunk);
    },
    close(reason) {
      if (done) return done;
      closed = true;
      const err =
        reason instanceof Error ? reason : new Error(String(reason || "DNS closed"));
      for (const c of active) c.abort(err);
      active.clear();
      done = (async () => {
        try {
          await writer.close();
        } catch {}
        try {
          writer.releaseLock();
        } catch {}
        try {
          await pump;
        } catch {}
      })();
      return done;
    },
  };
}

// ------------------------------------------------------------ VLESS hdr

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push((i + 256).toString(16).slice(1));

function uuidOf(bytes, off = 0) {
  return (
    HEX[bytes[off]] + HEX[bytes[off + 1]] + HEX[bytes[off + 2]] + HEX[bytes[off + 3]] +
    "-" + HEX[bytes[off + 4]] + HEX[bytes[off + 5]] +
    "-" + HEX[bytes[off + 6]] + HEX[bytes[off + 7]] +
    "-" + HEX[bytes[off + 8]] + HEX[bytes[off + 9]] +
    "-" + HEX[bytes[off + 10]] + HEX[bytes[off + 11]] +
    HEX[bytes[off + 12]] + HEX[bytes[off + 13]] +
    HEX[bytes[off + 14]] + HEX[bytes[off + 15]]
  ).toLowerCase();
}

function parseVlessHeader(buf, ids) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (data.byteLength < 24) return { needMore: true };
  const version = data.slice(0, 1);
  const user = uuidOf(data.slice(1, 17));
  if (!ids.includes(user)) return { hasError: true, message: "invalid user" };

  const optLen = data[17];
  const cmdIdx = 18 + optLen;
  if (data.byteLength < cmdIdx + 4) return { needMore: true };
  const cmd = data[cmdIdx];
  let isUDP = false;
  if (cmd === 1) isUDP = false;
  else if (cmd === 2) isUDP = true;
  else return { hasError: true, message: `unsupported command ${cmd}` };

  const portIdx = cmdIdx + 1;
  const port = (data[portIdx] << 8) | data[portIdx + 1];
  let addrIdx = portIdx + 2;
  const atyp = data[addrIdx];
  let addrLen = 0;
  let valIdx = addrIdx + 1;
  let addr = "";
  if (atyp === 1) {
    addrLen = 4;
    if (data.byteLength < valIdx + addrLen) return { needMore: true };
    addr = data.slice(valIdx, valIdx + addrLen).join(".");
  } else if (atyp === 2) {
    if (data.byteLength < valIdx + 1) return { needMore: true };
    addrLen = data[valIdx];
    valIdx += 1;
    if (!addrLen) return { hasError: true, message: "invalid domain" };
    if (data.byteLength < valIdx + addrLen) return { needMore: true };
    addr = new TextDecoder().decode(data.slice(valIdx, valIdx + addrLen));
  } else if (atyp === 3) {
    addrLen = 16;
    if (data.byteLength < valIdx + addrLen) return { needMore: true };
    const view = new DataView(
      data.buffer,
      data.byteOffset + valIdx,
      addrLen,
    );
    const g = [];
    for (let i = 0; i < 8; i++) g.push(view.getUint16(i * 2).toString(16));
    addr = g.join(":");
  } else {
    return { hasError: true, message: `invalid addressType ${atyp}` };
  }
  if (!addr)
    return { hasError: true, message: `empty address (atyp ${atyp})` };

  const rawIdx = valIdx + addrLen;
  return {
    hasError: false,
    needMore: false,
    addressRemote: addr,
    portRemote: port,
    rawDataIndex: rawIdx,
    rawClientData: data.slice(rawIdx),
    version,
    isUDP,
    addressType: atyp,
  };
}

function closeDataStream(ws) {
  try {
    if (ws.readyState === WS_OPEN || ws.readyState === WS_CLOSING) ws.close();
  } catch (err) {
    console.error("ws close error", err);
  }
}
