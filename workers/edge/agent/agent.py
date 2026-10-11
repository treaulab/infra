#!/usr/bin/env python3
"""treaulab tunnel agent: runs on the locked-down origin, dials OUT one
WebSocket to the edge and serves the local upstream over it.
Pure Python standard library (no pip, no Node): needs only
outbound 443 + DNS, like the Node agent.
Long-URL-only: the room ID in EDGE_URL is the secret (no token).

    EDGE_URL="wss://go.treau.me/t/<long-room-id>/__agent" \\
    UPSTREAM="http://127.0.0.1:8080" \\
    python3 agent.py

Env: EDGE_URL (required), UPSTREAM (default http://127.0.0.1:8080),
     UPSTREAM_TIMEOUT_MS (default 15000), NAME (default hostname).
Works on Python 3.8+.
"""

import base64
import hashlib
import json
import os
import random
import socket
import ssl
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from datetime import timezone

EDGE_URL_RAW = os.environ.get("EDGE_URL")
if not EDGE_URL_RAW:
    sys.stderr.write(
        "EDGE_URL is required, e.g. wss://go.treau.me/t/<long-room-id>/__agent\n"
    )
    sys.exit(1)
# Accept https:// too (common paste mistake) - the wire is always WebSocket.
EDGE_URL = EDGE_URL_RAW.replace("https://", "wss://").replace("http://", "ws://")
if EDGE_URL != EDGE_URL_RAW:
    sys.stderr.write("note: using %s (converted from %s)\n" % (EDGE_URL, EDGE_URL_RAW))
if not (EDGE_URL.startswith("wss://") or EDGE_URL.startswith("ws://")):
    sys.stderr.write(
        "bad EDGE_URL %r - want wss://<host>/t/<long-room-id>/__agent\n" % EDGE_URL_RAW
    )
    sys.exit(1)

UPSTREAM = os.environ.get("UPSTREAM", "http://127.0.0.1:8080").rstrip("/")
UPSTREAM_TIMEOUT_MS = int(os.environ.get("UPSTREAM_TIMEOUT_MS", "15000"))
NAME = os.environ.get("NAME") or socket.gethostname()
MAX_BODY = 5 * 1024 * 1024

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
}

# Keepalive: idle control sockets get reaped (~60s Cloudflare/NAT idle
# timeout, close 1006). The edge ignores {"type":"pong"} (see src/tunnel.js),
# so a pong every 20s is pure keepalive traffic.
HEARTBEAT_S = 20


def log(*a):
    print(datetime.now(timezone.utc).isoformat(), "-", *a, flush=True)


# ---- minimal WebSocket client (stdlib only) -------------------------------
# Speaks just enough RFC 6455 for the tunnel: masked client text frames out,
# fragmented server frames in, ping/pong/close control opcodes.

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_OP_TEXT = 0x1
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
        # timeout must not apply to the idle control socket. Dead sockets
        # surface via heartbeat send failures and close frames instead.
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

    def recv_message(self):
        """Next complete text message. Answers pings, ignores pongs."""
        parts = []
        while True:
            h = self._recvn(2)
            b1, b2 = h[0], h[1]
            fin = b1 & 0x80
            op = b1 & 0x0F
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
            if op == _OP_CLOSE:
                try:
                    self._send_frame(_OP_CLOSE, payload)
                except OSError:
                    pass
                raise WSClosed("close frame")
            if op == _OP_PING:
                try:
                    self._send_frame(_OP_PONG, payload)
                except OSError:
                    raise WSClosed("send failed")
                continue
            if op == _OP_PONG:
                continue
            if op == _OP_TEXT or op == 0x0:  # text or continuation
                parts.append(payload)
                if fin:
                    return b"".join(parts).decode("utf-8", "replace")
                continue
            # Other opcodes (incl. binary): tunnel is JSON-text; skip frame.
            if fin and not parts:
                continue

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


# ---- upstream fetch (direct connection, no proxy env) ----------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({}), _NoRedirect
)


def serve_upstream(env):
    target = UPSTREAM + env.get("path", "/")
    data = None
    if env.get("bodyB64"):
        data = base64.b64decode(env["bodyB64"])
    headers = {
        k: v
        for k, v in (env.get("headers") or {}).items()
        if k.lower() not in HOP and isinstance(v, str)
    }
    req = urllib.request.Request(
        target, data=data, headers=headers, method=env.get("method", "GET")
    )
    try:
        try:
            res = _OPENER.open(req, timeout=UPSTREAM_TIMEOUT_MS / 1000.0)
        except urllib.error.HTTPError as e:
            res = e  # 4xx/5xx are valid upstream responses; mirror them
        body = res.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            return {"type": "err", "id": env["id"], "message": "body too big"}
        out = {}
        for k, v in res.getheaders():
            if k.lower() not in HOP:
                out[k] = v
        return {
            "type": "res",
            "id": env["id"],
            "status": res.status,
            "headers": out,
            "bodyB64": base64.b64encode(body).decode("ascii") if body else None,
        }
    except Exception as e:  # noqa: BLE001 - must always answer the edge
        if isinstance(e, (socket.timeout, TimeoutError)):
            msg = "upstream timeout"
        else:
            msg = str(e) or type(e).__name__
        return {"type": "err", "id": env["id"], "message": msg}


# ---- control socket ---------------------------------------------------------


def connect_once():
    try:
        ws = WSClient(EDGE_URL)
        ws.connect()
    except Exception as e:  # noqa: BLE001 - redial loop reports it
        return "connect failed: %s" % e
    log("control socket open, registering as", NAME)
    try:
        ws.send_text(json.dumps({"type": "hello", "name": NAME, "version": 1}))
    except OSError as e:
        return "hello failed: %s" % e
    stop = threading.Event()

    def on_text(text):
        try:
            msg = json.loads(text)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        if msg.get("type") == "ping":
            try:
                ws.send_text(json.dumps({"type": "pong"}))
            except OSError:
                stop.set()
            return
        if msg.get("type") != "req" or not isinstance(msg.get("id"), str):
            return

        def work():
            answer = serve_upstream(msg)
            try:
                ws.send_text(json.dumps(answer))
            except OSError:
                stop.set()

        t = threading.Thread(target=work, daemon=True)
        t.start()

    def reader():
        try:
            while not stop.is_set():
                on_text(ws.recv_message())
        except WSClosed as e:
            if not stop.is_set():
                stop.reason = "code=1006 reason=%s" % e
                stop.set()
        except OSError as e:
            if not stop.is_set():
                stop.reason = "socket error: %s" % e
                stop.set()

    stop.reason = "unknown"
    rt = threading.Thread(target=reader, daemon=True)
    rt.start()
    # Heartbeat: quiet tunnels are healthy and must stay up.
    while not stop.wait(HEARTBEAT_S):
        try:
            ws.send_text(json.dumps({"type": "pong"}))
        except OSError as e:
            stop.reason = "heartbeat failed: %s" % e
            break
    reason = stop.reason
    ws.close()
    return reason


def main():
    log("agent starting:", NAME, "-> upstream", UPSTREAM)
    backoff = 1000
    while True:
        reason = connect_once()
        log("control socket closed:", reason)
        wait = min(backoff, 30000) / 1000.0 * (0.8 + random.random() * 0.4)
        log("redial in %.1fs" % wait)
        time.sleep(wait)
        backoff = min(backoff * 2, 30000)


if __name__ == "__main__":
    main()
