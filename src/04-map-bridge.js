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
