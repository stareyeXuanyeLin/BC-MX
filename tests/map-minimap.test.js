const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { TextEncoder } = require("node:util");

const root = path.resolve(__dirname, "..");
const parts = [
  "00-userscript-header.js",
  "01-runtime.js",
  "02-storage.js",
  "03-exchange.js",
  "04-map-bridge.js",
  "05-minimap.js",
  "05-ui.js",
  "06-bootstrap.js",
];
const source = parts.map(name => fs.readFileSync(path.join(root, "src", name), "utf8")).join("\n");

function createLocalStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values,
  };
}

const TILE_LOOKUP = {
  100: { ID: 100, Type: "Floor", Style: "Stone" },
  199: { ID: 199, Type: "Floor", Style: "HalfWall", CanEnter: () => false },
  200: { ID: 200, Type: "FloorExterior", Style: "Dirt" },
  300: { ID: 300, Type: "Water", Style: "Pool" },
  1000: { ID: 1000, Type: "Wall", Style: "Brick", CanEnter: () => false },
};
const OBJECT_LOOKUP = {
  2000: { ID: 2000, Type: "FloorObstacle", Style: "Blank", CanEnter: () => false },
  2030: { ID: 2030, Type: "FloorObstacle", Style: "IronBars", CanEnter: () => false },
  2100: { ID: 2100, Type: "Door", Style: "Wood", CanEnter: dir => dir === "R" },
  3000: { ID: 3000, Type: "FloorDecoration", Style: "Carpet" },
};

function createRuntime(overrides = {}) {
  const context = {
    console,
    TextEncoder,
    Date,
    Math,
    JSON,
    Blob,
    URL,
    setTimeout,
    clearTimeout,
    __BMS_TEST_MODE__: true,
    localStorage: createLocalStorage(),
    Player: {
      MemberNumber: 12345,
      MapData: { Pos: { X: 20, Y: 20 } },
      get Position() { return this.MapData?.Pos ?? null; },
      set Position(pos) { this.MapData = { ...this.MapData, Pos: pos }; },
    },
    CurrentScreen: "ChatRoom",
    ChatRoomData: {
      Name: "测试地图房",
      MapData: { Type: "Always", Tiles: String.fromCharCode(100).repeat(1600), Objects: String.fromCharCode(0).repeat(1600) },
    },
    ChatRoomCharacter: [
      { MemberNumber: 111, Name: "Alice", MapData: { Pos: { X: 5, Y: 5 } }, BMSMapViewActive: true },
      { MemberNumber: 222, Name: "Bob", MapData: { Pos: { X: 10, Y: 10 } }, BMSMapViewActive: true },
      { MemberNumber: 333, Name: "NoMap", MapData: null },
    ],
    ChatRoomPlayerIsAdmin: () => true,
    ChatRoomMapViewIsActive: () => true,
    ChatRoomMapManager: { Map: { exportString: () => "native-map-payload", importString: () => true } },
    ChatRoomMapViewUpdateFlag: () => {},
    ChatRoomMapViewCalculatePerceptionMasks: () => {},
    ChatRoomSendLocal: () => {},
    ChatRoomMapViewTileLookup: TILE_LOOKUP,
    ChatRoomMapViewObjectLookup: OBJECT_LOOKUP,
    ...overrides,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "BCMapSaver.user.js" });
  return { api: context.__BMS_TEST_API__, context };
}

function setCell(data, x, y, code) {
  const index = y * 40 + x;
  data = data.split("");
  data[index] = String.fromCharCode(code);
  return data.join("");
}

const plain = value => JSON.parse(JSON.stringify(value));

test("grid snapshot classifies floors, walls, half-walls and water", () => {
  let tiles = String.fromCharCode(100).repeat(1600);
  tiles = setCell(tiles, 0, 0, 1000); // 墙
  tiles = setCell(tiles, 1, 0, 199);  // 半墙
  tiles = setCell(tiles, 2, 0, 300);  // 水
  tiles = setCell(tiles, 3, 0, 200);  // 室外
  const objects = String.fromCharCode(0).repeat(1600);

  const { api } = createRuntime({ ChatRoomData: { Name: "房", MapData: { Type: "Always", Tiles: tiles, Objects: objects } } });
  const grid = api.buildMapGridSnapshot();
  assert.ok(grid);
  assert.equal(grid.width, 40);
  assert.equal(grid.height, 40);

  const at = (x, y) => ({ walkable: grid.walkable[y * 40 + x], kind: grid.tileKind[y * 40 + x] });
  assert.deepEqual(at(0, 0), { walkable: 0, kind: api.tileKindOf({ Type: "Wall" }) });
  assert.deepEqual(at(1, 0), { walkable: 0, kind: api.tileKindOf({ Type: "Floor", Style: "HalfWall" }) });
  assert.deepEqual(at(2, 0), { walkable: 1, kind: api.tileKindOf({ Type: "Water" }) });
  assert.deepEqual(at(3, 0), { walkable: 1, kind: api.tileKindOf({ Type: "FloorExterior" }) });
  assert.deepEqual(at(10, 10), { walkable: 1, kind: api.tileKindOf({ Type: "Floor" }) });
});

