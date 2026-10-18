# Horizon Rush · 极速地平线 —— 技术契约 v1.0

> 本文件是唯一接口契约。所有模块必须严格遵守，**不得擅自更改接口/字段名**。
> 若确需变更，先通知 Lead，由 Lead 统一改契约与消费方。

## 0. 铁律（所有模块）

1. **零依赖、零构建、零外部资源**：纯静态 HTML/CSS/JS。不使用 CDN、图片、字体文件、音频文件、npm 包。
2. **经典脚本，不是 ES Module**：所有 js 文件用 `<script src>` 顺序加载，模块间只通过全局命名空间 `window.HR` 通信。**不得使用 import/export**。
3. **UTF-8 无 BOM，LF 换行**。简体中文注释 + 中英混合标识符（标识符一律英文）。
4. **本机无法执行 shell / Node / 浏览器自动化**。所有代码必须经过仔细静态自审：所有 `HR.xxx` 引用必须与契约和被调文件一致；对 `null/undefined/NaN` 做防御；不得依赖运行时调试。
5. **文件所有权**：只修改任务中分配给你的文件；其它文件只读。不要动 `index.html`、`config.js`、`util.js`、`game.js`、`selftest.js`（Lead 所有）。
6. **频率/单位**：距离 m，速度 m/s（HUD 里转 km/h），角度 rad，时间 s，质量 kg。
7. **性能目标**：中端笔记本 60fps @ 1600×900；渲染循环内避免大对象分配、避免 DOM 操作（HUD 由 ui.js 每帧更新但用缓存节点）。
8. **禁止在模块加载时产生副作用**：文件顶层只做「定义/赋值 HR.xxx」。`game.js` 的 `HR.boot()` 由 DOMContentLoaded 触发。
9. 浏览器目标：Chrome/Edge 110+。可用 ES2020 语法（可选链、??、class、箭头函数），**不要用** TS、JSX、top-level await、私有字段 `#x`。

## 1. 目录与加载顺序

```
horizon-rush/
  index.html            (Lead)
  ARCHITECTURE.md       (Lead)
  README.md             (Lead)
  css/style.css         (UI 负责人)
  js/config.js          (Lead)
  js/util.js            (Lead)
  js/audio.js           (Audio 负责人)
  js/track.js           (Track 负责人)
  js/car.js             (Physics 负责人)
  js/ai.js              (Physics 负责人)
  js/render.js          (Render 负责人)
  js/ui.js              (UI 负责人)
  js/game.js            (Lead)
  js/selftest.js        (Lead)
```

index.html 加载顺序固定：
`config → util → audio → track → car → ai → render → ui → game → selftest`
（audio/track/... 中任何一个只定义 API，不执行初始化。）

全局命名空间：
```js
window.HR = window.HR || {}; // 各文件开头统一写这一行
```

## 2. 坐标系与赛道（track.js 产出）

- 世界坐标：X 右、Y 上、Z 前（右手系，Y+ 朝上）。单位 m。
- 赛道是**闭合回路**，用沿曲线的弧长参数 `s ∈ [0, track.length)` 表示，自动 wrap。
- 横向偏移 `x`：沿赛道前进方向，`+x` = 右侧，`0` = 中心线，单位 m。
- 车辆世界坐标 = `track.sample(car.s, car.x)`。

### 2.1 segment 字段（每段约 2.5~4 m，必须全部提供）
```js
{
  i,                    // 段索引 int
  s,                    // 段起点累计沿路距离 m
  x, y, z,              // 段起点中心线世界坐标
  ex, ey, ez,           // 段终点中心线世界坐标
  dirX, dirZ,           // 水平前进方向单位向量
  rightX, rightZ,       // 水平右向单位向量
  yaw,                  // atan2(dirX, dirZ)
  slope,                // (ey - y) / len
  len,                  // 段长 m (>0)
  width,                // 该段路面全宽 m (12~24)
  curve,                // 有符号曲率 1/m：>0 右转，<0 左转
  zone,                 // 'festival'|'coast'|'desert'|'forest'|'mountain'|'city'
  jitter                // 0..1 装饰随机数
}
```

