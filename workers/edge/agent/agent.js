#!/usr/bin/env node
// treaulab tunnel agent: runs on the locked-down origin, dials OUT one
// WebSocket to the edge and serves the local upstream over it.
// Zero dependencies, Node 22+ (global WebSocket + fetch).
// Long-URL-only: the room ID in EDGE_URL is the secret (no token).
//
//   EDGE_URL="wss://go.treau.me/t/<long-room-id>/__agent" \
//   UPSTREAM="http://127.0.0.1:8080" \
//   node agent.js
//
// Env: EDGE_URL (required), UPSTREAM (default http://127.0.0.1:8080),
//      UPSTREAM_TIMEOUT_MS (default 15000), NAME (default hostname).

const EDGE_URL_RAW = process.env.EDGE_URL;
if (!EDGE_URL_RAW) {
	console.error("EDGE_URL is required, e.g. wss://go.treau.me/t/<long-room-id>/__agent");
	process.exit(1);
}
// Accept https:// too (common paste mistake) — the wire is always WebSocket.
const EDGE_URL = EDGE_URL_RAW.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
if (EDGE_URL !== EDGE_URL_RAW) {
	console.error(`note: using ${EDGE_URL} (converted from ${EDGE_URL_RAW})`);
}
if (!/^wss?:\/\//.test(EDGE_URL)) {
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
const MAX_BODY = 5 * 1024 * 1024;

const HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
	"content-length",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), "-", ...a);

// Keepalive: idle control sockets get reaped (~60s Cloudflare/NAT idle
// timeout, close 1006). The edge ignores {"type":"pong"} (see src/tunnel.js),
// so a pong every 20s is pure keepalive traffic, both directions stay warm.
const HEARTBEAT_MS = 20_000;

async function serveUpstream(env) {
	const target = UPSTREAM + env.path;
	const headers = {};
	for (const [k, v] of Object.entries(env.headers ?? {})) {
		if (!HOP.has(String(k).toLowerCase()) && typeof v === "string") headers[k] = v;
	}
	let body;
	if (env.bodyB64) body = Buffer.from(env.bodyB64, "base64");
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
	try {
		const res = await fetch(target, {
			method: env.method,
			headers,
			body,
			signal: ctrl.signal,
			redirect: "manual",
		});
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > MAX_BODY) return { type: "err", id: env.id, message: "body too big" };
		const out = {};
		res.headers.forEach((v, k) => {
			if (!HOP.has(k.toLowerCase())) out[k] = v;
		});
		return {
			type: "res",
			id: env.id,
			status: res.status,
			headers: out,
			bodyB64: buf.length ? buf.toString("base64") : null,
		};
	} catch (e) {
		return { type: "err", id: env.id, message: e?.name === "AbortError" ? "upstream timeout" : String(e?.message ?? e) };
	} finally {
		clearTimeout(timer);
	}
}

function connectOnce() {
	return new Promise((resolve) => {
		const ws = new WebSocket(EDGE_URL);
		let hb;
		ws.onopen = () => {
			log("control socket open, registering as", NAME);
			ws.send(JSON.stringify({ type: "hello", name: NAME, version: 1 }));
			// Heartbeat replaces the old "close if silent" timer: quiet
			// tunnels are healthy and must stay up, not redial every 30s.
			hb = setInterval(() => {
				try {
					ws.send(JSON.stringify({ type: "pong" }));
				} catch {}
			}, HEARTBEAT_MS);
		};
		ws.onmessage = async (ev) => {
			let msg;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (msg?.type === "ping") {
				try {
					ws.send(JSON.stringify({ type: "pong" }));
				} catch {}
				return;
			}
			if (msg?.type !== "req" || typeof msg?.id !== "string") return;
			const answer = await serveUpstream(msg);
			try {
				ws.send(JSON.stringify(answer));
			} catch {}
		};
		const done = (why) => {
			clearInterval(hb);
			log("control socket closed:", why);
			resolve();
		};
		ws.onclose = (e) => done(`code=${e.code} reason=${e.reason || "-"}`);
		ws.onerror = () => {};
	});
}

log("agent starting:", NAME, "-> upstream", UPSTREAM);
let backoff = 1000;
for (;;) {
	await connectOnce();
	const wait = Math.min(backoff, 30_000) * (0.8 + Math.random() * 0.4);
	log(`redial in ${(wait / 1000).toFixed(1)}s`);
	await sleep(wait);
	backoff = Math.min(backoff * 2, 30_000);
}