test("grid snapshot accounts for blocking and directional objects", () => {
  const tiles = String.fromCharCode(100).repeat(1600);
  let objects = String.fromCharCode(0).repeat(1600);
  objects = setCell(objects, 0, 0, 2030);  // 铁栏：恒阻挡
  objects = setCell(objects, 1, 0, 2100);  // 门：可从 R 方向进入 → 可站人
  objects = setCell(objects, 2, 0, 3000);  // 地毯：无 CanEnter → 不阻挡
  objects = setCell(objects, 3, 0, 2000);  // Blank 障碍：恒阻挡

  const { api } = createRuntime({ ChatRoomData: { Name: "房", MapData: { Type: "Always", Tiles: tiles, Objects: objects } } });
  const grid = api.buildMapGridSnapshot();
  const at = (x, y) => grid.walkable[y * 40 + x];
  assert.equal(at(0, 0), 0);
  assert.equal(at(1, 0), 1);
  assert.equal(at(2, 0), 1);
  assert.equal(at(3, 0), 0);
});

test("grid snapshot is cached until the encoded strings change", () => {
  const { api } = createRuntime();
  const first = api.buildMapGridSnapshot();
  const second = api.buildMapGridSnapshot();
  assert.equal(first, second);
});

test("tileKindOf falls back to EMPTY for unknown tiles", () => {
  const { api } = createRuntime();
  assert.equal(api.tileKindOf(undefined), 0);
  assert.equal(api.tileKindOf({ Type: "SomethingNew" }), 6);
});

test("room character list filters out characters without map data", () => {
  const { api } = createRuntime();
  const list = api.getRoomCharacterList();
  assert.equal(list.length, 3);
  assert.deepEqual([...list.map(c => c.MemberNumber)].sort((a, b) => a - b), [111, 222, 12345]);
  assert.equal(api.playerPositionSignature(), "111:5,5:1|12345:20,20:1|222:10,10:1");
});

test("room character list deduplicates the player when included in the room list", () => {
  const { api } = createRuntime({
    ChatRoomCharacter: [
      { MemberNumber: 111, Name: "Alice", MapData: { Pos: { X: 5, Y: 5 } } },
      { MemberNumber: 12345, Name: "Myself", MapData: { Pos: { X: 20, Y: 20 } } }, // 重复的自己
      { MemberNumber: 222, Name: "Bob", MapData: { Pos: { X: 10, Y: 10 } } },
    ],
  });
  const list = api.getRoomCharacterList();
  assert.equal(list.length, 3);
  assert.deepEqual([...list.map(c => c.MemberNumber)].sort((a, b) => a - b), [111, 222, 12345]);
});

test("teleport rejects non-admin, out-of-range and unknown targets", () => {
  const { api, context } = createRuntime({ ChatRoomPlayerIsAdmin: () => false });
  assert.throws(() => api.teleportCharacter(222, 0, 0), /管理员/);
  context.ChatRoomPlayerIsAdmin = () => true;
  assert.throws(() => api.teleportCharacter(222, -1, 0), /超出地图范围/);
  assert.throws(() => api.teleportCharacter(222, 40, 0), /超出地图范围/);
  assert.throws(() => api.teleportCharacter(999, 0, 0), /找不到目标玩家/);
});

test("teleport prefers the native ChatRoomMapViewTeleport when available", () => {
  const nativeCalls = [];
  const { api, context } = createRuntime({
    ChatRoomMapViewTeleport: (target, position) => nativeCalls.push({ target, position }),
  });
  const mode = api.teleportCharacter(222, 7, 9);
  assert.equal(mode, "native");
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0].target.MemberNumber, 222);
  assert.deepEqual(plain(nativeCalls[0].position), { X: 7, Y: 9 });
});

