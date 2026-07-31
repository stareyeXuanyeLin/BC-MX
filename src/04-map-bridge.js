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

  function teleportCharacter(memberNumber, x, y) {
    assertRoomMapAction();
    const size = getChatRoomMapViewSize();
    const tx = Number(x);
    const ty = Number(y);
    if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || ty < 0 || tx >= size.width || ty >= size.height) {
      throw new Error("传送目标超出地图范围");
    }
    const target = findRoomCharacter(memberNumber);
    if (!target) throw new Error("找不到目标玩家");
    const position = { X: tx, Y: ty };

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

