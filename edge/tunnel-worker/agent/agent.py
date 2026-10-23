#!/usr/bin/env python3
"""treaulab tunnel agent: runs on the locked-down origin, dials OUT one
WebSocket to the worker and serves the local upstream over it.
Pure Python standard library (no pip, no Node): needs only
outbound 443 + DNS, like the Node agent.
Long-URL-only: the room ID in the URL is the secret (no token).

    python3 agent.py [UPSTREAM] [--host H] [--id ID] [--json]

UPSTREAM defaults to http://127.0.0.1:8080. Omit --id to mint a fresh
room, print the public URL, and run (ephemeral — Ctrl-C stops it).
Pass --id to reuse a room (e.g. the id from `tunnel info <name>`).

    curl -fsSL https://raw.githubusercontent.com/treaulab/infra/main/edge/tunnel-worker/agent/agent.py \\
      -o /tmp/agent.py
    UPSTREAM="http://127.0.0.1:8080" python3 /tmp/agent.py

Binary multiplex (v3, no backward compat): one control socket carries N
streams, one WS message = one frame
[type:u8][stream:u32be][flags:u16be][len:u32be][payload 0..64KiB].
HTTP uploads stream via chunked Transfer-Encoding (never reassembled);
responses stream back in 64 KiB DATA frames. Visitor WS streams
(method "WS") are bridged to a local upstream WS with the same WSClient.

Env fallback (systemd, `tunnel up`): TUNNEL_URL + UPSTREAM (legacy EDGE_URL
still read as a deprecated alias).
Other env: UPSTREAM_TIMEOUT_MS (default 15000, time to first byte),
NAME (default hostname), TUNNEL_HOST (default https://go.treau.me,
used when --host is absent), MAX_CONCURRENT (default 16),
MAX_TUNNEL_BYTES (default 500 MiB ceiling).
Works on Python 3.8+.
"""

import argparse
import base64
import hashlib
import http.client
import json
import os
import random
import secrets
import socket
import ssl
import struct
import sys
import threading
import time
import urllib.parse
from datetime import datetime
from datetime import timezone
from queue import Queue

DEFAULT_HOST = "https://go.treau.me"


ID_RE = None
try:
    import re

    ID_RE = re.compile(r"^[A-Za-z0-9_-]{20,64}$")
except Exception:
    pass


def _parse_cli(argv):
    p = argparse.ArgumentParser(
        description="Tunnel agent: serve a local upstream over one outbound websocket.",
        prog="agent.py",
    )
    p.add_argument(
        "upstream",
        nargs="?",
        default=None,
        help="local upstream (default: $UPSTREAM or http://127.0.0.1:8080)",
    )
    p.add_argument(
        "--host",
        default=None,
        help="worker host (default: $TUNNEL_HOST or " + DEFAULT_HOST + ")",
    )
    p.add_argument(
        "--id",
        default=None,
        help="reuse a room id (default: mint a fresh one and print the URL)",
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="print {url, id, upstream} instead of text when minting",
    )
    return p.parse_args(argv)


_CLI = _parse_cli(sys.argv[1:])

# Bare run with no TUNNEL_URL mints a room (one-command share); a set
# TUNNEL_URL means persistent mode. Any explicit arg forces the new style.
# (Legacy EDGE_URL is still read as a deprecated alias - same semantics.)
_env_url = os.environ.get("TUNNEL_URL") or os.environ.get("EDGE_URL")
if (
    _CLI.upstream is not None
    or _CLI.host is not None
    or _CLI.id is not None
    or not _env_url
):
    _host = (_CLI.host or os.environ.get("TUNNEL_HOST") or DEFAULT_HOST).rstrip("/")
    _id = _CLI.id or secrets.token_hex(16)  # 32 chars, matches worker ID_RE
    if ID_RE is not None and not ID_RE.match(_id):
        sys.stderr.write("bad id %r - want 20-64 chars [A-Za-z0-9_-]\n" % _id)
        sys.exit(2)
    _upstream = (_CLI.upstream or os.environ.get("UPSTREAM") or "http://127.0.0.1:8080").rstrip("/")
    _url = "%s/t/%s/" % (_host, _id)
    os.environ["TUNNEL_URL"] = (
        _host.replace("https://", "wss://").replace("http://", "ws://")
        + "/t/"
        + _id
        + "/__agent"
    )
    os.environ["UPSTREAM"] = _upstream
    if _CLI.id is None:
        if _CLI.json:
            print(
                json.dumps({"url": _url, "id": _id, "upstream": _upstream}), flush=True
            )
        else:
            print("tunnel ready: %s" % _url, flush=True)
            print(
                "id: %s   upstream: %s   (ephemeral - stops with this process)"
                % (_id, _upstream),
                flush=True,
            )

