/**
 * Horizon Rush · 极速地平线
 * util.js —— 通用工具库（Lead 所有，所有模块只读）
 *
 * 约定：
 *   - 不依赖 DOM 也可用（纯数学 / 存储部分），DOM 相关函数仅在浏览器中调用。
 *   - 所有函数对非法输入尽量返回安全值，不抛异常。
 */
window.HR = window.HR || {};

HR.Util = (function () {
  'use strict';

  var TWO_PI = Math.PI * 2;

  function clamp(v, lo, hi) {
    if (typeof v !== 'number' || v !== v) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function invLerp(a, b, v) {
    if (Math.abs(b - a) < 1e-9) return 0;
    return (v - a) / (b - a);
  }

  function mapRange(v, a, b, c, d) {
    return lerp(c, d, clamp(invLerp(a, b, v), 0, 1));
  }

  function smoothstep(t) {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** 把角度规范到 (-PI, PI] */
  function wrapAngle(a) {
    if (typeof a !== 'number' || a !== a) return 0;
    a = a % TWO_PI;
    if (a <= -Math.PI) a += TWO_PI;
    else if (a > Math.PI) a -= TWO_PI;
    return a;
  }

  /** 把数值规范到 [0, m) */
  function wrap(v, m) {
    if (!(m > 0)) return 0;
    v = v % m;
    return v < 0 ? v + m : v;
  }

  /** 帧率无关的指数平滑：把 current 以 rate(每秒) 逼近 target */
  function damp(current, target, rate, dt) {
    if (!(dt > 0)) return current;
    var k = 1 - Math.exp(-rate * dt);
    return current + (target - current) * k;
  }

  function sign(v) {
    return v < 0 ? -1 : (v > 0 ? 1 : 0);
  }

  /** mulberry32 确定性伪随机 */
  function rng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 由字符串/数字生成 32 位种子 */
  function hashSeed(v) {
    var s = String(v == null ? '' : v);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** 简单一维平滑噪声（用于生成器），返回 0..1 */
  function noise1(x, seed) {
    var i = Math.floor(x);
    var f = x - i;
    var r1 = rng((hashSeed(seed) + i * 374761393) >>> 0)();
    var r2 = rng((hashSeed(seed) + (i + 1) * 374761393) >>> 0)();
    return lerp(r1, r2, smoothstep(f));
  }

  /**
   * 格式化时间。输入秒，输出 "1:23.456" 或 "23.456"。
   * NaN/负数安全返回 "--:--"。
   */
  function formatTime(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '--:--';
    var ms = Math.round(sec * 1000);
    var m = Math.floor(ms / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var r = ms % 1000;
    if (m > 0) {
      return m + ':' + (s < 10 ? '0' : '') + s + '.' + (r < 100 ? '0' : '') + (r < 10 ? '0' : '') + r;
    }
    return s + '.' + (r < 100 ? '0' : '') + (r < 10 ? '0' : '') + r;
  }

  /** 格式化差值，如 "+0.352" / "-1.204"；nan 返回 "--" */
  function formatDelta(d) {
    if (typeof d !== 'number' || !isFinite(d)) return '--';
    var signStr = d >= 0 ? '+' : '-';
    return signStr + Math.abs(d).toFixed(3);
  }

  function pad(n, len) {
    var s = String(n);
    while (s.length < (len || 2)) s = '0' + s;
    return s;
  }

  /** 千分位 */
  function fmtNum(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '0';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* ---------------- 存储（file:// 下 localStorage 可能抛异常，自动降级） ---------------- */
  var memStore = {};
  var storage = {
    load: function (key, fallback) {
      try {
        var raw = window.localStorage.getItem(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch (e) {
        if (Object.prototype.hasOwnProperty.call(memStore, key)) return memStore[key];
        return fallback;
      }
    },
    save: function (key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        memStore[key] = value;
        return false;
      }
    },
    remove: function (key) {
      try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
      delete memStore[key];
    }
  };

  /* ---------------- DOM 小工具 ---------------- */
  function $(sel, root) {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  }

  function $all(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  }

  function el(tag, className, html) {
    var node = document.createElement(tag || 'div');
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function on(node, type, fn, opts) {
    if (!node || !node.addEventListener) return function () {};
    node.addEventListener(type, fn, opts);
    return function () { node.removeEventListener(type, fn, opts); };
  }

  function removeNode(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function isTouch() {
    try {
      return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    } catch (e) { return false; }
  }

  function now() {
    try { return performance.now() / 1000; } catch (e) { return Date.now() / 1000; }
  }

  function deepMerge(base, patch) {
    if (base == null || typeof base !== 'object') return patch;
    if (patch == null || typeof patch !== 'object') return base;
    var out = {};
    var k;
    for (k in base) {
      if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    }
    for (k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      var bv = base[k];
      var pv = patch[k];
      if (bv && pv && typeof bv === 'object' && typeof pv === 'object' &&
          !Array.isArray(bv) && !Array.isArray(pv)) {
        out[k] = deepMerge(bv, pv);
      } else {
        out[k] = pv;
      }
    }
    return out;
  }

  function clone(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
  }

  function formatNum(n, digits) {
    if (typeof n !== 'number' || !isFinite(n)) return '--';
    return n.toFixed(digits == null ? 1 : digits);
  }

  /** 速度显示换算 */
  function speedText(vMs, units) {
    var v = (vMs || 0) * 3.6;
    return Math.round(units === 'mph' ? v / 1.609344 : v);
  }

  function unitLabel(units) {
    return units === 'mph' ? 'MPH' : 'KM/H';
  }

  return {
    TWO_PI: TWO_PI,
    clamp: clamp,
    lerp: lerp,
    invLerp: invLerp,
    mapRange: mapRange,
    smoothstep: smoothstep,
    wrapAngle: wrapAngle,
    wrap: wrap,
    damp: damp,
    sign: sign,
    rng: rng,
    hashSeed: hashSeed,
    noise1: noise1,
    formatTime: formatTime,
    formatDelta: formatDelta,
    formatNum: formatNum,
    pad: pad,
    fmtNum: fmtNum,
    storage: storage,
    $: $,
    $all: $all,
    el: el,
    on: on,
    removeNode: removeNode,
    clearNode: clearNode,
    isTouch: isTouch,
    now: now,
    deepMerge: deepMerge,
    clone: clone,
    speedText: speedText,
    unitLabel: unitLabel
  };
})();
