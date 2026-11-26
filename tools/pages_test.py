#!/usr/bin/env python3
"""GitHub Pages 와 같은 하위 경로(/grade-head-os/)에서의 동작 검증

  · 상대 경로 자산 로드, 서비스 워커 범위, 오프라인 재방문
"""
import functools, http.server, os, socketserver, sys, threading

from playwright.sync_api import sync_playwright

PARENT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # /workspace/tmp
PORT = 8151
BASE = f"http://127.0.0.1:{PORT}/grade-head-os/"
fails = []


def check(c, m):
    print(("  ok   " if c else "  FAIL ") + m)
    if not c:
        fails.append(m)


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=PARENT)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    httpd = serve()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            ctx = b.new_context(viewport={"width": 390, "height": 844})
            pg = ctx.new_page()
            errs, failed = [], []
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("requestfailed", lambda r: failed.append(r.url))
            pg.goto(BASE, wait_until="networkidle")
            pg.wait_for_timeout(800)
            check("지금 바로 답해도 되나?" in pg.inner_text("body"), "하위 경로에서 앱 렌더")
            check(not errs, f"콘솔 오류 0 {errs}")

            sw = pg.evaluate("() => navigator.serviceWorker.getRegistrations().then(rs => rs.map(r => r.scope))")
            check(any("/grade-head-os/" in s for s in sw), f"서비스 워커 범위 {sw}")

            mf = pg.evaluate("""async () => {
                const r = await fetch('./manifest.webmanifest');
                const j = await r.json();
                return {status: r.status, name: j.short_name, icons: j.icons.length};
            }""")
            check(mf["status"] == 200 and mf["icons"] >= 4, f"매니페스트 {mf}")

            # 오프라인 재방문
            ctx.set_offline(True)
            pg.reload(wait_until="domcontentloaded")
            pg.wait_for_timeout(1200)
            check("지금 바로 답해도 되나?" in pg.inner_text("body"), "오프라인에서도 열림")
            check(not errs, f"오프라인 콘솔 오류 0 {errs}")
            b.close()
    finally:
        httpd.shutdown()
    print("\n실패:", len(fails))
    for f in fails:
        print(" -", f)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
