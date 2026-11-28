#!/usr/bin/env python3
"""학년부장 OS v5 — 전체 동작 검증 (PC 1440×900 / 모바일 390×844)

검증 항목
  · 전 탭 렌더링, 3초 판단 스텝 분기 7갈래 + 전체 6문항 + 약속 시각·복사
  · 결론 → 프로토콜·판단 화면 연결, 레이더 → 프로토콜·부서·순서표 연결
  · 레이더 월 전환·체크·직접 편집(제목·체크 추가) → 저장 → 기본값 복원
  · 학년도 전환(새 학년도 + 전년도 레이더 복사, 체크리스트 초기화, 지난 학년도)
  · 1~6학년 선택, 역할·직책 직접 입력
  · 대응 프로토콜 6묶음 = 40개 전부, 상세에서 수정·링크
  · 명단 붙여넣기 → 트래커 대상자, 사안·회고 저장, 허브, 찾기, 운영 원칙 편집
  · JSON/CSV 내보내기, 콘솔 오류 0, 페이지 오류 0, 모바일 가로 넘침 0
"""
import functools
import http.server
import os
import socketserver
import sys
import threading

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


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def overflow(page):
    return page.evaluate("() => { var d = document.documentElement; return d.scrollWidth - d.clientWidth; }")


def collect(page):
    logs = []
    page.on("console", lambda m: logs.append("console " + m.type + ": " + m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: logs.append("pageerror: " + str(e)))
    return logs


def nav(page, route):
    page.click(f'[data-a="nav"][data-r="{route}"]:visible')
    page.wait_for_timeout(280)


def close_sheet(page):
    if page.query_selector(".sheet.show"):
        page.click('.sheet-head [data-a="close-sheet"]')
        page.wait_for_timeout(250)


def restart_flow(page):
    if page.query_selector('[data-a="step-list"]'):
        page.click('[data-a="step-list"]')
        page.click('[data-a="step-list"]')
    elif page.query_selector('[data-a="step-restart"]'):
        page.click('[data-a="step-restart"]')
    page.wait_for_timeout(150)


def run(width, height, tag, shots=True):
    print(f"[{tag}] {width}x{height}")
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": width, "height": height}, device_scale_factor=2,
                            locale="ko-KR", timezone_id="Asia/Seoul", accept_downloads=True)
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        page = ctx.new_page()
        page.on("dialog", lambda d: d.accept())
        logs = collect(page)
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(500)

        # ---------------------------------------------------------- 홈
        check("지금 답해도 될까요?" in page.inner_text("body"), "홈 타이틀")
        check("2026학년도" in page.inner_text("#year-switch"), "상단 학년도 표시")
        check(page.locator("#year-switch .ys-arrow").count() == 2, "학년도 ‹ › 버튼 2개")
        check("문서·드라이브" in page.inner_text("body"), "홈에 문서 허브 카드")
        check(overflow(page) <= 0, f"가로 넘침 없음 (home) = {overflow(page)}")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-01-home.png")

        # ---------------------------------------------------------- 3초 판단: 스텝 분기
        branches = [
            ((1,), "즉시 보고"),
            ((0, 1), "관리자 결정 먼저"),
            ((0, 0, 1), "행정실·교무실 경유"),
            ((0, 0, 0, 0), "즉답 금지"),
            ((0, 0, 0, 1, 1), "즉답 금지"),
            ((0, 0, 0, 1, 0, 0), "즉답 금지"),
            ((0, 0, 0, 1, 0, 1), "초안 즉시 제시"),
        ]
        for vals, want in branches:
            restart_flow(page)
            for v in vals:
                page.click(f'[data-a="step-ans"][data-v="{v}"]')
                page.wait_for_timeout(110)
            got = page.inner_text(".result-title") if page.query_selector(".result-title") else "(없음)"
            check(got == want, f"판단 분기 {vals} → {want}")

        # 약속 시각·복사·이어서
        restart_flow(page)
        page.click('[data-a="step-ans"][data-v="1"]')
        page.wait_for_timeout(250)
        page.fill("#time-input", "16:30")
        page.dispatch_event("#time-input", "change")
        page.wait_for_timeout(200)
        check("오후 4시 30분" in page.inner_text(".mtext"), "약속 시각이 문장에 반영")
        page.click(".result .copy-wide")
        page.wait_for_timeout(300)
        check(page.query_selector(".toast.show") is not None, "복사 → 토스트")
        page.screenshot(path=f"{OUT}/{tag}-02-verdict.png")
        page.click(".result .next-row")   # 프로토콜
        page.wait_for_timeout(500)
        check(page.query_selector(".sheet.show") is not None, "결론 → 프로토콜 바로 열림")
        close_sheet(page)
        rows = page.query_selector_all(".result .next-row")
        if len(rows) > 1:
            rows[1].click()
            page.wait_for_timeout(350)
            check("판단" in page.inner_text("#crumb"), "결론 → 판단 화면 연결")
            check(page.inner_text(".segmented .active") == "보고·결정권", "결론 → 보고·결정권 탭")
        nav(page, "today")
        page.click('[data-a="step-restart"]')
        page.wait_for_timeout(150)
        page.click('[data-a="step-list"]')
        page.wait_for_timeout(200)
        check(page.locator('[data-a="toggle-q"]').count() == 6, "전체 6문항 토글")
        page.click('[data-a="toggle-q"][data-k="ground"]')
        page.wait_for_timeout(200)
        check("초안 즉시 제시" in page.inner_text("#verdict-wrap"), "6문항: 근거만 → 초안 즉시 제시")
        page.click('[data-a="step-list"]')
        page.wait_for_timeout(150)

        # ---------------------------------------------------------- 레이더
        nav(page, "radar")
        check("1년 선제 레이더" in page.inner_text("body"), "레이더 진입")
        check(page.locator('[data-a="grade"]').count() == 6, "1~6학년 6개 선택")
        page.click('[data-a="month"][data-m="11"]')
        page.wait_for_timeout(300)
        check("11월" in page.inner_text(".month-hero2") and len(page.inner_text(".month-hero2 h2")) > 2, "11월 전환")
        page.click('[data-a="check"]')
        page.wait_for_timeout(250)
        check("1/" in page.inner_text("#checks-card"), "체크 진행률 1/N")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-03-radar.png")

        page.click('[data-a="radar-edit"]')
        page.wait_for_timeout(400)
        check("11월 레이더 편집" in page.inner_text("#sheet"), "레이더 편집 시트")
        page.fill("#e-title", "11월 — 내가 고친 레이더")
        page.fill("#e-lead", "내가 쓴 한 줄 요약")
        page.click('[data-a="row-add"][data-l="checks"]')
        page.wait_for_timeout(150)
        page.locator('.elist[data-l="checks"] .erow').last.locator(".ein").fill("내가 추가한 체크 항목")
        page.click('.elist[data-l="traps"] .erow .xbtn')
        page.wait_for_timeout(120)
        page.click('[data-a="radar-save"]')
        page.wait_for_timeout(450)
        check("내가 고친 레이더" in page.inner_text(".month-hero2"), "레이더 편집 저장 → 화면 반영")
        check("내가 추가한 체크 항목" in page.inner_text("#checks-card"), "체크리스트 항목 추가 반영")
        check("내가 고침" in page.inner_text(".month-hero2"), "수정 표시 배지")

        # 링크 (월)
        page.click('[data-a="edit-links"][data-kind="month"]')
        page.wait_for_timeout(350)
        page.fill(".linkro .lk-l", "학년 공용 폴더")
        page.fill(".linkro .lk-u", "drive.google.com/drive/folders/TEST")
        page.click('[data-a="link-save"]')
        page.wait_for_timeout(400)
        check("학년 공용 폴더" in page.inner_text("body"), "레이더 월 링크 표시")
        href = page.get_attribute("a.link-chip", "href")
        check(href and href.startswith("https://drive.google.com/"), f"링크 https 보정 {href}")
        page.click('[data-a="edit-links"][data-kind="month"]')
        page.wait_for_timeout(300)
        page.locator(".linkro").last.locator(".lk-u").fill("javascript:alert(1)")
        page.click('[data-a="link-save"]')
        page.wait_for_timeout(300)
        check("주소를 확인해 주세요" in page.inner_text("#toast"), "http(s) 아닌 주소 거부")
        close_sheet(page)

        # 레이더 → 프로토콜·부서·순서표 연결
        page.click('.card [data-a="protocol"]')
        page.wait_for_timeout(450)
        check(page.query_selector(".sheet.show") is not None, "레이더 → 프로토콜 연결")
        close_sheet(page)
        page.click('.card [data-a="go-judge-seg"]')
        page.wait_for_timeout(350)
        check("판단" in page.inner_text("#crumb") and page.inner_text(".segmented .active") == "결재 순서",
              "레이더 → 결재 순서표 연결")
        nav(page, "radar")
        page.click('.card [data-a="nav-desk"]')
        page.wait_for_timeout(300)
        check("기능부장 정석" in page.inner_text(".page-head"), "레이더 → 부서 연결")

        # ---------------------------------------------------------- 판단
        nav(page, "judge")
        check(page.locator('[data-a="shape"]').count() == 4, "일의 성격 4문항")
        page.click('[data-a="shape"][data-k="fair"]')
        page.wait_for_timeout(250)
        check("협조 일" in page.inner_text("#shape-result"), "성격 판별 → 협조 일")
        page.click('[data-a="judge-seg"][data-v="order"]')
        page.wait_for_timeout(300)
        check(page.locator('[data-a="judge-work"]').count() == 12, "결재 순서 12업무")
        page.click('[data-a="judge-work"][data-i="0"]')
        page.wait_for_timeout(300)
        check("물품·비품 구입" in page.inner_text(".detail-title"), "업무 상세 타임라인")
        page.click('[data-a="judge-work-back"]')
        page.wait_for_timeout(200)
        page.click('[data-a="judge-seg"][data-v="report"]')
        page.wait_for_timeout(300)
        check(page.locator('[data-a="report-level"]').count() == 3, "보고선 3단계")
        page.click('[data-a="report-tab"][data-v="decide"]')
        page.wait_for_timeout(250)
        check(page.locator('[data-a="report-level"]').count() == 3, "결정권 3주체")
        page.click('[data-a="judge-seg"][data-v="forms"]')
        page.wait_for_timeout(300)
        check(page.locator(".acc-card .acc").count() == 5, "양식·정석 5묶음")

        # ---------------------------------------------------------- 대응
        nav(page, "respond")
        check(page.locator('[data-a="resp-group"]').count() == 7, "프로토콜 6묶음 + 전체")
        total = 0
        for g in ["team", "parent", "admin", "safety", "dept", "record"]:
            page.click(f'[data-a="resp-group"][data-v="{g}"]')
            page.wait_for_timeout(200)
            total += page.locator(".list-row").count()
            page.click('[data-a="resp-back"]')
            page.wait_for_timeout(200)
        check(total == 40, f"프로토콜 40개가 6묶음에 한 번씩 ({total})")
        page.click('[data-a="resp-group"][data-v="all"]')
        page.wait_for_timeout(250)
        check(page.locator('[data-a="p-filter"]').count() == 4, "전체 보기 범위 필터")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-04-protocols.png")
        page.click('[data-a="protocol"]')
        page.wait_for_timeout(450)
        check(page.query_selector(".sheet.show") is not None, "프로토콜 상세 열림")
        check("지금 할 일" in page.inner_text(".sheet"), "프로토콜 상세: 할 일")
        page.click('.sheet [data-a="edit-protocol"]')
        page.wait_for_timeout(400)
        page.fill("#pt-title", "내가 고친 프로토콜")
        page.click('[data-a="save-protocol"]')
        page.wait_for_timeout(450)
        check("내가 고친 프로토콜" in page.inner_text("body"), "프로토콜 수정 저장")
        close_sheet(page)

        # 트래커 + 명단
        page.click('[data-a="respond-tab"][data-t="tracker"]')
        page.wait_for_timeout(300)
        page.click('[data-a="open-roster"]')
        page.wait_for_timeout(350)
        page.fill("#ro-paste", "학생\t1반\t1\t김가람\n학생\t1반\t2\t나바다")
        page.click('[data-a="roster-save"]')
        page.wait_for_timeout(450)
        check("2명" in page.inner_text("body") or "김가람" in page.inner_text("body"), "명단 저장")
        close_sheet(page)
        page.click('[data-a="open-case"]')
        page.wait_for_timeout(350)
        page.fill("#f-title", "테스트 사안")
        page.click('[data-a="save-case"]')
        page.wait_for_timeout(400)
        check("테스트 사안" in page.inner_text("body"), "사안 저장 → 트래커 표시")

        # ---------------------------------------------------------- 부서
        nav(page, "desk")
        check(page.locator('[data-a="desk"]').count() == 8, "부서 8개")
        page.click('[data-a="desk"]')
        page.wait_for_timeout(400)
        check("1년 흐름" in page.inner_text(".sheet"), "부서 상세 1년 흐름")
        check(page.locator('.sheet [data-a="protocol"]').count() >= 3, "부서 → 프로토콜 연결")
        close_sheet(page)

        # ---------------------------------------------------------- 기록
        nav(page, "log")
        page.click('[data-a="open-retro"]')
        page.wait_for_timeout(350)
        page.fill("#r-situation", "테스트 회고 상황")
        page.click('[data-a="save-retro"]')
        page.wait_for_timeout(400)
        check("테스트 회고 상황" in page.inner_text("body"), "회고 저장 → 기록 표시")

        # 운영 원칙
        nav(page, "today")
        page.click('[data-a="open-principles"]')
        page.wait_for_timeout(350)
        page.click('.sheet [data-a="edit-principles"]')
        page.wait_for_timeout(350)
        page.fill(".erow .pr-k", "테스트 원칙")
        page.click('[data-a="save-principles"]')
        page.wait_for_timeout(450)
        check("테스트 원칙" in page.inner_text("body"), "운영 원칙 저장")

        # 허브
        page.click('[data-a="hub-add"]')
        page.wait_for_timeout(350)
        page.fill("#hub-label", "테스트 폴더")
        page.fill("#hub-url", "https://example.com/folder")
        page.click('[data-a="hub-save"]')
        page.wait_for_timeout(450)
        close_sheet(page)
        check("테스트 폴더" in page.inner_text("body"), "허브 바로가기 추가")

        # ---------------------------------------------------------- 찾기
        page.click('.topbar [data-a="search"]')
        page.wait_for_timeout(350)
        page.fill("#q-all", "학운위")
        page.wait_for_timeout(400)
        rows = page.query_selector_all(".srch-row")
        check(len(rows) > 0, f"찾기 결과 {len(rows)}건")
        target = next((r for r in rows if "프로토콜" in r.inner_text()), rows[0])
        target.click()
        page.wait_for_timeout(600)
        check(page.query_selector(".sheet.show") is not None or "판단" in page.inner_text("#crumb"),
              "찾기 결과 → 화면 이동")
        close_sheet(page)

        # ---------------------------------------------------------- 학년도
        page.click("#year-switch .year-pill")
        page.wait_for_timeout(400)
        check("학년도 · 역할" in page.inner_text("#sheet"), "학년도·역할 시트")
        check(page.locator("#sheet [data-a='set-grade']").count() == 6, "학년도 시트에 1~6학년")
        page.click('[data-a="new-year-open"]')
        page.wait_for_timeout(250)
        page.fill("#ny-year", "2027")
        page.select_option("#ny-grade", "4")
        page.click('[data-a="create-year"]')
        page.wait_for_timeout(500)
        check("2027학년도" in page.inner_text("#year-switch"), "새 학년도 생성")
        nav(page, "radar")
        check("내가 고친 레이더" in page.inner_text(".month-hero2"), "전년도 레이더(내 수정) 승계")
        check(page.inner_text(".progress-num").startswith("0/"), f"새 학년도 체크리스트 초기화 {page.inner_text('.progress-num')}")
        page.click('[data-a="radar-edit"]')
        page.wait_for_timeout(350)
        page.click('[data-a="radar-reset"]')
        page.wait_for_timeout(400)
        check("내가 고친" not in page.inner_text(".month-hero2"), "기본값 복원")
        page.click('[data-a="year-step"][data-d="-1"]')
        page.wait_for_timeout(400)
        check("2026학년도" in page.inner_text("#year-switch"), "이전 학년도로 이동")
        check("지난 학년도" in page.inner_text("body"), "지난 학년도 안내")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-05-year.png")

        # 역할 직접 입력
        page.click("#year-switch .year-pill")
        page.wait_for_timeout(350)
        page.fill("#s-role", "기능부장")
        page.click('[data-a="save-role"]')
        page.wait_for_timeout(300)
        check("기능부장" in page.inner_text("#role-pill"), "역할·직책 직접 입력 반영")
        close_sheet(page)

        # ---------------------------------------------------------- 내보내기
        nav(page, "radar")
        page.click('[data-a="open-export"]')
        page.wait_for_timeout(350)
        try:
            with page.expect_download(timeout=5000):
                page.click('[data-a="csv-radar"]')
            check(True, "CSV 내보내기")
        except Exception as e:
            check(False, "CSV 내보내기 (" + str(e)[:40] + ")")
        close_sheet(page)

        check(overflow(page) <= 0, f"가로 넘침 없음 (끝) = {overflow(page)}")
        check(not logs, "콘솔·페이지 오류 0 " + str(logs[:2]))
        b.close()


if __name__ == "__main__":
    srv = serve()
    try:
        run(1440, 900, "pc")
        run(390, 844, "m")
    finally:
        srv.shutdown()
    print("\nFAILS:", len(fails))
    for f in fails:
        print(" -", f)
    sys.exit(1 if fails else 0)
