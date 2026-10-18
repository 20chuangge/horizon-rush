/**
 * Horizon Rush · 极速地平线
 * audio.js —— 程序化 WebAudio 音频系统（Audio 负责人，唯一写入文件）
 *
 * 契约（ARCHITECTURE.md §7）：
 *   HR.Audio = {
 *     init(),                    // 幂等；首次用户手势时由 game 调用
 *     setEnabled(bool), setVolume(0..1), setMusicEnabled(bool),
 *     update(info),              // 每帧：{ car, cars, track, mode, paused, raceState, dt, time }
 *     play(name),                // 'ui_click' | ... | 'rescue'（未知名字忽略）
 *     suspend(), resume()
 *   }
 *
 * 设计铁律：
 *   1) 零外部资源：引擎 / 风噪 / 轮胎 / 氮气 / 音效 / 音乐全部用 OscillatorNode、
 *      AudioBuffer 噪声、BiquadFilter、GainNode 现场合成，不加载任何音频文件。
 *   2) 顶层零副作用：本文件被 <script> 加载时只做「定义 + 赋值 HR.Audio」。
 *      不 new AudioContext、不建节点、不启动计时器 —— 全部推迟到 init()，且 init 内部 try/catch。
 *   3) 节点图只在 init() 里创建一次，update() 每帧只改 AudioParam（setTargetAtTime 平滑），
 *      绝不每帧新建节点/数组。play() 的一次性音效节点稀疏创建、播完自动 disconnect。
 *   4) 任何公开方法都不允许抛异常：内部 try/catch + 未初始化守卫。
 *      浏览器不支持 WebAudio（无 AudioContext / webkitAudioContext）时全部退化为空操作。
 *
 * 节点图（一次创建、长期复用）：
 *
 *   musicGain ─┐
 *              ├──→ masterGain ──→ destination
 *   sfxGain ───┘
 *     ├── engineGain  ← engineFilter(lowpass) ← engineOsc1(saw) + engineOsc2(square) + engineOsc3(triangle,+1200Hz)
 *     ├── windGain    ← windFilter(lowpass)   ← windSrc(2s 白噪循环)
 *     ├── tireGain    ← tireFilter(bandpass)  ← tireSrc(2s 白噪循环)
 *     └── nitroGain   ← nitroFilter(highpass) ← nitroSrc(2s 白噪循环)
 *
 *   play(name) 的一次性节点 → sfxGain；音乐调度器的一次性音符 → musicGain。
 *
 * 单位：频率 Hz，时间 s，速度 m/s（与全项目契约一致）。
 */
window.HR = window.HR || {};

