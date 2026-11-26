#!/usr/bin/env python3
"""학년부장 OS — 동기화 경로 검증 (가짜 Apps Script 백엔드)

실제 배포 전에 프론트의 연결·저장·불러오기·충돌 병합 로직을 확인합니다.
  · GET /api?action=ping|load  → JSONP
  · POST /api                  → { ok, rev }
"""
import base64, functools, http.server, json, os, socketserver, sys, threading, time, urllib.parse

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8131
BASE = f"http://127.0.0.1:{PORT}/"
DOCS = {}   # key -> {"data":..., "rev":...}
LOCK = threading.Lock()
fails = []


def check(c, m):
    print(("  ok   " if c else "  FAIL ") + m)
    if not c:
        fails.append(m)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def _jsonp(self, obj, cb):
        body = f"{cb}({json.dumps(obj)});".encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/javascript; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api":
            q = urllib.parse.parse_qs(u.query)
            cb = (q.get("callback") or [""])[0]
            action = (q.get("action") or ["ping"])[0]
            key = (q.get("key") or ["state"])[0]
            with LOCK:
                if action == "ping":
                    out = {"ok": True, "app": "grade-head-os", "backend": "mock", "sheet": {"title": "mock"}}
                elif action == "load":
                    d = DOCS.get(key)
                    out = {"ok": True, "key": key,
                           "data": d["data"] if d else None,
                           "rev": d["rev"] if d else "", "updatedAt": ""}
                else:
                    out = {"ok": False, "error": "bad action"}
            self._jsonp(out, cb or "cb")
            return
        super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/api":
            self.send_response(404); self.end_headers(); return
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            body = {}
        key = body.get("key") or "state"
        with LOCK:
            cur = DOCS.get(key)
            base = str(body.get("baseRev") or "")
            if cur and base and base != cur["rev"]:
                out = {"ok": False, "conflict": True, "rev": cur["rev"], "data": cur["data"]}
            else:
                rev = str(int(time.time() * 1000))
                DOCS[key] = {"data": body.get("data"), "rev": rev}
                out = {"ok": True, "rev": rev}
        raw = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.end_headers()


def serve():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def hash_for(url):
    return "#s=" + base64.b64encode(url.encode()).decode()


def main():
    httpd = serve()
    api = BASE + "api"
    h = hash_for(api)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            # ----- 1) 기기 A: 연결 후 기록 저장
            a = b.new_context(viewport={"width": 390, "height": 844})
            pa = a.new_page()
            errs = []
            pa.on("pageerror", lambda e: errs.append(str(e)))
            pa.goto(BASE + h, wait_until="networkidle")
            pa.wait_for_timeout(900)
            chip = pa.inner_text("#sync-chip")
            check("동기화" in chip, f"기기 A 연결 상태: {chip}")
            pa.click('[data-a="nav"][data-r="log"]:visible')
            pa.wait_for_timeout(300)
            pa.click('[data-a="open-retro"]')
            pa.wait_for_timeout(400)
            pa.fill("#r-situation", "동기화 테스트 기록")
            pa.fill("#r-next", "다른 기기에서 보여야 함")
            pa.click('[data-a="save-retro"]')
            pa.wait_for_timeout(1800)
            with LOCK:
                saved = DOCS.get("state", {}).get("data") or {}
            items = [r for r in saved.get("retro", []) if r.get("situation") == "동기화 테스트 기록"]
            check(bool(items), "기기 A 저장 → 서버 반영")
            check("동기화됨" in pa.inner_text("#sync-chip"), f"A 칩: {pa.inner_text('#sync-chip')}")

            # ----- 2) 기기 B: 같은 주소로 열면 서버 내용을 받아온다
            c = b.new_context(viewport={"width": 1440, "height": 900})
            pb = c.new_page()
            pb.goto(BASE + h, wait_until="networkidle")
            pb.wait_for_timeout(1200)
            pb.click('[data-a="nav"][data-r="log"]:visible')
            pb.wait_for_timeout(400)
            check("동기화 테스트 기록" in pb.inner_text("body"), "기기 B가 서버 기록을 받아옴")

            # ----- 3) 기기 B에서 추가 저장 → 서버에 두 건
            pb.click('[data-a="open-retro"]')
            pb.wait_for_timeout(400)
            pb.fill("#r-situation", "PC에서 남긴 기록")
            pb.click('[data-a="save-retro"]')
            pb.wait_for_timeout(1800)
            with LOCK:
                saved = DOCS.get("state", {}).get("data") or {}
            names = [r.get("situation") for r in saved.get("retro", [])]
            check("동기화 테스트 기록" in names and "PC에서 남긴 기록" in names, f"서버에 두 기록 {names}")

            # ----- 4) 기기 A 새로고침 → PC 기록까지 병합해서 보인다
            pa.reload(wait_until="networkidle")
            pa.wait_for_timeout(1400)
            pa.click('[data-a="nav"][data-r="log"]:visible')
            pa.wait_for_timeout(400)
            body = pa.inner_text("body")
            check("PC에서 남긴 기록" in body, "기기 A가 다른 기기 기록을 병합")

            # ----- 5) 체크 상태도 서버에 저장되는지
            pa.click('[data-a="nav"][data-r="radar"]:visible')
            pa.wait_for_timeout(500)
            pa.click('[data-a="check"]')
            pa.wait_for_timeout(1600)
            with LOCK:
                saved = DOCS.get("state", {}).get("data") or {}
            check(bool(saved.get("checks")), f"체크 상태 저장 {list(saved.get('checks', {}))[:2]}")

            check(not errs, f"페이지 오류 0 {errs}")
            b.close()
    finally:
        httpd.shutdown()

    print("\n실패:", len(fails))
    for f in fails:
        print(" -", f)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
