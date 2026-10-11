#!/usr/bin/env node
// treaulab tunnel agent: runs on the locked-down origin, dials OUT one
// WebSocket to the edge and serves the local upstream over it.
// Zero dependencies, Node 22+ (global WebSocket + fetch). Also compiles to a
// standalone binary with `bun build --compile` (no runtime needed on the box).
// Long-URL-only: the room ID in the URL is the secret (no token).
//
//   node agent.js [UPSTREAM] [--host H] [--id ID] [--json]
//   UPSTREAM defaults to http://127.0.0.1:8080. Omit --id to mint a fresh
//   room, print the public URL, and run (ephemeral — Ctrl-C stops it).
//   Pass --id to reuse a room (e.g. the id from `tunnel info <name>`).
//
//   UPSTREAM="http://127.0.0.1:8080" node agent.js --host https://go.treau.me
//
// Env fallback (systemd, `tunnel up`): EDGE_URL + UPSTREAM work as before.
// Other env: UPSTREAM_TIMEOUT_MS (default 15000, time to first byte; bodies
// stream with no total cap), NAME (default hostname),
// TUNNEL_HOST (default https://go.treau.me, used when --host is absent),
// MAX_CONCURRENT (default 16),
// MAX_TUNNEL_BYTES (default 500 MiB safety ceiling per stream).

import {
	BACKOFF_BASE_MS,
	DEFAULT_HOST,
	HEARTBEAT_MS,
	HOP_HEADERS as HOP,
	ID_RE,
	TUNNEL_CHUNK_BYTES,
	TUNNEL_VERSION,
	T_DATA,
	T_FIN,
	T_FLAG_FIN,
	T_FLAG_TEXT,
	T_HB,
	T_HEADERS,
	T_HELLO,
	T_RST,
	backoffAfterSession,
	decodeTunnelFrame,
	encodeTunnelFrame,
	isValidEdgeUrl,
	newRoomId,
	normalizeEdgeUrl,
	parseTunnelHeaders,
	resolveHost,
	tunnelHeadersPayload,
	wsBaseFromHttp,
} from "../lib/shared.js";

const _te = new TextEncoder();
const _td = new TextDecoder();

const _argv = process.argv.slice(2);
if (_argv.includes("--share") || _argv.includes("--url") || _argv.includes("--upstream")) {
	console.error("usage: agent.js [UPSTREAM] [--host H] [--id ID] [--json]  (--share/--url/--upstream are gone; pass UPSTREAM positionally)");
	process.exit(2);
}
const _get = (f) => {
	const i = _argv.indexOf(f);
	return i >= 0 && _argv[i + 1] && !_argv[i + 1].startsWith("--") ? _argv[i + 1] : null;
};
let _positional = null;
for (let i = 0; i < _argv.length; i++) {
	const a = _argv[i];
	if (a === "--host" || a === "--id") {
		if (!_argv[i + 1] || _argv[i + 1].startsWith("--")) {
			console.error(`${a} needs a value — usage: agent.js [UPSTREAM] [--host H] [--id ID] [--json]`);
			process.exit(2);
		}
		i++; // skip its value
		continue;
	}
	if (a === "--json") continue;
	if (a.startsWith("--")) {
		console.error(`unknown flag ${JSON.stringify(a)} — usage: agent.js [UPSTREAM] [--host H] [--id ID] [--json]`);
		process.exit(2);
	}
	if (_positional === null) _positional = a;
	else {
		console.error(`unexpected argument ${JSON.stringify(a)} — usage: agent.js [UPSTREAM] [--host H] [--id ID] [--json]`);
		process.exit(2);
	}
}
// Bare run with no EDGE_URL mints a room (one-command share); a set
// EDGE_URL means persistent mode. Any explicit arg forces the new style.
const _newStyle =
	_positional !== null || _get("--host") !== null || _get("--id") !== null || !process.env.EDGE_URL;
if (_newStyle) {
	const host = resolveHost(_get("--host")).replace(/\/$/, "");
	const id = _get("--id") ?? newRoomId();
	if (!ID_RE.test(id)) {
		console.error(`bad id ${JSON.stringify(id)} — want 20-64 chars [A-Za-z0-9_-]`);
		process.exit(2);
	}
	const upstream = (_positional || process.env.UPSTREAM || "http://127.0.0.1:8080").replace(/\/$/, "");
	process.env.EDGE_URL = `${wsBaseFromHttp(host)}/t/${id}/__agent`;
	process.env.UPSTREAM = upstream;
	if (_get("--id") === null) {
		const url = `${host}/t/${id}/`;
		if (_argv.includes("--json")) console.log(JSON.stringify({ url, id, upstream }));
		else {
			console.log(`tunnel ready: ${url}`);
			console.log(`id: ${id}   upstream: ${upstream}   (ephemeral - stops with this process)`);
		}
	}
}

