#!/usr/bin/env python3
"""Offline test: --max-usd must be enforced before EVERY API call.

A local mock server answers every request with a fixed usage that costs exactly
USD 0.15 per call (see the price file written below). Two days of three chunks each
would cost 0.90 if the cap were only checked between days. With --max-usd 0.5 the run
must stop with rc=4 after the call that brings the total to or past 0.5 (0.60), never 0.90.

Run:  python3 tests/test_max_usd.py
No network, no API key: the mock server listens on 127.0.0.1 only.
"""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "notes", "memory_notes_nightly.py")
CALLS = []


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        self.rfile.read(n)
        CALLS.append(1)
        body = json.dumps({
            "content": [{"type": "text", "text": "### 日期 — 2026-01-0X（第 1/1 段）\n- 🔴 [09:12] [User] ordered a TV"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 1_000_000, "output_tokens": 0},  # 1M input tokens x $0.15/M = $0.15
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def make_day(src, day, chunks=3):
    # one channel, enough text to force several chunks (max 30000 chars per chunk)
    os.makedirs(os.path.join(src, "demo"), exist_ok=True)
    msgs = []
    for i in range(chunks):
        msgs.append(f"### {9 + i:02d}:00 👤 User\n" + ("x" * 29000) + "\n")
    with open(os.path.join(src, "demo", f"{day}.md"), "w", encoding="utf-8") as f:
        f.write("---\nchannel: demo\n---\n" + "\n".join(msgs))


def main():
    srv = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    with tempfile.TemporaryDirectory() as tmp:
        src, out, state = (os.path.join(tmp, d) for d in ("src", "out", "state"))
        make_day(src, "2026-01-01")
        make_day(src, "2026-01-02")
        prices = os.path.join(tmp, "prices.tsv")
        with open(prices, "w") as f:
            f.write("model\tinput\toutput\tcache_read\tcache_write\nclaude-haiku-5-5\t0.15\t0\t0\t0\n")
        env = dict(os.environ, MEMORY_OS_HOME=tmp, MEMORY_NOTES_SRC=src, MEMORY_NOTES_OUT=out,
                   MEMORY_NOTES_STATE=state, MEMORY_NOTES_PRICES=prices, ANTHROPIC_API_KEY="test-key",
                   MEMORY_NOTES_API_URL=f"http://127.0.0.1:{port}/v1/messages", MEMORY_NOTES_MODEL="claude-haiku-5-5")
        r = subprocess.run([sys.executable, "-I", SCRIPT, "--from", "2026-01-01", "--to", "2026-01-02", "--max-usd", "0.5"],
                           env=env, capture_output=True, text=True)
        spent = len(CALLS) * 0.15
        print(r.stdout)
        print(f"calls={len(CALLS)} spent=${spent:.2f} rc={r.returncode}")
        assert r.returncode == 4, f"expected rc=4, got {r.returncode}\n{r.stderr}"
        assert len(CALLS) == 4, f"expected 4 calls (0.60 total), got {len(CALLS)}"
        assert spent < 0.9 - 1e-9, "spend reached the uncapped total"
        assert "[LIMIT]" in r.stdout
        # a non-http(s) endpoint that is not local must be refused
        env2 = dict(env, MEMORY_NOTES_API_URL="http://example.com/v1/messages")
        r2 = subprocess.run([sys.executable, "-I", SCRIPT, "--day", "2026-01-01"], env=env2, capture_output=True, text=True)
        assert r2.returncode == 2, f"expected rc=2 for remote http, got {r2.returncode}"
    print("PASS test_max_usd")


if __name__ == "__main__":
    main()
