/* =========================================================================
   학년부장 OS — app
   ========================================================================= */
(function () {
  'use strict';

  var D = GH.data;
  var LS_KEY = 'grade-head-os.v1';
  var APP_VERSION = '1.0.0';

  /* ------------------------------------------------------------- 상태 */
  var defaults = {
    v: 1,
    grade: '3',
    checks: {},     // 'g-m-i' -> { v: 1|0, at: ms }
    tracker: [],    // { id, cls, type, urgency, report, status, title, memo, date, updatedAt, deleted }
    retro: [],      // { id, date, tag, situation, decision, result, next, updatedAt, deleted }
    verdicts: []    // 판단 기록 (home 카드에서 넘김) — retro로도 저장
  };

  var db = { state: JSON.parse(JSON.stringify(defaults)), rev: '', url: '' };
  var Q = { ground: 0, all: 0, report: 0 };
  var SHAPE = { affect: 0, fair: 0, approval: 0, flip: 0 };
  var route = 'today';
  var radarMonth = new Date().getMonth() + 1;
  var radarGrade = '3';
  var respondTab = 'protocol';
  var trackerFilter = { status: 'all', reportOnly: false, type: 'all' };
  var syncing = false;
  var saveTimer = null;

  var MONTH_TAG = { 2: '준비', 3: '학기초', 4: '현장', 5: '행사', 6: '평가', 7: '마무리', 8: '세팅', 9: '2학기', 10: '나눔', 11: '마감', 12: '인계', 1: '정리' };

  /* ------------------------------------------------------------- 유틸 */
  function $(sel, root) { return (root || document).querySelector(sel); }
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

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tm);
    t._tm = setTimeout(function () { t.classList.remove('show'); }, 1900);
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
        db.state = Object.assign(JSON.parse(JSON.stringify(defaults)), o.state);
        db.rev = o.rev || '';
        db.url = o.url || '';
      }
    } catch (e) { /* 무시 */ }
  }

  function touch() {
    db.state.v = 1;
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
  function apiBase() {
    var u = db.url.trim();
    return u;
  }

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
    el.innerHTML = '<i></i>' + (label || map[mode] || map.off);
  }

  function pushState() {
    if (!db.url || syncing) return;
    syncing = true;
    setSync('busy');
    var baseRev = db.rev;
    apiPost({
      action: 'save', key: 'state', app: 'grade-head-os', version: APP_VERSION,
      baseRev: baseRev, data: db.state
    }).then(function (r) {
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
      // 응답을 읽지 못해도 실제로 저장됐을 수 있다 → 읽기(JSONP)로 확인
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
          db.state = mergeStates(db.state, remote);
          persist();
          if (JSON.stringify(db.state) !== had) render();
        } else {
          db.state = Object.assign(JSON.parse(JSON.stringify(defaults)), remote);
          persist();
          render();
        }
      } else if (!merge) {
        // 원격이 비어 있으면 지금 상태를 올린다
        pushState();
      }
      setSync('on');
    }).catch(function (e) {
      setSync('warn', '연결 실패 · 기기에 저장됨');
      throw e;
    });
  }

  function mergeStates(local, remote) {
    var out = JSON.parse(JSON.stringify(defaults));
    out.grade = local.grade || remote.grade || '3';
    // checks: 키별 최신
    var ck = {};
    [remote.checks || {}, local.checks || {}].forEach(function (obj) {
      Object.keys(obj).forEach(function (k) {
        var a = ck[k], b = obj[k];
        if (!a || (b && b.at > a.at)) ck[k] = b;
      });
    });
    out.checks = ck;
    ['tracker', 'retro', 'verdicts'].forEach(function (name) {
      var map = {};
      (remote[name] || []).concat(local[name] || []).forEach(function (it) {
        if (!it || !it.id) return;
        var prev = map[it.id];
        if (!prev || (it.updatedAt || 0) >= (prev.updatedAt || 0)) map[it.id] = it;
      });
      out[name] = Object.keys(map).map(function (k) { return map[k]; });
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
      trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 13h9.4l.8-13"/>'
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
      '<button class="side-item" data-a="settings">' + icon('gear') + '<span>설정·동기화</span></button>' +
      '<div class="side-rule">오늘의 판단은 기록으로 남고,<br>기록은 다음 학년의 플레이북이 됩니다.</div>' +
      '</div>' +
      '</aside>' +
      '<main class="app-main">' +
      '<header class="topbar" id="topbar"><div class="topbar-in">' +
      '<div class="brand-mini mobile-only"><div class="brand-mark">學</div><div class="brand-name">학년부장 OS</div></div>' +
      '<span class="desk-crumb" id="crumb">오늘</span>' +
      '<div class="topbar-spacer"></div>' +
      '<span class="sync" id="sync-chip"><i></i>기기에만 저장</span>' +
      '<button class="grade-pill" data-a="settings"><span class="dot"></span>' + db.state.grade + '학년</button>' +
      '<button class="icon-btn desktop-only" data-a="settings" aria-label="설정">' + icon('gear') + '</button>' +
      '</div></header>' +
      '<div class="wrap" id="view"></div>' +
      '</main>' +
      '<nav class="tabbar">' + navHtml + '</nav>' +
      '<div class="scrim" id="scrim" data-a="close-sheet"></div>' +
      '<div class="sheet" id="sheet"><div class="sheet-grip"></div><div id="sheet-inner"></div></div>' +
      '<div class="toast" id="toast"></div>';
  }

  /* ------------------------------------------------------------- 렌더 */
  function render() {
    radarGrade = db.state.grade;
    var v = $('#view');
    var views = { today: viewToday, radar: viewRadar, judge: viewJudge, respond: viewRespond, log: viewLog };
    v.innerHTML = '<div class="view">' + (views[route] || viewToday)() + '</div>';
    // nav 상태
    document.querySelectorAll('.tab,.side-item').forEach(function (b) {
      if (b.dataset.r) b.classList.toggle('active', b.dataset.r === route);
    });
    var crumb = $('#crumb');
    if (crumb) crumb.textContent = (NAV.filter(function (n) { return n.r === route; })[0] || { label: '' }).label;
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

  /* ------------------------------------------------------------- 오늘 */
  function viewToday() {
    var now = new Date();
    var m = now.getMonth() + 1;
    var md = D.radar[m];
    var open = db.state.tracker.filter(function (t) { return !t.deleted && t.status !== '종결'; });
    var report = open.filter(function (t) { return t.report === '보고 필요'; });
    var done = 0, total = 0;
    (md.checks || []).forEach(function (_, i) {
      total++;
      var c = db.state.checks[db.state.grade + '-' + m + '-' + i];
      if (c && c.v) done++;
    });
    var recent = db.state.retro.filter(function (r) { return !r.deleted; }).slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }).slice(0, 2);

    return '' +
      '<div class="page-head">' +
      '<p class="page-eyebrow">' + (m) + '월 ' + now.getDate() + '일 ' + weekdayKor(now) + '요일 · ' + db.state.grade + '학년</p>' +
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
      '<h2 class="card-title">' + esc(md ? md.title : '') + '</h2></div>' +
      '<div class="now-list" style="margin-top:2px">' +
      (md ? md.now.map(function (t, i) {
        return '<div class="now-item" style="background:#F7F9FB;color:#333D4B"><span class="num" style="background:#E8F3FF;color:#1B64DA">' + (i + 1) + '</span><span>' + esc(t) + '</span></div>';
      }).join('') : '') +
      '</div>' +
      '<div class="progress-line" style="margin-top:16px">' +
      '<div class="progress-bar"><i style="width:' + (total ? Math.round(done / total * 100) : 0) + '%"></i></div>' +
      '<span class="progress-num">' + done + '/' + total + '</span>' +
      '</div>' +
      '<p class="card-note">이번 달 동학년 체크리스트 진행률입니다.</p>' +
      '<div class="btn-row"><button class="btn small line" data-a="nav" data-r="radar">레이더 열기</button>' +
      '<button class="btn small line" data-a="copy" data-copy="' + encodeURIComponent(md ? noticeOf(md, db.state.grade) : '') + '">' + icon('copy') + ' 공지 복사</button></div>' +
      '</section>' +

      '</div><div class="col">' +

      '<section class="card">' +
      '<div class="card-head"><h2 class="card-title">지금 챙길 것</h2></div>' +
      '<div class="stats">' +
      '<button class="stat red" data-a="nav" data-r="respond"><div class="n">' + open.length + '</div><div class="l">진행 중 사안</div></button>' +
      '<button class="stat blue" data-a="open-tracker-filter" data-f="report"><div class="n">' + report.length + '</div><div class="l">보고 필요</div></button>' +
      '<button class="stat" data-a="nav" data-r="log"><div class="n">' + db.state.retro.filter(function (r) { return !r.deleted; }).length + '</div><div class="l">남긴 기록</div></button>' +
      '</div>' +
      '<p class="card-note">‘진행 중’은 12개 반 민원·특이사항·휴직 인수인계 중 종결되지 않은 건입니다.</p>' +
      '</section>' +

      '<section class="card">' +
      '<div class="card-head"><h2 class="card-title">남긴 판단</h2>' +
      '<span class="topbar-spacer"></span>' +
      '<button class="chip small" data-a="open-retro">+ 쓰기</button></div>' +
      (recent.length ? recent.map(function (r) { return miniLog(r); }).join('') :
        '<p class="card-note" style="margin-top:0">아직 기록이 없습니다. 오늘 판단한 일 하나만 남겨 보세요. 다음에 같은 상황이 왔을 때 훨씬 빨라집니다.</p>') +
      '</section>' +

      '<section class="card card-tight">' +
      '<div class="card-head" style="margin-bottom:8px"><h2 class="card-title" style="font-size:16px">내 운영 원칙</h2></div>' +
      '<div class="chips">' + D.principles.slice(0, 4).map(function (p) { return '<span class="chip ghost small">' + esc(p.k) + '</span>'; }).join('') + '</div>' +
      '<p class="card-note">' + esc(D.principles[0].v) + '</p>' +
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
    return String(d.notice || '').replace('[3학년]', '[' + g + '학년]');
  }

  function viewRadar() {
    var m = radarMonth;
    var d = D.radar[m];
    var g = radarGrade;
    var notice = noticeOf(d, g);
    var done = 0, total = d.checks.length;
    d.checks.forEach(function (_, i) {
      var c = db.state.checks[g + '-' + m + '-' + i];
      if (c && c.v) done++;
    });
    var nowM = new Date().getMonth() + 1;

    return '' +
      '<div class="page-head">' +
      '<p class="page-eyebrow">1년 선제 레이더</p>' +
      '<h1 class="page-title">터지기 전에 미리 뿌리는 것</h1>' +
      '<p class="page-sub">월을 고르면 그 달에 뿌릴 공지·체크리스트·지뢰가 나옵니다.</p>' +
      '</div>' +

      '<div class="segmented" style="margin-bottom:14px">' +
      '<button class="' + (g === '3' ? 'active' : '') + '" data-a="grade" data-g="3">3학년</button>' +
      '<button class="' + (g === '4' ? 'active' : '') + '" data-a="grade" data-g="4">4학년</button>' +
      '</div>' +

      '<div class="month-strip" style="margin-bottom:16px">' +
      D.monthOrder.map(function (mm) {
        return '<button class="mbtn ' + (mm === m ? 'active' : '') + (mm === nowM ? ' now' : '') + '" data-a="month" data-m="' + mm + '">' +
          '<span class="m">' + mm + '월</span><span class="s">' + MONTH_TAG[mm] + '</span></button>';
      }).join('') +
      '</div>' +

      '<div class="month-hero">' +
      '<div class="mh-top"><span>' + m + '월</span><span style="opacity:.6">·</span><span>' + g + '학년</span></div>' +
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
      '<div class="card-head"><span class="card-cap">공지 초안</span></div>' +
      '<h2 class="card-title" style="margin-bottom:12px">그대로 보내는 안내문</h2>' +
      '<div class="notice-pre">' + esc(notice) + '</div>' +
      '<div class="btn-row"><button class="btn primary small" data-a="copy" data-copy="' + encodeURIComponent(notice) + '">' + icon('copy') + ' 공지 복사</button></div>' +
      '<p class="card-note">○ 자리만 학교 일정으로 채우면 됩니다. 보내기 전에 날짜·마감·양식을 한 번 더 확인하세요.</p>' +
      '</section>' +

      '<section class="card">' +
      '<div class="card-head"><span class="card-cap">놓치기 쉬운 지뢰</span></div>' +
      '<h2 class="card-title" style="margin-bottom:8px">이 달에 특히 잘 터지는 것</h2>' +
      d.traps.map(function (t) {
        return '<div class="trap"><div class="ico">⚠️</div><div><div class="tt">' + esc(t.t) + '</div><div class="td">' + esc(t.d) + '</div></div></div>';
      }).join('') +
      '</section>' +

      '<section class="card">' +
      '<div class="card-head"><h2 class="card-title">부장이 직접 챙길 일</h2></div>' +
      '<ul class="plain-list">' + d.me.map(function (t) { return '<li><span class="b"></span><span>' + esc(t) + '</span></li>'; }).join('') + '</ul>' +
      '<div class="grade-note"><div class="g">' + g + '학년</div><p>' + esc(g === '3' ? d.g3 : d.g4) + '</p></div>' +
      '</section>' +

      '<p class="foot-note">학교·교육청 규정과 공문이 항상 우선입니다. 이 레이더는 “미리 챙길 것”을 잊지 않기 위한 기준입니다.</p>';
  }

  function checksCardHTML() {
    var m = radarMonth, g = radarGrade, d = D.radar[m];
    var done = 0;
    var rows = d.checks.map(function (t, i) {
      var c = db.state.checks[g + '-' + m + '-' + i];
      var on = c && c.v;
      if (on) done++;
      return '<button class="check-row ' + (on ? 'on' : '') + '" data-a="check" data-g="' + g + '" data-m="' + m + '" data-i="' + i + '">' +
        '<span class="box">' + icon('check') + '</span><span class="txt">' + esc(t) + '</span></button>';
    }).join('');
    return '' +
      '<div class="card-head"><span class="card-cap">동학년 체크리스트</span><span class="topbar-spacer"></span>' +
      '<span class="progress-num">' + done + '/' + d.checks.length + '</span></div>' +
      '<div class="progress-bar" style="margin-bottom:8px"><i style="width:' + Math.round(done / d.checks.length * 100) + '%"></i></div>' +
      '<div class="check-list">' + rows + '</div>';
  }

  /* ------------------------------------------------------------- 판단 */
  function viewJudge() {
    var J = D.judge;
    var any = SHAPE.affect || SHAPE.fair || SHAPE.approval || SHAPE.flip;
    var shapeKey = (SHAPE.fair || SHAPE.approval || SHAPE.flip) ? 'collect' : 'draft';
    var sh = J.shapes[shapeKey];

    return '' +
      '<div class="page-head">' +
      '<p class="page-eyebrow">판단 · 조율</p>' +
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
      '<div class="verdict ' + (any ? sh.tone : '') + '" id="shape-result">' +
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
      '<div class="card-head"><h2 class="card-title">보고선 기준표</h2></div>' +
      '<p class="card-note" style="margin-top:0">혼자 판단해서 결론을 내리면 책임이 나에게 남습니다. 아래는 “누가 답을 정하는가”의 기준입니다.</p>' +
      J.reportLines.map(function (g) {
        return '<div class="rep-group">' +
          '<div class="rep-head"><span class="tag ' + (g.tone === 'danger' ? 'red' : g.tone === 'warn' ? 'amber' : 'green') + '">' + esc(g.level) + '</span>' +
          '<span class="rep-note">' + esc(g.note) + '</span></div>' +
          g.items.map(function (it) {
            return '<div class="rep-item"><span class="b" style="flex:0 0 5px;width:5px;height:5px;border-radius:50%;background:' +
              (g.tone === 'danger' ? '#F04452' : g.tone === 'warn' ? '#F07C00' : '#0E9F6E') + ';margin-top:9px"></span>' +
              '<div><div class="rt">' + esc(it.t) + '</div><div class="rd">' + esc(it.d) + '</div></div></div>';
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
      '<div class="page-head">' +
      '<p class="page-eyebrow">갈등 · 민원 · 휴직</p>' +
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
    return '<div class="protocol-grid">' +
      D.protocols.map(function (p) {
        return '<button class="pcard" data-a="protocol" data-id="' + p.id + '">' +
          '<span class="emo">' + p.emoji + '</span>' +
          '<span style="flex:1;min-width:0"><span class="pt" style="display:block">' + esc(p.title) + '</span>' +
          '<span class="pw" style="display:block">' + esc(p.when) + '</span></span>' +
          '<span class="arrow">' + icon('chevron') + '</span></button>';
      }).join('') +
      '</div>' +
      '<p class="foot-note">상황이 애매하면 홈의 3초 판단부터. 답을 정하는 문제인지, 시간을 버는 문제인지 먼저 나눕니다.</p>';
  }

  function trackerView() {
    var items = db.state.tracker.filter(function (t) { return !t.deleted; });
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
    D.tracker.classes.forEach(function (c) { counts[c] = 0; });
    open.forEach(function (t) { if (counts[t.cls] != null) counts[t.cls]++; });

    return '' +
      '<div class="stats page" style="margin-bottom:14px">' +
      '<div class="stat red"><div class="n">' + open.length + '</div><div class="l">진행 중</div></div>' +
      '<div class="stat blue"><div class="n">' + open.filter(function (t) { return t.report === '보고 필요'; }).length + '</div><div class="l">보고 필요</div></div>' +
      '<div class="stat green"><div class="n">' + items.filter(function (t) { return t.status === '종결'; }).length + '</div><div class="l">종결</div></div>' +
      '</div>' +

      '<div class="card card-tight" style="padding:16px">' +
      '<div class="card-head" style="margin-bottom:4px"><span class="card-cap">반별 진행 중</span></div>' +
      '<div class="heat">' +
      D.tracker.classes.filter(function (c) { return c !== '학년 공통'; }).map(function (c) {
        return '<div class="heat-cell ' + (counts[c] ? 'has' : '') + '"><div class="hc">' + c.replace('반', '') + '</div><div class="hn">' + counts[c] + '</div></div>';
      }).join('') +
      '</div>' +
      (counts['학년 공통'] ? '<p class="card-note">학년 공통 사안 ' + counts['학년 공통'] + '건이 진행 중입니다.</p>' : '') +
      '</div>' +

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

      (filtered.length ? filtered.map(caseCard).join('') :
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
      (t.memo ? '<div class="case-memo">' + esc(t.memo) + '</div>' : '') +
      (t.next ? '<div style="font-size:13px;color:#1B64DA;font-weight:700;margin-top:5px">→ ' + esc(t.next) + '</div>' : '') +
      '<div class="case-meta"><span>' + esc(t.status) + '</span><span class="sep"></span><span>' + fmtDate(t.date) + '</span></div>' +
      '</button>';
  }

  /* ------------------------------------------------------------- 기록 */
  function viewLog() {
    var items = db.state.retro.filter(function (r) { return !r.deleted; })
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || '') || (b.updatedAt || 0) - (a.updatedAt || 0); });
    return '' +
      '<div class="page-head">' +
      '<p class="page-eyebrow">멘토 회고</p>' +
      '<h1 class="page-title">내가 내린 판단을 남깁니다</h1>' +
      '<p class="page-sub">상황·판단·결과·다음에 바꿀 점. 4줄이면 다음에 같은 일이 와도 빠릅니다.</p>' +
      '</div>' +
      '<button class="btn primary block" data-a="open-retro">' + icon('plus') + ' 오늘 판단 기록하기</button>' +
      '<div class="section-head" style="margin-top:26px"><h2 class="section-title">기록 ' + items.length + '건</h2></div>' +
      (items.length ? items.map(function (r) {
        return '<button class="card log-card" data-a="edit-retro" data-id="' + r.id + '">' +
          '<div class="log-head"><span class="tag ' + tagTone(r.tag) + '">' + esc(r.tag || '기록') + '</span>' +
          '<span class="log-date">' + fmtDate(r.date) + '</span></div>' +
          '<div class="log-body">' +
          (r.situation ? '<div class="log-part"><span class="k">상황</span><span class="v">' + esc(r.situation) + '</span></div>' : '') +
          (r.decision ? '<div class="log-part"><span class="k">내 판단</span><span class="v">' + esc(r.decision) + '</span></div>' : '') +
          (r.result ? '<div class="log-part"><span class="k">결과</span><span class="v">' + esc(r.result) + '</span></div>' : '') +
          (r.next ? '<div class="log-part next"><span class="k">다음엔</span><span class="v">' + esc(r.next) + '</span></div>' : '') +
          '</div></button>';
      }).join('') :
        '<div class="empty"><div class="et">첫 기록을 남겨 보세요</div><div class="ed">거창할 필요 없습니다. “오늘 어떤 질문을 받았고,<br>어떻게 답했고, 다음엔 어떻게 할지” 한 줄씩이면 충분합니다.</div></div>') +
      '<p class="foot-note">기록은 비공개입니다. 연결하면 내 구글 시트에만 저장되고, 공개 저장소에는 아무것도 올라가지 않습니다.</p>';
  }

  function tagTone(tag) {
    return { '판단': 'blue', '민원': 'amber', '갈등': 'red', '업무': 'violet', '보고': 'green', '실수': 'amber' }[tag] || '';
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
    var p = D.protocols.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    openSheet({
      title: p.emoji + ' ' + esc(p.title),
      sub: esc(p.when),
      body:
        '<div class="section-head" style="padding:6px 0 2px"><h2 class="section-title">할 일</h2><span class="section-hint">순서대로</span></div>' +
        p.steps.map(function (s, i) {
          return '<div class="step-line"><span class="n">' + (i + 1) + '</span><span class="t">' + esc(s) + '</span></div>';
        }).join('') +
        '<div class="section-head" style="padding:18px 0 4px"><h2 class="section-title">절대 금지</h2></div>' +
        p.avoid.map(function (a) { return '<div class="avoid-item"><span class="x">✕</span><span>' + esc(a) + '</span></div>'; }).join('') +
        '<div class="section-head" style="padding:18px 0 4px"><h2 class="section-title">그대로 보낼 문장</h2></div>' +
        p.lines.map(function (l, i) {
          return '<div class="line-card"><div class="lt">' + esc(l) + '</div>' +
            '<div class="lf"><button class="copy-btn" data-a="copy" data-copy="' + encodeURIComponent(l) + '">' + icon('copy') + '복사</button></div></div>';
        }).join('') +
        '<div class="hint-box" style="margin-top:18px"><span>📝</span><span><b>기록 기준</b><br>' + esc(p.record) + '</span></div>',
      foot: '<button class="btn line" data-a="close-sheet">닫기</button>' +
        '<button class="btn primary" data-a="open-case-from-protocol" data-id="' + p.id + '">트래커에 남기기</button>'
    });
  }

  function caseForm(t) {
    var isNew = !t;
    t = t || { id: '', cls: '1반', type: '민원', urgency: '보통', report: '해당 없음', status: '진행', title: '', memo: '', date: todayISO() };
    function opts(arr, sel) {
      return arr.map(function (a) { return '<option' + (a === sel ? ' selected' : '') + '>' + a + '</option>'; }).join('');
    }
    return {
      title: isNew ? '사안 기록' : '사안 수정',
      sub: '민원·특이사항·휴직 인수인계를 남깁니다.',
      body:
        '<div class="field-row"><div class="field"><label>반</label><select class="select" id="f-cls">' + opts(D.tracker.classes, t.cls) + '</select></div>' +
        '<div class="field"><label>유형</label><select class="select" id="f-type">' + opts(D.tracker.types, t.type) + '</select></div></div>' +
        '<div class="field"><label>제목</label><input class="input" id="f-title" placeholder="예: 급식 메뉴 관련 반복 문의" value="' + esc(t.title) + '"></div>' +
        '<div class="field-row-3">' +
        '<div class="field"><label>긴급도</label><select class="select" id="f-urgency">' + opts(D.tracker.urgency, t.urgency) + '</select></div>' +
        '<div class="field"><label>보고</label><select class="select" id="f-report">' + opts(D.tracker.report, t.report) + '</select></div>' +
        '<div class="field"><label>상태</label><select class="select" id="f-status">' + opts(D.tracker.status, t.status) + '</select></div>' +
        '</div>' +
        '<div class="field"><label>내용</label><textarea class="textarea" id="f-memo" placeholder="무슨 일이 있었고, 지금까지 무엇을 했는지. 사실만.">' + esc(t.memo) + '</textarea></div>' +
        '<div class="field"><label>후속조치·다음 할 일</label><textarea class="textarea" id="f-next" style="min-height:70px" placeholder="예: 11/28 학부모 2차 답변 / 담임에게 사실 확인 후 종결">' + esc(t.next || '') + '</textarea></div>' +
        '<div class="hint-box"><span>🔒</span><span>학생·학부모 실명은 가급적 쓰지 마세요. “1반 학부모 A”처럼 남기면 충분합니다.</span></div>',
      foot: (isNew ? '' : '<button class="btn danger-text" data-a="del-case" data-id="' + t.id + '">' + icon('trash') + '</button>') +
        '<button class="btn line" data-a="close-sheet">취소</button>' +
        '<button class="btn primary" data-a="save-case" data-id="' + t.id + '">저장</button>'
    };
  }

  function openCase(t) {
    var f = caseForm(t);
    openSheet(f);
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
      memo: $('#f-memo').value.trim(),
      next: $('#f-next').value.trim(),
      updatedAt: now
    };
    if (!data.title) { toast('제목을 적어 주세요'); return; }
    var arr = db.state.tracker;
    var idx = arr.findIndex(function (x) { return x.id === id && id; });
    if (idx >= 0) {
      Object.assign(arr[idx], data);
    } else {
      arr.push(Object.assign({ id: uid(), date: todayISO(), createdAt: now }, data));
    }
    touch();
    closeSheet();
    if (route === 'respond' && respondTab === 'tracker') render();
    toast('저장했어요');
  }

  function delCase(id) {
    var it = db.state.tracker.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    it.deleted = true;
    it.updatedAt = Date.now();
    touch();
    closeSheet();
    render();
    toast('삭제했어요');
  }

  function retroForm(r) {
    var isNew = !r;
    r = r || { id: '', date: todayISO(), tag: '판단', situation: '', decision: '', result: '', next: '' };
    function opts(arr, sel) {
      return arr.map(function (a) { return '<option' + (a === sel ? ' selected' : '') + '>' + a + '</option>'; }).join('');
    }
    return {
      title: isNew ? '판단 기록' : '기록 수정',
      sub: '다음에 같은 상황이 왔을 때 꺼내 쓸 한 장입니다.',
      body:
        '<div class="field-row"><div class="field"><label>날짜</label><input class="input" type="date" id="r-date" value="' + esc(r.date) + '"></div>' +
        '<div class="field"><label>태그</label><select class="select" id="r-tag">' + opts(D.retro.tags, r.tag) + '</select></div></div>' +
        '<div class="field"><label>상황</label><textarea class="textarea" id="r-situation" placeholder="누가, 무엇을, 언제 물었나 / 무슨 일이 있었나">' + esc(r.situation) + '</textarea></div>' +
        '<div class="field"><label>내 판단</label><textarea class="textarea" id="r-decision" placeholder="무엇을, 왜 그렇게 했나">' + esc(r.decision) + '</textarea></div>' +
        '<div class="field"><label>결과</label><textarea class="textarea" id="r-result" placeholder="어떻게 됐나 (좋았던 점·아쉬운 점)">' + esc(r.result) + '</textarea></div>' +
        '<div class="field"><label>다음엔 이렇게</label><textarea class="textarea" id="r-next" placeholder="한 줄이면 충분합니다">' + esc(r.next) + '</textarea></div>',
      foot: (isNew ? '' : '<button class="btn danger-text" data-a="del-retro" data-id="' + r.id + '">' + icon('trash') + '</button>') +
        '<button class="btn line" data-a="close-sheet">취소</button>' +
        '<button class="btn primary" data-a="save-retro" data-id="' + r.id + '">저장</button>'
    };
  }

  function saveRetro(id) {
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
    var arr = db.state.retro;
    var idx = arr.findIndex(function (x) { return x.id === id && id; });
    if (idx >= 0) Object.assign(arr[idx], data);
    else arr.push(Object.assign({ id: uid(), createdAt: now }, data));
    touch();
    closeSheet();
    render();
    toast('기록했어요');
  }

  function delRetro(id) {
    var it = db.state.retro.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    it.deleted = true;
    it.updatedAt = Date.now();
    touch();
    closeSheet();
    render();
    toast('삭제했어요');
  }

  function settingsSheet() {
    openSheet({
      title: '설정',
      sub: '학년과 동기화를 정합니다.',
      body:
        '<div class="field"><label>올해 학년</label><select class="select" id="s-grade">' +
        ['3', '4'].map(function (g) { return '<option value="' + g + '"' + (db.state.grade === g ? ' selected' : '') + '>' + g + '학년</option>'; }).join('') +
        '</select></div>' +
        '<div class="divider"></div>' +
        '<div class="field" style="margin-top:0"><label>비공개 시트 연결 (Apps Script 웹 앱 주소)</label>' +
        '<input class="input" id="s-url" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(db.url) + '">' +
        '<p class="card-note">SETUP.md 순서대로 배포하면 주소가 나옵니다. 주소를 아는 사람만 내 데이터에 접근할 수 있으니 공유하지 마세요.</p></div>' +
        '<div class="btn-row"><button class="btn line small" data-a="test-conn">연결 확인</button>' +
        '<button class="btn primary small" data-a="save-url">저장</button></div>' +
        '<div class="divider"></div>' +
        '<div class="kv"><span class="k">저장 위치</span><span class="v">' + (db.url ? '내 구글 시트 + 이 기기' : '이 기기만') + '</span></div>' +
        '<div class="kv"><span class="k">사례 기록</span><span class="v">' + db.state.retro.filter(function (r) { return !r.deleted; }).length + '건</span></div>' +
        '<div class="kv"><span class="k">트래커</span><span class="v">' + db.state.tracker.filter(function (t) { return !t.deleted; }).length + '건</span></div>' +
        '<div class="kv"><span class="k">앱 버전</span><span class="v">' + APP_VERSION + '</span></div>' +
        '<div class="btn-row"><button class="btn line small" data-a="export">JSON 백업</button>' +
        '<button class="btn line small" data-a="reset">기기 데이터 초기화</button></div>' +
        '<div class="hint-box"><span>🔒</span><span>이 앱은 공개 저장소에 개인정보를 담지 않습니다. 기록은 기기와 내 비공개 시트에만 남습니다.</span></div>',
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
      radarGrade = el.dataset.g;
      db.state.grade = radarGrade;
      touch();
      render();
      return;
    }
    if (a === 'check') {
      var g = el.dataset.g, m = el.dataset.m, i = el.dataset.i;
      var key2 = g + '-' + m + '-' + i;
      var cur = db.state.checks[key2];
      var next = !(cur && cur.v);
      db.state.checks[key2] = { v: next ? 1 : 0, at: Date.now() };
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
      var p = D.protocols.filter(function (x) { return x.id === el.dataset.id; })[0];
      setTimeout(function () {
        openCase({ cls: '1반', type: p && /민원/.test(p.title) ? '민원' : '특이사항', urgency: '보통', report: /학폭|교권|안전/.test(p && p.title || '') ? '보고 필요' : '해당 없음', status: '진행', title: p ? p.title : '', memo: '', date: todayISO() });
      }, 220);
      return;
    }
    if (a === 'edit-case') {
      var cid = el.dataset.id;
      var it = db.state.tracker.filter(function (x) { return x.id === cid; })[0];
      if (it) openCase(it);
      return;
    }
    if (a === 'save-case') { saveCase(el.dataset.id); return; }
    if (a === 'del-case') { delCase(el.dataset.id); return; }
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
      var rid = el.dataset.id;
      var r = db.state.retro.filter(function (x) { return x.id === rid; })[0];
      if (r) openSheet(retroForm(r));
      return;
    }
    if (a === 'save-retro') { saveRetro(el.dataset.id); return; }
    if (a === 'del-retro') { delRetro(el.dataset.id); return; }
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
    if (a === 'settings') { settingsSheet(); return; }
    if (a === 'close-sheet') { closeSheet(); return; }
    if (a === 'copy') { copyText(decodeURIComponent(el.dataset.copy)); return; }
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
      db.state = JSON.parse(JSON.stringify(defaults));
      db.rev = '';
      persist();
      closeSheet();
      render();
      toast('기기 데이터를 초기화했어요');
      return;
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
    if (e.target.id === 's-grade') {
      db.state.grade = e.target.value;
      radarGrade = e.target.value;
      touch();
      closeSheet();
      render();
      toast(e.target.value + '학년으로 설정했어요');
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
    // 주소창에 실린 연결 주소(#s=base64) 우선
    try {
      var m = location.hash.match(/#s=([A-Za-z0-9_\-=+/]+)/);
      if (m) { db.url = atob(m[1]); persist(); }
    } catch (e) { /* 무시 */ }
    radarGrade = db.state.grade;
    radarMonth = new Date().getMonth() + 1;

    document.body.innerHTML = shell();

    render();
    if (db.url) {
      setSync('busy', '불러오는 중');
      pullState(hasLocalData).catch(function () { setSync('warn', '연결 실패 · 기기에 저장'); });
    } else {
      setSync('off');
    }
    // 서비스 워커
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
