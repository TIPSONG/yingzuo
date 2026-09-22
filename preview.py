"""Serve only the front-end preview on loopback; no ComfyUI or filesystem APIs."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen
import argparse
import json
import webbrowser

ROOT = Path(__file__).resolve().parent
PORT = 8840
IDENTITY = {"app": "yingzuo-alpha-preview", "version": "0.1", "mode": "frontend-only"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/healthz":
            data = json.dumps(IDENTITY).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        target = (ROOT / (path.lstrip("/") or "index.html")).resolve()
        if not target.is_relative_to(ROOT) or not target.is_file() or target.suffix.lower() not in {".html", ".css", ".js", ".png", ".svg"}:
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        self.send_error(405)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def log_message(self, *args):
        # pythonw has no console. The preview needs no request logs.
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{PORT}"
    try:
        with urlopen(f"{url}/healthz", timeout=1) as response:
            already_running = json.load(response) == IDENTITY
    except Exception:
        already_running = False
    if already_running:
        if args.open:
            webbrowser.open(url)
        return
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        # If the port belongs to another app, don't reuse or stop it.
        if args.open:
            webbrowser.open((ROOT / "index.html").as_uri())
        return
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
