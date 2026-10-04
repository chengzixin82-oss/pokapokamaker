(function () {
  function clamp(value) { return Math.max(0, Math.min(255, Math.round(Number(value) || 0))); }
  function rgbToHex(rgb) { return "#" + [rgb.r, rgb.g, rgb.b].map(function (v) { return clamp(v).toString(16).padStart(2, "0"); }).join("").toUpperCase(); }
  function hexToRgb(hex) { var match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim()); if (!match) return null; var value = match[1]; return { r: parseInt(value.slice(0,2),16), g: parseInt(value.slice(2,4),16), b: parseInt(value.slice(4,6),16) }; }
  function rgbToHsv(rgb) {
    var r=rgb.r/255, g=rgb.g/255, b=rgb.b/255, max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min, h=0;
    if (d) { if (max===r) h=((g-b)/d)%6; else if (max===g) h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if (h<0) h+=360; }
    return { h:h, s:max?d/max:0, v:max };
  }
  function hsvToRgb(h, s, v) {
    var c=v*s, x=c*(1-Math.abs(((h/60)%2)-1)), m=v-c, r=0, g=0, b=0;
    if (h<60){r=c;g=x;} else if (h<120){r=x;g=c;} else if (h<180){g=c;b=x;} else if (h<240){g=x;b=c;} else if (h<300){r=x;b=c;} else {r=c;b=x;}
    return { r:Math.round((r+m)*255), g:Math.round((g+m)*255), b:Math.round((b+m)*255) };
  }
  window.ColorUtils = { clamp: clamp, rgbToHex: rgbToHex, hexToRgb: hexToRgb };

  // ---- custom popup color picker (replaces the native one, which is ugly on phones) ----
  var popup=null, svEl, svCursor, hueEl, hueCursor, preview, hexInput;
  var hsv={h:0,s:0,v:1}, onPick=null, anchor=null;

  function bindDrag(el, handler) {
    el.addEventListener('pointerdown', function (e) {
      el.setPointerCapture(e.pointerId);
      handler(e);
      function move(ev){ handler(ev); }
      function up(){ el.removeEventListener('pointermove',move); el.removeEventListener('pointerup',up); el.removeEventListener('pointercancel',up); }
      el.addEventListener('pointermove',move);
      el.addEventListener('pointerup',up);
      el.addEventListener('pointercancel',up);
      e.preventDefault();
    });
  }
  function refresh(commitHex) {
    svEl.style.background='hsl('+hsv.h+',100%,50%)';
    svCursor.style.left=(hsv.s*100)+'%';
    svCursor.style.top=((1-hsv.v)*100)+'%';
    hueCursor.style.left=(hsv.h/360*100)+'%';
    var hex=rgbToHex(hsvToRgb(hsv.h,hsv.s,hsv.v));
    preview.style.background=hex;
    hueCursor.style.background=hex;
    svCursor.style.background=hex;
    if (commitHex !== false) { hexInput.value=hex; if (onPick) onPick(hex); }
  }
  function build() {
    popup=document.createElement('div');
    popup.className='cp-pop';
    popup.innerHTML='<div class="cp-sv"><span class="cp-cursor"></span></div>'+
      '<div class="cp-mid"><span class="cp-preview"></span><input class="cp-hex" maxlength="7" spellcheck="false" autocomplete="off" aria-label="十六进制颜色值" /><button class="cp-eyedrop" type="button" aria-label="屏幕取色" title="屏幕吸管取色"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.6 3.4a2.25 2.25 0 0 1 3.2 3.2l-1.7 1.7-3.2-3.2 1.7-1.7z"/><path d="M10.9 5.1 4.5 11.5c-.3.3-.5.7-.6 1.1l-.5 2.3a.55.55 0 0 0 .7.7l2.3-.5c.4-.1.8-.3 1.1-.6l6.4-6.4"/></svg></button></div>'+
      '<div class="cp-hue"><span class="cp-hue-cursor"></span></div>';
    document.body.appendChild(popup);
    svEl=popup.querySelector('.cp-sv'); svCursor=popup.querySelector('.cp-cursor');
    hueEl=popup.querySelector('.cp-hue'); hueCursor=popup.querySelector('.cp-hue-cursor');
    preview=popup.querySelector('.cp-preview'); hexInput=popup.querySelector('.cp-hex');
    // Eyedropper: pick any on-screen colour (Chromium secure contexts only).
    popup.querySelector('.cp-eyedrop').addEventListener('click', function () {
      if (!window.EyeDropper) {
        if (window.App && window.App.showToast) window.App.showToast('当前浏览器不支持屏幕取色');
        return;
      }
      var self=this;
      new window.EyeDropper().open().then(function (result) {
        var rgb=hexToRgb(result && result.sRGBHex);
        if (rgb) { hsv=rgbToHsv(rgb); refresh(); }
        self.blur();
      }).catch(function () { /* user cancelled */ });
    });
    bindDrag(svEl, function (e) {
      var r=svEl.getBoundingClientRect();
      hsv.s=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
      hsv.v=1-Math.max(0,Math.min(1,(e.clientY-r.top)/r.height));
      refresh();
    });
    bindDrag(hueEl, function (e) {
      var r=hueEl.getBoundingClientRect();
      hsv.h=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*360;
      refresh();
    });
    hexInput.addEventListener('change', function () {
      var rgb=hexToRgb(hexInput.value);
      if (rgb) { hsv=rgbToHsv(rgb); refresh(); } else { refresh(false); }
    });
    document.addEventListener('pointerdown', function (e) {
      if (!popup.classList.contains('show')) return;
      if (popup.contains(e.target) || (anchor && anchor.contains(e.target))) return;
      close();
    });
    document.addEventListener('keydown', function (e) { if (e.key==='Escape') close(); });
  }
  function open(anchorEl, hex, onChange) {
    if (!popup) build();
    anchor=anchorEl; onPick=onChange;
    hsv=rgbToHsv(hexToRgb(hex)||{r:255,g:255,b:255});
    popup.classList.add('show');
    var r=anchorEl.getBoundingClientRect(), w=popup.offsetWidth, h=popup.offsetHeight;
    var top=r.bottom+8; if (top+h>window.innerHeight-8) top=Math.max(8,r.top-h-8);
    var left=Math.max(8,Math.min(r.left,window.innerWidth-w-8));
    popup.style.top=top+'px'; popup.style.left=left+'px';
    refresh(false); hexInput.value=rgbToHex(hsvToRgb(hsv.h,hsv.s,hsv.v));
  }
  function close() { if (popup) popup.classList.remove('show'); anchor=null; onPick=null; }
  window.ColorPicker = { open: open, close: close };
})();
