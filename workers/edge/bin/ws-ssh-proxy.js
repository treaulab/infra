#!/usr/bin/env node
// treaulab ssh ProxyCommand helper: shuttles stdio <-> edge pipe as raw bytes.
// Zero dependencies, Node 20+. Usage in ~/.ssh/config:
//
//   Host lockedvps
//     HostName lockedvps
//     ProxyCommand node /path/to/ws-ssh-proxy.js wss://treau.me/p/<PIPE_TOKEN>/<box>
//     ServerAliveInterval 25
//     ServerAliveCountMax 3
//
// Then: ssh lockedvps   |   scp file lockedvps:/tmp/   |   sftp lockedvps
// Exit 0 = clean FIN from the far end; 1 = anything else (never silent).

const EDGE_URL = process.argv[2];
if (!EDGE_URL || !/^wss?:\/\//.test(EDGE_URL)) {
	console.error("usage: ws-ssh-proxy.js wss://<host>/p/<TOKEN>/<box>");
	process.exit(2);
}
if (EDGE_URL.startsWith("ws://")) {
	console.error("ws-ssh-proxy: warning: cleartext ws:// (local dev only)");
}

const fail = (msg, code = 1) => {
	console.error(`ws-ssh-proxy: ${msg}`);
	process.exit(code);
};

const ws = new WebSocket(EDGE_URL);
ws.binaryType = "arraybuffer";

let stdinEnded = false;
let wsClosed = false;

ws.onopen = () => {
	process.stdin.on("data", (chunk) => {
		try {
			ws.send(chunk);
		} catch {
			fail("send failed (edge unreachable?)");
		}
		// Simple backpressure: pause stdin while the socket drains.
		if (ws.bufferedAmount > 1024 * 1024) {
			process.stdin.pause();
			const t = setInterval(() => {
				if (ws.bufferedAmount < 256 * 1024 || wsClosed) {
					clearInterval(t);
					if (!wsClosed && !stdinEnded) process.stdin.resume();
				}
			}, 50);
		}
	});
	process.stdin.on("end", () => {
		stdinEnded = true;
		// Half-close: signal EOF downstream but keep delivering the response
		// (ssh parity for `ssh host cmd < file`). The 5-byte FIN signal is
		// recognized by the edge; see PIPE.md. Exit still driven by server close.
		try {
			ws.send(Buffer.from([4, 0, 0, 0, 0]));
		} catch {
			fail("send failed (edge unreachable?)");
		}
	});
	process.stdin.on("error", () => fail("stdin error"));
};

// ssh kills us (SIGTERM) when the session ends from its side.
process.on("SIGTERM", () => {
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
	if (e.code === 1000) process.exit(0);
	fail(`tunnel closed (code=${e.code}${e.reason ? ` reason=${e.reason}` : ""})`);
};

ws.onerror = () => {
	// onclose follows with the real code; this just guards silence.
	setTimeout(() => {
		if (!wsClosed) fail("websocket error (no agent? wrong token?)");
	}, 500);
};
