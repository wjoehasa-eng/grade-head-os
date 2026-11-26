#!/usr/bin/env python3
"""apps-script/Code.gs 로직 검증 — Apps Script 서비스를 브라우저 안에서 흉내 냅니다.

확인하는 것
  · ping / save / load / keys 기본 동작
  · rev 충돌 감지와 conflict 응답
  · 45,000자 초과 문서의 칸 분할 저장·복원
  · 저장 직전 내용의 prev 백업
"""
import functools, http.server, json, os, socketserver, sys, threading

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8137
BASE = f"http://127.0.0.1:{PORT}/"
fails = []

STUB = r"""
(() => {
  // ---- 아주 작은 스프레드시트 모형
  class Sheet {
    constructor(name) { this.name = name; this.grid = []; this.frozen = 0; }
    getName() { return this.name; }
    setName(n) { this.name = n; }
    setFrozenRows(n) { this.frozen = n; }
    _row(r) { while (this.grid.length < r) this.grid.push([]); return this.grid[r - 1]; }
    getLastRow() {
      let last = 0;
      this.grid.forEach((row, i) => { if (row.some(v => v !== '' && v !== null && v !== undefined)) last = i + 1; });
      return last;
    }
    getLastColumn() {
      let last = 0;
      this.grid.forEach(row => {
        row.forEach((v, i) => { if (v !== '' && v !== null && v !== undefined) last = Math.max(last, i + 1); });
      });
      return last;
    }
    getRange(row, col, nrows = 1, ncols = 1) {
      const sh = this;
      if (typeof row === 'string') {
        const m = row.match(/^([A-Z]+)(\d+)$/);
        const colIdx = m[1].split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
        row = parseInt(m[2], 10); col = colIdx;
      }
      return {
        setValues(vals) {
          vals.forEach((rv, ri) => {
            const target = sh._row(row + ri);
            rv.forEach((v, ci) => { target[col - 1 + ci] = v; });
          });
          return this;
        },
        getValues() {
          const out = [];
          for (let r = 0; r < nrows; r++) {
            const src = sh.grid[row - 1 + r] || [];
            const line = [];
            for (let c = 0; c < ncols; c++) {
              const v = src[col - 1 + c];
              line.push(v === undefined ? '' : v);
            }
            out.push(line);
          }
          return out;
        },
        clearContent() {
          for (let r = 0; r < nrows; r++) {
            const target = sh._row(row + r);
            for (let c = 0; c < ncols; c++) target[col - 1 + c] = '';
          }
          return this;
        },
        setValue(v) { sh._row(row)[col - 1] = v; return this; }
      };
    }
    clear() { this.grid = []; return this; }
    appendRow(vals) {
      this._row(this.grid.length + 1);
      const target = this.grid[this.grid.length - 1];
      vals.forEach((v, i) => { target[i] = v; });
    }
    deleteRows(start, n) { this.grid.splice(start - 1, n); }
  }

  class Spreadsheet {
    constructor(name) {
      this.name = name;
      this.tz = 'Etc/GMT';
      this.sheets = [new Sheet('Sheet1')];
    }
    getName() { return this.name; }
    getId() { return 'FAKE_SHEET_ID'; }
    getSheets() { return this.sheets; }
    getSheetByName(n) { return this.sheets.find(s => s.getName() === n) || null; }
    insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
    getSpreadsheetTimeZone() { return this.tz; }
    setSpreadsheetTimeZone(tz) { this.tz = tz; }
  }

  window.__ss = new Spreadsheet('[비공개] 학년부장 운영 시스템');

  window.PropertiesService = {
    getScriptProperties: () => {
      const store = window.__props = window.__props || {};
      return { getProperty: k => store[k] || null, setProperty: (k, v) => { store[k] = v; } };
    }
  };
  window.DriveApp = {
    getFilesByName: (name) => {
      let used = false;
      return {
        hasNext: () => !used,
        next: () => { used = true; return { isTrashed: () => false, getId: () => 'FAKE_SHEET_ID' }; }
      };
    }
  };
  window.SpreadsheetApp = {
    openById: () => window.__ss,
    create: (name) => { window.__ss = new Spreadsheet(name); return window.__ss; }
  };
  window.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  window.ContentService = {
    MimeType: { JSON: 'json', JAVASCRIPT: 'js' },
    createTextOutput: (text) => ({
      text, mime: 'json',
      setMimeType(m) { this.mime = m; return this; }
    })
  };
  window.MimeType = { PLAIN_TEXT: 'text/plain' };
})();
"""


