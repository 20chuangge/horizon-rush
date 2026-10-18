/**
 * Horizon Rush · 极速地平线
 * track.js —— 赛道生成与世界数据（Track 负责人，唯一写入文件）
 *
 * ============================================================================
 * 算法要点（严格对应 ARCHITECTURE.md §2）
 * ----------------------------------------------------------------------------
 * 1) 星形极坐标闭合回路：θ_i = 2πi/N（N = 48 个控制点），
 *      r(θ) = base · (1 + a3·sin(3θ+p3) + a5·sin(5θ+p5) + a7·sin(7θ+p7))
 *    a3/a5/a7 与 p3/p5/p7 全部来自 HR.Util.rng(HR.Util.hashSeed(...))，
 *    同 seed 完全确定；极坐标 r(θ)>0 且 θ 单调 ⇒ 曲线天然无自交（星形域）。
 * 2) 闭合 Catmull-Rom（uniform）在控制点之间采样成稠密折线，按弧长整体缩放到
 *    目标长度 lengthKm·1000，再按 ~3m 等弧长重采样为 segment 折线（契约要求 2.5~4m）。
 * 3) 曲率自检 + 自适应降幅：在最终重采样折线上计算 |curve| 与相邻 |Δcurve|；
 *    若超过阈值（0.0205 / 0.0032，硬上限 0.022 / 0.004）则等比缩小 (a3,a5,a7)
 *    重新生成，最多 8 次；极端情况下退化为纯圆（曲率 2π/L ≤ 0.0079，天然合法）。
 *    ⇒ 不变式 A：|segments[i].curve| ≤ 0.022 且 |Δcurve| ≤ 0.004 恒成立。
 * 4) 高程 y 用 3 个低频正弦叠加（总幅值 ≤ 15m，契约 0~18m），起跑区乘平滑衰减
 *    因子让发车区更平；按弧长取样，闭合处连续（y[0] 与最后一段 ey 严格相等）。
 * 5) 宽度 width 是 s 的平滑函数：基础宽度 15.6 + 1.5·sin(2θ) + 0.8·sin(3θ)
 *    （13.3~17.9m）；起跑线 ±80m 内平滑「混合」到固定目标宽度 ≈22m，340m 外
 *    回到基础宽度（用混合而非相加，避免加宽量被基础宽度相位抵消）。
 *    ⇒ 不变式 B：13 ≤ width ≤ 22、相邻段 |Δwidth| ≤ 0.35，且任意 seed 的起跑区
 *      宽度都稳定 ≈22m（满足契约「起跑区加宽到 ~22m」）。
 * 6) zone 按弧长扇区切分（每区等长），起跑线位于 startZone（默认 'festival'）
 *    扇区的正中，使 s≈0 与发车格（s≈L-6 … L-55）都落在 festival；区界硬切换。
 * 7) racingLine（弯内走线）：先对 curve 做 6 次环形滑动平均，再取前方约 6m 的
 *    曲率量化：line = clamp(curve/0.0055, -1, 1) · width · 0.30；curve>0=右转、
 *    +x=右侧 ⇒ 弯内 = +sign(curve)（与契约一致；任务书示例里的 -sign 与
 *    「+x 右侧 / >0 右转」两个约定相矛盾，此处按契约取 + 号）。
 *    随后环形平滑，并用全局上界 min_i(width_i/2 - 2.25) 截断。
 *    ⇒ 不变式 C：|racingLine[i]| ≤ width_i/2 - 2.2，相邻差 ≤ 0.30（< 0.35）。
 * 8) gridSlots / checkpoints / minimap / scenery 全部由已生成的世界数据推导；
 *    scenery 的 off 是「有符号横向坐标」（+右侧，可直接 track.sample(seg.s, off)），
 *    side = sign(off)（-1 左 / +1 右），|off| ≥ width/2 + 2.4。
 *
 * 坐标系约定（ARCHITECTURE §2）：
 *   X 右 / Y 上 / Z 前（右手系）；yaw = atan2(dirX, dirZ)；
 *   right = (dirZ, -dirX)；curve > 0 表示右转（yaw 增大）；横向 +x = 右侧。
 *   segment 字段齐全：i,s,x,y,z,ex,ey,ez,dirX,dirZ,rightX,rightZ,yaw,slope,len,
 *   width,curve,zone,jitter。
 *
 * 防御性 / 约束：
 *   - 所有对外方法（segAt/sample/widthAt/curveAt/racingLineAt/zoneAt）对 s 为
 *     NaN / Infinity / 负数 / 超长都安全（自动 wrap 到 [0,length)）。
 *   - 随机性只来自 HR.Util.rng / HR.Util.hashSeed / HR.Util.noise1；
 *     禁止 Math.random / Date.now；不使用 import/export / 顶层副作用。
 *   - HR.Track.generate 用 Map 缓存（key = seed:lengthKm:zones.join(',')），
 *     同参数重复调用直接返回同一对象。
 * ============================================================================
 */
window.HR = window.HR || {};

