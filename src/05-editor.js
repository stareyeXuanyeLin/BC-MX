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
  const EDITOR_TOOL_PAN = "pan";
  const EDITOR_TOOL_BRUSH = "brush";
  const EDITOR_TOOL_ERASER = "eraser";
  const EDITOR_CATEGORY_LABELS = Object.freeze({
    Floor: "地板", FloorExterior: "室外", Wall: "墙壁", Water: "水面",
    FloorDecoration: "地面装饰", FloorDecorationThemed: "主题装饰", FloorDecorationParty: "派对装饰",
    FloorDecorationCamping: "露营装饰", FloorDecorationExpanding: "扩展装饰", FloorItem: "地面物品",
    FloorObstacle: "障碍", FloorNumber: "数字", FloorLetter: "字母", FloorIcon: "图标",
    WallDecoration: "墙饰", WallPath: "墙面路径", Banners: "横幅",
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
  let editorMaterials = { tile: [], object: [] };
  let editorRecent = [];
  let editorMapSignature = "";
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

  function buildEditorMaterials(layer, lookup, player = getPlayerCharacter(), inventoryAvailable = getInventoryAvailable()) {
    return lookupValues(lookup)
      .filter(item => layer !== EDITOR_LAYER_OBJECT || (item.ID !== EDITOR_OBJECT_BLANK_ID && item.Style !== "Blank"))
      .map(item => ({
        id: item.ID,
        layer,
        type: String(item.Type || "Other"),
        style: String(item.Style || item.ID),
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
      return `${material.type} ${material.style} ${material.id}`.toLocaleLowerCase().includes(normalized);
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
    const radius = Math.max(0, Math.min(4, Number(range) - 1));
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
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
      const cell = valid[valid.length - 1]; // 与原版逐格“先清唯一项再写入”一致，最终只保留最后一个落点
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

  function editorMapSignatureOf(mapData = editorMapData()) {
    return `${mapData?.Tiles ?? ""}|${mapData?.Objects ?? ""}`;
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
    editorMapSignature = editorMapSignatureOf();
    queueEditorMapRender();
    if (!editorSyncNoticeShown) {
      editorSyncNoticeShown = true;
      toast("修改已交给 BC 原版同步，通常约 5 秒后全房间生效", "success");
    }
  }

  function editorApplyAt(gx, gy, temporaryEraser = false) {
    assertRoomMapAction(); // 每次落笔重新验权，避免打开后权限变化绕过入口检查
    const mapData = editorMapData();
    const size = getChatRoomMapViewSize();
    const erasing = temporaryEraser || editorTool === EDITOR_TOOL_ERASER;
    const material = editorSelected?.layer === editorLayer ? editorSelected : null;
    if (!erasing && !material) return false;
    const cells = editorBrushCells(gx, gy, editorBrushSize, size.width, size.height);
    const id = erasing
      ? (editorLayer === EDITOR_LAYER_OBJECT ? EDITOR_OBJECT_BLANK_ID : 0)
      : material.id;
    const changed = applyEditorStroke(mapData, editorLayer, id, cells, erasing ? null : material.definition);
    if (changed) notifyEditorMapChanged();
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
      #${EDITOR_ID}{position:fixed;z-index:99992;width:min(1120px,calc(100vw - 24px));height:min(720px,calc(100vh - 24px));background:#111d31;border:1px solid #45678f;border-radius:12px;box-shadow:0 18px 52px rgba(0,0,0,.6);font-family:Inter,"Microsoft YaHei",sans-serif;color:#eaf2ff;user-select:none;overflow:hidden;display:flex;flex-direction:column}
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
      #${EDITOR_ID} .bms-ed-body{display:grid;grid-template-columns:minmax(440px,1fr) 340px;gap:10px;padding:10px;min-height:0;flex:1}
      #${EDITOR_ID} .bms-ed-workspace{min-width:0;display:flex;flex-direction:column;gap:8px}
      #${EDITOR_ID} .bms-ed-tools{display:flex;align-items:center;gap:6px;min-height:38px;padding:5px 7px;border:1px solid #2c425d;border-radius:7px;background:#0f1a2c;overflow-x:auto}
      #${EDITOR_ID} .bms-ed-tools button{height:28px;padding:0 10px;white-space:nowrap;font-size:12px}
      #${EDITOR_ID} .bms-ed-tools .bms-ed-size{width:28px;padding:0}
      #${EDITOR_ID} .bms-ed-divider{width:1px;height:22px;background:#385576;flex:none;margin:0 2px}
      #${EDITOR_ID} .bms-ed-canvas-wrap{position:relative;min-height:0;flex:1;border:1px solid #2c425d;border-radius:7px;background:#09111e;overflow:hidden}
      #${EDITOR_ID} .bms-ed-canvas{display:block;width:100%;height:100%;touch-action:none;cursor:crosshair}
      #${EDITOR_ID} .bms-ed-canvas.bms-ed-panning{cursor:grabbing}
      #${EDITOR_ID} .bms-ed-coordinate{position:absolute;left:8px;bottom:8px;padding:3px 7px;border-radius:5px;background:rgba(5,11,20,.78);color:#9edcff;font:12px Consolas,monospace;pointer-events:none}
      #${EDITOR_ID} .bms-ed-canvas-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:320px;text-align:center;color:#9eb4ce;background:rgba(9,17,30,.86);border:1px solid #385576;border-radius:8px;padding:10px 14px;pointer-events:none}
      #${EDITOR_ID} .bms-ed-palette{display:flex;flex-direction:column;min-width:0;min-height:0;border:1px solid #2c425d;border-radius:7px;background:#0f1a2c;overflow:hidden}
      #${EDITOR_ID} .bms-ed-layer-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px;border-bottom:1px solid #2c425d}
      #${EDITOR_ID} .bms-ed-layer-tabs button{height:34px;font-weight:700}
      #${EDITOR_ID} .bms-ed-categories{display:flex;gap:6px;padding:8px;overflow-x:auto;border-bottom:1px solid #2c425d;flex:none}
      #${EDITOR_ID} .bms-ed-categories button{height:28px;padding:0 9px;white-space:nowrap;font-size:12px}
      #${EDITOR_ID} .bms-ed-search-wrap{padding:8px;border-bottom:1px solid #2c425d}
      #${EDITOR_ID} .bms-ed-search{width:100%;height:32px;border:1px solid #385576;border-radius:7px;background:#0a1423;color:#eaf2ff;padding:0 10px;outline:none;user-select:text}
      #${EDITOR_ID} .bms-ed-search:focus{border-color:#78a5d8}
      #${EDITOR_ID} .bms-ed-assets{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-content:start;gap:8px;padding:8px;overflow-y:auto;min-height:0;flex:1}
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
      @media(max-width:900px){#${EDITOR_ID} .bms-ed-body{grid-template-columns:minmax(360px,1fr) 300px}#${EDITOR_ID} .bms-ed-assets{grid-template-columns:repeat(3,minmax(0,1fr))}}
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
            <button data-tool="pan">平移</button><button data-tool="brush">画笔</button><button data-tool="eraser">橡皮</button><span class="bms-ed-divider"></span>
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
    root.style.left = `${Math.max(6, Math.floor((window.innerWidth - Math.min(1120, window.innerWidth - 24)) / 2))}px`;
    root.style.top = `${Math.max(6, Math.floor((window.innerHeight - Math.min(720, window.innerHeight - 24)) / 2))}px`;
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
      root.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, editorPanelDrag.left + event.clientX - editorPanelDrag.startX))}px`;
      root.style.top = `${Math.max(0, Math.min(window.innerHeight - 46, editorPanelDrag.top + event.clientY - editorPanelDrag.startY))}px`;
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
    if ([EDITOR_TOOL_PAN, EDITOR_TOOL_BRUSH, EDITOR_TOOL_ERASER].includes(tool)) {
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
    categoryHost.innerHTML = `${recent.length ? '<button data-category="recent">最近</button>' : ""}${categories.map(type => `<button data-category="${escapeHTML(type)}" title="${escapeHTML(type)}">${escapeHTML(EDITOR_CATEGORY_LABELS[type] || type)}</button>`).join("")}`;
    categoryHost.querySelectorAll("[data-category]").forEach(button => button.classList.toggle("bms-ed-active", !editorQuery && button.dataset.category === editorCategory[editorLayer]));

    let visible;
    if (editorQuery) visible = filterEditorMaterials(materials, "", editorQuery);
    else if (editorCategory[editorLayer] === "recent") visible = recent;
    else visible = filterEditorMaterials(materials, editorCategory[editorLayer]);
    const assets = root.querySelector(".bms-ed-assets");
    assets.innerHTML = visible.length ? visible.map(material => {
      const selected = editorSelected?.layer === material.layer && editorSelected.id === material.id;
      const title = material.owned
        ? `${material.type} / ${material.style} · ID ${material.id}`
        : `需要持有 ${material.definition.AssetGroup} / ${material.definition.AssetName}`;
      return `<button class="bms-ed-asset${selected ? " bms-ed-selected" : ""}${material.owned ? "" : " bms-ed-locked"}" data-asset-id="${material.id}" title="${escapeHTML(title)}" ${material.owned ? "" : "disabled"}><img src="${escapeHTML(editorMaterialPath(material))}" alt=""><span>${escapeHTML(material.style)}</span></button>`;
    }).join("") : '<div class="bms-ed-empty">没有匹配的素材</div>';
    const selection = root.querySelector(".bms-ed-selection");
    selection.innerHTML = editorSelected
      ? `当前：<strong>${editorSelected.layer === EDITOR_LAYER_TILE ? "地块" : "物件"} · ${escapeHTML(editorSelected.type)} / ${escapeHTML(editorSelected.style)}</strong>`
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
    if (hint) hint.hidden = editorTool === EDITOR_TOOL_PAN || editorTool === EDITOR_TOOL_ERASER || editorSelected?.layer === editorLayer;
    updateEditorStatus();
  }

  function updateEditorStatus() {
    const status = document.querySelector(`#${EDITOR_ID} .bms-ed-status`);
    if (!status) return;
    const hover = editorHover ? `格子 (${editorHover.x}, ${editorHover.y}) · ` : "";
    const failures = editorImageFailures > 0 ? ` · <span class="bms-ed-warn">${editorImageFailures} 个素材加载失败</span>` : "";
    status.innerHTML = `${hover}画笔 ${editorBrushSize} · 缩放 ${Math.round(editorView.zoom * 100)}% · 撤销 ${editorHistory.undo.length} / 重做 ${editorHistory.redo.length}${failures}`;
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
    const mapData = editorMapData();
    const size = getChatRoomMapViewSize();
    if (typeof document === "undefined" || !mapData) return;
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
      const tile = tileLookup?.[mapData.Tiles?.charCodeAt(i)];
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
      const object = objectLookup?.[mapData.Objects?.charCodeAt(i)];
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
    editorMapSignature = editorMapSignatureOf(mapData);
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
    if (!editorHover || editorTool === EDITOR_TOOL_PAN) return;
    const size = getChatRoomMapViewSize();
    const cells = editorBrushCells(editorHover.x, editorHover.y, editorBrushSize, size.width, size.height);
    const erasing = editorTool === EDITOR_TOOL_ERASER || editorPointer?.temporaryEraser;
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
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return canvasEventToInternalXY(canvas, rect, event.clientX, event.clientY);
  }

  function editorHandleWheel(event) {
    event.preventDefault();
    const pos = editorPointerPosition(event);
    editorZoomAt(pos.x, pos.y, event.deltaY < 0 ? 1.18 : 1 / 1.18);
  }

  function editorHandlePointerDown(event) {
    const canvas = event.currentTarget;
    const panning = event.button === 1 || (event.button === 0 && (editorTool === EDITOR_TOOL_PAN || editorSpaceDown));
    const drawing = event.button === 0 && !panning;
    const temporaryEraser = event.button === 2;
    if (!panning && !drawing && !temporaryEraser) return;
    canvas.setPointerCapture?.(event.pointerId);
    editorPointer = {
      pointerId: event.pointerId, panning, drawing: drawing || temporaryEraser, temporaryEraser,
      startX: event.clientX, startY: event.clientY, panX: editorView.panX, panY: editorView.panY, lastIndex: -1,
      beforeSnapshot: panning ? null : editorSnapshot(editorMapData()), historyRecorded: false,
    };
    if (panning) canvas.classList.add("bms-ed-panning");
    else {
      editorDrawFromPointer(event);
      renderEditorControls();
    }
    event.preventDefault();
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
      const changed = editorApplyAt(grid.x, grid.y, editorPointer.temporaryEraser);
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
    const mapData = editorMapData();
    const changed = direction === "redo" ? editorRedoMap(editorHistory, mapData) : editorUndoMap(editorHistory, mapData);
    if (!changed) return;
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
    const signature = editorMapSignatureOf();
    if (signature !== editorMapSignature) queueEditorMapRender();
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
    editorMapSignature = "";
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
    return true;
  }

  function closeEditor() {
    if (!editorOpen) return;
    editorOpen = false;
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
    if (typeof globalThis.ChatRoomSyncRoomProperties === "function") {
      modApi.hookFunction("ChatRoomSyncRoomProperties", 1000, (args, next) => {
        const result = next(args);
        if (editorOpen) {
          editorMapSignature = "";
          editorHistory = createEditorHistory();
          syncEditorMaterials();
          renderEditorPalette();
          renderEditorControls();
          queueEditorMapRender();
        }
        return result;
      });
    }
    if (typeof globalThis.ChatRoomLeave === "function") {
      modApi.hookFunction("ChatRoomLeave", 1000, (args, next) => {
        closeEditor();
        return next(args);
      });
    }
  }
