(function () {
  // Editor module: eraser, undo/redo history, sticker layer (拼贴), custom
  // background image and bottom page tabs. app.js exposes shared handles as
  // window.App; all canvas pointer interactions live here.
  var App = window.App;
  if (!App) return;
  var state = App.state, canvas = App.canvas, stage = App.stage,
      scheduleRender = App.scheduleRender, showToast = App.showToast;
  // Long-press on the canvas must never open the text-selection copy menu or
  // the context menu — it interrupts drags (Android shows selection handles).
  stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  var undoBtn = document.getElementById('undoButton'),
      redoBtn = document.getElementById('redoButton'),
      eraserBtn = document.getElementById('eraserButton'),
      stickerBar = document.getElementById('stickerBar'),
      stickerList = document.getElementById('stickerList'),
      stickerUpload = document.getElementById('stickerUpload'),
      bgUpload = document.getElementById('bgUpload'),
      removeBackgroundBtn = document.getElementById('removeBackground'),
      bgUploadLabel = document.getElementById('bgUploadLabel'),
      tabPattern = document.getElementById('tabPattern'),
      tabSticker = document.getElementById('tabSticker'),
      tabPatternBtn = document.getElementById('tabPatternBtn'),
      tabStickerBtn = document.getElementById('tabStickerBtn');

  function byId(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---------- history (object ops + parameter ops) ----------
  var undoStack = [], redoStack = [];
  // Parameter ops (colors / sliders / pattern drag) share the same undo stack:
  // each op stores before/after snapshots of the tunable fields below.
  var PARAM_FIELDS = ['backgroundColor','backgroundColor2','backgroundGradient','patternColor','patternColor2','patternSize','gapX','gapY','patternAngle','patternOpacity','patternBlur','offsetX','offsetY'];
  var pendingParam = null, paramTimer = 0;
  function snapshotParams() { var s = {}; for (var i = 0; i < PARAM_FIELDS.length; i++) s[PARAM_FIELDS[i]] = state[PARAM_FIELDS[i]]; return s; }
  function sameParams(a, b) { for (var i = 0; i < PARAM_FIELDS.length; i++) if (a[PARAM_FIELDS[i]] !== b[PARAM_FIELDS[i]]) return false; return true; }
  function beginParam() { if (!pendingParam) pendingParam = snapshotParams(); }
  function commitParam() {
    if (!pendingParam) return;
    var before = pendingParam; pendingParam = null;
    var after = snapshotParams();
    if (!sameParams(before, after)) pushOp({ k: 'param', before: before, after: after });
  }
  // Debounced variant for continuous sources without a change event (color picker).
  function noteParam() { beginParam(); clearTimeout(paramTimer); paramTimer = setTimeout(commitParam, 700); }
  // One-shot variant for discrete actions (e.g. swap colors button).
  function pushParamDirect(before) {
    var after = snapshotParams();
    if (!sameParams(before, after)) pushOp({ k: 'param', before: before, after: after });
  }
  function pushOp(op) { if (pendingParam) commitParam(); undoStack.push(op); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; updateHistoryUI(); }
  function findSticker(id) { for (var i = 0; i < state.stickers.length; i++) { if (state.stickers[i].id === id) return state.stickers[i]; } return null; }
  function applyOp(op, isUndo) {
    if (op.k === 'erase') {
      for (var i = 0; i < op.keys.length; i++) { if (isUndo) delete state.erased[op.keys[i]]; else state.erased[op.keys[i]] = 1; }
    } else if (op.k === 'add') {
      if (isUndo) { var idx = state.stickers.indexOf(op.st); if (idx >= 0) state.stickers.splice(idx, 1); }
      else state.stickers.splice(Math.min(op.index || state.stickers.length, state.stickers.length), 0, op.st);
    } else if (op.k === 'del') {
      if (isUndo) state.stickers.splice(Math.min(op.index, state.stickers.length), 0, op.st);
      else { var di = state.stickers.indexOf(op.st); if (di >= 0) state.stickers.splice(di, 1); }
    } else if (op.k === 'xform') {
      var st = findSticker(op.id);
      if (st) { var snap = isUndo ? op.before : op.after; st.x = snap.x; st.y = snap.y; st.scale = snap.scale; st.rotation = snap.rotation; st.flip = snap.flip; st.opacity = snap.opacity == null ? 1 : snap.opacity; }
    } else if (op.k === 'order') {
      var ost = findSticker(op.id), target = isUndo ? op.before : op.after;
      if (ost) { var oi = state.stickers.indexOf(ost); state.stickers.splice(oi, 1); state.stickers.splice(clamp(target, 0, state.stickers.length), 0, ost); }
    } else if (op.k === 'param') {
      var psnap = isUndo ? op.before : op.after;
      for (var pk in psnap) state[pk] = psnap[pk];
      if (App.syncControlsFromState) App.syncControlsFromState();
    }
    if (selectedId && !findSticker(selectedId)) select(null);
    refreshList(); syncBox(); scheduleRender();
  }
  function doUndo() { var op = undoStack.pop(); if (!op) return; applyOp(op, true); redoStack.push(op); updateHistoryUI(); }
  function doRedo() { var op = redoStack.pop(); if (!op) return; applyOp(op, false); undoStack.push(op); updateHistoryUI(); }
  function updateHistoryUI() { undoBtn.disabled = !undoStack.length; redoBtn.disabled = !redoStack.length; }
  undoBtn.addEventListener('click', doUndo);
  redoBtn.addEventListener('click', doRedo);

  // ---------- eraser (whole-motif removal via deterministic lattice keys) ----------
  var eraserActive = false;
  function erasable() { return state.patternType !== 'stripe' && state.patternType !== 'gingham'; }
  function canvasPoint(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * state.canvasWidth / rect.width, y: (e.clientY - rect.top) * state.canvasHeight / rect.height };
  }
  function motifKeyAt(pt) {
    // Undo the pattern rotation around the canvas centre before lattice lookup.
    var a = -(state.patternAngle || 0) * Math.PI / 180, cx = state.canvasWidth / 2, cy = state.canvasHeight / 2;
    var dx = pt.x - cx, dy = pt.y - cy;
    var rx = cx + dx * Math.cos(a) - dy * Math.sin(a), ry = cy + dx * Math.sin(a) + dy * Math.cos(a);
    var periodX = Math.max(1, state.patternSize + state.gapX), periodY = Math.max(1, state.patternSize + state.gapY);
    var row = Math.round((ry - state.offsetY) / periodY);
    var isTile = window.PatternTiles && window.PatternTiles.sources && window.PatternTiles.sources[state.patternType];
    var rowShift = isTile ? 0 : (Math.abs(row) % 2) * periodX / 2;
    var col = Math.round((rx - state.offsetX - rowShift) / periodX);
    return row + '_' + col;
  }
  eraserBtn.addEventListener('click', function () {
    if (!eraserActive) {
      if (!erasable()) { showToast('条纹 / 维希格为连续图案，暂不支持擦除'); return; }
      eraserActive = true;
    } else eraserActive = false;
    eraserBtn.classList.toggle('is-active', eraserActive);
    canvas.classList.toggle('is-erasing', eraserActive);
    if (eraserActive) showToast('橡皮擦已开启：点击或拖动即可擦除图案');
  });
  function setEraser(active) { eraserActive = active; eraserBtn.classList.toggle('is-active', active); canvas.classList.toggle('is-erasing', active); }
  function eraseAt(pt, gesture) {
    var key = motifKeyAt(pt);
    if (!state.erased[key]) { state.erased[key] = 1; gesture.keys.push(key); scheduleRender(); }
  }

  // ---------- stickers ----------
  var idSeq = 1, selectedId = null;
  function snapshot(st) { return { x: st.x, y: st.y, scale: st.scale, rotation: st.rotation, flip: st.flip, opacity: st.opacity == null ? 1 : st.opacity }; }
  function sameSnap(a, b) { return a.x === b.x && a.y === b.y && a.scale === b.scale && a.rotation === b.rotation && a.flip === b.flip && a.opacity === b.opacity; }
  function addSticker(img, name) {
    var nw = img.naturalWidth || 200, nh = img.naturalHeight || 200;
    var fit = Math.min(1, state.canvasWidth * 0.6 / nw, state.canvasHeight * 0.6 / nh);
    var st = { id: 'st' + (idSeq++), image: img, name: name || '贴纸', x: state.canvasWidth / 2, y: state.canvasHeight / 2, scale: fit, rotation: 0, flip: false, opacity: 1 };
    state.stickers.push(st);
    pushOp({ k: 'add', st: st, index: state.stickers.length - 1 });
    select(st.id); refreshList(); scheduleRender();
  }
  function deleteStickerById(id) {
    var st = findSticker(id);
    if (!st) return;
    var index = state.stickers.indexOf(st);
    state.stickers.splice(index, 1);
    pushOp({ k: 'del', st: st, index: index });
    if (selectedId === id) select(null);
    refreshList(); scheduleRender();
  }
  function loadImageFile(file, cb) {
    if (!file) return;
    if (!/^image\/(png|svg\+xml|jpeg|webp)$/.test(file.type)) { showToast('暂不支持该图片格式'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () { cb(img, file.name); };
      img.onerror = function () { showToast('图片加载失败，请重新选择'); };
      img.src = reader.result;
    };
    reader.onerror = function () { showToast('图片加载失败，请重新选择'); };
    reader.readAsDataURL(file);
  }
  stickerUpload.addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    if (!files.length) return;
    var loaded = 0;
    files.forEach(function (file) {
      loadImageFile(file, function (img) { addSticker(img, file.name); loaded++; if (loaded === files.length) showToast('已添加 ' + loaded + ' 张贴纸'); });
    });
    stickerUpload.value = '';
  });

  // ---------- selection box overlay ----------
  var box = document.createElement('div');
  box.className = 'sticker-box';
  box.hidden = true;
  box.innerHTML = '<button class="sb-btn sb-del" type="button" aria-label="删除贴纸">✕</button>' +
                  '<button class="sb-btn sb-flip" type="button" aria-label="水平镜像">⇋</button>' +
                  '<button class="sb-btn sb-rot" type="button" aria-label="旋转与缩放">⟳</button>';
  stage.appendChild(box);
  var boxDel = box.querySelector('.sb-del'), boxFlip = box.querySelector('.sb-flip'), boxRot = box.querySelector('.sb-rot');

  function screenScale() { return canvas.getBoundingClientRect().width / state.canvasWidth; }
  function stickerScreenCenter(st) {
    var cr = canvas.getBoundingClientRect(), sr = stage.getBoundingClientRect(), sc = screenScale();
    return { x: cr.left - sr.left + st.x * sc, y: cr.top - sr.top + st.y * sc };
  }
  function syncBox() {
    var st = selectedSticker();
    if (!st || !st.image || !st.image.naturalWidth) { box.hidden = true; return; }
    var sc = screenScale();
    var w = (st.image.naturalWidth || 200) * st.scale * sc, h = (st.image.naturalHeight || 200) * st.scale * sc;
    var c = stickerScreenCenter(st);
    box.hidden = false;
    box.style.width = w + 'px'; box.style.height = h + 'px';
    box.style.left = (c.x - w / 2) + 'px'; box.style.top = (c.y - h / 2) + 'px';
    box.style.transform = 'rotate(' + (st.rotation || 0) + 'deg)';
  }
  function selectedSticker() { return selectedId ? findSticker(selectedId) : null; }
  function select(id) {
    selectedId = id;
    stickerBar.hidden = !id;
    box.hidden = !id;
    if (!id) { setBarRow(sbOpacityRow, false); setBarRow(sbOrderRow, false); }
    else syncOpacityControl();
    syncBox(); refreshListSel();
  }
  function refreshListSel() {
    var items = stickerList.querySelectorAll('.sticker-item');
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('is-selected', items[i].getAttribute('data-id') === selectedId);
  }

  boxDel.addEventListener('click', function () { if (selectedId) deleteStickerById(selectedId); });
  boxFlip.addEventListener('click', function () {
    var st = selectedSticker(); if (!st) return;
    var before = snapshot(st);
    st.flip = !st.flip;
    pushOp({ k: 'xform', id: st.id, before: before, after: snapshot(st) });
    scheduleRender();
  });

  // Rotate+scale handle: dragging rotates by angle and scales by distance.
  var handleGesture = null;
  boxRot.addEventListener('pointerdown', function (e) {
    var st = selectedSticker(); if (!st || e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault(); e.stopPropagation();
    try { boxRot.setPointerCapture(e.pointerId); } catch (err) {}
    var c = stickerScreenCenter(st);
    handleGesture = { id: st.id, before: snapshot(st), base: { rotation: st.rotation, scale: st.scale }, c: c, a0: Math.atan2(e.clientY - c.y, e.clientX - c.x), d0: Math.max(8, Math.hypot(e.clientX - c.x, e.clientY - c.y)) };
  });
  boxRot.addEventListener('pointermove', function (e) {
    if (!handleGesture) return;
    var st = findSticker(handleGesture.id); if (!st) return;
    var a = Math.atan2(e.clientY - handleGesture.c.y, e.clientX - handleGesture.c.x);
    var d = Math.max(8, Math.hypot(e.clientX - handleGesture.c.x, e.clientY - handleGesture.c.y));
    st.rotation = handleGesture.base.rotation + (a - handleGesture.a0) * 180 / Math.PI;
    st.scale = clamp(handleGesture.base.scale * d / handleGesture.d0, 0.03, 20);
    scheduleRender(); syncBox();
  });
  function endHandleGesture() {
    if (!handleGesture) return;
    var st = findSticker(handleGesture.id);
    if (st && !sameSnap(handleGesture.before, snapshot(st))) pushOp({ k: 'xform', id: st.id, before: handleGesture.before, after: snapshot(st) });
    handleGesture = null;
  }
  boxRot.addEventListener('pointerup', endHandleGesture);
  boxRot.addEventListener('pointercancel', endHandleGesture);

  // ---------- sticker list (拼贴 tab) ----------
  function refreshList() {
    stickerList.innerHTML = '';
    state.stickers.forEach(function (st) {
      var item = document.createElement('div');
      item.className = 'sticker-item' + (st.id === selectedId ? ' is-selected' : '');
      item.setAttribute('data-id', st.id);
      var img = document.createElement('img');
      img.src = st.image.src; img.alt = st.name || '贴纸';
      item.appendChild(img);
      var del = document.createElement('button');
      del.className = 'si-del'; del.type = 'button'; del.textContent = '✕';
      del.setAttribute('aria-label', '删除贴纸');
      del.addEventListener('click', function (ev) { ev.stopPropagation(); deleteStickerById(st.id); });
      item.appendChild(del);
      item.addEventListener('click', function () { select(st.id); showToast('已选中，可在画布上拖动调整'); });
      stickerList.appendChild(item);
    });
  }

  // ---------- object action bar (copy / layer order) ----------
  stickerBar.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.sb-action') : null;
    if (!btn) return;
    var op = btn.getAttribute('data-op');
    if (!op) return; // toggle buttons (透明度/图层顺序) carry no data-op — they
    // have their own listeners; without this guard a null op fell through to
    // the layer-order branch and popped a bogus “已在最下层” toast.
    var st = selectedSticker();
    if (!st) return;
    if (op === 'copy') {
      var clone = { id: 'st' + (idSeq++), image: st.image, name: st.name, x: st.x + 36, y: st.y + 36, scale: st.scale, rotation: st.rotation, flip: st.flip, opacity: st.opacity == null ? 1 : st.opacity };
      state.stickers.push(clone);
      pushOp({ k: 'add', st: clone, index: state.stickers.length - 1 });
      select(clone.id); refreshList(); scheduleRender(); showToast('已复制贴纸');
      return;
    }
    var i = state.stickers.indexOf(st), n = state.stickers.length, j = i;
    if (op === 'up') j = Math.min(n - 1, i + 1);
    else if (op === 'down') j = Math.max(0, i - 1);
    else if (op === 'top') j = n - 1;
    else if (op === 'bottom') j = 0;
    if (j === i) { showToast(op === 'up' || op === 'top' ? '已在最上层' : '已在最下层'); return; }
    state.stickers.splice(i, 1); state.stickers.splice(j, 0, st);
    pushOp({ k: 'order', id: st.id, before: i, after: j });
    refreshList(); scheduleRender();
  });

  // ---------- bar expandable rows: opacity + layer order ----------
  var sbOpacityRow = byId('sbOpacityRow'), sbOrderRow = byId('sbOrderRow'),
      sbOpacityBtn = byId('sbOpacityBtn'), sbOrderBtn = byId('sbOrderBtn'),
      stickerOpacity = byId('stickerOpacity'), sbOpacityVal = byId('sbOpacityVal');
  function setBarRow(row, on) {
    row.hidden = !on;
    var toggle = row === sbOpacityRow ? sbOpacityBtn : sbOrderBtn;
    toggle.classList.toggle('is-on', on);
  }
  function syncOpacityControl() {
    var st = selectedSticker();
    var v = Math.round((st && st.opacity != null ? st.opacity : 1) * 100);
    stickerOpacity.value = v;
    sbOpacityVal.textContent = v + '%';
  }
  sbOpacityBtn.addEventListener('click', function () { setBarRow(sbOpacityRow, sbOpacityRow.hidden); setBarRow(sbOrderRow, false); });
  sbOrderBtn.addEventListener('click', function () { setBarRow(sbOrderRow, sbOrderRow.hidden); setBarRow(sbOpacityRow, false); });

  // Opacity slider: first input captures a before-snapshot, change commits one
  // xform op — a whole drag session collapses into a single undo step.
  var opacityPending = null;
  stickerOpacity.addEventListener('input', function () {
    var st = selectedSticker(); if (!st) return;
    if (!opacityPending || opacityPending.id !== st.id) opacityPending = { id: st.id, before: snapshot(st) };
    st.opacity = stickerOpacity.value / 100;
    sbOpacityVal.textContent = stickerOpacity.value + '%';
    scheduleRender();
  });
  function endOpacitySession() {
    if (!opacityPending) return;
    var st = findSticker(opacityPending.id);
    if (st && !sameSnap(opacityPending.before, snapshot(st))) pushOp({ k: 'xform', id: st.id, before: opacityPending.before, after: snapshot(st) });
    opacityPending = null;
  }
  stickerOpacity.addEventListener('change', endOpacitySession);

  // ---------- built-in sticker pack (js/stickers.js) ----------
  // Grid thumbs use the small StickerPackThumbs array; the full-resolution
  // image is lazy-loaded (new Image) on first click, so the page never
  // decodes all originals up front.
  var stickerGrid = byId('stickerGrid');
  if (stickerGrid && window.StickerPack) {
    var thumbs = window.StickerPackThumbs || window.StickerPack;
    var fullCache = {};
    window.StickerPack.forEach(function (src, idx) {
      var item = document.createElement('button');
      item.type = 'button'; item.className = 'gst-item'; item.setAttribute('aria-label', '添加贴纸');
      var thumb = document.createElement('img');
      thumb.src = thumbs[idx] || src; thumb.alt = ''; thumb.draggable = false; thumb.decoding = 'async';
      item.appendChild(thumb);
      item.addEventListener('click', function () {
        if (fullCache[idx]) { addSticker(fullCache[idx], '贴纸'); return; }
        var img = new Image();
        img.onload = function () { fullCache[idx] = img; addSticker(img, '贴纸'); };
        img.src = src;
      });
      stickerGrid.appendChild(item);
    });
  }

  // ---------- custom background image ----------
  function syncBgLock(locked) {
    var w = byId('canvasWidth'), h = byId('canvasHeight'), lock = byId('lockRatio'), trans = byId('backgroundTransparent');
    w.disabled = h.disabled = lock.disabled = !!locked;
    trans.disabled = !!locked;
    w.value = state.canvasWidth; h.value = state.canvasHeight;
    byId('backgroundColorSection').classList.toggle('is-locked', !!locked);
  }
  bgUpload.addEventListener('change', function (e) {
    loadImageFile(e.target.files && e.target.files[0], function (img, name) {
      state.background = img;
      if (img.naturalWidth) { state.canvasWidth = img.naturalWidth; state.canvasHeight = img.naturalHeight; }
      bgUploadLabel.textContent = name;
      removeBackgroundBtn.hidden = false;
      syncBgLock(true);
      scheduleRender();
      showToast('背景已应用，画布尺寸已跟随图片');
    });
    bgUpload.value = '';
  });
  removeBackgroundBtn.addEventListener('click', function () {
    state.background = null;
    bgUploadLabel.textContent = '上传背景图（画布跟随图片尺寸）';
    removeBackgroundBtn.hidden = true;
    syncBgLock(false);
    scheduleRender();
    showToast('已移除背景图，画布尺寸可自由调整');
  });

  // ---------- bottom page tabs ----------
  function switchTab(name) {
    var isPattern = name === 'pattern';
    tabPatternBtn.classList.toggle('is-active', isPattern);
    tabStickerBtn.classList.toggle('is-active', !isPattern);
    tabPatternBtn.setAttribute('aria-selected', isPattern ? 'true' : 'false');
    tabStickerBtn.setAttribute('aria-selected', isPattern ? 'false' : 'true');
    tabPattern.hidden = !isPattern;
    tabSticker.hidden = isPattern;
  }
  tabPatternBtn.addEventListener('click', function () { switchTab('pattern'); });
  tabStickerBtn.addEventListener('click', function () { switchTab('sticker'); });

  // ---------- unified canvas pointer interactions ----------
  // Modes are mutually exclusive: eraser drag erases, selected-sticker drag moves
  // the sticker, otherwise the drag pans the pattern layer. Two fingers on a
  // selected sticker pinch-zoom (distance) and rotate (angle between fingers).
  var pointers = {}, gesture = null;
  function pointerList() { var pts = []; for (var k in pointers) pts.push(pointers[k]); return pts; }
  function pointerDist(pts) { return Math.max(8, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)); }
  function pointerAngle(pts) { return Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x); }
  function hitSticker(pt) {
    for (var i = state.stickers.length - 1; i >= 0; i--) {
      var st = state.stickers[i];
      if (!st.image || !st.image.naturalWidth) continue;
      var dx = pt.x - st.x, dy = pt.y - st.y, a = -(st.rotation || 0) * Math.PI / 180;
      var lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      var w = st.image.naturalWidth * st.scale, h = st.image.naturalHeight * st.scale;
      if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) return st;
    }
    return null;
  }
  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var pt = canvasPoint(e);
    pointers[e.pointerId] = pt;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    var ids = Object.keys(pointers), sel = selectedSticker();
    if (ids.length === 2 && sel) {
      var pts = pointerList();
      gesture = { type: 'pinch', id: sel.id, before: snapshot(sel), base: { scale: sel.scale, rotation: sel.rotation }, d0: pointerDist(pts), a0: pointerAngle(pts) };
      return;
    }
    if (ids.length > 1) return;
    var hit = hitSticker(pt);
    if (eraserActive) {
      if (hit) { // stickers always win over the eraser
        if (selectedId !== hit.id) select(hit.id);
        gesture = { type: 'move', id: hit.id, start: pt, orig: { x: hit.x, y: hit.y }, before: snapshot(hit) };
        return;
      }
      if (!erasable()) { showToast('条纹 / 维希格为连续图案，暂不支持擦除'); return; }
      gesture = { type: 'erase', keys: [] };
      eraseAt(pt, gesture);
      return;
    }
    if (hit) {
      if (selectedId !== hit.id) select(hit.id);
      gesture = { type: 'move', id: hit.id, start: pt, orig: { x: hit.x, y: hit.y }, before: snapshot(hit) };
    } else {
      if (selectedId) select(null);
      gesture = { type: 'pattern', start: pt, orig: { offsetX: state.offsetX, offsetY: state.offsetY } };
      canvas.classList.add('is-dragging');
    }
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!(e.pointerId in pointers)) return;
    var pt = canvasPoint(e);
    pointers[e.pointerId] = pt;
    if (!gesture) return;
    if (gesture.type === 'pinch') {
      if (Object.keys(pointers).length < 2) return;
      var st = findSticker(gesture.id); if (!st) return;
      var pts = pointerList();
      st.scale = clamp(gesture.base.scale * pointerDist(pts) / gesture.d0, 0.03, 20);
      st.rotation = gesture.base.rotation + (pointerAngle(pts) - gesture.a0) * 180 / Math.PI;
      scheduleRender(); syncBox();
      return;
    }
    if (gesture.type === 'erase') { eraseAt(pt, gesture); return; }
    if (gesture.type === 'move') {
      var mst = findSticker(gesture.id); if (!mst) return;
      mst.x = gesture.orig.x + (pt.x - gesture.start.x);
      mst.y = gesture.orig.y + (pt.y - gesture.start.y);
      scheduleRender(); syncBox();
      return;
    }
    if (gesture.type === 'pattern') {
      state.offsetX = gesture.orig.offsetX + (pt.x - gesture.start.x);
      state.offsetY = gesture.orig.offsetY + (pt.y - gesture.start.y);
      scheduleRender();
    }
  });
  function endCanvasPointer(e) {
    delete pointers[e.pointerId];
    if (!gesture) return;
    if (gesture.type === 'pinch') {
      var st = findSticker(gesture.id);
      if (st && !sameSnap(gesture.before, snapshot(st))) pushOp({ k: 'xform', id: st.id, before: gesture.before, after: snapshot(st) });
      gesture = null;
      return;
    }
    if (gesture.type === 'erase') {
      if (gesture.keys.length) pushOp({ k: 'erase', keys: gesture.keys });
      gesture = null;
      return;
    }
    if (gesture.type === 'move') {
      var mst = findSticker(gesture.id);
      if (mst && !sameSnap(gesture.before, snapshot(mst))) pushOp({ k: 'xform', id: mst.id, before: gesture.before, after: snapshot(mst) });
      gesture = null;
      return;
    }
    if (gesture.type === 'pattern') {
      if (gesture.orig.offsetX !== state.offsetX || gesture.orig.offsetY !== state.offsetY) {
        var pBefore = snapshotParams(); pBefore.offsetX = gesture.orig.offsetX; pBefore.offsetY = gesture.orig.offsetY;
        pushOp({ k: 'param', before: pBefore, after: snapshotParams() });
      }
      gesture = null; canvas.classList.remove('is-dragging');
    }
  }
  canvas.addEventListener('pointerup', endCanvasPointer);
  canvas.addEventListener('pointercancel', endCanvasPointer);

  // Tapping any blank spot in the preview area (frame padding, badge, hint,
  // title row — anything above the params) clears the sticker selection.
  // The canvas itself keeps its own hit-test logic in the handler above.
  var previewSection = document.querySelector('.preview-section');
  if (previewSection) previewSection.addEventListener('pointerdown', function (e) {
    if (!selectedId) return;
    var t = e.target;
    if (t.closest && (t.closest('canvas') || t.closest('.sticker-box') || t.closest('.canvas-tools'))) return;
    select(null);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && selectedId) select(null);
  });

  // Keep the selection box glued to the canvas through resizes / renders.
  if (window.ResizeObserver) new ResizeObserver(syncBox).observe(stage);
  else window.addEventListener('resize', syncBox);

  // Reset (params only) must still re-sync editor UI: background lock, list, selection.
  App.onReset = function () {
    select(null); setEraser(false);
    removeBackgroundBtn.hidden = !state.background;
    bgUploadLabel.textContent = state.background ? bgUploadLabel.textContent : '上传背景图（画布跟随图片尺寸）';
    syncBgLock(!!state.background);
    refreshList();
  };

  updateHistoryUI(); syncBgLock(!!state.background); refreshList();

  // Hooks for app.js controls (sliders, number inputs, color pickers) to feed
  // parameter edits into the same undo/redo history as object operations.
  window.Editor = { snapshotParams: snapshotParams, beginParam: beginParam, commitParam: commitParam, noteParam: noteParam, pushParamDirect: pushParamDirect };
})();
