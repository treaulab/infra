// Treau tunnel: HTTP + WebSocket reverse tunnel over one outbound socket.
// The locked-down origin dials OUT to the agent endpoint; browsers and WS
// clients use plain public URLs. No origin fetch anywhere: Azure stays at
// zero egress.
//
// Roles (set by worker.js in the X-Tunnel-Role header, trusted same-account):
//   agent   -> WS only, path /t/<roomId>/__agent (binary multiplex, v3)
//   client  -> HTTP or WS, path /t/<roomId>/[...rest] (all paths upgrade-capable)
//
// Protocol v3 (binary, no backward compat): one agent WebSocket carries N
// streams. One WS message = exactly one frame:
//   [type:u8][stream:u32be][flags:u16be][len:u32be][payload 0..64KiB]
// HEADERS opens a stream (worker->agent {method,path,headers}; agent->worker
// {status,headers}); DATA carries raw body bytes (no Base64 tax); FIN ends
// cleanly; RST aborts (payload = optional UTF-8 message); HELLO/HB are
// connection-level (stream 0). Visitor WebSockets are just duplex streams:
// method "WS" in HEADERS tells the agent to dial its local upstream as WS
// and bridge both ways.
//
// Hibernation rule: the isolate stays awake while ANY stream is open and
// may sleep ($0) only when the stream count is zero. Each open stream holds
// a pending idle timer plus a shared waitUntil drain promise, so the event
// loop never empties mid-stream. Deploys/migrations still drop everything;
// clients retry and the agent redials.

import {
	HOP_HEADERS,
	PROBE_HEADER,
	STATUS_HEADER,
	TUNNEL_CHUNK_BYTES,
	TUNNEL_IDLE_TIMEOUT_MS,
	TUNNEL_MAX_TOTAL_BYTES,
	TUNNEL_VERSION,
	T_DATA,
	T_FIN,
	T_FLAG_FIN,
	T_FLAG_TEXT,
	T_HB,
	T_HEADERS,
	T_HELLO,
	T_RST,
	cleanHeadersFromHeaders,
	decodeTunnelFrame,
	encodeTunnelFrame,
	isAllowedMethod,
	newStreamId,
	parseTunnelHeaders,
	tunnelHeadersPayload,
} from "../lib/shared.js";

const _te = new TextEncoder();
const _td = new TextDecoder();

function maxTotalBytes(env) {
	const v = Number(env?.MAX_TUNNEL_BYTES ?? TUNNEL_MAX_TOTAL_BYTES);
	if (Number.isFinite(v) && v > 0) return v;
	return TUNNEL_MAX_TOTAL_BYTES;
}

