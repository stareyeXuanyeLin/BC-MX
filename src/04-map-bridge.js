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

  const OBJECT_MARKER_NONE = 0;
  const OBJECT_MARKER_DOOR = 1;
  const OBJECT_MARKER_ENTRY = 2;
  const OBJECT_MARKER_EXIT = 3;

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

  function objectMarkerOf(obj) {
    if (!obj || typeof obj !== "object") return OBJECT_MARKER_NONE;
    if (obj.Style === "EntryFlag") return OBJECT_MARKER_ENTRY;
    if (obj.Style === "ExitFlag") return OBJECT_MARKER_EXIT;
    // 原版门统一属于 WallPath；保留 Door 类型兼容旧版或第三方扩展对象。
    if (obj.Type === "Door" || (obj.Type === "WallPath" && obj.Style !== "Blank")) return OBJECT_MARKER_DOOR;
    return OBJECT_MARKER_NONE;
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
    const objectMarker = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const tile = tileLookup?.[tiles.charCodeAt(i)];
      const obj = objectLookup?.[objects.charCodeAt(i)];
      walkable[i] = isPositionWalkable(tile, obj) ? 1 : 0;
      tileKind[i] = tileKindOf(tile);
      objectMarker[i] = objectMarkerOf(obj);
    }
    const snapshot = { width: size.width, height: size.height, tiles, objects, walkable, tileKind, objectMarker, revision: now() };
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

  // 旧版 fog flip 实现：服务器对无变化的 ChatRoomAdmin Update 可能去重，因此先让
  // 房间迷雾产生一次真实变化，再立即恢复原状。新传送链路不会自动调用它；暂时保留
  // 这段代码只为双账号实测期间能够手动回滚，哨兵同步失败时直接安全退出。
  function triggerRoomPropertiesSync() {
    const serverSend = getServerSend();
    const getSettings = getChatRoomGetSettings();
    const player = getPlayerCharacter();
    const room = getChatRoomData();
    if (!serverSend || !getSettings || !player || !room?.MapData) return false;
    const mapData = room.MapData;
    const fogWasEnabled = mapData.Fog !== false;
    const applyFog = enabled => {
      if (enabled) delete mapData.Fog;
      else mapData.Fog = false;
    };
    const sendUpdate = () => {
      serverSend("ChatRoomAdmin", {
        // 对齐原版：MemberNumber 传 Player.ID（客户端角色索引，登录后为 0）。
        // 服务器用 MemberNumber 判断“管理员操作自己”，传自己的 MemberNumber 会被直接拒绝。
        MemberNumber: typeof player.ID === "number" ? player.ID : player.MemberNumber,
        Room: getSettings(room),
        Action: "Update",
      });
    };
    try {
      applyFog(!fogWasEnabled);
      sendUpdate();
      applyFog(fogWasEnabled);
      sendUpdate();
      return true;
    } catch (error) {
      warn("触发房间属性同步失败", error);
      applyFog(fogWasEnabled);
      return false;
    }
  }

  const SILENT_ROOM_SYNC_SENTINEL_MEMBER = 0;
  const SILENT_ROOM_SYNC_RECOVERY_DELAY_MS = 1500;
  let silentRoomSyncInProgress = false;

  function roomIdentity(room) {
    if (!room) return "";
    return `${String(room.Space ?? "")}|${String(room.Name ?? "")}`;
  }

  // BC 服务端对房间外成员执行 Whitelist/Unwhitelist 时不会发布 Action，但仍会调用
  // ChatRoomSyncRoomProperties。正式账号 MemberNumber 从 1 开始，因此用 0 作为无对应
  // 账号的哨兵：不会改变任何真人权限，又能迫使所有客户端重新广播自己的 MapData。
  // 若上次异常遗留了 0，本次只发送 Unwhitelist；该清理包本身也足以触发一次同步。
  function triggerSilentMapDataRefresh() {
    if (silentRoomSyncInProgress) return false;
    const serverSend = getServerSend();
    const room = getChatRoomData();
    if (!serverSend || !room || !Array.isArray(room.Whitelist) || !isRoomAdmin()) return false;

    const originalRoomIdentity = roomIdentity(room);
    const sentinelAlreadyPresent = room.Whitelist.map(Number).includes(SILENT_ROOM_SYNC_SENTINEL_MEMBER);
    let firstActionSent = false;
    silentRoomSyncInProgress = true;
    try {
      if (!sentinelAlreadyPresent) {
        serverSend("ChatRoomAdmin", {
          MemberNumber: SILENT_ROOM_SYNC_SENTINEL_MEMBER,
          Action: "Whitelist",
        });
        firstActionSent = true;
      }
      serverSend("ChatRoomAdmin", {
        MemberNumber: SILENT_ROOM_SYNC_SENTINEL_MEMBER,
        Action: "Unwhitelist",
      });
      firstActionSent = true;
    } catch (error) {
      warn("静默白名单哨兵同步失败", error);
      if (!firstActionSent) {
        silentRoomSyncInProgress = false;
        return false;
      }
    }

    setTimeout(() => {
      try {
        const currentRoom = getChatRoomData();
        if (globalThis.CurrentScreen !== "ChatRoom" || roomIdentity(currentRoom) !== originalRoomIdentity) return;
        if (!isRoomAdmin() || !Array.isArray(currentRoom?.Whitelist)) return;
        if (!currentRoom.Whitelist.map(Number).includes(SILENT_ROOM_SYNC_SENTINEL_MEMBER)) return;
        serverSend("ChatRoomAdmin", {
          MemberNumber: SILENT_ROOM_SYNC_SENTINEL_MEMBER,
          Action: "Unwhitelist",
        });
      } catch (error) {
        warn("静默白名单哨兵恢复检查失败", error);
      } finally {
        silentRoomSyncInProgress = false;
      }
    }, SILENT_ROOM_SYNC_RECOVERY_DELAY_MS);
    return sentinelAlreadyPresent ? "sentinel-cleanup" : "sentinel-toggle";
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
      return "native";
    }
    const serverSend = getServerSend();
    if (!serverSend) throw new Error("当前环境缺少 ServerSend，无法传送");
    const player = getPlayerCharacter();
    if (target === player && target.Position) target.Position = position; // 对齐原版“传自己本地立即生效”语义
    serverSend("ChatRoomChat", createTeleportMessage(memberNumber, tx, ty));
    return "fallback";
  }

  // 传送后的按需同步：目标位置尚未广播回本地视角时，通过房间外白名单哨兵触发
  // ChatRoomSyncRoomProperties，强制所有客户端重广播 MapData。已同步、事务占用或环境
  // 已失效时保持零打扰。返回是否成功启动了同步动作。
  function forceSyncUnsyncedTarget(memberNumber, x, y) {
    const target = findRoomCharacter(memberNumber);
    if (!target) return false;
    const pos = target.MapData?.Pos;
    if (pos?.X === Number(x) && pos?.Y === Number(y)) return false;
    return !!triggerSilentMapDataRefresh();
  }

  // ===== 小地图状态同步 =====
  // 坐标隐藏与地图视角状态都放在 MapData 顶层，随正常 MapData 广播流转；同时镜像到
  // PrivateState 兼容早期版本接收端。接收端只在插件侧维护角色状态，原版渲染不读取这些标记。

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

  // 插件视角下该玩家是否隐藏：自己永远可见；他人看 BMSHidden 标记（含原版同步进 MapData 的镜像）。
  function isCharacterHidden(character) {
    if (!character) return false;
    if (Number(character.MemberNumber) === currentMemberNumber()) return false;
    return character.BMSHidden === true || character.MapData?.BMSHidden === true;
  }

  function isLocalMapViewActive() {
    if (globalThis.CurrentScreen !== "ChatRoom") return false;
    try {
      if (typeof ChatRoomMapViewIsActive === "function") return ChatRoomMapViewIsActive() === true;
    } catch (_) { /* fall through to legacy window property */ }
    return typeof globalThis.ChatRoomMapViewIsActive === "function" && globalThis.ChatRoomMapViewIsActive() === true;
  }

  // 视图状态检测已按用户要求屏蔽：原版传送本就不检查目标视图，因此远端玩家一律视为
  // 可传送、可选中、可换位。保留函数签名以兼容调用点，恒返回 true。
  function isCharacterMapViewActive(character) {
    return true;
  }

  function applyStealthMarker(character, mapData) {
    if (!character) return;
    if (mapData?.BMSHidden === true) character.BMSHidden = true;
    else delete character.BMSHidden;
  }

  function applyMapViewPresenceMarker(character, mapData) {
    if (!character) return;
    // 三态标记：true=地图中，false=明确聊天中（当前版本发送端显式广播），
    // undefined=无插件或旧版发送端。同时识别早期版本放在 PrivateState 的标记。
    if (mapData?.BMSMapViewActive === true || mapData?.PrivateState?.BMSMapViewActive === true) character.BMSMapViewActive = true;
    else if (mapData?.BMSMapViewActive === false) character.BMSMapViewActive = false;
    else delete character.BMSMapViewActive;
  }

  // 同步本地地图状态：把持久化的隐藏开关重新映射回 MapData，覆盖重登/对象重建后
  // 新 MapData 丢失 BMSHidden 标记的情况；同时维护地图视角在线标记。
  // 视角标记显式写 true/false（而非删除），让接收端能区分“明确在聊天视图”与“无插件未上报”；
  // 同时镜像到 PrivateState 兼容早期版本接收端。任一字段变化或强制时立即广播。
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
    const activeField = active ? true : false;
    const changed = player.MapData.BMSMapViewActive !== activeField
      || (privateState.BMSMapViewActive === true) !== active
      || hiddenChanged;
    player.MapData.BMSMapViewActive = activeField;
    if (active) privateState.BMSMapViewActive = true;
    else delete privateState.BMSMapViewActive;
    player.BMSMapViewActive = activeField;
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

