/**
 * Horizon Rush · 极速地平线
 * ai.js —— AI 车手（HR.AI，契约见 ARCHITECTURE.md §4）
 *
 * 设计目标：每辆车都能接 AI 比赛，连续跑完整圈、不撞墙不长期越野，
 * 且不同性格/技术的车手跑出不同风格与圈速。
 *
 * 约束：
 *   - 经典脚本，只定义 HR.AI.createDriver，加载时无副作用；不依赖 DOM。
 *   - 只读 car / track / raceCtx；唯一允许写 car 的字段是 aiStuckTime（供 game 救援）。
 *   - 确定性：不使用 Math.random / Date / performance，所有随机来自 HR.Util.rng(seed)。
 *   - 性能：8 车 × 120Hz。think 内不创建数组/对象，输入对象与扫描 scratch 每 driver 复用。
 */
window.HR = window.HR || {};

HR.AI = (function () {
  'use strict';

  var U = HR.Util;

  var DEFAULT_WIDTH = 16;
  /* 契约允许的 5 个风格标签 */
  var STYLE_TAGS = { '激进': 1, '稳健': 1, '精准': 1, '凶狠': 1, '老练': 1 };

  /* 与 car.js 保持一致的横向响应/离心系数（从 HR.Physics 导出的常量读取，
   * 避免两处硬编码失配；car.js 在本文件之前加载）。 */
  var PHYS = (typeof HR !== 'undefined' && HR && HR.Physics) ? HR.Physics : null;
  var LAT_K = (PHYS && typeof PHYS.LAT_K === 'number') ? PHYS.LAT_K : 0.10;
  var CURVE_K = (PHYS && typeof PHYS.CURVE_K === 'number') ? PHYS.CURVE_K : 0.02;

  /* ===================== 小工具 ===================== */
  function finiteOr(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  function clamp(v, lo, hi) {
    if (typeof v !== 'number' || v !== v) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
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

  function curveAtS(track, s) {
    if (!track) return 0;
    if (typeof track.curveAt === 'function') return finiteOr(track.curveAt(s), 0);
    var segs = track.segments;
    if (segs && segs.length && typeof track.segAt === 'function') {
      var i = track.segAt(s);
      if (typeof i === 'number' && isFinite(i)) {
        var idx = Math.floor(i) % segs.length;
        if (idx < 0) idx += segs.length;
        var seg = segs[idx];
        if (seg) return finiteOr(seg.curve, 0);
      }
    }
    return 0;
  }

  function racingLineAt(track, s, length) {
    if (!track || typeof track.racingLineAt !== 'function') return 0;
    var ss = (length > 0) ? U.wrap(s, length) : s;
    return finiteOr(track.racingLineAt(ss), 0);
  }

  function pickTag(pers, opts, aggression, skill, consistency) {
    var raw = (opts && opts.tag) || (pers && pers.tag) || '';
    if (STYLE_TAGS[raw]) return raw;
    if (aggression > 0.85) return '凶狠';
    if (aggression > 0.72) return '激进';
    if (skill > 0.85 && consistency > 0.85) return '精准';
    if (consistency > 0.85) return '稳健';
    return '老练';
  }

  /* ===================== 速度规划 =====================
   * 从当前 s 起向前扫描 30 + v*2.2 m：
   *   每个采样段过弯极限 gripV = sqrt(latAccel / |curve|)，
   *   要在距离 d 之后降到 gripV，当前速度最多 sqrt(gripV^2 + 2*brakeDecel*d)。
   * 取全部约束的最小值，天然包含“前方连续 2 个弯”的提前刹车。
   * 结果写进 st.vTarget / st.maxCurve / st.curveNow，避免返回对象。
   */
  function scanSpeed(p, st, track, s, v, length) {
    var latAccel = p.latAccel;
    var speedBias = 1 + 0.06 * (p.skill - 0.5); // 新手 -3%，传奇 +3% 上限
    var brakeD = p.brakeDecel;
    var scanDist = 30 + v * 2.2;
    if (scanDist < 34) scanDist = 34;
    if (scanDist > 280) scanDist = 280;

    /* 速度上限取 stats 极速的 1.02 倍：物理实际极速约 0.98*stats，
     * 这样直道上 AI 永远处于 “v < vTarget*0.97 → throttle=1” 区间，不会在极速附近
     * 因为 0.97/1.03 阈值来回滑行/补油而抖速。 */
    var vTopTarget = p.topSpeed * 1.02;
    var best = vTopTarget;
    var maxCurveNear = 0;
    var curveNow = 0;
    var d = 0;

    var segs = track && track.segments;
    var count = (segs && segs.length) ? segs.length : 0;

    if (count) {
      var idx = -1;
      if (typeof track.segAt === 'function') {
        var si = track.segAt(s);
        if (typeof si === 'number' && isFinite(si)) idx = Math.floor(si);
      }
      if (idx < 0) idx = 0;
      if (idx >= count) idx = count - 1;

      var guard = 0;
      var guardMax = count < 130 ? count : 130;
      while (d < scanDist && guard < guardMax) {
        guard++;
        var seg = segs[idx];
        if (!seg) break;
        var segLen = finiteOr(seg.len, 3);
        if (!(segLen > 0.05)) segLen = 3;
        var rawCurve = finiteOr(seg.curve, 0);
        var c = rawCurve < 0 ? -rawCurve : rawCurve;
        if (guard === 1) curveNow = rawCurve;
        if (d < 80 && c > maxCurveNear) maxCurveNear = c; // 80m 内最大曲率（氮气判定用直道）
        if (c > 0.0004) {
          var gripV = Math.sqrt(latAccel / c) * speedBias;
          var req = Math.sqrt(gripV * gripV + 2 * brakeD * d);
          if (req < best) best = req;
        }
        d += segLen;
        idx++;
        if (idx >= count) idx = 0;
      }
    } else if (track && typeof track.curveAt === 'function') {
      /* 退化路径：track 没有 segments 时按距离采样 curveAt */
      var samples = 18;
      for (var k = 0; k < samples; k++) {
        var dd = scanDist * k / samples;
        var ss = (length > 0) ? U.wrap(s + dd, length) : (s + dd);
        var craw = finiteOr(track.curveAt(ss), 0);
        var cc = craw < 0 ? -craw : craw;
        if (k === 0) curveNow = craw;
        if (dd < 80 && cc > maxCurveNear) maxCurveNear = cc;
        if (cc > 0.0004) {
          var grip2 = Math.sqrt(latAccel / cc) * speedBias;
          var req2 = Math.sqrt(grip2 * grip2 + 2 * brakeD * dd);
          if (req2 < best) best = req2;
        }
      }
    }

    var vT = best;
    if (vT > vTopTarget) vT = vTopTarget;
    if (vT < 6) vT = 6;

    st.vTarget = vT;
    st.maxCurve = maxCurveNear;
    st.curveNow = curveNow;
    return vT;
  }

  /* ===================== driver 创建 ===================== */
  function createDriver(car, track, opts) {
    opts = opts || {};
    var spec = (car && car.spec) || (HR.CARS && HR.CARS[0]) || {};
    var stats = spec.stats || {};
    var pers = opts.personality || spec.ai || {};

    var skill = clamp(finiteOr(opts.skill, 0.72), 0, 1);
    var persAggr = clamp(finiteOr(pers.aggression, 0.65), 0, 1);
    var diffAggr = finiteOr(opts.aggression, -1);
    var aggression = diffAggr >= 0
      ? clamp(diffAggr * 0.55 + persAggr * 0.45, 0, 1) // 难度攻击性 + 性格攻击性
      : persAggr;
    var cornering = clamp(finiteOr(pers.cornering, 0.8), 0, 1);
    var consistency = clamp(finiteOr(pers.consistency, 0.8), 0, 1);
    var brakingP = clamp(finiteOr(pers.braking, 0.8), 0, 1);
    var handling = clamp(finiteOr(stats.handling, 0.75), 0, 1);
    var topSpeedMs = clamp(finiteOr(stats.topSpeed, 260), 120, 500) / 3.6;
    var physBrake = 9 + 9 * clamp(finiteOr(stats.braking, 0.75), 0, 1);

    /* 过弯规划用横向加速度极限（决定 AI 的弯速上限）。
     * 注意：这是 AI 的“规划值”，不是物理约束——games 的街机物理对横向更宽容，
     * 因此这里给得越高 AI 越敢开快；兼顾稳定性取 10 + 12*skill*cornering
     * （新手约 15.6、职业约 17.3、传奇约 19.0 m/s²，对应 50m 弯约 100~107km/h）。 */
    var latAccel = 10.0 + 12.0 * skill * cornering; // 计划用横向加速度极限 m/s²
    /* 规划用刹车减速度：比物理实际略保守（物理是 9+9*braking） */
    var brakeDecel = physBrake * (0.74 + 0.14 * skill + 0.08 * brakingP);
    /* 反应延迟 0.03~0.18s（低技术 + 高一致性略慢） */
    var reaction = 0.03 + 0.15 * (1 - skill) * (0.5 + 0.5 * consistency);
    /* 走神失误概率 0~1.5%/s，一致性越低越高 */
    var mistakeRate = clamp(0.015 * (1.15 - consistency), 0.002, 0.015);
    /* 走线个性：技术差/一致性差 → 偏外线（远离弯心）；攻击性强 → 偏内线（切弯心） */
    var outerBias = (1 - cornering) * (0.9 + 0.5 * (1 - consistency));
    var insideCut = aggression * 0.25;

    var seedBase = (opts.seed == null) ? 'hr-ai' : String(opts.seed);
    var idStr = String((car && car.id) || spec.id || 'car');
    var seed = U.hashSeed(seedBase + '|' + idStr + '|' + String(spec.id || ''));

    var tag = pickTag(pers, opts, aggression, skill, consistency);

    /* 每 driver 一份常量参数（创建时算一次） */
    var p = {
      skill: skill,
      aggression: aggression,
      cornering: cornering,
      consistency: consistency,
      handling: handling,
      topSpeed: topSpeedMs,
      latAccel: latAccel,
      brakeDecel: brakeDecel,
      reaction: reaction,
      mistakeRate: mistakeRate,
      outerBias: outerBias,
      insideCut: insideCut,
      wobble: (1 - consistency) * 0.7,
      wobblePhase: (seed % 628) / 100
    };

    /* 每 driver 一份可变状态 + 复用的输入 scratch */
    var st = {
      steerCmd: 0,
      overtake: 0,
      mistakeT: 0,
      mistakeOff: 0,
      thinkT: 0,
      stuckT: 0,
      moved: false,
      vTarget: 25,
      maxCurve: 0,
      curveNow: 0,
      rnd: U.rng(seed),
      input: { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: false }
    };

    var driver = {
      styleTag: tag,
      think: function (carArg, trackArg, raceCtx, dt) {
        return thinkImpl(p, st, carArg || car, trackArg || track, raceCtx, dt);
      }
    };
    return driver;
  }

  /* ===================== 每帧决策 ===================== */
  function thinkImpl(p, st, car, track, raceCtx, dt) {
    var out = st.input;
    out.throttle = 0;
    out.brake = 0;
    out.steer = 0;
    out.handbrake = 0;
    out.nitro = false;

    if (!car) return out;
    dt = clamp(finiteOr(dt, 0), 0, 0.1);
    if (dt <= 0) return out;
    st.thinkT += dt;

    var time = raceCtx ? finiteOr(raceCtx.time, NaN) : NaN;
    if (!isFinite(time)) time = st.thinkT;

    /* ---------- 读取车辆 / 赛道状态 ---------- */
    var spec = car.spec || {};
    var stats = spec.stats || {};
    var topSpeed = clamp(finiteOr(stats.topSpeed, 260), 120, 500) / 3.6;
    var handling = clamp(finiteOr(stats.handling, p.handling), 0, 1);

    var v = Math.max(0, finiteOr(car.v, 0));
    var x = finiteOr(car.x, 0);
    var s = finiteOr(car.s, 0);
    var length = (track && typeof track.length === 'number' && isFinite(track.length) && track.length > 0)
      ? track.length : 0;
    if (length > 0) s = U.wrap(s, length);

    var width = widthAtS(track, s);
    var halfW = width * 0.5;
    var limit = Math.max(1.5, halfW - 1.2); // 走线可达的横向极限（留 1.2m 余量）

    /* ---------- 1) 速度规划 ---------- */
    var vTarget = scanSpeed(p, st, track, s, v, length);
    if (vTarget > topSpeed * 1.02) vTarget = topSpeed * 1.02;
    if (car.offroad) {
      var offRoadTop = topSpeed * 0.42;
      if (vTarget > offRoadTop) vTarget = offRoadTop;
    }

    /* ---------- 2) 走线（racingLine 前瞻 + 个性偏移 + 轻微摆动） ---------- */
    var look = 10 + v * 1.05;
    if (look > 100) look = 100;
    var targetX = racingLineAt(track, s + look, length);
    var lookS = (length > 0) ? U.wrap(s + look, length) : (s + look);
    var curveAhead = curveAtS(track, lookS);
    var inside = curveAhead > 0.001 ? 1 : (curveAhead < -0.001 ? -1 : 0);
    var bias = inside * (p.insideCut - p.outerBias);
    if (bias > 0.45) bias = 0.45;
    if (bias < -0.45) bias = -0.45;
    targetX += bias;
    if (p.wobble > 0.01) {
      targetX += Math.sin(time * 0.9 + p.wobblePhase) * p.wobble * 0.4;
    }

    /* ---------- 3) 超车 / 跟随（只读 raceCtx.cars） ---------- */
    var cars = raceCtx && raceCtx.cars;
    var aheadX = 0;
    var aheadV = 0;
    var aheadGap = 0;
    var hasAhead = false;

    if (cars && cars.length) {
      for (var ci = 0; ci < cars.length; ci++) {
        var other = cars[ci];
        if (!other || other === car) continue;
        var otherS = finiteOr(other.s, 0);
        var ds = otherS - s;
        if (length > 0) ds = U.wrap(ds + length * 0.5, length) - length * 0.5;
        if (ds <= 0 || ds >= 30) continue;
        var otherX = finiteOr(other.x, 0);
        var dxo = otherX - x;
        if (dxo > 2.8 || dxo < -2.8) continue; // 前方同横向走廊里的车
        if (!hasAhead || ds < aheadGap) {
          hasAhead = true;
          aheadGap = ds;
          aheadX = otherX;
          aheadV = Math.max(0, finiteOr(other.v, 0));
        }
      }
    }

    var desiredOff = 0;
    if (hasAhead) {
      var roomR = limit - aheadX;   // 前车右侧剩余空间
      var roomL = limit + aheadX;   // 前车左侧剩余空间
      var side = roomR >= roomL ? 1 : -1;
      var passOff = 2.2 + p.aggression * 1.6; // 2.2~3.8m
      var passTarget = aheadX + side * passOff;
      if (passTarget > limit) passTarget = limit;
      if (passTarget < -limit) passTarget = -limit;

      var canPass = Math.max(roomR, roomL) > 2.0 && aheadV < v + 2.0;
      if (canPass && aheadGap > 4.0) {
        /* 前车更慢且空间足够：平滑移向空侧超车（约 1.5s 完成） */
        desiredOff = clamp(passTarget - targetX, -7, 7);
      } else {
        /* 跟随：目标车速不超过前车，留出 5~8.5m 车距 */
        var followGap = Math.min(8.5, 5 + v * 0.045);
        if (aheadGap < followGap + 4) {
          var followV = aheadV - (followGap - aheadGap) * 1.3;
          if (followV < vTarget) vTarget = Math.max(0, followV);
        }
        /* 已经贴得很近时向空间更大的一侧稍微躲开 */
        if (aheadGap < 5 && Math.abs(aheadX - x) < 2.2) {
          desiredOff = side * 1.4;
        }
      }
    }
    st.overtake = U.damp(st.overtake, desiredOff, 2.2, dt);
    targetX += st.overtake;

    /* ---------- 4) 走神失误（确定性 RNG，约 0~1.5%/s） ---------- */
    var throttleScale = 1;
    if (st.mistakeT > 0) {
      st.mistakeT -= dt;
      targetX += st.mistakeOff;
      throttleScale = 0.90; // 松油 10%
      if (st.mistakeT < 0) st.mistakeT = 0;
    } else {
      /* 每帧固定只抽一次随机数，保证同 seed 下序列完全一致 */
      if (st.rnd() < p.mistakeRate * dt) {
        st.mistakeT = 0.4;
        st.mistakeOff = (st.rnd() < 0.5 ? -1 : 1) * (1.0 + st.rnd() * 1.0); // 偏移 1~2m
        targetX += st.mistakeOff;
        throttleScale = 0.90;
      }
    }

    /* ---------- 5) 越野 / 贴边回中 ---------- */
    var edge = halfW - 1.5;
    if (Math.abs(x) > edge) {
      targetX *= 0.3; // 强制往中心拉
      throttleScale *= 0.8;
    }
    if (car.offroad) throttleScale *= 0.55; // 越野减少油门

    if (targetX > limit) targetX = limit;
    else if (targetX < -limit) targetX = -limit;

    /* ---------- 6) 转向：纯追踪 + 离心补偿 + 反应滞后 ---------- */
    var steerGain = (0.9 + 1.6 * handling) * (v / (v + 18)) * v * LAT_K;
    steerGain /= (1 + v * 0.006);
    var err = targetX - x;
    var vSafe = v > 0.5 ? v : 0.5;
    var vy = err * (vSafe / Math.max(look, 6));      // 纯追踪：look 米内收敛到 targetX 所需横移速度
    if (v > 0.5) {
      vy += st.curveNow * v * v * CURVE_K * (1 - 0.35 * handling); // 抵消离心外甩（系数与 car.js CURVE_K 同步）
    }
    var steerTarget;
    if (steerGain > 0.05) {
      steerTarget = clamp(vy / steerGain, -1, 1);
    } else {
      steerTarget = clamp(err * 0.5, -1, 1); // 低速时直接朝目标打方向
    }
    var lagRate = 1.5 / Math.max(p.reaction, 0.02);
    if (lagRate > 40) lagRate = 40;
    st.steerCmd = U.damp(st.steerCmd, steerTarget, lagRate, dt);
    st.steerCmd = clamp(st.steerCmd, -1, 1);

    /* ---------- 7) 油门 / 刹车 ---------- */
    var throttle = 0;
    var brake = 0;
    if (vTarget < 0) vTarget = 0;
    if (v < vTarget * 0.97) {
      throttle = throttleScale;
      if (throttle > 1) throttle = 1;
    } else if (v > vTarget * 1.03) {
      var over = v - vTarget * 1.03;
      brake = clamp(over / (vTarget * 0.20 + 3.5), 0, 1);
      if (brake < 0.08) brake = 0.08;
    } else {
      throttle = 0; // 中间区间滑行
      brake = 0;
    }

    /* ---------- 8) 卡住自救：v<2 持续 2s → aiStuckTime 累加 + 油门回中 ---------- */
    if (v > 3) st.moved = true;
    if (v < 2) st.stuckT += dt;
    else st.stuckT = 0;
    var stuck = st.stuckT > 2 && (st.moved || st.thinkT > 10);
    if (stuck) {
      /* 唯一允许写 car 的字段（game 用它触发救援） */
      car.aiStuckTime = Math.max(0, finiteOr(car.aiStuckTime, 0)) + dt;
      out.throttle = 1;
      out.brake = 0;
      out.steer = clamp(-x * 0.35, -0.85, 0.85);
      out.handbrake = 0;
      out.nitro = false;
      return out;
    }

    /* ---------- 9) 氮气：直道 + 有槽时喷射 ---------- */
    var nitro = false;
    if (v > 12 && finiteOr(car.boost, 0) > 0.18 && st.maxCurve < 0.006 &&
        throttle > 0.5 && !car.offroad && st.mistakeT <= 0) {
      nitro = true;
    }
    if (p.aggression < 0.4) nitro = nitro && finiteOr(car.boost, 0) > 0.45; // 保守性格留槽

    /* ---------- 输出合法 input ---------- */
    out.throttle = clamp(finiteOr(throttle, 0), 0, 1);
    out.brake = clamp(finiteOr(brake, 0), 0, 1);
    out.steer = clamp(finiteOr(st.steerCmd, 0), -1, 1);
    out.handbrake = 0;
    out.nitro = !!nitro;
    return out;
  }

  return {
    createDriver: createDriver
  };
})();