test("teleport falls back to a hand-built hidden message identical to the native one", () => {
  const sent = [];
  const { api, context } = createRuntime({ ServerSend: (type, data) => sent.push({ type, data }) });
  const mode = api.teleportCharacter(222, 3, 4);
  assert.equal(mode, "fallback");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "ChatRoomChat");
  assert.equal(sent[0].data.Content, "ChatRoomMapViewTeleport");
  assert.equal(sent[0].data.Type, "Hidden");
  assert.equal(sent[0].data.Target, 222);
  assert.deepEqual(plain(sent[0].data.Dictionary), [{ Tag: "MapViewTeleport", Position: { X: 3, Y: 4 } }]);
});

test("teleport triggers a fog-flip room sync so the server broadcasts twice", () => {
  const sent = [];
  const { api, context } = createRuntime({
    ServerSend: (type, data) => sent.push({ type, data }),
    ChatRoomGetSettings: room => ({ Name: room.Name, MapData: { ...room.MapData } }),
  });
  api.teleportCharacter(222, 3, 4);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].type, "ChatRoomChat"); // 传送消息先发
  assert.equal(sent[1].type, "ChatRoomAdmin"); // 第一次：迷雾翻转（真实变化）
  assert.equal(sent[2].type, "ChatRoomAdmin"); // 第二次：迷雾恢复
  assert.equal(sent[1].data.Action, "Update");
  assert.equal(sent[1].data.MemberNumber, 12345);
  // 第一次提交关闭迷雾，第二次恢复启用
  assert.equal(sent[1].data.Room.MapData.Fog, false);
  assert.equal(sent[2].data.Room.MapData.Fog, undefined);
  // 本地房间数据最终恢复原状（Fog 未显式设置）
  assert.equal(Object.prototype.hasOwnProperty.call(context.ChatRoomData.MapData, "Fog"), false);
});

test("fog flip restores an explicitly disabled fog to disabled", () => {
  const sent = [];
  const { api, context } = createRuntime({
    ServerSend: (type, data) => sent.push({ type, data }),
    ChatRoomGetSettings: room => ({ Name: room.Name, MapData: { ...room.MapData } }),
    ChatRoomData: { Name: "房", MapData: { Type: "Always", Fog: false, Tiles: "t", Objects: "o" } },
  });
  api.teleportCharacter(222, 3, 4);
  assert.equal(sent[1].data.Room.MapData.Fog, undefined); // 第一次翻转为启用
  assert.equal(sent[2].data.Room.MapData.Fog, false); // 恢复为关闭
  assert.equal(context.ChatRoomData.MapData.Fog, false);
});

test("native teleport path also triggers the fog-flip room sync", () => {
  const sent = [];
  const nativeCalls = [];
  const { api } = createRuntime({
    ServerSend: (type, data) => sent.push({ type, data }),
    ChatRoomGetSettings: room => ({ Name: room.Name, MapData: room.MapData }),
    ChatRoomMapViewTeleport: (target, position) => nativeCalls.push({ target, position }),
  });
  api.teleportCharacter(222, 7, 9);
  assert.equal(nativeCalls.length, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "ChatRoomAdmin");
  assert.equal(sent[1].type, "ChatRoomAdmin");
});

test("fallback teleport of self applies the position locally and sends the message", () => {
  const sent = [];
  const { api, context } = createRuntime({
    ServerSend: (type, data) => sent.push({ type, data }),
    ChatRoomCharacter: [],
  });
  const mode = api.teleportCharacter(12345, 11, 12);
  assert.equal(mode, "fallback");
  assert.equal(context.Player.MapData.Pos.X, 11);
  assert.equal(context.Player.MapData.Pos.Y, 12);
  assert.equal(sent[0].data.Target, 12345);
});

test("createTeleportMessage produces the native wire format", () => {
  const { api } = createRuntime();
  assert.deepEqual(plain(api.createTeleportMessage(777, 1, 2)), {
    Content: "ChatRoomMapViewTeleport",
    Type: "Hidden",
    Dictionary: [{ Tag: "MapViewTeleport", Position: { X: 1, Y: 2 } }],
    Target: 777,
  });
});

test("native teleport lookup resolves top-level lexical bindings", () => {
  const { api, context } = createRuntime();
  assert.equal(api.getChatRoomMapViewTeleport(), null);
  // 新版 BC 用顶层 let 声明：标识符可见但不在 globalThis
  vm.runInContext("let ChatRoomMapViewTeleport = function (t, p) { return 'lexical-called'; };", context);
  assert.equal(api.getChatRoomMapViewTeleport()(), "lexical-called");
  assert.equal(Object.prototype.hasOwnProperty.call(context, "ChatRoomMapViewTeleport"), false);
});

