// Shared constants + helpers for the tunnel Worker, agents, and CLI.
// Zero dependencies, ESM, runs in Workers + Node 22+ (no Node: imports).
// Python (agent.py) mirrors these values by hand — keep in sync, see comment there.
//
// Import from:
//   src/*    -> ../lib/shared.js
//   agent/*  -> ../lib/shared.js
//   bin/*    -> ../lib/shared.js

export const DEFAULT_HOST = "https://go.treau.me";

// Long URL IDs: the room/box ID itself is the secret (no token).
export const ID_RE = /^[A-Za-z0-9_-]{20,64}$/;
export const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const HOP_HEADERS = new Set([
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
	// `Expect: 100-continue` must not be forwarded through the tunnel:
	// undici fetch rejects it (NotSupportedError) and the worker/agent hop
	// cannot honor 100-continue semantics. The agent negotiates its own
	// expectation with the upstream.
	"expect",
]);

// HTTP methods: allow any token-shaped method except TRACE/TRACK
// (old code allow-listed 7 and returned 405 for the rest).
const BLOCKED_METHODS = new Set(["TRACE", "TRACK"]);
export function isAllowedMethod(method) {
	if (typeof method !== "string") return false;
	if (BLOCKED_METHODS.has(method)) return false;
	return /^[A-Z]+$/.test(method) && method.length <= 16;
}

// ---- ids ---------------------------------------------------------------

