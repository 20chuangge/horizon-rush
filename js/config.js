/**
 * Horizon Rush · 极速地平线
 * config.js —— 全局配置与数据表（Lead 所有，所有模块只读）
 *
 * 单位约定：距离 m，速度 m/s（topSpeed 为 km/h 展示值），角度 rad，时间 s。
 * 本文件只做数据定义，不产生副作用。
 */
window.HR = window.HR || {};

HR.VERSION = '1.0.0';
HR.SAVE_KEY = 'hr_save_v1';
HR.PROJECT = 'Horizon Rush · 极速地平线';
HR.TITLE_CN = '极速地平线';
HR.TITLE_EN = 'HORIZON RUSH';

/* ============================================================
 * 车辆数据（8 辆，覆盖 8 种车身风格）
 * stats:
 *   topSpeed 极速 km/h
 *   accel    0-100km/h 秒数（越小越快）
 *   handling 操控 0..1
 *   braking  制动 0..1
 *   nitro    氮气 0..1
 * pi: 性能指数（AI 匹配对手用）
 * ai: 该车 AI 车手的性格（ai.js 使用）
 * ============================================================ */
HR.CARS = [
  {
    id: 'apex-gt',
    name: 'Apex GT',
    brand: 'VORTEX',
    cls: 'S1',
    body: 'gt',
    color: '#ff5a1f',
    accent: '#ffd166',
    pi: 828,
    stats: { topSpeed: 318, accel: 3.2, handling: 0.84, braking: 0.82, nitro: 0.78 },
    length: 4.55,
    width: 1.98,
    gearCount: 7,
    ai: { aggression: 0.72, cornering: 0.86, consistency: 0.82, braking: 0.84, tag: '精准' },
    driver: '林 澈',
    desc: '均衡的意式 GT，弯中稳定、出弯凌厉，是海岸公路的常胜将军。'
  },
  {
    id: 'nightfall',
    name: 'Nightfall',
    brand: 'NOVA',
    cls: 'S2',
    body: 'hyper',
    color: '#7b5cff',
    accent: '#39e6ff',
    pi: 906,
    stats: { topSpeed: 358, accel: 2.5, handling: 0.9, braking: 0.88, nitro: 0.9 },
    length: 4.7,
    width: 2.02,
    gearCount: 8,
    ai: { aggression: 0.84, cornering: 0.93, consistency: 0.76, braking: 0.88, tag: '凶狠' },
    driver: 'Kira',
    desc: '千匹混动超跑，极速怪物。入弯凶狠，稍不留神就会推头。'
  },
  {
    id: 'dustdevil',
    name: 'Dust Devil',
    brand: 'TERRA',
    cls: 'A',
    body: 'suv',
    color: '#d9a23a',
    accent: '#3b2f1e',
    pi: 688,
    stats: { topSpeed: 245, accel: 5.6, handling: 0.68, braking: 0.7, nitro: 0.62 },
    length: 4.9,
    width: 2.1,
    gearCount: 6,
    ai: { aggression: 0.55, cornering: 0.72, consistency: 0.9, braking: 0.78, tag: '稳健' },
    driver: '高 野',
    desc: '沙漠改装越野车，皮实、稳健，砂石路面上谁也别想甩开它。'
  },
  {
    id: 'drift-king',
    name: 'Drift King',
    brand: 'KAIDO',
    cls: 'A',
    body: 'drift',
    color: '#ff2e63',
    accent: '#1a1a1f',
    pi: 736,
    stats: { topSpeed: 262, accel: 4.7, handling: 0.89, braking: 0.75, nitro: 0.7 },
    length: 4.4,
    width: 1.92,
    gearCount: 6,
    ai: { aggression: 0.93, cornering: 0.84, consistency: 0.68, braking: 0.76, tag: '激进' },
    driver: '顾 燃',
    desc: '后驱漂移机器，横着过弯才是正确姿势。观赏性拉满。'
  },
  {
    id: 'thunderbolt',
    name: 'Thunderbolt',
    brand: 'IRON',
    cls: 'B',
    body: 'muscle',
    color: '#2f6fdb',
    accent: '#e8e8ef',
    pi: 618,
    stats: { topSpeed: 255, accel: 4.1, handling: 0.62, braking: 0.66, nitro: 0.58 },
    length: 4.8,
    width: 2.0,
    gearCount: 5,
    ai: { aggression: 0.66, cornering: 0.7, consistency: 0.86, braking: 0.72, tag: '老练' },
    driver: '陈 默',
    desc: 'V8 肌肉车，直线推背感一流，弯道需要耐心。'
  },
  {
    id: 'volt',
    name: 'Volt',
    brand: 'LUMEN',
    cls: 'S1',
    body: 'ev',
    color: '#00d5b0',
    accent: '#0b2b2a',
    pi: 848,
    stats: { topSpeed: 302, accel: 2.1, handling: 0.86, braking: 0.85, nitro: 0.84 },
    length: 4.6,
    width: 1.96,
    gearCount: 1,
    ai: { aggression: 0.7, cornering: 0.9, consistency: 0.88, braking: 0.86, tag: '精准' },
    driver: '白 泽',
    desc: '纯电超跑，零延迟扭矩。单速变速箱，出弯即弹射。'
  },
  {
    id: 'rally-fox',
    name: 'Rally Fox',
    brand: 'RIDGE',
    cls: 'B',
    body: 'rally',
    color: '#f2c14e',
    accent: '#20242c',
    pi: 642,
    stats: { topSpeed: 232, accel: 4.9, handling: 0.81, braking: 0.79, nitro: 0.55 },
    length: 4.15,
    width: 1.86,
    gearCount: 6,
    ai: { aggression: 0.6, cornering: 0.8, consistency: 0.9, braking: 0.8, tag: '稳健' },
    driver: '苏 晚',
    desc: '四驱拉力掀背，抓地力惊人，越野切线是它的主场。'
  },
  {
    id: 'streetline',
    name: 'Streetline',
    brand: 'TOKYO',
    cls: 'A',
    body: 'street',
    color: '#e9e9f2',
    accent: '#ff3d81',
    pi: 722,
    stats: { topSpeed: 272, accel: 4.4, handling: 0.78, braking: 0.76, nitro: 0.74 },
    length: 4.5,
    width: 1.94,
    gearCount: 6,
    ai: { aggression: 0.78, cornering: 0.82, consistency: 0.74, braking: 0.78, tag: '激进' },
    driver: '江 夏',
    desc: '东京湾街头改装车，霓虹下的夜跑之王。'
  }
];