### 2.2 track 对象
```js
track = {
  id, name, seed, length, count,          // count = segments.length
  segments,                               // 上面的数组
  startS: 0,                              // 起跑线 s
  checkpoints: [s, ...],                  // 检查点门的 s（不含起跑线），约 3 个，递增
  racingLine: Float32Array,               // 长度 = count；每段推荐的横向走线偏移 m（弯内为正负号按弯向）
  gridSlots: [{s, lateral}, ... 8],       // 发车格：gridSlots[0] 杆位；s 在起跑线之后（即 s < length，倒数位置）
  scenery: [{seg, side, off, kind, scale, variant}],  // 仅渲染用
  minimap: {
    points: [{x, z}, ...],                // 中心线采样，约每 25m 一点
    bounds: {minX, maxX, minZ, maxZ},
    checkpoints: [{x, z}, ...],           // 与 checkpoints 对应
    start: {x, z}
  },
  // 方法（必须实现，性能敏感，避免内部 new 对象过多）
  segAt(s) -> int,                        // wrap 后所在段索引
  sample(s, lateral) -> {x,y,z, dirX,dirZ, rightX,rightZ, yaw, slope, width, curve, zone, segIndex},
  widthAt(s) -> number,
  curveAt(s) -> number,
  racingLineAt(s) -> number,              // 插值后的走线横向偏移
  zoneAt(s) -> string
}
```

### 2.3 生成 API
```js
HR.Track.generate(opts) -> track
// opts: { seed:int, name:string, lengthKm:number, zones:string[], startZone?:string }
```
**硬性保证（selftest 会检查）**：
- 闭合、不自交（推荐**星形极坐标回路**：角度 θ 均分 N 个控制点，半径 r = base*(1 + 0.28*sin(3θ+a) + 0.16*sin(5θ+b) + 0.08*sin(7θ+c))，再 Catmull-Rom 采样；这样天然无自交）。
- `curve` 连续平滑，`|curve| <= 0.022`（最小弯半径 ≈45m）；相邻段 `|curve[i]-curve[i-1]| <= 0.004`。
- `width` 平滑（相邻差 <= 0.35m），整体 13~22m 之间；起跑区（festival）加宽到 ~22m。
- `racingLine[i]` 绝对值 <= width/2 - 2.2；平滑（相邻差 <= 0.35m）。
- `gridSlots` 共 8 个：s 从 startS 向后倒推（如 startS - 6 - i*7），两两间距 >= 5m；lateral 在 ±3.2m 交替（±1.6m 也行，但两车横向距离 >= 2.6m）。
- checkpoints = 3 个（约 1/3、2/3、末段）且都在 (0,length) 内并递增。
- 同 seed + lengthKm **必须完全确定性一致**（浮点结果可重复；不要用 Math.random）。
- 装饰 scenery：60~180 个，`|off| >= width/2 + 2`，按 zone 选 kind，`kind` 只能取：
  `'palm'|'cactus'|'pine'|'rock'|'building'|'billboard'|'grandstand'|'tent'|'flag'|'lightpole'|'balloon'|'sign'|'bush'|'barrier'`
  起跑区必须有 grandstand / tent / flag / billboard 氛围。
- 生成耗时 < 30ms（4~6km）。允许缓存：`HR.Track.generate` 内部用 Map 以 seed+lengthKm 缓存。

## 3. 车辆物理（car.js）

```js
HR.Physics = {
  makeCar(spec, opts) -> car,
  step(car, input, track, dt, time),          // dt 单位 s，内部 clamp 到 [0, 0.05]
  resolveCollisions(cars, track),             // 成对处理，修改 car.x / car.v / car.bump
  resetToTrack(car, track),
  kmh(v) -> number
}
```

### 3.1 input
```js
{ throttle: 0..1, brake: 0..1, steer: -1..1, handbrake: 0|1, nitro: bool }
```

### 3.2 car 对象（makeCar 创建，game 补充 lap/place 等）
```js
{
  id, spec, name,          // spec 是 HR.CARS 里的对象
  s, x, v,                 // 沿路距离 / 横向偏移 / 前向速度 m/s
  steer, throttle, brakeInput, handbrake, nitroOn,
  driftAngle,              // 视觉漂移角 rad（±0.6 内），renderer 用
  gear, rpm,               // 1..gearCount, 800..9000
  boost, boosting,         // 氮气槽 0..1 / 本帧是否喷射
  offroad, drifting, driftScore, driftCombo,
  bump,                    // 0..1 撞击抖动，renderer/audio 用，step 内自动衰减
  aiStuckTime,             // AI 卡住累计秒数，game 用来救援
  control: 'ai',           // game 改：'player'|'ai'
  ai: null,                // game 挂的 AI driver（见 ai.js）
  // 以下 game 维护，physics 不得覆盖：
  dist, lap, lapStartTime, lastLap, bestLap, totalTime,
  finished, finishTime, place
}
```
`opts`: `{ id:string, name:string, s:number, x:number, v?:number }`。物理量：`v>=0`，`s` wrap 到 [0,length)。