export function newRoomId() {
	// 128-bit (16 bytes -> 32 hex chars), matches ID_RE.
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- urls ---------------------------------------------------------------

export function normalizeTunnelUrl(raw) {
	const converted = String(raw)
		.replace(/^https:\/\//, "wss://")
		.replace(/^http:\/\//, "ws://");
	return converted;
}

export function normalizeClientUrl(raw) {
	// Laptop-side helper (ws-ssh-proxy, ssh clients): accept https:// too,
	// the wire is always WebSocket.
	return normalizeTunnelUrl(raw);
}

export function isValidTunnelUrl(url) {
	return /^wss?:\/\//.test(url);
}

export function wsBaseFromHttp(host) {
	return String(host).replace(/\/$/, "").replace(/^http/, "ws");
}

// Single host rule everywhere: --host flag > TUNNEL_HOST env > default.
// No config file. `flag` is the already-parsed --host value (or null).
export function resolveHost(flag) {
	const h = String(flag || "").trim() || process.env.TUNNEL_HOST || DEFAULT_HOST;
	return h.replace(/\/$/, "");
}

// Target kind: http(s)://... -> "http", anything else (HOST:PORT) -> "tcp".
export function detectKind(target) {
	if (/^https?:\/\//i.test(String(target || ""))) return "http";
	return "tcp";
}

// Validate a tcp target shaped like HOST:PORT (port optional, default 22).
export function parseTcpTarget(target) {
	const m = String(target || "").match(/^([A-Za-z0-9_.-]+)(?::(\d{1,5}))?$/);
	if (!m) return null;
	const port = m[2] ? Number(m[2]) : 22;
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return { host: m[1], port };
}

// ---- headers ------------------------------------------------------------

export function cleanHeadersObj(obj) {
	const out = {};
	if (!obj || typeof obj !== "object") return out;
	for (const [k, v] of Object.entries(obj)) {
		if (typeof v !== "string") continue;
		if (!HOP_HEADERS.has(String(k).toLowerCase())) out[k] = v;
	}
	return out;
}

export function cleanHeadersFromHeaders(headers) {
	const out = {};
	for (const [k, v] of headers) {
		if (!HOP_HEADERS.has(k.toLowerCase())) out[k] = v;
	}
	return out;
}

// ---- tunnel binary multiplex (v3, no backward compat) ----------------------
// One agent WebSocket carries N streams. One WS message = exactly one frame:
//   [type:u8][stream:u32be][flags:u16be][len:u32be][payload 0..64K]
// (11-byte header.) stream 0 = connection-level frames (HELLO, HB) only;
// stream IDs are random 31-bit (same as pipe streams). Wire compat is gated
// by the HELLO {version} handshake, not a per-frame version byte.
//
// Types: HB keepalive (empty) · HEADERS opens a stream (worker->agent
// {method,path,headers}, agent->worker {status,headers}, JSON UTF-8) ·
// DATA raw body bytes · FIN clean end · RST abort (payload optional
// UTF-8 message) · HELLO agent->worker {name,version} on connect.
// FLAG_FIN on a DATA frame ends the stream with no separate FIN.

export const TUNNEL_VERSION = 3;

export const T_HB = 0;
export const T_HEADERS = 1;
export const T_DATA = 2;
export const T_FIN = 3;
export const T_RST = 4;
export const T_HELLO = 5;

export const T_FLAG_FIN = 1;
// DATA with this flag carries UTF-8 text (visitor/upstream text frames).
// Preserved end to end so chat/HMR apps see text frames, not binary.
export const T_FLAG_TEXT = 2;

export const TUNNEL_FRAME_HEADER = 11;

// ---- backoff with stable-reset ------------------------------------------
// Old agents only grew the delay (1s -> 30s) and never reset, so one flap
// after 10h stable still waited 30s. This resets after STABLE_MS of uptime.

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const BACKOFF_STABLE_MS = 60_000;

export function nextBackoffDelay(currentMs) {
	const wait =
		Math.min(currentMs, BACKOFF_MAX_MS) * (0.8 + Math.random() * 0.4);
	const next = Math.min(currentMs * 2, BACKOFF_MAX_MS);
	return { wait, next };
}

export function backoffAfterSession(currentMs, sessionMs) {
	if (sessionMs >= BACKOFF_STABLE_MS) return BACKOFF_BASE_MS;
	return Math.min(currentMs * 2, BACKOFF_MAX_MS);
}

// ---- tunnel streaming (v3 binary) ------------------------------------------
// HEADERS opens a stream, then 0..N DATA frames, then FIN (or RST to abort).
// Bodies stream in CHUNK_BYTES pieces with no Base64 tax; the only timeout
// is IDLE (sliding: any frame for that stream resets it), so SSE, chunked
// video, WebSocket passthrough, and GB transfers work with bounded memory.

export const TUNNEL_CHUNK_BYTES = 64 * 1024;
export const TUNNEL_MAX_FRAME_BYTES = TUNNEL_FRAME_HEADER + 64 * 1024;
export const TUNNEL_IDLE_TIMEOUT_MS = 60_000;
// Absolute safety ceiling per stream (platform caps apply too). Env can
// raise/lower via MAX_TUNNEL_BYTES; default is generous.
export const TUNNEL_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

export function encodeTunnelFrame(type, stream, payload, flags = 0) {
	const body = payload ?? new Uint8Array(0);
	const out = new Uint8Array(TUNNEL_FRAME_HEADER + body.length);
	const dv = new DataView(out.buffer);
	dv.setUint8(0, type & 0xff);
	dv.setUint32(1, stream >>> 0);
	dv.setUint16(5, flags & 0xffff);
	dv.setUint32(7, body.length >>> 0);
	out.set(body, TUNNEL_FRAME_HEADER);
	return out;
}

export function decodeTunnelFrame(message) {
	if (typeof message === "string") return null; // binary-only wire
	const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
	if (bytes.length < TUNNEL_FRAME_HEADER) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, TUNNEL_FRAME_HEADER);
	const type = dv.getUint8(0);
	if (type > T_HELLO) return null;
	const len = dv.getUint32(7);
	if (len > 64 * 1024 || bytes.length !== TUNNEL_FRAME_HEADER + len) return null;
	return {
		type,
		stream: dv.getUint32(1),
		flags: dv.getUint16(5),
		payload: bytes.subarray(TUNNEL_FRAME_HEADER),
	};
}

const _te = new TextEncoder();
const _td = new TextDecoder();

export function tunnelHeadersPayload(obj) {
	return _te.encode(JSON.stringify(obj));
}

export function parseTunnelHeaders(payload) {
	try {
		const obj = JSON.parse(_td.decode(payload));
		return obj && typeof obj === "object" ? obj : null;
	} catch {
		return null;
	}
}

// ---- pipe frames ---------------------------------------------------------

export const F_HB = 0;
export const F_OPEN = 1;
export const F_ACCEPT = 2;
export const F_DATA = 3;
export const F_FIN = 4;
export const F_RST = 5;
// Client->worker half-close without the 5-byte DATA collision: clients send a
// TEXT frame with exactly this payload (binary DATA can never collide with
// a text frame). Old binary magic [FIN,0,0,0,0] still accepted for compat.
export const HALF_CLOSE_TEXT = "__half_close__";
export const HALF_CLOSE_MAGIC = [F_FIN, 0, 0, 0, 0];

export const PIPE_MAX_DATA = 256 * 1024;
export const PIPE_ACCEPT_TIMEOUT_MS = 10_000;
export const HEARTBEAT_MS = 20_000;

export function pipeFrame(type, stream, payload) {
	const body = payload ?? new Uint8Array(0);
	const out = new Uint8Array(5 + body.length);
	out[0] = type;
	new DataView(out.buffer).setUint32(1, stream >>> 0);
	out.set(body, 5);
	return out;
}

export function parsePipeFrame(message) {
	const bytes =
		typeof message === "string"
			? new TextEncoder().encode(message)
			: new Uint8Array(message);
	if (bytes.length < 5) return null;
	return {
		type: bytes[0],
		stream: new DataView(bytes.buffer, bytes.byteOffset, 5).getUint32(1),
		payload: bytes.subarray(5),
	};
}

export function newStreamId(taken) {
	let id = 0;
	do {
		id =
			(crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff) >>> 0;
	} while (id === 0 || taken.has(id));
	return id >>> 0;
}

// Probe header: `X-Tunnel-Probe: status` answers locally (never forwarded
// to upstream), so `tunnel info` can distinguish worker-404 from upstream-404.
export const PROBE_HEADER = "x-tunnel-probe";
export const STATUS_HEADER = "x-tunnel-status";
