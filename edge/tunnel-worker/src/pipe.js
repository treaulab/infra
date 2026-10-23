// Worse-cloudflared, TCP edition: multiplexed raw-byte pipe over WebSocket.
// The locked-down origin dials OUT (agent); laptop ssh dials IN (client).
// One agent socket carries N streams; one client socket == one stream.
// Azure TREAU is never in the path: no origin fetch anywhere in this file.
//
// Frame: [type:u8][stream:u32be][payload...]  (all frames binary)
//   OPEN   client->worker (stream=0): open a stream; worker assigns id, forwards
//   ACCEPT agent->worker: TCP dial to :22 succeeded, stream is live
//   DATA   both ways: raw bytes (SSH ciphertext; worker never logs bodies)
//   FIN    both ways: clean close, forward + tear down stream
//   RST    both ways: abort stream immediately
//
// Hibernation-safe: pairing is rebuilt from socket attachments on wake
// (constructor), stream ids are random 31-bit so they survive counter reset.

import {
	F_ACCEPT,
	F_DATA,
	F_FIN,
	F_HB,
	F_OPEN,
	F_RST,
	HALF_CLOSE_TEXT,
	PIPE_ACCEPT_TIMEOUT_MS,
	PIPE_MAX_DATA,
	newStreamId,
	parsePipeFrame as parseFrame,
	pipeFrame as frame,
} from "../lib/shared.js";

// Worker -> client close codes: 1000 = clean FIN, 1011 = error/RST.

