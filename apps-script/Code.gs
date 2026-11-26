/**
 * 학년부장 OS — 범용 저장 백엔드 (Google Apps Script) v1.1.0
 * ================================================================
 * 프론트가 보내는 JSON “문서”를 내 비공개 구글 시트에 그대로 저장합니다.
 * 앱에 필드가 아무리 늘어나도 이 파일을 다시 배포할 일이 없습니다.
 *
 * 시트 구조
 *  · docs 탭 : key | rev | updated_at | chunks | data(칸1) | data(칸2) … 
 *              구글 시트 셀 하나는 5만 자까지만 담을 수 있어서,
 *              JSON을 45,000자 단위로 잘라 옆 칸에 이어 붙입니다(chunks = 칸 수).
 *              보통은 1칸에 다 들어가 people이 읽어도 JSON으로 보입니다.
 *  · prev 탭 : key | updated_at | chunks | data… — 저장 직전 내용 한 벌(한 단계 되돌리기)
 *  · log 탭  : time | key | rev | bytes — 저장 이력(최근 200줄)
 *
 * 준비 (한 번만, 약 3분) — 자세한 그림 설명은 저장소의 SETUP.md
 *  1. https://script.google.com → 새 프로젝트 → 이 파일 내용을 붙여 넣고 저장
 *  2. 배포 → 새 배포 → 유형(⚙) = 웹 앱
 *       · 다음 사용자로 실행: 나
 *       · 액세스 권한: 모든 사용자   ← 폰 브라우저에서 접속하려면 반드시 이 값
 *     → 액세스 승인 → 웹 앱 URL(.../exec) 복사
 *  3. 앱 설정 → 비공개 시트 연결에 주소를 붙여 넣고 [저장]
 *
 * API
 *  GET  ?action=ping                    연결 확인 { ok, app, backend, sheet }
 *  GET  ?action=keys                    저장된 문서 목록
 *  GET  ?action=load&key=state          { ok, key, data, rev, updatedAt }
 *  POST { action:'save', key, baseRev, data }
 *                                       { ok, rev, updatedAt } — rev가 다르면 conflict
 *  ?callback=함수이름                    JSONP 로 감싸서 응답
 *
 * 안전장치
 *  · LockService 로 동시 저장을 잠급니다.
 *  · baseRev 가 현재 rev 와 다르면 conflict 로 돌려주고, 앱이 항목별로 병합해 다시 저장합니다.
 *  · 저장 직전 내용을 prev 탭에 한 벌 남깁니다.
 *  · 문서 하나가 900KB 를 넘으면 거절합니다.
 */

/** 시트 ID를 직접 넣어도 됩니다. 비워 두면 이름으로 찾고, 없으면 만듭니다. */
var SHEET_ID = '';

var SHEET_NAME = '[비공개] 학년부장 운영 시스템';
var APP_NAME = 'grade-head-os';
var BACKEND_VERSION = '1.1.0';
var MAX_CHUNK = 45000;    // 셀당 안전 한도 (구글 시트 한도 50,000자)
var MAX_CHUNKS = 20;      // 최대 900KB
var LOG_KEEP = 200;
var TIMEZONE = 'Asia/Seoul';

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
    try { return SpreadsheetApp.openById(id); } catch (err) { /* 지워졌으면 이름으로 다시 찾습니다 */ }
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
  if (!docs) docs = ss.insertSheet('docs');
  if (docs.getLastRow() === 0) {
    docs.getRange(1, 1, 1, 5).setValues([['key', 'rev', 'updated_at', 'chunks', 'data']]);
    docs.setFrozenRows(1);
  }

  var prev = ss.getSheetByName('prev');
  if (!prev) prev = ss.insertSheet('prev');
  if (prev.getLastRow() === 0) {
    prev.getRange(1, 1, 1, 4).setValues([['key', 'updated_at', 'chunks', 'data']]);
    prev.setFrozenRows(1);
  }

  var log = ss.getSheetByName('log');
  if (!log) log = ss.insertSheet('log');
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, 4).setValues([['time', 'key', 'rev', 'bytes']]);
    log.setFrozenRows(1);
  }

  var first = ss.getSheets()[0];
  if (first && first.getName() === 'Sheet1' && first.getLastRow() === 0) {
    first.setName('안내');
    first.getRange('A1').setValue('학년부장 OS — 비공개 저장소');
    first.getRange('A2').setValue('앱의 기록(트래커·회고·체크)을 문서 단위 JSON으로 보관합니다. 직접 고치지 마세요.');
    first.getRange('A3').setValue('이 시트를 공유하지 마세요. 소유자만 열 수 있어야 합니다.');
  }

  try {
    if (ss.getSpreadsheetTimeZone() === 'Etc/GMT') ss.setSpreadsheetTimeZone(TIMEZONE);
  } catch (err) {}

  return { docs: docs, prev: prev, log: log };
}

function findRow(sheet, key) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var keys = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(key)) return i + 2;
  }
  return -1;
}

