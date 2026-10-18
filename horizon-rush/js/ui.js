/**
 * Horizon Rush · 极速地平线
 * ui.js —— HUD 与全屏界面（UI 负责人）
 *
 * 契约：ARCHITECTURE.md 第 6 节。
 *   HR.UI = { init(rootEl, handlers), showScreen(screen, data), hideScreens(),
 *             updateHUD(hud), toast(text, ms?), isBlocking() }
 *
 * 规则：
 *   - 经典脚本（非 ES Module），无外部资源、无顶层副作用（只定义 HR.UI）。
 *   - 只读取 HR.CARS / HR.EVENTS / HR.DIFFICULTIES / HR.CONTROLS / HR.HINTS /
 *     HR.CHAMP / HR.DEFAULT_SETTINGS / HR.SETTING_ENUMS / HR.FREE_TRACK 等公开数据。
 *   - 不引用 renderer / audio / game 内部对象；所有 handler 通过安全方式调用。
 *   - HUD 容器 pointer-events: none；只有全屏菜单面板拦截鼠标。
 *   - updateHUD 只在首帧建 DOM，之后仅更新 textContent / style / class。
 */
window.HR = window.HR || {};

HR.UI = (function () {
  'use strict';

  /* =========================================================================
   * 0. 常量
   * ========================================================================= */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var STANDING_ROWS = 8;
  var HINT_INTERVAL_MS = 6200;
  var TOAST_DEFAULT_MS = 2200;
  var MINIMAP_W = 440;
  var MINIMAP_H = 300;
  var MINIMAP_PAD = 30;

  var BLOCKING_SCREENS = {
    title: true,
    events: true,
    cars: true,
    settings: true,
    results: true,
    champ: true,
    pause: true,
    help: true,
    loading: true
  };

  var WEATHER_CN = { clear: '晴天', dawn: '黎明', dusk: '黄昏', night: '夜晚', rain: '暴雨' };
  var CAMERA_CN = { chase: '追尾', hood: '引擎盖', trackside: '路侧机位', heli: '航拍' };
  var CAMERA_ORDER = ['chase', 'hood', 'trackside', 'heli'];
  var MODE_CN = { race: '快速比赛', champ: '冠军赛', spectate: 'AI 观战', free: '自由驾驶', timetrial: '计时赛' };

  /** 5 条属性条定义（与 config.js 的 spec.stats 对应） */
  var STAT_DEFS = [
    { key: 'topSpeed', label: '极速', max: 380, min: 0, mode: 'speed' },
    { key: 'accel', label: '加速', max: 8.5, min: 2.0, invert: true, mode: 'accel' },
    { key: 'handling', label: '操控', max: 1, min: 0, mode: 'ratio' },
    { key: 'braking', label: '制动', max: 1, min: 0, mode: 'ratio' },
    { key: 'nitro', label: '氮气', max: 1, min: 0, mode: 'ratio' }
  ];

  /** results 界面 actions → 文案 / 回调 */
  var RESULT_ACTIONS = {
    again: { label: '再跑一次', cls: 'hr-btn--primary', run: function () { safeCall('onRaceAgain'); } },
    next: { label: '下一站', cls: 'hr-btn--primary', run: function () { safeCall('onNextEvent'); } },
    title: { label: '返回标题', cls: 'hr-btn--ghost', run: function () { safeCall('onTitle'); } },
    garage: {
      label: '车辆与赛事',
      cls: 'hr-btn--ghost',
      run: function () { safeCall('onOpenEvents', 'champ'); }
    }
  };

  /* =========================================================================
   * 1. 运行时状态（全部在 init 时初始化，无顶层副作用）
   * ========================================================================= */
  var state = {
    inited: false,
    root: null,
    hudRoot: null,
    screensRoot: null,
    toastRoot: null,
    handlers: {},
    screen: null,
    screenData: null,
    loading: null,
    hud: null,
    minimap: null,
    hintIdx: 0,
    hintNextAt: 0
  };

  /* =========================================================================
   * 2. 基础工具（全部防御式，永不抛错）
   * ========================================================================= */
  function arr(v) {
    return Array.isArray(v) ? v : [];
  }

  function clamp(v, lo, hi) {
    v = Number(v);
    if (!isFinite(v)) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function num(v, fallback) {
    if (typeof v === 'number' && isFinite(v)) return v;
    return fallback == null ? 0 : fallback;
  }

  function str(v, fallback) {
    if (v == null || v === '') return fallback == null ? '' : fallback;
    return String(v);
  }

  function pickNumber() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return null;
  }

  function findById(list, id) {
    var items = arr(list);
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].id === id) return items[i];
    }
    return null;
  }

  function extend(base, patch) {
    var out = {};
    var k;
    if (base && typeof base === 'object') {
      for (k in base) {
        if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
      }
    }
    if (patch && typeof patch === 'object') {
      for (k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k];
      }
    }
    return out;
  }

  function nowMs() {
    try {
      if (window.performance && typeof window.performance.now === 'function') {
        return window.performance.now();
      }
    } catch (e) { /* ignore */ }
    return Date.now();
  }

  /* ---------- 文本 / 时间 / 数字格式化 ---------- */
  function fmtTime(sec) {
    try {
      if (HR.Util && typeof HR.Util.formatTime === 'function') return HR.Util.formatTime(sec);
    } catch (e) { /* ignore */ }
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '--:--';
    var ms = Math.round(sec * 1000);
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var r = ms % 1000;
    if (m > 0) {
      return m + ':' + (s < 10 ? '0' : '') + s + '.' +
        (r < 100 ? '0' : '') + (r < 10 ? '0' : '') + r;
    }
    return s + '.' + (r < 100 ? '0' : '') + (r < 10 ? '0' : '') + r;
  }

  function fmtDelta(d) {
    if (typeof d !== 'number' || !isFinite(d)) return '--';
    return (d >= 0 ? '+' : '-') + Math.abs(d).toFixed(3);
  }

  function fmtTimeOrText(v) {
    if (typeof v === 'number' && isFinite(v)) return fmtTime(v);
    if (typeof v === 'string' && v) return v;
    return '--:--';
  }

  function gapText(gap) {
    if (typeof gap === 'number' && isFinite(gap)) {
      return Math.abs(gap) < 0.0005 ? '—' : fmtDelta(gap);
    }
    if (typeof gap === 'string' && gap) return gap;
    return '—';
  }

  function fmtCredits(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fmtInt(n, fallback) {
    if (typeof n === 'number' && isFinite(n)) return String(Math.round(n));
    return fallback == null ? '--' : fallback;
  }

  function speedOf(vMs, units) {
    var v = (typeof vMs === 'number' && isFinite(vMs) ? vMs : 0) * 3.6;
    return Math.round(units === 'mph' ? v / 1.609344 : v);
  }

  function unitLabel(units) {
    return units === 'mph' ? 'MPH' : 'KM/H';
  }

  function pad2(n) {
    n = Math.round(num(n, 0));
    return (n < 10 ? '0' : '') + n;
  }

  function clockText(t) {
    var total = num(t, 12);
    var hh = Math.floor(total);
    var mm = Math.round((total - hh) * 60);
    if (mm >= 60) { mm -= 60; hh += 1; }
    if (hh >= 24) hh -= 24;
    return pad2(hh) + ':' + pad2(mm);
  }

  function eventDifficultyName(id) {
    var d = findById(HR.DIFFICULTIES, id);
    return d ? str(d.name, str(id, '职业')) : str(id, '职业');
  }

  function validDifficulty(id) {
    if (findById(HR.DIFFICULTIES, id)) return id;
    var def = HR.DEFAULT_SETTINGS && HR.DEFAULT_SETTINGS.difficulty;
    if (findById(HR.DIFFICULTIES, def)) return def;
    var first = arr(HR.DIFFICULTIES)[0];
    return first ? first.id : 'pro';
  }

  /* ---------- 记录读取（兼容 number / object / game 的 records map） ---------- */
  function readBestLap(rec) {
    if (typeof rec === 'number' && isFinite(rec) && rec > 0) return rec;
    if (rec && typeof rec === 'object') {
      var v = pickNumber(rec.bestLap, rec.bestLapTime, rec.best, rec.time, rec.lapTime);
      if (v != null && v > 0) return v;
    }
    return null;
  }

  function bestLapTextOf(rec) {
    if (rec && typeof rec === 'object') {
      if (typeof rec.bestLapText === 'string' && rec.bestLapText && rec.bestLapText !== '--' &&
          rec.bestLapText !== '--:--') {
        return rec.bestLapText;
      }
    }
    var v = readBestLap(rec);
    return v == null ? null : fmtTime(v);
  }

  /* ---------- 冠军赛进度判断（兼容 game.js 的 { index, total } 等形态） ---------- */
  function arrayHasId(list, id) {
    var items = arr(list);
    for (var i = 0; i < items.length; i++) {
      var e = items[i];
      if (e === id) return true;
      if (e && typeof e === 'object' && e.id === id) return true;
    }
    return false;
  }

  function isEventDone(progress, id, index) {
    if (progress == null) return false;
    if (typeof progress === 'number' && isFinite(progress)) return index < progress;
    if (Array.isArray(progress)) {
      if (arrayHasId(progress, id)) return true;
      return progress.length > index && progress[index] != null && progress[index] !== false && progress[index] !== '';
    }
    if (typeof progress === 'object') {
      if (arrayHasId(progress.completed, id) || arrayHasId(progress.done, id) ||
          arrayHasId(progress.events, id) || arrayHasId(progress.results, id)) {
        return true;
      }
      if (progress[id] != null && progress[id] !== false) return true;
      var idx = pickNumber(progress.index, progress.completed, progress.done, progress.progress);
      if (idx != null) return index < idx;
      if (typeof progress.completedCount === 'number') return index < progress.completedCount;
    }
    return false;
  }

  function champDoneCount(progress, events) {
    var list = arr(events);
    var count = 0;
    for (var i = 0; i < list.length; i++) {
      if (isEventDone(progress, list[i] && list[i].id, i)) count++;
    }
    return count;
  }

  /* ---------- 车辆 / 赛事解析 ---------- */
  function resolveCar(item) {
    if (item == null) return null;
    if (typeof item === 'string') return findById(HR.CARS, item);
    if (typeof item === 'object') {
      if (item.stats && item.id) return item;
      if (item.carId) return findById(HR.CARS, item.carId);
      if (item.id) return findById(HR.CARS, item.id) || item;
    }
    return null;
  }

  function resolveCars(list) {
    var out = [];
    var raw = arr(list);
    for (var i = 0; i < raw.length; i++) {
      var car = resolveCar(raw[i]);
      if (car && !findById(out, car.id)) out.push(car);
    }
    if (!out.length) out = arr(HR.CARS).slice();
    return out;
  }

  function carColor(car) {
    if (car && typeof car.color === 'string' && car.color) return car.color;
    return '#7b5cff';
  }

  function carAccent(car) {
    if (car && typeof car.accent === 'string' && car.accent) return car.accent;
    return carColor(car);
  }

  function resolveEvent(data) {
    data = data || {};
    var ev = data.event;
    if (ev && typeof ev === 'object') {
      var base = findById(HR.EVENTS, ev.id) || {};
      return extend(base, ev);
    }
    if (typeof ev === 'string') {
      return findById(HR.EVENTS, ev) || { id: ev, name: ev };
    }
    var eid = data.eventId;
    if (eid) {
      var found = findById(HR.EVENTS, eid);
      if (found) return found;
    }
    return null;
  }

  function mapRaceMode(mode) {
    var m = str(mode, 'race');
    if (m === 'champ') return 'champ';
    if (m === 'spectate') return 'spectate';
    if (m === 'free') return 'free';
    return 'race';
  }

  function statValue(car, def) {
    var stats = car && car.stats ? car.stats : {};
    return stats[def.key];
  }

  function statRatio(car, def) {
    var v = statValue(car, def);
    if (typeof v !== 'number' || !isFinite(v)) return 0;
    var r;
    if (def.invert) {
      r = (def.max - v) / Math.max(0.0001, def.max - def.min);
    } else {
      r = v / Math.max(0.0001, def.max);
    }
    return clamp(r, 0.04, 1);
  }

  function statText(car, def) {
    var v = statValue(car, def);
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    if (def.mode === 'speed') return Math.round(v) + ' km/h';
    if (def.mode === 'accel') return v.toFixed(1) + ' s';
    return String(Math.round(clamp(v, 0, 1) * 100));
  }

  function toSegItems(list, onlyIds) {
    var out = [];
    var raw = arr(list);
    if (onlyIds) {
      for (var k = 0; k < onlyIds.length; k++) {
        var found = findById(raw, onlyIds[k]);
        if (found) out.push({ id: found.id, name: str(found.name, found.id) });
        else out.push({ id: onlyIds[k], name: String(onlyIds[k]) });
      }
      return out;
    }
    for (var i = 0; i < raw.length; i++) {
      var it = raw[i];
      if (it == null) continue;
      if (typeof it === 'string') out.push({ id: it, name: it });
      else out.push({ id: it.id != null ? it.id : String(it), name: str(it.name, str(it.id, '')) });
    }
    return out;
  }

  /* =========================================================================
   * 3. DOM 工具（带写入缓存，每帧不重复写相同值）
   * ========================================================================= */
  function el(tag, cls, text) {
    var node = document.createElement(tag || 'div');
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) node.setAttribute(k, attrs[k]);
      }
    }
    return node;
  }

  function add(parent, child) {
    if (parent && child) parent.appendChild(child);
    return child;
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setText(node, text) {
    if (!node) return;
    var s = text == null ? '' : String(text);
    if (node.__hrText === s) return;
    node.__hrText = s;
    node.textContent = s;
  }

  function setStyle(node, prop, value) {
    if (!node || !node.style) return;
    var key = '__hrStyle_' + prop;
    if (node[key] === value) return;
    node[key] = value;
    try { node.style[prop] = value; } catch (e) { /* ignore */ }
  }

  function setWidth(node, pct) {
    if (!node) return;
    var v = Math.round(clamp(pct, 0, 100) * 10) / 10;
    if (node.__hrWidth === v) return;
    node.__hrWidth = v;
    node.style.width = v + '%';
  }

  function setClass(node, cls, on) {
    if (!node || !node.classList) return;
    node.classList.toggle(cls, !!on);
  }

  function setHidden(node, hidden) {
    if (!node || !node.classList) return;
    var v = !!hidden;
    if (node.__hrHidden === v) return;
    node.__hrHidden = v;
    node.classList.toggle('hr-hidden', v);
  }

  /* =========================================================================
   * 4. handler 安全调用
   * ========================================================================= */
  function warn(name, e) {
    try {
      if (window.console && typeof console.warn === 'function') {
        console.warn('[HR.UI] ' + name + ' 调用失败：', e);
      }
    } catch (err) { /* ignore */ }
  }

  function hasHandler(name) {
    var hs = state.handlers;
    return !!(hs && typeof hs[name] === 'function');
  }

  function safeCall(name) {
    var hs = state.handlers;
    if (!hs) return;
    var fn = hs[name];
    if (typeof fn !== 'function') return;
    var args = Array.prototype.slice.call(arguments, 1);
    try {
      fn.apply(null, args);
    } catch (e) {
      warn(name, e);
    }
  }

  function safeQuitToTitle() {
    if (hasHandler('onTitle')) safeCall('onTitle');
    else safeCall('onQuitToTitle');
  }

  /* =========================================================================
   * 5. 通用界面组件
   * ========================================================================= */
  function makeHeader(title, kicker, buttons) {
    var head = el('div', 'hr-screen-head');
    var left = el('div', 'hr-screen-head-left');
    add(left, el('div', 'hr-screen-kicker', kicker || 'HORIZON RUSH'));
    add(left, el('h2', 'hr-screen-title', title));
    add(head, left);
    if (buttons && buttons.length) {
      var right = el('div', 'hr-screen-head-right');
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i]) right.appendChild(buttons[i]);
      }
      add(head, right);
    }
    return head;
  }

  function button(label, opts) {
    opts = opts || {};
    var btn = el('button', 'hr-btn' + (opts.cls ? ' ' + opts.cls : ''), label);
    btn.type = 'button';
    if (opts.disabled) {
      btn.disabled = true;
      btn.classList.add('is-disabled');
    }
    if (typeof opts.onClick === 'function') {
      btn.addEventListener('click', function (ev) {
        try {
          if (ev && ev.preventDefault) ev.preventDefault();
        } catch (e) { /* ignore */ }
        if (btn.disabled) return;
        try {
          opts.onClick(ev);
        } catch (e) {
          warn('button', e);
        }
      });
    }
    return btn;
  }

  function backButton(onClick) {
    return button('← 返回', {
      cls: 'hr-btn--ghost hr-btn--back',
      onClick: onClick || function () { safeCall('onTitle'); }
    });
  }

  function groupCard(title, kicker) {
    var card = el('section', 'hr-group');
    var head = el('div', 'hr-group-head');
    add(head, el('span', 'hr-group-title', title));
    if (kicker) add(head, el('span', 'hr-group-kicker', kicker));
    add(card, head);
    return card;
  }

  function segmented(items, current, onChange) {
    var wrap = el('div', 'hr-seg');
    var list = arr(items);
    var btns = [];
    var activeId = current;

    function setActive(id) {
      activeId = id;
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('is-active', btns[i].__hrId === id);
      }
    }

    for (var i = 0; i < list.length; i++) {
      (function (item) {
        var btn = el('button', 'hr-seg-btn' + (item.id === activeId ? ' is-active' : ''), item.name);
        btn.type = 'button';
        btn.__hrId = item.id;
        btn.addEventListener('click', function () {
          setActive(item.id);
          try {
            onChange(item.id);
          } catch (e) {
            warn('segmented', e);
          }
        });
        btns.push(btn);
        wrap.appendChild(btn);
      })(list[i]);
    }
    wrap.__hrSetActive = setActive;
    return wrap;
  }

  function toggleRow(label, desc, checked, onChange) {
    var row = el('label', 'hr-toggle-row');
    add(row, el('span', 'hr-toggle-label', label));
    if (desc) add(row, el('span', 'hr-toggle-desc', desc));
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'hr-toggle-input';
    input.checked = !!checked;
    var track = el('span', 'hr-toggle-track');
    add(track, el('span', 'hr-toggle-knob'));
    row.classList.toggle('is-on', !!checked);
    input.addEventListener('change', function () {
      row.classList.toggle('is-on', input.checked);
      try {
        onChange(!!input.checked);
      } catch (e) {
        warn('toggle', e);
      }
    });
    add(row, input);
    add(row, track);
    return row;
  }

  function settingRow(label, control, desc) {
    var row = el('div', 'hr-setting-row');
    var left = el('div', 'hr-setting-label');
    add(left, el('span', 'hr-setting-name', label));
    if (desc) add(left, el('span', 'hr-setting-desc', desc));
    var right = el('div', 'hr-setting-control');
    add(right, control);
    add(row, left);
    add(row, right);
    return row;
  }

  function statRow(label, text, ratio) {
    var row = el('div', 'hr-stat-row');
    add(row, el('span', 'hr-stat-label', label));
    var track = el('div', 'hr-stat-track');
    var fill = add(track, el('div', 'hr-stat-fill'));
    fill.style.width = (clamp(ratio, 0, 1) * 100).toFixed(1) + '%';
    add(row, track);
    add(row, el('span', 'hr-stat-value', text));
    return row;
  }

  function metaItem(parent, label, value, cls) {
    var item = el('span', 'hr-meta-item');
    add(item, el('span', 'hr-meta-label', label));
    add(item, el('span', 'hr-meta-value' + (cls ? ' ' + cls : ''), value));
    add(parent, item);
    return item;
  }

  function screenShell(name) {
    var panel = el('div', 'hr-screen hr-screen--' + name);
    var inner = el('div', 'hr-screen-inner');
    panel.appendChild(inner);
    return { panel: panel, inner: inner };
  }

  /* =========================================================================
   * 6. 生命周期 API
   * ========================================================================= */
  function init(rootEl, handlers) {
    var root = rootEl;
    if (!root || !root.appendChild) {
      try { root = document.getElementById('ui-root'); } catch (e) { root = null; }
    }
    if (!root || !root.appendChild) return false;

    state.root = root;
    state.handlers = handlers && typeof handlers === 'object' ? handlers : {};
    state.inited = true;
    state.screen = null;
    state.screenData = null;
    state.loading = null;
    state.hud = null;
    state.minimap = null;
    state.hintIdx = 0;
    state.hintNextAt = 0;

    clear(root);

    var hudRoot = el('div', 'hr-hud');
    hudRoot.id = 'hud';
    var screensRoot = el('div', 'hr-screens');
    screensRoot.id = 'screens';
    var toastRoot = el('div', 'hr-toasts');

    root.appendChild(hudRoot);
    root.appendChild(screensRoot);
    root.appendChild(toastRoot);

    state.hudRoot = hudRoot;
    state.screensRoot = screensRoot;
    state.toastRoot = toastRoot;
    setHudVisible(false);
    return true;
  }

  function hideScreens() {
    if (!state.inited) return;
    if (state.screensRoot) clear(state.screensRoot);
    state.screen = null;
    state.screenData = null;
    state.loading = null;
    setHudVisible(true);
  }

  /** 全屏菜单打开时隐藏 HUD（暂停例外：保留 HUD 作为背景信息层） */
  function setHudVisible(visible) {
    if (!state.hudRoot || !state.hudRoot.classList) return;
    state.hudRoot.classList.toggle('hr-hud--off', !visible);
  }

  function isBlocking() {
    return !!(state.screen && BLOCKING_SCREENS[state.screen]);
  }

  function showScreen(screen, data) {
    if (!state.inited || !state.screensRoot) return;
    data = data && typeof data === 'object' ? data : {};
    var name = str(screen, '');

    if (!name || name === 'spectate') {
      hideScreens();
      return;
    }

    // loading 是高频刷新界面：同屏时只更新进度，不重建 DOM
    if (name === 'loading') {
      if (state.screen === 'loading' && state.loading) {
        state.screenData = data;
        updateLoading(data);
        return;
      }
    }

    var prev = state.screen;
    state.screen = name;
    state.screenData = data;
    state.loading = null;
    setHudVisible(name === 'pause');
    clear(state.screensRoot);

    var shell = screenShell(name);
    state.screensRoot.appendChild(shell.panel);

    try {
      switch (name) {
        case 'title': buildTitle(shell.inner, data); break;
        case 'events': buildEvents(shell.inner, data); break;
        case 'cars': buildCars(shell.inner, data); break;
        case 'settings': buildSettings(shell.inner, data); break;
        case 'results': buildResults(shell.inner, data); break;
        case 'champ': buildChamp(shell.inner, data); break;
        case 'pause': buildPause(shell.inner, data); break;
        case 'help': buildHelp(shell.inner, data); break;
        case 'loading': buildLoading(shell.inner, data); break;
        default: buildUnknown(shell.inner, name); break;
      }
    } catch (e) {
      warn('screen:' + name + (prev ? '（上一屏 ' + prev + '）' : ''), e);
      clear(shell.inner);
      add(shell.inner, el('div', 'hr-screen-error', '界面渲染出错：' + (e && e.message ? e.message : '未知错误')));
    }
  }

  function toast(text, ms) {
    if (!state.inited || !state.toastRoot) return;
    var msg = str(text, '');
    if (!msg) return;
    var node = el('div', 'hr-toast', msg);
    state.toastRoot.appendChild(node);
    while (state.toastRoot.childNodes.length > 3) {
      state.toastRoot.removeChild(state.toastRoot.firstChild);
    }
    var life = (typeof ms === 'number' && ms > 200) ? ms : TOAST_DEFAULT_MS;
    function enter() {
      try { node.classList.add('is-in'); } catch (e) { /* ignore */ }
    }
    function leave() {
      try { node.classList.remove('is-in'); } catch (e) { /* ignore */ }
      try {
        window.setTimeout(function () {
          if (node.parentNode) node.parentNode.removeChild(node);
        }, 280);
      } catch (e) {
        if (node.parentNode) node.parentNode.removeChild(node);
      }
    }
    try {
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(enter);
      else enter();
      window.setTimeout(leave, life);
    } catch (e) {
      enter();
    }
  }

  /* =========================================================================
   * 7. 全屏界面：title
   * ========================================================================= */
  function buildTitle(inner, data) {
    var records = data && data.records && typeof data.records === 'object' ? data.records : null;
    var wrap = el('div', 'hr-title');

    var logo = el('div', 'hr-logo');
    var logoMain = el('div', 'hr-logo-main');
    add(logoMain, el('span', 'hr-logo-word', 'HORIZON'));
    add(logoMain, el('span', 'hr-logo-word hr-logo-word--accent', 'RUSH'));
    add(logo, logoMain);
    add(logo, el('div', 'hr-logo-cn', '极速地平线'));
    add(logo, el('div', 'hr-logo-sub', 'OPEN ROAD RACING · 开放公路竞速'));
    add(wrap, logo);

    var menu = el('div', 'hr-title-menu');
    var items = [
      {
        label: '快速比赛',
        desc: '四场赛事任选，立即发车',
        primary: true,
        run: function () {
          if (hasHandler('onQuickRace')) safeCall('onQuickRace');
          else safeCall('onOpenEvents', 'quick');
        }
      },
      {
        label: '冠军赛',
        desc: '四站积分赛，加冕地平线冠军',
        primary: true,
        run: function () {
          if (hasHandler('onChampionship')) safeCall('onChampionship');
          else safeCall('onOpenEvents', 'champ');
        }
      },
      { label: 'AI 观战', desc: '八位 AI 车手混战，随时接管', run: function () { safeCall('onSpectate'); } },
      { label: '自由驾驶', desc: '无排名，沿环岛公路自由探索', run: function () { safeCall('onFreeRoam'); } },
      { label: '设置', desc: '音量 / 画面 / 操控偏好', run: function () { safeCall('onSettings'); } },
      { label: '操作说明', desc: '按键、玩法与 AI 模式说明', run: function () { safeCall('onHelp'); } }
    ];
    for (var i = 0; i < items.length; i++) {
      menu.appendChild(titleMenuButton(items[i]));
    }
    add(wrap, menu);

    add(wrap, buildRecordsCard(records));

    var foot = el('div', 'hr-title-foot');
    add(foot, el('span', 'hr-version', 'v' + str(HR.VERSION, '1.0.0')));
    add(foot, el('span', 'hr-title-foot-dot', '·'));
    add(foot, el('span', 'hr-title-foot-text', '纯 Canvas 渲染 · 零外部资源'));
    add(wrap, foot);

    inner.appendChild(wrap);
  }

  function titleMenuButton(item) {
    var btn = el('button', 'hr-title-btn' + (item.primary ? ' hr-title-btn--primary' : ''));
    btn.type = 'button';
    var main = el('span', 'hr-title-btn-main');
    add(main, el('span', 'hr-title-btn-label', item.label));
    if (item.desc) add(main, el('span', 'hr-title-btn-desc', item.desc));
    add(btn, main);
    add(btn, el('span', 'hr-title-btn-arrow', '›'));
    btn.addEventListener('click', function () {
      try {
        item.run();
      } catch (e) {
        warn('title-menu', e);
      }
    });
    return btn;
  }

  function buildRecordsCard(records) {
    var card = el('div', 'hr-records');
    add(card, el('div', 'hr-records-title', '车手档案'));
    var grid = el('div', 'hr-records-grid');
    var r = records || {};

    var bestText = '--';
    if (typeof r.bestLapText === 'string' && r.bestLapText) bestText = r.bestLapText;
    else if (typeof r.bestLap === 'number' && r.bestLap > 0) bestText = fmtTime(r.bestLap);

    var credits = pickNumber(r.credits, r.cash);
    var races = pickNumber(r.races);
    var wins = pickNumber(r.wins);
    var champs = pickNumber(r.championships, r.champWins);

    var cells = [
      { label: '最佳圈速', value: bestText },
      { label: '累计奖金', value: fmtCredits(credits == null ? 0 : credits) + ' CR' },
      { label: '比赛场次', value: fmtInt(races == null ? 0 : races) },
      { label: '冠军头衔', value: fmtInt(champs == null ? 0 : champs) }
    ];
    for (var i = 0; i < cells.length; i++) {
      var cell = el('div', 'hr-records-cell');
      add(cell, el('span', 'hr-records-value', cells[i].value));
      add(cell, el('span', 'hr-records-label', cells[i].label));
      add(grid, cell);
    }
    if (wins != null) {
      var winsCell = el('div', 'hr-records-cell hr-records-cell--extra');
      add(winsCell, el('span', 'hr-records-value', fmtInt(wins)));
      add(winsCell, el('span', 'hr-records-label', '获胜场次'));
      add(grid, winsCell);
    }
    add(card, grid);
    return card;
  }

  /* =========================================================================
   * 8. 全屏界面：events
   * ========================================================================= */
  function buildEvents(inner, data) {
    data = data || {};
    var mode = data.mode === 'champ' ? 'champ' : 'quick';
    var events = arr(data.events).length ? arr(data.events) : arr(HR.EVENTS);
    var bestMap = data.bestRecords && typeof data.bestRecords === 'object' ? data.bestRecords : {};
    var progress = data.champProgress;
    var wrap = el('div', 'hr-page hr-events');

    var kicker = mode === 'champ' ? 'CHAMPIONSHIP' : 'QUICK RACE';
    var title = mode === 'champ' ? '地平线冠军赛' : '快速比赛';
    add(wrap, makeHeader(title, kicker, [backButton()]));

    var desc = mode === 'champ' && HR.CHAMP && HR.CHAMP.desc
      ? str(HR.CHAMP.desc)
      : '选择一站赛事发车。每站的圈数、天气与难度各不相同，刷新你在每条赛道上的最佳圈速。';
    add(wrap, el('p', 'hr-screen-desc', desc));

    if (mode === 'champ') {
      var done = champDoneCount(progress, events);
      var progLine = el('div', 'hr-champ-progress');
      add(progLine, el('span', 'hr-champ-progress-label', '冠军赛进度'));
      add(progLine, el('span', 'hr-champ-progress-value', '已完成 ' + done + ' / ' + events.length + ' 站'));
      if (progress && typeof progress.points === 'number' && isFinite(progress.points)) {
        add(progLine, el('span', 'hr-champ-progress-points', '当前积分 ' + Math.round(progress.points)));
      }
      add(wrap, progLine);
    }

    var grid = el('div', 'hr-event-grid');
    for (var i = 0; i < events.length; i++) {
      grid.appendChild(buildEventCard(events[i], i, bestMap, progress, mode));
    }
    if (!events.length) add(grid, el('div', 'hr-empty-state', '暂无赛事数据'));
    add(wrap, grid);

    inner.appendChild(wrap);
  }

  function buildEventCard(ev, index, bestMap, progress, mode) {
    ev = ev || {};
    var evId = str(ev.id, 'e' + (index + 1));
    var done = mode === 'champ' && isEventDone(progress, evId, index);
    var best = bestLapTextOf(bestMap[evId]);

    var card = el('button', 'hr-event-card' + (done ? ' is-done' : ''));
    card.type = 'button';
    add(card, el('span', 'hr-event-accent'));

    var top = el('span', 'hr-event-top');
    var titles = el('span', 'hr-event-titles');
    add(titles, el('span', 'hr-event-name', str(ev.name, evId)));
    if (ev.subtitle) add(titles, el('span', 'hr-event-subtitle', str(ev.subtitle)));
    add(top, titles);
    if (done) add(top, el('span', 'hr-event-done-tag', '已完赛'));
    add(card, top);

    if (ev.desc) add(card, el('span', 'hr-event-desc', str(ev.desc)));

    var meta = el('span', 'hr-event-meta');
    var laps = num(ev.laps, 3);
    metaItem(meta, '圈数', laps > 0 ? Math.round(laps) + ' 圈' : '自由驾驶');
    if (ev.track && typeof ev.track.lengthKm === 'number') {
      metaItem(meta, '赛道', ev.track.lengthKm.toFixed(1) + ' km');
    }
    metaItem(meta, '时间', clockText(ev.timeOfDay));
    metaItem(meta, '天气', WEATHER_CN[ev.weather] || '晴天');
    metaItem(meta, '难度', eventDifficultyName(ev.difficulty));
    if (typeof ev.reward === 'number' && ev.reward > 0) {
      metaItem(meta, '奖励', fmtCredits(ev.reward) + ' CR');
    }
    metaItem(meta, '最佳圈速', best == null ? '暂无记录' : best, best == null ? '' : 'hr-meta-value--good');
    add(card, meta);

    add(card, el('span', 'hr-event-cta', done ? '再战一场 ›' : '选择赛事 ›'));

    card.addEventListener('click', function () {
      safeCall('onSelectEvent', evId);
    });
    return card;
  }

  /* =========================================================================
   * 9. 全屏界面：cars（车库 / 选车）
   * ========================================================================= */
  function buildCars(inner, data) {
    data = data || {};
    var mode = str(data.mode, 'quick');
    var isSpectate = mode === 'spectate';
    var cars = resolveCars(data.cars);
    var event = resolveEvent(data);
    var selectedId = str(data.selectedCarId, '');
    var selected = findById(cars, selectedId) || cars[0] || null;
    var diffList = arr(data.difficultyList).length ? arr(data.difficultyList) : arr(HR.DIFFICULTIES);
    var difficulty = validDifficulty(data.difficulty);
    var autopilot = !!data.autopilot;
    var record = data.record || null;

    var wrap = el('div', 'hr-page hr-garage');

    var headTitle = isSpectate
      ? 'AI 观战 · 选择镜头车辆'
      : (mode === 'champ'
        ? '冠军赛 · 选择赛车'
        : (mode === 'free' ? '自由驾驶 · 选择赛车' : '快速比赛 · 选择赛车'));
    var headKicker = isSpectate ? 'AI BATTLE' : (mode === 'free' ? 'FREE ROAM' : 'SELECT YOUR RIDE');
    add(wrap, makeHeader(headTitle, headKicker, [backButton(function () {
      if (mode === 'champ') safeCall('onOpenEvents', 'champ');
      else if (mode === 'race' || mode === 'quick') safeCall('onOpenEvents', 'quick');
      else safeCall('onTitle');
    })]));

    add(wrap, buildEventBar(event, mode, record));

    var layout = el('div', 'hr-garage-layout');
    var grid = el('div', 'hr-car-grid');
    var detail = el('div', 'hr-car-detail');
    var cards = [];

    for (var i = 0; i < cars.length; i++) {
      (function (car) {
        var card = buildCarCard(car, selected && car.id === selected.id);
        card.addEventListener('click', function () {
          selectCar(car.id);
        });
        cards.push({ car: car, node: card });
        grid.appendChild(card);
      })(cars[i]);
    }
    if (!cars.length) add(grid, el('div', 'hr-empty-state', '暂无车辆数据'));
    add(layout, grid);
    add(layout, detail);
    add(wrap, layout);

    fillCarDetail(detail, selected, record);

    /* ---- 底部：难度 / 自动驾驶 / 开始 ---- */
    var footer = el('div', 'hr-garage-foot');

    var diffOption = el('div', 'hr-garage-option');
    add(diffOption, el('div', 'hr-option-label', '难度'));
    var diffSeg = segmented(toSegItems(diffList), difficulty, function (id) {
      difficulty = id;
      safeCall('onSettingsChange', { difficulty: id });
    });
    add(diffOption, diffSeg);
    add(footer, diffOption);

    if (!isSpectate) {
      var autoOption = el('div', 'hr-garage-option hr-garage-option--toggle');
      add(autoOption, el('div', 'hr-option-label', '自动驾驶'));
      add(autoOption, toggleRow(
        '让 AI 驾驶你的赛车',
        '比赛中随时按 H 接管',
        autopilot,
        function (v) {
          autopilot = !!v;
          // 同步到设置，避免「切换车辆后开关被重置」
          safeCall('onSettingsChange', { autopilot: !!v });
        }
      ));
      add(footer, autoOption);
    }

    var startLabel = isSpectate ? '开始 AI 大战' : (mode === 'free' ? '开始自由驾驶' : '开始比赛');
    var startBtn = button(startLabel, {
      cls: 'hr-btn--primary hr-btn--start',
      onClick: function () { startRace(); }
    });
    add(footer, startBtn);
    add(wrap, footer);

    inner.appendChild(wrap);

    /* ---- 内部函数（闭包共享当前选择） ---- */
    function selectCar(carId) {
      var car = findById(cars, carId);
      if (!car) return;
      selected = car;
      for (var k = 0; k < cards.length; k++) {
        cards[k].node.classList.toggle('is-selected', cards[k].car.id === carId);
      }
      fillCarDetail(detail, car, record);
      safeCall('onSelectCar', carId);
    }

    function startRace() {
      if (!selected) {
        toast('请先选择一辆赛车');
        return;
      }
      var opts = {
        eventId: event && event.id ? event.id : (data.eventId || null),
        carId: selected.id,
        difficulty: difficulty,
        mode: mapRaceMode(mode),
        autopilot: isSpectate ? false : !!autopilot
      };
      safeCall('onStartRace', opts);
    }
  }

  function buildEventBar(event, mode, record) {
    var bar = el('div', 'hr-event-bar');
    if (!event) {
      var free = HR.FREE_TRACK || {};
      var mainFree = el('div', 'hr-event-bar-main');
      add(mainFree, el('div', 'hr-event-bar-kicker', 'FREE ROAM'));
      add(mainFree, el('div', 'hr-event-bar-name', str(free.name, '自由驾驶')));
      add(mainFree, el('div', 'hr-event-bar-meta', '无排名 · 自由探索 · 按 Esc 暂停'));
      add(bar, mainFree);
      return bar;
    }
    var main = el('div', 'hr-event-bar-main');
    add(main, el('div', 'hr-event-bar-kicker', str(event.subtitle, mode === 'champ' ? 'CHAMPIONSHIP' : 'EVENT')));
    add(main, el('div', 'hr-event-bar-name', str(event.name, event.id)));
    var bits = [];
    var laps = num(event.laps, 3);
    bits.push(laps > 0 ? Math.round(laps) + ' 圈' : '自由驾驶');
    if (event.track && typeof event.track.lengthKm === 'number') {
      bits.push(event.track.lengthKm.toFixed(1) + ' km');
    }
    bits.push(WEATHER_CN[event.weather] || '晴天');
    bits.push(clockText(event.timeOfDay));
    bits.push('难度 ' + eventDifficultyName(event.difficulty));
    add(main, el('div', 'hr-event-bar-meta', bits.join(' · ')));
    add(bar, main);

    var side = el('div', 'hr-event-bar-side');
    add(side, el('div', 'hr-event-bar-best-label', '本赛事最佳圈速'));
    var best = bestLapTextOf(record);
    add(side, el('div', 'hr-event-bar-best', best == null ? '--:--' : best));
    add(bar, side);
    return bar;
  }

  function buildCarCard(car, isSelected) {
    var card = el('button', 'hr-car-card' + (isSelected ? ' is-selected' : ''));
    card.type = 'button';
    card.style.setProperty('--car-color', carColor(car));
    card.style.setProperty('--car-accent', carAccent(car));

    var top = el('span', 'hr-car-card-top');
    add(top, el('span', 'hr-car-brand', str(car.brand, 'HORIZON')));
    add(top, el('span', 'hr-car-cls', str(car.cls, '—')));
    add(card, top);

    add(card, el('span', 'hr-car-name', str(car.name, car.id)));
    if (car.driver) add(card, el('span', 'hr-car-driver', str(car.driver)));

    var pi = el('span', 'hr-car-pi');
    add(pi, el('span', 'hr-car-pi-value', fmtInt(car.pi, '—')));
    add(pi, el('span', 'hr-car-pi-label', 'PI'));
    add(card, pi);

    var mini = el('span', 'hr-car-mini-stats');
    for (var i = 0; i < STAT_DEFS.length; i++) {
      var def = STAT_DEFS[i];
      var stat = el('span', 'hr-mini-stat');
      var track = el('span', 'hr-mini-stat-track');
      var fill = el('span', 'hr-mini-stat-fill');
      fill.style.width = (statRatio(car, def) * 100).toFixed(1) + '%';
      add(track, fill);
      add(stat, track);
      add(mini, stat);
    }
    add(card, mini);
    return card;
  }

  function fillCarDetail(container, car, record) {
    if (!container) return;
    clear(container);
    if (!car) {
      add(container, el('div', 'hr-empty-state', '暂无车辆数据'));
      return;
    }
    var brand = el('div', 'hr-detail-brand');
    add(brand, el('span', 'hr-detail-brand-name', str(car.brand, 'HORIZON')));
    add(brand, el('span', 'hr-detail-class', str(car.cls, '—')));
    add(container, brand);

    var head = el('div', 'hr-detail-head');
    add(head, el('h3', 'hr-detail-name', str(car.name, car.id)));
    var pi = el('div', 'hr-detail-pi');
    add(pi, el('span', 'hr-detail-pi-value', fmtInt(car.pi, '—')));
    add(pi, el('span', 'hr-detail-pi-label', 'PI'));
    add(head, pi);
    add(container, head);

    if (car.desc) add(container, el('p', 'hr-detail-desc', str(car.desc)));

    var tags = el('div', 'hr-detail-tags');
    if (car.ai && car.ai.tag) add(tags, el('span', 'hr-tag hr-tag--ai', 'AI 风格 · ' + car.ai.tag));
    if (car.driver) add(tags, el('span', 'hr-tag', '车手 · ' + car.driver));
    if (car.body) add(tags, el('span', 'hr-tag hr-tag--ghost', String(car.body).toUpperCase()));
    add(container, tags);

    var stats = el('div', 'hr-detail-stats');
    for (var i = 0; i < STAT_DEFS.length; i++) {
      var def = STAT_DEFS[i];
      add(stats, statRow(def.label, statText(car, def), statRatio(car, def)));
    }
    add(container, stats);

    var best = bestLapTextOf(record);
    if (best != null) add(container, el('div', 'hr-detail-record', '本赛事最佳圈速 · ' + best));
  }

  /* =========================================================================
   * 10. 全屏界面：settings
   * ========================================================================= */
  function buildSettings(inner, data) {
    data = data || {};
    var settings = extend(HR.DEFAULT_SETTINGS || {}, data.settings || {});
    var wrap = el('div', 'hr-page hr-settings');
    add(wrap, makeHeader('设置', 'SETTINGS', [backButton()]));

    var body = el('div', 'hr-settings-body');

    /* ---- 音频 ---- */
    var audioGroup = groupCard('音频', 'AUDIO');

    var volRow = el('div', 'hr-setting-row');
    var volLeft = el('div', 'hr-setting-label');
    add(volLeft, el('span', 'hr-setting-name', '主音量'));
    add(volLeft, el('span', 'hr-setting-desc', '引擎、音乐与音效的总音量'));
    var volCtrl = el('div', 'hr-setting-control hr-volume');
    var slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'hr-slider';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(Math.round(clamp(settings.volume, 0, 1) * 100));
    var volVal = el('span', 'hr-volume-value', slider.value + '%');
    slider.addEventListener('input', function () {
      setText(volVal, Math.round(clamp(parseInt(slider.value, 10) || 0, 0, 100)) + '%');
    });
    slider.addEventListener('change', function () {
      var v = clamp((parseInt(slider.value, 10) || 0) / 100, 0, 1);
      settings.volume = v;
      setText(volVal, Math.round(v * 100) + '%');
      safeCall('onSettingsChange', { volume: v });
    });
    add(volCtrl, slider);
    add(volCtrl, volVal);
    add(volRow, volLeft);
    add(volRow, volCtrl);
    add(audioGroup, volRow);

    add(audioGroup, toggleRow('背景音乐', '程序化合成和弦循环', settings.music !== false, function (v) {
      settings.music = !!v;
      safeCall('onSettingsChange', { music: !!v });
    }));
    add(audioGroup, toggleRow('音效', '引擎、胎噪、碰撞与界面音效', settings.sfx !== false, function (v) {
      settings.sfx = !!v;
      safeCall('onSettingsChange', { sfx: !!v });
    }));
    add(body, audioGroup);

    /* ---- 画面与界面 ---- */
    var displayGroup = groupCard('画面与界面', 'DISPLAY');
    add(displayGroup, settingRow('画质', segmented([
      { id: 'low', name: '低' },
      { id: 'medium', name: '中' },
      { id: 'high', name: '高' }
    ], settings.quality, function (id) {
      settings.quality = id;
      safeCall('onSettingsChange', { quality: id });
    }), '低画质提升帧率'));
    add(displayGroup, settingRow('速度单位', segmented([
      { id: 'kmh', name: 'km/h' },
      { id: 'mph', name: 'mph' }
    ], settings.units, function (id) {
      settings.units = id;
      safeCall('onSettingsChange', { units: id });
    })));
    add(displayGroup, toggleRow('显示提示', 'HUD 底部操作提示与赛事提示', settings.showHints !== false, function (v) {
      settings.showHints = !!v;
      safeCall('onSettingsChange', { showHints: !!v });
    }));
    add(body, displayGroup);

    /* ---- 驾驶 ---- */
    var driveGroup = groupCard('驾驶', 'DRIVING');
    add(driveGroup, settingRow('默认视角', segmented([
      { id: 'chase', name: '追尾' },
      { id: 'hood', name: '引擎盖' }
    ], settings.camera, function (id) {
      settings.camera = id;
      safeCall('onSettingsChange', { camera: id });
    })));
    add(driveGroup, settingRow('默认难度', segmented(toSegItems(arr(HR.DIFFICULTIES)), settings.difficulty, function (id) {
      settings.difficulty = id;
      safeCall('onSettingsChange', { difficulty: id });
    }), 'AI 的驾驶水平'));
    add(body, driveGroup);

    add(wrap, body);
    inner.appendChild(wrap);
  }

  /* =========================================================================
   * 11. 全屏界面：results
   * ========================================================================= */
  function buildResults(inner, data) {
    data = data || {};
    var rows = arr(data.rows);
    var actions = arr(data.actions).length ? arr(data.actions) : ['again', 'title'];
    var mode = str(data.mode, 'race');
    var isChamp = mode === 'champ';

    var wrap = el('div', 'hr-page hr-results');

    /* ---- 头部 ---- */
    var hero = el('div', 'hr-result-hero');
    add(hero, el('div', 'hr-result-kicker', str(data.eventName, 'HORIZON RUSH')));
    add(hero, el('h2', 'hr-result-title', str(data.title, '比赛结束')));
    var subBits = [];
    if (data.trackName) subBits.push(str(data.trackName));
    if (typeof data.laps === 'number' && data.laps > 0) subBits.push(Math.round(data.laps) + ' 圈');
    if (subBits.length) add(hero, el('div', 'hr-result-sub', subBits.join(' · ')));

    var playerPlace = pickNumber(data.playerPlace);
    if (playerPlace == null) {
      for (var pi2 = 0; pi2 < rows.length; pi2++) {
        if (rows[pi2] && rows[pi2].isPlayer) {
          playerPlace = pickNumber(rows[pi2].place);
          break;
        }
      }
    }
    if (playerPlace != null && playerPlace > 0) {
      var placeBox = el('div', 'hr-result-place');
      add(placeBox, el('span', 'hr-result-place-num', 'P' + Math.round(playerPlace)));
      add(placeBox, el('span', 'hr-result-place-label', '你的名次'));
      add(hero, placeBox);
    }
    add(wrap, hero);

    /* ---- 名次表 ---- */
    var table = el('div', 'hr-table hr-result-table');
    var headRow = el('div', 'hr-table-row hr-table-head');
    var cols = ['名次', '车手', '赛车', '总时间', '最快圈', '差距', '积分'];
    for (var hc = 0; hc < cols.length; hc++) add(headRow, el('span', 'hr-table-cell', cols[hc]));
    add(table, headRow);

    for (var i = 0; i < rows.length; i++) {
      add(table, buildResultRow(rows[i], i, isChamp));
    }
    if (!rows.length) add(table, el('div', 'hr-empty-state', '暂无比赛数据'));
    add(wrap, table);

    /* ---- 奖励 / 最佳圈速 ---- */
    var foot = el('div', 'hr-result-foot');
    if (typeof data.credits === 'number' && isFinite(data.credits) && data.credits > 0) {
      add(foot, el('span', 'hr-result-credits', '奖金 +' + fmtCredits(data.credits) + ' CR'));
    }
    if (data.bestLapText && data.bestLapText !== '--' && data.bestLapText !== '--:--') {
      add(foot, el('span', 'hr-result-best', '你的最快圈速 ' + str(data.bestLapText)));
    } else {
      var playerBest = null;
      for (var pb = 0; pb < rows.length; pb++) {
        if (rows[pb] && rows[pb].isPlayer) {
          playerBest = rows[pb].bestLap;
          break;
        }
      }
      if (playerBest != null && playerBest !== '--' && playerBest !== '--:--') {
        add(foot, el('span', 'hr-result-best', '你的最快圈速 ' + fmtTimeOrText(playerBest)));
      }
    }
    add(wrap, foot);

    /* ---- 按钮 ---- */
    var btnRow = el('div', 'hr-page-actions');
    for (var a = 0; a < actions.length; a++) {
      var act = RESULT_ACTIONS[actions[a]];
      if (!act) continue;
      var label = act.label;
      if (actions[a] === 'next' && data.nextLabel) label = str(data.nextLabel);
      btnRow.appendChild(button(label, { cls: act.cls, onClick: act.run }));
    }
    add(wrap, btnRow);

    inner.appendChild(wrap);
  }

  function buildResultRow(row, index, isChamp) {
    row = row || {};
    var isPlayer = !!row.isPlayer;
    var node = el('div', 'hr-table-row' + (isPlayer ? ' is-player' : ''));
    var place = pickNumber(row.place);
    add(node, el('span', 'hr-table-cell hr-cell-place', 'P' + Math.round(place == null ? index + 1 : place)));

    var nameCell = el('span', 'hr-table-cell hr-cell-name');
    var dot = add(nameCell, el('span', 'hr-car-dot'));
    dot.style.background = str(row.carColor, '#8d86c9');
    add(nameCell, el('span', 'hr-cell-name-text', str(row.name, '车手')));
    if (row.ai && !isPlayer) add(nameCell, el('span', 'hr-chip hr-chip--ai', 'AI'));
    if (isPlayer) add(nameCell, el('span', 'hr-chip hr-chip--player', '玩家'));
    add(node, nameCell);

    add(node, el('span', 'hr-table-cell hr-cell-car', str(row.carName, '—')));
    add(node, el('span', 'hr-table-cell hr-cell-time', fmtTimeOrText(row.totalTime)));
    add(node, el('span', 'hr-table-cell hr-cell-lap', fmtTimeOrText(row.bestLap)));
    add(node, el('span', 'hr-table-cell hr-cell-gap', gapText(row.gap)));

    var pts = pickNumber(row.points);
    var ptsText = '—';
    if (pts != null && pts > 0) ptsText = '+' + Math.round(pts);
    else if (isChamp && pts != null) ptsText = String(Math.round(pts));
    add(node, el('span', 'hr-table-cell hr-cell-points', ptsText));
    return node;
  }

  /* =========================================================================
   * 12. 全屏界面：champ（积分榜）
   * ========================================================================= */
  function buildChamp(inner, data) {
    data = data || {};
    var standings = arr(data.standings);
    var wrap = el('div', 'hr-page hr-champ');
    add(wrap, makeHeader('地平线冠军赛', 'CHAMPIONSHIP STANDINGS', [backButton()]));

    var desc = HR.CHAMP && HR.CHAMP.desc ? str(HR.CHAMP.desc)
      : '四站积分赛，每站名次换算积分，总分最高者加冕地平线冠军。';
    add(wrap, el('p', 'hr-screen-desc', desc));

    if (data.champion) {
      add(wrap, el('div', 'hr-champion-banner', '🏆 你已成为地平线冠军'));
    }

    var nextEvent = findById(HR.EVENTS, data.nextEventId);
    var nextLine = el('div', 'hr-champ-next');
    if (nextEvent) {
      add(nextLine, el('span', 'hr-champ-next-label', '下一站'));
      add(nextLine, el('span', 'hr-champ-next-name', str(nextEvent.name, nextEvent.id)));
      if (nextEvent.subtitle) add(nextLine, el('span', 'hr-champ-next-sub', str(nextEvent.subtitle)));
    } else {
      add(nextLine, el('span', 'hr-champ-next-label', '赛季状态'));
      add(nextLine, el('span', 'hr-champ-next-name', data.finished ? '全部赛事已完成' : '等待下一站'));
    }
    add(wrap, nextLine);

    var table = el('div', 'hr-table hr-champ-table');
    var headRow = el('div', 'hr-table-row hr-table-head');
    var cols = ['名次', '车手', '赛车', '积分'];
    for (var hc = 0; hc < cols.length; hc++) add(headRow, el('span', 'hr-table-cell', cols[hc]));
    add(table, headRow);

    for (var i = 0; i < standings.length; i++) {
      var row = standings[i] || {};
      var node = el('div', 'hr-table-row' + (row.isPlayer ? ' is-player' : ''));
      var place = pickNumber(row.place);
      add(node, el('span', 'hr-table-cell hr-cell-place', 'P' + Math.round(place == null ? i + 1 : place)));

      var nameCell = el('span', 'hr-table-cell hr-cell-name');
      var dot = add(nameCell, el('span', 'hr-car-dot'));
      dot.style.background = str(row.carColor, '#8d86c9');
      add(nameCell, el('span', 'hr-cell-name-text', str(row.name, '车手')));
      if (row.isPlayer) add(nameCell, el('span', 'hr-chip hr-chip--player', '玩家'));
      add(node, nameCell);

      add(node, el('span', 'hr-table-cell hr-cell-car', str(row.carName, '—')));
      add(node, el('span', 'hr-table-cell hr-cell-points', fmtInt(row.points, '0')));
      add(table, node);
    }
    if (!standings.length) add(table, el('div', 'hr-empty-state', '暂无积分榜数据'));
    add(wrap, table);

    var btnRow = el('div', 'hr-page-actions');
    btnRow.appendChild(button(str(data.nextLabel, '下一站'), {
      cls: 'hr-btn--primary',
      onClick: function () { safeCall('onNextEvent'); }
    }));
    btnRow.appendChild(button('返回标题', {
      cls: 'hr-btn--ghost',
      onClick: function () { safeCall('onTitle'); }
    }));
    add(wrap, btnRow);

    inner.appendChild(wrap);
  }

  /* =========================================================================
   * 13. 全屏界面：pause
   * ========================================================================= */
  function buildPause(inner, data) {
    data = data || {};
    var isSpectate = str(data.mode, '') === 'spectate';
    var cameraMode = str(data.cameraMode, 'chase');
    var autopilot = !!data.autopilot;
    var muted = !!data.muted;
    var music = data.music !== false;
    var spectateSpeed = pickNumber(data.spectateSpeed);
    if (spectateSpeed == null) spectateSpeed = 1;

    var wrap = el('div', 'hr-page hr-pause');
    var panel = el('div', 'hr-pause-panel');
    add(panel, el('div', 'hr-pause-kicker', isSpectate ? 'SPECTATE · PAUSED' : 'PAUSED'));
    add(panel, el('h2', 'hr-pause-title', isSpectate ? 'AI 观战 · 已暂停' : '比赛暂停'));
    if (data.mode) add(panel, el('div', 'hr-pause-mode', '模式 · ' + (MODE_CN[data.mode] || str(data.mode))));

    /* ---- 主操作 ---- */
    var main = el('div', 'hr-pause-main');
    add(main, button('继续比赛', { cls: 'hr-btn--primary', onClick: function () { safeCall('onResume'); } }));
    add(main, button('重新开始', { cls: 'hr-btn--ghost', onClick: function () { safeCall('onRestart'); } }));
    add(main, button('返回标题', { cls: 'hr-btn--ghost', onClick: function () { safeQuitToTitle(); } }));
    add(panel, main);

    /* ---- 选项 ---- */
    var options = el('div', 'hr-pause-options');

    var camBtn = button('视角 · ' + cameraName(cameraMode), {
      cls: 'hr-btn--opt',
      onClick: function () {
        cameraMode = nextCamera(cameraMode);
        setText(camBtn, '视角 · ' + cameraName(cameraMode));
        safeCall('onCameraMode');
      }
    });
    add(options, camBtn);

    var autoBtn = button('自动驾驶 · ' + (autopilot ? '开' : '关'), {
      cls: 'hr-btn--opt',
      onClick: function () {
        autopilot = !autopilot;
        setText(autoBtn, '自动驾驶 · ' + (autopilot ? '开' : '关'));
        safeCall('onToggleAutopilot');
      }
    });
    add(options, autoBtn);

    var muteBtn = button('静音 · ' + (muted ? '开' : '关'), {
      cls: 'hr-btn--opt',
      onClick: function () {
        muted = !muted;
        setText(muteBtn, '静音 · ' + (muted ? '开' : '关'));
        safeCall('onToggleMute');
      }
    });
    add(options, muteBtn);

    var musicBtn = button('背景音乐 · ' + (music ? '开' : '关'), {
      cls: 'hr-btn--opt',
      onClick: function () {
        music = !music;
        setText(musicBtn, '背景音乐 · ' + (music ? '开' : '关'));
        safeCall('onToggleMusic');
      }
    });
    add(options, musicBtn);

    if (isSpectate) {
      var speedBtn = button('观战倍速 · ×' + spectateSpeed, {
        cls: 'hr-btn--opt',
        onClick: function () {
          spectateSpeed = spectateSpeed === 1 ? 2 : (spectateSpeed === 2 ? 4 : 1);
          setText(speedBtn, '观战倍速 · ×' + spectateSpeed);
          safeCall('onSpeedToggle');
        }
      });
      add(options, speedBtn);
    }
    add(panel, options);

    /* ---- 观战接管列表 ---- */
    var spectateCars = arr(data.spectateCars);
    if (data.canTakeOver && spectateCars.length) {
      var takeover = el('div', 'hr-takeover');
      add(takeover, el('div', 'hr-takeover-title', '接管一辆 AI 赛车'));
      add(takeover, el('div', 'hr-takeover-tip', '按 Tab 切换镜头，Enter 立即接管当前镜头车辆。'));
      var list = el('div', 'hr-takeover-list');
      for (var i = 0; i < spectateCars.length; i++) {
        list.appendChild(buildTakeoverRow(spectateCars[i]));
      }
      add(takeover, list);
      add(panel, takeover);
    }

    add(wrap, panel);
    inner.appendChild(wrap);
  }

  function buildTakeoverRow(car) {
    car = car || {};
    var isPlayer = !!car.isPlayer || car.control === 'player';
    var row = el('div', 'hr-takeover-row' + (isPlayer ? ' is-player' : ''));
    var info = el('div', 'hr-takeover-info');
    add(info, el('span', 'hr-takeover-name', str(car.name, '车手')));
    if (car.carName) add(info, el('span', 'hr-takeover-car', str(car.carName)));
    add(row, info);
    if (car.control) add(row, el('span', 'hr-takeover-state', car.control === 'player' ? '玩家' : 'AI'));
    var btn = button(isPlayer ? '已接管' : '接管', {
      cls: 'hr-btn--small' + (isPlayer ? ' hr-btn--ghost' : ''),
      disabled: isPlayer,
      onClick: function () { safeCall('onTakeOver', car.id); }
    });
    add(row, btn);
    return row;
  }

  function cameraName(mode) {
    if (CAMERA_CN[mode]) return CAMERA_CN[mode];
    return str(mode, '追尾');
  }

  function nextCamera(mode) {
    var idx = CAMERA_ORDER.indexOf(mode);
    if (idx < 0) idx = 0;
    return CAMERA_ORDER[(idx + 1) % CAMERA_ORDER.length];
  }

  /* =========================================================================
   * 14. 全屏界面：help
   * ========================================================================= */
  function buildHelp(inner) {
    var wrap = el('div', 'hr-page hr-help');
    add(wrap, makeHeader('操作说明', 'CONTROLS & TIPS', [backButton()]));

    var cols = el('div', 'hr-help-cols');

    /* ---- 键盘操作 ---- */
    var keyCard = groupCard('键盘操作', 'KEYBOARD');
    var keyList = el('div', 'hr-keys');
    var controls = arr(HR.CONTROLS);
    for (var i = 0; i < controls.length; i++) {
      var c = controls[i] || {};
      var row = el('div', 'hr-key-row');
      add(row, el('kbd', 'hr-key', str(c.keys, '?')));
      add(row, el('span', 'hr-key-action', str(c.action, '')));
      add(keyList, row);
    }
    if (!controls.length) add(keyList, el('div', 'hr-empty-state', '暂无操作数据'));
    add(keyCard, keyList);
    add(cols, keyCard);

    /* ---- 玩法提示 ---- */
    var tipCard = groupCard('玩法提示', 'TIPS');
    var tips = el('ul', 'hr-tips-list');
    var hints = arr(HR.HINTS);
    for (var j = 0; j < hints.length; j++) {
      add(tips, el('li', 'hr-tip', str(hints[j])));
    }
    if (!hints.length) add(tips, el('li', 'hr-tip', '弯前刹车、弯心给油，是刷圈速的第一原则。'));
    add(tipCard, tips);
    add(cols, tipCard);

    /* ---- AI 模式 ---- */
    var aiCard = groupCard('AI 模式 · 随时接管', 'AI BATTLE');
    var aiTips = el('ul', 'hr-tips-list');
    var aiLines = [
      'Tab：在观战中切换镜头车辆。',
      'Enter：立即接管当前镜头车辆，亲自驾驶。',
      'H：在玩家与 AI 之间切换控制权（比赛中随时可用）。',
      'T：切换观战倍速 1x / 2x / 4x。',
      'AI 车手各有风格：激进 / 稳健 / 精准 / 凶狠 / 老练，难度越高越贴近极限。'
    ];
    for (var k = 0; k < aiLines.length; k++) {
      add(aiTips, el('li', 'hr-tip', aiLines[k]));
    }
    add(aiCard, aiTips);
    add(cols, aiCard);

    add(wrap, cols);
    inner.appendChild(wrap);
  }

  /* =========================================================================
   * 15. 全屏界面：loading / 未知屏幕
   * ========================================================================= */
  function buildLoading(inner, data) {
    var wrap = el('div', 'hr-loading');
    add(wrap, el('div', 'hr-loading-logo', 'HORIZON RUSH'));
    var label = add(wrap, el('div', 'hr-loading-label', '正在准备…'));
    var bar = el('div', 'hr-loading-bar');
    var fill = add(bar, el('div', 'hr-loading-fill'));
    var pct = add(wrap, el('div', 'hr-loading-pct', '0%'));
    add(wrap, bar);
    add(wrap, pct);
    inner.appendChild(wrap);

    state.loading = { label: label, fill: fill, pct: pct, bar: bar, lastLabel: '' };
    updateLoading(data || {});
  }

  function updateLoading(data) {
    var lo = state.loading;
    if (!lo) return;
    data = data || {};
    if (data.label != null && str(data.label)) {
      lo.lastLabel = str(data.label);
    } else if (!lo.lastLabel) {
      lo.lastLabel = '正在准备…';
    }
    setText(lo.label, lo.lastLabel);
    var p = clamp(num(data.pct, 0), 0, 100);
    setWidth(lo.fill, p);
    setText(lo.pct, Math.round(p) + '%');
  }

  function buildUnknown(inner, name) {
    var wrap = el('div', 'hr-page');
    add(wrap, makeHeader('未知界面', 'UNKNOWN SCREEN', [backButton()]));
    add(wrap, el('p', 'hr-screen-desc', '未知界面标识：' + name));
    inner.appendChild(wrap);
  }

  /* =========================================================================
   * 16. HUD —— 首帧构建
   * ========================================================================= */
  function ensureHUD() {
    if (state.hud) return state.hud;
    state.hud = buildHUD();
    return state.hud;
  }

  function buildHUD() {
    var root = state.hudRoot;
    if (!root) return null;
    clear(root);

    var h = {};

    /* ---- 左上：模式 / 圈数 / 名次 / 计时 ---- */
    var tl = el('div', 'hr-hud-tl');

    var modes = el('div', 'hr-hud-modes');
    h.modeChip = add(modes, el('span', 'hr-mode-chip', '快速比赛'));
    h.spectateBadge = add(modes, el('span', 'hr-badge hr-badge--spectate hr-hidden', 'AI 大战 · Tab 切车 / Enter 接管'));
    h.autoBadge = add(modes, el('span', 'hr-badge hr-badge--auto hr-hidden', '自动驾驶 · H 接管'));
    h.muteBadge = add(modes, el('span', 'hr-badge hr-badge--mute hr-hidden', '静音'));
    h.camLabel = add(modes, el('span', 'hr-badge hr-badge--cam', '视角 · 追尾'));
    add(tl, modes);

    var lapPos = el('div', 'hr-lap-pos');
    var lapBox = el('div', 'hr-lap-box');
    add(lapBox, el('div', 'hr-mini-label', '圈数'));
    h.lap = add(lapBox, el('div', 'hr-lap-value', 'LAP 1/3'));
    h.delta = add(lapBox, el('div', 'hr-lap-delta hr-hidden', 'Δ --'));
    add(lapPos, lapBox);

    var posBox = el('div', 'hr-pos-box');
    add(posBox, el('div', 'hr-mini-label', '名次'));
    var posLine = el('div', 'hr-pos-line');
    h.pos = add(posLine, el('span', 'hr-pos-value', 'P1'));
    h.posTotal = add(posLine, el('span', 'hr-pos-total', '/8'));
    add(posBox, posLine);
    add(lapPos, posBox);
    add(tl, lapPos);

    var times = el('div', 'hr-times');
    h.timeCur = timeRow(times, '本圈');
    h.timeLast = timeRow(times, '上圈');
    h.timeBest = timeRow(times, '最佳');
    h.timeTotal = timeRow(times, '总计');
    add(tl, times);

    add(root, tl);

    /* ---- 右上：8 车名次表 ---- */
    var standings = el('div', 'hr-standings');
    var stHead = el('div', 'hr-standings-head');
    add(stHead, el('span', 'hr-standings-title', '排名'));
    h.standingsCount = add(stHead, el('span', 'hr-standings-count', '8 车'));
    h.fps = add(stHead, el('span', 'hr-fps hr-hidden', 'FPS'));
    add(standings, stHead);

    h.rows = [];
    for (var i = 0; i < STANDING_ROWS; i++) {
      var row = el('div', 'hr-standing-row');
      var place = add(row, el('span', 'hr-standing-place', 'P' + (i + 1)));
      var dot = add(row, el('span', 'hr-car-dot'));
      var nameWrap = el('div', 'hr-standing-name-wrap');
      var name = add(nameWrap, el('span', 'hr-standing-name', '—'));
      var markers = add(nameWrap, el('span', 'hr-standing-markers'));
      var aiTag = add(markers, el('span', 'hr-standing-tag hr-standing-tag--ai', 'AI'));
      var youTag = add(markers, el('span', 'hr-standing-tag hr-standing-tag--you', '你'));
      var finTag = add(markers, el('span', 'hr-standing-tag hr-standing-tag--fin', '完赛'));
      add(row, place);
      add(row, dot);
      add(row, nameWrap);
      add(standings, row);
      h.rows.push({
        root: row,
        place: place,
        dot: dot,
        name: name,
        aiTag: aiTag,
        youTag: youTag,
        finTag: finTag
      });
    }
    add(root, standings);

    /* ---- 左下：小地图 ---- */
    var bl = el('div', 'hr-hud-bl');
    var mini = el('div', 'hr-minimap');
    h.minimapTitle = add(mini, el('div', 'hr-minimap-title', '赛道'));
    var canvas = el('canvas', 'hr-minimap-canvas');
    canvas.width = MINIMAP_W;
    canvas.height = MINIMAP_H;
    add(mini, canvas);
    add(bl, mini);
    add(root, bl);

    var miniCtx = null;
    try {
      if (canvas.getContext) miniCtx = canvas.getContext('2d');
    } catch (e) { miniCtx = null; }
    state.minimap = {
      canvas: canvas,
      ctx: miniCtx,
      cache: null,
      map: null,
      track: null,
      ready: false,
      W: MINIMAP_W,
      H: MINIMAP_H
    };
    h.minimapCanvas = canvas;

    /* ---- 右下：挡位 / 转速 / 氮气 / 漂移 + 速度表 ---- */
    var br = el('div', 'hr-hud-br');
    var cluster = buildCluster();
    add(br, cluster.wrap);
    h.gear = cluster.gear;
    h.rpmK = cluster.rpmK;
    h.rpmFill = cluster.rpmFill;
    h.rpmBox = cluster.rpmBox;
    h.nitroFill = cluster.nitroFill;
    h.nitroState = cluster.nitroState;
    h.nitroBox = cluster.nitroBox;
    h.driftBox = cluster.driftBox;
    h.driftVal = cluster.driftVal;
    h.driftCombo = cluster.driftCombo;

    var speedo = buildSpeedo();
    add(br, speedo.wrap);
    h.gaugeFill = speedo.fill;
    h.needle = speedo.needle;
    h.speedNum = speedo.num;
    h.speedUnit = speedo.unit;
    h.speedMax = speedo.max;
    add(root, br);

    /* ---- 底部提示条 ---- */
    var hint = el('div', 'hr-hintbar');
    h.hintRoot = hint;
    h.hintText = add(hint, el('span', 'hr-hint-text', ''));
    h.hintKeys = add(hint, el('span', 'hr-hint-keys',
      'W/A/S/D 驾驶 · Space 手刹 · Shift 氮气 · C 视角 · P 暂停 · M 静音'));
    add(root, hint);

    /* ---- 中央倒计时 ---- */
    h.countdown = add(root, el('div', 'hr-countdown hr-hidden', '3'));

    return h;
  }

  function timeRow(parent, label) {
    var row = el('div', 'hr-time-row');
    add(row, el('span', 'hr-time-label', label));
    var value = add(row, el('span', 'hr-time-value', '--:--'));
    add(parent, row);
    return value;
  }

  function buildCluster() {
    var wrap = el('div', 'hr-cluster');

    var gearBox = el('div', 'hr-gear-box');
    add(gearBox, el('div', 'hr-mini-label', '挡位'));
    var gear = add(gearBox, el('div', 'hr-gear-num', '1'));
    add(wrap, gearBox);

    var stack = el('div', 'hr-cluster-stack');

    var rpmBox = el('div', 'hr-rpm-box');
    var rpmHead = el('div', 'hr-rpm-head');
    add(rpmHead, el('span', 'hr-mini-label', '转速'));
    var rpmK = add(rpmHead, el('span', 'hr-rpm-k', '0.0'));
    add(rpmBox, rpmHead);
    var rpmTrack = el('div', 'hr-rpm-track');
    var rpmFill = add(rpmTrack, el('div', 'hr-rpm-fill'));
    add(rpmBox, rpmTrack);
    add(stack, rpmBox);

    var nitroBox = el('div', 'hr-nitro-box');
    var nitroHead = el('div', 'hr-nitro-head');
    add(nitroHead, el('span', 'hr-mini-label', '氮气'));
    var nitroState = add(nitroHead, el('span', 'hr-nitro-state', 'READY'));
    add(nitroBox, nitroHead);
    var nitroTrack = el('div', 'hr-nitro-track');
    var nitroFill = add(nitroTrack, el('div', 'hr-nitro-fill'));
    add(nitroBox, nitroTrack);
    add(stack, nitroBox);

    var driftBox = el('div', 'hr-drift-box');
    var driftHead = el('div', 'hr-drift-head');
    add(driftHead, el('span', 'hr-mini-label', '漂移'));
    var driftCombo = add(driftHead, el('span', 'hr-drift-combo', ''));
    add(driftBox, driftHead);
    var driftVal = add(driftBox, el('div', 'hr-drift-val', '0'));
    add(stack, driftBox);

    add(wrap, stack);

    return {
      wrap: wrap,
      gear: gear,
      rpmK: rpmK,
      rpmFill: rpmFill,
      rpmBox: rpmBox,
      nitroFill: nitroFill,
      nitroState: nitroState,
      nitroBox: nitroBox,
      driftBox: driftBox,
      driftVal: driftVal,
      driftCombo: driftCombo
    };
  }

  function buildSpeedo() {
    var wrap = el('div', 'hr-speedo');
    var svg = svgEl('svg', { viewBox: '0 0 200 200', 'class': 'hr-gauge', 'aria-hidden': 'true' });

    var defs = svgEl('defs');
    var grad = svgEl('linearGradient', { id: 'hrSpeedGrad', x1: '0%', y1: '100%', x2: '100%', y2: '0%' });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#39e6ff' }));
    grad.appendChild(svgEl('stop', { offset: '55%', 'stop-color': '#7b5cff' }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#ff6a2b' }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    var arcD = 'M42.02 157.98 A82 82 0 1 1 157.98 157.98';
    svg.appendChild(svgEl('path', {
      d: arcD,
      'class': 'hr-gauge-track',
      fill: 'none'
    }));
    var fillPath = svgEl('path', {
      d: arcD,
      'class': 'hr-gauge-fill',
      fill: 'none',
      stroke: 'url(#hrSpeedGrad)',
      pathLength: '100',
      'stroke-dasharray': '100',
      'stroke-dashoffset': '100'
    });
    svg.appendChild(fillPath);

    var ticks = svgEl('g', { 'class': 'hr-gauge-ticks' });
    for (var i = 0; i <= 10; i++) {
      var ratio = i / 10;
      var deg = -135 + ratio * 270;
      var a = deg * Math.PI / 180;
      var major = (i % 5 === 0);
      var r1 = major ? 58 : 64;
      var r2 = 72;
      ticks.appendChild(svgEl('line', {
        x1: (100 + Math.sin(a) * r1).toFixed(2),
        y1: (100 - Math.cos(a) * r1).toFixed(2),
        x2: (100 + Math.sin(a) * r2).toFixed(2),
        y2: (100 - Math.cos(a) * r2).toFixed(2),
        'class': major ? 'hr-tick hr-tick--major' : 'hr-tick'
      }));
    }
    svg.appendChild(ticks);

    var needle = svgEl('g', { 'class': 'hr-needle' });
    needle.appendChild(svgEl('line', { x1: '100', y1: '100', x2: '100', y2: '34', 'class': 'hr-needle-line' }));
    needle.appendChild(svgEl('circle', { cx: '100', cy: '100', r: '6', 'class': 'hr-needle-hub' }));
    svg.appendChild(needle);

    add(wrap, svg);

    var readout = el('div', 'hr-speedo-readout');
    var numEl = add(readout, el('div', 'hr-speedo-num', '0'));
    var unitEl = add(readout, el('div', 'hr-speedo-unit', 'KM/H'));
    var maxEl = add(readout, el('div', 'hr-speedo-max', 'MAX 320'));
    add(wrap, readout);

    return { wrap: wrap, fill: fillPath, needle: needle, num: numEl, unit: unitEl, max: maxEl };
  }

  /* =========================================================================
   * 17. HUD —— 每帧增量更新（不重建节点）
   * ========================================================================= */
  function updateHUD(hud) {
    if (!state.inited || !state.hudRoot) return;
    var h = ensureHUD();
    if (!h) return;

    hud = hud && typeof hud === 'object' ? hud : {};
    var car = hud.car || null;
    var cars = arr(hud.cars);
    if (!cars.length && car) cars = [car];
    var race = hud.race && typeof hud.race === 'object' ? hud.race : {};
    var settings = hud.settings && typeof hud.settings === 'object' ? hud.settings : (HR.DEFAULT_SETTINGS || {});
    var units = settings.units === 'mph' ? 'mph' : 'kmh';
    var mode = str(hud.mode, 'race');
    var isSpectate = !!hud.spectate || mode === 'spectate';
    var isFree = mode === 'free';

    updateSpeedo(h, car, units);
    updateCluster(h, car);
    updateLapPos(h, car, race, isFree);
    updateTimes(h, car, race);
    updateStandings(h, hud, cars, isSpectate);
    updateBadges(h, hud, car, isSpectate);
    updateHint(h, race, settings);
    updateCountdown(h, race);
    drawMinimap(hud, h);
  }

  function updateSpeedo(h, car, units) {
    var spd = speedOf(car ? car.v : 0, units);
    if (spd < 0) spd = 0;
    var spec = car ? car.spec : null;
    var top = 320;
    if (spec && spec.stats && typeof spec.stats.topSpeed === 'number' && isFinite(spec.stats.topSpeed)) {
      top = spec.stats.topSpeed;
    }
    if (!(top > 80)) top = 320;
    var topDisplay = units === 'mph' ? top / 1.609344 : top;
    var ratio = clamp(spd / Math.max(1, topDisplay), 0, 1);
    var deg = -135 + ratio * 270;

    setStyle(h.needle, 'transform', 'rotate(' + deg.toFixed(1) + 'deg)');
    setStyle(h.gaugeFill, 'strokeDashoffset', (100 - ratio * 100).toFixed(1));
    setText(h.speedNum, String(spd));
    setText(h.speedUnit, unitLabel(units));
    setText(h.speedMax, 'MAX ' + Math.round(topDisplay));
  }

  function updateCluster(h, car) {
    if (!car) {
      setText(h.gear, '—');
      setText(h.rpmK, '0.0');
      setWidth(h.rpmFill, 0);
      setWidth(h.nitroFill, 0);
      setText(h.nitroState, '');
      setText(h.driftVal, '0');
      setText(h.driftCombo, '');
      setClass(h.driftBox, 'is-active', false);
      setClass(h.rpmFill, 'is-hot', false);
      setClass(h.nitroBox, 'is-boosting', false);
      return;
    }

    var gear = Math.round(num(car.gear, 0));
    setText(h.gear, gear > 0 ? String(gear) : 'N');

    var rpm = clamp(num(car.rpm, 800), 800, 9000);
    var rpmRatio = (rpm - 800) / 8200;
    setText(h.rpmK, (rpm / 1000).toFixed(1));
    setWidth(h.rpmFill, rpmRatio * 100);
    setClass(h.rpmFill, 'is-hot', rpmRatio > 0.9);

    var boost = clamp(num(car.boost, 0), 0, 1);
    setWidth(h.nitroFill, boost * 100);
    setClass(h.nitroBox, 'is-boosting', !!car.boosting);
    setText(h.nitroState, car.boosting ? 'BOOST' : (boost > 0.3 ? 'READY' : 'LOW'));

    var drifting = !!car.drifting;
    var combo = Math.round(num(car.driftCombo, 0));
    var driftScore = num(car.driftScore, 0);
    setText(h.driftVal, fmtInt(driftScore, '0'));
    setText(h.driftCombo, drifting && combo > 1 ? '×' + combo : (drifting ? 'DRIFT' : ''));
    setClass(h.driftBox, 'is-active', drifting);
  }

  function updateLapPos(h, car, race, isFree) {
    if (isFree) {
      setText(h.lap, '自由驾驶');
      setText(h.pos, '—');
      setText(h.posTotal, '');
      setHidden(h.delta, true);
      return;
    }
    var lap = Math.round(num(race.lap, car ? car.lap : 1));
    if (lap < 1) lap = 1;
    var laps = Math.round(num(race.laps, 3));
    if (laps < 1) laps = 3;
    if (lap > laps) lap = laps;
    setText(h.lap, 'LAP ' + lap + '/' + laps);

    var place = Math.round(num(race.position, car ? car.place : 0));
    setText(h.pos, place > 0 ? 'P' + place : '—');
    var total = Math.round(num(race.totalCars, 8));
    setText(h.posTotal, total > 0 ? '/' + total : '');

    if (typeof race.lapDelta === 'number' && isFinite(race.lapDelta)) {
      setHidden(h.delta, false);
      setText(h.delta, 'Δ ' + fmtDelta(race.lapDelta));
      setClass(h.delta, 'is-good', race.lapDelta < 0);
      setClass(h.delta, 'is-bad', race.lapDelta > 0);
    } else {
      setHidden(h.delta, true);
    }
  }

  function updateTimes(h, car, race) {
    var raceTime = (typeof race.raceTime === 'number' && isFinite(race.raceTime) && race.raceTime >= 0)
      ? race.raceTime : null;
    var lapStart = car && typeof car.lapStartTime === 'number' && isFinite(car.lapStartTime)
      ? car.lapStartTime : null;
    var cur = null;
    if (raceTime != null && lapStart != null) cur = Math.max(0, raceTime - lapStart);

    setText(h.timeCur, cur == null ? '--:--' : fmtTime(cur));
    setText(h.timeLast, positiveTime(race.lastLap));
    setText(h.timeBest, positiveTime(race.bestLap));
    setText(h.timeTotal, raceTime == null ? '--:--' : fmtTime(raceTime));
  }

  /** 只有 > 0 的圈速才展示，0 / NaN 一律显示占位符（避免首圈出现 0.000） */
  function positiveTime(sec) {
    return (typeof sec === 'number' && isFinite(sec) && sec > 0) ? fmtTime(sec) : '--:--';
  }

  function updateStandings(h, hud, cars, isSpectate) {
    if (!h.rows) return;
    var race = hud.race && typeof hud.race === 'object' ? hud.race : {};
    var list = arr(race.standings);
    if (!list.length) list = fallbackStandings(cars);

    var controlled = hud.car || null;
    var controlledId = controlled ? controlled.id : null;
    var count = list.length;
    setText(h.standingsCount, count + ' 车');

    for (var i = 0; i < h.rows.length; i++) {
      var row = h.rows[i];
      var item = i < list.length ? list[i] : null;
      if (!item) {
        setHidden(row.root, true);
        continue;
      }
      setHidden(row.root, false);

      var place = Math.round(num(item.place, i + 1));
      setText(row.place, 'P' + place);
      setText(row.name, str(item.name, item.id ? String(item.id) : '车手'));

      var color = str(item.carColor, '#8d86c9');
      setStyle(row.dot, 'background', color);

      var isPlayer = !!item.isPlayer ||
        item.control === 'player' ||
        (!isSpectate && controlledId != null && item.id === controlledId);
      var isAI = item.control ? item.control === 'ai' : !isPlayer;

      setClass(row.root, 'is-player', isPlayer);
      setClass(row.root, 'is-finished', !!item.finished);
      setHidden(row.aiTag, isPlayer || !isAI);
      setHidden(row.youTag, !isPlayer);
      setHidden(row.finTag, !item.finished);
    }
  }

  function fallbackStandings(cars) {
    var list = arr(cars).slice();
    list.sort(function (a, b) {
      var af = a && a.finished ? 1 : 0;
      var bf = b && b.finished ? 1 : 0;
      if (af !== bf) return bf - af;
      if (af && bf) return num(a.finishTime, 0) - num(b.finishTime, 0);
      return num(b && b.dist, 0) - num(a && a.dist, 0);
    });
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c) continue;
      out.push({
        id: c.id,
        name: c.name,
        carColor: c.spec ? c.spec.color : '#8d86c9',
        place: i + 1,
        finished: !!c.finished,
        control: c.control
      });
    }
    return out;
  }

  function updateBadges(h, hud, car, isSpectate) {
    var mode = str(hud.mode, 'race');
    setText(h.modeChip, MODE_CN[mode] || '快速比赛');

    setHidden(h.spectateBadge, !isSpectate);
    if (isSpectate) {
      var spd = pickNumber(hud.spectateSpeed);
      if (spd == null) spd = 1;
      setText(h.spectateBadge, 'AI 大战 · Tab 切车 / Enter 接管 · T 倍速 ×' + spd);
    }

    var autopilot = !!hud.autopilot;
    setHidden(h.autoBadge, !autopilot);
    setHidden(h.muteBadge, !hud.muted);

    var cam = str(hud.cameraMode, 'chase');
    setText(h.camLabel, '视角 · ' + cameraName(cam));

    if (typeof hud.fps === 'number' && isFinite(hud.fps)) {
      setHidden(h.fps, false);
      setText(h.fps, 'FPS ' + Math.round(hud.fps));
    } else {
      setHidden(h.fps, true);
    }
  }

  function updateHint(h, race, settings) {
    var showHints = settings.showHints !== false;
    var message = str(race.message, '');
    var text = '';
    var isMessage = false;

    if (message) {
      text = message;
      isMessage = true;
      state.hintNextAt = nowMs() + HINT_INTERVAL_MS;
    } else if (showHints) {
      var hints = arr(HR.HINTS);
      if (hints.length) {
        var now = nowMs();
        if (state.hintNextAt === 0 || race.state !== 'racing') {
          state.hintNextAt = now + HINT_INTERVAL_MS;
        } else if (now >= state.hintNextAt) {
          state.hintIdx = (state.hintIdx + 1) % hints.length;
          state.hintNextAt = now + HINT_INTERVAL_MS;
        }
        text = str(hints[state.hintIdx % hints.length], '');
      }
    }

    setText(h.hintText, text);
    setHidden(h.hintText, !text);
    setClass(h.hintRoot, 'is-message', isMessage);
  }

  function updateCountdown(h, race) {
    var node = h.countdown;
    if (!node) return;
    var racingGo = false;
    if (race.state !== 'countdown') {
      /* 开赛瞬间继续显示 GO! 约 0.9s（state 已切换为 racing） */
      if (race.state === 'racing' && typeof race.raceTime === 'number' && isFinite(race.raceTime) && race.raceTime < 0.9) {
        racingGo = true;
      } else {
        setHidden(node, true);
        return;
      }
    }
    var count = typeof race.countdown === 'number' && isFinite(race.countdown) ? race.countdown : null;
    var text = racingGo ? 'GO!' : (count == null ? '3' : (count > 0 ? String(Math.ceil(count)) : 'GO!'));
    setHidden(node, false);
    var prev = node.__hrText;
    setText(node, text);
    if (prev !== text) {
      setClass(node, 'is-go', text === 'GO!');
      node.classList.remove('is-pop');
      // 强制回流以重播入场动画（仅倒计时 3→2→1→GO 的 4 次变化）
      void node.offsetWidth;
      node.classList.add('is-pop');
    }
  }

  /* =========================================================================
   * 18. 小地图（路径缓存 + 每帧画点）
   * ========================================================================= */
  function ensureMinimap(track) {
    var m = state.minimap;
    if (!m || !m.canvas) return false;
    if (!track || typeof track !== 'object' || !track.minimap) {
      m.ready = false;
      return false;
    }
    if (m.track === track && m.ready) return true;

    var mini = track.minimap;
    var bounds = mini.bounds;
    var points = arr(mini.points);
    if (!bounds || !points.length) {
      m.ready = false;
      return false;
    }

    var W = m.W;
    var H = m.H;
    var minX = num(bounds.minX, 0);
    var maxX = num(bounds.maxX, 1);
    var minZ = num(bounds.minZ, 0);
    var maxZ = num(bounds.maxZ, 1);
    var spanX = Math.max(1, maxX - minX);
    var spanZ = Math.max(1, maxZ - minZ);
    var usableW = Math.max(10, W - MINIMAP_PAD * 2);
    var usableH = Math.max(10, H - MINIMAP_PAD * 2);
    var scale = Math.min(usableW / spanX, usableH / spanZ);
    var offX = (W - spanX * scale) / 2 - minX * scale;
    var offZ = (H - spanZ * scale) / 2 - minZ * scale;
    var map = { scale: scale, offX: offX, offZ: offZ };

    try {
      if (!m.cache) {
        m.cache = document.createElement('canvas');
      }
      m.cache.width = W;
      m.cache.height = H;
      var ctx = m.cache.getContext ? m.cache.getContext('2d') : null;
      if (!ctx) {
        m.ready = false;
        return false;
      }
      ctx.clearRect(0, 0, W, H);

      drawMiniPath(ctx, points, map, 12, 'rgba(123, 92, 255, 0.22)', true);
      drawMiniPath(ctx, points, map, 4.5, 'rgba(57, 230, 255, 0.8)', false);
      drawMiniPath(ctx, points, map, 1.6, 'rgba(235, 244, 255, 0.92)', false);

      var checkpoints = arr(mini.checkpoints);
      for (var c = 0; c < checkpoints.length; c++) {
        var cp = checkpoints[c];
        if (!cp) continue;
        var cx = offX + num(cp.x, 0) * scale;
        var cz = offZ + num(cp.z, 0) * scale;
        ctx.beginPath();
        ctx.arc(cx, cz, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 209, 102, 0.95)';
        ctx.fill();
      }

      if (mini.start) {
        var sx = offX + num(mini.start.x, 0) * scale;
        var sz = offZ + num(mini.start.z, 0) * scale;
        ctx.beginPath();
        ctx.arc(sx, sz, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 106, 43, 0.28)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sx, sz, 3.6, 0, Math.PI * 2);
        ctx.fillStyle = '#ff6a2b';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(sx, sz, 6.5, 0, Math.PI * 2);
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.stroke();
      }
    } catch (e) {
      m.ready = false;
      return false;
    }

    m.map = map;
    m.track = track;
    m.ready = true;
    return true;
  }

  function drawMiniPath(ctx, points, map, width, color, close) {
    if (!points.length) return;
    ctx.beginPath();
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (!p) continue;
      var x = map.offX + num(p.x, 0) * map.scale;
      var y = map.offZ + num(p.z, 0) * map.scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (close) ctx.closePath();
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  function mapCarPosition(car, track) {
    if (!car || !track || typeof track.sample !== 'function') return null;
    try {
      var p = track.sample(num(car.s, 0), num(car.x, 0));
      if (p && typeof p.x === 'number' && typeof p.z === 'number' && isFinite(p.x) && isFinite(p.z)) {
        return p;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function drawMinimap(hud, h) {
    var m = state.minimap;
    if (!m || !m.ctx) return;
    var track = hud.track || null;
    if (h && track && track.name) setText(h.minimapTitle, str(track.name, '赛道'));

    try {
      m.ctx.clearRect(0, 0, m.W, m.H);
    } catch (e) { return; }

    if (!ensureMinimap(track)) return;
    if (m.cache) {
      try { m.ctx.drawImage(m.cache, 0, 0); } catch (e) { /* ignore */ }
    }

    var map = m.map;
    if (!map) return;
    var cars = arr(hud.cars);
    if (!cars.length && hud.car) cars = [hud.car];
    var controlled = hud.car || null;
    var isSpectate = hud.mode === 'spectate' || !!hud.spectate;

    for (var i = 0; i < cars.length; i++) {
      var car = cars[i];
      if (!car) continue;
      var pos = mapCarPosition(car, track);
      if (!pos) continue;
      var x = map.offX + num(pos.x, 0) * map.scale;
      var y = map.offZ + num(pos.z, 0) * map.scale;

      var isPlayer = car.control === 'player' || (!isSpectate && controlled && car.id === controlled.id);
      var isTarget = controlled ? car.id === controlled.id : false;

      try {
        m.ctx.beginPath();
        m.ctx.arc(x, y, isPlayer ? 5 : 3.4, 0, Math.PI * 2);
        m.ctx.fillStyle = isPlayer ? '#ff6a2b' : 'rgba(57, 230, 255, 0.92)';
        m.ctx.fill();

        if (isTarget) {
          m.ctx.beginPath();
          m.ctx.arc(x, y, isPlayer ? 8 : 6.4, 0, Math.PI * 2);
          m.ctx.lineWidth = 1.6;
          m.ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
          m.ctx.stroke();
        }
      } catch (e) { /* ignore */ }
    }
  }

  /* =========================================================================
   * 19. 导出
   * ========================================================================= */
  return {
    init: init,
    showScreen: showScreen,
    hideScreens: hideScreens,
    updateHUD: updateHUD,
    toast: toast,
    isBlocking: isBlocking
  };
})();
