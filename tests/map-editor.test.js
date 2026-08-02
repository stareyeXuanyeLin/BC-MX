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
  "05-editor.js",
  "05-ui.js",
  "06-bootstrap.js",
];
const source = parts.map(name => fs.readFileSync(path.join(root, "src", name), "utf8")).join("\n");

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
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Player: { MemberNumber: 12345, Inventory: [], MapData: { Pos: { X: 20, Y: 20 } } },
    CurrentScreen: "ChatRoom",
    ChatRoomData: {
      Name: "编辑器测试房",
      MapData: {
        Type: "Always",
        Tiles: String.fromCharCode(100).repeat(1600),
        Objects: String.fromCharCode(100).repeat(1600),
      },
    },
    ChatRoomCharacter: [],
    ChatRoomPlayerIsAdmin: () => true,
    ChatRoomMapViewIsActive: () => true,
    ChatRoomMapViewEditMode: "",
    ChatRoomMapViewTileLookup: {},
    ChatRoomMapViewObjectLookup: {},
    ChatRoomMapManager: {
      Map: {
        exportString: () => "map",
        importString: () => true,
        _effects: Array.from({ length: 1600 }, () => []),
        getAllEffects() { return this._effects; },
        replaceAllEffects(list) { this._effects = list; },
        updateGlobalMapData() { return true; },
      },
    },
    ChatRoomMapViewUpdateFlag: () => {},
    ChatRoomMapViewCalculatePerceptionMasks: () => {},
    ...overrides,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "BCMX.user.js" });
  return { api: context.__BMS_TEST_API__, context };
}

const plain = value => JSON.parse(JSON.stringify(value));
const countCode = (text, code) => [...text].filter(char => char.charCodeAt(0) === code).length;

test("editor viewport coordinates round-trip with shared pan and zoom math", () => {
  const { api } = createRuntime();
  const view = { zoom: 1.75, panX: -246, panY: 83 };
  const size = { width: 40, height: 40 };
  for (const [x, y] of [[0, 0], [9, 17], [39, 39]]) {
    const point = api.editorGridToCanvasXY(x, y, view);
    const center = { x: point.x + 32 * view.zoom, y: point.y + 32 * view.zoom };
    assert.deepEqual(plain(api.editorCanvasToGridXY(center.x, center.y, view, size)), { x, y });
  }
  assert.equal(api.editorCanvasToGridXY(-9999, -9999, view, size), null);
});

test("brush size is an exact 1x1 through 5x5 square anchored at the pointer cell", () => {
  const { api } = createRuntime();
  assert.deepEqual(plain(api.editorBrushCells(10, 10, 1, 40, 40)), [{ x: 10, y: 10, index: 410 }]);
  assert.deepEqual(plain(api.editorBrushCells(10, 10, 2, 40, 40)), [
    { x: 10, y: 10, index: 410 }, { x: 11, y: 10, index: 411 },
    { x: 10, y: 11, index: 450 }, { x: 11, y: 11, index: 451 },
  ]);
  assert.equal(api.editorBrushCells(10, 10, 3, 40, 40).length, 9);
  assert.equal(api.editorBrushCells(10, 10, 5, 40, 40).length, 25);
  assert.equal(api.editorBrushCells(39, 39, 5, 40, 40).length, 1);
});

test("tile and object brush writes use UTF-16 map strings", () => {
  const { api, context } = createRuntime();
  const mapData = context.ChatRoomData.MapData;
  const cells = [{ x: 2, y: 3, index: 122 }, { x: 3, y: 3, index: 123 }];
  assert.equal(api.applyEditorStroke(mapData, "tile", 455, cells), true);
  assert.equal(mapData.Tiles.charCodeAt(122), 455);
  assert.equal(mapData.Tiles.charCodeAt(123), 455);
  assert.equal(api.applyEditorStroke(mapData, "object", 2030, cells), true);
  assert.equal(mapData.Objects.charCodeAt(122), 2030);
  assert.equal(mapData.Objects.charCodeAt(123), 2030);
});

