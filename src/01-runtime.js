  const MOD_NAME = "BCMX";
  const FULL_NAME = "BC Map eXtended";
  const VERSION = "0.3.2";
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
