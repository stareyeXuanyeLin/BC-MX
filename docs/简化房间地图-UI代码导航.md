# 简化房间地图 UI 代码导航

> 本文档服务于 UI 重构/优化任务。记录简化房间地图（第二功能模块）的代码位置、数据流与已知问题，供新会话直接接手。
>
> 基线提交：`8a468b0`（main 分支，2026-08-01）
> 项目根目录：`D:/agentData/佩拉的书桌/BC-Plugin/BC-Map-Saver-dev`

## 1. 文件总览

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/00-userscript-header.js` | ~20 | Userscript 元信息（版本 0.2.0），IIFE 入口 |
| `src/01-runtime.js` | ~90 | 常量（VERSION 等）、运行时状态、通用工具（toast、escapeHTML、storageKey 等） |
| `src/02-storage.js` | ~140 | 地图存档的规范化与本地持久化（第一阶段，UI 优化不涉及） |
| `src/03-exchange.js` | ~150 | 单图/整库导入导出与冲突策略（第一阶段，UI 优化不涉及） |
| `src/04-map-bridge.js` | ~320 | **地图数据层**：静态网格、玩家列表、传送核心、房间同步触发 |
| `src/05-minimap.js` | 641 | **简化房间地图 UI**（本任务主战场） |
| `src/05-ui.js` | ~260 | 存档管理面板 UI + 入口按钮 hook（第一阶段，"档"按钮） |
| `src/06-bootstrap.js` | ~110 | ModSDK 注册、hook 安装入口、公开 API、测试 API |

构建：`build.ps1` 按固定顺序拼接 `src/*.js` 到 `dist/BCMapSaver.user.js`（全部文件在同一个 IIFE 内，**函数跨文件可见，顺序敏感**：05-minimap.js 必须在 06-bootstrap.js 之前）。

```powershell
# 构建
powershell -File build.ps1            # 或 npm run build
# 测试（单进程模式，node:test）
npm test                              # 等价 node --test --test-isolation=none tests/*.test.js
```

## 2. 简化房间地图 UI（src/05-minimap.js）

### 2.1 面板结构与交互

当前设计（第 3 次迭代后的状态）：

```
┌──────────────────────────────────────────────┐  ← 标题栏（可拖动窗口）
│ 简化房间地图 [房间名]      [−][＋][⤢][×]       │
├──────────────────────┬───────────────────────┤
│ 房间成员              │   canvas 520×520      │
│ · Alice   (5, 5)     │   色块渲染 40×40 地图   │
│ · Bob    (10, 10)    │   滚轮缩放/拖拽平移     │
│ · 我      (20, 20)   │                       │
│ （最多 20 人，滚动）   │                       │
│ 提示                  │                       │
├──────────────────────┴───────────────────────┤
│ 状态条 / 操作区（选中提示、传送确认按钮）        │
└──────────────────────────────────────────────┘
```

- 面板：`#bms-minimap`，fixed 定位，JS 初始居中（`left: calc((innerWidth-778)/2)`），标题栏 pointer 事件拖动（`minimapPanelDrag`）
- 开关按钮：`#bms-minimap-toggle`，fixed (10, 570) 60×60，"图"字，位于"档"按钮（10, 500）正下方，地图房内常驻显示
- 成员列表：`#bms-minimap .bms-mm-roster`，左侧 222px，flex column，独立滚动，最多 20 人

### 2.2 关键函数索引（行号对应 `8a468b0`）

| 行号 | 函数 | 职责 |
|---|---|---|
| 43 | `injectMinimapStyle()` | 注入全部面板 CSS（单个 style 块） |
| 85 | `shouldShowMinimap()` | 显隐条件：ChatRoom + 地图房 + 地图视图激活 |
| 98 | `ensureMinimapToggle()` | 创建开关按钮（DOM，与游戏画布解耦） |
| 110 | `syncMinimapToggle()` | 按钮常驻显示逻辑（非地图房隐藏） |
| 117 | `ensureMinimapRoot()` | **面板 DOM 构建**：HTML 结构、初始定位、事件绑定（header 拖动、roster 点击、canvas 事件） |
| 186 | `fitMinimapView()` | 复位：缩放至整图 96% 并居中 |
| 197 | `minimapZoomAt(mx, my, factor)` | 以鼠标为锚点缩放（clamp 0.5~8） |
| 207 | `minimapEventToCanvasXY(canvas, rect, clientX, clientY)` | 事件坐标 → canvas 内部像素（按 rect/CSS 比例换算，免疫缩放） |
| 216 | `minimapCanvasToGridXY(mx, my, view, grid)` | **视口反算**：canvas 像素 → 格子（必须减 panX/panY，曾漏减导致鼠标错位） |
| 228 | `minimapGridToCanvas(x, y)` | 格子 → canvas 像素（渲染正向） |
| 235 | `rebuildMinimapBackground()` | 底图离屏 canvas：40×40 色块 + 不可通行暗化 + 网格线 |
| 270 | `playerPositionSignature()` | 玩家位置快照串（tick 对比用） |
| 275 | `findRoomCharacterAt(gx, gy)` | 格子上的玩家 |
| 284 | `drawMinimap()` | 每帧绘制：底图 blit + hover 高亮 + pending 目标框 + 选中连线 + 玩家圆点 + 名字浮层 |
| 367 | `renderMinimapRoster()` | 成员列表渲染（含选中态、"我"标记、坐标） |
| 389 | `minimapHandleRosterClick(memberNumber)` | 列表点击选中/取消（仅管理员） |
| 403 | `renderMinimapStatus()` | 底部状态区：模式提示 / 选中信息 / 传送确认按钮 |
| 453 | `teleportVerificationMessage(target, x, y)` | 传送结果校验文案（纯逻辑，可测） |
| 461 | `isTeleportMessageFor(data, memberNumber)` | 判断传送消息是否发给当前玩家（接收端增强用） |
| 471 | `installTeleportReceiveBoost()` | **接收端增强**：hook ChatRoomMessage，目标收到传送指令后强制广播位置（目标需装插件才生效） |
| 488 | `teleportWithVerify(member, x, y)` | UI 层传送入口：发送 + toast 链路 + 2.5s 后校验提示 |
| 507~560 | `minimapHandleWheel / PointerDown / PointerMove / PointerUp` | canvas 交互：缩放、拖拽、点击判定（4px 拖动阈值） |
| 574 | `minimapHandleClick(gx, gy)` | 点击逻辑：点玩家选中 / 选中后点格子进入待确认 |
| 611 | `minimapTick()` | 250ms 周期：地图数据变化检测 → 重建底图；玩家位置变化 → 重绘 + 刷新列表 |
| 635 | `openMinimap()` | 打开面板（进地图房自动调用） |
| 649 | `closeMinimap(manual)` | 关闭面板（manual 时本房间不再自动开） |
| 661 | `toggleMinimap()` | 开关切换 |
| 666 | `installMinimapHooks()` | ChatRoomRun（tick + 自动开 + 按钮同步）、ChatRoomMapViewUpdateFlag（底图脏标记）、ChatRoomSyncRoomProperties（房间切换重置）、ChatRoomLeave（关闭） |

### 2.3 状态变量（行 30~41）

```js
minimapOpen        // 面板是否打开
minimapAutoOpen    // 进地图房自动打开（手动关闭后置 false，换房间重置 true）
minimapGrid        // buildMapGridSnapshot() 结果（walkable/tileKind/字符串引用）
minimapView        // { zoom, panX, panY } 视口变换
minimapDrag        // canvas 拖拽状态（平移地图）
minimapPanelDrag   // 标题栏拖动状态（移动面板窗口）
minimapHover       // 鼠标所在格子
minimapSelected    // 选中的目标玩家 MemberNumber（管理员）
minimapPending     // 待确认传送 { member, x, y, walkable }
minimapPlayerSig   // 玩家位置签名（变化才重绘）
minimapDirty       // 底图脏标记（地图被编辑时置位）
minimapBgCanvas    // 离屏底图
```

### 2.4 配色与尺寸常量（行 6~28）

- 面板 778px 宽，canvas 520×520，成员列表 222px
- 瓦片 12px + 1px 间隙（40 格 = 519px）
- `MINIMAP_TILE_COLORS`：地板 #b8a48c / 室外 #a3b98d / 墙 #6a5d52 / 半墙 #96826e / 水 #7cb3d4 / 其他 #8a8f98 / 空 #232a36；不可通行叠加 45% 黑
- `MINIMAP_PLAYER_COLORS`：8 色轮转（按 MemberNumber 取模），自己白色圆点 + 蓝描边 + 头顶蓝点

## 3. 数据层（src/04-map-bridge.js）

| 行号 | 函数 | 职责 |
|---|---|---|
| 1 | `isMapRoom()` / `isRoomAdmin()` / `assertRoomMapAction()` | 权限与前置检查 |
| 88 | `getChatRoomMapViewTileLookup()` | Tile 定义表（lexical-first 读取） |
| 95 | `getChatRoomMapViewObjectLookup()` | Object 定义表 |
| 102 | `getChatRoomMapViewSize()` | 地图尺寸（默认 40×40） |
| 114 | `getPlayerCharacter()` | Player（lexical-first） |
| 121 | `getChatRoomCharacterList()` | ChatRoomCharacter（lexical-first） |
| 128 | `getRoomCharacterList()` | 玩家列表 = Player + 房间角色，**按 MemberNumber 去重**（曾出现两个自己） |
| 144 | `findRoomCharacter(memberNumber)` | 按编号找角色 |
| 167 | `isPositionWalkable(tile, obj)` | 静态可通行判定：四方向模拟原版 CanEnter(dir)，对象优先 |
| 179 | `tileKindOf(tile)` | 瓦片分类（墙/半墙/水/地板/室外） |
| 188 | `buildMapGridSnapshot()` | 网格快照（walkable/tileKind + 字符串签名缓存） |
| 220 | `getChatRoomMapViewTeleport()` | 原版传送函数（lexical-first） |
| 227 | `getChatRoomGetSettings()` | 原版房间设置提取（lexical-first） |
| 241 | `triggerRoomPropertiesSync()` | **迷雾翻转同步**：临时翻转 Fog → Update → 恢复 → Update，逼服务器广播房间属性（见 §5） |
| 271 | `getServerSend()` | ServerSend（lexical-first） |
| 278 | `createTeleportMessage()` | 传送 Hidden 消息构造（与原版 wire 格式一致） |
| 287 | `teleportCharacter(memberNumber, x, y)` | 传送核心：权限/边界/目标校验 → 原生函数优先，fallback 手发消息 → 迷雾翻转同步 |

## 4. 存档 UI（src/05-ui.js，第一阶段，一般不动）

- 入口按钮"档"：`ENTRY_BUTTON`（01-runtime.js 定义，位置 (10, 500) 60×60，仅管理员显示）
- `shouldDrawEntryButton()`（行 223）、`installHooks()`（行 232）：ChatRoomRun 画按钮 + ChatRoomClick 点击检测（走游戏画布管线，与简化地图的 DOM 按钮不同）
- 面板：`#bms-root` 全屏遮罩 + 存档列表卡片，dialog 组件 `showDialog/showConfirm/showMapForm/showImportOptions`

## 5. 已知问题与现状（重要）

### 5.1 传送对非地图视图目标无效（未解决）

**现象**：管理员传送目标玩家，目标处于地图视图时全房间立即生效；目标停留在聊天视图（Character 视图）时不生效。

**根因链**（已逐层验证）：

1. 传送消息（`ChatRoomChat` Hidden + Target）→ 目标端 `ChatRoomMapViewTeleportHiddenMessage` → `Player.Position` setter → 本地 `MapData.Pos` 立即更新（与视图无关，已验证安全）
2. **原版广播**依赖地图视图运行循环：`ChatRoomMapViewRun`（仅 Map 视图激活时执行）→ `ChatRoomMapViewUpdatePlayerSync()` 消费同步标志后 `ServerSend("ChatRoomCharacterMapDataUpdate")`。目标在聊天视图时无人消费标志 → 不广播
3. **方案 A（已实现，无效）**：传送后发 `ChatRoomAdmin Update` 触发房间属性广播 → 目标端 `ChatRoomSyncRoomProperties` → `ChatRoomMapViewInitializeCharacter(Player)` 无条件广播当前 MapData。实测无效，推测服务器对**内容无变化**的 Update 去重
4. **方案 B（已实现，无效）**：迷雾翻转制造真实变化 → 两次 Update 必然广播。实测依然无效。推测方向：
   - 服务器对 ChatRoomAdmin Update 的处理与预期不符（可能校验内容、可能要求经 `ChatRoomMapViewUpdateFlag` 延迟链路、可能根本不广播给聊天视图客户端）
   - 或目标端 `ChatRoomSyncRoomProperties` 执行时 `Player.MapData` 被某种机制重置为旧值（未验证）
   - 或目标端 InitializeCharacter 广播被服务器拒绝（未验证）
5. **方案 C（已实现，仅当目标也装插件时生效）**：`installTeleportReceiveBoost()` hook `ChatRoomMessage`，目标端收到传送指令后立即强制广播

**结论**：不依赖对方装插件的"聊天视图目标立即生效"目前没有可行路径。下一步排查建议：
- 用浏览器控制台在管理员端验证 `ServerSend` 是否真的发出两条 ChatRoomAdmin（网络面板）
- 让目标玩家开着控制台，观察是否收到 `ChatRoomSyncRoomProperties`（可在目标端临时注入日志）
- 若目标端收到 SyncRoomProperties 但位置没广播，检查目标端 `Player.MapData` 在执行 InitializeCharacter 时是否仍是新位置

### 5.2 其他已知边界

- 目标在聊天视图时，其他玩家看不到其位置变化（广播未发生）；目标切回地图视图后自动广播（原版机制，延迟生效）
- 传送落墙内：原版碰撞修正会把玩家推挤到邻近可站格（穿墙语义，预期行为）
- 目标客户端版本过旧（无 `ChatRoomMapViewTeleport` 接收 case）：任何方式都无效，发送端 2.5s 校验会提示

## 6. 测试

`tests/map-minimap.test.js`（简化地图与传送，39 例中的 14 例）：

- 网格分类（墙/半墙/水/室外）、障碍物与方向门判定、缓存复用
- 玩家列表过滤与去重
- 传送：权限/边界/目标校验、原生优先、fallback 消息格式、自传本地生效
- 迷雾翻转同步：两次 Update 顺序、Fog 翻转与恢复、两种初始状态
- 坐标换算：事件比例换算、视口往返（防错位回归）
- 接收端增强判定、传送校验文案

`tests/map-saver.test.js`（第一阶段存档，16 例）、`tests/loader.test.js`（加载器，3 例）

测试基建：`createRuntime()` 用 node:vm 沙箱拼接源码运行，`__BMS_TEST_MODE__` + `__BMS_TEST_API__` 暴露内部函数；断言跨 realm 对象需 `plain()` JSON 往返。

## 7. 接手建议

1. 先跑 `npm test` 确认 39 例全绿，再跑 `powershell -File build.ps1`
2. UI 改动集中在 `src/05-minimap.js`；布局/样式改动后需真机验证（缩放、拖拽、列表滚动、面板拖动）
3. 传送链路改动在 `src/04-map-bridge.js`，纯逻辑有测试保护；改动后同步更新 `tests/map-minimap.test.js`
4. 版本号：`src/00-userscript-header.js`、`src/01-runtime.js`、`package.json` 三处同步
5. 提交说明用简体中文；push 后向凡尘明确告知远程分支、提交哈希与结果