test("unique object write removes prior copies and keeps only the first brush cell", () => {
  const { api, context } = createRuntime();
  const mapData = context.ChatRoomData.MapData;
  mapData.Objects = String.fromCharCode(777) + mapData.Objects.slice(1, 800) + String.fromCharCode(777) + mapData.Objects.slice(801);
  const cells = [{ index: 10 }, { index: 11 }, { index: 12 }];
  assert.equal(api.applyEditorStroke(mapData, "object", 777, cells, { ID: 777, Unique: true }), true);
  assert.equal(countCode(mapData.Objects, 777), 1);
  assert.equal(mapData.Objects.charCodeAt(10), 777);
  assert.equal(mapData.Objects.charCodeAt(0), api.constants.EDITOR_OBJECT_BLANK_ID);
  assert.equal(mapData.Objects.charCodeAt(800), api.constants.EDITOR_OBJECT_BLANK_ID);
});

test("tiles cannot be erased, only objects are deleted via the blank object", () => {
  const { api, context } = createRuntime();
  const mapData = context.ChatRoomData.MapData;
  const cells = [{ index: 42 }];
  // 地块层没有空白概念：写 0 被拒绝，地块只能被其它地块覆盖
  assert.equal(api.applyEditorStroke(mapData, "tile", 0, cells), false);
  assert.equal(mapData.Tiles.charCodeAt(42), 100);
  // 物件层通过空白物件删除
  assert.equal(api.applyEditorStroke(mapData, "object", 200, cells), true);
  assert.equal(mapData.Objects.charCodeAt(42), 200);
  assert.equal(api.applyEditorStroke(mapData, "object", api.constants.EDITOR_OBJECT_BLANK_ID, cells), true);
  assert.equal(mapData.Objects.charCodeAt(42), 100);
});

test("undo and redo keep snapshots and cap undo history at 100", () => {
  const { api, context } = createRuntime();
  const mapData = context.ChatRoomData.MapData;
  const history = api.createEditorHistory();
  api.editorPushUndo(history, mapData);
  api.applyEditorStroke(mapData, "tile", 200, [{ index: 0 }]);
  assert.equal(api.editorUndoMap(history, mapData), true);
  assert.equal(mapData.Tiles.charCodeAt(0), 100);
  assert.equal(api.editorRedoMap(history, mapData), true);
  assert.equal(mapData.Tiles.charCodeAt(0), 200);

  for (let i = 0; i < 120; i++) {
    mapData.Tiles = String.fromCharCode(300 + i) + mapData.Tiles.slice(1);
    api.editorPushUndo(history, mapData);
  }
  assert.equal(history.undo.length, api.constants.EDITOR_HISTORY_LIMIT);
  assert.equal(history.redo.length, 0);
});

test("materials use simplified Chinese labels and remain searchable by Chinese, style and id", () => {
  const { api } = createRuntime();
  const lookup = {
    100: { ID: 100, Type: "Floor", Style: "Stone" },
    200: { ID: 200, Type: "Wall", Style: "Brick" },
    300: { ID: 300, Type: "FloorNumber", Style: "Number7" },
  };
  const materials = api.buildEditorMaterials("tile", lookup);
  assert.deepEqual(plain(materials).map(item => item.label), ["石材", "数字 7", "砖墙"]);
  assert.deepEqual(plain(api.filterEditorMaterials(materials, "Floor")).map(item => item.id), [100]);
  assert.deepEqual(plain(api.filterEditorMaterials(materials, "", "砖墙")).map(item => item.id), [200]);
  assert.deepEqual(plain(api.filterEditorMaterials(materials, "", "brick")).map(item => item.id), [200]);
  assert.deepEqual(plain(api.filterEditorMaterials(materials, "", "100")).map(item => item.id), [100]);
});

