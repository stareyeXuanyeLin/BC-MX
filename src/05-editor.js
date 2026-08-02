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
  const EDITOR_LIGHTING_BLANK_ID = 10;
  const EDITOR_TOOL_BRUSH = "brush";
  const EDITOR_TOOL_ERASER = "eraser";
  const EDITOR_CATEGORY_LABELS = Object.freeze({
    Floor: "室内地面", FloorExterior: "室外地面", Wall: "墙壁", Water: "水面", Lighting: "光照",
    FloorDecoration: "地面装饰", FloorDecorationThemed: "主题装饰", FloorDecorationParty: "派对装饰",
    FloorDecorationCamping: "露营装饰", FloorDecorationExpanding: "扩展装饰", FloorDecorationAnimal: "动物装饰",
    FloorItem: "大型设施", FloorObstacle: "障碍物", FloorNumber: "数字", FloorLetter: "字母", FloorIcon: "地面图标",
    WallDecoration: "墙面装饰", WallPath: "门与通道", Banners: "旗帜",
  });
  // 原版光照调色板（ChatRoomMapViewEffectList）：ID 10 为空白，11~17 为阴影/染色预设
  const EDITOR_LIGHTING_LABELS = Object.freeze({
    10: "无光照", 11: "浅阴影", 12: "中阴影", 13: "深阴影",
    14: "红色光照", 15: "蓝色光照", 16: "绿色光照", 17: "黄色光照",
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
  // 每层素材折叠栏的折叠状态；未记录的分类使用层默认值（地块展开、物件折叠）
  let editorGroupState = { tile: new Map(), object: new Map() };
  let editorQuery = "";
  let editorHover = null;
  let editorPointer = null;
  let editorPanelDrag = null;
  let editorSpaceDown = false;
  let editorHistory = createEditorHistory();
  let editorWorking = null; // 编辑器权威工作副本：打开时快照，渲染与撤销都以它为准，单向覆盖地图
  let editorMaterials = { tile: [], object: [], lighting: [] };
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

  function getChatRoomMapViewEffectList() {
    try {
      if (typeof ChatRoomMapViewEffectList !== "undefined") return ChatRoomMapViewEffectList;
    } catch (_) { /* fall through */ }
    return globalThis.ChatRoomMapViewEffectList ?? null;
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

  function editorStyleLabel(style, id, type) {
    const name = String(style || "");
    // 六边形地面与六边形墙壁同名，按类型区分
    if ((name === "HexBlue" || name === "HexPurple") && EDITOR_STYLE_LABELS[name]) {
      return `${EDITOR_STYLE_LABELS[name]}（${type === "Wall" ? "墙壁" : "地面"}）`;
    }
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
        label: editorStyleLabel(item.Style, item.ID, item.Type),
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

  // 光照素材归入地块大类（layer 沿用 tile），写入时按 definition.Type 走 Effects 层
  function buildLightingMaterials(list) {
    return (Array.isArray(list) ? list : []).map(effect => ({
      id: effect.ID,
      layer: EDITOR_LAYER_TILE,
      type: "Lighting",
      style: `Light${effect.ID}`,
      label: EDITOR_LIGHTING_LABELS[effect.ID] || `光照 ${effect.ID}`,
      owned: true,
      unique: false,
      definition: effect,
    }));
  }

  function editorMaterialPath(material) {
    if (!material) return "";
    const base = material.layer === EDITOR_LAYER_TILE ? "MapTile" : "MapObject";
    return `Screens/Online/ChatRoom/${base}/${material.type}/${material.style}.png`;
  }

  // 光照素材没有贴图，用 Color 生成半透明色块 SVG 缩略图
  function editorLightingSwatch(material) {
    const color = Array.isArray(material?.definition?.Color) ? material.definition.Color : [0, 0, 0, 0];
    const fill = `rgba(${color[0]},${color[1]},${color[2]},${color[3]})`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#16273e"/><rect x="8" y="8" width="48" height="48" rx="6" fill="${fill}" stroke="#5c7ea8" stroke-width="2"/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function editorMaterialImage(material) {
    if (material?.type === "Lighting") return editorLightingSwatch(material);
    return editorMaterialPath(material);
  }

  // Effects 是每格一个效果数组的三层结构；快照与历史必须深拷贝，避免与原版 MapManager 共享引用
  function editorCloneEffects(effects) {
    if (!Array.isArray(effects)) return [];
    return effects.map(list => (Array.isArray(list) ? list.slice() : list));
  }

  function editorEffectsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const la = a[i] || [];
      const lb = b[i] || [];
      if (la.length !== lb.length) return false;
      for (let j = 0; j < la.length; j++) {
        if (la[j]?.ID !== lb[j]?.ID) return false;
      }
    }
    return true;
  }

  function editorSnapshot(mapData) {
    return {
      Tiles: String(mapData?.Tiles ?? ""),
      Objects: String(mapData?.Objects ?? ""),
      Effects: editorCloneEffects(mapData?.Effects),
    };
  }

  function createEditorHistory() {
    return { undo: [], redo: [] };
  }

  function editorPushUndo(history, mapData) {
    if (!history || !mapData) return false;
    const snapshot = editorSnapshot(mapData);
    const last = history.undo[history.undo.length - 1];
    if (!last || last.Tiles !== snapshot.Tiles || last.Objects !== snapshot.Objects || !editorEffectsEqual(last.Effects, snapshot.Effects)) {
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
    if (Array.isArray(snapshot.Effects)) mapData.Effects = editorCloneEffects(snapshot.Effects);
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
    // 光照素材（归入地块大类）：写入 Effects 数组，不碰 Tiles 字符串
    if (definition?.Type === "StaticLighting") {
      const effects = mapData.Effects;
      if (!Array.isArray(effects)) return false;
      const valid = cells.filter(cell => Number.isInteger(cell?.index) && cell.index >= 0 && cell.index < effects.length);
      if (valid.length === 0) return false;
      const list = Number(id) === EDITOR_LIGHTING_BLANK_ID ? [] : [definition];
      let changed = false;
      for (const cell of valid) {
        const before = (effects[cell.index] || []).map(effect => effect?.ID).join(",");
        const next = list.map(effect => effect.ID).join(",");
        if (before !== next) {
          effects[cell.index] = list.slice();
          changed = true;
        }
      }
      return changed;
    }
    const key = layer === EDITOR_LAYER_OBJECT ? "Objects" : "Tiles";
    const source = mapData[key];
    if (typeof source !== "string" || source.length === 0) return false;
    const writeId = Number(id);
    if (!Number.isInteger(writeId) || writeId < 0 || writeId > 0xFFFF) return false;
    // 地块层没有空白概念，只能被其它地块覆盖，不允许写空 0
    if (layer === EDITOR_LAYER_TILE && writeId === 0) return false;
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
  // Effects 数据在 ChatRoomMapManager 内部（MapData.Effects 只是编码字符串），快照从 MapManager 深拷贝。
  function editorSnapshotWorking() {
    const mapData = editorMapData();
    if (!mapData) return null;
    const manager = getChatRoomMapManager();
    return {
      Tiles: String(mapData.Tiles ?? ""),
      Objects: String(mapData.Objects ?? ""),
      Effects: editorCloneEffects(manager?.Map?.getAllEffects?.() ?? []),
    };
  }

  // 单向覆盖：把编辑器工作副本写回 ChatRoomData.MapData（游戏画面与原版发送链路读到的都是它）。
  // 可选传入 working 参数便于测试；运行时使用模块工作副本。
  // Effects 走 ChatRoomMapManager：replaceAllEffects 替换内部数组，updateGlobalMapData 编码进 MapData.Effects。
  function editorPushWorkingToMap(working = editorWorking) {
    const mapData = editorMapData();
    if (!mapData || !working) return false;
    let changed = false;
    if (mapData.Tiles !== working.Tiles || mapData.Objects !== working.Objects) {
      mapData.Tiles = working.Tiles;
      mapData.Objects = working.Objects;
      changed = true;
    }
    if (Array.isArray(working.Effects)) {
      const manager = getChatRoomMapManager();
      const current = manager?.Map?.getAllEffects?.();
      if (Array.isArray(current) && !editorEffectsEqual(current, working.Effects)) {
        manager.Map.replaceAllEffects(editorCloneEffects(working.Effects));
        if (typeof manager.Map.updateGlobalMapData === "function") manager.Map.updateGlobalMapData();
        changed = true;
      }
    }
    return changed;
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
    // 地块层没有空白概念：地块只能被其它地块覆盖，不允许删除；光照清除使用“无光照”素材
    if (erasing && editorLayer === EDITOR_LAYER_TILE) {
      toast("地块无法删除，只能覆盖", "error");
      return false;
    }
    let cells = editorBrushCells(gx, gy, editorBrushSize, size.width, size.height);
    const id = erasing ? EDITOR_OBJECT_BLANK_ID : material.id;
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
    const effectList = getChatRoomMapViewEffectList();
    editorMaterials.tile = buildEditorMaterials(EDITOR_LAYER_TILE, tileList ?? getChatRoomMapViewTileLookup());
    editorMaterials.object = buildEditorMaterials(EDITOR_LAYER_OBJECT, objectList ?? getChatRoomMapViewObjectLookup());
    editorMaterials.lighting = buildLightingMaterials(effectList);
    if (editorSelected) {
      const layer = editorSelected.layer;
      const candidates = layer === EDITOR_LAYER_TILE ? [...editorMaterials.tile, ...editorMaterials.lighting] : editorMaterials[layer];
      editorSelected = candidates.find(item => item.id === editorSelected.id) ?? null;
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
      #${EDITOR_ID} .bms-ed-groups{display:flex;flex-direction:column;gap:6px;padding:8px;overflow-y:auto;min-height:0;flex:1}
      #${EDITOR_ID} .bms-ed-group{border:1px solid #2c425d;border-radius:7px;background:#0d1829;overflow:hidden;flex:none}
      #${EDITOR_ID} .bms-ed-group-head{display:flex;align-items:center;gap:6px;width:100%;height:32px;padding:0 10px;border:none;border-radius:0;background:#16273e;font-size:12px;text-align:left;color:#dbe7f7}
      #${EDITOR_ID} .bms-ed-group-head:hover:not(:disabled){background:#1e3553;border-color:transparent}
      #${EDITOR_ID} .bms-ed-group-count{margin-left:auto;font-size:10px;color:#8fa8c6;background:#203858;border-radius:9px;padding:1px 7px;flex:none}
      #${EDITOR_ID} .bms-ed-group-chevron{margin-left:6px;font-size:10px;color:#7d95b5;display:inline-block;transition:transform .15s ease;flex:none}
      #${EDITOR_ID} .bms-ed-group.bms-ed-collapsed .bms-ed-group-chevron{transform:rotate(-90deg)}
      #${EDITOR_ID} .bms-ed-group-body{display:block}
      #${EDITOR_ID} .bms-ed-group.bms-ed-collapsed .bms-ed-group-body{display:none}
      #${EDITOR_ID} .bms-ed-search-wrap{padding:8px;border-bottom:1px solid #2c425d}
      #${EDITOR_ID} .bms-ed-search{width:100%;height:32px;border:1px solid #385576;border-radius:7px;background:#0a1423;color:#eaf2ff;padding:0 10px;outline:none;user-select:text}
      #${EDITOR_ID} .bms-ed-search:focus{border-color:#78a5d8}
      #${EDITOR_ID} .bms-ed-assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));align-content:start;gap:8px;padding:8px}
      #${EDITOR_ID} .bms-ed-asset{position:relative;height:68px;padding:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:0}
      #${EDITOR_ID} .bms-ed-asset img{width:45px;height:45px;object-fit:contain;image-rendering:auto;pointer-events:none}
      #${EDITOR_ID} .bms-ed-asset span{width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:#b9cde6;text-align:center}
      #${EDITOR_ID} .bms-ed-asset.bms-ed-selected{border:2px solid #78a5d8;background:#2b4a72;box-shadow:0 0 10px rgba(98,211,255,.25)}
      #${EDITOR_ID} .bms-ed-asset.bms-ed-selected::after{content:"✓";position:absolute;right:3px;top:1px;color:#62d3ff;font-size:11px}
      #${EDITOR_ID} .bms-ed-asset.bms-ed-locked{filter:grayscale(1);opacity:.45}
      #${EDITOR_ID} .bms-ed-empty{grid-column:1/-1;color:#8095ae;text-align:center;padding:24px 8px;font-size:12px}
      #${EDITOR_ID} .bms-ed-group .bms-ed-empty{padding:10px 8px}
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
          <div class="bms-ed-search-wrap"><input class="bms-ed-search" type="search" maxlength="60" placeholder="搜索类型、样式或 ID"></div>
          <div class="bms-ed-groups"></div><div class="bms-ed-selection"></div>
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
      // 地块无法删除：切到地块层时若正持橡皮，自动切回画笔
      if (layer === EDITOR_LAYER_TILE && editorTool === EDITOR_TOOL_ERASER) {
        editorTool = EDITOR_TOOL_BRUSH;
        toast("地块无法删除，只能覆盖，已切换为画笔", "info");
      }
      editorQuery = "";
      const input = document.querySelector(`#${EDITOR_ID} .bms-ed-search`);
      if (input) input.value = "";
      renderEditorPalette();
      renderEditorControls();
      drawEditorViewport();
    }
    const group = event.target.closest?.("[data-group-head]")?.dataset.groupHead;
    if (group) {
      toggleEditorGroup(editorLayer, group);
      renderEditorPalette();
    }
    const assetButton = event.target.closest?.("[data-asset-id]");
    if (assetButton && !assetButton.disabled) {
      const id = Number(assetButton.dataset.assetId);
      const candidates = editorLayer === EDITOR_LAYER_TILE
        ? [...editorMaterials.tile, ...editorMaterials.lighting]
        : editorMaterials[editorLayer];
      const material = candidates.find(item => item.id === id);
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

  function isEditorGroupCollapsed(layer, key) {
    const state = editorGroupState[layer];
    return state.has(key) ? state.get(key) : layer === EDITOR_LAYER_OBJECT;
  }

  function toggleEditorGroup(layer, key) {
    editorGroupState[layer].set(key, !isEditorGroupCollapsed(layer, key));
  }

  function renderEditorPalette() {
    const root = document.getElementById(EDITOR_ID);
    if (!root) return;
    root.querySelectorAll("[data-layer]").forEach(button => button.classList.toggle("bms-ed-active", button.dataset.layer === editorLayer));
    const materials = editorLayer === EDITOR_LAYER_TILE
      ? [...editorMaterials.tile, ...editorMaterials.lighting]
      : editorMaterials[editorLayer];
    const categories = [...new Set(materials.map(item => item.type))];
    // 最近分类固定存在，始终置顶；其余按分类生成折叠组
    const groups = [
      { key: "recent", label: "最近", items: editorRecent.filter(item => item.layer === editorLayer && materials.some(current => current.id === item.id)) },
      ...categories.map(type => ({ key: type, label: EDITOR_CATEGORY_LABELS[type] || "其他分类", items: filterEditorMaterials(materials, type) })),
    ];
    const groupHost = root.querySelector(".bms-ed-groups");
    groupHost.innerHTML = groups.map(group => {
      const visible = editorQuery ? filterEditorMaterials(group.items, "", editorQuery) : group.items;
      if (editorQuery && visible.length === 0) return "";
      const collapsed = isEditorGroupCollapsed(editorLayer, group.key);
      const body = visible.length ? visible.map(material => {
        const selected = editorSelected?.layer === material.layer && editorSelected.id === material.id;
        const title = material.owned
          ? `${EDITOR_CATEGORY_LABELS[material.type] || "其他素材"} / ${material.label} · ID ${material.id}`
          : `需要持有 ${material.definition.AssetGroup} / ${material.definition.AssetName}`;
        return `<button class="bms-ed-asset${selected ? " bms-ed-selected" : ""}${material.owned ? "" : " bms-ed-locked"}" data-asset-id="${material.id}" title="${escapeHTML(title)}" ${material.owned ? "" : "disabled"}><img src="${escapeHTML(editorMaterialImage(material))}" alt=""><span>${escapeHTML(material.label)}</span></button>`;
      }).join("") : `<div class="bms-ed-empty">${group.key === "recent" ? "暂无最近使用的素材" : "暂无素材"}</div>`;
      return `<section class="bms-ed-group${collapsed ? " bms-ed-collapsed" : ""}" data-group="${escapeHTML(group.key)}">
        <button class="bms-ed-group-head" data-group-head="${escapeHTML(group.key)}"><span>${escapeHTML(group.label)}</span><span class="bms-ed-group-count">${visible.length}</span><span class="bms-ed-group-chevron">▾</span></button>
        <div class="bms-ed-group-body"><div class="bms-ed-assets">${body}</div></div></section>`;
    }).join("");
    const selection = root.querySelector(".bms-ed-selection");
    selection.innerHTML = editorSelected
      ? `当前：<strong>${editorSelected.layer === EDITOR_LAYER_TILE ? "地块" : "物件"} · ${escapeHTML(EDITOR_CATEGORY_LABELS[editorSelected.type] || "其他素材")} / ${escapeHTML(editorSelected.label)}</strong>`
      : `当前：<strong>${editorLayer === EDITOR_LAYER_TILE ? "请选择地块" : "请选择物件"}</strong>`;
  }

  function renderEditorControls() {
    const root = document.getElementById(EDITOR_ID);
    if (!root) return;
    root.querySelectorAll("[data-tool]").forEach(button => button.classList.toggle("bms-ed-active", button.dataset.tool === editorTool));
    // 地块层无法删除：橡皮只对物件层可用
    const eraser = root.querySelector('[data-tool="eraser"]');
    if (eraser) {
      eraser.disabled = editorLayer === EDITOR_LAYER_TILE;
      eraser.title = editorLayer === EDITOR_LAYER_TILE ? "地块无法删除，只能覆盖" : "删除物件";
    }
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

    // 光照层：按原版绘制顺序叠加在物件之上，半透明色块填充整格
    if (Array.isArray(editorWorking.Effects)) {
      for (let i = 0; i < size.width * size.height; i++) {
        const list = editorWorking.Effects[i];
        if (!Array.isArray(list) || list.length === 0) continue;
        const x = (i % size.width) * EDITOR_TILE_SIZE;
        const y = Math.floor(i / size.width) * EDITOR_TILE_SIZE;
        for (const effect of list) {
          const color = effect?.Color;
          if (!Array.isArray(color) || color.length < 4) continue;
          ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${color[3]})`;
          ctx.fillRect(x, y, EDITOR_TILE_SIZE, EDITOR_TILE_SIZE);
        }
      }
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
    const preview = !erasing && editorSelected?.layer === editorLayer ? getEditorImage(editorMaterialImage(editorSelected)) : null;
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
