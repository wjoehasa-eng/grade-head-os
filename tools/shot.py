#!/usr/bin/env python3
"""학년부장 OS — 화면 확인용 스크린샷 + 오류 수집 (내부 서버 포함)"""
import functools, http.server, os, socketserver, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "shots")
os.makedirs(OUT, exist_ok=True)
PORT = 8123


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def run(width, height, tag):
    errors, console = [], []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": width, "height": height}, device_scale_factor=2)
        pg.on("console", lambda m: console.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        pg.on("requestfailed", lambda r: errors.append("requestfailed: " + r.url))
        pg.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
        pg.wait_for_timeout(800)
        pg.screenshot(path=f"{OUT}/{tag}-today.png")
        print(tag, "errors:", errors)
        print(tag, "console:", console)
        b.close()


if __name__ == "__main__":
    httpd = serve()
    run(1440, 900, "pc")
    run(390, 844, "m")
    httpd.shutdown()
