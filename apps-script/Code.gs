/**
 * 학년부장 OS — 범용 저장 백엔드 (Google Apps Script)
 * ================================================================
 * 프론트가 보내는 JSON “문서”를 내 비공개 구글 시트에 그대로 저장합니다.
 * 컬럼 구조는 key / json / rev / updated_at 뿐이라, 앱에 필드가 아무리 늘어나도
 * 이 파일을 다시 배포할 일이 없습니다. (문서 단위 통저장 + rev 충돌 감지)
 *
 * 준비 (한 번만, 약 3분)
 *  1. 이 스크립트를 https://script.google.com 에 새 프로젝트로 만들고 이 내용을 붙여 넣습니다.
 *  2. 배포 → 새 배포 → 유형 ⚙ = 웹 앱
 *       · 다음 사용자로 실행: 나
 *       · 액세스 권한: 모든 사용자   ← 폰 브라우저에서 접속하려면 필요
 *     → 권한 허용 → 웹 앱 URL(.../exec) 복사
 *  3. 앱 → 설정 → 비공개 시트 연결에 주소를 붙여 넣고 [저장]
 *
 * 시트
 *  · 이름: [비공개] 학년부장 운영 시스템 (없으면 첫 저장 때 자동 생성)
 *  · docs 탭 : key | json | rev | updated_at | prev   (한 줄 = 문서 하나)
 *  · log 탭  : time | key | rev | bytes               (저장 이력, 최근 200줄 유지)
 *  · 소유자만 열 수 있게 두세요. 공유하지 마세요.
 *
 * API
 *  GET  ?action=ping                         연결 확인
 *  GET  ?action=keys                         저장된 문서 키 목록
 *  GET  ?action=load&key=state               문서 읽기  → { ok, key, data, rev, updatedAt }
 *  POST { action:'save', key:'state', baseRev:'…', data:{…} }
 *                                            문서 저장  → { ok, rev, updatedAt }
 *                                            rev 가 다르면 { ok:false, conflict:true, rev, data }
 *  ?callback=함수명                          JSONP 로 감싸서 응답
 *
 * 안전장치
 *  · 저장 중 LockService 로 동시 저장을 잠급니다.
 *  · baseRev 가 현재 rev 와 다르면 conflict 로 돌려주고, 프론트가 병합 후 다시 저장합니다.
 *  · 저장 직전 내용을 prev 컬럼에 한 벌 남깁니다(한 단계 되돌리기).
 *  · 문서 하나가 4MB 를 넘으면 거절합니다.
 */

/** 시트 ID를 직접 넣어도 됩니다. 비워 두면 이름으로 찾고, 없으면 만듭니다. */
var SHEET_ID = '';

var SHEET_NAME = '[비공개] 학년부장 운영 시스템';
var APP_NAME = 'grade-head-os';
var BACKEND_VERSION = '1.0.0';
var MAX_BYTES = 4 * 1024 * 1024;
var LOG_KEEP = 200;

/* ------------------------------------------------------------------ 진입점 */
function doGet(e) {
  return handle(e, {});
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  return handle(e, body || {});
}

function handle(e, body) {
  var p = (e && e.parameter) || {};
  var action = p.action || body.action || 'ping';
  var out;
  try {
    if (action === 'ping') out = ping();
    else if (action === 'keys') out = listKeys();
    else if (action === 'load') out = loadDoc(p.key || body.key);
    else if (action === 'save') out = saveDoc(body);
    else out = { ok: false, error: '알 수 없는 action: ' + action };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return respond(out, p.callback);
}

function respond(obj, callback) {
  var text = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + text + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ 시트 */
function getSheet() {
  var props = PropertiesService.getScriptProperties();
  var id = SHEET_ID || props.getProperty('SHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (err) { /* 지워졌으면 다시 찾습니다 */ }
  }
  var it = DriveApp.getFilesByName(SHEET_NAME);
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed()) {
      props.setProperty('SHEET_ID', f.getId());
      return SpreadsheetApp.openById(f.getId());
    }
  }
  var fresh = SpreadsheetApp.create(SHEET_NAME);
  props.setProperty('SHEET_ID', fresh.getId());
  return fresh;
}

