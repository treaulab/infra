// Edge-only client<->client relay. No origin fetch, no VPS traffic.
// One Durable Object instance = one room. Hibernation API keeps idle rooms
// asleep (clients stay connected, no duration billing while hibernated).
//
// Protocol: connect to /ws/<TOKEN>[/<room>], send anything, everyone else in
// the same room receives the raw message. Built-in heartbeat: send the exact
// string "__treaulab_ping__", get "__treaulab_pong__" back without waking us.

// Soft abuse caps (tune in one place). Runtime hard cap is 32 MiB inbound.
const MAX_CONNECTIONS = 1000;
const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB
const PING = "__treaulab_ping__";
const PONG = "__treaulab_pong__";

function messageSize(message) {
	return typeof message === "string"
		? new TextEncoder().encode(message).length
		: message.byteLength;
}

export class RelayRoom {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}

	async fetch(request) {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected Upgrade: websocket", { status: 426 });
		}
		if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) {
			return new Response("Room full", { status: 503 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		server.serializeAttachment({
			id: crypto.randomUUID(),
			joined: Date.now(),
		});
		this.ctx.acceptWebSocket(server);
		try {
			this.ctx.setWebSocketAutoResponse(PING, PONG);
		} catch {
			// Older runtimes lack auto-response; heartbeat just wakes us instead.
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws, message) {
		if (message === PING) {
			// Auto-response normally handles this; fallback if unsupported.
			try {
				ws.send(PONG);
			} catch {
				/* peer gone */
			}
			return;
		}
		let size = 0;
		try {
			size = messageSize(message);
		} catch {
			return;
		}
		if (size > MAX_MESSAGE_BYTES) {
			try {
				ws.close(1009, "message too big");
			} catch {
				/* peer gone */
			}
			return;
		}
		let senderId;
		try {
			senderId = ws.deserializeAttachment()?.id;
		} catch {
			senderId = undefined;
		}
		for (const peer of this.ctx.getWebSockets()) {
			let same = peer === ws;
			if (!same && senderId !== undefined) {
				try {
					same = peer.deserializeAttachment()?.id === senderId;
				} catch {
					same = false;
				}
			}
			if (same) continue;
			try {
				peer.send(message);
			} catch {
				// Peer disconnected between list and send; runtime cleans up.
			}
		}
	}

	async webSocketClose() {
		// No bookkeeping needed; getWebSockets() reflects live set.
	}

	async webSocketError(ws) {
		try {
			ws.close(1011, "internal error");
		} catch {
			/* already gone */
		}
	}
}
