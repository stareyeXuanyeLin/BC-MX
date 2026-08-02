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
    ChatRoomMapManager: { Map: { exportString: () => "map", importString: () => true } },
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

test("brush cell selection clips a 1-5 range square to map bounds", () => {
  const { api } = createRuntime();
  assert.deepEqual(plain(api.editorBrushCells(10, 10, 1, 40, 40)), [{ x: 10, y: 10, index: 410 }]);
  assert.equal(api.editorBrushCells(10, 10, 3, 40, 40).length, 25);
  assert.equal(api.editorBrushCells(0, 0, 5, 40, 40).length, 25);
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

test("unique object write removes prior copies and keeps only the final brush cell", () => {
  const { api, context } = createRuntime();
  const mapData = context.ChatRoomData.MapData;
  mapData.Objects = String.fromCharCode(777) + mapData.Objects.slice(1, 800) + String.fromCharCode(777) + mapData.Objects.slice(801);
  const cells = [{ index: 10 }, { index: 11 }, { index: 12 }];
  assert.equal(api.applyEditorStroke(mapData, "object", 777, cells, { ID: 777, Unique: true }), true);
  assert.equal(countCode(mapData.Objects, 777), 1);
  assert.equal(mapData.Objects.charCodeAt(12), 777);
  assert.equal(mapData.Objects.charCodeAt(0), api.constants.EDITOR_OBJECT_BLANK_ID);
  assert.equal(mapData.Objects.charCodeAt(800), api.constants.EDITOR_OBJECT_BLANK_ID);
});

test("eraser writes tile blank 0 and object blank 100", () => {
  const { api, context } = createRuntime();
  const mapData = context.ChatRoomData.MapData;
  const cells = [{ index: 42 }];
  api.applyEditorStroke(mapData, "tile", 0, cells);
  api.applyEditorStroke(mapData, "object", api.constants.EDITOR_OBJECT_BLANK_ID, cells);
  assert.equal(mapData.Tiles.charCodeAt(42), 0);
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

test("material filtering searches across type, style and id", () => {
  const { api } = createRuntime();
  const lookup = {
    100: { ID: 100, Type: "Floor", Style: "Stone" },
    200: { ID: 200, Type: "Wall", Style: "Brick" },
  };
  const materials = api.buildEditorMaterials("tile", lookup);
  assert.deepEqual(plain(api.filterEditorMaterials(materials, "Floor")).map(item => item.id), [100]);
  assert.deepEqual(plain(api.filterEditorMaterials(materials, "", "brick")).map(item => item.id), [200]);
  assert.deepEqual(plain(api.filterEditorMaterials(materials, "", "100")).map(item => item.id), [100]);
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

test("editor entry requires admin map view and no native edit submode", () => {
  assert.equal(createRuntime().api.shouldDrawEditorEntryButton(), true);
  assert.equal(createRuntime({ ChatRoomPlayerIsAdmin: () => false }).api.shouldDrawEditorEntryButton(), false);
  assert.equal(createRuntime({ ChatRoomMapViewIsActive: () => false }).api.shouldDrawEditorEntryButton(), false);
  assert.equal(createRuntime({ ChatRoomMapViewEditMode: "Tile" }).api.shouldDrawEditorEntryButton(), false);
  assert.equal(createRuntime({ ChatRoomData: { MapData: { Type: "Never" } } }).api.shouldDrawEditorEntryButton(), false);
});
