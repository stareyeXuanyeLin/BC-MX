  function exposePublicAPI() {
    globalThis.BCMapSaver = Object.freeze({
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
    });
  }

  function detectDuplicateInstance() {
    if (!globalThis.BCMapSaver && !document.getElementById(STYLE_ID) && !document.getElementById(ROOT_ID)) return false;
    duplicateInstance = true;
    console.error(`[${MOD_NAME}] 检测到另一份 BC Map Saver，当前实例停止安装。`);
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
        injectStyle();
        injectMinimapStyle();
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
      buildMapGridSnapshot,
      teleportCharacter,
      createTeleportMessage,
      isPositionWalkable,
      tileKindOf,
      findRoomCharacter,
      getRoomCharacterList,
      playerPositionSignature,
      installHooksForTest: api => { modApi = api; installHooks(); installMinimapHooks(); },
      constants: { STORAGE_SCHEMA_VERSION, MAP_FILE_FORMAT, LIBRARY_FILE_FORMAT, FILE_FORMAT_VERSION, MAX_AUTO_BACKUPS },
    };
  } else {
    const timer = setInterval(() => {
      initialize();
      if (initialized || duplicateInstance) clearInterval(timer);
    }, 500);
    globalThis.addEventListener?.("load", initialize);
  }
})();