test("hexagon floor and wall styles share the same name and get disambiguated labels", () => {
  const { api } = createRuntime();
  const lookup = {
    100: { ID: 100, Type: "Floor", Style: "HexPurple" },
    101: { ID: 101, Type: "Floor", Style: "HexBlue" },
    200: { ID: 200, Type: "Wall", Style: "HexPurple" },
    201: { ID: 201, Type: "Wall", Style: "HexBlue" },
  };
  const labels = plain(api.buildEditorMaterials("tile", lookup)).map(item => `${item.type}:${item.label}`);
  assert.deepEqual(labels, [
    "Floor:紫色六边形（地面）",
    "Floor:蓝色六边形（地面）",
    "Wall:紫色六边形（墙壁）",
    "Wall:蓝色六边形（墙壁）",
  ]);
  // 子串搜索仍能命中
  assert.deepEqual(plain(api.filterEditorMaterials(api.buildEditorMaterials("tile", lookup), "", "紫色六边形")).map(item => item.label), ["紫色六边形（地面）", "紫色六边形（墙壁）"]);
});

test("lighting materials are built from the native effect list as a tile-category group", () => {
  const { api } = createRuntime();
  const list = [
    { ID: 10, Type: "StaticLighting", TypeId: 1, Color: [0, 0, 0, 0.0] },
    { ID: 11, Type: "StaticLighting", TypeId: 1, Color: [0, 0, 0, 0.2] },
    { ID: 14, Type: "StaticLighting", TypeId: 1, Color: [255, 0, 0, 0.3] },
    { ID: 17, Type: "StaticLighting", TypeId: 1, Color: [255, 255, 0, 0.3] },
  ];
  const materials = plain(api.buildLightingMaterials(list));
  assert.deepEqual(materials.map(m => ({ id: m.id, layer: m.layer, type: m.type, label: m.label, owned: m.owned })), [
    { id: 10, layer: "tile", type: "Lighting", label: "无光照", owned: true },
    { id: 11, layer: "tile", type: "Lighting", label: "浅阴影", owned: true },
    { id: 14, layer: "tile", type: "Lighting", label: "红色光照", owned: true },
    { id: 17, layer: "tile", type: "Lighting", label: "黄色光照", owned: true },
  ]);
  // 素材色块是内联 SVG，不依赖原版贴图
  const swatch = api.editorLightingSwatch(materials[2]);
  assert.match(swatch, /^data:image\/svg\+xml,/);
  assert.match(decodeURIComponent(swatch), /rgba\(255,0,0,0\.3\)/);
});

test("lighting strokes write and clear the effects layer without touching tiles", () => {
  const { api, context } = createRuntime();
  const mapData = context.ChatRoomData.MapData;
  mapData.Effects = Array.from({ length: 1600 }, () => []);
  const cells = [{ index: 5 }, { index: 6 }];
  const effect = { ID: 14, Type: "StaticLighting", TypeId: 1, Color: [255, 0, 0, 0.3] };
  assert.equal(api.applyEditorStroke(mapData, "tile", 14, cells, effect), true);
  assert.deepEqual(plain(mapData.Effects[5]), [effect]);
  assert.deepEqual(plain(mapData.Effects[6]), [effect]);
  assert.equal(mapData.Tiles.charCodeAt(5), 100); // 地块字符串未被触碰
  assert.equal(mapData.Tiles.charCodeAt(6), 100);
  // 无光照（空白 ID 10）清除效果
  assert.equal(api.applyEditorStroke(mapData, "tile", api.constants.EDITOR_LIGHTING_BLANK_ID, cells, effect), true);
  assert.deepEqual(plain(mapData.Effects[5]), []);
  assert.deepEqual(plain(mapData.Effects[6]), []);
  // 同值重涂返回 false
  assert.equal(api.applyEditorStroke(mapData, "tile", api.constants.EDITOR_LIGHTING_BLANK_ID, cells, effect), false);
});