### 3.3 step 语义
- 速度映射（必须实现）：`topSpeed` 是 km/h，转 m/s；`accel` 是 0-100km/h 秒数，换算基础加速度 `a0 ≈ 27.8 / accel`（m/s²），随速度衰减；牵引/刹车/阻力按 `handling/braking/nitro` 属性调制。
- 转向：低速灵敏、高速迟钝；横向移动速率 ≈ `steer * v * dt * k`（k 由 handling 决定，约 0.06~0.10/rad 等价），同时受曲率离心力影响：`x -= curve * v * v * dt * 0.0016 * (1 - 0.35*handling)`。玩家不转向时，弯道会轻微向外甩。
- 漂移：`handbrake` 或（|steer|>0.55 且 v>22）时 `drifting=true`，`driftAngle` 平滑逼近 `steer*0.55`，横向响应变大、v 略降；`driftScore += Math.abs(driftAngle)*v*dt`（仅展示，不惩罚）。
- 越界：路面半宽 = `width/2`。`|x| > width/2` 时 `offroad=true`：额外摩擦、极速限制为 ~40%、随机 bump、`x` 最大到 `width/2 + 6`（软墙：超出时强制回拉并大幅降速）。
- 氮气：`nitro` 且 `boost>0.01` 时 `boosting=true`，额外推力 + 最高速 +8%；`boost` 消耗约 0.28/s；不喷时缓慢回充 0.045/s；漂移时回充 +0.06/s。
- 挡位/转速：按速度分档（每档对应速度区间），rpm 归一化用于 HUD/音频，换挡瞬间 rpm 回落。
- 数值目标（selftest/手感基准）：0-100km/h 约 3~8s；极速 200~380km/h；60m 半径弯道通过速度约 100~125km/h；草地极速约为路面的 40%。
- 处理首尾 wrap：s 跨 0 时正常；不得出现 NaN、Infinity。
- `resolveCollisions`：对每对车，若 `|Δs| < (lenA+lenB)/2 + 0.5` 且 `|Δx| < (wA+wB)/2`，沿 x 分离（各推一半）、v 少量衰减（×0.97~0.995）、bump=0.6。禁止把车推离 `width/2+6` 范围外。
- `resetToTrack`：x 朝最近的 `racingLine`，driftAngle=0，v*=0.3，offroad=false。

## 4. AI 车手（ai.js）

```js
HR.AI.createDriver(car, track, opts) -> driver
// opts: { skill: 0..1, aggression: 0..1, seed: int, personality: {braking,cornering,consistency,aggression} }
driver = {
  think(car, track, raceCtx, dt) -> input,   // 同 physics input
  styleTag: string                            // '激进'|'稳健'|'精准'|'凶狠'|'老练'
}
```
- `raceCtx = { cars: car[], time: number, targetCar: car|null }`。**AI 只读 raceCtx，不得访问 DOM/renderer/audio/track 以外的东西**。
- 必须实现（这是本项目的核心卖点）：
  1. **循迹**：沿 `track.racingLineAt(s)` 行进，前瞻 `look = 10 + v*1.1`（m），横向 PD：`steer = clamp((targetX - x)*0.45 + (targetX - xPrev)*..., -1, 1)`；对横向速度/误差做平滑。
  2. **速度规划**：扫描前方 `30 + v*2.2` m 的最大 `|curve|`，过弯极限 `vmax = sqrt(latAccel / |curve|)`，`latAccel = 7.5 + 7.5*skill`（m/s²）；刹车按 `braking` 属性与前瞻距离提前；出弯全油门。
  3. **超车/避让**：前方 6~30m 内有车且 `|Δx| < 2.8` 时，选择左右空间更大的一侧偏移 `targetX ± (2.2 + aggression*1.6)`（不得超出路面 - 1.2m），偏移在 1.5s 内平滑；空间不足时松油跟随（保持 5~8m 车距）；被追尾不前车急刹。
  4. **个性差异**：`opts.personality`（来自 `spec.ai`）调制走线偏移、刹车点、反应延迟（0.03~0.18s 的输入滞后缓存）、失误率（0~1.5%/s 小幅走神：走线偏移 1~2m 持续 0.4s）。不同车必须跑出不同风格与圈速差 1~4%。
  5. **越野恢复**：`|x| > width/2 - 1.5` 时向中心回打；`v < 2` 持续 2s 时给自己 `aiStuckTime` 累加，并输入油门+回中（救援由 game 负责）。
  6. **难度**：`skill` 直接缩放 latAccel、油门响应、走线精度；最多比物理极限快 3%（禁止瞬移/穿模）。
