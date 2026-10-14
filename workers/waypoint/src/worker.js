// waypoint: auth-gated test relay for workers.dev (spare account).
// Login-only deploy: `npx wrangler login` (spare-account profile) + `wrangler secret put`.
// No API tokens in repo, no dashboard paste.
// Full legitimate feature set drawn from the 4 reviewed workers, NOT their VPN cores:
// - relay (5.5k): hop/fwd-hop loop-guard, self-fetch block, upstream forwarder
//   fail-closed with legacy f-flag + ct passthrough, timeout, chunked b64
// - amclubs (100k): env-over-KV config (KV_CONFIG pattern), ENABLE_LOG toggle,
//   /get|/set admin shape, parseNumberOption-style clamping
// - BPB (395k): versioned settings cache-or-init + migration, secure admin path
//   idea (ADMIN_PATH), no EMBEDED_SETTINGS blob
// - EDT (5M): /health+/version+robots separation, HOST allowlist, admin/config
//   + init reset + metrics/log shape, request audit via waitUntil
// VLESS over WebSocket (./vless.js, adapted from the amclubs reference) is the
// one VPN transport this worker ships: UUID-authenticated WS upgrade on
// /<VLESS_UUID> (or /vless, or /<VLESS_PATH>), TCP dial via
// cloudflare:sockets, DNS(UDP/53) via DoH, plus an opt-in single NAT64
// retry (NAT64_FALLBACK=1) for egress that drops Cloudflare-sourced
// handshakes. Trojan/SS/XHTTP/gRPC/SOCKS-out/subscription panels omitted.

import {
  buildVlessLinks,
  getVlessIds,
  handleVlessWs,
  isVlessWsRequest,
  vlessPathAllowed,
} from "./vless.js";

const VERSION = "waypoint-2";
const CONFIG_VERSION = 2;
const CONFIG_KEY = "config";
const AUDIT_KEY = "audit";
const AUDIT_MAX = 50;
const DEFAULT_MAX_BODY = 1024 * 1024; // 1 MiB cap (well under 32 MiB runtime cap)
const DEFAULT_TIMEOUT_MS = 10000;
const RATE_LIMIT = 60; // requests per window per IP
const RATE_WINDOW_MS = 60_000;