test("lighting effects round-trip through the working snapshot and one-way push", () => {
  const { api, context } = createRuntime();
  const manager = context.ChatRoomMapManager.Map;
  manager._effects = Array.from({ length: 1600 }, () => []);
  const working = api.editorSnapshotWorking();
  const effect = { ID: 12, Type: "StaticLighting", TypeId: 1, Color: [0, 0, 0, 0.5] };
  working.Effects[10] = [effect];
  assert.equal(api.editorPushWorkingToMap(working), true);
  assert.deepEqual(plain(manager._effects[10]), [effect]);
  // 一致时不再写回
  assert.equal(api.editorPushWorkingToMap(working), false);
  // 外部把效果改走后，单向覆盖恢复工作副本
  manager._effects[10] = [];
  assert.equal(api.editorPushWorkingToMap(working), true);
  assert.deepEqual(plain(manager._effects[10]), [effect]);
  // 快照不共享内部数组引用
  manager._effects[11] = [effect];
  const snapshot = api.editorSnapshotWorking();
  manager._effects[11] = [];
  assert.deepEqual(plain(snapshot.Effects[11]), [effect]);
});

test("editor UI disables the eraser on the tile layer and ships lighting swatches", () => {
  const editorSource = fs.readFileSync(path.join(root, "src", "05-editor.js"), "utf8");
  // 地块无法删除：橡皮只对物件层可用，切到地块层自动切回画笔
  assert.match(editorSource, /eraser\.disabled = editorLayer === EDITOR_LAYER_TILE/);
  assert.match(editorSource, /地块无法删除，只能覆盖/);
  assert.match(editorSource, /Lighting: "光照"/);
  // 光照素材归入地块大类并写入 Effects 层
  assert.match(editorSource, /definition\?\.Type === "StaticLighting"/);
  assert.match(editorSource, /getChatRoomMapViewEffectList/);
  assert.match(editorSource, /data:image\/svg\+xml,/);
});

test("asset-bound objects are greyed logically when inventory ownership is missing", () => {
  const { api, context } = createRuntime();
  const lookup = {
    100: { ID: 100, Type: "FloorItem", Style: "Blank" },
    500: { ID: 500, Type: "FloorItem", Style: "Free" },
    501: { ID: 501, Type: "FloorItem", Style: "Owned", AssetName: "Collar", AssetGroup: "ItemNeck" },
    502: { ID: 502, Type: "FloorItem", Style: "Locked", AssetName: "Cuffs", AssetGroup: "ItemArms" },
  };
  const inventory = (_player, name, group) => name === "Collar" && group === "ItemNeck";
  const materials = api.buildEditorMaterials("object", lookup, context.Player, inventory);
  assert.deepEqual(plain(materials).map(item => ({ id: item.id, owned: item.owned })), [
    { id: 500, owned: true },
    { id: 501, owned: true },
    { id: 502, owned: false },
  ]);
});

