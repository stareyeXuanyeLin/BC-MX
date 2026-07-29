// ==UserScript==
// @name         Bondage Club - Map Saver（核心脚本）
// @name:zh-CN   Bondage Club - 地图存档（核心脚本）
// @namespace    https://github.com/stareyeXuanyeLin/BC-Map-Saver
// @version      0.1.2
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
  const VERSION = "0.1.2";
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

  function assertRoomMapAction() {
    if (globalThis.CurrentScreen !== "ChatRoom") throw new Error("当前不在聊天室");
    if (!isMapRoom()) throw new Error("当前房间没有启用地图模式");
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
        injectStyle();
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
      installHooksForTest: api => { modApi = api; installHooks(); },
      constants: { STORAGE_SCHEMA_VERSION, MAP_FILE_FORMAT, LIBRARY_FILE_FORMAT, FILE_FORMAT_VERSION, MAX_AUTO_BACKUPS },
    };
  } else {
    const timer = setInterval(() => {
      initialize();
      if (initialized || duplicateInstance) clearInterval(timer);
    }, 500);
    globalThis.addEventListener?.("load", initialize);
  }
})();