// Ephemeral per-isolate rate + metrics (resets on deploy/sleep — use KV audit log for durable abuse review).
const hits = new Map();
const metrics = {
  relayOk: 0,
  relayDenied: 0,
  vlessOk: 0,
  vlessDenied: 0,
  adminCalls: 0,
  startedAt: Date.now(),
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cfg = await resolveConfig(env);
    const adminBase = adminPath(env); // secure-path idea (BPB securePath): default /admin

    // VLESS over WebSocket: `Upgrade: websocket` GET on /<VLESS_UUID>
    // (or /vless, or /<VLESS_PATH> when set). UUID inside the VLESS header
    // is the real auth; the path is just obscurity + client convention
    // (?ed=2048 for 0-RTT early-data lives in sec-websocket-protocol).
    // Disabled when VLESS_UUID is unset (fail closed).
    const upgrade = request.headers.get("Upgrade") || request.headers.get("upgrade");
    if (String(upgrade || "").toLowerCase() === "websocket") {
      if (!getVlessIds(env).length) {
        metrics.vlessDenied++;
        return json({ e: "not found" }, 404);
      }
      if (!isVlessWsRequest(request, env)) {
        metrics.vlessDenied++;
        return json({ e: "not found" }, 404);
      }
      metrics.vlessOk++;
      return handleVlessWs(request, env, ctx, {
        cfg,
        selfHost: url.hostname,
        audit: (entry) => audit(ctx, env, entry),
      });
    }
    // Plain-HTTP hit on a VLESS path (client misconfigured / browser probe):
    // hint the caller instead of a bare 404.
    try {
      const ids = getVlessIds(env);
      if (ids.length && vlessPathAllowed(url, env, ids)) {
        return json({ e: "upgrade required (vless ws only)" }, 426);
      }
    } catch {
      // fall through to normal routes
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, version: VERSION });
    }
    if (request.method === "GET" && url.pathname === "/version") {
      return json({ version: VERSION, configVersion: CONFIG_VERSION });
    }
    if (request.method === "GET" && url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: { "content-type": "text/plain" },
      });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return json({ status: "waypoint relay. POST /relay with bearer auth." , vless: getVlessIds(env).length ? "ws enabled" : "disabled" });
    }

    // All admin routes are token-gated (cf. EDT /admin/* + amclubs /{id}/get|set, but bearer not UUID).
    if (
      url.pathname === `${adminBase}/config` ||
      url.pathname === `${adminBase}/metrics` ||
      url.pathname === `${adminBase}/init` ||
      url.pathname === `${adminBase}/vless` ||
      url.pathname === `${adminBase}/sub`
    ) {
      let auth = checkAuth(request, env);
      if (!auth.ok && url.pathname === `${adminBase}/sub` && request.method === "GET") {
        // Subscription URLs are fetched by clients (Hiddify / Clash Verge)
        // that cannot attach an Authorization header, so /admin/sub also
        // accepts the same secret as ?token=. Constant-time compare; header
        // auth stays the only option on every other admin route. A token URL
        // IS the secret — don't share it beyond the client.
        const expected = env.RELAY_TOKEN || "";
        const given = url.searchParams.get("token") || "";
        if (expected && given && safeEqual(given, expected)) auth = { ok: true };
      }
      if (!auth.ok) return auth.res;
      metrics.adminCalls++;
      if (url.pathname === `${adminBase}/metrics` && request.method === "GET") {
        return json({ version: VERSION, ...metrics, uptimeMs: Date.now() - metrics.startedAt });
      }
      if (url.pathname === `${adminBase}/vless` && request.method === "GET") {
        const ids = getVlessIds(env);
        if (!ids.length) return json({ e: "vless disabled (no VLESS_UUID)" }, 404);
        return json({ version: VERSION, links: buildVlessLinks(request, env) });
      }
      if (url.pathname === `${adminBase}/sub` && request.method === "GET") {
        const ids = getVlessIds(env);
        if (!ids.length) return json({ e: "vless disabled (no VLESS_UUID)" }, 404);
        // One-click client import: base64 batch of vless:// links, one per
        // line after decoding. Same ?host= override as /admin/vless.
        const batch = buildVlessLinks(request, env).join("\n");
        return new Response(strToB64(batch), {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
      if (url.pathname === `${adminBase}/init` && request.method === "POST") {
        const fresh = defaults(env);
        if (env.CONFIG?.put) await env.CONFIG.put(CONFIG_KEY, JSON.stringify(fresh));
        return json({ ok: true, reset: true, config: fresh });
      }
      if (url.pathname === `${adminBase}/config`) {
        if (request.method === "GET") return json({ version: VERSION, config: cfg });
        if (request.method === "POST") {
          if (!env.CONFIG) return json({ e: "no CONFIG KV bound" }, 501);
          let body;
          try {
            body = await request.json();
          } catch {
            return json({ e: "invalid json" }, 400);
          }
          const next = sanitizeConfig(body, cfg);
          await env.CONFIG.put(CONFIG_KEY, JSON.stringify(next));
          return json({ ok: true, config: next });
        }
      }
      return json({ e: "method not allowed" }, 405);
    }

    if (url.pathname !== "/relay") return json({ e: "not found" }, 404);
    if (request.method !== "POST") return json({ e: "method not allowed" }, 405);

    const auth = checkAuth(request, env);
    if (!auth.ok) {
      metrics.relayDenied++;
      return auth.res;
    }
    const rl = checkRate(request, cfg);
    if (!rl.ok) {
      metrics.relayDenied++;
      return rl.res;
    }

    // Loop guards (from 5.5k relay: both hop + fwd-hop).
    if (request.headers.get("x-relay-hop") === "1" || request.headers.get("x-fwd-hop") === "1") {
      return json({ e: "loop detected" }, 508);
    }

    let req;
    try {
      req = await request.json();
    } catch {
      return json({ e: "invalid json" }, 400);
    }
    if (!req?.u) return json({ e: "missing url" }, 400);

    let target;
    try {
      // Normalize SSRF-evasion shapes (cf. EDT fetch head): literal
      // backslashes and %5c have no legitimate meaning in an https URL and
      // are used to smuggle path/host parsing past naive checks; fragments
      // are never sent to origin, so drop them before policy checks.
      const raw = String(req.u).replace(/\\/g, "").replace(/%5c/gi, "");
      target = new URL(raw);
      target.hash = "";
    } catch {
      return json({ e: "invalid url" }, 400);
    }
    if (target.protocol !== "https:") {
      metrics.relayDenied++;
      return json({ e: "https only" }, 400);
    }
    if (isBlockedHost(target.hostname, url.hostname, cfg) || !isAllowedHost(target.hostname, cfg)) {
      metrics.relayDenied++;
      audit(ctx, env, { ok: false, reason: "blocked", host: target.hostname });
      return json({ e: "blocked host" }, 403);
    }

    // Optional upstream forwarder (fail-closed by default, from 5.5k relay).
    // Legacy compat: f === 1 forward, f === 0 skip, missing = forward.
    const upstream = env.UPSTREAM_FORWARDER_URL || "";
    const wantForward = req.f === 1 || req.f === undefined;
    if (upstream && wantForward) {
      const started = Date.now();
      const r = await forwardViaUpstream({ ...req, u: target.toString() }, env, url.hostname);
      if (r) {
        metrics.relayOk++;
        audit(ctx, env, { ok: true, via: "upstream", host: target.hostname, ms: Date.now() - started });
        return r;
      }
      const mode = (env.UPSTREAM_FAIL_MODE || "closed").toLowerCase();
      if (mode !== "open") return json({ e: "upstream failed (fail-closed)" }, 502);
    }

    const headers = new Headers();
    if (req.h && typeof req.h === "object") {
      for (const [k, v] of Object.entries(req.h)) {
        if (/^(x-relay-hop|x-fwd-hop)$/i.test(k)) continue;
        headers.set(k, String(v));
      }
    }
    headers.set("x-relay-hop", "1");

    const method = String(req.m || "GET").toUpperCase();
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) {
      return json({ e: "method not allowed" }, 405);
    }

    const opts = {
      method,
      headers,
      redirect: req.r === false ? "manual" : "follow",
    };
    if (req.b) {
      const body = Uint8Array.from(atob(req.b), (c) => c.charCodeAt(0));
      if (body.byteLength > cfg.maxBody) return json({ e: "request too large" }, 413);
      opts.body = body;
    }

    const log = isLogEnabled(url, env);
    const ctrl = new AbortController();
    const started = Date.now();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      if (log) console.log(`relay ${method} ${target.host}`);
      const resp = await fetch(target.toString(), { ...opts, signal: ctrl.signal });
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > cfg.maxBody) return json({ e: "response too large" }, 502);
      const out = {};
      resp.headers.forEach((v, k) => {
        out[k] = v;
      });
      metrics.relayOk++;
      const ms = Date.now() - started;
      audit(ctx, env, { ok: true, via: "direct", host: target.hostname, status: resp.status, ms });
      return json({ s: resp.status, h: out, b: encodeB64(new Uint8Array(buf)), ms });
    } catch (err) {
      return json({ e: String(err?.message || err) }, 502);
    } finally {
      clearTimeout(t);
    }
  },
};

