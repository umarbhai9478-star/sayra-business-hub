/* SAYRA BRAND — Real Jeans Product Showcase Gallery
   Strictly honest temporary placeholders until real SAYRA BRAND product photos & details are supplied/uploaded.
   Stores product metadata in localStorage ('sayraBrandJeansShowcase') and high-res photos in IndexedDB ('sayraBrandJeansDB'). */
(function () {
  const $ = id => document.getElementById(id);
  const STORAGE_KEY = 'sayraBrandJeansShowcase';
  const DB_NAME = 'sayraBrandJeansDB';
  const STORE_NAME = 'photos';

  function createEmptyPlaceholderSlots() {
    return [
      { id: 'sayra-slot-1', title: '', details: '', price: '', colour: '', sizes: '', hasPhoto: false, photoFallback: '' },
      { id: 'sayra-slot-2', title: '', details: '', price: '', colour: '', sizes: '', hasPhoto: false, photoFallback: '' },
      { id: 'sayra-slot-3', title: '', details: '', price: '', colour: '', sizes: '', hasPhoto: false, photoFallback: '' },
    ];
  }

  // Optional IndexedDB storage so 20+ real smartphone photos never hit localStorage's 5MB cap
  function openPhotoDB() {
    return new Promise(resolve => {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function savePhotoData(id, dataUrl) {
    const db = await openPhotoDB();
    if (!db) return false;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(dataUrl, id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (_) {
        resolve(false);
      }
    });
  }

  async function loadPhotoData(id) {
    const db = await openPhotoDB();
    if (!db) return '';
    return new Promise(resolve => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result || '');
        req.onerror = () => resolve('');
      } catch (_) {
        resolve('');
      }
    });
  }

  async function deletePhotoData(id) {
    const db = await openPhotoDB();
    if (!db) return;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
    } catch (_) {}
  }

  async function readAndOptimizeImage(file) {
    if (!file || !/^image\//i.test(file.type || '')) {
      throw new Error('Please upload a valid image file (JPG, PNG, or WebP).');
    }
    const rawDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read photo file.'));
      reader.readAsDataURL(file);
    });

    // Downscale ultra-large 12MP camera photos cleanly to max 1280px edge for fast rendering
    return new Promise(resolve => {
      let settled = false;
      const finish = val => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      };
      const timer = setTimeout(() => finish(rawDataUrl), 300);
      const img = new Image();
      img.onload = () => {
        try {
          const maxEdge = 1280;
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (!w || !h || Math.max(w, h) <= maxEdge) {
            finish(rawDataUrl);
            return;
          }
          const scale = maxEdge / Math.max(w, h);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(w * scale);
          canvas.height = Math.round(h * scale);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', 0.86));
        } catch (_) {
          finish(rawDataUrl);
        }
      };
      img.onerror = () => finish(rawDataUrl);
      img.src = rawDataUrl;
    });
  }

  let items = [];
  const photoMemCache = new Map();

  function loadCatalogueMeta() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createEmptyPlaceholderSlots();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.length) return createEmptyPlaceholderSlots();
      return parsed;
    } catch (_) {
      return createEmptyPlaceholderSlots();
    }
  }

  function saveCatalogueMeta() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (_) {
      // If photoFallback caused quota pressure, keep photos safely in IndexedDB/memCache
      const slim = items.map(it => ({ ...it, photoFallback: '' }));
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(slim)); } catch (_e) {}
    }
    updateShowcaseBanner();
  }

  function updateShowcaseBanner() {
    const realCount = items.filter(it => it.hasPhoto).length;
    const badge = $('jeansStatusBadge');
    const notice = $('jeansPlaceholderNotice');
    if (badge) {
      badge.textContent = realCount > 0
        ? `${realCount} Real Photo${realCount === 1 ? '' : 's'} Uploaded`
        : 'Temporary Placeholders Active';
    }
    if (notice) {
      notice.classList.toggle('hidden', realCount === items.length && items.length > 0);
    }
  }

  async function resolvePhotoUrl(item) {
    if (photoMemCache.has(item.id)) return photoMemCache.get(item.id);
    if (item.photoSrc) return item.photoSrc;
    const fromDb = await loadPhotoData(item.id);
    if (fromDb) {
      photoMemCache.set(item.id, fromDb);
      return fromDb;
    }
    if (item.photoFallback) {
      photoMemCache.set(item.id, item.photoFallback);
      return item.photoFallback;
    }
    return '';
  }

  function renderSizeChips(container, sizesStr) {
    container.innerHTML = '';
    const tokens = String(sizesStr || '')
      .split(/[,/|\s]+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (!tokens.length) {
      const hint = document.createElement('span');
      hint.className = 'jeans-chip-empty';
      hint.textContent = 'Sizes not entered yet';
      container.appendChild(hint);
      return;
    }
    tokens.forEach(sz => {
      const chip = document.createElement('span');
      chip.className = 'jeans-size-chip';
      chip.textContent = sz;
      container.appendChild(chip);
    });
  }

  async function attachPhotoToItem(item, file) {
    const dataUrl = await readAndOptimizeImage(file);
    photoMemCache.set(item.id, dataUrl);
    const savedInDb = await savePhotoData(item.id, dataUrl);
    item.hasPhoto = true;
    item.photoFallback = savedInDb ? '' : dataUrl;
    saveCatalogueMeta();
  }

  function openLightbox(src, title) {
    const modal = $('jeansLightbox');
    if (!modal || !src) return;
    $('jeansLightboxImg').src = src;
    $('jeansLightboxCaption').textContent = title || 'SAYRA BRAND Real Product Photo';
    modal.classList.remove('hidden');
  }

  async function renderShowcase() {
    const grid = $('jeansGrid');
    if (!grid) return;
    const query = (($('jeansSearchInput') && $('jeansSearchInput').value) || '').trim().toLowerCase();
    grid.innerHTML = '';
    updateShowcaseBanner();

    const filtered = items.filter(it => {
      if (!query) return true;
      return [it.title, it.details, it.colour, it.sizes, String(it.price)]
        .some(v => String(v || '').toLowerCase().includes(query));
    });

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'jeans-empty-search';
      empty.textContent = 'No jeans slots match your search filter.';
      grid.appendChild(empty);
      return;
    }

    for (const [index, item] of filtered.entries()) {
      const card = document.createElement('article');
      const accentMod = index % 3 === 0 ? 'jeans-card-lav' : index % 3 === 1 ? 'jeans-card-lime' : 'jeans-card-red';
      card.className = `jeans-card ${accentMod}`;
      card.dataset.slotId = item.id;

      const photoUrl = item.hasPhoto ? await resolvePhotoUrl(item) : '';

      // Media Frame (Real Photo OR Clearly Marked Temporary Placeholder)
      const media = document.createElement('div');
      media.className = 'jeans-media' + (photoUrl ? ' has-real-photo' : ' is-placeholder');

      const priceBadge = document.createElement('div');
      priceBadge.className = 'jeans-price-pill';
      const updatePriceBadge = () => {
        const n = Number(item.price);
        priceBadge.textContent = item.price !== '' && Number.isFinite(n) && n >= 0
          ? '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
          : 'Price: Not set';
      };
      updatePriceBadge();

      const colourBadge = document.createElement('div');
      colourBadge.className = 'jeans-colour-pill';
      const updateColourBadge = () => {
        colourBadge.textContent = item.colour && item.colour.trim() ? item.colour.trim() : 'Colour: —';
      };
      updateColourBadge();

      const hiddenInput = document.createElement('input');
      hiddenInput.type = 'file';
      hiddenInput.accept = 'image/*';
      hiddenInput.className = 'hidden';

      if (photoUrl) {
        const img = document.createElement('img');
        img.src = photoUrl;
        img.alt = item.title || 'SAYRA BRAND Jeans real product photo';
        img.loading = 'lazy';
        img.addEventListener('click', () => openLightbox(photoUrl, item.title));
        media.appendChild(img);

        const realTag = document.createElement('span');
        realTag.className = 'jeans-real-badge';
        realTag.textContent = '✦ REAL PHOTO';
        media.appendChild(realTag);
      } else {
        const ph = document.createElement('div');
        ph.className = 'jeans-placeholder-inner';
        ph.innerHTML = `
          <span class="jeans-ph-pill">TEMPORARY PLACEHOLDER</span>
          <div class="jeans-ph-monogram" aria-hidden="true">✦</div>
          <div class="jeans-ph-title">SAYRA BRAND Photo Slot ${index + 1}</div>
          <p class="jeans-ph-sub">No fake stock image used — click or drop your real SAYRA jeans photo here.</p>
        `;
        ph.addEventListener('click', () => hiddenInput.click());
        media.appendChild(ph);
      }

      media.append(priceBadge, colourBadge, hiddenInput);

      // Drag-and-drop photo onto card frame
      media.addEventListener('dragover', e => { e.preventDefault(); media.classList.add('dragover'); });
      media.addEventListener('dragleave', () => media.classList.remove('dragover'));
      media.addEventListener('drop', async e => {
        e.preventDefault();
        media.classList.remove('dragover');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return;
        try {
          await attachPhotoToItem(item, f);
          await renderShowcase();
          if (typeof window.showSayraToast === 'function') window.showSayraToast('Real jeans photo saved ❤️');
        } catch (err) {
          alert(err.message);
        }
      });

      hiddenInput.addEventListener('change', async e => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        try {
          await attachPhotoToItem(item, f);
          await renderShowcase();
          if (typeof window.showSayraToast === 'function') window.showSayraToast('Real jeans photo saved ❤️');
        } catch (err) {
          alert(err.message);
        }
      });

      // Editable Body
      const body = document.createElement('div');
      body.className = 'jeans-card-body';

      const mediaActions = document.createElement('div');
      mediaActions.className = 'jeans-media-btns';

      const uploadBtn = document.createElement('button');
      uploadBtn.type = 'button';
      uploadBtn.className = 'btn btn-gold jeans-btn-sm';
      uploadBtn.textContent = photoUrl ? '📷 Replace Photo' : '📷 Upload Real Photo';
      uploadBtn.addEventListener('click', () => hiddenInput.click());
      mediaActions.appendChild(uploadBtn);

      if (photoUrl) {
        const clearPhotoBtn = document.createElement('button');
        clearPhotoBtn.type = 'button';
        clearPhotoBtn.className = 'btn btn-ghost jeans-btn-sm';
        clearPhotoBtn.textContent = 'Clear Photo';
        clearPhotoBtn.addEventListener('click', async () => {
          item.hasPhoto = false;
          item.photoFallback = '';
          photoMemCache.delete(item.id);
          await deletePhotoData(item.id);
          saveCatalogueMeta();
          await renderShowcase();
        });
        mediaActions.appendChild(clearPhotoBtn);
      }

      // Editable Fields: Title, Details, Price, Colour, Sizes
      const titleId = `jTitle-${item.id}`;
      const detailsId = `jDetails-${item.id}`;
      const priceId = `jPrice-${item.id}`;
      const colourId = `jColour-${item.id}`;
      const sizesId = `jSizes-${item.id}`;

      const fieldsWrap = document.createElement('div');
      fieldsWrap.className = 'jeans-fields';
      fieldsWrap.innerHTML = `
        <div>
          <label for="${titleId}">Product name / style code</label>
          <input id="${titleId}" class="j-input-title" maxlength="90" placeholder="Enter real product name / SKU">
        </div>
        <div>
          <label for="${detailsId}">Product details (fabric, fit, rise, wash)</label>
          <textarea id="${detailsId}" class="j-input-details" rows="2" maxlength="280" placeholder="Add your real product specs & notes"></textarea>
        </div>
        <div class="jeans-row-2">
          <div>
            <label for="${priceId}">Selling price (₹)</label>
            <input id="${priceId}" class="j-input-price" type="number" min="0" step="1" placeholder="Enter ₹ price">
          </div>
          <div>
            <label for="${colourId}">Colour / wash</label>
            <input id="${colourId}" class="j-input-colour" maxlength="60" placeholder="Enter colour / wash">
          </div>
        </div>
        <div>
          <label for="${sizesId}">Sizes (comma or space separated)</label>
          <input id="${sizesId}" class="j-input-sizes" maxlength="80" placeholder="e.g. 28, 30, 32, 34, 36">
        </div>
      `;

      const sizeChipRow = document.createElement('div');
      sizeChipRow.className = 'jeans-size-row';

      const footActions = document.createElement('div');
      footActions.className = 'jeans-card-foot';

      const calcBtn = document.createElement('button');
      calcBtn.type = 'button';
      calcBtn.className = 'btn btn-ghost jeans-btn-sm';
      calcBtn.textContent = '🧮 Test Margin in Calculator';
      calcBtn.addEventListener('click', () => {
        if (item.price !== '' && Number.isFinite(Number(item.price))) {
          const sp = $('sellingPrice');
          if (sp) {
            sp.value = item.price;
            sp.dispatchEvent(new Event('input'));
          }
        }
        const calcSec = $('calculator');
        if (calcSec) calcSec.scrollIntoView({ behavior: 'smooth' });
      });

      const delSlotBtn = document.createElement('button');
      delSlotBtn.type = 'button';
      delSlotBtn.className = 'tinybtn';
      delSlotBtn.textContent = 'Remove Slot';
      delSlotBtn.addEventListener('click', async () => {
        if (!confirm('Remove this jeans showcase slot?')) return;
        await deletePhotoData(item.id);
        photoMemCache.delete(item.id);
        items = items.filter(x => x.id !== item.id);
        if (!items.length) items = createEmptyPlaceholderSlots();
        saveCatalogueMeta();
        await renderShowcase();
      });

      footActions.append(calcBtn, delSlotBtn);
      body.append(mediaActions, fieldsWrap, sizeChipRow, footActions);
      card.append(media, body);
      grid.appendChild(card);

      // Bind values & real-time persistence
      const elTitle = fieldsWrap.querySelector('.j-input-title');
      const elDetails = fieldsWrap.querySelector('.j-input-details');
      const elPrice = fieldsWrap.querySelector('.j-input-price');
      const elColour = fieldsWrap.querySelector('.j-input-colour');
      const elSizes = fieldsWrap.querySelector('.j-input-sizes');

      elTitle.value = item.title || '';
      elDetails.value = item.details || '';
      elPrice.value = item.price !== undefined && item.price !== null ? item.price : '';
      elColour.value = item.colour || '';
      elSizes.value = item.sizes || '';
      renderSizeChips(sizeChipRow, item.sizes);

      elTitle.addEventListener('input', () => { item.title = elTitle.value; saveCatalogueMeta(); });
      elDetails.addEventListener('input', () => { item.details = elDetails.value; saveCatalogueMeta(); });
      elPrice.addEventListener('input', () => {
        item.price = elPrice.value;
        updatePriceBadge();
        saveCatalogueMeta();
      });
      elColour.addEventListener('input', () => {
        item.colour = elColour.value;
        updateColourBadge();
        saveCatalogueMeta();
      });
      elSizes.addEventListener('input', () => {
        item.sizes = elSizes.value;
        renderSizeChips(sizeChipRow, item.sizes);
        saveCatalogueMeta();
      });
    }
  }

  function initShowcase() {
    if (!$('jeansGrid')) return;
    items = loadCatalogueMeta();

    $('addJeansSlotBtn').addEventListener('click', async () => {
      items.push({
        id: 'sayra-slot-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6),
        title: '',
        details: '',
        price: '',
        colour: '',
        sizes: '',
        hasPhoto: false,
        photoFallback: '',
      });
      saveCatalogueMeta();
      await renderShowcase();
      if (typeof window.showSayraToast === 'function') window.showSayraToast('Added new jeans showcase slot ❤️');
    });

    $('bulkJeansPhotosBtn').addEventListener('click', () => $('bulkJeansPhotosInput').click());
    $('bulkJeansPhotosInput').addEventListener('change', async e => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      if (!files.length) return;
      let added = 0;
      for (const file of files) {
        if (!/^image\//i.test(file.type || '')) continue;
        // Fill empty placeholder slots first before creating new slots!
        let target = items.find(it => !it.hasPhoto && !it.title && !it.details && it.price === '');
        if (!target) {
          target = {
            id: 'sayra-slot-' + Date.now() + '-' + Math.random().toString(16).slice(2, 6),
            title: '',
            details: '',
            price: '',
            colour: '',
            sizes: '',
            hasPhoto: false,
            photoFallback: '',
          };
          items.push(target);
        }
        await attachPhotoToItem(target, file);
        added++;
      }
      saveCatalogueMeta();
      await renderShowcase();
      if (added && typeof window.showSayraToast === 'function') {
        window.showSayraToast(`Uploaded ${added} real SAYRA jeans photo${added === 1 ? '' : 's'} ❤️`);
      }
    });

    if ($('jeansSearchInput')) {
      $('jeansSearchInput').addEventListener('input', () => { renderShowcase(); });
    }

    const closeModal = () => $('jeansLightbox').classList.add('hidden');
    $('jeansLightboxClose').addEventListener('click', closeModal);
    $('jeansLightbox').addEventListener('click', e => {
      if (e.target.id === 'jeansLightbox') closeModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('jeansLightbox').classList.contains('hidden')) closeModal();
    });

    renderShowcase();

    window.__sayraJeansShowcase = {
      getItems: () => items.map(x => ({ ...x })),
      reload: () => { items = loadCatalogueMeta(); return renderShowcase(); },
    };
  }

  if ($('jeansGrid')) {
    initShowcase();
  } else {
    document.addEventListener('DOMContentLoaded', initShowcase);
  }
})();
