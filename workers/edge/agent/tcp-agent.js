#!/usr/bin/env node
// treaulab pipe agent: runs on the locked-down box next to sshd, dials OUT one
// WebSocket to the edge and dials HOST:PORT per accepted stream.
// Zero dependencies, Node 22+. Only needs OUTBOUND 443 (wss) + DNS.
// Long-URL-only: box ID is the secret.
//
//   node tcp-agent.js [HOST:PORT] [--host H] [--id ID]
//   HOST:PORT defaults to 127.0.0.1:22. Omit --id to mint a fresh box id
//   and print it (pass that id to `tunnel add <name>`, or reuse via --id).
//   Env fallback (systemd, `tunnel up`): EDGE_URL + SSH_HOST/SSH_PORT.
//
// Frame: [type:u8][stream:u32be][payload]  OPEN=1 ACCEPT=2 DATA=3 FIN=4 RST=5

import net from "node:net";
import os from "node:os";
import {
	BACKOFF_BASE_MS,
	F_ACCEPT,
	F_DATA,
	F_FIN,
	F_HB,
	F_OPEN,
	F_RST,
	HEARTBEAT_MS,
	ID_RE,
	backoffAfterSession,
	isValidEdgeUrl,
	newRoomId,
	normalizeEdgeUrl,
	parseTcpTarget,
	resolveHost,
	wsBaseFromHttp,
} from "../lib/shared.js";

const _argv = process.argv.slice(2);
let _positional = null;
const _get = (f) => {
	const i = _argv.indexOf(f);
	return i >= 0 && _argv[i + 1] && !_argv[i + 1].startsWith("--") ? _argv[i + 1] : null;
};
for (let i = 0; i < _argv.length; i++) {
	const a = _argv[i];
	if (a === "--host" || a === "--id") {
		if (!_argv[i + 1] || _argv[i + 1].startsWith("--")) {
			console.error(`${a} needs a value — usage: tcp-agent.js [HOST:PORT] [--host H] [--id ID]`);
			process.exit(2);
		}
		i++;
		continue;
	}
	if (a.startsWith("--")) {
		console.error(`unknown flag ${JSON.stringify(a)} — usage: tcp-agent.js [HOST:PORT] [--host H] [--id ID]`);
		process.exit(2);
	}
	if (_positional === null) _positional = a;
	else {
		console.error(`unexpected argument ${JSON.stringify(a)} — usage: tcp-agent.js [HOST:PORT] [--host H] [--id ID]`);
		process.exit(2);
	}
}
// Bare run with no EDGE_URL mints a box id; a set EDGE_URL means
// persistent mode. Any explicit arg forces the new style.
if (_positional !== null || _get("--host") !== null || _get("--id") !== null || !process.env.EDGE_URL) {
	const host = resolveHost(_get("--host")).replace(/\/$/, "");
	const id = _get("--id") ?? newRoomId();
	if (!ID_RE.test(id)) {
		console.error(`bad id ${JSON.stringify(id)} — want 20-64 chars [A-Za-z0-9_-]`);
		process.exit(2);
	}
	const target = _positional ?? `${process.env.SSH_HOST ?? "127.0.0.1"}:${process.env.SSH_PORT ?? "22"}`;
	const parsed = parseTcpTarget(target);
	if (!parsed) {
		console.error(`bad target ${JSON.stringify(target)} — want HOST:PORT (e.g. 127.0.0.1:22)`);
		process.exit(2);
	}
	process.env.EDGE_URL = `${wsBaseFromHttp(host)}/p/${id}/__agent`;
	process.env.SSH_HOST = parsed.host;
	process.env.SSH_PORT = String(parsed.port);
	if (_get("--id") === null) {
		console.log(`pipe ready: box id ${id}   target ${parsed.host}:${parsed.port}   (ephemeral - stops with this process)`);
		console.log(`laptop: save it with \`tunnel add <name> ${parsed.host}:${parsed.port}\` using this id, then \`tunnel ssh <name>\``);
	}
}

