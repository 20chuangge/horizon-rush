/**
 * Horizon Rush · 极速地平线
 * car.js —— 车辆物理（HR.Physics，契约见 ARCHITECTURE.md §3）
 *
 * 约定：
 *   - 经典脚本，只定义 HR.Physics，加载时不产生副作用；不依赖 DOM。
 *   - 单位：距离 m、速度 m/s、角度 rad、时间 s；stats.topSpeed 是 km/h 展示值。
 *   - car 中 game 维护的字段（dist/lap/place/...）本文件只创建占位，不覆盖。
 */
window.HR = window.HR || {};

HR.Physics = (function () {
  'use strict';

  var U = HR.Util;

  /* ===================== 手感调参区 ===================== */
  var DT_MAX = 0.05;          // step 内部 dt 上限（s）
  var WALL_EXTRA = 6;         // 软墙：路面外允许的额外横向宽度（m）
  var DEFAULT_WIDTH = 16;     // track 缺数据时的兜底路面全宽（m）
  var LAT_MAX = 7.0;          // 横向移动速度上限（m/s，街机化限制）
  var LAT_K = 0.10;           // 横向基速系数（契约 §3.3 的 k≈0.06~0.10）
  var CURVE_K = 0.02;         // 离心外甩系数（契约给 0.0016 量纲过小、完全不可感知；取 0.02 轻微外甩）
  var NITRO_TOP = 1.08;       // 氮气极速倍数（契约 +8%）
  var NITRO_THRUST = 1.35;    // 氮气推力倍数
  /* 引擎在极速处仍剩 1-0.90=10% 推力；为了让实际极速落在 stats.topSpeed 的 ~98%，
   * 风阻二次项系数按 “全油门在 0.98*vTop 处推力=阻力” 反推归一，
   * 而不是直接用固定 0.0016*v^2（那会让所有车极速只有 ~200km/h，与数据表矛盾）。 */
  var ENGINE_TOP_RESIDUAL = 0.90;
  var DRAG_BALANCE = 0.13564; // 1 - 0.90 * 0.98^2
  var DRAG_EQ_RATIO2 = 0.9604; // 0.98^2
  var DRAG_K_MIN = 0.00002;   // 风阻系数下限（极慢车防止负值）

  /* ===================== 小工具 ===================== */
  function finiteOr(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  function clamp(v, lo, hi) {
    if (typeof v !== 'number' || v !== v) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function statOf(spec, key, fallback) {
    var stats = spec && spec.stats;
    var v = stats ? stats[key] : undefined;
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  /* 每次 step 复用的路面信息 scratch，避免热路径分配对象 */
  var _road = { width: DEFAULT_WIDTH, curve: 0, slope: 0, segIndex: -1 };

  function roadInfo(track, s, out) {
    out.width = DEFAULT_WIDTH;
    out.curve = 0;
    out.slope = 0;
    out.segIndex = -1;
    if (!track) return out;

    var segs = track.segments;
    var count = (segs && segs.length) ? segs.length : 0;
    var idx = -1;
    if (count && typeof track.segAt === 'function') {
      var i = track.segAt(s);
      if (typeof i === 'number' && isFinite(i)) idx = Math.floor(i) % count;
      if (idx < 0) idx += count;
    }
    if (idx >= 0) {
      var seg = segs[idx];
      if (seg) {
        out.width = clamp(finiteOr(seg.width, DEFAULT_WIDTH), 6, 40);
        out.curve = clamp(finiteOr(seg.curve, 0), -0.2, 0.2);
        out.slope = clamp(finiteOr(seg.slope, 0), -0.6, 0.6);
        out.segIndex = idx;
        return out;
      }
    }
    /* 退化路径：segment 不可用时用 track 的标量方法（兜底，非热路径） */
    if (typeof track.widthAt === 'function') {
      out.width = clamp(finiteOr(track.widthAt(s), DEFAULT_WIDTH), 6, 40);
    }
    if (typeof track.curveAt === 'function') {
      out.curve = clamp(finiteOr(track.curveAt(s), 0), -0.2, 0.2);
    }
    if (typeof track.sample === 'function') {
      var smp = track.sample(s, 0);
      if (smp) {
        out.slope = clamp(finiteOr(smp.slope, 0), -0.6, 0.6);
        if (typeof track.widthAt !== 'function') {
          out.width = clamp(finiteOr(smp.width, DEFAULT_WIDTH), 6, 40);
        }
        if (typeof track.curveAt !== 'function') {
          out.curve = clamp(finiteOr(smp.curve, 0), -0.2, 0.2);
        }
      }
    }
    return out;
  }

  function widthAtS(track, s) {
    if (!track) return DEFAULT_WIDTH;
    if (typeof track.widthAt === 'function') {
      return clamp(finiteOr(track.widthAt(s), DEFAULT_WIDTH), 6, 40);
    }
    var segs = track.segments;
    if (segs && segs.length && typeof track.segAt === 'function') {
      var i = track.segAt(s);
      if (typeof i === 'number' && isFinite(i)) {
        var idx = Math.floor(i) % segs.length;
        if (idx < 0) idx += segs.length;
        var seg = segs[idx];
        if (seg) return clamp(finiteOr(seg.width, DEFAULT_WIDTH), 6, 40);
      }
    }
    return DEFAULT_WIDTH;
  }

  function lineAt(track, s) {
    if (track && typeof track.racingLineAt === 'function') {
      return finiteOr(track.racingLineAt(s), 0);
    }
    return 0;
  }

  /* ===================== 车辆创建 ===================== */
  function makeCar(spec, opts) {
    spec = spec || (HR.CARS && HR.CARS[0]) || {};
    opts = opts || {};

    var s = finiteOr(opts.s, 0);
    var x = finiteOr(opts.x, 0);
    var v = finiteOr(opts.v, 0);
    if (v < 0) v = 0;

    return {
      id: (opts.id != null) ? opts.id : (spec.id || 'car'),
      spec: spec,
      name: (opts.name != null) ? opts.name : (spec.name || spec.id || 'Car'),

      /* ------- 契约 §3.2 物理字段 ------- */
      s: s,
      x: x,
      v: v,
      steer: 0,
      throttle: 0,
      brakeInput: 0,
      handbrake: 0,
      nitroOn: false,
      driftAngle: 0,
      gear: 1,
      rpm: 1500,
      rpmMax: 9000,
      boost: 1,
      boosting: false,
      offroad: false,
      drifting: false,
      driftScore: 0,
      driftCombo: 1,
      bump: 0,
      aiStuckTime: 0,
      control: 'ai',
      ai: null,

      /* ------- game 维护字段的占位（physics 不覆盖） ------- */
      dist: 0,
      lap: 1,
      lapStartTime: 0,
      lastLap: 0,
      bestLap: 0,
      totalTime: 0,
      finished: false,
      finishTime: 0,
      place: 0
    };
  }

  /* ===================== 物理步进 ===================== */
  function step(car, input, track, dt, time) {
    if (!car || typeof car !== 'object') return car;

    dt = clamp(finiteOr(dt, 0), 0, DT_MAX);
    if (dt <= 0) return car;
    time = finiteOr(time, 0);

    var spec = car.spec || {};
    var gearCount = Math.max(1, Math.floor(finiteOr(spec.gearCount, 6)));
    var topKmh = clamp(statOf(spec, 'topSpeed', 260), 120, 500);
    var accel = clamp(statOf(spec, 'accel', 4), 0.9, 20);
    var handling = clamp(statOf(spec, 'handling', 0.75), 0, 1);
    var braking = clamp(statOf(spec, 'braking', 0.75), 0, 1);
    var nitroStat = clamp(statOf(spec, 'nitro', 0.7), 0, 1);
    var vTop = topKmh / 3.6;

    var length = 0;
    if (track && typeof track.length === 'number' && isFinite(track.length) && track.length > 0) {
      length = track.length;
    }

    /* ---------------- 输入归一化 ---------------- */
    var inThrottle = clamp(input ? input.throttle : 0, 0, 1);
    var inBrake = clamp(input ? input.brake : 0, 0, 1);
    var steerInput = clamp(input ? input.steer : 0, -1, 1);
    var handbrake = (input && input.handbrake) ? 1 : 0;
    var nitroReq = !!(input && input.nitro);

    /* ---------------- 取出车辆状态 ---------------- */
    var s = finiteOr(car.s, 0);
    if (length > 0) s = U.wrap(s, length);
    var x = finiteOr(car.x, 0);
    var v = Math.max(0, finiteOr(car.v, 0));

    var road = roadInfo(track, s, _road);
    var width = road.width;
    var curve = road.curve;
    var slope = road.slope;
    var halfW = width * 0.5;

    /* ---------------- 方向盘平滑（键盘数字输入柔化，~0.06s） ---------------- */
    var steerSmooth = U.damp(clamp(finiteOr(car.steer, 0), -1, 1), steerInput, 16, dt);
    steerSmooth = clamp(steerSmooth, -1, 1);

    /* ---------------- 漂移判定 ---------------- */
    var wantDrift = (handbrake === 1) || (Math.abs(steerSmooth) > 0.6 && v > 20);
    var drifting = wantDrift && v > 6;
    var driftTarget = drifting ? clamp(steerSmooth * 0.52, -0.6, 0.6) : 0;
    var driftAngle = U.damp(clamp(finiteOr(car.driftAngle, 0), -0.6, 0.6),
      driftTarget, drifting ? 7.5 : 5.5, dt);
    driftAngle = clamp(driftAngle, -0.6, 0.6);
    if (Math.abs(driftAngle) < 0.002) driftAngle = 0;

    /* ---------------- 氮气槽 ---------------- */
    var boost = clamp(finiteOr(car.boost, 0.6), 0, 1);
    var boosting = nitroReq && boost > 0.01 && v > 1;
    if (boosting) {
      var drainRate = 0.30 / (0.8 + 0.4 * nitroStat); // ≈0.25~0.30 /s
      boost -= drainRate * dt;
      if (boost <= 0) {
        boost = 0;
        boosting = false; // boost 耗尽自动停喷
      }
    } else if (!nitroReq) {
      /* 只在“没有按住氮气”时回充：否则空槽按住 Shift 会按 0.05/s 攒到 0.01
       * 又被瞬间抽干，形成 ~0.2s 一次的 boosting 闪烁（渲染/音效会抖）。 */
      var rechargeRate = 0.05 * (0.9 + 0.2 * nitroStat); // ≈0.05 /s
      if (drifting) rechargeRate += 0.07;                // 漂移额外回充
      boost += rechargeRate * dt;
      if (boost > 1) boost = 1;
    }

    /* ---------------- 越野状态（0.35m 滞回，避免路缘来回抖动） ---------------- */
    var wasOffroad = !!car.offroad;
    var offEdge = wasOffroad ? halfW - 0.35 : halfW;
    var offroad = halfW > 0.5 && Math.abs(x) > offEdge;

    /* ---------------- 纵向速度模型 ---------------- */
    var aMax = 27.8 / accel;                 // 0-100 平均加速度 m/s²
    var vMaxDrive = vTop * (boosting ? NITRO_TOP : 1);
    var vOffCap = vTop * 0.42;               // 越野限速 ≈ 极速 42%
    if (offroad) vMaxDrive = Math.min(vMaxDrive, vOffCap);

    var ratio = v / Math.max(vMaxDrive, 1);
    var engineFactor = 1 - ENGINE_TOP_RESIDUAL * ratio * ratio;
    if (engineFactor < 0) engineFactor = 0;
    var throttleEffective = inThrottle * (1 - inBrake * 0.85);
    if (throttleEffective < 0) throttleEffective = 0;
    var aEng = aMax * throttleEffective * engineFactor;
    if (boosting) aEng *= NITRO_THRUST;

    /* 风阻/滚阻：系数按极速归一，保证全油门极速 ≈ 0.98*stats.topSpeed */
    var dragK = (DRAG_BALANCE * aMax - 0.4) / (vTop * vTop * DRAG_EQ_RATIO2);
    if (!(dragK > DRAG_K_MIN)) dragK = DRAG_K_MIN;
    var aDrag = 0.4 + dragK * v * v;

    /* 松油滑行时的发动机制动（不与刹车叠加） */
    var aCoast = (1 - inThrottle) * (1 - inBrake) * (1.2 + 0.00045 * v * v);

    /* 刹车：契约 §3.3 的 9 + 9*braking */
    var aBrake = (9 + 9 * braking) * inBrake;

    /* 手刹：漂移中轻降速，直线手刹大幅降速 */
    var aHand = handbrake ? (drifting ? 2.8 : 6.5) : 0;

    /* 漂移自身阻力（"v 略降"） */
    var aDrift = drifting ? Math.abs(driftAngle) * 2.2 : 0;

    /* 越野额外阻力 + 超速惩罚（软限速，比硬 clamp 更平滑） */
    var aOff = 0;
    if (offroad) {
      aOff = 1.1;
      if (v > vOffCap) aOff += (v - vOffCap) * 0.35; // 超速惩罚
      if (aOff > 12) aOff = 12;                      // 上限 ~1.2g，避免入草瞬间被“急刹”
    }

    /* 坡度：上坡减速、下坡加速（街机化，取重力分量一半） */
    var aSlope = 9.81 * slope * 0.55;

    var netA = aEng - aDrag - aCoast - aBrake - aHand - aDrift - aOff - aSlope;
    v += netA * dt;
    if (v < 0) v = 0;
    var vHardCap = vTop * 1.15;
    if (v > vHardCap) v = vHardCap;
    if (v < 0.03 && inThrottle < 0.02 && !boosting) v = 0;

    /* ---------------- 横向：转向 + 离心 + 漂移侧滑 ---------------- */
    /* 低速灵敏、高速迟钝；handling 越高横向响应越大 */
    var steerGain = (0.9 + 1.6 * handling) * (v / (v + 18)) * v * LAT_K;
    steerGain /= (1 + v * 0.006);
    var latSpeed = steerSmooth * steerGain;
    if (drifting) latSpeed *= 1.5;                          // 漂移时横向响应更大
    latSpeed += Math.sin(driftAngle) * v * 0.08;            // 漂移侧滑
    /* 离心力：右弯 curve>0，不转向时向 -x（外侧）轻甩 */
    latSpeed -= curve * v * v * CURVE_K * (1 - 0.35 * handling);
    if (offroad) latSpeed *= 0.8;                           // 草地抓地差
    latSpeed = clamp(latSpeed, -LAT_MAX, LAT_MAX);
    x += latSpeed * dt;

    /* ---------------- 软墙：|x| 不超过 width/2 + 6 ---------------- */
    var wallX = halfW + WALL_EXTRA;
    var bumpNow = clamp(finiteOr(car.bump, 0), 0, 1);
    if (x > wallX || x < -wallX) {
      var over = Math.abs(x) - wallX;
      x = x > 0 ? wallX : -wallX;
      if (over > 0.3) {
        v *= 0.8;                              // 硬撞：强制回拉 + 大幅降速
        bumpNow = Math.max(bumpNow, 0.55);
      } else {
        v -= 4.0 * dt;                         // 蹭墙：持续摩擦减速
        if (v < 0) v = 0;
        bumpNow = Math.max(bumpNow, 0.18);
      }
    }

    /* ---------------- 越野抖动 + bump 衰减 ---------------- */
    var offroadEnd = halfW > 0.5 && Math.abs(x) > offEdge;
    if (offroadEnd) {
      var jitter = 0.10 + 0.16 * Math.abs(Math.sin(s * 2.7 + time * 21.0)) +
        0.12 * clamp(v / Math.max(vTop, 1), 0, 1);
      if (jitter > bumpNow) bumpNow = jitter;
    }
    bumpNow *= Math.exp(-6 * dt);
    if (bumpNow < 0.002) bumpNow = 0;

    /* ---------------- 沿路推进 + wrap ---------------- */
    s += v * dt;
    if (length > 0) s = U.wrap(s, length);

    /* ---------------- 漂移分 / 连击（HUD 展示用，不惩罚物理） ---------------- */
    var driftScore = Math.max(0, finiteOr(car.driftScore, 0));
    var driftCombo = clamp(finiteOr(car.driftCombo, 1), 1, 5);
    if (drifting) {
      driftScore += Math.abs(driftAngle) * v * dt;
      driftCombo = Math.min(5, driftCombo + dt * 0.9);
    } else {
      driftCombo = U.damp(driftCombo, 1, 2.5, dt);
    }

    /* ---------------- 挡位 / 转速（连续平滑，供 HUD 与音频） ---------------- */
    var vRatio = clamp(v / Math.max(vTop, 1), 0, 1.12);
    var gear = 1;
    var rpmTarget = 1500;
    if (gearCount <= 1) {
      /* EV 单速：rpm 随车速线性（1000~8300） */
      gear = 1;
      rpmTarget = 1000 + 7300 * clamp(vRatio, 0, 1);
    } else {
      var gFloat = clamp(vRatio, 0, 0.9999) * gearCount;
      gear = Math.floor(gFloat) + 1;
      if (gear > gearCount) gear = gearCount;
      if (gear < 1) gear = 1;
      var frac = gFloat - Math.floor(gFloat);
      rpmTarget = 1500 + frac * 6800; // 每档 1500~8300，换挡回落
      if (v < 0.5) rpmTarget = 1500;
    }
    var rpmSmooth = U.damp(clamp(finiteOr(car.rpm, 1500), 800, 9000),
      clamp(rpmTarget, 800, 9000), 15, dt);

    /* ---------------- 写回 car（不触碰 game 维护字段） ---------------- */
    car.s = s;
    car.x = x;
    car.v = v;
    car.steer = steerSmooth;
    car.throttle = inThrottle;
    car.brakeInput = inBrake;
    car.handbrake = handbrake;
    car.nitroOn = nitroReq;
    car.driftAngle = driftAngle;
    car.gear = gear;
    car.rpm = rpmSmooth;
    car.boost = boost;
    car.boosting = boosting;
    car.offroad = offroadEnd;
    car.drifting = drifting;
    car.driftScore = driftScore;
    car.driftCombo = driftCombo;
    car.bump = bumpNow;

    /* ---------------- NaN / Infinity 兜底 ---------------- */
    car.s = finiteOr(car.s, 0);
    if (length > 0) car.s = U.wrap(car.s, length);
    car.x = finiteOr(car.x, 0);
    car.v = clamp(finiteOr(car.v, 0), 0, vHardCap);
    car.steer = clamp(finiteOr(car.steer, 0), -1, 1);
    car.driftAngle = clamp(finiteOr(car.driftAngle, 0), -0.6, 0.6);
    car.gear = Math.round(clamp(finiteOr(car.gear, 1), 1, gearCount));
    car.rpm = clamp(finiteOr(car.rpm, 1500), 800, 9000);
    car.boost = clamp(finiteOr(car.boost, 0), 0, 1);
    car.bump = clamp(finiteOr(car.bump, 0), 0, 1);
    car.driftScore = Math.max(0, finiteOr(car.driftScore, 0));
    car.driftCombo = clamp(finiteOr(car.driftCombo, 1), 1, 5);
    return car;
  }

  /* ===================== 车车碰撞（契约 §3.3） ===================== */
  function resolveCollisions(cars, track) {
    if (!cars || typeof cars.length !== 'number' || cars.length < 2) return;
    var n = cars.length;
    var length = 0;
    if (track && typeof track.length === 'number' && isFinite(track.length) && track.length > 0) {
      length = track.length;
    }

    for (var i = 0; i < n; i++) {
      var a = cars[i];
      if (!a) continue;
      for (var j = i + 1; j < n; j++) {
        var b = cars[j];
        if (!b) continue;

        var sa = finiteOr(a.s, 0);
        var sb = finiteOr(b.s, 0);
        var ds = sb - sa;
        if (length > 0) ds = U.wrap(ds + length * 0.5, length) - length * 0.5;

        var specA = a.spec || {};
        var specB = b.spec || {};
        var lenA = clamp(finiteOr(specA.length, 4.6), 2, 8);
        var lenB = clamp(finiteOr(specB.length, 4.6), 2, 8);
        var longHit = (lenA + lenB) * 0.5 + 0.5;
        if (Math.abs(ds) >= longHit) continue;

        var wa = clamp(finiteOr(specA.width, 1.98), 1.2, 3);
        var wb = clamp(finiteOr(specB.width, 1.98), 1.2, 3);
        var latHit = (wa + wb) * 0.5;

        var xa = finiteOr(a.x, 0);
        var xb = finiteOr(b.x, 0);
        var dx = xb - xa;
        var adx = dx < 0 ? -dx : dx;
        if (adx >= latHit) continue;

        var dir = dx >= 0 ? 1 : -1;
        var overlap = latHit - adx;
        if (!(overlap > 0)) continue;

        var halfA = widthAtS(track, sa) * 0.5 + WALL_EXTRA;
        var halfB = widthAtS(track, sb) * 0.5 + WALL_EXTRA;

        var nxA = xa - dir * (overlap * 0.5 + 0.02);
        var nxB = xb + dir * (overlap * 0.5 + 0.02);
        nxA = finiteOr(nxA, 0);
        nxB = finiteOr(nxB, 0);
        nxA = clamp(nxA, -halfA, halfA);
        nxB = clamp(nxB, -halfB, halfB);

        /* 一侧被软墙顶住时，把剩余分离量让给另一台车，避免“叠车” */
        var remain = latHit - Math.abs(nxB - nxA);
        if (remain > 0.01) {
          if (Math.abs(nxA) >= halfA - 0.02) {
            nxB = clamp(nxB + dir * remain, -halfB, halfB);
          } else if (Math.abs(nxB) >= halfB - 0.02) {
            nxA = clamp(nxA - dir * remain, -halfA, halfA);
          } else {
            nxA = clamp(nxA - dir * remain * 0.5, -halfA, halfA);
            nxB = clamp(nxB + dir * remain * 0.5, -halfB, halfB);
          }
        }

        a.x = finiteOr(nxA, 0);
        b.x = finiteOr(nxB, 0);

        /* 对称减速 + 撞击抖动 */
        a.v = Math.max(0, finiteOr(a.v, 0) * 0.985);
        b.v = Math.max(0, finiteOr(b.v, 0) * 0.985);
        a.bump = Math.max(clamp(finiteOr(a.bump, 0), 0, 1), 0.6);
        b.bump = Math.max(clamp(finiteOr(b.bump, 0), 0, 1), 0.6);
      }
    }
  }

  /* ===================== 复位到赛道 ===================== */
  function resetToTrack(car, track) {
    if (!car) return car;
    var length = 0;
    if (track && typeof track.length === 'number' && isFinite(track.length) && track.length > 0) {
      length = track.length;
    }
    var s = finiteOr(car.s, 0);
    if (length > 0) s = U.wrap(s, length);

    var halfW = widthAtS(track, s) * 0.5;
    var target = lineAt(track, s);
    var safe = Math.max(1, halfW - 1.5);
    target = clamp(target, -safe, safe);

    car.s = s;
    car.x = target;
    car.v = Math.max(0, finiteOr(car.v, 0)) * 0.3;
    car.driftAngle = 0;
    car.drifting = false;
    car.offroad = false;
    car.steer = 0;
    car.throttle = 0;
    car.brakeInput = 0;
    car.handbrake = 0;
    car.boosting = false;
    car.bump = 0;
    car.gear = 1;
    car.rpm = 1500;
    car.aiStuckTime = 0;
    return car;
  }

  /* ===================== 速度换算 ===================== */
  function kmh(v) {
    return Math.max(0, finiteOr(v, 0)) * 3.6;
  }

  return {
    makeCar: makeCar,
    step: step,
    resolveCollisions: resolveCollisions,
    resetToTrack: resetToTrack,
    kmh: kmh,
    /* 手感常量对外暴露（ai.js 用同一套参数做转向/离心补偿，避免两处硬编码失配） */
    LAT_K: LAT_K,
    CURVE_K: CURVE_K
  };
})();
