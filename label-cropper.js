/* SAYRA BRAND — 100% Browser-Side Smart PDF Shipping Label Cropper
   Zero network uploads: processes all Flipkart/Meesho/courier PDFs strictly in browser memory. */
(function () {
  const $ = id => document.getElementById(id);

  const PRESETS_CROP = {
    flipkart: { x: 0.25, y: 0.02, w: 0.50, h: 0.455 },
    meesho:   { x: 0.025, y: 0.018, w: 0.95, h: 0.47 },
    tophalf:  { x: 0.02, y: 0.02, w: 0.96, h: 0.48 },
    full:     { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
  };

  const SIZE_PRESETS = {
    thermal_4x6: { w: 4, h: 6, unit: 'in' },
    thermal_100x150: { w: 100, h: 150, unit: 'mm' },
    a4: { w: 210, h: 297, unit: 'mm' },
    a6: { w: 105, h: 148, unit: 'mm' },
  };

  let pdfjsLibPromise = null;
  let pdfLibPromise = null;

  async function ensurePdfEngines() {
    if (!pdfjsLibPromise) {
      pdfjsLibPromise = Promise.all([
        import('./vendor/pdf.min.mjs'),
        import('./vendor/pdf.worker.min.mjs'),
      ]).then(([mod, workerMod]) => {
        globalThis.pdfjsWorker = workerMod;
        if (mod.GlobalWorkerOptions) {
          mod.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
        }
        return mod;
      });
    }
    if (!pdfLibPromise) {
      pdfLibPromise = new Promise((resolve, reject) => {
        if (window.PDFLib) {
          resolve(window.PDFLib);
          return;
        }
        const s = document.createElement('script');
        s.src = './vendor/pdf-lib.min.js';
        s.onload = () => (window.PDFLib ? resolve(window.PDFLib) : reject(new Error('PDF writer failed to initialize.')));
        s.onerror = () => reject(new Error('Could not load local PDF writer library.'));
        document.head.appendChild(s);
      });
    }
    const [pdfjs, pdflib] = await Promise.all([pdfjsLibPromise, pdfLibPromise]);
    return { pdfjs, pdflib };
  }

  function unitToPoints(val, unit) {
    const n = Number(val);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    if (unit === 'in') return n * 72;
    if (unit === 'mm') return (n * 72) / 25.4;
    if (unit === 'px') return (n * 72) / 96;
    return n;
  }

  function pointsToUnit(pt, unit) {
    if (unit === 'in') return pt / 72;
    if (unit === 'mm') return (pt * 25.4) / 72;
    if (unit === 'px') return (pt * 96) / 72;
    return pt;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function hasPdfMagicHeader(bytes) {
    const limit = Math.min(bytes.length, 1024);
    for (let i = 0; i <= limit - 5; i++) {
      if (
        bytes[i] === 0x25 && // %
        bytes[i + 1] === 0x50 && // P
        bytes[i + 2] === 0x44 && // D
        bytes[i + 3] === 0x46 && // F
        bytes[i + 4] === 0x2d    // -
      ) {
        return true;
      }
    }
    return false;
  }

  function hasImageHeader(bytes) {
    if (bytes.length < 4) return false;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    return isPng || isJpg || isWebp;
  }

  function parsePageSelection(scope, customRangeStr, totalPages, currentPage) {
    if (scope === 'current') return [currentPage];
    if (scope === 'all') return Array.from({ length: totalPages }, (_, i) => i + 1);
    const cleaned = (customRangeStr || '').trim();
    if (!cleaned) throw new Error('Enter a custom page range such as "1-3" or "1, 3, 5".');
    const pages = [];
    const seen = new Set();
    for (const part of cleaned.split(',')) {
      const token = part.trim();
      if (!token) continue;
      const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
      if (!m) throw new Error(`Invalid page range "${token}". Use numbers like "1-4" or "1, 2, 5".`);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : start;
      if (start < 1 || end < 1 || start > totalPages || end > totalPages) {
        throw new Error(`Page numbers must be between 1 and ${totalPages} (this PDF has ${totalPages} page${totalPages === 1 ? '' : 's'}).`);
      }
      const step = start <= end ? 1 : -1;
      for (let p = start; step > 0 ? p <= end : p >= end; p += step) {
        if (!seen.has(p)) {
          seen.add(p);
          pages.push(p);
        }
      }
    }
    if (!pages.length) throw new Error('Select at least one valid page to export.');
    return pages;
  }

  const state = {
    fileName: '',
    fileSize: 0,
    immutableSourceBytes: null, // Never mutated; always sliced before worker transfer
    pdfDoc: null,
    totalPages: 0,
    currentPage: 1,
    pagePtW: 595.28,
    pagePtH: 841.89,
    zoomLarge: false,
    crop: { x: 0.025, y: 0.018, w: 0.95, h: 0.47 },
    renderToken: 0,
    lastPdfBlobUrl: null,
  };

  function showPdfError(message) {
    const banner = $('pdfErrorBanner');
    if (!banner) return;
    if (!message) {
      banner.classList.add('hidden');
      banner.textContent = '';
    } else {
      banner.textContent = '⚠️ ' + message;
      banner.classList.remove('hidden');
    }
  }

  function showPdfStatus(message) {
    const el = $('pdfStatusText');
    if (el) el.textContent = message;
  }

  function getOutputPagePoints() {
    const preset = $('pdfSizePreset').value;
    if (preset === 'match') {
      const marginPt = unitToPoints(Number($('pdfMarginMm').value) || 0, 'mm') || 0;
      const wPt = Math.max(36, state.crop.w * state.pagePtW + marginPt * 2);
      const hPt = Math.max(36, state.crop.h * state.pagePtH + marginPt * 2);
      return { wPt, hPt };
    }
    const unit = $('pdfOutUnit').value;
    const wPt = unitToPoints($('pdfOutWidth').value, unit);
    const hPt = unitToPoints($('pdfOutHeight').value, unit);
    if (!Number.isFinite(wPt) || !Number.isFinite(hPt) || wPt < 18 || hPt < 18) {
      throw new Error('Enter valid positive output width and height values.');
    }
    return { wPt, hPt };
  }

  function syncCropOverlayAndInputs() {
    const box = $('pdfCropBox');
    if (box) {
      box.style.left = (state.crop.x * 100).toFixed(2) + '%';
      box.style.top = (state.crop.y * 100).toFixed(2) + '%';
      box.style.width = (state.crop.w * 100).toFixed(2) + '%';
      box.style.height = (state.crop.h * 100).toFixed(2) + '%';
    }
    if (document.activeElement !== $('cropX')) $('cropX').value = (state.crop.x * 100).toFixed(1);
    if (document.activeElement !== $('cropY')) $('cropY').value = (state.crop.y * 100).toFixed(1);
    if (document.activeElement !== $('cropW')) $('cropW').value = (state.crop.w * 100).toFixed(1);
    if (document.activeElement !== $('cropH')) $('cropH').value = (state.crop.h * 100).toFixed(1);

    const cropMmW = pointsToUnit(state.crop.w * state.pagePtW, 'mm');
    const cropMmH = pointsToUnit(state.crop.h * state.pagePtH, 'mm');
    const dimTag = $('pdfCropReadout');
    if (dimTag) {
      dimTag.textContent = `${cropMmW.toFixed(0)} × ${cropMmH.toFixed(0)} mm`;
    }
    renderLiveOutputPreview();
  }

  function renderLiveOutputPreview() {
    const srcCanvas = $('pdfSourceCanvas');
    const outCanvas = $('pdfOutputPreviewCanvas');
    if (!srcCanvas || !outCanvas || !srcCanvas.width || !srcCanvas.height) return;

    let outW = 288, outH = 432;
    try {
      const dims = getOutputPagePoints();
      outW = dims.wPt;
      outH = dims.hPt;
    } catch (_) {
      return;
    }

    const maxSide = 340;
    const scale = maxSide / Math.max(outW, outH);
    const cw = Math.max(60, Math.round(outW * scale));
    const ch = Math.max(60, Math.round(outH * scale));
    outCanvas.width = cw * 2;
    outCanvas.height = ch * 2;
    outCanvas.style.width = cw + 'px';
    outCanvas.style.height = ch + 'px';

    const ctx = outCanvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.scale(2, 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cw, ch);

    const sx = clamp(state.crop.x * srcCanvas.width, 0, srcCanvas.width - 1);
    const sy = clamp(state.crop.y * srcCanvas.height, 0, srcCanvas.height - 1);
    const sw = clamp(state.crop.w * srcCanvas.width, 1, srcCanvas.width - sx);
    const sh = clamp(state.crop.h * srcCanvas.height, 1, srcCanvas.height - sy);

    const marginPt = Math.max(0, unitToPoints(Number($('pdfMarginMm').value) || 0, 'mm') || 0);
    const padPx = Math.min(cw * 0.25, ch * 0.25, marginPt * scale);
    const availW = Math.max(10, cw - padPx * 2);
    const availH = Math.max(10, ch - padPx * 2);
    const fitMode = $('pdfFitMode').value;
    const cropWpt = Math.max(1, state.crop.w * state.pagePtW);
    const cropHpt = Math.max(1, state.crop.h * state.pagePtH);
    const shouldRotate90 = fitMode === 'auto_rotate' && (cropWpt > cropHpt) !== (availW > availH);

    if (shouldRotate90) {
      const s = Math.min(availW / cropHpt, availH / cropWpt);
      const rw = cropWpt * s, rh = cropHpt * s;
      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(srcCanvas, sx, sy, sw, sh, -rw / 2, -rh / 2, rw, rh);
      ctx.restore();
      ctx.restore();
    } else {
      let dw = availW, dh = availH, dx = padPx, dy = padPx;
      if (fitMode !== 'stretch') {
        const cropAspect = cropWpt / cropHpt;
        if (availW / availH > cropAspect) {
          dh = availH;
          dw = dh * cropAspect;
        } else {
          dw = availW;
          dh = dw / cropAspect;
        }
        dx = padPx + (availW - dw) / 2;
        dy = fitMode === 'top' ? padPx : padPx + (availH - dh) / 2;
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(srcCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.restore();
    }

    const meta = $('pdfOutputMeta');
    if (meta) {
      const unit = $('pdfSizePreset').value === 'match' ? 'mm' : $('pdfOutUnit').value;
      const dispW = pointsToUnit(outW, unit).toFixed(unit === 'in' ? 2 : 0);
      const dispH = pointsToUnit(outH, unit).toFixed(unit === 'in' ? 2 : 0);
      meta.textContent = `Output sheet: ${dispW} × ${dispH} ${unit} • Print-ready white ground`;
    }
  }

  async function renderCurrentPdfPage(autoDetectOnLoad = false) {
    if (!state.pdfDoc) return;
    const token = ++state.renderToken;
    const page = await state.pdfDoc.getPage(state.currentPage);
    if (token !== state.renderToken) return;

    const baseVp = page.getViewport({ scale: 1 });
    state.pagePtW = baseVp.width;
    state.pagePtH = baseVp.height;

    const targetCssWidth = state.zoomLarge ? 700 : 460;
    const cssScale = targetCssWidth / baseVp.width;
    const renderScale = Math.min(2.6, Math.max(1.8, cssScale * (window.devicePixelRatio || 1.5)));
    const renderVp = page.getViewport({ scale: renderScale });

    const canvas = $('pdfSourceCanvas');
    canvas.width = Math.ceil(renderVp.width);
    canvas.height = Math.ceil(renderVp.height);
    const stageWrap = $('pdfStageInner');
    stageWrap.style.maxWidth = state.zoomLarge ? '720px' : '470px';

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport: renderVp }).promise;
    if (token !== state.renderToken) return;

    $('pdfPageIndicator').textContent = `Page ${state.currentPage} of ${state.totalPages}`;
    $('pdfPageSelect').value = String(state.currentPage);
    $('pdfPrevPage').disabled = state.currentPage <= 1;
    $('pdfNextPage').disabled = state.currentPage >= state.totalPages;
    $('pdfPageDimsBadge').textContent =
      `${pointsToUnit(baseVp.width, 'mm').toFixed(0)} × ${pointsToUnit(baseVp.height, 'mm').toFixed(0)} mm`;

    if (autoDetectOnLoad) {
      await smartAutoDetectCrop(page, baseVp, canvas);
    } else {
      syncCropOverlayAndInputs();
    }
  }

  async function smartAutoDetectCrop(pageOpt, vpOpt, canvasOpt) {
    if (!state.pdfDoc) return;
    const page = pageOpt || await state.pdfDoc.getPage(state.currentPage);
    const vp = vpOpt || page.getViewport({ scale: 1 });
    const canvas = canvasOpt || $('pdfSourceCanvas');

    // Step 1: Check text layer for Flipkart / Meesho "Tax Invoice" / "Fold Here" split line
    let splitYNorm = 1.0;
    try {
      const tc = await page.getTextContent();
      for (const item of tc.items) {
        const s = (item.str || '').trim().toLowerCase();
        if (!s) continue;
        if (
          s.includes('tax invoice') ||
          s.includes('fold here') ||
          s.includes('cut here') ||
          s === 'invoice'
        ) {
          const [, vy] = vp.convertToViewportPoint(item.transform[4], item.transform[5]);
          const normY = vy / vp.height;
          if (normY > 0.24 && normY < splitYNorm) {
            splitYNorm = Math.max(0.20, normY - 0.022);
          }
        }
      }
    } catch (_) {
      // Ignore text layer errors and rely on pixel scan
    }

    // Step 2: Scan non-white ink bounding box within [0, splitYNorm] on rendered canvas
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const scanH = Math.max(10, Math.floor(canvas.height * splitYNorm));
    let minX = w, minY = scanH, maxX = 0, maxY = 0, found = false;

    try {
      const img = ctx.getImageData(0, 0, w, scanH).data;
      const step = Math.max(1, Math.floor(w / 320));
      for (let y = 2; y < scanH - 2; y += step) {
        for (let x = 2; x < w - 2; x += step) {
          const idx = (y * w + x) * 4;
          if (img[idx + 3] > 20 && (img[idx] < 244 || img[idx + 1] < 244 || img[idx + 2] < 244)) {
            found = true;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
    } catch (_) {
      found = false;
    }

    if (found && maxX - minX > w * 0.08 && maxY - minY > canvas.height * 0.05) {
      const padX = 0.018;
      const padY = 0.016;
      const nx = clamp(minX / w - padX, 0, 0.92);
      const ny = clamp(minY / canvas.height - padY, 0, 0.92);
      const nw = clamp(maxX / w + padX - nx, 0.08, 1 - nx);
      const nh = clamp(Math.min(splitYNorm, maxY / canvas.height + padY) - ny, 0.08, 1 - ny);
      state.crop = { x: nx, y: ny, w: nw, h: nh };
    } else if (splitYNorm < 0.95) {
      state.crop = { x: 0.03, y: 0.02, w: 0.94, h: clamp(splitYNorm - 0.02, 0.2, 0.96) };
    } else {
      state.crop = { ...PRESETS_CROP.meesho };
    }
    syncCropOverlayAndInputs();
  }

  function readFileBytesSafe(file) {
    if (typeof file.arrayBuffer === 'function') {
      return file.arrayBuffer().then(buf => new Uint8Array(buf.slice(0)));
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsArrayBuffer(file);
    });
  }

  async function loadPdfFromFile(file) {
    showPdfError('');
    if (!file) return;
    if (file.size === 0) {
      showPdfError('This file is empty (0 bytes). Please upload a valid shipping label PDF.');
      return;
    }

    let immutableBytes;
    try {
      immutableBytes = await readFileBytesSafe(file);
    } catch (_) {
      showPdfError('Could not read the selected file from your device.');
      return;
    }
    if (!immutableBytes.byteLength) {
      showPdfError('This file is empty (0 bytes). Please upload a valid shipping label PDF.');
      return;
    }

    if (!hasPdfMagicHeader(immutableBytes)) {
      if (hasImageHeader(immutableBytes) || /^image\//i.test(file.type || '')) {
        showPdfError(`"${file.name}" is an image file, not a PDF. Upload shipping label PDFs (.pdf) here — or upload product photos in the SAYRA Jeans Showcase below.`);
      } else {
        showPdfError(`Unsupported file "${file.name}". Please upload a valid PDF (.pdf) shipping label document.`);
      }
      return;
    }

    await loadPdfBytesInternal(immutableBytes, file.name || 'shipping-label.pdf');
  }

  async function loadPdfBytesInternal(immutableBytes, displayFileName) {
    showPdfError('');
    showPdfStatus('Loading PDF locally in your browser…');
    try {
      const { pdfjs } = await ensurePdfEngines();
      const docOpts = {
        data: new Uint8Array(immutableBytes),
        standardFontDataUrl: './vendor/standard_fonts/',
      };
      const loadedDoc = await pdfjs.getDocument(docOpts).promise;
      if (!loadedDoc || loadedDoc.numPages < 1) {
        showPdfError('This PDF contains no pages.');
        return;
      }

      if (state.pdfDoc && state.pdfDoc.destroy) {
        try { await state.pdfDoc.destroy(); } catch (_) {}
      }

      state.fileName = displayFileName || 'shipping-label.pdf';
      state.fileSize = immutableBytes.byteLength;
      state.immutableSourceBytes = new Uint8Array(immutableBytes);
      state.pdfDoc = loadedDoc;
      state.totalPages = loadedDoc.numPages;
      state.currentPage = 1;

      const sel = $('pdfPageSelect');
      sel.innerHTML = '';
      for (let i = 1; i <= state.totalPages; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `Page ${i} of ${state.totalPages}`;
        sel.appendChild(opt);
      }

      $('pdfFileName').textContent = state.fileName;
      $('pdfFileMeta').textContent = `${formatBytes(state.fileSize)} • ${state.totalPages} page${state.totalPages === 1 ? '' : 's'} • Original file unchanged`;
      $('pdfAllScopeOption').textContent = `All pages (1 – ${state.totalPages})`;
      $('pdfWorkspace').classList.remove('hidden');

      await renderCurrentPdfPage(true);
      showPdfStatus('Ready — adjust crop box if needed, then download your print-ready PDF.');
    } catch (err) {
      if (err && (err.name === 'PasswordException' || /password/i.test(err.message || ''))) {
        showPdfError('This PDF is password-protected. Please unlock it first before cropping labels.');
      } else {
        showPdfError('Could not open this PDF file — it may be corrupted or in an unsupported PDF format.');
      }
      showPdfStatus('Upload a Flipkart or Meesho shipping label PDF to begin.');
    }
  }

  async function buildCroppedPdfBytes() {
    if (!state.immutableSourceBytes || !state.pdfDoc) {
      throw new Error('Please upload a shipping label PDF first.');
    }
    const { pdflib } = await ensurePdfEngines();
    const { PDFDocument, rgb, degrees } = pdflib;

    const scope = $('pdfPageScope').value;
    const pagesToExport = parsePageSelection(scope, $('pdfPageRange').value, state.totalPages, state.currentPage);
    const { wPt: outW, hPt: outH } = getOutputPagePoints();
    const marginPt = Math.max(0, unitToPoints(Number($('pdfMarginMm').value) || 0, 'mm') || 0);
    if (marginPt * 2 >= outW - 8 || marginPt * 2 >= outH - 8) {
      throw new Error('Margin is too large for the chosen output dimensions. Reduce margin or increase output size.');
    }

    // Load fresh copy from untouched source bytes
    const srcPdf = await PDFDocument.load(state.immutableSourceBytes.slice(0), { ignoreEncryption: false });
    const outPdf = await PDFDocument.create();
    const fitMode = $('pdfFitMode').value;

    for (const pageNum of pagesToExport) {
      const srcPage = srcPdf.getPages()[pageNum - 1];
      const rot = ((srcPage.getRotation().angle % 360) + 360) % 360;
      const box = srcPage.getCropBox();

      let left, bottom, right, top;
      if (rot === 0) {
        left = box.x + state.crop.x * box.width;
        right = box.x + (state.crop.x + state.crop.w) * box.width;
        top = box.y + (1 - state.crop.y) * box.height;
        bottom = box.y + (1 - (state.crop.y + state.crop.h)) * box.height;
      } else if (rot === 180) {
        right = box.x + (1 - state.crop.x) * box.width;
        left = box.x + (1 - (state.crop.x + state.crop.w)) * box.width;
        bottom = box.y + state.crop.y * box.height;
        top = box.y + (state.crop.y + state.crop.h) * box.height;
      } else if (rot === 90) {
        left = box.x + state.crop.y * box.width;
        right = box.x + (state.crop.y + state.crop.h) * box.width;
        bottom = box.y + state.crop.x * box.height;
        top = box.y + (state.crop.x + state.crop.w) * box.height;
      } else {
        right = box.x + (1 - state.crop.y) * box.width;
        left = box.x + (1 - (state.crop.y + state.crop.h)) * box.width;
        top = box.y + (1 - state.crop.x) * box.height;
        bottom = box.y + (1 - (state.crop.x + state.crop.w)) * box.height;
      }

      const embedded = await outPdf.embedPage(srcPage, { left, bottom, right, top });
      const outPage = outPdf.addPage([outW, outH]);
      outPage.drawRectangle({ x: 0, y: 0, width: outW, height: outH, color: rgb(1, 1, 1) });

      const availW = outW - marginPt * 2;
      const availH = outH - marginPt * 2;
      const shouldRotate90 = fitMode === 'auto_rotate' && (embedded.width > embedded.height) !== (availW > availH);

      if (shouldRotate90) {
        const s = Math.min(availW / embedded.height, availH / embedded.width);
        const dw = embedded.width * s;
        const dh = embedded.height * s;
        const cx = outW / 2;
        const cy = outH / 2;
        outPage.drawPage(embedded, {
          x: cx + dh / 2,
          y: cy - dw / 2,
          width: dw,
          height: dh,
          rotate: degrees(90),
        });
      } else {
        let dw = availW, dh = availH, dx = marginPt, dy = marginPt;
        if (fitMode !== 'stretch') {
          const s = Math.min(availW / embedded.width, availH / embedded.height);
          dw = embedded.width * s;
          dh = embedded.height * s;
          dx = marginPt + (availW - dw) / 2;
          dy = fitMode === 'top' ? outH - marginPt - dh : marginPt + (availH - dh) / 2;
        }
        outPage.drawPage(embedded, { x: dx, y: dy, width: dw, height: dh });
      }
    }

    const bytes = await outPdf.save();
    return { bytes, pageCount: pagesToExport.length };
  }

  async function generateSampleShippingPdfFile() {
    const { pdflib } = await ensurePdfEngines();
    const { PDFDocument, StandardFonts, rgb } = pdflib;
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const regular = await doc.embedFont(StandardFonts.Helvetica);

    const samples = [
      {
        platform: 'E-KART / FLIPKART LOGISTICS',
        orderId: 'OD42991008812',
        awb: 'FMPC3928174650',
        buyer: 'Customer Delivery Address — Ludhiana, Punjab 141001',
        sku: 'SAYRA-DENIM-SLIM-32  |  QTY: 1  |  PREPAID',
        x: 135, width: 325,
      },
      {
        platform: 'XPRESSBEES / MEESHO SUPPLIER HUB',
        orderId: 'MSH-9988123401',
        awb: 'XB144098761234',
        buyer: 'Customer Delivery Address — Jalandhar, Punjab 144001',
        sku: 'SAYRA-CARGO-BLACK-30  |  QTY: 1  |  COD Rs. 699',
        x: 34, width: 527,
      },
    ];

    for (const [idx, s] of samples.entries()) {
      const p = doc.addPage([595.28, 841.89]);
      // Top Shipping Label Box
      p.drawRectangle({ x: s.x, y: 468, width: s.width, height: 344, borderColor: rgb(0.08, 0.08, 0.1), borderWidth: 2 });
      p.drawText(s.platform, { x: s.x + 14, y: 786, size: 12, font: bold });
      // Crisp simulated vector barcode bars
      for (let b = 0; b < 46; b++) {
        const bw = b % 3 === 0 ? 3.2 : 1.5;
        p.drawRectangle({ x: s.x + 16 + b * 5.8, y: 728, width: bw, height: 44, color: rgb(0, 0, 0) });
      }
      p.drawText(`AWB: ${s.awb}   (Page ${idx + 1} of 2)`, { x: s.x + 14, y: 711, size: 10, font: bold });
      p.drawLine({ start: { x: s.x, y: 700 }, end: { x: s.x + s.width, y: 700 }, thickness: 1 });
      p.drawText('SHIP TO:', { x: s.x + 14, y: 680, size: 10, font: bold });
      p.drawText(s.buyer, { x: s.x + 14, y: 662, size: 10, font: regular });
      p.drawText(`Order ID: ${s.orderId}`, { x: s.x + 14, y: 636, size: 10, font: regular });
      p.drawLine({ start: { x: s.x, y: 618 }, end: { x: s.x + s.width, y: 618 }, thickness: 1 });
      p.drawText(s.sku, { x: s.x + 14, y: 596, size: 10.5, font: bold });
      p.drawText('Return if undelivered: SAYRA BRAND Warehouse, Ludhiana PB', { x: s.x + 14, y: 486, size: 9, font: regular });

      // Dashed Fold Line + Bottom Tax Invoice (cropped out automatically!)
      p.drawLine({ start: { x: 24, y: 432 }, end: { x: 571, y: 432 }, thickness: 1, dashArray: [5, 5] });
      p.drawText('--- FOLD HERE  |  TAX INVOICE BELOW ---', { x: 185, y: 414, size: 10, font: bold });
      p.drawRectangle({ x: 34, y: 60, width: 527, height: 340, borderColor: rgb(0.5, 0.5, 0.5), borderWidth: 1 });
      p.drawText('TAX INVOICE (CUSTOMER COPY)', { x: 50, y: 374, size: 12, font: bold });
      p.drawText(`Invoice for Order ${s.orderId} — Keep separate from thermal parcel label.`, { x: 50, y: 350, size: 10, font: regular });
    }

    const pdfBytes = await doc.save();
    return new Uint8Array(pdfBytes);
  }

  function setupPointerCropInteraction() {
    const stage = $('pdfCropStage');
    if (!stage) return;

    let drag = null;
    stage.addEventListener('pointerdown', e => {
      if (!state.pdfDoc) return;
      if (e.button && e.button !== 0) return;
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      e.preventDefault();
      if (stage.setPointerCapture) {
        try { stage.setPointerCapture(e.pointerId); } catch (_) {}
      }
      const px = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const py = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      const handle = e.target.dataset && e.target.dataset.handle;
      const insideBox = e.target.id === 'pdfCropBox' || e.target.closest('#pdfCropBox');

      drag = {
        pointerId: e.pointerId,
        mode: handle || (insideBox ? 'move' : 'draw'),
        startX: px,
        startY: py,
        orig: { ...state.crop },
      };
    });

    stage.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      e.preventDefault();
      const px = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const py = clamp((e.clientY - rect.top) / rect.height, 0, 1);
      const dx = px - drag.startX;
      const dy = py - drag.startY;
      const MIN = 0.05;
      let { x, y, w, h } = drag.orig;

      if (drag.mode === 'move') {
        x = clamp(x + dx, 0, 1 - w);
        y = clamp(y + dy, 0, 1 - h);
      } else if (drag.mode === 'draw') {
        const x1 = Math.min(drag.startX, px), x2 = Math.max(drag.startX, px);
        const y1 = Math.min(drag.startY, py), y2 = Math.max(drag.startY, py);
        if (x2 - x1 > 0.02 || y2 - y1 > 0.02) {
          x = x1;
          y = y1;
          w = clamp(x2 - x1, MIN, 1 - x1);
          h = clamp(y2 - y1, MIN, 1 - y1);
        }
      } else {
        let right = x + w, bottom = y + h;
        if (drag.mode.includes('w')) x = clamp(x + dx, 0, right - MIN);
        if (drag.mode.includes('e')) right = clamp(right + dx, x + MIN, 1);
        if (drag.mode.includes('n')) y = clamp(y + dy, 0, bottom - MIN);
        if (drag.mode.includes('s')) bottom = clamp(bottom + dy, y + MIN, 1);
        w = right - x;
        h = bottom - y;
      }

      state.crop = { x, y, w, h };
      syncCropOverlayAndInputs();
    });

    const endDrag = e => {
      if (drag && e.pointerId === drag.pointerId) drag = null;
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
  }

  function initLabelCropper() {
    const fileInput = $('pdfUploadInput');
    const dropzone = $('pdfDropzone');
    if (!fileInput || !dropzone) return;

    dropzone.addEventListener('click', e => {
      if (e.target.closest('#loadSamplePdfBtn')) return;
      fileInput.click();
    });
    dropzone.addEventListener('dragover', e => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadPdfFromFile(f);
    });
    fileInput.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) loadPdfFromFile(f);
      e.target.value = '';
    });

    $('loadSamplePdfBtn').addEventListener('click', async e => {
      e.stopPropagation();
      showPdfError('');
      try {
        showPdfStatus('Generating 2-page sample Flipkart + Meesho shipping label PDF…');
        const sampleBytes = await generateSampleShippingPdfFile();
        await loadPdfBytesInternal(sampleBytes, 'sample-flipkart-meesho-labels-2pages.pdf');
      } catch (err) {
        showPdfError(err.message || 'Could not create sample PDF.');
      }
    });

    $('pdfClearBtn').addEventListener('click', () => {
      state.pdfDoc = null;
      state.immutableSourceBytes = null;
      state.totalPages = 0;
      $('pdfWorkspace').classList.add('hidden');
      showPdfError('');
      showPdfStatus('Upload a Flipkart or Meesho shipping label PDF to begin.');
    });

    // Multi-page navigation
    $('pdfPrevPage').addEventListener('click', () => {
      if (state.currentPage > 1) {
        state.currentPage--;
        renderCurrentPdfPage(false);
      }
    });
    $('pdfNextPage').addEventListener('click', () => {
      if (state.currentPage < state.totalPages) {
        state.currentPage++;
        renderCurrentPdfPage(false);
      }
    });
    $('pdfPageSelect').addEventListener('change', e => {
      const p = Number(e.target.value);
      if (p >= 1 && p <= state.totalPages) {
        state.currentPage = p;
        renderCurrentPdfPage(false);
      }
    });
    $('pdfZoomBtn').addEventListener('click', () => {
      state.zoomLarge = !state.zoomLarge;
      $('pdfZoomBtn').textContent = state.zoomLarge ? '🔍 Fit Preview' : '🔍 Larger Preview';
      renderCurrentPdfPage(false);
    });

    // Presets
    document.querySelectorAll('[data-crop-preset]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-crop-preset');
        if (key === 'auto') {
          await smartAutoDetectCrop();
          return;
        }
        if (PRESETS_CROP[key]) {
          state.crop = { ...PRESETS_CROP[key] };
          syncCropOverlayAndInputs();
        }
      });
    });

    // Manual % inputs
    ['cropX', 'cropY', 'cropW', 'cropH'].forEach(id => {
      $(id).addEventListener('input', () => {
        const x = clamp((Number($('cropX').value) || 0) / 100, 0, 0.95);
        const y = clamp((Number($('cropY').value) || 0) / 100, 0, 0.95);
        const w = clamp((Number($('cropW').value) || 10) / 100, 0.05, 1 - x);
        const h = clamp((Number($('cropH').value) || 10) / 100, 0.05, 1 - y);
        state.crop = { x, y, w, h };
        syncCropOverlayAndInputs();
      });
    });

    // Output dimension controls
    $('pdfSizePreset').addEventListener('change', e => {
      const p = SIZE_PRESETS[e.target.value];
      const customFields = $('pdfCustomDimsWrap');
      if (e.target.value === 'match') {
        customFields.classList.add('hidden');
      } else {
        customFields.classList.remove('hidden');
        if (p) {
          $('pdfOutWidth').value = p.w;
          $('pdfOutHeight').value = p.h;
          $('pdfOutUnit').value = p.unit;
        }
      }
      renderLiveOutputPreview();
    });

    ['pdfOutWidth', 'pdfOutHeight', 'pdfOutUnit'].forEach(id => {
      $(id).addEventListener('input', () => {
        if ($('pdfSizePreset').value !== 'custom') $('pdfSizePreset').value = 'custom';
        showPdfError('');
        renderLiveOutputPreview();
      });
      $(id).addEventListener('change', renderLiveOutputPreview);
    });
    ['pdfMarginMm', 'pdfFitMode'].forEach(id => {
      $(id).addEventListener('input', renderLiveOutputPreview);
      $(id).addEventListener('change', renderLiveOutputPreview);
    });

    $('pdfPageScope').addEventListener('change', e => {
      $('pdfCustomRangeWrap').classList.toggle('hidden', e.target.value !== 'custom');
    });

    // Download & Print actions
    $('pdfDownloadBtn').addEventListener('click', async () => {
      showPdfError('');
      const btn = $('pdfDownloadBtn');
      const prevLabel = btn.textContent;
      try {
        btn.disabled = true;
        btn.textContent = 'Generating Print PDF…';
        const { bytes, pageCount } = await buildCroppedPdfBytes();
        const base = (state.fileName || 'shipping-label').replace(/\.pdf$/i, '');
        const outName = `${base}-cropped-print.pdf`;
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = outName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        if (typeof window.showSayraToast === 'function') {
          window.showSayraToast(`Cropped ${pageCount} label page${pageCount === 1 ? '' : 's'} ❤️`);
        }
        showPdfStatus(`Downloaded "${outName}" (${pageCount} page${pageCount === 1 ? '' : 's'}) — original file untouched.`);
      } catch (err) {
        showPdfError(err.message || 'Could not export cropped PDF.');
      } finally {
        btn.disabled = false;
        btn.textContent = prevLabel;
      }
    });

    $('pdfPrintBtn').addEventListener('click', async () => {
      showPdfError('');
      try {
        const { bytes } = await buildCroppedPdfBytes();
        if (state.lastPdfBlobUrl) URL.revokeObjectURL(state.lastPdfBlobUrl);
        state.lastPdfBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        window.open(state.lastPdfBlobUrl, '_blank', 'noopener');
      } catch (err) {
        showPdfError(err.message || 'Could not prepare print preview PDF.');
      }
    });

    setupPointerCropInteraction();

    // Expose programmatic test API cleanly for verification without altering user state
    window.__sayraLabelCropper = {
      loadFile: loadPdfFromFile,
      buildCroppedPdfBytes,
      getState: () => ({
        fileName: state.fileName,
        totalPages: state.totalPages,
        currentPage: state.currentPage,
        crop: { ...state.crop },
        sourceByteLength: state.immutableSourceBytes ? state.immutableSourceBytes.byteLength : 0,
      }),
      setCrop: c => {
        state.crop = { ...state.crop, ...c };
        syncCropOverlayAndInputs();
      },
    };
  }

  if ($('pdfUploadInput')) {
    initLabelCropper();
  } else {
    document.addEventListener('DOMContentLoaded', initLabelCropper);
  }
})();
