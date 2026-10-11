import { TunnelRoom } from "./tunnel.js";
import { PipeRoom } from "./pipe.js";

export { TunnelRoom, PipeRoom };

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

// Path shapes (long-URL-only, trycloudflare-style: the room/box ID itself
// is the secret — no separate token):
// /t/<roomId> -> room, upstream "/",
// /t/<roomId>/[...rest] -> named room, rest defaults to "/".
// /t/<roomId>/__agent is the agent-only control endpoint (websocket).
// IDs must be 20-64 chars [A-Za-z0-9_-] so short guessable names fail fast.
const ID_RE = /^[A-Za-z0-9_-]{20,64}$/;

function parseTunnelPath(pathname) {
	const m = pathname.match(/^\/t\/([^/]+)((?:\/.*)?)$/);
	if (!m) return null;
	const room = m[1];
	if (!ID_RE.test(room)) return null;
	const rest = m[2] || "";
	if (rest === "/__agent" || rest.startsWith("/__agent/")) return null;
	return { room, agent: false };
}

function parseAgentPath(pathname) {
	const m = pathname.match(/^\/t\/([^/]+)\/__agent\/?$/);
	if (!m || !ID_RE.test(m[1])) return null;
	return { room: m[1] };
}

// Path shapes: /p/<boxId> -> client pipe, /p/<boxId>/__agent.
// One room per locked box; box IDs keep DO names unpredictable.
// No token: knowledge of the long box ID is the only gate.
function parsePipePath(pathname) {
	const agent = pathname.match(/^\/p\/([^/]+)\/__agent\/?$/);
	if (agent) {
		if (!ID_RE.test(agent[1])) return null;
		return { box: agent[1], agent: true };
	}
	const client = pathname.match(/^\/p\/([^/]+)\/?$/);
	if (!client || !ID_RE.test(client[1])) {
		return null;
	}
	return { box: client[1], agent: false };
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
			const stub = env.TUNNEL.getByName(parsed.room);
			const fwd = new Request(request);
			fwd.headers.set("X-Tunnel-Role", parsed.agent ? "agent" : "client");
			return stub.fetch(fwd);
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