(function () {
  'use strict';

  /* ============================================================
   * 1. 调音常量（所有音色"手感"集中在此，便于统一修改）
   * ============================================================ */

  /* ---- 引擎 ---- */
  var ENGINE_IDLE_RPM = 800;      // 物理契约的怠速转速
  var DEFAULT_RPM_MAX = 9000;     // car.rpmMax 缺省（契约 rpm 上限 9000）
  var ENGINE_BASE_HZ = 35;        // 点火基频：rpm 归一化 0 时 35Hz（低沉怠速轰鸣）
  var ENGINE_RANGE_HZ = 95;       // 转速拉满额外 +95Hz → 红线约 130Hz（四缸机点火频率的听感）
  var ENGINE_OVERTONE_HZ = 1200;  // 高次谐波偏移 +1200Hz（给引擎加一点"金属高频"质感）
  var ENGINE_MIX_SAW = 0.5;       // 锯齿波音量（引擎主体：谐波最丰富）
  var ENGINE_MIX_SQUARE = 0.22;   // 方波音量（增加粗糙机械感）
  var ENGINE_MIX_OVERTONE = 0.08; // 高次谐波音量（很小，只作"沙粒感"）
  var ENGINE_DETUNE_SAW = -6;     // 锯齿基准微失谐（音分）；转速越高略向 0 收拢
  var ENGINE_DETUNE_SQUARE = 9;   // 方波基准微失谐（与锯齿错开，产生拍频厚度）
  var ENGINE_LP_MIN = 500;        // 低通最低截止 Hz（怠速：闷）
  var ENGINE_LP_RPM = 1200;       // 转速带来的低通提升 Hz（高转逐步变亮）
  var ENGINE_LP_THROTTLE = 500;   // 油门带来的低通提升 Hz（踩油门"开口"）
  var ENGINE_LEVEL_BASE = 0.055;  // 引擎总线底噪（怠速可闻但不吵）
  var ENGINE_LEVEL_THROTTLE = 0.05; // 油门额外音量
  var ENGINE_LEVEL_RPM = 0.04;    // 转速额外音量（高转更响）

  /* ---- 风噪（与速度平方近似） ---- */
  var WIND_FULL_SPEED = 85;       // m/s ≈ 306km/h：风噪到此为"满档"
  var WIND_LEVEL_BASE = 0.008;    // 低速也保留一丝风（避免完全无声的割裂）
  var WIND_LEVEL_MAX = 0.07;      // 满速风噪增益（叠加在引擎上仍不刺耳）
  var WIND_FILTER_MIN = 400;      // 低速风噪截止 Hz（闷）
  var WIND_FILTER_RANGE = 1200;   // 满速额外 +1200Hz（尖锐呼啸）

  /* ---- 轮胎摩擦 / 越野砂石 ---- */
  var TIRE_DRIFT_LEVEL = 0.03;    // 漂移基础音量
  var TIRE_DRIFT_SPEED = 0.05;    // 漂移随速度增加音量
  var TIRE_OFFROAD_LEVEL = 0.045; // 越野基础音量（砂石/草地更闷更响）
  var TIRE_OFFROAD_SPEED = 0.05;  // 越野随速度增加音量
  var TIRE_LEVEL_MAX = 0.12;      // 轮胎总线最大增益（封顶防破音）
  var TIRE_FILTER_DRIFT_MIN = 950;  // 漂移尖叫中心频率（沥青上轮胎的"吱"）
  var TIRE_FILTER_DRIFT_RANGE = 700; // 速度带来的中心频率提升
  var TIRE_FILTER_OFFROAD_MIN = 320; // 越野砂石中心频率（低频"沙沙"）
  var TIRE_FILTER_OFFROAD_RANGE = 420;
  var TIRE_Q_DRIFT = 1.3;         // 漂移用较高 Q：窄带尖叫
  var TIRE_Q_OFFROAD = 0.7;       // 越野用低 Q：宽带沙沙声

  /* ---- 氮气 ---- */
  var NITRO_LEVEL = 0.09;         // 喷射时氮气噪声增益
  var NITRO_HP = 1800;            // 氮气高通截止 Hz（只留"嘶——"的高频气流声）

  /* ---- 音乐 ---- */
  var MUSIC_LEVEL = 0.12;         // 音乐总线音量（契约要求小音量，不盖过引擎/音效）
  var MUSIC_BPM = 96;             // 速度：偏氛围的 96 BPM
  var MUSIC_LOOKAHEAD = 0.12;     // 预排时间窗：提前 0.12s 把音符排进音频时钟
  var MUSIC_TICK_MS = 25;         // 调度器轮询间隔：25ms
  var MUSIC_STEPS_PER_BAR = 8;    // 每小节 8 个八分音符
  var MUSIC_BAR_COUNT = 4;        // 四小节和弦循环（Am-F-C-G）
  var MUSIC_STEP_SEC = 60 / MUSIC_BPM / 2;              // 八分音符时长 = 0.3125s
  var MUSIC_BAR_SEC = MUSIC_STEP_SEC * MUSIC_STEPS_PER_BAR; // 小节 = 2.5s
  var MUSIC_TOTAL_STEPS = MUSIC_STEPS_PER_BAR * MUSIC_BAR_COUNT; // 循环 32 步

  /* ---- 包络 / 平滑时间 ---- */
  var PAD_ATTACK = 0.35;          // Pad 慢起音：营造"呼吸感"
  var SMOOTH_FAST = 0.05;         // 快速跟随（油门/漂移/氮气开关）
  var SMOOTH_MID = 0.08;          // 常规平滑
  var SMOOTH_SLOW = 0.15;         // 总线音量/音乐开关的柔和过渡

  /* ---- 噪声 ---- */
  var NOISE_SECONDS = 2;          // 白噪 buffer 长度 2s，循环播放
  var NOISE_PEAK = 0.0001;        // 指数包络的"零"（exponentialRamp 不能到 0）

  /* ============================================================
   * 2. 运行状态（init() 之前全部为 null / 默认值，模块加载时无副作用）
   * ============================================================ */

  var ctx = null;                 // AudioContext；null 表示尚未 init 或已失败
  var unsupported = false;        // 浏览器完全没有 WebAudio → 永久空操作
  var enabled = true;             // setEnabled：总开关（masterGain）
  var volume = 0.7;               // setVolume：0..1；默认与 HR.DEFAULT_SETTINGS.volume 一致
  var musicEnabled = true;        // setMusicEnabled：音乐分轨开关
  var manuallySuspended = false;  // suspend() 后为 true（避免挂起期间排入音效、恢复时爆音）

  /* 总线与分轨 */
  var masterGain = null;
  var musicGain = null;
  var sfxGain = null;
  var engineGain = null;
  var windGain = null;
  var tireGain = null;
  var nitroGain = null;

  /* 引擎链路 */
  var engineFilter = null;
  var engineOsc1 = null;          // sawtooth 主体
  var engineOsc2 = null;          // square 粗糙层
  var engineOsc3 = null;          // triangle 高次谐波
  var engineMix1 = null;
  var engineMix2 = null;
  var engineMix3 = null;

  /* 噪声链路 */
  var noiseBuffer = null;         // 2s 白噪，一次生成全模块复用
  var windFilter = null;
  var windSrc = null;
  var tireFilter = null;
  var tireSrc = null;
  var nitroFilter = null;
  var nitroSrc = null;

  /* 音乐调度器 */
  var musicTimer = 0;             // setInterval 句柄；0 = 未启动
  var musicNextTime = 0;          // 下一个音乐网格点的 ctx.currentTime 时刻
  var musicStep = 0;              // 当前网格步（0..31）

  /* ============================================================
   * 3. 基础工具（不分配对象、不抛异常）
   * ============================================================ */

  function isNum(v) {
    return typeof v === 'number' && v === v && isFinite(v);
  }

  function num(v, fallback) {
    return isNum(v) ? v : fallback;
  }

  function clamp(v, lo, hi) {
    if (v !== v) return lo;             // NaN 兜底
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /**
   * 平滑设置 AudioParam。
   * setTargetAtTime 是指数逼近（不会瞬间跳变），是避免爆音/咔嗒声的关键：
   *   timeConstant = 0.05~0.15s 覆盖本模块所有持久参数。
   * 参数非法时静默忽略 —— 绝不让游戏崩溃。
   */
  function smooth(param, value, timeConstant) {
    if (!ctx || !param || !isNum(value)) return;
    var tc = (isNum(timeConstant) && timeConstant > 0) ? timeConstant : SMOOTH_MID;
    try {
      param.setTargetAtTime(value, ctx.currentTime, tc);
    } catch (e) { /* 浏览器拒绝该值：忽略 */ }
  }

  /** MIDI 音高 → 频率 Hz（A4 = 69 = 440Hz） */
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /**
   * 用 car.spec.stats.topSpeed(km/h) 估算极速（m/s）。
   * 仅在 car.rpm 缺失时兜底（正常路径不走到这里，避免每帧读 spec）。
   */
  function estimateTopSpeed(car) {
    try {
      if (car && car.spec && car.spec.stats && isNum(car.spec.stats.topSpeed) && car.spec.stats.topSpeed > 20) {
        return car.spec.stats.topSpeed / 3.6;
      }
    } catch (e) { /* 忽略 */ }
    return 90; // 缺省假设 90m/s ≈ 324km/h
  }

  /* ============================================================
   * 4. 节点图构建（只在 init() 中调用一次）
   * ============================================================ */

  /** 创建 AudioContext；浏览器不支持时置 unsupported 并返回 false */
  function createContext() {
    var Ctor = null;
    try {
      Ctor = window.AudioContext || window.webkitAudioContext || null;
    } catch (e) {
      Ctor = null;
    }
    if (!Ctor) {
      unsupported = true;
      return false;
    }
    try {
      ctx = new Ctor();
    } catch (e) {
      ctx = null;
      return false;
    }
    return true;
  }

  /** 生成 2 秒白噪声 buffer（风噪/轮胎/氮气/碰撞音效共用，全模块只生成一次） */
  function createNoiseBuffer() {
    var len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    if (!(len > 0)) len = ctx.sampleRate * 2;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    noiseBuffer = buf;
  }

  /** 构建完整节点图并启动所有长生命周期源（此后不再新建持久节点） */
  function buildGraph() {
    /* ---------- 总线 ---------- */
    masterGain = ctx.createGain();
    masterGain.gain.value = 0;          // 从 0 平滑进入：init 时不"啪"一声
    masterGain.connect(ctx.destination);

    musicGain = ctx.createGain();
    musicGain.gain.value = 0;           // 由 setMusicEnabled / applyAudioState 打开
    musicGain.connect(masterGain);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = 1;             // 音效分轨：音效各自带包络，总线固定 1
    sfxGain.connect(masterGain);

    /* ---------- 引擎：3 振荡器 → lowpass → engineGain ---------- */
    engineGain = ctx.createGain();
    engineGain.gain.value = 0;          // 没有车时保持 0（update 中淡入/淡出）
    engineGain.connect(sfxGain);

    engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = ENGINE_LP_MIN;
    engineFilter.Q.value = 0.9;         // 轻微共振：低通扫频时更有"腔体感"
    engineFilter.connect(engineGain);

    // 主体：锯齿波（谐波最丰富，模拟发动机排气脉冲）
    engineOsc1 = ctx.createOscillator();
    engineOsc1.type = 'sawtooth';
    engineOsc1.frequency.value = ENGINE_BASE_HZ;
    engineOsc1.detune.value = ENGINE_DETUNE_SAW;
    engineMix1 = ctx.createGain();
    engineMix1.gain.value = ENGINE_MIX_SAW;
    engineOsc1.connect(engineMix1);
    engineMix1.connect(engineFilter);

    // 粗糙层：方波（增加机械/金属的"硬"质感），detune 与锯齿错开产生拍频
    engineOsc2 = ctx.createOscillator();
    engineOsc2.type = 'square';
    engineOsc2.frequency.value = ENGINE_BASE_HZ;
    engineOsc2.detune.value = ENGINE_DETUNE_SQUARE;
    engineMix2 = ctx.createGain();
    engineMix2.gain.value = ENGINE_MIX_SQUARE;
    engineOsc2.connect(engineMix2);
    engineMix2.connect(engineFilter);

    // 高次谐波：基频 +1200Hz 的三角波，音量非常低，只负责"高频沙粒感"
    engineOsc3 = ctx.createOscillator();
    engineOsc3.type = 'triangle';
    engineOsc3.frequency.value = ENGINE_BASE_HZ + ENGINE_OVERTONE_HZ;
    engineMix3 = ctx.createGain();
    engineMix3.gain.value = ENGINE_MIX_OVERTONE;
    engineOsc3.connect(engineMix3);
    engineMix3.connect(engineFilter);

    /* ---------- 风噪：白噪循环 → lowpass → windGain ---------- */
    windGain = ctx.createGain();
    windGain.gain.value = 0;
    windGain.connect(sfxGain);

    windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = WIND_FILTER_MIN;
    windFilter.Q.value = 0.6;
    windFilter.connect(windGain);

    windSrc = ctx.createBufferSource();
    windSrc.buffer = noiseBuffer;
    windSrc.loop = true;                // 循环 2s 白噪：无外部文件、无接缝问题
    windSrc.connect(windFilter);

    /* ---------- 轮胎摩擦：白噪循环 → bandpass → tireGain ---------- */
    tireGain = ctx.createGain();
    tireGain.gain.value = 0;
    tireGain.connect(sfxGain);

    tireFilter = ctx.createBiquadFilter();
    tireFilter.type = 'bandpass';
    tireFilter.frequency.value = TIRE_FILTER_DRIFT_MIN;
    tireFilter.Q.value = TIRE_Q_DRIFT;
    tireFilter.connect(tireGain);

    tireSrc = ctx.createBufferSource();
    tireSrc.buffer = noiseBuffer;
    tireSrc.loop = true;
    tireSrc.connect(tireFilter);

    /* ---------- 氮气：白噪循环 → highpass → nitroGain ---------- */
    nitroGain = ctx.createGain();
    nitroGain.gain.value = 0;
    nitroGain.connect(sfxGain);

    nitroFilter = ctx.createBiquadFilter();
    nitroFilter.type = 'highpass';
    nitroFilter.frequency.value = NITRO_HP;
    nitroFilter.Q.value = 0.7;
    nitroFilter.connect(nitroGain);

    nitroSrc = ctx.createBufferSource();
    nitroSrc.buffer = noiseBuffer;
    nitroSrc.loop = true;
    nitroSrc.connect(nitroFilter);

    /* ---------- 启动所有长生命周期源（只启动这一次） ---------- */
    var t0 = ctx.currentTime;
    engineOsc1.start(t0);
    engineOsc2.start(t0);
    engineOsc3.start(t0);
    windSrc.start(t0);
    tireSrc.start(t0);
    nitroSrc.start(t0);
  }

  /** init 中途失败：尽量关闭 context 并清空引用，下次 init 可重试 */
  function failInit() {
    stopMusicClock();
    var dying = ctx;
    ctx = null;
    if (dying) {
      try {
        if (dying.close) {
          var p = dying.close();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        }
      } catch (e) { /* 忽略 */ }
    }
  }

  /** 恢复被 autoplay 策略挂起的 context（失败静默，不抛错） */
  function resumeContext() {
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        var p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      }
    } catch (e) { /* 静默降级 */ }
  }

  /** 把 enabled / volume / musicEnabled 的当前状态应用到总线（全部平滑） */
  function applyAudioState() {
    if (!ctx) return;
    if (masterGain) {
      // 总开关：关闭时 masterGain 平滑到 0（而不是 suspend，避免恢复时爆音）
      smooth(masterGain.gain, enabled ? clamp(volume, 0, 1) : 0, SMOOTH_SLOW);
    }
    if (musicGain) {
      smooth(musicGain.gain, musicEnabled ? MUSIC_LEVEL : 0, SMOOTH_SLOW);
    }
  }

  /* ============================================================
   * 5. 生命周期：init / suspend / resume（全部幂等、永不抛错）
   * ============================================================ */

  function init() {
    if (unsupported) return false;
    try {
      // init 是"启用音频"的入口：清除主动挂起标记，
      // 否则 suspend() 之后若再次 init（例如每次手势都调一次 init 的防御式写法），
      // play() 会一直因 manuallySuspended 被静默跳过。
      manuallySuspended = false;

      // 极少数情况下 context 已关闭（浏览器回收/异常）：重建整套图
      if (ctx && ctx.state === 'closed') {
        stopMusicClock();
        ctx = null;
      }

      if (!ctx) {
        if (!createContext()) return false;
        try {
          createNoiseBuffer();   // 噪声源依赖 buffer，必须先建
          buildGraph();
        } catch (e) {
          failInit();
          return false;
        }
      }

      // autoplay 策略：在用户手势里初始化时 resume 通常立即成功；被拒绝则静默待机
      resumeContext();

      // 应用 init 之前 setter 暂存的音量/静音状态（game 可能在 title 界面就先调 setVolume）
      applyAudioState();

      if (musicEnabled) startMusicClock();

      return true;
    } catch (e) {
      return false;
    }
  }

  function suspend() {
    manuallySuspended = true;
    stopMusicClock();
    if (!ctx) return;
    try {
      var p = ctx.suspend();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* 静默 */ }
  }

  function resume() {
    manuallySuspended = false;
    if (!ctx) return;
    try {
      resumeContext();
      applyAudioState();
      if (musicEnabled) startMusicClock();
    } catch (e) { /* 静默 */ }
  }

  /* ============================================================
   * 6. 参数设置（init 前后调用都安全；init 前只记录状态）
   * ============================================================ */

  function setEnabled(on) {
    enabled = !!on;
    try { applyAudioState(); } catch (e) { /* 静默 */ }
  }

  function setVolume(v) {
    if (!isNum(v)) return;          // 非法值忽略，保持原音量
    volume = clamp(v, 0, 1);
    try { applyAudioState(); } catch (e) { /* 静默 */ }
  }

  function setMusicEnabled(on) {
    musicEnabled = !!on;
    try {
      if (!ctx || !musicGain) return;
      smooth(musicGain.gain, musicEnabled ? MUSIC_LEVEL : 0, SMOOTH_SLOW);
      if (musicEnabled) {
        startMusicClock();
      } else {
        stopMusicClock();           // 关闭时也停调度器：省 CPU，长时间挂机不发散
      }
    } catch (e) { /* 静默 */ }
  }

  /* ============================================================
   * 7. 每帧更新（update）
   *    info = { car, cars, track, mode, paused, raceState, dt, time }
   *    要求：只改已创建节点的 AudioParam，不新建节点、不新建数组/对象。
   * ============================================================ */

  function update(info) {
    // 任一分轨链路缺失都不进入（init 未完成/失败时）；context 被关闭时也直接跳过
    if (!ctx || ctx.state === 'closed') return;
    if (!engineGain || !engineFilter || !engineOsc1 || !engineOsc2 || !engineOsc3) return;
    if (!windGain || !windFilter || !tireGain || !tireFilter || !nitroGain) return;

    try {
      var car = (info && info.car) ? info.car : null;
      var paused = !!(info && info.paused);
      var hasCar = car !== null;

      /* ---- 从 car 提取归一化参数（全部是原始值，不分配对象） ---- */
      var rpmNorm = 0;      // 0..1 转速归一化
      var throttle = 0;     // 0..1 油门
      var speedNorm = 0;    // 0..1 速度归一化（风噪用）
      var drifting = 0;     // 0..1 漂移强度
      var offroad = 0;      // 0/1 是否越野
      var boosting = false; // 是否正在喷氮气

      if (hasCar) {
        var rpmMax = (isNum(car.rpmMax) && car.rpmMax > ENGINE_IDLE_RPM + 100) ? car.rpmMax : DEFAULT_RPM_MAX;
        if (isNum(car.rpm)) {
          rpmNorm = clamp((car.rpm - ENGINE_IDLE_RPM) / (rpmMax - ENGINE_IDLE_RPM), 0, 1);
        } else {
          // rpm 缺失时的兜底：用速度估算转速感
          rpmNorm = clamp(num(car.v, 0) / estimateTopSpeed(car), 0, 1);
        }
        throttle = clamp(num(car.throttle, 0), 0, 1);
        speedNorm = clamp(num(car.v, 0) / WIND_FULL_SPEED, 0, 1);
        // 漂移强度：布尔标志 + driftAngle 幅度（契约 ±0.6）共同决定尖叫音量
        drifting = car.drifting
          ? clamp(0.5 + Math.abs(num(car.driftAngle, 0)) * 0.9, 0, 1)
          : 0;
        offroad = car.offroad ? 1 : 0;
        boosting = !!car.boosting;
      }

      /* ---- 引擎：基频 / 失谐 / 低通 / 总线音量 ---- */
      // 点火基频 = 35 + rpmNorm*95 Hz（契约 §7 的发动机点火频率公式）。
      // 油门/负载的听感差异由 lowpass 截止与 engineGain 音量承载，不改基频公式。
      var baseFreq = ENGINE_BASE_HZ + rpmNorm * ENGINE_RANGE_HZ;

      smooth(engineOsc1.frequency, baseFreq, SMOOTH_FAST);
      smooth(engineOsc2.frequency, baseFreq, SMOOTH_FAST);
      // 谐波振荡器 = 基频 + 1200Hz（高次谐波质感）
      smooth(engineOsc3.frequency, baseFreq + ENGINE_OVERTONE_HZ, SMOOTH_MID);
      // detune：怠速时两振荡器分得开（拍频厚），高转时收拢（声音更"紧"）
      smooth(engineOsc1.detune, ENGINE_DETUNE_SAW + rpmNorm * 4, SMOOTH_MID);
      smooth(engineOsc2.detune, ENGINE_DETUNE_SQUARE - rpmNorm * 5, SMOOTH_MID);

      // 低通截止 = 500 + 转速*1200 + 油门*500，clamp 到契约要求的 500..2200Hz
      var lpFreq = clamp(ENGINE_LP_MIN + rpmNorm * ENGINE_LP_RPM + throttle * ENGINE_LP_THROTTLE, 500, 2200);
      smooth(engineFilter.frequency, lpFreq, SMOOTH_MID);

      // 引擎总线音量：无车时为 0（淡出）；暂停时压到 25%（不硬切）
      var engineLevel = 0;
      if (hasCar) {
        engineLevel = ENGINE_LEVEL_BASE + throttle * ENGINE_LEVEL_THROTTLE + rpmNorm * ENGINE_LEVEL_RPM;
        if (paused) engineLevel *= 0.25;
      }
      smooth(engineGain.gain, engineLevel, SMOOTH_MID);

      /* ---- 风噪：随速度，速度平方曲线更接近真实风压 ---- */
      var windLevel = hasCar ? (WIND_LEVEL_BASE + speedNorm * speedNorm * WIND_LEVEL_MAX) : 0;
      if (paused) windLevel *= 0.25;    // 暂停时降低风噪（保留一点环境底噪）
      smooth(windGain.gain, windLevel, SMOOTH_MID);
      smooth(windFilter.frequency, WIND_FILTER_MIN + speedNorm * WIND_FILTER_RANGE, SMOOTH_SLOW);

      /* ---- 轮胎：漂移尖叫 + 越野砂石（两者可叠加，最终 clamp） ---- */
      var tireLevel = 0;
      if (hasCar) {
        tireLevel = drifting * (TIRE_DRIFT_LEVEL + speedNorm * TIRE_DRIFT_SPEED) +
                    offroad * (TIRE_OFFROAD_LEVEL + speedNorm * TIRE_OFFROAD_SPEED);
        tireLevel = clamp(tireLevel, 0, TIRE_LEVEL_MAX);
        if (paused) tireLevel *= 0.25;
      }
      smooth(tireGain.gain, tireLevel, SMOOTH_FAST);

      if (offroad > 0) {
        // 越野：低频宽带砂石声
        smooth(tireFilter.frequency, TIRE_FILTER_OFFROAD_MIN + speedNorm * TIRE_FILTER_OFFROAD_RANGE, SMOOTH_MID);
        smooth(tireFilter.Q, TIRE_Q_OFFROAD, SMOOTH_SLOW);
      } else {
        // 漂移：窄带高频尖叫，速度越快越尖
        smooth(tireFilter.frequency, TIRE_FILTER_DRIFT_MIN + speedNorm * TIRE_FILTER_DRIFT_RANGE, SMOOTH_MID);
        smooth(tireFilter.Q, TIRE_Q_DRIFT, SMOOTH_SLOW);
      }

      /* ---- 氮气：只随 boosting 开/关，快开慢关避免"噗"的爆音 ---- */
      var nitroLevel = (hasCar && boosting && !paused) ? NITRO_LEVEL : 0;
      smooth(nitroGain.gain, nitroLevel, boosting ? SMOOTH_FAST : SMOOTH_SLOW);
    } catch (e) {
      // 音频参数更新失败绝不能影响游戏主循环
    }
  }

  /* ============================================================
   * 8. 一次性音效（play）
   *    SFX 稀疏触发，允许现场创建少量节点；播完 onended 自动 disconnect，
   *    不会造成长会话的节点图膨胀。
   * ============================================================ */

  /**
   * 一次性振荡器音符（UI / 倒计时 / 完赛 / 换挡等）。
   * 参数含义：
   *   type    波形：'sine' | 'triangle' | 'square' | 'sawtooth'
   *   freq    起始频率 Hz
   *   freqEnd 结束频率 Hz；传 0 表示不滑音
   *   dur     总时长 s
   *   peak    峰值增益（进 sfxGain 之前的值，0..1）
   *   delay   相对当前时刻的延迟 s（用于琶音/双音）
   */
  function tone(type, freq, freqEnd, dur, peak, delay) {
    if (!ctx || !sfxGain || !isNum(freq) || freq <= 0) return;
    var t = ctx.currentTime + num(delay, 0);
    var d = Math.max(0.02, num(dur, 0.1));
    var p = Math.max(0.001, num(peak, 0.1));
    var osc = null;
    var g = null;
    try {
      osc = ctx.createOscillator();
      g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      if (isNum(freqEnd) && freqEnd > 0 && Math.abs(freqEnd - freq) > 0.5) {
        // 频率指数滑音（频率必须 > 0）：GO / 氮气 / 救援等"扫频"音色
        osc.frequency.exponentialRampToValueAtTime(freqEnd, t + d);
      }
      // ADSR 简化版：8ms 指数起音（防咔嗒）→ 指数衰减到静音
      g.gain.setValueAtTime(NOISE_PEAK, t);
      g.gain.exponentialRampToValueAtTime(p, t + Math.min(0.012, d * 0.3));
      g.gain.exponentialRampToValueAtTime(NOISE_PEAK, t + d);
      osc.connect(g);
      g.connect(sfxGain);
      osc.start(t);
      osc.stop(t + d + 0.03);
      osc.onended = function () {
        try { osc.disconnect(); } catch (e) { /* 忽略 */ }
        try { g.disconnect(); } catch (e) { /* 忽略 */ }
      };
    } catch (e) {
      try { if (osc) osc.disconnect(); } catch (e2) { /* 忽略 */ }
      try { if (g) g.disconnect(); } catch (e2) { /* 忽略 */ }
    }
  }

  /**
   * 一次性噪声爆发（碰撞 / 氮气 / 换挡）。
   * 复用 init 时生成的 2s 白噪 buffer，随机切一个 offset，每次听感略有差异。
   * 参数：
   *   filterType  'lowpass' | 'bandpass' | 'highpass'
   *   freqStart   滤波起始频率 Hz
   *   q           滤波器 Q
   *   dur         时长 s
   *   peak        峰值增益
   *   delay       延迟 s
   *   freqEnd     滤波结束频率 Hz（0 表示不扫频）
   */
  function noiseBurst(filterType, freqStart, q, dur, peak, delay, freqEnd) {
    if (!ctx || !sfxGain || !noiseBuffer) return;
    var t = ctx.currentTime + num(delay, 0);
    var d = Math.max(0.02, num(dur, 0.1));
    var p = Math.max(0.001, num(peak, 0.1));
    var src = null;
    var f = null;
    var g = null;
    try {
      src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      f = ctx.createBiquadFilter();
      f.type = filterType || 'bandpass';
      f.frequency.setValueAtTime(Math.max(20, num(freqStart, 1000)), t);
      if (isNum(freqEnd) && freqEnd > 0) {
        f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + d);
      }
      f.Q.value = isNum(q) && q > 0 ? q : 1;
      g = ctx.createGain();
      g.gain.setValueAtTime(NOISE_PEAK, t);
      g.gain.exponentialRampToValueAtTime(p, t + 0.01);
      g.gain.exponentialRampToValueAtTime(NOISE_PEAK, t + d);
      src.connect(f);
      f.connect(g);
      g.connect(sfxGain);
      // 随机 offset：避免同一音效重复播放时"机械重复"；duration 受 buffer 剩余长度限制
      var maxOff = Math.max(0.05, NOISE_SECONDS - d - 0.05);
      var offset = Math.random() * maxOff;
      src.start(t, offset, d + 0.02);
      src.onended = function () {
        try { src.disconnect(); } catch (e) { /* 忽略 */ }
        try { f.disconnect(); } catch (e) { /* 忽略 */ }
        try { g.disconnect(); } catch (e) { /* 忽略 */ }
      };
    } catch (e) {
      try { if (src) src.disconnect(); } catch (e2) { /* 忽略 */ }
      try { if (f) f.disconnect(); } catch (e2) { /* 忽略 */ }
      try { if (g) g.disconnect(); } catch (e2) { /* 忽略 */ }
    }
  }

  /**
   * 音效表：name → 合成配方。
   * 设计原则：UI 音短促克制；比赛事件音有明确"语义"（上升=开始/检查点，下降=返回/救援）；
   * 碰撞/氮气/换挡用噪声爆发保证冲击力；所有峰值都留足余量防止多音叠加破音。
   */
  var SFX = {
    /* ---- UI ---- */
    ui_click: function () {
      // 短促下滑正弦：轻、快、不抢戏
      tone('sine', 720, 540, 0.07, 0.10, 0);
    },
    ui_confirm: function () {
      // 两音上行（C5→G5 近似）：确认感
      tone('triangle', 660, 0, 0.09, 0.10, 0);
      tone('triangle', 990, 0, 0.13, 0.09, 0.07);
    },
    ui_back: function () {
      // 下滑：返回/取消
      tone('triangle', 540, 340, 0.13, 0.10, 0);
    },

    /* ---- 比赛流程 ---- */
    countdown: function () {
      // 3/2/1：低沉方波 + 正弦低八度，像赛道广播提示音
      tone('square', 480, 480, 0.14, 0.06, 0);
      tone('sine', 240, 240, 0.16, 0.05, 0);
    },
    go: function () {
      // GO：锯齿上行扫频 + 高八度方波 + 高频噪声"冲刺"，明亮有冲击
      tone('sawtooth', 620, 1240, 0.34, 0.08, 0);
      tone('square', 930, 1860, 0.22, 0.05, 0.02);
      noiseBurst('highpass', 2200, 0.7, 0.30, 0.08, 0, 5200);
    },
    finish: function () {
      // 完赛号角：A4-C5-E5-A5 四音上行（triangle，带一点铜管味）
      tone('triangle', 440.00, 0, 0.30, 0.12, 0);
      tone('triangle', 523.25, 0, 0.30, 0.11, 0.13);
      tone('triangle', 659.25, 0, 0.45, 0.11, 0.26);
      tone('triangle', 880.00, 0, 0.70, 0.12, 0.39);
      tone('sine', 440.00, 0, 0.80, 0.06, 0.39);
    },
    checkpoint: function () {
      // 检查点：两个高频正弦"叮"（E6→A6），清亮、可远距离辨认
      tone('sine', 1318.5, 0, 0.10, 0.09, 0);
      tone('sine', 1760.0, 0, 0.18, 0.08, 0.09);
      noiseBurst('bandpass', 3200, 1.6, 0.06, 0.05, 0, 3400);
    },
    collision: function () {
      // 碰撞：低频正弦"闷响" + 三角波中频 + 低通噪声冲击
      tone('sine', 95, 42, 0.30, 0.30, 0);
      tone('triangle', 190, 80, 0.18, 0.12, 0);
      noiseBurst('lowpass', 900, 0.8, 0.22, 0.20, 0, 220);
    },
    nitro: function () {
      // 氮气：高频噪声爆发扫频（嘶——）+ 低频锯齿上扬（推背感）
      noiseBurst('highpass', 1100, 0.8, 0.38, 0.14, 0, 4800);
      tone('sawtooth', 170, 620, 0.30, 0.05, 0);
    },
    shift: function () {
      // 换挡：高 Q 窄带噪声"哒"（机械撞击）+ 极短低频闷音
      noiseBurst('bandpass', 2400, 2.2, 0.05, 0.10, 0, 1800);
      tone('square', 150, 110, 0.06, 0.05, 0.01);
    },
    rescue: function () {
      // 救援/复位：下降扫频（提醒）+ 低通噪声收尾
      tone('triangle', 620, 180, 0.55, 0.10, 0);
      noiseBurst('lowpass', 1200, 0.6, 0.40, 0.05, 0.05, 300);
    }
  };

  function play(name) {
    if (!ctx || !enabled || !sfxGain) return;
    if (manuallySuspended) return;               // 主动挂起期间不排音效，避免恢复时齐响
    if (typeof name !== 'string') return;
    if (ctx.state !== 'running') {
      // autoplay 策略把 context 挂在 suspended 时：play 通常发生在用户手势里，
      // 借这次手势尝试 resume（失败静默）。本次事件先不发声，避免恢复瞬间齐响。
      resumeContext();
      return;
    }
    try {
      if (!Object.prototype.hasOwnProperty.call(SFX, name)) return; // 未知名字忽略
      SFX[name]();
    } catch (e) {
      // 音效合成失败必须静默
    }
  }

  /* ============================================================
   * 9. 背景音乐（A 小调 i-VI-III-VII：Am - F - C - G，四小节循环）
   *
   *    音色分层：
   *      - pad ：triangle 三音铺底，慢起音、长衰减，制造氛围
   *      - bass：triangle 低音根音，落在每小节第 1、3 拍
   *      - arp ：sine 琶音 pluck，八分音符网格，短促衰减
   *    整体挂在 musicGain（MUSIC_LEVEL = 0.12）上，小音量、不盖过引擎。
   *
   *    调度方式：setInterval(25ms) + 提前 MUSIC_LOOKAHEAD(0.12s) 把音符排进
   *    音频时钟（lookahead scheduler）。不用 setTimeout 精确排音符，
   *    因为主线程卡顿会导致节奏抖动；音频时钟是采样级精确的。
   * ============================================================ */

  // 和弦表（MIDI 音高）：root 为低音区根音，notes 为三/七和弦音（取 [1][2][3] 作 pad，[0..3] 作琶音）
  var MUSIC_CHORDS = [
    { root: 45, notes: [57, 60, 64, 67] }, // Am：A2 根音 / A3 C4 E4 G4
    { root: 41, notes: [53, 57, 60, 65] }, // F ：F2 根音 / F3 A3 C4 F4
    { root: 36, notes: [48, 55, 60, 64] }, // C ：C2 根音 / C3 G3 C4 E4
    { root: 43, notes: [55, 59, 62, 67] }  // G ：G2 根音 / G3 B3 D4 G4
  ];

  /** 单个音乐音符（bass / arp）：快速起音 + 指数衰减，一次性节点播完断开 */
  function musicNote(type, midi, when, dur, peak, attack) {
    if (!ctx || !musicGain) return;
    // 防御：midi 非数值时 midiToFreq 会得到 NaN，给 AudioParam 赋 NaN 会抛 TypeError。
    // 正常路径不会触发（和弦表是静态合法数据），但音频模块必须永不因坏参数崩溃。
    if (!isNum(midi)) return;
    var t = Math.max(when, ctx.currentTime + 0.005);
    var d = Math.max(0.05, num(dur, 0.2));
    var p = Math.max(0.001, num(peak, 0.05));
    var atk = clamp(num(attack, 0.01), 0.002, d * 0.5);
    var osc = null;
    var g = null;
    try {
      osc = ctx.createOscillator();
      g = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.value = midiToFreq(midi);
      g.gain.setValueAtTime(NOISE_PEAK, t);
      g.gain.linearRampToValueAtTime(p, t + atk);          // 起音
      g.gain.exponentialRampToValueAtTime(NOISE_PEAK, t + d); // 衰减（pluck 感）
      osc.connect(g);
      g.connect(musicGain);
      osc.start(t);
      osc.stop(t + d + 0.05);
      osc.onended = function () {
        try { osc.disconnect(); } catch (e) { /* 忽略 */ }
        try { g.disconnect(); } catch (e) { /* 忽略 */ }
      };
    } catch (e) {
      try { if (osc) osc.disconnect(); } catch (e2) { /* 忽略 */ }
      try { if (g) g.disconnect(); } catch (e2) { /* 忽略 */ }
    }
  }

  /** Pad 单音：慢起音 → 缓降 → 释放，triangle 波形柔和 */
  function padVoice(midi, when, dur, peak) {
    if (!ctx || !musicGain) return;
    if (!isNum(midi)) return;        // 同 musicNote：防止 NaN 频率抛 TypeError
    var t = Math.max(when, ctx.currentTime + 0.005);
    var d = Math.max(0.4, num(dur, MUSIC_BAR_SEC - 0.15));
    var p = Math.max(0.002, num(peak, 0.05));
    var releaseStart = Math.max(t + PAD_ATTACK + 0.05, t + d - 0.35);
    var osc = null;
    var g = null;
    try {
      osc = ctx.createOscillator();
      g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = midiToFreq(midi);
      g.gain.setValueAtTime(NOISE_PEAK, t);
      g.gain.linearRampToValueAtTime(p, t + PAD_ATTACK);              // 慢起音
      g.gain.setTargetAtTime(p * 0.7, t + PAD_ATTACK, 0.9);           // 缓慢自然衰减
      g.gain.setTargetAtTime(NOISE_PEAK, releaseStart, 0.22);         // 收尾释放
      osc.connect(g);
      g.connect(musicGain);
      osc.start(t);
      osc.stop(t + d + 0.15);
      osc.onended = function () {
        try { osc.disconnect(); } catch (e) { /* 忽略 */ }
        try { g.disconnect(); } catch (e) { /* 忽略 */ }
      };
    } catch (e) {
      try { if (osc) osc.disconnect(); } catch (e2) { /* 忽略 */ }
      try { if (g) g.disconnect(); } catch (e2) { /* 忽略 */ }
    }
  }

  /** Pad 三音和弦（避免传数组，减少分配） */
  function musicPad(m1, m2, m3, when, dur, peak) {
    padVoice(m1, when, dur, peak);
    padVoice(m2, when + 0.01, dur, peak * 0.9);
    padVoice(m3, when + 0.02, dur, peak * 0.8);
  }

  /**
   * 排一个音乐网格步（八分音符）：
   *   step 0..31，每 8 步一小节（4 小节循环），96 BPM。
   */
  function scheduleMusicStep(step, when) {
    var bar = Math.floor(step / MUSIC_STEPS_PER_BAR);     // 0..3
    var inBar = step % MUSIC_STEPS_PER_BAR;               // 0..7
    var chord = MUSIC_CHORDS[bar % MUSIC_CHORDS.length];

    // 低音：第 1、3 拍（八分网格 0 和 4），根音升八度保证笔记本扬声器也能听到
    if (inBar === 0 || inBar === 4) {
      musicNote('triangle', chord.root + 12, when, MUSIC_STEP_SEC * 1.6, 0.26, 0.01);
    }

    // Pad：每小节第一拍铺一个三音和弦（notes[1..3]）
    if (inBar === 0) {
      musicPad(chord.notes[1], chord.notes[2], chord.notes[3],
               when, MUSIC_BAR_SEC - 0.15, 0.055);
    }

    // 琶音：每小节 0/2/4/6 四个八分音符，音域 +12，短衰减 pluck
    if (inBar % 2 === 0) {
      var idx = inBar / 2;                                // 0..3
      musicNote('sine', chord.notes[idx] + 12, when, MUSIC_STEP_SEC * 1.1, 0.075, 0.006);
    }
  }

  /** 25ms 调度器：把未来 0.12s 内该响的音符提前排进音频时钟 */
  function musicTick() {
    try {
      if (!ctx || !musicGain || ctx.state !== 'running') return;
      var now = ctx.currentTime;

      // 后台标签页会节流 setInterval：若已严重落后，直接跳回当前时间，
      // 避免恢复时一次性"补课"几十个音符造成爆音。
      if (musicNextTime < now - 0.3) {
        musicNextTime = now + 0.05;
      }

      var horizon = now + MUSIC_LOOKAHEAD;
      var guard = 0;
      while (musicNextTime < horizon && guard < 8) {
        scheduleMusicStep(musicStep, musicNextTime);
        musicNextTime += MUSIC_STEP_SEC;
        musicStep = (musicStep + 1) % MUSIC_TOTAL_STEPS;   // 32 步自然循环
        guard++;
      }
    } catch (e) {
      // 音乐调度失败不影响游戏
    }
  }

  function startMusicClock() {
    if (!ctx || musicTimer) return;
    try {
      musicNextTime = ctx.currentTime + 0.15;   // 留一点启动余量
      musicStep = 0;                           // 每次开启都从和弦循环头部开始
      musicTimer = setInterval(musicTick, MUSIC_TICK_MS);
    } catch (e) {
      musicTimer = 0;
    }
  }

  function stopMusicClock() {
    if (!musicTimer) return;
    try { clearInterval(musicTimer); } catch (e) { /* 忽略 */ }
    musicTimer = 0;
  }

  /* ============================================================
   * 10. 导出（契约 §7 的 8 个方法，不多不少）
   * ============================================================ */

  HR.Audio = {
    init: init,
    setEnabled: setEnabled,
    setVolume: setVolume,
    setMusicEnabled: setMusicEnabled,
    update: update,
    play: play,
    suspend: suspend,
    resume: resume
  };
})();