/** 한 줄에서 JSON 문자열을 이어 붙여 읽습니다. metaCols = 데이터 앞 칸 수 */
function readRowJson(sheet, row, metaCols) {
  var width = Math.max(sheet.getLastColumn(), metaCols + 1);
  var vals = sheet.getRange(row, 1, 1, width).getValues()[0];
  var chunks = Number(vals[metaCols - 1]) || 1;   // chunks 칸
  if (chunks < 1) chunks = 1;
  var parts = [];
  for (var i = 0; i < chunks; i++) {
    var v = vals[metaCols + i];
    if (v !== '' && v !== null && typeof v !== 'undefined') parts.push(String(v));
  }
  return parts.join('');
}

function writeRowJson(sheet, row, metaValues, json, metaCols) {
  var chunks = [];
  for (var i = 0; i < json.length; i += MAX_CHUNK) chunks.push(json.substr(i, MAX_CHUNK));
  if (chunks.length === 0) chunks.push('');
  if (chunks.length > MAX_CHUNKS) throw new Error('문서가 너무 큽니다(900KB 초과).');

  var meta = metaValues.slice();           // [key, rev|updated, time, ...]
  meta.push(chunks.length);                // chunks 칸
  sheet.getRange(row, 1, 1, metaCols).setValues([meta]);

  // 이전에 쓰던 긴 칸을 지우고 새로 씁니다
  var clearWidth = Math.max(sheet.getLastColumn() - metaCols, chunks.length, 1);
  sheet.getRange(row, metaCols + 1, 1, clearWidth).clearContent();
  sheet.getRange(row, metaCols + 1, 1, chunks.length).setValues([chunks]);
  return chunks.length;
}

/* ------------------------------------------------------------------ 동작 */
function ping() {
  var ss = getSheet();
  ensureTabs(ss);
  return {
    ok: true,
    app: APP_NAME,
    backend: BACKEND_VERSION,
    sheet: { title: ss.getName(), tabs: ss.getSheets().map(function (s) { return s.getName(); }) },
    time: new Date().toISOString()
  };
}

function listKeys() {
  var ss = getSheet();
  var t = ensureTabs(ss);
  var last = t.docs.getLastRow();
  if (last < 2) return { ok: true, keys: [] };
  var rows = t.docs.getRange(2, 1, last - 1, 3).getValues();
  return {
    ok: true,
    keys: rows.filter(function (r) { return r[0]; }).map(function (r) {
      return {
        key: String(r[0]),
        rev: String(r[1] || ''),
        updatedAt: r[2] ? new Date(r[2]).toISOString() : ''
      };
    })
  };
}

function loadDoc(key) {
  key = key || 'state';
  var ss = getSheet();
  var t = ensureTabs(ss);
  var row = findRow(t.docs, key);
  if (row < 0) return { ok: true, key: key, data: null, rev: '', updatedAt: '' };

  var json = readRowJson(t.docs, row, 4);
  var data = null;
  try { data = json ? JSON.parse(json) : null; } catch (err) { data = null; }
  var head = t.docs.getRange(row, 1, 1, 3).getValues()[0];
  return {
    ok: true, key: key, data: data,
    rev: String(head[1] || ''),
    updatedAt: head[2] ? new Date(head[2]).toISOString() : ''
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
  if (json.length > MAX_CHUNK * MAX_CHUNKS) {
    return { ok: false, error: '문서가 너무 큽니다(900KB 초과).' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { ok: false, error: '다른 기기가 저장 중입니다. 잠시 뒤 다시 시도해 주세요.' };
  }

  try {
    var ss = getSheet();
    var t = ensureTabs(ss);
    var row = findRow(t.docs, key);
    var now = new Date();
    var rev = String(now.getTime()) + '-' + Math.floor(Math.random() * 1000);

    if (row > 0) {
      var head = t.docs.getRange(row, 1, 1, 3).getValues()[0];
      var curRev = String(head[1] || '');
      var baseRev = String((body && body.baseRev) || '');
      if (baseRev && curRev && baseRev !== curRev) {
        var curJson = readRowJson(t.docs, row, 4);
        var curData = null;
        try { curData = curJson ? JSON.parse(curJson) : null; } catch (e) {}
        return { ok: false, conflict: true, rev: curRev, data: curData };
      }

      // 직전 내용을 prev 탭에 한 벌 (한 단계 되돌리기)
      try {
        var oldJson = readRowJson(t.docs, row, 4);
        if (oldJson) {
          var prow = findRow(t.prev, key);
          var pmeta = [key, now];
          if (prow > 0) writeRowJson(t.prev, prow, pmeta, oldJson, 3);
          else writeRowJson(t.prev, t.prev.getLastRow() + 1, pmeta, oldJson, 3);
        }
      } catch (e) { /* 백업 실패는 저장을 막지 않습니다 */ }

      writeRowJson(t.docs, row, [key, rev, now], json, 4);
    } else {
      var newRow = t.docs.getLastRow() + 1;
      writeRowJson(t.docs, newRow, [key, rev, now], json, 4);
    }

    // 저장 이력
    t.log.appendRow([now, key, rev, json.length]);
    var logRows = t.log.getLastRow();
    if (logRows > LOG_KEEP + 1) t.log.deleteRows(2, logRows - LOG_KEEP - 1);

    return { ok: true, rev: rev, updatedAt: now.toISOString(), bytes: json.length };
  } finally {
    lock.releaseLock();
  }
}
