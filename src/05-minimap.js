  // ===== 简化房间地图（第二功能模块） =====
  // 大号操作面板：色块渲染全图（可通行/墙壁/障碍），右侧玩家列表，管理员可选中玩家并传送到任意格子。
  // 视口变换：滚轮缩放（鼠标锚点）+ 拖拽平移。坐标换算按 canvas 内部像素 / CSS 像素比例进行，
  // 免疫全局样式或浏览器缩放造成的尺寸不一致。

  const MINIMAP_ID = "bms-minimap";
  const MINIMAP_TOGGLE_ID = "bms-minimap-toggle";
  const MINIMAP_TOGGLE_POS = Object.freeze({ x: 10, y: 570, width: 60, height: 60 }); // “档”按钮正下方
  const MINIMAP_CANVAS_SIZE = 520;
  const MINIMAP_TILE = 12;
  const MINIMAP_GAP = 1;
  const MINIMAP_ZOOM_MIN = 0.5;
  const MINIMAP_ZOOM_MAX = 8;
  const MINIMAP_TICK_MS = 250;
  const MINIMAP_DRAG_THRESHOLD = 4;
  const MINIMAP_VERIFY_DELAY_MS = 2500;
  const MINIMAP_PLAYER_COLORS = ["#e8a0c0", "#8fd0ff", "#a8d68f", "#ffd08f", "#d0a8ff", "#ff9d9d", "#9df0e0", "#f0e0a0"];
  const MINIMAP_TILE_COLORS = {
    [TILE_KIND_EMPTY]: "#232a36",
    [TILE_KIND_FLOOR]: "#b8a48c",
    [TILE_KIND_OUTDOOR]: "#a3b98d",
    [TILE_KIND_WALL]: "#6a5d52",
    [TILE_KIND_HALF_WALL]: "#96826e",
    [TILE_KIND_WATER]: "#7cb3d4",
    [TILE_KIND_OTHER]: "#8a8f98",
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
      #${MINIMAP_TOGGLE_ID}{position:fixed;left:${MINIMAP_TOGGLE_POS.x}px;top:${MINIMAP_TOGGLE_POS.y}px;z-index:99980;width:${MINIMAP_TOGGLE_POS.width}px;height:${MINIMAP_TOGGLE_POS.height}px;border:1px solid #4b6e98;border-radius:10px;background:#203858;color:#f2f7ff;font-size:18px;font-weight:700;cursor:pointer;font-family:Inter,"Microsoft YaHei",sans-serif;line-height:1}
      #${MINIMAP_TOGGLE_ID}:hover{background:#2b4a72;border-color:#78a5d8}
      #${MINIMAP_ID}{position:fixed;left:50%;top:36px;transform:translateX(-50%);z-index:99990;width:806px;background:#111d31;border:1px solid #45678f;border-radius:12px;box-shadow:0 18px 52px rgba(0,0,0,.6);font-family:Inter,"Microsoft YaHei",sans-serif;color:#eaf2ff;user-select:none;overflow:hidden}
      #${MINIMAP_ID} *{box-sizing:border-box}
      #${MINIMAP_ID} header{display:flex;align-items:center;gap:8px;padding:9px 12px;background:linear-gradient(135deg,#1b3151,#17243b);border-bottom:1px solid #385576}
      #${MINIMAP_ID} .bms-mm-title{font-size:15px;font-weight:750;letter-spacing:.03em}
      #${MINIMAP_ID} .bms-mm-room{font-size:12px;color:#9eb4ce;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${MINIMAP_ID} .bms-mm-spacer{flex:1}
      #${MINIMAP_ID} header button{appearance:none;width:28px;height:28px;border:1px solid #4b6e98;border-radius:7px;background:#203858;color:#f2f7ff;font-size:15px;line-height:1;cursor:pointer}
      #${MINIMAP_ID} header button:hover{background:#2b4a72;border-color:#78a5d8}
      #${MINIMAP_ID} .bms-mm-body{display:flex;gap:12px;padding:10px 12px}
      #${MINIMAP_ID} canvas{width:${MINIMAP_CANVAS_SIZE}px;height:${MINIMAP_CANVAS_SIZE}px;flex:none;background:#0b1220;border:1px solid #2c425d;border-radius:6px;cursor:grab;touch-action:none}
      #${MINIMAP_ID} canvas.bms-mm-dragging{cursor:grabbing}
      #${MINIMAP_ID} .bms-mm-side{flex:1;display:flex;flex-direction:column;min-width:0;border:1px solid #2c425d;border-radius:6px;background:#0f1a2c;overflow:hidden}
      #${MINIMAP_ID} .bms-mm-side-title{padding:8px 10px;font-size:12px;font-weight:700;color:#9eb4ce;border-bottom:1px solid #2c425d;background:#152238}
      #${MINIMAP_ID} .bms-mm-roster{list-style:none;margin:0;padding:6px;flex:1;overflow-y:auto;min-height:0}
      #${MINIMAP_ID} .bms-mm-roster li{display:flex;gap:8px;align-items:center;padding:7px 9px;border-radius:7px;cursor:pointer;font-size:13px;border:1px solid transparent}
      #${MINIMAP_ID} .bms-mm-roster li:hover{background:#1c3250}
      #${MINIMAP_ID} .bms-mm-roster li.bms-mm-selected{background:#2b4a72;border-color:#78a5d8}
      #${MINIMAP_ID} .bms-mm-dot{width:10px;height:10px;border-radius:50%;flex:none}
      #${MINIMAP_ID} .bms-mm-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #${MINIMAP_ID} .bms-mm-pos{font-size:12px;color:#8fb3d8;font-family:Consolas,monospace}
      #${MINIMAP_ID} .bms-mm-me{font-size:11px;color:#ffd94d;border:1px solid #806a41;border-radius:999px;padding:0 6px}
      #${MINIMAP_ID} .bms-mm-hint{padding:8px 10px;font-size:11px;color:#7d93ad;line-height:1.7;border-top:1px solid #2c425d}
      #${MINIMAP_ID} footer{padding:0 12px 12px;min-height:50px}
      .bms-mm-status{font-size:12px;color:#a8bdd5;line-height:1.7}
      .bms-mm-status strong{color:#8fd0ff}
      .bms-mm-status .bms-mm-warn{color:#ffc981}
      .bms-mm-status .bms-mm-bad{color:#ff9d9d}
      .bms-mm-actions{display:flex;gap:6px;margin-top:5px}
      .bms-mm-actions button{appearance:none;border:1px solid #4b6e98;border-radius:7px;background:#203858;color:#f2f7ff;padding:6px 14px;font-size:13px;cursor:pointer}
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

  function ensureMinimapToggle() {
    let button = document.getElementById(MINIMAP_TOGGLE_ID);
    if (button) return button;
    button = document.createElement("button");
    button.id = MINIMAP_TOGGLE_ID;
    button.title = "简化房间地图";
    button.textContent = "图";
    button.addEventListener("click", toggleMinimap);
    document.body.appendChild(button);
    return button;
  }

  function syncMinimapToggle() {
    const button = document.getElementById(MINIMAP_TOGGLE_ID);
    if (!button) return;
    button.style.display = shouldShowMinimap() && !minimapOpen ? "" : "none";
  }

  function ensureMinimapRoot() {
    let root = document.getElementById(MINIMAP_ID);
    if (root) return root;
    root = document.createElement("section");
    root.id = MINIMAP_ID;
    root.innerHTML = `
      <header>
        <span class="bms-mm-title">简化房间地图</span>
        <span class="bms-mm-room"></span>
        <span class="bms-mm-spacer"></span>
        <button data-mm="zoomOut" title="缩小">−</button>
        <button data-mm="zoomIn" title="放大">＋</button>
        <button data-mm="fit" title="复位">⤢</button>
        <button data-mm="close" title="关闭">×</button>
      </header>
      <div class="bms-mm-body">
        <canvas width="${MINIMAP_CANVAS_SIZE}" height="${MINIMAP_CANVAS_SIZE}"></canvas>
        <aside class="bms-mm-side">
          <div class="bms-mm-side-title">房间成员</div>
          <ul class="bms-mm-roster"></ul>
          <div class="bms-mm-hint">滚动缩放 · 拖拽平移 · 点击玩家选中<br>点击格子选择传送目标</div>
        </aside>
      </div>
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

    root.querySelector(".bms-mm-roster").addEventListener("click", event => {
      const item = event.target.closest?.("[data-member]");
      if (!item) return;
      minimapHandleRosterClick(Number(item.dataset.member));
    });
    return root;
  }

  function fitMinimapView() {
    if (!minimapGrid) return;
    const size = minimapGridPixelSize(minimapGrid);
    const zoom = (MINIMAP_CANVAS_SIZE / size) * 0.96;
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

  // 事件坐标 → canvas 内部像素坐标（比例换算，免疫 CSS 尺寸与属性尺寸不一致）
  function minimapEventToCanvasXY(canvas, rect, clientX, clientY) {
    const scaleX = rect.width > 0 ? canvas.width / rect.width : 1;
    const scaleY = rect.height > 0 ? canvas.height / rect.height : 1;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function minimapCanvasToGrid(mx, my) {
    if (!minimapGrid) return null;
    const gx = Math.floor(mx / minimapView.zoom / minimapTileStep());
    const gy = Math.floor(my / minimapView.zoom / minimapTileStep());
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
          ctx.fillStyle = "rgba(0,0,0,0.45)";
          ctx.fillRect(x * step, y * step, MINIMAP_TILE, MINIMAP_TILE);
        }
      }
    }
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
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

    // Hover 高亮
    if (minimapHover) {
      const p = minimapGridToCanvas(minimapHover.x, minimapHover.y);
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fillRect(p.x, p.y, step, step);
    }

    // 待确认传送目标
    if (minimapPending) {
      const p = minimapGridToCanvas(minimapPending.x, minimapPending.y);
      ctx.fillStyle = minimapPending.walkable ? "rgba(60,180,90,0.30)" : "rgba(255,110,110,0.32)";
      ctx.fillRect(p.x, p.y, step, step);
      ctx.strokeStyle = minimapPending.walkable ? "#3cb45a" : "#ff6e6e";
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
      const radius = Math.max(3, Math.min(8, MINIMAP_TILE * minimapView.zoom * 0.34));
      const isMe = character.MemberNumber === myNumber;
      const isSelected = minimapSelected === character.MemberNumber;
      ctx.beginPath();
      ctx.arc(p.x + step / 2, p.y + step / 2, radius, 0, Math.PI * 2);
      ctx.fillStyle = isMe ? "#f5f9ff" : minimapPlayerColor(character.MemberNumber);
      ctx.fill();
      ctx.lineWidth = isSelected ? 3 : 1.4;
      ctx.strokeStyle = isSelected ? "#ffd94d" : isMe ? "#4d94d5" : "rgba(10,15,25,0.85)";
      ctx.stroke();
      // 自己头顶标记
      if (isMe) {
        ctx.beginPath();
        ctx.arc(p.x + step / 2, p.y + step / 2 - radius - 3, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = "#8fd0ff";
        ctx.fill();
      }
      // hover 名字
      if (minimapHover && pos.X === minimapHover.x && pos.Y === minimapHover.y) {
        const name = character.Name ? String(character.Name) : `#${character.MemberNumber}`;
        ctx.font = "12px Inter, 'Microsoft YaHei', sans-serif";
        const width = ctx.measureText(name).width + 12;
        const bx = Math.max(0, Math.min(MINIMAP_CANVAS_SIZE - width, p.x + step / 2 - width / 2));
        const by = Math.max(0, p.y + step / 2 - radius - 22);
        ctx.fillStyle = "rgba(10,16,28,0.88)";
        ctx.fillRect(bx, by, width, 18);
        ctx.strokeStyle = "rgba(120,160,210,0.6)";
        ctx.strokeRect(bx, by, width, 18);
        ctx.fillStyle = isMe ? "#8fd0ff" : "#eaf2ff";
        ctx.fillText(name, bx + 6, by + 14);
      }
    }
  }

  function renderMinimapRoster() {
    const root = document.getElementById(MINIMAP_ID);
    if (!root) return;
    const listEl = root.querySelector(".bms-mm-roster");
    if (!listEl) return;
    const list = getRoomCharacterList();
    const myNumber = currentMemberNumber();
    const admin = isRoomAdmin();
    listEl.innerHTML = list.map(character => {
      const pos = character.MapData?.Pos;
      const isMe = character.MemberNumber === myNumber;
      const isSelected = minimapSelected === character.MemberNumber;
      const name = character.Name ? String(character.Name) : `#${character.MemberNumber}`;
      return `<li data-member="${character.MemberNumber}" class="${isSelected ? "bms-mm-selected" : ""}" title="${admin ? "点击选中后传送" : ""}">
        <span class="bms-mm-dot" style="background:${isMe ? "#f5f9ff" : minimapPlayerColor(character.MemberNumber)}"></span>
        <span class="bms-mm-name">${escapeHTML(name)}</span>
        <span class="bms-mm-pos">(${pos?.X ?? "-"}, ${pos?.Y ?? "-"})</span>
        ${isMe ? '<span class="bms-mm-me">我</span>' : ""}
      </li>`;
    }).join("") || '<li style="cursor:default;color:#7d93ad">房间内没有玩家</li>';
  }

  function minimapHandleRosterClick(memberNumber) {
    if (!isRoomAdmin()) return;
    if (minimapSelected === memberNumber) {
      minimapSelected = null;
      minimapPending = null;
    } else {
      minimapSelected = memberNumber;
      minimapPending = null;
    }
    renderMinimapStatus();
    renderMinimapRoster();
    drawMinimap();
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
        html = `<div class="bms-mm-status">已选中 <strong>${escapeHTML(name)}</strong> (${target.MapData?.Pos?.X}, ${target.MapData?.Pos?.Y})，点击地图选择目标格子；右键或再次点击取消。</div>
          <div class="bms-mm-actions"><button data-mm-action="cancel">取消选中</button></div>`;
      }
    } else if (admin) {
      html = `<div class="bms-mm-status">点击玩家（地图或列表）选中，然后点击目标格子传送（穿墙）。滚动缩放，拖拽平移。</div>`;
    } else {
      html = `<div class="bms-mm-status">只读概览：滚动缩放，拖拽平移。</div>`;
    }
    footer.innerHTML = html;
    footer.querySelector('[data-mm-action="confirm"]')?.addEventListener("click", () => {
      if (!minimapPending) return;
      const { member, x, y } = minimapPending;
      minimapPending = null;
      minimapSelected = null;
      renderMinimapStatus();
      renderMinimapRoster();
      drawMinimap();
      teleportWithVerify(member, x, y);
    });
    footer.querySelector('[data-mm-action="cancel"]')?.addEventListener("click", () => {
      minimapPending = null;
      minimapSelected = null;
      renderMinimapStatus();
      renderMinimapRoster();
      drawMinimap();
    });
  }

  // 传送结果校验（纯逻辑）：目标仍在房间且位置已变为目标坐标才算完成广播。
  // 注意：目标处于聊天视图时位置已本地更新但未广播，切回地图视图后会自动生效，
  // 因此“位置未变化”不等于传送失败，只提示尚未同步。
  function teleportVerificationMessage(target, x, y) {
    if (!target) return "目标已不在房间，传送可能未生效";
    const pos = target.MapData?.Pos;
    if (!pos || pos.X !== x || pos.Y !== y) return "目标尚未同步新位置：若目标处于聊天视图，切回地图视图后将自动生效；否则可能客户端版本过旧";
    return "传送成功：目标位置已更新";
  }

  // 判断一条 Hidden 消息是否为“发给当前玩家”的原版传送指令
  function isTeleportMessageFor(data, memberNumber) {
    return !!data
      && data.Type === "Hidden"
      && data.Content === "ChatRoomMapViewTeleport"
      && Number(data.Target) === Number(memberNumber);
  }

  // 接收端增强：原版 ChatRoomMapViewTeleport 只更新本地 MapData.Pos，真正的广播由
  // ChatRoomMapViewUpdatePlayerSync 在地图视图运行循环里消费标志后发送。目标玩家停在
  // 聊天视图时标志无人消费，位置不生效。这里在原版处理完成后强制广播一次（幂等）。
  function installTeleportReceiveBoost() {
    modApi.hookFunction("ChatRoomMessage", 1000, (args, next) => {
      const data = args[0];
      const result = next(args);
      try {
        if (isTeleportMessageFor(data, currentMemberNumber())) {
          const serverSend = getServerSend();
          const player = getPlayerCharacter();
          if (serverSend && player?.MapData) serverSend("ChatRoomCharacterMapDataUpdate", player.MapData);
        }
      } catch (error) {
        warn("传送后强制同步失败", error);
      }
      return result;
    });
  }

  function teleportWithVerify(member, x, y) {
    let mode;
    try {
      mode = teleportCharacter(member, x, y);
    } catch (error) {
      toast(error.message, "error");
      return;
    }
    if (member === currentMemberNumber()) {
      toast("已传送到目标位置", "success");
      return;
    }
    toast(`传送指令已发出（${mode === "native" ? "原生接口" : "兼容消息"}），等待目标同步…`, "success");
    setTimeout(() => {
      const target = findRoomCharacter(member);
      toast(teleportVerificationMessage(target, x, y), target ? "success" : "error");
    }, MINIMAP_VERIFY_DELAY_MS);
  }

  function minimapHandleWheel(event) {
    event.preventDefault();
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const pos = minimapEventToCanvasXY(canvas, rect, event.clientX, event.clientY);
    minimapZoomAt(pos.x, pos.y, event.deltaY < 0 ? 1.18 : 1 / 1.18);
  }

  function minimapHandlePointerDown(event) {
    const canvas = event.currentTarget;
    if (event.button === 2) {
      minimapSelected = null;
      minimapPending = null;
      renderMinimapStatus();
      renderMinimapRoster();
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
    const pos = minimapEventToCanvasXY(canvas, rect, event.clientX, event.clientY);
    const grid = minimapCanvasToGrid(pos.x, pos.y);
    minimapHover = grid;
    if (minimapDrag && minimapDrag.pointerId === event.pointerId) {
      const dx = event.clientX - minimapDrag.startX;
      const dy = event.clientY - minimapDrag.startY;
      if (Math.abs(dx) > MINIMAP_DRAG_THRESHOLD || Math.abs(dy) > MINIMAP_DRAG_THRESHOLD) minimapDrag.moved = true;
      minimapView.panX = minimapDrag.panX + dx;
      minimapView.panY = minimapDrag.panY + dy;
    }
    drawMinimap();
    if (!minimapDrag?.moved && grid) renderMinimapHoverStatus(grid);
  }

  function renderMinimapHoverStatus(grid) {
    if (minimapPending || minimapSelected != null) return;
    const root = document.getElementById(MINIMAP_ID);
    if (!root) return;
    const character = findRoomCharacterAt(grid.x, grid.y);
    const walkable = minimapGrid?.walkable[grid.y * minimapGrid.width + grid.x] === 1;
    const text = character
      ? `格子 (${grid.x}, ${grid.y})：${escapeHTML(character.Name ? String(character.Name) : `#${character.MemberNumber}`)}`
      : `格子 (${grid.x}, ${grid.y})：${walkable ? "可站人" : '<span class="bms-mm-bad">不可站人</span>'}`;
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
    const pos = minimapEventToCanvasXY(canvas, rect, event.clientX, event.clientY);
    const grid = minimapCanvasToGrid(pos.x, pos.y);
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
      renderMinimapRoster();
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
      renderMinimapRoster();
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
      renderMinimapRoster();
      drawMinimap();
    }
  }

  function openMinimap() {
    if (minimapOpen) return;
    minimapOpen = true;
    ensureMinimapRoot();
    syncMinimapToggle();
    const room = getChatRoomData();
    const roomEl = document.querySelector(`#${MINIMAP_ID} .bms-mm-room`);
    if (roomEl) roomEl.textContent = room?.Name ? `房间：${room.Name}` : "";
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
    syncMinimapToggle();
  }

  function toggleMinimap() {
    if (minimapOpen) closeMinimap(true);
    else openMinimap();
  }

  function installMinimapHooks() {
    if (typeof document === "undefined") return; // 简化地图依赖 DOM，无 DOM 环境（测试沙箱）不安装
    installTeleportReceiveBoost();
    modApi.hookFunction("ChatRoomRun", 0, (args, next) => {
      const result = next(args);
      if (shouldShowMinimap()) {
        if (minimapAutoOpen && !minimapOpen) openMinimap();
        if (minimapOpen) minimapTick();
        syncMinimapToggle();
      } else if (minimapOpen) {
        closeMinimap();
      }
      return result;
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
