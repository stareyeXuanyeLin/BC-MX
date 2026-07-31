  // ===== 小地图（第二功能模块） =====
  // 独立 DOM canvas 浮窗：静态网格底图离屏缓存，玩家层动态重绘。
  // 视口变换：滚轮缩放（鼠标锚点）+ 拖拽平移。管理员可选中玩家并传送到任意格子（穿墙语义）。

  const MINIMAP_ID = "bms-minimap";
  const MINIMAP_BUTTON = Object.freeze({ x: 940, y: 10, width: 50, height: 50 });
  const MINIMAP_CANVAS_SIZE = 300;
  const MINIMAP_TILE = 6;
  const MINIMAP_GAP = 1;
  const MINIMAP_ZOOM_MIN = 0.5;
  const MINIMAP_ZOOM_MAX = 8;
  const MINIMAP_TICK_MS = 250;
  const MINIMAP_DRAG_THRESHOLD = 4;
  const MINIMAP_PLAYER_COLORS = ["#e8a0c0", "#8fd0ff", "#a8d68f", "#ffd08f", "#d0a8ff", "#ff9d9d", "#9df0e0", "#f0e0a0"];
  const MINIMAP_TILE_COLORS = {
    [TILE_KIND_EMPTY]: "#1b2230",
    [TILE_KIND_FLOOR]: "#4b5a70",
    [TILE_KIND_OUTDOOR]: "#4f5d43",
    [TILE_KIND_WALL]: "#23272e",
    [TILE_KIND_HALF_WALL]: "#5a4636",
    [TILE_KIND_WATER]: "#3a6d8c",
    [TILE_KIND_OTHER]: "#3a4150",
  };

  let minimapOpen = false;
  let minimapAutoOpen = true;
  let minimapGrid = null;
  let minimapView = { zoom: 1, panX: 0, panY: 0 };
  let minimapDrag = null;
  let minimapHover = null;
  let minimapSelected = null;
  let minimapPending = null;
  let minimapPlayerSig = "";
  let minimapDirty = true;
  let minimapBgCanvas = null;

  function injectMinimapStyle() {
    if (document.getElementById("bms-minimap-style")) return;
    const style = document.createElement("style");
    style.id = "bms-minimap-style";
    style.textContent = `
      #${MINIMAP_ID}{position:fixed;left:648px;top:48px;z-index:99990;width:352px;background:#111d31;border:1px solid #45678f;border-radius:12px;box-shadow:0 16px 46px rgba(0,0,0,.5);font-family:Inter,"Microsoft YaHei",sans-serif;color:#eaf2ff;user-select:none;overflow:hidden}
      #${MINIMAP_ID} *{box-sizing:border-box}
      #${MINIMAP_ID} header{display:flex;align-items:center;gap:6px;padding:8px 10px;background:linear-gradient(135deg,#1b3151,#17243b);border-bottom:1px solid #385576}
      #${MINIMAP_ID} .bms-mm-title{font-size:14px;font-weight:700;letter-spacing:.03em}
      #${MINIMAP_ID} .bms-mm-spacer{flex:1}
      #${MINIMAP_ID} header button{appearance:none;width:26px;height:26px;border:1px solid #4b6e98;border-radius:7px;background:#203858;color:#f2f7ff;font-size:14px;line-height:1;cursor:pointer}
      #${MINIMAP_ID} header button:hover{background:#2b4a72;border-color:#78a5d8}
      #${MINIMAP_ID} canvas{display:block;margin:10px auto 6px;background:#0b1220;border:1px solid #2c425d;border-radius:6px;cursor:grab;touch-action:none}
      #${MINIMAP_ID} canvas.bms-mm-dragging{cursor:grabbing}
      #${MINIMAP_ID} footer{padding:0 10px 10px;min-height:44px}
      .bms-mm-status{font-size:12px;color:#a8bdd5;line-height:1.7}
      .bms-mm-status strong{color:#8fd0ff}
      .bms-mm-status .bms-mm-warn{color:#ffc981}
      .bms-mm-status .bms-mm-bad{color:#ff9d9d}
      .bms-mm-actions{display:flex;gap:6px;margin-top:5px}
      .bms-mm-actions button{appearance:none;border:1px solid #4b6e98;border-radius:7px;background:#203858;color:#f2f7ff;padding:5px 12px;font-size:12px;cursor:pointer}
      .bms-mm-actions button.bms-mm-confirm{background:#2966a3;border-color:#4d94d5}
      .bms-mm-actions button.bms-mm-confirm-warn{background:#7a4a26;border-color:#c98a4a}
    `;
    document.head.appendChild(style);
  }

  function shouldShowMinimap() {
    return globalThis.CurrentScreen === "ChatRoom"
      && isMapRoom()
      && typeof globalThis.ChatRoomMapViewIsActive === "function"
      && ChatRoomMapViewIsActive();
  }

  function minimapTileStep() { return MINIMAP_TILE + MINIMAP_GAP; }

  function minimapGridPixelSize(grid) {
    return grid.width * MINIMAP_TILE + (grid.width - 1) * MINIMAP_GAP;
  }

  function ensureMinimapRoot() {
    let root = document.getElementById(MINIMAP_ID);
    if (root) return root;
    root = document.createElement("section");
    root.id = MINIMAP_ID;
    root.innerHTML = `
      <header>
        <span class="bms-mm-title">小地图</span>
        <span class="bms-mm-spacer"></span>
        <button data-mm="zoomIn" title="放大">+</button>
        <button data-mm="zoomOut" title="缩小">−</button>
        <button data-mm="fit" title="复位">⤢</button>
        <button data-mm="close" title="关闭">×</button>
      </header>
      <canvas width="${MINIMAP_CANVAS_SIZE}" height="${MINIMAP_CANVAS_SIZE}"></canvas>
      <footer class="bms-mm-status"></footer>`;
    document.body.appendChild(root);

    const canvas = root.querySelector("canvas");
    canvas.addEventListener("wheel", minimapHandleWheel, { passive: false });
    canvas.addEventListener("pointerdown", minimapHandlePointerDown);
    canvas.addEventListener("pointermove", minimapHandlePointerMove);
    canvas.addEventListener("pointerup", minimapHandlePointerUp);
    canvas.addEventListener("pointercancel", minimapHandlePointerUp);
    canvas.addEventListener("pointerleave", () => { minimapHover = null; drawMinimap(); });
    canvas.addEventListener("contextmenu", event => event.preventDefault());

    root.querySelector("header").addEventListener("click", event => {
      const action = event.target.closest?.("[data-mm]")?.dataset.mm;
      if (action === "zoomIn") minimapZoomAt(MINIMAP_CANVAS_SIZE / 2, MINIMAP_CANVAS_SIZE / 2, 1.25);
      else if (action === "zoomOut") minimapZoomAt(MINIMAP_CANVAS_SIZE / 2, MINIMAP_CANVAS_SIZE / 2, 1 / 1.25);
      else if (action === "fit") fitMinimapView();
      else if (action === "close") closeMinimap(true);
    });
    return root;
  }

  function fitMinimapView() {
    if (!minimapGrid) return;
    const size = minimapGridPixelSize(minimapGrid);
    const zoom = Math.min(MINIMAP_CANVAS_SIZE / size, MINIMAP_CANVAS_SIZE / size) * 0.96;
    minimapView = {
      zoom: Math.max(MINIMAP_ZOOM_MIN, Math.min(MINIMAP_ZOOM_MAX, zoom)),
      panX: (MINIMAP_CANVAS_SIZE - size * zoom) / 2,
      panY: (MINIMAP_CANVAS_SIZE - size * zoom) / 2,
    };
  }

  function minimapZoomAt(mx, my, factor) {
    const next = Math.max(MINIMAP_ZOOM_MIN, Math.min(MINIMAP_ZOOM_MAX, minimapView.zoom * factor));
    const ratio = next / minimapView.zoom;
    minimapView.panX = mx - (mx - minimapView.panX) * ratio;
    minimapView.panY = my - (my - minimapView.panY) * ratio;
    minimapView.zoom = next;
    drawMinimap();
  }

  function minimapCanvasToGrid(mx, my) {
    if (!minimapGrid) return null;
    const gx = Math.floor((mx - minimapView.panX) / minimapView.zoom / minimapTileStep());
    const gy = Math.floor((my - minimapView.panY) / minimapView.zoom / minimapTileStep());
    if (gx < 0 || gy < 0 || gx >= minimapGrid.width || gy >= minimapGrid.height) return null;
    return { x: gx, y: gy };
  }

  function minimapGridToCanvas(x, y) {
    return {
      x: x * minimapTileStep() * minimapView.zoom + minimapView.panX,
      y: y * minimapTileStep() * minimapView.zoom + minimapView.panY,
    };
  }

  function rebuildMinimapBackground() {
    if (!minimapGrid) return;
    const size = minimapGridPixelSize(minimapGrid);
    minimapBgCanvas = document.createElement("canvas");
    minimapBgCanvas.width = size;
    minimapBgCanvas.height = size;
    const ctx = minimapBgCanvas.getContext("2d");
    const step = minimapTileStep();
    for (let y = 0; y < minimapGrid.height; y++) {
      for (let x = 0; x < minimapGrid.width; x++) {
        const index = y * minimapGrid.width + x;
        ctx.fillStyle = MINIMAP_TILE_COLORS[minimapGrid.tileKind[index]] ?? MINIMAP_TILE_COLORS[TILE_KIND_EMPTY];
        ctx.fillRect(x * step, y * step, MINIMAP_TILE, MINIMAP_TILE);
        if (minimapGrid.walkable[index] !== 1) {
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(x * step, y * step, MINIMAP_TILE, MINIMAP_TILE);
        }
      }
    }
    ctx.strokeStyle = "rgba(0,0,0,0.30)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= minimapGrid.width; x++) {
      ctx.beginPath();
      ctx.moveTo(x * step - 0.5, 0);
      ctx.lineTo(x * step - 0.5, size);
      ctx.stroke();
    }
    for (let y = 0; y <= minimapGrid.height; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * step - 0.5);
      ctx.lineTo(size, y * step - 0.5);
      ctx.stroke();
    }
  }

  function playerPositionSignature() {
    const list = getRoomCharacterList();
    return list.map(c => `${c.MemberNumber}:${c.MapData.Pos.X},${c.MapData.Pos.Y}`).sort().join("|");
  }

  function findRoomCharacterAt(gx, gy) {
    const list = getRoomCharacterList();
    return list.find(c => c.MapData?.Pos?.X === gx && c.MapData?.Pos?.Y === gy) ?? null;
  }

  function minimapPlayerColor(memberNumber) {
    return MINIMAP_PLAYER_COLORS[Math.abs(Number(memberNumber) || 0) % MINIMAP_PLAYER_COLORS.length];
  }

  function drawMinimap() {
    const root = document.getElementById(MINIMAP_ID);
    if (!root || !minimapGrid) return;
    const canvas = root.querySelector("canvas");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, MINIMAP_CANVAS_SIZE, MINIMAP_CANVAS_SIZE);
    if (minimapBgCanvas) ctx.drawImage(minimapBgCanvas, minimapView.panX, minimapView.panY, minimapBgCanvas.width * minimapView.zoom, minimapBgCanvas.height * minimapView.zoom);

    const step = minimapTileStep() * minimapView.zoom;
    const tilePx = MINIMAP_TILE * minimapView.zoom;

    // Hover 高亮
    if (minimapHover) {
      const p = minimapGridToCanvas(minimapHover.x, minimapHover.y);
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fillRect(p.x, p.y, step, step);
    }

    // 待确认传送目标
    if (minimapPending) {
      const p = minimapGridToCanvas(minimapPending.x, minimapPending.y);
      ctx.fillStyle = minimapPending.walkable ? "rgba(90,210,120,0.30)" : "rgba(255,110,110,0.32)";
      ctx.fillRect(p.x, p.y, step, step);
      ctx.strokeStyle = minimapPending.walkable ? "#5ad278" : "#ff6e6e";
      ctx.lineWidth = 2;
      ctx.strokeRect(p.x + 1, p.y + 1, step - 2, step - 2);
    }

    // 选中玩家 → hover 目标连线
    const selected = minimapSelected != null ? findRoomCharacter(minimapSelected) : null;
    if (selected?.MapData?.Pos && minimapHover) {
      const from = minimapGridToCanvas(selected.MapData.Pos.X, selected.MapData.Pos.Y);
      const to = minimapGridToCanvas(minimapHover.x, minimapHover.y);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(from.x + step / 2, from.y + step / 2);
      ctx.lineTo(to.x + step / 2, to.y + step / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 玩家点
    const list = getRoomCharacterList();
    const myNumber = currentMemberNumber();
    for (const character of list) {
      const pos = character.MapData?.Pos;
      if (!pos) continue;
      const p = minimapGridToCanvas(pos.X, pos.Y);
      const radius = Math.max(2.5, Math.min(7, tilePx * 0.34));
      const isMe = character.MemberNumber === myNumber;
      const isSelected = minimapSelected === character.MemberNumber;
      ctx.beginPath();
      ctx.arc(p.x + step / 2, p.y + step / 2, radius, 0, Math.PI * 2);
      ctx.fillStyle = isMe ? "#f5f9ff" : minimapPlayerColor(character.MemberNumber);
      ctx.fill();
      ctx.lineWidth = isSelected ? 2.5 : 1.2;
      ctx.strokeStyle = isSelected ? "#ffd94d" : isMe ? "#4d94d5" : "rgba(10,15,25,0.8)";
      ctx.stroke();
      // 自己头顶标记
      if (isMe) {
        ctx.beginPath();
        ctx.arc(p.x + step / 2, p.y + step / 2 - radius - 2, 2, 0, Math.PI * 2);
        ctx.fillStyle = "#8fd0ff";
        ctx.fill();
      }
      // hover 名字
      if (minimapHover && pos.X === minimapHover.x && pos.Y === minimapHover.y) {
        const name = character.Name ? String(character.Name) : `#${character.MemberNumber}`;
        ctx.font = "11px Inter, 'Microsoft YaHei', sans-serif";
        const width = ctx.measureText(name).width + 10;
        const bx = Math.max(0, Math.min(MINIMAP_CANVAS_SIZE - width, p.x + step / 2 - width / 2));
        const by = Math.max(0, p.y + step / 2 - radius - 20);
        ctx.fillStyle = "rgba(10,16,28,0.85)";
        ctx.fillRect(bx, by, width, 17);
        ctx.strokeStyle = "rgba(120,160,210,0.6)";
        ctx.strokeRect(bx, by, width, 17);
        ctx.fillStyle = isMe ? "#8fd0ff" : "#eaf2ff";
        ctx.fillText(name, bx + 5, by + 13);
      }
    }
  }

  function renderMinimapStatus() {
    const root = document.getElementById(MINIMAP_ID);
    if (!root) return;
    const footer = root.querySelector("footer");
    const admin = isRoomAdmin();
    let html = "";
    if (minimapPending) {
      const target = findRoomCharacter(minimapPending.member);
      const name = target?.Name ? String(target.Name) : `#${minimapPending.member}`;
      const warn = minimapPending.walkable ? "" : `<span class="bms-mm-bad">落点不可站人，玩家将被推挤到邻近位置</span>`;
      html = `<div class="bms-mm-status">传送 <strong>${escapeHTML(name)}</strong> 到 (${minimapPending.x}, ${minimapPending.y})${warn ? `<br>${warn}` : ""}</div>
        <div class="bms-mm-actions">
          <button class="bms-mm-confirm${minimapPending.walkable ? "" : "-warn"}" data-mm-action="confirm">确认传送</button>
          <button data-mm-action="cancel">取消</button>
        </div>`;
    } else if (minimapSelected != null) {
      const target = findRoomCharacter(minimapSelected);
      if (target) {
        const name = target.Name ? String(target.Name) : `#${minimapSelected}`;
        html = `<div class="bms-mm-status">已选中 <strong>${escapeHTML(name)}</strong> (${target.MapData?.Pos?.X}, ${target.MapData?.Pos?.Y})，点击目标格子传送；右键或再次点击取消。</div>
          <div class="bms-mm-actions"><button data-mm-action="cancel">取消选中</button></div>`;
      }
    } else if (admin) {
      html = `<div class="bms-mm-status">点击玩家选中后可将其传送至任意格子（穿墙）。滚动缩放，拖拽平移。</div>`;
    } else {
      html = `<div class="bms-mm-status">只读概览：滚动缩放，拖拽平移。</div>`;
    }
    footer.innerHTML = html;
    const confirmButton = footer.querySelector('[data-mm-action="confirm"]');
    confirmButton?.addEventListener("click", () => {
      try {
        if (!minimapPending) return;
        const { member, x, y } = minimapPending;
        teleportCharacter(member, x, y);
        toast("传送指令已发出", "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        minimapPending = null;
        minimapSelected = null;
        renderMinimapStatus();
        drawMinimap();
      }
    });
    footer.querySelector('[data-mm-action="cancel"]')?.addEventListener("click", () => {
      minimapPending = null;
      minimapSelected = null;
      renderMinimapStatus();
      drawMinimap();
    });
  }

  function minimapHandleWheel(event) {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    minimapZoomAt(mx, my, event.deltaY < 0 ? 1.18 : 1 / 1.18);
  }

  function minimapHandlePointerDown(event) {
    const canvas = event.currentTarget;
    if (event.button === 2) {
      minimapSelected = null;
      minimapPending = null;
      renderMinimapStatus();
      drawMinimap();
      return;
    }
    if (event.button !== 0) return;
    canvas.setPointerCapture?.(event.pointerId);
    minimapDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX: minimapView.panX, panY: minimapView.panY, moved: false };
    canvas.classList.add("bms-mm-dragging");
  }

  function minimapHandlePointerMove(event) {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const grid = minimapCanvasToGrid(mx, my);
    if (grid) {
      minimapHover = grid;
    } else {
      minimapHover = null;
    }
    if (minimapDrag && minimapDrag.pointerId === event.pointerId) {
      const dx = event.clientX - minimapDrag.startX;
      const dy = event.clientY - minimapDrag.startY;
      if (Math.abs(dx) > MINIMAP_DRAG_THRESHOLD || Math.abs(dy) > MINIMAP_DRAG_THRESHOLD) minimapDrag.moved = true;
      minimapView.panX = minimapDrag.panX + dx;
      minimapView.panY = minimapDrag.panY + dy;
    }
    drawMinimap();
    if (!minimapDrag?.moved && grid) renderMinimapHoverStatus();
  }

  function renderMinimapHoverStatus() {
    if (minimapPending || minimapSelected != null) return;
    const root = document.getElementById(MINIMAP_ID);
    if (!root || !minimapHover) return;
    const character = findRoomCharacterAt(minimapHover.x, minimapHover.y);
    const walkable = minimapGrid?.walkable[minimapHover.y * minimapGrid.width + minimapHover.x] === 1;
    const text = character
      ? `格子 (${minimapHover.x}, ${minimapHover.y})：${escapeHTML(character.Name ? String(character.Name) : `#${character.MemberNumber}`)}`
      : `格子 (${minimapHover.x}, ${minimapHover.y})：${walkable ? "可站人" : '<span class="bms-mm-bad">不可站人</span>'}`;
    root.querySelector("footer").innerHTML = `<div class="bms-mm-status">${text}</div>`;
  }

  function minimapHandlePointerUp(event) {
    const canvas = event.currentTarget;
    canvas.classList.remove("bms-mm-dragging");
    if (!minimapDrag || minimapDrag.pointerId !== event.pointerId) return;
    const wasDrag = minimapDrag.moved;
    minimapDrag = null;
    if (wasDrag) return;
    const rect = canvas.getBoundingClientRect();
    const grid = minimapCanvasToGrid(event.clientX - rect.left, event.clientY - rect.top);
    if (!grid) return;
    minimapHandleClick(grid.x, grid.y);
  }

  function minimapHandleClick(gx, gy) {
    const character = findRoomCharacterAt(gx, gy);
    if (character) {
      if (!isRoomAdmin()) return; // 只读模式不选中
      if (minimapSelected === character.MemberNumber) {
        minimapSelected = null;
        minimapPending = null;
      } else {
        minimapSelected = character.MemberNumber;
        minimapPending = null;
      }
      renderMinimapStatus();
      drawMinimap();
      return;
    }
    if (minimapSelected == null || !minimapGrid) return;
    const selected = findRoomCharacter(minimapSelected);
    if (!selected) {
      minimapSelected = null;
      return;
    }
    const pos = selected.MapData?.Pos;
    if (pos && pos.X === gx && pos.Y === gy) {
      minimapSelected = null;
      minimapPending = null;
      renderMinimapStatus();
      drawMinimap();
      return;
    }
    const walkable = minimapGrid.walkable[gy * minimapGrid.width + gx] === 1;
    minimapPending = { member: minimapSelected, x: gx, y: gy, walkable };
    renderMinimapStatus();
    drawMinimap();
  }

  function minimapTick() {
    if (!minimapOpen) return;
    if (!shouldShowMinimap()) {
      closeMinimap();
      return;
    }
    const grid = buildMapGridSnapshot();
    if (!grid) return;
    if (!minimapGrid || grid.tiles !== minimapGrid.tiles || grid.objects !== minimapGrid.objects || minimapDirty) {
      minimapGrid = grid;
      minimapDirty = false;
      rebuildMinimapBackground();
      if (minimapSelected == null && minimapPending == null) fitMinimapView();
    } else {
      minimapGrid = grid;
    }
    const sig = playerPositionSignature();
    if (sig !== minimapPlayerSig) {
      minimapPlayerSig = sig;
      drawMinimap();
    }
  }

  function openMinimap() {
    if (minimapOpen) return;
    minimapOpen = true;
    ensureMinimapRoot();
    minimapGrid = null;
    minimapDirty = true;
    minimapView = { zoom: 1, panX: 0, panY: 0 };
    minimapTick();
  }

  function closeMinimap(manual = false) {
    if (!minimapOpen) return;
    minimapOpen = false;
    minimapSelected = null;
    minimapPending = null;
    minimapHover = null;
    minimapDrag = null;
    if (manual) minimapAutoOpen = false;
    document.getElementById(MINIMAP_ID)?.remove();
  }

  function toggleMinimap() {
    if (minimapOpen) closeMinimap(true);
    else openMinimap();
  }

  function installMinimapHooks() {
    if (typeof document === "undefined") return; // 小地图依赖 DOM，无 DOM 环境（测试沙箱）不安装
    modApi.hookFunction("ChatRoomRun", 0, (args, next) => {
      const result = next(args);
      if (shouldShowMinimap()) {
        if (typeof globalThis.DrawButton === "function") {
          DrawButton(MINIMAP_BUTTON.x, MINIMAP_BUTTON.y, MINIMAP_BUTTON.width, MINIMAP_BUTTON.height, "图", "#DDEBFF", "");
        }
        if (minimapAutoOpen && !minimapOpen) openMinimap();
        if (minimapOpen) minimapTick();
      } else if (minimapOpen) {
        closeMinimap();
      }
      return result;
    });
    modApi.hookFunction("ChatRoomClick", 1000, (args, next) => {
      if (shouldShowMinimap() && typeof globalThis.MouseIn === "function" && MouseIn(MINIMAP_BUTTON.x, MINIMAP_BUTTON.y, MINIMAP_BUTTON.width, MINIMAP_BUTTON.height)) {
        toggleMinimap();
        return;
      }
      return next(args);
    });
    modApi.hookFunction("ChatRoomMapViewUpdateFlag", 0, (args, next) => {
      const result = next(args);
      minimapDirty = true; // 地图被编辑：下一个 tick 重建底图
      return result;
    });
    if (typeof globalThis.ChatRoomSyncRoomProperties === "function") {
      modApi.hookFunction("ChatRoomSyncRoomProperties", 1000, (args, next) => {
        const result = next(args);
        minimapGrid = null; // 房间属性替换：强制重建
        minimapDirty = true;
        minimapAutoOpen = true; // 进入新房间重新自动打开
        minimapSelected = null;
        minimapPending = null;
        return result;
      });
    }
    if (typeof globalThis.ChatRoomLeave === "function") {
      modApi.hookFunction("ChatRoomLeave", 1000, (args, next) => {
        closeMinimap();
        return next(args);
      });
    }
  }
