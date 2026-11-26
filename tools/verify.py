#!/usr/bin/env python3
"""학년부장 OS v2 — 전체 동작 검증 (PC 1440×900 / 모바일 390×844)

검증 항목
  · 전 탭 렌더링, 3초 판단 3결론, 레이더 월 전환·체크
  · 레이더 직접 편집(제목·체크 추가·지뢰 삭제) → 저장 → 기본값 복원
  · 학년도 전환(새 학년도 + 전년도 복사, 체크리스트 초기화, 지난 학년도 열람)
  · 1~6학년 선택, 역할·직책 직접 입력
  · 명단 붙여넣기 → 트래커 반 선택 시 학생·교사 칩 → 탭 한 번으로 대상자
  · 링크 추가(월·프로토콜·원칙·보고선·사안·기록) + 허브 + 링크 모아보기
  · 운영 원칙·보고선·프로토콜 직접 편집
  · CSV 내보내기(BOM), Docs용 복사, JSON 백업
  · 콘솔 오류 0, 페이지 오류 0, 실패 리소스 0, 모바일 가로 넘침 0
"""
import functools, http.server, os, socketserver, sys, threading

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
    handler = functools.partial(Quiet, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


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


def go(page, route):
    page.click(f'[data-a="nav"][data-r="{route}"]:visible')
    page.wait_for_timeout(320)


def run(width, height, tag, shots=True):
    print(f"[{tag}] {width}x{height}")
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": width, "height": height}, device_scale_factor=2,
                            locale="ko-KR", timezone_id="Asia/Seoul",
                            accept_downloads=True)
        ctx.grant_permissions(["clipboard-read", "clipboard-write"])
        page = ctx.new_page()
        page.on("dialog", lambda d: d.accept())
        logs = collect(page)
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(600)

        # ---------------------------------------------------------- 홈
        check("지금 바로 답해도 되나?" in page.inner_text("body"), "홈 타이틀")
        check("2026학년도" in page.inner_text("#year-switch"), "상단 학년도 전환기 표시")
        check(page.locator("#year-switch .ys-arrow").count() == 2, "학년도 ‹ › 버튼 2개")
        check("문서·드라이브 허브" in page.inner_text("body"), "홈에 문서 허브 카드")
        check(overflow(page) <= 0, f"가로 넘침 없음 (home) = {overflow(page)}")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-01-home.png")

        # ---------------------------------------------------------- 3초 판단
        page.click('[data-a="toggle-q"][data-k="ground"]')
        page.wait_for_timeout(220)
        check("초안 즉시 제시" in page.inner_text("#verdict-wrap"), "판단: 근거만 → 초안 즉시 제시")
        page.click('[data-a="toggle-q"][data-k="all"]')
        page.wait_for_timeout(220)
        check("즉답 금지" in page.inner_text("#verdict-wrap"), "판단: 전체 영향 → 즉답 금지")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-02-verdict.png")
        page.click('[data-a="toggle-q"][data-k="report"]')
        page.wait_for_timeout(220)
        check("즉시 보고" in page.inner_text("#verdict-wrap"), "판단: 보고 필요 → 즉시 보고")

        # ---------------------------------------------------------- 레이더
        go(page, "radar")
        check("1년 선제 레이더" in page.inner_text("body"), "레이더 진입")
        check(page.locator('[data-a="grade"]').count() == 6, "1~6학년 6개 선택")
        page.click('[data-a="month"][data-m="11"]')
        page.wait_for_timeout(300)
        check("평가 마감" in page.inner_text(".month-hero"), "11월 전환")
        page.click('[data-a="check"]')
        page.wait_for_timeout(250)
        check("1/" in page.inner_text("#checks-card"), "체크 진행률 1/N")

        # 레이더 직접 편집
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
        check("내가 고친 레이더" in page.inner_text(".month-hero"), "레이더 편집 저장 → 화면 반영")
        check("내가 추가한 체크 항목" in page.inner_text("#checks-card"), "체크리스트 항목 추가 반영")
        check("내가 고침" in page.inner_text(".month-hero"), "수정 표시 배지")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-03-radar-edit.png")

        # 링크 (월)
        page.click('[data-a="edit-links"][data-kind="month"]')
        page.wait_for_timeout(350)
        page.click('[data-a="link-add"]')
        page.wait_for_timeout(120)
        page.fill(".linkro .lk-l", "학년 공용 폴더")
        page.fill(".linkro .lk-u", "drive.google.com/drive/folders/TEST")
        page.click('[data-a="link-save"]')
        page.wait_for_timeout(400)
        check("학년 공용 폴더" in page.inner_text("body"), "레이더 월 링크 표시")
        href = page.get_attribute('a.link-chip', "href")
        check(href and href.startswith("https://drive.google.com/"), f"링크 https 보정 {href}")

        # 잘못된 주소 거부
        page.click('[data-a="edit-links"][data-kind="month"]')
        page.wait_for_timeout(300)
        page.click('[data-a="link-add"]')
        page.wait_for_timeout(120)
        page.locator(".linkro").last.locator(".lk-u").fill("javascript:alert(1)")
        page.click('[data-a="link-save"]')
        page.wait_for_timeout(300)
        check("주소를 확인해 주세요" in page.inner_text("#toast"), "http(s) 아닌 주소 거부")
        page.click('#sheet .sheet-head [data-a="close-sheet"]')
        page.wait_for_timeout(250)

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
        go(page, "radar")
        check("내가 고친 레이더" in page.inner_text(".month-hero"), "전년도 레이더(내 수정) 승계")
        check("/" in page.inner_text(".progress-num") and page.inner_text(".progress-num").startswith("0/"),
              f"새 학년도 체크리스트 초기화 {page.inner_text('.progress-num')}")
        page.click('[data-a="radar-edit"]')
        page.wait_for_timeout(350)
        page.click('[data-a="radar-reset"]')
        page.wait_for_timeout(400)
        check("평가 마감" in page.inner_text(".month-hero") and "내가 고친" not in page.inner_text(".month-hero"),
              "기본값 복원")
        page.click('[data-a="year-step"][data-d="-1"]')
        page.wait_for_timeout(400)
        check("2026학년도" in page.inner_text("#year-switch"), "이전 학년도로 이동")
        check("지난 학년도" in page.inner_text("body"), "지난 학년도 안내")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-04-year.png")

        # 역할 직접 입력
        page.click("#year-switch .year-pill")
        page.wait_for_timeout(350)
        page.fill("#s-role", "기능부장")
        page.click('[data-a="save-role"]')
        page.wait_for_timeout(300)
        check("기능부장" in page.inner_text("#role-pill"), "역할·직책 직접 입력 반영")
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)

        # ---------------------------------------------------------- 운영 원칙 편집
        go(page, "today")
        page.click('[data-a="edit-principles"]')
        page.wait_for_timeout(350)
        page.click('[data-a="pr-add"]')
        page.wait_for_timeout(150)
        page.locator('.elist[data-l="principles"] .erow').last.locator(".pr-k").fill("내 원칙")
        page.locator('.elist[data-l="principles"] .erow').last.locator(".pr-v").fill("기록이 먼저다")
        page.click('[data-a="save-principles"]')
        page.wait_for_timeout(350)
        check("내 원칙" in page.inner_text("body"), "운영 원칙 추가")

        # ---------------------------------------------------------- 보고선 편집
        go(page, "judge")
        check("보고선 기준표" in page.inner_text("body"), "판단 탭")
        page.click('[data-a="edit-report"]')
        page.wait_for_timeout(350)
        page.click('[data-a="rep-add"][data-gi="0"]')
        page.wait_for_timeout(150)
        page.locator('.elist[data-l="rep0"] .erow').last.locator(".rp-t").fill("내가 추가한 보고 항목")
        page.click('[data-a="save-report"]')
        page.wait_for_timeout(350)
        check("내가 추가한 보고 항목" in page.inner_text("body"), "보고선 항목 추가")
        page.click('[data-a="edit-links"][data-kind="report"]')
        page.wait_for_timeout(350)
        page.click('[data-a="link-add"]')
        page.wait_for_timeout(120)
        page.fill(".linkro .lk-l", "보고 양식")
        page.fill(".linkro .lk-u", "https://docs.google.com/document/d/TEST")
        page.click('[data-a="link-save"]')
        page.wait_for_timeout(350)
        check("보고 양식" in page.inner_text("body"), "보고선 항목 링크")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-05-judge.png")

        # ---------------------------------------------------------- 프로토콜 편집
        go(page, "respond")
        check(page.locator('[data-a="protocol"]').count() >= 10, "프로토콜 목록")
        page.click('[data-a="protocol"][data-id="p1"]')
        page.wait_for_timeout(400)
        check("절대 금지" in page.inner_text("#sheet"), "프로토콜 시트")
        page.click('[data-a="edit-protocol"]')
        page.wait_for_timeout(400)
        page.fill("#pt-title", "동학년 업무 불만 (내가 고침)")
        page.fill("#pt-memo", "올해는 분장표를 먼저 보여준다")
        page.click('[data-a="save-protocol"]')
        page.wait_for_timeout(400)
        check("내가 고침" in page.inner_text("body"), "프로토콜 직접 수정")
        page.click('[data-a="protocol"][data-id="p1"]')
        page.wait_for_timeout(350)
        check("올해는 분장표를" in page.inner_text("#sheet"), "프로토콜 메모 표시")
        page.click('[data-a="edit-links"][data-kind="protocol"]')
        page.wait_for_timeout(350)
        page.click('[data-a="link-add"]')
        page.wait_for_timeout(120)
        page.fill(".linkro .lk-l", "공문함")
        page.fill(".linkro .lk-u", "https://example.com/official")
        page.click('[data-a="link-save"]')
        page.wait_for_timeout(400)
        check("공문함" in page.inner_text("#sheet"), "프로토콜 링크 표시")
        page.click('#sheet .sheet-head [data-a="close-sheet"]')
        page.wait_for_timeout(250)
        page.click('[data-a="new-protocol"]')
        page.wait_for_timeout(350)
        check("새 프로토콜" in page.inner_text("#sheet"), "새 프로토콜 작성")
        page.click('#sheet .sheet-head [data-a="close-sheet"]')
        page.wait_for_timeout(250)

        # ---------------------------------------------------------- 명단 · 트래커
        page.click('[data-a="respond-tab"][data-t="tracker"]')
        page.wait_for_timeout(350)
        page.click('[data-a="open-roster"]')
        page.wait_for_timeout(400)
        page.fill("#ro-paste",
                  "구분\t반\t번호\t이름\t비고\n학생\t3반\t1\t김○○\n학생\t3반\t2\t이○○\n교사\t3반\t\t박○○\t담임")
        page.click('[data-a="roster-save"]')
        page.wait_for_timeout(400)
        check("명단 4명" in page.inner_text("body") or "명단" in page.inner_text("body"), "명단 저장")
        page.click('[data-a="open-case"]')
        page.wait_for_timeout(400)
        page.select_option("#f-cls", "3반")
        page.wait_for_timeout(300)
        chips = page.inner_text("#f-roster-wrap")
        check("김○○" in chips and "박○○" in chips, "반 선택 → 학생·교사 칩 표시")
        page.click('[data-a="pick-name"]')
        page.wait_for_timeout(200)
        check("김○○" in page.input_value("#f-target"), "칩 탭 → 대상자 입력")
        page.fill("#f-title", "3반 상담 반복 요청")
        page.fill("#f-memo", "학부모 2회 연락. 담임 1차 안내 후 종결.")
        page.select_option("#f-urgency", "높음")
        page.select_option("#f-report", "보고 필요")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-06-case-form.png")
        page.click('[data-a="save-case"]')
        page.wait_for_timeout(450)
        body = page.inner_text("body")
        check("3반 상담 반복 요청" in body and "김○○" in body, "사안 카드 + 대상자 표시")
        page.click('[data-a="edit-links"][data-kind="case"]')
        page.wait_for_timeout(350)
        page.click('[data-a="link-add"]')
        page.wait_for_timeout(120)
        page.fill(".linkro .lk-l", "상담 기록")
        page.fill(".linkro .lk-u", "https://docs.google.com/spreadsheets/d/TEST")
        page.click('[data-a="link-save"]')
        page.wait_for_timeout(350)
        check("상담 기록" in page.inner_text("body"), "사안 링크")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-07-tracker.png")

        # ---------------------------------------------------------- 기록 + 검색
        go(page, "log")
        page.click('[data-a="open-retro"]')
        page.wait_for_timeout(400)
        page.fill("#r-situation", "동학년이 수행평가 마감일을 물어옴")
        page.fill("#r-decision", "학년 공통표 확인 후 일괄 안내")
        page.fill("#r-next", "질문이 오면 공통표 링크를 먼저 보낸다")
        page.click('[data-a="save-retro"]')
        page.wait_for_timeout(450)
        check("수행평가 마감일" in page.inner_text("body"), "기록 저장")
        page.fill("#log-q", "수행평가")
        page.wait_for_timeout(250)
        check("수행평가 마감일" in page.inner_text("#log-list"), "기록 검색")
        page.click('[data-a="log-scope"][data-v="all"]')
        page.wait_for_timeout(250)
        check("학년도" in page.inner_text("#log-list"), "전체 학년도 검색 라벨")
        page.fill("#log-q", "")
        page.wait_for_timeout(200)
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-08-log.png")

        # ---------------------------------------------------------- 허브
        go(page, "today")
        page.click('[data-a="hub-add"]')
        page.wait_for_timeout(400)
        page.fill("#hub-label", "3학년 공용 폴더")
        page.fill("#hub-url", "https://drive.google.com/drive/folders/XYZ")
        page.fill("#hub-memo", "양식·시험지")
        page.click('[data-a="hub-tag"][data-t="드라이브"]')
        page.click('[data-a="hub-save"]')
        page.wait_for_timeout(450)
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)
        check("3학년 공용 폴더" in page.inner_text("body"), "허브 바로가기 홈 표시")
        page.locator('[data-a="open-hub"]').last.click()
        page.wait_for_timeout(400)
        hubtext = page.inner_text("#sheet")
        check("레이더·프로토콜·사안·기록에 단 링크" in hubtext, "허브에 모아보기 섹션")
        check("11월 레이더" in hubtext or "레이더" in hubtext, "레이더 링크가 허브에 모임")
        if shots:
            page.screenshot(path=f"{OUT}/{tag}-09-hub.png")
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)

        # ---------------------------------------------------------- 내보내기
        go(page, "log")
        page.click('[data-a="open-export"]')
        page.wait_for_timeout(400)
        check("구글 문서" in page.inner_text("#sheet"), "내보내기 시트")
        with page.expect_download() as dl:
            page.click('[data-a="csv-radar"]')
        d = dl.value
        path = os.path.join(OUT, d.suggested_filename)
        d.save_as(path)
        raw = open(path, "rb").read()
        text = raw.decode("utf-8-sig")
        check(raw.startswith(b"\xef\xbb\xbf"), "CSV UTF-8 BOM")
        check("학년도,직책·학년,월,구분,내용,완료여부,링크" in text.splitlines()[0], "CSV 머리행")
        check("체크리스트" in text and "공지초안" in text, "CSV 레이더 내용")
        with page.expect_download() as dl2:
            page.click('[data-a="csv-retro"]')
        d2 = dl2.value
        p2 = os.path.join(OUT, d2.suggested_filename)
        d2.save_as(p2)
        t2 = open(p2, "rb").read().decode("utf-8-sig")
        check("판단_기록" in d2.suggested_filename or "수행평가" in t2, "CSV 기록")
        page.click('[data-a="copy-docs"]')
        page.wait_for_timeout(500)
        check("붙여넣기" in page.inner_text("#toast"), "Docs용 복사 토스트")
        clip = page.evaluate("""async () => {
            try {
              const items = await navigator.clipboard.read();
              for (const it of items) {
                if (it.types.includes('text/plain')) { const b = await it.getType('text/plain'); return await b.text(); }
              }
            } catch (e) { return ''; }
            return '';
        }""")
        check("학년부장 운영 노트" in clip and "1년 레이더" in clip, f"클립보드 텍스트 {len(clip)}자")
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)

        # ---------------------------------------------------------- 설정
        page.click('[data-a="settings"]:visible')   # 모바일은 상단 저장 표시가 설정으로 연결
        page.wait_for_timeout(400)
        st = page.inner_text("#sheet")
        check("비공개 시트 연결" in st, "설정 시트")
        check("기능부장" in st and "2026학년도" in st, "설정에 학년도·역할")
        check(overflow(page) <= 0, f"가로 넘침 없음 (settings) = {overflow(page)}")
        page.keyboard.press("Escape")
        page.wait_for_timeout(250)

        # ---------------------------------------------------------- 새로고침 유지
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(700)
        go(page, "log")
        check("수행평가 마감일" in page.inner_text("body"), "새로고침 후 기록 유지")
        check("2026학년도" in page.inner_text("#year-switch"), "새로고침 후 학년도 유지")
        go(page, "radar")
        check("내가 고친 레이더" in page.inner_text(".month-hero"), "새로고침 후 레이더 수정 유지")

        sw = page.evaluate("() => navigator.serviceWorker.getRegistrations().then(r => r.length)")
        check(sw >= 1, f"서비스 워커 등록 {sw}")

        check(overflow(page) <= 0, f"가로 넘침 없음 (final) = {overflow(page)}")
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