test("editor UI uses collapsible category groups, fills the viewport and uses right-button panning", () => {
  const editorSource = fs.readFileSync(path.join(root, "src", "05-editor.js"), "utf8");
  assert.match(editorSource, /width:calc\(100vw - 16px\);height:calc\(100vh - 16px\)/);
  // 素材库改为折叠栏：整栏滚动，不再使用分类按钮行与分页
  assert.match(editorSource, /\.bms-ed-groups\{[^}]*overflow-y:auto/);
  assert.doesNotMatch(editorSource, /\.bms-ed-categories/);
  assert.doesNotMatch(editorSource, /data-category/);
  // 最近分类固定存在且置顶，地块层默认展开、物件层默认折叠
  assert.match(editorSource, /\{ key: "recent", label: "最近", items:/);
  assert.match(editorSource, /state\.has\(key\) \? state\.get\(key\) : layer === EDITOR_LAYER_OBJECT/);
  assert.match(editorSource, /data-group-head=/);
  assert.doesNotMatch(editorSource, /data-tool="pan"/);
  assert.match(editorSource, /event\.button === 2 \|\| event\.button === 1/);
  assert.doesNotMatch(editorSource, /temporaryEraser/);
  // 不尝试屏蔽浏览器手势：拦截代码与画布交互互相干扰且对扩展无效，改为提示用户自行关闭
  assert.doesNotMatch(editorSource, /stopImmediatePropagation/);
  assert.doesNotMatch(editorSource, /blockEditorContextMenu/);
  assert.doesNotMatch(editorSource, /blockBrowserMouseGesture/);
  assert.match(editorSource, /在手势软件中禁用鼠标手势/);
});

test("editor entry requires admin map view and no native edit submode", () => {
  assert.equal(createRuntime().api.shouldDrawEditorEntryButton(), true);
  assert.equal(createRuntime({ ChatRoomPlayerIsAdmin: () => false }).api.shouldDrawEditorEntryButton(), false);
  assert.equal(createRuntime({ ChatRoomMapViewIsActive: () => false }).api.shouldDrawEditorEntryButton(), false);
  assert.equal(createRuntime({ ChatRoomMapViewEditMode: "Tile" }).api.shouldDrawEditorEntryButton(), false);
  assert.equal(createRuntime({ ChatRoomData: { MapData: { Type: "Never" } } }).api.shouldDrawEditorEntryButton(), false);
});

test("editor working copy overwrites external map state one-way", () => {
  const { api, context } = createRuntime();
  const mapData = context.ChatRoomData.MapData;
  mapData.Tiles = String.fromCharCode(100).repeat(1600);
  mapData.Objects = String.fromCharCode(100).repeat(1600);
  // 编辑器打开时快照的工作副本
  const working = api.editorSnapshotWorking();
  // 外部同步（服务器广播/原版清理）把地图改走，编辑器内容必须单向覆盖回去
  mapData.Tiles = String.fromCharCode(200).repeat(1600);
  assert.equal(api.editorPushWorkingToMap(working), true);
  assert.equal(mapData.Tiles.charCodeAt(0), 100);
  // 再次调用时一致，返回 false，不会无限写回
  assert.equal(api.editorPushWorkingToMap(working), false);
  // 外部只改一个格子（局部竞态）也会被写回
  mapData.Tiles = mapData.Tiles.substring(0, 5) + String.fromCharCode(300) + mapData.Tiles.substring(6);
  assert.equal(api.editorPushWorkingToMap(working), true);
  assert.equal(mapData.Tiles.charCodeAt(5), 100);
});

test("object compatibility pre-check mirrors the native cleanup rules", () => {
  const { api } = createRuntime();
  const tileLookup = {
    100: { ID: 100, Type: "Floor", Style: "Stone" },
    1000: { ID: 1000, Type: "Wall", Style: "Brick" },
  };
  const build = code => String.fromCharCode(code).repeat(1600);
  const floor = build(100);
  const wall = build(1000);
  const def = { Type: "FloorDecoration", Style: "Table" };
  // 地面装饰：地板上可放，墙上被原版清理
  assert.equal(api.editorObjectCellCompatible(floor, 5, 5, 40, 40, def, tileLookup), true);
  assert.equal(api.editorObjectCellCompatible(wall, 5, 5, 40, 40, def, tileLookup), false);
  // 墙饰：地板上被清理；墙面上下方非墙可放，下方也是墙被清理
  const wallDeco = { Type: "WallDecoration", Style: "Painting" };
  assert.equal(api.editorObjectCellCompatible(floor, 5, 5, 40, 40, wallDeco, tileLookup), false);
  let wallAboveFloor = build(1000); // 全墙，(5,5) 保持墙
  wallAboveFloor = wallAboveFloor.substring(0, 6 * 40 + 5) + String.fromCharCode(100) + wallAboveFloor.substring(6 * 40 + 6); // 仅下方 (5,6) 改为地板
  assert.equal(api.editorObjectCellCompatible(wallAboveFloor, 5, 5, 40, 40, wallDeco, tileLookup), true);
  const wallAboveWall = build(1000);
  assert.equal(api.editorObjectCellCompatible(wallAboveWall, 5, 5, 40, 40, wallDeco, tileLookup), false);
});