const EDGE_URL_RAW = process.env.EDGE_URL;
if (!EDGE_URL_RAW) {
	console.error("give an upstream (e.g. node agent.js http://127.0.0.1:8080) or set EDGE_URL, e.g. wss://go.treau.me/t/<long-id>/__agent");
	process.exit(1);
}
// Accept https:// too (common paste mistake) — the wire is always WebSocket.
const EDGE_URL = normalizeEdgeUrl(EDGE_URL_RAW);
if (EDGE_URL !== EDGE_URL_RAW) {
	console.error(`note: using ${EDGE_URL} (converted from ${EDGE_URL_RAW})`);
}
if (!isValidEdgeUrl(EDGE_URL)) {
	console.error(`bad EDGE_URL ${JSON.stringify(EDGE_URL_RAW)} — want wss://<host>/t/<long-room-id>/__agent`);
	process.exit(1);
}
if (typeof WebSocket === "undefined") {
	console.error(`node ${process.versions.node} has no global WebSocket — need Node 22+ (https://nodejs.org/)`);
	process.exit(1);
}
const UPSTREAM = (process.env.UPSTREAM ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 15000);
const NAME = process.env.NAME ?? (await import("node:os")).hostname();
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? 16);
const MAX_TUNNEL_BYTES = Number(process.env.MAX_TUNNEL_BYTES ?? 500 * 1024 * 1024);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), "-", ...a);

// Keepalive: idle control sockets get reaped (~60s Cloudflare/NAT idle
// timeout, close 1006). A binary HB frame every 20s keeps it warm.

function validPath(p) {
	return typeof p === "string" && p.startsWith("/") && !p.includes("://") && p.length <= 8192;
}

function buildHeaders(obj) {
	const headers = {};
	for (const [k, v] of Object.entries(obj ?? {})) {
		if (!HOP.has(String(k).toLowerCase()) && typeof v === "string") headers[k] = v;
	}
	return headers;
}

function sendFrame(ws, type, stream, payload, flags = 0) {
	try {
		ws.send(encodeTunnelFrame(type, stream, payload, flags));
		return true;
	} catch {
		return false;
	}
}

const rst = (ws, stream, msg) => sendFrame(ws, T_RST, stream, _te.encode(msg));

// Upload state: streamId -> http-upload | ws-bridge.
const streams = new Map();
let inFlight = 0;

async function fetchUpstream({ method, path, headers, body }) {
	const target = UPSTREAM + path;
	const ctrl = new AbortController();
	// Timeout applies to first byte only: SSE / long streams stay open once
	// headers arrive. The timer is cleared on first byte (see callers).
	const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
	try {
		const res = await fetch(target, {
			method,
			headers,
			body,
			signal: ctrl.signal,
			redirect: "manual",
			// Required in Node when body is a stream; harmless otherwise.
			duplex: body instanceof ReadableStream ? "half" : undefined,
		});
		return { res, timer, ctrl };
	} catch (e) {
		clearTimeout(timer);
		throw e;
	}
}

async function streamResponseToEdge(ws, id, res, timer, ctrl) {
	const out = {};
	res.headers.forEach((v, k) => {
		if (!HOP.has(k.toLowerCase())) out[k] = v;
	});
	if (!sendFrame(ws, T_HEADERS, id, tunnelHeadersPayload({ status: res.status, headers: out }))) return;
	let firstByte = true;
	try {
		if (!res.body) {
			clearTimeout(timer);
			sendFrame(ws, T_FIN, id);
			return;
		}
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (firstByte) {
				firstByte = false;
				clearTimeout(timer);
			}
			if (done) break;
			if (!value?.length) continue;
			for (let off = 0; off < value.length; off += TUNNEL_CHUNK_BYTES) {
				const piece = value.subarray(off, off + TUNNEL_CHUNK_BYTES);
				if (!sendFrame(ws, T_DATA, id, piece)) return;
			}
		}
		clearTimeout(timer);
		sendFrame(ws, T_FIN, id);
	} catch (e) {
		clearTimeout(timer);
		// Mid-stream failure: the edge has already sent headers, so RST (the
		// browser sees a truncated stream).
		try {
			ctrl.abort();
		} catch {}
		rst(ws, id, String(e?.message ?? e));
	}
}

