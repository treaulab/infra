// Worse-cloudflared, TCP edition: multiplexed raw-byte pipe over WebSocket.
// The locked-down origin dials OUT (agent); laptop ssh dials IN (client).
// One agent socket carries N streams; one client socket == one stream.
// Azure TREAU is never in the path: no origin fetch anywhere in this file.
//
// Frame: [type:u8][stream:u32be][payload...]  (all frames binary)
//   OPEN   client->edge (stream=0): open a stream; edge assigns id, forwards
//   ACCEPT agent->edge: TCP dial to :22 succeeded, stream is live
//   DATA   both ways: raw bytes (SSH ciphertext; edge never logs bodies)
//   FIN    both ways: clean close, forward + tear down stream
//   RST    both ways: abort stream immediately
//
// Hibernation-safe: pairing is rebuilt from socket attachments on wake
// (constructor), stream ids are random 31-bit so they survive counter reset.

const F_OPEN = 1;
const F_ACCEPT = 2;
const F_DATA = 3;
const F_FIN = 4;
const F_RST = 5;
// Heartbeat (agent -> edge only): keeps idle control sockets from being
// reaped. Never references a stream; the edge drops it silently.
const F_HB = 0;

const MAX_DATA = 256 * 1024;
const ACCEPT_TIMEOUT_MS = 10_000;

// Edge -> client close codes: 1000 = clean FIN, 1011 = error/RST.
function frame(type, stream, payload) {
	const body = payload ?? new Uint8Array(0);
	const out = new Uint8Array(5 + body.length);
	out[0] = type;
	new DataView(out.buffer).setUint32(1, stream >>> 0);
	out.set(body, 5);
	return out;
}

function parseFrame(message) {
	const bytes =
		typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message);
	if (bytes.length < 5) return null;
	return {
		type: bytes[0],
		stream: new DataView(bytes.buffer, bytes.byteOffset, 5).getUint32(1),
		payload: bytes.subarray(5),
	};
}

function newStreamId(taken) {
	let id = 0;
	do {
		id = (crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff) >>> 0;
	} while (id === 0 || taken.has(id));
	return id >>> 0;
}