function idleTimeoutMs(env) {
	const v = Number(env?.TUNNEL_IDLE_TIMEOUT_MS ?? TUNNEL_IDLE_TIMEOUT_MS);
	if (Number.isFinite(v) && v >= 5_000) return v;
	return TUNNEL_IDLE_TIMEOUT_MS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TunnelRoom {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
		this.agent = null; // accepted server-side WebSocket
		this.agentGen = null;
		this.agentName = null;
		this.pending = new Map(); // streamId -> http | ws entry
		this._pin = null; // hibernation pin while streams are open
		// Rebuild pairing after hibernation wake (memory was wiped but
		// hibernated sockets survive). Orphaned visitors get RST + fast fail
		// below (their stream state died with the old isolate); the agent
		// re-sends HELLO on its own only after a reconnect.
		let orphaned = [];
		for (const ws of this.ctx.getWebSockets()) {
			let a;
			try {
				a = ws.deserializeAttachment();
			} catch {
				continue;
			}
			if (a?.role === "agent" && typeof a.gen === "string") {
				this.agent = ws;
				this.agentGen = a.gen;
				this.agentName = a.name ?? null;
			} else if (a?.role === "visitor" && Number.isInteger(a.stream)) {
				orphaned.push(ws);
			}
		}
		for (const ws of orphaned) {
			let stream = 0;
			try {
				stream = ws.deserializeAttachment()?.stream ?? 0;
			} catch {
				/* gone */
			}
			if (Number.isInteger(stream) && stream !== 0) {
				this.sendAgent(encodeTunnelFrame(T_RST, stream, _te.encode("evicted, retry")));
			}
			try {
				ws.close(1011, "evicted, retry");
			} catch {
				/* gone */
			}
		}
	}

	// ---- hibernation pin -------------------------------------------------
	// Hold the isolate awake while streams are open: a pending waitUntil
	// drain promise plus one sliding idle timer per stream. When the last
	// stream closes/errors/times out, the promise resolves and all timers
	// are clear, so the room is free to hibernate at $0 cost.
	_pinStreams() {
		if (!this._pin) {
			let resolve;
			const promise = new Promise((r) => {
				resolve = r;
			});
			this._pin = { promise, resolve };
			try {
				this.ctx.waitUntil(promise);
			} catch {
				/* waitUntil unavailable outside request context; timers still pin */
			}
		}
	}

	_unpinStreams() {
		if (this._pin && this.pending.size === 0) {
			try {
				this._pin.resolve();
			} catch {
				/* gone */
			}
			this._pin = null;
		}
	}

	// ---- entry -----------------------------------------------------------
	async fetch(request) {
		const url = new URL(request.url);
		const role = request.headers.get("X-Tunnel-Role") ?? "client";
		if (role === "agent") return this.handleAgent(request);
		return this.handleClient(request, url);
	}

	// ---- agent side ------------------------------------------------------
	async handleAgent(request) {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected Upgrade: websocket", { status: 426 });
		}
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		const gen = crypto.randomUUID();
		server.serializeAttachment({ role: "agent", gen });
		// Single agent per room: newcomer takes over, old pipe is cut.
		if (this.agent) {
			try {
				this.agent.close(4000, "superseded");
			} catch {
				/* gone */
			}
		}
		this.failAllStreams(502, "agent reconnected");
		this.agent = server;
		this.agentGen = gen;
		this.agentName = null;
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	isLiveAgent(ws) {
		let a;
		try {
			a = ws.deserializeAttachment();
		} catch {
			return false;
		}
		if (a?.role !== "agent" || typeof a?.gen !== "string") return false;
		if (this.agent && ws === this.agent) return a.gen === this.agentGen;
		// Adopt a matching agent socket we don't hold (hibernation wake may
		// deliver a different object than the constructor rebuilt).
		if (a.gen === this.agentGen) {
			this.agent = ws;
			return true;
		}
		return false;
	}

	visitorStreamOf(ws) {
		try {
			const a = ws.deserializeAttachment();
			if (a?.role === "visitor" && Number.isInteger(a?.stream)) return a.stream;
		} catch {
			/* fall through */
		}
		return null;
	}

	dropAgent(reason) {
		this.agent = null;
		this.agentGen = null;
		this.agentName = null;
		this.failAllStreams(502, reason);
	}

	failAllStreams(status, reason) {
		for (const [, p] of this.pending) {
			if (p.idleTimer) clearTimeout(p.idleTimer);
			p.done = true;
			if (p.kind === "http") {
				try {
					if (p.started) p.controller.error(new Error(reason));
					else p.reject(new Response(reason, { status }));
				} catch {
					/* stream already closed */
				}
			} else {
				try {
					p.ws.close(1011, reason);
				} catch {
					/* gone */
				}
			}
		}
		this.pending.clear();
		this._unpinStreams();
	}

	removeStream(id) {
		const p = this.pending.get(id);
		if (!p) return null;
		this.pending.delete(id);
		if (p.idleTimer) clearTimeout(p.idleTimer);
		p.done = true;
		this._unpinStreams();
		return p;
	}

	touch(entry) {
		if (!entry || entry.done) return;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = setTimeout(() => this.onIdleTimeout(entry.id), idleTimeoutMs(this.env));
	}

	onIdleTimeout(id) {
		const p = this.pending.get(id);
		if (!p) return;
		this.removeStream(id);
		this.sendAgent(encodeTunnelFrame(T_RST, id, _te.encode("agent idle timeout")));
		if (p.kind === "http") {
			try {
				if (p.started) p.controller.error(new Error("agent idle timeout"));
				else p.reject(new Response("Agent timed out", { status: 504 }));
			} catch {
				/* gone */
			}
		} else {
			try {
				p.ws.close(1011, "agent idle timeout");
			} catch {
				/* gone */
			}
		}
	}

	sendAgent(frame) {
		if (!this.agent) return false;
		try {
			this.agent.send(frame);
			return true;
		} catch {
			this.dropAgent("agent send failed");
			return false;
		}
	}

	async waitForDrain() {
		// Avoid unbounded WS buffering when streaming large bodies.
		try {
			let spins = 0;
			while (this.agent && this.agent.bufferedAmount > 1024 * 1024 && spins < 200) {
				await sleep(10);
				spins++;
			}
		} catch {
			/* ignore */
		}
	}

	// ---- visitor / browser side ------------------------------------------
	async handleClient(request, url) {
		// Local status probe (never forwarded upstream): lets `tunnel info`
		// distinguish worker-404 from upstream-404.
		if ((request.headers.get(PROBE_HEADER) ?? "").toLowerCase() === "status") {
			return new Response(
				JSON.stringify({
					agent: !!this.agent,
					version: TUNNEL_VERSION,
					binary: true,
					streams: this.pending.size,
				}),
				{ headers: { "Content-Type": "application/json", [STATUS_HEADER]: this.agent ? "live" : "offline" } },
			);
		}
		// Every client path is upgrade-capable: a WS upgrade opens a duplex
		// visitor stream (method "WS"); plain HTTP opens a request stream.
		if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
			return this.handleVisitor(request, url);
		}
		return this.handleHttp(request, url);
	}

	upstreamPathOf(url) {
		// Upstream path = everything after /t/<roomId>, default "/".
		const m = url.pathname.match(/^\/t\/[^/]+(\/.*)?$/);
		return (m?.[1] ?? "/") + url.search;
	}

	async handleVisitor(request, url) {
		if (!this.agent) {
			return new Response("No agent connected", {
				status: 502,
				headers: { [STATUS_HEADER]: "offline" },
			});
		}
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
	 const id = newStreamId(this.pending);
		server.serializeAttachment({ role: "visitor", stream: id });
		this.ctx.acceptWebSocket(server);
		const entry = {
			kind: "ws",
			id,
			ws: server,
			idleTimer: null,
			done: false,
			totalReq: 0,
			totalRes: 0,
			maxTotal: maxTotalBytes(this.env),
		};
		entry.idleTimer = setTimeout(() => this.onIdleTimeout(id), idleTimeoutMs(this.env));
		this.pending.set(id, entry);
		this._pinStreams();
		const ok = this.sendAgent(
			encodeTunnelFrame(
				T_HEADERS,
				id,
				tunnelHeadersPayload({
					method: "WS",
					path: this.upstreamPathOf(url),
					headers: cleanHeadersFromHeaders(request.headers),
				}),
			),
		);
		if (!ok) {
			this.removeStream(id);
			return new Response("Agent unreachable", { status: 502 });
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	// HTTP: HEADERS first so the agent can start fetching, then stream the
	// request body as DATA in the background; resolve with a ReadableStream
	// Response once the agent answers HEADERS.
	async handleHttp(request, url) {
		if (!isAllowedMethod(request.method)) {
			return new Response("Method not allowed", { status: 405 });
		}
		if (!this.agent) {
			return new Response("No agent connected", {
				status: 502,
				headers: { [STATUS_HEADER]: "offline" },
			});
		}
		const upstreamPath = this.upstreamPathOf(url);
		const id = newStreamId(this.pending);
		const maxTotal = maxTotalBytes(this.env);
		let resolveStart;
		let rejectStart;
		const started = new Promise((res, rej) => {
			resolveStart = res;
			rejectStart = rej;
		});
		// Avoid unhandled rejection when idle timeout wins before HEADERS.
		started.catch(() => {});

		let controller;
		const stream = new ReadableStream({
			start(c) {
				controller = c;
			},
		});

		const entry = {
			kind: "http",
			id,
			controller: null, // set below once stream starts
			resolve: resolveStart,
			reject: rejectStart,
			idleTimer: null,
			started: false,
			done: false,
			status: 0,
			totalRes: 0,
			totalReq: 0,
			maxTotal,
		};
		// Wire controller after ReadableStream start runs synchronously.
		entry.controller = controller;
		entry.idleTimer = setTimeout(() => this.onIdleTimeout(id), idleTimeoutMs(this.env));
		this.pending.set(id, entry);
		this._pinStreams();

		const aborted = () => {
			const p = this.pending.get(id);
			if (!p || p.done) return;
			this.removeStream(id);
			this.sendAgent(encodeTunnelFrame(T_RST, id, _te.encode("client disconnected")));
			try {
				if (p.started) p.controller.error(new Error("client disconnected"));
				else p.reject(new Response("Client disconnected", { status: 499 }));
			} catch {
				/* gone */
			}
		};
		try {
			request.signal?.addEventListener("abort", aborted, { once: true });
		} catch {
			/* signal may be missing in some runtimes */
		}

		// 1. HEADERS (headers first so the agent can start fetching).
		const ok = this.sendAgent(
			encodeTunnelFrame(
				T_HEADERS,
				id,
				tunnelHeadersPayload({
					method: request.method,
					path: upstreamPath,
					headers: cleanHeadersFromHeaders(request.headers),
				}),
			),
		);
		if (!ok) {
			this.removeStream(id);
			return new Response("Agent unreachable", { status: 502 });
		}

		// 2. Pump request body in the background (don't block HEADERS wait).
		(async () => {
			try {
				if (request.method === "GET" || request.method === "HEAD" || !request.body) {
					this.sendAgent(encodeTunnelFrame(T_FIN, id));
					return;
				}
				const reader = request.body.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!value || !value.length) continue;
					// Slice into CHUNK pieces so no single WS frame is huge.
					for (let off = 0; off < value.length; off += TUNNEL_CHUNK_BYTES) {
						const piece = value.subarray(off, off + TUNNEL_CHUNK_BYTES);
						const p = this.pending.get(id);
						if (!p || p.done) return;
						p.totalReq += piece.length;
						if (p.totalReq > p.maxTotal) {
							this.removeStream(id);
							this.sendAgent(encodeTunnelFrame(T_RST, id, _te.encode("request body too big")));
							try {
								if (p.started) p.controller.error(new Error("request body too big"));
								else p.reject(new Response("Request body too big", { status: 413 }));
							} catch {
								/* gone */
							}
							return;
						}
						await this.waitForDrain();
						const cur = this.pending.get(id);
						if (!cur || cur.done) return;
						if (!this.sendAgent(encodeTunnelFrame(T_DATA, id, piece))) return;
						this.touch(cur);
					}
				}
				const p = this.pending.get(id);
				if (p && !p.done) {
					this.sendAgent(encodeTunnelFrame(T_FIN, id));
					this.touch(p);
				}
			} catch {
				const p = this.pending.get(id);
				if (p && !p.done && !p.started) {
					this.removeStream(id);
					try {
						p.reject(new Response("Bad gateway", { status: 502 }));
					} catch {
						/* gone */
					}
				}
			}
		})();

		// 3. Wait for HEADERS (or RST/timeout), then return streaming Response.
		try {
			const { status, headers } = await started;
			const outHeaders = new Headers(headers);
			outHeaders.set("Referrer-Policy", "no-referrer");
			outHeaders.set(STATUS_HEADER, "live");
			// Streaming: never set Content-Length (chunked). Delete any the
			// agent echoed (hop headers are already stripped, be explicit).
			outHeaders.delete("content-length");
			return new Response(stream, { status, headers: outHeaders });
		} catch (res) {
			if (res instanceof Response) return res;
			return new Response("Bad gateway", { status: 502 });
		}
	}

	headersToBrowser(obj) {
		const headers = new Headers();
		if (obj && typeof obj === "object") {
			for (const [k, v] of Object.entries(obj)) {
				const name = String(k).toLowerCase();
				// Never let an upstream Referrer-Policy govern the tunnel URL:
				// the room ID in the path is the secret, and a permissive
				// upstream policy (e.g. unsafe-url) would leak it to third
				// parties via the Referer header. Forced to no-referrer below.
				if (name === "referrer-policy") continue;
				if (!HOP_HEADERS.has(name) && typeof v === "string") {
					try {
						headers.append(k, v);
					} catch {
						/* skip bad values */
					}
				}
			}
		}
		return headers;
	}

	// ---- socket events ---------------------------------------------------
	async webSocketMessage(ws, message) {
		if (this.isLiveAgent(ws)) return this.onAgentFrame(message);
		return this.onVisitorMessage(ws, message);
	}

	failStream(id, message, streamGone) {
		const p = this.pending.get(id);
		if (!p) return;
		this.removeStream(id);
		if (!streamGone) this.sendAgent(encodeTunnelFrame(T_RST, id, _te.encode(message)));
		if (p.kind === "http") {
			try {
				if (p.started) p.controller.error(new Error(message));
				else p.reject(new Response(message, { status: 502 }));
			} catch {
				/* gone */
			}
		} else {
			try {
				p.ws.close(1011, message);
			} catch {
				/* gone */
			}
		}
	}

	finishStream(id) {
		const p = this.pending.get(id);
		if (!p) return;
		this.removeStream(id);
		if (p.kind === "http") {
			if (!p.started) {
				// FIN before HEADERS: agent bug.
				try {
					p.reject(new Response("Bad gateway", { status: 502 }));
				} catch {
					/* gone */
				}
				return;
			}
			try {
				p.controller.close();
			} catch {
				/* gone */
			}
		} else {
			try {
				p.ws.close(1000, "done");
			} catch {
				/* gone */
			}
		}
	}

	pushStreamData(p, bytes, flags, finAfter) {
		p.totalRes += bytes.length;
		if (p.totalRes > p.maxTotal) {
			this.failStream(p.id, "response too big", true);
			this.sendAgent(encodeTunnelFrame(T_RST, p.id, _te.encode("response too big")));
			return;
		}
		if (p.kind === "http") {
			try {
				p.controller.enqueue(bytes);
			} catch {
				/* browser went away */
			}
		} else {
			// Preserve text frames end to end (chat/HMR expect text).
			try {
				if (flags & T_FLAG_TEXT) p.ws.send(_td.decode(bytes));
				else p.ws.send(bytes);
			} catch {
				/* visitor went away */
			}
		}
		if (finAfter) this.finishStream(p.id);
	}

	onAgentFrame(message) {
		const f = decodeTunnelFrame(message);
		if (!f) {
			// Binary-only wire: anything else is a protocol violation. Fail
			// loud so version skew surfaces instead of hanging streams.
			try {
				this.agent?.close(4400, "protocol violation: binary frames only");
			} catch {
				/* gone */
			}
			this.dropAgent("protocol violation");
			return;
		}
		if (f.type === T_HB) return; // keepalive, no stream involved
		if (f.type === T_HELLO) {
			if (f.stream !== 0) return;
			const hello = parseTunnelHeaders(f.payload);
			const version = Number(hello?.version);
			if (!hello || version !== TUNNEL_VERSION) {
				try {
					this.agent?.close(4400, "protocol mismatch: want v3 binary");
				} catch {
					/* gone */
				}
				this.dropAgent("protocol mismatch");
				return;
			}
			this.agentName = typeof hello.name === "string" ? hello.name : null;
			try {
				this.agent?.serializeAttachment({ role: "agent", gen: this.agentGen, name: this.agentName });
			} catch {
				/* best-effort */
			}
			return;
		}
		if (f.stream === 0) return; // stream frames need a nonzero stream
		const p = this.pending.get(f.stream);
		if (!p) {
			// Stale/unknown stream: tell the agent to tear it down.
			this.sendAgent(encodeTunnelFrame(T_RST, f.stream, _te.encode("unknown stream")));
			return;
		}
		this.touch(p);

		if (f.type === T_HEADERS) {
			if (p.started) {
				this.failStream(f.stream, "duplicate HEADERS", true);
				return;
			}
			const head = parseTunnelHeaders(f.payload);
			if (!head || typeof head.status !== "number") {
				this.failStream(f.stream, "bad HEADERS", false);
				return;
			}
			p.started = true;
			p.status = head.status;
			if (p.kind === "http") {
				try {
					p.resolve({ status: head.status, headers: this.headersToBrowser(head.headers) });
				} catch {
					/* gone */
				}
			}
			// Visitor streams need no resolve: the socket is already open and
			// duplex. A non-101 status from the agent still streams as DATA
			// (the upstream WS server may answer HTTP); RST means dial failed.
			if (f.flags & T_FLAG_FIN) this.finishStream(f.stream);
			return;
		}
		if (f.type === T_DATA) {
			if (!p.started) {
				this.failStream(f.stream, "DATA before HEADERS", false);
				return;
			}
			this.pushStreamData(p, f.payload, f.flags, (f.flags & T_FLAG_FIN) !== 0);
			return;
		}
		if (f.type === T_FIN) {
			if (p.kind === "ws" && !p.started) {
				// Agent ends a visitor stream it never accepted (e.g. local
				// WS dial refused before HEADERS): fail fast with the reason.
				this.failStream(f.stream, "upstream unavailable", true);
				return;
			}
			this.finishStream(f.stream);
			return;
		}
		if (f.type === T_RST) {
			let msg = "reset by agent";
			try {
				const text = _td.decode(f.payload);
				if (text) msg = text;
			} catch {
				/* keep default */
			}
			this.failStream(f.stream, msg, true);
			return;
		}
	}

	onVisitorMessage(ws, message) {
		const id = this.visitorStreamOf(ws);
		if (id === null) return;
		const p = this.pending.get(id);
		if (!p || p.kind !== "ws" || p.done) return;
		const sendData = (bytes, flags = 0) => {
			for (let off = 0; off < bytes.length; off += TUNNEL_CHUNK_BYTES) {
				const piece = bytes.subarray(off, off + TUNNEL_CHUNK_BYTES);
				const cur = this.pending.get(id);
				if (!cur || cur.done) return false;
				cur.totalReq += piece.length;
				if (cur.totalReq > cur.maxTotal) {
					this.failStream(id, "request body too big", false);
					try {
						ws.close(1009, "message too big");
					} catch {
						/* gone */
					}
					return false;
				}
				if (!this.sendAgent(encodeTunnelFrame(T_DATA, id, piece, flags))) {
					try {
						ws.close(1011, "agent unreachable");
					} catch {
						/* gone */
					}
					return false;
				}
				this.touch(cur);
			}
			return true;
		};
		if (typeof message === "string") {
			// Text frames (chat/HMR JSON): bridge as UTF-8 DATA with the TEXT
			// flag so the far end delivers text, not binary.
			sendData(_te.encode(message), T_FLAG_TEXT);
			return;
		}
		sendData(new Uint8Array(message));
	}

	closeVisitorStream(ws, reason, rst) {
		const id = this.visitorStreamOf(ws);
		if (id === null) return;
		const p = this.pending.get(id);
		if (!p) return;
		this.removeStream(id);
		if (rst) this.sendAgent(encodeTunnelFrame(T_RST, id, _te.encode(reason)));
		else this.sendAgent(encodeTunnelFrame(T_FIN, id));
	}

	async webSocketClose(ws, code) {
		if (this.isLiveAgent(ws)) {
			this.dropAgent("agent disconnected");
			return;
		}
		// Visitor socket closed: clean FIN for clean closes, RST otherwise
		// (so the agent stops fetching for a gone visitor).
		if (this.visitorStreamOf(ws) !== null) {
			this.closeVisitorStream(ws, "visitor closed", code !== 1000);
		}
	}

	async webSocketError(ws) {
		if (this.isLiveAgent(ws)) {
			this.dropAgent("agent error");
			return;
		}
		if (this.visitorStreamOf(ws) !== null) {
			this.closeVisitorStream(ws, "visitor error", true);
		} else {
			try {
				ws.close(1011, "internal error");
			} catch {
				/* gone */
			}
		}
	}
}