- 确定性：同一 seed、相同初始状态，多次模拟结果一致（selftest 要求）。
- 性能：8 车 × 120Hz，单次 think < 0.05ms 量级（避免每帧分配数组/对象；可用每 driver 复用的 scratch 对象）。
- 不要写 lap/名次判断，那是 game 的职责。

## 5. 渲染（render.js）

```js
HR.Renderer = {
  init(canvas, opts?),   // opts: {quality}
  resize(),
  setQuality(q),         // 'low'|'medium'|'high'
  drawFrame(frame),
  setPaused(bool)        // 可选，用于暂停时停止内部动画
}
```
### 5.1 frame（game.js 每帧构造一次）
```js
{
  track,                       // track 对象
  cars,                        // car[]（8 辆，含玩家）
  time,                        // 游戏累计时间 s（用于动画）
  dt,                          // 帧间隔 s（clamp 0.1）
  camera: {
    mode: 'chase'|'hood'|'trackside'|'heli',   // 默认 chase
    targetCar: car|null,       // 主视角车；null 时取 cars[0]
    shake: 0..1                // 撞击/越野抖动
  },
  environment: { timeOfDay: 0..24, weather: 'clear'|'dawn'|'dusk'|'night'|'rain' },
  race: { state: 'countdown'|'racing'|'finished', countdown: number },
  player: car|null,            // 玩家控制的车（用于高亮/速度特效），可为 null
  quality: 'low'|'medium'|'high'
}
```
### 5.2 要求
- **伪 3D 投影**：相机有位置/朝向（yaw+pitch 近似），投影公式建议
  `camSpace = worldPoint - camPos; sx = dot(camSpace, right); sy = dot(camSpace, up); depth = dot(camSpace, forward); screenX = W/2 + sx*focal/depth; screenY = H/2 - sy*focal/depth; focal ≈ H*0.9`。depth<=0.6 丢弃。
- 相机**内部平滑**（lerp），chase：车后 7.5~9.5m、高 3.0m，看向车前 12m；hood：车头 1.2m 高；trackside：车前方 45~70m 的路边固定机位，看向车；heli：后上方 25m/高 45m。切车时相机也要跟随 targetCar。
- 画家算法：远→近。先画天空/远山/地面，再画路面（逐段四边形、车道线、路肩、护栏），再把 scenery 与车辆收集成 {depth, draw} 列表按 depth 降序绘制。
- 每帧对每辆车调用 `track.sample(car.s, car.x)` 得世界坐标。
- 车：程序化绘制后视图（车体/车顶/后窗/尾灯/尾翼/轮胎/扩散器），用离屏 canvas 按 `spec.body`(gt/suv/drift/muscle/ev/rally/hyper/street) 预渲染多个变体并 `drawImage`；刹车灯（`car.brakeInput>0.2` 亮）、氮气火焰（`car.boosting`）、漂移烟雾（`car.drifting`）、越野尘土（`car.offroad`）；车顶画名次标签 `P{car.place} {car.name}`，玩家车高亮描边。
- 场景：天空渐变 + 太阳/月亮 + 云 + 多层远山视差（随相机 yaw 平移）+ 起跑/检查点门架 + 广告牌 + 路肩护栏。按 seg.zone 使用不同调色板（渲染器自己定义，见下）。
- 特效：速度线（高速时）、暗角、屏幕抖动、雨天雨丝（weather='rain'）。
- 推荐调色板（zone）：festival 紫粉橙、coast 蓝绿+沙滩、desert 橙黄沙、forest 深绿、mountain 岩灰+雪、city 霓虹蓝紫。timeOfDay 影响天色：<6 夜、6-8 晨、8-16 日、16-19 黄昏、>19 夜。
- **不得修改传入对象**；不得调用 UI/Audio；空 cars 不允许崩。
- 帧内不创建大对象：预分配数组、复用 scratch；DPR 上限 2（high）/1.5（medium）/1（low）；draw distance 380~480m。
- 需要暴露 `HR.Renderer.getCameraYaw()`（可选，HUD 不用）。