export class PipeRoom {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
		this.agent = null;
		this.agentGen = null;
		this.streams = new Map(); // id -> {ws, timer}
		// Rebuild pairing after hibernation wake (memory was wiped).
		for (const ws of this.ctx.getWebSockets()) {
			let a;
			try {
				a = ws.deserializeAttachment();
			} catch {
				continue;
			}
			if (!a || typeof a !== "object") continue;
			if (a.role === "agent") {
				this.agent = ws;
				this.agentGen = a.gen;
			} else if (a.role === "client" && Number.isInteger(a.stream)) {
				this.streams.set(a.stream, { ws, timer: null });
			}
		}
	}

	// ---- entry -----------------------------------------------------------
	async fetch(request) {
		const role = request.headers.get("X-Tunnel-Role") ?? "client";
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected Upgrade: websocket", { status: 426 });
		}
		if (role === "agent") return this.registerAgent();
		// Client: fail fast when nobody is home so ssh errors, never hangs.
		if (!this.agent) return new Response("No agent connected", { status: 502 });
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		const id = newStreamId(this.streams);
		server.serializeAttachment({ role: "client", stream: id });
		this.ctx.acceptWebSocket(server);
		const timer = setTimeout(() => this.acceptTimeout(id), ACCEPT_TIMEOUT_MS);
		this.streams.set(id, { ws: server, timer, halfClosed: false });
		try {
			this.agent.send(frame(F_OPEN, id));
		} catch {
			this.dropAgent("agent send failed");
			return new Response("Agent unreachable", { status: 502 });
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	registerAgent() {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		const gen = crypto.randomUUID();
		server.serializeAttachment({ role: "agent", gen });
		if (this.agent) {
			try {
				this.agent.close(4000, "superseded");
			} catch {
				/* gone */
			}
		}
		this.failAllStreams(1011, "agent reconnected");
		this.agent = server;
		this.agentGen = gen;
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	// ---- helpers ---------------------------------------------------------
	isLiveAgent(ws) {
		if (!this.agent || ws !== this.agent) return false;
		try {
			const a = ws.deserializeAttachment();
			return a?.role === "agent" && a?.gen === this.agentGen;
		} catch {
			return false;
		}
	}

	streamOf(ws) {
		try {
			const a = ws.deserializeAttachment();
			if (a?.role === "client" && Number.isInteger(a?.stream)) return a.stream;
		} catch {
			/* fall through */
		}
		for (const [id, s] of this.streams) if (s.ws === ws) return id;
		return null;
	}

	sendAgent(bytes) {
		try {
			this.agent.send(bytes);
			return true;
		} catch {
			this.dropAgent("agent send failed");
			return false;
		}
	}

	closeClient(id, code, reason) {
		const s = this.streams.get(id);
		if (!s) return;
		this.streams.delete(id);
		if (s.timer) clearTimeout(s.timer);
		try {
			s.ws.close(code, reason);
		} catch {
			/* gone */
		}
	}

	acceptTimeout(id) {
		const s = this.streams.get(id);
		if (!s) return;
		this.sendAgent(frame(F_RST, id));
		this.closeClient(id, 1011, "agent accept timeout");
	}

	failAllStreams(code, reason) {
		for (const id of [...this.streams.keys()]) this.closeClient(id, code, reason);
	}

	dropAgent(reason = "agent disconnected") {
		this.agent = null;
		this.agentGen = null;
		this.failAllStreams(1011, reason);
	}

	// ---- socket events ---------------------------------------------------
	async webSocketMessage(ws, message) {
		if (this.isLiveAgent(ws)) return this.onAgentMessage(message);
		return this.onClientMessage(ws, message);
	}

	onAgentMessage(message) {
		const f = parseFrame(message);
		if (!f) return;
		if (f.type === F_HB) return; // keepalive, no stream involved
		const s = this.streams.get(f.stream);
		if (f.type === F_ACCEPT) return; // stream already mapped; nothing to forward
		if (!s) {
			// Stale/unknown stream: tell the agent to tear it down.
			this.sendAgent(frame(F_RST, f.stream));
			return;
		}
		if (f.type === F_DATA) {
			try {
				s.ws.send(f.payload);
			} catch {
				this.streams.delete(f.stream);
				this.sendAgent(frame(F_RST, f.stream));
			}
		} else if (f.type === F_FIN) {
			this.closeClient(f.stream, 1000, "done");
		} else if (f.type === F_RST) {
			this.closeClient(f.stream, 1011, "reset by agent");
		}
		// OPEN from agent is meaningless; ignore.
	}

	onClientMessage(ws, message) {
		// Client->edge is raw payload (no header) with ONE exception: the exact
		// 5-byte frame [FIN,0,0,0,0] means "stdin EOF, keep delivering to me"
		// (half-close, ssh parity). A 5-byte DATA payload colliding with that
		// pattern is a 2^-40 fluke; documented in PIPE.md.
		// Agent->edge is always framed; see onAgentMessage.
		const id = this.streamOf(ws);
		if (id === null) return;
		const raw = typeof message === "string" ? null : new Uint8Array(message);
		if (raw && raw.length === 5 && raw[0] === F_FIN &&
			raw[1] === 0 && raw[2] === 0 && raw[3] === 0 && raw[4] === 0) {
			const s = this.streams.get(id);
			if (s) s.halfClosed = true;
			this.sendAgent(frame(F_FIN, id));
			return;
		}
		const s = this.streams.get(id);
		if (s?.halfClosed) return; // ignore post-EOF writes (proxy bug if any)
		const payload =
			typeof message === "string"
				? new TextEncoder().encode(message)
				: new Uint8Array(message);
		if (payload.length > MAX_DATA) {
			this.sendAgent(frame(F_RST, id));
			this.closeClient(id, 1009, "frame too big");
			return;
		}
		if (!this.sendAgent(frame(F_DATA, id, payload))) {
			this.closeClient(id, 1011, "agent unreachable");
		}
	}

	async webSocketClose(ws, code) {
		// Explicit ack: no-op in production (already CLOSED there), but it
		// completes the handshake on runtimes that fire this handler early.
		try {
			ws.close(1000, "bye");
		} catch {
			/* already gone */
		}
		if (this.isLiveAgent(ws)) {
			this.dropAgent();
			return;
		}
		const id = this.streamOf(ws);
		if (id === null) return;
		const s = this.streams.get(id);
		this.streams.delete(id);
		if (s?.timer) clearTimeout(s.timer);
		this.sendAgent(frame(F_FIN, id));
	}

	async webSocketError(ws) {
		if (this.isLiveAgent(ws)) {
			this.dropAgent();
			return;
		}
		const id = this.streamOf(ws);
		if (id === null) return;
		const s = this.streams.get(id);
		this.streams.delete(id);
		if (s?.timer) clearTimeout(s.timer);
		this.sendAgent(frame(F_RST, id));
	}
}