TUNNEL_URL_RAW = os.environ.get("TUNNEL_URL") or os.environ.get("EDGE_URL")
if not TUNNEL_URL_RAW:
    sys.stderr.write(
        "give an upstream (e.g. python3 agent.py http://127.0.0.1:8080)"
        " or set TUNNEL_URL, e.g. wss://go.treau.me/t/<long-id>/__agent\n"
    )
    sys.exit(1)
if not os.environ.get("TUNNEL_URL") and os.environ.get("EDGE_URL"):
    sys.stderr.write("note: EDGE_URL is deprecated - use TUNNEL_URL (reading the legacy value)\n")
# Accept https:// too (common paste mistake) - the wire is always WebSocket.
TUNNEL_URL = TUNNEL_URL_RAW.replace("https://", "wss://").replace("http://", "ws://")
if TUNNEL_URL != TUNNEL_URL_RAW:
    sys.stderr.write("note: using %s (converted from %s)\n" % (TUNNEL_URL, TUNNEL_URL_RAW))
if not (TUNNEL_URL.startswith("wss://") or TUNNEL_URL.startswith("ws://")):
    sys.stderr.write(
        "bad TUNNEL_URL %r - want wss://<host>/t/<long-room-id>/__agent\n" % TUNNEL_URL_RAW
    )
    sys.exit(1)

UPSTREAM = (
    (_CLI.upstream or os.environ.get("UPSTREAM") or "http://127.0.0.1:8080").rstrip("/")
)
# (set from argv above when the new style is used; env otherwise)
UPSTREAM_TIMEOUT_MS = int(os.environ.get("UPSTREAM_TIMEOUT_MS", "15000"))
NAME = os.environ.get("NAME") or socket.gethostname()
# Safety ceiling per stream (matches JS agent + worker default 500 MiB).
MAX_BODY = int(os.environ.get("MAX_TUNNEL_BYTES", str(500 * 1024 * 1024)))
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "16"))
CHUNK_BYTES = 64 * 1024

# Mirrors edge/tunnel-worker/lib/shared.js HOP_HEADERS — keep in sync.
HOP = {
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
    # Mirrors lib/shared.js: `Expect: 100-continue` cannot survive the hop;
    # the agent negotiates with upstream itself.
    "expect",
}

# Keepalive: idle control sockets get reaped (~60s Cloudflare/NAT idle
# timeout, close 1006). A binary HB frame every 20s keeps it warm.
HEARTBEAT_S = 20

# Binary frame types — mirror lib/shared.js T_*.
T_HB = 0
T_HEADERS = 1
T_DATA = 2
T_FIN = 3
T_RST = 4
T_HELLO = 5
T_FLAG_FIN = 1
# DATA with this flag carries UTF-8 text (bridged text frames).
T_FLAG_TEXT = 2
FRAME_HDR = 11
TUNNEL_VERSION = 3


def log(*a):
    print(datetime.now(timezone.utc).isoformat(), "-", *a, flush=True)


# ---- binary frame codec (mirrors lib/shared.js) ----------------------------


def t_encode(ftype, stream, payload=b"", flags=0):
    payload = payload or b""
    return struct.pack("!BIHI", ftype & 0xFF, stream & 0xFFFFFFFF, flags & 0xFFFF, len(payload)) + payload


def t_decode(buf):
    if buf is None or len(buf) < FRAME_HDR:
        return None
    ftype, stream, flags, ln = struct.unpack("!BIHI", buf[:FRAME_HDR])
    if ftype > T_HELLO or ln > 64 * 1024 or len(buf) != FRAME_HDR + ln:
        return None
    return (ftype, stream, flags, buf[FRAME_HDR:])


def h_payload(obj):
    return json.dumps(obj).encode("utf-8")