test("native server send lookup resolves lexical ServerSend when present", () => {
  const { api, context } = createRuntime();
  assert.equal(api.getServerSend(), null);
  vm.runInContext("let ServerSend = function () { return 'send-called'; };", context);
  assert.equal(api.getServerSend()(), "send-called");
  assert.equal(Object.prototype.hasOwnProperty.call(context, "ServerSend"), false);
});

test("minimap entry button uses canvas coordinates directly below the archive button", () => {
  const { api, context } = createRuntime({
    ChatRoomMapViewIsActive: () => true,
    ChatRoomMapViewEditMode: "",
  });
  assert.equal(api.shouldDrawMinimapEntryButton(), true);
  assert.equal(api.constants.MINIMAP_ENTRY_BUTTON.x, api.constants.ENTRY_BUTTON.x);
  assert.equal(
    api.constants.MINIMAP_ENTRY_BUTTON.y,
    api.constants.ENTRY_BUTTON.y + api.constants.ENTRY_BUTTON.height + 10,
  );

  context.ChatRoomMapViewEditMode = "Tile";
  assert.equal(api.shouldDrawMinimapEntryButton(), false);
});

test("minimap layout isolates the roster and canvas into explicit side-by-side grid columns", () => {
  const minimapSource = fs.readFileSync(path.join(root, "src", "05-minimap.js"), "utf8");
  assert.match(minimapSource, /display:grid!important;grid-template-columns:\$\{MINIMAP_SIDE_WIDTH\}px \$\{MINIMAP_CANVAS_SIZE\}px/);
  assert.match(minimapSource, /canvas\{position:relative!important;inset:auto!important;/);
  assert.match(minimapSource, /grid-column:2;grid-row:1/);
  assert.match(minimapSource, /\.bms-mm-side\{position:relative!important;inset:auto!important;/);
  assert.match(minimapSource, /grid-column:1;grid-row:1/);
});

test("event coordinates are scaled from CSS pixels to internal canvas pixels", () => {
  const { api } = createRuntime();
  const canvas = { width: 520, height: 520 };
  // CSS 尺寸被全局样式放大到 650（与内部 520 不一致）时，换算仍应落到正确内部坐标
  const rect = { left: 100, top: 50, width: 650, height: 650 };
  const pos = api.minimapEventToCanvasXY(canvas, rect, 100 + 650 / 2, 50 + 650 / 2);
  assert.ok(Math.abs(pos.x - 260) < 0.001);
  assert.ok(Math.abs(pos.y - 260) < 0.001);
  // 比例一致时退化为直接相减
  const rect2 = { left: 0, top: 0, width: 520, height: 520 };
  assert.deepEqual(plain(api.minimapEventToCanvasXY(canvas, rect2, 130, 70)), { x: 130, y: 70 });
});

test("grid coordinates round-trip through the viewport transform", () => {
  const { api } = createRuntime();
  const grid = { width: 40, height: 40 };
  const step = 13; // MINIMAP_TILE 12 + MINIMAP_GAP 1
  // 拖拽 + 缩放后的视口：grid(3,4) → canvas 中心 (108, 124)
  const view = { zoom: 2, panX: 30, panY: 20 };
  const point = api.minimapCanvasToGridXY(3 * step * view.zoom + view.panX, 4 * step * view.zoom + view.panY, view, grid);
  assert.deepEqual(plain(point), { x: 3, y: 4 });
  // 命中格子内部任意一点仍应回落到同一格子
  const inside = api.minimapCanvasToGridXY(3 * step * view.zoom + view.panX + 5, 4 * step * view.zoom + view.panY + 9, view, grid);
  assert.deepEqual(plain(inside), { x: 3, y: 4 });
  // 越界返回 null
  assert.equal(api.minimapCanvasToGridXY(-100, 0, view, grid), null);
  assert.equal(api.minimapCanvasToGridXY(0, 99999, view, grid), null);
});

test("teleport verification reports position unchanged and missing targets", () => {
  const { api } = createRuntime();
  assert.equal(api.teleportVerificationMessage(null, 3, 4), "目标已不在房间，传送可能未生效");
  assert.equal(
    api.teleportVerificationMessage({ MemberNumber: 222, MapData: { Pos: { X: 1, Y: 1 } } }, 3, 4),
    "目标尚未同步新位置：若目标处于聊天视图，切回地图视图后将自动生效；否则可能客户端版本过旧",
  );
  assert.equal(
    api.teleportVerificationMessage({ MemberNumber: 222, MapData: { Pos: { X: 3, Y: 4 } } }, 3, 4),
    "传送成功：目标位置已更新",
  );
});

test("receive boost only targets the exact hidden teleport message for the current player", () => {
  const { api } = createRuntime();
  const base = { Type: "Hidden", Content: "ChatRoomMapViewTeleport", Target: 222, Dictionary: [] };
  assert.equal(api.isTeleportMessageFor(base, 222), true);
  assert.equal(api.isTeleportMessageFor(base, 12345), false);
  assert.equal(api.isTeleportMessageFor({ ...base, Type: "Action" }, 222), false);
  assert.equal(api.isTeleportMessageFor({ ...base, Content: "Other" }, 222), false);
  assert.equal(api.isTeleportMessageFor(null, 222), false);
});

test("swap plan uses a temporary adjacent empty tile before filling both original positions", () => {
  const { api } = createRuntime();
  const a = { MemberNumber: 111, MapData: { Pos: { X: 5, Y: 5 } } };
  const b = { MemberNumber: 222, MapData: { Pos: { X: 10, Y: 10 } } };
  const grid = { width: 40, height: 40, walkable: new Uint8Array(1600).fill(1) };
  assert.deepEqual(plain(api.buildSwapTeleportPlan(a, b, grid, [a, b])), [
    { member: 222, x: 11, y: 10, phase: "vacate" },
    { member: 111, x: 10, y: 10, phase: "fill" },
    { member: 222, x: 5, y: 5, phase: "complete" },
  ]);
});

test("swap plan rejects missing positions and targets without an adjacent empty tile", () => {
  const { api } = createRuntime();
  const a = { MemberNumber: 111, MapData: { Pos: { X: 5, Y: 5 } } };
  const b = { MemberNumber: 222, MapData: { Pos: { X: 10, Y: 10 } } };
  const grid = { width: 40, height: 40, walkable: new Uint8Array(1600).fill(1) };
  assert.equal(api.buildSwapTeleportPlan({ MemberNumber: 111, MapData: null }, b, grid, [b]), null);
  assert.equal(api.buildSwapTeleportPlan(null, b, grid, [b]), null);
  for (const [x, y] of [[11, 10], [9, 10], [10, 11], [10, 9]]) grid.walkable[y * 40 + x] = 0;
  assert.equal(api.buildSwapTeleportPlan(a, b, grid, [a, b]), null);
});

test("reopening the minimap redraws the roster and member clicks switch the unique selection", () => {
  const minimapSource = fs.readFileSync(path.join(root, "src", "05-minimap.js"), "utf8");
  // 重开后必须重置玩家签名，否则 tick 因签名未变而跳过列表渲染（空列表 bug）
  assert.match(minimapSource, /minimapPlayerSig = ""; \/\/ 重置签名/);
  // 打开时默认选中自己，成员列表恒有选中项
  assert.match(minimapSource, /minimapSelected = currentMemberNumber\(\); \/\/ 默认选中自己/);
  // 点击任意可选成员必须直接切换唯一选中项，并清除上一成员的待确认落点
  assert.match(minimapSource, /minimapSelected = memberNumber;\s*minimapPending = null;/);
  assert.doesNotMatch(minimapSource, /swapWith: memberNumber/);
  // 再次点击同一目标格子确认传送
  assert.match(minimapSource, /再次点击同一目标格子 = 确认/);
  // 右键仅取消落点，不能把选中的其他成员强制切回自己
  assert.match(minimapSource, /\/\/ 右键只取消尚未确认的落点，当前选中成员保持不变。/);
  // 离开地图视角的成员在列表中明确标记为不可操作
  assert.match(minimapSource, /bms-mm-unavailable/);
  assert.match(minimapSource, /该玩家当前不在地图视角，不能选中、传送或交换位置/);
});

test("three-step swap executes serially and locks roster interactions until completion", () => {
  const minimapSource = fs.readFileSync(path.join(root, "src", "05-minimap.js"), "utf8");
  assert.match(minimapSource, /MINIMAP_SWAP_STEP_DELAY_MS = 1200/);
  assert.match(minimapSource, /const runNextStep = \(\) =>/);
  assert.match(minimapSource, /if \(index < plan\.length\)/);
  assert.match(minimapSource, /minimapSwapInProgress = true/);
  assert.match(minimapSource, /minimapSwapInProgress = false/);
  assert.match(minimapSource, /minimapPlayerSig = "";\s*\/\/ 同步可能替换角色数据对象/);
  assert.match(minimapSource, /bms-mm-roster\.bms-mm-locked/);
});

test("minimap stays closed by default and only opens on demand", () => {
  const minimapSource = fs.readFileSync(path.join(root, "src", "05-minimap.js"), "utf8");
  // 不再自动打开：无 autoOpen 状态、无进房自动 openMinimap 调用
  assert.doesNotMatch(minimapSource, /minimapAutoOpen/);
  assert.doesNotMatch(minimapSource, /closeMinimap\(true\)/);
  assert.doesNotMatch(minimapSource, /minimapAutoOpen && !minimapOpen\) openMinimap/);
  // 仍保留手动开关
  assert.match(minimapSource, /function toggleMinimap\(\)/);
});

test("reachability detects enclosed areas for non-admin teleport", () => {
  const tiles = String.fromCharCode(100).repeat(1600);
  const objects = String.fromCharCode(0).repeat(1600);
  const { api } = createRuntime({ ChatRoomData: { Name: "房", MapData: { Type: "Always", Tiles: tiles, Objects: objects } } });
  const grid = api.buildMapGridSnapshot();
  // 全地板时处处可达
  assert.equal(api.isPositionReachable(grid, 1, 1, 30, 30), true);
  assert.equal(api.isPositionReachable(grid, 4, 4, 4, 4), true);
  // 手动围出封闭房间：房间 [2,2]~[6,6]，外圈 [1,7] 全不可走
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const inside = x >= 2 && x <= 6 && y >= 2 && y <= 6;
      const ring = ((x === 1 || x === 7) && y >= 1 && y <= 7) || ((y === 1 || y === 7) && x >= 1 && x <= 7);
      if (!inside && ring) grid.walkable[y * 40 + x] = 0;
    }
  }
  // 房间内相互可达
  assert.equal(api.isPositionReachable(grid, 4, 4, 3, 3), true);
  // 外部无法进入封闭房间，房间内无法出去
  assert.equal(api.isPositionReachable(grid, 20, 20, 4, 4), false);
  assert.equal(api.isPositionReachable(grid, 4, 4, 20, 20), false);
  // 墙本身不可达
  assert.equal(api.isPositionReachable(grid, 20, 20, 1, 1), false);
  // 越界
  assert.equal(api.isPositionReachable(grid, 4, 4, 40, 4), false);
});

