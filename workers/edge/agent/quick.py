#!/usr/bin/env python3
"""treaulab quick tunnel (trycloudflare-style): ephemeral public URL for a
local upstream, one command, zero setup. Pure Python standard library
(no pip, no Node, no clone).

    python3 quick.py [--upstream http://127.0.0.1:8080] [--json]
    UPSTREAM=http://127.0.0.1:8080 TUNNEL_HOST=https://go.treau.me python3 quick.py

Zero-clone one-liner (downloads this file only; it fetches agent.py itself):

    curl -fsSL https://raw.githubusercontent.com/treaulab/infra/main/workers/edge/agent/quick.py \\
      -o /tmp/quick.py
    UPSTREAM=http://127.0.0.1:8080 python3 /tmp/quick.py

Prints the public URL, then runs the agent in the foreground (Ctrl-C stops
it, like `tunnel --url`). The room ID is the secret: knowledge of the long
URL is the only gate. Python 3.8+.
"""

import argparse
import os
import secrets
import sys
import urllib.request

DEFAULT_HOST = "https://go.treau.me"
# Fallback source when quick.py runs without agent.py beside it (e.g. the
# zero-clone one-liner). Same trust as the curl-pipe itself.
AGENT_URL = (
    "https://raw.githubusercontent.com/treaulab/infra/main"
    "/workers/edge/agent/agent.py"
)


def parse_args(argv):
    p = argparse.ArgumentParser(
        description="Ephemeral trycloudflare-style tunnel (prints URL, runs agent)."
    )
    p.add_argument(
        "--upstream",
        default=os.environ.get("UPSTREAM", "http://127.0.0.1:8080"),
        help="local upstream to expose (default: $UPSTREAM or http://127.0.0.1:8080)",
    )
    p.add_argument(
        "--host",
        default=os.environ.get("TUNNEL_HOST", DEFAULT_HOST),
        help="edge host (default: $TUNNEL_HOST or " + DEFAULT_HOST + ")",
    )
    p.add_argument(
        "--json",
        action="store_true",
        help="print machine-readable {url, room, upstream} instead of text",
    )
    return p.parse_args(argv)


def run_agent(edge_url, upstream):
    """Run agent.py in-process: co-located import first, download fallback."""
    os.environ["EDGE_URL"] = edge_url
    os.environ["UPSTREAM"] = upstream
    try:
        import agent

        agent.main()
        return
    except ImportError:
        pass
    sys.stderr.write("note: fetching agent.py (no local copy)\n")
    with urllib.request.urlopen(AGENT_URL, timeout=30) as res:
        src = res.read().decode("utf-8")
    ns = {"__name__": "__main__", "__file__": "<agent.py>"}
    exec(compile(src, AGENT_URL, "exec"), ns)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    upstream = args.upstream.rstrip("/")
    host = (args.host or DEFAULT_HOST).rstrip("/")
    room = secrets.token_hex(16)  # 32 chars, matches edge ID_RE
    url = "%s/t/%s/" % (host, room)
    edge_url = (
        host.replace("https://", "wss://").replace("http://", "ws://")
        + "/t/"
        + room
        + "/__agent"
    )
    if args.json:
        import json as _json

        print(_json.dumps({"url": url, "room": room, "upstream": upstream}), flush=True)
    else:
        print("tunnel ready: %s" % url, flush=True)
        print(
            "room: %s   upstream: %s   (ephemeral - stops with this process)"
            % (room, upstream),
            flush=True,
        )
    try:
        run_agent(edge_url, upstream)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