// HTTP upload: the request body arrives as DATA frames and is fed straight
// into fetch via a ReadableStream — never reassembled, no size wall except
// the MAX_TUNNEL_BYTES safety ceiling.
async function serveHttp(ws, id, head) {
	if (!validPath(head.path)) {
		rst(ws, id, "bad path");
		return;
	}
	if (inFlight >= MAX_CONCURRENT) {
		rst(ws, id, "overloaded");
		return;
	}
	inFlight++;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		streams.delete(id);
		inFlight--;
	};
	// Placeholder so an edge RST during TTFB is observed (no silent work).
	streams.set(id, { kind: "http-pending", id, release });
	try {
		const headers = buildHeaders(head.headers);
		let body = undefined;
		if (head.method !== "GET" && head.method !== "HEAD") {
			let push;
			let total = 0;
			body = new ReadableStream({
				start(c) {
					push = c;
				},
			});
			streams.set(id, {
				kind: "http-upload",
				id,
				release,
				onData: (bytes) => {
					total += bytes.length;
					if (total > MAX_TUNNEL_BYTES) {
						rst(ws, id, "request body too big");
						try {
							push.error(new Error("request body too big"));
						} catch {}
						release();
						return;
					}
					try {
						push.enqueue(bytes);
					} catch {
						release();
					}
				},
				onFin: () => {
					try {
						push.close();
					} catch {}
				},
			});
		}
		let fetched;
		try {
			fetched = await fetchUpstream({ method: head.method, path: head.path, headers, body });
		} catch (e) {
			// Edge RST may have won the race (released): then stay silent.
			if (!released) {
				release();
				rst(ws, id, e?.name === "AbortError" ? "upstream timeout" : String(e?.message ?? e));
			}
			return;
		}
		if (released) {
			// Edge RST landed mid-fetch: drop the response.
			try {
				fetched.ctrl.abort();
			} catch {}
			clearTimeout(fetched.timer);
			return;
		}
		// Upload done; the response phase owns the stream now so a later
		// edge RST can abort it mid-body.
		streams.set(id, { kind: "http-response", id, release, ctrl: fetched.ctrl });
		await streamResponseToEdge(ws, id, fetched.res, fetched.timer, fetched.ctrl);
		release();
	} catch {
		release();
	}
}

// Visitor WS stream: dial the local upstream as WS and bridge both ways.
function serveWsBridge(ws, id, head) {
	if (!validPath(head.path)) {
		rst(ws, id, "bad path");
		return;
	}
	if (inFlight >= MAX_CONCURRENT) {
		rst(ws, id, "overloaded");
		return;
	}
	inFlight++;
	const finish = () => {
		if (streams.get(id)?.kind === "ws") {
			streams.delete(id);
			inFlight--;
		}
	};
	const wsUrl = UPSTREAM.replace(/^http/, "ws") + head.path;
	let up;
	try {
		up = new WebSocket(wsUrl);
	} catch (e) {
		inFlight--;
		rst(ws, id, "upstream ws dial failed");
		return;
	}
	if (typeof up.binaryType !== "undefined") {
		try {
			up.binaryType = "arraybuffer";
		} catch {}
	}
	streams.set(id, { kind: "ws", up, finish, id });
	let opened = false;
	up.onopen = () => {
		opened = true;
		if (!streams.has(id)) {
			try {
				up.close();
			} catch {}
			return;
		}
		sendFrame(ws, T_HEADERS, id, tunnelHeadersPayload({ status: 101, headers: {} }));
	};
	up.onmessage = async (ev) => {
		if (!streams.has(id)) return;
		let bytes;
		let text = false;
		try {
			if (typeof ev.data === "string") {
				bytes = _te.encode(ev.data);
				text = true;
			} else if (ev.data instanceof Blob) bytes = new Uint8Array(await ev.data.arrayBuffer());
			else bytes = new Uint8Array(ev.data);
		} catch {
			return;
		}
		const flags = text ? T_FLAG_TEXT : 0;
		for (let off = 0; off < bytes.length || bytes.length === 0; off += TUNNEL_CHUNK_BYTES) {
			const piece = bytes.subarray(off, off + TUNNEL_CHUNK_BYTES);
			if (!sendFrame(ws, T_DATA, id, piece, flags)) return;
			if (bytes.length === 0) break;
		}
	};
	const endToEdge = (ok) => {
		if (!streams.has(id)) return;
		finish();
		if (opened) sendFrame(ws, T_FIN, id);
		else rst(ws, id, "upstream ws failed");
	};
	up.onclose = () => endToEdge();
	up.onerror = () => {
		try {
			up.close();
		} catch {}
	};
}