test("remote players outside the map view cannot be teleported", () => {
  const { api, context } = createRuntime({ ChatRoomMapViewTeleport: () => {} });
  const bob = context.ChatRoomCharacter.find(character => character.MemberNumber === 222);
  delete bob.BMSMapViewActive;
  assert.equal(api.isCharacterMapViewActive(bob), false);
  assert.throws(() => api.teleportCharacter(222, 3, 4), /当前不在地图视角/);

  api.applyMapViewPresenceMarker(bob, { PrivateState: { BMSMapViewActive: true } });
  assert.equal(api.isCharacterMapViewActive(bob), true);
  assert.equal(api.teleportCharacter(222, 3, 4), "native");
});

test("local map view presence is broadcast only when it changes or is forced", () => {
  const sent = [];
  const { api, context } = createRuntime({ ServerSend: (type, data) => sent.push({ type, data: plain(data) }) });
  assert.equal(api.syncLocalMapViewPresence(), true);
  assert.equal(context.Player.MapData.PrivateState.BMSMapViewActive, true);
  assert.equal(sent.length, 1);
  api.syncLocalMapViewPresence();
  assert.equal(sent.length, 1);

  context.ChatRoomMapViewIsActive = () => false;
  api.syncLocalMapViewPresence();
  assert.equal(context.Player.MapData.PrivateState.BMSMapViewActive, undefined);
  assert.equal(sent.length, 2);
  api.syncLocalMapViewPresence(true);
  assert.equal(sent.length, 3);
});