## 6. UI（ui.js + css/style.css）

```js
HR.UI = {
  init(rootEl, handlers),        // rootEl = #ui-root（index.html 已提供）
  showScreen(screen, data),      // 'title'|'events'|'cars'|'settings'|'results'|'champ'|'pause'|'help'|'loading'|'spectate'
  hideScreens(),
  updateHUD(hud),                // 每帧调用；首帧自动建 DOM
  toast(text, ms?),              // 顶部浮动提示，默认 2200ms
  isBlocking() -> bool           // 是否有全屏菜单挡住游戏（game 用它判断是否暂停物理）
}
```
### 6.1 handlers（game.js 实现并传入，UI 只调用，不得直接改游戏状态）
```js
{
  onQuickRace(), onChampionship(), onSpectate(), onFreeRoam(),
  onHelp(), onSettings(),
  onTitle(),                                  // 回标题
  onOpenEvents(mode),                         // mode: 'quick'|'champ'
  onSelectEvent(eventId),
  onSelectCar(carId),
  onStartRace(opts),                          // {eventId, carId, difficulty, mode:'race'|'champ'|'spectate'|'free', autopilot}
  onSettingsChange(patch),                    // 增量设置 patch 对象
  onPause(), onResume(), onRestart(), onQuitToTitle(),
  onRaceAgain(), onNextEvent(),
  onTakeOver(carId),                          // 玩家接管某辆 AI 车
  onGiveToAI(),                               // 当前车交给 AI
  onCameraMode(),                             // 切换视角
  onToggleAutopilot(),
  onToggleMute(), onToggleMusic(),
  onSpeedToggle(),                            // 观战倍速
  onSelectSpectateCar(carId)
}
```
### 6.2 screen 数据结构（UI 必须实现以下渲染）
- `title`: `{}` → Logo「HORIZON RUSH 极速地平线」+ 按钮：快速比赛 / 冠军赛 / AI 观战 / 自由驾驶 / 设置 / 操作说明 + 版本号 + 存档记录摘要（`data.records`）。
- `events`: `{ mode:'quick'|'champ', bestRecords, champProgress }` → 卡片列表（名称、描述、圈数、时间、难度、最佳成绩），点击 `onSelectEvent(event.id)`；返回按钮。
- `cars`: `{ mode, event, cars, selectedCarId, difficulty, difficultyList, autopilot, record }`
  → 左侧车辆网格（8 车，显示品牌/型号/分数 PI/属性条），右侧详情（属性条、AI 车手风格标签、说明），底部：难度选择（新手/职业/传奇）、自动驾驶开关、开始比赛按钮；`mode==='spectate'` 时按钮文字「开始 AI 大战」，隐藏自动驾驶。
- `settings`: `{ settings }` → 音量滑条、音乐开关、音效开关、画质、单位（km/h | mph）、默认视角、难度、显示提示；改动即回调 `onSettingsChange(patch)`；返回按钮。
- `results`: `{ title, eventName, trackName, laps, rows:[{place,name,carName,carColor,isPlayer,totalTime,bestLap,gap,points,ai}], playerPlace, credits, bestLapText, actions:['again','next','title','garage'], nextLabel }` → 名次表 + 按钮（按 actions 显示），按钮回调对应 handler。
- `champ`: `{ standings:[{place,name,carName,carColor,points,isPlayer}], nextEventId, nextLabel }` → 积分榜 + 下一站按钮。
- `pause`: `{ mode, autopilot, muted, cameraMode, spectateSpeed, canTakeOver, spectateCars:[{id,name,carName,isPlayer,control}] }` → 继续 / 重开 / 视角 / 自动驾驶 / 静音 / 返回标题 / （观战时）接管列表。
- `help`: `{}` → 操作说明（键盘+手柄）、玩法提示、AI 说明。
- `loading`: `{ label, pct }` → 居中进度条。
- `spectate`（观战信息面板）：由 updateHUD 处理，不单独用。

