import { TunnelRoom } from "./tunnel.js";
import { PipeRoom } from "./pipe.js";
import { ID_RE } from "../lib/shared.js";

export { TunnelRoom, PipeRoom };

const APEX_HOST = "treau.me";
const TUNNEL_HOST = "go.treau.me";

// Mirror of apps/caddy/Caddyfile security posture, enforced at the worker.
// Apex treau.me is static-only (reputation protection): no /t/* or /p/*
// proxying there. Tunnels/pipes live on go.treau.me.
function withSecurityHeaders(res, url) {
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
	out.headers.set(
		"Content-Security-Policy",
		"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	);
	out.headers.set(
		"Permissions-Policy",
		"camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
	);
	out.headers.set("Cross-Origin-Opener-Policy", "same-origin");
	out.headers.set("Cross-Origin-Resource-Policy", "same-origin");
	out.headers.delete("Server");
	out.headers.delete("X-Powered-By");
	const pathname = url ? new URL(url).pathname : "";
	if (/\.(svg|ico|txt|xml)$/.test(pathname)) {
		out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
	} else if (
		!out.headers.has("Cache-Control") &&
		res.headers.get("Content-Type")?.includes("text/html")
	) {
		out.headers.set("Cache-Control", "public, max-age=3600");
	}
	return out;
}

function noindex(res) {
	res.headers.set("X-Robots-Tag", "noindex, nofollow");
	return res;
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
// (ID_RE lives in lib/shared.js so worker/agents/CLI validate identically.)

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

function isTunnelPath(pathname) {
	return (
		pathname === "/t" ||
		pathname.startsWith("/t/") ||
		pathname === "/p" ||
		pathname.startsWith("/p/")
	);
}

async function handleTunnelPipe(request, env, pathname) {
	if (pathname === "/p" || pathname.startsWith("/p/")) {
		const parsed = parsePipePath(pathname);
		if (!parsed)
			return noindex(new Response("Not found", { status: 404 }));
		if (!isWebSocketUpgrade(request)) {
			return noindex(
				new Response("Expected Upgrade: websocket", { status: 426 }),
			);
		}
		const stub = env.PIPE.getByName(parsed.box);
		const fwd = new Request(request);
		fwd.headers.set("X-Tunnel-Role", parsed.agent ? "agent" : "client");
		return stub.fetch(fwd);
	}

	if (pathname === "/t" || pathname.startsWith("/t/")) {
		const agent = parseAgentPath(pathname);
		const client = agent ? null : parseTunnelPath(pathname);
		const parsed = agent
			? { ...agent, agent: true }
			: client
				? { ...client, agent: false }
				: null;
		if (!parsed) return noindex(new Response("Not found", { status: 404 }));
		const stub = env.TUNNEL.getByName(parsed.room);
		const fwd = new Request(request);
		fwd.headers.set("X-Tunnel-Role", parsed.agent ? "agent" : "client");
		return stub.fetch(fwd);
	}

	return null;
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
			return noindex(
				new Response("ok", {
					headers: {
						"Content-Type": "text/plain",
						"Cache-Control": "no-store",
					},
				}),
			);
		}

		// Apex is static-only: tunnel/pipe URLs never proxy here so the
		// apex domain never looks like an open proxy / URL obfuscator to
		// FortiGuard / Palo Alto / BrightCloud. Long URLs live on go.*.
		if (url.hostname === APEX_HOST && isTunnelPath(url.pathname)) {
			return noindex(
				withSecurityHeaders(
					new Response(
						`Gone: tunnel URLs moved to https://${TUNNEL_HOST}${url.pathname}\n`,
						{
							status: 410,
							headers: {
								"Content-Type": "text/plain; charset=utf-8",
								"Cache-Control": "no-store",
							},
						},
					),
					request.url,
				),
			);
		}

		// Tunnel host serves tunnels/pipes only: apex marketing content is
		// never duplicated here (avoids duplicate-content SEO penalty).
		if (url.hostname === TUNNEL_HOST) {
			if (url.pathname === "/") {
				return Response.redirect(`https://${APEX_HOST}/`, 301);
			}
			const tunneled = await handleTunnelPipe(request, env, url.pathname);
			if (tunneled) return tunneled;
			return noindex(
				withSecurityHeaders(
					new Response("Not found\n", {
						status: 404,
						headers: {
							"Content-Type": "text/plain; charset=utf-8",
							"Cache-Control": "no-store",
						},
					}),
					request.url,
				),
			);
		}

		// Dev/preview hosts (workers.dev, localhost): tunnels + static.
		if (url.hostname !== APEX_HOST && isTunnelPath(url.pathname)) {
			const tunneled = await handleTunnelPipe(request, env, url.pathname);
			if (tunneled) return tunneled;
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
				request.url,
			);
			out.headers.set("X-Robots-Tag", "noindex");
			return out;
		}
		return withSecurityHeaders(asset, request.url);
	},
};