HR.Track = (function () {
  'use strict';

  /* ==========================================================================
   * 0. 常量
   * ========================================================================== */
  var TWO_PI = Math.PI * 2;

  var SEG_TARGET_LEN = 3.0;      // 目标段长 m（契约 2.5~4）
  var MIN_SEGMENTS = 96;         // 最少段数（保证任何合法长度都能闭合）
  var MAX_SEGMENTS = 4000;       // 最多段数（12km 上限）
  var CONTROL_POINTS = 48;       // 极坐标控制点数（需 > 2×最高谐波 7）
  var MAX_ATTEMPTS = 8;          // 曲率自适应降幅的最大重试次数

  var CURVE_ACCEPT = 0.0205;     // 曲率接受阈值（硬上限 0.022，留 7% 余量）
  var CURVE_DELTA_ACCEPT = 0.0032; // 相邻曲率差阈值（硬上限 0.004）
  var LINE_DELTA_ACCEPT = 0.30;  // racingLine 相邻差阈值（硬上限 0.35）
  var LINE_GAIN = 0.30;          // 弯内走线幅度 = width × 0.30
  var LINE_LOOKAHEAD_M = 6;      // 走线曲率前瞻距离 m
  var CURVE_REF = 0.0055;        // 走线归一化参考曲率 1/m

  var MIN_LENGTH_KM = 0.8;
  var MAX_LENGTH_KM = 12;

  var CACHE_LIMIT = 16;

  var ZONE_CN = {
    festival: '嘉年华',
    coast: '海岸',
    desert: '沙漠',
    forest: '森林',
    mountain: '山道',
    city: '城市'
  };
  var ZONE_SET = {
    festival: true,
    coast: true,
    desert: true,
    forest: true,
    mountain: true,
    city: true
  };
  /* scenery.kind 只能取契约 §2.3 列表中的字符串；按 zone 选择 */
  var ZONE_KINDS = {
    festival: ['grandstand', 'tent', 'flag', 'balloon', 'billboard'],
    coast: ['palm', 'billboard', 'lightpole'],
    desert: ['cactus', 'rock', 'sign'],
    forest: ['pine', 'bush'],
    mountain: ['rock', 'pine'],
    city: ['building', 'lightpole', 'billboard']
  };
  /* 起跑区固定氛围：必须覆盖 grandstand / tent / flag / billboard */
  var START_SCENERY_KINDS = [
    'grandstand', 'grandstand', 'tent', 'tent',
    'flag', 'flag', 'billboard', 'billboard'
  ];

  /* ==========================================================================
   * 1. 基础数学（自带实现，避免依赖 util 对 NaN 的具体行为）
   * ========================================================================== */
  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smooth01(t) {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /** 把 s 安全 wrap 到 [0, len)；NaN/Infinity/非法 len 一律返回 0 */
  function wrapS(s, len) {
    if (typeof s !== 'number' || !isFinite(s) || !(len > 0)) return 0;
    s = s % len;
    return s < 0 ? s + len : s;
  }

  /** 把角度规范到 (-PI, PI] */
  function wrapAngle(a) {
    if (typeof a !== 'number' || !isFinite(a)) return 0;
    a = a % TWO_PI;
    if (a <= -Math.PI) a += TWO_PI;
    else if (a > Math.PI) a -= TWO_PI;
    return a;
  }

  /* ==========================================================================
   * 2. HR.Util 获取（正常加载顺序下直接使用 util.js；仅做兜底防崩溃）
   * ========================================================================== */
  var LOCAL_UTIL = null;

  function getUtil() {
    var U = (typeof HR !== 'undefined' && HR) ? HR.Util : null;
    if (U && typeof U.rng === 'function' && typeof U.hashSeed === 'function' &&
        typeof U.noise1 === 'function') {
      return U;
    }
    if (!LOCAL_UTIL) {
      /* 仅在 util.js 未按顺序加载时生效的等价兜底（不影响正常路径的确定性） */
      var local = {
        hashSeed: function (v) {
          var s = String(v == null ? '' : v);
          var h = 2166136261;
          for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
          }
          return h >>> 0;
        },
        rng: function (seed) {
          var a = (seed >>> 0) || 0x9e3779b9;
          return function () {
            a |= 0;
            a = (a + 0x6D2B79F5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
        }
      };
      local.noise1 = function (x, seed) {
        var i = Math.floor(x);
        var f = x - i;
        var r1 = local.rng((local.hashSeed(seed) + i * 374761393) >>> 0)();
        var r2 = local.rng((local.hashSeed(seed) + (i + 1) * 374761393) >>> 0)();
        return lerp(r1, r2, smooth01(f));
      };
      LOCAL_UTIL = local;
    }
    return LOCAL_UTIL;
  }

  /* ==========================================================================
   * 3. 参数规范化 / 命名
   * ========================================================================== */
  function normalizeZones(rawZones, rawStartZone) {
    var list = [];
    var i;
    if (Object.prototype.toString.call(rawZones) === '[object Array]') {
      for (i = 0; i < rawZones.length; i++) {
        var z = rawZones[i];
        if (typeof z === 'string' && ZONE_SET[z] && list.indexOf(z) < 0) list.push(z);
      }
    }
    if (!list.length) list = ['coast', 'desert', 'festival'];

    var startZone = (typeof rawStartZone === 'string' && ZONE_SET[rawStartZone])
      ? rawStartZone : 'festival';
    if (list.indexOf(startZone) < 0) list.push(startZone);
    /* 起跑区必须是 festival（默认 startZone 即 festival；此分支仅防御异常入参） */
    if (list.indexOf('festival') < 0) list.push('festival');

    return { zones: list, startZone: startZone };
  }

  function defaultName(zones) {
    var parts = [];
    for (var i = 0; i < zones.length; i++) {
      parts.push(ZONE_CN[zones[i]] || zones[i]);
    }
    return parts.join(' · ') + ' 环线';
  }

  /* ==========================================================================
   * 4. 生成缓存（同 seed + lengthKm + zones 返回同一 track 对象）
   * ========================================================================== */
  var cache = null;

  function cacheGet(key) {
    return cache ? (cache.get(key) || null) : null;
  }

  function cachePut(key, track) {
    if (!cache) cache = new Map();
    if (cache.size >= CACHE_LIMIT) {
      var oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, track);
  }

  function clearCache() {
    if (cache) cache.clear();
  }

  /* ==========================================================================
   * 5. HR.Track.generate(opts) -> track
   *    opts = { seed:int, name:string, lengthKm:number, zones:string[], startZone?:string }
   * ========================================================================== */
  function generate(opts) {
    opts = opts || {};
    var U = getUtil();

    /* ---- seed（同 seed 完全确定；禁止 Math.random / Date.now） ---- */
    var seed;
    if (typeof opts.seed === 'number' && isFinite(opts.seed)) {
      seed = Math.floor(opts.seed) >>> 0;
    } else if (opts.seed == null) {
      seed = 20240501;
    } else {
      seed = U.hashSeed(opts.seed);
    }

    /* ---- lengthKm ---- */
    var lengthKm = 4.5;
    if (typeof opts.lengthKm === 'number' && isFinite(opts.lengthKm) && opts.lengthKm > 0) {
      lengthKm = clamp(opts.lengthKm, MIN_LENGTH_KM, MAX_LENGTH_KM);
    }

    /* ---- zones / startZone ---- */
    var zinfo = normalizeZones(opts.zones, opts.startZone);

    /* ---- name ---- */
    var name = (typeof opts.name === 'string' && opts.name.length)
      ? opts.name : defaultName(zinfo.zones);

    /* ---- 缓存命中 ----
       key 按约定 = seed:lengthKm:zones.join(',')；若调用方显式指定了非默认
       startZone（会影响扇区布局），再追加 startZone 以免不同布局互相串用。 */
    var key = seed + ':' + lengthKm + ':' + zinfo.zones.join(',');
    if (zinfo.startZone !== 'festival') key += ':' + zinfo.startZone;
    var cached = cacheGet(key);
    if (cached) {
      if (typeof opts.name === 'string' && opts.name.length) cached.name = opts.name;
      return cached;
    }

    var track = buildTrack(seed, name, lengthKm, zinfo, U);
    cachePut(key, track);
    return track;
  }

  /* ==========================================================================
   * 6. 形状参数 / 极坐标控制点 / Catmull-Rom 稠密采样
   * ========================================================================== */
  function makeShape(seed, U) {
    var rnd = U.rng(U.hashSeed('hr-shape:' + seed));
    var jit = function (base, frac) {
      return base * (1 + (rnd() * 2 - 1) * frac);
    };
    return {
      baseR: 600,                                  // 形状只决定比例，最终按弧长缩放
      a3: jit(0.26, 0.10),                         // 3 次谐波
      a5: jit(0.14, 0.10),                         // 5 次谐波
      a7: jit(0.075, 0.12),                        // 7 次谐波
      p3: rnd() * TWO_PI,
      p5: rnd() * TWO_PI,
      p7: rnd() * TWO_PI,
      rot: rnd() * TWO_PI,                         // 整体旋转（不改变曲率特性）
      h1: 5.6 + rnd() * 2.0,                       // 高程：总幅值 ≤ 15m
      h2: 3.0 + rnd() * 1.7,
      h3: 1.5 + rnd() * 1.2,
      hp1: rnd() * TWO_PI,
      hp2: rnd() * TWO_PI,
      hp3: rnd() * TWO_PI,
      wp1: rnd() * TWO_PI,                         // 宽度低频起伏相位
      wp2: rnd() * TWO_PI,
      wStart: 21.75 + rnd() * 0.15                 // 起跑区目标全宽 m（≈22m，契约要求）
    };
  }

  function makeControls(shape, ampScale) {
    var ctrl = new Array(CONTROL_POINTS);
    var a3 = shape.a3 * ampScale;
    var a5 = shape.a5 * ampScale;
    var a7 = shape.a7 * ampScale;
    for (var i = 0; i < CONTROL_POINTS; i++) {
      var th = TWO_PI * i / CONTROL_POINTS;
      var r = 1
        + a3 * Math.sin(3 * th + shape.p3)
        + a5 * Math.sin(5 * th + shape.p5)
        + a7 * Math.sin(7 * th + shape.p7);
      if (!(r > 0.18)) r = 0.18; // 防御：保持星形（r > 0，射线与曲线恰好一个交点）
      var rr = shape.baseR * r;
      ctrl[i] = {
        x: rr * Math.cos(th + shape.rot),
        z: rr * Math.sin(th + shape.rot)
      };
    }
    return ctrl;
  }

  /** 闭合 uniform Catmull-Rom：返回 { x:Float64Array, z:Float64Array }（K 个稠密点） */
  function sampleClosedCatmullRom(ctrl, subdiv) {
    var N = ctrl.length;
    var K = N * subdiv;
    var xs = new Float64Array(K);
    var zs = new Float64Array(K);
    var idx = 0;
    var i, j;
    for (i = 0; i < N; i++) {
      var p0 = ctrl[(i - 1 + N) % N];
      var p1 = ctrl[i];
      var p2 = ctrl[(i + 1) % N];
      var p3 = ctrl[(i + 2) % N];
      for (j = 0; j < subdiv; j++) {
        var t = j / subdiv;
        var t2 = t * t;
        var t3 = t2 * t;
        xs[idx] = 0.5 * (
          (2 * p1.x) +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
        );
        zs[idx] = 0.5 * (
          (2 * p1.z) +
          (-p0.z + p2.z) * t +
          (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
          (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3
        );
        idx++;
      }
    }
    return { x: xs, z: zs };
  }

  function polylineLength(p) {
    var n = p.x.length;
    var total = 0;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var dx = p.x[j] - p.x[i];
      var dz = p.z[j] - p.z[i];
      total += Math.sqrt(dx * dx + dz * dz);
    }
    return total;
  }

  function scalePoints(p, scale) {
    for (var i = 0; i < p.x.length; i++) {
      p.x[i] *= scale;
      p.z[i] *= scale;
    }
  }

  /** 在闭合稠密折线上按等弧长重采样为 M 个点（总弧长保持不变） */
  function resampleClosed(dense, M) {
    var n = dense.x.length;
    var cum = new Float64Array(n + 1);
    var total = 0;
    var i;
    for (i = 0; i < n; i++) {
      var j = (i + 1) % n;
      var dx = dense.x[j] - dense.x[i];
      var dz = dense.z[j] - dense.z[i];
      total += Math.sqrt(dx * dx + dz * dz);
      cum[i + 1] = total;
    }
    var x = new Float64Array(M);
    var z = new Float64Array(M);
    if (!(total > 1e-6)) return { x: x, z: z };
    var ds = total / M;
    var k = 0;
    for (i = 0; i < M; i++) {
      var target = ds * i;
      while (k < n - 1 && cum[k + 1] < target) k++;
      var segLen = cum[k + 1] - cum[k];
      var t = segLen > 1e-9 ? (target - cum[k]) / segLen : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      var k2 = (k + 1) % n;
      x[i] = dense.x[k] + (dense.x[k2] - dense.x[k]) * t;
      z[i] = dense.z[k] + (dense.z[k2] - dense.z[k]) * t;
    }
    return { x: x, z: z };
  }

  /**
   * 由 M 个折线顶点计算：段长 len(i)、方向 yaw(i)（从 i 指向 i+1）、
   * 有符号曲率 curve(i)（>0 右转 = yaw 增大）以及最大绝对值/相邻差。
   */
  function measurePolyline(x, z) {
    var M = x.length;
    var lens = new Float64Array(M);
    var yaw = new Float64Array(M);
    var i, j, dx, dz, l;
    for (i = 0; i < M; i++) {
      j = (i + 1) % M;
      dx = x[j] - x[i];
      dz = z[j] - z[i];
      l = Math.sqrt(dx * dx + dz * dz);
      if (!(l > 1e-6)) { // 防御：绝不产生 NaN / Infinity
        l = 1e-6;
        dx = 0;
        dz = 1;
      }
      lens[i] = l;
      yaw[i] = Math.atan2(dx, dz);
    }
    var curves = new Float64Array(M);
    var maxAbs = 0;
    for (i = 0; i < M; i++) {
      j = (i + 1) % M;
      var avg = (lens[i] + lens[j]) * 0.5;
      var c = wrapAngle(yaw[j] - yaw[i]) / (avg > 1e-6 ? avg : 1e-6);
      curves[i] = c;
      if (Math.abs(c) > maxAbs) maxAbs = Math.abs(c);
    }
    var maxDelta = 0;
    for (i = 0; i < M; i++) {
      var d = Math.abs(curves[i] - curves[(i + 1) % M]);
      if (d > maxDelta) maxDelta = d;
    }
    return {
      lens: lens,
      yaw: yaw,
      curves: curves,
      maxAbsCurve: maxAbs,
      maxDeltaCurve: maxDelta
    };
  }

  /* ==========================================================================
   * 7. 中心线构建（含曲率自适应降幅 + 纯圆兜底）
   * ========================================================================== */
  function buildCenterline(targetLen, shape) {
    var M = clamp(Math.round(targetLen / SEG_TARGET_LEN), MIN_SEGMENTS, MAX_SEGMENTS);
    var denseTarget = Math.max(1600, M * 3);
    var subdiv = clamp(Math.ceil(denseTarget / CONTROL_POINTS), 10, 260);
    var ampScale = 1;
    var result = null;
    var attempt;

    for (attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      var ctrl = makeControls(shape, ampScale);
      var dense = sampleClosedCatmullRom(ctrl, subdiv);
      var denseLen = polylineLength(dense);
      if (denseLen > 1e-6) {
        scalePoints(dense, targetLen / denseLen); // 形状线性缩放 ⇒ 长度精确命中
        var re = resampleClosed(dense, M);
        var metrics = measurePolyline(re.x, re.z);
        var accepted = metrics.maxAbsCurve <= CURVE_ACCEPT &&
                       metrics.maxDeltaCurve <= CURVE_DELTA_ACCEPT;
        result = { M: M, x: re.x, z: re.z, metrics: metrics, accepted: accepted };
        if (accepted) break;
        if (attempt < MAX_ATTEMPTS - 1) {
          var ratio = (metrics.maxAbsCurve > CURVE_ACCEPT)
            ? (CURVE_ACCEPT * 0.90 / metrics.maxAbsCurve)
            : 0.70;
          ampScale *= clamp(ratio, 0.45, 0.86);
        }
      } else {
        ampScale *= 0.5;
      }
    }

    if (!result || !result.accepted) {
      /* 自适应降幅 8 次后仍未达到「验收阈值」时：
         - 若最后一次结果的曲率仍满足契约硬上限，直接采用（形状比纯圆好）；
         - 否则退化为纯圆。纯圆曲率 2π/L ≤ 0.0079 < 0.022、相邻差 ≈ 0，天然合法。 */
      var m = result ? result.metrics : null;
      var hardOK = !!(m && m.maxAbsCurve <= 0.0218 && m.maxDeltaCurve <= 0.0039);
      if (!hardOK) {
        var cx = new Float64Array(M);
        var cz = new Float64Array(M);
        var radius = targetLen / TWO_PI;
        for (var i = 0; i < M; i++) {
          var a = TWO_PI * i / M;
          cx[i] = radius * Math.cos(a);
          cz[i] = radius * Math.sin(a);
        }
        result = {
          M: M,
          x: cx,
          z: cz,
          metrics: measurePolyline(cx, cz),
          accepted: false
        };
      }
    }
    return result;
  }

  /* ==========================================================================
   * 8. 环形滑动平均 / racingLine
   * ========================================================================== */
  function circularSmooth(arr, count, window, passes, tmp) {
    if (count < 3 || passes <= 0) return arr;
    var half = (window - 1) >> 1;
    if (half < 1) return arr;
    var span = half * 2 + 1;
    var buf = tmp || new Float64Array(count);
    for (var p = 0; p < passes; p++) {
      for (var i = 0; i < count; i++) {
        var sum = 0;
        for (var k = -half; k <= half; k++) {
          var j = i + k;
          while (j < 0) j += count;
          while (j >= count) j -= count;
          sum += arr[j];
        }
        buf[i] = sum / span;
      }
      for (var q = 0; q < count; q++) arr[q] = buf[q];
    }
    return arr;
  }

  /**
   * 弯内走线：
   *   curve > 0 = 右转；横向 +x = 右侧 ⇒ 弯心在 + 侧，raw = +clamp(curve/REF)·width·0.30。
   *   多次平滑保证相邻差 ≤ 0.30，最后用全局上界截断保证 |line| ≤ width/2-2.2。
   */
  function buildRacingLine(curves, widths, M, totalLen) {
    var i;
    var smoothCurve = new Float64Array(M);
    for (i = 0; i < M; i++) smoothCurve[i] = curves[i];
    circularSmooth(smoothCurve, M, 7, 6, new Float64Array(M));

    var avgLen = totalLen / M;
    var look = clamp(
      Math.round(LINE_LOOKAHEAD_M / (avgLen > 1e-6 ? avgLen : SEG_TARGET_LEN)),
      1, 6
    );

    var raw = new Float64Array(M);
    for (i = 0; i < M; i++) {
      var q = smoothCurve[(i + look) % M] / CURVE_REF;
      if (q > 1) q = 1; else if (q < -1) q = -1;
      raw[i] = q * widths[i] * LINE_GAIN;
    }

    var tmp = new Float64Array(M);
    circularSmooth(raw, M, 5, 5, tmp);

    /* 强制相邻差 ≤ 0.30（滑动平均后差值单调收敛，通常 0~2 轮即可退出） */
    var maxDiff = 0;
    var guard = 0;
    while (guard < 240) {
      maxDiff = 0;
      for (i = 0; i < M; i++) {
        var d = Math.abs(raw[(i + 1) % M] - raw[i]);
        if (d > maxDiff) maxDiff = d;
      }
      if (maxDiff <= LINE_DELTA_ACCEPT) break;
      circularSmooth(raw, M, 5, 1, tmp);
      guard++;
    }
    if (!(maxDiff <= LINE_DELTA_ACCEPT)) {
      /* 理论兜底：直线走线恒满足平滑与幅度约束 */
      for (i = 0; i < M; i++) raw[i] = 0;
    }

    /* 全局上界：min(width_i/2 - 2.25) ⇒ 对每个 i 都有 |line| ≤ width_i/2 - 2.2 */
    var bound = 6.5;
    for (i = 0; i < M; i++) {
      var b = widths[i] * 0.5 - 2.25;
      if (b < bound) bound = b;
    }
    if (!(bound > 0.3)) bound = 0.3;

    var line = new Float32Array(M);
    for (i = 0; i < M; i++) {
      var v = raw[i];
      if (v > bound) v = bound; else if (v < -bound) v = -bound;
      line[i] = v;
    }
    return line;
  }

  /* ==========================================================================
   * 9. zone 扇区解析（起跑线在 startZone 扇区正中）
   * ========================================================================== */
  function makeZoneResolver(zinfo, trackLen) {
    var order = [zinfo.startZone];
    var i;
    for (i = 0; i < zinfo.zones.length; i++) {
      if (zinfo.zones[i] !== zinfo.startZone) order.push(zinfo.zones[i]);
    }
    var K = order.length;
    var startSpan = trackLen / K;
    var startHalf = startSpan * 0.5;
    var innerSpan = (K > 1) ? (trackLen - startSpan) / (K - 1) : 0;

    function zoneOf(s) {
      if (K <= 1) return order[0];
      if (s < startHalf || s >= trackLen - startHalf) return order[0];
      if (!(innerSpan > 1e-6)) return order[0];
      var idx = 1 + Math.floor((s - startHalf) / innerSpan);
      if (idx < 1) idx = 1;
      if (idx > K - 1) idx = K - 1;
      return order[idx];
    }

    return { zoneOf: zoneOf, startHalf: startHalf, order: order };
  }

  /* ==========================================================================
   * 10. 完整 track 构建
   * ========================================================================== */
  function buildTrack(seed, name, lengthKm, zinfo, U) {
    var targetLen = lengthKm * 1000;
    var shape = makeShape(seed, U);
    var cl = buildCenterline(targetLen, shape);
    var M = cl.M;
    var metrics = cl.metrics;
    var lens = metrics.lens;
    var yaws = metrics.yaw;
    var curves = metrics.curves;
    var px = cl.x;
    var pz = cl.z;
    var i, j;

    /* ---- 累计弧长 s（track.length = Σ len） ---- */
    var sArr = new Float64Array(M);
    var totalLen = 0;
    for (i = 0; i < M; i++) {
      sArr[i] = totalLen;
      totalLen += lens[i];
    }

    /* ---- zone 扇区 ---- */
    var zoneRes = makeZoneResolver(zinfo, totalLen);

    /* ---- 高程 / 宽度 / zone / jitter ---- */
    var yArr = new Float64Array(M);
    var wArr = new Float64Array(M);
    var zoneArr = new Array(M);
    var jitArr = new Float64Array(M);
    for (i = 0; i < M; i++) {
      var s = sArr[i];
      var th = TWO_PI * s / totalLen;
      var dStart = s < totalLen - s ? s : totalLen - s; // 到起跑线的环形距离
      /* 高程：低频正弦叠加；起跑区平滑压平 */
      var flatten = 0.32 + 0.68 * smooth01(dStart / 320);
      yArr[i] = flatten * (
        shape.h1 * Math.sin(2 * th + shape.hp1) +
        shape.h2 * Math.sin(3 * th + shape.hp2) +
        shape.h3 * Math.sin(5 * th + shape.hp3)
      );
      /* 宽度：基础 13.3~17.9m；起跑区渐变系数 startBlend 为 1，平滑「混合」到
         shape.wStart（21.75~21.9m），340m 外回到基础宽度。
         用混合而不是叠加，可保证任意 seed 相位下起跑线宽度都稳定 ≈22m。 */
      var wBase = 15.6
        + 1.5 * Math.sin(2 * th + shape.wp1)
        + 0.8 * Math.sin(3 * th + shape.wp2);
      var startBlend = smooth01((340 - dStart) / 260);
      var w = wBase + (shape.wStart - wBase) * startBlend;
      wArr[i] = clamp(w, 13.05, 21.9);
      zoneArr[i] = zoneRes.zoneOf(s);
      jitArr[i] = U.noise1(i * 0.731 + 0.37, seed + 7); // 0..1 装饰随机数
    }

    /* ---- 推荐走线 ---- */
    var racingLine = buildRacingLine(curves, wArr, M, totalLen);

    /* ---- segments（契约 §2.1 全部字段） ---- */
    var segs = new Array(M);
    var starts = new Float64Array(M);
    var sAcc = 0;
    for (i = 0; i < M; i++) {
      j = (i + 1) % M;
      var len = lens[i];
      var dx = px[j] - px[i];
      var dz = pz[j] - pz[i];
      var dirX = dx / len;
      var dirZ = dz / len;
      var yaw = yaws[i];
      starts[i] = sAcc;
      segs[i] = {
        i: i,
        s: sAcc,
        x: px[i],
        y: yArr[i],
        z: pz[i],
        ex: px[j],
        ey: yArr[j],
        ez: pz[j],
        dirX: dirX,
        dirZ: dirZ,
        rightX: dirZ,
        rightZ: -dirX,
        yaw: yaw,
        slope: (yArr[j] - yArr[i]) / len,
        len: len,
        width: wArr[i],
        curve: curves[i],
        zone: zoneArr[i],
        jitter: jitArr[i]
      };
      sAcc += len;
    }

    /* ---- 查询方法（全部自动 wrap，对 NaN/Infinity 安全） ---- */
    function indexAt(s) {
      s = wrapS(s, totalLen);
      var lo = 0;
      var hi = M - 1;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= s) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    function fracInSeg(s, i) {
      s = wrapS(s, totalLen);
      var l = segs[i].len;
      if (!(l > 1e-9)) return 0;
      var t = (s - starts[i]) / l;
      return t < 0 ? 0 : (t > 1 ? 1 : t);
    }

    function segAt(s) {
      return indexAt(s);
    }

    function widthAt(s) {
      var i = indexAt(s);
      var j2 = (i + 1) % M;
      return lerp(segs[i].width, segs[j2].width, fracInSeg(s, i));
    }

    function curveAt(s) {
      var i = indexAt(s);
      var j2 = (i + 1) % M;
      return lerp(segs[i].curve, segs[j2].curve, fracInSeg(s, i));
    }

    function racingLineAt(s) {
      var i = indexAt(s);
      var j2 = (i + 1) % M;
      return lerp(racingLine[i], racingLine[j2], fracInSeg(s, i));
    }

    function zoneAt(s) {
      return segs[indexAt(s)].zone;
    }

    function sample(s, lateral) {
      s = wrapS(s, totalLen);
      var i = indexAt(s);
      var seg = segs[i];
      var j2 = (i + 1) % M;
      var nxt = segs[j2];
      var t = (seg.len > 1e-9) ? (s - seg.s) / seg.len : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);

      /* 方向按角度插值（跨 ±π 用 wrapAngle 取最短弧），并把结果规范回 (-π,π]，
         从而恒有 dirX=sin(yaw)、dirZ=cos(yaw)、yaw=atan2(dirX,dirZ)。 */
      var yaw = wrapAngle(seg.yaw + wrapAngle(nxt.yaw - seg.yaw) * t);
      var dirX = Math.sin(yaw);
      var dirZ = Math.cos(yaw);
      var rightX = dirZ;
      var rightZ = -dirX;
      var lat = (typeof lateral === 'number' && isFinite(lateral)) ? lateral : 0;

      return {
        x: seg.x + (seg.ex - seg.x) * t + rightX * lat,
        y: seg.y + (seg.ey - seg.y) * t,
        z: seg.z + (seg.ez - seg.z) * t + rightZ * lat,
        dirX: dirX,
        dirZ: dirZ,
        rightX: rightX,
        rightZ: rightZ,
        yaw: yaw,
        slope: seg.slope + (nxt.slope - seg.slope) * t,
        width: seg.width + (nxt.width - seg.width) * t,
        curve: seg.curve + (nxt.curve - seg.curve) * t,
        zone: seg.zone,
        segIndex: i
      };
    }

    /* ---- track 对象 ---- */
    var track = {
      id: 'hr-track-' + seed.toString(36) + '-' + Math.round(lengthKm * 100),
      name: name,
      seed: seed,
      length: totalLen,
      count: M,
      segments: segs,
      startS: 0,
      checkpoints: buildCheckpoints(totalLen),
      racingLine: racingLine,
      gridSlots: buildGridSlots(totalLen, 0),
      scenery: [],
      minimap: null,
      segAt: segAt,
      sample: sample,
      widthAt: widthAt,
      curveAt: curveAt,
      racingLineAt: racingLineAt,
      zoneAt: zoneAt
    };

    track.minimap = buildMinimap(track);
    track.scenery = buildScenery(track, seed, lengthKm, zinfo, zoneRes);
    return track;
  }

  /* ==========================================================================
   * 11. 发车格 / 检查点
   * ========================================================================== */
  function buildGridSlots(trackLen, startS) {
    var slots = [];
    for (var i = 0; i < 8; i++) {
      /* 杆位在起跑线前 6m，之后每 7m 一辆（wrap 到 [0,length)）；
         横向 ±(2.2~2.6) 交替：相邻两车横向距离 >= 4.4m（契约 >= 2.6） */
      var s = wrapS(startS - 6 - i * 7, trackLen);
      var lateral = (i % 2 === 0 ? 1 : -1) * (2.2 + (i % 3) * 0.2);
      slots.push({ s: s, lateral: lateral });
    }
    return slots;
  }

  function buildCheckpoints(trackLen) {
    /* 约 1/3、2/3、末段；严格在 (0,length) 内且递增 */
    return [trackLen * 0.33, trackLen * 0.66, trackLen * 0.85];
  }

  /* ==========================================================================
   * 12. 小地图（每 ~25m 一个中心线采样点）
   * ========================================================================== */
  function buildMinimap(track) {
    var TL = track.length;
    var n = clamp(Math.round(TL / 25), 32, 640);
    var points = new Array(n);
    var checkpoints = [];
    var i;

    var minX = Infinity;
    var maxX = -Infinity;
    var minZ = Infinity;
    var maxZ = -Infinity;

    function absorb(x, z) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    for (i = 0; i < n; i++) {
      var p = track.sample(TL * i / n, 0);
      points[i] = { x: p.x, z: p.z };
      absorb(p.x, p.z);
    }
    for (i = 0; i < track.checkpoints.length; i++) {
      var cp = track.sample(track.checkpoints[i], 0);
      checkpoints.push({ x: cp.x, z: cp.z });
      absorb(cp.x, cp.z);
    }
    var sp = track.sample(track.startS, 0);
    absorb(sp.x, sp.z);

    if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minZ) || !isFinite(maxZ)) {
      minX = -1; maxX = 1; minZ = -1; maxZ = 1;
    }

    return {
      points: points,
      bounds: { minX: minX, maxX: maxX, minZ: minZ, maxZ: maxZ },
      checkpoints: checkpoints,
      start: { x: sp.x, z: sp.z }
    };
  }

  /* ==========================================================================
   * 13. 沿途装饰 scenery
   *   { seg, side, off, kind, scale, variant }
   *   side = -1 左 / +1 右；off = 有符号横向坐标（+右侧），|off| >= width/2 + 2.4
   *   渲染器可直接 track.sample(segments[seg].s, off) 得到世界坐标。
   * ========================================================================== */
  function buildScenery(track, seed, lengthKm, zinfo, zoneRes) {
    var U = getUtil();
    var rnd = U.rng(U.hashSeed(
      'hr-scenery:' + seed + ':' + lengthKm + ':' + zinfo.zones.join(',')
    ));
    var list = [];
    var TL = track.length;
    var startHalf = (zoneRes && zoneRes.startHalf > 0) ? zoneRes.startHalf : TL * 0.1;
    var step = clamp(startHalf * 0.40, 8, 60);
    var k;

    /* 起跑区固定氛围：8 个，两侧成对，覆盖 grandstand/tent/flag/billboard */
    for (k = 0; k < START_SCENERY_KINDS.length; k++) {
      var row = k >> 1;                              // 0..3
      var side = (k % 2 === 0) ? 1 : -1;
      var s = wrapS((row - 1.5) * step, TL);         // 起跑线前后各两排
      var w = track.widthAt(s);
      var kind0 = START_SCENERY_KINDS[k];
      list.push({
        seg: track.segAt(s),
        side: side,
        off: side * (w * 0.5 + 4.5 + row * 1.6 + rnd() * 1.2),
        kind: kind0,
        scale: (kind0 === 'grandstand') ? (1.4 + rnd() * 0.6) : (0.9 + rnd() * 0.5),
        variant: k % 4
      });
    }

    /* 沿途装饰：60~180 总数（这里 78~172，含起跑区 8 个），按 zone 选 kind */
    var total = clamp(Math.round(TL / 32), 78, 172);
    var generic = total - START_SCENERY_KINDS.length;
    for (k = 0; k < generic; k++) {
      /* 分层均匀分布 + 抖动，避免等距呆板 */
      var s2 = wrapS((k + 0.10 + rnd() * 0.80) * TL / generic, TL);
      var zone = track.zoneAt(s2);
      var kinds = ZONE_KINDS[zone] || ZONE_KINDS.coast;
      var kind = kinds[Math.floor(rnd() * kinds.length) % kinds.length];
      var side2 = rnd() < 0.5 ? -1 : 1;
      var w2 = track.widthAt(s2);
      list.push({
        seg: track.segAt(s2),
        side: side2,
        off: side2 * (w2 * 0.5 + 2.4 + rnd() * 30),  // |off| >= width/2 + 2.4
        kind: kind,
        scale: 0.70 + rnd() * 1.10,
        variant: Math.floor(rnd() * 4) % 4
      });
    }
    return list;
  }

  /* ==========================================================================
   * 14. 对外 API
   * ========================================================================== */
  return {
    generate: generate,
    clearCache: clearCache
  };
})();
