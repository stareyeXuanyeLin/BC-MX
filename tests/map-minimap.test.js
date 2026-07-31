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
      { MemberNumber: 111, Name: "Alice", MapData: { Pos: { X: 5, Y: 5 } } },
      { MemberNumber: 222, Name: "Bob", MapData: { Pos: { X: 10, Y: 10 } } },
      { MemberNumber: 333, Name: "NoMap", MapData: null },
    ],
    ChatRoomPlayerIsAdmin: () => true,
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
  assert.equal(api.playerPositionSignature(), "111:5,5|12345:20,20|222:10,10");
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

test("teleport verification reports position unchanged and missing targets", () => {
  const { api } = createRuntime();
  assert.equal(api.teleportVerificationMessage(null, 3, 4), "目标已不在房间，传送可能未生效");
  assert.equal(
    api.teleportVerificationMessage({ MemberNumber: 222, MapData: { Pos: { X: 1, Y: 1 } } }, 3, 4),
    "传送未生效：目标未在地图视图或客户端版本过旧（位置未变化）",
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