test("non-admin teleport is restricted to self and reachable tiles", () => {
  const tiles = String.fromCharCode(100).repeat(1600);
  const objects = String.fromCharCode(0).repeat(1600);
  const sent = [];
  const { api, context } = createRuntime({
    ChatRoomPlayerIsAdmin: () => false,
    ChatRoomData: { Name: "房", MapData: { Type: "Always", Tiles: tiles, Objects: objects } },
    ServerSend: (type, data) => sent.push({ type, data }),
  });
  // 传别人 → 拒绝
  assert.throws(() => api.teleportCharacter(222, 0, 0), /只有管理员才能传送其他玩家/);
  // 传自己到可达位置 → 本地生效，不发消息不触发同步
  const mode = api.teleportCharacter(12345, 5, 5);
  assert.equal(mode, "local");
  assert.equal(context.Player.MapData.Pos.X, 5);
  assert.equal(context.Player.MapData.Pos.Y, 5);
  assert.equal(sent.length, 0);
  // 把自己放进封闭房间后，传不出去
  const grid = api.buildMapGridSnapshot();
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const inside = x >= 2 && x <= 6 && y >= 2 && y <= 6;
      const ring = ((x === 1 || x === 7) && y >= 1 && y <= 7) || ((y === 1 || y === 7) && x >= 1 && x <= 7);
      if (!inside && ring) grid.walkable[y * 40 + x] = 0;
    }
  }
  context.Player.MapData.Pos = { X: 4, Y: 4 };
  assert.throws(() => api.teleportCharacter(12345, 20, 20), /无法通过正常行走抵达/);
  // 房间内可达
  assert.equal(api.teleportCharacter(12345, 3, 3), "local");
  assert.equal(context.Player.MapData.Pos.X, 3);
  assert.equal(context.Player.MapData.Pos.Y, 3);
  assert.equal(sent.length, 0);
});