function checkAuth(request, env) {
  // Fail closed: no token configured -> refuse to run as open relay.
  const token = env.RELAY_TOKEN || "";
  if (!token) return { ok: false, res: json({ e: "server misconfigured (no RELAY_TOKEN)" }, 500) };
  const got =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    request.headers.get("x-relay-auth") ||
    "";
  if (got !== token) return { ok: false, res: json({ e: "unauthorized" }, 401) };
  return { ok: true };
}

// Constant-time string compare for the ?token= fallback (avoids leaking
// the secret byte-by-byte via timing). Length mismatch short-circuits.
function safeEqual(a, b) {
  const ab = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));
  if (!ab.byteLength || ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function adminPath(env) {
  const p = String(env.ADMIN_PATH || "admin").trim().replace(/^\/+|\/+$/g, "");
  return `/${p || "admin"}`;
}

// Config resolution: env defaults, optionally overridden by CONFIG KV (cf. amclubs
// KV_CONFIG + BPB proxySettings cache-or-init + EDT config.json). KV is optional;
// without a binding the worker runs on env-only defaults. Stored configs migrate
// forward when CONFIG_VERSION bumps (BPB panelVersion pattern).
function defaults(env) {
  return {
    version: CONFIG_VERSION,
    allowedHosts: parseList(env.ALLOWED_HOSTS),
    extraBlockedHosts: parseList(env.BLOCKED_HOSTS),
    maxBody: clampInt(env.RELAY_MAX_BODY, DEFAULT_MAX_BODY, 1024, 4 * 1024 * 1024),
    timeoutMs: clampInt(
      env.RELAY_TIMEOUT_MS || env.UPSTREAM_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1000,
      25000,
    ),
  };
}

async function resolveConfig(env) {
  const base = defaults(env);
  if (!env.CONFIG?.get) return base;
  try {
    const stored = await env.CONFIG.get(CONFIG_KEY, { type: "json" });
    if (!stored) {
      await env.CONFIG.put(CONFIG_KEY, JSON.stringify(base));
      return base;
    }
    if (stored.version !== CONFIG_VERSION) {
      const migrated = sanitizeConfig(stored, base);
      await env.CONFIG.put(CONFIG_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return sanitizeConfig(stored, base);
  } catch {
    return base;
  }
}

// Best-effort audit trail (EDT log.json shape, capped). Never blocks the relay;
// uses waitUntil so slow KV never adds latency. No URLs/bodies stored, hosts only.
function audit(ctx, env, entry) {
  try {
    if (!env.CONFIG?.get || !env.CONFIG?.put) return;
    ctx?.waitUntil?.(
      (async () => {
        try {
          const cur = (await env.CONFIG.get(AUDIT_KEY, { type: "json" })) || [];
          cur.push({ at: new Date().toISOString(), ...entry });
          await env.CONFIG.put(AUDIT_KEY, JSON.stringify(cur.slice(-AUDIT_MAX)));
        } catch {
          // audit must never fail the request
        }
      })(),
    );
  } catch {
    // ignore
  }
}

function sanitizeConfig(input, fallback) {
  const out = { ...fallback, version: CONFIG_VERSION };
  if (Array.isArray(input?.allowedHosts)) out.allowedHosts = input.allowedHosts.map(String).slice(0, 100);
  if (Array.isArray(input?.extraBlockedHosts))
    out.extraBlockedHosts = input.extraBlockedHosts.map(String).slice(0, 100);
  if (Number.isFinite(+input?.maxBody)) out.maxBody = Math.min(Math.max(+input.maxBody, 1024), 4 * 1024 * 1024);
  if (Number.isFinite(+input?.timeoutMs))
    out.timeoutMs = Math.min(Math.max(+input.timeoutMs, 1000), 25000);
  return out;
}

function parseList(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 100);
}

function clampInt(v, fallback, min, max) {
  const n = parseInt(v || "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function timeoutMs(env) {
  return clampInt(env.UPSTREAM_TIMEOUT_MS || env.RELAY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 25000);
}

function isLogEnabled(url, env) {
  return url.searchParams.get("log") === "1" || env.ENABLE_LOG === "1";
}

// Block self-fetch (workers.dev), metadata endpoints, RFC1918/loopback literals,
// plus operator extraBlockedHosts (env BLOCKED_HOSTS or KV). Hostnames that resolve
// to private IPs can't be resolved at the edge without DNS, so this is a
// literal/hostname guard, not a full SSRF fix. Keep allowlist tight.
function isBlockedHost(hostname, selfHost, cfg) {
  const h = hostname.toLowerCase();
  if (h === selfHost.toLowerCase()) return true;
  if (h.endsWith(".workers.dev")) return true;
  if (h === "localhost" || h === "metadata.google.internal") return true;
  if (h === "169.254.169.254" || h === "[::ffff:169.254.169.254]") return true;
  if (/^127\./.test(h) || h === "::1" || h === "[::1]") return true;
  if (/^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|31)\.\d+\.\d+)$/.test(h)) return true;
  const extra = cfg?.extraBlockedHosts || [];
  if (extra.some((b) => h === b || h.endsWith(`.${b}`))) return true;
  return false;
}

// Optional strict allowlist (cf. EDT HOST): if ALLOWED_HOSTS (or KV allowedHosts)
// is non-empty, only those hosts (+ subdomains) may be fetched.
function isAllowedHost(hostname, cfg) {
  if (!cfg.allowedHosts.length) return true;
  const h = hostname.toLowerCase();
  return cfg.allowedHosts.some((a) => h === a || h.endsWith(`.${a}`));
}

function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function checkRate(request, cfg) {
  const now = Date.now();
  const ip = clientIp(request);
  const rec = hits.get(ip) || { count: 0, reset: now + RATE_WINDOW_MS };
  if (now > rec.reset) {
    rec.count = 0;
    rec.reset = now + RATE_WINDOW_MS;
  }
  rec.count++;
  hits.set(ip, rec);
  if (rec.count > RATE_LIMIT) {
    return {
      ok: false,
      res: json({ e: "rate limited" }, 429),
    };
  }
  void cfg;
  return { ok: true };
}

async function forwardViaUpstream(req, env, selfHost) {
  const upstreamUrl = env.UPSTREAM_FORWARDER_URL;
  const authKey = env.UPSTREAM_AUTH_KEY || "";
  if (!authKey) return json({ e: "upstream auth missing" }, 502);
  let parsed;
  try {
    parsed = new URL(upstreamUrl);
  } catch {
    return json({ e: "bad upstream url" }, 502);
  }
  if (parsed.protocol !== "https:") return json({ e: "upstream must be https" }, 502);
  if (parsed.hostname.toLowerCase() === String(selfHost || "").toLowerCase()) {
    return json({ e: "self-forward blocked" }, 502);
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs(env));
  try {
    const resp = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-upstream-auth": authKey },
      body: JSON.stringify({ u: req.u, m: req.m, h: req.h, b: req.b, ct: req.ct, r: req.r }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return json({ e: `upstream status ${resp.status}` }, 502);
    return new Response(await resp.text(), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return json({ e: `upstream: ${err?.message || err}` }, 502);
  } finally {
    clearTimeout(t);
  }
}

function encodeB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function strToB64(str) {
  return encodeB64(new TextEncoder().encode(str));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
