#!/usr/bin/env node
// treaulab tunnel agent: runs on the locked-down origin, dials OUT one
// WebSocket to the edge and serves the local upstream over it.
// Zero dependencies, Node 20+. Only needs OUTBOUND 443 (wss) + DNS.
//
//   EDGE_URL="wss://treau.me/t/<TOKEN>/<room>/__agent" \
//   UPSTREAM="http://127.0.0.1:8080" \
//   node agent.js
//
// Env: EDGE_URL (required), UPSTREAM (default http://127.0.0.1:8080),
//      UPSTREAM_TIMEOUT_MS (default 15000), NAME (default hostname).

const EDGE_URL = process.env.EDGE_URL;
if (!EDGE_URL) {
	console.error("EDGE_URL is required, e.g. wss://treau.me/t/<TOKEN>/<room>/__agent");
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
		let helloTimer;
		ws.onopen = () => {
			log("control socket open, registering as", NAME);
			ws.send(JSON.stringify({ type: "hello", name: NAME, version: 1 }));
			// If the edge never sees us (silent drop), fail fast and redial.
			helloTimer = setTimeout(() => {
				try {
					ws.close(4001, "no traffic");
				} catch {}
			}, 30_000);
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
			clearTimeout(helloTimer);
			const answer = await serveUpstream(msg);
			try {
				ws.send(JSON.stringify(answer));
			} catch {}
		};
		const done = (why) => {
			clearTimeout(helloTimer);
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