const EDGE_URL_RAW = process.env.EDGE_URL;
if (!EDGE_URL_RAW) {
	console.error("give a target (e.g. node tcp-agent.js 127.0.0.1:22) or set EDGE_URL, e.g. wss://go.treau.me/p/<long-box-id>/__agent");
	process.exit(1);
}
// Accept https:// too (common paste mistake) — the wire is always WebSocket.
const EDGE_URL = normalizeEdgeUrl(EDGE_URL_RAW);
if (EDGE_URL !== EDGE_URL_RAW) {
	console.error(`note: using ${EDGE_URL} (converted from ${EDGE_URL_RAW})`);
}
if (!isValidEdgeUrl(EDGE_URL)) {
	console.error(`bad EDGE_URL ${JSON.stringify(EDGE_URL_RAW)} — want wss://<host>/p/<long-box-id>/__agent`);
	process.exit(1);
}
if (typeof WebSocket === "undefined") {
	console.error(`node ${process.versions.node} has no global WebSocket — need Node 22+ (https://nodejs.org/)`);
	process.exit(1);
}
const SSH_HOST = process.env.SSH_HOST ?? "127.0.0.1";
const SSH_PORT = Number(process.env.SSH_PORT ?? 22);
const NAME = process.env.NAME ?? os.hostname();

// Keepalive: idle control sockets get reaped (~60s Cloudflare/NAT idle
// timeout, close 1006). A heartbeat frame every 20s keeps it warm.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), "-", ...a);

function frame(type, stream, payload) {
	const body = payload ? Buffer.from(payload) : Buffer.alloc(0);
	const out = Buffer.allocUnsafe(5 + body.length);
	out[0] = type;
	out.writeUInt32BE(stream >>> 0, 1);
	body.copy(out, 5);
	return out;
}

function parse(buf) {
	if (buf.length < 5) return null;
	return { type: buf[0], stream: buf.readUInt32BE(1), payload: buf.subarray(5) };
}

function connectOnce() {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const sockets = new Map(); // stream -> net.Socket
		let dead = false;
		let hb;
		const ws = new WebSocket(EDGE_URL);
		ws.binaryType = "arraybuffer";

		const send = (buf) => {
			try {
				ws.send(buf);
				return true;
			} catch {
				return false;
			}
		};
		const killAll = () => {
			for (const [, s] of sockets) s.destroy();
			sockets.clear();
		};
		const done = (why) => {
			if (dead) return;
			dead = true;
			clearInterval(hb);
			killAll();
			log("control socket closed:", why);
			resolve(Date.now() - startedAt);
		};

		ws.onopen = () => {
			log("control socket open, serving", `${SSH_HOST}:${SSH_PORT}`);
			hb = setInterval(() => send(frame(F_HB, 0)), HEARTBEAT_MS);
		};
		ws.onmessage = (ev) => {
			const f = parse(Buffer.from(ev.data));
			if (!f) return;
			if (f.type === F_OPEN) {
				log(`stream ${f.stream}: opening -> ${SSH_HOST}:${SSH_PORT}`);
				const sock = net.connect(SSH_PORT, SSH_HOST);
				sockets.set(f.stream, sock);
				sock.on("connect", () => {
					if (!send(frame(F_ACCEPT, f.stream))) sock.destroy();
				});
				sock.on("data", (chunk) => {
					if (!send(frame(F_DATA, f.stream, chunk))) sock.destroy();
				});
				sock.on("close", () => {
					sockets.delete(f.stream);
					send(frame(F_FIN, f.stream));
				});
				sock.on("error", () => {
					sockets.delete(f.stream);
					send(frame(F_RST, f.stream));
				});
			} else if (f.type === F_DATA) {
				sockets.get(f.stream)?.write(f.payload);
			} else if (f.type === F_FIN) {
				log(`stream ${f.stream}: FIN, ending`);
				sockets.get(f.stream)?.end();
			} else if (f.type === F_RST) {
				log(`stream ${f.stream}: RST, destroying`);
				const s = sockets.get(f.stream);
				sockets.delete(f.stream);
				s?.destroy();
			}
		};
		ws.onclose = (e) => done(`code=${e.code} reason=${e.reason || "-"}`);
		ws.onerror = () => {};
	});
}

log("pipe agent starting:", NAME, "->", `${SSH_HOST}:${SSH_PORT}`);
let backoff = BACKOFF_BASE_MS;
for (;;) {
	const sessionMs = await connectOnce();
	const wait = Math.min(backoff, 30_000) * (0.8 + Math.random() * 0.4);
	log(`redial in ${(wait / 1000).toFixed(1)}s`);
	await sleep(wait);
	backoff = backoffAfterSession(backoff, sessionMs);
}