function createModApi(context) {
  const hooks = [];
  const modApi = {
    hookFunction(name, priority, fn) {
      hooks.push({ name, priority, fn });
      const original = context[name];
      // 模拟 bcModSDK 的 hook 链：fn(argsArray, next)，next(argsArray) 展开后调用原函数
      context[name] = function (...callArgs) {
        return fn(callArgs, nextArgs => {
          if (typeof original !== "function") return undefined;
          return original.apply(this, nextArgs);
        });
      };
    },
    unload() {},
    hooks,
  };
  return modApi;
}

test("stealth toggle persists and broadcasts marker", () => {
  const sent = [];
  const { api, context } = createRuntime({ ServerSend: (msg, data) => sent.push({ msg, data }) });
  assert.equal(api.isStealthEnabled(), false);
  assert.equal(context.Player.MapData.BMSHidden, undefined);

  assert.equal(api.setStealthEnabled(true), true);
  assert.equal(context.Player.MapData.BMSHidden, true);
  assert.equal(api.isStealthEnabled(), true);
  assert.equal(context.localStorage.getItem("BC.MapSaver.stealth:12345"), "1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg, "ChatRoomCharacterMapDataUpdate");
  assert.equal(sent[0].data.BMSHidden, true);

  api.setStealthEnabled(false);
  assert.equal(context.Player.MapData.BMSHidden, undefined);
  assert.equal(context.localStorage.getItem("BC.MapSaver.stealth:12345"), "0");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].data.BMSHidden, undefined);
});

