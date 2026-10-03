(function () {
  function crc32(bytes) { var crc=0xffffffff; for(var i=0;i<bytes.length;i++){crc^=bytes[i];for(var bit=0;bit<8;bit++){crc=(crc>>>1)^((crc&1)?0xedb88320:0);}} return (crc^0xffffffff)>>>0; }
  function writeUint32(bytes, offset, value) { bytes[offset]=(value>>>24)&255; bytes[offset+1]=(value>>>16)&255; bytes[offset+2]=(value>>>8)&255; bytes[offset+3]=value&255; }
  function readBlobBytes(blob) { if (blob.arrayBuffer) return blob.arrayBuffer(); return new Promise(function (resolve, reject) { var reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = function () { reject(reader.error || new Error('blob read failed')); }; reader.readAsArrayBuffer(blob); }); }
  function blobToDataUri(blob) { return new Promise(function (resolve, reject) { var reader = new FileReader(); reader.onload = function () { resolve(reader.result); }; reader.onerror = function () { reject(reader.error || new Error('blob read failed')); }; reader.readAsDataURL(blob); }); }
  function isTouchEnvironment() { if (window.matchMedia) { try { return window.matchMedia('(pointer:coarse)').matches; } catch (e) {} } return 'ontouchstart' in window; }
  async function applyPngResolution(blob, dpi) { var source=new Uint8Array(await readBlobBytes(blob)), ppm=Math.round(dpi/0.0254), offset=8, length=(source[offset]<<24)|(source[offset+1]<<16)|(source[offset+2]<<8)|source[offset+3]; offset+=12+length; var chunk=new Uint8Array(21); writeUint32(chunk,0,9); chunk.set([112,72,89,115],4); writeUint32(chunk,8,ppm); writeUint32(chunk,12,ppm); chunk[16]=1; writeUint32(chunk,17,crc32(chunk.slice(4,17))); var output=new Uint8Array(source.length+chunk.length); output.set(source.slice(0,offset)); output.set(chunk,offset); output.set(source.slice(offset),offset+chunk.length); return new Blob([output],{type:'image/png'}); }
  async function applyJpegResolution(blob, dpi) { var bytes=new Uint8Array(await readBlobBytes(blob)), density=Math.max(1,Math.min(65535,Math.round(dpi))); for(var offset=2;offset+10<bytes.length&&bytes[offset]===255;){var marker=bytes[offset+1], length=(bytes[offset+2]<<8)|bytes[offset+3]; if(marker===224&&bytes[offset+4]===74&&bytes[offset+5]===70&&bytes[offset+6]===73&&bytes[offset+7]===70){bytes[offset+11]=1;bytes[offset+12]=(density>>>8)&255;bytes[offset+13]=density&255;bytes[offset+14]=(density>>>8)&255;bytes[offset+15]=density&255;break;} if(!length)break;offset+=2+length;} return new Blob([bytes],{type:'image/jpeg'}); }
  async function applyResolution(blob, type, dpi) { return type==='image/png'?applyPngResolution(blob,dpi):applyJpegResolution(blob,dpi); }
  async function saveBlob(blob, fileName, type) {
    // Inside the mini-tool container, downloads (a[download] / blob URLs) are blocked;
    // save to the photo album through the injected JSBridge instead.
    var bridge = window.xhs && window.xhs.miniTool;
    if (bridge && typeof bridge.writeTempFile === 'function' && typeof bridge.saveImageToPhotosAlbum === 'function') {
      var dataUri = await blobToDataUri(blob);
      var written = await bridge.writeTempFile({ data: dataUri });
      await bridge.saveImageToPhotosAlbum({ filePath: written.filePath });
      return;
    }
    // Native saving writes directly to a user-selected local file and avoids an embedded browser
    // navigating to a temporary blob: URL (the source of the Internet-security warning).
    // Touch devices (phones) must skip the picker: some mobile Chromium-fork browsers expose
    // showSaveFilePicker but abort it (AbortError), which was misreported as "user cancelled".
    if (window.showSaveFilePicker && !isTouchEnvironment()) {
      try {
        var handle = await window.showSaveFilePicker({ suggestedName:fileName, types:[{description:type==='image/jpeg'?'JPEG 图片':'PNG 图片',accept:{[type]:[type==='image/jpeg'?'.jpg':'.png']}}] });
        var writable = await handle.createWritable(); await writable.write(blob); await writable.close(); return;
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        // File System Access can be exposed but unavailable in a local/sandboxed page.
        // Continue with the browser-download fallback in that case.
      }
    }
    if (navigator.msSaveOrOpenBlob) { navigator.msSaveOrOpenBlob(blob,fileName); return; }
    var url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url;link.download=fileName;link.style.display='none';document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(url);},60000);
  }
  function renderToCanvas(state, format) { var canvas=document.createElement('canvas'); canvas.width=state.canvasWidth; canvas.height=state.canvasHeight; var ctx=canvas.getContext('2d'); var exportState=Object.assign({},state,{backgroundTransparent:state.backgroundTransparent&&format!=='jpeg'}); if(format==='jpeg'&&state.backgroundTransparent){exportState.backgroundColor='#FFFFFF';} window.PatternRenderer.drawPattern(ctx,exportState,state.canvasWidth,state.canvasHeight,1); return canvas; }
  function renderDataUri(state, format) { var type=format==='jpeg'?'image/jpeg':'image/png'; return renderToCanvas(state,format).toDataURL(type, format==='jpeg' ? 0.95 : undefined); }
  async function exportImage(state, format) { var canvas=renderToCanvas(state,format); var type=format==='jpeg'?'image/jpeg':'image/png'; var blob=await new Promise(function(resolve){canvas.toBlob(resolve,type,format==='jpeg' ? 0.95 : undefined);}); if(!blob) throw new Error('图片编码失败：画布可能过大或内存不足，请尝试减小画布尺寸后重试'); blob=await applyResolution(blob,type,state.resolutionDpi); await saveBlob(blob,'pattern-'+state.canvasWidth+'x'+state.canvasHeight+'.'+(format==='jpeg'?'jpg':'png'),type); return format==='jpeg'&&state.backgroundTransparent; }
  window.PatternExport = { exportImage: exportImage, renderDataUri: renderDataUri };
})();
