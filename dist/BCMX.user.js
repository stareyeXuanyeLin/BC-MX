// ==UserScript==
// @name         Bondage Club - BCMX（核心脚本）
// @name:zh-CN   Bondage Club - 地图功能强化（核心脚本）
// @namespace    https://github.com/stareyeXuanyeLin/BC-MX
// @version      0.3.3
// @description  Bondage Club 地图功能强化：本地存档、小地图、管理员传送与自由地图编辑器。
// @description:zh-CN 地图功能强化：本地保存与重建聊天室地图、小地图实时概览、管理员传送与自由地图编辑。
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
// @downloadURL  https://raw.githubusercontent.com/stareyeXuanyeLin/BC-MX/main/dist/BCMX.user.js
// @updateURL    https://raw.githubusercontent.com/stareyeXuanyeLin/BC-MX/main/dist/BCMX.user.js
// ==/UserScript==

(() => {
  "use strict";



  const MOD_NAME = "BCMX";
  const FULL_NAME = "BC Map eXtended";
  const VERSION = "0.3.3";
  const STORAGE_SCHEMA_VERSION = 1;
  const RECORD_STORAGE_VERSION = 1;
  // 文件格式标识沿用历史值（BC_MAP_SAVER_*），保证旧版本导出的文件可继续导入，反之亦然。
  const MAP_FILE_FORMAT = "BC_MAP_SAVER_MAP";
  const LIBRARY_FILE_FORMAT = "BC_MAP_SAVER_LIBRARY";
  const FILE_FORMAT_VERSION = 1;
  // 本地存储键沿用历史前缀（BC.MapSaver.v1），已安装用户的本地地图库不因改名而丢失。
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
    try {
      if (typeof ChatRoomPlayerIsAdmin === "function") return ChatRoomPlayerIsAdmin() === true;
    } catch (_) { /* fall through to legacy window property */ }
    return typeof globalThis.ChatRoomPlayerIsAdmin === "function" && globalThis.ChatRoomPlayerIsAdmin() === true;
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
    // 整图替换后编辑器工作副本已过期：关闭编辑器，避免单向覆盖把旧内容写回新地图。
    if (typeof closeEditor === "function") closeEditor();
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
    return { width: 40, height: 40 }; // 原版固定尺寸兜底
  }

  // 小地图与地图编辑器共用的视口数学。所有反算都必须先减平移量，再除缩放与格步长。
  function canvasEventToInternalXY(canvas, rect, clientX, clientY) {
    const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
    const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function viewportCanvasToGridXY(mx, my, view, grid, cellStep) {
    if (!grid || !view || !(cellStep > 0) || !(view.zoom > 0)) return null;
    const gx = Math.floor((mx - view.panX) / view.zoom / cellStep);
    const gy = Math.floor((my - view.panY) / view.zoom / cellStep);
    if (gx < 0 || gy < 0 || gx >= grid.width || gy >= grid.height) return null;
    return { x: gx, y: gy };
  }

  function viewportGridToCanvasXY(x, y, view, cellStep) {
    return {
      x: x * cellStep * view.zoom + view.panX,
      y: y * cellStep * view.zoom + view.panY,
    };
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
    if (!isCharacterMapViewActive(target)) throw new Error("目标玩家当前不在地图视角，无法传送");
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

  // ===== 小地图状态同步 =====
  // 坐标隐藏沿用 MapData.BMSHidden；地图视角状态写入原版允许扩展的 PrivateState，
  // 随正常 MapData 广播流转。接收端仅在插件侧维护角色状态，原版渲染不读取这些标记。

  // 隐藏状态存储键沿用历史前缀（BC.MapSaver.stealth），已开启隐藏的用户升级后状态保留。
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

  function isLocalMapViewActive() {
    if (globalThis.CurrentScreen !== "ChatRoom") return false;
    try {
      if (typeof ChatRoomMapViewIsActive === "function") return ChatRoomMapViewIsActive() === true;
    } catch (_) { /* fall through to legacy window property */ }
    return typeof globalThis.ChatRoomMapViewIsActive === "function" && globalThis.ChatRoomMapViewIsActive() === true;
  }

  // 自己读原版实时视图状态；远端玩家读取插件随 MapData 同步的状态标记。
  // 未安装插件或尚未上报状态的玩家按“不在地图视角”处理，避免发出必然失败的传送。
  function isCharacterMapViewActive(character) {
    if (!character) return false;
    if (Number(character.MemberNumber) === currentMemberNumber()) return isLocalMapViewActive();
    return character.BMSMapViewActive === true;
  }

  function applyStealthMarker(character, mapData) {
    if (!character) return;
    if (mapData?.BMSHidden === true) character.BMSHidden = true;
    else delete character.BMSHidden;
  }

  function applyMapViewPresenceMarker(character, mapData) {
    if (!character) return;
    if (mapData?.PrivateState?.BMSMapViewActive === true) character.BMSMapViewActive = true;
    else delete character.BMSMapViewActive;
  }

  // 同步本地地图状态：把持久化的隐藏开关重新映射回 MapData，覆盖重登/对象重建后
  // 新 MapData 丢失 BMSHidden 标记的情况；同时维护地图视角在线标记。
  // 任一字段变化或强制时立即广播一次，让房间内所有插件端感知。
  function syncLocalMapViewPresence(force = false) {
    const player = getPlayerCharacter();
    if (!player?.MapData) return false;
    const hidden = isStealthEnabled();
    const hiddenChanged = (player.MapData.BMSHidden === true) !== hidden;
    if (hidden) player.MapData.BMSHidden = true;
    else delete player.MapData.BMSHidden;
    const active = isLocalMapViewActive();
    const privateState = player.MapData.PrivateState && typeof player.MapData.PrivateState === "object"
      ? player.MapData.PrivateState
      : (player.MapData.PrivateState = {});
    const changed = (privateState.BMSMapViewActive === true) !== active || hiddenChanged;
    if (active) privateState.BMSMapViewActive = true;
    else delete privateState.BMSMapViewActive;
    if (active) player.BMSMapViewActive = true;
    else delete player.BMSMapViewActive;
    if (!changed && !force) return true;
    const serverSend = getServerSend();
    if (typeof serverSend === "function") {
      try {
        serverSend("ChatRoomCharacterMapDataUpdate", player.MapData);
      } catch (error) {
        warn("广播地图视角状态失败", error);
      }
    }
    return true;
  }

  // 接收端：跟随每次 MapData 同步识别隐藏标记，仅维护插件侧状态。
  // 注意消息结构差异：实时位置更新（ChatRoomSyncMapData）是平铺的 {MemberNumber, MapData}；
  // 进房/重同步/成员加入（ChatRoomSyncCharacter/SyncSingle/MemberJoin）是嵌套的 {Character: {...}}，
  // 且角色对象会被 CharacterLoadOnline 重建，必须每次同步都重新评估标记。
  function applyMapStateFromCharacterData(characterData) {
    if (!characterData || typeof characterData !== "object") return;
    const character = findRoomCharacter(characterData.MemberNumber);
    if (!character || character === getPlayerCharacter()) return;
    applyStealthMarker(character, characterData.MapData);
    applyMapViewPresenceMarker(character, characterData.MapData);
  }

  function installStealthHooks() {
    if (typeof globalThis.ChatRoomMapViewSyncMapData === "function") {
      modApi.hookFunction("ChatRoomMapViewSyncMapData", 0, (args, next) => {
        const result = next(args);
        try {
          const data = args[0];
          if (data && Number.isInteger(data?.MemberNumber)) {
            const character = findRoomCharacter(data.MemberNumber);
            if (character && character !== getPlayerCharacter()) {
              applyStealthMarker(character, data.MapData);
              applyMapViewPresenceMarker(character, data.MapData);
            }
          }
        } catch (error) {
          warn("同步小地图状态标记失败", error);
        }
        return result;
      });
    }
    for (const name of ["ChatRoomSyncCharacter", "ChatRoomSyncSingle", "ChatRoomSyncMemberJoin"]) {
      if (typeof globalThis[name] !== "function") continue;
      modApi.hookFunction(name, 0, (args, next) => {
        const result = next(args);
        try {
          applyMapStateFromCharacterData(args[0]?.Character);
        } catch (error) {
          warn(`同步小地图状态标记失败（${name}）`, error);
        }
        return result;
      });
    }
    // 本地切换聊天/地图视角后立即广播状态。ChatRoomActivateView 是统一切换入口，
    // 比直接 Hook MapView.Activate/Deactivate 更可靠，因为原版视图表持有的是早期函数引用。
    if (typeof globalThis.ChatRoomActivateView === "function") {
      modApi.hookFunction("ChatRoomActivateView", 1000, (args, next) => {
        const result = next(args);
        try { syncLocalMapViewPresence(); } catch (error) { warn("同步地图视角切换失败", error); }
        return result;
      });
    }
    // 有新成员加入时主动重广播一次当前标记，弥补服务器初始角色同步可能净化扩展字段的问题。
    if (typeof globalThis.ChatRoomSyncMemberJoin === "function") {
      modApi.hookFunction("ChatRoomSyncMemberJoin", 1000, (args, next) => {
        const result = next(args);
        try {
          if (!isStealthEnabled() && !isLocalMapViewActive()) return result;
          setTimeout(() => {
            try { syncLocalMapViewPresence(true); } catch (error) { warn("进房后重广播小地图状态失败", error); }
          }, 400);
        } catch (error) {
          warn("进房重广播小地图状态失败", error);
        }
        return result;
      });
    }
    syncLocalMapViewPresence();
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
  const MINIMAP_VERIFY_RETRY_DELAY_MS = 3000; // 校验失败后的复查等待：广播可能因原版 500ms 节流或网络延迟晚到，再等一轮避免误报
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
  let minimapSelected = null; // 恒有选中：默认自己，只能从左侧成员列表切换，异常时兜底重置为自己
  let minimapPending = null;
  let minimapFitted = false; // 打开后仅自动适配一次视图，之后保持用户视角
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
      #${MINIMAP_ID} .bms-mm-roster li.bms-mm-unavailable{cursor:not-allowed;opacity:.58}
      #${MINIMAP_ID} .bms-mm-dot{width:10px;height:10px;border-radius:50%;flex:none}
      #${MINIMAP_ID} .bms-mm-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${MINIMAP_ID} .bms-mm-pos{font-size:12px;color:#8fb3d8;font-family:Consolas,monospace}
      #${MINIMAP_ID} .bms-mm-me{font-size:11px;color:#ffd94d;border:1px solid #806a41;border-radius:999px;padding:0 6px}
      #${MINIMAP_ID} .bms-mm-hidden{font-size:11px;color:#ff9d9d;border:1px solid #7a4a26;border-radius:999px;padding:0 6px;flex:none}
      #${MINIMAP_ID} .bms-mm-offmap{font-size:11px;color:#b7c2d0;border:1px solid #536276;border-radius:999px;padding:0 6px;flex:none}
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

  // 包装共享视口函数，保留既有测试与模块内命名。
  function minimapEventToCanvasXY(canvas, rect, clientX, clientY) {
    return canvasEventToInternalXY(canvas, rect, clientX, clientY);
  }

  function minimapCanvasToGridXY(mx, my, view, grid) {
    return viewportCanvasToGridXY(mx, my, view, grid, minimapTileStep());
  }

  function minimapCanvasToGrid(mx, my) {
    return minimapCanvasToGridXY(mx, my, minimapView, minimapGrid);
  }

  function minimapGridToCanvas(x, y) {
    return viewportGridToCanvasXY(x, y, minimapView, minimapTileStep());
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
      .map(c => `${c.MemberNumber}:${c.MapData.Pos.X},${c.MapData.Pos.Y}:${isCharacterMapViewActive(c) ? 1 : 0}`).sort().join("|");
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
      const mapActive = isCharacterMapViewActive(character);
      const unavailable = hidden || !mapActive;
      const title = hidden
        ? "该玩家已隐藏坐标"
        : !mapActive
          ? "该玩家当前不在地图视角，不能选中、传送或交换位置"
          : admin ? "点击选中后传送" : "";
      return `<li data-member="${character.MemberNumber}" class="${isSelected ? "bms-mm-selected" : ""}${unavailable ? " bms-mm-unavailable" : ""}" title="${title}">
        <span class="bms-mm-dot" style="background:${isMe ? "#f5f9ff" : minimapPlayerColor(character)}"></span>
        <span class="bms-mm-name">${escapeHTML(name)}</span>
        ${hidden
          ? '<span class="bms-mm-hidden">🙈 隐藏中</span>'
          : !mapActive
            ? '<span class="bms-mm-offmap">聊天中</span>'
            : `<span class="bms-mm-pos">(${pos?.X ?? "-"}, ${pos?.Y ?? "-"})</span>`}
        ${isMe ? '<span class="bms-mm-me">我</span>' : ""}
      </li>`;
    }).join("") || '<li style="cursor:default;color:#7d93ad">房间内没有玩家</li>';
  }

  // 只能通过左侧成员列表切换唯一选中成员；地图上的玩家标记用于发起换位。
  // 选中状态永不取消，切换成员时清除上一名成员尚未确认的落点。
  function minimapSelectCharacter(memberNumber) {
    if (minimapSwapInProgress) return;
    if (!isRoomAdmin() && memberNumber !== currentMemberNumber()) return; // 非管理员只能选中自己
    const target = findRoomCharacter(memberNumber);
    if (!target) return;
    if (isCharacterHidden(target)) {
      toast("该玩家已隐藏坐标，无法选中或传送", "error");
      return;
    }
    if (!isCharacterMapViewActive(target)) {
      toast("该玩家当前不在地图视角，无法选中、传送或交换位置", "error");
      return;
    }
    minimapSelected = memberNumber;
    minimapPending = null;
    renderMinimapStatus();
    renderMinimapRoster();
    drawMinimap();
  }

  function minimapHandleRosterClick(memberNumber) {
    minimapSelectCharacter(memberNumber);
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
        html = `<div class="bms-mm-status">交换位置：<strong>${escapeHTML(aName)}</strong> ↔ <strong>${escapeHTML(bName)}</strong><br>再次点击 ${escapeHTML(bName)} 所在格子确认</div>
          <div class="bms-mm-actions">
            <button class="bms-mm-confirm" data-mm-action="swap">交换位置</button>
            <button data-mm-action="cancel">取消</button>
          </div>`;
      } else {
        const target = findRoomCharacter(minimapPending.member);
        const name = target?.Name ? String(target.Name) : `#${minimapPending.member}`;
        const warn = minimapPending.walkable ? "" : `<span class="bms-mm-bad">落点不可站人，玩家将被推挤到邻近位置</span>`;
        html = `<div class="bms-mm-status">传送 <strong>${escapeHTML(name)}</strong> 到 (${minimapPending.x}, ${minimapPending.y})${warn ? `<br>${warn}` : ""}<br>再次点击同一格子确认传送，右键取消目标</div>
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
          html = `<div class="bms-mm-status">已选中 <strong>${escapeHTML(name)}</strong> (${target.MapData?.Pos?.X}, ${target.MapData?.Pos?.Y})，点击地图选择目标格子，再次点击同一格子确认传送；右键取消目标。</div>
            <div class="bms-mm-actions"><button data-mm-action="cancel">取消目标</button></div>`;
        } else {
          html = `<div class="bms-mm-status">已选中 <strong>${escapeHTML(name)}</strong>（自己），点击可达格子选择传送目标，再次点击同一格子确认。</div>
            <div class="bms-mm-actions"><button data-mm-action="cancel">取消目标</button></div>`;
        }
      }
    } else if (admin) {
      html = `<div class="bms-mm-status">从左侧成员列表选择玩家，然后点击目标格子传送；点击地图上的其他玩家可发起换位。滚动缩放，拖拽平移。</div>`;
    } else {
      html = `<div class="bms-mm-status">只读概览：滚动缩放，拖拽平移。</div>`;
    }
    footer.innerHTML = html;
    footer.querySelector('[data-mm-action="confirm"]')?.addEventListener("click", () => confirmMinimapPending());
    footer.querySelector('[data-mm-action="swap"]')?.addEventListener("click", () => confirmMinimapPending());
    footer.querySelector('[data-mm-action="cancel"]')?.addEventListener("click", () => {
      minimapPending = null;
      renderMinimapStatus();
      renderMinimapRoster();
      drawMinimap();
    });
  }

  // 确认当前待确认操作：交换走三步换位，否则传送；选中状态保持不变。
  function confirmMinimapPending() {
    if (!minimapPending || minimapSwapInProgress) return;
    const { member, swapWith, x, y } = minimapPending;
    minimapPending = null;
    renderMinimapStatus();
    renderMinimapRoster();
    drawMinimap();
    if (swapWith != null) {
      swapPositionsAndVerify(member, swapWith);
    } else {
      teleportWithVerify(member, x, y);
    }
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
    if (!isCharacterMapViewActive(a) || !isCharacterMapViewActive(b)) {
      toast("只有当前处于地图视角的玩家才能交换位置", "error");
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
    minimapPending = null; // 选中保持：换位结束后仍选中发起方
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
      const verifySwapResult = () => {
        const aNow = findRoomCharacter(aMember);
        const bNow = findRoomCharacter(bMember);
        const aOk = aNow?.MapData?.Pos?.X === finalA.x && aNow?.MapData?.Pos?.Y === finalA.y;
        const bOk = bNow?.MapData?.Pos?.X === finalB.x && bNow?.MapData?.Pos?.Y === finalB.y;
        return { aNow, bNow, aOk, bOk };
      };
      const reportSwapResult = result => {
        if (!result.aNow || !result.bNow) {
          toast("目标已不在房间，换位可能未生效", "error");
        } else if (result.aOk && result.bOk) {
          toast("换位成功：双方已到达彼此原位置", "success");
        } else {
          toast("换位尚未完全同步：若目标处于聊天视图，切回地图视图后自动生效", "error");
        }
      };
      setTimeout(() => {
        const first = verifySwapResult();
        if (first.aOk && first.bOk) {
          reportSwapResult(first);
          finishSwap();
          return;
        }
        // 广播可能因原版节流或网络延迟晚到：复查一轮再下结论，避免误报失败
        setTimeout(() => {
          reportSwapResult(verifySwapResult());
          finishSwap();
        }, MINIMAP_VERIFY_RETRY_DELAY_MS);
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
      // 右键只取消尚未确认的落点，当前选中成员保持不变。
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
    if (minimapSwapInProgress || minimapSelected == null || !minimapGrid) return;
    const admin = isRoomAdmin();
    const selected = findRoomCharacter(minimapSelected);
    if (!selected || !isCharacterMapViewActive(selected)) {
      minimapSelected = currentMemberNumber(); // 目标离开房间/地图视角：兜底选回自己
      minimapPending = null;
      renderMinimapStatus();
      renderMinimapRoster();
      drawMinimap();
      return;
    }
    // 确认：换位按目标玩家本人（允许其走动后仍可确认），传送按同一格子
    if (minimapPending && minimapPending.member === minimapSelected) {
      if (minimapPending.swapWith != null) {
        const hit = findRoomCharacterAt(gx, gy);
        if (hit && hit.MemberNumber === minimapPending.swapWith) {
          confirmMinimapPending();
          return;
        }
      } else if (minimapPending.x === gx && minimapPending.y === gy) {
        confirmMinimapPending();
        return;
      }
    }
    const character = findRoomCharacterAt(gx, gy);
    if (character) {
      // 地图上的玩家标记不再切换选中；管理员点击另一名玩家时准备换位。
      if (character.MemberNumber === minimapSelected) return;
      if (!admin) {
        toast("只有房间管理员才能交换玩家位置", "error");
        return;
      }
      if (!isCharacterMapViewActive(character)) {
        toast("该玩家当前不在地图视角，无法交换位置", "error");
        return;
      }
      minimapPending = {
        member: minimapSelected,
        swapWith: character.MemberNumber,
        x: gx,
        y: gy,
        walkable: true,
      };
      renderMinimapStatus();
      drawMinimap();
      return;
    }
    const walkable = minimapGrid.walkable[gy * minimapGrid.width + gx] === 1;
    if (!admin) {
      // 非管理员：落点必须可正常行走抵达，否则拒绝
      const pos = selected.MapData?.Pos;
      const reachable = pos && isPositionReachable(minimapGrid, pos.X, pos.Y, gx, gy);
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
      if (!minimapFitted) {
        fitMinimapView();
        minimapFitted = true;
      }
    } else {
      minimapGrid = grid;
    }
    const sig = playerPositionSignature();
    if (sig !== minimapPlayerSig) {
      minimapPlayerSig = sig;
      const selected = minimapSelected != null ? findRoomCharacter(minimapSelected) : null;
      if (!selected || isCharacterHidden(selected) || !isCharacterMapViewActive(selected)) {
        minimapSelected = currentMemberNumber(); // 隐藏、离开地图视角或失效：兜底选回自己
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
    minimapFitted = false;
    minimapSelected = currentMemberNumber(); // 默认选中自己
    minimapPending = null;
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
        const selected = minimapSelected != null ? findRoomCharacter(minimapSelected) : null;
        if (!selected || isCharacterHidden(selected) || !isCharacterMapViewActive(selected)) minimapSelected = currentMemberNumber(); // 仅在原选中不可操作时兜底回自己
        minimapPending = null;
        minimapFitted = false; // 地图可能更换：重新适配视图
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



  // ===== 自由地图编辑器（第三功能模块） =====
  // 独立 DOM 浮窗：原版素材全图渲染、自由视口、分类素材库、画笔/橡皮与撤销重做。
  // 地图写入只修改 ChatRoomData.MapData 字符串，并调用原版刷新函数走原版延迟同步链路。

  const EDITOR_ID = "bms-editor";
  const EDITOR_ENTRY_BUTTON = Object.freeze({
    x: ENTRY_BUTTON.x,
    y: ENTRY_BUTTON.y + (ENTRY_BUTTON.height + 10) * 2,
    width: ENTRY_BUTTON.width,
    height: ENTRY_BUTTON.height,
  });
  const EDITOR_TILE_SIZE = 64;
  const EDITOR_ZOOM_MIN = 0.15;
  const EDITOR_ZOOM_MAX = 8;
  const EDITOR_HISTORY_LIMIT = 100;
  const EDITOR_RECENT_LIMIT = 12;
  const EDITOR_TICK_MS = 250;
  const EDITOR_LAYER_TILE = "tile";
  const EDITOR_LAYER_OBJECT = "object";
  const EDITOR_OBJECT_BLANK_ID = 100;
  const EDITOR_TOOL_BRUSH = "brush";
  const EDITOR_TOOL_ERASER = "eraser";
  const EDITOR_CATEGORY_LABELS = Object.freeze({
    Floor: "室内地面", FloorExterior: "室外地面", Wall: "墙壁", Water: "水面",
    FloorDecoration: "地面装饰", FloorDecorationThemed: "主题装饰", FloorDecorationParty: "派对装饰",
    FloorDecorationCamping: "露营装饰", FloorDecorationExpanding: "扩展装饰", FloorDecorationAnimal: "动物装饰",
    FloorItem: "大型设施", FloorObstacle: "障碍物", FloorNumber: "数字", FloorLetter: "字母", FloorIcon: "地面图标",
    WallDecoration: "墙面装饰", WallPath: "门与通道", Banners: "旗帜",
  });
  const EDITOR_STYLE_LABELS = Object.freeze({
    OakWood: "橡木地板", Stone: "石材", Pavement: "铺路砖", Ceramic: "浅色陶瓷", CeramicDark: "深色陶瓷",
    CarpetPink: "粉色地毯", CarpetBlue: "蓝色地毯", CarpetRed: "红色地毯", Padded: "软垫", LatexFloor: "乳胶地板",
    Tile: "瓷砖", HexBlue: "蓝色六边形", HexPurple: "紫色六边形", Machine: "机械地板", HalfWall: "半墙",
    Dirt: "泥土", Grass: "草地", LongGrass: "茂密草地", Sand: "沙地", Gravel: "碎石地", Asphalt: "沥青地",
    Snow: "雪地", StoneSquareGray: "灰色方石", ScatteredLeaves: "散落树叶", ScatteredLeavesDirt: "泥地落叶", ScatteredLeavesThick: "浓密落叶",
    MixedWood: "混合木墙", CedarWood: "雪松木墙", Log: "原木墙", Japanese: "日式墙", Brick: "砖墙", Dungeon: "地牢墙",
    Square: "方块墙", Steel: "钢墙", Lattice: "格栅墙", PipeBlue: "蓝色管线墙", PipePurple: "紫色管线墙", SteelBlack: "黑色钢墙", SteelGary: "灰色钢墙",
    Pool: "泳池水", Sea: "海水", Ocean: "海洋", OceanCyan: "青色海洋", OceanCalm: "平静海面", Swamp: "沼泽", Waves: "波浪", Shallow: "浅水", Lava: "熔岩",
    EntryFlag: "入口旗", ExitFlag: "出口旗", BedTeal: "青绿色床", PillowPink: "粉色枕头", TableBrown: "棕色桌子", ChairWood: "木椅",
    ThroneRed: "红色王座", KeyBronze: "青铜钥匙", KeySilver: "白银钥匙", KeyGold: "黄金钥匙", VikingChair: "维京椅", Bed: "床", Stairs: "楼梯", AirConditioner: "空调",
    TeacherDesk: "讲台", StudentDesk: "课桌", SinkDishes: "餐具水槽", LaundryMachine: "洗衣机", IroningBoard: "熨衣板", ShibariFrame: "绳缚架",
    JapaneseTable: "日式矮桌", BanzaiTree: "盆景树", MedicalDesk: "医疗桌", Toilet: "马桶", DeskBlue: "蓝色桌子", DeskPurple: "紫色桌子",
    ConsoleLeft: "控制台左段", ConsoleRight: "控制台右段", LongDeskLeft: "长桌左段", LongDeskRight: "长桌右段", Cabinet: "柜子",
    Television: "电视正面", TelevisionBack: "电视背面", Wardrobe: "衣柜", StandingBellflowerBanner: "立式桔梗旗", BondageClubBanner: "拘束俱乐部旗",
    VoidOrderBanner: "虚空教团旗", KatanaOnStand: "刀架上的武士刀", MagicMark: "魔法印记",
    BalloonFiveColor: "五色气球", BalloonTwoHeart: "双爱心气球", WeddingCake: "婚礼蛋糕", WeddingArch: "婚礼拱门", FlowerVasePink: "粉色花瓶",
    BeachUmbrellaStripe: "条纹沙滩伞", BeachTowelStripe: "条纹沙滩巾", Speaker: "音箱", Presents: "礼物堆",
    LogFire: "原木篝火", LogFireAnim0: "动态原木篝火", LogSingle: "单根原木", TentBlue: "蓝色帐篷", SleepingBagBlue: "蓝色睡袋", ChairRed: "红色椅子",
    Hurdle1: "障碍栏一", Hurdle2: "障碍栏二", Hurdle3: "障碍栏三", CouchPinkPreview: "粉色沙发组合", BedBluePreview: "蓝色床组合",
    BallPitPreview: "海洋球池组合", VikingTablePreview: "维京桌组合", RailroadPreview: "铁路组合",
    CatCaramelHappy: "开心的焦糖色猫", DogBrownHappy: "开心的棕色狗", RabbitBrownStand: "站立的棕色兔", ChickenBrownIdleLeft: "向左待机的棕色鸡",
    Kennel: "狗笼", "X-Cross": "X 形架", BondageBench: "拘束长凳", Trolley: "推车", Locker: "储物柜", WoodenBox: "木箱", Coffin: "棺材",
    TheDisplayFrame: "展示架", Pole: "立柱", MedicalBed: "医疗床", FuturisticCrate: "未来风货箱",
    Stalagmite: "石笋", Rocks: "岩石", GoldStones: "金色石块", StonePile: "石堆", Statue: "雕像", Knight: "骑士像", Samurai: "武士像", Totem: "图腾",
    EasterIsland: "复活节岛石像", OrderOfTheVoidTotem: "虚空教团图腾", Barrel: "木桶", Chest: "宝箱", IronBars: "铁栅栏", BarbFence: "铁丝围栏",
    PicketFence: "尖桩围栏", VelourRopeBarrier: "丝绒绳护栏", Bush: "灌木", OakTree: "橡树", OakTree_Fall: "倒下的橡树", LeaflessTree: "枯树",
    PineTree: "松树", PalmTree: "棕榈树", Sakura: "樱花树", Cactus: "仙人掌", ChristmasTree: "圣诞树", Window: "窗户", TrashCan: "垃圾桶",
    RoadCone: "路锥", LampPost: "路灯", Pillar: "立柱", Painting: "画作", Mirror: "镜子", Candelabra0: "烛台", Whip: "鞭子", Fireplace: "壁炉",
    Stocking: "圣诞袜", Moss: "苔藓", Vines: "藤蔓", Vines2: "茂密藤蔓", SilverShield: "银色盾牌", CrossedSabers: "交叉军刀",
    WindowNight: "夜景窗户", StainedGlass: "彩绘玻璃", SchoolBoard: "学校黑板", FirstAidKit: "急救箱", EyeTest: "视力表", Scroll: "卷轴",
    Wanted: "通缉令", Bookshelf: "书架", ShowerHead: "淋浴喷头", EnemaHead: "灌肠喷头", MonitorSmall: "小显示器", MonitorBigLeft: "大显示器左段", MonitorBigRight: "大显示器右段",
    WoodOpen: "木门打开", WoodClosed: "木门关闭", WoodLocked: "木门上锁", WoodLockedBronze: "青铜锁木门", WoodLockedSilver: "白银锁木门", WoodLockedGold: "黄金锁木门",
    Metal: "金属门", MetalUp: "金属门上段", MetalDown: "金属门下段", MetalLockedBronze: "青铜锁金属门", MetalLockedSilver: "白银锁金属门", MetalLockedGold: "黄金锁金属门",
    BrownDoor: "棕色门", BrownDoorOpen: "打开的棕色门", RoyalDoor: "皇家门", RoyalDoorOpen: "打开的皇家门", SteelDoor: "钢门", SteelDoorOpen: "打开的钢门", GrayDoor: "灰色门", GrayDoorOpen: "打开的灰色门",
    Red: "红色旗帜", Blue: "蓝色旗帜", Green: "绿色旗帜", Yellow: "黄色旗帜", Black: "黑色旗帜", PaladinBanner: "圣骑士团旗",
    ServiOrdinisBanner: "秩序仆从旗", BellflowerBanner: "桔梗旗", BondageClub: "拘束俱乐部旗", Inquisition: "审判庭旗",
    MagesSacrosanctorum: "神圣法师团旗", MaidSorority: "女仆姐妹会旗", Priesthood: "祭司团旗", VoidOrder: "虚空教团旗",
  });

  let editorOpen = false;
  let editorView = { zoom: 1, panX: 0, panY: 0 };
  let editorTool = EDITOR_TOOL_BRUSH;
  let editorLayer = EDITOR_LAYER_TILE;
  let editorBrushSize = 1;
  let editorGridVisible = true;
  let editorSelected = null;
  let editorCategory = { tile: "", object: "" };
  let editorQuery = "";
  let editorHover = null;
  let editorPointer = null;
  let editorPanelDrag = null;
  let editorSpaceDown = false;
  let editorHistory = createEditorHistory();
  let editorWorking = null; // 编辑器权威工作副本：打开时快照，渲染与撤销都以它为准，单向覆盖地图
  let editorMaterials = { tile: [], object: [] };
  let editorRecent = [];
  let editorLastTick = 0;
  let editorOffscreen = null;
  let editorRenderQueued = false;
  let editorSyncNoticeShown = false;
  let editorImageFailures = 0;
  const editorImageCache = new Map();

  function getChatRoomMapViewTileList() {
    try {
      if (typeof ChatRoomMapViewTileList !== "undefined") return ChatRoomMapViewTileList;
    } catch (_) { /* fall through */ }
    return globalThis.ChatRoomMapViewTileList ?? null;
  }

  function getChatRoomMapViewObjectList() {
    try {
      if (typeof ChatRoomMapViewObjectList !== "undefined") return ChatRoomMapViewObjectList;
    } catch (_) { /* fall through */ }
    return globalThis.ChatRoomMapViewObjectList ?? null;
  }

  function getChatRoomMapViewEditMode() {
    try {
      if (typeof ChatRoomMapViewEditMode !== "undefined") return ChatRoomMapViewEditMode;
    } catch (_) { /* fall through */ }
    return globalThis.ChatRoomMapViewEditMode ?? "";
  }

  function getInventoryAvailable() {
    try {
      if (typeof InventoryAvailable === "function") return InventoryAvailable;
    } catch (_) { /* fall through */ }
    return typeof globalThis.InventoryAvailable === "function" ? globalThis.InventoryAvailable : null;
  }

  function getOriginalMapRefreshFunctions() {
    let update = null;
    let masks = null;
    try {
      if (typeof ChatRoomMapViewUpdateFlag === "function") update = ChatRoomMapViewUpdateFlag;
    } catch (_) { /* fall through */ }
    try {
      if (typeof ChatRoomMapViewCalculatePerceptionMasks === "function") masks = ChatRoomMapViewCalculatePerceptionMasks;
    } catch (_) { /* fall through */ }
    return {
      update: update ?? globalThis.ChatRoomMapViewUpdateFlag,
      masks: masks ?? globalThis.ChatRoomMapViewCalculatePerceptionMasks,
    };
  }

  function lookupValues(lookup) {
    if (!lookup || typeof lookup !== "object") return [];
    const values = Array.isArray(lookup) ? lookup : Object.values(lookup);
    const seen = new Set();
    const result = [];
    for (const value of values) {
      if (!value || !Number.isInteger(value.ID) || seen.has(value.ID)) continue;
      seen.add(value.ID);
      result.push(value);
    }
    return result;
  }

  function editorMaterialOwned(definition, player = getPlayerCharacter(), inventoryAvailable = getInventoryAvailable()) {
    if (!definition?.AssetName || !definition?.AssetGroup) return true;
    if (typeof inventoryAvailable !== "function" || !player) return false;
    try {
      return inventoryAvailable(player, definition.AssetName, definition.AssetGroup) === true;
    } catch (_) {
      return false;
    }
  }

  function editorStyleLabel(style, id) {
    const name = String(style || "");
    if (EDITOR_STYLE_LABELS[name]) return EDITOR_STYLE_LABELS[name];
    let match = /^Number(\d)$/.exec(name);
    if (match) return `数字 ${match[1]}`;
    match = /^Letter([A-Z])$/.exec(name);
    if (match) return `字母 ${match[1]}`;
    const iconLabels = {
      IconCircle: "圆形图标", IconSquare: "方形图标", IconTriangle: "三角形图标", IconCross: "叉号图标", IconDiamond: "菱形图标",
      IconArrowUp: "向上箭头", IconArrowDown: "向下箭头", IconArrowLeft: "向左箭头", IconArrowRight: "向右箭头",
    };
    return iconLabels[name] || `素材 ${id}`;
  }

  function buildEditorMaterials(layer, lookup, player = getPlayerCharacter(), inventoryAvailable = getInventoryAvailable()) {
    return lookupValues(lookup)
      .filter(item => layer !== EDITOR_LAYER_OBJECT || (item.ID !== EDITOR_OBJECT_BLANK_ID && item.Style !== "Blank"))
      .map(item => ({
        id: item.ID,
        layer,
        type: String(item.Type || "Other"),
        style: String(item.Style || item.ID),
        label: editorStyleLabel(item.Style, item.ID),
        owned: layer === EDITOR_LAYER_TILE || editorMaterialOwned(item, player, inventoryAvailable),
        unique: item.Unique === true,
        definition: item,
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id);
  }

  function filterEditorMaterials(materials, category, query = "") {
    const normalized = String(query).trim().toLocaleLowerCase();
    return materials.filter(material => {
      if (!normalized && category && category !== "recent" && material.type !== category) return false;
      if (!normalized) return true;
      return `${material.type} ${material.style} ${material.label} ${material.id}`.toLocaleLowerCase().includes(normalized);
    });
  }

  function editorMaterialPath(material) {
    if (!material) return "";
    const base = material.layer === EDITOR_LAYER_TILE ? "MapTile" : "MapObject";
    return `Screens/Online/ChatRoom/${base}/${material.type}/${material.style}.png`;
  }

  function editorSnapshot(mapData) {
    return { Tiles: String(mapData?.Tiles ?? ""), Objects: String(mapData?.Objects ?? "") };
  }

  function createEditorHistory() {
    return { undo: [], redo: [] };
  }

  function editorPushUndo(history, mapData) {
    if (!history || !mapData) return false;
    const snapshot = editorSnapshot(mapData);
    const last = history.undo[history.undo.length - 1];
    if (!last || last.Tiles !== snapshot.Tiles || last.Objects !== snapshot.Objects) {
      history.undo.push(snapshot);
      if (history.undo.length > EDITOR_HISTORY_LIMIT) history.undo.shift();
    }
    history.redo.length = 0;
    return true;
  }

  function editorRestoreSnapshot(mapData, snapshot) {
    if (!mapData || !snapshot || typeof snapshot.Tiles !== "string" || typeof snapshot.Objects !== "string") return false;
    mapData.Tiles = snapshot.Tiles;
    mapData.Objects = snapshot.Objects;
    return true;
  }

  function editorUndoMap(history, mapData) {
    if (!history?.undo?.length || !mapData) return false;
    history.redo.push(editorSnapshot(mapData));
    if (history.redo.length > EDITOR_HISTORY_LIMIT) history.redo.shift();
    return editorRestoreSnapshot(mapData, history.undo.pop());
  }

  function editorRedoMap(history, mapData) {
    if (!history?.redo?.length || !mapData) return false;
    history.undo.push(editorSnapshot(mapData));
    if (history.undo.length > EDITOR_HISTORY_LIMIT) history.undo.shift();
    return editorRestoreSnapshot(mapData, history.redo.pop());
  }

  function editorBrushCells(cx, cy, range, width, height) {
    const cells = [];
    const side = Math.max(1, Math.min(5, Math.floor(Number(range) || 1)));
    // 指针格固定为左上角，画笔数字严格对应 N×N；偶数尺寸不再产生方向歧义。
    for (let y = cy; y < cy + side; y++) {
      for (let x = cx; x < cx + side; x++) {
        if (x >= 0 && y >= 0 && x < width && y < height) cells.push({ x, y, index: y * width + x });
      }
    }
    return cells;
  }

  function replaceEncodedCell(encoded, index, id) {
    return encoded.substring(0, index) + String.fromCharCode(id) + encoded.substring(index + 1);
  }

  function applyEditorStroke(mapData, layer, id, cells, definition = null) {
    if (!mapData || !Array.isArray(cells) || cells.length === 0) return false;
    const key = layer === EDITOR_LAYER_OBJECT ? "Objects" : "Tiles";
    const source = mapData[key];
    if (typeof source !== "string" || source.length === 0) return false;
    const writeId = Number(id);
    if (!Number.isInteger(writeId) || writeId < 0 || writeId > 0xFFFF) return false;
    let next = source;
    const valid = cells.filter(cell => Number.isInteger(cell?.index) && cell.index >= 0 && cell.index < source.length);
    if (valid.length === 0) return false;

    if (layer === EDITOR_LAYER_OBJECT && definition?.Unique === true && writeId !== EDITOR_OBJECT_BLANK_ID) {
      const blank = String.fromCharCode(EDITOR_OBJECT_BLANK_ID);
      const target = String.fromCharCode(writeId);
      next = next.split(target).join(blank);
      const cell = valid[0]; // 对齐原版：Unique 只写画笔选区中的第一个有效格
      next = replaceEncodedCell(next, cell.index, writeId);
    } else {
      for (const cell of valid) next = replaceEncodedCell(next, cell.index, writeId);
    }
    if (next === source) return false;
    mapData[key] = next;
    return true;
  }

  function editorCanvasToGridXY(mx, my, view, size) {
    return viewportCanvasToGridXY(mx, my, view, size, EDITOR_TILE_SIZE);
  }

  function editorGridToCanvasXY(x, y, view) {
    return viewportGridToCanvasXY(x, y, view, EDITOR_TILE_SIZE);
  }

  function shouldShowEditor() {
    return globalThis.CurrentScreen === "ChatRoom"
      && isMapRoom()
      && isRoomAdmin()
      && isLocalMapViewActive();
  }

  function shouldDrawEditorEntryButton() {
    return shouldShowEditor() && getChatRoomMapViewEditMode() === "";
  }

  function editorMapData() {
    return getChatRoomData()?.MapData ?? null;
  }

  // 编辑器权威副本：绘制、撤销与渲染都只读写 editorWorking；对外部同步只做单向覆盖。
  function editorSnapshotWorking() {
    const mapData = editorMapData();
    if (!mapData) return null;
    return { Tiles: String(mapData.Tiles ?? ""), Objects: String(mapData.Objects ?? "") };
  }

  // 单向覆盖：把编辑器工作副本写回 ChatRoomData.MapData（游戏画面与原版发送链路读到的都是它）。
  // 可选传入 working 参数便于测试；运行时使用模块工作副本。
  function editorPushWorkingToMap(working = editorWorking) {
    const mapData = editorMapData();
    if (!mapData || !working) return false;
    if (mapData.Tiles === working.Tiles && mapData.Objects === working.Objects) return false;
    mapData.Tiles = working.Tiles;
    mapData.Objects = working.Objects;
    return true;
  }

  // 按原版 ChatRoomMapViewUpdateFlag 的清理规则预检物件落点，避免画出必被原版清除的内容。
  function editorObjectCellCompatible(tiles, x, y, width, height, definition, tileLookup) {
    if (!definition || definition.Style === "Blank") return false;
    const index = y * width + x;
    const tile = tileLookup?.[tiles.charCodeAt(index)];
    if (!tile) return false;
    const floorTypes = ["FloorDecoration", "FloorDecorationThemed", "FloorDecorationParty", "FloorDecorationCamping", "FloorDecorationExpanding", "FloorItem", "FloorObstacle"];
    if (floorTypes.includes(definition.Type) && tile.Type !== "Floor" && tile.Type !== "FloorExterior") return false;
    if (["WallDecoration", "Banners", "WallPath"].includes(definition.Type) && tile.Type !== "Wall") return false;
    if (tile.Type === "Wall" && y + 1 < height) {
      const below = tileLookup?.[tiles.charCodeAt((y + 1) * width + x)];
      if (below?.Type === "Wall") return false;
    }
    return true;
  }

  function notifyEditorMapChanged() {
    const refresh = getOriginalMapRefreshFunctions();
    if (typeof refresh.update !== "function" || typeof refresh.masks !== "function") {
      throw new Error("当前 BC 版本缺少地图刷新接口");
    }
    refresh.update();
    refresh.masks();
    mapGridCache = null;
    minimapDirty = true;
    queueEditorMapRender();
    if (!editorSyncNoticeShown) {
      editorSyncNoticeShown = true;
      toast("修改已交给 BC 原版同步，通常约 5 秒后全房间生效", "success");
    }
  }

  function editorApplyAt(gx, gy) {
    assertRoomMapAction(); // 每次落笔重新验权，避免打开后权限变化绕过入口检查
    const mapData = editorMapData();
    if (!mapData || !editorWorking) return false;
    const size = getChatRoomMapViewSize();
    const erasing = editorTool === EDITOR_TOOL_ERASER;
    const material = editorSelected?.layer === editorLayer ? editorSelected : null;
    if (!erasing && !material) return false;
    let cells = editorBrushCells(gx, gy, editorBrushSize, size.width, size.height);
    const id = erasing
      ? (editorLayer === EDITOR_LAYER_OBJECT ? EDITOR_OBJECT_BLANK_ID : 0)
      : material.id;
    if (!erasing && editorLayer === EDITOR_LAYER_OBJECT && material.definition) {
      const tileLookup = getChatRoomMapViewTileLookup();
      cells = cells.filter(cell => editorObjectCellCompatible(editorWorking.Tiles, cell.x, cell.y, size.width, size.height, material.definition, tileLookup));
    }
    const changed = applyEditorStroke(editorWorking, editorLayer, id, cells, erasing ? null : material.definition);
    if (!changed) {
      if (!erasing && editorLayer === EDITOR_LAYER_OBJECT && cells.length === 0) toast("该物件不能放置在当前地块上", "error");
      return false;
    }
    editorPushWorkingToMap();
    notifyEditorMapChanged();
    return changed;
  }

  function syncEditorMaterials() {
    const tileList = getChatRoomMapViewTileList();
    const objectList = getChatRoomMapViewObjectList();
    editorMaterials.tile = buildEditorMaterials(EDITOR_LAYER_TILE, tileList ?? getChatRoomMapViewTileLookup());
    editorMaterials.object = buildEditorMaterials(EDITOR_LAYER_OBJECT, objectList ?? getChatRoomMapViewObjectLookup());
    for (const layer of [EDITOR_LAYER_TILE, EDITOR_LAYER_OBJECT]) {
      const types = [...new Set(editorMaterials[layer].map(item => item.type))];
      if (!types.includes(editorCategory[layer])) editorCategory[layer] = types[0] ?? "";
    }
    if (editorSelected) {
      editorSelected = editorMaterials[editorSelected.layer].find(item => item.id === editorSelected.id) ?? null;
    }
  }

  function injectEditorStyle() {
    if (document.getElementById("bms-editor-style")) return;
    const style = document.createElement("style");
    style.id = "bms-editor-style";
    style.textContent = `
      #${EDITOR_ID}{position:fixed;z-index:99992;width:calc(100vw - 16px);height:calc(100vh - 16px);background:#111d31;border:1px solid #45678f;border-radius:12px;box-shadow:0 18px 52px rgba(0,0,0,.6);font-family:Inter,"Microsoft YaHei",sans-serif;color:#eaf2ff;user-select:none;overflow:hidden;display:flex;flex-direction:column}
      #${EDITOR_ID} *{box-sizing:border-box}
      #${EDITOR_ID} button,#${EDITOR_ID} input{font:inherit}
      #${EDITOR_ID} .bms-ed-header{height:46px;display:flex;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(135deg,#1b3151,#17243b);border-bottom:1px solid #385576;cursor:move;touch-action:none;flex:none}
      #${EDITOR_ID} .bms-ed-title{font-size:16px;font-weight:750;letter-spacing:.03em}
      #${EDITOR_ID} .bms-ed-room{font-size:12px;color:#9eb4ce;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${EDITOR_ID} .bms-ed-spacer{flex:1}
      #${EDITOR_ID} button{appearance:none;border:1px solid #4b6e98;border-radius:7px;background:#203858;color:#f2f7ff;cursor:pointer}
      #${EDITOR_ID} button:hover:not(:disabled){background:#2b4a72;border-color:#78a5d8}
      #${EDITOR_ID} button:disabled{opacity:.42;cursor:not-allowed}
      #${EDITOR_ID} button.bms-ed-active{background:#2b4a72;border-color:#78a5d8;box-shadow:inset 0 0 0 1px rgba(120,165,216,.35)}
      #${EDITOR_ID} .bms-ed-header button{width:30px;height:30px;font-size:14px;flex:none}
      #${EDITOR_ID} .bms-ed-body{display:grid;grid-template-columns:minmax(520px,1fr) clamp(400px,32vw,560px);gap:10px;padding:10px;min-height:0;flex:1}
      #${EDITOR_ID} .bms-ed-workspace{min-width:0;display:flex;flex-direction:column;gap:8px}
      #${EDITOR_ID} .bms-ed-tools{display:flex;align-items:center;gap:6px;min-height:38px;padding:5px 7px;border:1px solid #2c425d;border-radius:7px;background:#0f1a2c;overflow-x:auto}
      #${EDITOR_ID} .bms-ed-tools button{height:28px;padding:0 10px;white-space:nowrap;font-size:12px}
      #${EDITOR_ID} .bms-ed-tools .bms-ed-size{width:28px;padding:0}
      #${EDITOR_ID} .bms-ed-divider{width:1px;height:22px;background:#385576;flex:none;margin:0 2px}
      #${EDITOR_ID} .bms-ed-canvas-wrap{position:relative;min-height:0;flex:1;border:1px solid #2c425d;border-radius:7px;background:#09111e;overflow:hidden}
      #${EDITOR_ID} .bms-ed-canvas{display:block;width:100%;height:100%;touch-action:none;overscroll-behavior:none;cursor:crosshair}
      #${EDITOR_ID} .bms-ed-canvas.bms-ed-panning{cursor:grabbing}
      #${EDITOR_ID} .bms-ed-coordinate{position:absolute;left:8px;bottom:8px;padding:3px 7px;border-radius:5px;background:rgba(5,11,20,.78);color:#9edcff;font:12px Consolas,monospace;pointer-events:none}
      #${EDITOR_ID} .bms-ed-canvas-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:320px;text-align:center;color:#9eb4ce;background:rgba(9,17,30,.86);border:1px solid #385576;border-radius:8px;padding:10px 14px;pointer-events:none}
      #${EDITOR_ID} .bms-ed-palette{display:flex;flex-direction:column;min-width:0;min-height:0;border:1px solid #2c425d;border-radius:7px;background:#0f1a2c;overflow:hidden}
      #${EDITOR_ID} .bms-ed-layer-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px;border-bottom:1px solid #2c425d}
      #${EDITOR_ID} .bms-ed-layer-tabs button{height:34px;font-weight:700}
      #${EDITOR_ID} .bms-ed-categories{display:flex;flex-wrap:wrap;align-content:flex-start;gap:6px;padding:8px;border-bottom:1px solid #2c425d;flex:none}
      #${EDITOR_ID} .bms-ed-categories button{height:28px;padding:0 10px;white-space:nowrap;font-size:12px;flex:0 0 auto}
      #${EDITOR_ID} .bms-ed-search-wrap{padding:8px;border-bottom:1px solid #2c425d}
      #${EDITOR_ID} .bms-ed-search{width:100%;height:32px;border:1px solid #385576;border-radius:7px;background:#0a1423;color:#eaf2ff;padding:0 10px;outline:none;user-select:text}
      #${EDITOR_ID} .bms-ed-search:focus{border-color:#78a5d8}
      #${EDITOR_ID} .bms-ed-assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));align-content:start;gap:8px;padding:8px;overflow-y:auto;min-height:0;flex:1}
      #${EDITOR_ID} .bms-ed-asset{position:relative;height:68px;padding:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:0}
      #${EDITOR_ID} .bms-ed-asset img{width:45px;height:45px;object-fit:contain;image-rendering:auto;pointer-events:none}
      #${EDITOR_ID} .bms-ed-asset span{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:#b9cde6;text-align:center}
      #${EDITOR_ID} .bms-ed-asset.bms-ed-selected{border:2px solid #78a5d8;background:#2b4a72;box-shadow:0 0 10px rgba(98,211,255,.25)}
      #${EDITOR_ID} .bms-ed-asset.bms-ed-selected::after{content:"✓";position:absolute;right:3px;top:1px;color:#62d3ff;font-size:11px}
      #${EDITOR_ID} .bms-ed-asset.bms-ed-locked{filter:grayscale(1);opacity:.45}
      #${EDITOR_ID} .bms-ed-empty{grid-column:1/-1;color:#8095ae;text-align:center;padding:24px 8px;font-size:12px}
      #${EDITOR_ID} .bms-ed-selection{padding:8px 10px;min-height:38px;border-top:1px solid #2c425d;color:#9eb4ce;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}
      #${EDITOR_ID} .bms-ed-selection strong{color:#8fd0ff}
      #${EDITOR_ID} .bms-ed-status{height:34px;padding:7px 12px;border-top:1px solid #385576;background:#0d1829;color:#9eb4ce;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:none}
      #${EDITOR_ID} .bms-ed-status .bms-ed-warn{color:#ffc981}
      @media(max-width:1050px){#${EDITOR_ID} .bms-ed-body{grid-template-columns:minmax(400px,1fr) minmax(340px,42vw)}}
    `;
    document.head.appendChild(style);
  }

  function ensureEditorRoot() {
    let root = document.getElementById(EDITOR_ID);
    if (root) return root;
    root = document.createElement("section");
    root.id = EDITOR_ID;
    root.innerHTML = `
      <header class="bms-ed-header">
        <span class="bms-ed-title">地图编辑器</span><span class="bms-ed-room"></span><span class="bms-ed-spacer"></span>
        <button data-ed="grid" title="显示或隐藏网格">▦</button><button data-ed="fit" title="整图适配">⤢</button><button data-ed="close" title="关闭">×</button>
      </header>
      <div class="bms-ed-body">
        <main class="bms-ed-workspace">
          <nav class="bms-ed-tools">
            <button data-tool="brush">画笔</button><button data-tool="eraser">橡皮</button><span class="bms-ed-divider"></span>
            <span style="font-size:12px;color:#9eb4ce;white-space:nowrap">大小</span>
            ${[1, 2, 3, 4, 5].map(size => `<button class="bms-ed-size" data-size="${size}">${size}</button>`).join("")}
            <span class="bms-ed-divider"></span><button data-ed="undo">撤销</button><button data-ed="redo">重做</button>
          </nav>
          <div class="bms-ed-canvas-wrap"><canvas class="bms-ed-canvas"></canvas><div class="bms-ed-coordinate">—</div><div class="bms-ed-canvas-hint">请先从右侧选择一种地块或物件</div></div>
        </main>
        <aside class="bms-ed-palette">
          <nav class="bms-ed-layer-tabs"><button data-layer="tile">地块</button><button data-layer="object">物件</button></nav>
          <div class="bms-ed-categories"></div>
          <div class="bms-ed-search-wrap"><input class="bms-ed-search" type="search" maxlength="60" placeholder="搜索类型、样式或 ID"></div>
          <div class="bms-ed-assets"></div><div class="bms-ed-selection"></div>
        </aside>
      </div><footer class="bms-ed-status"></footer>`;
    root.style.left = "8px";
    root.style.top = "8px";
    document.body.appendChild(root);

    const header = root.querySelector(".bms-ed-header");
    header.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest?.("button")) return;
      editorPanelDrag = { startX: event.clientX, startY: event.clientY, left: root.offsetLeft, top: root.offsetTop };
      header.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    header.addEventListener("pointermove", event => {
      if (!editorPanelDrag) return;
      const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - root.offsetHeight);
      root.style.left = `${Math.max(0, Math.min(maxLeft, editorPanelDrag.left + event.clientX - editorPanelDrag.startX))}px`;
      root.style.top = `${Math.max(0, Math.min(maxTop, editorPanelDrag.top + event.clientY - editorPanelDrag.startY))}px`;
    });
    header.addEventListener("pointerup", () => { editorPanelDrag = null; });
    header.addEventListener("pointercancel", () => { editorPanelDrag = null; });

    root.addEventListener("click", editorHandleRootClick);
    root.querySelector(".bms-ed-search").addEventListener("input", event => {
      editorQuery = String(event.target.value || "");
      renderEditorPalette();
    });
    const canvas = root.querySelector(".bms-ed-canvas");
    canvas.addEventListener("wheel", editorHandleWheel, { passive: false });
    canvas.addEventListener("pointerdown", editorHandlePointerDown);
    canvas.addEventListener("pointermove", editorHandlePointerMove);
    canvas.addEventListener("pointerup", editorHandlePointerUp);
    canvas.addEventListener("pointercancel", editorHandlePointerUp);
    canvas.addEventListener("pointerleave", () => { editorHover = null; updateEditorCoordinate(); drawEditorViewport(); });
    canvas.addEventListener("contextmenu", event => event.preventDefault());
    return root;
  }

  function editorHandleRootClick(event) {
    const action = event.target.closest?.("[data-ed]")?.dataset.ed;
    if (action === "close") closeEditor();
    else if (action === "fit") fitEditorView();
    else if (action === "grid") { editorGridVisible = !editorGridVisible; renderEditorControls(); queueEditorMapRender(); }
    else if (action === "undo") editorPerformHistory("undo");
    else if (action === "redo") editorPerformHistory("redo");

    const tool = event.target.closest?.("[data-tool]")?.dataset.tool;
    if ([EDITOR_TOOL_BRUSH, EDITOR_TOOL_ERASER].includes(tool)) {
      editorTool = tool;
      renderEditorControls();
      drawEditorViewport();
    }
    const size = Number(event.target.closest?.("[data-size]")?.dataset.size);
    if (Number.isInteger(size) && size >= 1 && size <= 5) {
      editorBrushSize = size;
      renderEditorControls();
      drawEditorViewport();
    }
    const layer = event.target.closest?.("[data-layer]")?.dataset.layer;
    if ([EDITOR_LAYER_TILE, EDITOR_LAYER_OBJECT].includes(layer)) {
      editorLayer = layer;
      editorSelected = editorSelected?.layer === layer ? editorSelected : null;
      editorQuery = "";
      const input = document.querySelector(`#${EDITOR_ID} .bms-ed-search`);
      if (input) input.value = "";
      renderEditorPalette();
      renderEditorControls();
      drawEditorViewport();
    }
    const category = event.target.closest?.("[data-category]")?.dataset.category;
    if (category) {
      editorCategory[editorLayer] = category;
      editorQuery = "";
      const input = document.querySelector(`#${EDITOR_ID} .bms-ed-search`);
      if (input) input.value = "";
      renderEditorPalette();
    }
    const assetButton = event.target.closest?.("[data-asset-id]");
    if (assetButton && !assetButton.disabled) {
      const id = Number(assetButton.dataset.assetId);
      const material = editorMaterials[editorLayer].find(item => item.id === id);
      if (material?.owned) selectEditorMaterial(material);
    }
  }

  function selectEditorMaterial(material) {
    editorSelected = material;
    editorTool = EDITOR_TOOL_BRUSH;
    editorRecent = [material, ...editorRecent.filter(item => item.layer !== material.layer || item.id !== material.id)].slice(0, EDITOR_RECENT_LIMIT);
    renderEditorPalette();
    renderEditorControls();
    drawEditorViewport();
  }

  function renderEditorPalette() {
    const root = document.getElementById(EDITOR_ID);
    if (!root) return;
    root.querySelectorAll("[data-layer]").forEach(button => button.classList.toggle("bms-ed-active", button.dataset.layer === editorLayer));
    const materials = editorMaterials[editorLayer];
    const categories = [...new Set(materials.map(item => item.type))];
    const recent = editorRecent.filter(item => item.layer === editorLayer && materials.some(current => current.id === item.id));
    const categoryHost = root.querySelector(".bms-ed-categories");
    categoryHost.innerHTML = `${recent.length ? '<button data-category="recent">最近</button>' : ""}${categories.map(type => {
      const label = EDITOR_CATEGORY_LABELS[type] || "其他分类";
      return `<button data-category="${escapeHTML(type)}" title="${escapeHTML(label)}">${escapeHTML(label)}</button>`;
    }).join("")}`;
    categoryHost.querySelectorAll("[data-category]").forEach(button => button.classList.toggle("bms-ed-active", !editorQuery && button.dataset.category === editorCategory[editorLayer]));

    let visible;
    if (editorQuery) visible = filterEditorMaterials(materials, "", editorQuery);
    else if (editorCategory[editorLayer] === "recent") visible = recent;
    else visible = filterEditorMaterials(materials, editorCategory[editorLayer]);
    const assets = root.querySelector(".bms-ed-assets");
    assets.innerHTML = visible.length ? visible.map(material => {
      const selected = editorSelected?.layer === material.layer && editorSelected.id === material.id;
      const title = material.owned
        ? `${EDITOR_CATEGORY_LABELS[material.type] || "其他素材"} / ${material.label} · ID ${material.id}`
        : `需要持有 ${material.definition.AssetGroup} / ${material.definition.AssetName}`;
      return `<button class="bms-ed-asset${selected ? " bms-ed-selected" : ""}${material.owned ? "" : " bms-ed-locked"}" data-asset-id="${material.id}" title="${escapeHTML(title)}" ${material.owned ? "" : "disabled"}><img src="${escapeHTML(editorMaterialPath(material))}" alt=""><span>${escapeHTML(material.label)}</span></button>`;
    }).join("") : '<div class="bms-ed-empty">没有匹配的素材</div>';
    const selection = root.querySelector(".bms-ed-selection");
    selection.innerHTML = editorSelected
      ? `当前：<strong>${editorSelected.layer === EDITOR_LAYER_TILE ? "地块" : "物件"} · ${escapeHTML(EDITOR_CATEGORY_LABELS[editorSelected.type] || "其他素材")} / ${escapeHTML(editorSelected.label)}</strong>`
      : `当前：<strong>${editorLayer === EDITOR_LAYER_TILE ? "请选择地块" : "请选择物件"}</strong>`;
  }

  function renderEditorControls() {
    const root = document.getElementById(EDITOR_ID);
    if (!root) return;
    root.querySelectorAll("[data-tool]").forEach(button => button.classList.toggle("bms-ed-active", button.dataset.tool === editorTool));
    root.querySelectorAll("[data-size]").forEach(button => button.classList.toggle("bms-ed-active", Number(button.dataset.size) === editorBrushSize));
    root.querySelector('[data-ed="grid"]')?.classList.toggle("bms-ed-active", editorGridVisible);
    const undo = root.querySelector('[data-ed="undo"]');
    const redo = root.querySelector('[data-ed="redo"]');
    if (undo) undo.disabled = editorHistory.undo.length === 0;
    if (redo) redo.disabled = editorHistory.redo.length === 0;
    const hint = root.querySelector(".bms-ed-canvas-hint");
    if (hint) hint.hidden = editorTool === EDITOR_TOOL_ERASER || editorSelected?.layer === editorLayer;
    updateEditorStatus();
  }

  function updateEditorStatus() {
    const status = document.querySelector(`#${EDITOR_ID} .bms-ed-status`);
    if (!status) return;
    const hover = editorHover ? `格子 (${editorHover.x}, ${editorHover.y}) · ` : "";
    const failures = editorImageFailures > 0 ? ` · <span class="bms-ed-warn">${editorImageFailures} 个素材加载失败</span>` : "";
    status.innerHTML = `${hover}画笔 ${editorBrushSize}×${editorBrushSize} · 右键拖拽平移 · 缩放 ${Math.round(editorView.zoom * 100)}% · 撤销 ${editorHistory.undo.length} / 重做 ${editorHistory.redo.length}${failures}`;
  }

  function updateEditorCoordinate() {
    const coordinate = document.querySelector(`#${EDITOR_ID} .bms-ed-coordinate`);
    if (coordinate) coordinate.textContent = editorHover ? `(${editorHover.x}, ${editorHover.y})` : "—";
    updateEditorStatus();
  }

  function fitEditorView() {
    const canvas = document.querySelector(`#${EDITOR_ID} .bms-ed-canvas`);
    const size = getChatRoomMapViewSize();
    if (!canvas) return;
    resizeEditorCanvas(canvas);
    const mapWidth = size.width * EDITOR_TILE_SIZE;
    const mapHeight = size.height * EDITOR_TILE_SIZE;
    const zoom = Math.max(EDITOR_ZOOM_MIN, Math.min(EDITOR_ZOOM_MAX, Math.min(canvas.width / mapWidth, canvas.height / mapHeight) * 0.96));
    editorView = { zoom, panX: (canvas.width - mapWidth * zoom) / 2, panY: (canvas.height - mapHeight * zoom) / 2 };
    drawEditorViewport();
  }

  function editorZoomAt(mx, my, factor) {
    const next = Math.max(EDITOR_ZOOM_MIN, Math.min(EDITOR_ZOOM_MAX, editorView.zoom * factor));
    const ratio = next / editorView.zoom;
    editorView.panX = mx - (mx - editorView.panX) * ratio;
    editorView.panY = my - (my - editorView.panY) * ratio;
    editorView.zoom = next;
    drawEditorViewport();
  }

  function resizeEditorCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }

  function getEditorImage(path) {
    if (!path || typeof Image !== "function") return null;
    let record = editorImageCache.get(path);
    if (record) return record;
    const image = new Image();
    record = { image, state: "loading" };
    editorImageCache.set(path, record);
    image.onload = () => { record.state = "loaded"; queueEditorMapRender(); };
    image.onerror = () => { record.state = "failed"; editorImageFailures += 1; queueEditorMapRender(); updateEditorStatus(); };
    image.src = path;
    return record;
  }

  function drawEditorPlaceholder(ctx, x, y, width, height) {
    ctx.fillStyle = "#263448";
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = "#40546c";
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + width, y + height);
    ctx.moveTo(x + width, y); ctx.lineTo(x, y + height);
    ctx.stroke();
  }

  function renderEditorOffscreen() {
    const size = getChatRoomMapViewSize();
    if (typeof document === "undefined" || !editorWorking) return;
    const tiles = editorWorking.Tiles;
    const objects = editorWorking.Objects;
    if (!editorOffscreen) editorOffscreen = document.createElement("canvas");
    editorOffscreen.width = size.width * EDITOR_TILE_SIZE;
    editorOffscreen.height = size.height * EDITOR_TILE_SIZE;
    const ctx = editorOffscreen.getContext("2d");
    ctx.clearRect(0, 0, editorOffscreen.width, editorOffscreen.height);
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, editorOffscreen.width, editorOffscreen.height);
    const tileLookup = getChatRoomMapViewTileLookup();
    const objectLookup = getChatRoomMapViewObjectLookup();

    for (let i = 0; i < size.width * size.height; i++) {
      const x = (i % size.width) * EDITOR_TILE_SIZE;
      const y = Math.floor(i / size.width) * EDITOR_TILE_SIZE;
      const tile = tileLookup?.[tiles.charCodeAt(i)];
      if (!tile) {
        drawEditorPlaceholder(ctx, x, y, EDITOR_TILE_SIZE, EDITOR_TILE_SIZE);
        continue;
      }
      const material = { layer: EDITOR_LAYER_TILE, type: tile.Type, style: tile.Style };
      const record = getEditorImage(editorMaterialPath(material));
      if (record?.state === "loaded") ctx.drawImage(record.image, x, y, EDITOR_TILE_SIZE, EDITOR_TILE_SIZE);
      else drawEditorPlaceholder(ctx, x, y, EDITOR_TILE_SIZE, EDITOR_TILE_SIZE);
    }

    for (let i = 0; i < size.width * size.height; i++) {
      const object = objectLookup?.[objects.charCodeAt(i)];
      if (!object || object.ID <= EDITOR_OBJECT_BLANK_ID || object.Style === "Blank") continue;
      const gx = i % size.width;
      const gy = Math.floor(i / size.width);
      const left = Number(object.Left) || 0;
      const top = Number(object.Top) || 0;
      const width = Number(object.Width) || 1;
      const height = Number(object.Height) || 1;
      const x = (gx + left) * EDITOR_TILE_SIZE;
      const y = (gy + top) * EDITOR_TILE_SIZE;
      const w = width * EDITOR_TILE_SIZE;
      const h = height * EDITOR_TILE_SIZE;
      const material = { layer: EDITOR_LAYER_OBJECT, type: object.Type, style: object.Style };
      const record = getEditorImage(editorMaterialPath(material));
      if (record?.state === "loaded") ctx.drawImage(record.image, x, y, w, h);
      else drawEditorPlaceholder(ctx, x, y, w, h);
    }

    if (editorGridVisible) {
      ctx.strokeStyle = "rgba(180,210,240,.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= size.width; x++) { ctx.moveTo(x * EDITOR_TILE_SIZE + .5, 0); ctx.lineTo(x * EDITOR_TILE_SIZE + .5, editorOffscreen.height); }
      for (let y = 0; y <= size.height; y++) { ctx.moveTo(0, y * EDITOR_TILE_SIZE + .5); ctx.lineTo(editorOffscreen.width, y * EDITOR_TILE_SIZE + .5); }
      ctx.stroke();
    }
    drawEditorViewport();
  }

  function queueEditorMapRender() {
    if (!editorOpen || editorRenderQueued) return;
    editorRenderQueued = true;
    const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : callback => setTimeout(callback, 0);
    schedule(() => {
      editorRenderQueued = false;
      if (editorOpen) renderEditorOffscreen();
    });
  }

  function drawEditorViewport() {
    const canvas = document.querySelector?.(`#${EDITOR_ID} .bms-ed-canvas`);
    if (!canvas) return;
    resizeEditorCanvas(canvas);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#09111e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (editorOffscreen) {
      ctx.save();
      ctx.translate(editorView.panX, editorView.panY);
      ctx.scale(editorView.zoom, editorView.zoom);
      ctx.drawImage(editorOffscreen, 0, 0);
      ctx.restore();
    }
    drawEditorHover(ctx);
    updateEditorStatus();
  }

  function drawEditorHover(ctx) {
    if (!editorHover || editorPointer?.panning) return;
    const size = getChatRoomMapViewSize();
    const cells = editorBrushCells(editorHover.x, editorHover.y, editorBrushSize, size.width, size.height);
    const erasing = editorTool === EDITOR_TOOL_ERASER;
    const preview = !erasing && editorSelected?.layer === editorLayer ? getEditorImage(editorMaterialPath(editorSelected)) : null;
    ctx.save();
    for (const cell of cells) {
      const p = editorGridToCanvasXY(cell.x, cell.y, editorView);
      const side = EDITOR_TILE_SIZE * editorView.zoom;
      if (preview?.state === "loaded") {
        const definition = editorSelected.definition || {};
        const left = editorLayer === EDITOR_LAYER_OBJECT ? Number(definition.Left) || 0 : 0;
        const top = editorLayer === EDITOR_LAYER_OBJECT ? Number(definition.Top) || 0 : 0;
        const width = editorLayer === EDITOR_LAYER_OBJECT ? Number(definition.Width) || 1 : 1;
        const height = editorLayer === EDITOR_LAYER_OBJECT ? Number(definition.Height) || 1 : 1;
        const imagePos = editorGridToCanvasXY(cell.x + left, cell.y + top, editorView);
        ctx.globalAlpha = 0.55;
        ctx.drawImage(preview.image, imagePos.x, imagePos.y, side * width, side * height);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = erasing ? "rgba(255,90,110,.23)" : "rgba(98,211,255,.22)";
      ctx.fillRect(p.x, p.y, side, side);
      ctx.strokeStyle = erasing ? "#ff8f9d" : "#62d3ff";
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x + 1, p.y + 1, Math.max(0, side - 2), Math.max(0, side - 2));
      if (erasing) {
        ctx.beginPath(); ctx.moveTo(p.x + 3, p.y + 3); ctx.lineTo(p.x + side - 3, p.y + side - 3); ctx.stroke();
      }
    }
    ctx.restore();
  }

  function editorPointerPosition(event) {
    const canvas = document.querySelector?.(`#${EDITOR_ID} .bms-ed-canvas`);
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return canvasEventToInternalXY(canvas, rect, event.clientX, event.clientY);
  }

  function editorHandleWheel(event) {
    event.preventDefault();
    const pos = editorPointerPosition(event);
    editorZoomAt(pos.x, pos.y, event.deltaY < 0 ? 1.18 : 1 / 1.18);
  }

  function editorHandlePointerDown(event) {
    // 可能在 window 捕获阶段被委托调用（手势拦截），因此不依赖 event.currentTarget。
    const canvas = document.querySelector?.(`#${EDITOR_ID} .bms-ed-canvas`);
    if (!canvas) return;
    // 右键或中键始终平移；空格+左键保留为键盘快捷方式。阻止默认行为以压制浏览器菜单与页面手势。
    const panning = event.button === 2 || event.button === 1 || (event.button === 0 && editorSpaceDown);
    const drawing = event.button === 0 && !panning;
    if (!panning && !drawing) return;
    event.preventDefault();
    event.stopPropagation();
    canvas.setPointerCapture?.(event.pointerId);
    editorPointer = {
      pointerId: event.pointerId, panning, drawing,
      startX: event.clientX, startY: event.clientY, panX: editorView.panX, panY: editorView.panY, lastIndex: -1,
      beforeSnapshot: panning ? null : editorSnapshot(editorWorking), historyRecorded: false,
    };
    if (panning) canvas.classList.add("bms-ed-panning");
    else {
      editorDrawFromPointer(event);
      renderEditorControls();
    }
  }

  function editorHandlePointerMove(event) {
    const canvas = event.currentTarget;
    const pos = editorPointerPosition(event);
    editorHover = editorCanvasToGridXY(pos.x, pos.y, editorView, getChatRoomMapViewSize());
    updateEditorCoordinate();
    if (editorPointer?.pointerId === event.pointerId) {
      if (editorPointer.panning) {
        editorView.panX = editorPointer.panX + event.clientX - editorPointer.startX;
        editorView.panY = editorPointer.panY + event.clientY - editorPointer.startY;
      } else if (editorPointer.drawing) editorDrawFromPointer(event);
    }
    drawEditorViewport();
  }

  function editorDrawFromPointer(event) {
    const pos = editorPointerPosition(event);
    const grid = editorCanvasToGridXY(pos.x, pos.y, editorView, getChatRoomMapViewSize());
    editorHover = grid;
    if (!grid || !editorPointer) return;
    const index = grid.y * getChatRoomMapViewSize().width + grid.x;
    if (editorPointer.lastIndex === index) return;
    editorPointer.lastIndex = index;
    try {
      const changed = editorApplyAt(grid.x, grid.y);
      if (changed && !editorPointer.historyRecorded && editorPointer.beforeSnapshot) {
        editorHistory.undo.push(editorPointer.beforeSnapshot);
        if (editorHistory.undo.length > EDITOR_HISTORY_LIMIT) editorHistory.undo.shift();
        editorHistory.redo.length = 0;
        editorPointer.historyRecorded = true;
        renderEditorControls();
      }
    } catch (error) { toast(error.message, "error"); }
  }

  function editorHandlePointerUp(event) {
    if (!editorPointer || editorPointer.pointerId !== event.pointerId) return;
    event.currentTarget.classList.remove("bms-ed-panning");
    editorPointer = null;
    renderEditorControls();
    drawEditorViewport();
  }

  function editorPerformHistory(direction) {
    try { assertRoomMapAction(); }
    catch (error) { toast(error.message, "error"); return; }
    const changed = direction === "redo" ? editorRedoMap(editorHistory, editorWorking) : editorUndoMap(editorHistory, editorWorking);
    if (!changed) return;
    editorPushWorkingToMap();
    try { notifyEditorMapChanged(); }
    catch (error) { toast(error.message, "error"); }
    renderEditorControls();
  }

  function editorTick(time = now()) {
    if (!editorOpen || time - editorLastTick < EDITOR_TICK_MS) return;
    editorLastTick = time;
    if (!shouldShowEditor()) {
      closeEditor();
      return;
    }
    if (getChatRoomMapViewEditMode() !== "") {
      closeEditor();
      toast("检测到原版地图编辑模式，增强编辑器已关闭", "error");
      return;
    }
    // 单向同步：外部地图状态（服务器广播、原版清理等）不得回灌编辑器，
    // 检测到被覆盖时立即把工作副本写回地图，保证已绘制内容不消失。
    if (editorPushWorkingToMap()) {
      try { notifyEditorMapChanged(); }
      catch (error) { warn("编辑器内容写回失败", error); }
    }
    drawEditorViewport();
  }

  function openEditor() {
    if (editorOpen) return true;
    try { assertRoomMapAction(); }
    catch (error) { toast(error.message, "error"); return false; }
    if (!isLocalMapViewActive()) {
      toast("请先切换到地图视图再打开地图编辑器", "error");
      return false;
    }
    if (getChatRoomMapViewEditMode() !== "") {
      toast("请先退出原版地图编辑模式，再打开增强编辑器", "error");
      return false;
    }
    if (minimapOpen) closeMinimap();
    editorOpen = true;
    editorView = { zoom: 1, panX: 0, panY: 0 };
    editorTool = EDITOR_TOOL_BRUSH;
    editorLayer = EDITOR_LAYER_TILE;
    editorBrushSize = 1;
    editorGridVisible = true;
    editorSelected = null;
    editorQuery = "";
    editorHover = null;
    editorPointer = null;
    editorHistory = createEditorHistory();
    editorWorking = editorSnapshotWorking();
    editorOffscreen = null;
    editorSyncNoticeShown = false;
    editorImageFailures = 0;
    syncEditorMaterials();
    const root = ensureEditorRoot();
    const room = getChatRoomData();
    root.querySelector(".bms-ed-room").textContent = room?.Name ? `房间：${room.Name}` : "";
    renderEditorPalette();
    renderEditorControls();
    queueEditorMapRender();
    setTimeout(fitEditorView, 0);
    toast("按住右键或中键拖拽平移；若鼠标手势干扰，请在手势软件中禁用鼠标手势", "info");
    return true;
  }

  function closeEditor() {
    if (!editorOpen) return;
    editorOpen = false;
    editorWorking = null;
    editorPointer = null;
    editorPanelDrag = null;
    editorHover = null;
    editorSpaceDown = false;
    editorRenderQueued = false;
    document.getElementById(EDITOR_ID)?.remove();
  }

  function toggleEditor() {
    return editorOpen ? (closeEditor(), false) : openEditor();
  }

  function editorHandleKeyDown(event) {
    if (!editorOpen) return;
    if (event.code === "Space" && !event.target?.matches?.("input,textarea")) {
      editorSpaceDown = true;
      event.preventDefault();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      editorPerformHistory(event.shiftKey ? "redo" : "undo");
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      editorPerformHistory("redo");
      event.preventDefault();
    } else if (event.key === "Escape") closeEditor();
  }

  function editorHandleKeyUp(event) {
    if (event.code === "Space") editorSpaceDown = false;
  }

  function installEditorHooks() {
    if (typeof document === "undefined") return;
    globalThis.addEventListener?.("keydown", editorHandleKeyDown);
    globalThis.addEventListener?.("keyup", editorHandleKeyUp);
    modApi.hookFunction("ChatRoomRun", 0, (args, next) => {
      const result = next(args);
      if (editorOpen) editorTick();
      if (shouldDrawEditorEntryButton() && typeof globalThis.DrawButton === "function") {
        DrawButton(EDITOR_ENTRY_BUTTON.x, EDITOR_ENTRY_BUTTON.y, EDITOR_ENTRY_BUTTON.width, EDITOR_ENTRY_BUTTON.height, "编", "#DDEBFF", "");
      }
      return result;
    });
    modApi.hookFunction("ChatRoomClick", 1000, (args, next) => {
      if (shouldDrawEditorEntryButton()
        && typeof globalThis.MouseIn === "function"
        && MouseIn(EDITOR_ENTRY_BUTTON.x, EDITOR_ENTRY_BUTTON.y, EDITOR_ENTRY_BUTTON.width, EDITOR_ENTRY_BUTTON.height)) {
        toggleEditor();
        return;
      }
      return next(args);
    });
  // 单向同步策略下不再监听 ChatRoomSyncRoomProperties 回灌编辑器：
  // 房间内地图同步由 tick 检测并按工作副本单向覆盖处理。
  if (typeof globalThis.ChatRoomLeave === "function") {
    modApi.hookFunction("ChatRoomLeave", 1000, (args, next) => {
      closeEditor();
      return next(args);
    });
  }
  // 鼠标手势（浏览器扩展/系统手势软件）无法从网页层屏蔽，拦截代码会与画布交互互相干扰；
  // 因此不尝试屏蔽，改为提示用户自行在手势软件中禁用。
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
    const api = Object.freeze({
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
      editor: {
        open: openEditor,
        close: closeEditor,
        toggle: toggleEditor,
        isOpen: () => editorOpen,
      },
    });
    // BCMX 为当前正式 API 名；BCMapSaver 保留为兼容别名，供已发布时依赖旧名的外部脚本使用。
    globalThis.BCMX = api;
    globalThis.BCMapSaver = api;
  }

  function detectDuplicateInstance() {
    if (!globalThis.BCMX && !globalThis.BCMapSaver && !document.getElementById(STYLE_ID) && !document.getElementById(ROOT_ID)) return false;
    duplicateInstance = true;
    console.error(`[${MOD_NAME}] 检测到另一份 BC Map eXtended，当前实例停止安装。`);
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
        installEditorHooks();
        installStealthHooks();
        injectStyle();
        injectMinimapStyle();
        injectEditorStyle();
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
      canvasEventToInternalXY,
      viewportCanvasToGridXY,
      viewportGridToCanvasXY,
      buildEditorMaterials,
      filterEditorMaterials,
      editorStyleLabel,
      editorMaterialOwned,
      editorBrushCells,
      applyEditorStroke,
      editorSnapshotWorking,
      editorPushWorkingToMap,
      editorObjectCellCompatible,
      createEditorHistory,
      editorPushUndo,
      editorUndoMap,
      editorRedoMap,
      editorCanvasToGridXY,
      editorGridToCanvasXY,
      shouldDrawEditorEntryButton,
      isStealthEnabled,
      setStealthEnabled,
      isCharacterHidden,
      isLocalMapViewActive,
      isCharacterMapViewActive,
      applyStealthMarker,
      applyMapViewPresenceMarker,
      syncLocalMapViewPresence,
      installStealthHooks,
      teleportVerificationMessage,
      isTeleportMessageFor,
      buildSwapTeleportPlan,
      isPositionReachable,
      installHooksForTest: api => { modApi = api; installHooks(); installMinimapHooks(); installEditorHooks(); installStealthHooks(); },
      constants: { STORAGE_SCHEMA_VERSION, MAP_FILE_FORMAT, LIBRARY_FILE_FORMAT, FILE_FORMAT_VERSION, MAX_AUTO_BACKUPS, ENTRY_BUTTON, MINIMAP_ENTRY_BUTTON, EDITOR_ENTRY_BUTTON, EDITOR_HISTORY_LIMIT, EDITOR_OBJECT_BLANK_ID },
    };
  } else {
    const timer = setInterval(() => {
      initialize();
      if (initialized || duplicateInstance) clearInterval(timer);
    }, 500);
    globalThis.addEventListener?.("load", initialize);
  }
})();



