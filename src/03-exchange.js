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
