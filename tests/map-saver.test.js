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

function createRuntime(overrides = {}) {
  const localStorage = overrides.localStorage || createLocalStorage();
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
    localStorage,
    Player: { MemberNumber: 12345 },
    CurrentScreen: "ChatRoom",
    ChatRoomData: {
      Name: "测试地图房",
      MapData: { Type: "Always", Tiles: "tiles", Objects: "objects" },
    },
    ChatRoomPlayerIsAdmin: () => true,
    ChatRoomMapManager: {
      Map: {
        exportString: () => "native-map-payload",
        importString: () => true,
      },
    },
    ChatRoomMapViewUpdateFlag: () => {},
    ChatRoomMapViewCalculatePerceptionMasks: () => {},
    ChatRoomSendLocal: () => {},
    ...overrides,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "BCMapSaver.user.js" });
  return { api: context.__BMS_TEST_API__, context, localStorage };
}

const plain = value => JSON.parse(JSON.stringify(value));

function record(api, id, name, payload = `payload-${id}`) {
  return api.normalizeMapRecord({ id, name, payload, createdAt: 100, updatedAt: 100 });
}

test("normalizes a BC-native payload without decoding it", () => {
  const { api } = createRuntime();
  const normalized = api.normalizeMapRecord({ id: "one", name: "  地图一  ", note: "  备注  ", payload: "  ABC@XYZ  ", mapType: "Always" });
  assert.equal(normalized.name, "地图一");
  assert.equal(normalized.note, "备注");
  assert.equal(normalized.payload, "ABC@XYZ");
  assert.equal(normalized.mapType, "Always");
  assert.equal(normalized.storageVersion, 1);
});

test("rejects empty payloads and duplicate record ids", () => {
  const { api } = createRuntime();
  assert.throws(() => api.normalizeMapRecord({ name: "x", payload: "" }), /负载为空/);
  assert.throws(() => api.normalizeLibrary({ schemaVersion: 1, records: [record(api, "same", "A"), record(api, "same", "B")] }), /ID 重复/);
});

test("round-trips one-map and whole-library file documents", () => {
  const { api } = createRuntime();
  const map = record(api, "m1", "雪原");
  const one = api.parseImportDocument(api.serializeFileDocument(api.createMapFileDocument(map)), "snow.bcmap.json");
  assert.equal(one.kind, "map");
  assert.equal(one.records[0].payload, map.payload);

  const library = { schemaVersion: 1, records: [map, record(api, "m2", "城堡")] };
  const all = api.parseImportDocument(api.serializeFileDocument(api.createLibraryFileDocument(library)), "all.bcmapset.json");
  assert.equal(all.kind, "library");
  assert.deepEqual(all.records.map(item => item.name), ["雪原", "城堡"]);
});

test("accepts a raw BC export string as a single imported map", () => {
  const { api } = createRuntime();
  const parsed = api.parseImportDocument("native@payload", "Old Castle.bcmap");
  assert.equal(parsed.kind, "map");
  assert.equal(parsed.rawNativePayload, true);
  assert.equal(parsed.records[0].name, "Old Castle");
  assert.equal(parsed.records[0].payload, "native@payload");
});

test("keepBoth generates an independent id and non-conflicting display name", () => {
  const { api } = createRuntime();
  const current = { schemaVersion: 1, records: [record(api, "same", "同名地图")] };
  const plan = api.buildImportPlan(current, [record(api, "same", "同名地图", "new")], "keepBoth");
  assert.equal(plan.library.records.length, 2);
  assert.notEqual(plan.library.records[1].id, "same");
  assert.equal(plan.library.records[1].name, "同名地图（导入 2）");
  assert.deepEqual(plain(plan.stats), { added: 1, overwritten: 0, skipped: 0 });
});

test("overwriteId replaces payload while preserving local identity and creation time", () => {
  const { api } = createRuntime();
  const existing = record(api, "same", "旧名称", "old");
  existing.createdAt = 10;
  const incoming = record(api, "same", "新名称", "new");
  const plan = api.buildImportPlan({ schemaVersion: 1, records: [existing] }, [incoming], "overwriteId");
  assert.equal(plan.library.records.length, 1);
  assert.equal(plan.library.records[0].id, "same");
  assert.equal(plan.library.records[0].name, "新名称");
  assert.equal(plan.library.records[0].payload, "new");
  assert.equal(plan.library.records[0].createdAt, 10);
  assert.equal(plan.stats.overwritten, 1);
});

test("overwriteName targets the local same-name record", () => {
  const { api } = createRuntime();
  const current = { schemaVersion: 1, records: [record(api, "local-id", "同名", "old")] };
  const incoming = record(api, "foreign-id", "同名", "new");
  const plan = api.buildImportPlan(current, [incoming], "overwriteName");
  assert.equal(plan.library.records.length, 1);
  assert.equal(plan.library.records[0].id, "local-id");
  assert.equal(plan.library.records[0].payload, "new");
});

