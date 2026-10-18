/**
 * Horizon Rush · 极速地平线
 * selftest.js —— 内置自检（Lead 所有）
 *
 * 用法：用浏览器打开 index.html?selftest=1
 * 会用真实代码路径做静态/动态校验：
 *   1. 配置与工具函数
 *   2. 赛道生成：字段、闭合、曲率/宽度/走线约束、确定性
 *   3. 物理：加速/极速、氮气、越野、碰撞、复位、NaN 兜底
 *   4. AI + 比赛：8 辆 AI 跑完整场 2 圈（纯逻辑模拟），检查全部完赛、圈速合理、排名唯一
 *   5. 自动驾驶：玩家车交给 AI 后也能完赛
 *
 * 注意：本文件只做验证，不改游戏状态；运行结束后刷新页面即可正常游玩。
 */
(function () {
  'use strict';
  window.HR = window.HR || {};

  var results = [];
  var started = false;

  function nowMs() {
    try { return performance.now(); } catch (e) { return Date.now(); }
  }

  function addResult(group, name, ok, detail, ms) {
    results.push({ group: group, name: name, ok: !!ok, detail: detail || '', ms: ms || 0 });
  }

  function check(group, name, fn) {
    var t0 = nowMs();
    try {
      var r = fn();
      var ok = true;
      var detail = '';
      if (r && typeof r === 'object') {
        ok = r.ok !== false;
        detail = r.detail || '';
      } else if (typeof r === 'string') {
        detail = r;
      } else if (r === false) {
        ok = false;
      }
      addResult(group, name, ok, detail, nowMs() - t0);
      return ok;
    } catch (e) {
      addResult(group, name, false, '异常：' + (e && (e.message || e)), nowMs() - t0);
      return false;
    }
  }

  function fmt(n, d) {
    return (typeof n === 'number' && isFinite(n)) ? n.toFixed(d == null ? 1 : d) : String(n);
  }

  function finite(n) { return typeof n === 'number' && isFinite(n); }

  /**
   * 物理单元测试专用直道 stub：宽 18m、无曲率、无坡度、无限长循环。
   * 避免真实赛道的弯道离心力把测试车甩出路面，造成误报。
   */
  function makeStraightStub() {
    var segLen = 3;
    var count = 2000;
    var total = count * segLen;
    var width = 18;
    var seg = {
      i: 0, s: 0, x: 0, y: 0, z: 0, ex: 0, ey: 0, ez: segLen,
      dirX: 0, dirZ: 1, rightX: 1, rightZ: 0, yaw: 0, slope: 0,
      len: segLen, width: width, curve: 0, zone: 'coast', jitter: 0.5
    };
    return {
      id: 'selftest-straight', name: '直道测试', seed: 0, length: total, count: count,
      segments: [seg], startS: 0, checkpoints: [], gridSlots: [], scenery: [],
      segAt: function () { return 0; },
      sample: function (s, lateral) {
        var lat = finite(lateral) ? lateral : 0;
        var ss = U.wrap(finite(s) ? s : 0, total);
        return {
          x: lat, y: 0, z: ss, dirX: 0, dirZ: 1, rightX: 1, rightZ: 0,
          yaw: 0, slope: 0, width: width, curve: 0, zone: 'coast', segIndex: 0
        };
      },
      widthAt: function () { return width; },
      curveAt: function () { return 0; },
      racingLineAt: function () { return 0; },
      zoneAt: function () { return 'coast'; }
    };
  }

  /* ---------------- 页面输出 ---------------- */
  var outputEl = null;
  var summaryEl = null;
  var progressEl = null;

  function ensureDom() {
    if (document.getElementById('selftest-root')) return;
    try {
      var canvas = document.getElementById('game');
      if (canvas) canvas.style.display = 'none';
      var root = document.getElementById('ui-root');
      if (root) root.style.display = 'none';
    } catch (e) { /* ignore */ }
    var wrap = document.createElement('div');
    wrap.id = 'selftest-root';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#0a0812;color:#e9e6f5;' +
      'font-family:"Segoe UI","Microsoft YaHei",system-ui,monospace;padding:28px 32px;box-sizing:border-box;';
    var h = document.createElement('div');
    h.style.cssText = 'font-size:24px;font-weight:800;letter-spacing:2px;color:#ff8a4c;margin-bottom:4px;';
    h.textContent = 'HORIZON RUSH · 自检';
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:13px;color:#9d97b5;margin-bottom:18px;line-height:1.6;';
    sub.textContent = '正在用真实代码路径验证赛道 / 物理 / AI / 比赛逻辑，请稍候（约几秒）。自检完成后刷新页面即可正常游玩。';
    summaryEl = document.createElement('div');
    summaryEl.style.cssText = 'font-size:15px;font-weight:700;margin:10px 0 14px;padding:12px 16px;border-radius:8px;' +
      'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);white-space:pre-wrap;';
    summaryEl.textContent = '运行中…';
    progressEl = document.createElement('div');
    progressEl.style.cssText = 'font-size:12px;color:#8f8aa4;margin-bottom:10px;';
    outputEl = document.createElement('pre');
    outputEl.style.cssText = 'font-size:12px;line-height:1.65;white-space:pre-wrap;margin:0;' +
      'padding:16px 18px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);';
    wrap.appendChild(h);
    wrap.appendChild(sub);
    wrap.appendChild(summaryEl);
    wrap.appendChild(progressEl);
    wrap.appendChild(outputEl);
    document.body.appendChild(wrap);
  }

  function render() {
    if (!outputEl) return;
    var lines = [];
    var curGroup = '';
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r.group !== curGroup) {
        curGroup = r.group;
        lines.push('');
        lines.push('== ' + curGroup + ' ==');
      }
      lines.push((r.ok ? '[PASS] ' : '[FAIL] ') + r.name + (r.detail ? '  — ' + r.detail : '') + '  (' + r.ms.toFixed(1) + 'ms)');
    }
    outputEl.textContent = lines.join('\n');
    if (progressEl) progressEl.textContent = '已完成 ' + results.length + ' 项检查';
  }

  function finish() {
    var total = results.length;
    var failed = 0;
    for (var i = 0; i < results.length; i++) if (!results[i].ok) failed++;
    var passed = total - failed;
    var msg = '共 ' + total + ' 项检查：' + passed + ' 通过，' + failed + ' 失败。';
    if (failed === 0) {
      msg += '\n\n✅ 全部通过！游戏逻辑正常。刷新页面（F5）即可开始游玩。';
      summaryEl.style.color = '#7dffb0';
      summaryEl.style.borderColor = 'rgba(125,255,176,.5)';
      try { console.log('[HorizonRush][selftest] ALL PASS', passed + '/' + total); } catch (e) { /* ignore */ }
    } else {
      msg += '\n\n❌ 存在失败项。请把本页全部内容（或 F12 控制台输出）反馈给开发者。';
      summaryEl.style.color = '#ff8a8a';
      summaryEl.style.borderColor = 'rgba(255,138,138,.5)';
      try {
        for (var k = 0; k < results.length; k++) {
          if (!results[k].ok) console.error('[HorizonRush][selftest] FAIL', results[k].group + ' / ' + results[k].name, results[k].detail);
        }
      } catch (e) { /* ignore */ }
    }
    summaryEl.textContent = msg;
    render();
  }

  /* ---------------- 具体检查 ---------------- */
  function requireModules() {
    var missing = [];
    if (!HR.Track || typeof HR.Track.generate !== 'function') missing.push('HR.Track.generate');
    if (!HR.Physics || typeof HR.Physics.makeCar !== 'function' || typeof HR.Physics.step !== 'function' ||
        typeof HR.Physics.resolveCollisions !== 'function' || typeof HR.Physics.resetToTrack !== 'function') missing.push('HR.Physics');
    if (!HR.AI || typeof HR.AI.createDriver !== 'function') missing.push('HR.AI.createDriver');
    if (!HR.Game || typeof HR.Game.buildRace !== 'function' || typeof HR.Game.step !== 'function' ||
        typeof HR.Game.updateStandings !== 'function' || typeof HR.Game.buildResultsData !== 'function') {
      missing.push('HR.Game');
    }
    if (missing.length) return { ok: false, detail: '缺少：' + missing.join(', ') };
    return { ok: true, detail: '模块 API 齐全' };
  }

  function testConfig() {
    check('配置', '车辆数量与字段', function () {
      if (!Array.isArray(HR.CARS) || HR.CARS.length !== 8) return { ok: false, detail: 'HR.CARS 应为 8 辆' };
      for (var i = 0; i < HR.CARS.length; i++) {
        var c = HR.CARS[i];
        if (!c.id || !c.name || !c.stats) return { ok: false, detail: '车辆 ' + i + ' 缺少 id/name/stats' };
        var s = c.stats;
        if (!finite(s.topSpeed) || s.topSpeed < 180 || s.topSpeed > 420) return { ok: false, detail: c.id + ' topSpeed 异常' };
        if (!finite(s.accel) || s.accel <= 0.5) return { ok: false, detail: c.id + ' accel 异常' };
        if (!c.ai || typeof c.ai.cornering !== 'number') return { ok: false, detail: c.id + ' 缺少 AI 性格配置（每个车都要能接 AI）' };
      }
      return { ok: true, detail: '8 辆车，均含 AI 性格配置' };
    });
    check('配置', '赛事数量与赛道参数', function () {
      if (!Array.isArray(HR.EVENTS) || HR.EVENTS.length !== 4) return { ok: false, detail: 'HR.EVENTS 应为 4 站' };
      for (var i = 0; i < HR.EVENTS.length; i++) {
        var e = HR.EVENTS[i];
        if (!e.track || !finite(e.track.seed) || !finite(e.track.lengthKm)) return { ok: false, detail: e.id + ' 赛道参数缺失' };
        if (!finite(e.laps) || e.laps < 1) return { ok: false, detail: e.id + ' laps 异常' };
        if (!Array.isArray(e.track.zones) || e.track.zones.length === 0) return { ok: false, detail: e.id + ' zones 缺失' };
      }
      return { ok: true, detail: '4 站赛事参数正常' };
    });
    check('配置', '工具函数', function () {
      var U = HR.Util;
      if (U.formatTime(83.456) !== '1:23.456') return { ok: false, detail: 'formatTime 结果=' + U.formatTime(83.456) };
      if (U.formatTime(9.5) !== '9.500') return { ok: false, detail: 'formatTime(9.5)=' + U.formatTime(9.5) };
      if (U.clamp(5, 0, 3) !== 3 || U.wrap(-1, 10) !== 9) return { ok: false, detail: 'clamp/wrap 异常' };
      var r1 = U.rng(42), r2 = U.rng(42);
      if (r1() !== r2()) return { ok: false, detail: 'rng 不确定' };
      return { ok: true, detail: '时间/数学/RNG 正常' };
    });
  }

  function validateTrack(track) {
    var errs = [];
    if (!track) return ['track 为空'];
    if (!Array.isArray(track.segments) || track.segments.length < 100) return ['segments 数量异常'];
    if (!track.segments.length) return ['segments 为空'];
    if (!finite(track.length) || track.length < 800) return ['length 异常：' + track.length];
    if (typeof track.sample !== 'function' || typeof track.segAt !== 'function' ||
        typeof track.widthAt !== 'function' || typeof track.curveAt !== 'function' ||
        typeof track.racingLineAt !== 'function' || typeof track.zoneAt !== 'function') {
      return ['track 方法缺失'];
    }
    var i;
    // 段字段 + 数值
    for (i = 0; i < track.segments.length; i++) {
      var s = track.segments[i];
      if (!s || s.i !== i) { errs.push('seg ' + i + ' i 字段异常'); break; }
      var keys = ['s', 'x', 'y', 'z', 'ex', 'ey', 'ez', 'dirX', 'dirZ', 'rightX', 'rightZ',
        'yaw', 'slope', 'len', 'width', 'curve', 'zone', 'jitter'];
      for (var k = 0; k < keys.length; k++) {
        if (s[keys[k]] === undefined || s[keys[k]] === null) { errs.push('seg ' + i + ' 缺字段 ' + keys[k]); break; }
      }
      if (errs.length) break;
      if (!finite(s.x) || !finite(s.y) || !finite(s.z) || !finite(s.len) || !finite(s.width) || !finite(s.curve)) {
        errs.push('seg ' + i + ' 存在 NaN');
        break;
      }
      if (s.len <= 1.5 || s.len > 6) { errs.push('seg ' + i + ' len=' + s.len); break; }
      if (s.width < 12.8 || s.width > 22.2) { errs.push('seg ' + i + ' width=' + s.width); break; }
      if (Math.abs(s.curve) > 0.0221) { errs.push('seg ' + i + ' curve=' + s.curve + ' 超限'); break; }
      if (Math.abs(s.dirX * s.dirX + s.dirZ * s.dirZ - 1) > 0.01) { errs.push('seg ' + i + ' dir 未归一化'); break; }
      if (['festival', 'coast', 'desert', 'forest', 'mountain', 'city'].indexOf(s.zone) < 0) { errs.push('seg ' + i + ' zone 非法：' + s.zone); break; }
    }
    if (errs.length) return errs;
    // 相邻曲率平滑
    var maxJump = 0;
    for (i = 1; i < track.segments.length; i++) {
      maxJump = Math.max(maxJump, Math.abs(track.segments[i].curve - track.segments[i - 1].curve));
    }
    if (maxJump > 0.0045) errs.push('曲率跳变过大：' + fmt(maxJump, 4));
    // 闭合性
    var first = track.segments[0];
    var last = track.segments[track.segments.length - 1];
    var gap = Math.sqrt(Math.pow(last.ex - first.x, 2) + Math.pow(last.ez - first.z, 2));
    if (gap > 1.5) errs.push('首尾未闭合，间距=' + fmt(gap, 2));
    // s 累计连续
    var total = 0;
    for (i = 0; i < track.segments.length; i++) total += track.segments[i].len;
    if (Math.abs(total - track.length) > 1) errs.push('length 与段长之和不等');
    // 赛车线
    if (!track.racingLine || track.racingLine.length !== track.segments.length) {
      errs.push('racingLine 长度不符');
    } else {
      var maxAbs = 0;
      for (i = 0; i < track.segments.length; i++) {
        var v = track.racingLine[i];
        if (!finite(v)) { errs.push('racingLine 存在 NaN'); break; }
        var limit = track.segments[i].width / 2 - 2.2;
        if (Math.abs(v) > limit + 0.01) { errs.push('racingLine 超出路面 seg ' + i + ' v=' + fmt(v, 2) + ' limit=' + fmt(limit, 2)); break; }
        maxAbs = Math.max(maxAbs, Math.abs(v));
      }
      if (!errs.length && maxAbs < 0.1) errs.push('racingLine 全为 0（未生成走线）');
    }
    // 发车格
    if (!Array.isArray(track.gridSlots) || track.gridSlots.length < 8) {
      errs.push('gridSlots 数量不足');
    } else {
      for (i = 0; i < 8; i++) {
        var slot = track.gridSlots[i];
        if (!finite(slot.s) || !finite(slot.lateral)) { errs.push('gridSlots[' + i + '] 非法'); break; }
      }
    }
    // checkpoints
    if (!Array.isArray(track.checkpoints) || track.checkpoints.length !== 3) errs.push('checkpoints 应为 3 个，实际 ' + (track.checkpoints ? track.checkpoints.length : 0));
    else {
      for (i = 1; i < track.checkpoints.length; i++) {
        if (!(track.checkpoints[i] > track.checkpoints[i - 1])) { errs.push('checkpoints 未递增'); break; }
      }
    }
    // minimap
    if (!track.minimap || !Array.isArray(track.minimap.points) || track.minimap.points.length < 20) errs.push('minimap.points 不足');
    // scenery
    if (!Array.isArray(track.scenery) || track.scenery.length < 60) errs.push('scenery 数量不足（应 60~180）');
    // sample 一致性
    try {
      var smp = track.sample(0, 0);
      if (!smp || !finite(smp.x) || !finite(smp.width) || smp.zone === undefined) errs.push('sample(0) 返回异常');
      var smp2 = track.sample(track.length * 0.5, 5);
      if (!smp2 || !finite(smp2.x) || !finite(smp2.yaw)) errs.push('sample(mid) 返回异常');
      var smp3 = track.sample(-5, 0);
      if (!smp3 || !finite(smp3.x)) errs.push('sample(负数) 异常');
      var idx = track.segAt(track.length - 0.01);
      if (!(idx >= 0 && idx < track.segments.length)) errs.push('segAt wrap 异常：' + idx);
    } catch (e) {
      errs.push('sample/segAt 抛异常：' + e.message);
    }
    return errs;
  }

  function testTrack() {
    var tracks = {};
    var defs = [
      { name: '海岸序章', seed: 1101, lengthKm: 3.4, zones: ['coast', 'desert', 'festival'] },
      { name: '山城夜雨', seed: 3303, lengthKm: 3.8, zones: ['city', 'forest', 'mountain', 'festival'] },
      { name: '自由驾驶', seed: 9001, lengthKm: 3.6, zones: ['coast', 'desert', 'forest', 'festival'] }
    ];
    for (var i = 0; i < defs.length; i++) {
      (function (def) {
        check('赛道', def.name + ' 生成与约束', function () {
          var t0 = nowMs();
          var track = HR.Track.generate({ seed: def.seed, name: def.name, lengthKm: def.lengthKm, zones: def.zones });
          var ms = nowMs() - t0;
          tracks[def.seed] = track;
          var errs = validateTrack(track);
          if (errs.length) return { ok: false, detail: errs.slice(0, 3).join(' | ') };
          return { detail: '长度 ' + fmt(track.length / 1000, 2) + 'km / ' + track.segments.length + ' 段 / 生成 ' + fmt(ms, 1) + 'ms' };
        });
      })(defs[i]);
    }
    check('赛道', '同 seed 确定性（绕过缓存）', function () {
      if (HR.Track.clearCache) HR.Track.clearCache();
      var a = HR.Track.generate({ seed: 1101, name: '海岸序章', lengthKm: 3.4, zones: ['coast', 'desert', 'festival'] });
      if (HR.Track.clearCache) HR.Track.clearCache();
      var b = HR.Track.generate({ seed: 1101, name: '海岸序章', lengthKm: 3.4, zones: ['coast', 'desert', 'festival'] });
      if (!a || !b) return { ok: false, detail: '生成失败' };
      if (a.segments.length !== b.segments.length) return { ok: false, detail: '段数不一致' };
      if (Math.abs(a.length - b.length) > 1e-6) return { ok: false, detail: '长度不一致' };
      for (var i = 0; i < Math.min(20, a.segments.length); i++) {
        if (Math.abs(a.segments[i].x - b.segments[i].x) > 1e-6 ||
            Math.abs(a.segments[i].z - b.segments[i].z) > 1e-6 ||
            Math.abs(a.racingLine[i] - b.racingLine[i]) > 1e-6) {
          return { ok: false, detail: '段 ' + i + ' 不一致' };
        }
      }
      return { detail: '两次独立生成完全一致' };
    });
  }

  function testPhysics() {
    var track = makeStraightStub();
    var spec = HR.CARS[0];

    check('物理', '加速与极速', function () {
      var car = HR.Physics.makeCar(spec, { id: 't1', name: 'T', s: 10, x: 0 });
      var input = { throttle: 1, brake: 0, steer: 0, handbrake: 0, nitro: false };
      var t = 0;
      var dt = 1 / 120;
      while (t < 12) { HR.Physics.step(car, input, track, dt, t); t += dt; }
      var kmh = car.v * 3.6;
      if (!finite(kmh)) return { ok: false, detail: '速度为 NaN' };
      if (kmh < 180) return { ok: false, detail: '12s 后仅 ' + fmt(kmh, 0) + 'km/h，加速过慢' };
      var top = spec.stats.topSpeed;
      if (kmh > top * 1.12) return { ok: false, detail: '超过极速上限：' + fmt(kmh, 0) + ' > ' + top };
      return { detail: '12s → ' + fmt(kmh, 0) + 'km/h（极速 ' + top + '）' };
    });

    check('物理', '0-100km/h 加速时间', function () {
      var car = HR.Physics.makeCar(spec, { id: 't2', name: 'T', s: 10, x: 0 });
      var input = { throttle: 1, brake: 0, steer: 0, handbrake: 0, nitro: false };
      var t = 0, dt = 1 / 240, reached = -1;
      while (t < 15) {
        HR.Physics.step(car, input, track, dt, t);
        t += dt;
        if (car.v * 3.6 >= 100) { reached = t; break; }
      }
      if (reached < 0) return { ok: false, detail: '15s 内未达到 100km/h' };
      if (reached < 1.2 || reached > 12) return { ok: false, detail: '0-100 时间异常：' + fmt(reached, 2) + 's（配置 ' + spec.stats.accel + 's）' };
      return { detail: fmt(reached, 2) + 's（配置 ' + spec.stats.accel + 's）' };
    });

    check('物理', '氮气消耗与回收', function () {
      var car = HR.Physics.makeCar(spec, { id: 't3', name: 'T', s: 10, x: 0 });
      var t = 0, dt = 1 / 120;
      var input = { throttle: 1, brake: 0, steer: 0, handbrake: 0, nitro: true };
      for (; t < 1.5; t += dt) HR.Physics.step(car, input, track, dt, t);
      if (!(car.boost < 0.9)) return { ok: false, detail: 'boost 未消耗：' + fmt(car.boost, 3) };
      var low = car.boost;
      input.nitro = false;
      for (; t < 4.5; t += dt) HR.Physics.step(car, input, track, dt, t);
      if (!(car.boost > low)) return { ok: false, detail: 'boost 未回收：' + fmt(low, 3) + ' → ' + fmt(car.boost, 3) };
      return { detail: '消耗 ' + fmt(1 - low, 2) + '，4.5s 后回到 ' + fmt(car.boost, 2) };
    });

    check('物理', '越野减速与软墙', function () {
      var w = track.widthAt(30);
      var road = HR.Physics.makeCar(spec, { id: 'road', name: 'R', s: 30, x: 0 });
      var dirt = HR.Physics.makeCar(spec, { id: 'dirt', name: 'D', s: 30, x: w / 2 + 3 });
      var input = { throttle: 1, brake: 0, steer: 0, handbrake: 0, nitro: false };
      var t = 0, dt = 1 / 120;
      for (; t < 7; t += dt) {
        HR.Physics.step(road, input, track, dt, t);
        HR.Physics.step(dirt, input, track, dt, t);
      }
      if (!dirt.offroad) return { ok: false, detail: '越野状态未触发' };
      if (!(dirt.v < road.v * 0.72)) return { ok: false, detail: '越野未明显减速：road=' + fmt(road.v * 3.6, 0) + ' dirt=' + fmt(dirt.v * 3.6, 0) };
      if (Math.abs(dirt.x) > track.widthAt(dirt.s) / 2 + 6.05) {
        return { ok: false, detail: '冲出软墙：x=' + fmt(dirt.x, 2) };
      }
      return { detail: 'road ' + fmt(road.v * 3.6, 0) + 'km/h / dirt ' + fmt(dirt.v * 3.6, 0) + 'km/h' };
    });

    check('物理', '碰撞分离与 NaN 兜底', function () {
      var a = HR.Physics.makeCar(HR.CARS[0], { id: 'a', name: 'A', s: 100, x: 0.2 });
      var b = HR.Physics.makeCar(HR.CARS[1], { id: 'b', name: 'B', s: 100.6, x: 0.4 });
      a.v = 30; b.v = 30;
      var list = [a, b];
      HR.Physics.step(a, { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: false }, track, 1 / 120, 0);
      HR.Physics.resolveCollisions(list, track);
      var dx = Math.abs(a.x - b.x);
      if (!finite(a.x) || !finite(b.x) || !finite(a.v) || !finite(b.v)) return { ok: false, detail: '出现 NaN' };
      if (dx < 1.8) return { ok: false, detail: '碰撞后未分离：Δx=' + fmt(dx, 2) };
      if (Math.abs(a.x) > track.widthAt(a.s) / 2 + 6.05) return { ok: false, detail: '碰撞后越界' };
      return { detail: '分离后 Δx=' + fmt(dx, 2) + 'm' };
    });

    check('物理', '脱困复位', function () {
      var car = HR.Physics.makeCar(spec, { id: 'r', name: 'R', s: 50, x: track.widthAt(50) / 2 + 5 });
      car.v = 5;
      HR.Physics.resetToTrack(car, track);
      if (car.offroad) return { ok: false, detail: '复位后仍 offroad' };
      if (Math.abs(car.x) > track.widthAt(car.s) / 2 - 1) return { ok: false, detail: '复位后仍不在赛道内：x=' + fmt(car.x, 2) };
      if (!finite(car.v) || car.v < 0) return { ok: false, detail: '复位后速度异常' };
      return { detail: '复位到 x=' + fmt(car.x, 2) + ' / v=' + fmt(car.v, 1) };
    });

    check('物理', '极端 dt 与非法输入不崩', function () {
      var car = HR.Physics.makeCar(spec, { id: 'x', name: 'X', s: 20, x: 0 });
      HR.Physics.step(car, { throttle: 1, brake: 0, steer: 1, handbrake: 0, nitro: true }, track, 10, 0);
      HR.Physics.step(car, { throttle: NaN, brake: NaN, steer: NaN, handbrake: 0, nitro: false }, track, 0.016, 0);
      HR.Physics.step(car, { throttle: -5, brake: -5, steer: 99, handbrake: 1, nitro: true }, track, -1, 0);
      if (!finite(car.s) || !finite(car.x) || !finite(car.v)) return { ok: false, detail: '非法输入导致 NaN' };
      if (car.v < 0) return { ok: false, detail: '速度为负：' + car.v };
      return { detail: 's=' + fmt(car.s, 1) + ' x=' + fmt(car.x, 2) + ' v=' + fmt(car.v, 1) };
    });

    check('物理', '不同车辆手感差异', function () {
      var fastest = HR.CARS.slice().sort(function (a, b) { return b.stats.topSpeed - a.stats.topSpeed; })[0];
      var slowest = HR.CARS.slice().sort(function (a, b) { return a.stats.topSpeed - b.stats.topSpeed; })[0];
      var dt = 1 / 120, t = 0;
      var fa = HR.Physics.makeCar(fastest, { id: 'f', name: 'F', s: 10, x: 0 });
      var sl = HR.Physics.makeCar(slowest, { id: 's', name: 'S', s: 10, x: 0 });
      var input = { throttle: 1, brake: 0, steer: 0, handbrake: 0, nitro: false };
      for (; t < 10; t += dt) { HR.Physics.step(fa, input, track, dt, t); HR.Physics.step(sl, input, track, dt, t); }
      if (!(fa.v > sl.v + 2)) return { ok: false, detail: '快车未快于慢车：' + fmt(fa.v * 3.6, 0) + ' vs ' + fmt(sl.v * 3.6, 0) };
      return { detail: fastest.id + ' ' + fmt(fa.v * 3.6, 0) + 'km/h > ' + slowest.id + ' ' + fmt(sl.v * 3.6, 0) + 'km/h' };
    });
  }

  function simulateRaceToEnd(cfg, deadlineSec, lapsOverride) {
    var race = HR.Game.buildRace(cfg);
    if (lapsOverride && lapsOverride > 0) {
      race.laps = lapsOverride;
      for (var li = 0; li < race.cars.length; li++) race.cars[li].lap = 1;
    }
    var dt = 1 / 120;
    var t = 0;
    var endCheck = 0;
    while (t < deadlineSec) {
      HR.Game.step(race, dt);
      t += dt;
      if (t - endCheck >= 0.25) {
        endCheck = t;
        HR.Game.updateStandings(race);
        // 与游戏主循环一致的 AI 救援（selftest 不跑渲染/UI，所以在这里补上）
        for (var r = 0; r < race.cars.length; r++) {
          var rc = race.cars[r];
          if (!rc.finished && rc.control === 'ai' && rc.aiStuckTime > 2.5 && rc.v < 3) {
            HR.Physics.resetToTrack(rc, race.track);
            rc.aiStuckTime = 0;
          }
        }
        var done = true;
        for (var i = 0; i < race.cars.length; i++) {
          if (!race.cars[i].finished) { done = false; break; }
        }
        if (done) break;
      }
    }
    HR.Game.updateStandings(race);
    return { race: race, simTime: t };
  }

  /** 只推进固定秒数（用于确定性对比） */
  function simulateSteps(cfg, seconds) {
    var race = HR.Game.buildRace(cfg);
    var dt = 1 / 120;
    var steps = Math.round(seconds / dt);
    for (var i = 0; i < steps; i++) HR.Game.step(race, dt);
    HR.Game.updateStandings(race);
    return race;
  }

  function testAI() {
    var res = null;
    check('AI 比赛', '8 辆 AI 完整跑完 3 圈（纯逻辑模拟）', function () {
      res = simulateRaceToEnd({ mode: 'spectate', eventId: 'e1', carId: 'apex-gt', difficultyId: 'pro' }, 560, 3);
      var race = res.race;
      var cars = race.cars;
      if (cars.length !== 8) return { ok: false, detail: '车辆数=' + cars.length };
      var unfinished = [];
      for (var i = 0; i < cars.length; i++) if (!cars[i].finished) unfinished.push(cars[i].spec.name);
      if (unfinished.length) return { ok: false, detail: '未完赛：' + unfinished.join('、') + '（模拟 ' + fmt(res.simTime, 0) + 's）' };
      var laps = race.laps, len = race.track.length;
      if (laps !== 3) return { ok: false, detail: '圈数覆盖失败：' + laps };
      for (i = 0; i < cars.length; i++) {
        var c = cars[i];
        var dist = c.dist;
        if (!finite(dist) || dist < laps * len - 2) return { ok: false, detail: c.spec.name + ' 里程异常 ' + fmt(dist, 0) };
        if (!finite(c.finishTime) || c.finishTime < 20 || c.finishTime > 560) return { ok: false, detail: c.spec.name + ' 完赛时间异常 ' + fmt(c.finishTime, 1) };
        if (!finite(c.bestLap) || c.bestLap < 15 || c.bestLap > 300) return { ok: false, detail: c.spec.name + ' 最快圈异常 ' + fmt(c.bestLap, 1) };
        if (!finite(c.x) || !finite(c.v)) return { ok: false, detail: c.spec.name + ' 状态 NaN' };
        if (Math.abs(c.x) > race.track.widthAt(c.s) / 2 + 6.05) return { ok: false, detail: c.spec.name + ' 冲出软墙 x=' + fmt(c.x, 2) };
      }
      // 名次唯一
      var seen = {};
      for (i = 0; i < cars.length; i++) {
        if (seen[cars[i].place]) return { ok: false, detail: '名次重复：' + cars[i].place };
        seen[cars[i].place] = true;
      }
      var times = cars.map(function (c) { return c.finishTime; }).sort(function (a, b) { return a - b; });
      return {
        detail: '3 圈完赛 ' + fmt(times[0], 1) + 's ~ ' + fmt(times[times.length - 1], 1) + 's，最快圈 ' +
          fmt(Math.min.apply(null, cars.map(function (c) { return c.bestLap; })), 1) + 's'
      };
    });

    check('AI 比赛', '同种子 AI 模拟确定性', function () {
      var cfgA = { mode: 'spectate', eventId: 'e1', carId: 'apex-gt', difficultyId: 'ace' };
      var a = simulateSteps(cfgA, 20);
      var b = simulateSteps(cfgA, 20);
      for (var i = 0; i < a.cars.length; i++) {
        if (Math.abs(a.cars[i].dist - b.cars[i].dist) > 1e-9 ||
            Math.abs(a.cars[i].x - b.cars[i].x) > 1e-9 ||
            Math.abs(a.cars[i].v - b.cars[i].v) > 1e-9) {
          return { ok: false, detail: a.cars[i].spec.name + ' 两次模拟结果不一致' };
        }
      }
      return { detail: '20s 模拟 8 车状态完全一致' };
    });

    check('AI 比赛', '不同车 AI 风格圈速差异', function () {
      if (!res) return { ok: false, detail: '前置模拟未完成' };
      var laps = res.race.cars.map(function (c) { return c.bestLap; }).filter(function (v) { return v > 0; });
      if (laps.length < 8) return { ok: false, detail: '有效圈速不足' };
      var min = Math.min.apply(null, laps), max = Math.max.apply(null, laps);
      if (max - min < 0.4) return { ok: false, detail: '8 车圈速几乎相同（' + fmt(min, 2) + '~' + fmt(max, 2) + '），AI 缺少个性差异' };
      return { detail: '圈速范围 ' + fmt(min, 1) + 's ~ ' + fmt(max, 1) + 's（差 ' + fmt(max - min, 1) + 's）' };
    });

    check('AI 比赛', '玩家车交给 AI 后仍能完赛（自动驾驶）', function () {
      var r = simulateRaceToEnd({ mode: 'race', eventId: 'e1', carId: 'nightfall', difficultyId: 'rookie', autopilot: true }, 360, 2);
      var race = r.race;
      var pc = race.playerCar;
      if (!pc) return { ok: false, detail: '没有玩家车' };
      if (pc.control !== 'ai') return { ok: false, detail: '自动驾驶未生效' };
      if (!pc.finished) return { ok: false, detail: '玩家车（AI 驾驶）未完赛' };
      if (!finite(pc.place) || pc.place < 1 || pc.place > 8) return { ok: false, detail: '名次异常：' + pc.place };
      return { detail: '完赛 P' + pc.place + '，总时间 ' + fmt(pc.finishTime, 1) + 's' };
    });
  }

  function testRaceFlow() {
    check('比赛流程', '发车格/圈数/排名初始化', function () {
      var race = HR.Game.buildRace({ mode: 'race', eventId: 'e2', carId: 'drift-king', difficultyId: 'pro', autopilot: false });
      if (!race.playerCar) return { ok: false, detail: '未分配玩家车' };
      if (race.playerCar.spec.id !== 'drift-king') return { ok: false, detail: '玩家车错误：' + race.playerCar.spec.id };
      if (race.laps !== 2) return { ok: false, detail: '圈数错误：' + race.laps };
      if (race.cars.length !== 8) return { ok: false, detail: '车辆数错误：' + race.cars.length };
      if (race.state !== 'countdown') return { ok: false, detail: '初始状态应为 countdown，实际 ' + race.state };
      if (race.playerCar.control !== 'player') return { ok: false, detail: '玩家车控制标记错误' };
      // 倒计时推进
      var t = 0;
      while (t < 3.2) { HR.Game.step(race, 1 / 120); t += 1 / 120; }
      if (race.state !== 'racing') return { ok: false, detail: '3.2s 后仍未开赛：' + race.state };
      // 跑 10 秒
      HR.Game.step(race, 1 / 120);
      var d0 = race.cars.map(function (c) { return c.dist; });
      for (var i = 0; i < 1200; i++) HR.Game.step(race, 1 / 120);
      var moved = 0;
      for (i = 0; i < race.cars.length; i++) if (race.cars[i].dist > d0[i] + 10) moved++;
      if (moved < 7) return { ok: false, detail: '10s 内只有 ' + moved + '/8 辆车前进' };
      return { detail: '倒计时→开赛正常，' + moved + '/8 车前进' };
    });

    check('比赛流程', '结算数据与名次表', function () {
      // 完整跑完一场（玩家车由 AI 驾驶），再用真实 buildResultsData 构建结算数据
      var r = simulateRaceToEnd({ mode: 'race', eventId: 'e1', carId: 'volt', difficultyId: 'ace', autopilot: true }, 360, 2);
      var race = r.race;
      if (!race.playerCar || !race.playerCar.finished) return { ok: false, detail: '玩家车未完赛' };
      race.finalStandings = HR.Game.updateStandings(race);
      if (!(race.playerCar.place >= 1 && race.playerCar.place <= 8)) return { ok: false, detail: '名次异常' };
      if (!(race.playerCar.bestLap > 0)) return { ok: false, detail: '最快圈未记录' };
      var seen = {};
      for (var i = 0; i < race.cars.length; i++) {
        if (!race.cars[i].place || seen[race.cars[i].place]) return { ok: false, detail: '名次重复/缺失' };
        seen[race.cars[i].place] = true;
        if (!finite(race.cars[i].dist)) return { ok: false, detail: '距离 NaN' };
      }
      var results = HR.Game.buildResultsData(race);
      if (!results || !Array.isArray(results.rows) || results.rows.length !== 8) {
        return { ok: false, detail: '结算 rows 数量异常' };
      }
      if (!results.rows[0].totalTime || results.rows[0].totalTime === '未完赛') {
        return { ok: false, detail: '冠军总时间未生成' };
      }
      var playerRow = null;
      for (var ri = 0; ri < results.rows.length; ri++) if (results.rows[ri].isPlayer) playerRow = results.rows[ri];
      if (!playerRow) return { ok: false, detail: '结算缺少玩家行' };
      if (typeof playerRow.totalTime !== 'string' || !playerRow.totalTime.length) return { ok: false, detail: '玩家总时间格式异常' };
      if (!(typeof results.credits === 'number' && results.credits > 0)) return { ok: false, detail: '奖金计算异常：' + results.credits };
      if (!Array.isArray(results.actions) || !results.actions.length) return { ok: false, detail: '结算按钮缺失' };
      if (!results.title || !results.eventName) return { ok: false, detail: '结算标题/赛事名缺失' };
      return {
        detail: '完赛 P' + race.playerCar.place + '，最快圈 ' + fmt(race.playerCar.bestLap, 1) +
          's，奖金 ' + results.credits + ' CR，名次表 ' + results.rows.length + ' 行'
      };
    });
  }

  /* ---------------- 运行器 ---------------- */
  var groups = [
    { name: '模块与配置', fn: function () { check('模块', '依赖模块 API', requireModules); testConfig(); } },
    { name: '赛道生成', fn: testTrack },
    { name: '车辆物理', fn: testPhysics },
    { name: 'AI 与完整比赛', fn: testAI },
    { name: '比赛流程与结算', fn: testRaceFlow }
  ];

  function runNext(i) {
    if (i >= groups.length) { finish(); return; }
    var g = groups[i];
    if (progressEl) progressEl.textContent = '正在检查：' + g.name + ' …';
    setTimeout(function () {
      try { g.fn(); } catch (e) { addResult(g.name, '检查组异常', false, String(e && (e.message || e)), 0); }
      render();
      runNext(i + 1);
    }, 30);
  }

  function run() {
    if (started) return;
    started = true;
    ensureDom();
    try { document.title = '自检中… · HORIZON RUSH'; } catch (e) { /* ignore */ }
    try { console.log('[HorizonRush][selftest] 开始自检…'); } catch (e) { /* ignore */ }
    runNext(0);
  }

  HR.selftest = { run: run, results: results };
})();
