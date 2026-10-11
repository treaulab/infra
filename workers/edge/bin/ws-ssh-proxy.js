#!/usr/bin/env node
// treaulab ssh ProxyCommand helper: shuttles stdio <-> edge pipe as raw bytes.
// Zero dependencies, Node 22+. Usage in ~/.ssh/config:
//
//   Host lockedvps
//     HostName lockedvps
//     ProxyCommand node /path/to/ws-ssh-proxy.js wss://go.treau.me/p/<long-box-id>
//     ServerAliveInterval 25
//     ServerAliveCountMax 3
//
// Then: ssh lockedvps   |   scp file lockedvps:/tmp/   |   sftp lockedvps
// Exit 0 = clean FIN from the far end; 1 = anything else (never silent).

import { HALF_CLOSE_TEXT } from "../lib/shared.js";

const EDGE_URL_RAW = process.argv[2];
if (!EDGE_URL_RAW || !/^wss?:\/\//.test(EDGE_URL_RAW)) {
	console.error("usage: ws-ssh-proxy.js wss://<host>/p/<long-box-id>");
	process.exit(2);
}
const EDGE_URL = EDGE_URL_RAW;
if (EDGE_URL.startsWith("ws://")) {
	console.error("ws-ssh-proxy: warning: cleartext ws:// (local dev only)");
}
if (typeof WebSocket === "undefined") {
	console.error(`ws-ssh-proxy: node ${process.versions.node} has no global WebSocket — need Node 22+`);
	process.exit(1);
}

const fail = (msg, code = 1) => {
	console.error(`ws-ssh-proxy: ${msg}`);
	process.exit(code);
};

const ws = new WebSocket(EDGE_URL);
ws.binaryType = "arraybuffer";

let stdinEnded = false;
let wsClosed = false;
let drainTimer = null;

function clearDrain() {
	if (drainTimer) {
		clearInterval(drainTimer);
		drainTimer = null;
	}
}

ws.onopen = () => {
	process.stdin.on("data", (chunk) => {
		if (wsClosed) return;
		try {
			ws.send(chunk);
		} catch {
			fail("send failed (edge unreachable?)");
		}
		// Simple backpressure: pause stdin while the socket drains.
		if (ws.bufferedAmount > 1024 * 1024 && !drainTimer) {
			process.stdin.pause();
			drainTimer = setInterval(() => {
				if (ws.bufferedAmount < 256 * 1024 || wsClosed) {
					clearDrain();
					if (!wsClosed && !stdinEnded) process.stdin.resume();
				}
			}, 50);
		}
	});
	process.stdin.on("end", () => {
		stdinEnded = true;
		// Half-close: signal EOF downstream but keep delivering the response
		// (ssh parity for `ssh host cmd < file`). TEXT frame: binary DATA can
		// never collide with it (old 5-byte binary magic still accepted by
		// the edge for old proxies). Exit still driven by server close.
		try {
			ws.send(HALF_CLOSE_TEXT);
		} catch {
			fail("send failed (edge unreachable?)");
		}
	});
	process.stdin.on("error", () => fail("stdin error"));
};

// ssh kills us (SIGTERM) when the session ends from its side.
process.on("SIGTERM", () => {
	clearDrain();
	try {
		ws.close(1000, "terminated");
	} catch {}
	process.exit(0);
});

ws.onmessage = (ev) => {
	try {
		process.stdout.write(Buffer.from(ev.data));
	} catch {
		fail("stdout write failed");
	}
};

ws.onclose = (e) => {
	wsClosed = true;
	clearDrain();
	if (e.code === 1000) process.exit(0);
	fail(`tunnel closed (code=${e.code}${e.reason ? ` reason=${e.reason}` : ""})`);
};

ws.onerror = () => {
	// onclose follows with the real code; this just guards silence.
	setTimeout(() => {
		if (!wsClosed) fail("websocket error (no agent? wrong URL?)");
	}, 500);
};