test("skip ignores either id or name conflicts and replaceAll discards old records", () => {
  const { api } = createRuntime();
  const current = { schemaVersion: 1, records: [record(api, "a", "A"), record(api, "b", "B")] };
  const skipped = api.buildImportPlan(current, [record(api, "a", "C"), record(api, "c", "B")], "skip");
  assert.equal(skipped.library.records.length, 2);
  assert.equal(skipped.stats.skipped, 2);

  const replaced = api.buildImportPlan(current, [record(api, "z", "Z")], "replaceAll");
  assert.deepEqual(plain(replaced.library.records.map(item => item.id)), ["z"]);
});

test("persists per-account library and does not mutate state when storage write fails", () => {
  const localStorage = createLocalStorage();
  const { api } = createRuntime({ localStorage });
  api.readLibraryFromStorage();
  api.addRecord(record(api, "a", "A"));
  assert.ok(localStorage.values.has("BC.MapSaver.v1:12345"));
  assert.equal(api.getLibrary().records.length, 1);

  localStorage.setItem = () => { throw new Error("quota"); };
  assert.throws(() => api.addRecord(record(api, "b", "B")), /quota/);
  assert.equal(api.getLibrary().records.length, 1);
});

test("backs up malformed local storage before allowing a fresh library write", () => {
  const localStorage = createLocalStorage();
  localStorage.setItem("BC.MapSaver.v1:12345", "{broken json");
  const { api } = createRuntime({ localStorage });
  const loaded = api.readLibraryFromStorage();
  assert.equal(loaded.records.length, 0);
  const recoveryKeys = [...localStorage.values.keys()].filter(key => key.startsWith("BC.MapSaver.v1:12345.corrupt."));
  assert.equal(recoveryKeys.length, 1);
  assert.equal(localStorage.getItem(recoveryKeys[0]), "{broken json");
  api.addRecord(record(api, "fresh", "新地图"));
  assert.equal(api.getLibrary().records.length, 1);
});

test("saving and overwriting current room maps require admin and use BC exportString", () => {
  let payload = "first";
  const manager = { Map: { exportString: () => payload, importString: () => true } };
  const { api, context } = createRuntime({ ChatRoomMapManager: manager });
  api.setActiveStorageKey("test");
  const saved = api.saveCurrentMapAsNew("当前地图", "note");
  assert.equal(saved.payload, "first");
  assert.equal(saved.sourceRoomName, "测试地图房");

  payload = "second";
  api.overwriteSavedMapFromCurrent(saved.id);
  assert.equal(api.findRecord(saved.id).payload, "second");

  context.ChatRoomPlayerIsAdmin = () => false;
  assert.throws(() => api.saveCurrentMapAsNew("无权限"), /管理员/);
});

test("applying a map creates an automatic backup and invokes native sync post-processing", () => {
  let importedPayload = null;
  let updateCalls = 0;
  let maskCalls = 0;
  const manager = {
    Map: {
      exportString: () => "current-room-map",
      importString: payload => { importedPayload = payload; return true; },
    },
  };
  const { api } = createRuntime({
    ChatRoomMapManager: manager,
    ChatRoomMapViewUpdateFlag: () => { updateCalls += 1; },
    ChatRoomMapViewCalculatePerceptionMasks: () => { maskCalls += 1; },
  });
  api.setActiveStorageKey("test");
  api.setLibrary({ schemaVersion: 1, records: [record(api, "target", "目标地图", "target-payload")] });

  const result = api.applySavedMapToRoom("target");
  assert.equal(importedPayload, "target-payload");
  assert.equal(updateCalls, 1);
  assert.equal(maskCalls, 1);
  assert.equal(result.backup.payload, "current-room-map");
  assert.equal(result.backup.autoBackup, true);
  assert.equal(api.getLibrary().records.filter(item => item.autoBackup).length, 1);
});

test("failed native import leaves the target library intact and removes the unused backup", () => {
  const manager = { Map: { exportString: () => "current", importString: () => false } };
  const { api } = createRuntime({ ChatRoomMapManager: manager });
  api.setActiveStorageKey("test");
  api.setLibrary({ schemaVersion: 1, records: [record(api, "target", "坏地图", "bad")] });
  assert.throws(() => api.applySavedMapToRoom("target"), /没有被修改/);
  assert.equal(api.getLibrary().records.length, 1);
  assert.equal(api.getLibrary().records[0].id, "target");
});

test("automatic backups are pruned independently from user-created maps", () => {
  const { api } = createRuntime();
  api.setActiveStorageKey("test");
  api.setLibrary({ schemaVersion: 1, records: [record(api, "user", "用户地图")] });
  for (let index = 0; index < api.constants.MAX_AUTO_BACKUPS + 3; index += 1) {
    api.addAutoBackup(api.normalizeMapRecord({ id: `backup-${index}`, name: `备份 ${index}`, payload: `p-${index}`, createdAt: index + 1, updatedAt: index + 1, autoBackup: true }));
  }
  const result = api.getLibrary();
  assert.equal(result.records.filter(item => item.autoBackup).length, api.constants.MAX_AUTO_BACKUPS);
  assert.ok(result.records.some(item => item.id === "user"));
});
