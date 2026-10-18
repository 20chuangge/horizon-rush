/**
 * Horizon Rush · 极速地平线
 * game.js —— 游戏主控：状态机 / 输入 / 竞速管理 / 冠军赛 / 存档 / 主循环（Lead 所有）
 *
 * 依赖（按 index.html 顺序加载）：
 *   HR.Util, HR.Cfg(HR.CARS/EVENTS/D…), HR.Track, HR.Physics, HR.AI, HR.Renderer, HR.UI, HR.Audio
 *
 * 提供：
 *   HR.boot()            启动（DOMContentLoaded 自动调用）
 *   HR.Game.buildRace()  构建比赛（selftest 复用）
 *   HR.Game.step()       固定步长推进（selftest 复用）
 *   HR.Game.state        game 状态对象（调试用）
 */
(function () {
  'use strict';

  window.HR = window.HR || {};
  var U = HR.Util;
  var TWO_PI = Math.PI * 2;

  /* ============================================================
   * 全局状态
   * ============================================================ */
  var game = {
    booted: false,
    fatal: false,
    canvas: null,
    appMode: 'boot',          // 'menu' | 'race' | 'spectate' | 'free'
    race: null,               // 当前渲染/模拟的 race
    attract: null,            // 标题页背景演示赛
    raceConfig: null,         // 重开用
    save: null,
    settings: null,
    paused: false,
    input: null,
    cameraMode: 'chase',
    spectateSpeed: 1,
    champ: null,
    pending: { eventId: null, carId: null, mode: 'race' },
    lastTs: 0,
    timeAccum: 0,
    fps: 60,
    frameDt: 0.016,
    audioReady: false,
    playerName: '你',
    screenOpen: false
  };

  /* ============================================================
   * 安全调用工具
   * ============================================================ */
  function audio(name, args) {
    try {
      if (HR.Audio && typeof HR.Audio[name] === 'function') HR.Audio[name].apply(HR.Audio, args || []);
    } catch (e) { /* 音频永远不能导致游戏崩溃 */ }
  }

  function toast(msg, ms) {
    try {
      if (HR.UI && typeof HR.UI.toast === 'function') HR.UI.toast(msg, ms || 2200);
    } catch (e) { /* ignore */ }
  }

  function getSpec(carId) {
    var list = HR.CARS || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === carId) return list[i];
    return list[0];
  }

  function getEvent(eventId) {
    var list = HR.EVENTS || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === eventId) return list[i];
    return list[0];
  }

  function getDifficulty(id) {
    var list = HR.DIFFICULTIES || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[1] || list[0];
  }

  /* ============================================================
   * 存档
   * ============================================================ */
  function defaultSave() {
    return {
      version: 1,
      settings: U.clone(HR.DEFAULT_SETTINGS),
      credits: 0,
      records: {},
      stats: { races: 0, wins: 0, podiums: 0, championships: 0, bestLap: 0 },
      championships: []
    };
  }

  function validateSettings(s) {
    var out = U.deepMerge(U.clone(HR.DEFAULT_SETTINGS), s || {});
    var enums = HR.SETTING_ENUMS || {};
    var k;
    for (k in enums) {
      if (!Object.prototype.hasOwnProperty.call(enums, k)) continue;
      if (enums[k].indexOf(out[k]) < 0) out[k] = HR.DEFAULT_SETTINGS[k];
    }
    if (typeof out.volume !== 'number' || !isFinite(out.volume)) out.volume = 0.7;
    out.volume = U.clamp(out.volume, 0, 1);
    out.music = !!out.music;
    out.sfx = !!out.sfx;
    out.autopilot = !!out.autopilot;
    out.showHints = !!out.showHints;
    return out;
  }

  function loadSave() {
    var raw = U.storage.load(HR.SAVE_KEY, null);
    if (!raw || typeof raw !== 'object') return defaultSave();
    var base = defaultSave();
    var out = U.deepMerge(base, raw);
    out.settings = validateSettings(raw.settings);
    out.credits = typeof out.credits === 'number' && isFinite(out.credits) ? out.credits : 0;
    if (!out.records || typeof out.records !== 'object') out.records = {};
    /* 逐条规范化记录（旧版本/手改存档可能类型不对，避免 save.strict 下抛错或字符串拼接） */
    var rkeys = Object.keys(out.records);
    for (var ri = 0; ri < rkeys.length; ri++) {
      var rk = rkeys[ri];
      var rr = out.records[rk];
      if (!rr || typeof rr !== 'object') { delete out.records[rk]; continue; }
      var nb = {};
      nb.bestLap = (typeof rr.bestLap === 'number' && isFinite(rr.bestLap) && rr.bestLap > 0) ? rr.bestLap : 0;
      nb.bestTotal = (typeof rr.bestTotal === 'number' && isFinite(rr.bestTotal) && rr.bestTotal > 0) ? rr.bestTotal : 0;
      nb.bestLapText = nb.bestLap ? U.formatTime(nb.bestLap) : '--';
      nb.bestTotalText = nb.bestTotal ? U.formatTime(nb.bestTotal) : '--';
      if (typeof rr.updatedAt === 'number' && isFinite(rr.updatedAt)) nb.updatedAt = rr.updatedAt;
      out.records[rk] = nb;
    }
    if (!out.stats || typeof out.stats !== 'object') out.stats = base.stats;
    var stKeys = ['races', 'wins', 'podiums', 'championships', 'bestLap'];
    for (var si = 0; si < stKeys.length; si++) {
      var sk = stKeys[si];
      var sv = out.stats[sk];
      out.stats[sk] = (typeof sv === 'number' && isFinite(sv) && sv >= 0) ? sv : 0;
    }
    if (!Array.isArray(out.championships)) out.championships = [];
    return out;
  }

  function saveGame() {
    try { game.save.settings = game.settings; U.storage.save(HR.SAVE_KEY, game.save); } catch (e) { /* ignore */ }
  }

  function applySettings(patch) {
    if (!patch || typeof patch !== 'object') return;
    game.settings = validateSettings(U.deepMerge(game.settings, patch));
    game.save.settings = game.settings;
    saveGame();
    try {
      if (HR.Renderer && typeof HR.Renderer.setQuality === 'function') HR.Renderer.setQuality(game.settings.quality);
    } catch (e) { /* ignore */ }
    audio('setVolume', [game.settings.volume]);
    audio('setEnabled', [game.settings.sfx]);
    audio('setMusicEnabled', [game.settings.music]);
  }

  /* ============================================================
   * 错误处理
   * ============================================================ */
  function showFatal(msg, err) {
    if (game.fatal) return;
    game.fatal = true;
    try {
      var box = document.getElementById('fatal');
      var detail = document.getElementById('fatal-detail');
      if (box) box.style.display = 'flex';
      if (detail) {
        detail.textContent =
          msg +
          (err ? '\n\n' + (err.stack || err.message || String(err)) : '') +
          '\n\n提示：按 F12 打开控制台查看完整错误。';
      }
    } catch (e) { /* ignore */ }
    try { console.error('[HorizonRush]', msg, err); } catch (e) { /* ignore */ }
  }

  function validateModules() {
    var missing = [];
    if (!HR.Track || typeof HR.Track.generate !== 'function') missing.push('js/track.js（HR.Track.generate）');
    if (!HR.Physics || typeof HR.Physics.makeCar !== 'function' ||
        typeof HR.Physics.step !== 'function' || typeof HR.Physics.resolveCollisions !== 'function' ||
        typeof HR.Physics.resetToTrack !== 'function') missing.push('js/car.js（HR.Physics）');
    if (!HR.AI || typeof HR.AI.createDriver !== 'function') missing.push('js/ai.js（HR.AI.createDriver）');
    if (!HR.Renderer || typeof HR.Renderer.init !== 'function' ||
        typeof HR.Renderer.drawFrame !== 'function') missing.push('js/render.js（HR.Renderer）');
    if (!HR.UI || typeof HR.UI.init !== 'function' || typeof HR.UI.showScreen !== 'function' ||
        typeof HR.UI.updateHUD !== 'function') missing.push('js/ui.js（HR.UI）');
    return missing;
  }

  /* ============================================================
   * 输入
   * ============================================================ */
  function makeInput() {
    return {
      keys: {},
      throttle: 0,
      brake: 0,
      steer: 0,
      handbrake: 0,
      nitro: false,
      update: function (dt) {
        var keys = this.keys;
        var th = 0, br = 0, st = 0, hb = 0, nos = false;
        if (keys['KeyW'] || keys['ArrowUp']) th = 1;
        if (keys['KeyS'] || keys['ArrowDown']) br = 1;
        if (keys['KeyA'] || keys['ArrowLeft']) st -= 1;
        if (keys['KeyD'] || keys['ArrowRight']) st += 1;
        if (keys['Space']) hb = 1;
        if (keys['ShiftLeft'] || keys['ShiftRight']) nos = true;

        // 手柄（可选，失败静默）
        try {
          if (navigator.getGamepads) {
            var pads = navigator.getGamepads();
            for (var i = 0; i < pads.length; i++) {
              var pad = pads[i];
              if (!pad || !pad.connected) continue;
              var ax = pad.axes && pad.axes.length > 0 ? pad.axes[0] : 0;
              if (typeof ax === 'number' && isFinite(ax) && Math.abs(ax) > 0.14) st = U.clamp(st + ax, -1, 1);
              var pth = 0, pbr = 0;
              if (pad.buttons && pad.buttons.length > 7) {
                pth = pad.buttons[7] ? (pad.buttons[7].value || (pad.buttons[7].pressed ? 1 : 0)) : 0;
                pbr = pad.buttons[6] ? (pad.buttons[6].value || (pad.buttons[6].pressed ? 1 : 0)) : 0;
              }
              th = Math.max(th, pth);
              br = Math.max(br, pbr);
              if (pad.buttons && pad.buttons.length > 2) {
                if (pad.buttons[0] && pad.buttons[0].pressed) hb = 1;
                if (pad.buttons[2] && pad.buttons[2].pressed) nos = true;
              }
              break;
            }
          }
        } catch (e) { /* ignore */ }

        st = U.clamp(st, -1, 1);
        this.throttle = th;
        this.brake = br;
        this.handbrake = hb;
        this.nitro = nos;
        this.steer = U.damp(this.steer, st, 10, dt);
        if (Math.abs(this.steer) < 0.001) this.steer = 0;
      },
      clear: function () {
        this.keys = {};
        this.throttle = 0; this.brake = 0; this.steer = 0; this.handbrake = 0; this.nitro = false;
      }
    };
  }

  var playerInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: false };
  function updatePlayerInput() {
    playerInput.throttle = game.input.throttle;
    playerInput.brake = game.input.brake;
    playerInput.steer = game.input.steer;
    playerInput.handbrake = game.input.handbrake;
    playerInput.nitro = game.input.nitro;
  }

  function onKeyDown(e) {
    initAudio();
    var code = e.code;
    if (code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' ||
        code === 'ArrowRight' || code === 'Space' || code === 'Tab' || code === 'Enter') {
      try { e.preventDefault(); } catch (er) { /* ignore */ }
    }
    game.input.keys[code] = true;
    if (e.repeat) return;
    switch (code) {
      case 'Escape':
      case 'KeyP':
        togglePause();
        break;
      case 'KeyC':
        cycleCamera();
        break;
      case 'KeyR':
        resetControlledCar();
        break;
      case 'KeyH':
        toggleControl();
        break;
      case 'Tab':
        cycleSpectateCar();
        break;
      case 'Enter':
        if (game.race && game.race.mode === 'spectate') takeOverCar(game.race.cameraCar);
        break;
      case 'KeyT':
        cycleSpectateSpeed();
        break;
      case 'KeyM':
        toggleMute();
        break;
      default:
        break;
    }
  }

  function onKeyUp(e) {
    game.input.keys[e.code] = false;
  }

  function onBlur() {
    game.input.clear();
    if (game.race && game.race.mode !== 'attract' && game.race.state !== 'finished' && !game.paused) {
      pauseGame();
    }
  }

  function setupInput() {
    game.input = makeInput();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerdown', initAudio, true);
  }

  function initAudio() {
    if (game.audioReady) return;
    game.audioReady = true;
    try {
      if (HR.Audio && typeof HR.Audio.init === 'function') {
        HR.Audio.init();
        audio('setVolume', [game.settings.volume]);
        audio('setEnabled', [game.settings.sfx]);
        audio('setMusicEnabled', [game.settings.music]);
      }
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
   * 开场演示赛（标题背景） / 主循环
   * ============================================================ */
  function makeAttractRace() {
    var track = HR.Track.generate({
      seed: 777,
      name: '地平线嘉年华 · 环线',
      lengthKm: 4.4,
      zones: ['festival', 'coast', 'desert', 'city']
    });
    var cars = [];
    var slots = track.gridSlots || [];
    var diff = getDifficulty('ace');
    for (var i = 0; i < HR.CARS.length; i++) {
      var spec = HR.CARS[i];
      var slot = slots[i] || { s: 0, lateral: 0 };
      var car = HR.Physics.makeCar(spec, { id: spec.id, name: spec.driver, s: slot.s, x: slot.lateral });
      car.spec = spec;
      car.control = 'ai';
      initCarRaceFields(car, slot.s, track);
      attachAI(car, track, diff, 'attract-' + spec.id);
      cars.push(car);
    }
    var race = makeRaceShell('attract', track, cars, 9999, null, diff);
    race.state = 'racing';
    race.cameraMode = 'trackside';
    race.cameraCar = cars[0];
    race.cameraTimer = 5;
    race.env = { timeOfDay: 18.5, weather: 'clear' };
    updateStandings(race);
    return race;
  }

  function startAttract() {
    try {
      if (!game.attract) game.attract = makeAttractRace();
      game.race = game.attract;
      game.appMode = 'menu';
    } catch (e) {
      console.warn('[HorizonRush] 演示赛创建失败（不影响菜单）', e);
      game.attract = null;
      game.race = null;
    }
  }

  function loop(ts) {
    if (game.fatal) return;
    requestAnimationFrame(loop);
    var now = (typeof ts === 'number' ? ts : 0) / 1000;
    var dt = game.lastTs > 0 ? U.clamp(now - game.lastTs, 0, 0.1) : 0.016;
    game.lastTs = now;
    game.frameDt = dt;
    game.timeAccum += dt;
    game.fps = U.damp(game.fps, dt > 0.0001 ? 1 / dt : 60, 4, dt);

    try {
      game.input.update(dt);
      updatePlayerInput();

      var race = game.race;
      if (race) {
        var simulate = false;
        if (race.mode === 'attract') simulate = true;
        else if (!game.paused && race.state !== 'finished') simulate = true;
        if (simulate) simulateRace(race, dt);
        drawRace(race, dt);
        if (race.mode !== 'attract' && race.state !== 'finished') {
          // 比赛中每帧刷新 HUD；完赛时保留最后一帧 HUD 即可（结果界面覆盖）
          updateHud(race);
        }
        if (race.mode !== 'attract') updateAudio(race);
        else audio('update', [{ car: null, cars: race.cars, track: race.track, mode: 'attract', paused: true, raceState: race.state, dt: dt, time: game.timeAccum }]);
      }
    } catch (e) {
      showFatal('游戏循环发生错误，已停止渲染以避免刷屏。', e);
      game.fatal = true;
      audio('suspend', []);
    }
  }

  /* ============================================================
   * 比赛构建
   * ============================================================ */
  function initCarRaceFields(car, startS, track) {
    car.prevS = startS;
    car.dist = startS - track.length;   // 起跑线(s=0)之后的负进度
    car.lapIndex = -1;
    car.lap = 1;
    car.lapStartTime = 0;
    car.lastLap = 0;
    car.bestLap = 0;
    car.totalTime = 0;
    car.finished = false;
    car.finishTime = 0;
    car.place = 1;
    car.isPlayer = false;
    car.aiStuckTime = 0;
    car.offroadTime = 0;
  }

  function attachAI(car, track, difficulty, seedTag) {
    try {
      var spec = car.spec;
      var p = spec.ai || { aggression: 0.7, cornering: 0.8, consistency: 0.8, braking: 0.8, tag: '稳健' };
      var jitter = (U.rng(U.hashSeed(tagSeed(seedTag, spec.id)))() - 0.5) * 0.06;
      var skill = U.clamp((difficulty.aiSkill || 0.7) + (p.cornering - 0.8) * 0.18 + jitter, 0.3, 0.99);
      var aggression = U.clamp((difficulty.aiAggression || 0.6) * (0.75 + 0.5 * (p.aggression || 0.7)), 0, 1);
      car.ai = HR.AI.createDriver(car, track, {
        skill: skill,
        aggression: aggression,
        seed: U.hashSeed(seedTag + '|' + spec.id),
        personality: p
      });
      car.aiSkill = skill;
      car.aiAggression = aggression;
    } catch (e) {
      car.ai = null;
      console.warn('[HorizonRush] AI 创建失败', car.spec && car.spec.id, e);
    }
  }

  function tagSeed(tag, id) { return String(tag) + '#' + String(id); }

  function makeRaceShell(mode, track, cars, laps, event, difficulty) {
    var race = {
      mode: mode,
      track: track,
      cars: cars,
      laps: laps,
      event: event,
      eventId: event ? event.id : null,
      difficulty: difficulty,
      state: 'racing',
      countdown: 0,
      displayCountdown: 0,
      time: 0,
      acc: 0,
      goTimer: 0,
      playerCar: null,
      cameraCar: cars.length ? cars[0] : null,
      cameraMode: 'chase',
      cameraTimer: 6,
      autopilot: false,
      spectateSpeed: 1,
      standings: cars.slice(),
      finalStandings: null,
      results: null,
      activeCars: [],
      msg: '',
      msgTimer: 0,
      env: { timeOfDay: 18, weather: 'clear' },
      noChampPoints: false,
      simulated: false,
      attract: mode === 'attract'
    };
    return race;
  }

  function aiSeedTag(config, mode) {
    return (config.eventId || 'free') + '|' + (config.difficultyId || 'pro') + '|' + mode;
  }

  /**
   * 构建比赛。纯逻辑，不触碰 UI/音频/渲染器（selftest 可安全调用）。
   * config = { mode:'race'|'champ'|'spectate'|'free', eventId, carId, difficultyId, autopilot }
   */
  function buildRace(config) {
    config = config || {};
    var mode = config.mode || 'race';
    var event = mode === 'free'
      ? {
        id: 'free',
        name: HR.FREE_TRACK.name,
        subtitle: 'FREE ROAM',
        laps: 0,
        timeOfDay: 18.2,
        weather: 'clear',
        reward: 0,
        track: HR.FREE_TRACK
      }
      : getEvent(config.eventId || HR.EVENTS[0].id);
    var track;
    if (mode === 'free') {
      track = HR.Track.generate({
        seed: HR.FREE_TRACK.seed,
        name: HR.FREE_TRACK.name,
        lengthKm: HR.FREE_TRACK.lengthKm,
        zones: HR.FREE_TRACK.zones
      });
    } else {
      track = HR.Track.generate({
        seed: event.track.seed,
        name: event.name,
        lengthKm: event.track.lengthKm,
        zones: event.track.zones
      });
    }
    var difficulty = getDifficulty(config.difficultyId || game.settings.difficulty);
    var playerSpec = getSpec(config.carId);
    var slots = track.gridSlots && track.gridSlots.length >= 8 ? track.gridSlots : fallbackGridSlots(track);

    // ---- 决定每个车位的车 ----
    var slotCars = new Array(HR.CARS.length).fill(null); // spec 或 null
    var playerSlot = 7;
    var isPlayerRace = mode !== 'spectate';

    if (mode === 'spectate' || mode === 'free') {
      // 全部 8 辆车；free 的玩家车在最后；spectate 全 AI
      var playerCarSpec = playerSpec;
      if (isPlayerRace) {
        var aiSpecs = HR.CARS.filter(function (s) { return s.id !== playerCarSpec.id; });
        var sorted = aiSpecs.slice().sort(function (a, b) { return b.pi - a.pi; });
        for (var i = 0; i < sorted.length; i++) slotCars[i] = sorted[i];
        slotCars[playerSlot] = playerCarSpec;
      } else {
        var allByPi = HR.CARS.slice().sort(function (a, b) { return b.pi - a.pi; });
        for (var j = 0; j < allByPi.length; j++) slotCars[j] = allByPi[j];
      }
    } else if (mode === 'champ' && game.champ && game.champIndexValid && game.champ.carId) {
      // 冠军赛：按积分排位（第一站玩家最后）
      var order = champGridOrder(game.champ);
      for (var k = 0; k < order.length; k++) {
        var key = order[k].key;
        slotCars[k] = (key === 'player') ? getSpec(game.champ.carId) : getSpec(key);
      }
    } else {
      // 普通比赛：玩家最后发车，AI 按 PI 排序
      var others = HR.CARS.filter(function (s) { return s.id !== playerSpec.id; });
      var othersSorted = others.slice().sort(function (a, b) { return b.pi - a.pi; });
      for (var m = 0; m < othersSorted.length; m++) slotCars[m] = othersSorted[m];
      slotCars[playerSlot] = playerSpec;
    }

    var playerName = game.playerName || '你';
    var cars = [];
    var playerCar = null;
    var autopilot = (config.autopilot != null) ? !!config.autopilot : !!game.settings.autopilot;
    var seedTag = aiSeedTag(config, mode);
    for (var slotIndex = 0; slotIndex < slotCars.length; slotIndex++) {
      var spec = slotCars[slotIndex];
      if (!spec) continue;
      var slot = slots[slotIndex] || slots[slots.length - 1] || { s: 0, lateral: 0 };
      var isPlayer = isPlayerRace && spec.id === playerSpec.id && mode !== 'spectate';
      var carName = isPlayer ? playerName : (spec.driver || 'AI');
      var car = HR.Physics.makeCar(spec, { id: spec.id, name: carName, s: slot.s, x: slot.lateral });
      car.spec = spec;
      car.isPlayer = isPlayer;
      initCarRaceFields(car, slot.s, track);
      if (mode === 'free') car.dist = slot.s - track.length;
      attachAI(car, track, difficulty, seedTag);
      if (isPlayer && mode !== 'spectate') {
        playerCar = car;
        car.control = autopilot ? 'ai' : 'player';
      } else {
        car.control = 'ai';
      }
      cars.push(car);
    }
    if (!playerCar && mode !== 'spectate') {
      // 兜底：没有玩家车时把第一辆给玩家
      playerCar = cars[0] || null;
      if (playerCar) { playerCar.isPlayer = true; playerCar.control = 'player'; playerCar.name = playerName; }
    }

    var laps = (mode === 'free' || mode === 'spectate') ? (mode === 'spectate' ? event.laps : 0) : event.laps;
    var race = makeRaceShell(mode, track, cars, laps, event, difficulty);
    race.playerCar = playerCar;
    race.autopilot = autopilot;
    race.noChampPoints = !!config.noChampPoints;
    race.env = { timeOfDay: event.timeOfDay != null ? event.timeOfDay : 17.5, weather: event.weather || 'clear' };
    race.seedTag = seedTag;

    if (mode === 'spectate') {
      race.playerCar = null;
      var byPi = cars.slice().sort(function (a, b) { return b.spec.pi - a.spec.pi; });
      /* 观战界面允许选择“初始镜头车辆” */
      var wantCam = null;
      for (var wc = 0; wc < cars.length; wc++) {
        if (cars[wc].spec && cars[wc].spec.id === config.carId) { wantCam = cars[wc]; break; }
      }
      race.cameraCar = wantCam || byPi[0] || cars[0];
      race.cameraMode = 'trackside';
      race.cameraTimer = 6;
      race.state = 'countdown';
      race.countdown = 3.0;
      race.displayCountdown = 3;
    } else if (mode === 'free') {
      race.state = 'racing';
      race.cameraCar = playerCar || cars[0];
      race.cameraMode = game.settings.camera === 'hood' ? 'hood' : 'chase';
      race.time = 0;
      race.laps = 0;
    } else {
      race.state = 'countdown';
      race.countdown = 3.0;
      race.displayCountdown = 3;
      race.cameraCar = playerCar || cars[0];
      race.cameraMode = game.settings.camera === 'hood' ? 'hood' : 'chase';
    }
    if (mode === 'attract') {
      race.state = 'racing';
      race.cameraMode = 'trackside';
    }
    updateStandings(race);
    return race;
  }

  function fallbackGridSlots(track) {
    var slots = [];
    for (var i = 0; i < 8; i++) {
      slots.push({ s: U.wrap(track.startS - 6 - i * 7, track.length), lateral: (i % 2 === 0 ? -1.7 : 1.7) });
    }
    return slots;
  }

  function champGridOrder(champ) {
    var entries = [];
    var playerSpec = getSpec(champ.carId);
    var totalAI = 0;
    for (var i = 0; i < HR.CARS.length; i++) {
      var spec = HR.CARS[i];
      if (spec.id === playerSpec.id) continue;
      var pts = (champ.points && champ.points[spec.id]) || 0;
      totalAI += pts;
      entries.push({ key: spec.id, points: pts, pi: spec.pi });
    }
    entries.push({ key: 'player', points: champ.playerPoints || 0, pi: playerSpec.pi });
    var firstEvent = totalAI === 0 && (champ.playerPoints || 0) === 0;
    if (firstEvent) {
      /* 第一站：没有历史积分，按性能指数排位，玩家最后发车 */
      entries.sort(function (a, b) {
        if (a.key === 'player') return 1;
        if (b.key === 'player') return -1;
        return b.pi - a.pi;
      });
    } else {
      /* 之后：积分高者在前；同分时玩家优先（对玩家友好） */
      entries.sort(function (a, b) {
        if (b.points !== a.points) return b.points - a.points;
        if (a.key === 'player') return -1;
        if (b.key === 'player') return 1;
        return b.pi - a.pi;
      });
    }
    return entries;
  }

  /* ============================================================
   * 模拟（固定步长）
   * ============================================================ */
  var raceCtx = { cars: null, time: 0, targetCar: null };
  var zeroInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: false };

  function activeInputFor(race, car, dt) {
    if (car.control === 'player') {
      if (car.finished) return { throttle: 0, brake: 0.4, steer: 0, handbrake: 0, nitro: false };
      return playerInput;
    }
    if (!car.ai) attachAI(car, race.track, race.difficulty, race.seedTag || 'late');
    if (!car.ai) return zeroInput;
    try {
      return car.ai.think(car, race.track, raceCtx, dt) || zeroInput;
    } catch (e) {
      return zeroInput;
    }
  }

  function step(race, dt) {
    if (!race || game.fatal) return;
    dt = U.clamp(dt || 0.008333, 0, 0.05);
    if (race.state === 'countdown') {
      race.countdown -= dt;
      race.displayCountdown = Math.max(0, Math.ceil(race.countdown - 0.0001));
      if (race.countdown <= 0) {
        race.state = 'racing';
        race.countdown = 0;
        race.displayCountdown = 0;
        race.goTimer = 0.9;
        race.time = 0;
        race.msg = 'GO!';
        race.msgTimer = 0.9;
        for (var i = 0; i < race.cars.length; i++) {
          race.cars[i].lapStartTime = 0;
        }
        if (race.mode !== 'attract') audio('play', ['go']);
      }
      return;
    }
    if (race.state !== 'racing') return;

    if (race.goTimer > 0) race.goTimer -= dt;
    race.time += dt;

    raceCtx.cars = race.cars;
    raceCtx.time = race.time;
    raceCtx.targetCar = race.playerCar;

    var cars = race.cars;
    var active = race.activeCars;
    active.length = 0;
    for (var c = 0; c < cars.length; c++) {
      var car = cars[c];
      var input;
      if (car.finished) {
        // 已完赛车辆滑行/继续由 AI 带一圈，不再参与碰撞
        input = car.ai ? activeInputFor(race, car, dt) : { throttle: 0, brake: 0.35, steer: 0, handbrake: 0, nitro: false };
      } else {
        input = activeInputFor(race, car, dt);
        active.push(car);
      }
      try { HR.Physics.step(car, input, race.track, dt, race.time); } catch (e) { /* 单车站错误不拖垮整场 */ }
      progressCar(race, car, dt);
    }
    try { HR.Physics.resolveCollisions(active, race.track); } catch (e) { /* ignore */ }

    if (race.mode !== 'attract' && race.mode !== 'free') checkFinish(race);
  }

  function progressCar(race, car, dt) {
    var len = race.track.length;
    if (!(len > 0)) return;
    var ds = car.s - car.prevS;
    if (ds > len / 2) ds -= len;
    else if (ds < -len / 2) ds += len;
    if (!isFinite(ds)) ds = 0;
    car.prevS = car.s;
    car.dist += ds;
    if (car.s < 0 || car.s >= len) car.s = U.wrap(car.s, len);

    if (race.laps <= 0) return;
    var lapIdx = Math.floor(car.dist / len);
    if (lapIdx > car.lapIndex) {
      for (var k = car.lapIndex + 1; k <= lapIdx; k++) {
        if (k === 0) {
          car.lapStartTime = race.time;
        } else if (k >= 1 && !car.finished) {
          var lapTime = race.time - car.lapStartTime;
          if (lapTime > 0.5 && lapTime < 3600) {
            car.lastLap = lapTime;
            if (!car.bestLap || lapTime < car.bestLap) car.bestLap = lapTime;
            if (race.playerCar === car) {
              audio('play', ['checkpoint']);
              if (race.laps > 0 && k === race.laps - 1) {
                race.msg = '最后一圈！';
                race.msgTimer = 2.6;
              }
            }
            car.lapStartTime = race.time;
          }
        }
      }
      car.lapIndex = lapIdx;
      car.lap = U.clamp(lapIdx + 1, 1, race.laps);
    }
  }

  function checkFinish(race) {
    var len = race.track.length;
    var cars = race.cars;
    var finishedCount = 0;
    var i;
    for (i = 0; i < cars.length; i++) if (cars[i].finished) finishedCount++;
    for (i = 0; i < cars.length; i++) {
      var car = cars[i];
      if (car.finished) continue;
      if (car.dist >= race.laps * len - 0.001) {
        car.finished = true;
        car.finishTime = race.time + finishedCount * 0.001;
        finishedCount++;
        car.totalTime = car.finishTime;
        car.lap = race.laps;
      }
    }
    return race;
  }

  /* ============================================================
   * 排名 / 完赛
   * ============================================================ */
  function cmpCars(a, b) {
    if (a.finished && b.finished) return (a.finishTime || 0) - (b.finishTime || 0);
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    return b.dist - a.dist;
  }

  function updateStandings(race) {
    if (!race || !race.cars) return [];
    var arr = race.cars.slice();
    arr.sort(cmpCars);
    for (var i = 0; i < arr.length; i++) arr[i].place = i + 1;
    race.standings = arr;
    return arr;
  }

  function simulateRace(race, frameDt) {
    var speed = (race.mode === 'spectate' && !race.playerCar) ? (race.spectateSpeed || 1) : 1;
    var stepDt = 1 / 120;
    var scaled = frameDt * speed;
    race.acc += scaled;
    var maxSteps = Math.min(40, Math.ceil(scaled / stepDt) + 2);
    var n = 0;
    while (race.acc >= stepDt && n < maxSteps) {
      step(race, stepDt);
      race.acc -= stepDt;
      n++;
      if (race.state !== 'racing' && race.state !== 'countdown') break;
    }
    if (n >= maxSteps) race.acc = 0;

    updateStandings(race);
    updateDirector(race, frameDt);
    rescueCars(race);
    updateCountdownAudio(race);
    updateRaceSfx(race);
    if (race.msgTimer > 0) { race.msgTimer -= frameDt; if (race.msgTimer <= 0) race.msg = ''; }
    maybeEndRace(race);
  }

  /** 撞击 / 氮气 / 换挡音效（以镜头车为准，每帧比较一次状态跳变） */
  function updateRaceSfx(race) {
    if (race.mode === 'attract') return;
    var car = race.cameraCar || race.playerCar;
    if (!car) return;
    var prev = race._sfxState;
    if (!prev) {
      race._sfxState = { bump: car.bump || 0, boosting: !!car.boosting, gear: car.gear || 0 };
      return;
    }
    if ((car.bump || 0) > 0.55 && prev.bump <= 0.55) audio('play', ['collision']);
    if (car.boosting && !prev.boosting) audio('play', ['nitro']);
    if (prev.gear > 0 && car.gear !== prev.gear) audio('play', ['shift']);
    prev.bump = car.bump || 0;
    prev.boosting = !!car.boosting;
    prev.gear = car.gear || 0;
  }

  function updateDirector(race, dt) {
    if (race.mode !== 'attract' && !(race.mode === 'spectate' && !race.playerCar)) return;
    race.cameraTimer -= dt;
    if (race.cameraTimer > 0) return;
    race.cameraTimer = race.mode === 'attract' ? 6.5 : 8;
    var arr = race.standings || race.cars;
    if (!arr.length) return;
    // 65% 概率选前三名中的一辆（避免总是同一辆），否则随机
    var r = Math.random();
    var pick;
    if (r < 0.65) {
      var top = Math.min(3, arr.length);
      pick = arr[Math.floor(Math.random() * top)];
    } else {
      pick = arr[Math.floor(Math.random() * arr.length)];
    }
    if (pick && pick !== race.cameraCar) race.cameraCar = pick;
  }

  function rescueCars(race) {
    var cars = race.cars;
    for (var i = 0; i < cars.length; i++) {
      var car = cars[i];
      if (car.finished || car.control !== 'ai' || !car.ai) continue;
      if (car.aiStuckTime > 2.5 && car.v < 3) {
        try { HR.Physics.resetToTrack(car, race.track); } catch (e) { /* ignore */ }
        car.aiStuckTime = 0;
      }
      if (car.offroad) car.offroadTime = (car.offroadTime || 0) + game.frameDt;
      else car.offroadTime = 0;
      if (car.offroadTime > 4 && car.v < 8) {
        try { HR.Physics.resetToTrack(car, race.track); } catch (e) { /* ignore */ }
        car.offroadTime = 0;
        car.aiStuckTime = 0;
      }
    }
  }

  function updateCountdownAudio(race) {
    if (race.mode === 'attract') return;
    if (race._lastCount === undefined) race._lastCount = -1;
    if (race.state === 'countdown') {
      var d = race.displayCountdown;
      if (d !== race._lastCount) {
        race._lastCount = d;
        if (d === 3 || d === 2 || d === 1) audio('play', ['countdown']);
      }
    }
  }

  function maybeEndRace(race) {
    if (!race || race.state !== 'racing') return false;
    if (race.mode === 'attract' || race.mode === 'free') return false;
    if (race.mode === 'spectate') {
      /* 观战中若已接管某辆车，则按玩家完赛结算；否则等所有 AI 完赛 */
      if (race.playerCar && race.playerCar.finished) { endRace(race); return true; }
      var all = true;
      for (var i = 0; i < race.cars.length; i++) if (!race.cars[i].finished) { all = false; break; }
      if (all || race.time > 1500) { endRace(race); return true; }
      return false;
    }
    if (race.playerCar && race.playerCar.finished) { endRace(race); return true; }
    if (race.time > 1200) { endRace(race); return true; }
    return false;
  }

  function updateRecords(race, car) {
    if (!car) return null;
    var key = race.event ? race.event.id : 'free';
    if (!race.event) return null;
    var raw = game.save.records[key];
    var rec = (raw && typeof raw === 'object') ? raw : {};
    var updated = false;
    if (car.bestLap > 0 && (!rec.bestLap || car.bestLap < rec.bestLap)) {
      rec.bestLap = car.bestLap;
      rec.bestLapText = U.formatTime(car.bestLap);
      updated = true;
    }
    if (car.finished && car.finishTime > 0 && (!rec.bestTotal || car.finishTime < rec.bestTotal)) {
      rec.bestTotal = car.finishTime;
      rec.bestTotalText = U.formatTime(car.finishTime);
      updated = true;
    }
    if (updated) {
      rec.updatedAt = Date.now();
      game.save.records[key] = rec;
      return true;
    }
    return false;
  }

  function buildResultsData(race) {
    var standings = race.finalStandings || updateStandings(race);
    var rows = [];
    var firstFinish = null;
    for (var i = 0; i < standings.length; i++) {
      var car = standings[i];
      if (car.finished && !firstFinish) firstFinish = car;
    }
    var champ = (race.mode === 'champ');
    for (var j = 0; j < standings.length; j++) {
      var c = standings[j];
      var isP = race.playerCar === c;
      var gap = '—';
      if (c.finished && firstFinish && firstFinish.finishTime > 0) {
        gap = U.formatDelta(c.finishTime - firstFinish.finishTime);
      }
      rows.push({
        place: j + 1,
        name: isP ? playerNameOr() : (c.name || (c.spec && c.spec.driver) || 'AI'),
        carName: c.spec ? c.spec.name : '—',
        carColor: c.spec ? c.spec.color : '#888',
        isPlayer: isP,
        totalTime: c.finished ? U.formatTime(c.finishTime) : '未完赛',
        bestLap: c.bestLap > 0 ? U.formatTime(c.bestLap) : '--',
        gap: gap,
        points: champ ? (HR.CHAMP_POINTS[j] || 0) : 0,
        ai: c.control === 'ai'
      });
    }
    var player = race.playerCar;
    var playerPlace = player ? player.place : 0;
    var actions;
    if (race.mode === 'champ') {
      var champFar = game.champ && game.champ.index >= game.champ.events.length;
      actions = champFar ? ['next', 'title'] : ['next', 'title'];
    } else if (race.mode === 'spectate') {
      actions = ['again', 'title'];
    } else {
      actions = ['again', 'title'];
    }
    var credits = 0;
    if (race.mode !== 'spectate' && playerPlace > 0 && race.event) {
      credits = Math.round((race.event.reward || 0) * (9 - playerPlace) / 8);
      credits = Math.max(50, credits);
    }
    var nextLabel = '下一站';
    if (race.mode === 'champ' && game.champ) {
      var nextIdx = game.champ.index + 1; // 本场结算后 index++，下一站是 index+1
      if (nextIdx < game.champ.events.length) {
        nextLabel = '下一站 · ' + getEvent(game.champ.events[nextIdx]).name;
      } else {
        nextLabel = '查看最终积分榜';
      }
    }
    return {
      title: race.mode === 'champ' ? '冠军赛 · 第 ' + (game.champ ? Math.min(game.champ.index + 1, game.champ.events.length) : 1) + ' 站' : (race.event ? race.event.name : '比赛'),
      eventName: race.event ? race.event.name : '',
      trackName: race.track ? race.track.name : '',
      laps: race.laps,
      rows: rows,
      playerPlace: playerPlace,
      credits: credits,
      bestLapText: player && player.bestLap > 0 ? U.formatTime(player.bestLap) : '--',
      actions: actions,
      nextLabel: nextLabel,
      mode: race.mode
    };
  }

  function playerNameOr() {
    return game.playerName || '你';
  }

  function computeChampStandings() {
    var champ = game.champ;
    if (!champ) return [];
    var entries = [];
    entries.push({ key: 'player', points: champ.playerPoints || 0, isPlayer: true });
    for (var i = 0; i < HR.CARS.length; i++) {
      var spec = HR.CARS[i];
      if (spec.id === champ.carId) continue;
      entries.push({ key: spec.id, points: (champ.points && champ.points[spec.id]) || 0, isPlayer: false });
    }
    entries.sort(function (a, b) {
      if (b.points !== a.points) return b.points - a.points;
      if (a.isPlayer) return -1;
      if (b.isPlayer) return 1;
      return 0;
    });
    var rows = [];
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      var spec2 = e.isPlayer ? getSpec(champ.carId) : getSpec(e.key);
      rows.push({
        place: j + 1,
        name: e.isPlayer ? playerNameOr() : (spec2.driver || 'AI'),
        carName: spec2.name,
        carColor: spec2.color,
        points: e.points,
        isPlayer: e.isPlayer
      });
    }
    return rows;
  }

  function buildChampData() {
    var standings = computeChampStandings();
    var champ = game.champ;
    var finished = !champ || champ.finished;
    var nextLabel = '返回标题';
    if (champ && !finished && champ.index < champ.events.length) {
      var ev = getEvent(champ.events[champ.index]);
      nextLabel = '第 ' + (champ.index + 1) + ' 站 · ' + ev.name;
    }
    return {
      standings: standings,
      nextEventId: (champ && !finished && champ.index < champ.events.length) ? champ.events[champ.index] : null,
      nextLabel: nextLabel,
      champion: !!(standings.length && standings[0].isPlayer),
      finished: finished
    };
  }

  function endRace(race) {
    if (!race || race.state === 'finished') return;
    race.state = 'finished';
    race.finalStandings = updateStandings(race);
    try {
      race.results = buildResultsData(race);
    } catch (e) {
      console.warn('[HorizonRush] 结算数据构建异常，使用兜底结算', e);
      race.results = {
        title: '比赛结束',
        eventName: race.event ? race.event.name : '',
        trackName: race.track ? race.track.name : '',
        laps: race.laps,
        rows: [],
        playerPlace: 0,
        credits: 0,
        bestLapText: '--',
        actions: ['title'],
        nextLabel: '返回标题',
        mode: race.mode
      };
    }

    // ---- 存档：记录 / 战绩 / 积分 ----
    var player = race.playerCar;
    if (player && race.mode !== 'spectate') {
      try {
        updateRecords(race, player);
        var st = game.save.stats || {};
        st.races = (st.races || 0) + 1;
        if (player.place === 1) st.wins = (st.wins || 0) + 1;
        if (player.place <= 3) st.podiums = (st.podiums || 0) + 1;
        if (player.bestLap > 0 && (!st.bestLap || player.bestLap < st.bestLap)) st.bestLap = player.bestLap;
        game.save.stats = st;
        game.save.credits += race.results.credits;
      } catch (e) { /* ignore */ }
    }

    // ---- 冠军赛积分 ----
    if (race.mode === 'champ' && game.champ && !race.noChampPoints) {
      try { applyChampResult(race); } catch (e) { console.warn('冠军赛结算失败', e); }
    }
    try { saveGame(); } catch (e) { /* ignore */ }

    audio('play', ['finish']);
    game.paused = false;
    game.appMode = 'race';
    try {
      HR.UI.showScreen('results', race.results);
      game.screenOpen = true;
    } catch (e) { showFatal('结算界面显示失败', e); }
  }

  function applyChampResult(race) {
    var champ = game.champ;
    if (!champ) return;
    var standings = race.finalStandings || [];
    for (var i = 0; i < standings.length; i++) {
      var car = standings[i];
      var pts = HR.CHAMP_POINTS[i] || 0;
      if (race.playerCar === car) champ.playerPoints = (champ.playerPoints || 0) + pts;
      else if (car.spec) champ.points[car.spec.id] = (champ.points[car.spec.id] || 0) + pts;
    }
    champ.index++;
    champ.results.push({ eventId: race.eventId, rows: race.results ? race.results.rows : [] });
    if (champ.index >= champ.events.length) {
      champ.finished = true;
      champ.viewedFinal = false;
      var standingsFinal = computeChampStandings();
      if (standingsFinal.length && standingsFinal[0].isPlayer) {
        game.save.stats.championships = (game.save.stats.championships || 0) + 1;
        game.save.championships.push({
          date: new Date().toISOString().slice(0, 10),
          carId: champ.carId,
          points: champ.playerPoints,
          champion: true
        });
      } else {
        game.save.championships.push({
          date: new Date().toISOString().slice(0, 10),
          carId: champ.carId,
          points: champ.playerPoints,
          champion: false
        });
      }
    }
    saveGame();
  }

  /* ============================================================
   * 帧渲染 / HUD / 音频
   * ============================================================ */
  function drawRace(race, dt) {
    if (!HR.Renderer || typeof HR.Renderer.drawFrame !== 'function') return;
    var camCar = race.cameraCar || race.playerCar || (race.cars && race.cars[0]) || null;
    var shake = 0;
    if (camCar) {
      shake = U.clamp((camCar.bump || 0) * 0.75 + (camCar.offroad ? 0.1 : 0) + (camCar.drifting ? 0.02 : 0), 0, 1);
    }
    var frame = {
      track: race.track,
      cars: race.cars,
      time: game.timeAccum,
      dt: dt,
      camera: {
        mode: race.cameraMode || 'chase',
        targetCar: camCar,
        shake: shake
      },
      environment: race.env || { timeOfDay: 18, weather: 'clear' },
      race: { state: race.state, countdown: race.displayCountdown || 0 },
      player: race.playerCar || null,
      quality: game.settings ? game.settings.quality : 'high'
    };
    try {
      HR.Renderer.drawFrame(frame);
    } catch (e) {
      // 渲染错误只记录一次，不打断游戏
      if (!game._renderWarned) {
        game._renderWarned = true;
        console.warn('[HorizonRush] 渲染异常', e);
      }
    }
  }

  function buildHud(race) {
    var standings = race.standings || updateStandings(race);
    var controlled = race.playerCar || race.cameraCar;
    var rows = [];
    for (var i = 0; i < standings.length; i++) {
      var c = standings[i];
      rows.push({
        id: c.id,
        name: c.name,
        carName: c.spec ? c.spec.name : '',
        carColor: c.spec ? c.spec.color : '#888',
        place: i + 1,
        lap: c.lap,
        dist: c.dist,
        finished: c.finished,
        control: c.control
      });
    }
    var cd = controlled;
    var isSpectate = race.mode === 'spectate';
    var hud = {
      mode: race.mode,
      car: controlled || null,
      cars: race.cars,
      track: race.track,
      race: {
        state: race.state,
        countdown: race.displayCountdown || 0,
        lap: cd ? cd.lap : 0,
        laps: race.laps,
        position: cd ? cd.place : 0,
        totalCars: race.cars.length,
        raceTime: race.time,
        lastLap: cd ? cd.lastLap : 0,
        bestLap: cd ? cd.bestLap : 0,
        lapDelta: (cd && cd.lastLap > 0 && cd.bestLap > 0) ? (cd.lastLap - cd.bestLap) : null,
        standings: rows,
        message: race.msg || ''
      },
      cameraMode: race.cameraMode,
      autopilot: !!(race.playerCar && cd === race.playerCar && cd.control === 'ai'),
      muted: !game.settings.sfx,
      spectate: isSpectate,
      spectateSpeed: game.spectateSpeed,
      fps: Math.round(game.fps),
      settings: { units: game.settings.units, showHints: game.settings.showHints }
    };
    return hud;
  }

  function updateHud(race) {
    try {
      if (HR.UI && typeof HR.UI.updateHUD === 'function') HR.UI.updateHUD(buildHud(race));
    } catch (e) {
      if (!game._hudWarned) { game._hudWarned = true; console.warn('[HorizonRush] HUD 异常', e); }
    }
  }

  function updateAudio(race) {
    var camCar = race.cameraCar || race.playerCar || null;
    audio('update', [{
      car: camCar,
      cars: race.cars,
      track: race.track,
      mode: race.mode,
      paused: game.paused || race.state === 'finished',
      raceState: race.state,
      dt: game.frameDt,
      time: game.timeAccum
    }]);
  }

  /* ============================================================
   * 操作
   * ============================================================ */
  function controlledCar() {
    var race = game.race;
    if (!race) return null;
    return race.playerCar || race.cameraCar || null;
  }

  function togglePause() {
    var race = game.race;
    if (!race || race.mode === 'attract') return;
    if (race.state === 'finished') return;
    if (game.paused) resumeGame();
    else pauseGame();
  }

  function buildPauseData() {
    var race = game.race || {};
    var controlled = controlledCar();
    var spectateCars = [];
    if (race.cars) {
      for (var i = 0; i < race.cars.length; i++) {
        var c = race.cars[i];
        spectateCars.push({
          id: c.id,
          name: c.name,
          carName: c.spec ? c.spec.name : '',
          isPlayer: race.playerCar === c,
          control: c.control
        });
      }
    }
    return {
      mode: race.mode || 'race',
      autopilot: controlled ? controlled.control === 'ai' : false,
      muted: !game.settings.sfx,
      music: !!game.settings.music,
      cameraMode: race.cameraMode || 'chase',
      spectateSpeed: game.spectateSpeed,
      canTakeOver: race.mode === 'spectate' && !race.playerCar,
      spectateCars: spectateCars
    };
  }

  function pauseGame() {
    if (!game.race || game.race.mode === 'attract') return;
    game.paused = true;
    game.screenOpen = true;
    audio('play', ['ui_back']);
    try { HR.UI.showScreen('pause', buildPauseData()); } catch (e) { /* ignore */ }
  }

  function resumeGame() {
    game.paused = false;
    game.screenOpen = false;
    audio('play', ['ui_confirm']);
    try { HR.UI.hideScreens(); } catch (e) { /* ignore */ }
  }

  function cycleCamera() {
    var race = game.race;
    if (!race || race.mode === 'attract') return;
    var modes = (race.mode === 'spectate' && !race.playerCar)
      ? ['trackside', 'chase', 'heli']
      : ['chase', 'hood'];
    var idx = modes.indexOf(race.cameraMode);
    race.cameraMode = modes[(idx + 1) % modes.length];
    toast('视角：' + cameraLabel(race.cameraMode));
  }

  function cameraLabel(m) {
    if (m === 'hood') return '引擎盖';
    if (m === 'trackside') return '赛道机位';
    if (m === 'heli') return '航拍';
    return '追尾';
  }

  function resetControlledCar() {
    var race = game.race;
    if (!race || !race.playerCar) return;
    try {
      HR.Physics.resetToTrack(race.playerCar, race.track);
      race.playerCar.aiStuckTime = 0;
      toast('已复位到赛道');
      audio('play', ['rescue']);
    } catch (e) { /* ignore */ }
  }

  function toggleControl() {
    var race = game.race;
    if (!race || race.mode === 'attract') return;
    var car = race.playerCar || race.cameraCar;
    if (!car) return;
    if (race.mode === 'spectate' && !race.playerCar) {
      takeOverCar(car);
      return;
    }
    if (car.control === 'player') {
      car.control = 'ai';
      if (!car.ai) attachAI(car, race.track, race.difficulty, race.seedTag || 'late');
      if (race.playerCar) race.playerCar.isPlayer = false;
      if (race.mode === 'spectate') {
        // 观战中把车交还 AI：回到纯观战/导演机位
        race.playerCar = null;
        race.cameraMode = 'trackside';
        race.cameraTimer = 4;
      }
      toast('已将 ' + (car.spec ? car.spec.name : '赛车') + ' 交给 AI 驾驶');
    } else {
      car.control = 'player';
      if (race.playerCar) race.playerCar.isPlayer = false;
      race.playerCar = car;
      car.isPlayer = true;
      toast('你已接管 ' + (car.spec ? car.spec.name : '赛车'));
    }
    game.settings.autopilot = car.control === 'ai';
    saveGame();
    if (game.paused) { try { HR.UI.showScreen('pause', buildPauseData()); } catch (e) { /* ignore */ } }
  }

  function takeOverCar(car) {
    var race = game.race;
    if (!race || !car) return;
    if (car.finished) { toast('该车已完赛，无法接管'); return; }
    if (car.control === 'player') { toast('这辆车已经在你的操控下'); return; }
    // 确保场上只有一辆车由玩家控制
    for (var i = 0; i < race.cars.length; i++) {
      var c = race.cars[i];
      if (c !== car && c.control === 'player') {
        c.control = 'ai';
        c.isPlayer = false;
        if (!c.ai) attachAI(c, race.track, race.difficulty, race.seedTag || 'late');
      }
    }
    car.control = 'player';
    car.isPlayer = true;
    if (race.playerCar && race.playerCar !== car) race.playerCar.isPlayer = false;
    race.playerCar = car;
    race.cameraCar = car;
    race.cameraMode = (game.settings.camera === 'hood') ? 'hood' : 'chase';
    game.paused = false;
    game.screenOpen = false;
    game.settings.autopilot = false;
    audio('play', ['ui_confirm']);
    toast('已接管 ' + (car.spec ? car.spec.name : '赛车') + ' · 按 H 交还 AI');
    try { HR.UI.hideScreens(); } catch (e) { /* ignore */ }
  }

  function cycleSpectateCar() {
    var race = game.race;
    if (!race || race.mode !== 'spectate') return;
    var arr = race.standings || race.cars;
    if (!arr.length) return;
    var idx = arr.indexOf(race.cameraCar);
    race.cameraCar = arr[(idx + 1) % arr.length];
    toast('镜头：' + (race.cameraCar.name || '') + ' · ' + (race.cameraCar.spec ? race.cameraCar.spec.name : ''));
  }

  function cycleSpectateSpeed() {
    var race = game.race;
    if (!race || race.mode !== 'spectate' || race.playerCar) return;
    var opts = HR.SETTING_ENUMS && HR.SETTING_ENUMS.spectateSpeed ? HR.SETTING_ENUMS.spectateSpeed : [1, 2, 4];
    var idx = opts.indexOf(game.spectateSpeed);
    game.spectateSpeed = opts[(idx + 1) % opts.length];
    race.spectateSpeed = game.spectateSpeed;
    toast('观战倍速 ×' + game.spectateSpeed);
  }

  function toggleMute() {
    game.settings.sfx = !game.settings.sfx;
    applySettings({ sfx: game.settings.sfx });
    toast(game.settings.sfx ? '声音：开' : '声音：静音');
  }

  function toggleAutopilot() {
    var race = game.race;
    if (!race || race.mode === 'attract') return;
    var car = race.playerCar || race.cameraCar;
    if (!car) return;
    if (race.mode === 'spectate' && !race.playerCar) {
      // 纯观战时不存在“自动驾驶”，直接接管镜头车
      takeOverCar(car);
      return;
    }
    if (car.control === 'player') {
      car.control = 'ai';
      if (!car.ai) attachAI(car, race.track, race.difficulty, race.seedTag || 'late');
      game.settings.autopilot = true;
    } else {
      car.control = 'player';
      game.settings.autopilot = false;
    }
    saveGame();
    toast(car.control === 'ai' ? '自动驾驶：开（AI 正在驾驶你的赛车）' : '自动驾驶：关');
    if (game.paused) { try { HR.UI.showScreen('pause', buildPauseData()); } catch (e) { /* ignore */ } }
  }

  /* ============================================================
   * 屏幕 / 菜单
   * ============================================================ */
  function showTitle() {
    game.appMode = 'menu';
    game.paused = false;
    game.race = game.attract || null;
    game.screenOpen = true;
    try {
      HR.UI.showScreen('title', { records: buildTitleRecords() });
    } catch (e) { showFatal('标题界面显示失败', e); }
  }

  function buildTitleRecords() {
    var stats = game.save.stats || {};
    var bestLap = stats.bestLap || 0;
    return {
      credits: game.save.credits || 0,
      races: stats.races || 0,
      wins: stats.wins || 0,
      podiums: stats.podiums || 0,
      championships: stats.championships || 0,
      bestLap: bestLap,
      bestLapText: bestLap > 0 ? U.formatTime(bestLap) : '--',
      lastEvent: game.save.records && Object.keys(game.save.records).length ? true : false
    };
  }

  function buildRecordsMap() {
    var map = {};
    for (var i = 0; i < HR.EVENTS.length; i++) {
      var id = HR.EVENTS[i].id;
      var rec = (game.save.records && game.save.records[id]) || null;
      map[id] = rec ? {
        bestLap: rec.bestLap || 0,
        bestLapText: rec.bestLapText || (rec.bestLap ? U.formatTime(rec.bestLap) : '--'),
        bestTotal: rec.bestTotal || 0,
        bestTotalText: rec.bestTotalText || (rec.bestTotal ? U.formatTime(rec.bestTotal) : '--')
      } : { bestLap: 0, bestLapText: '--', bestTotal: 0, bestTotalText: '--' };
    }
    return map;
  }

  function showEvents(mode) {
    game.pending.mode = mode || 'quick';
    game.screenOpen = true;
    game.appMode = 'menu';
    try {
      HR.UI.showScreen('events', {
        mode: game.pending.mode,
        bestRecords: buildRecordsMap(),
        champProgress: game.champ ? { index: game.champ.index, total: game.champ.events.length, points: game.champ.playerPoints } : null
      });
    } catch (e) { showFatal('赛事列表显示失败', e); }
  }

  function eventForMode(mode, eventId) {
    if (mode === 'free') {
      return {
        id: 'free',
        name: HR.FREE_TRACK.name,
        subtitle: 'FREE ROAM',
        desc: '没有对手、没有终点线。沿着环岛公路自由驾驶，随手拍下落日。',
        laps: 0,
        timeOfDay: 18.2,
        weather: 'clear',
        difficulty: 'pro',
        reward: 0,
        track: HR.FREE_TRACK
      };
    }
    if (mode === 'spectate') {
      return getEvent(HR.SPECTATE_EVENT_ID || 'e4');
    }
    return getEvent(eventId || HR.EVENTS[0].id);
  }

  function showCars(mode, event) {
    game.pending.mode = mode;
    game.screenOpen = true;
    game.appMode = 'menu';
    var ev = event || eventForMode(mode, game.pending.eventId);
    game.pending.eventId = ev && ev.id !== 'free' ? ev.id : null;
    var selected = game.pending.carId || (game.champ && game.champ.carId) || HR.CARS[0].id;
    game.pending.carId = selected;
    try {
      HR.UI.showScreen('cars', {
        mode: mode,
        event: ev,
        cars: HR.CARS,
        selectedCarId: selected,
        difficulty: game.settings.difficulty,
        difficultyList: HR.DIFFICULTIES,
        autopilot: !!game.settings.autopilot,
        record: ev && ev.id !== 'free' ? (buildRecordsMap()[ev.id] || null) : null
      });
    } catch (e) { showFatal('选车界面显示失败', e); }
  }

  function showSettings() {
    game.screenOpen = true;
    game.appMode = 'menu';
    try {
      HR.UI.showScreen('settings', { settings: game.settings });
    } catch (e) { showFatal('设置界面显示失败', e); }
  }

  function showHelp() {
    game.screenOpen = true;
    game.appMode = 'menu';
    try { HR.UI.showScreen('help', {}); } catch (e) { showFatal('帮助界面显示失败', e); }
  }

  function startRace(config) {
    config = config || {};
    if (config.mode === 'champ' && game.champ) {
      // 以冠军赛状态为准
      config.eventId = game.champ.events[game.champ.index] || config.eventId;
      config.carId = game.champ.carId || config.carId;
      config.difficultyId = game.champ.difficultyId || config.difficultyId;
    }
    game.raceConfig = config;
    game.paused = false;
    game.screenOpen = true;
    game.appMode = 'race';
    audio('play', ['ui_confirm']);
    try { HR.UI.showScreen('loading', { label: '正在生成赛道与车手…', pct: 35 }); } catch (e) { /* ignore */ }

    setTimeout(function () {
      try {
        var race = buildRace(config);
        game.race = race;
        game.appMode = (config.mode === 'free') ? 'free' : (config.mode === 'spectate' ? 'spectate' : 'race');
        game.spectateSpeed = 1;
        game.paused = false;
        game.screenOpen = false;
        game.lastTs = 0;
        try { HR.UI.hideScreens(); } catch (e) { /* ignore */ }
        if (config.mode === 'free') toast('自由驾驶 · 按 Esc 暂停 / P 暂停', 2600);
        else if (config.mode === 'spectate') toast('AI 大战开始 · Tab 切车 / Enter 接管 / T 倍速', 3200);
      } catch (e) {
        showFatal('比赛创建失败', e);
      }
    }, 90);
  }

  var handlers = {
    onQuickRace: function () { game.pending.mode = 'quick'; showEvents('quick'); },
    onChampionship: function () {
      game.champ = {
        active: true,
        carId: null,
        difficultyId: game.settings.difficulty,
        events: (HR.CHAMP && HR.CHAMP.events ? HR.CHAMP.events.slice() : HR.EVENTS.map(function (e) { return e.id; })),
        index: 0,
        points: {},
        playerPoints: 0,
        results: [],
        finished: false,
        viewedFinal: false
      };
      game.champIndexValid = true;
      showCars('champ', getEvent(game.champ.events[0]));
    },
    onSpectate: function () { showCars('spectate', eventForMode('spectate')); },
    onFreeRoam: function () { showCars('free', eventForMode('free')); },
    onHelp: function () { showHelp(); },
    onSettings: function () { showSettings(); },
    onTitle: function () {
      game.champ = null;
      game.champIndexValid = false;
      showTitle();
    },
    onOpenEvents: function (mode) {
      if (mode === 'quick' || mode === 'champ') showEvents(mode);
      else showTitle();
    },
    onSelectEvent: function (eventId) {
      if (game.pending.mode === 'champ' && game.champ) {
        // 冠军赛按站序进行：只允许从当前站开始，忽略在赛事列表里点其它站
        showCars('champ', getEvent(game.champ.events[game.champ.index] || eventId));
        return;
      }
      game.pending.eventId = eventId;
      showCars('race', getEvent(eventId));
    },
    onSelectCar: function (carId) {
      // UI 自身已即时高亮选中车辆，这里只记录选择，避免重建界面导致闪烁
      game.pending.carId = carId || game.pending.carId;
    },
    onStartRace: function (opts) {
      opts = opts || {};
      var mode = opts.mode || game.pending.mode || 'race';
      if (mode === 'quick') mode = 'race';
      var cfg = {
        mode: mode,
        eventId: opts.eventId || game.pending.eventId || (mode === 'spectate' ? (HR.SPECTATE_EVENT_ID || 'e4') : HR.EVENTS[0].id),
        carId: opts.carId || game.pending.carId || (game.champ && game.champ.carId) || HR.CARS[0].id,
        difficultyId: opts.difficulty || game.settings.difficulty,
        autopilot: opts.autopilot != null ? !!opts.autopilot : !!game.settings.autopilot
      };
      if (mode === 'champ') {
        if (!game.champ) game.champ = {
          active: true, carId: cfg.carId, difficultyId: cfg.difficultyId,
          events: HR.CHAMP.events.slice(), index: 0, points: {}, playerPoints: 0,
          results: [], finished: false, viewedFinal: false
        };
        game.champ.carId = cfg.carId;
        game.champ.difficultyId = cfg.difficultyId;
        game.champIndexValid = true;
      }
      applySettings({ difficulty: cfg.difficultyId, autopilot: cfg.autopilot });
      startRace(cfg);
    },
    onSettingsChange: function (patch) { applySettings(patch || {}); },
    onPause: function () { pauseGame(); },
    onResume: function () { resumeGame(); },
    onRestart: function () {
      if (game.raceConfig) {
        var cfg = U.clone(game.raceConfig);
        // 重开当前这一场：冠军赛此时还没结算积分，正常完赛后照常推进站序
        startRace(cfg);
      }
    },
    onQuitToTitle: function () {
      game.paused = false;
      game.champ = null;
      game.champIndexValid = false;
      startAttract();
      showTitle();
    },
    onRaceAgain: function () {
      if (!game.raceConfig) { showTitle(); return; }
      var cfg = U.clone(game.raceConfig);
      if (cfg.mode === 'champ') { cfg.mode = 'race'; }
      startRace(cfg);
    },
    onNextEvent: function () {
      var champ = game.champ;
      if (!champ) { showTitle(); return; }
      if (champ.finished) {
        if (!champ.viewedFinal) {
          champ.viewedFinal = true;
          game.screenOpen = true;
          try { HR.UI.showScreen('champ', buildChampData()); } catch (e) { showFatal('积分榜显示失败', e); }
          return;
        }
        game.champ = null;
        game.champIndexValid = false;
        showTitle();
        return;
      }
      if (!champ.carId) { showCars('champ', getEvent(champ.events[champ.index])); return; }
      startRace({
        mode: 'champ',
        eventId: champ.events[champ.index],
        carId: champ.carId,
        difficultyId: champ.difficultyId,
        autopilot: game.settings.autopilot
      });
    },
    onTakeOver: function (carId) {
      var race = game.race;
      if (!race) return;
      var car = null;
      for (var i = 0; i < race.cars.length; i++) if (race.cars[i].id === carId) car = race.cars[i];
      if (car) takeOverCar(car);
    },
    onGiveToAI: function () { toggleControl(); },
    onCameraMode: function () { cycleCamera(); if (game.paused) { try { HR.UI.showScreen('pause', buildPauseData()); } catch (e) { /* ignore */ } } },
    onToggleAutopilot: function () { toggleAutopilot(); },
    onToggleMute: function () { toggleMute(); },
    onToggleMusic: function () { game.settings.music = !game.settings.music; applySettings({ music: game.settings.music }); toast(game.settings.music ? '音乐：开' : '音乐：关'); },
    onSpeedToggle: function () { cycleSpectateSpeed(); },
    onSelectSpectateCar: function (carId) {
      var race = game.race;
      if (!race) return;
      for (var i = 0; i < race.cars.length; i++) {
        if (race.cars[i].id === carId) { race.cameraCar = race.cars[i]; break; }
      }
    }
  };

  function wrapHandlers(obj) {
    var out = {};
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      (function (name, fn) {
        out[name] = function () {
          initAudio();
          try { audio('play', ['ui_click']); } catch (e) { /* ignore */ }
          try { return fn.apply(null, arguments); } catch (e) { showFatal('操作处理失败：' + name, e); }
        };
      })(k, obj[k]);
    }
    return out;
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  function boot() {
    if (game.booted) return;
    game.booted = true;

    // 自检模式
    try {
      var params = new URLSearchParams(window.location.search || '');
      if (params.get('selftest') === '1') {
        // 自检不需要渲染/UI，但需要一份可用的设置与输入对象
        game.save = defaultSave();
        game.settings = game.save.settings;
        game.input = makeInput();
        if (HR.selftest && typeof HR.selftest.run === 'function') { HR.selftest.run(); return; }
        showFatal('自检模块 js/selftest.js 未加载');
        return;
      }
    } catch (e) { /* ignore */ }

    try {
      var missing = validateModules();
      if (missing.length) {
        showFatal('游戏模块缺失或不完整，请确认以下文件存在且实现正确：\n- ' + missing.join('\n- '));
        return;
      }
      game.canvas = document.getElementById('game');
      game.save = loadSave();
      game.settings = game.save.settings;
      game.playerName = '你';

      HR.Renderer.init(game.canvas);
      if (typeof HR.Renderer.setQuality === 'function') HR.Renderer.setQuality(game.settings.quality);
      try { HR.Renderer.resize(); } catch (e) { /* ignore */ }

      var root = document.getElementById('ui-root');
      HR.UI.init(root, wrapHandlers(handlers));
      setupInput();

      window.addEventListener('resize', function () {
        try { HR.Renderer.resize(); } catch (e) { /* ignore */ }
      });

      // 错误兜底
      window.addEventListener('error', function (ev) {
        if (ev && ev.error) showFatal('运行时错误：' + (ev.message || '未知错误'), ev.error);
        else if (ev && ev.message) showFatal('运行时错误：' + ev.message);
      });
      window.addEventListener('unhandledrejection', function (ev) {
        showFatal('未处理的异步错误', ev ? ev.reason : null);
      });

      // 先展示 loading，再生成开场演示赛（避免首帧白屏）
      try { HR.UI.showScreen('loading', { label: '正在准备地平线嘉年华…', pct: 20 }); } catch (e) { /* ignore */ }
      setTimeout(function () {
        try {
          startAttract();
          try { HR.UI.hideScreens(); } catch (e) { /* ignore */ }
          showTitle();
          applySettings({});
          requestAnimationFrame(loop);
        } catch (e) {
          showFatal('初始化失败', e);
        }
      }, 80);
    } catch (e) {
      showFatal('启动失败', e);
    }
  }

  /* ============================================================
   * 暴露 & 生命周期
   * ============================================================ */
  HR.boot = boot;
  HR.Game = {
    state: game,
    buildRace: buildRace,
    step: step,
    updateStandings: updateStandings,
    buildResultsData: buildResultsData,
    initCarRaceFields: initCarRaceFields,
    attachAI: attachAI,
    simConfig: function (mode, eventId, carId, difficultyId, autopilot) {
      return { mode: mode, eventId: eventId, carId: carId, difficultyId: difficultyId, autopilot: autopilot };
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
