  function exposePublicAPI() {
    const api = Object.freeze({
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
      editor: {
        open: openEditor,
        close: closeEditor,
        toggle: toggleEditor,
        isOpen: () => editorOpen,
      },
    });
    // BCMX 为当前正式 API 名；BCMapSaver 保留为兼容别名，供已发布时依赖旧名的外部脚本使用。
    globalThis.BCMX = api;
    globalThis.BCMapSaver = api;
  }

  function detectDuplicateInstance() {
    if (!globalThis.BCMX && !globalThis.BCMapSaver && !document.getElementById(STYLE_ID) && !document.getElementById(ROOT_ID)) return false;
    duplicateInstance = true;
    console.error(`[${MOD_NAME}] 检测到另一份 BC Map eXtended，当前实例停止安装。`);
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
        installEditorHooks();
        installStealthHooks();
        injectStyle();
        injectMinimapStyle();
        injectEditorStyle();
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
      shouldDrawMinimapEntryButton,
      buildMapGridSnapshot,
      teleportCharacter,
      createTeleportMessage,
      isPositionWalkable,
      tileKindOf,
      objectMarkerOf,
      findRoomCharacter,
      getRoomCharacterList,
      playerPositionSignature,
      getChatRoomMapViewTeleport,
      getServerSend,
      minimapEventToCanvasXY,
      minimapCanvasToGridXY,
      minimapDefaultPanelLeft,
      minimapPlayerColor,
      canvasEventToInternalXY,
      viewportCanvasToGridXY,
      viewportGridToCanvasXY,
      buildEditorMaterials,
      buildLightingMaterials,
      editorLightingSwatch,
      editorEffectsEqual,
      filterEditorMaterials,
      editorStyleLabel,
      editorMaterialOwned,
      editorBrushCells,
      applyEditorStroke,
      editorSnapshotWorking,
      editorPushWorkingToMap,
      editorObjectCellCompatible,
      createEditorHistory,
      editorPushUndo,
      editorUndoMap,
      editorRedoMap,
      editorCanvasToGridXY,
      editorGridToCanvasXY,
      shouldDrawEditorEntryButton,
      isStealthEnabled,
      setStealthEnabled,
      isCharacterHidden,
      isLocalMapViewActive,
      isCharacterMapViewActive,
      applyStealthMarker,
      applyMapViewPresenceMarker,
      syncLocalMapViewPresence,
      installStealthHooks,
      teleportVerificationMessage,
      chooseAdminFlipPlan,
      triggerSilentMapDataRefresh,
      forceSyncUnsyncedTarget,
      isTeleportMessageFor,
      buildSwapTeleportPlan,
      isPositionReachable,
      installHooksForTest: api => { modApi = api; installHooks(); installMinimapHooks(); installEditorHooks(); installStealthHooks(); },
      constants: { STORAGE_SCHEMA_VERSION, MAP_FILE_FORMAT, LIBRARY_FILE_FORMAT, FILE_FORMAT_VERSION, MAX_AUTO_BACKUPS, ENTRY_BUTTON, MINIMAP_ENTRY_BUTTON, MINIMAP_PANEL_WIDTH, MINIMAP_PANEL_EDGE_GAP, OBJECT_MARKER_NONE, OBJECT_MARKER_DOOR, OBJECT_MARKER_ENTRY, OBJECT_MARKER_EXIT, EDITOR_ENTRY_BUTTON, EDITOR_HISTORY_LIMIT, EDITOR_OBJECT_BLANK_ID, EDITOR_LIGHTING_BLANK_ID },
    };
  } else {
    const timer = setInterval(() => {
      initialize();
      if (initialized || duplicateInstance) clearInterval(timer);
    }, 500);
    globalThis.addEventListener?.("load", initialize);
  }
})();