def h_parse(payload):
    try:
        obj = json.loads(bytes(payload).decode("utf-8"))
        return obj if isinstance(obj, dict) else None
    except ValueError:
        return None


# ---- minimal WebSocket endpoint (stdlib only) --------------------------------
# Speaks enough RFC 6455 for both roles: masked client frames out (worker
# control socket AND local upstream WS dials), any server frames in.

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_OP_TEXT = 0x1
_OP_BIN = 0x2
_OP_CLOSE = 0x8
_OP_PING = 0x9
_OP_PONG = 0xA


class WSClosed(Exception):
    pass


class WSClient:
    def __init__(self, url, timeout=15):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ("ws", "wss"):
            raise ValueError("bad scheme %r" % u.scheme)
        self.host = u.hostname
        default_port = 443 if u.scheme == "wss" else 80
        self.port = u.port or default_port
        self.path = (u.path or "/") + (("?" + u.query) if u.query else "")
        self.secure = u.scheme == "wss"
        self.timeout = timeout
        self.sock = None
        self._lock = threading.Lock()

    def connect(self):
        s = socket.create_connection((self.host, self.port), timeout=self.timeout)
        if self.secure:
            s = ssl.create_default_context().wrap_socket(s, server_hostname=self.host)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_hdr = self.host
        if (self.secure and self.port != 443) or (not self.secure and self.port != 80):
            host_hdr = "%s:%d" % (self.host, self.port)
        req = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n" % (self.path, host_hdr, key)
        )
        s.sendall(req.encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = s.recv(4096)
            if not chunk:
                s.close()
                raise WSClosed("handshake EOF")
            head += chunk
            if len(head) > 65536:
                s.close()
                raise WSClosed("handshake too big")
        lines = head.split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")
        if " 101" not in lines[0]:
            s.close()
            raise WSClosed("handshake rejected: %s" % lines[0])
        want = base64.b64encode(
            hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()
        ).decode("ascii")
        got = ""
        for ln in lines[1:]:
            if ln.lower().startswith("sec-websocket-accept:"):
                got = ln.split(":", 1)[1].strip()
        if got != want:
            s.close()
            raise WSClosed("handshake accept mismatch")
        # Blocking reads from here on (like the Node agent): the connect
        # timeout must not apply to idle sockets. Dead sockets surface via
        # heartbeat send failures and close frames instead.
        s.settimeout(None)
        self.sock = s

    def _recvn(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise WSClosed("EOF")
            buf += chunk
        return buf

    def _send_frame(self, opcode, payload=b""):
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            hdr = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            hdr = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            hdr = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        masked = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
        with self._lock:
            self.sock.sendall(hdr + mask + masked)

    def send_text(self, s):
        self._send_frame(_OP_TEXT, s.encode("utf-8"))

    def send_binary(self, b):
        self._send_frame(_OP_BIN, bytes(b))

    def recv_frame(self):
        """Next complete data frame as (opcode, payload). Pings answered."""
        parts = []
        op = None
        while True:
            h = self._recvn(2)
            b1, b2 = h[0], h[1]
            fin = b1 & 0x80
            fop = b1 & 0x0F
            masked = b2 & 0x80
            n = b2 & 0x7F
            if n == 126:
                (n,) = struct.unpack("!H", self._recvn(2))
            elif n == 127:
                (n,) = struct.unpack("!Q", self._recvn(8))
            mask = self._recvn(4) if masked else None
            payload = self._recvn(n) if n else b""
            if mask:
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
            if fop == _OP_CLOSE:
                try:
                    self._send_frame(_OP_CLOSE, payload)
                except OSError:
                    pass
                raise WSClosed("close frame")
            if fop == _OP_PING:
                try:
                    self._send_frame(_OP_PONG, payload)
                except OSError:
                    raise WSClosed("send failed")
                continue
            if fop == _OP_PONG:
                continue
            if fop in (_OP_TEXT, _OP_BIN) or fop == 0x0:
                if op is None:
                    op = fop
                parts.append(payload)
                if fin:
                    return (op, b"".join(parts))
                continue
            # Other opcodes: skip frame.

    def close(self):
        try:
            self._send_frame(_OP_CLOSE, b"")
        except OSError:
            pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


# ---- upstream HTTP (direct connection, no proxy env) -------------------------
# Chunked upload via http.client: DATA frames stream straight into the
# request body, the response streams back in CHUNK reads. stdlib only.

_UP = urllib.parse.urlsplit(UPSTREAM)
_UP_SSL = _UP.scheme == "https"
_UP_HOST = _UP.hostname or "127.0.0.1"
_UP_PORT = _UP.port or (443 if _UP_SSL else 80)


def _upstream_conn():
    if _UP_SSL:
        return http.client.HTTPSConnection(
            _UP_HOST, _UP_PORT, timeout=UPSTREAM_TIMEOUT_MS / 1000.0
        )
    return http.client.HTTPConnection(
        _UP_HOST, _UP_PORT, timeout=UPSTREAM_TIMEOUT_MS / 1000.0
    )


_SEM = threading.Semaphore(MAX_CONCURRENT)
_STREAMS = {}
_STREAMS_LOCK = threading.Lock()


def _valid_path(p):
    return (
        isinstance(p, str)
        and p.startswith("/")
        and "://" not in p
        and len(p) <= 8192
    )


def _send_frame(ws, ftype, stream, payload=b"", flags=0):
    try:
        ws.send_binary(t_encode(ftype, stream, payload, flags))
        return True
    except OSError:
        return False


def _rst(ws, stream, msg):
    return _send_frame(ws, T_RST, stream, msg.encode("utf-8", "replace"))


def _clean_headers(obj):
    return {
        k: v
        for k, v in (obj or {}).items()
        if isinstance(v, str) and k.lower() not in HOP
    }


# ---- HTTP streams -------------------------------------------------------------


def _serve_http(ws, req_id, head):
    """Worker thread: chunked upload in, streamed response out.
    Owns one _SEM slot from entry to finally (exactly one release)."""
    if not _valid_path(head.get("path", "/")):
        _rst(ws, req_id, "bad path")
        return
    method = head.get("method", "GET")
    has_body = method not in ("GET", "HEAD")
    with _STREAMS_LOCK:
        st = _STREAMS.get(req_id)
    if st is None:  # worker RST won the race before we started
        return
    conn = None
    try:
        conn = _upstream_conn()
        conn.putrequest(method, head.get("path", "/"), skip_accept_encoding=True)
        for k, v in _clean_headers(head.get("headers")).items():
            conn.putheader(k, v)
        conn.putheader("Connection", "close")
        if has_body:
            conn.putheader("Transfer-Encoding", "chunked")
        conn.endheaders()
        if has_body:
            # Consume the body queue until the worker says FIN/RST.
            total = 0
            for item in _iter_body(req_id):
                if item is None:  # RST: worker is gone, stop quietly
                    try:
                        conn.close()
                    except Exception:
                        pass
                    return
                if item[0] == "fin":
                    break
                data = item[1]
                total += len(data)
                if total > MAX_BODY:
                    _rst(ws, req_id, "request body too big")
                    try:
                        conn.close()
                    except Exception:
                        pass
                    return
                conn.send(b"%x\r\n" % len(data) + bytes(data) + b"\r\n")
            conn.send(b"0\r\n\r\n")
        try:
            res = conn.getresponse()
        except (socket.timeout, TimeoutError):
            _rst(ws, req_id, "upstream timeout")
            return
        except Exception as e:
            _rst(ws, req_id, str(e) or type(e).__name__)
            return
        # First byte arrived: long streams must not die on read timeouts.
        try:
            conn.sock.settimeout(None)
        except Exception:
            pass
        out = {}
        try:
            for k, v in res.getheaders():
                if k.lower() not in HOP:
                    out[k] = v
        except Exception:
            pass
        status = res.status
        if not _send_frame(ws, T_HEADERS, req_id, h_payload({"status": status, "headers": out})):
            return
        try:
            while True:
                piece = res.read(CHUNK_BYTES)
                if not piece:
                    break
                if not _send_frame(ws, T_DATA, req_id, piece):
                    return
        except Exception as e:
            _rst(ws, req_id, str(e) or type(e).__name__)
            return
        _send_frame(ws, T_FIN, req_id)
    except Exception as e:  # noqa: BLE001 - must always answer or RST
        with _STREAMS_LOCK:
            alive = req_id in _STREAMS
        if alive:
            _rst(ws, req_id, str(e) or type(e).__name__)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        with _STREAMS_LOCK:
            _STREAMS.pop(req_id, None)
        _SEM.release()


def _iter_body(req_id):
    """Yield ('data', bytes) / ('fin',) from the worker; None on RST/death."""
    with _STREAMS_LOCK:
        st = _STREAMS.get(req_id)
    q = st["q"] if st else None
    if q is None:
        yield None
        return
    while True:
        item = q.get()
        if item is None:
            return
        yield item
        if item[0] == "fin":
            return


# ---- visitor WS bridge ----------------------------------------------------------


def _serve_ws(ws, req_id, head):
    """Worker thread: dial local upstream WS, bridge both ways."""
    if not _valid_path(head.get("path", "/")):
        _rst(ws, req_id, "bad path")
        _SEM.release()
        return
    target = ("wss://" if _UP_SSL else "ws://") + _UP_HOST
    if (_UP_SSL and _UP_PORT != 443) or (not _UP_SSL and _UP_PORT != 80):
        target += ":%d" % _UP_PORT
    target += head.get("path", "/")
    up = None
    try:
        up = WSClient(target, timeout=UPSTREAM_TIMEOUT_MS / 1000.0)
        up.connect()
    except Exception:
        if _ws_take(req_id) is not None:
            _rst(ws, req_id, "upstream ws failed")
            _SEM.release()
        return
    if _ws_take(req_id) is None:  # worker RST while dialing
        try:
            up.close()
        except OSError:
            pass
        return
    # Re-insert under ownership: from here exactly one of abort_stream /
    # upstream_reader releases the slot.
    with _STREAMS_LOCK:
        _STREAMS[req_id] = {"kind": "ws", "up": up, "released": False}
    if not _send_frame(ws, T_HEADERS, req_id, h_payload({"status": 101, "headers": {}})):
        if _ws_take(req_id) is not None:
            try:
                up.close()
            except OSError:
                pass
            _SEM.release()
        return

    def upstream_reader():
        try:
            while True:
                op, payload = up.recv_frame()
                with _STREAMS_LOCK:
                    alive = req_id in _STREAMS and not _STREAMS[req_id].get("released")
                if not alive:
                    return
                flag = T_FLAG_TEXT if op == _OP_TEXT else 0
                off = 0
                # Preserve text frames end to end (chat/HMR expect text).
                while off < len(payload):
                    if not _send_frame(ws, T_DATA, req_id, payload[off:off + CHUNK_BYTES], flag):
                        return
                    off += CHUNK_BYTES
        except (WSClosed, OSError):
            pass
        finally:
            if _ws_take(req_id) is not None:
                _send_frame(ws, T_FIN, req_id)
                try:
                    up.close()
                except OSError:
                    pass
                _SEM.release()

    rt = threading.Thread(target=upstream_reader, daemon=True)
    rt.start()

def _ws_take(req_id):
    """Pop a ws entry iff still owned. Non-None means the caller now owns
    the exactly-once _SEM release for this stream."""
    with _STREAMS_LOCK:
        st = _STREAMS.pop(req_id, None)
        if st is None or st.get("released"):
            return None
        st["released"] = True
        return st


# ---- control socket -------------------------------------------------------------


def connect_once():
    started_at = time.monotonic()
    try:
        ws = WSClient(TUNNEL_URL)
        ws.connect()
    except Exception as e:  # noqa: BLE001 - redial loop reports it
        return "connect failed: %s" % e, 0
    log("control socket open, registering as", NAME)
    try:
        ws.send_binary(t_encode(T_HELLO, 0, h_payload({"name": NAME, "version": TUNNEL_VERSION})))
    except OSError as e:
        return "hello failed: %s" % e, 0
    stop = threading.Event()

    def abort_stream(req_id):
        with _STREAMS_LOCK:
            st = _STREAMS.get(req_id)
            if st is None:
                return
            kind = st["kind"]
        if kind == "http":
            with _STREAMS_LOCK:
                st = _STREAMS.pop(req_id, None)
            if st is None:
                return
            st["q"].put(None)  # worker exits via _iter_body; finally releases
        elif kind == "ws":
            st = _ws_take(req_id)
            if st is None:
                return
            try:
                if st.get("up"):
                    st["up"].close()
            except OSError:
                pass
            _SEM.release()

    def on_frame(ftype, stream, flags, payload):
        if ftype == T_HB or ftype == T_HELLO:
            return
        if stream == 0:
            return
        req_id = stream
        if ftype == T_HEADERS:
            head = h_parse(payload)
            if not head or not isinstance(head.get("method"), str):
                _rst(ws, req_id, "bad HEADERS")
                return
            if not _SEM.acquire(blocking=False):
                _rst(ws, req_id, "overloaded")
                return
            with _STREAMS_LOCK:
                if req_id in _STREAMS:
                    _SEM.release()
                    _rst(ws, req_id, "duplicate HEADERS")
                    return
                if head["method"] == "WS":
                    _STREAMS[req_id] = {"kind": "ws", "up": None}
                else:
                    _STREAMS[req_id] = {"kind": "http", "q": Queue()}
            if head["method"] == "WS":
                t = threading.Thread(target=_serve_ws, args=(ws, req_id, head), daemon=True)
            else:
                t = threading.Thread(target=_serve_http, args=(ws, req_id, head), daemon=True)
            t.start()
            return
        with _STREAMS_LOCK:
            st = _STREAMS.get(req_id)
        if st is None:
            _rst(ws, req_id, "unknown stream")
            return
        if ftype == T_DATA:
            if st["kind"] == "http":
                q = st["q"]
                total = st.get("total", 0) + len(payload)
                if total > MAX_BODY:
                    with _STREAMS_LOCK:
                        _STREAMS.pop(req_id, None)
                    q.put(None)
                    _rst(ws, req_id, "request body too big")
                    return
                st["total"] = total
                q.put(("data", bytes(payload)))
            elif st["kind"] == "ws" and st.get("up"):
                try:
                    if flags & T_FLAG_TEXT:
                        st["up"].send_text(bytes(payload).decode("utf-8", "replace"))
                    else:
                        st["up"].send_binary(bytes(payload))
                except OSError:
                    pass
            if flags & T_FLAG_FIN:
                if st["kind"] == "http":
                    st["q"].put(("fin",))
                elif st["kind"] == "ws" and st.get("up"):
                    try:
                        st["up"].close()
                    except OSError:
                        pass
            return
        if ftype == T_FIN:
            if st["kind"] == "http":
                st["q"].put(("fin",))
            elif st["kind"] == "ws" and st.get("up"):
                try:
                    st["up"].close()
                except OSError:
                    pass
            return
        if ftype == T_RST:
            abort_stream(req_id)
            return

    def reader():
        try:
            while not stop.is_set():
                op, payload = ws.recv_frame()
                if op == _OP_TEXT:
                    continue  # binary-only wire; worker never sends text
                f = t_decode(payload)
                if f is None:
                    continue
                on_frame(*f)
        except (WSClosed, OSError) as e:
            if not stop.is_set():
                stop.reason = "socket: %s" % e
                stop.set()

    stop.reason = "unknown"
    rt = threading.Thread(target=reader, daemon=True)
    rt.start()
    # Heartbeat: quiet tunnels are healthy and must stay up.
    while not stop.wait(HEARTBEAT_S):
        try:
            ws.send_binary(t_encode(T_HB, 0))
        except OSError as e:
            stop.reason = "heartbeat failed: %s" % e
            break
    reason = stop.reason
    # Kill everything owned by this control socket.
    with _STREAMS_LOCK:
        doomed = list(_STREAMS.keys())
    for req_id in doomed:
        abort_stream(req_id)
    ws.close()
    return reason, time.monotonic() - started_at


def main():
    log("agent starting:", NAME, "-> upstream", UPSTREAM)
    backoff = 1000
    while True:
        reason, session_s = connect_once()
        log("control socket closed:", reason)
        wait = min(backoff, 30000) / 1000.0 * (0.8 + random.random() * 0.4)
        log("redial in %.1fs" % wait)
        time.sleep(wait)
        # Stable sessions reset the backoff (old code only grew to 30s).
        if session_s * 1000.0 >= 60_000:
            backoff = 1000
        else:
            backoff = min(backoff * 2, 30000)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
