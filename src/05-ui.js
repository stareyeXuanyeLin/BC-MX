  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID}{position:fixed;inset:0;z-index:100000;background:rgba(8,15,28,.78);display:flex;align-items:center;justify-content:center;font-family:Inter,"Microsoft YaHei",sans-serif;color:#eaf2ff;pointer-events:auto}
      #${ROOT_ID} *{box-sizing:border-box}
      .bms-panel{width:min(1120px,94vw);height:min(780px,92vh);display:flex;flex-direction:column;background:#111d31;border:1px solid #45678f;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden}
      .bms-header{display:flex;align-items:center;gap:14px;padding:18px 22px;background:linear-gradient(135deg,#1b3151,#17243b);border-bottom:1px solid #385576}
      .bms-title{font-size:24px;font-weight:750;letter-spacing:.02em}.bms-subtitle{font-size:13px;color:#9eb4ce;margin-top:3px}.bms-spacer{flex:1}
      .bms-toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid #2c425d;background:#132139}
      .bms-btn{appearance:none;border:1px solid #4b6e98;border-radius:9px;background:#203858;color:#f2f7ff;padding:9px 14px;font-size:14px;line-height:1.2;cursor:pointer;transition:.15s ease}
      .bms-btn:hover{background:#2b4a72;border-color:#78a5d8}.bms-btn:disabled{opacity:.42;cursor:not-allowed}.bms-btn-primary{background:#2966a3;border-color:#4d94d5}.bms-btn-danger{background:#682e3b;border-color:#a95065}.bms-btn-quiet{background:transparent}.bms-btn-small{padding:7px 10px;font-size:13px}
      .bms-status{font-size:13px;color:#a8bdd5;padding-left:4px}.bms-status strong{color:#8fd0ff}.bms-warning{color:#ffc981}
      .bms-list{flex:1;overflow:auto;padding:16px 20px 24px}.bms-empty{height:100%;display:grid;place-content:center;text-align:center;color:#8fa6c0;font-size:16px;line-height:1.8}
      .bms-card{display:grid;grid-template-columns:minmax(220px,1fr) minmax(260px,1.5fr) auto;gap:18px;align-items:center;padding:15px 16px;margin-bottom:11px;background:#172740;border:1px solid #314d6d;border-radius:12px}
      .bms-card:hover{border-color:#527ba8}.bms-name{font-size:17px;font-weight:700;color:#f5f9ff;overflow-wrap:anywhere}.bms-meta{font-size:12px;color:#91a9c3;margin-top:5px;line-height:1.55}.bms-note{font-size:13px;color:#c1d0e1;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.bms-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
      .bms-badge{display:inline-block;padding:2px 7px;border:1px solid #5a7898;border-radius:999px;font-size:11px;color:#bad1e8;margin-left:7px;vertical-align:2px}.bms-badge-auto{border-color:#806a41;color:#f0ce8d}
      .bms-dialog-backdrop{position:absolute;inset:0;background:rgba(5,10,18,.72);display:grid;place-items:center;padding:24px}.bms-dialog{width:min(560px,92vw);max-height:85vh;overflow:auto;background:#182942;border:1px solid #5478a1;border-radius:14px;padding:22px;box-shadow:0 20px 55px rgba(0,0,0,.5)}
      .bms-dialog h3{margin:0 0 10px;font-size:20px}.bms-dialog p{color:#c0d0e1;line-height:1.65;margin:8px 0}.bms-field{display:block;margin:15px 0}.bms-field span{display:block;font-size:13px;color:#a9bfd7;margin-bottom:7px}.bms-field input,.bms-field textarea{width:100%;border:1px solid #49698d;border-radius:8px;background:#0f1c2e;color:#f3f7fc;padding:10px 12px;font:inherit;outline:none}.bms-field textarea{height:110px;resize:vertical}.bms-field input:focus,.bms-field textarea:focus{border-color:#79afe5}.bms-dialog-actions{display:flex;justify-content:flex-end;gap:9px;flex-wrap:wrap;margin-top:20px}.bms-import-options{display:grid;gap:9px;margin-top:16px}.bms-import-options .bms-btn{text-align:left;padding:11px 13px}
      .bms-toast{position:fixed;right:24px;bottom:24px;z-index:100002;max-width:440px;padding:12px 16px;border-radius:10px;background:#1e3858;border:1px solid #5c83ad;color:#f4f8ff;box-shadow:0 12px 30px rgba(0,0,0,.4);opacity:0;transform:translateY(10px);transition:.18s ease;pointer-events:none}.bms-toast.bms-show{opacity:1;transform:none}.bms-toast.bms-error{background:#572b36;border-color:#bb6378}.bms-toast.bms-success{background:#234b43;border-color:#58a691}
      @media(max-width:860px){.bms-card{grid-template-columns:1fr}.bms-actions{justify-content:flex-start}.bms-panel{height:94vh}.bms-toolbar{padding:11px}.bms-list{padding:11px}}
    `;
    document.head.appendChild(style);
  }

  function sortedRecords() {
    return [...library.records].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.addEventListener("click", handleRootClick);
    document.body.appendChild(root);
    return root;
  }

  function recordCardHTML(record) {
    const badges = `${record.autoBackup ? '<span class="bms-badge bms-badge-auto">自动备份</span>' : ''}${record.mapType ? `<span class="bms-badge">${escapeHTML(record.mapType)}</span>` : ""}`;
    return `<article class="bms-card" data-record-id="${escapeHTML(record.id)}">
      <div><div class="bms-name">${escapeHTML(record.name)}${badges}</div><div class="bms-meta">修改：${escapeHTML(localTimestamp(record.updatedAt))}<br>来源：${escapeHTML(record.sourceRoomName || "未记录")}</div></div>
      <div class="bms-note">${escapeHTML(record.note || "没有备注")}</div>
      <div class="bms-actions">
        <button class="bms-btn bms-btn-primary bms-btn-small" data-action="apply" data-id="${escapeHTML(record.id)}">应用到房间</button>
        <button class="bms-btn bms-btn-small" data-action="overwrite" data-id="${escapeHTML(record.id)}">用当前地图覆盖</button>
        <button class="bms-btn bms-btn-small" data-action="export-one" data-id="${escapeHTML(record.id)}">导出</button>
        <button class="bms-btn bms-btn-small" data-action="edit" data-id="${escapeHTML(record.id)}">编辑</button>
        <button class="bms-btn bms-btn-danger bms-btn-small" data-action="delete" data-id="${escapeHTML(record.id)}">删除</button>
      </div>
    </article>`;
  }

  function renderUI() {
    if (!uiOpen) return;
    const root = ensureRoot();
    const records = sortedRecords();
    root.innerHTML = `<section class="bms-panel" role="dialog" aria-modal="true" aria-label="地图存档">
      <header class="bms-header"><div><div class="bms-title">地图存档</div><div class="bms-subtitle">本地保存，不写入角色数据 · v${VERSION}</div></div><div class="bms-spacer"></div><button class="bms-btn bms-btn-quiet" data-action="close">关闭</button></header>
      <div class="bms-toolbar">
        <button class="bms-btn bms-btn-primary" data-action="save-new">保存当前地图</button>
        <button class="bms-btn" data-action="import">导入文件</button>
        <button class="bms-btn" data-action="export-all" ${records.length ? "" : "disabled"}>导出全部</button>
        <span class="bms-status">当前房间：<strong>${escapeHTML(globalThis.ChatRoomData?.Name || "未知")}</strong>　共 ${records.length} 张地图${library.loadError ? `　<span class="bms-warning">检测到损坏数据，恢复副本：${escapeHTML(storageRecoveryKey || "创建失败")}</span>` : ""}</span>
      </div>
      <main class="bms-list">${records.length ? records.map(recordCardHTML).join("") : '<div class="bms-empty">还没有本地地图。<br>点击“保存当前地图”创建第一张存档。</div>'}</main>
      <input id="${FILE_INPUT_ID}" type="file" accept=".json,.bcmap,.bcmapset,text/plain,application/json" hidden>
      <div class="bms-dialog-host"></div>
    </section>`;
    root.querySelector(`#${FILE_INPUT_ID}`)?.addEventListener("change", handleFileSelection, { once: true });
  }

  function openUI() {
    try {
      assertRoomMapAction();
      if (activeStorageKey !== storageKeyForCurrentPlayer()) readLibraryFromStorage();
      uiOpen = true;
      renderUI();
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function closeUI() {
    uiOpen = false;
    document.getElementById(ROOT_ID)?.remove();
  }

  function dialogHost() {
    return document.querySelector(`#${ROOT_ID} .bms-dialog-host`);
  }

  function closeDialog() {
    const host = dialogHost();
    if (host) host.innerHTML = "";
  }

  function showDialog(title, bodyHTML, buttons) {
    const host = dialogHost();
    if (!host) return;
    host.innerHTML = `<div class="bms-dialog-backdrop"><section class="bms-dialog"><h3>${escapeHTML(title)}</h3>${bodyHTML}<div class="bms-dialog-actions"></div></section></div>`;
    const actions = host.querySelector(".bms-dialog-actions");
    for (const button of buttons) {
      const element = document.createElement("button");
      element.className = `bms-btn ${button.className || ""}`;
      element.textContent = button.label;
      element.addEventListener("click", button.onClick);
      actions.appendChild(element);
    }
  }

  function showMapForm(title, record, onSave) {
    const name = record?.name || globalThis.ChatRoomData?.Name || `地图 ${localTimestamp(now())}`;
    const note = record?.note || "";
    showDialog(title, `<label class="bms-field"><span>名称</span><input class="bms-name-input" maxlength="80" value="${escapeHTML(name)}"></label><label class="bms-field"><span>备注</span><textarea class="bms-note-input" maxlength="500">${escapeHTML(note)}</textarea></label>`, [
      { label: "取消", onClick: closeDialog },
      { label: "保存", className: "bms-btn-primary", onClick: () => {
        const enteredName = clampText(dialogHost()?.querySelector(".bms-name-input")?.value, 80);
        const enteredNote = clampText(dialogHost()?.querySelector(".bms-note-input")?.value, 500);
        if (!enteredName) return toast("请输入地图名称", "error");
        try {
          onSave(enteredName, enteredNote);
          closeDialog();
          renderUI();
          toast("地图已保存到本地", "success");
        } catch (error) { toast(error.message, "error"); }
      } },
    ]);
    dialogHost()?.querySelector(".bms-name-input")?.focus();
  }

  function showConfirm(title, message, confirmLabel, onConfirm, danger = false) {
    showDialog(title, `<p>${escapeHTML(message)}</p>`, [
      { label: "取消", onClick: closeDialog },
      { label: confirmLabel, className: danger ? "bms-btn-danger" : "bms-btn-primary", onClick: () => {
        try {
          onConfirm();
          closeDialog();
          renderUI();
        } catch (error) { toast(error.message, "error"); }
      } },
    ]);
  }

  function showImportOptions(parsed) {
    const kindText = parsed.kind === "library" ? "完整地图库" : "单张地图";
    const optionButtons = [
      ["keepBoth", "保留双方", "冲突记录以新的 ID 和名称导入"],
      ["overwriteId", "按 ID 覆盖", "相同 ID 的本地记录将被导入记录覆盖"],
      ["overwriteName", "按名称覆盖", "同名本地记录将被导入记录覆盖"],
      ["skip", "跳过冲突", "ID 或名称冲突的记录不导入"],
    ];
    if (parsed.kind === "library") optionButtons.push(["replaceAll", "替换整个本地地图库", "清空当前地图库后导入文件内容"]);
    const body = `<p>识别为${kindText}，包含 <strong>${parsed.records.length}</strong> 张地图。请选择冲突处理方式。</p><div class="bms-import-options">${optionButtons.map(([strategy, label, description]) => `<button class="bms-btn ${strategy === "replaceAll" ? "bms-btn-danger" : ""}" data-import-strategy="${strategy}"><strong>${escapeHTML(label)}</strong><br><span>${escapeHTML(description)}</span></button>`).join("")}</div>`;
    showDialog("导入地图文件", body, [{ label: "取消", onClick: closeDialog }]);
    dialogHost()?.querySelectorAll("[data-import-strategy]").forEach(button => button.addEventListener("click", () => {
      const strategy = button.dataset.importStrategy;
      try {
        const plan = buildImportPlan(library, parsed.records, strategy);
        persistLibrary(plan.library);
        closeDialog();
        renderUI();
        toast(`导入完成：新增 ${plan.stats.added}，覆盖 ${plan.stats.overwritten}，跳过 ${plan.stats.skipped}`, "success");
      } catch (error) { toast(error.message, "error"); }
    }));
  }

  async function handleFileSelection(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error("导入文件超过大小限制");
      const parsed = parseImportDocument(await file.text(), file.name);
      showImportOptions(parsed);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      event.target.value = "";
    }
  }

  function handleRootClick(event) {
    const actionElement = event.target.closest?.("[data-action]");
    if (!actionElement) return;
    const action = actionElement.dataset.action;
    const id = actionElement.dataset.id;
    const record = id ? findRecord(id) : null;

    if (action === "close") return closeUI();
    if (action === "save-new") return showMapForm("保存当前地图", null, (name, note) => saveCurrentMapAsNew(name, note));
    if (action === "import") return document.getElementById(FILE_INPUT_ID)?.click();
    if (action === "export-all") {
      try { exportWholeLibrary(); toast("已导出全部地图", "success"); } catch (error) { toast(error.message, "error"); }
      return;
    }
    if (!record) return toast("找不到地图记录", "error");

    if (action === "export-one") {
      try { exportSingleRecord(record); toast("地图文件已导出", "success"); } catch (error) { toast(error.message, "error"); }
    } else if (action === "edit") {
      showMapForm("编辑地图信息", record, (name, note) => updateRecordMetadata(record.id, { name, note }));
    } else if (action === "delete") {
      showConfirm("删除地图", `确定删除“${record.name}”吗？此操作只影响本地存档。`, "删除", () => {
        deleteRecord(record.id);
        toast("地图已删除", "success");
      }, true);
    } else if (action === "overwrite") {
      showConfirm("覆盖本地存档", `用房间“${globalThis.ChatRoomData?.Name || "当前房间"}”的当前地图覆盖“${record.name}”？`, "覆盖保存", () => {
        overwriteSavedMapFromCurrent(record.id);
        toast("本地存档已覆盖", "success");
      });
    } else if (action === "apply") {
      showConfirm("覆盖当前房间地图", `将“${record.name}”应用到房间“${globalThis.ChatRoomData?.Name || "当前房间"}”，并同步给房间内所有玩家。插件会先自动备份当前地图。`, "应用并同步", () => {
        applySavedMapToRoom(record.id);
        toast("地图已载入，等待 BC 同步房间", "success");
      });
    }
  }

  function shouldDrawEntryButton() {
    return globalThis.CurrentScreen === "ChatRoom"
      && typeof globalThis.ChatRoomMapViewIsActive === "function"
      && ChatRoomMapViewIsActive()
      && globalThis.ChatRoomMapViewEditMode === ""
      && isMapRoom()
      && isRoomAdmin();
  }

  function installHooks() {
    modApi.hookFunction("ChatRoomMapViewDrawUi", 0, (args, next) => {
      const result = next(args);
      if (uiOpen && !isRoomAdmin()) closeUI();
      if (shouldDrawEntryButton() && typeof globalThis.DrawButton === "function") {
        DrawButton(ENTRY_BUTTON.x, ENTRY_BUTTON.y, ENTRY_BUTTON.width, ENTRY_BUTTON.height, "档", "#DDEBFF", "");
      }
      return result;
    });
    modApi.hookFunction("ChatRoomMapViewClick", 1000, (args, next) => {
      if (shouldDrawEntryButton() && typeof globalThis.MouseIn === "function" && MouseIn(ENTRY_BUTTON.x, ENTRY_BUTTON.y, ENTRY_BUTTON.width, ENTRY_BUTTON.height)) {
        openUI();
        return;
      }
      return next(args);
    });
    for (const functionName of ["ChatRoomLeave", "ChatRoomMapViewDeactivate"]) {
      if (typeof globalThis[functionName] !== "function") continue;
      modApi.hookFunction(functionName, 1000, (args, next) => {
        closeUI();
        return next(args);
      });
    }
  }