/* 观战/冠军赛中 8 位 AI 车手（与车辆一一对应） */
HR.DRIVERS = HR.CARS.map(function (c) {
  return { id: c.id + '-driver', name: c.driver, carId: c.id, tag: c.ai.tag };
});

/* ============================================================
 * AI 难度
 * aiSkill 0..1：直接映射到 ai.js 的 skill
 * ============================================================ */
HR.DIFFICULTIES = [
  { id: 'rookie', name: '新手', aiSkill: 0.55, aiAggression: 0.45, desc: '适合第一次上手的车手，AI 会留出明显空间。' },
  { id: 'pro', name: '职业', aiSkill: 0.72, aiAggression: 0.65, desc: '势均力敌的对手，需要走好每一个弯。' },
  { id: 'ace', name: '传奇', aiSkill: 0.88, aiAggression: 0.86, desc: 'AI 会贴着你过弯，任何失误都会被放大。' }
];

/* ============================================================
 * 赛事
 * track: { seed, lengthKm, zones[] }
 * timeOfDay: 0..24；weather: 'clear'|'dawn'|'dusk'|'night'|'rain'
 * ============================================================ */
HR.EVENTS = [
  {
    id: 'e1',
    name: '海岸序章',
    subtitle: 'COASTAL PROLOGUE',
    desc: '黄昏的海岸公路，落日把弯道拉得很长。地平线嘉年华的第一战。',
    laps: 2,
    timeOfDay: 17.6,
    weather: 'clear',
    difficulty: 'pro',
    reward: 1200,
    track: { seed: 1101, lengthKm: 3.4, zones: ['coast', 'desert', 'festival'] }
  },
  {
    id: 'e2',
    name: '沙丘狂飙',
    subtitle: 'DUNE RUSH',
    desc: '正午的沙漠峡谷，高温与砂石考验轮胎。谁能在直道尽头刹得更晚？',
    laps: 2,
    timeOfDay: 13.2,
    weather: 'clear',
    difficulty: 'pro',
    reward: 1500,
    track: { seed: 2202, lengthKm: 3.6, zones: ['desert', 'mountain', 'festival'] }
  },
  {
    id: 'e3',
    name: '山城夜雨',
    subtitle: 'MIDNIGHT HILLS',
    desc: '暴雨中的山城街道，霓虹在湿滑路面上碎成一片。抓地力是唯一的信仰。',
    laps: 2,
    timeOfDay: 21.6,
    weather: 'rain',
    difficulty: 'ace',
    reward: 1800,
    track: { seed: 3303, lengthKm: 3.8, zones: ['city', 'forest', 'mountain', 'festival'] }
  },
  {
    id: 'e4',
    name: '地平线总决赛',
    subtitle: 'HORIZON FINALE',
    desc: '跨越大海、沙漠与城市的终极环线，日落时分，冠军在此加冕。',
    laps: 2,
    timeOfDay: 19.2,
    weather: 'clear',
    difficulty: 'ace',
    reward: 2600,
    track: { seed: 4404, lengthKm: 4.2, zones: ['coast', 'desert', 'city', 'mountain', 'festival'] }
  }
];

