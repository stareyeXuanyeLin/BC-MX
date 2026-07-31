// ==UserScript==
// @name         Bondage Club - Map Saver（核心脚本）
// @name:zh-CN   Bondage Club - 地图存档（核心脚本）
// @namespace    https://github.com/stareyeXuanyeLin/BC-Map-Saver
// @version      0.2.5
// @description  在本地保存、导入、导出并重建 Bondage Club 聊天室地图。
// @author       林宣夜＆佩菈
// @match        https://www.bondageprojects.com/R*/*
// @match        https://bondageprojects.com/R*/*
// @match        https://www.bondageprojects.elementfx.com/R*/*
// @match        https://bondageprojects.elementfx.com/R*/*
// @match        https://bondage-europe.com/R*/*
// @match        https://www.bondage-europe.com/R*/*
// @match        https://bondage-asia.com/club/R*/*
// @match        https://www.bondage-asia.com/club/R*/*
// @match        http://localhost:*/*
// @run-at       document-end
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/stareyeXuanyeLin/BC-Map-Saver/main/dist/BCMapSaver.user.js
// @updateURL    https://raw.githubusercontent.com/stareyeXuanyeLin/BC-Map-Saver/main/dist/BCMapSaver.user.js
// ==/UserScript==

(() => {
  "use strict";



  const MOD_NAME = "BCMapSaver";
  const FULL_NAME = "BC Map Saver";
  const VERSION = "0.2.5";
  const STORAGE_SCHEMA_VERSION = 1;
  const RECORD_STORAGE_VERSION = 1;
  const MAP_FILE_FORMAT = "BC_MAP_SAVER_MAP";
  const LIBRARY_FILE_FORMAT = "BC_MAP_SAVER_LIBRARY";
  const FILE_FORMAT_VERSION = 1;
  const STORAGE_PREFIX = "BC.MapSaver.v1";
  const ROOT_ID = "bms-root";
  const STYLE_ID = "bms-style";
  const FILE_INPUT_ID = "bms-file-input";
  const MAX_RECORDS = 300;
  const MAX_AUTO_BACKUPS = 10;
  const MAX_PAYLOAD_CHARS = 2_000_000;
  const MAX_IMPORT_FILE_BYTES = 12 * 1024 * 1024;
  const MAX_LIBRARY_STORAGE_BYTES = 4_500_000;
  const ENTRY_BUTTON = Object.freeze({ x: 10, y: 500, width: 60, height: 60 });

  let modApi = null;
  let runtimeInstalled = false;
  let initialized = false;
  let duplicateInstance = false;
  let activeStorageKey = null;
  let storageRecoveryKey = null;
  let storageWriteBlocked = false;
  let library = { schemaVersion: STORAGE_SCHEMA_VERSION, records: [] };
  let uiOpen = false;

  const log = (...args) => console.log(`[${MOD_NAME}]`, ...args);
  const warn = (...args) => console.warn(`[${MOD_NAME}]`, ...args);
  const cloneJSON = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const utf8Bytes = value => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return typeof TextEncoder === "function"
      ? new TextEncoder().encode(text).length
      : unescape(encodeURIComponent(text)).length;
  };
  const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const now = () => Date.now();
  const clampText = (value, max) => String(value ?? "").trim().slice(0, max);
  const escapeHTML = value => String(value ?? "").replace(/[&<>'"]/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[c]);
  const localTimestamp = timestamp => {
    const d = new Date(Number(timestamp) || now());
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const fileTimestamp = timestamp => localTimestamp(timestamp).replace(/[-:]/g, "").replace(" ", "-");
  const sanitizeFilenamePart = value => clampText(value, 80)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/g, "") || "未命名地图";
  const currentMemberNumber = () => Number(globalThis.Player?.MemberNumber);
  const storageKeyForCurrentPlayer = () => {
    const member = currentMemberNumber();
    return `${STORAGE_PREFIX}:${Number.isInteger(member) ? member : "anonymous"}`;
  };
  const emptyLibrary = () => ({ schemaVersion: STORAGE_SCHEMA_VERSION, records: [] });

  // Current BC declares some shared values with top-level let/const. Those bindings are
  // visible by identifier to later scripts, but are intentionally absent from globalThis.
  function getChatRoomData() {
    try {
      if (typeof ChatRoomData !== "undefined") return ChatRoomData;
    } catch (_) { /* fall through to legacy window property */ }
    return globalThis.ChatRoomData ?? null;
  }

  function getChatRoomMapManager() {
    try {
      if (typeof ChatRoomMapManager !== "undefined") return ChatRoomMapManager;
    } catch (_) { /* fall through to legacy window property */ }
    return globalThis.ChatRoomMapManager ?? null;
  }

  function toast(message, kind = "info") {
    const host = document.getElementById(ROOT_ID) || document.body;
    if (!host) return;
    const element = document.createElement("div");
    element.className = `bms-toast bms-${kind}`;
    element.textContent = String(message);
    host.appendChild(element);
    requestAnimationFrame(() => element.classList.add("bms-show"));
    setTimeout(() => {
      element.classList.remove("bms-show");
      setTimeout(() => element.remove(), 180);
    }, 2800);
  }



  function normalizeMapRecord(input, options = {}) {
    if (!isPlainObject(input)) throw new Error("地图记录必须是对象");
    const payload = typeof input.payload === "string" ? input.payload.trim() : "";
    if (!payload) throw new Error("地图负载为空");
    if (payload.length > MAX_PAYLOAD_CHARS) throw new Error("地图负载超过大小限制");

    const timestamp = now();
    const id = clampText(input.id, 120) || uid();
    const name = clampText(input.name, 80) || options.defaultName || "未命名地图";
    const createdAt = Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : timestamp;
    const updatedAt = Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : createdAt;
    const mapType = ["Always", "Hybrid", "Never"].includes(input.mapType) ? input.mapType : undefined;

    return {
      id,
      name,
      note: clampText(input.note, 500),
      createdAt,
      updatedAt,
      payload,
      sourceRoomName: clampText(input.sourceRoomName, 120),
      mapType,
      storageVersion: RECORD_STORAGE_VERSION,
      autoBackup: input.autoBackup === true,
    };
  }

  function normalizeLibrary(input) {
    if (!isPlainObject(input)) throw new Error("地图库必须是对象");
    if (Number(input.schemaVersion) !== STORAGE_SCHEMA_VERSION) throw new Error("不支持的地图库版本");
    if (!Array.isArray(input.records)) throw new Error("地图库记录列表无效");
    if (input.records.length > MAX_RECORDS) throw new Error(`地图库最多保存 ${MAX_RECORDS} 张地图`);

    const ids = new Set();
    const records = input.records.map(record => {
      const normalized = normalizeMapRecord(record);
      if (ids.has(normalized.id)) throw new Error(`地图 ID 重复：${normalized.id}`);
      ids.add(normalized.id);
      return normalized;
    });
    return { schemaVersion: STORAGE_SCHEMA_VERSION, records };
  }

  function readLibraryFromStorage() {
    activeStorageKey = storageKeyForCurrentPlayer();
    if (!globalThis.localStorage) throw new Error("当前浏览器不支持本地存储");
    const raw = globalThis.localStorage.getItem(activeStorageKey);
    if (!raw) {
      storageRecoveryKey = null;
      storageWriteBlocked = false;
      library = emptyLibrary();
      return library;
    }
    try {
      library = normalizeLibrary(JSON.parse(raw));
      storageRecoveryKey = null;
      storageWriteBlocked = false;
    } catch (error) {
      storageRecoveryKey = `${activeStorageKey}.corrupt.${now()}`;
      try {
        globalThis.localStorage.setItem(storageRecoveryKey, raw);
        storageWriteBlocked = false;
      } catch (backupError) {
        storageWriteBlocked = true;
        warn("损坏地图库无法创建恢复副本，已禁止覆盖本地存储", backupError);
      }
      warn(`本地地图库损坏；原始文本已保留在 ${storageRecoveryKey}`, error);
      library = emptyLibrary();
      library.loadError = String(error?.message || error);
    }
    return library;
  }

  function persistLibrary(nextLibrary) {
    if (storageWriteBlocked) throw new Error("损坏的本地地图库无法创建恢复副本，插件已禁止写入以保护原始数据");
    const normalized = normalizeLibrary(nextLibrary);
    const serialized = JSON.stringify(normalized);
    if (utf8Bytes(serialized) > MAX_LIBRARY_STORAGE_BYTES) throw new Error("本地地图库已接近浏览器容量上限，请先导出并删除部分地图");
    const key = activeStorageKey || storageKeyForCurrentPlayer();
    if (!globalThis.localStorage) throw new Error("当前浏览器不支持本地存储");
    globalThis.localStorage.setItem(key, serialized);
    activeStorageKey = key;
    library = normalized;
    return library;
  }

  function mutateLibrary(mutator) {
    const draft = cloneJSON(library);
    const result = mutator(draft);
    persistLibrary(draft);
    return result;
  }

  function createMapRecord(payload, metadata = {}) {
    return normalizeMapRecord({
      id: metadata.id || uid(),
      name: metadata.name,
      note: metadata.note,
      payload,
      sourceRoomName: metadata.sourceRoomName,
      mapType: metadata.mapType,
      createdAt: metadata.createdAt || now(),
      updatedAt: metadata.updatedAt || now(),
      autoBackup: metadata.autoBackup === true,
    });
  }

  function addRecord(record) {
    const normalized = normalizeMapRecord(record);
    mutateLibrary(draft => {
      if (draft.records.length >= MAX_RECORDS) throw new Error(`地图库最多保存 ${MAX_RECORDS} 张地图`);
      if (draft.records.some(item => item.id === normalized.id)) throw new Error("地图 ID 已存在");
      draft.records.push(normalized);
    });
    return normalized;
  }

  function overwriteRecord(id, replacement) {
    let saved;
    mutateLibrary(draft => {
      const index = draft.records.findIndex(record => record.id === id);
      if (index < 0) throw new Error("找不到要覆盖的地图");
      const previous = draft.records[index];
      saved = normalizeMapRecord({
        ...replacement,
        id: previous.id,
        name: replacement.name || previous.name,
        note: replacement.note ?? previous.note,
        createdAt: previous.createdAt,
        updatedAt: now(),
        autoBackup: previous.autoBackup,
      });
      draft.records[index] = saved;
    });
    return saved;
  }

  function updateRecordMetadata(id, changes) {
    let saved;
    mutateLibrary(draft => {
      const record = draft.records.find(item => item.id === id);
      if (!record) throw new Error("找不到地图记录");
      record.name = clampText(changes.name, 80) || record.name;
      record.note = clampText(changes.note, 500);
      record.updatedAt = now();
      saved = cloneJSON(record);
    });
    return saved;
  }

  function deleteRecord(id) {
    let removed = null;
    mutateLibrary(draft => {
      const index = draft.records.findIndex(record => record.id === id);
      if (index < 0) throw new Error("找不到地图记录");
      removed = draft.records.splice(index, 1)[0];
    });
    return removed;
  }

  function pruneAutoBackups(draft) {
    const backups = draft.records
      .filter(record => record.autoBackup)
      .sort((a, b) => b.createdAt - a.createdAt);
    const removeIds = new Set(backups.slice(MAX_AUTO_BACKUPS).map(record => record.id));
    if (removeIds.size) draft.records = draft.records.filter(record => !removeIds.has(record.id));
  }

  function addAutoBackup(record) {
    const normalized = normalizeMapRecord({ ...record, autoBackup: true });
    mutateLibrary(draft => {
      if (draft.records.length >= MAX_RECORDS) {
        const oldestBackupIndex = draft.records
          .map((item, index) => ({ item, index }))
          .filter(entry => entry.item.autoBackup)
          .sort((a, b) => a.item.createdAt - b.item.createdAt)[0]?.index;
        if (oldestBackupIndex == null) throw new Error(`地图库最多保存 ${MAX_RECORDS} 张地图`);
        draft.records.splice(oldestBackupIndex, 1);
      }
      draft.records.push(normalized);
      pruneAutoBackups(draft);
    });
    return normalized;
  }

  function findRecord(id) {
    return library.records.find(record => record.id === id) || null;
  }



  function createMapFileDocument(record) {
    return {
      format: MAP_FILE_FORMAT,
      version: FILE_FORMAT_VERSION,
      exportedAt: now(),
      map: normalizeMapRecord(record),
    };
  }

  function createLibraryFileDocument(sourceLibrary = library) {
    return {
      format: LIBRARY_FILE_FORMAT,
      version: FILE_FORMAT_VERSION,
      exportedAt: now(),
      library: normalizeLibrary(sourceLibrary),
    };
  }

  function serializeFileDocument(documentValue) {
    return JSON.stringify(documentValue, null, 2);
  }

  function parseImportDocument(text, filename = "") {
    if (typeof text !== "string" || !text.trim()) throw new Error("导入文件为空");
    if (utf8Bytes(text) > MAX_IMPORT_FILE_BYTES) throw new Error("导入文件超过大小限制");

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      const payload = text.trim();
      if (payload.startsWith("{") || payload.startsWith("[")) throw new Error("地图 JSON 文件已损坏，无法解析");
      if (payload.length > MAX_PAYLOAD_CHARS) throw new Error("地图负载超过大小限制");
      return {
        kind: "map",
        records: [createMapRecord(payload, { name: sanitizeFilenamePart(filename.replace(/\.[^.]+$/, "")) })],
        rawNativePayload: true,
      };
    }

    if (!isPlainObject(parsed) || Number(parsed.version) !== FILE_FORMAT_VERSION) throw new Error("不支持的地图文件版本");
    if (parsed.format === MAP_FILE_FORMAT) {
      return { kind: "map", records: [normalizeMapRecord(parsed.map)] };
    }
    if (parsed.format === LIBRARY_FILE_FORMAT) {
      return { kind: "library", records: normalizeLibrary(parsed.library).records };
    }
    throw new Error("无法识别的地图文件格式");
  }

  function uniqueImportedName(name, records) {
    const names = new Set(records.map(record => record.name));
    if (!names.has(name)) return name;
    let index = 2;
    while (names.has(`${name}（导入 ${index}）`)) index += 1;
    return `${name}（导入 ${index}）`;
  }

  function buildImportPlan(currentLibrary, incomingRecords, strategy) {
    const base = normalizeLibrary(currentLibrary);
    if (!Array.isArray(incomingRecords) || incomingRecords.length === 0) throw new Error("没有可导入的地图");
    const incoming = incomingRecords.map(record => normalizeMapRecord(record));
    if (!["keepBoth", "overwriteId", "overwriteName", "skip", "replaceAll"].includes(strategy)) throw new Error("未知的冲突处理方式");

    const result = strategy === "replaceAll" ? emptyLibrary() : cloneJSON(base);
    const stats = { added: 0, overwritten: 0, skipped: 0 };

    for (const imported of incoming) {
      const idIndex = result.records.findIndex(record => record.id === imported.id);
      const nameIndex = result.records.findIndex(record => record.name === imported.name);

      if (strategy === "skip" && (idIndex >= 0 || nameIndex >= 0)) {
        stats.skipped += 1;
        continue;
      }

      if (strategy === "overwriteId" && idIndex >= 0) {
        const target = result.records[idIndex];
        result.records[idIndex] = normalizeMapRecord({ ...imported, id: target.id, createdAt: target.createdAt, updatedAt: now() });
        stats.overwritten += 1;
        continue;
      }

      if (strategy === "overwriteName" && nameIndex >= 0) {
        const target = result.records[nameIndex];
        result.records[nameIndex] = normalizeMapRecord({ ...imported, id: target.id, name: target.name, createdAt: target.createdAt, updatedAt: now() });
        stats.overwritten += 1;
        continue;
      }

      const added = cloneJSON(imported);
      if (strategy === "keepBoth" || result.records.some(record => record.id === added.id)) added.id = uid();
      if (strategy === "keepBoth") added.name = uniqueImportedName(added.name, result.records);
      else if (result.records.some(record => record.id === added.id)) added.id = uid();
      result.records.push(normalizeMapRecord(added));
      stats.added += 1;
    }

    if (result.records.length > MAX_RECORDS) throw new Error(`导入后超过 ${MAX_RECORDS} 张地图的上限`);
    return { library: normalizeLibrary(result), stats };
  }

  function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportSingleRecord(record) {
    const filename = `${sanitizeFilenamePart(record.name)}-${fileTimestamp(record.updatedAt)}.bcmap.json`;
    downloadTextFile(filename, serializeFileDocument(createMapFileDocument(record)));
  }

  function exportWholeLibrary() {
    const filename = `BC地图仓库-${fileTimestamp(now())}.bcmapset.json`;
    downloadTextFile(filename, serializeFileDocument(createLibraryFileDocument(library)));
  }



  function isMapRoom() {
    const type = getChatRoomData()?.MapData?.Type;
    return type === "Always" || type === "Hybrid";
  }

  function isRoomAdmin() {
    return typeof globalThis.ChatRoomPlayerIsAdmin === "function" && ChatRoomPlayerIsAdmin() === true;
  }

  function assertRoomContextAction() {
    if (globalThis.CurrentScreen !== "ChatRoom") throw new Error("当前不在聊天室");
    if (!isMapRoom()) throw new Error("当前房间没有启用地图模式");
  }

  function assertRoomMapAction() {
    assertRoomContextAction();
    if (!isRoomAdmin()) throw new Error("只有当前房间管理员可以执行此操作");
  }

  function exportCurrentNativeMap() {
    assertRoomMapAction();
    const manager = getChatRoomMapManager();
    if (typeof manager?.Map?.exportString !== "function") throw new Error("当前 BC 版本缺少地图导出接口");
    const payload = manager.Map.exportString();
    if (typeof payload !== "string" || !payload) throw new Error("BC 无法导出当前地图");
    return payload;
  }

  function currentMapMetadata() {
    const room = getChatRoomData();
    return {
      sourceRoomName: clampText(room?.Name, 120),
      mapType: room?.MapData?.Type,
    };
  }

  function saveCurrentMapAsNew(name, note = "") {
    const payload = exportCurrentNativeMap();
    const record = createMapRecord(payload, { name, note, ...currentMapMetadata() });
    return addRecord(record);
  }

  function overwriteSavedMapFromCurrent(recordId) {
    const target = findRecord(recordId);
    if (!target) throw new Error("找不到要覆盖的地图");
    const payload = exportCurrentNativeMap();
    return overwriteRecord(recordId, { ...target, payload, ...currentMapMetadata() });
  }

  function createCurrentMapBackup(targetName) {
    const payload = exportCurrentNativeMap();
    const roomName = clampText(getChatRoomData()?.Name, 60) || "当前房间";
    return createMapRecord(payload, {
      name: `自动备份 · ${roomName} · ${localTimestamp(now())}`,
      note: `加载“${clampText(targetName, 80)}”前自动创建`,
      autoBackup: true,
      ...currentMapMetadata(),
    });
  }

  function applySavedMapToRoom(recordId) {
    assertRoomMapAction();
    const manager = getChatRoomMapManager();
    if (typeof manager?.Map?.importString !== "function") throw new Error("当前 BC 版本缺少地图导入接口");
    if (typeof globalThis.ChatRoomMapViewUpdateFlag !== "function") throw new Error("当前 BC 版本缺少地图同步接口");
    if (typeof globalThis.ChatRoomMapViewCalculatePerceptionMasks !== "function") throw new Error("当前 BC 版本缺少地图刷新接口");
    const record = findRecord(recordId);
    if (!record) throw new Error("找不到要加载的地图");

    const backup = createCurrentMapBackup(record.name);
    addAutoBackup(backup);

    let imported = false;
    try {
      imported = manager.Map.importString(record.payload) === true;
    } catch (error) {
      warn("BC 地图导入器抛出异常", error);
    }
    if (!imported) {
      try { deleteRecord(backup.id); } catch (cleanupError) { warn("清理未使用的自动备份失败", cleanupError); }
      throw new Error("地图负载无法由当前 BC 版本解析，当前房间没有被修改");
    }

    ChatRoomMapViewUpdateFlag();
    ChatRoomMapViewCalculatePerceptionMasks();
    if (typeof globalThis.ChatRoomSendLocal === "function") ChatRoomSendLocal(`地图存档“${record.name}”已载入，BC 将同步房间地图。`);
    return { record, backup };
  }

  // ===== 地图视图运行时读取（lexical 优先，兼容新版 BC 的 let/const 顶层声明） =====

  function getChatRoomMapViewTileLookup() {
    try {
      if (typeof ChatRoomMapViewTileLookup !== "undefined") return ChatRoomMapViewTileLookup;
    } catch (_) { /* fall through to legacy window property */ }
    return globalThis.ChatRoomMapViewTileLookup ?? null;
  }

  function getChatRoomMapViewObjectLookup() {
    try {
      if (typeof ChatRoomMapViewObjectLookup !== "undefined") return ChatRoomMapViewObjectLookup;
    } catch (_) { /* fall through to legacy window property */ }
    return globalThis.ChatRoomMapViewObjectLookup ?? null;
  }

  function getChatRoomMapViewSize() {
    try {
      if (typeof ChatRoomMapViewWidth !== "undefined" && typeof ChatRoomMapViewHeight !== "undefined") {
        if (Number.isInteger(ChatRoomMapViewWidth) && Number.isInteger(ChatRoomMapViewHeight)) return { width: ChatRoomMapViewWidth, height: ChatRoomMapViewHeight };
      }
    } catch (_) { /* fall through */ }
    const width = globalThis.ChatRoomMapViewWidth;
    const height = globalThis.ChatRoomMapViewHeight;
    if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) return { width, height };
    return { width: 40, height: 40 }; // 原版固定尺寸兑底
  }

  function getPlayerCharacter() {
    try {
      if (typeof Player !== "undefined" && Player) return Player;
    } catch (_) { /* fall through */ }
    return globalThis.Player ?? null;
  }

  function getChatRoomCharacterList() {
    try {
      if (typeof ChatRoomCharacter !== "undefined") return ChatRoomCharacter;
    } catch (_) { /* fall through */ }
    return globalThis.ChatRoomCharacter ?? [];
  }

  function getRoomCharacterList() {
    const result = [];
    const myNumber = currentMemberNumber();
    const player = getPlayerCharacter();
    if (player?.MapData?.Pos) result.push(player);
    const list = getChatRoomCharacterList();
    if (Array.isArray(list)) {
      for (const character of list) {
        if (!character?.MapData?.Pos) continue;
        if (Number(character.MemberNumber) === Number(myNumber)) continue; // 房间角色列表可能包含自己，去重
        result.push(character);
      }
    }
    return result;
  }

  function findRoomCharacter(memberNumber) {
    const target = Number(memberNumber);
    if (!Number.isInteger(target)) return null;
    if (target === currentMemberNumber()) return getPlayerCharacter();
    const list = getChatRoomCharacterList();
    if (!Array.isArray(list)) return null;
    return list.find(character => character?.MemberNumber === target) ?? null;
  }

  // ===== 静态可通行网格 =====
  // 判定策略：对每个格子模拟从 4 个方向进入（dir 语义与原版一致），任一方向可行即视为可站人。
  // 顺序照抄原版 ChatRoomMapViewPositionIsBlocked：对象优先，对象无 CanEnter 再看 Tile。

  const TILE_KIND_EMPTY = 0;
  const TILE_KIND_FLOOR = 1;
  const TILE_KIND_OUTDOOR = 2;
  const TILE_KIND_WALL = 3;
  const TILE_KIND_HALF_WALL = 4;
  const TILE_KIND_WATER = 5;
  const TILE_KIND_OTHER = 6;

  let mapGridCache = null; // { signature, snapshot }

  function isPositionWalkable(tile, obj) {
    if (obj && typeof obj.CanEnter === "function") {
      for (const dir of ["R", "L", "D", "U"]) if (obj.CanEnter(dir) === true) return true;
      return false;
    }
    if (tile && typeof tile.CanEnter === "function") {
      for (const dir of ["R", "L", "D", "U"]) if (tile.CanEnter(dir) === true) return true;
      return false;
    }
    return true;
  }

  function tileKindOf(tile) {
    if (!tile || typeof tile.Type !== "string") return TILE_KIND_EMPTY;
    if (tile.Type === "Wall") return TILE_KIND_WALL;
    if (tile.Type === "Water") return TILE_KIND_WATER;
    if (tile.Type === "FloorExterior") return TILE_KIND_OUTDOOR;
    if (tile.Type === "Floor") return tile.Style === "HalfWall" ? TILE_KIND_HALF_WALL : TILE_KIND_FLOOR;
    return TILE_KIND_OTHER;
  }

  function buildMapGridSnapshot() {
    const mapData = getChatRoomData()?.MapData;
    const tiles = mapData?.Tiles;
    const objects = mapData?.Objects;
    if (typeof tiles !== "string" || typeof objects !== "string") return null;
    const size = getChatRoomMapViewSize();
    const count = size.width * size.height;
    if (tiles.length !== count || objects.length !== count) return null;

    const signature = `${tiles}|${objects}`;
    if (mapGridCache && mapGridCache.signature === signature) return mapGridCache.snapshot;

    const tileLookup = getChatRoomMapViewTileLookup();
    const objectLookup = getChatRoomMapViewObjectLookup();
    const walkable = new Uint8Array(count);
    const tileKind = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const tile = tileLookup?.[tiles.charCodeAt(i)];
      const obj = objectLookup?.[objects.charCodeAt(i)];
      walkable[i] = isPositionWalkable(tile, obj) ? 1 : 0;
      tileKind[i] = tileKindOf(tile);
    }
    const snapshot = { width: size.width, height: size.height, tiles, objects, walkable, tileKind, revision: now() };
    mapGridCache = { signature, snapshot };
    return snapshot;
  }

  // ===== 玩家传送 =====
  // 首选调用原版 ChatRoomMapViewTeleport（R130+，目标玩家无需安装插件）：
  //   管理员 → Hidden 定向聊天消息 → 目标客户端 Player.Position setter → 正常同步链路广播。
  // 降级：手发与原版同构的 Hidden 消息（更旧版本接收端可能没有处理逻辑，UI 层需提示）。

  function getChatRoomMapViewTeleport() {
    try {
      if (typeof ChatRoomMapViewTeleport === "function") return ChatRoomMapViewTeleport;
    } catch (_) { /* fall through to legacy window property */ }
    return globalThis.ChatRoomMapViewTeleport ?? null;
  }

  function getChatRoomGetSettings() {
    try {
      if (typeof ChatRoomGetSettings === "function") return ChatRoomGetSettings;
    } catch (_) { /* fall through to legacy window property */ }
    return globalThis.ChatRoomGetSettings ?? null;
  }

  // 触发房间属性同步：服务器对无变化的 ChatRoomAdmin Update 可能去重，因此先让
  // 房间迷雾产生一次真实变化（必然广播 ChatRoomSyncRoomProperties），再立即恢复原状
  // （再次广播）。各客户端在 ChatRoomSyncRoomProperties 处理流程中调用
  // ChatRoomMapViewInitializeCharacter(Player)，该函数无条件广播自己的当前 MapData。
  // 传送消息先于本调用发出（同一 socket FIFO 保证顺序），目标客户端执行初始化时
  // MapData 已是新位置，从而在目标处于任何视图时都立即向全房间同步新位置。
  // 两次广播的迷雾中间态持续约一个 RTT，最终房间状态完全恢复。
  function triggerRoomPropertiesSync() {
    const serverSend = getServerSend();
    const getSettings = getChatRoomGetSettings();
    const player = getPlayerCharacter();
    const room = getChatRoomData();
    if (!serverSend || !getSettings || !player || !room?.MapData) return;
    const mapData = room.MapData;
    const fogWasEnabled = mapData.Fog !== false;
    const applyFog = enabled => {
      if (enabled) delete mapData.Fog;
      else mapData.Fog = false;
    };
    const sendUpdate = () => {
      serverSend("ChatRoomAdmin", {
        MemberNumber: Number(player.ID) || Number(player.MemberNumber),
        Room: getSettings(room),
        Action: "Update",
      });
    };
    try {
      applyFog(!fogWasEnabled); // 第一次：真实变化，服务器必然广播
      sendUpdate();
      applyFog(fogWasEnabled); // 恢复原状
      sendUpdate();
    } catch (error) {
      warn("触发房间属性同步失败", error);
      applyFog(fogWasEnabled);
    }
  }

  function getServerSend() {
    try {
      if (typeof ServerSend === "function") return ServerSend;
    } catch (_) { /* fall through to legacy window property */ }
    return globalThis.ServerSend ?? null;
  }

  function createTeleportMessage(memberNumber, x, y) {
    return {
      Content: "ChatRoomMapViewTeleport",
      Type: "Hidden",
      Dictionary: [{ Tag: "MapViewTeleport", Position: { X: Number(x), Y: Number(y) } }],
      Target: Number(memberNumber),
    };
  }

  // 静态可达性（BFS）：从 (sx, sy) 出发，只经过可通行格，能否走到 (tx, ty)。
  // 用于非管理员传送限制：封闭空间无法抵达。
  function isPositionReachable(grid, sx, sy, tx, ty) {
    if (!grid || grid.width <= 0 || grid.height <= 0) return false;
    if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return false;
    if (sx === tx && sy === ty) return true;
    const w = grid.width;
    const h = grid.height;
    const walkable = grid.walkable;
    const visited = new Uint8Array(w * h);
    const queue = new Int32Array(w * h * 2);
    let head = 0;
    let tail = 0;
    const push = (x, y) => {
      const i = y * w + x;
      if (visited[i]) return;
      visited[i] = 1;
      queue[tail++] = x;
      queue[tail++] = y;
    };
    push(sx, sy);
    while (head < tail) {
      const x = queue[head++];
      const y = queue[head++];
      if (x === tx && y === ty) return true;
      if (y > 0 && walkable[(y - 1) * w + x] === 1) push(x, y - 1);
      if (y + 1 < h && walkable[(y + 1) * w + x] === 1) push(x, y + 1);
      if (x > 0 && walkable[y * w + x - 1] === 1) push(x - 1, y);
      if (x + 1 < w && walkable[y * w + x + 1] === 1) push(x + 1, y);
    }
    return false;
  }

  function teleportCharacter(memberNumber, x, y) {
    const admin = isRoomAdmin();
    const self = Number(memberNumber) === currentMemberNumber();
    if (admin) {
      assertRoomMapAction();
    } else {
      if (!self) throw new Error("只有管理员才能传送其他玩家");
      assertRoomContextAction();
    }
    const size = getChatRoomMapViewSize();
    const tx = Number(x);
    const ty = Number(y);
    if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || ty < 0 || tx >= size.width || ty >= size.height) {
      throw new Error("传送目标超出地图范围");
    }
    const target = findRoomCharacter(memberNumber);
    if (!target) throw new Error("找不到目标玩家");
    const position = { X: tx, Y: ty };

    if (!admin) {
      // 非管理员：只能传送自己，落点必须是正常行走可抵达的位置（封闭空间不可达）
      const grid = buildMapGridSnapshot();
      const start = target.MapData?.Pos;
      if (!grid || !start) throw new Error("无法获取当前位置");
      if (!isPositionReachable(grid, start.X, start.Y, tx, ty)) throw new Error("该位置无法通过正常行走抵达");
      if (target.Position) target.Position = position;
      return "local";
    }

    const nativeTeleport = getChatRoomMapViewTeleport();
    if (nativeTeleport) {
      nativeTeleport(target, position);
      triggerRoomPropertiesSync();
      return "native";
    }
    const serverSend = getServerSend();
    if (!serverSend) throw new Error("当前环境缺少 ServerSend，无法传送");
    const player = getPlayerCharacter();
    if (target === player && target.Position) target.Position = position; // 对齐原版“传自己本地立即生效”语义
    serverSend("ChatRoomChat", createTeleportMessage(memberNumber, tx, ty));
    triggerRoomPropertiesSync();
    return "fallback";
  }

  // ===== 坐标隐藏（捉迷藏） =====
  // 插件层面隐藏：本地 Player.MapData 挂 BMSHidden 标记字段，随正常位置广播流转。
  // 接收端验证器对未知字段原样保留，原版渲染只读 Pos/PrivateState，游戏协议零干预。
  // 接收端仅在插件侧维护 character.BMSHidden，不改动 char.MapData。

  const STEALTH_STORAGE_PREFIX = "BC.MapSaver.stealth";

  function stealthStorageKey() {
    const member = currentMemberNumber();
    return `${STEALTH_STORAGE_PREFIX}:${Number.isInteger(member) ? member : "anonymous"}`;
  }

  function isStealthEnabled() {
    try {
      return localStorage.getItem(stealthStorageKey()) === "1";
    } catch (error) {
      warn("读取坐标隐藏状态失败", error);
      return false;
    }
  }

  // 切换隐藏状态：只增删本地 MapData 上的标记字段，随后立即广播一次让所有插件端感知。
  // 之后玩家正常移动，广播自然携带/摘除该字段，无需任何网络拦截。
  function setStealthEnabled(enabled) {
    const player = getPlayerCharacter();
    if (!player?.MapData) return false;
    const on = Boolean(enabled);
    if (on) player.MapData.BMSHidden = true;
    else delete player.MapData.BMSHidden;
    try {
      localStorage.setItem(stealthStorageKey(), on ? "1" : "0");
    } catch (error) {
      warn("保存坐标隐藏状态失败", error);
    }
    const serverSend = getServerSend();
    if (typeof serverSend === "function") {
      try {
        serverSend("ChatRoomCharacterMapDataUpdate", player.MapData);
      } catch (error) {
        warn("广播坐标隐藏状态失败", error);
      }
    }
    return true;
  }

  // 插件视角下该玩家是否隐藏：自己永远可见；他人看 BMSHidden 标记。
  function isCharacterHidden(character) {
    if (!character) return false;
    if (Number(character.MemberNumber) === currentMemberNumber()) return false;
    return character.BMSHidden === true;
  }

  function applyStealthMarker(character, mapData) {
    if (!character) return;
    if (mapData?.BMSHidden === true) character.BMSHidden = true;
    else delete character.BMSHidden;
  }

  // 接收端：跟随每次 MapData 同步识别隐藏标记，仅维护插件侧状态。
  // 注意消息结构差异：实时位置更新（ChatRoomSyncMapData）是平铺的 {MemberNumber, MapData}；
  // 进房/重同步/成员加入（ChatRoomSyncCharacter/SyncSingle/MemberJoin）是嵌套的 {Character: {...}}，
  // 且角色对象会被 CharacterLoadOnline 重建，必须每次同步都重新评估标记。
  function applyStealthFromCharacterData(characterData) {
    if (!characterData || typeof characterData !== "object") return;
    const character = findRoomCharacter(characterData.MemberNumber);
    if (!character || character === getPlayerCharacter()) return;
    applyStealthMarker(character, characterData.MapData);
  }

  function installStealthHooks() {
    if (typeof globalThis.ChatRoomMapViewSyncMapData === "function") {
      modApi.hookFunction("ChatRoomMapViewSyncMapData", 0, (args, next) => {
        const result = next(args);
        try {
          const data = args[0];
          if (data && Number.isInteger(data?.MemberNumber)) {
            const character = findRoomCharacter(data.MemberNumber);
            if (character && character !== getPlayerCharacter()) applyStealthMarker(character, data.MapData);
          }
        } catch (error) {
          warn("同步坐标隐藏标记失败", error);
        }
        return result;
      });
    }
    for (const name of ["ChatRoomSyncCharacter", "ChatRoomSyncSingle", "ChatRoomSyncMemberJoin"]) {
      if (typeof globalThis[name] !== "function") continue;
      modApi.hookFunction(name, 0, (args, next) => {
        const result = next(args);
        try {
          applyStealthFromCharacterData(args[0]?.Character);
        } catch (error) {
          warn(`同步坐标隐藏标记失败（${name}）`, error);
        }
        return result;
      });
    }
    // 发送端兜底：有新成员加入房间时，隐藏玩家主动重广播一次带标记的 MapData，
    // 确保新玩家在初始角色同步（服务器下发的数据可能被净化）后尽快恢复隐藏识别。
    if (typeof globalThis.ChatRoomSyncMemberJoin === "function") {
      modApi.hookFunction("ChatRoomSyncMemberJoin", 1000, (args, next) => {
        const result = next(args);
        try {
          if (!isStealthEnabled()) return result;
          const player = getPlayerCharacter();
          if (!player?.MapData) return result;
          const serverSend = getServerSend();
          if (typeof serverSend !== "function") return result;
          setTimeout(() => {
            try {
              serverSend("ChatRoomCharacterMapDataUpdate", player.MapData);
            } catch (error) {
              warn("进房后重广播隐藏标记失败", error);
            }
          }, 400);
        } catch (error) {
          warn("进房重广播隐藏标记失败", error);
        }
        return result;
      });
    }
  }




  // ===== 简化房间地图（第二功能模块） =====
  // 大号操作面板：左侧房间成员列表，右侧色块渲染全图（可通行/墙壁/障碍）。
  // 管理员可选中玩家并传送到任意格子。视口变换：滚轮缩放（鼠标锚点）+ 拖拽平移。
  // 坐标换算按 canvas 内部像素 / CSS 像素比例进行，免疫全局样式或浏览器缩放造成的尺寸不一致。

  const MINIMAP_ID = "bms-minimap";
  const MINIMAP_ENTRY_BUTTON = Object.freeze({
    x: ENTRY_BUTTON.x,
    y: ENTRY_BUTTON.y + ENTRY_BUTTON.height + 10,
    width: ENTRY_BUTTON.width,
    height: ENTRY_BUTTON.height,
  });
  const MINIMAP_CANVAS_SIZE = 520;
  const MINIMAP_PANEL_WIDTH = 778;
  const MINIMAP_SIDE_WIDTH = 222;
  const MINIMAP_TILE = 12;
  const MINIMAP_GAP = 1;
  const MINIMAP_ZOOM_MIN = 0.5;
  const MINIMAP_ZOOM_MAX = 8;
  const MINIMAP_TICK_MS = 250;
  const MINIMAP_DRAG_THRESHOLD = 4;
  const MINIMAP_VERIFY_DELAY_MS = 2500;
  const MINIMAP_SWAP_STEP_DELAY_MS = 1200; // 交换两步之间的间隔：等第一步传送与广播完成，避免消息乱序覆盖
  const MINIMAP_PLAYER_COLORS = ["#e8a0c0", "#8fd0ff", "#a8d68f", "#ffd08f", "#d0a8ff", "#ff9d9d", "#9df0e0", "#f0e0a0"];
  const MINIMAP_TILE_COLORS = {
    [TILE_KIND_EMPTY]: "#232a36",
    [TILE_KIND_FLOOR]: "#b8a48c",
    [TILE_KIND_OUTDOOR]: "#a3b98d",
    [TILE_KIND_WALL]: "#6a5d52",
    [TILE_KIND_HALF_WALL]: "#96826e",
    [TILE_KIND_WATER]: "#7cb3d4",
    [TILE_KIND_OTHER]: "#8a8f98",
  };

  let minimapOpen = false;
  let minimapGrid = null;
  let minimapView = { zoom: 1, panX: 0, panY: 0 };
  let minimapDrag = null;
  let minimapPanelDrag = null;
  let minimapHover = null;
  let minimapSelected = null;
  let minimapPending = null;
  let minimapPlayerSig = "";
  let minimapDirty = true;
  let minimapBgCanvas = null;
  let minimapSwapInProgress = false;

  function injectMinimapStyle() {
    if (document.getElementById("bms-minimap-style")) return;
    const style = document.createElement("style");
    style.id = "bms-minimap-style";
    style.textContent = `
      #${MINIMAP_ID}{position:fixed;left:50%;top:36px;z-index:99990;width:${MINIMAP_PANEL_WIDTH}px;background:#111d31;border:1px solid #45678f;border-radius:12px;box-shadow:0 18px 52px rgba(0,0,0,.6);font-family:Inter,"Microsoft YaHei",sans-serif;color:#eaf2ff;user-select:none;overflow:hidden}
      #${MINIMAP_ID} *{box-sizing:border-box}
      #${MINIMAP_ID} header{display:flex;align-items:center;gap:8px;padding:9px 12px;background:linear-gradient(135deg,#1b3151,#17243b);border-bottom:1px solid #385576;cursor:move;touch-action:none}
      #${MINIMAP_ID} .bms-mm-title{font-size:15px;font-weight:750;letter-spacing:.03em}
      #${MINIMAP_ID} .bms-mm-room{font-size:12px;color:#9eb4ce;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${MINIMAP_ID} .bms-mm-spacer{flex:1}
      #${MINIMAP_ID} header button{appearance:none;width:28px;height:28px;border:1px solid #4b6e98;border-radius:7px;background:#203858;color:#f2f7ff;font-size:15px;line-height:1;cursor:pointer;flex:none}
      #${MINIMAP_ID} header button:hover{background:#2b4a72;border-color:#78a5d8}
      #${MINIMAP_ID} .bms-mm-body{display:grid!important;grid-template-columns:${MINIMAP_SIDE_WIDTH}px ${MINIMAP_CANVAS_SIZE}px;grid-template-rows:${MINIMAP_CANVAS_SIZE}px;align-items:stretch;gap:12px;padding:10px 12px}
      #${MINIMAP_ID} canvas{position:relative!important;inset:auto!important;display:block!important;float:none!important;transform:none!important;margin:0!important;width:${MINIMAP_CANVAS_SIZE}px!important;height:${MINIMAP_CANVAS_SIZE}px!important;min-width:0;grid-column:2;grid-row:1;background:#0b1220;border:1px solid #2c425d;border-radius:6px;cursor:grab;touch-action:none}
      #${MINIMAP_ID} canvas.bms-mm-dragging{cursor:grabbing}
      #${MINIMAP_ID} .bms-mm-side{position:relative!important;inset:auto!important;float:none!important;transform:none!important;margin:0!important;width:${MINIMAP_SIDE_WIDTH}px!important;min-width:0;grid-column:1;grid-row:1;display:flex!important;flex-direction:column;border:1px solid #2c425d;border-radius:6px;background:#0f1a2c;overflow:hidden}
      #${MINIMAP_ID} .bms-mm-side-title{padding:8px 10px;font-size:12px;font-weight:700;color:#9eb4ce;border-bottom:1px solid #2c425d;background:#152238}
      #${MINIMAP_ID} .bms-mm-roster{list-style:none;margin:0;padding:6px;flex:1;overflow-y:auto;min-height:0}
      #${MINIMAP_ID} .bms-mm-roster.bms-mm-locked{pointer-events:none;opacity:.68}
      #${MINIMAP_ID} .bms-mm-roster li{display:flex;gap:8px;align-items:center;padding:7px 9px;border-radius:7px;cursor:pointer;font-size:13px;border:1px solid transparent}
      #${MINIMAP_ID} .bms-mm-roster li:hover{background:#1c3250}
      #${MINIMAP_ID} .bms-mm-roster li.bms-mm-selected{background:#2b4a72;border-color:#78a5d8}
      #${MINIMAP_ID} .bms-mm-dot{width:10px;height:10px;border-radius:50%;flex:none}
      #${MINIMAP_ID} .bms-mm-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${MINIMAP_ID} .bms-mm-pos{font-size:12px;color:#8fb3d8;font-family:Consolas,monospace}
      #${MINIMAP_ID} .bms-mm-me{font-size:11px;color:#ffd94d;border:1px solid #806a41;border-radius:999px;padding:0 6px}
      #${MINIMAP_ID} .bms-mm-hidden{font-size:11px;color:#ff9d9d;border:1px solid #7a4a26;border-radius:999px;padding:0 6px;flex:none}
      #${MINIMAP_ID} .bms-mm-stealth{display:flex;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid #2c425d;font-size:12px;color:#9eb4ce;cursor:pointer;user-select:none;flex:none}
      #${MINIMAP_ID} .bms-mm-stealth input{display:none}
      #${MINIMAP_ID} .bms-mm-slider{position:relative;width:36px;height:19px;border-radius:999px;background:#2a3d57;border:1px solid #45678f;transition:background .15s;flex:none}
      #${MINIMAP_ID} .bms-mm-slider::after{content:"";position:absolute;left:2px;top:2px;width:13px;height:13px;border-radius:50%;background:#b9cde6;transition:transform .15s}
      #${MINIMAP_ID} .bms-mm-stealth input:checked + .bms-mm-slider{background:#7a4a26;border-color:#c98a4a}
      #${MINIMAP_ID} .bms-mm-stealth input:checked + .bms-mm-slider::after{transform:translateX(17px);background:#ffd94d}
      #${MINIMAP_ID} .bms-mm-stealth-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${MINIMAP_ID} .bms-mm-stealth input:checked ~ .bms-mm-stealth-label{color:#ffc981}
      #${MINIMAP_ID} footer{padding:0 12px 12px;min-height:50px}
      .bms-mm-status{font-size:12px;color:#a8bdd5;line-height:1.7}
      .bms-mm-status strong{color:#8fd0ff}
      .bms-mm-status .bms-mm-warn{color:#ffc981}
      .bms-mm-status .bms-mm-bad{color:#ff9d9d}
      .bms-mm-actions{display:flex;gap:6px;margin-top:5px}
      .bms-mm-actions button{appearance:none;border:1px solid #4b6e98;border-radius:7px;background:#203858;color:#f2f7ff;padding:6px 14px;font-size:13px;cursor:pointer}
      .bms-mm-actions button.bms-mm-confirm{background:#2966a3;border-color:#4d94d5}
      .bms-mm-actions button.bms-mm-confirm-warn{background:#7a4a26;border-color:#c98a4a}
    `;
    document.head.appendChild(style);
  }

  function shouldShowMinimap() {
    return globalThis.CurrentScreen === "ChatRoom"
      && isMapRoom()
      && typeof globalThis.ChatRoomMapViewIsActive === "function"
      && ChatRoomMapViewIsActive();
  }

  function shouldDrawMinimapEntryButton() {
    return shouldShowMinimap() && globalThis.ChatRoomMapViewEditMode === "";
  }

  function minimapTileStep() { return MINIMAP_TILE + MINIMAP_GAP; }

  function minimapGridPixelSize(grid) {
    return grid.width * MINIMAP_TILE + (grid.width - 1) * MINIMAP_GAP;
  }

  function ensureMinimapRoot() {
    let root = document.getElementById(MINIMAP_ID);
    if (root) return root;
    root = document.createElement("section");
    root.id = MINIMAP_ID;
    root.innerHTML = `
      <header>
        <span class="bms-mm-title">简化房间地图</span>
        <span class="bms-mm-room"></span>
        <span class="bms-mm-spacer"></span>
        <button data-mm="zoomOut" title="缩小">−</button>
        <button data-mm="zoomIn" title="放大">＋</button>
        <button data-mm="close" title="关闭">×</button>
      </header>
      <div class="bms-mm-body">
        <aside class="bms-mm-side">
          <div class="bms-mm-side-title">房间成员</div>
          <ul class="bms-mm-roster"></ul>
          <label class="bms-mm-stealth" title="隐藏坐标：开启后其它插件用户的小地图不再显示你的坐标与标记，游戏内位置不受影响">
            <input type="checkbox" data-mm-stealth>
            <span class="bms-mm-slider"></span>
            <span class="bms-mm-stealth-label">隐藏坐标</span>
          </label>
        </aside>
        <canvas width="${MINIMAP_CANVAS_SIZE}" height="${MINIMAP_CANVAS_SIZE}"></canvas>
      </div>
      <footer class="bms-mm-status"></footer>`;
    root.style.left = `${Math.max(8, Math.floor((window.innerWidth - MINIMAP_PANEL_WIDTH) / 2))}px`;
    root.style.top = "36px";
    document.body.appendChild(root);

    // 标题栏拖动面板
    root.querySelector("header").addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      if (event.target.closest?.("button")) return; // 标题栏按钮不触发拖动
      minimapPanelDrag = { startX: event.clientX, startY: event.clientY, left: root.offsetLeft, top: root.offsetTop };
      root.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    root.addEventListener("pointermove", event => {
      if (!minimapPanelDrag) return;
      root.style.left = `${Math.max(0, minimapPanelDrag.left + event.clientX - minimapPanelDrag.startX)}px`;
      root.style.top = `${Math.max(0, minimapPanelDrag.top + event.clientY - minimapPanelDrag.startY)}px`;
    });
    root.addEventListener("pointerup", () => { minimapPanelDrag = null; });
    root.addEventListener("pointercancel", () => { minimapPanelDrag = null; });

    const canvas = root.querySelector("canvas");
    canvas.addEventListener("wheel", minimapHandleWheel, { passive: false });
    canvas.addEventListener("pointerdown", minimapHandlePointerDown);
    canvas.addEventListener("pointermove", minimapHandlePointerMove);
    canvas.addEventListener("pointerup", minimapHandlePointerUp);
    canvas.addEventListener("pointercancel", minimapHandlePointerUp);
    canvas.addEventListener("pointerleave", () => { minimapHover = null; drawMinimap(); });
    canvas.addEventListener("contextmenu", event => event.preventDefault());

    root.querySelector("header").addEventListener("click", event => {
      const action = event.target.closest?.("[data-mm]")?.dataset.mm;
      if (action === "zoomIn") minimapZoomAt(MINIMAP_CANVAS_SIZE / 2, MINIMAP_CANVAS_SIZE / 2, 1.25);
      else if (action === "zoomOut") minimapZoomAt(MINIMAP_CANVAS_SIZE / 2, MINIMAP_CANVAS_SIZE / 2, 1 / 1.25);
      else if (action === "close") closeMinimap();
    });

    root.querySelector(".bms-mm-roster").addEventListener("click", event => {
      const item = event.target.closest?.("[data-member]");
      if (!item) return;
      minimapHandleRosterClick(Number(item.dataset.member));
    });
    root.querySelector("[data-mm-stealth]").addEventListener("change", event => {
      const on = event.target.checked === true;
      if (!setStealthEnabled(on)) {
        event.target.checked = !on;
        return;
      }
      syncStealthToggle();
      toast(on ? "已开启隐藏坐标：其他插件用户的小地图将不再显示你" : "已关闭隐藏坐标：小地图恢复显示你", on ? "success" : "info");
    });
    return root;
  }

  function syncStealthToggle() {
    const root = document.getElementById(MINIMAP_ID);
    const toggle = root?.querySelector("[data-mm-stealth]");
    if (!toggle) return;
    toggle.checked = isStealthEnabled();
  }

  function fitMinimapView() {
    if (!minimapGrid) return;
    const size = minimapGridPixelSize(minimapGrid);
    const zoom = (MINIMAP_CANVAS_SIZE / size) * 0.96;
    minimapView = {
      zoom: Math.max(MINIMAP_ZOOM_MIN, Math.min(MINIMAP_ZOOM_MAX, zoom)),
      panX: (MINIMAP_CANVAS_SIZE - size * zoom) / 2,
      panY: (MINIMAP_CANVAS_SIZE - size * zoom) / 2,
    };
  }

  function minimapZoomAt(mx, my, factor) {
    const next = Math.max(MINIMAP_ZOOM_MIN, Math.min(MINIMAP_ZOOM_MAX, minimapView.zoom * factor));
    const ratio = next / minimapView.zoom;
    minimapView.panX = mx - (mx - minimapView.panX) * ratio;
    minimapView.panY = my - (my - minimapView.panY) * ratio;
    minimapView.zoom = next;
    drawMinimap();
  }

  // 事件坐标 → canvas 内部像素坐标（比例换算，免疫 CSS 尺寸与属性尺寸不一致）
  function minimapEventToCanvasXY(canvas, rect, clientX, clientY) {
    const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
    const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function minimapCanvasToGridXY(mx, my, view, grid) {
    if (!grid) return null;
    const gx = Math.floor((mx - view.panX) / view.zoom / minimapTileStep());
    const gy = Math.floor((my - view.panY) / view.zoom / minimapTileStep());
    if (gx < 0 || gy < 0 || gx >= grid.width || gy >= grid.height) return null;
    return { x: gx, y: gy };
  }

  function minimapCanvasToGrid(mx, my) {
    return minimapCanvasToGridXY(mx, my, minimapView, minimapGrid);
  }

  function minimapGridToCanvas(x, y) {
    return {
      x: x * minimapTileStep() * minimapView.zoom + minimapView.panX,
      y: y * minimapTileStep() * minimapView.zoom + minimapView.panY,
    };
  }

  function rebuildMinimapBackground() {
    if (!minimapGrid) return;
    const size = minimapGridPixelSize(minimapGrid);
    minimapBgCanvas = document.createElement("canvas");
    minimapBgCanvas.width = size;
    minimapBgCanvas.height = size;
    const ctx = minimapBgCanvas.getContext("2d");
    const step = minimapTileStep();
    for (let y = 0; y < minimapGrid.height; y++) {
      for (let x = 0; x < minimapGrid.width; x++) {
        const index = y * minimapGrid.width + x;
        ctx.fillStyle = MINIMAP_TILE_COLORS[minimapGrid.tileKind[index]] ?? MINIMAP_TILE_COLORS[TILE_KIND_EMPTY];
        ctx.fillRect(x * step, y * step, MINIMAP_TILE, MINIMAP_TILE);
        if (minimapGrid.walkable[index] !== 1) {
          ctx.fillStyle = "rgba(0,0,0,0.45)";
          ctx.fillRect(x * step, y * step, MINIMAP_TILE, MINIMAP_TILE);
        }
      }
    }
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= minimapGrid.width; x++) {
      ctx.beginPath();
      ctx.moveTo(x * step - 0.5, 0);
      ctx.lineTo(x * step - 0.5, size);
      ctx.stroke();
    }
    for (let y = 0; y <= minimapGrid.height; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * step - 0.5);
      ctx.lineTo(size, y * step - 0.5);
      ctx.stroke();
    }
  }

  function playerPositionSignature() {
    const list = getRoomCharacterList();
    return list
      .filter(c => !isCharacterHidden(c))
      .map(c => `${c.MemberNumber}:${c.MapData.Pos.X},${c.MapData.Pos.Y}`).sort().join("|");
  }

  function findRoomCharacterAt(gx, gy) {
    const list = getRoomCharacterList();
    return list.find(c => !isCharacterHidden(c) && c.MapData?.Pos?.X === gx && c.MapData?.Pos?.Y === gy) ?? null;
  }

  function minimapPlayerColor(character) {
    const color = character?.LabelColor;
    if (typeof color === "string" && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color)) return color;
    return MINIMAP_PLAYER_COLORS[Math.abs(Number(character?.MemberNumber) || 0) % MINIMAP_PLAYER_COLORS.length];
  }

  function drawMinimap() {
    const root = document.getElementById(MINIMAP_ID);
    if (!root || !minimapGrid) return;
    const canvas = root.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, MINIMAP_CANVAS_SIZE, MINIMAP_CANVAS_SIZE);
    if (minimapBgCanvas) ctx.drawImage(minimapBgCanvas, minimapView.panX, minimapView.panY, minimapBgCanvas.width * minimapView.zoom, minimapBgCanvas.height * minimapView.zoom);

    const step = minimapTileStep() * minimapView.zoom;

    // Hover 高亮
    if (minimapHover) {
      const p = minimapGridToCanvas(minimapHover.x, minimapHover.y);
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fillRect(p.x, p.y, step, step);
    }

    // 待确认传送目标
    if (minimapPending) {
      const p = minimapGridToCanvas(minimapPending.x, minimapPending.y);
      const isSwap = minimapPending.swapWith != null;
      ctx.fillStyle = isSwap ? "rgba(255,217,77,0.28)" : (minimapPending.walkable ? "rgba(60,180,90,0.30)" : "rgba(255,110,110,0.32)");
      ctx.fillRect(p.x, p.y, step, step);
      ctx.strokeStyle = isSwap ? "#ffd94d" : (minimapPending.walkable ? "#3cb45a" : "#ff6e6e");
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x + 1, p.y + 1, step - 2, step - 2);
    }

    // 选中玩家 → hover 目标连线
    const selected = minimapSelected != null ? findRoomCharacter(minimapSelected) : null;
    if (selected?.MapData?.Pos && minimapHover) {
      const from = minimapGridToCanvas(selected.MapData.Pos.X, selected.MapData.Pos.Y);
      const to = minimapGridToCanvas(minimapHover.x, minimapHover.y);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(from.x + step / 2, from.y + step / 2);
      ctx.lineTo(to.x + step / 2, to.y + step / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 玩家点
    const list = getRoomCharacterList();
    const myNumber = currentMemberNumber();
    for (const character of list) {
      if (isCharacterHidden(character)) continue;
      const pos = character.MapData?.Pos;
      if (!pos) continue;
      const p = minimapGridToCanvas(pos.X, pos.Y);
      const radius = Math.max(3, Math.min(8, MINIMAP_TILE * minimapView.zoom * 0.34));
      const isMe = character.MemberNumber === myNumber;
      const isSelected = minimapSelected === character.MemberNumber;
      ctx.beginPath();
      ctx.arc(p.x + step / 2, p.y + step / 2, radius, 0, Math.PI * 2);
      ctx.fillStyle = isMe ? "#f5f9ff" : minimapPlayerColor(character);
      ctx.fill();
      ctx.lineWidth = isSelected ? 3 : 1.4;
      ctx.strokeStyle = isSelected ? "#ffd94d" : isMe ? "#4d94d5" : "rgba(10,15,25,0.85)";
      ctx.stroke();
      // 自己头顶标记
      if (isMe) {
        ctx.beginPath();
        ctx.arc(p.x + step / 2, p.y + step / 2 - radius - 3, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#8fd0ff";
        ctx.fill();
      }
      // hover 名字
      if (minimapHover && pos.X === minimapHover.x && pos.Y === minimapHover.y) {
        const name = character.Name ? String(character.Name) : `#${character.MemberNumber}`;
        ctx.font = "12px Inter, 'Microsoft YaHei', sans-serif";
        const width = ctx.measureText(name).width + 12;
        const bx = Math.max(0, Math.min(MINIMAP_CANVAS_SIZE - width, p.x + step / 2 - width / 2));
        const by = Math.max(0, p.y + step / 2 - radius - 22);
        ctx.fillStyle = "rgba(10,16,28,0.88)";
        ctx.fillRect(bx, by, width, 18);
        ctx.strokeStyle = "rgba(120,160,210,0.6)";
        ctx.strokeRect(bx, by, width, 18);
        ctx.fillStyle = isMe ? "#8fd0ff" : "#eaf2ff";
        ctx.fillText(name, bx + 6, by + 14);
      }
    }
  }

  function renderMinimapRoster() {
    const root = document.getElementById(MINIMAP_ID);
    if (!root) return;
    const listEl = root.querySelector(".bms-mm-roster");
    if (!listEl) return;
    const myNumber = currentMemberNumber();
    const list = getRoomCharacterList().slice().sort((a, b) => {
      if (a.MemberNumber === myNumber) return -1;
      if (b.MemberNumber === myNumber) return 1;
      return Number(a.MemberNumber) - Number(b.MemberNumber);
    });
    const admin = isRoomAdmin();
    listEl.classList.toggle("bms-mm-locked", minimapSwapInProgress);
    listEl.innerHTML = list.map(character => {
      const pos = character.MapData?.Pos;
      const isMe = character.MemberNumber === myNumber;
      const isSelected = minimapSelected === character.MemberNumber;
      const name = character.Name ? String(character.Name) : `#${character.MemberNumber}`;
      const hidden = !isMe && isCharacterHidden(character);
      return `<li data-member="${character.MemberNumber}" class="${isSelected ? "bms-mm-selected" : ""}${hidden ? " bms-mm-hidden-item" : ""}" title="${hidden ? "该玩家已隐藏坐标" : (admin ? "点击选中后传送" : "")}">
        <span class="bms-mm-dot" style="background:${isMe ? "#f5f9ff" : minimapPlayerColor(character)}"></span>
        <span class="bms-mm-name">${escapeHTML(name)}</span>
        ${hidden
          ? '<span class="bms-mm-hidden">🙈 隐藏中</span>'
          : `<span class="bms-mm-pos">(${pos?.X ?? "-"}, ${pos?.Y ?? "-"})</span>`}
        ${isMe ? '<span class="bms-mm-me">我</span>' : ""}
      </li>`;
    }).join("") || '<li style="cursor:default;color:#7d93ad">房间内没有玩家</li>';
  }

  function minimapHandleRosterClick(memberNumber) {
    if (minimapSwapInProgress) return;
    if (!isRoomAdmin() && memberNumber !== currentMemberNumber()) return; // 非管理员只能选中自己
    const target = findRoomCharacter(memberNumber);
    if (isCharacterHidden(target)) {
      toast("该玩家已隐藏坐标，无法选中或传送", "error");
      return;
    }
    if (minimapSelected === memberNumber) {
      minimapSelected = null;
      minimapPending = null;
    } else {
      minimapSelected = memberNumber;
      minimapPending = null;
    }
    renderMinimapStatus();
    renderMinimapRoster();
    drawMinimap();
  }

  function renderMinimapStatus() {
    const root = document.getElementById(MINIMAP_ID);
    if (!root) return;
    const footer = root.querySelector("footer");
    const admin = isRoomAdmin();
    let html = "";
    if (minimapSwapInProgress) {
      footer.innerHTML = '<div class="bms-mm-status"><strong>三步换位进行中</strong>：正在腾出临时空格并依次移动双方，请稍候…</div>';
      return;
    }
    if (minimapPending) {
      if (minimapPending.swapWith != null) {
        const a = findRoomCharacter(minimapPending.member);
        const b = findRoomCharacter(minimapPending.swapWith);
        const aName = a?.Name ? String(a.Name) : `#${minimapPending.member}`;
        const bName = b?.Name ? String(b.Name) : `#${minimapPending.swapWith}`;
        html = `<div class="bms-mm-status">交换位置：<strong>${escapeHTML(aName)}</strong> ↔ <strong>${escapeHTML(bName)}</strong></div>
          <div class="bms-mm-actions">
            <button class="bms-mm-confirm" data-mm-action="swap">交换位置</button>
            <button data-mm-action="switch-select">切换选中到 ${escapeHTML(bName)}</button>
            <button data-mm-action="cancel">取消</button>
          </div>`;
      } else {
        const target = findRoomCharacter(minimapPending.member);
        const name = target?.Name ? String(target.Name) : `#${minimapPending.member}`;
        const warn = minimapPending.walkable ? "" : `<span class="bms-mm-bad">落点不可站人，玩家将被推挤到邻近位置</span>`;
        html = `<div class="bms-mm-status">传送 <strong>${escapeHTML(name)}</strong> 到 (${minimapPending.x}, ${minimapPending.y})${warn ? `<br>${warn}` : ""}</div>
          <div class="bms-mm-actions">
            <button class="bms-mm-confirm${minimapPending.walkable ? "" : "-warn"}" data-mm-action="confirm">确认传送</button>
            <button data-mm-action="cancel">取消</button>
          </div>`;
      }
    } else if (minimapSelected != null) {
      const target = findRoomCharacter(minimapSelected);
      if (target) {
        const name = target.Name ? String(target.Name) : `#${minimapSelected}`;
        if (isRoomAdmin()) {
          html = `<div class="bms-mm-status">已选中 <strong>${escapeHTML(name)}</strong> (${target.MapData?.Pos?.X}, ${target.MapData?.Pos?.Y})，点击地图选择目标格子；右键或再次点击取消。</div>
            <div class="bms-mm-actions"><button data-mm-action="cancel">取消选中</button></div>`;
        } else {
          html = `<div class="bms-mm-status">已选中 <strong>${escapeHTML(name)}</strong>（自己），点击可达格子传送（仅限正常行走能到的地方）。</div>
            <div class="bms-mm-actions"><button data-mm-action="cancel">取消选中</button></div>`;
        }
      }
    } else if (admin) {
      html = `<div class="bms-mm-status">点击玩家（地图或列表）选中，然后点击目标格子传送（穿墙）。滚动缩放，拖拽平移。</div>`;
    } else {
      html = `<div class="bms-mm-status">只读概览：滚动缩放，拖拽平移。</div>`;
    }
    footer.innerHTML = html;
    footer.querySelector('[data-mm-action="confirm"]')?.addEventListener("click", () => {
      if (!minimapPending) return;
      const { member, x, y } = minimapPending;
      minimapPending = null;
      minimapSelected = null;
      renderMinimapStatus();
      renderMinimapRoster();
      drawMinimap();
      teleportWithVerify(member, x, y);
    });
    footer.querySelector('[data-mm-action="swap"]')?.addEventListener("click", () => {
      if (!minimapPending || minimapPending.swapWith == null) return;
      const { member, swapWith } = minimapPending;
      minimapPending = null;
      minimapSelected = null;
      renderMinimapStatus();
      renderMinimapRoster();
      drawMinimap();
      swapPositionsAndVerify(member, swapWith);
    });
    footer.querySelector('[data-mm-action="switch-select"]')?.addEventListener("click", () => {
      if (!minimapPending || minimapPending.swapWith == null) return;
      minimapSelected = minimapPending.swapWith;
      minimapPending = null;
      renderMinimapStatus();
      renderMinimapRoster();
      drawMinimap();
    });
    footer.querySelector('[data-mm-action="cancel"]')?.addEventListener("click", () => {
      minimapPending = null;
      minimapSelected = null;
      renderMinimapStatus();
      renderMinimapRoster();
      drawMinimap();
    });
  }

  // 传送结果校验（纯逻辑）：目标仍在房间且位置已变为目标坐标才算完成广播。
  // 注意：目标处于聊天视图时位置已本地更新但未广播，切回地图视图后会自动生效，
  // 因此“位置未变化”不等于传送失败，只提示尚未同步。
  function teleportVerificationMessage(target, x, y) {
    if (!target) return "目标已不在房间，传送可能未生效";
    const pos = target.MapData?.Pos;
    if (!pos || pos.X !== x || pos.Y !== y) return "目标尚未同步新位置：若目标处于聊天视图，切回地图视图后将自动生效；否则可能客户端版本过旧";
    return "传送成功：目标位置已更新";
  }

  // 判断一条 Hidden 消息是否为“发给当前玩家”的原版传送指令
  function isTeleportMessageFor(data, memberNumber) {
    return !!data
      && data.Type === "Hidden"
      && data.Content === "ChatRoomMapViewTeleport"
      && Number(data.Target) === Number(memberNumber);
  }

  // 接收端增强：原版 ChatRoomMapViewTeleport 只更新本地 MapData.Pos，真正的广播由
  // ChatRoomMapViewUpdatePlayerSync 在地图视图运行循环里消费标志后发送。目标玩家停在
  // 聊天视图时标志无人消费，位置不生效。这里在原版处理完成后强制广播一次（幂等）。
  function installTeleportReceiveBoost() {
    modApi.hookFunction("ChatRoomMessage", 1000, (args, next) => {
      const data = args[0];
      const result = next(args);
      try {
        if (isTeleportMessageFor(data, currentMemberNumber())) {
          const serverSend = getServerSend();
          const player = getPlayerCharacter();
          if (serverSend && player?.MapData) serverSend("ChatRoomCharacterMapDataUpdate", player.MapData);
        }
      } catch (error) {
        warn("传送后强制同步失败", error);
      }
      return result;
    });
  }

  function teleportWithVerify(member, x, y) {
    let mode;
    try {
      mode = teleportCharacter(member, x, y);
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    if (member === currentMemberNumber()) {
      toast("已传送到目标位置", "success");
      return;
    }
    toast(`传送指令已发出（${mode === "native" ? "原生接口" : "兼容消息"}），等待目标同步…`, "success");
    setTimeout(() => {
      const target = findRoomCharacter(member);
      toast(teleportVerificationMessage(target, x, y), target ? "success" : "error");
    }, MINIMAP_VERIFY_DELAY_MS);
  }

  // 为被临时挪开的角色寻找相邻一格的空落点。只选择可站人且没有角色占用的格子。
  function findSwapStagingPosition(grid, characters, anchor) {
    if (!grid || !anchor) return null;
    const occupied = new Set((characters ?? []).map(character => {
      const pos = character.MapData?.Pos;
      return pos ? `${pos.X},${pos.Y}` : "";
    }).filter(Boolean));
    const candidates = [
      { x: anchor.X + 1, y: anchor.Y },
      { x: anchor.X - 1, y: anchor.Y },
      { x: anchor.X, y: anchor.Y + 1 },
      { x: anchor.X, y: anchor.Y - 1 },
    ];
    return candidates.find(pos => pos.x >= 0 && pos.y >= 0 && pos.x < grid.width && pos.y < grid.height
      && grid.walkable[pos.y * grid.width + pos.x] === 1
      && !occupied.has(`${pos.x},${pos.y}`)) ?? null;
  }

  // 三步换位：先把 B 挪到相邻空格，再让 A 占据 B 原位置，最后让 B 占据 A 原位置。
  function buildSwapTeleportPlan(a, b, grid, characters) {
    const ax = a?.MapData?.Pos?.X;
    const ay = a?.MapData?.Pos?.Y;
    const bx = b?.MapData?.Pos?.X;
    const by = b?.MapData?.Pos?.Y;
    if (ax == null || ay == null || bx == null || by == null) return null;
    const staging = findSwapStagingPosition(grid, characters, { X: bx, Y: by });
    if (!staging) return null;
    return [
      { member: b.MemberNumber, x: staging.x, y: staging.y, phase: "vacate" },
      { member: a.MemberNumber, x: bx, y: by, phase: "fill" },
      { member: b.MemberNumber, x: ax, y: ay, phase: "complete" },
    ];
  }

  function swapPositionsAndVerify(aMember, bMember) {
    const a = findRoomCharacter(aMember);
    const b = findRoomCharacter(bMember);
    if (!a || !b) {
      toast("目标玩家已不在房间", "error");
      return;
    }
    const grid = minimapGrid ?? buildMapGridSnapshot();
    const plan = buildSwapTeleportPlan(a, b, grid, getRoomCharacterList());
    if (!plan) {
      toast("目标角色周围没有可用于换位的相邻空格", "error");
      return;
    }
    const finalA = plan[1];
    const finalB = plan[2];
    let index = 0;
    minimapSwapInProgress = true;
    minimapSelected = null;
    minimapPending = null;
    renderMinimapRoster();
    renderMinimapStatus();
    drawMinimap();

    const finishSwap = () => {
      minimapSwapInProgress = false;
      minimapPlayerSig = "";
      renderMinimapRoster();
      renderMinimapStatus();
      drawMinimap();
    };
    const runNextStep = () => {
      const step = plan[index];
      try {
        teleportCharacter(step.member, step.x, step.y);
      } catch (error) {
        toast(`换位第 ${index + 1} 步失败：${error.message}`, "error");
        finishSwap();
        return;
      }
      index += 1;
      if (index < plan.length) {
        setTimeout(runNextStep, MINIMAP_SWAP_STEP_DELAY_MS);
        return;
      }
      toast("三步换位指令已发出，等待双方同步…", "success");
      setTimeout(() => {
        const aNow = findRoomCharacter(aMember);
        const bNow = findRoomCharacter(bMember);
        const aOk = aNow?.MapData?.Pos?.X === finalA.x && aNow?.MapData?.Pos?.Y === finalA.y;
        const bOk = bNow?.MapData?.Pos?.X === finalB.x && bNow?.MapData?.Pos?.Y === finalB.y;
        if (!aNow || !bNow) {
          toast("目标已不在房间，换位可能未生效", "error");
        } else if (aOk && bOk) {
          toast("换位成功：双方已到达彼此原位置", "success");
        } else {
          toast("换位尚未完全同步：若目标处于聊天视图，切回地图视图后自动生效", "error");
        }
        finishSwap();
      }, MINIMAP_VERIFY_DELAY_MS);
    };
    runNextStep();
  }

  function minimapHandleWheel(event) {
    event.preventDefault();
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const pos = minimapEventToCanvasXY(canvas, rect, event.clientX, event.clientY);
    minimapZoomAt(pos.x, pos.y, event.deltaY < 0 ? 1.18 : 1 / 1.18);
  }

  function minimapHandlePointerDown(event) {
    if (minimapSwapInProgress) return;
    const canvas = event.currentTarget;
    if (event.button === 2) {
      minimapSelected = null;
      minimapPending = null;
      renderMinimapStatus();
      renderMinimapRoster();
      drawMinimap();
      return;
    }
    if (event.button !== 0) return;
    canvas.setPointerCapture?.(event.pointerId);
    minimapDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: minimapView.panX, panY: minimapView.panY, moved: false };
    canvas.classList.add("bms-mm-dragging");
  }

  function minimapHandlePointerMove(event) {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const pos = minimapEventToCanvasXY(canvas, rect, event.clientX, event.clientY);
    const grid = minimapCanvasToGrid(pos.x, pos.y);
    minimapHover = grid;
    if (minimapDrag && minimapDrag.pointerId === event.pointerId) {
      const dx = event.clientX - minimapDrag.startX;
      const dy = event.clientY - minimapDrag.startY;
      if (Math.abs(dx) > MINIMAP_DRAG_THRESHOLD || Math.abs(dy) > MINIMAP_DRAG_THRESHOLD) minimapDrag.moved = true;
      minimapView.panX = minimapDrag.panX + dx;
      minimapView.panY = minimapDrag.panY + dy;
    }
    drawMinimap();
    if (!minimapDrag?.moved && grid) renderMinimapHoverStatus(grid);
  }

  function renderMinimapHoverStatus(grid) {
    if (minimapSwapInProgress || minimapPending || minimapSelected != null) return;
    const root = document.getElementById(MINIMAP_ID);
    if (!root) return;
    const character = findRoomCharacterAt(grid.x, grid.y);
    const walkable = minimapGrid?.walkable[grid.y * minimapGrid.width + grid.x] === 1;
    let text;
    if (character) {
      text = `格子 (${grid.x}, ${grid.y})：${escapeHTML(character.Name ? String(character.Name) : `#${character.MemberNumber}`)}`;
    } else if (!walkable) {
      text = `格子 (${grid.x}, ${grid.y})：<span class="bms-mm-bad">不可站人</span>`;
    } else if (!isRoomAdmin()) {
      const start = getPlayerCharacter()?.MapData?.Pos;
      const reachable = start && isPositionReachable(minimapGrid, start.X, start.Y, grid.x, grid.y);
      text = `格子 (${grid.x}, ${grid.y})：${reachable ? "可传送" : '<span class="bms-mm-bad">无法抵达</span>'}`;
    } else {
      text = `格子 (${grid.x}, ${grid.y})：可站人`;
    }
    root.querySelector("footer").innerHTML = `<div class="bms-mm-status">${text}</div>`;
  }

  function minimapHandlePointerUp(event) {
    const canvas = event.currentTarget;
    canvas.classList.remove("bms-mm-dragging");
    if (!minimapDrag || minimapDrag.pointerId !== event.pointerId) return;
    const wasDrag = minimapDrag.moved;
    minimapDrag = null;
    if (wasDrag) return;
    const rect = canvas.getBoundingClientRect();
    const pos = minimapEventToCanvasXY(canvas, rect, event.clientX, event.clientY);
    const grid = minimapCanvasToGrid(pos.x, pos.y);
    if (!grid) return;
    minimapHandleClick(grid.x, grid.y);
  }

  function minimapHandleClick(gx, gy) {
    if (minimapSwapInProgress) return;
    const character = findRoomCharacterAt(gx, gy);
    const admin = isRoomAdmin();
    const myNumber = currentMemberNumber();
    if (character) {
      if (admin) {
        // 管理员：取消 / 交换待确认 / 选中
        if (minimapSelected === character.MemberNumber) {
          minimapSelected = null;
          minimapPending = null;
        } else if (minimapSelected != null) {
          const selected = findRoomCharacter(minimapSelected);
          if (!selected) {
            minimapSelected = null;
            minimapPending = null;
          } else {
            minimapPending = {
              member: minimapSelected,
              x: gx,
              y: gy,
              walkable: true,
              swapWith: character.MemberNumber,
            };
          }
        } else {
          minimapSelected = character.MemberNumber;
          minimapPending = null;
        }
        renderMinimapStatus();
        renderMinimapRoster();
        drawMinimap();
        return;
      }
      // 非管理员：只能选中/取消自己，点击其他玩家忽略
      if (character.MemberNumber !== myNumber) return;
      if (minimapSelected === myNumber) {
        minimapSelected = null;
        minimapPending = null;
      } else {
        minimapSelected = myNumber;
        minimapPending = null;
      }
      renderMinimapStatus();
      renderMinimapRoster();
      drawMinimap();
      return;
    }
    if (minimapSelected == null || !minimapGrid) return;
    const selected = findRoomCharacter(minimapSelected);
    if (!selected) {
      minimapSelected = null;
      return;
    }
    const pos = selected.MapData?.Pos;
    if (pos && pos.X === gx && pos.Y === gy) {
      minimapSelected = null;
      minimapPending = null;
      renderMinimapStatus();
      renderMinimapRoster();
      drawMinimap();
      return;
    }
    const walkable = minimapGrid.walkable[gy * minimapGrid.width + gx] === 1;
    if (!admin) {
      // 非管理员：落点必须可正常行走抵达，否则拒绝
      const reachable = isPositionReachable(minimapGrid, pos.X, pos.Y, gx, gy);
      if (!reachable) {
        toast("该位置无法通过正常行走抵达，传送被拒绝", "error");
        return;
      }
    }
    minimapPending = { member: minimapSelected, x: gx, y: gy, walkable };
    renderMinimapStatus();
    drawMinimap();
  }

  function minimapTick() {
    if (!minimapOpen) return;
    if (!shouldShowMinimap()) {
      closeMinimap();
      return;
    }
    const grid = buildMapGridSnapshot();
    if (!grid) return;
    if (!minimapGrid || grid.tiles !== minimapGrid.tiles || grid.objects !== minimapGrid.objects || minimapDirty) {
      minimapGrid = grid;
      minimapDirty = false;
      rebuildMinimapBackground();
      if (minimapSelected == null && minimapPending == null) fitMinimapView();
    } else {
      minimapGrid = grid;
    }
    const sig = playerPositionSignature();
    if (sig !== minimapPlayerSig) {
      minimapPlayerSig = sig;
      if (minimapSelected != null && isCharacterHidden(findRoomCharacter(minimapSelected))) {
        minimapSelected = null;
        minimapPending = null;
      }
      if (!minimapSwapInProgress) renderMinimapRoster();
      drawMinimap();
    }
  }

  function openMinimap() {
    if (minimapOpen) return;
    minimapOpen = true;
    ensureMinimapRoot();
    const room = getChatRoomData();
    const roomEl = document.querySelector(`#${MINIMAP_ID} .bms-mm-room`);
    if (roomEl) roomEl.textContent = room?.Name ? `房间：${room.Name}` : "";
    minimapGrid = null;
    minimapDirty = true;
    minimapView = { zoom: 1, panX: 0, panY: 0 };
    minimapPlayerSig = ""; // 重置签名：重开后首个 tick 必然重建玩家列表与画面
    syncStealthToggle();
    minimapTick();
  }

  function closeMinimap() {
    if (!minimapOpen) return;
    minimapOpen = false;
    minimapSelected = null;
    minimapPending = null;
    minimapHover = null;
    minimapDrag = null;
    document.getElementById(MINIMAP_ID)?.remove();
  }

  function toggleMinimap() {
    if (minimapOpen) closeMinimap();
    else openMinimap();
  }

  function installMinimapHooks() {
    if (typeof document === "undefined") return; // 简化地图依赖 DOM，无 DOM 环境（测试沙箱）不安装
    installTeleportReceiveBoost();
    modApi.hookFunction("ChatRoomRun", 0, (args, next) => {
      const result = next(args);
      if (shouldShowMinimap()) {
        if (minimapOpen) minimapTick();
        if (shouldDrawMinimapEntryButton() && typeof globalThis.DrawButton === "function") {
          DrawButton(MINIMAP_ENTRY_BUTTON.x, MINIMAP_ENTRY_BUTTON.y, MINIMAP_ENTRY_BUTTON.width, MINIMAP_ENTRY_BUTTON.height, "图", "#DDEBFF", "");
        }
      } else if (minimapOpen) {
        closeMinimap();
      }
      return result;
    });
    modApi.hookFunction("ChatRoomClick", 1000, (args, next) => {
      if (shouldDrawMinimapEntryButton()
        && typeof globalThis.MouseIn === "function"
        && MouseIn(MINIMAP_ENTRY_BUTTON.x, MINIMAP_ENTRY_BUTTON.y, MINIMAP_ENTRY_BUTTON.width, MINIMAP_ENTRY_BUTTON.height)) {
        toggleMinimap();
        return;
      }
      return next(args);
    });
    modApi.hookFunction("ChatRoomMapViewUpdateFlag", 0, (args, next) => {
      const result = next(args);
      minimapDirty = true; // 地图被编辑：下一个 tick 重建底图
      return result;
    });
    if (typeof globalThis.ChatRoomSyncRoomProperties === "function") {
      modApi.hookFunction("ChatRoomSyncRoomProperties", 1000, (args, next) => {
        const result = next(args);
        minimapGrid = null; // 房间属性替换：强制重建
        minimapDirty = true;
        minimapPlayerSig = ""; // 同步可能替换角色数据对象，强制下个 tick 重建名单
        minimapSelected = null;
        minimapPending = null;
        return result;
      });
    }
    if (typeof globalThis.ChatRoomLeave === "function") {
      modApi.hookFunction("ChatRoomLeave", 1000, (args, next) => {
        closeMinimap();
        return next(args);
      });
    }
  }



  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID}{position:fixed;inset:0;z-index:100000;background:rgba(8,15,28,.78);display:flex;align-items:center;justify-content:center;font-family:Inter,"Microsoft YaHei",sans-serif;color:#eaf2ff;pointer-events:auto}
      #${ROOT_ID} *{box-sizing:border-box}
      .bms-panel{width:min(1120px,94vw);height:min(780px,92vh);display:flex;flex-direction:column;background:#111d31;border:1px solid #45678f;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden}
      .bms-header{display:flex;align-items:center;gap:14px;padding:18px 22px;background:linear-gradient(135deg,#1b3151,#17243b);border-bottom:1px solid #385576}
      .bms-title{font-size:24px;font-weight:750;letter-spacing:.02em}.bms-subtitle{font-size:13px;color:#9eb4ce;margin-top:3px}.bms-spacer{flex:1}
      .bms-toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid #2c425d;background:#132139}
      .bms-btn{appearance:none;border:1px solid #4b6e98;border-radius:9px;background:#203858;color:#f2f7ff;padding:9px 14px;font-size:14px;line-height:1.2;cursor:pointer;transition:.15s ease}
      .bms-btn:hover{background:#2b4a72;border-color:#78a5d8}.bms-btn:disabled{opacity:.42;cursor:not-allowed}.bms-btn-primary{background:#2966a3;border-color:#4d94d5}.bms-btn-danger{background:#682e3b;border-color:#a95065}.bms-btn-quiet{background:transparent}.bms-btn-small{padding:7px 10px;font-size:13px}
      .bms-status{font-size:13px;color:#a8bdd5;padding-left:4px}.bms-status strong{color:#8fd0ff}.bms-warning{color:#ffc981}
      .bms-list{flex:1;overflow:auto;padding:16px 20px 24px}.bms-empty{height:100%;display:grid;place-content:center;text-align:center;color:#8fa6c0;font-size:16px;line-height:1.8}
      .bms-card{display:grid;grid-template-columns:minmax(220px,1fr) minmax(260px,1.5fr) auto;gap:18px;align-items:center;padding:15px 16px;margin-bottom:11px;background:#172740;border:1px solid #314d6d;border-radius:12px}
      .bms-card:hover{border-color:#527ba8}.bms-name{font-size:17px;font-weight:700;color:#f5f9ff;overflow-wrap:anywhere}.bms-meta{font-size:12px;color:#91a9c3;margin-top:5px;line-height:1.55}.bms-note{font-size:13px;color:#c1d0e1;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.bms-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
      .bms-badge{display:inline-block;padding:2px 7px;border:1px solid #5a7898;border-radius:999px;font-size:11px;color:#bad1e8;margin-left:7px;vertical-align:2px}.bms-badge-auto{border-color:#806a41;color:#f0ce8d}
      .bms-dialog-backdrop{position:absolute;inset:0;background:rgba(5,10,18,.72);display:grid;place-items:center;padding:24px}.bms-dialog{width:min(560px,92vw);max-height:85vh;overflow:auto;background:#182942;border:1px solid #5478a1;border-radius:14px;padding:22px;box-shadow:0 20px 55px rgba(0,0,0,.5)}
      .bms-dialog h3{margin:0 0 10px;font-size:20px}.bms-dialog p{color:#c0d0e1;line-height:1.65;margin:8px 0}.bms-field{display:block;margin:15px 0}.bms-field span{display:block;font-size:13px;color:#a9bfd7;margin-bottom:7px}.bms-field input,.bms-field textarea{width:100%;border:1px solid #49698d;border-radius:8px;background:#0f1c2e;color:#f3f7fc;padding:10px 12px;font:inherit;outline:none}.bms-field textarea{height:110px;resize:vertical}.bms-field input:focus,.bms-field textarea:focus{border-color:#79afe5}.bms-dialog-actions{display:flex;justify-content:flex-end;gap:9px;flex-wrap:wrap;margin-top:20px}.bms-import-options{display:grid;gap:9px;margin-top:16px}.bms-import-options .bms-btn{text-align:left;padding:11px 13px}
      .bms-toast{position:fixed;right:24px;bottom:24px;z-index:100002;max-width:440px;padding:12px 16px;border-radius:10px;background:#1e3858;border:1px solid #5c83ad;color:#f4f8ff;box-shadow:0 12px 30px rgba(0,0,0,.4);opacity:0;transform:translateY(10px);transition:.18s ease;pointer-events:none}.bms-toast.bms-show{opacity:1;transform:none}.bms-toast.bms-error{background:#572b36;border-color:#bb6378}.bms-toast.bms-success{background:#234b43;border-color:#58a691}
      @media(max-width:860px){.bms-card{grid-template-columns:1fr}.bms-actions{justify-content:flex-start}.bms-panel{height:94vh}.bms-toolbar{padding:11px}.bms-list{padding:11px}}
    `;
    document.head.appendChild(style);
  }

  function sortedRecords() {
    return [...library.records].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.addEventListener("click", handleRootClick);
    document.body.appendChild(root);
    return root;
  }

  function recordCardHTML(record) {
    const badges = `${record.autoBackup ? '<span class="bms-badge bms-badge-auto">自动备份</span>' : ''}${record.mapType ? `<span class="bms-badge">${escapeHTML(record.mapType)}</span>` : ""}`;
    return `<article class="bms-card" data-record-id="${escapeHTML(record.id)}">
      <div><div class="bms-name">${escapeHTML(record.name)}${badges}</div><div class="bms-meta">修改：${escapeHTML(localTimestamp(record.updatedAt))}<br>来源：${escapeHTML(record.sourceRoomName || "未记录")}</div></div>
      <div class="bms-note">${escapeHTML(record.note || "没有备注")}</div>
      <div class="bms-actions">
        <button class="bms-btn bms-btn-primary bms-btn-small" data-action="apply" data-id="${escapeHTML(record.id)}">应用到房间</button>
        <button class="bms-btn bms-btn-small" data-action="overwrite" data-id="${escapeHTML(record.id)}">用当前地图覆盖</button>
        <button class="bms-btn bms-btn-small" data-action="export-one" data-id="${escapeHTML(record.id)}">导出</button>
        <button class="bms-btn bms-btn-small" data-action="edit" data-id="${escapeHTML(record.id)}">编辑</button>
        <button class="bms-btn bms-btn-danger bms-btn-small" data-action="delete" data-id="${escapeHTML(record.id)}">删除</button>
      </div>
    </article>`;
  }

  function renderUI() {
    if (!uiOpen) return;
    const root = ensureRoot();
    const records = sortedRecords();
    const room = getChatRoomData();
    root.innerHTML = `<section class="bms-panel" role="dialog" aria-modal="true" aria-label="地图存档">
      <header class="bms-header"><div><div class="bms-title">地图存档</div><div class="bms-subtitle">本地保存，不写入角色数据 · v${VERSION}</div></div><div class="bms-spacer"></div><button class="bms-btn bms-btn-quiet" data-action="close">关闭</button></header>
      <div class="bms-toolbar">
        <button class="bms-btn bms-btn-primary" data-action="save-new">保存当前地图</button>
        <button class="bms-btn" data-action="import">导入文件</button>
        <button class="bms-btn" data-action="export-all" ${records.length ? "" : "disabled"}>导出全部</button>
        <span class="bms-status">当前房间：<strong>${escapeHTML(room?.Name || "未知")}</strong>　共 ${records.length} 张地图${library.loadError ? `　<span class="bms-warning">检测到损坏数据，恢复副本：${escapeHTML(storageRecoveryKey || "创建失败")}</span>` : ""}</span>
      </div>
      <main class="bms-list">${records.length ? records.map(recordCardHTML).join("") : '<div class="bms-empty">还没有本地地图。<br>点击“保存当前地图”创建第一张存档。</div>'}</main>
      <input id="${FILE_INPUT_ID}" type="file" accept=".json,.bcmap,.bcmapset,text/plain,application/json" hidden>
      <div class="bms-dialog-host"></div>
    </section>`;
    root.querySelector(`#${FILE_INPUT_ID}`)?.addEventListener("change", handleFileSelection, { once: true });
  }

  function openUI() {
    try {
      assertRoomMapAction();
      if (activeStorageKey !== storageKeyForCurrentPlayer()) readLibraryFromStorage();
      uiOpen = true;
      renderUI();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function closeUI() {
    uiOpen = false;
    document.getElementById(ROOT_ID)?.remove();
  }

  function dialogHost() {
    return document.querySelector(`#${ROOT_ID} .bms-dialog-host`);
  }

  function closeDialog() {
    const host = dialogHost();
    if (host) host.innerHTML = "";
  }

  function showDialog(title, bodyHTML, buttons) {
    const host = dialogHost();
    if (!host) return;
    host.innerHTML = `<div class="bms-dialog-backdrop"><section class="bms-dialog"><h3>${escapeHTML(title)}</h3>${bodyHTML}<div class="bms-dialog-actions"></div></section></div>`;
    const actions = host.querySelector(".bms-dialog-actions");
    for (const button of buttons) {
      const element = document.createElement("button");
      element.className = `bms-btn ${button.className || ""}`;
      element.textContent = button.label;
      element.addEventListener("click", button.onClick);
      actions.appendChild(element);
    }
  }

  function showMapForm(title, record, onSave) {
    const name = record?.name || getChatRoomData()?.Name || `地图 ${localTimestamp(now())}`;
    const note = record?.note || "";
    showDialog(title, `<label class="bms-field"><span>名称</span><input class="bms-name-input" maxlength="80" value="${escapeHTML(name)}"></label><label class="bms-field"><span>备注</span><textarea class="bms-note-input" maxlength="500">${escapeHTML(note)}</textarea></label>`, [
      { label: "取消", onClick: closeDialog },
      { label: "保存", className: "bms-btn-primary", onClick: () => {
        const enteredName = clampText(dialogHost()?.querySelector(".bms-name-input")?.value, 80);
        const enteredNote = clampText(dialogHost()?.querySelector(".bms-note-input")?.value, 500);
        if (!enteredName) return toast("请输入地图名称", "error");
        try {
          onSave(enteredName, enteredNote);
          closeDialog();
          renderUI();
          toast("地图已保存到本地", "success");
        } catch (error) { toast(error.message, "error"); }
      } },
    ]);
    dialogHost()?.querySelector(".bms-name-input")?.focus();
  }

  function showConfirm(title, message, confirmLabel, onConfirm, danger = false) {
    showDialog(title, `<p>${escapeHTML(message)}</p>`, [
      { label: "取消", onClick: closeDialog },
      { label: confirmLabel, className: danger ? "bms-btn-danger" : "bms-btn-primary", onClick: () => {
        try {
          onConfirm();
          closeDialog();
          renderUI();
        } catch (error) { toast(error.message, "error"); }
      } },
    ]);
  }

  function showImportOptions(parsed) {
    const kindText = parsed.kind === "library" ? "完整地图库" : "单张地图";
    const optionButtons = [
      ["keepBoth", "保留双方", "冲突记录以新的 ID 和名称导入"],
      ["overwriteId", "按 ID 覆盖", "相同 ID 的本地记录将被导入记录覆盖"],
      ["overwriteName", "按名称覆盖", "同名本地记录将被导入记录覆盖"],
      ["skip", "跳过冲突", "ID 或名称冲突的记录不导入"],
    ];
    if (parsed.kind === "library") optionButtons.push(["replaceAll", "替换整个本地地图库", "清空当前地图库后导入文件内容"]);
    const body = `<p>识别为${kindText}，包含 <strong>${parsed.records.length}</strong> 张地图。请选择冲突处理方式。</p><div class="bms-import-options">${optionButtons.map(([strategy, label, description]) => `<button class="bms-btn ${strategy === "replaceAll" ? "bms-btn-danger" : ""}" data-import-strategy="${strategy}"><strong>${escapeHTML(label)}</strong><br><span>${escapeHTML(description)}</span></button>`).join("")}</div>`;
    showDialog("导入地图文件", body, [{ label: "取消", onClick: closeDialog }]);
    dialogHost()?.querySelectorAll("[data-import-strategy]").forEach(button => button.addEventListener("click", () => {
      const strategy = button.dataset.importStrategy;
      try {
        const plan = buildImportPlan(library, parsed.records, strategy);
        persistLibrary(plan.library);
        closeDialog();
        renderUI();
        toast(`导入完成：新增 ${plan.stats.added}，覆盖 ${plan.stats.overwritten}，跳过 ${plan.stats.skipped}`, "success");
      } catch (error) { toast(error.message, "error"); }
    }));
  }

  async function handleFileSelection(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error("导入文件超过大小限制");
      const parsed = parseImportDocument(await file.text(), file.name);
      showImportOptions(parsed);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      event.target.value = "";
    }
  }

  function handleRootClick(event) {
    const actionElement = event.target.closest?.("[data-action]");
    if (!actionElement) return;
    const action = actionElement.dataset.action;
    const id = actionElement.dataset.id;
    const record = id ? findRecord(id) : null;

    if (action === "close") return closeUI();
    if (action === "save-new") return showMapForm("保存当前地图", null, (name, note) => saveCurrentMapAsNew(name, note));
    if (action === "import") return document.getElementById(FILE_INPUT_ID)?.click();
    if (action === "export-all") {
      try { exportWholeLibrary(); toast("已导出全部地图", "success"); } catch (error) { toast(error.message, "error"); }
      return;
    }
    if (!record) return toast("找不到地图记录", "error");

    if (action === "export-one") {
      try { exportSingleRecord(record); toast("地图文件已导出", "success"); } catch (error) { toast(error.message, "error"); }
    } else if (action === "edit") {
      showMapForm("编辑地图信息", record, (name, note) => updateRecordMetadata(record.id, { name, note }));
    } else if (action === "delete") {
      showConfirm("删除地图", `确定删除“${record.name}”吗？此操作只影响本地存档。`, "删除", () => {
        deleteRecord(record.id);
        toast("地图已删除", "success");
      }, true);
    } else if (action === "overwrite") {
      showConfirm("覆盖本地存档", `用房间“${getChatRoomData()?.Name || "当前房间"}”的当前地图覆盖“${record.name}”？`, "覆盖保存", () => {
        overwriteSavedMapFromCurrent(record.id);
        toast("本地存档已覆盖", "success");
      });
    } else if (action === "apply") {
      showConfirm("覆盖当前房间地图", `将“${record.name}”应用到房间“${getChatRoomData()?.Name || "当前房间"}”，并同步给房间内所有玩家。插件会先自动备份当前地图。`, "应用并同步", () => {
        applySavedMapToRoom(record.id);
        toast("地图已载入，等待 BC 同步房间", "success");
      });
    }
  }

  function shouldDrawEntryButton() {
    return globalThis.CurrentScreen === "ChatRoom"
      && typeof globalThis.ChatRoomMapViewIsActive === "function"
      && ChatRoomMapViewIsActive()
      && globalThis.ChatRoomMapViewEditMode === ""
      && isMapRoom()
      && isRoomAdmin();
  }

  function installHooks() {
    // ChatRoomViews.Map captures DrawUi and Click function references while BC initializes.
    // Hooking ChatRoomMapViewDrawUi/Click later would only replace the globals, while the
    // active view keeps calling its captured originals. Hook the live room dispatchers.
    modApi.hookFunction("ChatRoomRun", 0, (args, next) => {
      const result = next(args);
      if (uiOpen && (!isMapRoom() || !isRoomAdmin() || typeof globalThis.ChatRoomMapViewIsActive !== "function" || !ChatRoomMapViewIsActive())) closeUI();
      if (shouldDrawEntryButton() && typeof globalThis.DrawButton === "function") {
        DrawButton(ENTRY_BUTTON.x, ENTRY_BUTTON.y, ENTRY_BUTTON.width, ENTRY_BUTTON.height, "档", "#DDEBFF", "");
      }
      return result;
    });
    modApi.hookFunction("ChatRoomClick", 1000, (args, next) => {
      if (shouldDrawEntryButton() && typeof globalThis.MouseIn === "function" && MouseIn(ENTRY_BUTTON.x, ENTRY_BUTTON.y, ENTRY_BUTTON.width, ENTRY_BUTTON.height)) {
        openUI();
        return;
      }
      return next(args);
    });
    if (typeof globalThis.ChatRoomLeave === "function") {
      modApi.hookFunction("ChatRoomLeave", 1000, (args, next) => {
        closeUI();
        return next(args);
      });
    }
  }



  function exposePublicAPI() {
    globalThis.BCMapSaver = Object.freeze({
      version: VERSION,
      open: openUI,
      close: closeUI,
      list: () => cloneJSON(library.records),
      exportLibrary: () => cloneJSON(createLibraryFileDocument(library)),
      status: () => ({
        installed: runtimeInstalled,
        initialized,
        recordCount: library.records.length,
        storageKey: activeStorageKey,
        storageRecoveryKey,
        storageWriteBlocked,
        mapRoom: isMapRoom(),
        roomAdmin: isRoomAdmin(),
      }),
      minimap: {
        open: openMinimap,
        close: closeMinimap,
        toggle: toggleMinimap,
        isOpen: () => minimapOpen,
        teleport: teleportCharacter,
        grid: buildMapGridSnapshot,
      },
    });
  }

  function detectDuplicateInstance() {
    if (!globalThis.BCMapSaver && !document.getElementById(STYLE_ID) && !document.getElementById(ROOT_ID)) return false;
    duplicateInstance = true;
    console.error(`[${MOD_NAME}] 检测到另一份 BC Map Saver，当前实例停止安装。`);
    return true;
  }

  function initialize() {
    if (!globalThis.bcModSdk || !globalThis.Player) return;
    if (!runtimeInstalled) {
      if (detectDuplicateInstance()) return;
      try {
        modApi = bcModSdk.registerMod({ name: MOD_NAME, fullName: FULL_NAME, version: VERSION }, { allowReplace: false });
        installHooks();
        installMinimapHooks();
        installStealthHooks();
        injectStyle();
        injectMinimapStyle();
        runtimeInstalled = true;
      } catch (error) {
        duplicateInstance = /already|duplicate|registered|replace/i.test(String(error?.message || error));
        warn("插件 Hook 安装失败，将继续等待 BC 加载", error);
        try { modApi?.unload(); } catch (_) { /* ignore */ }
        modApi = null;
        return;
      }
    }
    if (initialized || !Number.isInteger(currentMemberNumber())) return;
    readLibraryFromStorage();
    exposePublicAPI();
    initialized = true;
    log(`v${VERSION} 已加载，本地地图 ${library.records.length} 张`);
  }

  if (globalThis.__BMS_TEST_MODE__) {
    globalThis.__BMS_TEST_API__ = {
      normalizeMapRecord,
      normalizeLibrary,
      createMapRecord,
      createMapFileDocument,
      createLibraryFileDocument,
      serializeFileDocument,
      parseImportDocument,
      buildImportPlan,
      readLibraryFromStorage,
      persistLibrary,
      addRecord,
      overwriteRecord,
      updateRecordMetadata,
      deleteRecord,
      addAutoBackup,
      findRecord,
      isMapRoom,
      isRoomAdmin,
      exportCurrentNativeMap,
      saveCurrentMapAsNew,
      overwriteSavedMapFromCurrent,
      applySavedMapToRoom,
      getLibrary: () => cloneJSON(library),
      setLibrary: value => { library = normalizeLibrary(value); },
      setActiveStorageKey: value => { activeStorageKey = value; },
      shouldDrawEntryButton,
      shouldDrawMinimapEntryButton,
      buildMapGridSnapshot,
      teleportCharacter,
      createTeleportMessage,
      isPositionWalkable,
      tileKindOf,
      findRoomCharacter,
      getRoomCharacterList,
      playerPositionSignature,
      getChatRoomMapViewTeleport,
      getServerSend,
      minimapEventToCanvasXY,
      minimapCanvasToGridXY,
      minimapPlayerColor,
      isStealthEnabled,
      setStealthEnabled,
      isCharacterHidden,
      applyStealthMarker,
      installStealthHooks,
      teleportVerificationMessage,
      isTeleportMessageFor,
      buildSwapTeleportPlan,
      isPositionReachable,
      installHooksForTest: api => { modApi = api; installHooks(); installMinimapHooks(); installStealthHooks(); },
      constants: { STORAGE_SCHEMA_VERSION, MAP_FILE_FORMAT, LIBRARY_FILE_FORMAT, FILE_FORMAT_VERSION, MAX_AUTO_BACKUPS, ENTRY_BUTTON, MINIMAP_ENTRY_BUTTON },
    };
  } else {
    const timer = setInterval(() => {
      initialize();
      if (initialized || duplicateInstance) clearInterval(timer);
    }, 500);
    globalThis.addEventListener?.("load", initialize);
  }
})();



