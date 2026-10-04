(function () {
  function customDimensions(image, size) { var ratio = image.naturalWidth / image.naturalHeight || 1; return ratio >= 1 ? {w:size,h:size/ratio} : {w:size*ratio,h:size}; }
  // Built-in shapes are drawn with the vector paths in patterns.js.
  // Wrought-iron tiles come from js/tiles.js as grayscale+alpha data-URI images
  // (data: URIs never taint the canvas, unlike file:// raster assets) and are
  // tinted to the pattern colour on first use, then cached per colour.
  var tileImages = {}, tintedTiles = {};
  function tileSource(type) { return window.PatternTiles && window.PatternTiles.sources && window.PatternTiles.sources[type]; }
  function getTileImage(type) {
    var img = tileImages[type];
    if (img) return img.complete && img.naturalWidth ? img : null;
    var src = tileSource(type);
    if (!src) return null;
    img = new Image();
    img.onload = function () { if (window.PatternRenderer.onTilesLoaded) window.PatternRenderer.onTilesLoaded(); };
    img.src = src;
    tileImages[type] = img;
    return null;
  }
  function getTintedTile(state, type) {
    var img = getTileImage(type);
    if (!img) return null;
    var key = type + '|' + state.patternColor, cached = tintedTiles[key];
    if (cached) return cached;
    var canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    var c2 = canvas.getContext('2d');
    c2.drawImage(img, 0, 0);
    c2.globalCompositeOperation = 'source-in';
    c2.fillStyle = state.patternColor;
    c2.fillRect(0, 0, canvas.width, canvas.height);
    tintedTiles[key] = canvas;
    return canvas;
  }
  // Deterministic PRNG so leopard cells render identically across preview,
  // export and re-renders (same contract as the eraser's row_col keys).
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // One lattice cell of the leopard pattern: one big two-colour spot plus an
  // optional satellite dot/crescent. Offsets stay inside the cell so spots can
  // never overlap across cell borders -> seamless at any X/Y period.
  function drawLeopardCell(ctx, x, y, px, py, state, row, col) {
    var P = window.Patterns;
    var rand = mulberry32(((row * 73856093) ^ (col * 19349663)) | 0);
    var base = Math.min(px, py) / 2;
    var color = state.patternColor, color2 = state.patternColor2 || null;
    var dx = (rand() - 0.5) * px * 0.24, dy = (rand() - 0.5) * py * 0.24;
    var r = base * (0.5 + 0.24 * rand());
    P.leopardSpot(ctx, x + dx, y + dy, r, rand, color, color2);
    if (rand() < 0.45) {
      var bx = x + (rand() - 0.5) * px * 0.55, by = y + (rand() - 0.5) * py * 0.55;
      var br = base * (0.12 + 0.16 * rand());
      if (rand() < 0.5) P.leopardSpot(ctx, bx, by, br, rand, color, null);
      else P.leopardArc(ctx, bx, by, br, rand, color);
    }
  }
  function drawPattern(ctx, state, width, height, scale) {
    scale = scale || 1; ctx.save(); ctx.scale(scale,scale);
    // Background: custom image > vertical gradient > transparent > flat colour.
    if (state.background && state.background.complete && state.background.naturalWidth) { ctx.drawImage(state.background, 0, 0, width, height); }
    else if (state.backgroundTransparent) { ctx.clearRect(0,0,width,height); }
    else if (state.backgroundGradient) {
      var grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, state.backgroundColor);
      grad.addColorStop(1, state.backgroundColor2 || state.backgroundColor);
      ctx.fillStyle = grad; ctx.fillRect(0, 0, width, height);
    } else { ctx.fillStyle=state.backgroundColor; ctx.fillRect(0,0,width,height); }
    var angle = (Number(state.patternAngle) || 0) * Math.PI / 180;
    ctx.save();
    if (angle) { ctx.translate(width / 2, height / 2); ctx.rotate(angle); ctx.translate(-width / 2, -height / 2); }
    // Pattern effects only apply to the motifs, never to the background.
    var alpha = state.patternOpacity == null ? 1 : Math.max(0, Math.min(100, Number(state.patternOpacity))) / 100;
    var blur = Math.max(0, Number(state.patternBlur) || 0);
    if (alpha !== 1) ctx.globalAlpha = alpha;
    // Chromium applies ctx.filter in device pixels (unaffected by the CTM), so the
    // preview's backing scale would otherwise multiply the blur — normalise by scale
    // to keep preview and export equally blurred.
    if (blur > 0 && typeof ctx.filter === 'string') ctx.filter = 'blur(' + (blur * scale) + 'px)';
    // When rotated, tiles must cover the diagonal square around the canvas centre.
    var diag = Math.sqrt(width * width + height * height);
    var ex0 = (width - diag) / 2, ex1 = width + (diag - width) / 2, ey0 = (height - diag) / 2, ey1 = height + (diag - height) / 2;
    var isTile = !!tileSource(state.patternType);
    var periodX=Math.max(1,state.patternSize+state.gapX), periodY=Math.max(1,state.patternSize+state.gapY), startRow=Math.floor((ey0-state.offsetY-state.patternSize)/periodY)-1, endRow=Math.ceil((ey1-state.offsetY+state.patternSize)/periodY)+1;
    if(state.patternType==='gingham'){
      // Gingham weave from a single colour: vertical + horizontal bands at half
      // alpha, then a full-alpha square stamped at each crossing so the grid reads
      // band < crossing without needing a second colour.
      var bandA=alpha*0.5;
      var gCol0=Math.floor((ex0-state.offsetX-state.patternSize)/periodX)-1, gCol1=Math.ceil((ex1-state.offsetX+state.patternSize)/periodX)+1;
      ctx.fillStyle=state.patternColor;
      ctx.globalAlpha=bandA;
      for(var gc=gCol0;gc<=gCol1;gc++){ var gbx=state.offsetX+gc*periodX; ctx.fillRect(gbx-state.patternSize/2, ey0, state.patternSize, ey1-ey0); }
      for(var gr=startRow;gr<=endRow;gr++){ var gby=state.offsetY+gr*periodY; ctx.fillRect(ex0, gby-state.patternSize/2, ex1-ex0, state.patternSize); }
      ctx.globalAlpha=alpha;
      for(var gr2=startRow;gr2<=endRow;gr2++){ var gcy=state.offsetY+gr2*periodY; for(var gc2=gCol0;gc2<=gCol1;gc2++){ var gcx=state.offsetX+gc2*periodX; ctx.fillRect(gcx-state.patternSize/2, gcy-state.patternSize/2, state.patternSize, state.patternSize); } }
    } else for(var row=startRow; row<=endRow; row++){ var y=state.offsetY+row*periodY; var rowShift=(state.patternType==='stripe'||isTile)?0:(Math.abs(row)%2)*periodX/2; var startCol=Math.floor((ex0-state.offsetX-rowShift-state.patternSize)/periodX)-1, endCol=Math.ceil((ex1-state.offsetX-rowShift+state.patternSize)/periodX)+1; for(var col=startCol;col<=endCol;col++){ var x=state.offsetX+rowShift+col*periodX;
      // Eraser: each lattice cell has a deterministic row_col key; erased cells are skipped.
      if(state.patternType!=='stripe' && state.erased && state.erased[row+'_'+col]) continue;
      if(state.patternType==='stripe'){ ctx.fillStyle=state.patternColor; ctx.fillRect(x-state.patternSize/2, y-periodY/2-1, state.patternSize, periodY+2); }
      else if(state.patternType==='argyle'){ ctx.fillStyle=state.patternColor; ctx.beginPath(); ctx.moveTo(x,y-periodY/2); ctx.lineTo(x+periodX/2,y); ctx.lineTo(x,y+periodY/2); ctx.lineTo(x-periodX/2,y); ctx.closePath(); ctx.fill(); }
      else if(state.patternType==='leopard'){ drawLeopardCell(ctx,x,y,periodX,periodY,state,row,col); }
      else if(isTile){ var tinted=getTintedTile(state,state.patternType); if(tinted){ ctx.drawImage(tinted, x-periodX/2-0.5, y-periodY/2-0.5, periodX+1, periodY+1); } }
      else if(state.patternType==='custom' && state.customImage){var d=customDimensions(state.customImage,state.patternSize);ctx.drawImage(state.customImage,x-d.w/2,y-d.h/2,d.w,d.h);}
      else{(window.Patterns[state.patternType]||window.Patterns.circle)(ctx,x,y,state.patternSize,state.patternColor);} } }
    if (typeof ctx.filter === 'string') ctx.filter = 'none';
    ctx.restore();
    // Sticker layer (拼贴): drawn above pattern effects, per-sticker opacity,
    // unaffected by pattern rotation. Array order == z-order (last is topmost).
    if (state.stickers && state.stickers.length) {
      for (var si = 0; si < state.stickers.length; si++) {
        var st = state.stickers[si], sim = st.image;
        if (!sim || !sim.complete || !sim.naturalWidth) continue;
        var sw = sim.naturalWidth * st.scale, sh = sim.naturalHeight * st.scale;
        ctx.save();
        ctx.globalAlpha = st.opacity == null ? 1 : st.opacity;
        ctx.translate(st.x, st.y);
        ctx.rotate((st.rotation || 0) * Math.PI / 180);
        ctx.scale(st.flip ? -1 : 1, 1);
        ctx.drawImage(sim, -sw / 2, -sh / 2, sw, sh);
        ctx.restore();
      }
    }
    ctx.restore();
  }
  window.PatternRenderer = { drawPattern: drawPattern, onTilesLoaded: null };
})();