function ensureTabs(ss) {
  var docs = ss.getSheetByName('docs');
  if (!docs) {
    docs = ss.insertSheet('docs');
  }
  if (docs.getLastRow() === 0) {
    docs.appendRow(['key', 'json', 'rev', 'updated_at', 'prev']);
    docs.setFrozenRows(1);
  }
  var log = ss.getSheetByName('log');
  if (!log) log = ss.insertSheet('log');
  if (log.getLastRow() === 0) {
    log.appendRow(['time', 'key', 'rev', 'bytes']);
    log.setFrozenRows(1);
  }
  // 기본 시트(Sheet1)가 비어 있으면 이름만 바꿔 안내로 씁니다.
  var first = ss.getSheets()[0];
  if (first && first.getName() === 'Sheet1' && first.getLastRow() === 0 && first.getLastColumn() <= 1) {
    first.setName('안내');
    first.getRange('A1').setValue('학년부장 OS — 비공개 저장소');
    first.getRange('A2').setValue('이 시트는 앱의 기록(트래커·회고·체크)을 문서 단위 JSON으로 보관합니다. docs 탭을 직접 고치지 마세요.');
    first.getRange('A3').setValue('시트를 공유하지 마세요. 소유자만 열 수 있어야 합니다.');
  }
  return { docs: docs, log: log };
}

function findRow(docs, key) {
  var last = docs.getLastRow();
  if (last < 2) return -1;
  var keys = docs.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(key)) return i + 2;
  }
  return -1;
}

/* ------------------------------------------------------------------ 동작 */
function ping() {
  var ss = getSheet();
  ensureTabs(ss);
  return {
    ok: true,
    app: APP_NAME,
    backend: BACKEND_VERSION,
    sheet: { title: ss.getName(), id: ss.getId(), tabs: ss.getSheets().map(function (s) { return s.getName(); }) },
    time: new Date().toISOString()
  };
}

function listKeys() {
  var ss = getSheet();
  var t = ensureTabs(ss);
  var last = t.docs.getLastRow();
  if (last < 2) return { ok: true, keys: [] };
  var rows = t.docs.getRange(2, 1, last - 1, 4).getValues();
  return {
    ok: true,
    keys: rows.filter(function (r) { return r[0]; }).map(function (r) {
      return { key: String(r[0]), rev: String(r[2] || ''), updatedAt: r[3] ? new Date(r[3]).toISOString() : '' };
    })
  };
}

function loadDoc(key) {
  key = key || 'state';
  var ss = getSheet();
  var t = ensureTabs(ss);
  var row = findRow(t.docs, key);
  if (row < 0) return { ok: true, key: key, data: null, rev: '', updatedAt: '' };
  var vals = t.docs.getRange(row, 1, 1, 4).getValues()[0];
  var data = null;
  try { data = vals[1] ? JSON.parse(vals[1]) : null; } catch (err) { data = null; }
  return {
    ok: true, key: key, data: data,
    rev: String(vals[2] || ''),
    updatedAt: vals[3] ? new Date(vals[3]).toISOString() : ''
  };
}

function saveDoc(body) {
  var key = String((body && body.key) || 'state');
  if (!/^[a-zA-Z0-9_.가-힣-]{1,40}$/.test(key)) {
    return { ok: false, error: 'key 형식이 올바르지 않습니다.' };
  }
  if (!body || typeof body.data === 'undefined' || body.data === null) {
    return { ok: false, error: '저장할 data 가 없습니다.' };
  }
  var json = JSON.stringify(body.data);
  if (json.length > MAX_BYTES) return { ok: false, error: '문서가 너무 큽니다(4MB 초과).' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: '다른 기기가 저장 중입니다. 잠시 뒤 다시 시도해 주세요.' };

  try {
    var ss = getSheet();
    var t = ensureTabs(ss);
    var row = findRow(t.docs, key);
    var now = new Date();
    var rev = String(now.getTime()) + '-' + Math.floor(Math.random() * 1000);

    if (row > 0) {
      var cur = t.docs.getRange(row, 1, 1, 4).getValues()[0];
      var curRev = String(cur[2] || '');
      var baseRev = String((body && body.baseRev) || '');
      if (baseRev && curRev && baseRev !== curRev) {
        var curData = null;
        try { curData = cur[1] ? JSON.parse(cur[1]) : null; } catch (e) {}
        return { ok: false, conflict: true, rev: curRev, data: curData };
      }
      // 직전 내용 한 벌 보관 (한 단계 되돌리기)
      t.docs.getRange(row, 5).setValue(String(cur[1] || ''));
      t.docs.getRange(row, 2, 1, 3).setValues([[json, rev, now]]);
    } else {
      t.docs.appendRow([key, json, rev, now, '']);
    }

    // 저장 이력
    t.log.appendRow([now, key, rev, json.length]);
    var logRows = t.log.getLastRow();
    if (logRows > LOG_KEEP + 1) {
      t.log.deleteRows(2, logRows - LOG_KEEP - 1);
    }

    return { ok: true, rev: rev, updatedAt: now.toISOString(), bytes: json.length };
  } finally {
    lock.releaseLock();
  }
}
