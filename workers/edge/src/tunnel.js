// Worse-cloudflared: HTTP reverse tunnel over one outbound WebSocket.
// The locked-down origin dials OUT to the agent endpoint; browsers use plain
// HTTP(S) URLs. No origin fetch anywhere: Azure stays at zero egress.
//
// Roles (set by worker.js in the X-Tunnel-Role header, trusted same-account):
//   agent  -> WS only,  path /t/<roomId>/__agent
//   client -> HTTP only, path /ws untouched, /t/<roomId>/[...rest]
// Plain WS upgrades on client paths get 426 (this tunnel is HTTP-only).

const MAX_REQ_BODY = 2 * 1024 * 1024; // browser -> agent
const MAX_RES_BODY = 5 * 1024 * 1024; // agent -> browser
const AGENT_TIMEOUT_MS = 20_000;
const ALLOW_METHODS = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
]);
const HOP_HEADERS = new Set([
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

function b64encode(bytes) {
	let s = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		s += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(s);
}

function b64decode(b64) {
	const s = atob(b64);
	const bytes = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
	return bytes;
}

function cleanHeaders(headers) {
	const out = {};
	for (const [k, v] of headers) {
		if (!HOP_HEADERS.has(k.toLowerCase())) out[k] = v;
	}
	return out;
}

export class TunnelRoom {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
		this.agent = null; // accepted server-side WebSocket
		this.agentGen = null;
		this.pending = new Map(); // id -> {resolve, reject, timer}
		// Rebuild agent pairing after hibernation wake (memory was wiped but
		// hibernated sockets survive). Without this, an evicted room answers
		// 502 forever despite a live agent socket. Mirrors PipeRoom.
		// In-flight requests from before the wake are gone with the old map;
		// their browsers already hit the 20s agent timeout or will retry.
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
				break;
			}
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
		this.failAllPending(502, "agent reconnected");
		this.agent = server;
		this.agentGen = gen;
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

	dropAgent(reason) {
		this.agent = null;
		this.agentGen = null;
		this.failAllPending(502, reason);
	}

	failAllPending(status, reason) {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Response(reason, { status }));
		}
		this.pending.clear();
	}

	// ---- browser side ----------------------------------------------------
	async handleClient(request, url) {
		if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
			return new Response("Tunnel is HTTP-only", { status: 426 });
		}
		if (!ALLOW_METHODS.has(request.method)) {
			return new Response("Method not allowed", { status: 405 });
		}
		if (!this.agent) {
			return new Response("No agent connected", { status: 502 });
		}

		let reqBodyB64 = null;
		if (request.method !== "GET" && request.method !== "HEAD") {
			const buf = new Uint8Array(await request.arrayBuffer());
			if (buf.length > MAX_REQ_BODY) {
				return new Response("Request body too big", { status: 413 });
			}
			if (buf.length) reqBodyB64 = b64encode(buf);
		}

		// Upstream path = everything after /t/<roomId>, default "/".
		const m = url.pathname.match(/^\/t\/[^/]+(\/.*)?$/);
		const upstreamPath = (m?.[1] ?? "/") + url.search;

		const id = crypto.randomUUID();
		const envelope = JSON.stringify({
			type: "req",
			id,
			method: request.method,
			path: upstreamPath,
			headers: cleanHeaders(request.headers),
			bodyB64: reqBodyB64,
		});

		const answer = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Response("Agent timed out", { status: 504 }));
			}, AGENT_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.agent.send(envelope);
			} catch {
				this.pending.delete(id);
				clearTimeout(timer);
				this.dropAgent("agent send failed");
				reject(new Response("Agent unreachable", { status: 502 }));
			}
		}).catch((res) => res);

		if (answer instanceof Response) return answer; // timeout / failure path
		return this.toBrowserResponse(answer);
	}

	toBrowserResponse(msg) {
		if (!msg || msg.type === "err" || typeof msg.status !== "number") {
			return new Response("Bad gateway", { status: 502 });
		}
		const headers = new Headers();
		if (msg.headers && typeof msg.headers === "object") {
			for (const [k, v] of Object.entries(msg.headers)) {
				if (!HOP_HEADERS.has(String(k).toLowerCase()) && typeof v === "string") {
					try {
						headers.append(k, v);
					} catch {
						/* skip bad values */
					}
				}
			}
		}
		let body = null;
		if (msg.bodyB64) {
			let bytes;
			try {
				bytes = b64decode(msg.bodyB64);
			} catch {
				return new Response("Bad gateway", { status: 502 });
			}
			if (bytes.length > MAX_RES_BODY) {
				return new Response("Upstream response too big", { status: 502 });
			}
			body = bytes;
			headers.set("Content-Length", String(bytes.length));
		}
		return new Response(body, { status: msg.status, headers });
	}

	// ---- agent socket events ---------------------------------------------
	async webSocketMessage(ws, message) {
		if (!this.isLiveAgent(ws)) return;
		if (typeof message !== "string") return; // v1: JSON control only
		let msg;
		try {
			msg = JSON.parse(message);
		} catch {
			return;
		}
		// Agent "pong" frames double as keepalive (sent every 20s so idle
	// control sockets aren't reaped). They carry no request state.
	if (msg?.type === "hello" || msg?.type === "pong") return;
		if ((msg?.type === "res" || msg?.type === "err") && typeof msg?.id === "string") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			p.resolve(msg);
		}
	}

	async webSocketClose(ws) {
		if (this.isLiveAgent(ws)) this.dropAgent("agent disconnected");
	}

	async webSocketError(ws) {
		if (this.isLiveAgent(ws)) this.dropAgent("agent error");
		else {
			try {
				ws.close(1011, "internal error");
			} catch {
				/* gone */
			}
		}
	}
}
