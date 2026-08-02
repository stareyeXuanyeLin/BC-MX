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