def check(c, m):
    print(("  ok   " if c else "  FAIL ") + m)
    if not c:
        fails.append(m)


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    httpd = serve()
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page()
            pg.goto(BASE + "index.html", wait_until="domcontentloaded")
            pg.add_script_tag(content=STUB)
            pg.add_script_tag(path=os.path.join(ROOT, "apps-script", "Code.gs"))

            call = lambda js: pg.evaluate(js)

            def get(params):
                return json.loads(pg.evaluate("(p) => doGet({parameter: p}).text", params))

            def post(body):
                return json.loads(pg.evaluate("(b) => doPost({postData:{contents: JSON.stringify(b)}}).text", body))

            # ping
            ping = get({"action": "ping"})
            check(ping.get("ok") and ping.get("app") == "grade-head-os", f"ping {ping.get('app')} v{ping.get('backend')}")
            tabs = ping["sheet"]["tabs"]
            check(set(["docs", "prev", "log", "안내", "명단", "레이더_정리", "사안_트래커", "판단_기록"]).issubset(set(tabs)),
                  f"탭 생성 {tabs}")

            # save (small) + 사람용 미러 표
            doc = {"v": 2, "year": "2026", "years": ["2026"], "byYear": {"2026": {
                "grade": "3", "role": "3학년 부장", "checks": {"3-11-0": {"v": 1, "at": 1}},
                "tracker": [], "retro": [{"id": "a", "situation": "테스트"}], "radar": {}, "roster": []}}}
            mirror = [
                {"tab": "레이더_정리", "header": ["학년도", "직책·학년", "월", "구분", "내용", "완료여부", "링크"],
                 "rows": [["2026", "3학년 부장 / 3학년", "11월", "체크리스트", "평가 마감 확인", "O", ""]]},
                {"tab": "사안_트래커", "header": ["학년도", "기록시각", "반", "대상", "유형", "긴급도", "상태", "보고여부", "내용", "후속조치", "링크"],
                 "rows": [["2026", "2026-11-26", "3반", "김○○", "민원", "보통", "진행", "해당 없음", "상담 요청", "재통화", ""]]},
                {"tab": "판단_기록", "header": ["학년도", "날짜", "상황", "판단", "결과", "다음엔", "태그", "링크"],
                 "rows": [["2026", "2026-11-26", "질문", "확인 후 안내", "", "", "판단", ""]]}
            ]
            body = {"action": "save", "key": "state", "data": doc, "mirror": mirror}
            r1 = post(body)
            check(r1.get("ok") and r1.get("rev"), f"첫 저장 rev={r1.get('rev')}")
            rev1 = r1["rev"]

            load = get({"action": "load", "key": "state"})
            check(load.get("data") == doc, "저장한 문서 그대로 복원")
            check(load.get("rev") == rev1, "rev 일치")

            # conflict
            body2 = {"action": "save", "key": "state", "baseRev": "stale-rev", "data": {"v": 1, "retro": []}}
            r2 = post(body2)
            check(r2.get("ok") is False and r2.get("conflict") is True, "오래된 baseRev → conflict")
            check(r2.get("data") == doc, "conflict 응답에 최신 데이터 포함")

            # large doc → chunking
            big_text = "가" * 60000
            big = {"v": 1, "retro": [{"id": "big", "situation": big_text}]}
            body3 = {"action": "save", "key": "state", "baseRev": rev1, "data": big}
            r3 = post(body3)
            check(r3.get("ok") is True, f"6만자 문서 저장 bytes={r3.get('bytes')}")
            meta = json.loads(call("""() => {
                const sh = __ss.getSheetByName('docs');
                const row = 2;
                const head = sh.getRange(row,1,1,4).getValues()[0];
                return JSON.stringify({chunks: head[3], cols: sh.getLastColumn()});
            }"""))
            check(int(meta["chunks"]) >= 2, f"칸 분할 저장 chunks={meta['chunks']}")

            load_big = get({"action": "load", "key": "state"})
            check(load_big["data"] == big, "분할 저장한 6만자 문서 복원 일치")

            # prev 백업
            prev = json.loads(call("""() => {
                const sh = __ss.getSheetByName('prev');
                return JSON.stringify({lastRow: sh.getLastRow(), key: sh.getRange(2,1).getValues()[0][0]});
            }"""))
            check(prev["lastRow"] >= 2 and prev["key"] == "state", f"prev 백업 {prev}")

            # 미러 표가 실제로 써졌는지
            mr = json.loads(call("""() => {
                const out = {};
                ['레이더_정리','사안_트래커','판단_기록'].forEach(n => {
                  const sh = __ss.getSheetByName(n);
                  out[n] = { lastRow: sh.getLastRow(), head: sh.getRange(1,1,1,1).getValues()[0][0],
                             first: sh.getRange(2,1,1,3).getValues()[0] };
                });
                return JSON.stringify(out);
            }"""))
            check(mr["레이더_정리"]["lastRow"] == 2 and mr["레이더_정리"]["head"] == "학년도", f"레이더_정리 기록 {mr['레이더_정리']}")
            check(mr["사안_트래커"]["lastRow"] == 2 and "3반" in mr["사안_트래커"]["first"], f"사안_트래커 기록 {mr['사안_트래커']['first']}")
            check(mr["판단_기록"]["lastRow"] == 2, "판단_기록 기록")

            # 명단 탭 읽기
            call("""() => {
                const sh = __ss.getSheetByName('명단');
                sh.getRange(1,1,1,5).setValues([['구분','반','번호','이름','비고']]);
                sh.getRange(2,1,3,5).setValues([['학생','3반','1','김○○',''],['학생','3반','2','이○○',''],['교사','3반','','박○○','담임']]);
                return 1;
            }""")
            ros = get({"action": "roster"})
            check(len(ros.get("roster", [])) == 3, f"action=roster {len(ros.get('roster', []))}명")
            check(ros["roster"][2]["kind"] == "교사" and ros["roster"][2]["name"] == "박○○", "교사 행 읽기")
            load_r = get({"action": "load", "key": "state"})
            check(len(load_r.get("roster", [])) == 3, "load 응답에 명단 포함")
            check(mr["레이더_정리"]["head"] == "학년도", "머리행 유지")

            # keys
            keys = get({"action": "keys"})
            check(any(k["key"] == "state" for k in keys.get("keys", [])), "keys 목록")

            # JSONP
            raw = pg.evaluate("() => doGet({parameter:{action:'ping', callback:'cb'}}).text")
            check(raw.startswith("cb(") and raw.rstrip().endswith(");"), "JSONP 콜백 형식")
            b.close()
    finally:
        httpd.shutdown()

    print("\n실패:", len(fails))
    for f in fails:
        print(" -", f)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
