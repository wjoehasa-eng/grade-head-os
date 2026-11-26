#!/usr/bin/env python3
"""학년부장 OS — 전체 동작 검증 (PC 1440×900 / 모바일 390×844)

검증 항목
  · 모든 탭 렌더링, 3초 판단 카드 3가지 결론, 월별 레이더 전환/체크 저장
  · 판단 엔진, 프로토콜 시트, 트래커 추가/필터, 회고 기록
  · 콘솔 오류 0, 페이지 오류 0, 실패 리소스 0
  · 모바일 가로 넘침 0
"""
import functools, http.server, io, json, os, socketserver, sys, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "shots")
os.makedirs(OUT, exist_ok=True)
PORT = 8127
BASE = f"http://127.0.0.1:{PORT}/"

fails = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


def serve():
    handler = functools.partial(Quiet, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def collect(page):
    logs = {"console": [], "pageerror": [], "failed": []}
    page.on("console", lambda m: logs["console"].append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: logs["pageerror"].append(str(e)))
    page.on("requestfailed", lambda r: logs["failed"].append(r.url))
    return logs


def overflow(page):
    return page.evaluate(
        "() => { const d = document.documentElement; return d.scrollWidth - d.clientWidth; }"
    )


def text(page, sel):
    return page.inner_text(sel)


def run(width, height, tag, shots=True):
    print(f"[{tag}] {width}x{height}")
    logs = None
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": width, "height": height}, device_scale_factor=2,
                            locale="ko-KR", timezone_id="Asia/Seoul")
        page = ctx.new_page()
        logs = collect(page)
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(600)

        # 홈
        check("지금 바로 답해도 되나?" in page.inner_text("body"), "홈 타이틀")
        check(overflow(page) <= 0, f"가로 넘침 없음 (home) = {overflow(page)}")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-01-home.png")

        # 3초 판단: 근거 O + 전체 X → 초안
        page.click('[data-a="toggle-q"][data-k="ground"]')
        page.wait_for_timeout(250)
        v = text(page, "#verdict-wrap")
        check("초안 즉시 제시" in v, "판단: 근거만 → 초안 즉시 제시")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-02-verdict-draft.png")

        # 전체 영향 → 즉답 금지
        page.click('[data-a="toggle-q"][data-k="all"]')
        page.wait_for_timeout(250)
        v = text(page, "#verdict-wrap")
        check("즉답 금지" in v, "판단: 전체 영향 → 즉답 금지")
        check("확인해서" in v, "보낼 문장 생성")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-03-verdict-hold.png")

        # 보고 필요 → 즉시 보고
        page.click('[data-a="toggle-q"][data-k="report"]')
        page.wait_for_timeout(250)
        v = text(page, "#verdict-wrap")
        check("즉시 보고" in v, "판단: 보고 필요 → 즉시 보고")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-04-verdict-report.png")

        # 레이더
        page.click('[data-a="nav"][data-r="radar"]:visible')
        page.wait_for_timeout(400)
        check("1년 선제 레이더" in page.inner_text("body"), "레이더 진입")
        check(overflow(page) <= 0, f"가로 넘침 없음 (radar) = {overflow(page)}")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-05-radar.png")
        page.click('[data-a="month"][data-m="3"]')
        page.wait_for_timeout(350)
        check("학기 초" in page.inner_text(".month-hero"), "3월 전환")
        # 체크 저장
        page.click('[data-a="check"]')
        page.wait_for_timeout(250)
        check("1/" in page.inner_text("#checks-card"), "체크 진행률 1/6")
        page.click('[data-a="grade"][data-g="4"]')
        page.wait_for_timeout(350)
        check("4학년" in page.inner_text(".month-hero"), "4학년 전환")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-06-radar-check.png")

        # 판단·조율
        page.click('[data-a="nav"][data-r="judge"]:visible')
        page.wait_for_timeout(350)
        check("내가 정할 일인가" in page.inner_text("body"), "판단 탭")
        page.click('[data-a="shape"][data-k="fair"]')
        page.wait_for_timeout(250)
        check("협조 일" in page.inner_text("#shape-result"), "판별: 공평 문제 → 협조 일")
        check(overflow(page) <= 0, f"가로 넘침 없음 (judge) = {overflow(page)}")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-07-judge.png")

        # 대응 — 프로토콜
        page.click('[data-a="nav"][data-r="respond"]:visible')
        page.wait_for_timeout(350)
        check("대응 프로토콜" in page.inner_text("body"), "대응 탭")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-08-protocols.png")
        page.click('[data-a="protocol"][data-id="p1"]')
        page.wait_for_timeout(450)
        check("절대 금지" in page.inner_text("#sheet"), "프로토콜 시트 내용")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-09-protocol-sheet.png")
        page.click("#sheet .sheet-head [data-a=\"close-sheet\"]")
        page.wait_for_timeout(350)

        # 트래커
        page.click('[data-a="respond-tab"][data-t="tracker"]')
        page.wait_for_timeout(350)
        check("12개 반" in page.inner_text("body") or "반별 진행 중" in page.inner_text("body"), "트래커 진입")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-10-tracker-empty.png")
        page.click('[data-a="open-case"]')
        page.wait_for_timeout(450)
        page.fill("#f-title", "급식 메뉴 관련 반복 문의")
        page.fill("#f-memo", "1반 학부모가 2회 전화. 학교 기준 안내 후 추가 요구 없음.")
        page.select_option("#f-urgency", "높음")
        page.select_option("#f-report", "보고 필요")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-11-case-form.png")
        page.click('[data-a="save-case"]')
        page.wait_for_timeout(500)
        body = page.inner_text("body")
        check("급식 메뉴 관련" in body, "트래커 카드 저장")
        check("보고 필요" in body, "보고 필요 뱃지")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-12-tracker-filled.png")
        page.click('[data-a="t-filter"][data-k="report"]')
        page.wait_for_timeout(300)
        check("급식 메뉴 관련" in page.inner_text("body"), "보고 필요 필터 유지")
        check(overflow(page) <= 0, f"가로 넘침 없음 (tracker) = {overflow(page)}")

        # 기록
        page.click('[data-a="nav"][data-r="log"]:visible')
        page.wait_for_timeout(350)
        page.click('[data-a="open-retro"]')
        page.wait_for_timeout(450)
        page.fill("#r-situation", "동학년이 수행평가 마감일을 물어옴")
        page.fill("#r-decision", "바로 답하지 않고 학년 공통표 확인 후 일괄 안내")
        page.fill("#r-next", "질문이 오면 바로 공통표 링크를 먼저 보낸다")
        page.click('[data-a="save-retro"]')
        page.wait_for_timeout(500)
        check("수행평가 마감일" in page.inner_text("body"), "회고 저장")
        check(overflow(page) <= 0, f"가로 넘침 없음 (log) = {overflow(page)}")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-13-log.png")

        # 설정 — 학년 변경
        page.click('[data-a="settings"]:visible')
        page.wait_for_timeout(400)
        check("비공개 시트 연결" in page.inner_text("#sheet"), "설정 시트")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-14-settings.png")
        page.click("#sheet .sheet-head [data-a=\"close-sheet\"]")
        page.wait_for_timeout(300)

        # 새로고침 후 로컬 저장 유지
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(600)
        page.click('[data-a="nav"][data-r="log"]:visible')
        page.wait_for_timeout(300)
        check("수행평가 마감일" in page.inner_text("body"), "새로고침 후 기록 유지")

        # 서비스 워커
        sw = page.evaluate("() => navigator.serviceWorker.getRegistrations().then(r => r.length)")
        check(sw >= 1, f"서비스 워커 등록 {sw}")

        # 오류
        check(not logs["pageerror"], f"페이지 오류 0 {logs['pageerror']}")
        check(not logs["console"], f"콘솔 오류 0 {logs['console']}")
        failed = [u for u in logs["failed"] if "favicon" not in u]
        check(not failed, f"실패 리소스 0 {failed}")

        b.close()


if __name__ == "__main__":
    httpd = serve()
    try:
        run(1440, 900, "pc")
        run(390, 844, "m")
    finally:
        httpd.shutdown()
    print("\n실패:", len(fails))
    for f in fails:
        print(" -", f)
    sys.exit(1 if fails else 0)