export class PipeRoom {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
		this.agent = null;
		this.agentGen = null;
		this.streams = new Map(); // id -> {ws, timer, halfClosed, accepted, id}
		this.wsToId = new WeakMap();
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
				const entry = {
					ws,
					timer: null,
					halfClosed: !!a.halfClosed,
					accepted: !!a.accepted,
					id: a.stream,
				};
				this.streams.set(a.stream, entry);
				this.wsToId.set(ws, a.stream);
				// Accept timer does not survive hibernation. Re-arm it for
				// streams the agent never ACCEPTed so dead dials still fail
				// fast instead of hanging forever.
				if (!entry.accepted) {
					entry.timer = setTimeout(
						() => this.acceptTimeout(a.stream),
						PIPE_ACCEPT_TIMEOUT_MS,
					);
				}
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
		server.serializeAttachment({ role: "client", stream: id, accepted: false });
		this.ctx.acceptWebSocket(server);
		const timer = setTimeout(() => this.acceptTimeout(id), PIPE_ACCEPT_TIMEOUT_MS);
		this.streams.set(id, { ws: server, timer, halfClosed: false, accepted: false, id });
		this.wsToId.set(server, id);
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
		const cached = this.wsToId.get(ws);
		if (Number.isInteger(cached) && this.streams.has(cached)) return cached;
		try {
			const a = ws.deserializeAttachment();
			if (a?.role === "client" && Number.isInteger(a?.stream)) {
				this.wsToId.set(ws, a.stream);
				return a.stream;
			}
		} catch {
			/* fall through */
		}
		for (const [id, s] of this.streams) {
			if (s.ws === ws) {
				this.wsToId.set(ws, id);
				return id;
			}
		}
		return null;
	}

	markAccepted(id) {
		const s = this.streams.get(id);
		if (!s || s.accepted) return;
		s.accepted = true;
		if (s.timer) {
			clearTimeout(s.timer);
			s.timer = null;
		}
		// Persist so a hibernation wake does not re-arm a timer for live streams.
		try {
			s.ws.serializeAttachment({
				role: "client",
				stream: id,
				accepted: true,
				halfClosed: !!s.halfClosed,
			});
		} catch {
			/* attachment update is best-effort */
		}
	}

	sendAgent(bytes) {
		if (!this.agent) return false;
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
		this.wsToId.delete(s.ws);
		if (s.timer) clearTimeout(s.timer);
		try {
			s.ws.close(code, reason);
		} catch {
			/* gone */
		}
	}

	acceptTimeout(id) {
		const s = this.streams.get(id);
		if (!s || s.accepted) return;
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
		if (f.type === F_ACCEPT) {
			// TCP dial succeeded: stream is live. Clear the accept timer so
			// healthy streams are not RST after 10s (previous bug: ACCEPT was
			// ignored and the timer always fired).
			const s = this.streams.get(f.stream);
			if (s) this.markAccepted(f.stream);
			else this.sendAgent(frame(F_RST, f.stream));
			return;
		}
		const s = this.streams.get(f.stream);
		if (!s) {
			// Stale/unknown stream: tell the agent to tear it down.
			this.sendAgent(frame(F_RST, f.stream));
			return;
		}
		if (f.type === F_DATA) {
			this.markAccepted(f.stream);
			try {
				s.ws.send(f.payload);
			} catch {
				this.streams.delete(f.stream);
				this.sendAgent(frame(F_RST, f.stream));
			}
		} else if (f.type === F_FIN) {
			this.markAccepted(f.stream);
			this.closeClient(f.stream, 1000, "done");
		} else if (f.type === F_RST) {
			this.closeClient(f.stream, 1011, "reset by agent");
		}
		// OPEN from agent is meaningless; ignore.
	}

	isHalfCloseMagic(raw) {
		return (
			raw &&
			raw.length === 5 &&
			raw[0] === F_FIN &&
			raw[1] === 0 &&
			raw[2] === 0 &&
			raw[3] === 0 &&
			raw[4] === 0
		);
	}

	onClientMessage(ws, message) {
		// Client->worker is raw payload (no header) with a half-close signal for
		// stdin EOF (ssh parity for `ssh host cmd < file`): keep delivering
		// the response after EOF. New clients send TEXT `__half_close__`
		// (a text frame can never collide with binary DATA). The legacy exact
		// 5-byte binary [FIN,0,0,0,0] is still accepted for old proxies.
		const id = this.streamOf(ws);
		if (id === null) return;
		if (typeof message === "string") {
			if (message === HALF_CLOSE_TEXT) {
				const s = this.streams.get(id);
				if (s) {
					s.halfClosed = true;
					try {
						s.ws.serializeAttachment({
							role: "client",
							stream: id,
							accepted: !!s.accepted,
							halfClosed: true,
						});
					} catch {
						/* best-effort */
					}
				}
				this.sendAgent(frame(F_FIN, id));
				return;
			}
			// Other text frames: ssh is binary; encode as UTF-8 DATA.
			const s = this.streams.get(id);
			if (s?.halfClosed) return;
			const payload = new TextEncoder().encode(message);
			if (payload.length > PIPE_MAX_DATA) {
				this.sendAgent(frame(F_RST, id));
				this.closeClient(id, 1009, "frame too big");
				return;
			}
			if (!this.sendAgent(frame(F_DATA, id, payload))) {
				this.closeClient(id, 1011, "agent unreachable");
			}
			return;
		}
		const raw = new Uint8Array(message);
		if (this.isHalfCloseMagic(raw)) {
			const s = this.streams.get(id);
			if (s) s.halfClosed = true;
			this.sendAgent(frame(F_FIN, id));
			return;
		}
		const s = this.streams.get(id);
		if (s?.halfClosed) return; // ignore post-EOF writes (proxy bug if any)
		if (raw.length > PIPE_MAX_DATA) {
			this.sendAgent(frame(F_RST, id));
			this.closeClient(id, 1009, "frame too big");
			return;
		}
		if (!this.sendAgent(frame(F_DATA, id, raw))) {
			this.closeClient(id, 1011, "agent unreachable");
		}
	}

	async webSocketClose(ws, code) {
		if (this.isLiveAgent(ws)) {
			this.dropAgent();
			return;
		}
		const id = this.streamOf(ws);
		if (id === null) return;
		const s = this.streams.get(id);
		this.streams.delete(id);
		if (s?.ws) this.wsToId.delete(s.ws);
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
		if (s?.ws) this.wsToId.delete(s.ws);
		if (s?.timer) clearTimeout(s.timer);
		this.sendAgent(frame(F_RST, id));
	}
}