test("receive hooks mark hidden characters without touching game MapData", () => {
  const { api, context } = createRuntime();
  // 模拟原版接收处理：须在沙箱创建后再注入，避免预置函数被 contextify 包装
  context.ChatRoomMapViewSyncMapData = data => {
    const char = context.ChatRoomCharacter.find(c => c.MemberNumber === data.MemberNumber);
    if (char) char.MapData = data.MapData;
  };
  // 模拟原版嵌套结构：角色数据在 Character 字段里，且同步后角色对象被重建
  const syncCharacterData = data => {
    const index = context.ChatRoomCharacter.findIndex(c => c.MemberNumber === data.Character.MemberNumber);
    if (index >= 0) context.ChatRoomCharacter[index] = { ...context.ChatRoomCharacter[index], ...data.Character };
  };
  context.ChatRoomSyncCharacter = syncCharacterData;
  context.ChatRoomSyncSingle = syncCharacterData;
  context.ChatRoomSyncMemberJoin = syncCharacterData;
  api.installHooksForTest(createModApi(context));

  const alice = context.ChatRoomCharacter[0];
  assert.equal(alice.BMSHidden, undefined);

  // 实时位置更新（平铺结构 {MemberNumber, MapData}）
  context.ChatRoomMapViewSyncMapData({ MemberNumber: 111, MapData: { Pos: { X: 6, Y: 6 }, PrivateState: { BMSMapViewActive: true }, BMSHidden: true } });
  assert.equal(alice.BMSHidden, true);
  assert.equal(alice.BMSMapViewActive, true);
  assert.deepEqual(plain(alice.MapData), { Pos: { X: 6, Y: 6 }, PrivateState: { BMSMapViewActive: true }, BMSHidden: true }); // 游戏数据保持原样，仅插件侧标记

  context.ChatRoomMapViewSyncMapData({ MemberNumber: 111, MapData: { Pos: { X: 7, Y: 7 } } });
  assert.equal(alice.BMSHidden, undefined);
  assert.equal(alice.BMSMapViewActive, undefined);
  assert.deepEqual(plain(alice.MapData), { Pos: { X: 7, Y: 7 } });

  // 进房同步（嵌套结构 {Character: {...}}，对象被重建后标记重新评估）
  context.ChatRoomSyncCharacter({ Character: { MemberNumber: 111, MapData: { Pos: { X: 8, Y: 8 }, BMSHidden: true } } });
  assert.equal(context.ChatRoomCharacter[0].BMSHidden, true);
  assert.deepEqual(plain(context.ChatRoomCharacter[0].MapData), { Pos: { X: 8, Y: 8 }, BMSHidden: true });

  // 单角色更新（嵌套结构）
  context.ChatRoomSyncSingle({ Character: { MemberNumber: 222, MapData: { Pos: { X: 3, Y: 3 }, BMSHidden: true } } });
  assert.equal(context.ChatRoomCharacter[1].BMSHidden, true);
  assert.deepEqual(plain(context.ChatRoomCharacter[1].MapData), { Pos: { X: 3, Y: 3 }, BMSHidden: true });

  // 成员加入（嵌套结构，无 MapData 的角色对象重建后不误标）
  context.ChatRoomSyncMemberJoin({ Character: { MemberNumber: 333, MapData: { Pos: { X: 9, Y: 9 }, BMSHidden: true } } });
  assert.equal(context.ChatRoomCharacter[2].BMSHidden, true);

  // 重建后无标记 → 标记清除
  context.ChatRoomSyncSingle({ Character: { MemberNumber: 222, MapData: { Pos: { X: 4, Y: 4 } } } });
  assert.equal(context.ChatRoomCharacter[1].BMSHidden, undefined);
});

test("active map player rebroadcasts plugin markers after a member joins", async () => {
  const sent = [];
  const { api, context } = createRuntime({ ServerSend: (msg, data) => sent.push({ msg, data }) });
  context.ChatRoomSyncMemberJoin = () => {};
  api.installHooksForTest(createModApi(context));

  api.setStealthEnabled(true);
  sent.length = 0;
  context.ChatRoomSyncMemberJoin({ Character: { MemberNumber: 444, MapData: null } });
  assert.equal(sent.length, 0); // 延迟广播尚未触发
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg, "ChatRoomCharacterMapDataUpdate");
  assert.equal(sent[0].data.BMSHidden, true);

  // 即使未隐藏，处于地图视角时仍补发视角在线标记
  api.setStealthEnabled(false);
  sent.length = 0;
  context.ChatRoomSyncMemberJoin({ Character: { MemberNumber: 555, MapData: null } });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.BMSHidden, undefined);
  assert.equal(sent[0].data.PrivateState.BMSMapViewActive, true);
});

test("isCharacterHidden: self never hidden, others follow marker", () => {
  const { api, context } = createRuntime();
  assert.equal(api.isCharacterHidden(context.Player), false); // 自己永远可见
  const alice = context.ChatRoomCharacter[0];
  assert.equal(api.isCharacterHidden(alice), false);
  alice.BMSHidden = true;
  assert.equal(api.isCharacterHidden(alice), true);
  assert.equal(api.isCharacterHidden(null), false);
});

test("minimap player color prefers LabelColor with fallback", () => {
  const { api } = createRuntime();
  assert.equal(api.minimapPlayerColor({ MemberNumber: 111, LabelColor: "#ff66aa" }), "#ff66aa");
  assert.equal(api.minimapPlayerColor({ MemberNumber: 111, LabelColor: "#f6a" }), "#f6a");
  const fallback = api.minimapPlayerColor({ MemberNumber: 111 });
  assert.equal(api.minimapPlayerColor({ MemberNumber: 111, LabelColor: "not-a-color" }), fallback);
  assert.equal(api.minimapPlayerColor({ MemberNumber: 111, LabelColor: "" }), fallback);
  assert.match(fallback, /^#[0-9a-f]{6}$/);
});
