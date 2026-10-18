/**
 * Horizon Rush · 极速地平线
 * render.js —— 伪 3D 渲染器（HR.Renderer）
 *
 * 设计要点：
 *  - 纯 Canvas 2D，无外部图片 / 字体 / CDN，所有精灵均由离屏 canvas 程序化预渲染。
 *  - 世界坐标：X 右、Y 上、Z 前（右手系）。相机 pos + yaw + pitch；
 *      depth = dot(d, forward)，sx = dot(d, right)，sy = dot(d, up)，
 *      screenX = W/2 + sx*focal/depth，screenY = H/2 - sy*focal/depth。
 *  - 画家算法：天空 → 远山 → 地面 → 道路（远→近逐段四边形）→ 精灵（车/场景按 depth 排序）→ 粒子 → 天气 → 后处理。
 *  - 每帧避免大对象分配：多边形顶点与投影结果用预分配 Float64Array；精灵全部缓存。
 *  - 只读传入的 frame / track / cars；不修改任何传入对象；不调用 UI / Audio。
 *
 * 加载顺序：config → util → ... → render，因此本文件可安全引用 HR.Util / HR.CARS。
 */
window.HR = window.HR || {};

HR.Renderer = (function () {
  'use strict';

  var U = HR.Util;

  /* ============================================================
   * 0. 常量
   * ============================================================ */

  var NEAR = 0.6;              // 近平面（m）
  var FOG_STEPS = 9;           // 雾色分级
  var MAX_POLY = 10;           // 裁剪后多边形最大顶点数
  var SPR_RES = 2;             // 车辆精灵内部分辨率倍率
  var SCENERY_RES = 1.6;       // 场景精灵内部分辨率倍率
  var CAR_SPR_W = 200;         // 车辆精灵逻辑宽（像素）
  var CAR_SPR_H = 150;         // 车辆精灵逻辑高
  var CAR_GROUND_FRAC = 0.92;  // 精灵内轮胎接地点所在高度比例（138/150）
  var CAR_SPR_ASPECT = CAR_SPR_H / CAR_SPR_W;
  var MAX_SEGMENTS = 300;      // 单帧最大绘制段数

  /* 画质档位：dpr 上限 / 绘制距离 / 细节可见距离系数 / 装饰跳步 / 粒子数 / 雨丝数 */
  var QUALITY = {
    low: {
      dpr: 1, draw: 380, shoulder: 0.42, lane: 0.30, rail: 0.32,
      stride: 2, gstride: 3, particles: 70, speedLines: 10, rain: 70
    },
    medium: {
      dpr: 1.5, draw: 430, shoulder: 0.50, lane: 0.38, rail: 0.40,
      stride: 1, gstride: 2, particles: 130, speedLines: 18, rain: 110
    },
    high: {
      dpr: 2, draw: 480, shoulder: 0.56, lane: 0.44, rail: 0.46,
      stride: 1, gstride: 2, particles: 210, speedLines: 26, rain: 150
    }
  };

  /* 区域调色板（白天基色，渲染时按光照/雾再合成；见 rebuildPalettes） */
  var ZONE_NAMES = ['festival', 'coast', 'desert', 'forest', 'mountain', 'city'];

  var ZONE_DEFS = {
    festival: {
      road: [56, 50, 74], roadAlt: [62, 56, 80], shoulder: [96, 68, 118],
      groundL: [96, 56, 126], groundR: [124, 72, 148],
      lane: [246, 238, 255], edge: [225, 210, 245], railA: [212, 164, 236], railB: [152, 110, 186]
    },
    coast: {
      road: [60, 64, 78], roadAlt: [66, 70, 84], shoulder: [214, 198, 152],
      groundL: [32, 78, 116], groundR: [206, 180, 122],
      lane: [250, 248, 235], edge: [226, 222, 200], railA: [226, 222, 202], railB: [188, 184, 164]
    },
    desert: {
      road: [86, 74, 62], roadAlt: [92, 80, 68], shoulder: [206, 172, 118],
      groundL: [190, 132, 72], groundR: [202, 148, 84],
      lane: [250, 244, 220], edge: [228, 214, 184], railA: [224, 204, 172], railB: [190, 168, 138]
    },
    forest: {
      road: [58, 58, 60], roadAlt: [64, 64, 66], shoulder: [96, 92, 72],
      groundL: [34, 68, 46], groundR: [42, 78, 52],
      lane: [240, 242, 232], edge: [206, 210, 196], railA: [196, 198, 188], railB: [160, 164, 154]
    },
    mountain: {
      road: [68, 68, 74], roadAlt: [74, 74, 80], shoulder: [142, 142, 148],
      groundL: [98, 98, 106], groundR: [108, 108, 116],
      lane: [242, 242, 248], edge: [210, 212, 222], railA: [234, 236, 244], railB: [196, 198, 208]
    },
    city: {
      road: [52, 50, 62], roadAlt: [58, 56, 70], shoulder: [96, 84, 146],
      groundL: [40, 38, 66], groundR: [46, 42, 72],
      lane: [186, 232, 255], edge: [140, 196, 240], railA: [152, 206, 255], railB: [110, 150, 210]
    }
  };

  var PAL_KEYS = ['road', 'roadAlt', 'shoulder', 'groundL', 'groundR', 'lane', 'edge', 'railA', 'railB'];

  /* 天空 / 环境颜色节点（RGB） */
  var DAY_TOP = [46, 118, 204];
  var DAY_HOR = [182, 220, 238];
  var NIGHT_TOP = [7, 9, 26];
  var NIGHT_HOR = [28, 32, 58];
  var WARM_TOP = [58, 44, 86];
  var WARM_HOR = [255, 138, 74];
  var RAIN_TOP = [58, 66, 82];
  var RAIN_HOR = [126, 134, 150];

  /* 远山层（数组顺序：近 → 远；绘制时从远到近）
   * mul 必须是整数：height(az) 以 2π 为周期，保证相机 yaw 跨越 ±π 时无接缝。 */
  var MOUNTAINS = [
    { h: 0.20, par: 1.00, mul: 1, p1: 0.7, p2: 2.1, p3: 4.3, mix: 0.64 },
    { h: 0.15, par: 1.16, mul: 2, p1: 2.4, p2: 0.8, p3: 3.0, mix: 0.48 },
    { h: 0.11, par: 1.34, mul: 3, p1: 4.2, p2: 1.6, p3: 0.4, mix: 0.34 }
  ];

  /* 场景装饰种类：精灵逻辑宽高 / 世界高度（m）/ 基准点抬高（m） */
  var KINDS = {
    palm: { w: 96, h: 172, worldH: 10.0, offY: 0 },
    cactus: { w: 72, h: 92, worldH: 4.2, offY: 0 },
    pine: { w: 84, h: 128, worldH: 12.0, offY: 0 },
    rock: { w: 92, h: 60, worldH: 2.8, offY: 0 },
    building: { w: 132, h: 214, worldH: 22.0, offY: 0 },
    billboard: { w: 162, h: 122, worldH: 7.6, offY: 0 },
    grandstand: { w: 196, h: 124, worldH: 7.0, offY: 0 },
    tent: { w: 116, h: 84, worldH: 4.6, offY: 0 },
    flag: { w: 60, h: 124, worldH: 7.6, offY: 0 },
    lightpole: { w: 52, h: 164, worldH: 9.5, offY: 0 },
    balloon: { w: 104, h: 134, worldH: 9.5, offY: 7.0 },
    sign: { w: 86, h: 74, worldH: 4.0, offY: 0 },
    bush: { w: 76, h: 50, worldH: 1.8, offY: 0 },
    barrier: { w: 100, h: 48, worldH: 1.3, offY: 0 }
  };

  /* 车身风格参数（逻辑坐标，精灵 200×150，地面线 y=138） */
  var BODY_STYLE = {
    gt: { halfB: 74, bodyTop: 78, bodyBottom: 118, roofHalf: 46, roofTop: 60, tire: 1.00, tireW: 26, wing: 0.35, livery: 0.0, lightBar: 0, roofBox: 0, roofPod: 0, underglow: 0, ground: 138 },
    hyper: { halfB: 80, bodyTop: 82, bodyBottom: 120, roofHalf: 40, roofTop: 56, tire: 1.10, tireW: 30, wing: 1.00, livery: 0.0, lightBar: 0, roofBox: 0, roofPod: 0, underglow: 0, ground: 138 },
    suv: { halfB: 76, bodyTop: 62, bodyBottom: 120, roofHalf: 56, roofTop: 38, tire: 1.15, tireW: 28, wing: 0.10, livery: 0.0, lightBar: 0, roofBox: 1, roofPod: 0, underglow: 0, ground: 138 },
    drift: { halfB: 72, bodyTop: 80, bodyBottom: 118, roofHalf: 44, roofTop: 58, tire: 1.00, tireW: 28, wing: 0.90, livery: 0.8, lightBar: 0, roofBox: 0, roofPod: 0, underglow: 0, ground: 138 },
    muscle: { halfB: 78, bodyTop: 82, bodyBottom: 120, roofHalf: 50, roofTop: 64, tire: 1.05, tireW: 30, wing: 0.20, livery: 0.6, lightBar: 0, roofBox: 0, roofPod: 0, underglow: 0, ground: 138 },
    ev: { halfB: 74, bodyTop: 80, bodyBottom: 118, roofHalf: 48, roofTop: 58, tire: 1.00, tireW: 26, wing: 0.30, livery: 0.0, lightBar: 1, roofBox: 0, roofPod: 0, underglow: 0, ground: 138 },
    rally: { halfB: 70, bodyTop: 70, bodyBottom: 118, roofHalf: 50, roofTop: 48, tire: 1.05, tireW: 26, wing: 0.50, livery: 0.9, lightBar: 0, roofBox: 0, roofPod: 1, underglow: 0, ground: 138 },
    street: { halfB: 74, bodyTop: 80, bodyBottom: 118, roofHalf: 44, roofTop: 60, tire: 1.00, tireW: 27, wing: 0.80, livery: 0.5, lightBar: 0, roofBox: 0, roofPod: 0, underglow: 1, ground: 138 }
  };

  /* ============================================================
   * 1. 模块状态
   * ============================================================ */

  var canvas = null;
  var ctx = null;
  var inited = false;
  var assetsReady = false;
  var paused = false;

  var qualityName = 'high';
  var qual = QUALITY.high;
  var drawDist = 480;
  var maxDpr = 2;

  var cssW = 0, cssH = 0;       // CSS 像素尺寸
  var W = 0, H = 0;             // 逻辑绘制尺寸（= CSS 像素）
  var dpr = 1;
  var focal = 720;              // 焦距（≈ H*0.9）
  var timeSec = 0;              // 当前帧游戏时间（用于动画）

  /* 相机（cam.* 为平滑值；cam.e* 为本帧生效值，含抖动） */
  var cam = {
    x: 0, y: 3, z: 0, yaw: 0, pitch: 0,
    ex: 0, ey: 3, ez: 0, eyaw: 0, epitch: 0,
    fx: 0, fy: 0, fz: 1,
    rx: 1, ry: 0, rz: 0,
    ux: 0, uy: 1, uz: 0,
    init: false, lastMode: '', lastTarget: null, lastTrack: null
  };
  var camTrackS = 0;            // 相机所对应的赛道 s（用于确定起始段与遍历方向）

  /* 帧级渲染状态 */
  var ST = {
    skyGrad: null, skyKey: '',
    groundGrad: null, groundKey: '',
    topGrad: null, vignette: null,
    camSeg: 0, segCount: 0, dirSign: 1, nSeg: 0, zoneNear: 'festival',
    camMode: 'chase',
    lastStation: 0,
    trackRef: null,
    cpRels: [],
    stars: [], clouds: []
  };

  /* 环境（天空/光照/雾）状态 */
  var ENV = {
    key: '', tod: 12, weather: 'clear',
    light: 1, night: 0, warm: 0, amb: 1, sunElev: 0,
    topR: 0, topG: 0, topB: 0,
    horR: 0, horG: 0, horB: 0,
    topCss: '#1a3c66', midCss: '#4a78a8', horCss: '#b6dcf0',
    nightFill: 'rgba(6,10,30,0)', warmFill: null
  };

  var palCache = {};

  /* 离屏精灵资源 */
  var assets = {
    sun: null, moon: null, clouds: [],
    brakeGlow: null, flame: null,
    particleSmoke: null, particleDust: null, particleSpark: null
  };
  var carSprites = {};
  var scenerySprites = {};

  /* ============================================================
   * 2. 数学 / 颜色 / 通用小工具
   * ============================================================ */

  function fin(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v : d;
  }

  function byte(v) {
    v = Math.round(v);
    if (!isFinite(v)) return 0;
    if (v < 0) return 0;
    if (v > 255) return 255;
    return v;
  }

  function rgbStr(r, g, b) {
    return 'rgb(' + byte(r) + ',' + byte(g) + ',' + byte(b) + ')';
  }

  function mix3(a, b, t) {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t
    ];
  }

  function mixRGB(r1, g1, b1, r2, g2, b2, t) {
    return [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t];
  }

  function hexToRgb(hex) {
    var h = String(hex == null ? '' : hex).replace('#', '').trim();
    if (h.length === 3) {
      h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    }
    if (h.length < 6) return [170, 175, 190];
    var n = parseInt(h.substring(0, 6), 16);
    if (!isFinite(n) || isNaN(n)) return [170, 175, 190];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function shadeCss(rgb, f) {
    return 'rgb(' + byte(rgb[0] * f) + ',' + byte(rgb[1] * f) + ',' + byte(rgb[2] * f) + ')';
  }

  /* 内部确定性随机（避免 Math.random，保证回放稳定） */
  var rndSeed = 0x2545f491;
  function rnd() {
    rndSeed = (Math.imul(rndSeed, 1664525) + 1013904223) >>> 0;
    return rndSeed / 4294967296;
  }

  function wrapIndex(i, count) {
    if (!(count > 0)) return 0;
    i = i % count;
    return i < 0 ? i + count : i;
  }

  function roundRect(c, x, y, w, h, r) {
    if (r > w * 0.5) r = w * 0.5;
    if (r > h * 0.5) r = h * 0.5;
    if (r < 0) r = 0;
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  /* ============================================================
   * 3. 赛道 / 采样安全包装（不修改 track 对象）
   * ============================================================ */

  var SMP_A = {
    x: 0, y: 0, z: 0, dirX: 0, dirZ: 1, rightX: 1, rightZ: 0,
    yaw: 0, slope: 0, width: 14, curve: 0, zone: 'festival', segIndex: 0
  };
  var SMP_B = {
    x: 0, y: 0, z: 0, dirX: 0, dirZ: 1, rightX: 1, rightZ: 0,
    yaw: 0, slope: 0, width: 14, curve: 0, zone: 'festival', segIndex: 0
  };

  function segIndexAt(track, s) {
    if (!track || !track.segments || !track.segments.length) return 0;
    var segs = track.segments;
    var count = segs.length;
    if (typeof track.segAt === 'function') {
      try {
        var i = track.segAt(s);
        if (typeof i === 'number' && isFinite(i)) {
          i = i | 0;
          if (i >= 0 && i < count) return i;
        }
      } catch (e) { /* 降级到近似法 */ }
    }
    var length = fin(track.length, 0);
    if (!(length > 0)) return 0;
    var ss = U.wrap(fin(s, 0), length);
    var idx = ((ss / length) * count) | 0;
    if (!(idx >= 0)) idx = 0;
    if (idx >= count) idx = count - 1;
    return idx;
  }

  function safeSample(track, s, lat, out) {
    var o = out || SMP_A;
    o.x = 0; o.y = 0; o.z = 0;
    o.dirX = 0; o.dirZ = 1; o.rightX = 1; o.rightZ = 0;
    o.yaw = 0; o.slope = 0; o.width = 14; o.curve = 0;
    o.zone = 'festival'; o.segIndex = 0;

    var got = false;
    if (track && typeof track.sample === 'function') {
      try {
        var r = track.sample(fin(s, 0), fin(lat, 0));
        if (r && typeof r === 'object') {
          o.x = fin(r.x, 0);
          o.y = fin(r.y, 0);
          o.z = fin(r.z, 0);
          o.dirX = fin(r.dirX, 0);
          o.dirZ = fin(r.dirZ, 1);
          o.rightX = fin(r.rightX, 1);
          o.rightZ = fin(r.rightZ, 0);
          o.yaw = fin(r.yaw, Math.atan2(o.dirX, o.dirZ));
          o.slope = fin(r.slope, 0);
          o.width = fin(r.width, 14);
          o.curve = fin(r.curve, 0);
          o.zone = (typeof r.zone === 'string' && ZONE_DEFS[r.zone]) ? r.zone : 'festival';
          o.segIndex = (typeof r.segIndex === 'number' && isFinite(r.segIndex)) ? (r.segIndex | 0) : 0;
          got = true;
        }
      } catch (e) { /* 降级 */ }
    }

    if (!got) {
      var segs = (track && track.segments) ? track.segments : null;
      if (segs && segs.length) {
        var i0 = segIndexAt(track, s);
        var sg = segs[i0];
        if (sg) {
          var lat2 = fin(lat, 0);
          var rx = fin(sg.rightX, 1);
          var rz = fin(sg.rightZ, 0);
          o.x = fin(sg.x, 0) + rx * lat2;
          o.y = fin(sg.y, 0);
          o.z = fin(sg.z, 0) + rz * lat2;
          o.dirX = fin(sg.dirX, 0);
          o.dirZ = fin(sg.dirZ, 1);
          o.rightX = rx;
          o.rightZ = rz;
          o.yaw = fin(sg.yaw, Math.atan2(o.dirX, o.dirZ));
          o.width = fin(sg.width, 14);
          o.zone = (typeof sg.zone === 'string' && ZONE_DEFS[sg.zone]) ? sg.zone : 'festival';
          o.segIndex = i0;
        }
      }
    }
    if (!(fin(o.width, 14) > 2)) o.width = 14;
    return o;
  }

  /* 门口（起跑线 / 检查点）缓存：按 track 对象引用失效 */
  var gateCache = { track: null, startSeg: 0, cps: [] };

  function getGates(track) {
    if (gateCache.track === track) return gateCache;
    gateCache.track = track;
    gateCache.cps.length = 0;
    var startS = fin(track.startS, 0);
    gateCache.startSeg = segIndexAt(track, startS);
    var cps = track.checkpoints;
    if (Array.isArray(cps)) {
      for (var i = 0; i < cps.length; i++) {
        var cs = fin(cps[i], NaN);
        if (isFinite(cs)) gateCache.cps.push({ s: cs, seg: segIndexAt(track, cs) });
      }
    }
    return gateCache;
  }

  function relViewIndex(segIdx, camSeg, dirSign, count) {
    if (!(count > 0)) return -1;
    var rel = dirSign > 0 ? (segIdx - camSeg) : (camSeg - segIdx);
    rel = rel % count;
    if (rel < 0) rel += count;
    return rel;
  }

  /* --------------------------------------------------------------------------
   * 顶点横截面缓存（每段起点即一个"顶点"）。
   * track 只给每个 segment 起点方向的 right 向量，若相邻四边形各自使用自己的 right，
   * 在弯道上接缝处会错开最多 |curve|*len*width/2 ≈ 0.8m（屏幕上非常明显）。
   * 因此这里在顶点处取前后两段方向的"斜接"（miter）作为 right，
   * 宽度取前后两段的平均值；相邻两个四边形共享同一横截面 ⇒ 接缝完全对齐。
   * ------------------------------------------------------------------------ */
  var vtxCache = { track: null, n: 0, rx: null, rz: null, hw: null };

  function getVertexData(track) {
    if (vtxCache.track === track && vtxCache.n === track.segments.length) return vtxCache;
    var segments = track.segments;
    var n = segments.length;
    if (!(n > 0)) return vtxCache;

    var rx = new Float32Array(n);
    var rz = new Float32Array(n);
    var hw = new Float32Array(n);

    for (var k = 0; k < n; k++) {
      var prev = segments[(k - 1 + n) % n];
      var cur = segments[k];
      var dx1 = fin(prev ? prev.dirX : 0, 0);
      var dz1 = fin(prev ? prev.dirZ : 1, 1);
      var dx2 = fin(cur ? cur.dirX : 0, 0);
      var dz2 = fin(cur ? cur.dirZ : 1, 1);
      var l1 = Math.sqrt(dx1 * dx1 + dz1 * dz1);
      if (!(l1 > 1e-6)) { dx1 = 0; dz1 = 1; l1 = 1; }
      var l2 = Math.sqrt(dx2 * dx2 + dz2 * dz2);
      if (!(l2 > 1e-6)) { dx2 = 0; dz2 = 1; l2 = 1; }
      var tx = dx1 / l1 + dx2 / l2;
      var tz = dz1 / l1 + dz2 / l2;
      var tl = Math.sqrt(tx * tx + tz * tz);
      if (!(tl > 1e-6)) { tx = dx2 / l2; tz = dz2 / l2; tl = 1; }
      tx /= tl;
      tz /= tl;
      rx[k] = tz;
      rz[k] = -tx;
      var w1 = fin(prev ? prev.width : 14, 14);
      var w2 = fin(cur ? cur.width : 14, 14);
      var h = (w1 + w2) * 0.25;
      if (!(h > 2)) h = 7;
      if (h > 30) h = 30;
      hw[k] = h;
    }

    vtxCache.track = track;
    vtxCache.n = n;
    vtxCache.rx = rx;
    vtxCache.rz = rz;
    vtxCache.hw = hw;
    return vtxCache;
  }

  /* ============================================================
   * 4. 投影 / 多边形裁剪
   * ============================================================ */

  var P = { sx: 0, sy: 0, d: 0, ok: false };

  function projectScalar(wx, wy, wz) {
    var dx = wx - cam.ex;
    var dy = wy - cam.ey;
    var dz = wz - cam.ez;
    var d = dx * cam.fx + dy * cam.fy + dz * cam.fz;
    if (!(d > NEAR)) { P.ok = false; P.d = d; return P; }
    var sx = dx * cam.rx + dy * cam.ry + dz * cam.rz;
    var sy = dx * cam.ux + dy * cam.uy + dz * cam.uz;
    var inv = focal / d;
    var px = W * 0.5 + sx * inv;
    var py = H * 0.5 - sy * inv;
    if (!isFinite(px) || !isFinite(py)) { P.ok = false; P.d = d; return P; }
    P.sx = px; P.sy = py; P.d = d; P.ok = true;
    return P;
  }

  /* 预分配工作数组（全局顺序使用，不嵌套调用） */
  var WPX = new Float64Array(MAX_POLY), WPY = new Float64Array(MAX_POLY), WPZ = new Float64Array(MAX_POLY);
  var CPX = new Float64Array(MAX_POLY), CPY = new Float64Array(MAX_POLY), CPZ = new Float64Array(MAX_POLY);
  var SX = new Float64Array(MAX_POLY), SY = new Float64Array(MAX_POLY);
  var polyN = 0;

  /**
   * 近平面裁剪 + 投影。输入多边形在 WPX/WPY/WPZ 前 n 个顶点。
   * 成功返回 true，投影结果写入 SX/SY（数量 polyN）。
   */
  function prepPoly(n) {
    var m = 0;
    for (var i = 0; i < n; i++) {
      var j = i + 1;
      if (j === n) j = 0;
      var x1 = WPX[i], y1 = WPY[i], z1 = WPZ[i];
      var x2 = WPX[j], y2 = WPY[j], z2 = WPZ[j];
      var d1 = (x1 - cam.ex) * cam.fx + (y1 - cam.ey) * cam.fy + (z1 - cam.ez) * cam.fz;
      var d2 = (x2 - cam.ex) * cam.fx + (y2 - cam.ey) * cam.fy + (z2 - cam.ez) * cam.fz;
      var in1 = d1 >= NEAR;
      var in2 = d2 >= NEAR;
      if (in1) {
        if (m >= MAX_POLY) return false;
        CPX[m] = x1; CPY[m] = y1; CPZ[m] = z1; m++;
      }
      if (in1 !== in2) {
        var den = d2 - d1;
        if (!(Math.abs(den) > 1e-9)) return false;
        var t = (NEAR - d1) / den;
        if (!isFinite(t)) return false;
        if (m >= MAX_POLY) return false;
        CPX[m] = x1 + (x2 - x1) * t;
        CPY[m] = y1 + (y2 - y1) * t;
        CPZ[m] = z1 + (z2 - z1) * t;
        m++;
      }
    }
    if (m < 3) return false;

    for (var k = 0; k < m; k++) {
      var dx = CPX[k] - cam.ex;
      var dy = CPY[k] - cam.ey;
      var dz = CPZ[k] - cam.ez;
      var d = dx * cam.fx + dy * cam.fy + dz * cam.fz;
      if (!(d > 0.2)) return false;
      var inv = focal / d;
      var px = W * 0.5 + (dx * cam.rx + dy * cam.ry + dz * cam.rz) * inv;
      var py = H * 0.5 - (dx * cam.ux + dy * cam.uy + dz * cam.uz) * inv;
      if (!isFinite(px) || !isFinite(py)) return false;
      if (px < -200000 || px > 200000 || py < -200000 || py > 200000) return false;
      SX[k] = px;
      SY[k] = py;
    }
    polyN = m;
    return true;
  }

  function drawPolyFill() {
    ctx.beginPath();
    ctx.moveTo(SX[0], SY[0]);
    for (var i = 1; i < polyN; i++) ctx.lineTo(SX[i], SY[i]);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * 世界空间四边形填充。
   * color 为预生成颜色字符串；seam=true 时额外描边同色以消除相邻四边形接缝。
   */
  function fillQuad(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, color, seam) {
    WPX[0] = x0; WPY[0] = y0; WPZ[0] = z0;
    WPX[1] = x1; WPY[1] = y1; WPZ[1] = z1;
    WPX[2] = x2; WPY[2] = y2; WPZ[2] = z2;
    WPX[3] = x3; WPY[3] = y3; WPZ[3] = z3;
    if (!prepPoly(4)) return false;
    ctx.fillStyle = color;
    drawPolyFill();
    if (seam) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    return true;
  }

  /* ============================================================
   * 5. 环境色 / 调色板
   * ============================================================ */

  function updateEnv(tod, weather) {
    ENV.tod = tod;
    ENV.weather = weather;

    var sunElev = Math.sin((tod - 6) / 12 * Math.PI);
    ENV.sunElev = sunElev;

    var light = U.clamp(sunElev * 1.35 + 0.50, 0, 1);
    if (weather === 'night') light *= 0.45;
    else if (weather === 'rain') light *= 0.72;
    else if (weather === 'dawn' || weather === 'dusk') light *= 0.9;

    var warm = U.clamp(1 - Math.abs(sunElev) * 2.0, 0, 1);
    if (weather === 'dawn') warm = Math.max(warm, 0.5);
    else if (weather === 'dusk') warm = Math.max(warm, 0.78);
    if (weather === 'night' || weather === 'rain') warm *= 0.25;

    var night = 1 - light;
    ENV.light = light;
    ENV.night = night;
    ENV.warm = warm;

    var top = mix3(NIGHT_TOP, DAY_TOP, light);
    top = mix3(top, WARM_TOP, warm * 0.45);
    var hor = mix3(NIGHT_HOR, DAY_HOR, light);
    hor = mix3(hor, WARM_HOR, warm * 0.8);
    var mid = mix3(top, hor, 0.55);

    if (weather === 'rain') {
      top = mix3(top, RAIN_TOP, 0.55);
      mid = mix3(mid, RAIN_TOP, 0.45);
      hor = mix3(hor, RAIN_HOR, 0.6);
    }

    ENV.topR = top[0]; ENV.topG = top[1]; ENV.topB = top[2];
    ENV.horR = hor[0]; ENV.horG = hor[1]; ENV.horB = hor[2];
    ENV.amb = 0.55 + 0.45 * light;

    var key = Math.round(tod * 24) + '|' + weather + '|' + Math.round(light * 14);
    if (key !== ENV.key) {
      ENV.key = key;
      ENV.topCss = rgbStr(top[0], top[1], top[2]);
      ENV.midCss = rgbStr(mid[0], mid[1], mid[2]);
      ENV.horCss = rgbStr(hor[0], hor[1], hor[2]);
      ENV.nightFill = 'rgba(6,10,30,' + (0.36 * night).toFixed(3) + ')';
      ENV.warmFill = (warm > 0.02) ? ('rgba(255,124,58,' + (0.10 * warm).toFixed(3) + ')') : null;
      rebuildPalettes();
    }
  }

  function rebuildPalettes() {
    var amb = ENV.amb;
    var horR = ENV.horR, horG = ENV.horG, horB = ENV.horB;
    var light = ENV.light;

    for (var zi = 0; zi < ZONE_NAMES.length; zi++) {
      var name = ZONE_NAMES[zi];
      var def = ZONE_DEFS[name];
      var pal = palCache[name];
      if (!pal) {
        pal = {
          road: [], roadAlt: [], shoulder: [], groundL: [], groundR: [],
          lane: [], edge: [], railA: [], railB: []
        };
        palCache[name] = pal;
      }
      for (var mi = 0; mi < PAL_KEYS.length; mi++) {
        var key = PAL_KEYS[mi];
        var base = def[key];
        if (!base) continue;
        var arr = pal[key];
        if (!arr) arr = pal[key] = [];
        var scale = (key === 'lane' || key === 'edge' || key === 'railA' || key === 'railB')
          ? (0.68 + 0.32 * light)
          : amb;
        for (var s = 0; s < FOG_STEPS; s++) {
          var t = s / (FOG_STEPS - 1);
          var fogT = t * t;   // 远处完全融入地平线色
          var r = base[0] * scale;
          var g = base[1] * scale;
          var b = base[2] * scale;
          r = r + (horR - r) * fogT;
          g = g + (horG - g) * fogT;
          b = b + (horB - b) * fogT;
          arr[s] = rgbStr(r, g, b);
        }
      }
    }
  }

  function fogStepOf(depth) {
    var fogStart = drawDist * 0.32;
    var span = drawDist - fogStart;
    if (!(span > 1)) span = 1;
    var t = (depth - fogStart) / span;
    if (!(t > 0)) t = 0;
    if (t > 1) t = 1;
    var s = (t * (FOG_STEPS - 1) + 0.5) | 0;
    if (s < 0) s = 0;
    if (s > FOG_STEPS - 1) s = FOG_STEPS - 1;
    return s;
  }

  /* ============================================================
   * 6. 相机
   * ============================================================ */

  function updateCamera(frame, track, cars, t, dt) {
    var camF = (frame.camera && typeof frame.camera === 'object') ? frame.camera : null;
    var mode = camF ? camF.mode : 'chase';
    if (mode !== 'chase' && mode !== 'hood' && mode !== 'trackside' && mode !== 'heli') mode = 'chase';
    ST.camMode = mode;

    var target = null;
    if (camF && camF.targetCar && typeof camF.targetCar === 'object') target = camF.targetCar;
    else if (cars.length && cars[0] && typeof cars[0] === 'object') target = cars[0];
    if (!target && cars.length) target = cars[0] || null;

    var shake = camF ? U.clamp(fin(camF.shake, 0), 0, 1) : 0;

    var tgtX = cam.x, tgtY = cam.y, tgtZ = cam.z;
    var tgtYaw = cam.yaw, tgtPitch = cam.pitch;
    var trackS = camTrackS;

    var hasTrack = !!(track && track.segments && track.segments.length);

    if (target && hasTrack) {
      var ts = fin(target.s, 0);
      var tx = fin(target.x, 0);
      var smp = safeSample(track, ts, tx, SMP_A);
      var carX = smp.x, carY = smp.y, carZ = smp.z;
      var dirX = smp.dirX, dirZ = smp.dirZ;
      var dl = Math.sqrt(dirX * dirX + dirZ * dirZ);
      if (dl > 1e-6) { dirX /= dl; dirZ /= dl; }
      else { dirX = Math.sin(smp.yaw); dirZ = Math.cos(smp.yaw); }

      var speed = Math.max(0, fin(target.v, 0));
      var sp01 = U.clamp(speed / 70, 0, 1);

      var lookX, lookY, lookZ;
      var stationChanged = false;
      trackS = ts;

      if (mode === 'hood') {
        tgtX = carX + dirX * 1.8;
        tgtZ = carZ + dirZ * 1.8;
        tgtY = carY + 1.2;
        lookX = carX + dirX * 34;
        lookZ = carZ + dirZ * 34;
        lookY = carY + 0.75 + fin(smp.slope, 0) * 10;
      } else if (mode === 'trackside') {
        /* 观战转播机位：始终位于车前方 ~58m（契约 45~70m）的路边，看向车；
           每约 900m 换一次左右侧，换侧时硬切。 */
        var lead = 58;
        var camS = ts + lead;
        var sideIdx = Math.floor((ts + 400) / 900);
        var side = (sideIdx & 1) ? -1 : 1;
        if (ST.lastStation !== sideIdx) {
          ST.lastStation = sideIdx;
          stationChanged = true;
        }
        var smp2 = safeSample(track, camS, 0, SMP_B);
        var halfW = fin(smp2.width, 14) * 0.5;
        var lat2 = (halfW + 5.5) * side;
        var r2x = fin(smp2.rightX, 1);
        var r2z = fin(smp2.rightZ, 0);
        tgtX = smp2.x + r2x * lat2;
        tgtZ = smp2.z + r2z * lat2;
        tgtY = smp2.y + 2.6;
        lookX = carX;
        lookY = carY + 1.0;
        lookZ = carZ;
        /* 起始段放到相机身后（观战看向车尾方向），确保屏幕底部有路面 */
        trackS = camS + 16;
      } else if (mode === 'heli') {
        tgtX = carX - dirX * 24;
        tgtZ = carZ - dirZ * 24;
        tgtY = carY + 40;
        lookX = carX + dirX * 4;
        lookY = carY + 1.2;
        lookZ = carZ + dirZ * 4;
        /* 起始段放在相机身后，保证相机脚下的路面/地面也能被绘制 */
        trackS = ts - 38;
      } else {
        var back = 7.6 + sp01 * 2.0;
        var hgt = 2.9 + sp01 * 0.8;
        tgtX = carX - dirX * back;
        tgtZ = carZ - dirZ * back;
        tgtY = carY + hgt;
        var ahead = 12 + sp01 * 8;
        lookX = carX + dirX * ahead;
        lookZ = carZ + dirZ * ahead;
        lookY = carY + 0.9 + fin(smp.slope, 0) * 8;
        /* 起始段放在相机身后，避免屏幕底部出现"没有路面"的空洞 */
        trackS = ts - (back + 8.0);
      }

      var ax = lookX - tgtX;
      var az = lookZ - tgtZ;
      var ay = lookY - tgtY;
      var horiz = Math.sqrt(ax * ax + az * az);
      if (!(horiz > 0.001)) horiz = 0.001;
      tgtYaw = Math.atan2(ax, az);
      tgtPitch = U.clamp(Math.atan2(ay, horiz), -1.0, 1.0);
    } else if (hasTrack) {
      /* 无车：赛道起点后的固定机位 */
      var smp3 = safeSample(track, 0, 0, SMP_A);
      var ddx = smp3.dirX, ddz = smp3.dirZ;
      var dl3 = Math.sqrt(ddx * ddx + ddz * ddz);
      if (dl3 > 1e-6) { ddx /= dl3; ddz /= dl3; } else { ddx = 0; ddz = 1; }
      tgtX = smp3.x - ddx * 9;
      tgtZ = smp3.z - ddz * 9;
      tgtY = smp3.y + 3.2;
      var lx3 = smp3.x + ddx * 20;
      var lz3 = smp3.z + ddz * 20;
      tgtYaw = Math.atan2(lx3 - tgtX, lz3 - tgtZ);
      var dh3 = Math.sqrt((lx3 - tgtX) * (lx3 - tgtX) + (lz3 - tgtZ) * (lz3 - tgtZ));
      if (!(dh3 > 0.001)) dh3 = 0.001;
      tgtPitch = U.clamp(Math.atan2((smp3.y + 1.2) - tgtY, dh3), -1.0, 1.0);
      trackS = 0;
    }

    camTrackS = trackS;

    var snap = !cam.init || cam.lastMode !== mode || cam.lastTarget !== target ||
      cam.lastTrack !== track || (mode === 'trackside' && stationChanged);
    cam.lastMode = mode;
    cam.lastTarget = target;
    cam.lastTrack = track;

    if (snap || !(dt > 0)) {
      cam.x = tgtX; cam.y = tgtY; cam.z = tgtZ;
      cam.yaw = tgtYaw; cam.pitch = tgtPitch;
    } else {
      var posRate = 26, yawRate = 9.5, pitchRate = 8;
      if (mode === 'trackside') { posRate = 14; yawRate = 6; pitchRate = 6; }
      else if (mode === 'heli') { posRate = 14; yawRate = 6; pitchRate = 6; }
      else if (mode === 'hood') { posRate = 40; yawRate = 20; pitchRate = 18; }

      var kp = 1 - Math.exp(-posRate * dt);
      cam.x += (tgtX - cam.x) * kp;
      cam.y += (tgtY - cam.y) * kp;
      cam.z += (tgtZ - cam.z) * kp;

      var kyw = 1 - Math.exp(-yawRate * dt);
      cam.yaw = U.wrapAngle(cam.yaw + U.wrapAngle(tgtYaw - cam.yaw) * kyw);

      var kpt = 1 - Math.exp(-pitchRate * dt);
      cam.pitch += (tgtPitch - cam.pitch) * kpt;
    }

    cam.init = true;

    /* 抖动：只作用于本帧生效值，不影响平滑状态 */
    if (shake > 0.003) {
      var st = t * 43.0;
      var amp = shake * 0.42;
      cam.ex = cam.x + Math.sin(st) * amp;
      cam.ey = cam.y + Math.sin(st * 1.37 + 1.1) * amp * 0.7;
      cam.ez = cam.z + Math.cos(st * 0.91) * amp;
      cam.eyaw = cam.yaw + Math.sin(st * 1.71) * shake * 0.022;
      cam.epitch = cam.pitch + Math.sin(st * 2.13 + 2.0) * shake * 0.016;
    } else {
      cam.ex = cam.x; cam.ey = cam.y; cam.ez = cam.z;
      cam.eyaw = cam.yaw; cam.epitch = cam.pitch;
    }

    if (!(cam.eyaw === cam.eyaw)) cam.eyaw = 0;
    if (!(cam.epitch === cam.epitch)) cam.epitch = 0;
    if (!(cam.ex === cam.ex)) cam.ex = 0;
    if (!(cam.ey === cam.ey)) cam.ey = 0;
    if (!(cam.ez === cam.ez)) cam.ez = 0;

    updateBasis();
  }

  function updateBasis() {
    var yaw = cam.eyaw;
    var pitch = cam.epitch;
    var sy = Math.sin(yaw), cy = Math.cos(yaw);
    var sp = Math.sin(pitch), cp = Math.cos(pitch);
    cam.fx = sy * cp; cam.fy = sp; cam.fz = cy * cp;
    cam.rx = cy; cam.ry = 0; cam.rz = -sy;
    cam.ux = -sy * sp; cam.uy = cp; cam.uz = -cy * sp;
  }

  function horizonY() {
    var p = U.clamp(fin(cam.epitch, 0), -0.75, 0.75);
    var hy = H * 0.5 + focal * Math.tan(p);
    return U.clamp(hy, -H, H * 2);
  }

  /* ============================================================
   * 7. 天空 / 远山 / 云 / 星空
   * ============================================================ */

  function drawSky(t, tod) {
    var hy = horizonY();

    var skyKey = ENV.key + '|' + Math.round(hy * 0.125);
    if (!ST.skyGrad || skyKey !== ST.skyKey) {
      try {
        var g = ctx.createLinearGradient(0, 0, 0, Math.max(30, hy + 40));
        g.addColorStop(0, ENV.topCss);
        g.addColorStop(0.55, ENV.midCss);
        g.addColorStop(1, ENV.horCss);
        ST.skyGrad = g;
      } catch (e) {
        ST.skyGrad = null;
      }
      ST.skyKey = skyKey;
    }

    if (ST.skyGrad) {
      ctx.fillStyle = ST.skyGrad;
      ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = ENV.horCss || '#101828';
      ctx.fillRect(0, 0, W, H);
    }

    if (ENV.night > 0.10) drawStars();
    if (ENV.night > 0.28) drawMoon(hy);
    if (ENV.light > 0.06) drawSun(hy);
    drawClouds(hy);
    drawMountains(hy);
  }

  function drawStars() {
    var list = ST.stars;
    if (!list || !list.length) return;
    var a = U.clamp((ENV.night - 0.10) / 0.7, 0, 1) * 0.85;
    if (!(a > 0.02)) return;
    ctx.fillStyle = 'rgba(230,238,255,' + a.toFixed(2) + ')';
    ctx.beginPath();
    /* 平移在 yaw 转过 2π 时恰好是 W 的整数倍，保证首尾无缝 */
    var shift = (cam.eyaw / (Math.PI * 2)) * W * 2;
    var lim = H * 0.72;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var x = U.wrap(s.x * W + shift, W);
      var y = s.y * lim;
      ctx.rect(x, y, s.r, s.r);
    }
    ctx.fill();
  }

  function drawSun(hy) {
    if (!assets.sun) return;
    var az = 0.25 + (ENV.tod - 6) * 0.12;
    var diff = U.wrapAngle(az - cam.eyaw);
    if (diff < -1.25 || diff > 1.25) return;
    var x = W * 0.5 + focal * Math.tan(diff);
    if (x < -W * 0.5 || x > W * 1.5) return;
    var elev = U.clamp(ENV.sunElev * 1.15, -0.18, 1.05);
    var y = hy - focal * Math.tan(U.clamp(elev, -0.18, 1.1));
    var r = H * (0.055 + 0.02 * U.clamp(ENV.sunElev, 0, 1));
    if (!(r > 4)) r = 4;
    var alpha = U.clamp((ENV.light - 0.05) / 0.5, 0, 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(assets.sun, x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  function drawMoon(hy) {
    if (!assets.moon) return;
    var az = 0.25 + (ENV.tod - 6) * 0.12 + Math.PI;
    var diff = U.wrapAngle(az - cam.eyaw);
    if (diff < -1.25 || diff > 1.25) return;
    var x = W * 0.5 + focal * Math.tan(diff);
    if (x < -W * 0.5 || x > W * 1.5) return;
    var elev = U.clamp(-ENV.sunElev * 0.9, 0.08, 1.05);
    var y = hy - focal * Math.tan(elev);
    var r = H * 0.042;
    if (!(r > 4)) r = 4;
    var alpha = U.clamp((ENV.night - 0.15) / 0.5, 0, 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(assets.moon, x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  function drawClouds(hy) {
    var list = ST.clouds;
    if (!list || !list.length || !assets.clouds.length) return;
    var alphaBase = 0.18 + 0.34 * ENV.light;
    for (var i = 0; i < list.length; i++) {
      var cl = list[i];
      var diff = U.wrapAngle(cl.az - cam.eyaw);
      if (diff < -1.1 || diff > 1.1) continue;
      var x = W * 0.5 + focal * Math.tan(diff);
      if (x < -W * 0.7 || x > W * 1.7) continue;
      var y = hy - focal * Math.tan(cl.elev);
      if (y < -H * 0.5 || y > hy + 40) continue;
      var size = cl.scale * H * 0.20;
      var spr = assets.clouds[cl.spr % assets.clouds.length];
      if (!spr || !(size > 2)) continue;
      ctx.globalAlpha = alphaBase * cl.alpha;
      ctx.drawImage(spr, x - size, y - size * 0.42, size * 2, size * 0.84);
      ctx.globalAlpha = 1;
    }
  }

  function drawMountains(hy) {
    var baseY = hy + 8;
    for (var li = MOUNTAINS.length - 1; li >= 0; li--) {
      var L = MOUNTAINS[li];
      var col = mixRGB(ENV.horR, ENV.horG, ENV.horB, 28, 32, 50, L.mix);
      ctx.fillStyle = rgbStr(col[0], col[1], col[2]);
      var step = li === 0 ? 8 : 12;
      ctx.beginPath();
      ctx.moveTo(-14, baseY + 40);
      for (var x = -14; x <= W + 14; x += step) {
        var az = cam.eyaw + Math.atan((x - W * 0.5) / (focal * L.par));
        var v = 0.5
          + 0.30 * Math.sin(az * 3 * L.mul + L.p1)
          + 0.18 * Math.sin(az * 7 * L.mul + L.p2)
          + 0.10 * Math.sin(az * 13 * L.mul + L.p3);
        if (!(v > 0.06)) v = 0.06;
        if (v > 1) v = 1;
        ctx.lineTo(x, baseY - v * L.h * H);
      }
      ctx.lineTo(W + 14, baseY + 40);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* ============================================================
   * 8. 地面底色 + 逐段路面
   * ============================================================ */

  function drawGroundBase() {
    var hy = U.clamp(horizonY(), 0, H);
    var zone = ST.zoneNear;
    var def = ZONE_DEFS[zone] || ZONE_DEFS.festival;
    var key = ENV.key + '|' + zone + '|' + Math.round(hy / 6);
    if (!ST.groundGrad || key !== ST.groundKey) {
      try {
        var top = U.clamp(hy, 0, H - 2);
        var g = ctx.createLinearGradient(0, top, 0, H);
        var amb = ENV.amb;
        var midC = mixRGB(
          def.groundR[0] * amb, def.groundR[1] * amb, def.groundR[2] * amb,
          ENV.horR, ENV.horG, ENV.horB, 0.62
        );
        var nearC = [
          def.groundR[0] * amb * 0.85,
          def.groundR[1] * amb * 0.85,
          def.groundR[2] * amb * 0.85
        ];
        g.addColorStop(0, ENV.horCss);
        g.addColorStop(0.20, rgbStr(midC[0], midC[1], midC[2]));
        g.addColorStop(1, rgbStr(nearC[0], nearC[1], nearC[2]));
        ST.groundGrad = g;
      } catch (e) {
        ST.groundGrad = null;
      }
      ST.groundKey = key;
    }
    if (ST.groundGrad) {
      ctx.fillStyle = ST.groundGrad;
      ctx.fillRect(0, hy, W, H - hy + 1);
    } else {
      ctx.fillStyle = ENV.horCss || '#20242c';
      ctx.fillRect(0, hy, W, H - hy + 1);
    }
  }

  /**
   * 地面条带：把相邻 gstride 段合并成一个长四边形，一直画到 drawDist。
   * 远端颜色由雾完全融入地平线色，避免地面在 drawDist 处出现截断硬边。
   * 地面与路面共面且横向不重叠，因此在道路之前绘制是安全的。
   */
  function drawGroundGroup(track, count, camSeg, dirSign, v0, vi) {
    var segments = track.segments;
    var vd = getVertexData(track);
    var vRX = vd.rx;
    var vRZ = vd.rz;
    var vHW = vd.hw;

    /* 近 / 远顶点（顶点 k = segments[k] 起点） */
    var idxN, idxF;
    if (dirSign > 0) {
      idxN = wrapIndex(camSeg + v0, count);
      idxF = wrapIndex(camSeg + vi + 1, count);
    } else {
      idxN = wrapIndex(camSeg - v0 + 1, count);
      idxF = wrapIndex(camSeg - vi, count);
    }
    var segN = segments[idxN];
    var segF = segments[idxF];
    if (!segN || !segF) return;

    var nearX = fin(segN.x, 0);
    var nearY = fin(segN.y, 0);
    var nearZ = fin(segN.z, 0);
    var farX = fin(segF.x, nearX);
    var farY = fin(segF.y, nearY);
    var farZ = fin(segF.z, nearZ);

    projectScalar(nearX, nearY, nearZ);
    var nearD = P.ok ? P.d : 0;
    projectScalar(farX, farY, farZ);
    var farD = P.ok ? P.d : drawDist * 2;
    if (nearD > drawDist) return;

    var dRef = farD;
    if (dRef > drawDist) dRef = drawDist;
    if (!(dRef > 1)) dRef = 1;

    var zone = (typeof segF.zone === 'string' && ZONE_DEFS[segF.zone]) ? segF.zone : 'festival';
    var pal = palCache[zone] || palCache.festival;
    if (!pal) return;
    var f = fogStepOf(dRef);

    var nearHalf = fin(vHW[idxN], 7);
    var farHalf = fin(vHW[idxF], 7);
    var nrx = fin(vRX[idxN], 1);
    var nrz = fin(vRZ[idxN], 0);
    var frx = fin(vRX[idxF], 1);
    var frz = fin(vRZ[idxF], 0);

    var EXT = 170;   // 地面向道路两侧延伸的距离（m）

    /* 左侧 */
    fillQuad(
      nearX - nrx * nearHalf, nearY, nearZ - nrz * nearHalf,
      farX - frx * farHalf, farY, farZ - frz * farHalf,
      farX - frx * (farHalf + EXT), farY, farZ - frz * (farHalf + EXT),
      nearX - nrx * (nearHalf + EXT), nearY, nearZ - nrz * (nearHalf + EXT),
      pal.groundL[f], false
    );
    /* 右侧 */
    fillQuad(
      nearX + nrx * nearHalf, nearY, nearZ + nrz * nearHalf,
      farX + frx * farHalf, farY, farZ + frz * farHalf,
      farX + frx * (farHalf + EXT), farY, farZ + frz * (farHalf + EXT),
      nearX + nrx * (nearHalf + EXT), nearY, nearZ + nrz * (nearHalf + EXT),
      pal.groundR[f], false
    );
  }

  function drawGround(track, count, camSeg, dirSign, nSeg) {
    if (!(count > 0)) return;
    var stride = qual.gstride | 0;
    if (!(stride >= 1)) stride = 2;

    var vi;
    for (vi = nSeg - 1; vi >= stride; vi -= stride) {
      drawGroundGroup(track, count, camSeg, dirSign, vi - stride + 1, vi);
    }
    /* 覆盖相机脚下 / 屏幕底部：允许负的视索引（由近平面裁剪处理） */
    drawGroundGroup(track, count, camSeg, dirSign, -2, stride - 1);
  }

  function prepareView(track) {
    var segments = track.segments;
    var count = segments.length;
    ST.segCount = count;

    var camSeg = segIndexAt(track, camTrackS);
    ST.camSeg = camSeg;

    var seg0 = segments[camSeg] || segments[0];
    if (seg0) {
      var dot = Math.sin(cam.eyaw) * fin(seg0.dirX, 0) + Math.cos(cam.eyaw) * fin(seg0.dirZ, 1);
      if (Math.abs(dot) > 0.28) ST.dirSign = dot >= 0 ? 1 : -1;
    }

    var length = fin(track.length, 0);
    var avgLen = length > 0 ? length / count : 3;
    if (!(avgLen > 0.4)) avgLen = 3;
    var n = Math.ceil(drawDist / avgLen) + 2;
    if (n > count) n = count;
    if (n > MAX_SEGMENTS) n = MAX_SEGMENTS;
    if (!(n >= 1)) n = 1;
    ST.nSeg = n;

    var zi = wrapIndex(camSeg + ST.dirSign * 6, count);
    var zseg = segments[zi];
    ST.zoneNear = (zseg && typeof zseg.zone === 'string' && ZONE_DEFS[zseg.zone]) ? zseg.zone : 'festival';
  }

  function drawWorld(frame, track, cars, player, t, dt) {
    var segments = track.segments;
    var count = segments.length;
    if (!(count > 0)) return;

    var camSeg = ST.camSeg;
    var dirSign = ST.dirSign;
    var nSeg = ST.nSeg;
    if (!(nSeg > 0)) return;

    var shoulderDist = drawDist * qual.shoulder;
    var laneDist = drawDist * qual.lane;
    var railDist = drawDist * qual.rail;

    var gates = getGates(track);
    var startRel = relViewIndex(gates.startSeg, camSeg, dirSign, count);
    var cpRels = ST.cpRels;
    cpRels.length = 0;
    for (var gi = 0; gi < gates.cps.length; gi++) {
      cpRels.push(relViewIndex(gates.cps[gi].seg, camSeg, dirSign, count));
    }

    var vd = getVertexData(track);
    var vRX = vd.rx;
    var vRZ = vd.rz;
    var vHW = vd.hw;

    var vi, idx, seg;
    for (vi = nSeg - 1; vi >= 0; vi--) {
      idx = wrapIndex(camSeg + dirSign * vi, count);
      seg = segments[idx];
      if (!seg) continue;

      /* 顶点 k = segments[k] 起点。本段在观察方向上的近 / 远横截面索引 */
      var idxN, idxF;
      if (dirSign > 0) {
        idxN = idx;
        idxF = (idx + 1 >= count) ? 0 : idx + 1;
      } else {
        idxN = (idx + 1 >= count) ? 0 : idx + 1;
        idxF = idx;
      }
      var segN = segments[idxN];
      var segF = segments[idxF];
      if (!segN || !segF) continue;

      var nsx = fin(segN.x, 0);
      var nsy = fin(segN.y, 0);
      var nsz = fin(segN.z, 0);
      var fsx = fin(segF.x, nsx);
      var fsy = fin(segF.y, nsy);
      var fsz = fin(segF.z, nsz);

      projectScalar((nsx + fsx) * 0.5, (nsy + fsy) * 0.5, (nsz + fsz) * 0.5);
      if (!P.ok) continue;
      var depth = P.d;
      if (depth > drawDist) continue;

      var zone = (typeof seg.zone === 'string' && ZONE_DEFS[seg.zone]) ? seg.zone : 'festival';
      var pal = palCache[zone] || palCache.festival;
      if (!pal) continue;
      var f = fogStepOf(depth);

      var nrx = fin(vRX[idxN], 1);
      var nrz = fin(vRZ[idxN], 0);
      var nhw = fin(vHW[idxN], 7);
      var frx = fin(vRX[idxF], 1);
      var frz = fin(vRZ[idxF], 0);
      var fhw = fin(vHW[idxF], 7);

      /* --- 路肩色带 --- */
      if (depth < shoulderDist) {
        var shW = 2.1;
        fillQuad(
          nsx - nrx * nhw, nsy, nsz - nrz * nhw,
          fsx - frx * fhw, fsy, fsz - frz * fhw,
          fsx - frx * (fhw + shW), fsy, fsz - frz * (fhw + shW),
          nsx - nrx * (nhw + shW), nsy, nsz - nrz * (nhw + shW),
          pal.shoulder[f], true
        );
        fillQuad(
          nsx + nrx * nhw, nsy, nsz + nrz * nhw,
          fsx + frx * fhw, fsy, fsz + frz * fhw,
          fsx + frx * (fhw + shW), fsy, fsz + frz * (fhw + shW),
          nsx + nrx * (nhw + shW), nsy, nsz + nrz * (nhw + shW),
          pal.shoulder[f], true
        );
      }

      /* --- 路面 --- */
      var roadCol = (idx & 1) ? pal.roadAlt[f] : pal.road[f];
      fillQuad(
        nsx - nrx * nhw, nsy, nsz - nrz * nhw,
        nsx + nrx * nhw, nsy, nsz + nrz * nhw,
        fsx + frx * fhw, fsy, fsz + frz * fhw,
        fsx - frx * fhw, fsy, fsz - frz * fhw,
        roadCol, depth < 170
      );

      /* --- 车道线（近处才画） --- */
      if (depth < laneDist) {
        var lw = 0.16;
        if ((idx & 3) < 2) {
          fillQuad(
            nsx - nrx * lw, nsy + 0.02, nsz - nrz * lw,
            nsx + nrx * lw, nsy + 0.02, nsz + nrz * lw,
            fsx + frx * lw, fsy + 0.02, fsz + frz * lw,
            fsx - frx * lw, fsy + 0.02, fsz - frz * lw,
            pal.lane[f], false
          );
        }
        var ne = nhw - 0.55;
        var fe = fhw - 0.55;
        var ew = 0.15;
        if (ne > 1 && fe > 1) {
          fillQuad(
            nsx - nrx * (ne + ew), nsy + 0.02, nsz - nrz * (ne + ew),
            nsx - nrx * (ne - ew), nsy + 0.02, nsz - nrz * (ne - ew),
            fsx - frx * (fe - ew), fsy + 0.02, fsz - frz * (fe - ew),
            fsx - frx * (fe + ew), fsy + 0.02, fsz - frz * (fe + ew),
            pal.edge[f], false
          );
          fillQuad(
            nsx + nrx * (ne - ew), nsy + 0.02, nsz + nrz * (ne - ew),
            nsx + nrx * (ne + ew), nsy + 0.02, nsz + nrz * (ne + ew),
            fsx + frx * (fe + ew), fsy + 0.02, fsz + frz * (fe + ew),
            fsx + frx * (fe - ew), fsy + 0.02, fsz + frz * (fe - ew),
            pal.edge[f], false
          );
        }
      }

      /* --- 护栏（近处） --- */
      if (depth < railDist) {
        var nRail = nhw + 2.7;
        var fRail = fhw + 2.7;
        var railH = 0.95;
        var railCol = (idx & 1) ? pal.railA[f] : pal.railB[f];
        fillQuad(
          nsx - nrx * nRail, nsy + 0.02, nsz - nrz * nRail,
          fsx - frx * fRail, fsy + 0.02, fsz - frz * fRail,
          fsx - frx * fRail, fsy + railH, fsz - frz * fRail,
          nsx - nrx * nRail, nsy + railH, nsz - nrz * nRail,
          railCol, false
        );
        fillQuad(
          nsx + nrx * nRail, nsy + 0.02, nsz + nrz * nRail,
          fsx + frx * fRail, fsy + 0.02, fsz + frz * fRail,
          fsx + frx * fRail, fsy + railH, fsz + frz * fRail,
          nsx + nrx * nRail, nsy + railH, nsz + nrz * nRail,
          railCol, false
        );
      }

      /* --- 起跑线 / 检查点门架 --- */
      if (vi === startRel) {
        drawGate(segments, vRX, vRZ, vHW, idx, 'start', depth);
        if (depth < 165) {
          drawStartLine(segments, vRX, vRZ, vHW, idx, (idx + 1 >= count) ? 0 : idx + 1);
        }
      }
      for (var ci = 0; ci < cpRels.length; ci++) {
        if (vi === cpRels[ci]) drawGate(segments, vRX, vRZ, vHW, idx, 'checkpoint', depth);
      }
    }

    /* --- 精灵：场景 + 车辆（按深度排序） --- */
    collectScenery(track, count);
    collectCars(track, cars, player, dt);
    drawRecords();
  }

  function drawGate(segments, vRX, vRZ, vHW, idx, kind, depth) {
    var seg = segments[idx];
    if (!seg) return;
    var sxp = fin(seg.x, 0);
    var syp = fin(seg.y, 0);
    var szp = fin(seg.z, 0);
    var rxs = fin(vRX[idx], 1);
    var rzs = fin(vRZ[idx], 0);
    var half = fin(vHW[idx], 7);

    var postLat = half + 2.2;
    var postHalf = 0.4;
    var h = kind === 'start' ? 6.6 : 5.9;
    var alpha = U.clamp(1.25 - depth / drawDist, 0, 1);
    if (!(alpha > 0.03)) return;

    var colPost = '#e9eef8';
    var colBeam = kind === 'start' ? '#ff5a1f' : '#39e6ff';
    var colBeam2 = kind === 'start' ? '#ffd166' : '#7b5cff';

    ctx.globalAlpha = alpha;

    for (var sgn = -1; sgn <= 1; sgn += 2) {
      var lx = sgn * postLat;
      fillQuad(
        sxp + rxs * (lx - postHalf), syp, szp + rzs * (lx - postHalf),
        sxp + rxs * (lx + postHalf), syp, szp + rzs * (lx + postHalf),
        sxp + rxs * (lx + postHalf), syp + h, szp + rzs * (lx + postHalf),
        sxp + rxs * (lx - postHalf), syp + h, szp + rzs * (lx - postHalf),
        colPost, false
      );
    }

    /* 横幅上沿 */
    fillQuad(
      sxp - rxs * postLat, syp + h - 1.3, szp - rzs * postLat,
      sxp + rxs * postLat, syp + h - 1.3, szp + rzs * postLat,
      sxp + rxs * postLat, syp + h, szp + rzs * postLat,
      sxp - rxs * postLat, syp + h, szp - rzs * postLat,
      colBeam, false
    );
    /* 横幅彩色下沿 */
    fillQuad(
      sxp - rxs * postLat, syp + h - 2.1, szp - rzs * postLat,
      sxp + rxs * postLat, syp + h - 2.1, szp + rzs * postLat,
      sxp + rxs * postLat, syp + h - 1.3, szp + rzs * postLat,
      sxp - rxs * postLat, syp + h - 1.3, szp - rzs * postLat,
      colBeam2, false
    );
    /* 检查点：横幅中央色块 */
    if (kind === 'checkpoint') {
      var cw = postLat * 0.34;
      fillQuad(
        sxp + rxs * (-cw), syp + h - 2.6, szp + rzs * (-cw),
        sxp + rxs * (cw), syp + h - 2.6, szp + rzs * (cw),
        sxp + rxs * (cw), syp + h - 2.1, szp + rzs * (cw),
        sxp + rxs * (-cw), syp + h - 2.1, szp + rzs * (-cw),
        '#f4f6ff', false
      );
    }

    ctx.globalAlpha = 1;
  }

  function drawStartLine(segments, vRX, vRZ, vHW, idxA, idxB) {
    var segA = segments[idxA];
    var segB = segments[idxB];
    if (!segA || !segB) return;

    var ax0 = fin(segA.x, 0);
    var ay0 = fin(segA.y, 0);
    var az0 = fin(segA.z, 0);
    var bx0 = fin(segB.x, ax0);
    var by0 = fin(segB.y, ay0);
    var bz0 = fin(segB.z, az0);
    var arx = fin(vRX[idxA], 1);
    var arz = fin(vRZ[idxA], 0);
    var brx = fin(vRX[idxB], 1);
    var brz = fin(vRZ[idxB], 0);
    var ah = fin(vHW[idxA], 7);
    var bh = fin(vHW[idxB], 7);

    var cols = 10;
    var rows = 2;
    for (var c = 0; c < cols; c++) {
      var u0 = -1 + (2 * c) / cols;
      var u1 = -1 + (2 * (c + 1)) / cols;
      for (var r = 0; r < rows; r++) {
        var f0 = 0.18 + r * 0.32;
        var f1 = f0 + 0.30;

        var cax = ax0 + (bx0 - ax0) * f0;
        var cay = ay0 + (by0 - ay0) * f0;
        var caz = az0 + (bz0 - az0) * f0;
        var cbx = ax0 + (bx0 - ax0) * f1;
        var cby = ay0 + (by0 - ay0) * f1;
        var cbz = az0 + (bz0 - az0) * f1;

        var raX = arx + (brx - arx) * f0;
        var raZ = arz + (brz - arz) * f0;
        var ral = Math.sqrt(raX * raX + raZ * raZ);
        if (!(ral > 1e-6)) { raX = 1; raZ = 0; ral = 1; }
        raX /= ral; raZ /= ral;

        var rbX = arx + (brx - arx) * f1;
        var rbZ = arz + (brz - arz) * f1;
        var rbl = Math.sqrt(rbX * rbX + rbZ * rbZ);
        if (!(rbl > 1e-6)) { rbX = 1; rbZ = 0; rbl = 1; }
        rbX /= rbl; rbZ /= rbl;

        var hA = ah + (bh - ah) * f0;
        var hB = ah + (bh - ah) * f1;
        var la0 = u0 * hA;
        var la1 = u1 * hA;
        var lb0 = u0 * hB;
        var lb1 = u1 * hB;
        var col = ((c + r) & 1) ? '#f4f6ff' : '#1a1c26';

        fillQuad(
          cax + raX * la0, cay + 0.03, caz + raZ * la0,
          cax + raX * la1, cay + 0.03, caz + raZ * la1,
          cbx + rbX * lb1, cby + 0.03, cbz + rbZ * lb1,
          cbx + rbX * lb0, cby + 0.03, cbz + rbZ * lb0,
          col, false
        );
      }
    }
  }

  /* ============================================================
   * 9. 精灵收集 / 绘制
   * ============================================================ */

  var sortArr = [];
  var recPool = [];
  var recCount = 0;

  function getRec() {
    var r = recPool[recCount];
    if (!r) {
      r = {
        type: 0, depth: 0, sx: 0, sy: 0, k: 1, fog: 0,
        obj: null, spec: null, kind: '', variant: 0, scale: 1,
        rot: 0, sxScale: 1, player: false, place: 0, name: '',
        brake: false, boost: false, drift: false, offroad: false, state: null,
        wx: 0, wy: 0, wz: 0, fdx: 0, fdz: 0, rtx: 0, rtz: 0
      };
      recPool.push(r);
    }
    recCount++;
    return r;
  }

  function byDepth(a, b) {
    return b.depth - a.depth;
  }

  function collectScenery(track, count) {
    var list = track.scenery;
    if (!Array.isArray(list) || !list.length) return;
    var segments = track.segments;
    var stride = qual.stride || 1;

    for (var i = 0; i < list.length; i += stride) {
      var it = list[i];
      if (!it || typeof it !== 'object') continue;
      var segI = it.seg | 0;
      if (!(segI >= 0 && segI < count)) continue;
      var seg = segments[segI];
      if (!seg) continue;

      var kind = (typeof it.kind === 'string' && KINDS[it.kind]) ? it.kind : 'bush';
      var meta = KINDS[kind];
      /* track.js 约定：off 是带符号横向坐标（+右侧，m），不要再乘 side */
      var lat = fin(it.off, 12);
      if (Math.abs(lat) < 6) {
        var sideSign = (typeof it.side === 'number' && isFinite(it.side) && it.side < 0) ? -1 : 1;
        lat = 12 * sideSign;
      }
      var scale = fin(it.scale, 1);
      if (!(scale > 0.1)) scale = 1;
      if (scale > 4) scale = 4;

      var wx = fin(seg.x, 0) + fin(seg.rightX, 1) * lat;
      var wz = fin(seg.z, 0) + fin(seg.rightZ, 0) * lat;
      var wy = fin(seg.y, 0) + meta.offY * scale;

      projectScalar(wx, wy, wz);
      if (!P.ok || P.d > drawDist || P.d < 1.5) continue;

      var rec = getRec();
      rec.type = 0;
      rec.depth = P.d;
      rec.sx = P.sx;
      rec.sy = P.sy;
      rec.k = focal / P.d;
      rec.fog = U.clamp((P.d - drawDist * 0.32) / (drawDist * 0.68), 0, 1);
      rec.kind = kind;
      rec.variant = fin(it.variant, 0) | 0;
      rec.scale = scale;
      rec.obj = null;
      rec.spec = null;
      rec.player = false;
      sortArr.push(rec);
    }
  }

  var carStateMap = new Map();

  function getCarState(car) {
    var st = carStateMap.get(car);
    if (!st) {
      st = { smoke: 0, dust: 0, lastBump: 0 };
      carStateMap.set(car, st);
    }
    return st;
  }

  function collectCars(track, cars, player, dt) {
    if (!cars || !cars.length) return;
    if (carStateMap.size > 48) carStateMap.clear();

    for (var i = 0; i < cars.length; i++) {
      var car = cars[i];
      if (!car || typeof car !== 'object') continue;
      var s = fin(car.s, NaN);
      if (!isFinite(s)) continue;
      var lat = fin(car.x, 0);

      var smp = safeSample(track, s, lat, SMP_B);
      projectScalar(smp.x, smp.y + 0.1, smp.z);
      if (!P.ok || P.d > drawDist || P.d < 0.85) continue;
      var depth = P.d;

      var spec = (car.spec && typeof car.spec === 'object')
        ? car.spec
        : ((HR.CARS && HR.CARS.length) ? HR.CARS[i % HR.CARS.length] : null);

      var heading = fin(smp.yaw, Math.atan2(fin(smp.dirX, 0), fin(smp.dirZ, 1)));
      var rel = U.wrapAngle(heading + fin(car.driftAngle, 0) - cam.eyaw);

      var rec = getRec();
      rec.type = 1;
      rec.depth = depth;
      rec.sx = P.sx;
      rec.sy = P.sy;
      rec.k = focal / depth;
      rec.fog = U.clamp((depth - drawDist * 0.32) / (drawDist * 0.68), 0, 1);
      rec.obj = car;
      rec.spec = spec;
      rec.rot = U.clamp(Math.sin(rel) * 0.55, -0.55, 0.55);
      rec.sxScale = 0.6 + 0.4 * Math.abs(Math.cos(rel));
      rec.player = (car === player);
      rec.place = fin(car.place, 0);
      rec.name = (typeof car.name === 'string' && car.name) ? car.name
        : ((spec && typeof spec.name === 'string') ? spec.name : '');
      rec.brake = fin(car.brakeInput, 0) > 0.2;
      rec.boost = car.boosting === true;
      rec.drift = car.drifting === true || Math.abs(fin(car.driftAngle, 0)) > 0.2;
      rec.offroad = car.offroad === true;
      rec.state = getCarState(car);

      var fdx = fin(smp.dirX, 0);
      var fdz = fin(smp.dirZ, 1);
      var fl = Math.sqrt(fdx * fdx + fdz * fdz);
      if (fl > 1e-6) { fdx /= fl; fdz /= fl; } else { fdx = 0; fdz = 1; }
      rec.wx = smp.x;
      rec.wy = smp.y;
      rec.wz = smp.z;
      rec.fdx = fdx;
      rec.fdz = fdz;
      rec.rtx = fin(smp.rightX, 1);
      rec.rtz = fin(smp.rightZ, 0);

      sortArr.push(rec);
      emitCarParticles(rec, dt);
    }
  }

  function emitCarParticles(rec, dt) {
    if (!(dt > 0)) dt = 0.016;
    var car = rec.obj;
    var st = rec.state;
    if (!car || !st) return;
    var speed = Math.max(0, fin(car.v, 0));
    var n = 0;
    var side, px, pz;

    if (rec.drift && speed > 9) {
      st.smoke += dt * (14 + speed * 0.5);
      n = 0;
      while (st.smoke >= 1 && n < 6) {
        st.smoke -= 1;
        n++;
        side = rnd() < 0.5 ? -1 : 1;
        px = rec.wx - rec.fdx * 1.6 + rec.rtx * (side * 0.72);
        pz = rec.wz - rec.fdz * 1.6 + rec.rtz * (side * 0.72);
        emitParticle(0, px, rec.wy + 0.35, pz,
          -rec.fdx * 2.4 + (rnd() - 0.5) * 1.6,
          0.9 + rnd() * 1.1,
          -rec.fdz * 2.4 + (rnd() - 0.5) * 1.6,
          0.55 + rnd() * 0.55, 0.9 + rnd() * 0.7);
      }
    }

    if (rec.offroad && speed > 4) {
      st.dust += dt * (16 + speed * 0.4);
      n = 0;
      while (st.dust >= 1 && n < 6) {
        st.dust -= 1;
        n++;
        side = rnd() < 0.5 ? -1 : 1;
        px = rec.wx - rec.fdx * 1.4 + rec.rtx * (side * 0.8);
        pz = rec.wz - rec.fdz * 1.4 + rec.rtz * (side * 0.8);
        emitParticle(1, px, rec.wy + 0.25, pz,
          -rec.fdx * 1.4 + (rnd() - 0.5) * 2.2,
          1.4 + rnd() * 1.6,
          -rec.fdz * 1.4 + (rnd() - 0.5) * 2.2,
          0.55 + rnd() * 0.6, 0.8 + rnd() * 0.8);
      }
    }

    var bump = fin(car.bump, 0);
    if (bump > 0.42 && st.lastBump <= 0.42 && speed > 2) {
      for (var i = 0; i < 7; i++) {
        emitParticle(2,
          rec.wx + (rnd() - 0.5) * 0.6,
          rec.wy + 0.5 + rnd() * 0.4,
          rec.wz + (rnd() - 0.5) * 0.6,
          (rnd() - 0.5) * 6,
          2 + rnd() * 3,
          (rnd() - 0.5) * 6,
          0.10 + rnd() * 0.08,
          0.35 + rnd() * 0.35);
      }
    }
    st.lastBump = bump;
  }

  function drawRecords() {
    if (!sortArr.length) return;
    sortArr.sort(byDepth);
    for (var i = 0; i < sortArr.length; i++) {
      var rec = sortArr[i];
      if (!rec) continue;
      if (rec.type === 1) drawCarRec(rec);
      else drawSceneryRec(rec);
    }
  }

  function drawSceneryRec(rec) {
    var meta = KINDS[rec.kind];
    if (!meta) return;
    var spr = getScenerySprite(rec.kind, rec.variant);
    if (!spr) return;
    var drawH = meta.worldH * rec.scale * rec.k;
    if (!(drawH > 1.4)) return;
    if (drawH > H * 8) drawH = H * 8;
    var drawW = drawH * (meta.w / meta.h);
    if (!(drawW > 1)) return;
    var alpha = 1 - 0.55 * rec.fog;
    if (!(alpha > 0.02)) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(spr, rec.sx - drawW * 0.5, rec.sy - drawH, drawW, drawH);
    ctx.globalAlpha = 1;
  }

  function playerAccent(rec) {
    var spec = rec.spec;
    if (spec && typeof spec.accent === 'string' && spec.accent) return spec.accent;
    if (spec && typeof spec.color === 'string' && spec.color) return spec.color;
    return '#ffd166';
  }

  function drawCarRec(rec) {
    var spec = rec.spec;
    var spr = getCarSprite(spec);
    var carW = spec ? fin(spec.width, 2.0) : 2.0;
    if (!(carW > 0.5)) carW = 2.0;

    var drawW = carW * 1.28 * rec.k;
    if (!(drawW > 2)) return;
    if (drawW > W * 3.5) drawW = W * 3.5;
    var drawH = drawW * CAR_SPR_ASPECT;

    var groundY = rec.sy;

    /* 玩家：地面高亮环 */
    if (rec.player) {
      ctx.strokeStyle = playerAccent(rec);
      ctx.lineWidth = Math.max(1.5, drawW * 0.02);
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.ellipse(rec.sx, groundY, drawW * 0.52, drawW * 0.13, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (!spr) {
      /* 兜底：纯色块 */
      ctx.fillStyle = (spec && typeof spec.color === 'string') ? spec.color : '#cc3344';
      ctx.fillRect(rec.sx - drawW * 0.4, groundY - drawH * 0.6, drawW * 0.8, drawH * 0.55);
    } else {
      ctx.save();
      ctx.translate(rec.sx, groundY);
      if (rec.rot) ctx.rotate(rec.rot);
      if (rec.sxScale !== 1) ctx.scale(rec.sxScale, 1);
      /* 玩家车：用 shadowBlur 沿精灵 alpha 轮廓描出一圈 accent 高亮 */
      if (rec.player) {
        ctx.shadowColor = playerAccent(rec);
        ctx.shadowBlur = Math.max(6, drawW * 0.06);
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }
      ctx.drawImage(spr, -drawW * 0.5, -drawH * CAR_GROUND_FRAC, drawW, drawH);
      if (rec.player) {
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'rgba(0,0,0,0)';
      }

      /* 刹车灯辉光 */
      if (rec.brake && assets.brakeGlow && drawW > 8) {
        var gs = drawW * 0.30;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.85;
        ctx.drawImage(assets.brakeGlow, -0.26 * drawW - gs * 0.5, -0.28 * drawH - gs * 0.5, gs, gs);
        ctx.drawImage(assets.brakeGlow, 0.26 * drawW - gs * 0.5, -0.28 * drawH - gs * 0.5, gs, gs);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      /* 氮气火焰 */
      if (rec.boost && assets.flame && drawW > 10) {
        var fw = drawW * 0.46;
        var fh = drawH * 0.30;
        var pulse = 0.8 + 0.35 * Math.sin(timeSec * 42 + rec.depth);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.85;
        ctx.drawImage(assets.flame, -fw * 0.5, -fh * 0.5 - 0.02 * drawH, fw, Math.max(1, fh * pulse));
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
    }

    /* 车顶名次/名字标签 */
    if (drawW > 16 && rec.name) {
      var labelSize = U.clamp(drawW * 0.15, 9, 17);
      var plac = rec.place;
      var label = '';
      if (plac > 0 && plac < 100) label = 'P' + Math.round(plac) + ' ' + rec.name;
      else label = rec.name;
      if (label) {
        ctx.font = '700 ' + labelSize.toFixed(0) + 'px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        var ly = groundY - drawH * CAR_GROUND_FRAC - labelSize * 0.55;
        if (ly > -40 && ly < H + 40) {
          var tw = ctx.measureText(label).width;
          if (isFinite(tw) && tw > 0) {
            var pad = labelSize * 0.35;
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = 'rgb(8,10,20)';
            roundRect(ctx, rec.sx - tw * 0.5 - pad, ly - labelSize * 0.95, tw + pad * 2, labelSize * 1.35, labelSize * 0.3);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = rec.player ? playerAccent(rec) : 'rgba(240,244,255,0.92)';
            ctx.fillText(label, rec.sx, ly);
          }
        }
      }
    }
  }

  /* ============================================================
   * 10. 粒子
   * ============================================================ */

  var particles = [];
  var pCursor = 0;

  function buildParticlePool() {
    particles.length = 0;
    for (var i = 0; i < 230; i++) {
      particles.push({
        active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, max: 1, size: 1, type: 0
      });
    }
    pCursor = 0;
  }

  function particleLimit() {
    var n = qual.particles | 0;
    if (n > particles.length) n = particles.length;
    if (!(n > 0)) n = 1;
    return n;
  }

  function emitParticle(type, x, y, z, vx, vy, vz, size, life) {
    var n = particleLimit();
    if (pCursor >= n) pCursor = 0;
    var p = particles[pCursor];
    if (!p) return;
    pCursor++;
    p.active = true;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = life;
    p.max = (life > 0.001) ? life : 0.001;
    p.size = size;
    p.type = type;
  }

  function updateParticles(dt) {
    if (!(dt > 0)) return;
    /* 遍历整个池（不只是当前画质上限），避免降档后残留粒子永不失效 */
    var n = particles.length;
    for (var i = 0; i < n; i++) {
      var p = particles[i];
      if (!p || !p.active) continue;
      p.life -= dt;
      if (!(p.life > 0)) { p.active = false; continue; }
      if (p.type === 2) {
        p.vy -= 12 * dt;
        p.vx *= Math.exp(-0.5 * dt);
        p.vz *= Math.exp(-0.5 * dt);
      } else {
        p.vy += (p.type === 0 ? 0.9 : 0.35) * dt;
        var k = Math.exp(-1.8 * dt);
        p.vx *= k;
        p.vz *= k;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0) p.y = 0;
    }
  }

  function drawParticles() {
    var n = particleLimit();
    for (var i = 0; i < n; i++) {
      var p = particles[i];
      if (!p || !p.active) continue;
      projectScalar(p.x, p.y, p.z);
      if (!P.ok || P.d > drawDist) continue;
      var lifeT = p.life / p.max;
      if (lifeT < 0) lifeT = 0;
      if (lifeT > 1) lifeT = 1;
      var size = p.size * (0.7 + (1 - lifeT) * 0.9) * focal / P.d;
      if (!(size > 0.8) || size > 3000) continue;
      var spr = (p.type === 0) ? assets.particleSmoke
        : (p.type === 1 ? assets.particleDust : assets.particleSpark);
      if (!spr) continue;
      var a = U.clamp(lifeT * (p.type === 2 ? 1.0 : 0.55), 0, 1);
      ctx.globalAlpha = a;
      ctx.drawImage(spr, P.sx - size * 0.5, P.sy - size * 0.5, size, size);
      ctx.globalAlpha = 1;
    }
  }

  /* ============================================================
   * 11. 天气 / 特效 / 后处理
   * ============================================================ */

  function drawRain(t) {
    var n = qual.rain | 0;
    if (!(n > 0)) return;
    ctx.strokeStyle = 'rgba(180,205,235,0.30)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var x = (i * 97.13 + t * 240) % (W + 120) - 60;
      var y = (i * 173.71 + t * 980) % (H + 80) - 40;
      ctx.moveTo(x, y);
      ctx.lineTo(x - 10, y + 34);
    }
    ctx.stroke();
  }

  function drawSpeedLines(player, t) {
    var v = player ? fin(player.v, 0) : 0;
    var sp = U.clamp((v - 44) / 50, 0, 1);
    if (!(sp > 0.02)) return;
    var n = qual.speedLines | 0;
    if (!(n > 0)) return;
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.05 + 0.20 * sp).toFixed(2) + ')';
    ctx.lineWidth = 1 + sp;
    ctx.beginPath();
    var cy = H * 0.55;
    for (var i = 0; i < n; i++) {
      var side = (i & 1) ? 1 : -1;
      var yy = (i * 137.53 + t * 220 * (1 + sp)) % H;
      var len = (80 + 220 * sp) * (0.5 + ((i * 37) % 100) / 100);
      var x1 = side < 0 ? 0 : W;
      var x2 = side < 0 ? len : W - len;
      ctx.moveTo(x1, yy);
      ctx.lineTo(x2, yy + (yy - cy) * 0.04);
    }
    ctx.stroke();
  }

  function drawNightOverlay() {
    if (!(ENV.night > 0.03) || !ENV.nightFill) return;
    var hy = U.clamp(horizonY(), 0, H);
    ctx.fillStyle = ENV.nightFill;
    ctx.fillRect(0, hy, W, H - hy);
  }

  function drawAtmosphere(weather) {
    var hy = U.clamp(horizonY(), 0, H);
    if (ENV.warm > 0.15 && ENV.warmFill) {
      ctx.fillStyle = ENV.warmFill;
      ctx.fillRect(0, hy, W, H - hy);
    }
    if (weather === 'rain') {
      ctx.fillStyle = 'rgba(120,142,172,0.10)';
      ctx.fillRect(0, 0, W, H);
    }
  }

  function buildScreenGradients() {
    if (!ctx) return;
    ST.vignette = null;
    ST.topGrad = null;
    try {
      var vg = ctx.createRadialGradient(
        W * 0.5, H * 0.52, Math.min(W, H) * 0.26,
        W * 0.5, H * 0.52, Math.max(W, H) * 0.80
      );
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(0.62, 'rgba(0,0,0,0.10)');
      vg.addColorStop(1, 'rgba(2,3,8,0.55)');
      ST.vignette = vg;

      var tg = ctx.createLinearGradient(0, 0, 0, H * 0.24);
      tg.addColorStop(0, 'rgba(2,3,8,0.45)');
      tg.addColorStop(1, 'rgba(2,3,8,0)');
      ST.topGrad = tg;
    } catch (e) {
      ST.vignette = null;
      ST.topGrad = null;
    }
  }

  function drawVignette() {
    if (!ST.vignette) return;
    ctx.fillStyle = ST.vignette;
    ctx.fillRect(0, 0, W, H);
  }

  function drawTopBar() {
    if (!ST.topGrad) return;
    ctx.fillStyle = ST.topGrad;
    ctx.fillRect(0, 0, W, H * 0.24);
  }

  /* ============================================================
   * 12. 离屏精灵生成
   * ============================================================ */

  function makeCanvas(w, h) {
    var cv = document.createElement('canvas');
    cv.width = Math.max(2, Math.round(w));
    cv.height = Math.max(2, Math.round(h));
    return cv;
  }

  function makeSunSprite(size) {
    var cv = makeCanvas(size, size);
    var c = cv.getContext('2d');
    if (!c) return cv;
    var g = c.createRadialGradient(size * 0.5, size * 0.5, size * 0.03, size * 0.5, size * 0.5, size * 0.5);
    g.addColorStop(0, 'rgba(255,252,232,1)');
    g.addColorStop(0.22, 'rgba(255,238,176,0.96)');
    g.addColorStop(0.48, 'rgba(255,172,92,0.42)');
    g.addColorStop(1, 'rgba(255,120,60,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    return cv;
  }

  function makeMoonSprite(size) {
    var cv = makeCanvas(size, size);
    var c = cv.getContext('2d');
    if (!c) return cv;
    var half = size * 0.5;
    var r = size * 0.30;
    var glow = c.createRadialGradient(half, half, r * 0.8, half, half, size * 0.5);
    glow.addColorStop(0, 'rgba(200,220,255,0.28)');
    glow.addColorStop(1, 'rgba(200,220,255,0)');
    c.fillStyle = glow;
    c.fillRect(0, 0, size, size);

    c.fillStyle = 'rgba(226,235,255,0.96)';
    c.beginPath();
    c.arc(half, half, r, 0, Math.PI * 2);
    c.fill();

    c.fillStyle = 'rgba(188,202,232,0.55)';
    c.beginPath(); c.arc(half - r * 0.32, half - r * 0.22, r * 0.22, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(half + r * 0.26, half + r * 0.10, r * 0.16, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(half - r * 0.05, half + r * 0.34, r * 0.12, 0, Math.PI * 2); c.fill();
    return cv;
  }

  function makeCloudSprite(idx) {
    var w = 200, h = 90;
    var cv = makeCanvas(w, h);
    var c = cv.getContext('2d');
    if (!c) return cv;
    var rnd2 = U.rng(U.hashSeed('cloud' + idx));
    for (var i = 0; i < 7; i++) {
      var cx = 30 + rnd2() * 140;
      var cy = 40 + rnd2() * 18;
      var r = 16 + rnd2() * 16;
      var g = c.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
      g.addColorStop(0, 'rgba(255,255,255,0.72)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
    }
    return cv;
  }

  function makeGlowSprite(size, col) {
    var cv = makeCanvas(size, size);
    var c = cv.getContext('2d');
    if (!c) return cv;
    var g = c.createRadialGradient(size * 0.5, size * 0.5, 0, size * 0.5, size * 0.5, size * 0.5);
    g.addColorStop(0, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',1)');
    g.addColorStop(0.35, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0.55)');
    g.addColorStop(1, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0)');
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    return cv;
  }

  function makeFlameSprite(size) {
    var cv = makeCanvas(size, size);
    var c = cv.getContext('2d');
    if (!c) return cv;
    var g = c.createRadialGradient(size * 0.5, size * 0.42, size * 0.04, size * 0.5, size * 0.55, size * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.28, 'rgba(130,220,255,0.85)');
    g.addColorStop(0.58, 'rgba(72,132,255,0.42)');
    g.addColorStop(1, 'rgba(40,60,255,0)');
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(size * 0.5, size * 0.5, size * 0.34, size * 0.46, 0, 0, Math.PI * 2);
    c.fill();
    return cv;
  }

  function makeSoftDot(size, col, hard) {
    var cv = makeCanvas(size, size);
    var c = cv.getContext('2d');
    if (!c) return cv;
    var g = c.createRadialGradient(size * 0.5, size * 0.5, 0, size * 0.5, size * 0.5, size * 0.5);
    g.addColorStop(0, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',1)');
    g.addColorStop(U.clamp(hard * 0.5, 0.05, 0.9), 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0.55)');
    g.addColorStop(1, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0)');
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    return cv;
  }

  /* ---------- 车辆后视图精灵 ---------- */

  function makeCarSprite(spec, body, colorCss, accentCss) {
    var color = hexToRgb(colorCss);
    var accent = hexToRgb(accentCss);
    var st = BODY_STYLE[body] || BODY_STYLE.gt;

    var cv = makeCanvas(CAR_SPR_W * SPR_RES, CAR_SPR_H * SPR_RES);
    var c = cv.getContext('2d');
    if (!c) return cv;
    c.scale(SPR_RES, SPR_RES);

    var cx = CAR_SPR_W * 0.5;
    var gy = st.ground;
    var halfB = st.halfB;
    var topY = st.bodyTop;
    var botY = st.bodyBottom;
    var roofHalf = st.roofHalf;
    var roofTop = st.roofTop;
    var wheelW = st.tireW;
    var wheelH = 34 * st.tire;
    var wheelY = gy - wheelH;

    /* 底光（street） */
    if (st.underglow) {
      var ug = c.createRadialGradient(cx, gy, 4, cx, gy, halfB * 1.35);
      ug.addColorStop(0, 'rgba(' + accent[0] + ',' + accent[1] + ',' + accent[2] + ',0.55)');
      ug.addColorStop(1, 'rgba(' + accent[0] + ',' + accent[1] + ',' + accent[2] + ',0)');
      c.fillStyle = ug;
      c.beginPath();
      c.ellipse(cx, gy + 2, halfB * 1.35, 13, 0, 0, Math.PI * 2);
      c.fill();
    }

    /* 地面阴影 */
    c.fillStyle = 'rgba(0,0,0,0.34)';
    c.beginPath();
    c.ellipse(cx, gy + 3, halfB * 1.02, 10, 0, 0, Math.PI * 2);
    c.fill();

    /* 轮胎 */
    for (var tI = 0; tI < 2; tI++) {
      var tx = (tI === 0) ? (cx - halfB * 0.82 - wheelW * 0.5) : (cx + halfB * 0.82 - wheelW * 0.5);
      c.fillStyle = '#15161c';
      roundRect(c, tx, wheelY, wheelW, wheelH, 5);
      c.fill();
      c.fillStyle = 'rgba(150,155,170,0.50)';
      c.beginPath();
      c.ellipse(tx + wheelW * 0.5, wheelY + wheelH * 0.58, wheelW * 0.28, wheelH * 0.22, 0, 0, Math.PI * 2);
      c.fill();
    }

    /* 车身 */
    var grad = c.createLinearGradient(0, topY, 0, botY + 8);
    grad.addColorStop(0, shadeCss(color, 1.22));
    grad.addColorStop(0.5, shadeCss(color, 0.95));
    grad.addColorStop(1, shadeCss(color, 0.55));
    c.fillStyle = grad;
    c.beginPath();
    c.moveTo(cx - halfB, botY);
    c.lineTo(cx + halfB, botY);
    c.lineTo(cx + halfB * 0.96, topY + 10);
    c.quadraticCurveTo(cx + halfB * 0.99, topY, cx + halfB * 0.84, topY);
    c.lineTo(cx - halfB * 0.84, topY);
    c.quadraticCurveTo(cx - halfB * 0.99, topY, cx - halfB * 0.96, topY + 10);
    c.closePath();
    c.fill();

    /* 下部扩散器 */
    c.fillStyle = shadeCss(accent, 0.72);
    c.beginPath();
    c.moveTo(cx - halfB * 0.82, botY);
    c.lineTo(cx + halfB * 0.82, botY);
    c.lineTo(cx + halfB * 0.72, botY + 10);
    c.lineTo(cx - halfB * 0.72, botY + 10);
    c.closePath();
    c.fill();

    /* 车顶 / 后窗 */
    c.fillStyle = shadeCss(color, 1.12);
    c.beginPath();
    c.moveTo(cx - roofHalf, topY + 2);
    c.lineTo(cx - roofHalf * 0.94, roofTop + 4);
    c.quadraticCurveTo(cx, roofTop - 2, cx + roofHalf * 0.94, roofTop + 4);
    c.lineTo(cx + roofHalf, topY + 2);
    c.closePath();
    c.fill();

    c.fillStyle = 'rgba(14,17,26,0.94)';
    c.beginPath();
    c.moveTo(cx - roofHalf * 0.82, roofTop + 9);
    c.lineTo(cx + roofHalf * 0.82, roofTop + 9);
    c.lineTo(cx + halfB * 0.74, topY + 1);
    c.lineTo(cx - halfB * 0.74, topY + 1);
    c.closePath();
    c.fill();

    c.fillStyle = 'rgba(150,190,255,0.16)';
    c.beginPath();
    c.moveTo(cx - roofHalf * 0.7, roofTop + 11);
    c.lineTo(cx + roofHalf * 0.4, roofTop + 11);
    c.lineTo(cx + halfB * 0.3, topY - 2);
    c.lineTo(cx - halfB * 0.2, topY - 2);
    c.closePath();
    c.fill();

    c.strokeStyle = shadeCss(accent, 1.0);
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(cx - roofHalf * 0.9, roofTop + 6);
    c.quadraticCurveTo(cx, roofTop, cx + roofHalf * 0.9, roofTop + 6);
    c.stroke();

    /* 涂装条纹 */
    if (st.livery > 0.1) {
      c.globalAlpha = st.livery;
      c.fillStyle = shadeCss(accent, 1.1);
      c.fillRect(cx - 12, topY + 6, 7, botY - topY - 6);
      c.fillRect(cx + 5, topY + 6, 7, botY - topY - 6);
      c.globalAlpha = 1;
    }

    /* 尾翼 */
    if (st.wing > 0.2) {
      var wingY = topY - 20 - st.wing * 8;
      var wingHalf = halfB * (0.86 + st.wing * 0.12);
      var bladeH = 7 + st.wing * 3;
      c.fillStyle = shadeCss(accent, 0.9);
      c.fillRect(cx - wingHalf, wingY, wingHalf * 2, bladeH);
      c.fillStyle = shadeCss(accent, 1.15);
      c.fillRect(cx - wingHalf, wingY - 5, 6, bladeH + 9);
      c.fillRect(cx + wingHalf - 6, wingY - 5, 6, bladeH + 9);
      c.fillStyle = 'rgba(20,22,30,0.85)';
      var supH = Math.max(1, topY - wingY - bladeH);
      c.fillRect(cx - halfB * 0.5, wingY + bladeH, 7, supH);
      c.fillRect(cx + halfB * 0.5 - 7, wingY + bladeH, 7, supH);
    }

    /* 车顶行李箱 / 拉力灯组 */
    if (st.roofBox) {
      c.fillStyle = 'rgba(30,32,40,0.92)';
      roundRect(c, cx - roofHalf * 0.6, roofTop - 7, roofHalf * 1.2, 8, 2);
      c.fill();
    }
    if (st.roofPod) {
      c.fillStyle = 'rgba(20,22,30,0.95)';
      c.fillRect(cx - roofHalf * 0.55, roofTop - 9, roofHalf * 1.1, 8);
      c.fillStyle = '#ffe9a8';
      for (var pI = 0; pI < 4; pI++) {
        c.fillRect(cx - roofHalf * 0.5 + pI * roofHalf * 0.28, roofTop - 7, roofHalf * 0.16, 4);
      }
    }

    /* 尾灯 */
    var lightY = topY + 12;
    if (st.lightBar) {
      c.save();
      c.shadowColor = 'rgba(255,60,52,0.9)';
      c.shadowBlur = 12;
      c.fillStyle = '#ff3b30';
      roundRect(c, cx - halfB * 0.72, lightY, halfB * 1.44, 7, 3);
      c.fill();
      c.restore();
    } else {
      var lw2 = halfB * 0.5;
      c.save();
      c.shadowColor = 'rgba(255,60,52,0.85)';
      c.shadowBlur = 10;
      c.fillStyle = '#ff2b25';
      roundRect(c, cx - halfB * 0.84, lightY, lw2, 8, 3);
      c.fill();
      roundRect(c, cx + halfB * 0.84 - lw2, lightY, lw2, 8, 3);
      c.fill();
      c.restore();
      c.fillStyle = 'rgba(255,170,150,0.75)';
      c.fillRect(cx - halfB * 0.80, lightY + 2, lw2 * 0.55, 3);
      c.fillRect(cx + halfB * 0.84 - lw2 + 4, lightY + 2, lw2 * 0.55, 3);
    }

    /* 中央标牌 */
    c.fillStyle = 'rgba(10,12,18,0.75)';
    roundRect(c, cx - 15, botY - 14, 30, 10, 2);
    c.fill();
    c.fillStyle = shadeCss(accent, 1.2);
    c.fillRect(cx - 8, botY - 11, 16, 3);

    /* 排气 */
    if (!st.lightBar) {
      c.fillStyle = '#0d0e13';
      c.beginPath();
      c.arc(cx - 22, botY + 7, 4.5, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.arc(cx + 22, botY + 7, 4.5, 0, Math.PI * 2);
      c.fill();
    }

    /* 底部阴影线 */
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(cx - halfB * 0.7, botY + 9, halfB * 1.4, 3);

    return cv;
  }

  function getCarSprite(spec) {
    var body = (spec && typeof spec.body === 'string' && BODY_STYLE[spec.body]) ? spec.body : 'gt';
    var colorCss = (spec && typeof spec.color === 'string' && spec.color) ? spec.color : '#c8c8d2';
    var accentCss = (spec && typeof spec.accent === 'string' && spec.accent) ? spec.accent : '#22232c';
    var key = body + '|' + colorCss + '|' + accentCss;
    var spr = carSprites[key];
    if (!spr) {
      if (typeof document === 'undefined') return null;
      try {
        spr = makeCarSprite(spec, body, colorCss, accentCss);
      } catch (e) {
        spr = null;
      }
      if (!spr) return null;
      carSprites[key] = spr;
    }
    return spr;
  }

  /* ---------- 场景装饰精灵 ---------- */

  function makeScenerySprite(kind, variant) {
    var meta = KINDS[kind] || KINDS.bush;
    var rw = meta.w, rh = meta.h;
    var cv = makeCanvas(rw * SCENERY_RES, rh * SCENERY_RES);
    var c = cv.getContext('2d');
    if (!c) return cv;
    c.scale(SCENERY_RES, SCENERY_RES);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    var rnd2 = U.rng(U.hashSeed(kind + '#' + variant));
    var gy = rh - 2;

    switch (kind) {
      case 'palm': drawScPalm(c, rw, rh, gy, rnd2, variant); break;
      case 'cactus': drawScCactus(c, rw, rh, gy, variant); break;
      case 'pine': drawScPine(c, rw, rh, gy, variant); break;
      case 'rock': drawScRock(c, rw, rh, gy, variant); break;
      case 'building': drawScBuilding(c, rw, rh, gy, rnd2, variant); break;
      case 'billboard': drawScBillboard(c, rw, rh, gy, variant); break;
      case 'grandstand': drawScGrandstand(c, rw, rh, gy, rnd2, variant); break;
      case 'tent': drawScTent(c, rw, rh, gy, variant); break;
      case 'flag': drawScFlag(c, rw, rh, gy, variant); break;
      case 'lightpole': drawScLightpole(c, rw, rh, gy); break;
      case 'balloon': drawScBalloon(c, rw, rh, gy, variant); break;
      case 'sign': drawScSign(c, rw, rh, gy, variant); break;
      case 'barrier': drawScBarrier(c, rw, rh, gy); break;
      case 'bush':
      default: drawScBush(c, rw, rh, gy, variant); break;
    }
    return cv;
  }

  function drawScPalm(c, w, h, gy, rnd2, variant) {
    var trunkCol = ['#6d4c33', '#7a563a', '#5d3f2a'][variant % 3];
    var leafCol = ['#2f7a4a', '#358a52', '#256b40'][variant % 3];
    var baseX = w * 0.5;
    var topX = baseX + (rnd2() - 0.5) * w * 0.22;
    var topY = h * 0.30;

    c.strokeStyle = trunkCol;
    c.lineWidth = Math.max(2, w * 0.10);
    c.beginPath();
    c.moveTo(baseX, gy);
    c.quadraticCurveTo(baseX + (topX - baseX) * 0.25, gy - (gy - topY) * 0.55, topX, topY);
    c.stroke();

    c.fillStyle = leafCol;
    for (var i = 0; i < 7; i++) {
      var a = -Math.PI * 0.95 + (i / 6) * Math.PI * 0.9;
      var len = w * (0.38 + rnd2() * 0.22);
      var ex = topX + Math.cos(a) * len;
      var ey = topY + Math.sin(a) * len * 0.55 + len * 0.18;
      c.beginPath();
      c.moveTo(topX, topY);
      c.quadraticCurveTo(
        topX + Math.cos(a) * len * 0.6, topY + Math.sin(a) * len * 0.3 - h * 0.04,
        ex, ey
      );
      c.quadraticCurveTo(
        topX + Math.cos(a) * len * 0.5, topY + Math.sin(a) * len * 0.35 + h * 0.03,
        topX, topY
      );
      c.fill();
    }

    c.fillStyle = '#4a3320';
    c.beginPath();
    c.arc(topX + w * 0.04, topY + h * 0.04, Math.max(1.5, w * 0.035), 0, Math.PI * 2);
    c.fill();
  }

  function drawScCactus(c, w, h, gy, variant) {
    var col = ['#4e7c42', '#5b8a4b', '#3f6b38'][variant % 3];
    c.fillStyle = col;
    roundRect(c, w * 0.42, h * 0.22, w * 0.16, gy - h * 0.22, w * 0.08);
    c.fill();
    roundRect(c, w * 0.18, h * 0.44, w * 0.13, h * 0.26, w * 0.065);
    c.fill();
    roundRect(c, w * 0.68, h * 0.36, w * 0.13, h * 0.30, w * 0.065);
    c.fill();
    c.fillRect(w * 0.30, h * 0.54, w * 0.16, h * 0.06);
    c.fillRect(w * 0.56, h * 0.48, w * 0.14, h * 0.06);

    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.lineWidth = Math.max(1, w * 0.03);
    c.beginPath();
    c.moveTo(w * 0.47, h * 0.27);
    c.lineTo(w * 0.47, gy - h * 0.05);
    c.stroke();
  }

  function drawScPine(c, w, h, gy, variant) {
    var trunk = '#4a3524';
    var leaf = ['#1f4d33', '#25593b', '#1a422c'][variant % 3];
    c.fillStyle = trunk;
    c.fillRect(w * 0.44, h * 0.70, w * 0.12, h * 0.28);
    c.fillStyle = leaf;
    for (var i = 0; i < 3; i++) {
      var topY = h * (0.10 + i * 0.20);
      var botY = h * (0.50 + i * 0.17);
      var halfW = w * (0.16 + i * 0.11);
      c.beginPath();
      c.moveTo(w * 0.5, topY);
      c.lineTo(w * 0.5 + halfW, botY);
      c.lineTo(w * 0.5 - halfW, botY);
      c.closePath();
      c.fill();
    }
    if (variant === 2) {
      c.fillStyle = 'rgba(245,250,255,0.88)';
      c.beginPath();
      c.moveTo(w * 0.5, h * 0.10);
      c.lineTo(w * 0.5 + w * 0.09, h * 0.26);
      c.lineTo(w * 0.5 - w * 0.09, h * 0.26);
      c.closePath();
      c.fill();
    }
  }

  function drawScRock(c, w, h, gy, variant) {
    var base = ['#7c766c', '#6d675e', '#8a8378'][variant % 3];
    c.fillStyle = base;
    c.beginPath();
    c.moveTo(w * 0.06, gy);
    c.lineTo(w * 0.24, h * 0.34);
    c.lineTo(w * 0.46, h * 0.12);
    c.lineTo(w * 0.68, h * 0.30);
    c.lineTo(w * 0.94, gy);
    c.closePath();
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.14)';
    c.beginPath();
    c.moveTo(w * 0.24, h * 0.34);
    c.lineTo(w * 0.46, h * 0.12);
    c.lineTo(w * 0.50, gy);
    c.closePath();
    c.fill();
    c.fillStyle = 'rgba(0,0,0,0.18)';
    c.beginPath();
    c.moveTo(w * 0.68, h * 0.30);
    c.lineTo(w * 0.94, gy);
    c.lineTo(w * 0.60, gy);
    c.closePath();
    c.fill();
  }

  function drawScBuilding(c, w, h, gy, rnd2, variant) {
    var body = ['#39405a', '#4b3a56', '#2f465a'][variant % 3];
    c.fillStyle = body;
    c.fillRect(w * 0.12, h * 0.12, w * 0.76, gy - h * 0.12);
    c.fillStyle = 'rgba(0,0,0,0.25)';
    c.fillRect(w * 0.10, h * 0.10, w * 0.80, h * 0.05);

    var cols = 4, rows = 8;
    var cw = (w * 0.64) / cols;
    var chh = (h * 0.62) / rows;
    for (var r = 0; r < rows; r++) {
      for (var i = 0; i < cols; i++) {
        c.fillStyle = (rnd2() < 0.55) ? 'rgba(255,226,150,0.90)' : 'rgba(120,140,175,0.32)';
        c.fillRect(w * 0.18 + i * cw + cw * 0.18, h * 0.18 + r * chh + chh * 0.2, cw * 0.55, chh * 0.5);
      }
    }
    c.strokeStyle = 'rgba(200,210,230,0.6)';
    c.lineWidth = Math.max(1, w * 0.018);
    c.beginPath();
    c.moveTo(w * 0.5, h * 0.12);
    c.lineTo(w * 0.5, h * 0.02);
    c.stroke();
  }

  function drawScBillboard(c, w, h, gy, variant) {
    c.strokeStyle = '#5a5f6e';
    c.lineWidth = Math.max(2, w * 0.032);
    c.beginPath();
    c.moveTo(w * 0.30, gy);
    c.lineTo(w * 0.34, h * 0.62);
    c.stroke();
    c.beginPath();
    c.moveTo(w * 0.70, gy);
    c.lineTo(w * 0.66, h * 0.62);
    c.stroke();

    c.fillStyle = '#20242e';
    c.fillRect(w * 0.06, h * 0.10, w * 0.88, h * 0.52);

    var sets = [
      ['#ff5a1f', '#ffd166', '#ff2e63'],
      ['#39e6ff', '#7b5cff', '#00d5b0'],
      ['#f2c14e', '#ff8a5c', '#e9e9f2']
    ];
    var cols = sets[variant % 3];
    for (var i = 0; i < 3; i++) {
      c.fillStyle = cols[i];
      c.fillRect(w * 0.09, h * (0.14 + i * 0.16), w * 0.82, h * 0.12);
    }
    c.strokeStyle = '#cfd6e6';
    c.lineWidth = Math.max(1, w * 0.02);
    c.strokeRect(w * 0.06, h * 0.10, w * 0.88, h * 0.52);
  }

  function drawScGrandstand(c, w, h, gy, rnd2, variant) {
    c.fillStyle = '#3a3f4e';
    c.fillRect(w * 0.05, h * 0.45, w * 0.90, gy - h * 0.45);
    for (var i = 0; i < 4; i++) {
      c.fillStyle = 'rgba(255,255,255,0.07)';
      c.fillRect(w * 0.06, h * (0.50 + i * 0.11), w * 0.88, h * 0.02);
    }
    var crowd = ['#ff5a1f', '#39e6ff', '#ffd166', '#ff2e63', '#e9e9f2', '#7b5cff'];
    for (var r = 0; r < 5; r++) {
      for (var k = 0; k < 16; k++) {
        var idx = (r * 3 + k + ((rnd2() * 6) | 0)) % crowd.length;
        c.fillStyle = crowd[idx];
        c.fillRect(w * 0.08 + k * w * 0.055, h * (0.47 + r * 0.095), w * 0.03, h * 0.05);
      }
    }
    c.fillStyle = '#20242e';
    c.fillRect(w * 0.03, h * 0.14, w * 0.94, h * 0.08);
    c.fillRect(w * 0.08, h * 0.20, w * 0.03, h * 0.26);
    c.fillRect(w * 0.89, h * 0.20, w * 0.03, h * 0.26);
    if (variant === 1) {
      c.fillStyle = 'rgba(255,90,31,0.9)';
      c.fillRect(w * 0.30, h * 0.16, w * 0.40, h * 0.04);
    }
  }

  function drawScTent(c, w, h, gy, variant) {
    var sets = [
      ['#ff5a1f', '#f4f6ff'],
      ['#39e6ff', '#f4f6ff'],
      ['#7b5cff', '#ffd166']
    ];
    var set = sets[variant % 3];
    c.fillStyle = set[1];
    c.beginPath();
    c.moveTo(w * 0.5, h * 0.06);
    c.lineTo(w * 0.94, h * 0.72);
    c.lineTo(w * 0.06, h * 0.72);
    c.closePath();
    c.fill();

    c.save();
    c.beginPath();
    c.moveTo(w * 0.5, h * 0.06);
    c.lineTo(w * 0.94, h * 0.72);
    c.lineTo(w * 0.06, h * 0.72);
    c.closePath();
    c.clip();
    c.fillStyle = set[0];
    for (var i = 0; i < 6; i += 2) {
      c.fillRect(w * (0.04 + i * 0.15), h * 0.04, w * 0.15, h * 0.72);
    }
    c.restore();

    c.fillStyle = 'rgba(0,0,0,0.30)';
    c.fillRect(w * 0.06, h * 0.72, w * 0.88, Math.max(2, gy - h * 0.72));
    c.fillStyle = 'rgba(255,255,255,0.18)';
    c.fillRect(w * 0.44, h * 0.72, w * 0.12, Math.max(2, gy - h * 0.72));
  }

  function drawScFlag(c, w, h, gy, variant) {
    c.strokeStyle = '#c9cfdd';
    c.lineWidth = Math.max(2, w * 0.05);
    c.beginPath();
    c.moveTo(w * 0.30, gy);
    c.lineTo(w * 0.30, h * 0.08);
    c.stroke();

    var col = ['#ff5a1f', '#39e6ff', '#ffd166'][variant % 3];
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(w * 0.30, h * 0.10);
    c.quadraticCurveTo(w * 0.70, h * 0.16, w * 0.84, h * 0.30);
    c.quadraticCurveTo(w * 0.60, h * 0.34, w * 0.30, h * 0.42);
    c.closePath();
    c.fill();

    c.fillStyle = 'rgba(255,255,255,0.35)';
    c.fillRect(w * 0.30, h * 0.10, w * 0.08, h * 0.32);
  }

  function drawScLightpole(c, w, h, gy) {
    c.strokeStyle = '#8d93a3';
    c.lineWidth = Math.max(2, w * 0.06);
    c.beginPath();
    c.moveTo(w * 0.5, gy);
    c.lineTo(w * 0.5, h * 0.16);
    c.stroke();

    var g = c.createRadialGradient(w * 0.5, h * 0.14, 0, w * 0.5, h * 0.14, w * 0.55);
    g.addColorStop(0, 'rgba(255,236,170,0.85)');
    g.addColorStop(1, 'rgba(255,220,140,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h * 0.45);

    c.fillStyle = '#d8deea';
    c.fillRect(w * 0.30, h * 0.11, w * 0.40, h * 0.07);
  }

  function drawScBalloon(c, w, h, gy, variant) {
    var sets = [
      ['#ff5a1f', '#ffd166'],
      ['#39e6ff', '#7b5cff'],
      ['#ff2e63', '#e9e9f2']
    ];
    var set = sets[variant % 3];
    var cx = w * 0.5;
    var cy = h * 0.30;
    var r = w * 0.30;

    c.fillStyle = set[0];
    c.beginPath();
    c.ellipse(cx, cy, r, r * 1.12, 0, 0, Math.PI * 2);
    c.fill();

    c.save();
    c.beginPath();
    c.ellipse(cx, cy, r, r * 1.12, 0, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = set[1];
    c.fillRect(cx - r * 0.18, cy - r * 1.3, r * 0.36, r * 2.6);
    c.restore();

    c.strokeStyle = 'rgba(220,225,240,0.55)';
    c.lineWidth = Math.max(1, w * 0.012);
    c.beginPath();
    c.moveTo(cx - r * 0.5, cy + r * 0.95);
    c.lineTo(cx - w * 0.08, h * 0.72);
    c.moveTo(cx + r * 0.5, cy + r * 0.95);
    c.lineTo(cx + w * 0.08, h * 0.72);
    c.stroke();

    c.fillStyle = '#6b4a2f';
    c.fillRect(cx - w * 0.12, h * 0.72, w * 0.24, Math.max(3, gy - h * 0.72));
  }

  function drawScSign(c, w, h, gy, variant) {
    c.strokeStyle = '#9aa1b2';
    c.lineWidth = Math.max(2, w * 0.06);
    c.beginPath();
    c.moveTo(w * 0.5, gy);
    c.lineTo(w * 0.5, h * 0.40);
    c.stroke();

    c.fillStyle = (variant % 2 === 0) ? '#2f6f4f' : '#2f4f8f';
    roundRect(c, w * 0.08, h * 0.08, w * 0.84, h * 0.38, w * 0.06);
    c.fill();

    c.fillStyle = 'rgba(245,250,255,0.88)';
    c.fillRect(w * 0.18, h * 0.17, w * 0.64, h * 0.05);
    c.fillRect(w * 0.18, h * 0.27, w * 0.44, h * 0.05);
  }

  function drawScBush(c, w, h, gy, variant) {
    var col = ['#2f5f3c', '#386b45', '#28513a'][variant % 3];
    c.fillStyle = col;
    for (var i = 0; i < 4; i++) {
      var cx = w * (0.25 + i * 0.17);
      var cy = gy - h * (0.18 + (i % 2) * 0.10);
      var r = w * 0.19;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.beginPath();
    c.arc(w * 0.36, gy - h * 0.40, w * 0.10, 0, Math.PI * 2);
    c.fill();
  }

  function drawScBarrier(c, w, h, gy) {
    c.fillStyle = '#4a4f5e';
    c.fillRect(w * 0.14, h * 0.55, w * 0.08, Math.max(2, gy - h * 0.55));
    c.fillRect(w * 0.78, h * 0.55, w * 0.08, Math.max(2, gy - h * 0.55));
    c.fillStyle = '#f4f6ff';
    c.fillRect(w * 0.04, h * 0.28, w * 0.92, h * 0.30);
    c.fillStyle = '#ff5a1f';
    for (var i = 0; i < 4; i++) {
      c.fillRect(w * (0.08 + i * 0.23), h * 0.28, w * 0.11, h * 0.30);
    }
  }

  function getScenerySprite(kind, variant) {
    var k = KINDS[kind] ? kind : 'bush';
    var v = ((variant | 0) % 3 + 3) % 3;
    var key = k + '|' + v;
    var spr = scenerySprites[key];
    if (!spr) {
      if (typeof document === 'undefined') return null;
      try {
        spr = makeScenerySprite(k, v);
      } catch (e) {
        spr = null;
      }
      if (!spr) return null;
      scenerySprites[key] = spr;
    }
    return spr;
  }

  /* ---------- 星空 / 云 / 粒子池初始化 ---------- */

  function buildStars() {
    ST.stars.length = 0;
    var rnd2 = U.rng(0xC0FFEE);
    for (var i = 0; i < 90; i++) {
      ST.stars.push({ x: rnd2(), y: rnd2(), r: 0.9 + rnd2() * 1.3 });
    }
  }

  function buildClouds() {
    ST.clouds.length = 0;
    var rnd2 = U.rng(0x5EED11);
    for (var i = 0; i < 7; i++) {
      ST.clouds.push({
        az: rnd2() * Math.PI * 2 - Math.PI,
        elev: 0.10 + rnd2() * 0.34,
        scale: 0.5 + rnd2() * 0.9,
        alpha: 0.45 + rnd2() * 0.55,
        spr: i % 3
      });
    }
  }

  function ensureAssets() {
    if (typeof document === 'undefined') return;
    if (!assetsReady) {
      try {
        assets.sun = makeSunSprite(160);
        assets.moon = makeMoonSprite(140);
        assets.clouds = [];
        for (var i = 0; i < 3; i++) assets.clouds.push(makeCloudSprite(i));
        assets.brakeGlow = makeGlowSprite(64, [255, 70, 56]);
        assets.flame = makeFlameSprite(64);
        assets.particleSmoke = makeSoftDot(40, [232, 234, 240], 0.75);
        assets.particleDust = makeSoftDot(40, [200, 165, 118], 0.75);
        assets.particleSpark = makeSoftDot(28, [255, 196, 92], 0.9);
        buildStars();
        buildClouds();
        buildParticlePool();
      } catch (e) {
        /* 资源生成失败时仍可降级绘制（各绘制点均已判空） */
      }
      assetsReady = true;
    }

    var list = (HR.CARS && HR.CARS.length) ? HR.CARS : [];
    for (var k = 0; k < list.length; k++) {
      try { getCarSprite(list[k]); } catch (e2) { /* 忽略单辆车失败 */ }
    }

    /* 预生成所有场景精灵（14 种 × 3 变体），避免比赛中首次出现时卡顿 */
    try {
      var kinds = Object.keys(KINDS);
      for (var ki = 0; ki < kinds.length; ki++) {
        for (var vi = 0; vi < 3; vi++) getScenerySprite(kinds[ki], vi);
      }
    } catch (e3) { /* 忽略个别失败 */ }
  }

  /* ============================================================
   * 13. 尺寸 / 初始化 / API
   * ============================================================ */

  function resize() {
    if (!canvas || !ctx) return;
    var cw = canvas.clientWidth || 0;
    var ch = canvas.clientHeight || 0;
    if (!(cw > 0)) cw = window.innerWidth || 1280;
    if (!(ch > 0)) ch = window.innerHeight || 720;
    cw = Math.max(320, Math.round(cw));
    ch = Math.max(200, Math.round(ch));

    var wDpr = window.devicePixelRatio || 1;
    var nd = Math.min(wDpr, maxDpr);
    if (!(nd >= 1)) nd = 1;

    cssW = cw;
    cssH = ch;
    dpr = nd;
    W = cw;
    H = ch;
    focal = H * 0.9;

    var pw = Math.max(1, Math.round(cw * nd));
    var ph = Math.max(1, Math.round(ch * nd));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;

    try { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (e) { /* ignore */ }
    ctx.imageSmoothingEnabled = true;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    ST.skyGrad = null;
    ST.skyKey = '';
    ST.groundGrad = null;
    ST.groundKey = '';
    buildScreenGradients();
  }

  function ensureCanvasSize() {
    if (!canvas) return;
    var cw = canvas.clientWidth || 0;
    var ch = canvas.clientHeight || 0;
    if (!(cw > 0)) cw = window.innerWidth || 1280;
    if (!(ch > 0)) ch = window.innerHeight || 720;
    cw = Math.max(320, Math.round(cw));
    ch = Math.max(200, Math.round(ch));
    var wDpr = window.devicePixelRatio || 1;
    var nd = Math.min(wDpr, maxDpr);
    if (!(nd >= 1)) nd = 1;
    if (cw !== cssW || ch !== cssH || nd !== dpr) resize();
  }

  function init(canvasEl, opts) {
    if (typeof document === 'undefined') return;
    if (!canvasEl || typeof canvasEl.getContext !== 'function') return;
    canvas = canvasEl;

    var c = null;
    try {
      c = canvas.getContext('2d', { alpha: false, desynchronized: true });
    } catch (e) {
      c = null;
    }
    if (!c) {
      try { c = canvas.getContext('2d'); } catch (e2) { c = null; }
    }
    if (!c) return;
    ctx = c;

    /* 保留 init 之前可能已通过 setQuality 设定的画质 */
    var qn = (opts && typeof opts.quality === 'string' && QUALITY[opts.quality]) ? opts.quality : qualityName;
    if (!QUALITY[qn]) qn = 'high';
    qualityName = qn;
    qual = QUALITY[qn];
    drawDist = qual.draw;
    maxDpr = qual.dpr;

    inited = true;

    try {
      resize();
      ensureAssets();
    } catch (e3) {
      /* 初始化失败时不抛出，避免整个游戏白屏 */
    }
  }

  function setQuality(name) {
    var qn = (typeof name === 'string' && QUALITY[name]) ? name : 'high';
    if (qn === qualityName) return;
    qualityName = qn;
    qual = QUALITY[qn];
    drawDist = qual.draw;
    maxDpr = qual.dpr;
    if (inited && canvas && ctx) {
      try { resize(); } catch (e) { /* ignore */ }
    }
  }

  function setPaused(b) {
    paused = !!b;
  }

  function drawFrame(frame) {
    if (!inited || !ctx) return;
    if (!frame || typeof frame !== 'object') return;

    if (!assetsReady) {
      try { ensureAssets(); } catch (e) { /* ignore */ }
    }
    ensureCanvasSize();

    var fq = frame.quality;
    if (typeof fq === 'string' && QUALITY[fq] && fq !== qualityName) setQuality(fq);

    var dt = U.clamp(fin(frame.dt, 0.016), 0, 0.1);
    if (paused) dt = 0;

    var t = fin(frame.time, 0);
    timeSec = t;

    var track = (frame.track && typeof frame.track === 'object') ? frame.track : null;
    var cars = Array.isArray(frame.cars) ? frame.cars : [];
    var player = (frame.player && typeof frame.player === 'object') ? frame.player : null;
    var envF = (frame.environment && typeof frame.environment === 'object') ? frame.environment : null;

    var tod = U.wrap(fin(envF ? envF.timeOfDay : 12, 12), 24);
    var weather = (envF && typeof envF.weather === 'string') ? envF.weather : 'clear';

    updateCamera(frame, track, cars, t, dt);
    updateEnv(tod, weather);

    /* 观战（trackside）使用"长焦"效果：车在 ~58m 外仍保持可见大小 */
    focal = H * 0.9 * (ST.camMode === 'trackside' ? 1.65 : 1);

    /* 切换赛道 / 新一场比赛：清空粒子与车辆特效状态，避免旧坐标残留
     * 注意：HR.Track.generate 对同 seed 会返回缓存同一 track 对象，所以还要比较车辆数组身份。 */
    var carsRef = cars.length ? cars[0] : null;
    if (track !== ST.trackRef || carsRef !== ST.carsRef) {
      ST.trackRef = track;
      ST.carsRef = carsRef;
      carStateMap.clear();
      buildParticlePool();
    }

    sortArr.length = 0;
    recCount = 0;

    drawSky(t, tod);

    var hasTrack = !!(track && track.segments && track.segments.length > 0);
    if (hasTrack) {
      prepareView(track);
      drawGroundBase();
      drawGround(track, track.segments.length, ST.camSeg, ST.dirSign, ST.nSeg);
      drawWorld(frame, track, cars, player, t, dt);
    }

    updateParticles(dt);
    drawParticles();

    drawNightOverlay();
    drawAtmosphere(weather);
    if (weather === 'rain') drawRain(t);
    drawSpeedLines(player, t);
    drawTopBar();
    drawVignette();

    if (ctx.globalAlpha !== 1) ctx.globalAlpha = 1;
  }

  function getCameraYaw() {
    return fin(cam.eyaw, 0);
  }

  /* ============================================================
   * 14. 导出
   * ============================================================ */

  return {
    init: init,
    resize: resize,
    setQuality: setQuality,
    drawFrame: drawFrame,
    setPaused: setPaused,
    getCameraYaw: getCameraYaw
  };
})();
