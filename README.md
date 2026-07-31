# BC Map Saver

Bondage Club 聊天室地图本地保存、导入导出与房间重建插件。

## 当前版本

```text
0.2.0 dev
```

第二阶段功能（小地图与管理员传送）开发中，正式仓库使用 `main` 分支：

```text
https://github.com/stareyeXuanyeLin/BC-Map-Saver
```

## 安装

### 便携远程加载器（推荐）

[![Install Loader](https://img.shields.io/badge/Tampermonkey-%E5%AE%89%E8%A3%85%E5%9C%B0%E5%9B%BE%E5%AD%98%E6%A1%A3-245a91?labelColor=1c1c1c&logo=tampermonkey)](https://raw.githubusercontent.com/stareyeXuanyeLin/BC-Map-Saver/main/dist/BCMapSaver.loader.user.js)

加载器每次进入 BC 时使用 Tampermonkey 特权请求获取并执行 `main` 分支最新核心脚本。GitHub Raw 不可用时，会依次尝试 jsDelivr、Fastly 和 Gcore 备用源。首次安装时需要允许加载器访问元信息中列出的远程域名。

### 完整核心脚本

```text
https://raw.githubusercontent.com/stareyeXuanyeLin/BC-Map-Saver/main/dist/BCMapSaver.user.js
```

请只启用加载器或完整核心脚本中的一种，避免同名 Mod 重复注册。

本地构建产物：

```text
dist/BCMapSaver.loader.user.js
dist/BCMapSaver.user.js
```

## 功能

- 在地图模式左侧工具栏提供“档”按钮；
- 将当前聊天室地图保存到浏览器本地；
- 新建、覆盖、重命名、备注和删除地图存档；
- 导出单张地图文件；
- 导出整个本地地图库；
- 导入插件单张地图文件、整库文件或 BC 原生地图字符串文件；
- 导入时支持保留双方、按 ID 覆盖、按名称覆盖、跳过冲突和替换整个地图库；
- 将任意本地存档应用到当前地图房；
- 应用前自动备份当前房间地图，最多保留 10 份自动备份；
- 通过 BC 原生房间更新链路同步给当前房间所有玩家；
- 按玩家账号编号隔离本地地图库；
- 小地图浮窗：全图概览，实时显示可通行区域与所有玩家位置；
- 小地图支持滚轮缩放（鼠标锚点）与拖拽平移，可查看任意局部区域；
- 管理员可在小地图上选中任意玩家并传送到任意格子（穿墙语义）。

## 权限

插件入口只在以下条件同时满足时显示：

1. 当前处于聊天室；
2. 当前处于地图视图；
3. 当前房间启用了地图；
4. 当前玩家是房间管理员；
5. 地图编辑器当前没有进入地块、物件或效果编辑子模式。

保存当前地图、覆盖本地地图和应用到房间时，业务层会重新检查管理员权限，不能通过直接调用界面事件绕过。

小地图入口对所有玩家可见（地图房内），传送功能仅在房间管理员界面启用。

## 地图与玩家位置

地图存档只保存 BC 原生地图负载，不保存任何角色的 `MapData.Pos` 或个人地图状态。

### 小地图

小地图使用公开结构实时渲染：`ChatRoomData.MapData.Tiles/Objects` 编码 + `ChatRoomMapViewTileLookup/ObjectLookup` 定义表。静态网格通过模拟四方向进入调用原版 `CanEnter(dir)` 判定可通行性，墙、半墙、障碍物和方向门都能正确区分。玩家位置来自 `Player.MapData.Pos` 与 `ChatRoomCharacter[i].MapData.Pos`，节流扫描重绘。

### 管理员传送

管理员传送优先调用原版 `ChatRoomMapViewTeleport(target, position)`（R130+）。该函数发送 `Hidden` 定向聊天消息，目标玩家客户端由原版接收链路校验发送者管理员身份后设置自己的位置，再经正常同步链路广播给全房间，**目标玩家无需安装插件**。

旧版本 BC 缺少该函数时，插件降级为手发与原版同构的 `Hidden` 消息；接收端同样没有处理逻辑时功能不可用，界面会提示。

传送落点可为任意格子（穿墙语义）；落点在墙内时，BC 原版碰撞修正会把玩家推挤到邻近可站位置。

**已知原版限制**：位置广播由地图视图运行循环（`ChatRoomMapViewUpdatePlayerSync`）消费同步标志后发出。目标玩家停留在聊天视图时，本地坐标已立即更新，但广播标志挂起，需等目标切回地图视图才会自动发送。因此：

- 目标处于地图视图：约 0.5 秒内全房间可见；
- 目标处于聊天视图：本地立即生效，切回地图视图时画面直接显示在挪动后的位置，同时自动广播给全房间（无需对方安装插件）；
- 目标若在聊天视图期间直接离开房间重进，`LastMapData` 尚未更新，会回到旧位置；切回地图视图停留 10 秒以上则保持新位置。

**接收端增强**：当目标玩家同样安装本插件时，插件会在目标端 hook 原版消息处理流程，收到传送指令后强制广播一次位置，目标停留在聊天视图也能立即同步给全房间。未安装插件时按上述原版行为工作，发送端会在约 2.5 秒后提示目标尚未同步（区分离开房间与延迟生效）。

## 数据结构

本地记录以 BC 原生导出字符串作为唯一地图真值：

```ts
interface LocalMapRecord {
  id: string;
  name: string;
  note: string;
  createdAt: number;
  updatedAt: number;
  payload: string; // ChatRoomMapManager.Map.exportString()
  sourceRoomName: string;
  mapType?: "Always" | "Hybrid" | "Never";
  storageVersion: 1;
  autoBackup: boolean;
}
```

插件不自行解释、重写或二次编码 `payload`。地图格式升级与兼容迁移由 BC 原生 `ChatRoomMapManager` 负责。

本地存储键：

```text
BC.MapSaver.v1:<MemberNumber>
```

地图不写入 `Player`、`Player.LastChatRoom`、`Character.MapData` 或其他角色数据。

## 导入导出格式

### 单张地图

```text
*.bcmap.json
```

顶层标识：

```text
BC_MAP_SAVER_MAP
```

### 整个地图库

```text
*.bcmapset.json
```

顶层标识：

```text
BC_MAP_SAVER_LIBRARY
```

导入修改采用先完整解析和规范化、再一次性写入的事务式流程。解析、容量检查或本地存储写入失败时，运行中的地图库不会被部分替换。

如果插件读取到损坏的旧本地数据，会先把原始文本复制到带 `.corrupt.<时间戳>` 后缀的恢复键，再建立新的空地图库；恢复副本创建失败时会禁止后续写入。

## 地图应用链路

```text
检查地图房和管理员权限
    ↓
调用 BC exportString() 保存当前地图自动备份
    ↓
调用 BC importString() 导入目标负载
    ↓
导入失败：移除未使用的自动备份，当前地图保持不变
    ↓
导入成功：调用 ChatRoomMapViewUpdateFlag()
    ↓
重算感知遮罩
    ↓
BC 通过 ChatRoomAdmin / Update 同步房间地图
```

插件不自行构造地图网络消息，也不修改 `ChatRoomMapManager` 内部 Codec。

## 开发

```powershell
npm run build
npm run check
npm test
```

源码结构：

```text
src/
├─ 00-userscript-header.js  Userscript 元信息与 IIFE 入口
├─ 01-runtime.js            常量、运行时状态与通用函数
├─ 02-storage.js            数据规范化与本地持久化
├─ 03-exchange.js           单图、整库导入导出与冲突策略
├─ 04-map-bridge.js         BC 原生地图接口、静态网格与玩家传送
├─ 05-minimap.js            小地图浮窗渲染与交互
├─ 05-ui.js                 地图模式入口和存档管理面板
└─ 06-bootstrap.js          ModSDK 注册、公开 API 与测试入口
```

自动化测试位于：

```text
tests/map-saver.test.js
tests/map-minimap.test.js
tests/loader.test.js
```

## 调查基线

当前以 Bondage Club R130 为开发基线：

```text
GameVersion: R130
Commit: 4265e9786b7a0e71275fd1d45736b0709736fac0
```

原版地图模块调查见：

```text
docs/BC-R130-聊天室地图模块调查.md
```

第一阶段实现说明见：

```text
docs/第一阶段设计与实现.md
```

第二阶段设计（小地图与玩家传送）见：

```text
docs/第二阶段设计：小地图与玩家传送.md
```