### 6.3 HUD（updateHUD(hud) 的数据）
```js
hud = {
  mode: 'race'|'champ'|'spectate'|'free'|'timetrial',
  car, cars, track,
  race: {
    state: 'countdown'|'racing'|'finished',
    countdown: 3..0,           // 用于显示 3/2/1/GO
    lap: 1, laps: 3,
    position: 2, totalCars: 8,
    raceTime: 12.34,           // 总用时 s
    lastLap: 63.21, bestLap: 61.4, lapDelta: 0.35,
    standings: [{id,name,carName,carColor,place,lap,dist,finished,control}], // 已排序
    message: ''                // 可选提示（如「最后一圈」「被超越」）
  },
  cameraMode, autopilot, muted, spectate: bool, spectateSpeed,
  fps: number,
  settings: { units:'kmh'|'mph', showHints:true }
}
```
HUD 内容：速度表（指针+数字）、挡位、转速条、氮气条、漂移分、圈数/名次、本圈/最佳/总计计时、右侧名次表（8 行，玩家高亮、AI/玩家标记）、左下小地图（用 track.minimap 绘制一次缓存路径 + 每帧画车点）、屏幕中央倒计时大字、底部提示条（操作提示）、观战模式标注「AI 大战 · 按 Tab 切车 / Enter 接管」。
- 样式：Forza Horizon 风格（紫橙渐变、玻璃拟态、霓虹描边、斜切角、大号斜体数字）。中文字体栈：`"Segoe UI", "Microsoft YaHei", system-ui, sans-serif`。
- 所有交互用 `click`（触屏/鼠标通吃）；按钮加 `pointer-events:auto`，HUD 容器 `pointer-events:none`。
- UI 不得引用 renderer/audio 内部对象；只读 HR.CARS / HR.EVENTS / HR.DIFFICULTIES / HR.DEFAULT_SETTINGS。

## 7. 音频（audio.js）

```js
HR.Audio = {
  init(),                    // 幂等；应在首次用户手势时调用（game 会调）
  setEnabled(bool), setVolume(0..1), setMusicEnabled(bool),
  update(info),              // 每帧：{ car, cars, track, mode, paused, raceState, dt, time }
  play(name),                // 'ui_click'|'ui_confirm'|'ui_back'|'countdown'|'go'|'finish'|'checkpoint'|'collision'|'nitro'|'shift'|'rescue'
  suspend(), resume()
}
```
- WebAudio 程序化合成：引擎（锯齿+方波，频率随 rpm/油门）、风噪（滤波白噪，随速度）、轮胎摩擦（漂移时）、氮气、撞击、倒计时、UI；背景音乐用简单和弦/琶音合成循环（可关，默认开）。
- 首次 `play` 前需 `init()`；`init()` 若被浏览器 autoplay 策略阻止要静默降级，不得抛错。
- 所有节点音量做平滑（setTargetAtTime），避免爆音/咔嗒声。
- 明确禁止外部音频文件。

## 8. game.js（Lead 所有，供理解）

- 启动：DOMContentLoaded → `HR.boot()`；异常显示错误覆盖层（含 stack），页面不白屏。
- 输入：键盘 W/S/A/D 或 ↑↓←→，Space 手刹，Shift 氮气，C 视角，P/Esc 暂停，R 复位，H 接管/交给 AI，Tab 循环观战车，Enter 接管观战车，T 观战倍速，M 静音。
- 比赛流程：车辆/难度选择 → 生成赛道（loading）→ 发车格 → 3 秒倒计时 → 比赛（物理 120Hz 固定步长）→ 完赛结算（含冠军赛积分/存档）。
- 观战：全部 AI，导演机位 + 切换车辆 + 随时接管。
- 存档：localStorage key `hr_save_v1`（设置/积分/最佳圈速）。

## 9. 自检（selftest.js，Lead）

`index.html?selftest=1` 运行：赛道生成 3 次一致性/字段/数值合法性 + 8 车 AI 全模拟 3 圈（120Hz 纯逻辑，不渲染）+ 物理极端输入稳定性，输出 PASS/FAIL 清单到页面和 console。各模块不得为此加特殊分支（自检走真实代码路径）。

## 10. 交付要求（各负责人回答 Lead 时）

回复格式：
1. 已完成文件列表 + 每个文件行数；
2. 实现了哪些契约 API（对照第 N 节）；
3. 已知风险/未实现项（诚实列出）；
4. 自审记录：通读代码发现并修复的问题（至少 3 条）。
不要在回复里贴大段代码。
