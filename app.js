/* =========================================================================
   학년부장 OS — app (v2)
   · 학년도(연도) 전환 · 레이더 직접 편집 · 명단(시트) 연동
   ========================================================================= */
(function () {
  'use strict';

  var D = GH.data;
  var LS_KEY = 'grade-head-os.v1';
  var APP_VERSION = '2.0.0';

  /* 학년도는 3월에 시작합니다 (1~2월은 지난 학년도). */
  var NOW = new Date();
  var START_YEAR = String(NOW.getMonth() + 1 >= 3 ? NOW.getFullYear() : NOW.getFullYear() - 1);

  var GRADES = ['1', '2', '3', '4', '5', '6'];
  var CLASSES = ['1반', '2반', '3반', '4반', '5반', '6반', '7반', '8반', '9반', '10반', '11반', '12반', '학년 공통'];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function defaultRole(g) { return String(g || '3') + '학년 부장'; }

  function blankYear(grade, role) {
    grade = String(grade || '3');
    return {
      grade: grade,
      role: role || defaultRole(grade),
      checks: {}, tracker: [], retro: [], radar: {}, roster: [],
      updatedAt: 0
    };
  }

  /* ------------------------------------------------------------- 상태 */
  var defaults = { v: 2, year: START_YEAR, years: [START_YEAR], byYear: {} };
  defaults.byYear[START_YEAR] = blankYear('3');

  var db = { state: clone(defaults), rev: '', url: '' };
  var Q = { ground: 0, all: 0, report: 0 };
  var SHAPE = { affect: 0, fair: 0, approval: 0, flip: 0 };
  var route = 'today';
  var radarMonth = NOW.getMonth() + 1;
  var respondTab = 'protocol';
  var trackerFilter = { status: 'all', reportOnly: false, type: 'all' };
  var logScope = 'current';
  var logQuery = '';
  var syncing = false;
  var saveTimer = null;

  var MONTH_TAG = { 2: '준비', 3: '학기초', 4: '현장', 5: '행사', 6: '평가', 7: '마무리', 8: '세팅', 9: '2학기', 10: '나눔', 11: '마감', 12: '인계', 1: '정리' };

  /* ------------------------------------------------------------- 유틸 */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var p = iso.split('-');
    if (p.length < 3) return iso;
    return p[0].slice(2) + '.' + p[1] + '.' + p[2];
  }
  function weekdayKor(d) { return ['일', '월', '화', '수', '목', '금', ''][d.getDay()]; }
  function uniq(arr) {
    var seen = {}, out = [];
    arr.forEach(function (v) { if (!seen[v]) { seen[v] = 1; out.push(v); } });
    return out;
  }

  function toast(msg) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.classList.remove('show'); }, 2100);
  }

  function copyText(text) {
    var done = function () { toast('복사했어요'); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else { fallback(); }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('복사가 안 됐어요. 길게 눌러 복사해 주세요.'); }
      document.body.removeChild(ta);
    }
  }

  /* ------------------------------------------------------------- 학년도 */
  function normalize(st) {
    if (!st || typeof st !== 'object') st = clone(defaults);
    if (st.v !== 2 || !st.byYear) {
      // v1 → v2 이전: 기존 기록을 올해 학년도로 옮깁니다
      var yv = blankYear(st.grade || '3');
      yv.checks = st.checks || {};
      yv.tracker = st.tracker || [];
      yv.retro = st.retro || [];
      st = { v: 2, year: START_YEAR, years: [START_YEAR], byYear: {} };
      st.byYear[START_YEAR] = yv;
    }
    st.v = 2;
    if (!Array.isArray(st.years) || !st.years.length) st.years = [String(st.year || START_YEAR)];
    st.years = uniq(st.years.map(String)).sort();
    if (!st.byYear) st.byYear = {};
    st.years.forEach(function (y) { st.byYear[y] = fillYear(st.byYear[y], y); });
    if (!st.byYear[st.year]) st.year = st.years[st.years.length - 1];
    return st;
  }

  function fillYear(yv, y) {
    yv = yv || {};
    var g = String(yv.grade || '3');
    return {
      grade: GRADES.indexOf(g) >= 0 ? g : '3',
      role: yv.role || defaultRole(g),
      checks: yv.checks || {},
      tracker: yv.tracker || [],
      retro: yv.retro || [],
      radar: yv.radar || {},
      roster: yv.roster || [],
      updatedAt: yv.updatedAt || 0
    };
  }

  function Y() {
    var st = db.state;
    if (!st.byYear[st.year]) {
      st.byYear[st.year] = blankYear('3');
      if (st.years.indexOf(st.year) < 0) { st.years.push(st.year); st.years.sort(); }
    }
    return st.byYear[st.year];
  }
  function Yof(y) { return db.state.byYear[y] || fillYear(null, y); }
  function latestYear() { return db.state.years[db.state.years.length - 1]; }
  function isPast() { return db.state.year !== latestYear(); }
  function yearLabel() { return db.state.year + '학년도'; }
  function roleLabel() { return Y().role || defaultRole(Y().grade); }

  /* ------------------------------------------------------------- 레이더 */
  var _defMonth = {};
  function defaultMonth(m) {
    if (_defMonth[m]) return _defMonth[m];
    var src = D.radar[m] || {};
    var dm = {
      title: src.title || (m + '월'),
      lead: src.lead || '',
      now: (src.now || []).slice(),
      notice: src.notice || '',
      checks: (src.checks || []).map(function (t, i) { return { id: m + '-' + i, t: t }; }),
      traps: (src.traps || []).map(function (t) { return { t: t.t, d: t.d }; }),
      me: (src.me || []).slice(),
      points: { '1': '', '2': '', '3': src.g3 || '', '4': src.g4 || '', '5': '', '6': '' },
      memo: '', links: [], editedAt: 0
    };
    _defMonth[m] = dm;
    return dm;
  }

  function radarOf(m, y) {
    var yv = y ? Yof(y) : Y();
    var ov = yv.radar && yv.radar[m];
    var base = defaultMonth(m);
    if (!ov) return base;
    return {
      title: ov.title != null ? ov.title : base.title,
      lead: ov.lead != null ? ov.lead : base.lead,
      now: Array.isArray(ov.now) ? ov.now : base.now,
      notice: ov.notice != null ? ov.notice : base.notice,
      checks: Array.isArray(ov.checks) ? ov.checks : base.checks,
      traps: Array.isArray(ov.traps) ? ov.traps : base.traps,
      me: Array.isArray(ov.me) ? ov.me : base.me,
      points: Object.assign({}, base.points, ov.points || {}),
      memo: ov.memo || '',
      links: Array.isArray(ov.links) ? ov.links : [],
      editedAt: ov.editedAt || 0
    };
  }
  function isEdited(m, y) { var yv = y ? Yof(y) : Y(); return !!(yv.radar && yv.radar[m]); }
  function pointOf(d, g) { return (d.points && d.points[String(g)]) || ''; }

  function checkKey(g, id) { return String(g) + '-' + id; }
  function checkOn(g, id) { var c = Y().checks[checkKey(g, id)]; return !!(c && c.v); }
  function checkOnY(y, g, id) { var c = (Yof(y).checks || {})[checkKey(g, id)]; return !!(c && c.v); }

  /* --------------------------------------------- 열린 구조 (원칙·프로토콜·보고선) */
  function principles() { return Y().principles || D.principles; }
  function protocolsData() { return Y().protocols || D.protocols; }
  function reportLinesData() { return Y().reportLines || D.judge.reportLines; }

  function ensurePrinciples() {
    if (!Y().principles) {
      Y().principles = clone(D.principles).map(function (p, i) { p.id = 'pr' + i; p.links = p.links || []; return p; });
    }
    return Y().principles;
  }
  function ensureProtocols() {
    if (!Y().protocols) {
      Y().protocols = clone(D.protocols).map(function (p) { p.links = p.links || []; p.memo = p.memo || ''; return p; });
    }
    return Y().protocols;
  }
  function ensureReportLines() {
    if (!Y().reportLines) {
      Y().reportLines = clone(D.judge.reportLines).map(function (g, gi) {
        g.id = 'rg' + gi;
        (g.items || []).forEach(function (it, ii) { it.id = g.id + '-' + ii; it.links = it.links || []; });
        return g;
      });
    }
    return Y().reportLines;
  }

  /* ------------------------------------------------------------- 링크 */
  function safeUrl(u) {
    var s = String(u == null ? '' : u).trim();
    if (!s) return '';
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
      if (/^[\w.-]+\.[a-zA-Z]{2,}(\/|$|\?|#)/.test(s)) s = 'https://' + s;
      else return '';
    }
    try {
      var x = new URL(s);
      if (x.protocol !== 'http:' && x.protocol !== 'https:') return '';
      return x.href;
    } catch (e) { return ''; }
  }

  function linkText(links) {
    return (links || []).map(function (l) { return (l.l ? l.l + ' ' : '') + (l.u || ''); }).join(' | ');
  }

  function linkChipsHTML(links, kind, k1, k2) {
    var arr = (links || []).filter(function (l) { return l && safeUrl(l.u); });
    var html = arr.map(function (l) {
      return '<a class="link-chip" href="' + esc(safeUrl(l.u)) + '" target="_blank" rel="noopener noreferrer">' +
        '🔗 ' + esc(l.l || safeUrl(l.u)) + '</a>';
    }).join('');
    if (kind) {
      html += '<button class="link-chip add" data-a="edit-links" data-kind="' + kind + '" data-k1="' + esc(k1 == null ? '' : k1) + '" data-k2="' + esc(k2 == null ? '' : k2) + '">' +
        (arr.length ? '+ 링크' : '🔗 링크 추가') + '</button>';
    }
    return html ? '<div class="chips link-chips">' + html + '</div>' : '';
  }

  function linkOwner(kind, k1, k2) {
    var yv = Y();
    if (kind === 'month') {
      var m = parseInt(k1, 10);
      if (!yv.radar[m]) yv.radar[m] = clone(radarOf(m));
      yv.radar[m].links = yv.radar[m].links || [];
      return { obj: yv.radar[m], title: m + '월 레이더 · ' + esc(radarOf(m).title), done: function () { closeSheet(); render(); } };
    }
    if (kind === 'protocol') {
      var p = ensureProtocols().filter(function (x) { return x.id === k1; })[0];
      if (p) p.links = p.links || [];
      return p ? { obj: p, title: esc(p.title), done: function () { render(); protocolSheet(p.id); } } : null;
    }
    if (kind === 'case') {
      var c = yv.tracker.filter(function (x) { return x.id === k1; })[0];
      if (c) c.links = c.links || [];
      return c ? { obj: c, title: esc(c.title || '사안'), done: function () { closeSheet(); render(); } } : null;
    }
    if (kind === 'retro') {
      var ry = k2 || db.state.year;
      var r = (Yof(ry).retro || []).filter(function (x) { return x.id === k1; })[0];
      if (r) r.links = r.links || [];
      return r ? { obj: r, title: (r.situation || '기록') + ' · ' + esc(ry) + '학년도', done: function () { closeSheet(); render(); } } : null;
    }
    if (kind === 'principle') {
      var pr = ensurePrinciples().filter(function (x) { return x.id === k1; })[0];
      if (pr) pr.links = pr.links || [];
      return pr ? { obj: pr, title: esc(pr.k), done: function () { closeSheet(); render(); } } : null;
    }
    if (kind === 'report') {
      var rl = ensureReportLines();
      var g = rl[parseInt(k1, 10)];
      var it = g && g.items[parseInt(k2, 10)];
      if (it) it.links = it.links || [];
      return it ? { obj: it, title: esc(it.t), done: function () { closeSheet(); render(); } } : null;
    }
    if (kind === 'hub') {
      var h = (yv.hub || []).filter(function (x) { return x.id === k1; })[0];
      if (h) h.links = h.links || [];
      return h ? { obj: h, title: esc(h.label), done: function () { closeSheet(); render(); } } : null;
    }
    return null;
  }

  function linkRowHTML(l) {
    return '<div class="erow linkro">' +
      '<input class="input lk-l" value="' + esc(l && l.l || '') + '" placeholder="라벨 (예: 학년 공용 폴더)">' +
      '<input class="input lk-u" value="' + esc(l && l.u || '') + '" placeholder="https://docs.google.com/…" inputmode="url">' +
      '<button class="xbtn" data-a="row-del" aria-label="삭제">' + icon('close') + '</button></div>';
  }

  var currentLinks = null;
  function linkSheet(kind, k1, k2) {
    var own = linkOwner(kind, k1, k2);
    if (!own || !own.obj) { toast('먼저 저장해 주세요'); return; }
    currentLinks = { kind: kind, k1: k1, k2: k2 };
    var rows = (own.obj.links || []).map(linkRowHTML).join('');
    openSheet({
      title: '🔗 링크',
      sub: own.title,
      body:
        '<div class="elist" data-l="links">' + rows +
        '<button class="addline" data-a="link-add">＋ 링크 추가</button></div>' +
        '<div class="hint-box"><span>🔗</span><span>구글 문서·시트·드라이브 폴더·공문 주소를 붙여 두면 여기서 바로 열 수 있습니다. <b>http:// 또는 https://</b> 주소만 저장됩니다.</span></div>',
      foot: '<button class="btn line" data-a="close-sheet">취소</button>' +
        '<button class="btn primary" data-a="link-save">저장</button>'
    });
  }

  function saveLinks() {
    if (!currentLinks) return;
    var own = linkOwner(currentLinks.kind, currentLinks.k1, currentLinks.k2);
    if (!own || !own.obj) { closeSheet(); return; }
    var out = [], bad = '';
    $all('.elist[data-l="links"] .erow').forEach(function (row) {
      var l = (row.querySelector('.lk-l').value || '').trim();
      var u = (row.querySelector('.lk-u').value || '').trim();
      if (!u && !l) return;
      var ok = safeUrl(u);
      if (!ok) { bad = bad || (u || l); return; }
      out.push({ l: l || ok.replace(/^https?:\/\//, '').slice(0, 40), u: ok });
    });
    if (bad) { toast('주소를 확인해 주세요: ' + bad); return; }
    own.obj.links = out;
    if ('editedAt' in own.obj && !own.obj.editedAt) own.obj.editedAt = Date.now();
    touch();
    own.done();
    toast(out.length ? '링크 ' + out.length + '개를 저장했어요' : '링크를 지웠어요');
  }

  function allLinks() {
    var yv = Y(), out = [];
    D.monthOrder.forEach(function (m) {
      var d = radarOf(m);
      (d.links || []).forEach(function (l) { if (safeUrl(l.u)) out.push({ l: l.l, u: l.u, src: m + '월 레이더', tab: 'radar', m: m }); });
    });
    protocolsData().forEach(function (p) {
      (p.links || []).forEach(function (l) { if (safeUrl(l.u)) out.push({ l: l.l, u: l.u, src: '프로토콜 · ' + p.title, id: p.id }); });
    });
    principles().forEach(function (p) {
      (p.links || []).forEach(function (l) { if (safeUrl(l.u)) out.push({ l: l.l, u: l.u, src: '운영 원칙 · ' + p.k }); });
    });
    reportLinesData().forEach(function (g) {
      (g.items || []).forEach(function (it) {
        (it.links || []).forEach(function (l) { if (safeUrl(l.u)) out.push({ l: l.l, u: l.u, src: '보고선 · ' + it.t }); });
      });
    });
    (yv.tracker || []).forEach(function (t) {
      if (t.deleted) return;
      (t.links || []).forEach(function (l) { if (safeUrl(l.u)) out.push({ l: l.l, u: l.u, src: '사안 · ' + (t.title || t.cls) }); });
    });
    (yv.retro || []).forEach(function (r) {
      if (r.deleted) return;
      (r.links || []).forEach(function (l) { if (safeUrl(l.u)) out.push({ l: l.l, u: l.u, src: '기록 · ' + (r.date || '') }); });
    });
    return out;
  }

  /* ------------------------------------------------------------- 허브 */
  var HUB_TAGS = ['드라이브', '문서', '시트', '기타'];
  function hubList() { return (Y().hub || []).filter(function (h) { return h && safeUrl(h.url); }); }

  function hubCardHTML() {
    var list = hubList().slice(0, 6);
    var collected = allLinks().length;
    return '<section class="card">' +
      '<div class="card-head"><h2 class="card-title">문서·드라이브 허브</h2><span class="topbar-spacer"></span>' +
      '<button class="mini-link" data-a="open-hub">정리</button></div>' +
      (list.length ? '<div class="hub-list">' + list.map(function (h) {
        return '<a class="hub-item" href="' + esc(safeUrl(h.url)) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="hub-tag ' + hubTagClass(h.tag) + '">' + esc(h.tag || '기타') + '</span>' +
          '<span class="hub-body"><b>' + esc(h.label) + '</b>' +
          (h.memo ? '<em>' + esc(h.memo) + '</em>' : '') + '</span>' +
          '<span class="hub-go">' + icon('chevron') + '</span></a>';
      }).join('') + '</div>' :
        '<p class="card-note" style="margin-top:0">드라이브 폴더, 구글 문서·시트, 공문 주소를 여기에 모아 두면 한 번에 열 수 있습니다.</p>') +
      '<div class="btn-row"><button class="btn small line" data-a="hub-add">' + icon('plus') + ' 바로가기</button>' +
      '<button class="btn small line" data-a="open-hub">' + icon('users') + ' 모아보기' + (collected ? ' ' + collected : '') + '</button></div>' +
      '</section>';
  }

  function hubTagClass(t) {
    return t === '드라이브' ? 'blue' : t === '문서' ? 'violet' : t === '시트' ? 'green' : '';
  }

  function hubSheet(newOnly) {
    var hub = Y().hub || [];
    var collected = allLinks();
    openSheet({
      title: '문서·드라이브 허브',
      sub: '구글 드라이브 폴더·문서·시트·공문을 한 곳에 묶어 둡니다.',
      body:
        '<div class="field" style="margin-top:0"><label>바로가기 추가</label>' +
        '<input class="input" id="hub-label" placeholder="이름 (예: 3학년 공용 폴더)">' +
        '<input class="input" id="hub-url" placeholder="https://drive.google.com/…" inputmode="url" style="margin-top:8px">' +
        '<input class="input" id="hub-memo" placeholder="메모 (선택)" style="margin-top:8px">' +
        '<div class="chips hub-tags" style="margin-top:10px" id="hub-tags">' +
        HUB_TAGS.map(function (t, i) {
          return '<button class="chip small ' + (i === 0 ? 'active' : '') + '" data-a="hub-tag" data-t="' + t + '">' + t + '</button>';
        }).join('') + '</div>' +
        '<button class="btn primary block" style="margin-top:10px" data-a="hub-save">추가</button></div>' +
        '<div class="divider"></div>' +
        '<div class="card-head"><span class="card-cap">내 바로가기 ' + hub.length + '개</span></div>' +
        (hub.length ? '<div class="elist" data-l="hub">' + hub.map(function (h, i) {
          return '<div class="hub-row" data-i="' + i + '">' +
            '<span class="hub-tag ' + hubTagClass(h.tag) + '">' + esc(h.tag || '기타') + '</span>' +
            '<div style="flex:1;min-width:0"><a class="hub-a" href="' + esc(safeUrl(h.url) || '#') + '" target="_blank" rel="noopener noreferrer">' + esc(h.label) + '</a>' +
            (h.memo ? '<div class="hub-m">' + esc(h.memo) + '</div>' : '') + '</div>' +
            '<button class="xbtn" data-a="hub-del" data-i="' + i + '" aria-label="삭제">' + icon('trash') + '</button></div>';
        }).join('') + '</div>' : '<p class="card-note" style="margin-top:0">아직 없습니다. 폴더·문서 주소를 붙여 넣어 보세요.</p>') +
        '<div class="divider"></div>' +
        '<div class="card-head"><span class="card-cap">레이더·프로토콜·사안·기록에 단 링크 ' + collected.length + '개</span></div>' +
        (collected.length ? collected.map(function (l) {
          return '<a class="hub-item" href="' + esc(safeUrl(l.u)) + '" target="_blank" rel="noopener noreferrer">' +
            '<span class="hub-body"><b>🔗 ' + esc(l.l) + '</b><em>' + esc(l.src) + '</em></span>' +
            '<span class="hub-go">' + icon('chevron') + '</span></a>';
        }).join('') : '<p class="card-note" style="margin-top:0">레이더 월 카드·프로토콜·사안·기록의 ‘링크 추가’로 달아 둔 주소가 여기 모입니다.</p>') +
        '<div class="hint-box"><span>🔗</span><span>http(s) 주소만 저장됩니다. 링크는 내 기기와 비공개 시트에만 남습니다.</span></div>',
      foot: '<button class="btn line" data-a="close-sheet">닫기</button>'
    });
    hubTag = HUB_TAGS[0];
    if (newOnly) setTimeout(function () { var el = $('#hub-label'); if (el) el.focus(); }, 120);
  }
  var hubTag = '드라이브';

  function saveHubItem() {
    var label = ($('#hub-label').value || '').trim();
    var url = safeUrl($('#hub-url').value);
    var memo = ($('#hub-memo').value || '').trim();
    if (!label) { toast('이름을 적어 주세요'); return; }
    if (!url) { toast('http:// 또는 https:// 주소를 확인해 주세요'); return; }
    Y().hub = Y().hub || [];
    Y().hub.push({ id: 'h' + uid(), label: label, url: url, tag: hubTag, memo: memo, at: Date.now() });
    touch();
    hubSheet();
    render();
    toast('바로가기를 추가했어요');
  }

  function delHubItem(i) {
    var hub = Y().hub || [];
    if (!hub[i]) return;
    if (!confirm('“' + hub[i].label + '” 바로가기를 지울까요?')) return;
    hub.splice(i, 1);
    touch();
    hubSheet();
    render();
    toast('지웠어요');
  }

  /* ------------------------------------------------------------- 내보내기 */
  function mirrorTables() {
    var radar = { tab: '레이더_정리', header: ['학년도', '직책·학년', '월', '구분', '내용', '완료여부', '링크'], rows: [] };
    var cases = { tab: '사안_트래커', header: ['학년도', '기록시각', '반', '대상', '유형', '긴급도', '상태', '보고여부', '내용', '후속조치', '링크'], rows: [] };
    var retro = { tab: '판단_기록', header: ['학년도', '날짜', '상황', '판단', '결과', '다음엔', '태그', '링크'], rows: [] };

    db.state.years.slice().sort().forEach(function (y) {
      var yv = Yof(y);
      var who = (yv.role || defaultRole(yv.grade)) + ' / ' + yv.grade + '학년';
      D.monthOrder.forEach(function (m) {
        var d = radarOf(m, y);
        var lk = linkText(d.links);
        (d.checks || []).forEach(function (c) {
          radar.rows.push([y, who, m + '월', '체크리스트', c.t, checkOnY(y, yv.grade, c.id) ? 'O' : '', lk]);
        });
        (d.traps || []).forEach(function (t) { radar.rows.push([y, who, m + '월', '지뢰', t.t + ' — ' + t.d, '', lk]); });
        radar.rows.push([y, who, m + '월', '공지초안', d.notice || '', '', lk]);
        (d.now || []).forEach(function (t) { radar.rows.push([y, who, m + '월', '할일', t, '', lk]); });
        (d.me || []).forEach(function (t) { radar.rows.push([y, who, m + '월', '할일', t, '', lk]); });
        (d.links || []).forEach(function (l) { radar.rows.push([y, who, m + '월', '링크', (l.l || '') + ' — ' + (l.u || ''), '', '']); });
        if (d.memo) radar.rows.push([y, who, m + '월', '메모', d.memo, '', lk]);
      });
      (yv.tracker || []).forEach(function (t) {
        if (t.deleted) return;
        cases.rows.push([
          y, t.date || '', t.cls || '', t.target || '', t.type || '', t.urgency || '', t.status || '', t.report || '',
          t.title + (t.memo ? ' — ' + t.memo : ''), t.next || '', linkText(t.links)
        ]);
      });
      (yv.retro || []).forEach(function (r) {
        if (r.deleted) return;
        retro.rows.push([y, r.date || '', r.situation || '', r.decision || '', r.result || '', r.next || '', r.tag || '', linkText(r.links)]);
      });
    });
    return { radar: radar, cases: cases, retro: retro };
  }

  function buildMirror() {
    var t = mirrorTables();
    return [t.radar, t.cases, t.retro];
  }

  function csvEsc(v) {
    var s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function csvOf(table) {
    return '\ufeff' + [table.header].concat(table.rows).map(function (r) {
      return r.map(csvEsc).join(',');
    }).join('\r\n');
  }
  function downloadText(name, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2500);
  }

  function docsParts() {
    var y = db.state.year, yv = Y();
    var h = [], txt = [];
    function H(level, s) { h.push('<h' + level + '>' + esc(s) + '</h' + level + '>'); txt.push(''); txt.push((level === 1 ? '# ' : level === 2 ? '## ' : '### ') + s); }
    function P(s) { if (!s) return; h.push('<p>' + esc(s) + '</p>'); txt.push(s); }
    function UL(items) {
      if (!items || !items.length) return;
      h.push('<ul>' + items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>');
      items.forEach(function (t) { txt.push('• ' + t); });
    }
    function LK(links) {
      var arr = (links || []).filter(function (l) { return safeUrl(l.u); });
      if (!arr.length) return;
      h.push('<ul>' + arr.map(function (l) {
        return '<li><a href="' + esc(safeUrl(l.u)) + '">' + esc(l.l || safeUrl(l.u)) + '</a> <span>' + esc(safeUrl(l.u)) + '</span></li>';
      }).join('') + '</ul>');
      arr.forEach(function (l) { txt.push('• ' + (l.l || '') + ' ' + safeUrl(l.u)); });
    }

    H(1, yearLabel() + ' ' + roleLabel() + ' — 학년부장 운영 노트');
    P('1년 레이더 · 판단 기준 · 대응 프로토콜 · 사안 기록을 한 문서로 묶었습니다.');

    H(2, '내 운영 원칙');
    principles().forEach(function (p) {
      h.push('<p><b>' + esc(p.k) + '</b> — ' + esc(p.v) + '</p>');
      txt.push('• ' + p.k + ' — ' + p.v);
      LK(p.links);
    });

    H(2, '1년 레이더');
    D.monthOrder.forEach(function (m) {
      var d = radarOf(m, y);
      H(3, m + '월 · ' + d.title);
      P(d.lead);
      if ((d.now || []).length) { h.push('<p><b>미리 뿌릴 것</b></p>'); txt.push('미리 뿌릴 것'); UL(d.now); }
      if ((d.checks || []).length) {
        h.push('<p><b>동학년 체크리스트</b></p>');
        txt.push('동학년 체크리스트');
        h.push('<ul>' + d.checks.map(function (c) {
          var on = checkOnY(y, yv.grade, c.id);
          return '<li>' + (on ? '☑ ' : '☐ ') + esc(c.t) + '</li>';
        }).join('') + '</ul>');
        d.checks.forEach(function (c) { txt.push((checkOnY(y, yv.grade, c.id) ? '[x] ' : '[ ] ') + c.t); });
      }
      if ((d.traps || []).length) {
        h.push('<p><b>놓치기 쉬운 지뢰</b></p>');
        txt.push('놓치기 쉬운 지뢰');
        h.push('<ul>' + d.traps.map(function (t) { return '<li><b>' + esc(t.t) + '</b> — ' + esc(t.d) + '</li>'; }).join('') + '</ul>');
        d.traps.forEach(function (t) { txt.push('• ' + t.t + ' — ' + t.d); });
      }
      if ((d.me || []).length) { h.push('<p><b>부장이 직접 챙길 일</b></p>'); txt.push('부장이 직접 챙길 일'); UL(d.me); }
      if (d.notice) {
        h.push('<p><b>공지 초안</b></p><pre>' + esc(noticeOf(d, yv.grade)) + '</pre>');
        txt.push('공지 초안');
        noticeOf(d, yv.grade).split('\n').forEach(function (line) { txt.push(line); });
      }
      if (d.memo) { h.push('<p><b>내 메모</b><br>' + esc(d.memo) + '</p>'); txt.push('내 메모: ' + d.memo); }
      LK(d.links);
    });

    H(2, '판단 · 보고선');
    h.push('<table border="1" cellspacing="0" cellpadding="6"><thead><tr><th>구분</th><th>항목</th><th>설명</th><th>링크</th></tr></thead><tbody>');
    txt.push('구분 | 항목 | 설명');
    reportLinesData().forEach(function (g) {
      (g.items || []).forEach(function (it) {
        h.push('<tr><td>' + esc(g.level) + '</td><td>' + esc(it.t) + '</td><td>' + esc(it.d) + '</td><td>' + esc(linkText(it.links)) + '</td></tr>');
        txt.push(g.level + ' | ' + it.t + ' | ' + it.d);
      });
    });
    h.push('</tbody></table>');

    H(2, '대응 프로토콜');
    protocolsData().forEach(function (p) {
      H(3, p.title);
      P(p.when);
      if ((p.steps || []).length) { h.push('<p><b>할 일</b></p>'); txt.push('할 일'); UL(p.steps); }
      if ((p.avoid || []).length) { h.push('<p><b>절대 금지</b></p>'); txt.push('절대 금지'); UL(p.avoid); }
      if ((p.lines || []).length) { h.push('<p><b>보낼 문장</b></p>'); txt.push('보낼 문장'); UL(p.lines); }
      if (p.record) P('기록 기준: ' + p.record);
      if (p.memo) P('메모: ' + p.memo);
      LK(p.links);
    });

    H(2, '사안 트래커');
    var items = (yv.tracker || []).filter(function (t) { return !t.deleted; });
    if (items.length) {
      h.push('<table border="1" cellspacing="0" cellpadding="6"><thead><tr><th>반</th><th>유형</th><th>제목</th><th>대상</th><th>긴급도</th><th>보고</th><th>상태</th><th>내용</th><th>후속조치</th><th>링크</th></tr></thead><tbody>');
      txt.push('반 | 유형 | 제목 | 대상 | 상태');
      items.forEach(function (t) {
        h.push('<tr>' + [t.cls, t.type, t.title, t.target, t.urgency, t.report, t.status, t.memo, t.next, linkText(t.links)].map(function (v) { return '<td>' + esc(v || '') + '</td>'; }).join('') + '</tr>');
        txt.push([t.cls, t.type, t.title, t.target, t.status].join(' | '));
      });
      h.push('</tbody></table>');
    } else P('기록 없음');

    H(2, '판단 기록');
    var logs = (yv.retro || []).filter(function (r) { return !r.deleted; });
    logs.forEach(function (r) {
      H(3, (r.date || '') + ' · ' + (r.tag || '기록'));
      if (r.situation) P('상황: ' + r.situation);
      if (r.decision) P('판단: ' + r.decision);
      if (r.result) P('결과: ' + r.result);
      if (r.next) P('다음엔: ' + r.next);
      LK(r.links);
    });
    if (!logs.length) P('기록 없음');

    var hub = hubList();
    if (hub.length) {
      H(2, '문서·드라이브 바로가기');
      h.push('<ul>' + hub.map(function (x) {
        return '<li><a href="' + esc(safeUrl(x.url)) + '">' + esc(x.label) + '</a> (' + esc(x.tag || '기타') + ')' + (x.memo ? ' — ' + esc(x.memo) : '') + '</li>';
      }).join('') + '</ul>');
      hub.forEach(function (x) { txt.push('• ' + x.label + ' ' + safeUrl(x.url) + (x.memo ? ' — ' + x.memo : '')); });
    }

    return { html: '<div>' + h.join('\n') + '</div>', text: txt.join('\n').replace(/^\n+/, '') };
  }

  function copyForDocs() {
    var parts = docsParts();
    var done = function () { toast('구글 문서에 붙여넣기(Ctrl+V) 하세요'); };
    if (navigator.clipboard && window.ClipboardItem) {
      var item = new ClipboardItem({
        'text/html': new Blob([parts.html], { type: 'text/html' }),
        'text/plain': new Blob([parts.text], { type: 'text/plain' })
      });
      navigator.clipboard.write([item]).then(done).catch(function () { copyRichFallback(parts.html, parts.text); });
    } else {
      copyRichFallback(parts.html, parts.text);
    }
  }

  function copyRichFallback(html, text) {
    try {
      var div = document.createElement('div');
      div.contentEditable = 'true';
      div.style.position = 'fixed';
      div.style.left = '-9999px';
      div.style.top = '0';
      div.innerHTML = html;
      document.body.appendChild(div);
      var range = document.createRange();
      range.selectNodeContents(div);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      var ok = document.execCommand('copy');
      sel.removeAllRanges();
      document.body.removeChild(div);
      if (ok) { toast('구글 문서에 붙여넣기(Ctrl+V) 하세요'); return; }
    } catch (e) { /* 아래로 */ }
    copyText(text);
  }

  function exportSheet() {
    var t = mirrorTables();
    openSheet({
      title: '내보내기',
      sub: '구글 문서·스프레드시트·엑셀에서 그대로 열 수 있게 꺼냅니다.',
      body:
        '<div class="field" style="margin-top:0"><label>① 구글 문서(Docs)</label>' +
        '<button class="btn primary block" data-a="copy-docs">' + icon('copy') + ' 문서용으로 복사 (서식 포함)</button>' +
        '<p class="card-note">복사한 뒤 구글 문서에서 <b>Ctrl+V</b> 하면 제목·목록·표가 그대로 들어갑니다.</p></div>' +
        '<div class="field"><label>② 스프레드시트·엑셀 (CSV)</label>' +
        '<button class="btn line block" data-a="csv-radar">레이더_정리.csv · ' + t.radar.rows.length + '줄</button>' +
        '<button class="btn line block" style="margin-top:8px" data-a="csv-cases">사안_트래커.csv · ' + t.cases.rows.length + '줄</button>' +
        '<button class="btn line block" style="margin-top:8px" data-a="csv-retro">판단_기록.csv · ' + t.retro.rows.length + '줄</button>' +
        '<p class="card-note">UTF-8 BOM을 넣어 한글이 깨지지 않습니다. 구글 시트 · 엑셀에서 바로 열립니다.</p></div>' +
        '<div class="field"><label>③ 백업</label>' +
        '<button class="btn line block" data-a="export">JSON 백업 (전체 학년도)</button></div>' +
        '<div class="hint-box"><span>📄</span><span>비공개 시트의 <b>레이더_정리 · 사안_트래커 · 판단_기록</b> 탭도 앱이 저장할 때마다 같은 내용으로 채워집니다.</span></div>',
      foot: '<button class="btn line" data-a="close-sheet">닫기</button>'
    });
  }

  function exportCSV(kind) {
    var t = mirrorTables();
    var tab = kind === 'cases' ? t.cases : kind === 'retro' ? t.retro : t.radar;
    var name = tab.tab + '_' + db.state.year + '_' + todayISO() + '.csv';
    downloadText(name, csvOf(tab), 'text/csv');
    toast(name + ' 내려받았어요');
  }

  /* ------------------------------------------------------------- 명단 */
  function normCls(v) {
    var s = String(v == null ? '' : v).replace(/\s/g, '');
    if (!s) return '';
    if (s === '공통' || s === '학년공통') return '학년 공통';
    var m = s.match(/^(\d{1,2})/);
    if (!m) return s;
    var n = parseInt(m[1], 10);
    return (n >= 1 && n <= 12) ? n + '반' : s;
  }
  function normKind(v) {
    var s = String(v == null ? '' : v).trim();
    if (/^(교사|교원|직원|선생님|교직원)$/.test(s)) return '교사';
    return '학생';
  }
  function rosterKey(r) { return [r.kind, r.cls, r.no, r.name].join('|'); }

  function normalizeRoster(rows) {
    var map = {}, out = [];
    (rows || []).forEach(function (r) {
      if (!r) return;
      var name = String(r.name == null ? '' : r.name).trim();
      if (!name) return;
      var item = {
        kind: normKind(r.kind),
        cls: normCls(r.cls),
        no: String(r.no == null ? '' : r.no).trim(),
        name: name,
        memo: String(r.memo == null ? '' : r.memo).trim(),
        at: r.at || 0
      };
      if (!item.cls) item.cls = '학년 공통';
      var k = rosterKey(item);
      if (!map[k] || (item.at || 0) >= (map[k].at || 0)) map[k] = item;
    });
    Object.keys(map).forEach(function (k) { out.push(map[k]); });
    return out;
  }

  function parseRosterText(text) {
    var rows = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var s = String(line).replace(/\u00a0/g, ' ').trim();
      if (!s) return;
      var cells;
      if (s.indexOf('\t') >= 0) cells = s.split('\t');
      else if (s.indexOf(',') >= 0) cells = s.split(',');
      else cells = s.split(/\s{2,}|\s+/);
      cells = cells.map(function (c) { return String(c).trim(); }).filter(function (c, i, a) { return !(c === '' && i === a.length - 1); });
      if (!cells.length) return;
      if (/^(구분|분류|종류)$/.test(cells[0]) && cells.length > 1) return;
      if (/^(번호|no)$/i.test(cells[0]) && cells.length > 1) return;

      var kind = '학생';
      if (/^(학생|교사|교원|직원|선생님)$/.test(cells[0])) { kind = normKind(cells.shift()); }

      var cls = '';
      if (cells.length && /^(\d{1,2}|공통|학년공통)(반)?$/.test(cells[0])) cls = normCls(cells.shift());

      var no = '';
      if (cells.length > 1 && cells[0] === '') cells.shift();          // 빈 번호 칸
      if (cells.length > 1 && /^\d{1,3}$/.test(cells[0])) no = cells.shift();

      var name = cells.shift() || '';
      var memo = cells.join(' ').trim();
      if (!name) return;
      rows.push({ kind: kind, cls: cls || '학년 공통', no: no, name: name, memo: memo, at: Date.now() });
    });
    return normalizeRoster(rows);
  }

  function rosterOf(cls) {
    var list = Y().roster || [];
    return list.filter(function (r) { return !cls || r.cls === normCls(cls); });
  }
  function rosterTotal() { return (Y().roster || []).length; }

  /* ------------------------------------------------------------- 저장 */
  function persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ state: db.state, rev: db.rev, url: db.url }));
    } catch (e) { /* 용량 초과 등 */ }
  }

  var hasLocalData = false;

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && o.state) {
        hasLocalData = true;
        db.state = normalize(o.state);
        db.rev = o.rev || '';
        db.url = o.url || '';
      }
    } catch (e) { /* 무시 */ }
  }

  function touch() {
    Y().updatedAt = Date.now();
    persist();
    scheduleSave();
  }

  function scheduleSave() {
    if (!db.url) { setSync('off'); return; }
    setSync('busy');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { pushState(); }, 900);
  }

  /* ------------------------------------------------------------- 동기화 */
  function apiBase() { return db.url.trim(); }

  var cbSeq = 0;
  function apiGet(params) {
    return new Promise(function (resolve, reject) {
      var base = apiBase();
      if (!base) return reject(new Error('주소 없음'));
      var cb = '__ghcb' + (++cbSeq);
      var qs = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }).join('&');
      var script = document.createElement('script');
      var timer = setTimeout(function () { cleanup(); reject(new Error('응답 시간 초과')); }, 15000);
      function cleanup() {
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = function (data) { cleanup(); resolve(data); };
      script.onerror = function () { cleanup(); reject(new Error('주소를 열 수 없음')); };
      script.src = base + (base.indexOf('?') >= 0 ? '&' : '?') + qs + '&callback=' + cb;
      document.head.appendChild(script);
    });
  }

  function apiPost(payload) {
    var base = apiBase();
    return fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    }).then(function (r) { return r.json(); });
  }

  function setSync(mode, label) {
    var el = $('#sync-chip');
    if (!el) return;
    var map = { off: '기기에만 저장', busy: '저장 중…', on: '동기화됨', warn: '확인 필요' };
    el.className = 'sync ' + (mode === 'on' ? 'on' : mode === 'busy' ? 'busy' : mode === 'warn' ? 'warn' : '');
    el.innerHTML = '<i></i><span class="sync-t">' + esc(label || map[mode] || map.off) + '</span>';
    el.title = label || map[mode] || map.off;
  }

  function pushState() {
    if (!db.url || syncing) return;
    syncing = true;
    setSync('busy');
    var baseRev = db.rev;
    var payload = {
      action: 'save', key: 'state', app: 'grade-head-os', version: APP_VERSION,
      baseRev: baseRev, data: db.state
    };
    try { payload.mirror = buildMirror(); } catch (e) { payload.mirror = null; }
    apiPost(payload).then(function (r) {
      syncing = false;
      if (r && r.ok) {
        db.rev = r.rev || db.rev;
        persist();
        setSync('on');
      } else if (r && r.conflict) {
        setSync('warn', '다른 기기와 합치는 중');
        pullState(true).then(function () { pushState(); });
      } else {
        setSync('warn');
      }
    }).catch(function () {
      apiGet({ action: 'load', key: 'state' }).then(function (r) {
        syncing = false;
        if (r && r.ok && r.rev && r.rev !== baseRev) {
          db.rev = r.rev;
          persist();
          setSync('on');
        } else {
          setSync('warn', '오프라인 · 기기에 저장됨');
        }
      }).catch(function () {
        syncing = false;
        setSync('warn', '오프라인 · 기기에 저장됨');
      });
    });
  }

  function pullState(merge) {
    if (!db.url) return Promise.resolve();
    return apiGet({ action: 'load', key: 'state' }).then(function (r) {
      if (!r || !r.ok) { setSync('warn'); return; }
      var remote = r.data;
      db.rev = r.rev || db.rev;
      var remoteHasData = remote && typeof remote === 'object' && Object.keys(remote).length > 0;
      if (remoteHasData) {
        if (merge) {
          var had = JSON.stringify(db.state);
          db.state = mergeStates(db.state, normalize(remote));
          persist();
          if (JSON.stringify(db.state) !== had) render();
        } else {
          db.state = normalize(remote);
          persist();
          render();
        }
      } else if (!merge) {
        pushState();
      }
      // 명단 자동 동기화 (시트에 내용이 있을 때만 덮어씁니다)
      if (Array.isArray(r.roster) && r.roster.length) {
        var incoming = normalizeRoster(r.roster);
        if (JSON.stringify(incoming) !== JSON.stringify(Y().roster)) {
          Y().roster = incoming;
          persist();
          if (route === 'respond' || sheetOpen) { /* 다음 렌더에서 반영 */ }
          render();
        }
      }
      setSync('on');
    }).catch(function (e) {
      setSync('warn', '연결 실패 · 기기에 저장됨');
      throw e;
    });
  }

  function mergeStates(local, remote) {
    local = normalize(local); remote = normalize(remote);
    var years = uniq(local.years.concat(remote.years)).sort();
    var out = { v: 2, year: local.year || remote.year, years: years, byYear: {} };
    years.forEach(function (y) {
      var a = local.byYear[y] || fillYear(null, y);
      var b = remote.byYear[y] || fillYear(null, y);
      var pick = ((b.updatedAt || 0) > (a.updatedAt || 0)) ? b : a;
      var yv = {
        grade: pick.grade, role: pick.role,
        updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
        checks: {}, tracker: [], retro: [], radar: {}, roster: []
      };
      [a.checks || {}, b.checks || {}].forEach(function (obj) {
        Object.keys(obj).forEach(function (k) {
          var prev = yv.checks[k], cur = obj[k];
          if (!prev || (cur && (cur.at || 0) >= (prev.at || 0))) yv.checks[k] = cur;
        });
      });
      ['tracker', 'retro'].forEach(function (name) {
        var map = {};
        (a[name] || []).concat(b[name] || []).forEach(function (it) {
          if (!it || !it.id) return;
          var prev = map[it.id];
          if (!prev || (it.updatedAt || 0) >= (prev.updatedAt || 0)) map[it.id] = it;
        });
        yv[name] = Object.keys(map).map(function (k) { return map[k]; });
      });
      [a.radar || {}, b.radar || {}].forEach(function (obj) {
        Object.keys(obj).forEach(function (m) {
          var prev = yv.radar[m], cur = obj[m];
          if (!prev || (cur && (cur.editedAt || 0) >= (prev.editedAt || 0))) yv.radar[m] = cur;
        });
      });
      var rmap = {};
      (a.roster || []).concat(b.roster || []).forEach(function (r) {
        if (!r || !r.name) return;
        var k = rosterKey(r), prev = rmap[k];
        if (!prev || (r.at || 0) >= (prev.at || 0)) rmap[k] = r;
      });
      yv.roster = Object.keys(rmap).map(function (k) { return rmap[k]; });
      out.byYear[y] = yv;
    });
    return out;
  }

  /* ------------------------------------------------------------- 판단 계산 */
  function verdictKey() {
    if (Q.report) return 'report';
    if (Q.all || !Q.ground) return 'hold';
    return 'draft';
  }

  function defaultTime() {
    var d = new Date();
    d.setHours(d.getHours() + 2);
    d.setMinutes(0);
    var ampm = d.getHours() < 12 ? '오전' : '오후';
    var h = d.getHours() % 12; if (h === 0) h = 12;
    return '오늘 ' + ampm + ' ' + h + '시';
  }

  function verdictHTML() {
    var o = D.quick.outcomes[verdictKey()];
    var checked = Q.ground || Q.all || Q.report;
    if (!checked) {
      return '' +
        '<div class="verdict empty">' +
        '<div class="vt"><span>지금 판단</span></div>' +
        '<p class="vtitle">아직 판단 전</p>' +
        '<p class="vsub">위 3가지를 체크하면 결론이 바로 나옵니다.</p>' +
        '</div>';
    }
    var time = timeLabel(($('#time-input') && $('#time-input').value) || to24(defaultTime()));
    var msg = o.msg.replace('{time}', time);
    return '' +
      '<div class="verdict ' + o.tone + '">' +
      '<div class="vt"><span>결론</span></div>' +
      '<p class="vtitle">' + esc(o.title) + '</p>' +
      '<p class="vsub">' + esc(o.sub) + '</p>' +
      '</div>' +
      '<div class="msgbox">' +
      '<div class="mlabel">그대로 보낼 문장</div>' +
      '<div class="mtext">' + esc(msg) + '</div>' +
      '<div class="msgbox-foot">' +
      '<label class="time-pick">약속 시각 <input type="time" id="time-input" value="' + to24(defaultTime()) + '"></label>' +
      '<button class="copy-btn" data-a="copy" data-copy="' + encodeURIComponent(msg) + '">' +
      icon('copy') + '복사</button>' +
      '</div>' +
      '</div>' +
      '<ul class="why-list">' + o.why.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' +
      '<div class="btn-row">' +
      '<button class="btn small line" data-a="verdict-save">판단 기록 남기기</button>' +
      '<button class="btn small line" data-a="open-protocol">대응 프로토콜</button>' +
      '</div>';
  }

  function to24(txt) {
    var m = String(txt).match(/(오전|오후)\s*(\d+)시/);
    if (!m) return '14:00';
    var h = parseInt(m[2], 10) % 12;
    if (m[1] === '오후') h += 12;
    return String(h).padStart(2, '0') + ':00';
  }

  function timeLabel(v) {
    var p = String(v || '').split(':');
    var h = parseInt(p[0], 10);
    if (isNaN(h)) return defaultTime();
    var mn = p[1] || '00';
    var ampm = h < 12 ? '오전' : '오후';
    var hh = h % 12; if (hh === 0) hh = 12;
    return '오늘 ' + ampm + ' ' + hh + '시' + (mn === '00' ? '' : ' ' + mn + '분');
  }

  /* ------------------------------------------------------------- 아이콘 */
  function icon(name) {
    var p = {
      copy: '<path d="M9 9V6.5A2.5 2.5 0 0 1 11.5 4H18a2 2 0 0 1 2 2v6.5A2.5 2.5 0 0 1 17.5 15H15"/><rect x="4" y="9" width="11" height="11" rx="2.5"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      chevron: '<path d="M9 6l6 6-6 6"/>',
      check: '<path d="M4 12.5l5 5L20 6.5"/>',
      gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.54h.08A1.7 1.7 0 0 0 10.1 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.03z"/>',
      compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
      calendar: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3.5v3M16 3.5v3M3.5 10h17"/>',
      scale: '<path d="M12 4v16M7 20h10"/><path d="M4 8h16"/><path d="M7 8l-3 6h6z"/><path d="M17 8l-3 6h6z"/>',
      alert: '<path d="M12 3.8l8.4 15.2H3.6z"/><path d="M12 9.5v4"/><path d="M12 16.4v.2"/>',
      book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/>',
      close: '<path d="M6 6l12 12M18 6L6 18"/>',
      trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 13h9.4l.8-13"/>',
      pencil: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/>',
      users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 6.1M17 20a6 6 0 0 0-2-4.5"/>',
      down: '<path d="M6 9l6 6 6-6"/>'
    };
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + (p[name] || '') + '</svg>';
  }

  /* ------------------------------------------------------------- 셸 */
  var NAV = [
    { r: 'today', label: '오늘', icon: 'compass' },
    { r: 'radar', label: '1년 레이더', icon: 'calendar' },
    { r: 'judge', label: '판단·조율', icon: 'scale' },
    { r: 'respond', label: '대응', icon: 'alert' },
    { r: 'log', label: '기록', icon: 'book' }
  ];

  function yearSwitchHTML() {
    var ys = db.state.years.slice().sort();
    var i = ys.indexOf(db.state.year);
    return '' +
      '<div class="year-switch' + (isPast() ? ' past' : '') + '" id="year-switch">' +
      '<button class="ys-arrow" data-a="year-step" data-d="-1" aria-label="이전 학년도"' + (i <= 0 ? ' disabled' : '') + '>‹</button>' +
      '<button class="year-pill" data-a="open-years" aria-label="학년도 바꾸기">' +
      '<span class="yp-t">' + esc(db.state.year) + '<span class="yp-u">학년도</span></span>' +
      '<span class="yp-caret">' + icon('down') + '</span>' +
      '</button>' +
      '<button class="ys-arrow" data-a="year-step" data-d="1" aria-label="다음 학년도"' + (i >= ys.length - 1 ? ' disabled' : '') + '>›</button>' +
      '</div>';
  }

  function shell() {
    var navHtml = NAV.map(function (n) {
      return '<button class="tab ' + (route === n.r ? 'active' : '') + '" data-a="nav" data-r="' + n.r + '">' +
        icon(n.icon) + '<span>' + n.label + '</span></button>';
    }).join('');
    var sideHtml = NAV.map(function (n) {
      return '<button class="side-item ' + (route === n.r ? 'active' : '') + '" data-a="nav" data-r="' + n.r + '">' +
        icon(n.icon) + '<span>' + n.label + '</span></button>';
    }).join('');

    return '' +
      '<aside class="sidebar">' +
      '<div class="side-brand"><div class="brand-mark">學</div>' +
      '<div><div class="brand-name">학년부장 OS</div><div class="sub">12학급 운영 시스템</div></div></div>' +
      '<nav class="side-nav">' + sideHtml + '</nav>' +
      '<div class="side-foot">' +
      '<button class="side-item" data-a="settings">' + icon('gear') + '<span>설정·명단·동기화</span></button>' +
      '<div class="side-rule">오늘의 판단은 기록으로 남고,<br>기록은 다음 학년의 플레이북이 됩니다.</div>' +
      '</div>' +
      '</aside>' +
      '<main class="app-main">' +
      '<header class="topbar" id="topbar"><div class="topbar-in">' +
      '<div class="brand-mini mobile-only"><div class="brand-mark">學</div><div class="brand-name">학년부장 OS</div></div>' +
      '<span class="desk-crumb" id="crumb">오늘</span>' +
      '<div class="topbar-spacer"></div>' +
      yearSwitchHTML() +
      '<button class="role-pill" data-a="open-years" id="role-pill" title="역할·학년도 바꾸기"><span class="dot"></span><span id="role-text">' + esc(roleLabel()) + '</span></button>' +
      '<span class="sync" id="sync-chip" data-a="settings" title="저장·동기화 설정"><i></i><span class="sync-t">기기에만 저장</span></span>' +
      '<button class="icon-btn desktop-only" data-a="settings" aria-label="설정">' + icon('gear') + '</button>' +
      '</div></header>' +
      '<div class="wrap" id="view"></div>' +
      '</main>' +
      '<nav class="tabbar">' + navHtml + '</nav>' +
      '<div class="scrim" id="scrim" data-a="close-sheet"></div>' +
      '<div class="sheet" id="sheet"><div class="sheet-grip"></div><div id="sheet-inner"></div></div>' +
      '<div class="toast" id="toast"></div>';
  }

  function refreshChrome() {
    var ys = db.state.years.slice().sort();
    var i = ys.indexOf(db.state.year);
    var sw = $('#year-switch');
    if (sw) {
      var tmp = document.createElement('div');
      tmp.innerHTML = yearSwitchHTML();
      sw.parentNode.replaceChild(tmp.firstElementChild, sw);
    }
    var rt = $('#role-text');
    if (rt) rt.textContent = roleLabel();
  }

  /* ------------------------------------------------------------- 렌더 */
  function render() {
    var v = $('#view');
    var views = { today: viewToday, radar: viewRadar, judge: viewJudge, respond: viewRespond, log: viewLog };
    v.innerHTML = '<div class="view">' + (views[route] || viewToday)() + '</div>';
    $all('.tab,.side-item').forEach(function (b) {
      if (b.dataset.r) b.classList.toggle('active', b.dataset.r === route);
    });
    var crumb = $('#crumb');
    if (crumb) crumb.textContent = (NAV.filter(function (n) { return n.r === route; })[0] || { label: '' }).label;
    refreshChrome();
    if (db.url) setSync('on'); else setSync('off');
    if (route === 'radar') {
      var strip = $('.month-strip');
      var mb = strip && strip.querySelector('.mbtn.active');
      if (strip && mb) {
        var r = mb.getBoundingClientRect(), sr = strip.getBoundingClientRect();
        strip.scrollLeft += (r.left - sr.left) - (strip.clientWidth - r.width) / 2;
      }
    }
    window.scrollTo({ top: 0, behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' });
  }

  function yearNoteHTML() {
    if (!isPast()) return '';
    return '<div class="past-note">' + icon('book') + '<span>' + esc(yearLabel()) + ' · 지난 학년도 기록을 보고 있습니다.</span>' +
      '<button class="mini-link" data-a="year-latest">최근 학년도로</button></div>';
  }

  /* ------------------------------------------------------------- 오늘 */
  function viewToday() {
    var now = new Date();
    var m = now.getMonth() + 1;
    var md = radarOf(m);
    var yv = Y();
    var open = yv.tracker.filter(function (t) { return !t.deleted && t.status !== '종결'; });
    var report = open.filter(function (t) { return t.report === '보고 필요'; });
    var done = 0, total = 0;
    (md.checks || []).forEach(function (c) {
      total++;
      if (checkOn(yv.grade, c.id)) done++;
    });
    var recent = yv.retro.filter(function (r) { return !r.deleted; }).slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).slice(0, 2);

    return '' +
      yearNoteHTML() +
      '<div class="page-head">' +
      '<p class="page-eyebrow">' + m + '월 ' + now.getDate() + '일 ' + weekdayKor(now) + '요일 · ' + esc(roleLabel()) + ' · ' + esc(yearLabel()) + '</p>' +
      '<h1 class="page-title">지금 바로 답해도 되나?</h1>' +
      '<p class="page-sub">질문·민원·돌발 상황이 오면, 답하기 전에 3가지만 확인하세요.</p>' +
      '</div>' +

      '<div class="home-grid">' +
      '<div class="col">' +

      '<section class="card quick">' +
      '<div class="quick-top"><div>' +
      '<h2 class="quick-title">3초 판단 브레이크</h2>' +
      '<p class="quick-sub">체크하면 결론과 보낼 문장이 바로 나옵니다.</p>' +
      '</div></div>' +
      '<div class="qlist" id="qlist">' + qRowsHTML() + '</div>' +
      '<div id="verdict-wrap">' + verdictHTML() + '</div>' +
      '</section>' +

      '<section class="card">' +
      '<div class="card-head"><span class="card-cap">' + m + '월</span>' +
      '<h2 class="card-title">' + esc(md.title) + '</h2></div>' +
      '<div class="now-list" style="margin-top:2px">' +
      md.now.map(function (t, i) {
        return '<div class="now-item" style="background:#F7F9FB;color:#333D4B"><span class="num" style="background:#E8F3FF;color:#1B64DA">' + (i + 1) + '</span><span>' + esc(t) + '</span></div>';
      }).join('') +
      '</div>' +
      '<div class="progress-line" style="margin-top:16px">' +
      '<div class="progress-bar"><i style="width:' + (total ? Math.round(done / total * 100) : 0) + '%"></i></div>' +
      '<span class="progress-num">' + done + '/' + total + '</span>' +
      '</div>' +
      '<p class="card-note">이번 달 동학년 체크리스트 진행률입니다.</p>' +
      '<div class="btn-row"><button class="btn small line" data-a="nav" data-r="radar">레이더 열기</button>' +
      '<button class="btn small line" data-a="copy" data-copy="' + encodeURIComponent(noticeOf(md, yv.grade)) + '">' + icon('copy') + ' 공지 복사</button></div>' +
      '</section>' +

      '</div><div class="col">' +

      '<section class="card">' +
      '<div class="card-head"><h2 class="card-title">지금 챙길 것</h2></div>' +
      '<div class="stats">' +
      '<button class="stat red" data-a="nav" data-r="respond"><div class="n">' + open.length + '</div><div class="l">진행 중 사안</div></button>' +
      '<button class="stat blue" data-a="open-tracker-filter" data-f="report"><div class="n">' + report.length + '</div><div class="l">보고 필요</div></button>' +
      '<button class="stat" data-a="nav" data-r="log"><div class="n">' + yv.retro.filter(function (r) { return !r.deleted; }).length + '</div><div class="l">남긴 기록</div></button>' +
      '</div>' +
      '<p class="card-note">‘진행 중’은 12개 반 민원·특이사항·휴직 인수인계 중 종결되지 않은 건입니다.</p>' +
      '</section>' +

      hubCardHTML() +

      '<section class="card">' +
      '<div class="card-head"><h2 class="card-title">남긴 판단</h2>' +
      '<span class="topbar-spacer"></span>' +
      '<button class="chip small" data-a="open-retro">+ 쓰기</button></div>' +
      (recent.length ? recent.map(function (r) { return miniLog(r); }).join('') :
        '<p class="card-note" style="margin-top:0">아직 기록이 없습니다. 오늘 판단한 일 하나만 남겨 보세요. 다음에 같은 상황이 왔을 때 훨씬 빨라집니다.</p>') +
      '</section>' +

      '<section class="card card-tight">' +
      '<div class="card-head" style="margin-bottom:10px"><h2 class="card-title" style="font-size:16px">내 운영 원칙</h2>' +
      '<span class="topbar-spacer"></span>' +
      '<button class="mini-link" data-a="edit-principles">' + icon('pencil') + ' 고치기</button></div>' +
      principles().map(function (p, i) {
        return '<div class="principle"><div class="pr-k">' + esc(p.k) + '</div>' +
          '<div class="pr-v">' + esc(p.v) + '</div>' +
          linkChipsHTML(p.links, 'principle', p.id || ('pr' + i)) + '</div>';
      }).join('') +
      '</section>' +

      '</div></div>' +
      '<p class="foot-note">기록은 기기에 먼저 저장되고, 연결하면 비공개 시트와 동기화됩니다.</p>';
  }

  function miniLog(r) {
    return '<div style="padding:12px 0;border-bottom:1px solid #F2F4F6">' +
      '<div style="display:flex;gap:6px;align-items:center">' +
      '<span class="tag ' + tagTone(r.tag) + '">' + esc(r.tag || '기록') + '</span>' +
      '<span class="log-date">' + fmtDate(r.date) + '</span></div>' +
      '<div style="font-size:14px;font-weight:700;margin-top:6px;line-height:1.45">' + esc(r.situation || '') + '</div>' +
      (r.next ? '<div style="font-size:13px;color:#1B64DA;margin-top:3px">→ ' + esc(r.next) + '</div>' : '') +
      '</div>';
  }

  function qRowsHTML() {
    return D.quick.questions.map(function (q) {
      return '<button class="qrow ' + (Q[q.k] ? 'on' : '') + '" data-a="toggle-q" data-k="' + q.k + '">' +
        '<span class="box">' + icon('check') + '</span>' +
        '<span><span class="qt">' + esc(q.q) + '</span><span class="qh" style="display:block">' + esc(q.hint) + '</span></span>' +
        '</button>';
    }).join('');
  }

  /* ------------------------------------------------------------- 레이더 */
  function noticeOf(d, g) {
    var t = String(d.notice || '');
    if (g === '3') return t;
    return t.replace(/^\[3학년\]/, '[' + g + '학년]');
  }

  function viewRadar() {
    var m = radarMonth;
    var d = radarOf(m);
    var yv = Y();
    var g = yv.grade;
    var notice = noticeOf(d, g);
    var done = 0, total = (d.checks || []).length;
    (d.checks || []).forEach(function (c) { if (checkOn(g, c.id)) done++; });
    var nowM = new Date().getMonth() + 1;
    var point = pointOf(d, g);

    return '' +
      yearNoteHTML() +
      '<div class="page-head">' +
      '<p class="page-eyebrow">1년 선제 레이더 · ' + esc(yearLabel()) + '</p>' +
      '<h1 class="page-title">터지기 전에 미리 뿌리는 것</h1>' +
      '<p class="page-sub">월을 고르면 그 달에 뿌릴 공지·체크리스트·지뢰가 나옵니다. 내 학교 사정에 맞게 고쳐 쓰세요.</p>' +
      '</div>' +

      '<div class="gradestrip" style="margin-bottom:14px">' +
      GRADES.map(function (gg) {
        return '<button class="chip ' + (g === gg ? 'active' : '') + '" data-a="grade" data-g="' + gg + '">' + gg + '학년</button>';
      }).join('') +
      '</div>' +

      '<div class="month-strip" style="margin-bottom:16px">' +
      D.monthOrder.map(function (mm) {
        return '<button class="mbtn ' + (mm === m ? 'active' : '') + (mm === nowM ? ' now' : '') + (isEdited(mm) ? ' edited' : '') + '" data-a="month" data-m="' + mm + '">' +
          '<span class="m">' + mm + '월</span><span class="s">' + MONTH_TAG[mm] + '</span></button>';
      }).join('') +
      '</div>' +

      '<div class="month-hero">' +
      '<div class="mh-top"><span>' + m + '월</span><span style="opacity:.6">·</span><span>' + g + '학년</span>' +
      '<span class="topbar-spacer"></span>' +
      (isEdited(m) ? '<span class="mh-chip">내가 고침</span>' : '') +
      '<button class="mh-edit" data-a="radar-edit" data-m="' + m + '">' + icon('pencil') + ' 편집</button>' +
      '</div>' +
      '<h2>' + esc(d.title) + '</h2>' +
      '<p>' + esc(d.lead) + '</p>' +
      '<div class="now-list">' +
      d.now.map(function (t, i) {
        return '<div class="now-item"><span class="num">' + (i + 1) + '</span><span>' + esc(t) + '</span></div>';
      }).join('') +
      '</div>' +
      '</div>' +

      '<section class="card" style="margin-top:14px" id="checks-card">' + checksCardHTML() + '</section>' +

      '<section class="card">' +
      '<div class="card-head"><span class="card-cap">공지 초안</span><span class="topbar-spacer"></span>' +
      '<button class="mini-link" data-a="radar-edit" data-m="' + m + '">' + icon('pencil') + ' 고치기</button></div>' +
      '<h2 class="card-title" style="margin-bottom:12px">그대로 보내는 안내문</h2>' +
      '<div class="notice-pre">' + esc(notice) + '</div>' +
      '<div class="btn-row"><button class="btn primary small" data-a="copy" data-copy="' + encodeURIComponent(notice) + '">' + icon('copy') + ' 공지 복사</button></div>' +
      '<p class="card-note">○ 자리만 학교 일정으로 채우면 됩니다. 보내기 전에 날짜·마감·양식을 한 번 더 확인하세요.</p>' +
      '</section>' +

      '<section class="card">' +
      '<div class="card-head"><span class="card-cap">놓치기 쉬운 지뢰</span><span class="topbar-spacer"></span>' +
      '<button class="mini-link" data-a="radar-edit" data-m="' + m + '">' + icon('pencil') + ' 고치기</button></div>' +
      '<h2 class="card-title" style="margin-bottom:8px">이 달에 특히 잘 터지는 것</h2>' +
      (d.traps.length ? d.traps.map(function (t) {
        return '<div class="trap"><div class="ico">⚠️</div><div><div class="tt">' + esc(t.t) + '</div><div class="td">' + esc(t.d) + '</div></div></div>';
      }).join('') : '<p class="card-note" style="margin-top:0">아직 적어 둔 지뢰가 없습니다. 편집에서 추가해 보세요.</p>') +
      '</section>' +

      '<section class="card">' +
      '<div class="card-head"><h2 class="card-title">부장이 직접 챙길 일</h2><span class="topbar-spacer"></span>' +
      '<button class="mini-link" data-a="radar-edit" data-m="' + m + '">' + icon('pencil') + ' 고치기</button></div>' +
      (d.me.length ? '<ul class="plain-list">' + d.me.map(function (t) { return '<li><span class="b"></span><span>' + esc(t) + '</span></li>'; }).join('') + '</ul>' : '<p class="card-note">비어 있습니다. 편집에서 추가해 보세요.</p>') +
      (point ? '<div class="grade-note"><div class="g">' + g + '학년</div><p>' + esc(point) + '</p></div>' : '') +
      '</section>' +

      (d.memo ? '<section class="card"><div class="card-head"><span class="card-cap">내 메모</span><span class="topbar-spacer"></span>' +
        '<button class="mini-link" data-a="radar-edit" data-m="' + m + '">' + icon('pencil') + ' 고치기</button></div>' +
        '<div class="notice-pre" style="background:#FFF9E8;border-color:#F5E3B3">' + esc(d.memo) + '</div></section>' : '') +

      '<section class="card">' +
      '<div class="card-head"><span class="card-cap">이 달 링크</span><span class="topbar-spacer"></span>' +
      '<button class="mini-link" data-a="edit-links" data-kind="month" data-k1="' + m + '">' + icon('plus') + ' 링크</button></div>' +
      linkChipsHTML((radarOf(m).links || []), 'month', m) +
      ((radarOf(m).links || []).filter(function (l) { return safeUrl(l.u); }).length ? ''
        : '<p class="card-note" style="margin-top:0">이 달에 볼 문서·폴더·공문 주소를 달아 두면 바로 열 수 있습니다.</p>') +
      '</section>' +

      '<div class="btn-row" style="margin-top:14px">' +
      '<button class="btn small line" data-a="copy-docs">' + icon('copy') + ' 문서용 복사</button>' +
      '<button class="btn small line" data-a="open-export">' + icon('down') + ' 내보내기(CSV)</button></div>' +
      '<p class="foot-note">학교·교육청 규정과 공문이 항상 우선입니다. 이 레이더는 “미리 챙길 것”을 잊지 않기 위한 기준입니다.</p>';
  }

  function checksCardHTML() {
    var m = radarMonth, g = Y().grade, d = radarOf(m);
    var done = 0;
    var rows = (d.checks || []).map(function (c, i) {
      var on = checkOn(g, c.id);
      if (on) done++;
      return '<button class="check-row ' + (on ? 'on' : '') + '" data-a="check" data-id="' + esc(c.id) + '">' +
        '<span class="box">' + icon('check') + '</span><span class="txt">' + esc(c.t) + '</span></button>';
    }).join('');
    var total = (d.checks || []).length;
    return '' +
      '<div class="card-head"><span class="card-cap">동학년 체크리스트</span><span class="topbar-spacer"></span>' +
      '<span class="progress-num">' + done + '/' + total + '</span></div>' +
      '<div class="progress-bar" style="margin-bottom:8px"><i style="width:' + (total ? Math.round(done / total * 100) : 0) + '%"></i></div>' +
      (total ? '<div class="check-list">' + rows + '</div>' : '<p class="card-note" style="margin-top:0">체크리스트가 비어 있습니다. 편집에서 추가해 보세요.</p>');
  }

  /* ------------------------------------------------------------- 레이더 편집 시트 */
  function rowHTML(l, val, ph, multiline) {
    return '<div class="erow" data-l="' + l + '">' +
      (multiline
        ? '<textarea class="textarea ein" style="min-height:64px" placeholder="' + esc(ph) + '">' + esc(val) + '</textarea>'
        : '<input class="input ein" value="' + esc(val) + '" placeholder="' + esc(ph) + '">') +
      '<button class="xbtn" data-a="row-del" aria-label="삭제">' + icon('close') + '</button></div>';
  }

  function listHTML(l, arr, ph, multiline) {
    var rows = (arr || []).map(function (v) { return rowHTML(l, v, ph, multiline); }).join('');
    return rows + '<button class="addline" data-a="row-add" data-l="' + l + '">＋ 항목 추가</button>';
  }

  function checkRowHTML(c) {
    return '<div class="erow" data-l="checks">' +
      '<input type="hidden" class="eid" value="' + esc(c.id) + '">' +
      '<input class="input ein" value="' + esc(c.t) + '" placeholder="체크리스트 항목">' +
      '<button class="xbtn" data-a="row-del" aria-label="삭제">' + icon('close') + '</button></div>';
  }

  function trapRowHTML(t) {
    return '<div class="erow trapro" data-l="traps">' +
      '<div class="trap-in">' +
      '<input class="input ein ein-t" value="' + esc(t.t) + '" placeholder="지뢰 제목 (예: 동의서 마감을 반별로 다르게 잡기)">' +
      '<textarea class="textarea ein ein-d" style="min-height:56px" placeholder="왜 문제이고 어떻게 피할지">' + esc(t.d) + '</textarea>' +
      '</div>' +
      '<button class="xbtn" data-a="row-del" aria-label="삭제">' + icon('close') + '</button></div>';
  }

  function trapListHTML(arr) {
    var rows = (arr || []).map(trapRowHTML).join('');
    return rows + '<button class="addline" data-a="row-add" data-l="traps">＋ 지뢰 추가</button>';
  }

  function radarEditSheet(m) {
    var d = radarOf(m);
    var g = Y().grade;
    var edited = isEdited(m);
    openSheet({
      title: m + '월 레이더 편집',
      sub: esc(yearLabel()) + ' · ' + g + '학년 · ' + (edited ? '내가 고친 내용입니다.' : '기본 예시입니다. 고치면 내 것으로 저장됩니다.'),
      body:
        '<div class="field"><label>제목</label><input class="input" id="e-title" value="' + esc(d.title) + '"></div>' +
        '<div class="field"><label>한 줄 요약</label><input class="input" id="e-lead" value="' + esc(d.lead) + '"></div>' +
        '<div class="field"><label>이 달에 미리 뿌릴 것</label><div class="elist" data-l="now">' + listHTML('now', d.now, '예: 학부모총회 날짜를 첫 주에 확정한다') + '</div></div>' +
        '<div class="field"><label>공지 초안 (그대로 보낼 안내문)</label>' +
        '<textarea class="textarea" id="e-notice" style="min-height:190px">' + esc(d.notice) + '</textarea>' +
        '<p class="card-note">맨 앞의 <b>[3학년]</b>은 지금 고른 학년에 맞춰 자동으로 바뀝니다.</p></div>' +
        '<div class="field"><label>동학년 체크리스트</label><div class="elist" data-l="checks">' +
        ((d.checks || []).map(checkRowHTML).join('') + '<button class="addline" data-a="row-add" data-l="checks">＋ 항목 추가</button>') +
        '</div><p class="card-note">항목을 지우면 그 항목의 완료 표시도 함께 사라집니다.</p></div>' +
        '<div class="field"><label>놓치기 쉬운 지뢰</label><div class="elist" data-l="traps">' + trapListHTML(d.traps) + '</div></div>' +
        '<div class="field"><label>부장이 직접 챙길 일</label><div class="elist" data-l="me">' + listHTML('me', d.me, '예: 인수인계 목차 배포') + '</div></div>' +
        '<div class="field"><label>' + g + '학년 포인트</label>' +
        '<textarea class="textarea" id="e-point" style="min-height:80px" placeholder="이 학년에서 특히 조심할 점">' + esc(pointOf(d, g)) + '</textarea>' +
        '<p class="card-note">학년을 바꾸면 그 학년의 포인트를 따로 적을 수 있습니다(1~6학년 각각).</p></div>' +
        '<div class="field"><label>내 메모</label>' +
        '<textarea class="textarea" id="e-memo" style="min-height:70px" placeholder="이 달에 겪은 일, 우리 학교 사정">' + esc(d.memo || '') + '</textarea></div>' +
        '<div class="hint-box"><span>✍️</span><span>여기서 고친 내용은 <b>' + esc(yearLabel()) + '</b>에만 저장됩니다. 다음 학년도를 만들 때 복사할 수 있습니다.</span></div>',
      foot: (edited ? '<button class="btn line" data-a="radar-reset" data-m="' + m + '">기본값</button>' : '') +
        '<button class="btn line" data-a="close-sheet">취소</button>' +
        '<button class="btn primary" data-a="radar-save" data-m="' + m + '">저장</button>'
    });
  }

  function readList(l) {
    return $all('.elist[data-l="' + l + '"] .erow').map(function (row) {
      var el = row.querySelector('.ein');
      return el ? el.value.trim() : '';
    }).filter(Boolean);
  }
  function readChecks(m) {
    return $all('.elist[data-l="checks"] .erow').map(function (row) {
      var id = row.querySelector('.eid');
      var txt = row.querySelector('.ein');
      return { id: (id && id.value) || (m + '-u' + uid()), t: txt.value.trim() };
    }).filter(function (c) { return c.t; });
  }
  function readTraps() {
    return $all('.elist[data-l="traps"] .erow').map(function (row) {
      var t = row.querySelector('.ein-t'), d = row.querySelector('.ein-d');
      return { t: t ? t.value.trim() : '', d: d ? d.value.trim() : '' };
    }).filter(function (x) { return x.t; });
  }

  function addRow(l) {
    var box = $('.elist[data-l="' + l + '"]');
    if (!box) return;
    var btn = box.querySelector('.addline');
    var wrap = document.createElement('div');
    var html;
    if (l === 'checks') html = checkRowHTML({ id: 'u' + uid(), t: '' });
    else if (l === 'traps') html = trapRowHTML({ t: '', d: '' });
    else html = rowHTML(l, '', '할 일');
    wrap.innerHTML = html;
    var node = wrap.firstElementChild;
    box.insertBefore(node, btn);
    var inp = node.querySelector('.ein');
    if (inp) inp.focus();
  }

  function saveRadar(m) {
    var g = Y().grade;
    var base = radarOf(m);
    Y().radar[m] = {
      title: $('#e-title').value.trim() || base.title,
      lead: $('#e-lead').value.trim(),
      now: readList('now'),
      notice: $('#e-notice').value,
      checks: readChecks(m),
      traps: readTraps(),
      me: readList('me'),
      points: Object.assign({}, base.points, (function () { var o = {}; o[g] = $('#e-point').value.trim(); return o; })()),
      memo: $('#e-memo').value.trim(),
      links: base.links || [],
      editedAt: Date.now()
    };
    touch();
    closeSheet();
    render();
    toast('레이더를 저장했어요');
  }

  function resetRadar(m) {
    if (!confirm(m + '월 레이더를 기본 예시로 되돌릴까요? 내가 고친 내용은 사라집니다.')) return;
    delete Y().radar[m];
    touch();
    closeSheet();
    render();
    toast('기본 예시로 되돌렸어요');
  }

  /* ------------------------------------------------------------- 판단 */
  function viewJudge() {
    var J = D.judge;
    var any = SHAPE.affect || SHAPE.fair || SHAPE.approval || SHAPE.flip;
    var shapeKey = (SHAPE.fair || SHAPE.approval || SHAPE.flip) ? 'collect' : 'draft';

    return '' +
      '<div class="page-head">' +
      '<p class="page-eyebrow">판단 · 조율 · ' + esc(yearLabel()) + '</p>' +
      '<h1 class="page-title">내가 정할 일인가, 모아서 정할 일인가</h1>' +
      '<p class="page-sub">단순한 일은 초안으로 치우고, 협조가 필요한 일만 모아서 정합니다.</p>' +
      '</div>' +

      '<section class="card">' +
      '<div class="card-head"><h2 class="card-title">일의 성격 판별</h2></div>' +
      '<div class="qlist" style="margin-top:0">' +
      J.shapeQuestions.map(function (q) {
        return '<button class="qrow ' + (SHAPE[q.k] ? 'on' : '') + '" data-a="shape" data-k="' + q.k + '">' +
          '<span class="box">' + icon('check') + '</span>' +
          '<span><span class="qt">' + esc(q.q) + '</span><span class="qh" style="display:block">' + esc(q.hint) + '</span></span>' +
          '</button>';
      }).join('') +
      '</div>' +
      '<div class="verdict ' + (any ? J.shapes[shapeKey].tone : '') + '" id="shape-result">' +
      (any ? shapeBlock(shapeKey) : '<div class="vt"><span>결과</span></div><p class="vtitle">아직 판단 전</p><p class="vsub">하나라도 해당하면 “모아서 정하는 일”입니다.</p>') +
      '</div>' +
      '</section>' +

      '<section class="card">' +
      '<div class="card-head"><span class="card-cap">12학급 공지</span></div>' +
      '<h2 class="card-title">한 번에, 수정 없이, 마감·양식까지</h2>' +
      J.noticeRules.map(function (r) {
        return '<div class="trap" style="padding:12px 0"><div class="ico" style="background:#E8F3FF;color:#1B64DA;font-size:12px;font-weight:900">' + esc(r.t.slice(0, 2)) + '</div>' +
          '<div><div class="tt">' + esc(r.t) + '</div><div class="td">' + esc(r.d) + '</div></div></div>';
      }).join('') +
      '<div class="notice-pre" style="margin-top:14px">' + esc(J.noticeTemplate) + '</div>' +
      '<div class="btn-row"><button class="btn small line" data-a="copy" data-copy="' + encodeURIComponent(J.noticeTemplate) + '">' + icon('copy') + ' 공지 양식 복사</button></div>' +
      '</section>' +

      '<section class="card">' +
      '<div class="card-head"><span class="card-cap">회의</span></div>' +
      '<h2 class="card-title">12개 반 회의를 짧게 끝내는 법</h2>' +
      '<ul class="plain-list">' + J.meetingRules.map(function (t) { return '<li><span class="b"></span><span>' + esc(t) + '</span></li>'; }).join('') + '</ul>' +
      '<div class="notice-pre" style="margin-top:14px">' + esc(J.meetingTemplate) + '</div>' +
      '<div class="btn-row"><button class="btn small line" data-a="copy" data-copy="' + encodeURIComponent(J.meetingTemplate) + '">' + icon('copy') + ' 회의 안건 양식 복사</button></div>' +
      '</section>' +

      '<section class="card">' +
      '<div class="card-head"><span class="card-cap">보고 3줄</span></div>' +
      '<h2 class="card-title">보고는 길게 하지 않습니다</h2>' +
      '<div class="notice-pre" style="margin-top:12px">' + esc(J.reportForm) + '</div>' +
      '<p class="card-note" style="font-weight:800;color:#333D4B;margin-top:16px">예시</p>' +
      '<div class="notice-pre">' + esc(J.reportExample) + '</div>' +
      '<div class="btn-row"><button class="btn small line" data-a="copy" data-copy="' + encodeURIComponent(J.reportForm) + '">' + icon('copy') + ' 보고 양식 복사</button></div>' +
      '</section>' +

      '<section class="card">' +
      '<div class="card-head"><h2 class="card-title">보고선 기준표</h2><span class="topbar-spacer"></span>' +
      '<button class="mini-link" data-a="edit-report">' + icon('pencil') + ' 고치기</button></div>' +
      '<p class="card-note" style="margin-top:0">혼자 판단해서 결론을 내리면 책임이 나에게 남습니다. 아래는 “누가 답을 정하는가”의 기준입니다.</p>' +
      reportLinesData().map(function (g, gi) {
        return '<div class="rep-group">' +
          '<div class="rep-head"><span class="tag ' + (g.tone === 'danger' ? 'red' : g.tone === 'warn' ? 'amber' : 'green') + '">' + esc(g.level) + '</span>' +
          '<span class="rep-note">' + esc(g.note) + '</span></div>' +
          (g.items || []).map(function (it, ii) {
            return '<div class="rep-item"><span class="b" style="flex:0 0 5px;width:5px;height:5px;border-radius:50%;background:' +
              (g.tone === 'danger' ? '#F04452' : g.tone === 'warn' ? '#F07C00' : '#0E9F6E') + ';margin-top:9px"></span>' +
              '<div style="flex:1;min-width:0"><div class="rt">' + esc(it.t) + '</div><div class="rd">' + esc(it.d) + '</div>' +
              linkChipsHTML(it.links, 'report', gi, ii) + '</div></div>';
          }).join('') +
          '</div>';
      }).join('') +
      '</section>' +

      '<section class="card">' +
      '<div class="card-head"><h2 class="card-title">번복을 막는 4규칙</h2></div>' +
      '<ul class="plain-list">' + J.flipRules.map(function (t) { return '<li><span class="b"></span><span>' + esc(t) + '</span></li>'; }).join('') + '</ul>' +
      '</section>' +
      '<p class="foot-note">판단이 어려우면 홈의 3초 판단으로 돌아가세요. 세 질문이면 대부분 정리됩니다.</p>';
  }

  function shapeBlock(key) {
    var sh = D.judge.shapes[key];
    return '<div class="vt"><span>결과</span></div>' +
      '<p class="vtitle">' + esc(sh.title) + '</p>' +
      '<p class="vsub">' + esc(sh.sub) + '</p>' +
      '<div style="margin-top:14px;background:#fff;border-radius:15px;padding:6px 14px 12px;border:1px solid #E8EBEE">' +
      sh.steps.map(function (s, i) {
        return '<div class="step-line"><span class="n">' + (i + 1) + '</span><span class="t">' + esc(s) + '</span></div>';
      }).join('') +
      '</div>' +
      '<div class="msgbox" style="margin-top:12px"><div class="mlabel">그대로 보낼 문장</div><div class="mtext">' + esc(sh.msg) + '</div>' +
      '<div class="msgbox-foot" style="justify-content:flex-end"><button class="copy-btn" data-a="copy" data-copy="' + encodeURIComponent(sh.msg) + '">' + icon('copy') + '복사</button></div></div>';
  }

  /* ------------------------------------------------------------- 대응 */
  function viewRespond() {
    return '' +
      yearNoteHTML() +
      '<div class="page-head">' +
      '<p class="page-eyebrow">갈등 · 민원 · 휴직 · ' + esc(yearLabel()) + '</p>' +
      '<h1 class="page-title">상황별로 꺼내 쓰는 대응</h1>' +
      '<p class="page-sub">할 일·절대 금지·보낼 문장이 정해져 있으면, 감정이 올라와도 흔들리지 않습니다.</p>' +
      '</div>' +
      '<div class="segmented" style="margin-bottom:16px">' +
      '<button class="' + (respondTab === 'protocol' ? 'active' : '') + '" data-a="respond-tab" data-t="protocol">대응 프로토콜</button>' +
      '<button class="' + (respondTab === 'tracker' ? 'active' : '') + '" data-a="respond-tab" data-t="tracker">12개 반 트래커</button>' +
      '</div>' +
      (respondTab === 'protocol' ? protocolList() : trackerView());
  }

  function protocolList() {
    var list = protocolsData();
    return '<div class="btn-row" style="margin-top:0;margin-bottom:12px">' +
      '<button class="btn line small" data-a="edit-protocol-list">' + icon('pencil') + ' 프로토콜 고치기</button>' +
      '<button class="btn line small" data-a="new-protocol">' + icon('plus') + ' 새 프로토콜</button></div>' +
      '<div class="protocol-grid">' +
      list.map(function (p) {
        return '<button class="pcard" data-a="protocol" data-id="' + esc(p.id) + '">' +
          '<span class="emo">' + esc(p.emoji || '📌') + '</span>' +
          '<span style="flex:1;min-width:0"><span class="pt" style="display:block">' + esc(p.title) + '</span>' +
          '<span class="pw" style="display:block">' + esc(p.when) + '</span>' +
          ((p.links || []).filter(function (l) { return safeUrl(l.u); }).length ? '<span class="pw" style="display:block;color:#1B64DA">🔗 링크 ' + p.links.length + '개</span>' : '') +
          '</span>' +
          '<span class="arrow">' + icon('chevron') + '</span></button>';
      }).join('') +
      '</div>' +
      '<p class="foot-note">상황이 애매하면 홈의 3초 판단부터. 답을 정하는 문제인지, 시간을 버는 문제인지 먼저 나눕니다.</p>';
  }

  function trackerView() {
    var items = Y().tracker.filter(function (t) { return !t.deleted; });
    var open = items.filter(function (t) { return t.status !== '종결'; });
    var filtered = items.filter(function (t) {
      if (trackerFilter.status !== 'all' && t.status !== trackerFilter.status) return false;
      if (trackerFilter.reportOnly && t.report !== '보고 필요') return false;
      if (trackerFilter.type !== 'all' && t.type !== trackerFilter.type) return false;
      return true;
    }).sort(function (a, b) {
      var rank = { '높음': 0, '보통': 1, '낮음': 2 };
      if (a.status !== '종결' && b.status === '종결') return -1;
      if (a.status === '종결' && b.status !== '종결') return 1;
      var r = (rank[a.urgency] || 1) - (rank[b.urgency] || 1);
      if (r) return r;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    var counts = {};
    CLASSES.forEach(function (c) { counts[c] = 0; });
    open.forEach(function (t) { if (counts[t.cls] != null) counts[t.cls]++; });

    return '' +
      '<div class="stats page" style="margin-bottom:14px">' +
      '<div class="stat red"><div class="n">' + open.length + '</div><div class="l">진행 중</div></div>' +
      '<div class="stat blue"><div class="n">' + open.filter(function (t) { return t.report === '보고 필요'; }).length + '</div><div class="l">보고 필요</div></div>' +
      '<div class="stat green"><div class="n">' + items.filter(function (t) { return t.status === '종결'; }).length + '</div><div class="l">종결</div></div>' +
      '</div>' +

      '<div class="card card-tight" style="padding:16px">' +
      '<div class="card-head" style="margin-bottom:4px"><span class="card-cap">반별 진행 중</span>' +
      '<span class="topbar-spacer"></span>' +
      '<button class="mini-link" data-a="open-roster">' + icon('users') + ' 명단 ' + rosterTotal() + '명</button></div>' +
      '<div class="heat">' +
      CLASSES.filter(function (c) { return c !== '학년 공통'; }).map(function (c) {
        return '<div class="heat-cell ' + (counts[c] ? 'has' : '') + '"><div class="hc">' + c.replace('반', '') + '</div><div class="hn">' + counts[c] + '</div></div>';
      }).join('') +
      '</div>' +
      (counts['학년 공통'] ? '<p class="card-note">학년 공통 사안 ' + counts['학년 공통'] + '건이 진행 중입니다.</p>' : '') +
      (rosterTotal() ? '' : '<p class="card-note">명단을 넣으면 사안 기록에서 반을 고를 때 학생·교사를 탭 한 번으로 넣을 수 있습니다. <button class="mini-link" data-a="open-roster">명단 넣기</button></p>') +
      '</div>' +

      '<div class="btn-row" style="margin-top:12px">' +
      '<button class="btn small line" data-a="open-roster">' + icon('users') + ' 명단 관리</button>' +
      '<button class="btn small line" data-a="open-export">' + icon('down') + ' 내보내기(CSV)</button></div>' +
      '<div class="filter-row" style="margin-top:16px;margin-bottom:2px">' +
      ['all', '진행', '보류', '종결'].map(function (s) {
        return '<button class="chip ' + (trackerFilter.status === s ? 'active' : '') + '" data-a="t-filter" data-k="status" data-v="' + s + '">' + (s === 'all' ? '전체' : s) + '</button>';
      }).join('') +
      '<button class="chip ' + (trackerFilter.reportOnly ? 'active' : '') + '" data-a="t-filter" data-k="report" data-v="1">보고 필요</button>' +
      '</div>' +
      '<div class="filter-row" style="margin-top:8px">' +
      ['all'].concat(D.tracker.types).map(function (t) {
        return '<button class="chip ghost small ' + (trackerFilter.type === t ? 'active' : '') + '" data-a="t-filter" data-k="type" data-v="' + t + '">' + (t === 'all' ? '유형 전체' : t) + '</button>';
      }).join('') +
      '</div>' +

      (filtered.length ? filtered.map(function (t) { return caseCard(t) + '<div class="linkbar">' + linkChipsHTML(t.links, 'case', t.id) + '</div>'; }).join('') :
        '<div class="empty" style="margin-top:14px"><div class="et">기록이 없습니다</div><div class="ed">민원·특이사항·휴직 인수인계가 생기면 바로 남기세요.<br>나중에 “언제, 누가, 무엇을” 답할 수 있어야 합니다.</div>' +
        '<button class="btn small line" style="margin-top:16px" data-a="open-case">' + icon('plus') + ' 첫 사안 기록</button></div>') +
      '<button class="fab" data-a="open-case">' + icon('plus') + '기록</button>' +
      '<div style="height:84px"></div>';
  }

  function caseCard(t) {
    var tone = t.urgency === '높음' ? 'red' : t.type === '휴직·인수인계' ? 'violet' : t.type === '민원' ? 'amber' : 'blue';
    return '<button class="case ' + (t.status === '종결' ? 'done' : '') + '" data-a="edit-case" data-id="' + t.id + '">' +
      '<div class="case-top">' +
      '<span class="tag ' + tone + '">' + esc(t.cls) + '</span>' +
      '<span class="tag">' + esc(t.type) + '</span>' +
      (t.urgency === '높음' ? '<span class="tag red">긴급</span>' : '') +
      (t.report === '보고 필요' ? '<span class="tag amber">보고 필요</span>' : '') +
      '</div>' +
      '<div class="case-title">' + esc(t.title || '(제목 없음)') + '</div>' +
      (t.target ? '<div class="case-target">' + icon('users') + esc(t.target) + '</div>' : '') +
      (t.memo ? '<div class="case-memo">' + esc(t.memo) + '</div>' : '') +
      (t.next ? '<div style="font-size:13px;color:#1B64DA;font-weight:700;margin-top:5px">→ ' + esc(t.next) + '</div>' : '') +
      '<div class="case-meta"><span>' + esc(t.status) + '</span><span class="sep"></span><span>' + fmtDate(t.date) + '</span></div>' +
      '</button>';
  }

  /* ------------------------------------------------------------- 기록 */
  function logSource() {
    var years = logScope === 'all' ? db.state.years.slice().sort().reverse() : [db.state.year];
    var out = [];
    years.forEach(function (y) {
      (Yof(y).retro || []).forEach(function (r) {
        if (!r.deleted) out.push(Object.assign({ _y: y }, r));
      });
    });
    var q = logQuery.trim().toLowerCase();
    if (q) {
      out = out.filter(function (r) {
        return [r.tag, r.situation, r.decision, r.result, r.next].join(' ').toLowerCase().indexOf(q) >= 0;
      });
    }
    return out.sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '') || (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  function logListHTML() {
    var items = logSource();
    if (!items.length) {
      return '<div class="empty">' + (logQuery ? '<div class="et">검색 결과가 없습니다</div><div class="ed">다른 낱말로 찾아보거나 “전체 학년도”로 범위를 넓혀 보세요.</div>'
        : '<div class="et">첫 기록을 남겨 보세요</div><div class="ed">거창할 필요 없습니다. “오늘 어떤 질문을 받았고,<br>어떻게 답했고, 다음엔 어떻게 할지” 한 줄씩이면 충분합니다.</div>') + '</div>';
    }
    return items.map(function (r) {
      return '<button class="card log-card" data-a="edit-retro" data-id="' + r.id + '" data-y="' + r._y + '">' +
        '<div class="log-head"><span class="tag ' + tagTone(r.tag) + '">' + esc(r.tag || '기록') + '</span>' +
        (logScope === 'all' || r._y !== db.state.year ? '<span class="tag violet">' + esc(r._y) + '학년도</span>' : '') +
        '<span class="log-date">' + fmtDate(r.date) + '</span></div>' +
        '<div class="log-body">' +
        (r.situation ? '<div class="log-part"><span class="k">상황</span><span class="v">' + esc(r.situation) + '</span></div>' : '') +
        (r.decision ? '<div class="log-part"><span class="k">내 판단</span><span class="v">' + esc(r.decision) + '</span></div>' : '') +
        (r.result ? '<div class="log-part"><span class="k">결과</span><span class="v">' + esc(r.result) + '</span></div>' : '') +
        (r.next ? '<div class="log-part next"><span class="k">다음엔</span><span class="v">' + esc(r.next) + '</span></div>' : '') +
        '</div></button>' +
        '<div class="linkbar">' + linkChipsHTML(r.links, 'retro', r.id, r._y) + '</div>';
    }).join('');
  }

  function viewLog() {
    return '' +
      yearNoteHTML() +
      '<div class="page-head">' +
      '<p class="page-eyebrow">멘토 회고 · ' + esc(yearLabel()) + '</p>' +
      '<h1 class="page-title">내가 내린 판단을 남깁니다</h1>' +
      '<p class="page-sub">상황·판단·결과·다음에 바꿀 점. 4줄이면 다음에 같은 일이 와도 빠릅니다.</p>' +
      '</div>' +
      '<button class="btn primary block" data-a="open-retro">' + icon('plus') + ' 오늘 판단 기록하기</button>' +
      '<div class="searchbox">' +
      '<input class="input" id="log-q" placeholder="기록 검색 (상황·판단·결과)" value="' + esc(logQuery) + '">' +
      '<div class="segmented mini" style="margin-top:10px">' +
      '<button class="' + (logScope === 'current' ? 'active' : '') + '" data-a="log-scope" data-v="current">이 학년도</button>' +
      '<button class="' + (logScope === 'all' ? 'active' : '') + '" data-a="log-scope" data-v="all">전체 학년도</button>' +
      '</div>' +
      '</div>' +
      '<div class="section-head" style="margin-top:22px"><h2 class="section-title" id="log-count">기록 ' + logSource().length + '건</h2></div>' +
      '<div id="log-list">' + logListHTML() + '</div>' +
      '<div class="btn-row" style="margin-top:12px"><button class="btn line small" data-a="open-export">' + icon('down') + ' 내보내기·복사</button></div>' +
      '<p class="foot-note">기록은 비공개입니다. 연결하면 내 구글 시트에만 저장되고, 공개 저장소에는 아무것도 올라가지 않습니다.</p>';
  }

  function tagTone(tag) {
    return { '판단': 'blue', '민원': 'amber', '갈등': 'red', '업무': 'violet', '보고': 'green', '실수': 'amber' }[tag] || '';
  }

  function refreshLog() {
    var list = $('#log-list');
    if (list) list.innerHTML = logListHTML();
    var cnt = $('#log-count');
    if (cnt) cnt.textContent = '기록 ' + logSource().length + '건';
  }

  /* ------------------------------------------------------------- 시트 */
  var sheetOpen = false;
  function openSheet(opts) {
    var s = $('#sheet');
    $('#sheet-inner').innerHTML =
      '<div class="sheet-head"><div style="flex:1"><h3>' + opts.title + '</h3>' +
      (opts.sub ? '<p class="sheet-sub">' + opts.sub + '</p>' : '') + '</div>' +
      '<button class="icon-btn" data-a="close-sheet" aria-label="닫기">' + icon('close') + '</button></div>' +
      '<div class="sheet-body">' + opts.body + '</div>' +
      (opts.foot ? '<div class="sheet-foot">' + opts.foot + '</div>' : '');
    s.classList.add('show');
    $('#scrim').classList.add('show');
    document.body.style.overflow = 'hidden';
    sheetOpen = true;
  }
  function closeSheet() {
    if (!sheetOpen) return;
    $('#sheet').classList.remove('show');
    $('#scrim').classList.remove('show');
    document.body.style.overflow = '';
    sheetOpen = false;
  }

  function protocolSheet(id) {
    var p = protocolsData().filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    openSheet({
      title: (p.emoji || '📌') + ' ' + esc(p.title),
      sub: esc(p.when),
      body:
        '<div class="section-head" style="padding:6px 0 2px"><h2 class="section-title">할 일</h2><span class="section-hint">순서대로</span></div>' +
        (p.steps || []).map(function (s, i) {
          return '<div class="step-line"><span class="n">' + (i + 1) + '</span><span class="t">' + esc(s) + '</span></div>';
        }).join('') +
        '<div class="section-head" style="padding:18px 0 4px"><h2 class="section-title">절대 금지</h2></div>' +
        (p.avoid || []).map(function (a) { return '<div class="avoid-item"><span class="x">✕</span><span>' + esc(a) + '</span></div>'; }).join('') +
        '<div class="section-head" style="padding:18px 0 4px"><h2 class="section-title">그대로 보낼 문장</h2></div>' +
        (p.lines || []).map(function (l) {
          return '<div class="line-card"><div class="lt">' + esc(l) + '</div>' +
            '<div class="lf"><button class="copy-btn" data-a="copy" data-copy="' + encodeURIComponent(l) + '">' + icon('copy') + '복사</button></div></div>';
        }).join('') +
        (p.memo ? '<div class="section-head" style="padding:18px 0 4px"><h2 class="section-title">내 메모</h2></div><div class="notice-pre" style="background:#FFF9E8;border-color:#F5E3B3">' + esc(p.memo) + '</div>' : '') +
        '<div class="section-head" style="padding:18px 0 4px"><h2 class="section-title">링크</h2></div>' +
        (linkChipsHTML(p.links, 'protocol', p.id) || '<p class="card-note">관련 문서·공문 주소를 달아 두세요.</p>') +
        '<div class="hint-box" style="margin-top:18px"><span>📝</span><span><b>기록 기준</b><br>' + esc(p.record || '') + '</span></div>',
      foot: '<button class="btn line" data-a="edit-protocol" data-id="' + esc(p.id) + '">' + icon('pencil') + ' 수정</button>' +
        '<button class="btn line" data-a="open-case-from-protocol" data-id="' + esc(p.id) + '">트래커</button>' +
        '<button class="btn primary" data-a="close-sheet">닫기</button>'
    });
  }

  /* ------------------------------------------------------------- 명단 칩 */
  function chipsFor(cls, target, q) {
    var names = String(target || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var list = rosterOf(cls);
    var qq = String(q || '').trim();
    if (qq) list = list.filter(function (r) { return (r.name + ' ' + r.no).indexOf(qq) >= 0; });
    if (!list.length) {
      return '<div class="roster-empty">' +
        (rosterTotal() ? '이 반 명단이 없습니다.' : '아직 명단이 없습니다.') +
        ' <button class="mini-link" data-a="open-roster">명단 넣기</button></div>';
    }
    var students = list.filter(function (r) { return r.kind === '학생'; });
    var teachers = list.filter(function (r) { return r.kind === '교사'; });
    function chip(r) {
      var on = names.indexOf(r.name) >= 0;
      return '<button class="chip name-chip ' + (on ? 'active' : '') + '" data-a="pick-name" data-n="' + esc(r.name) + '">' +
        (r.kind === '교사' ? '<em>교사</em>' : '') + esc(r.no ? r.no + '. ' : '') + esc(r.name) + '</button>';
    }
    return '<div class="roster-chips">' +
      (students.length ? '<div class="rc-row"><span class="rc-k">학생</span><div class="chips">' + students.map(chip).join('') + '</div></div>' : '') +
      (teachers.length ? '<div class="rc-row"><span class="rc-k">교사</span><div class="chips">' + teachers.map(chip).join('') + '</div></div>' : '') +
      '</div>';
  }

  function caseForm(t) {
    var isNew = !t;
    t = t || { id: '', cls: '1반', type: '민원', urgency: '보통', report: '해당 없음', status: '진행', title: '', target: '', memo: '', next: '', date: todayISO() };
    function opts(arr, sel) {
      return arr.map(function (a) { return '<option' + (a === sel ? ' selected' : '') + '>' + a + '</option>'; }).join('');
    }
    return {
      title: isNew ? '사안 기록' : '사안 수정',
      sub: '민원·특이사항·휴직 인수인계를 남깁니다.',
      body:
        '<div class="field-row"><div class="field"><label>반</label><select class="select" id="f-cls">' + opts(CLASSES, t.cls) + '</select></div>' +
        '<div class="field"><label>유형</label><select class="select" id="f-type">' + opts(D.tracker.types, t.type) + '</select></div></div>' +
        '<div class="field"><label>대상자 <span class="lbl-hint">명단에서 탭</span></label>' +
        '<input class="input" id="f-target" value="' + esc(t.target || '') + '" placeholder="명단 칩을 누르면 들어갑니다. 직접 입력도 됩니다.">' +
        '<input class="input roster-q" id="f-roster-q" placeholder="명단에서 이름 검색">' +
        '<div id="f-roster-wrap">' + chipsFor(t.cls, t.target, '') + '</div></div>' +
        '<div class="field"><label>제목</label><input class="input" id="f-title" placeholder="예: 급식 메뉴 관련 반복 문의" value="' + esc(t.title) + '"></div>' +
        '<div class="field-row-3">' +
        '<div class="field"><label>긴급도</label><select class="select" id="f-urgency">' + opts(D.tracker.urgency, t.urgency) + '</select></div>' +
        '<div class="field"><label>보고</label><select class="select" id="f-report">' + opts(D.tracker.report, t.report) + '</select></div>' +
        '<div class="field"><label>상태</label><select class="select" id="f-status">' + opts(D.tracker.status, t.status) + '</select></div>' +
        '</div>' +
        '<div class="field"><label>내용</label><textarea class="textarea" id="f-memo" placeholder="무슨 일이 있었고, 지금까지 무엇을 했는지. 사실만.">' + esc(t.memo) + '</textarea></div>' +
        '<div class="field"><label>후속조치·다음 할 일</label><textarea class="textarea" id="f-next" style="min-height:70px" placeholder="예: 11/28 학부모 2차 답변 / 담임에게 사실 확인 후 종결">' + esc(t.next || '') + '</textarea></div>' +
        '<div class="hint-box"><span>🔒</span><span>명단은 내 비공개 시트에서만 읽습니다. 공개 저장소에는 이름이 올라가지 않습니다.</span></div>',
      foot: (isNew ? '' : '<button class="btn danger-text" data-a="del-case" data-id="' + t.id + '">' + icon('trash') + '</button>') +
        '<button class="btn line" data-a="close-sheet">취소</button>' +
        '<button class="btn primary" data-a="save-case" data-id="' + t.id + '">저장</button>'
    };
  }

  function openCase(t) {
    openSheet(caseForm(t));
  }

  function saveCase(id) {
    var now = Date.now();
    var data = {
      cls: $('#f-cls').value,
      type: $('#f-type').value,
      urgency: $('#f-urgency').value,
      report: $('#f-report').value,
      status: $('#f-status').value,
      title: $('#f-title').value.trim(),
      target: $('#f-target').value.trim(),
      memo: $('#f-memo').value.trim(),
      next: $('#f-next').value.trim(),
      updatedAt: now
    };
    if (!data.title) { toast('제목을 적어 주세요'); return; }
    var arr = Y().tracker;
    var idx = arr.findIndex(function (x) { return x.id === id && id; });
    if (idx >= 0) Object.assign(arr[idx], data);
    else arr.push(Object.assign({ id: uid(), date: todayISO(), createdAt: now }, data));
    touch();
    closeSheet();
    if (route === 'respond' && respondTab === 'tracker') render();
    toast('저장했어요');
  }

  function delCase(id) {
    var it = Y().tracker.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    it.deleted = true;
    it.updatedAt = Date.now();
    touch();
    closeSheet();
    render();
    toast('삭제했어요');
  }

  function retroForm(r, y) {
    var isNew = !r;
    r = r || { id: '', date: todayISO(), tag: '판단', situation: '', decision: '', result: '', next: '' };
    function opts(arr, sel) {
      return arr.map(function (a) { return '<option' + (a === sel ? ' selected' : '') + '>' + a + '</option>'; }).join('');
    }
    return {
      title: isNew ? '판단 기록' : '기록 수정',
      sub: '다음에 같은 상황이 왔을 때 꺼내 쓸 한 장입니다.' + (y && y !== db.state.year ? ' · ' + y + '학년도' : ''),
      body:
        '<div class="field-row"><div class="field"><label>날짜</label><input class="input" type="date" id="r-date" value="' + esc(r.date) + '"></div>' +
        '<div class="field"><label>태그</label><select class="select" id="r-tag">' + opts(D.retro.tags, r.tag) + '</select></div></div>' +
        '<div class="field"><label>상황</label><textarea class="textarea" id="r-situation" placeholder="누가, 무엇을, 언제 물었나 / 무슨 일이 있었나">' + esc(r.situation) + '</textarea></div>' +
        '<div class="field"><label>내 판단</label><textarea class="textarea" id="r-decision" placeholder="무엇을, 왜 그렇게 했나">' + esc(r.decision) + '</textarea></div>' +
        '<div class="field"><label>결과</label><textarea class="textarea" id="r-result" placeholder="어떻게 됐나 (좋았던 점·아쉬운 점)">' + esc(r.result) + '</textarea></div>' +
        '<div class="field"><label>다음엔 이렇게</label><textarea class="textarea" id="r-next" placeholder="한 줄이면 충분합니다">' + esc(r.next) + '</textarea></div>',
      foot: (isNew ? '' : '<button class="btn danger-text" data-a="del-retro" data-id="' + r.id + '" data-y="' + (y || '') + '">' + icon('trash') + '</button>') +
        '<button class="btn line" data-a="close-sheet">취소</button>' +
        '<button class="btn primary" data-a="save-retro" data-id="' + r.id + '" data-y="' + (y || '') + '">저장</button>'
    };
  }

  function saveRetro(id, y) {
    var now = Date.now();
    var data = {
      date: $('#r-date').value || todayISO(),
      tag: $('#r-tag').value,
      situation: $('#r-situation').value.trim(),
      decision: $('#r-decision').value.trim(),
      result: $('#r-result').value.trim(),
      next: $('#r-next').value.trim(),
      updatedAt: now
    };
    if (!data.situation && !data.decision && !data.next) { toast('한 칸은 적어 주세요'); return; }
    var arr = Yof(y || db.state.year).retro;
    var idx = arr.findIndex(function (x) { return x.id === id && id; });
    if (idx >= 0) Object.assign(arr[idx], data);
    else arr.push(Object.assign({ id: uid(), createdAt: now }, data));
    Yof(y || db.state.year).updatedAt = now;
    touch();
    closeSheet();
    render();
    toast('기록했어요');
  }

  function delRetro(id, y) {
    var arr = Yof(y || db.state.year).retro;
    var it = arr.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    it.deleted = true;
    it.updatedAt = Date.now();
    touch();
    closeSheet();
    render();
    toast('삭제했어요');
  }

  /* ------------------------------------------------------------- 학년도 시트 */
  function yearSheet() {
    var years = db.state.years.slice().sort();
    var nextY = String(parseInt(latestYear(), 10) + 1);
    var cards = years.map(function (y) {
      var yv = Yof(y);
      var n = (yv.tracker || []).filter(function (t) { return !t.deleted; }).length +
        (yv.retro || []).filter(function (r) { return !r.deleted; }).length;
      var on = y === db.state.year;
      var edited = Object.keys(yv.radar || {}).length;
      return '<button class="year-card ' + (on ? 'on' : '') + '" data-a="pick-year" data-y="' + y + '">' +
        '<span class="yc-top"><b>' + y + '</b><span>학년도</span>' + (on ? '<em>지금</em>' : '') + '</span>' +
        '<span class="yc-m">' + esc(yv.role || defaultRole(yv.grade)) + '</span>' +
        '<span class="yc-m">기록 ' + n + '건 · 레이더 수정 ' + edited + '/12달</span>' +
        '</button>';
    }).join('');

    openSheet({
      title: '학년도 · 역할',
      sub: '해를 넘겨도 내가 고친 레이더는 그대로 이어집니다.',
      body:
        '<div class="ygrid">' + cards + '</div>' +
        '<div class="btn-row" style="margin-top:12px">' +
        '<button class="btn line" data-a="new-year-open">' + icon('plus') + ' ' + nextY + '학년도 시작</button>' +
        (years.length > 1 && isPast() ? '<button class="btn line danger-text" data-a="del-year" data-y="' + db.state.year + '">이 학년도 삭제</button>' : '') +
        '</div>' +
        '<div id="year-new" class="year-new"></div>' +

        '<div class="divider"></div>' +
        '<div class="field"><label>역할·직책 이름 <span class="lbl-hint">직접 입력</span></label>' +
        '<div class="role-row"><input class="input" id="s-role" value="' + esc(roleLabel()) + '" placeholder="예: 3학년 부장, 기능부장, 정보부장">' +
        '<button class="btn primary small" data-a="save-role">저장</button></div>' +
        '<p class="card-note">상단 배지와 화면에 이 이름이 표시됩니다. 학년부장이 아니어도 됩니다.</p></div>' +
        '<div class="field"><label>' + esc(yearLabel()) + ' 학년</label>' +
        '<div class="gradestrip">' + GRADES.map(function (g) {
        return '<button class="chip ' + (Y().grade === g ? 'active' : '') + '" data-a="set-grade" data-g="' + g + '">' + g + '학년</button>';
      }).join('') + '</div>' +
        '<p class="card-note">1~6학년 모두 고를 수 있습니다. 학년을 바꾸면 그 학년의 포인트를 따로 적을 수 있고, 레이더는 그대로 편집할 수 있습니다.</p></div>' +
        '<div class="divider"></div>' +
        '<div class="kv"><span class="k">이 학년도 사안</span><span class="v">' + Y().tracker.filter(function (t) { return !t.deleted; }).length + '건</span></div>' +
        '<div class="kv"><span class="k">이 학년도 기록</span><span class="v">' + Y().retro.filter(function (r) { return !r.deleted; }).length + '건</span></div>' +
        '<div class="kv"><span class="k">레이더 직접 수정</span><span class="v">' + Object.keys(Y().radar || {}).length + '달</span></div>' +
        '<div class="kv"><span class="k">명단</span><span class="v">' + rosterTotal() + '명</span></div>' +
        '<div class="btn-row"><button class="btn line small" data-a="open-roster">' + icon('users') + ' 명단 관리</button>' +
        '<button class="btn line small" data-a="settings">설정·동기화</button></div>',
      foot: '<button class="btn line" data-a="close-sheet">닫기</button>'
    });
  }

  function newYearFormHTML() {
    var nextY = String(parseInt(latestYear(), 10) + 1);
    return '<div class="year-form">' +
      '<div class="divider" style="margin:16px 0 6px"></div>' +
      '<div class="field-row">' +
      '<div class="field" style="margin-top:10px"><label>학년도</label><input class="input" id="ny-year" type="number" inputmode="numeric" value="' + nextY + '"></div>' +
      '<div class="field" style="margin-top:10px"><label>학년</label><select class="select" id="ny-grade">' +
      GRADES.map(function (g) { return '<option value="' + g + '"' + (g === Y().grade ? ' selected' : '') + '>' + g + '학년</option>'; }).join('') +
      '</select></div></div>' +
      '<label class="checkline"><input type="checkbox" id="ny-copy" checked><span><b>전년도 레이더 복사</b> — 내가 고친 체크리스트·지뢰·공지 초안</span></label>' +
      '<label class="checkline"><input type="checkbox" id="ny-roster"><span><b>명단도 복사</b> — 이름이 그대로 넘어갑니다(필요할 때만)</span></label>' +
      '<p class="card-note">체크리스트 완료 표시와 사안·기록은 새 학년도에서 <b>비어 있는 상태</b>로 시작합니다. 지난 학년도는 그대로 남아 언제든 볼 수 있습니다.</p>' +
      '<button class="btn primary block" style="margin-top:12px" data-a="create-year">' + nextY + '학년도 시작하기</button>' +
      '</div>';
  }

  function createYear() {
    var y = ($('#ny-year').value || '').trim();
    if (!/^\d{4}$/.test(y)) { toast('학년도를 4자리로 적어 주세요'); return; }
    if (db.state.years.indexOf(y) >= 0) { toast('이미 있는 학년도입니다'); return; }
    var grade = $('#ny-grade').value;
    var copyR = $('#ny-copy').checked;
    var copyRos = $('#ny-roster').checked;
    var prev = Y();
    var ny = blankYear(grade, defaultRole(grade));
    if (copyR) ny.radar = clone(prev.radar || {});
    if (copyRos) ny.roster = clone(prev.roster || []);
    ny.updatedAt = Date.now();
    db.state.byYear[y] = ny;
    db.state.years.push(y);
    db.state.years = uniq(db.state.years).sort();
    db.state.year = y;
    touch();
    closeSheet();
    render();
    toast(y + '학년도를 시작했어요' + (copyR && Object.keys(ny.radar).length ? ' · 내가 고친 레이더 ' + Object.keys(ny.radar).length + '달을 이어받았습니다' : ''));
  }

  function delYear(y) {
    if (y === db.state.year && db.state.years.length <= 1) { toast('학년도는 하나 이상 있어야 합니다'); return; }
    if (!confirm(y + '학년도의 사안·기록·레이더 수정이 함께 지워집니다. 되돌릴 수 없습니다. 계속할까요?')) return;
    delete db.state.byYear[y];
    db.state.years = db.state.years.filter(function (x) { return x !== y; }).sort();
    if (db.state.year === y) db.state.year = latestYear();
    touch();
    closeSheet();
    render();
    toast(y + '학년도를 지웠어요');
  }

  function stepYear(d) {
    var ys = db.state.years.slice().sort();
    var i = ys.indexOf(db.state.year) + d;
    if (i < 0 || i >= ys.length) {
      if (d > 0) { yearSheet(); toast('새 학년도는 학년도 전환기에서 시작하세요'); }
      else toast('이전 학년도가 없습니다');
      return;
    }
    db.state.year = ys[i];
    persist();
    render();
    toast(yearLabel());
  }

  function pickYear(y) {
    if (!db.state.byYear[y]) return;
    db.state.year = y;
    persist();
    closeSheet();
    render();
    toast(y + '학년도');
  }

  /* ------------------------------------------------------------- 명단 시트 */
  function rosterSheet() {
    var counts = {};
    CLASSES.forEach(function (c) { counts[c] = 0; });
    (Y().roster || []).forEach(function (r) { if (counts[r.cls] != null) counts[r.cls]++; });
    var rowsHTML = Object.keys(counts).map(function (c) {
      return '<div class="heat-cell ' + (counts[c] ? 'has2' : '') + '"><div class="hc">' + c.replace('반', '') + '</div><div class="hn">' + counts[c] + '</div></div>';
    }).join('');
    openSheet({
      title: '명단',
      sub: esc(yearLabel()) + ' · 대응 트래커에서 반을 고르면 이 명단이 칩으로 뜹니다.',
      body:
        '<div class="heat" style="margin-top:0">' + rowsHTML + '</div>' +
        '<p class="card-note">구분 · 반 · 번호 · 이름 · 비고 순서입니다. “학년 공통”은 13번째 칸에 표시됩니다.</p>' +
        '<div class="field"><label>시트에서 불러오기</label>' +
        '<button class="btn line block" data-a="roster-fetch">' + icon('down') + ' 시트 ‘명단’ 탭에서 불러오기</button>' +
        '<p class="card-note">' + (db.url ? '연결됨 · 시트의 명단 탭을 읽어 이 학년도에 저장합니다.' : '비공개 시트를 먼저 연결하면 시트의 명단 탭을 그대로 읽어옵니다.') + '</p></div>' +
        '<div class="field"><label>직접 입력 (엑셀·구글시트에서 복사해 붙여넣기)</label>' +
        '<textarea class="textarea" id="ro-paste" style="min-height:150px" placeholder="구분\t반\t번호\t이름\t비고&#10;학생\t3반\t1\t김○○&#10;학생\t3반\t2\t이○○&#10;교사\t3반\t\t박○○\t담임&#10;&#10;이름만 한 줄에 하나씩 넣어도 됩니다."></textarea>' +
        '<div class="segmented mini" style="margin-top:10px" id="ro-mode">' +
        '<button class="active" data-a="ro-mode" data-v="replace">이번 내용으로 바꾸기</button>' +
        '<button data-a="ro-mode" data-v="merge">추가하기</button>' +
        '</div></div>' +
        '<div class="hint-box"><span>🔒</span><span>이름은 <b>이 기기</b>와 <b>내 비공개 시트</b>에만 저장됩니다. 공개 저장소에는 올라가지 않습니다.</span></div>',
      foot: '<button class="btn danger-text" data-a="roster-clear">' + icon('trash') + '</button>' +
        '<button class="btn line" data-a="close-sheet">닫기</button>' +
        '<button class="btn primary" data-a="roster-save">저장</button>'
    });
    rosterMode = 'replace';
  }
  var rosterMode = 'replace';

  function saveRoster() {
    var text = ($('#ro-paste') && $('#ro-paste').value) || '';
    var rows = parseRosterText(text);
    if (!rows.length) { toast('붙여넣은 내용에서 이름을 찾지 못했어요'); return; }
    if (rosterMode === 'merge') {
      Y().roster = normalizeRoster((Y().roster || []).concat(rows));
    } else {
      Y().roster = rows;
    }
    touch();
    closeSheet();
    render();
    toast(rows.length + '명을 ' + (rosterMode === 'merge' ? '추가했어요' : '저장했어요'));
  }

  function fetchRoster() {
    if (!db.url) { toast('먼저 비공개 시트를 연결해 주세요'); return; }
    setSync('busy', '명단 불러오는 중');
    apiGet({ action: 'roster' }).then(function (r) {
      if (!r || !r.ok) { setSync('warn'); toast('명단을 받지 못했어요. 새 Code.gs로 다시 배포했는지 확인해 주세요.'); return; }
      var rows = normalizeRoster(r.roster || []);
      if (!rows.length) { setSync('on'); toast('시트 ‘명단’ 탭이 비어 있어요'); return; }
      Y().roster = rows;
      touch();
      setSync('on');
      closeSheet();
      render();
      toast(rows.length + '명 명단을 불러왔어요');
    }).catch(function () {
      setSync('warn');
      toast('연결 실패 — 주소를 확인해 주세요');
    });
  }

  /* ------------------------------------------------------------- 열린 편집 시트 */
  function prRowHTML(p) {
    return '<div class="erow pro" data-l="principles">' +
      '<input type="hidden" class="pr-id" value="' + esc(p && p.id || '') + '">' +
      '<div class="erow-main">' +
      '<input class="input pr-k" value="' + esc(p && p.k || '') + '" placeholder="원칙 이름 (예: 한 번에)">' +
      '<textarea class="textarea pr-v" style="min-height:56px" placeholder="한두 문장으로">' + esc(p && p.v || '') + '</textarea>' +
      '</div>' +
      '<button class="xbtn" data-a="row-del" aria-label="삭제">' + icon('close') + '</button></div>';
  }

  function principlesEditor() {
    var arr = ensurePrinciples();
    openSheet({
      title: '내 운영 원칙 편집',
      sub: '해가 갈수록 내 문장으로 다듬으세요. 링크는 저장한 뒤 카드에서 달 수 있습니다.',
      body: '<div class="elist" data-l="principles">' + arr.map(prRowHTML).join('') +
        '<button class="addline" data-a="pr-add">＋ 원칙 추가</button></div>' +
        '<div class="hint-box"><span>✍️</span><span>원칙은 홈 카드와 구글 문서 복사에 그대로 들어갑니다.</span></div>',
      foot: '<button class="btn line" data-a="close-sheet">취소</button>' +
        '<button class="btn primary" data-a="save-principles">저장</button>'
    });
  }

  function savePrinciples() {
    var out = [];
    $all('.elist[data-l="principles"] .erow').forEach(function (row) {
      var k = row.querySelector('.pr-k').value.trim();
      var v = row.querySelector('.pr-v').value.trim();
      var id = row.querySelector('.pr-id').value;
      if (!k && !v) return;
      var prev = (Y().principles || []).filter(function (x) { return x.id === id; })[0];
      out.push({ id: id || ('pr' + uid()), k: k, v: v, links: prev ? (prev.links || []) : [] });
    });
    if (!out.length) { toast('원칙을 하나 이상 적어 주세요'); return; }
    Y().principles = out;
    touch(); closeSheet(); render(); toast('운영 원칙을 저장했어요');
  }

  function repRowHTML(gi, it) {
    return '<div class="erow pro" data-l="rep' + gi + '">' +
      '<input type="hidden" class="rp-id" value="' + esc(it && it.id || '') + '">' +
      '<div class="erow-main">' +
      '<input class="input rp-t" value="' + esc(it && it.t || '') + '" placeholder="항목 (예: 학생 안전사고)">' +
      '<textarea class="textarea rp-d" style="min-height:52px" placeholder="어떻게 대응할지">' + esc(it && it.d || '') + '</textarea>' +
      '</div>' +
      '<button class="xbtn" data-a="row-del" aria-label="삭제">' + icon('close') + '</button></div>';
  }

  function reportEditor() {
    var arr = ensureReportLines();
    openSheet({
      title: '보고선 기준표 편집',
      sub: '“누가 답을 정하는가”를 내 기준으로 다듬으세요.',
      body: arr.map(function (g, gi) {
        return '<div class="field" style="margin-top:14px"><label>' + esc(g.level) + ' <span class="lbl-hint">' + esc(g.note) + '</span></label>' +
          '<div class="elist" data-l="rep' + gi + '">' + (g.items || []).map(function (it) { return repRowHTML(gi, it); }).join('') +
          '<button class="addline" data-a="rep-add" data-gi="' + gi + '">＋ 항목 추가</button></div></div>';
      }).join(''),
      foot: '<button class="btn line" data-a="close-sheet">취소</button>' +
        '<button class="btn primary" data-a="save-report">저장</button>'
    });
  }

  function saveReport() {
    var arr = ensureReportLines();
    arr.forEach(function (g, gi) {
      var items = $all('.elist[data-l="rep' + gi + '"] .erow').map(function (row) {
        var id = row.querySelector('.rp-id').value;
        var t = row.querySelector('.rp-t').value.trim();
        var d = row.querySelector('.rp-d').value.trim();
        var prev = (g.items || []).filter(function (x) { return x.id === id; })[0];
        return { id: id || (g.id + '-u' + uid()), t: t, d: d, links: prev ? (prev.links || []) : [] };
      }).filter(function (x) { return x.t; });
      g.items = items;
    });
    touch(); closeSheet(); render(); toast('보고선 기준표를 저장했어요');
  }

  function addRepRow(gi) {
    var box = $('.elist[data-l="rep' + gi + '"]');
    if (!box) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = repRowHTML(gi, { id: '', t: '', d: '' });
    box.insertBefore(wrap.firstElementChild, box.querySelector('.addline'));
    box.querySelectorAll('.erow .rp-t')[box.querySelectorAll('.erow').length - 1].focus();
  }

  function protocolPickSheet() {
    var list = protocolsData();
    openSheet({
      title: '프로토콜 고치기',
      sub: '내 상황에 맞게 할 일·절대 금지·보낼 문장을 다듬으세요.',
      body: list.map(function (p) {
        return '<button class="pick-row" data-a="edit-protocol" data-id="' + esc(p.id) + '">' +
          '<span class="pick-emoji">' + esc(p.emoji || '📌') + '</span>' +
          '<span class="pick-t">' + esc(p.title) + '</span>' +
          '<span class="link-count">' + ((p.links || []).length ? '🔗' + p.links.length : '') + '</span>' +
          '<span class="arrow">' + icon('chevron') + '</span></button>';
      }).join('') +
      '<button class="btn line block" style="margin-top:12px" data-a="new-protocol">＋ 새 프로토콜</button>',
      foot: '<button class="btn line" data-a="close-sheet">닫기</button>'
    });
  }

  function protocolEditor(id) {
    var isNew = !id;
    var p = !isNew ? ensureProtocols().filter(function (x) { return x.id === id; })[0] : null;
    if (!isNew && !p) return;
    p = p || { id: 'up' + uid(), emoji: '📌', title: '', when: '', steps: [], avoid: [], lines: [], record: '', memo: '', links: [] };
    openSheet({
      title: isNew ? '새 프로토콜' : '프로토콜 편집',
      sub: '할 일 → 절대 금지 → 보낼 문장 순서가 현장에서 가장 빠릅니다.',
      body:
        '<div class="field-row"><div class="field" style="margin-top:0"><label>아이콘</label>' +
        '<input class="input" id="pt-emoji" value="' + esc(p.emoji || '📌') + '" maxlength="4"></div>' +
        '<div class="field" style="margin-top:0"><label>제목</label>' +
        '<input class="input" id="pt-title" value="' + esc(p.title || '') + '" placeholder="예: 교무실 예산 문의"></div></div>' +
        '<div class="field"><label>언제 쓰나</label><input class="input" id="pt-when" value="' + esc(p.when || '') + '" placeholder="한 줄 상황 설명"></div>' +
        '<div class="field"><label>할 일</label><div class="elist" data-l="pt-steps">' + listHTML('pt-steps', p.steps, '예: 사실관계를 먼저 확인한다') + '</div></div>' +
        '<div class="field"><label>절대 금지</label><div class="elist" data-l="pt-avoid">' + listHTML('pt-avoid', p.avoid, '예: 그 자리에서 즉답하기') + '</div></div>' +
        '<div class="field"><label>그대로 보낼 문장</label><div class="elist" data-l="pt-lines">' + listHTML('pt-lines', p.lines, '예: 확인해서 ○시까지 안내드리겠습니다.', true) + '</div></div>' +
        '<div class="field"><label>기록 기준</label><textarea class="textarea" id="pt-record" style="min-height:64px">' + esc(p.record || '') + '</textarea></div>' +
        '<div class="field"><label>내 메모</label><textarea class="textarea" id="pt-memo" style="min-height:64px" placeholder="이 상황에서 배운 점">' + esc(p.memo || '') + '</textarea></div>' +
        '<div class="field"><label>링크</label>' + (linkChipsHTML(p.links, null) || '<p class="card-note">링크는 저장한 뒤 프로토콜 화면에서 달 수 있습니다.</p>') + '</div>',
      foot: (isNew ? '' : '<button class="btn danger-text" data-a="del-protocol" data-id="' + esc(p.id) + '">' + icon('trash') + '</button>') +
        '<button class="btn line" data-a="close-sheet">취소</button>' +
        '<button class="btn primary" data-a="save-protocol" data-id="' + esc(p.id) + '">저장</button>'
    });
  }

  function saveProtocol(id) {
    var arr = ensureProtocols();
    var data = {
      emoji: ($('#pt-emoji').value || '📌').trim(),
      title: ($('#pt-title').value || '').trim(),
      when: ($('#pt-when').value || '').trim(),
      steps: readList('pt-steps'),
      avoid: readList('pt-avoid'),
      lines: readList('pt-lines'),
      record: ($('#pt-record').value || '').trim(),
      memo: ($('#pt-memo').value || '').trim()
    };
    if (!data.title) { toast('제목을 적어 주세요'); return; }
    var p = arr.filter(function (x) { return x.id === id; })[0];
    if (p) Object.assign(p, data);
    else arr.push(Object.assign({ id: id || ('up' + uid()), links: [] }, data));
    touch(); closeSheet(); render(); toast('프로토콜을 저장했어요');
  }

  function delProtocol(id) {
    if (!confirm('이 프로토콜을 지울까요? 되돌릴 수 없습니다.')) return;
    Y().protocols = ensureProtocols().filter(function (x) { return x.id !== id; });
    touch(); closeSheet(); render(); toast('지웠어요');
  }

  /* ------------------------------------------------------------- 설정 */
  function settingsSheet() {
    openSheet({
      title: '설정',
      sub: '학년도·역할·명단·동기화를 정합니다.',
      body:
        '<div class="kv"><span class="k">학년도</span><span class="v">' + esc(yearLabel()) + '</span></div>' +
        '<div class="kv"><span class="k">역할·직책</span><span class="v">' + esc(roleLabel()) + '</span></div>' +
        '<div class="kv"><span class="k">학년</span><span class="v">' + Y().grade + '학년</span></div>' +
        '<div class="btn-row"><button class="btn line small" data-a="open-years">학년도·역할 바꾸기</button>' +
        '<button class="btn line small" data-a="open-roster">명단 관리</button></div>' +
        '<div class="divider"></div>' +
        '<div class="field" style="margin-top:0"><label>비공개 시트 연결 (Apps Script 웹 앱 주소)</label>' +
        '<input class="input" id="s-url" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(db.url) + '">' +
        '<p class="card-note">SETUP.md 순서대로 배포하면 주소가 나옵니다. 주소를 아는 사람만 내 데이터에 접근할 수 있으니 공유하지 마세요.</p></div>' +
        '<div class="btn-row"><button class="btn line small" data-a="test-conn">연결 확인</button>' +
        '<button class="btn primary small" data-a="save-url">저장</button></div>' +
        (db.url ? '<p class="card-note">연결되면 시트의 <b>명단</b> 탭도 함께 읽어 옵니다.</p>' : '') +
        '<div class="divider"></div>' +
        '<div class="kv"><span class="k">저장 위치</span><span class="v">' + (db.url ? '내 구글 시트 + 이 기기' : '이 기기만') + '</span></div>' +
        '<div class="kv"><span class="k">학년도 수</span><span class="v">' + db.state.years.length + '개</span></div>' +
        '<div class="kv"><span class="k">명단</span><span class="v">' + rosterTotal() + '명</span></div>' +
        '<div class="kv"><span class="k">사례 기록</span><span class="v">' + Y().retro.filter(function (r) { return !r.deleted; }).length + '건</span></div>' +
        '<div class="kv"><span class="k">트래커</span><span class="v">' + Y().tracker.filter(function (t) { return !t.deleted; }).length + '건</span></div>' +
        '<div class="kv"><span class="k">앱 버전</span><span class="v">' + APP_VERSION + '</span></div>' +
        '<div class="btn-row"><button class="btn line small" data-a="export">JSON 백업</button>' +
        '<button class="btn line small" data-a="open-export">Docs·CSV 내보내기</button></div>' +
        '<div class="hint-box"><span>🔒</span><span>이 앱은 공개 저장소에 개인정보를 담지 않습니다. 기록과 명단은 기기와 내 비공개 시트에만 남습니다.</span></div>',
      foot: '<button class="btn line" data-a="close-sheet">닫기</button>'
    });
  }

  function exportJSON() {
    var blob = new Blob([JSON.stringify(db.state, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'grade-head-os-backup-' + todayISO() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast('백업 파일을 내려받았어요');
  }

  /* ------------------------------------------------------------- 이벤트 */
  document.addEventListener('click', function (e) {
    if (e.target.closest('a[href]')) return;   // 링크는 브라우저가 열게 둡니다
    var el = e.target.closest('[data-a]');
    if (!el) return;
    var a = el.dataset.a;

    if (a === 'nav') {
      route = el.dataset.r;
      if (route === 'respond') respondTab = respondTab || 'protocol';
      render();
      return;
    }
    if (a === 'toggle-q') {
      var k = el.dataset.k;
      Q[k] = Q[k] ? 0 : 1;
      el.classList.toggle('on', !!Q[k]);
      $('#verdict-wrap').innerHTML = verdictHTML();
      return;
    }
    if (a === 'shape') {
      var sk = el.dataset.k;
      SHAPE[sk] = SHAPE[sk] ? 0 : 1;
      el.classList.toggle('on', !!SHAPE[sk]);
      var any = SHAPE.affect || SHAPE.fair || SHAPE.approval || SHAPE.flip;
      var key = (SHAPE.fair || SHAPE.approval || SHAPE.flip) ? 'collect' : 'draft';
      var box = $('#shape-result');
      box.className = 'verdict ' + (any ? D.judge.shapes[key].tone : '');
      box.innerHTML = any ? shapeBlock(key) :
        '<div class="vt"><span>결과</span></div><p class="vtitle">아직 판단 전</p><p class="vsub">하나라도 해당하면 “모아서 정하는 일”입니다.</p>';
      return;
    }
    if (a === 'month') { radarMonth = parseInt(el.dataset.m, 10); render(); return; }
    if (a === 'grade') {
      var oldRole = roleLabel();
      Y().grade = el.dataset.g;
      if (oldRole === defaultRole(GRADES[0]) || GRADES.some(function (g) { return defaultRole(g) === oldRole; })) {
        Y().role = defaultRole(el.dataset.g);
      }
      touch();
      render();
      toast(el.dataset.g + '학년으로 바꿨어요');
      return;
    }
    if (a === 'set-grade') {
      var oldR = roleLabel();
      Y().grade = el.dataset.g;
      if (GRADES.some(function (g) { return defaultRole(g) === oldR; })) Y().role = defaultRole(el.dataset.g);
      touch();
      yearSheet();
      render();
      return;
    }
    if (a === 'check') {
      var g = Y().grade, id = el.dataset.id;
      var key2 = checkKey(g, id);
      var cur = Y().checks[key2];
      var next = !(cur && cur.v);
      Y().checks[key2] = { v: next ? 1 : 0, at: Date.now() };
      el.classList.toggle('on', next);
      touch();
      var card = $('#checks-card');
      if (card) { card.innerHTML = checksCardHTML(); }
      return;
    }
    if (a === 'respond-tab') { respondTab = el.dataset.t; render(); return; }
    if (a === 'protocol') { protocolSheet(el.dataset.id); return; }
    if (a === 'open-case') { openCase(null); return; }
    if (a === 'open-case-from-protocol') {
      closeSheet();
      var p = protocolsData().filter(function (x) { return x.id === el.dataset.id; })[0];
      setTimeout(function () {
        openCase({ cls: '1반', type: p && /민원/.test(p.title) ? '민원' : '특이사항', urgency: '보통', report: /학폭|교권|안전/.test(p && p.title || '') ? '보고 필요' : '해당 없음', status: '진행', title: p ? p.title : '', target: '', memo: '', date: todayISO() });
      }, 220);
      return;
    }
    if (a === 'edit-case') {
      var cid = el.dataset.id;
      var it = Y().tracker.filter(function (x) { return x.id === cid; })[0];
      if (it) openCase(it);
      return;
    }
    if (a === 'save-case') { saveCase(el.dataset.id); return; }
    if (a === 'del-case') { delCase(el.dataset.id); return; }
    if (a === 'pick-name') {
      var inp = $('#f-target');
      if (!inp) return;
      var name = el.dataset.n;
      var names = inp.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var idx = names.indexOf(name);
      if (idx >= 0) names.splice(idx, 1); else names.push(name);
      inp.value = names.join(', ');
      var wrap = $('#f-roster-wrap');
      var q = ($('#f-roster-q') && $('#f-roster-q').value) || '';
      var cls = ($('#f-cls') && $('#f-cls').value) || '';
      if (wrap) wrap.innerHTML = chipsFor(cls, inp.value, q);
      return;
    }
    if (a === 't-filter') {
      var kk = el.dataset.k, vv = el.dataset.v;
      if (kk === 'status') trackerFilter.status = vv;
      if (kk === 'type') trackerFilter.type = vv;
      if (kk === 'report') trackerFilter.reportOnly = !trackerFilter.reportOnly;
      render();
      return;
    }
    if (a === 'open-tracker-filter') {
      trackerFilter = { status: 'all', reportOnly: true, type: 'all' };
      respondTab = 'tracker'; route = 'respond'; render();
      return;
    }
    if (a === 'open-retro') { openSheet(retroForm(null)); return; }
    if (a === 'edit-retro') {
      var rid = el.dataset.id, ry = el.dataset.y || db.state.year;
      var r = Yof(ry).retro.filter(function (x) { return x.id === rid; })[0];
      if (r) openSheet(retroForm(r, ry));
      return;
    }
    if (a === 'save-retro') { saveRetro(el.dataset.id, el.dataset.y); return; }
    if (a === 'del-retro') { delRetro(el.dataset.id, el.dataset.y); return; }
    if (a === 'log-scope') { logScope = el.dataset.v; render(); return; }
    if (a === 'verdict-save') {
      var o = D.quick.outcomes[verdictKey()];
      var answers = D.quick.questions.map(function (q) { return (Q[q.k] ? 'O' : 'X') + ' ' + q.q; }).join(' / ');
      openSheet(retroForm({
        id: '', date: todayISO(), tag: '판단',
        situation: '동학년 질문·민원 접수 → 3초 판단: ' + o.title,
        decision: answers,
        result: '', next: ''
      }));
      return;
    }
    if (a === 'open-protocol') { route = 'respond'; respondTab = 'protocol'; render(); return; }
    if (a === 'edit-links') { linkSheet(el.dataset.kind, el.dataset.k1, el.dataset.k2); return; }
    if (a === 'link-add') {
      var lbox = $('.elist[data-l="links"]');
      if (!lbox) return;
      var lw = document.createElement('div');
      lw.innerHTML = linkRowHTML({ l: '', u: '' });
      lbox.insertBefore(lw.firstElementChild, lbox.querySelector('.addline'));
      return;
    }
    if (a === 'link-save') { saveLinks(); return; }
    if (a === 'open-hub') { hubSheet(); return; }
    if (a === 'hub-add') { hubSheet(true); return; }
    if (a === 'hub-save') { saveHubItem(); return; }
    if (a === 'hub-del') { delHubItem(parseInt(el.dataset.i, 10)); return; }
    if (a === 'hub-tag') {
      hubTag = el.dataset.t;
      $all('#hub-tags .chip').forEach(function (b) { b.classList.toggle('active', b === el); });
      return;
    }
    if (a === 'open-export') { exportSheet(); return; }
    if (a === 'copy-docs') { copyForDocs(); return; }
    if (a === 'csv-radar') { exportCSV('radar'); return; }
    if (a === 'csv-cases') { exportCSV('cases'); return; }
    if (a === 'csv-retro') { exportCSV('retro'); return; }
    if (a === 'edit-principles') { principlesEditor(); return; }
    if (a === 'save-principles') { savePrinciples(); return; }
    if (a === 'pr-add') {
      var pbox = $('.elist[data-l="principles"]');
      if (!pbox) return;
      var pw = document.createElement('div');
      pw.innerHTML = prRowHTML({ id: '', k: '', v: '' });
      pbox.insertBefore(pw.firstElementChild, pbox.querySelector('.addline'));
      return;
    }
    if (a === 'edit-report') { reportEditor(); return; }
    if (a === 'save-report') { saveReport(); return; }
    if (a === 'rep-add') { addRepRow(parseInt(el.dataset.gi, 10)); return; }
    if (a === 'edit-protocol') { protocolEditor(el.dataset.id); return; }
    if (a === 'edit-protocol-list') { protocolPickSheet(); return; }
    if (a === 'new-protocol') { protocolEditor(null); return; }
    if (a === 'save-protocol') { saveProtocol(el.dataset.id); return; }
    if (a === 'del-protocol') { delProtocol(el.dataset.id); return; }
    if (a === 'settings') { settingsSheet(); return; }
    if (a === 'close-sheet') { closeSheet(); return; }
    if (a === 'copy') { copyText(decodeURIComponent(el.dataset.copy)); return; }

    /* 학년도 */
    if (a === 'open-years') { yearSheet(); return; }
    if (a === 'pick-year') { pickYear(el.dataset.y); return; }
    if (a === 'year-step') { stepYear(parseInt(el.dataset.d, 10)); return; }
    if (a === 'year-latest') { db.state.year = latestYear(); persist(); render(); toast(yearLabel()); return; }
    if (a === 'new-year-open') {
      var yn = $('#year-new');
      if (yn) { yn.innerHTML = newYearFormHTML(); yn.scrollIntoView({ block: 'nearest' }); }
      return;
    }
    if (a === 'create-year') { createYear(); return; }
    if (a === 'del-year') { delYear(el.dataset.y); return; }
    if (a === 'save-role') {
      var rv = ($('#s-role').value || '').trim();
      if (!rv) { toast('역할 이름을 적어 주세요'); return; }
      Y().role = rv;
      touch();
      var rt = $('#role-text'); if (rt) rt.textContent = rv;
      toast('역할을 “' + rv + '”(으)로 저장했어요');
      return;
    }

    /* 레이더 편집 */
    if (a === 'radar-edit') { radarEditSheet(parseInt(el.dataset.m, 10)); return; }
    if (a === 'radar-save') { saveRadar(parseInt(el.dataset.m, 10)); return; }
    if (a === 'radar-reset') { resetRadar(parseInt(el.dataset.m, 10)); return; }
    if (a === 'row-add') { addRow(el.dataset.l); return; }
    if (a === 'row-del') {
      var row = el.closest('.erow');
      if (row) row.parentNode.removeChild(row);
      return;
    }

    /* 명단 */
    if (a === 'open-roster') { rosterSheet(); return; }
    if (a === 'ro-mode') {
      rosterMode = el.dataset.v;
      $all('#ro-mode button').forEach(function (b) { b.classList.toggle('active', b.dataset.v === rosterMode); });
      return;
    }
    if (a === 'roster-save') { saveRoster(); return; }
    if (a === 'roster-fetch') { fetchRoster(); return; }
    if (a === 'roster-clear') {
      if (!confirm('이 학년도 명단을 모두 지울까요? 시트의 명단은 그대로 남습니다.')) return;
      Y().roster = [];
      touch();
      closeSheet();
      render();
      toast('명단을 지웠어요');
      return;
    }

    if (a === 'test-conn') {
      var u = $('#s-url').value.trim();
      if (!u) { toast('주소를 먼저 붙여 넣어 주세요'); return; }
      var old = db.url; db.url = u;
      toast('연결 확인 중…');
      apiGet({ action: 'ping' }).then(function (r) {
        if (r && r.ok) {
          toast('연결됐습니다 · ' + (r.app || 'grade-head-os'));
          if (r.sheet) setSync('on');
        } else { toast('응답은 왔지만 앱이 아닙니다'); db.url = old; }
      }).catch(function () { toast('연결 실패 — 주소와 배포 권한을 확인하세요'); db.url = old; });
      return;
    }
    if (a === 'save-url') {
      var u2 = $('#s-url').value.trim();
      db.url = u2;
      persist();
      if (!u2) { setSync('off'); toast('이 기기에만 저장합니다'); return; }
      try { history.replaceState(null, '', '#s=' + btoa(u2)); } catch (e) {}
      setSync('busy', '연결 중…');
      pullState(hasLocalData).then(function () {
        if (hasLocalData) pushState();
        toast('연결됐습니다');
      }).catch(function () { toast('연결 실패 — 주소를 확인해 주세요'); });
      return;
    }
    if (a === 'export') { exportJSON(); return; }
    if (a === 'reset') {
      if (!confirm('이 기기의 기록을 모두 지웁니다. 시트에 저장된 내용은 남습니다. 계속할까요?')) return;
      localStorage.removeItem(LS_KEY);
      db.state = clone(defaults);
      db.rev = '';
      persist();
      closeSheet();
      render();
      toast('기기 데이터를 초기화했어요');
      return;
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.id === 'log-q') {
      logQuery = e.target.value;
      refreshLog();
    }
    if (e.target.id === 'f-roster-q') {
      var wrap = $('#f-roster-wrap');
      var cls = ($('#f-cls') && $('#f-cls').value) || '';
      var target = ($('#f-target') && $('#f-target').value) || '';
      if (wrap) wrap.innerHTML = chipsFor(cls, target, e.target.value);
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target.id === 'time-input') {
      var o = D.quick.outcomes[verdictKey()];
      var label = timeLabel(e.target.value);
      var wrap = $('#verdict-wrap');
      if (wrap) {
        var box = wrap.querySelector('.mtext');
        if (box) box.textContent = o.msg.replace('{time}', label);
        var btn = wrap.querySelector('[data-a="copy"]');
        if (btn) btn.dataset.copy = encodeURIComponent(o.msg.replace('{time}', label));
      }
    }
    if (e.target.id === 'f-cls') {
      var w = $('#f-roster-wrap');
      var t = ($('#f-target') && $('#f-target').value) || '';
      var q = ($('#f-roster-q') && $('#f-roster-q').value) || '';
      if (w) w.innerHTML = chipsFor(e.target.value, t, q);
    }
  });

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  window.addEventListener('scroll', function () {
    var tb = $('#topbar');
    if (tb) tb.classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && db.url) pullState(true).catch(function () {});
  });

  /* ------------------------------------------------------------- 시작 */
  function boot() {
    loadLocal();
    try {
      var m = location.hash.match(/#s=([A-Za-z0-9_\-=+/]+)/);
      if (m) { db.url = atob(m[1]); persist(); }
    } catch (e) { /* 무시 */ }
    radarMonth = new Date().getMonth() + 1;

    document.body.innerHTML = shell();
    render();
    if (db.url) {
      setSync('busy', '불러오는 중');
      pullState(hasLocalData).catch(function () { setSync('warn', '연결 실패 · 기기에 저장'); });
    } else {
      setSync('off');
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 검증 스크립트용 (읽기 전용 노출)
  window.GHApp = { state: function () { return db.state; } };
})();
