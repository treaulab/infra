import { RelayRoom } from "./room.js";
import { TunnelRoom } from "./tunnel.js";
import { PipeRoom } from "./pipe.js";

export { RelayRoom, TunnelRoom, PipeRoom };

// Mirror of apps/caddy/Caddyfile security posture, enforced at the edge.
function withSecurityHeaders(res) {
	const out = new Response(res.body, res);
	out.headers.set(
		"Strict-Transport-Security",
		"max-age=31536000; includeSubDomains",
	);
	out.headers.set("X-Content-Type-Options", "nosniff");
	out.headers.set("X-Frame-Options", "DENY");
	out.headers.set(
		"Referrer-Policy",
		"strict-origin-when-cross-origin",
	);
	if (
		!out.headers.has("Cache-Control") &&
		res.headers.get("Content-Type")?.includes("text/html")
	) {
		out.headers.set("Cache-Control", "public, max-age=3600");
	}
	return out;
}

function isWebSocketUpgrade(request) {
	return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

// Path shapes: /t/<TOKEN> -> room "main", / -> upstream "/",
// /t/<TOKEN>/<room>[/...rest] -> named room, rest defaults to "/".
// /t/<TOKEN>/<room>/__agent is the agent-only control endpoint.
function parseTunnelPath(pathname) {
	const m = pathname.match(/^\/t\/([^/]+)(?:\/([^/]+))?((?:\/.*)?)$/);
	if (!m) return null;
	const room = m[2] ?? "main";
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(room) || room === "__agent") return null;
	const rest = m[3] || "";
	if (rest === "/__agent" || rest.startsWith("/__agent/")) return null;
	return { token: m[1], room, agent: false };
}

function parseAgentPath(pathname) {
	const m = pathname.match(/^\/t\/([^/]+)\/([^/]+)\/__agent\/?$/);
	if (!m || !/^[A-Za-z0-9_-]{1,64}$/.test(m[2])) return null;
	return { token: m[1], room: m[2] };
}

// Path shapes: /p/<TOKEN>/<box> -> client pipe, /p/<TOKEN>/<box>/__agent.
// One room per locked box; box names keep DO names predictable and safe.
// Separate PIPE_TOKEN: a leaked chat-room token must never open terminals.
function parsePipePath(pathname) {
	const agent = pathname.match(/^\/p\/([^/]+)\/([^/]+)\/__agent\/?$/);
	if (agent) {
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(agent[2])) return null;
		return { token: agent[1], box: agent[2], agent: true };
	}
	const client = pathname.match(/^\/p\/([^/]+)\/([^/]+)\/?$/);
	if (!client || !/^[A-Za-z0-9_-]{1,64}$/.test(client[2]) || client[2] === "__agent") {
		return null;
	}
	return { token: client[1], box: client[2], agent: false };
}

// Path shapes: /ws/<TOKEN> -> room "main", /ws/<TOKEN>/<room> -> named room.
// Room names are restricted to keep DO names predictable and safe.
function parseRelayPath(pathname) {
	const m = pathname.match(/^\/ws\/([^/]+)(?:\/([^/]+))?\/?$/);
	if (!m) return null;
	const room = m[2] ?? "main";
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) return null;
	return { token: m[1], room };
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// www -> apex, same as Caddy redir block.
		if (url.hostname === "www.treau.me") {
			url.hostname = "treau.me";
			return Response.redirect(url.toString(), 301);
		}

		if (url.pathname === "/health") {
			return new Response("ok", {
				headers: { "Content-Type": "text/plain" },
			});
		}

		if (url.pathname === "/p" || url.pathname.startsWith("/p/")) {
			const parsed = parsePipePath(url.pathname);
			if (!parsed) return new Response("Not found", { status: 404 });
			if (!env.PIPE_TOKEN) {
				console.error("PIPE_TOKEN secret not set");
				return new Response("Pipe misconfigured", { status: 500 });
			}
			if (parsed.token !== env.PIPE_TOKEN) return new Response("Forbidden", { status: 403 });
			if (!isWebSocketUpgrade(request)) {
				return new Response("Expected Upgrade: websocket", { status: 426 });
			}
			const stub = env.PIPE.getByName(parsed.box);
			const fwd = new Request(request);
			fwd.headers.set("X-Tunnel-Role", parsed.agent ? "agent" : "client");
			return stub.fetch(fwd);
		}

		if (url.pathname === "/t" || url.pathname.startsWith("/t/")) {
			const agent = parseAgentPath(url.pathname);
			const client = agent ? null : parseTunnelPath(url.pathname);
			const parsed = agent
				? { ...agent, agent: true }
				: client
					? { ...client, agent: false }
					: null;
			if (!parsed) return new Response("Not found", { status: 404 });
			if (!env.RELAY_TOKEN) {
				console.error("RELAY_TOKEN secret not set");
				return new Response("Relay misconfigured", { status: 500 });
			}
			if (parsed.token !== env.RELAY_TOKEN) return new Response("Forbidden", { status: 403 });
			const stub = env.TUNNEL.getByName(parsed.room);
			const fwd = new Request(request);
			fwd.headers.set("X-Tunnel-Role", parsed.agent ? "agent" : "client");
			return stub.fetch(fwd);
		}

		if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
			const parsed = parseRelayPath(url.pathname);
			if (!parsed) return new Response("Not found", { status: 404 });
			if (!env.RELAY_TOKEN) {
				console.error("RELAY_TOKEN secret not set");
				return new Response("Relay misconfigured", { status: 500 });
			}
			if (parsed.token !== env.RELAY_TOKEN) return new Response("Forbidden", { status: 403 });
			if (!isWebSocketUpgrade(request)) {
				return new Response("Expected Upgrade: websocket", { status: 426 });
			}
			const stub = env.ROOM.getByName(parsed.room);
			return stub.fetch(request);
		}

		// Static site (synced from apps/website/src). Custom 404 page on miss.
		const asset = await env.ASSETS.fetch(request);
		if (asset.status === 404) {
			const notFound = await env.ASSETS.fetch(
				new Request(new URL("/404.html", url), request),
			);
			const body =
				notFound.status === 200 ? notFound : new Response("Page not found");
			const out = withSecurityHeaders(
				new Response(body.body, {
					status: 404,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				}),
			);
			out.headers.set("X-Robots-Tag", "noindex");
			return out;
		}
		return withSecurityHeaders(asset);
	},
};