async function messageBytes(data) {
	if (typeof data === "string") return null; // protocol violation path
	if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return new Uint8Array(data);
}

function connectOnce() {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const ws = new WebSocket(EDGE_URL);
		if (typeof ws.binaryType !== "undefined") {
			try {
				ws.binaryType = "arraybuffer";
			} catch {}
		}
		let hb;
		let dead = false;
		const myStreams = new Set();
		const killStreams = () => {
			for (const id of myStreams) {
				const s = streams.get(id);
				if (!s) continue;
				if (s.release) s.release();
				else {
					streams.delete(id);
					inFlight--;
				}
				if (s.kind === "ws") {
					try {
						s.up.close();
					} catch {}
				}
			}
			myStreams.clear();
		};
		ws.onopen = () => {
			log("control socket open, registering as", NAME);
			sendFrame(ws, T_HELLO, 0, tunnelHeadersPayload({ name: NAME, version: TUNNEL_VERSION }));
			// Heartbeat replaces the old "close if silent" timer: quiet
			// tunnels are healthy and must stay up, not redial every 30s.
			hb = setInterval(() => {
				sendFrame(ws, T_HB, 0);
			}, HEARTBEAT_MS);
		};
		ws.onmessage = async (ev) => {
			if (dead) return;
			let raw;
			try {
				raw = await messageBytes(ev.data);
			} catch {
				return;
			}
			if (!raw) return; // text frame on a binary wire: ignore
			const f = decodeTunnelFrame(raw);
			if (!f) return;
			if (f.type === T_HB) return;
			if (f.type === T_HELLO) return; // edge never sends HELLO
			if (f.stream === 0) return;
			const id = f.stream;
			if (f.type === T_HEADERS) {
				const head = parseTunnelHeaders(f.payload);
				if (!head || typeof head.method !== "string") {
					rst(ws, id, "bad HEADERS");
					return;
				}
				myStreams.add(id);
				if (head.method === "WS") serveWsBridge(ws, id, head);
				else serveHttp(ws, id, head);
				return;
			}
			const s = streams.get(id);
			if (!s) {
				rst(ws, id, "unknown stream");
				return;
			}
			if (f.type === T_DATA) {
				if (s.kind === "http-upload" && s.onData) {
					s.onData(new Uint8Array(f.payload));
				} else if (s.kind === "ws") {
					try {
						if (f.flags & T_FLAG_TEXT) s.up.send(_td.decode(f.payload));
						else s.up.send(Buffer.from(f.payload));
					} catch {
						/* upstream gone; its onclose ends the stream */
					}
				}
				// DATA for an http-response stream is a protocol violation;
				// ignore it (edge never sends it).
				if (f.flags & T_FLAG_FIN) {
					myStreams.delete(id);
					if (s.kind === "http-upload" && s.onFin) s.onFin();
					else if (s.kind === "ws") {
						try {
							s.up.close();
						} catch {}
					}
				}
				return;
			}
			if (f.type === T_FIN) {
				myStreams.delete(id);
				if (s.kind === "http-upload" && s.onFin) s.onFin();
				else if (s.kind === "ws") {
					try {
						s.up.close();
					} catch {}
				}
				return;
			}
			if (f.type === T_RST) {
				myStreams.delete(id);
				if (s.kind === "ws") {
					streams.delete(id);
					inFlight--;
					try {
						s.up.close();
					} catch {}
				} else if (s.release) {
					// http-upload or http-response: abort the upstream fetch.
					try {
						s.ctrl?.abort();
					} catch {}
					s.release();
				}
				return;
			}
		};
		const done = (why) => {
			if (dead) return;
			dead = true;
			clearInterval(hb);
			killStreams();
			log("control socket closed:", why);
			resolve(Date.now() - startedAt);
		};
		ws.onclose = (e) => done(`code=${e.code} reason=${e.reason || "-"}`);
		ws.onerror = () => {};
	});
}

log("agent starting:", NAME, "-> upstream", UPSTREAM);
let backoff = BACKOFF_BASE_MS;
for (;;) {
	const sessionMs = await connectOnce();
	const wait = Math.min(backoff, 30_000) * (0.8 + Math.random() * 0.4);
	log(`redial in ${(wait / 1000).toFixed(1)}s`);
	await sleep(wait);
	backoff = backoffAfterSession(backoff, sessionMs);
}