/* 自由驾驶 / AI 观战默认赛道 */
HR.FREE_TRACK = {
  name: '自由驾驶 · 环岛公路',
  seed: 9001,
  lengthKm: 3.6,
  zones: ['coast', 'desert', 'forest', 'festival']
};
HR.SPECTATE_EVENT_ID = 'e4';

/* ============================================================
 * 冠军赛
 * ============================================================ */
HR.CHAMP_POINTS = [25, 18, 15, 12, 10, 8, 6, 4];
HR.CHAMP = {
  name: '地平线冠军赛',
  desc: '四站积分赛，每站名次换算积分，总分最高者加冕地平线冠军。',
  events: ['e1', 'e2', 'e3', 'e4'],
  creditPerPoint: 40
};

/* ============================================================
 * 默认设置
 * ============================================================ */
HR.DEFAULT_SETTINGS = {
  volume: 0.7,
  music: true,
  sfx: true,
  quality: 'high',
  units: 'kmh',        // 'kmh' | 'mph'
  camera: 'chase',     // 'chase' | 'hood'
  difficulty: 'pro',   // HR.DIFFICULTIES.id
  autopilot: false,    // 玩家车默认交给 AI
  showHints: true,
  spectateSpeed: 1     // 1 | 2 | 4
};

/* 设置项合法值（game.js 校验用） */
HR.SETTING_ENUMS = {
  quality: ['low', 'medium', 'high'],
  units: ['kmh', 'mph'],
  camera: ['chase', 'hood'],
  difficulty: ['rookie', 'pro', 'ace'],
  spectateSpeed: [1, 2, 4]
};

/* ============================================================
 * 操作说明（UI help 屏、提示条使用）
 * ============================================================ */
HR.CONTROLS = [
  { keys: 'W / ↑', action: '油门' },
  { keys: 'S / ↓', action: '刹车 / 倒挡减速' },
  { keys: 'A D / ← →', action: '转向' },
  { keys: 'Space', action: '手刹（漂移）' },
  { keys: 'Shift', action: '氮气加速' },
  { keys: 'C', action: '切换视角（追尾 / 引擎盖）' },
  { keys: 'R', action: '脱困复位' },
  { keys: 'H', action: '接管 / 交给 AI' },
  { keys: 'Tab', action: '观战：切换镜头车辆' },
  { keys: 'Enter', action: '观战：接管当前镜头车辆' },
  { keys: 'T', action: '观战：切换倍速（1x / 2x / 4x）' },
  { keys: 'P / Esc', action: '暂停' },
  { keys: 'M', action: '静音' },
  { keys: '左摇杆', action: '手柄转向（自动识别）' },
  { keys: 'RT / LT', action: '手柄油门 / 刹车' },
  { keys: 'A / X', action: '手柄手刹 / 氮气' }
];

/* 起步提示（HUD 底部轮播） */
HR.HINTS = [
  '弯前刹车、弯心给油，是刷圈速的第一原则。',
  '高速过弯时轻点手刹可以甩尾，漂移会积攒氮气。',
  '绿线以外是越野区，速度会大幅下降。',
  '尾流里加速更快：贴着前车跑，再找机会抽头。',
  '按 H 可以让 AI 接管你的赛车，按 Tab 在观战中切车。',
  '氮气不要一次喷完，出弯时再按 Shift 更划算。'
];

/* 名次积分表（HUD / 结算展示用） */
HR.POSITION_LABEL = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
