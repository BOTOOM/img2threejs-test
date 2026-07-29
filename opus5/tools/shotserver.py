#!/usr/bin/env python3
"""Static file server for the viewer plus a PNG/JSON sink for the browser.

The review gates consume PNG files on disk. Rather than shuttling megabytes of
base64 through the agent's browser bridge, the page POSTs each rendered canvas
straight back to this server, which writes it under opus5/. Pure stdlib.

  POST /__save/renders/blockout-reference.png   body = raw PNG bytes
  POST /__save/review/parts.json                body = raw JSON bytes
  GET  /__status                                -> {"saved": [...]}
"""

from __future__ import annotations

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAVED: list[str] = []


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args) -> None:  # keep the console readable
        pass

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/__status":
            payload = json.dumps({"saved": SAVED}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.startswith("/__save/"):
            self.send_error(404)
            return
        relative = self.path[len("/__save/"):].split("?")[0].lstrip("/")
        target = (ROOT / relative).resolve()
        if ROOT not in target.parents:
            self.send_error(403, "path escapes the project root")
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        SAVED.append(f"{relative} ({len(body)} bytes)")
        print(f"saved {relative} ({len(body)} bytes)", flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


def main(argv: list[str]) -> int:
    port = int(argv[0]) if argv else 8712
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"serving {ROOT} on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
