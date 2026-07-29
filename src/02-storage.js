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
