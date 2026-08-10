/**
 * ScaleUp Clone — аналитика YO (паритет dashboard/finance/assortment/logistics)
 * Данные: Uzum Seller OpenAPI через /api/uzum-proxy + себестоимость YO.
 */
(function () {
  'use strict';

  const UZUM_OPENAPI = 'https://api-seller.uzum.uz/api/seller-openapi';
  const TOKEN_KEY = 'yo_uzum_bearer_token';
  const SYNC_KEY = 'yo_scaleup_sync_meta';
  const ORDERS_KEY = 'yo_uzum_orders_v1';
  const EXPENSES_KEY = 'yo_uzum_expenses_v1';
  const FBS_KEY = 'yo_uzum_fbs_orders_v1';
  const API_PRODUCTS_KEY = 'yo_uzum_api_products_v1';
  const DISMISSED_KEY = 'yo_scaleup_dismissed_insights';
  const SETTINGS_KEY = 'yo_scaleup_settings';

  let _view = 'dashboard';
  let _periodMode = 'today'; // today | month | days | day | custom
  let _periodDays = 90;
  let _periodDay = ''; // YYYY-MM-DD
  let _periodCustomFrom = '';
  let _periodCustomTo = '';
  let _finSub = 'overview';
  let _expFilter = 'all';
  let _dynMode = 'orders';
  let _products = [];
  let _yoCostMap = {};
  let _yoCostProductCount = 0;
  let _yoCostStrongKeys = [];
  let _shipments = [];
  let _orders = [];
  let _expenses = [];
  let _fbsOrders = [];
  let _financeLocal = [];
  let _dismissed = new Set();
  let _settings = { vatPct: 12, commPct: 22, minMarginPct: 18 };
  let _hasApiData = false;
  let _hasFirebase = false;
  let _initialized = false;
  let _prodFilter = 'all';
  let _wired = false;
  let _assortTab = 'products';
  let _selectedSkuKey = '';
  let _syncBusy = false;
  let _costFilter = 'all'; // all | has | miss
  let _autoOrdersTimer = null;
  const UZ_TZ = 'Asia/Tashkent';
  const AUTO_ORDERS_MS = 15 * 60 * 1000;

  try {
    _dismissed = new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]'));
  } catch (_) { /* ignore */ }
  try {
    _settings = Object.assign(_settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  } catch (_) { /* ignore */ }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function money(v) {
    if (typeof fmtMoney === 'function') return fmtMoney(v);
    const x = Number(v) || 0;
    return `${Math.round(x).toLocaleString('ru-RU')} сум`;
  }

  function moneyShort(v) {
    const x = Number(v) || 0;
    const a = Math.abs(x);
    if (a >= 1e9) return `${(x / 1e9).toFixed(1)} млрд`;
    if (a >= 1e6) return `${(x / 1e6).toFixed(1)} млн`;
    if (a >= 1e3) return `${(x / 1e3).toFixed(1)} тыс`;
    return `${Math.round(x).toLocaleString('ru-RU')}`;
  }

  function pct(v) {
    const x = Number(v);
    if (!Number.isFinite(x)) return '—';
    return `${x.toFixed(1)}%`;
  }

  function getToken() {
    return String(localStorage.getItem(TOKEN_KEY) || '').trim();
  }

  function cleanToken(raw) {
    return String(raw || '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/^Bearer\s+/i, '')
      .replace(/\s+/g, '');
  }

  function readJwtMeta(token) {
    try {
      const parts = String(token || '').split('.');
      if (parts.length < 2) return null;
      const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
      const payload = JSON.parse(json);
      const exp = Number(payload.exp);
      return {
        exp: Number.isFinite(exp) ? exp : null,
        expired: Number.isFinite(exp) ? exp * 1000 < Date.now() : null,
        secondsLeft: Number.isFinite(exp) ? Math.floor(exp - Date.now() / 1000) : null
      };
    } catch {
      return null;
    }
  }

  function tokenStatusHtml(token) {
    if (!token) return pill('bad', 'Не подключён');
    const meta = readJwtMeta(token);
    if (meta?.expired) return pill('bad', 'Ключ просрочен');
    return pill('ok', 'API-ключ есть');
  }

  function getSyncMeta() {
    try {
      return JSON.parse(localStorage.getItem(SYNC_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function saveSyncMeta(data) {
    localStorage.setItem(SYNC_KEY, JSON.stringify(Object.assign({}, getSyncMeta(), data)));
  }

  function readLocal(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeLocal(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  const IDB_NAME = 'yo_scaleup_cache_v1';
  const IDB_STORE = 'kv';
  let _idbPromise = null;

  function openScaleupIdb() {
    if (_idbPromise) return _idbPromise;
    _idbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB недоступен'));
        return;
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
    return _idbPromise;
  }

  async function idbGet(key) {
    try {
      const db = await openScaleupIdb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return undefined;
    }
  }

  async function idbSet(key, val) {
    const db = await openScaleupIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
    });
  }

  async function idbDel(key) {
    try {
      const db = await openScaleupIdb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) { /* ignore */ }
  }

  /** Крупные массивы (заказы/товары) — IndexedDB; localStorage только как legacy fallback. */
  async function readCache(key, fallback) {
    const fromIdb = await idbGet(key);
    if (fromIdb !== undefined) return fromIdb;
    return readLocal(key, fallback);
  }

  async function writeCache(key, val) {
    await idbSet(key, val);
    try {
      localStorage.removeItem(key);
    } catch (_) { /* ignore */ }
    try {
      localStorage.setItem(
        `${key}__meta`,
        JSON.stringify({ n: Array.isArray(val) ? val.length : 1, at: new Date().toISOString() })
      );
    } catch (_) { /* ignore */ }
  }

  function slimOrder(o) {
    if (!o || typeof o !== 'object') return o;
    return {
      id: o.id,
      status: o.status,
      date: o.date,
      dateIssued: o.dateIssued,
      orderId: o.orderId,
      skuTitle: o.skuTitle,
      productId: o.productId,
      shopId: o.shopId,
      sellPrice: o.sellPrice ?? o.sellerPrice,
      amount: o.amount,
      amountReturns: o.amountReturns,
      commission: o.commission,
      sellerProfit: o.sellerProfit,
      purchasePrice: o.purchasePrice,
      logisticDeliveryFee: o.logisticDeliveryFee,
      cancelled: o.cancelled,
      withdrawnProfit: o.withdrawnProfit,
      productTitle: o.productTitle,
      returnCause: o.returnCause
    };
  }

  function slimSku(sku) {
    if (!sku || typeof sku !== 'object') return sku;
    return {
      skuTitle: sku.skuTitle,
      skuFullTitle: sku.skuFullTitle,
      productTitle: sku.productTitle,
      skuId: sku.skuId,
      quantityActive: sku.quantityActive,
      quantityFbs: sku.quantityFbs,
      quantityFbo: sku.quantityFbo,
      barcode: sku.barcode,
      archived: sku.archived,
      commission: sku.commission,
      previewImage: resolveUzumImage(sku.previewImage),
      price: sku.price,
      blocked: sku.blocked,
      avgdsales: sku.avgdsales,
      paidStorageAmount: sku.paidStorageAmount,
      paidStoragePriceItem: sku.paidStoragePriceItem,
      pstorage: sku.pstorage,
      status: sku.status,
      article: sku.article,
      sellerItemCode: sku.sellerItemCode
    };
  }

  function slimProductCard(card) {
    if (!card || typeof card !== 'object') return card;
    return {
      productId: card.productId,
      category: card.category,
      rating: card.rating,
      feedbackQuantity: card.feedbackQuantity,
      status: card.status,
      moderationStatus: card.moderationStatus,
      commission: card.commission,
      commissionDto: card.commissionDto,
      skuTitle: card.skuTitle,
      image: resolveUzumImage(card.image, card.previewImg),
      title: card.title,
      quantityActive: card.quantityActive,
      quantityFbs: card.quantityFbs,
      quantityFbo: card.quantityFbo,
      price: card.price,
      conversion: card.conversion,
      pstorage: card.pstorage,
      shopId: card.shopId,
      skuList: Array.isArray(card.skuList) ? card.skuList.map(slimSku) : []
    };
  }

  function slimExpense(e) {
    if (!e || typeof e !== 'object') return e;
    return {
      id: e.id,
      type: e.type,
      status: e.status,
      paymentPrice: e.paymentPrice ?? e.amount,
      amount: e.amount,
      dateCreated: e.dateCreated,
      dateService: e.dateService,
      dateUpdated: e.dateUpdated,
      date: e.date,
      source: e.source,
      code: e.code,
      shopId: e.shopId,
      externalId: e.externalId,
      comment: e.comment,
      name: e.name,
      title: e.title || e.name
    };
  }

  function slimFbs(o) {
    if (!o || typeof o !== 'object') return o;
    return {
      id: o.id,
      orderId: o.orderId,
      status: o.status || o._status,
      _status: o._status || o.status,
      dateCreated: o.dateCreated || o.createdAt || o.date,
      shopId: o.shopId,
      skuTitle: o.skuTitle || o.sku?.skuTitle,
      productTitle: o.productTitle || o.title
    };
  }

  /** Календарный день в TZ Узбекистана (как Market Plus / Uzum). */
  function ymdInTz(d, timeZone) {
    const x = d instanceof Date ? d : new Date(d || Date.now());
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || UZ_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(x);
    const get = (t) => parts.find((p) => p.type === t)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function startOfDayMs(d) {
    const ymd = ymdInTz(d || Date.now(), UZ_TZ);
    return new Date(`${ymd}T00:00:00+05:00`).getTime();
  }

  function endOfDayMs(d) {
    const ymd = ymdInTz(d || Date.now(), UZ_TZ);
    return new Date(`${ymd}T23:59:59.999+05:00`).getTime();
  }

  function isoDateLocal(d) {
    return ymdInTz(d || Date.now(), UZ_TZ);
  }

  function getPeriodRange() {
    const now = Date.now();
    if (_periodMode === 'today') {
      return { from: startOfDayMs(), to: endOfDayMs(), label: 'Сегодня', days: 1 };
    }
    if (_periodMode === 'month') {
      const ymd = ymdInTz(Date.now(), UZ_TZ);
      const [y, m] = ymd.split('-').map(Number);
      const from = new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00+05:00`).getTime();
      return {
        from,
        to: endOfDayMs(),
        label: 'Этот месяц',
        days: Math.max(1, Math.ceil((endOfDayMs() - from) / 86400000) + 1)
      };
    }
    if (_periodMode === 'day' && _periodDay) {
      const d = new Date(`${_periodDay}T12:00:00`);
      return { from: startOfDayMs(d), to: endOfDayMs(d), label: _periodDay, days: 1 };
    }
    if (_periodMode === 'custom' && _periodCustomFrom && _periodCustomTo) {
      const a = new Date(`${_periodCustomFrom}T12:00:00`);
      const b = new Date(`${_periodCustomTo}T12:00:00`);
      const from = startOfDayMs(a);
      const to = endOfDayMs(b);
      return {
        from: Math.min(from, to),
        to: Math.max(from, to),
        label: `${_periodCustomFrom} — ${_periodCustomTo}`,
        days: Math.max(1, Math.round(Math.abs(to - from) / 86400000) + 1)
      };
    }
    const days = Number(_periodDays) || 90;
    return { from: now - days * 86400000, to: now, label: `${days} дн`, days };
  }

  function periodStartMs() {
    return getPeriodRange().from;
  }

  function periodEndMs() {
    return getPeriodRange().to;
  }

  function periodDaysCount() {
    return getPeriodRange().days || 1;
  }

  function inPeriodMs(ms) {
    const t = Number(ms);
    if (!Number.isFinite(t) || t <= 0) return false;
    const r = getPeriodRange();
    return t >= r.from && t <= r.to;
  }

  function periodToolbarHtml() {
    const r = getPeriodRange();
    const chip = (mode, label, days) => {
      let active = _periodMode === mode;
      if (mode === 'days') active = active && Number(days) === Number(_periodDays);
      return `<button type="button" class="sc-period${active ? ' active' : ''}" data-sc-period="${mode}"${
        days != null ? ` data-days="${days}"` : ''
      }>${label}</button>`;
    };
    return `<div class="sc-period-bar">
      <div class="sc-period-wrap">
        ${chip('today', 'Сегодня')}
        ${chip('month', 'Месяц')}
        ${chip('days', '30 дн', 30)}
        ${chip('days', '90 дн', 90)}
        ${chip('day', 'День')}
        ${chip('custom', 'Период')}
      </div>
      <div class="sc-period-inputs">
        ${_periodMode === 'day'
          ? `<input type="date" class="sc-date-input" id="sc-period-day" value="${esc(_periodDay || isoDateLocal())}" />`
          : ''}
        ${_periodMode === 'custom'
          ? `<input type="date" class="sc-date-input" id="sc-period-from" value="${esc(_periodCustomFrom || isoDateLocal())}" />
             <span class="sc-period-sep">—</span>
             <input type="date" class="sc-date-input" id="sc-period-to" value="${esc(_periodCustomTo || isoDateLocal())}" />`
          : ''}
        <span class="sc-period-label">Показано: <strong>${esc(r.label)}</strong></span>
      </div>
    </div>`;
  }

  function orderDateMs(o) {
    // У finance/orders поле dateIssued часто null — реальное время в `date`
    return Number(o?.date || o?.dateIssued || o?.createdAt || 0) || 0;
  }

  function orderSellPrice(o) {
    return Number(o?.sellPrice ?? o?.sellerPrice ?? o?.purchasePrice ?? 0) || 0;
  }

  function resolveUzumImage(...candidates) {
    for (const raw of candidates) {
      let u = String(raw || '').trim();
      if (!u) continue;
      // Иногда API отдаёт только ключ без размера → пиксели / битая картинка
      if (/^https?:\/\/images\.uzum\.uz\/[^/]+$/i.test(u)) {
        u = `${u}/t_product_540_high.jpg`;
      }
      u = u
        .replace(/\/t_product_80_(low|high)\.jpg/gi, '/t_product_540_high.jpg')
        .replace(/\/t_product_240_low\.jpg/gi, '/t_product_540_high.jpg')
        .replace(/\/t_product_low\.jpg/gi, '/t_product_540_high.jpg')
        .replace(/\/t_product_540_low\.jpg/gi, '/t_product_540_high.jpg');
      return u;
    }
    return '';
  }

  function deltaPct(cur, prev) {
    if (!prev) return cur ? 100 : 0;
    return ((cur - prev) / Math.abs(prev)) * 100;
  }

  function deltaHtml(cur, prev, unit) {
    const d = deltaPct(cur, prev);
    const cls = d >= 0 ? 'sc-kpi-delta-up' : 'sc-kpi-delta-down';
    const sign = d >= 0 ? '+' : '';
    const suf = unit === 'pp' ? ' п.п.' : '%';
    return `<span class="${cls}">${sign}${d.toFixed(1)}${suf}</span>`;
  }

  function productSku(p) {
    return String(p?.sku || p?.skuTitle || p?.skuFullTitle || p?.article1c || p?.skuId || p?.id || '').trim();
  }

  function normalizeSkuKey(s) {
    return String(s || '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/[_–—−]/g, '-')
      .toLowerCase();
  }

  function isWeakSkuKey(raw) {
    const s = String(raw ?? '').trim();
    if (s.length < 3) return true;
    if (/^\d{1,7}$/.test(s)) return true; // заглушки вроде «19»
    return false;
  }

  /** Себестоимость из базы YO: матч по Uzum SKU / артикулу / штрихкоду. */
  function buildYoCostMap(list) {
    const map = {};
    const add = (key, cost, { allowWeak } = {}) => {
      const raw = String(key ?? '').trim();
      if (!raw || !(cost > 0)) return;
      if (!allowWeak && isWeakSkuKey(raw)) return;
      map[raw] = cost;
      const nk = normalizeSkuKey(raw);
      if (nk) map[nk] = cost;
      // без префикса магазина BAHMALG-
      const noShop = nk.replace(/^bahmalg-/, '');
      if (noShop && noShop !== nk && noShop.length >= 4) map[noShop] = cost;
      // хвост после первого «-» (часто короткий артикул в YO)
      const dash = nk.indexOf('-');
      if (dash > 0) {
        const tail = nk.slice(dash + 1);
        if (tail.length >= 6) map[tail] = cost;
      }
    };
    let withCost = 0;
    (list || []).forEach((p) => {
      const c =
        Number(p?.costGross ?? p?.costPriceUzs ?? p?.costPrice ?? p?.cost ?? p?.purchasePrice ?? 0) || 0;
      if (!(c > 0)) return;
      withCost += 1;
      add(p.uzumSku ?? p.uzum_sku ?? p.calc?.mpSkuUzum, c);
      add(p.sku, c);
      add(p.article1c, c);
      add(p.name, c);
      add(p.uzum_barcode, c, { allowWeak: false });
      add(p.barcode, c, { allowWeak: false });
      add(p.wbSku ?? p.wb_nmid ?? p.calc?.mpWbNmid, c);
      add(p.yandexSku ?? p.yandex_sku ?? p.calc?.mpSkuYandex, c);
      add(p.code1c, c);
    });
    _yoCostProductCount = withCost;
    _yoCostStrongKeys = Object.keys(map).filter((k) => {
      if (!k || k.length < 6 || isWeakSkuKey(k)) return false;
      return /[-_]/.test(k) || /[a-zа-яё]\d|\d[a-zа-яё]/i.test(k);
    });
    return map;
  }

  function lookupYoCost(...keys) {
    const tried = [];
    for (const k of keys) {
      const raw = String(k ?? '').trim();
      if (!raw || isWeakSkuKey(raw)) continue;
      if (_yoCostMap[raw] != null) return _yoCostMap[raw];
      const nk = normalizeSkuKey(raw);
      if (_yoCostMap[nk] != null) return _yoCostMap[nk];
      const noShop = nk.replace(/^bahmalg-/, '');
      if (noShop && _yoCostMap[noShop] != null) return _yoCostMap[noShop];
      tried.push(nk, noShop);
    }
    // мягкий матч: OpenAPI SKU заканчивается на ключ из YO (или наоборот)
    for (const nk of tried) {
      if (!nk || nk.length < 6) continue;
      for (const mapKey of _yoCostStrongKeys) {
        if (nk === mapKey) return _yoCostMap[mapKey];
        if (nk.endsWith(mapKey) || (mapKey.length >= 8 && mapKey.endsWith(nk))) return _yoCostMap[mapKey];
      }
    }
    return 0;
  }

  function yoCostMatchStats() {
    const total = _products.length;
    let withCost = 0;
    _products.forEach((p) => {
      if (productCost(p) > 0) withCost += 1;
    });
    return { total, withCost, miss: Math.max(0, total - withCost), yoProducts: _yoCostProductCount };
  }

  function productCost(p) {
    const fromDb = lookupYoCost(
      p?.sku,
      p?.skuTitle,
      p?.skuFullTitle,
      p?.uzumSku,
      p?.uzum_sku,
      p?.barcode,
      p?.article1c,
      p?.name,
      p?.title,
      productSku(p)
    );
    if (fromDb > 0) return fromDb;
    return Number(p?.costGross ?? p?.costPrice ?? p?.cost ?? p?.purchasePrice ?? 0) || 0;
  }

  function productStock(p) {
    return Math.max(
      0,
      Number(p?.stockQty ?? p?.quantityActive ?? p?.quantityFbo ?? p?.quantityFbs ?? 0) || 0
    );
  }

  function productLiters(p) {
    const v = Number(p?.volumeLiters);
    if (Number.isFinite(v) && v > 0) return v;
    return 0;
  }

  function pill(cls, txt) {
    return `<span class="sc-pill sc-pill-${cls}">${esc(txt)}</span>`;
  }

  function kpiCard(label, val, sub, color) {
    return `<div class="sc-kpi${color ? ' ' + color : ''}">
      <div class="sc-kpi-label">${esc(label)}</div>
      <div class="sc-kpi-val">${val}</div>
      ${sub ? `<div class="sc-kpi-sub">${sub}</div>` : ''}
    </div>`;
  }

  function showLoader() {
    const el = document.getElementById('sc-content');
    if (el) el.innerHTML = '<div class="sc-loader"><div class="sc-spinner"></div>Загрузка данных…</div>';
  }

  async function loadFromFirebase(collection) {
    if (!window.db) return null;
    try {
      const snap = await window.db.collection(collection).limit(4000).get();
      return snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
    } catch (e) {
      console.warn(`ScaleUp Firebase ${collection}:`, e?.message || e);
      return null;
    }
  }

  function statusLabel(status) {
    if (!status) return '';
    if (typeof status === 'string') return status;
    return String(status.value || status.name || status.title || status.description || '').trim();
  }

  function statusIsOnSale(status) {
    const s = statusLabel(status).toUpperCase();
    return /IN_SALE|IN_STOCK|ON_SALE|FOR_SALE|ACTIVE|SALE|В ПРОДАЖ|ПРОДАЖ|AVAILABLE|SELLING/.test(s);
  }

  function statusIsArchived(status) {
    const s = statusLabel(status).toUpperCase();
    return /ARCHIV|АРХИВ/.test(s);
  }

  function statusIsBlocked(status) {
    const s = statusLabel(status).toUpperCase();
    return /BLOCK|БЛОК/.test(s);
  }

  function flattenApiProducts(apiList) {
    const out = [];
    const shopIdFallback = getSyncMeta().shopId || null;
    (apiList || []).forEach((card) => {
      const skus = Array.isArray(card.skuList) && card.skuList.length ? card.skuList : [null];
      skus.forEach((sku) => {
        const skuCode = String(
          sku?.skuFullTitle ||
            sku?.skuTitle ||
            sku?.article ||
            sku?.sellerItemCode ||
            card.skuTitle ||
            sku?.barcode ||
            card.productId ||
            ''
        ).trim();
        if (!skuCode) return;
        const qActive = Number(sku?.quantityActive ?? card.quantityActive ?? 0) || 0;
        const qFbo = Number(sku?.quantityFbo ?? card.quantityFbo ?? 0) || 0;
        const qFbs = Number(sku?.quantityFbs ?? card.quantityFbs ?? 0) || 0;
        const stock = qActive || qFbo + qFbs;
        const price = Number(sku?.price ?? sku?.sellPrice ?? sku?.fullPrice ?? card.price ?? 0) || 0;
        const commission =
          Number(
            sku?.commission ??
              card.commissionDto?.maxCommission ??
              card.commissionDto?.minCommission ??
              card.commission ??
              0
          ) || 0;
        const avgd = Number(sku?.avgdsales ?? card.avgdsales ?? 0) || 0;
        const turnoverDays = avgd > 0 ? Math.round(stock / avgd) : null;
        const paidStorage =
          sku?.pstorage || card.pstorage || Number(sku?.paidStorageAmount ?? sku?.paidStoragePriceItem ?? 0) > 0;
        const paidStorageAmount = Number(sku?.paidStorageAmount ?? sku?.paidStoragePriceItem ?? 0) || 0;
        const skuStatus = sku?.status || card.status;
        out.push({
          id: sku?.skuId || card.productId,
          productId: card.productId,
          skuId: sku?.skuId,
          sku: skuCode,
          barcode: sku?.barcode != null ? String(sku.barcode) : '',
          name: card.title || sku?.productTitle || card.skuTitle || skuCode,
          title: card.title || sku?.productTitle || card.skuTitle || skuCode,
          image: resolveUzumImage(card.image, sku?.previewImage, card.previewImg, sku?.photo),
          rating: card.rating != null ? Number(card.rating) : null,
          reviews: Number(card.feedbackQuantity || card.reviewsCount || card.reviews || 0) || 0,
          category: card.categoryTitle || card.category?.title || card.category || '',
          status: statusLabel(skuStatus),
          statusRaw: skuStatus,
          cardStatus: statusLabel(card.status),
          cardStatusRaw: card.status,
          moderationStatus: statusLabel(card.moderationStatus),
          conversion: card.conversion != null ? Number(card.conversion) : null,
          avgdsales: avgd,
          commission,
          stockQty: stock,
          quantityActive: qActive,
          quantityFbo: qFbo,
          quantityFbs: qFbs,
          price,
          sellPrice: price,
          cost: lookupYoCost(skuCode, sku?.skuTitle, sku?.skuFullTitle, sku?.barcode, card.skuTitle) || 0,
          shopId: card.shopId || shopIdFallback,
          turnoverDays,
          paidStorage,
          paidStorageAmount,
          archived: !!(sku?.archived || statusIsArchived(card.status)),
          blocked: !!(sku?.blocked || statusIsBlocked(skuStatus) || statusIsBlocked(card.status)),
          source: 'openapi',
          _key: `${card.productId || ''}:${sku?.skuId || skuCode}`
        });
      });
    });
    return out;
  }

  async function loadAllData() {
    showLoader();
    const fbProducts = await loadFromFirebase('products');
    const fbShipments = await loadFromFirebase('shipments');
    const fbFinance = await loadFromFirebase('finance_payments');
    _hasFirebase = !!(fbProducts && fbProducts.length);

    let yoProducts = [];
    if (fbProducts && fbProducts.length) yoProducts = fbProducts;
    else if (window.appState?.products?.length) yoProducts = window.appState.products.slice();
    else yoProducts = readLocal('uzum_products_db_v1', []);
    _yoCostMap = buildYoCostMap(yoProducts);

    if (fbShipments && fbShipments.length) _shipments = fbShipments;
    else if (window.appState?.shipments?.length) _shipments = window.appState.shipments.slice();
    else _shipments = readLocal('uzum_shipments_db_v1', []);

    try {
      const fin = JSON.parse(localStorage.getItem('yo_finances_uzum_v1') || '{"payments":[]}');
      _financeLocal = Array.isArray(fin.payments) ? fin.payments : [];
    } catch (_) {
      _financeLocal = [];
    }
    if (fbFinance && fbFinance.length) _financeLocal = fbFinance;

    _orders = await readCache(ORDERS_KEY, []);
    _expenses = await readCache(EXPENSES_KEY, []);
    _fbsOrders = await readCache(FBS_KEY, []);
    const apiProducts = await readCache(API_PRODUCTS_KEY, []);

    // Ассортимент = только Uzum OpenAPI. YO — только себестоимость.
    if (apiProducts.length) {
      _products = flattenApiProducts(apiProducts);
      _hasApiData = true;
    } else {
      _products = [];
      _hasApiData = _orders.length > 0;
    }

    if (_selectedSkuKey && !_products.some((p) => p._key === _selectedSkuKey || productSku(p) === _selectedSkuKey)) {
      _selectedSkuKey = '';
    }
    updateDataSourceBadge();
    render();
  }

  function updateDataSourceBadge() {
    const el = document.getElementById('sc-data-source');
    if (!el) return;
    const parts = [];
    if (_hasFirebase) parts.push('Firebase');
    if (_hasApiData) parts.push('Uzum OpenAPI');
    if (!_hasFirebase && !_hasApiData) parts.push('localStorage');
    const meta = getSyncMeta();
    const todayQty = _orders.length
      ? metricsFor(ordersInRange(startOfDayMs(), endOfDayMs())).qty
      : null;
    const todayBit = todayQty != null ? ` · сегодня ${todayQty} шт` : '';
    el.textContent = `${parts.join(' · ')} · ${_products.length} SKU${meta.shopId ? ` · shop #${meta.shopId}` : ''}${todayBit}`;
  }

  /* ========== OpenAPI client ========== */
  function uzumProxyUrl(apiPath) {
    return `/api/uzum-proxy?path=${encodeURIComponent(String(apiPath || '').replace(/^\/+/, ''))}`;
  }

  async function uzumFetch(apiPath, options = {}) {
    const token = cleanToken(getToken());
    if (!token) throw new Error('Нет API-ключа');
    const headers = Object.assign(
      {
        Authorization: token,
        Accept: 'application/json',
        'Accept-Language': 'ru-RU'
      },
      options.headers || {}
    );
    const path = String(apiPath || '').replace(/^\/+/, '');
    try {
      const proxied = await fetch(uzumProxyUrl(path), { ...options, headers });
      const ct = proxied.headers.get('content-type') || '';
      if (proxied.status === 404 && ct.includes('text/html')) throw new Error('proxy-missing');
      return proxied;
    } catch (e) {
      if (String(e?.message) !== 'proxy-missing' && !(e instanceof TypeError)) throw e;
      return fetch(`${UZUM_OPENAPI}/${path}`, { ...options, headers });
    }
  }

  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function uzumJson(apiPath) {
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await uzumFetch(apiPath);
      const text = await res.text().catch(() => '');
      if (res.status === 429) {
        lastErr = new Error(`HTTP 429: ${text.slice(0, 200)}`);
        lastErr.status = 429;
        lastErr.body = text;
        const wait = Math.min(45000, 2000 * Math.pow(2, attempt) + Math.random() * 800);
        setSyncBusy(true, `Лимит Uzum (429). Пауза ${Math.round(wait / 1000)}с…`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        err.body = text;
        throw err;
      }
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    }
    throw lastErr || new Error('HTTP 429: слишком много запросов к Uzum');
  }

  function unwrapList(data, keys) {
    if (Array.isArray(data)) return data;
    for (const k of keys || []) {
      if (Array.isArray(data?.[k])) return data[k];
    }
    if (Array.isArray(data?.payload?.payments)) return data.payload.payments;
    if (Array.isArray(data?.payload?.paymentList)) return data.payload.paymentList;
    if (Array.isArray(data?.payload?.productList)) return data.payload.productList;
    if (Array.isArray(data?.payload)) return data.payload;
    if (Array.isArray(data?.content)) return data.content;
    return [];
  }

  async function fetchPaged(buildPath, extract, maxPages, pageDelayMs, pageSizeHint) {
    const out = [];
    const limit = maxPages || 8;
    const delay = pageDelayMs == null ? 900 : pageDelayMs;
    const sizeHint = pageSizeHint || 20;
    for (let page = 0; page < limit; page++) {
      if (page > 0 && delay > 0) await sleep(delay);
      const data = await uzumJson(buildPath(page));
      const chunk = extract(data);
      if (!chunk.length) break;
      out.push(...chunk);
      const total =
        data?.totalElements ??
        data?.payload?.totalElements ??
        data?.totalProductsAmount ??
        data?.total ??
        null;
      // Uzum expenses часто отдаёт totalElements=0 при непустой странице — игнорим такой total
      if (total != null && Number(total) > 0 && out.length >= Number(total)) break;
      if (chunk.length < sizeHint) break;
    }
    return out;
  }

  function explainUzumHttpError(status, errText) {
    if (status === 429 || /429|too many|rate/i.test(errText || '')) {
      return (
        'Uzum ограничил частоту запросов (HTTP 429).\n\n' +
        'Подожди 2–5 минут и нажми «Синхронизировать» ещё раз.\n' +
        'Товары сохраняются первыми — заказы/FBS можно дотянуть позже.'
      );
    }
    if (status === 401 || /unauthorized/i.test(errText || '')) {
      return (
        'Uzum отклонил API-ключ (HTTP 401).\n\n' +
        'Создай ключ: https://seller.uzum.uz/seller/api-keys\n' +
        'Вставь в Настройки → Сохранить и проверить'
      );
    }
    if (String(errText).includes('proxy-missing')) {
      return 'Прокси /api/uzum-proxy не найден. Задеплой папку api/ на Vercel.';
    }
    return `HTTP ${status}${errText ? ': ' + String(errText).slice(0, 220) : ''}`;
  }

  async function syncUzum() {
    if (_syncBusy) return;
    const token = cleanToken(getToken());
    if (!token) {
      alert('Сначала вставь API-ключ (Настройки → API ключи Uzum)');
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    _syncBusy = true;
    setSyncBusy(true, 'Идёт синхронизация с Uzum OpenAPI…');

    let productCards = await readCache(API_PRODUCTS_KEY, []);
    let orders = await readCache(ORDERS_KEY, []);
    let expenses = await readCache(EXPENSES_KEY, []);
    let fbs = await readCache(FBS_KEY, []);
    let shopId = getSyncMeta().shopId || null;
    const warnings = [];

    try {
      const shopsRaw = await uzumJson('v1/shops');
      const shops = unwrapList(shopsRaw, ['shops', 'organizations']);
      const shop = shops[0] || null;
      shopId = shop?.id || shop?.shopId || shopId;
      const shopName = shop?.name || shop?.title || getSyncMeta().shopName || '';
      if (!shopId) throw new Error('Магазины не найдены по API-ключу');

      // Синк всегда тянет минимум 90 дней, UI-фильтр режет уже на клиенте
      const dateFrom = Date.now() - Math.max(90, Number(_periodDays) || 90) * 86400000;
      const dateTo = Date.now();
      void dateTo;

      // 1) Товары — приоритет (карточки ScaleUp)
      setSyncBusy(true, 'Загрузка товаров OpenAPI…');
      await sleep(400);
      try {
        const rawCards = await fetchPaged(
          (page) =>
            `v1/product/shop/${shopId}?searchQuery=&sortBy=DEFAULT&order=DESC&size=50&page=${page}`,
          (data) => unwrapList(data, ['productList']),
          20,
          900,
          50
        );
        productCards = rawCards.map(slimProductCard);
        await writeCache(API_PRODUCTS_KEY, productCards);
      } catch (e) {
        if (productCards.length) {
          warnings.push(`Товары: ${e?.message || e} (оставлен прошлый кэш ${productCards.length})`);
        } else {
          throw e;
        }
      }

      // 2) Finance orders — shopIds ОБЯЗАТЕЛЕН; dateFrom/dateTo в API часто дают пустой ответ → фильтр на клиенте
      setSyncBusy(true, 'Загрузка заказов (finance)…');
      await sleep(1000);
      try {
        const rawOrders = [];
        const size = 100;
        const maxPages = 30;
        for (let page = 0; page < maxPages; page++) {
          if (page > 0) await sleep(900);
          setSyncBusy(true, `Загрузка заказов… стр. ${page + 1}`);
          const data = await uzumJson(
            `v1/finance/orders?page=${page}&size=${size}&group=false&shopIds=${shopId}`
          );
          const chunk = unwrapList(data, ['orderItems']);
          if (!chunk.length) break;
          let older = 0;
          chunk.forEach((o) => {
            const t = orderDateMs(o);
            if (!dateFrom || t >= dateFrom) rawOrders.push(slimOrder(o));
            else older += 1;
          });
          // лента от новых к старым — выходим, когда вся страница старше периода
          if (older === chunk.length) break;
          const total = Number(data?.totalElements);
          // totalElements у Uzum часто 0/мусор — не стопаем по нему, если ≤0
          if (Number.isFinite(total) && total > 0 && (page + 1) * size >= total) break;
          if (chunk.length < size) break;
        }
        orders = rawOrders;
        await writeCache(ORDERS_KEY, orders);
      } catch (e) {
        warnings.push(`Заказы: ${e?.message || e}`);
      }

      // 3) Expenses — payload.payments; dateCreated = unix ms; totalElements часто 0
      setSyncBusy(true, 'Загрузка расходов…');
      await sleep(1000);
      try {
        const rawExp = [];
        const size = 50;
        const maxPages = 40;
        for (let page = 0; page < maxPages; page++) {
          if (page > 0) await sleep(800);
          setSyncBusy(true, `Загрузка расходов… стр. ${page + 1}`);
          const data = await uzumJson(
            `v1/finance/expenses?page=${page}&size=${size}&shopIds=${shopId}`
          );
          const chunk = Array.isArray(data?.payload?.payments)
            ? data.payload.payments
            : Array.isArray(data?.payments)
              ? data.payments
              : unwrapList(data, ['paymentList', 'payments', 'expenses', 'items']);
          if (!chunk.length) break;
          let older = 0;
          chunk.forEach((e) => {
            const t = expenseDateMs(e);
            if (dateFrom && t > 0 && t < dateFrom) {
              older += 1;
              return;
            }
            rawExp.push(slimExpense(e));
          });
          if (older === chunk.length) break;
          if (chunk.length < size) break;
        }
        expenses = rawExp;
        await writeCache(EXPENSES_KEY, expenses);
      } catch (e) {
        warnings.push(`Расходы: ${e?.message || e}`);
      }

      // 4) FBS — только активные статусы, по 1–2 страницы
      setSyncBusy(true, 'Загрузка FBS…');
      const fbsNew = [];
      const statuses = ['CREATED', 'PACKING', 'DELIVERING'];
      for (const st of statuses) {
        await sleep(900);
        try {
          const chunk = await fetchPaged(
            (page) =>
              `v2/fbs/orders?shopIds=${shopId}&status=${st}&page=${page}&size=50`,
            (data) => {
              const list = unwrapList(data, ['orders', 'payload']);
              return list.map((o) => slimFbs({ ...o, _status: st }));
            },
            2,
            800
          );
          fbsNew.push(...chunk);
        } catch (e) {
          warnings.push(`FBS ${st}: ${e?.message || e}`);
        }
      }
      if (fbsNew.length || !warnings.some((w) => w.startsWith('FBS'))) {
        fbs = fbsNew;
        await writeCache(FBS_KEY, fbs);
      }

      try {
        localStorage.removeItem(ORDERS_KEY);
        localStorage.removeItem(API_PRODUCTS_KEY);
        localStorage.removeItem(EXPENSES_KEY);
        localStorage.removeItem(FBS_KEY);
      } catch (_) { /* ignore */ }

      const flatSkuCount = flattenApiProducts(productCards).length;
      saveSyncMeta({
        lastSyncAt: new Date().toISOString(),
        lastStatus: warnings.length ? 'partial' : 'ok',
        shopId,
        shopName,
        shopsCount: shops.length,
        ordersCount: orders.length,
        productsCount: productCards.length,
        skuCount: flatSkuCount,
        expensesCount: expenses.length,
        fbsCount: fbs.length,
        storage: 'indexeddb',
        api: 'seller-openapi',
        lastError: warnings.join(' | ').slice(0, 500)
      });

      _orders = orders;
      _expenses = expenses;
      _fbsOrders = fbs;
      _hasApiData = productCards.length > 0 || orders.length > 0;

      await loadAllData();
      _syncBusy = false;
      setSyncBusy(false);
      const warnTxt = warnings.length ? `\n\nЧастично:\n${warnings.slice(0, 4).join('\n')}` : '';
      alert(
        `Синхронизация ${warnings.length ? 'частичная' : 'OK'}\n` +
          `Магазин #${shopId}\nТовары (карточки): ${productCards.length}\n` +
          `SKU: ${flatSkuCount}\nЗаказы finance: ${orders.length}\n` +
          `Расходы: ${expenses.length}\nFBS: ${fbs.length}\n` +
          `Хранение: IndexedDB` +
          warnTxt
      );
      renderSettingsPage();
    } catch (err) {
      const status = err?.status;
      const msg = explainUzumHttpError(status, err?.body || err?.message);
      saveSyncMeta({
        lastSyncAt: new Date().toISOString(),
        lastStatus: productCards.length || orders.length ? 'partial' : 'error',
        shopId,
        productsCount: productCards.length,
        ordersCount: orders.length,
        expensesCount: expenses.length,
        fbsCount: fbs.length,
        lastError: String(err?.message || err)
      });
      if (productCards.length || orders.length) {
        _orders = orders;
        _expenses = expenses;
        _fbsOrders = fbs;
        await loadAllData();
      }
      _syncBusy = false;
      setSyncBusy(false);
      alert(msg);
      renderSettingsPage();
    }
  }

  /**
   * Быстрый догон заказов (как Market Plus раз в час): первые страницы finance/orders,
   * merge по id. Не трогает товары/расходы.
   */
  async function syncOrdersFresh(opts = {}) {
    const silent = !!opts.silent;
    const token = cleanToken(getToken());
    if (!token) {
      if (!silent) alert('Сначала вставь API-ключ (Настройки → API ключи Uzum)');
      return { ok: false, reason: 'no-token' };
    }
    if (_syncBusy) return { ok: false, reason: 'busy' };
    let shopId = getSyncMeta().shopId || null;
    _syncBusy = true;
    if (!silent) setSyncBusy(true, 'Обновление заказов за сегодня…');
    try {
      if (!shopId) {
        const shopsRaw = await uzumJson('v1/shops');
        const shops = unwrapList(shopsRaw, ['shops', 'organizations']);
        shopId = shops[0]?.id || shops[0]?.shopId || null;
        if (shopId) saveSyncMeta({ shopId });
      }
      if (!shopId) throw new Error('shopId не найден');

      const existing = Array.isArray(_orders) && _orders.length ? _orders.slice() : await readCache(ORDERS_KEY, []);
      const byId = new Map();
      existing.forEach((o) => {
        const id = o?.id != null ? String(o.id) : o?.orderId != null ? `oid:${o.orderId}:${o.skuTitle || ''}` : '';
        if (id) byId.set(id, o);
      });

      const dayStart = startOfDayMs();
      const size = 100;
      const maxPages = 8;
      let added = 0;
      let seenToday = 0;

      for (let page = 0; page < maxPages; page++) {
        if (page > 0) await sleep(500);
        if (!silent) setSyncBusy(true, `Заказы сегодня… стр. ${page + 1}`);
        const data = await uzumJson(
          `v1/finance/orders?page=${page}&size=${size}&group=false&shopIds=${shopId}`
        );
        const chunk = unwrapList(data, ['orderItems']);
        if (!chunk.length) break;
        let older = 0;
        chunk.forEach((o) => {
          const t = orderDateMs(o);
          if (t >= dayStart) seenToday += Number(o.amount || 0) || 0;
          if (t > 0 && t < dayStart - 2 * 86400000) older += 1; // старше «сегодня−2д» — можно стопать
          const slim = slimOrder(o);
          const id =
            slim?.id != null
              ? String(slim.id)
              : slim?.orderId != null
                ? `oid:${slim.orderId}:${slim.skuTitle || ''}`
                : '';
          if (!id) return;
          if (!byId.has(id)) added += 1;
          byId.set(id, slim);
        });
        if (older === chunk.length) break;
        if (chunk.length < size) break;
      }

      const merged = Array.from(byId.values()).sort((a, b) => orderDateMs(b) - orderDateMs(a));
      await writeCache(ORDERS_KEY, merged);
      _orders = merged;
      _hasApiData = _hasApiData || merged.length > 0;
      saveSyncMeta({
        lastOrdersAt: new Date().toISOString(),
        lastSyncAt: getSyncMeta().lastSyncAt || new Date().toISOString(),
        lastStatus: 'ok',
        shopId,
        ordersCount: merged.length,
        todayQtyHint: seenToday
      });
      updateDataSourceBadge();
      render();
      if (!silent) {
        const todayQty = metricsFor(ordersInRange(dayStart, endOfDayMs())).qty;
        setSyncBusy(false);
        const btn = document.getElementById('sc-refresh-btn');
        if (btn) {
          const prev = btn.textContent;
          btn.textContent = `✓ Сегодня: ${todayQty} шт`;
          setTimeout(() => {
            btn.textContent = prev || '🔄 Обновить заказы';
          }, 2500);
        }
      }
      _syncBusy = false;
      if (!silent) setSyncBusy(false);
      return { ok: true, orders: merged.length, added, todayQty: seenToday };
    } catch (e) {
      _syncBusy = false;
      if (!silent) {
        setSyncBusy(false);
        alert(`Не удалось обновить заказы: ${e?.message || e}`);
      }
      console.warn('syncOrdersFresh', e);
      return { ok: false, reason: String(e?.message || e) };
    }
  }

  function ensureAutoOrdersRefresh() {
    if (_autoOrdersTimer) return;
    _autoOrdersTimer = setInterval(() => {
      if (document.hidden) return;
      if (!cleanToken(getToken())) return;
      void syncOrdersFresh({ silent: true });
    }, AUTO_ORDERS_MS);
    // первый догон через пару секунд после открытия (не блокирует UI)
    setTimeout(() => {
      if (!cleanToken(getToken())) return;
      const last = Date.parse(getSyncMeta().lastOrdersAt || getSyncMeta().lastSyncAt || 0) || 0;
      if (Date.now() - last > 5 * 60 * 1000) void syncOrdersFresh({ silent: true });
    }, 2500);
  }

  function saveToken() {
    const inp = document.getElementById('sc-token-inp');
    let raw = String(inp?.value || '').trim();
    if (!raw || raw.startsWith('••••')) {
      if (!getToken()) {
        alert('Вставь API-ключ из seller.uzum.uz → API ключи');
        return;
      }
      void syncUzum();
      return;
    }
    raw = cleanToken(raw);
    if (raw.length < 16) {
      alert('Ключ слишком короткий');
      return;
    }
    localStorage.setItem(TOKEN_KEY, raw);
    void syncUzum();
  }

  function clearToken() {
    if (!confirm('Удалить API-ключ Uzum и кэш OpenAPI?')) return;
    localStorage.removeItem(TOKEN_KEY);
    try {
      localStorage.removeItem(ORDERS_KEY);
      localStorage.removeItem(API_PRODUCTS_KEY);
      localStorage.removeItem(EXPENSES_KEY);
      localStorage.removeItem(FBS_KEY);
      localStorage.removeItem(`${ORDERS_KEY}__meta`);
      localStorage.removeItem(`${API_PRODUCTS_KEY}__meta`);
    } catch (_) { /* ignore */ }
    void idbDel(ORDERS_KEY);
    void idbDel(API_PRODUCTS_KEY);
    void idbDel(EXPENSES_KEY);
    void idbDel(FBS_KEY);
    _orders = [];
    _expenses = [];
    _fbsOrders = [];
    _products = [];
    _hasApiData = false;
    renderSettingsPage();
  }

  function toggleToken() {
    const inp = document.getElementById('sc-token-inp');
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
  }

  /* ========== Metrics ========== */
  function ordersInRange(fromMs, toMs) {
    return _orders.filter((o) => {
      const t = orderDateMs(o);
      return t >= fromMs && t <= toMs;
    });
  }

  function metricsFor(list) {
    let qty = 0;
    let returns = 0;
    let canceled = 0;
    let revenue = 0;
    let commission = 0;
    let logistics = 0;
    let sellerProfit = 0;
    let withdraw = 0;
    let cogs = 0;
    list.forEach((o) => {
      const amt = Number(o.amount || 0) || 0;
      const ret = Number(o.amountReturns || 0) || 0;
      const can = Number(o.cancelled || 0) || 0;
      const price = orderSellPrice(o);
      qty += amt;
      returns += ret;
      canceled += can;
      revenue += price * Math.max(amt - ret, 0);
      commission += Number(o.commission || 0) || 0;
      logistics += Number(o.logisticDeliveryFee || 0) || 0;
      sellerProfit += Number(o.sellerProfit || o.withdrawnProfit || 0) || 0;
      if (String(o.status) === 'TO_WITHDRAW') {
        withdraw += Number(o.withdrawnProfit || o.sellerProfit || price * amt) || 0;
      }
      const sku = String(o.skuTitle || o.sku || '').trim();
      const unitCost = lookupYoCost(sku, o.skuTitle, o.productId) || Number(o.purchasePrice || 0) || 0;
      cogs += unitCost * Math.max(amt - ret, 0);
    });
    const sold = Math.max(qty - returns, 0);
    const buyoutDenom = qty + canceled;
    const buyout = buyoutDenom > 0 ? (sold / buyoutDenom) * 100 : 0;
    const gross = sellerProfit || revenue - commission - logistics - cogs;
    const speed = sold / Math.max(periodDaysCount(), 1);
    return { qty, sold, returns, canceled, revenue, commission, logistics, sellerProfit, withdraw, cogs, buyout, gross, speed };
  }

  function currentMetrics() {
    const r = getPeriodRange();
    return metricsFor(ordersInRange(r.from, r.to));
  }

  function prevMetrics() {
    const r = getPeriodRange();
    const len = Math.max(r.to - r.from, 86400000);
    return metricsFor(ordersInRange(r.from - len, r.from - 1));
  }

  function expenseDateMs(e) {
    const raw = e?.dateCreated ?? e?.dateService ?? e?.dateUpdated ?? e?.date;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
    if (raw == null || raw === '') return 0;
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 1e11) return asNum; // unix ms
    if (Number.isFinite(asNum) && asNum > 1e9 && asNum < 1e11) return asNum * 1000; // unix sec
    const parsed = Date.parse(String(raw));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function expensesInPeriod() {
    const r = getPeriodRange();
    return _expenses.filter((e) => {
      const t = expenseDateMs(e);
      return t >= r.from && t <= r.to;
    });
  }

  function expenseTotal(list) {
    return list.reduce((s, e) => {
      const sign = String(e.type) === 'INCOME' ? -1 : 1;
      return s + sign * (Number(e.paymentPrice || e.amount || 0) || 0);
    }, 0);
  }

  function dailySeries(mode) {
    const map = {};
    const r = getPeriodRange();
    _orders.forEach((o) => {
      const t = orderDateMs(o);
      if (t < r.from || t > r.to) return;
      const day = new Date(t).toISOString().slice(0, 10);
      if (!map[day]) map[day] = { orders: 0, buyouts: 0, returns: 0, revenue: 0 };
      const amt = Number(o.amount || 0) || 0;
      const ret = Number(o.amountReturns || 0) || 0;
      map[day].orders += amt;
      map[day].buyouts += Math.max(amt - ret, 0);
      map[day].returns += ret;
      map[day].revenue += orderSellPrice(o) * Math.max(amt - ret, 0);
    });
    return Object.keys(map)
      .sort()
      .map((d) => ({
        label: d.slice(5),
        value: mode === 'returns' ? map[d].returns : mode === 'buyouts' ? map[d].buyouts : mode === 'revenue' ? map[d].revenue : map[d].orders
      }));
  }

  function activityHeatmap() {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    const r = getPeriodRange();
    _orders.forEach((o) => {
      const t = orderDateMs(o);
      if (t < r.from || t > r.to) return;
      const dt = new Date(t);
      const dow = (dt.getDay() + 6) % 7;
      grid[dow][dt.getHours()] += Number(o.amount || 1) || 1;
    });
    return grid;
  }

  function expenseAmount(e) {
    return Number(e.paymentPrice ?? e.amount ?? 0) || 0;
  }

  function expenseIsReturn(e) {
    const type = String(e.type || '').toUpperCase();
    const status = String(e.status || '').toUpperCase();
    return type === 'INCOME' || status === 'REFUNDED';
  }

  function expenseSourceKey(e) {
    const raw = `${e.source || ''} ${e.code || ''} ${e.name || ''} ${e.title || ''}`.toUpperCase();
    if (/FINE|PENALTY|ШТРАФ|JARIMA/.test(raw)) return 'FINE';
    if (/BOOST|БУСТ|TOP\b|В ТОП/.test(raw)) return 'BOOST';
    if (/ADVERT|ADS|REKLAM|РЕКЛАМ|MARKETING|MARKETING/.test(raw)) return 'ADVERTISING';
    if (/RETURN.*STOR|ХРАНЕН.*ВОЗВРАТ|ВОЗВРАТ.*ХРАН/.test(raw)) return 'RETURN_STORAGE';
    if (/LOGIST|ДОСТАВ|ЛОГИСТ|DELIVERY|LOGISTIKA/.test(raw)) return 'LOGISTICS';
    if (/OMBOR|STOR|ХРАНЕН|WAREHOUSE|СКЛАД/.test(raw)) return 'STORAGE';
    if (/PREP|ПОДГОТОВ|PACKAG/.test(raw)) return 'PREPARATION';
    if (/КОМИСС|SELLER|MARKETPLACE|МП\b/.test(raw)) return 'MARKETPLACE';
    const s = String(e.source || '').trim();
    if (/^logistika$/i.test(s)) return 'LOGISTICS';
    if (/^marketing$/i.test(s)) return 'ADVERTISING';
    if (/^ombor$/i.test(s)) return 'STORAGE';
    return String(e.source || '').trim().toUpperCase() || 'OTHER';
  }

  const EXP_LABELS = {
    all: 'Все расходы',
    MARKETPLACE: 'Расходы на маркетплейсе',
    LOGISTICS: 'Логистика',
    STORAGE: 'Хранение',
    ADVERTISING: 'Реклама',
    BOOST: 'Буст заказов',
    RETURN_STORAGE: 'Хранение возвратов',
    FINE: 'Штрафы',
    PREPARATION: 'Подготовка товара',
    OTHER: 'Прочее'
  };

  function expenseSourceLabel(key) {
    return EXP_LABELS[key] || key || 'Прочее';
  }

  function groupExpensesBySource(list) {
    const map = {};
    (list || []).forEach((e) => {
      if (expenseIsReturn(e)) return;
      const key = expenseSourceKey(e);
      if (!map[key]) map[key] = { key, label: expenseSourceLabel(key), sum: 0, count: 0 };
      map[key].sum += Math.abs(expenseAmount(e));
      map[key].count += 1;
    });
    return Object.values(map).sort((a, b) => b.sum - a.sum);
  }

  function donutSvg(segments, total) {
    const size = 180;
    const r = 68;
    const cx = 90;
    const cy = 90;
    const stroke = 28;
    const C = 2 * Math.PI * r;
    let offset = 0;
    const colors = ['#3b66f5', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#64748b', '#ec4899'];
    if (!total) {
      return `<svg class="sc-donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="${stroke}"></circle>
      </svg>`;
    }
    const arcs = segments
      .map((s, i) => {
        const len = (s.sum / total) * C;
        const dash = `${len} ${C - len}`;
        const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colors[i % colors.length]}"
          stroke-width="${stroke}" stroke-dasharray="${dash}" stroke-dashoffset="${-offset}"
          transform="rotate(-90 ${cx} ${cy})"></circle>`;
        offset += len;
        return el;
      })
      .join('');
    return `<svg class="sc-donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#eef2ff" stroke-width="${stroke}"></circle>
      ${arcs}
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="11" fill="#64748b">Итого</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="12" font-weight="700">${esc(moneyShort(total))}</text>
    </svg>`;
  }

  function financeTabsHtml(active) {
    const tabs = [
      ['overview', 'Обзор'],
      ['expenses', 'Расходы'],
      ['pnl', 'ОПиУ'],
      ['payout', 'Календарь выплат']
    ];
    return `<div class="sc-subtabs">${tabs
      .map(
        ([id, label]) =>
          `<button type="button" class="sc-subtab${active === id ? ' active' : ''}" data-sc-finsub="${id}">${label}</button>`
      )
      .join('')}</div>`;
  }

  function insightCards() {
    const m = currentMetrics();
    const prev = prevMetrics();
    const cards = [];
    const r90 = metricsFor(ordersInRange(Date.now() - 90 * 86400000, Date.now()));

    if (m.buyout > 0 && m.buyout < 85) {
      cards.push({
        key: 'buyout-low',
        type: 'danger',
        title: 'Выкуп ниже нормы',
        val: pct(m.buyout),
        detail: r90.buyout
          ? `обычно ${pct(r90.buyout)} за последние 90 дней`
          : 'ниже комфортного уровня 85%+',
        actions: [
          { label: 'Посмотреть динамику →', view: 'dashboard' },
          { label: 'Открыть Финансы →', view: 'finance' }
        ]
      });
    }

    const created = _fbsOrders.filter((o) => String(o._status || o.status) === 'CREATED').length;
    const packing = _fbsOrders.filter((o) => String(o._status || o.status) === 'PACKING').length;
    if (created + packing > 0) {
      cards.push({
        key: 'fbs-overdue',
        type: 'danger',
        title: 'Просроченные / ожидают сборки FBS',
        val: `${created + packing} поставок`,
        detail: `FBS к сборке: ${created} · в упаковке: ${packing}`,
        actions: [{ label: 'Открыть Отгрузки →', view: 'shipments' }]
      });
    }

    const fines = expensesInPeriod().filter((e) => expenseSourceKey(e) === 'FINE');
    const fineSum = fines.reduce((s, e) => s + Math.abs(expenseAmount(e)), 0);
    if (fines.length) {
      cards.push({
        key: 'fines',
        type: 'danger',
        title: 'Штрафы от Uzum',
        val: `${fines.length} штрафов`,
        detail: `на сумму ${money(fineSum)} за выбранный период`,
        actions: [{ label: 'Открыть Финансы →', view: 'finance-expenses' }]
      });
    }

    if (prev.revenue > 0 && m.revenue < prev.revenue * 0.7) {
      const drop = ((m.revenue - prev.revenue) / Math.abs(prev.revenue)) * 100;
      const sales = salesBySku();
      const topDrop = Object.keys(sales)
        .map((sku) => ({ sku, ...sales[sku] }))
        .sort((a, b) => a.revenue - b.revenue)
        .slice(0, 3);
      cards.push({
        key: 'sales-drop',
        type: 'danger',
        title: 'Падение продаж',
        val: pct(drop),
        detail:
          `к прошлому такому же периоду · потеря ~${money(Math.max(prev.revenue - m.revenue, 0))}` +
          (topDrop.length
            ? `<br>${topDrop.map((x) => `${esc(x.sku)}: ${money(x.revenue)}`).join(' · ')}`
            : ''),
        actions: [
          { label: 'Посмотреть динамику →', view: 'dashboard' },
          { label: 'Ассортимент →', view: 'products' }
        ]
      });
    }

    const noStock = _products.filter((p) => productStock(p) <= 0 && !p.archived).length;
    if (noStock > 0) {
      cards.push({
        key: 'oos',
        type: 'warn',
        title: 'Закончились товары',
        val: `${noStock} SKU`,
        detail: 'без остатка на складе — риск потери продаж',
        actions: [{ label: 'Открыть Ассортимент →', view: 'products' }]
      });
    }

    const lowRate = _products.filter((p) => {
      const r = Number(String(p.rating || '').replace(',', '.'));
      return Number.isFinite(r) && r > 0 && r < 4.5;
    }).length;
    if (lowRate > 0) {
      cards.push({
        key: 'rating',
        type: 'warn',
        title: 'Низкий рейтинг',
        val: `${lowRate} товаров`,
        detail: 'рейтинг ниже 4.5 — проверь отзывы и качество',
        actions: [{ label: 'Товары →', view: 'products' }]
      });
    }

    if (!_orders.length) {
      cards.push({
        key: 'nosync',
        type: 'info',
        title: 'Нет данных OpenAPI',
        val: 'Синхронизируй API-ключ',
        detail: 'Настройки → Сохранить и синхронизировать',
        actions: [{ label: 'Настройки →', view: '__settings' }]
      });
    }

    return cards.filter((c) => !_dismissed.has(c.key));
  }

  function insightHtml(c) {
    const btns = (c.actions || [])
      .map((a) => `<button type="button" class="sc-insight-action" data-sc-goview="${esc(a.view)}">${esc(a.label)}</button>`)
      .join('');
    return `<div class="sc-insight ${c.type}">
      <div class="sc-insight-body">
        <div class="sc-insight-title">⚠ ${esc(c.title)}</div>
        <div class="sc-insight-val">${c.val}</div>
        ${c.detail ? `<div class="sc-insight-detail">${c.detail}</div>` : ''}
        <div class="sc-insight-btns">
          ${btns}
          <button type="button" class="sc-insight-dismiss" data-sc-dismiss="${esc(c.key)}">Отложить</button>
          <button type="button" class="sc-insight-dismiss" data-sc-dismiss="${esc(c.key)}">Решено</button>
        </div>
      </div>
    </div>`;
  }

  function drawSimpleChart(canvasId, series) {
    const el = document.getElementById(canvasId);
    if (!el) return;
    const vals = (series || []).map((s) => Number(s.value) || 0);
    const labels = (series || []).map((s) => s.label);
    if (!vals.length) {
      el.innerHTML = '<div class="sc-empty-sub">Нет данных за период</div>';
      return;
    }
    const max = Math.max(...vals, 1);
    const w = Math.max(el.clientWidth || 600, 320);
    const h = 220;
    const pad = 28;
    const step = (w - pad * 2) / Math.max(vals.length - 1, 1);
    const points = vals
      .map((v, i) => {
        const x = pad + i * step;
        const y = h - pad - (v / max) * (h - pad * 2);
        return `${x},${y}`;
      })
      .join(' ');
    const area = `${pad},${h - pad} ${points} ${pad + (vals.length - 1) * step},${h - pad}`;
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
      <polyline fill="rgba(59,102,245,0.12)" stroke="none" points="${area}"></polyline>
      <polyline fill="none" stroke="#3b66f5" stroke-width="2.5" points="${points}"></polyline>
    </svg>
    <div class="sc-chart-labels">${labels
      .filter((_, i) => i % Math.ceil(labels.length / 6) === 0)
      .map((l) => `<span>${esc(l)}</span>`)
      .join('')}</div>`;
  }

  function renderHeatmap(grid) {
    const days = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    let max = 1;
    grid.forEach((row) => row.forEach((v) => {
      if (v > max) max = v;
    }));
    const hours = [0, 3, 6, 9, 12, 15, 18, 21];
    let html = '<div class="sc-heat"><div class="sc-heat-corner"></div>';
    hours.forEach((h) => {
      html += `<div class="sc-heat-h">${h}:00</div>`;
    });
    grid.forEach((row, di) => {
      html += `<div class="sc-heat-d">${days[di]}</div>`;
      hours.forEach((h) => {
        const slice = row.slice(h, h + 3);
        const v = slice.reduce((a, b) => a + b, 0);
        const op = 0.12 + (v / max) * 0.88;
        html += `<div class="sc-heat-cell" style="background:rgba(59,102,245,${op.toFixed(2)})" title="${days[di]} ${h}:00 — ${v}"></div>`;
      });
    });
    html += '</div>';
    return html;
  }

  /* ========== Views ========== */
  function viewDashboard() {
    const cur = currentMetrics();
    const prev = prevMetrics();
    const expSum = expenseTotal(expensesInPeriod());
    const withdraw = cur.withdraw || Math.max(cur.sellerProfit - expSum, 0);
    const insights = insightCards();
    const pr = getPeriodRange();

    return `${periodToolbarHtml()}
    <div class="sc-dash-grid">
      <div>
        <div class="sc-kpi-row cols-3">
          ${kpiCard('Заказы', `${cur.qty} шт`, `${moneyShort(cur.revenue)} сум · ${deltaHtml(cur.qty, prev.qty)}`, 'blue')}
          ${kpiCard('Скорость продаж', `${cur.speed.toFixed(1)} шт/день`, deltaHtml(cur.speed, prev.speed), 'orange')}
          ${kpiCard('Выкуп', pct(cur.buyout), deltaHtml(cur.buyout, prev.buyout, 'pp'), cur.buyout >= 70 ? 'green' : 'red')}
        </div>
        <div class="sc-kpi-row cols-3">
          ${kpiCard('Валовая прибыль', money(cur.gross), deltaHtml(cur.gross, prev.gross), 'green')}
          ${kpiCard(`Выручка · ${esc(pr.label)}`, money(cur.revenue), deltaHtml(cur.revenue, prev.revenue), 'blue')}
          ${kpiCard('Можно вывести', money(withdraw), 'по статусу TO_WITHDRAW / прибыль', 'green')}
        </div>
        <div class="sc-card">
          <div class="sc-card-title" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
            <span>Динамика</span>
            <div class="sc-subtabs" style="margin:0">
              <button type="button" class="sc-subtab${_dynMode === 'orders' ? ' active' : ''}" data-sc-dyn="orders">Заказы</button>
              <button type="button" class="sc-subtab${_dynMode === 'buyouts' ? ' active' : ''}" data-sc-dyn="buyouts">Выкупы</button>
              <button type="button" class="sc-subtab${_dynMode === 'returns' ? ' active' : ''}" data-sc-dyn="returns">Возвраты</button>
              <button type="button" class="sc-subtab${_dynMode === 'revenue' ? ' active' : ''}" data-sc-dyn="revenue">Выручка</button>
            </div>
          </div>
          <div id="sc-dash-chart"></div>
        </div>
        <div class="sc-card">
          <div class="sc-card-title">Карта активности: Заказы</div>
          ${renderHeatmap(activityHeatmap())}
        </div>
      </div>
      <div class="sc-card sc-insights-panel">
        <div class="sc-card-title">Что важно сейчас
          <span class="sc-pill sc-pill-bad" style="margin-left:auto">${insights.length} проблем</span>
        </div>
        <div class="sc-insights-sub">Проблемы, которые нужно решить, чтобы продажи росли</div>
        ${insights.length ? insights.map(insightHtml).join('') : '<div class="sc-empty-sub">Пока спокойно — критичных сигналов нет</div>'}
      </div>
    </div>`;
  }

  function viewFinanceOverview() {
    const cur = currentMetrics();
    const prev = prevMetrics();
    const exp = expenseTotal(expensesInPeriod());
    const net = cur.gross - exp;
    return `${periodToolbarHtml()}${financeTabsHtml('overview')}
      <div class="sc-kpi-row cols-4">
        ${kpiCard('Заказы', String(cur.qty), deltaHtml(cur.qty, prev.qty), 'blue')}
        ${kpiCard('Продажи (выручка)', money(cur.revenue), deltaHtml(cur.revenue, prev.revenue), 'blue')}
        ${kpiCard('Валовая прибыль', money(cur.gross), deltaHtml(cur.gross, prev.gross), 'green')}
        ${kpiCard('Расходы МП', money(exp), 'finance/expenses', 'orange')}
      </div>
      <div class="sc-kpi-row cols-3">
        ${kpiCard('Чистая прибыль', money(net), 'валовая − расходы', net >= 0 ? 'green' : 'red')}
        ${kpiCard('Можно вывести', money(cur.withdraw || cur.sellerProfit), '', 'green')}
        ${kpiCard('Возвраты', `${cur.returns} шт`, money(cur.returns), 'red')}
      </div>
      <div class="sc-card">
        <div class="sc-card-title">Динамика выручки</div>
        <div id="sc-fin-chart"></div>
      </div>`;
  }

  function viewExpenses() {
    const list = expensesInPeriod();
    const outcomes = list.filter((e) => !expenseIsReturn(e));
    const returns = list.filter((e) => expenseIsReturn(e));
    const groups = groupExpensesBySource(outcomes);
    const totalOut = groups.reduce((s, g) => s + g.sum, 0);
    const totalRet = returns.reduce((s, e) => s + Math.abs(expenseAmount(e)), 0);
    const filtered =
      _expFilter === 'all' ? outcomes : outcomes.filter((e) => expenseSourceKey(e) === _expFilter);
    const filteredSum = filtered.reduce((s, e) => s + Math.abs(expenseAmount(e)), 0);

    const tabs = [
      { key: 'all', sum: totalOut },
      ...groups.map((g) => ({ key: g.key, sum: g.sum }))
    ];

    const fmtDate = (e) => {
      const t = expenseDateMs(e);
      if (!t) return '—';
      return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
    };

    return `${periodToolbarHtml()}${financeTabsHtml('expenses')}
      <div class="sc-exp-layout">
        <div class="sc-card">
          <div class="sc-card-title">Структура расходов</div>
          <div class="sc-exp-structure">
            ${donutSvg(groups, totalOut)}
            <div class="sc-exp-legend">
              ${groups
                .map((g) => {
                  const share = totalOut ? ((g.sum / totalOut) * 100).toFixed(0) : 0;
                  return `<div class="sc-exp-legend-row">
                    <span class="sc-exp-legend-name">${esc(g.label)}</span>
                    <span class="sc-exp-legend-pct">${share}%</span>
                    <span class="sc-exp-legend-sum">${money(g.sum)}</span>
                  </div>`;
                })
                .join('') || '<div class="sc-empty-sub">Нет расходов за период — синхронизируй expenses</div>'}
              <div class="sc-exp-legend-total">Итого: <strong>${money(totalOut)}</strong></div>
            </div>
          </div>
        </div>
        <div class="sc-card">
          <div class="sc-card-title" style="justify-content:space-between">
            <span>Все расходы</span>
            <span class="sc-pill sc-pill-ok">Итого по фильтру: ${money(filteredSum)}</span>
          </div>
          <div class="sc-exp-tabs">
            ${tabs
              .map(
                (t) =>
                  `<button type="button" class="sc-exp-tab${_expFilter === t.key ? ' active' : ''}" data-sc-expfilter="${esc(t.key)}">
                    <span>${esc(expenseSourceLabel(t.key))}</span>
                    <b>${moneyShort(t.sum)}</b>
                  </button>`
              )
              .join('')}
          </div>
          <div class="sc-table-wrap"><table class="sc-table">
            <thead><tr><th>Дата</th><th>ID</th><th>Название</th><th>Источник</th><th>Сумма</th></tr></thead>
            <tbody>
              ${filtered
                .slice()
                .sort((a, b) => expenseDateMs(b) - expenseDateMs(a))
                .slice(0, 300)
                .map(
                  (e) => `<tr>
                    <td>${esc(fmtDate(e))}</td>
                    <td>${esc(e.id || e.externalId || '—')}</td>
                    <td>${esc(e.name || e.title || '—')}</td>
                    <td>${esc(expenseSourceLabel(expenseSourceKey(e)))}</td>
                    <td>${money(Math.abs(expenseAmount(e)))}</td>
                  </tr>`
                )
                .join('') || '<tr><td colspan="5">Нет расходов по фильтру</td></tr>'}
            </tbody>
          </table></div>
        </div>
      </div>
      <div class="sc-card" style="margin-top:16px">
        <div class="sc-card-title" style="justify-content:space-between">
          <span>Возвраты</span>
          <span class="sc-pill sc-pill-ok">Итого по возвратам: ${money(totalRet)}</span>
        </div>
        <p class="sc-muted-note">Операционные возвраты за период (type=INCOME / status=REFUNDED): логистика, хранение и др.</p>
        <div class="sc-table-wrap"><table class="sc-table">
          <thead><tr><th>Дата</th><th>ID</th><th>Категория</th><th>Название</th><th>Сумма</th></tr></thead>
          <tbody>
            ${returns
              .slice()
              .sort((a, b) => expenseDateMs(b) - expenseDateMs(a))
              .slice(0, 200)
              .map(
                (e) => `<tr>
                  <td>${esc(fmtDate(e))}</td>
                  <td>${esc(e.id || e.externalId || '—')}</td>
                  <td>${esc(expenseSourceLabel(expenseSourceKey(e)))}</td>
                  <td>${esc(e.name || e.title || '—')}</td>
                  <td class="sc-pnl-up">+${money(Math.abs(expenseAmount(e)))}</td>
                </tr>`
              )
              .join('') || '<tr><td colspan="5">Нет возвратов за период</td></tr>'}
          </tbody>
        </table></div>
      </div>`;
  }

  function viewPnl() {
    const cur = currentMetrics();
    const prev = prevMetrics();
    const exp = expenseTotal(expensesInPeriod());
    const prevExp = 0;
    const row = (name, a, b, opts) => {
      const d = b - a;
      const dp = a ? (d / Math.abs(a)) * 100 : null;
      return `<div class="sc-pnl-row${opts?.tot ? ' tot' : opts?.sub ? ' sub' : opts?.sep ? ' sep' : ''}">
        <span>${esc(name)}</span>
        <span>${money(a)}</span>
        <span>${money(b)}</span>
        <span class="${d >= 0 ? 'sc-pnl-up' : 'sc-pnl-dn'}">${d >= 0 ? '+' : ''}${money(d)}</span>
        <span class="${d >= 0 ? 'sc-pnl-up' : 'sc-pnl-dn'}">${dp != null ? pct(dp) : '—'}</span>
      </div>`;
    };
    return `${periodToolbarHtml()}${financeTabsHtml('pnl')}
      <div class="sc-pnl">
        <div class="sc-pnl-row hdr"><span>Показатель</span><span>Пред. период</span><span>Тек. период</span><span>Изм.</span><span>%</span></div>
        ${row('Выручка', prev.revenue, cur.revenue)}
        ${row('Себестоимость (YO)', prev.cogs, cur.cogs, { sub: true })}
        ${row('Комиссия Uzum', prev.commission, cur.commission, { sub: true })}
        ${row('Логистика', prev.logistics, cur.logistics, { sub: true })}
        ${row('Валовая прибыль', prev.gross, cur.gross, { tot: true })}
        ${row('Прочие расходы МП', prevExp, exp)}
        ${row('Чистая прибыль', prev.gross - prevExp, cur.gross - exp, { tot: true })}
        <div class="sc-pnl-row sep"><span>Рентабельность нетто, %</span>
          <span>${prev.revenue ? pct(((prev.gross - prevExp) / prev.revenue) * 100) : '—'}</span>
          <span>${cur.revenue ? pct(((cur.gross - exp) / cur.revenue) * 100) : '—'}</span>
          <span></span><span></span>
        </div>
      </div>`;
  }

  function viewPayout() {
    const cur = currentMetrics();
    const exp = expenseTotal(expensesInPeriod());
    const toWithdraw = _orders
      .filter((o) => String(o.status) === 'TO_WITHDRAW')
      .reduce((s, o) => s + (Number(o.withdrawnProfit || o.sellerProfit || 0) || 0), 0);
    return `${periodToolbarHtml()}${financeTabsHtml('payout')}
      <div class="sc-kpi-row cols-3">
        ${kpiCard('Доступно сейчас', money(toWithdraw || cur.withdraw), 'статус TO_WITHDRAW', 'green')}
        ${kpiCard('Расходы МП за период', money(exp), '', 'orange')}
        ${kpiCard('Прибыль продавца (API)', money(cur.sellerProfit), '', 'blue')}
      </div>
      <div class="sc-card">
        <div class="sc-card-title">Позиции к выводу</div>
        <div class="sc-table-wrap"><table class="sc-table">
          <thead><tr><th>Дата</th><th>SKU</th><th>Кол-во</th><th>К выводу</th><th>Статус</th></tr></thead>
          <tbody>
            ${_orders
              .filter((o) => String(o.status) === 'TO_WITHDRAW')
              .slice(0, 80)
              .map((o) => {
                const t = orderDateMs(o);
                return `<tr>
                  <td>${t ? new Date(t).toLocaleDateString('ru-RU') : '—'}</td>
                  <td>${esc(o.skuTitle || '—')}</td>
                  <td>${Number(o.amount || 0)}</td>
                  <td>${money(o.withdrawnProfit || o.sellerProfit || 0)}</td>
                  <td>${pill('ok', o.status)}</td>
                </tr>`;
              })
              .join('') || '<tr><td colspan="5">Нет позиций TO_WITHDRAW</td></tr>'}
          </tbody>
        </table></div>
      </div>`;
  }

  function viewFinance() {
    if (_finSub === 'pnl') return viewPnl();
    if (_finSub === 'payout') return viewPayout();
    if (_finSub === 'expenses') return viewExpenses();
    return viewFinanceOverview();
  }

  function salesBySku() {
    const map = {};
    const r = getPeriodRange();
    _orders.forEach((o) => {
      const t = orderDateMs(o);
      if (t < r.from || t > r.to) return;
      const sku = String(o.skuTitle || '').trim();
      if (!sku) return;
      if (!map[sku]) map[sku] = { qty: 0, revenue: 0, profit: 0, returns: 0 };
      const amt = Number(o.amount || 0) || 0;
      const ret = Number(o.amountReturns || 0) || 0;
      map[sku].qty += Math.max(amt - ret, 0);
      map[sku].returns += ret;
      map[sku].revenue += orderSellPrice(o) * Math.max(amt - ret, 0);
      map[sku].profit += Number(o.sellerProfit || 0) || 0;
    });
    return map;
  }

  function assortTabsHtml(active) {
    const tabs = [
      ['products', 'Товары'],
      ['abcxyz', 'ABC/XYZ'],
      ['profit-share', 'Доли прибыли'],
      ['unit-economics', 'Юнит-экономика'],
      ['cost', 'Себестоимость'],
      ['new-calc', 'Калькулятор']
    ];
    return `<div class="sc-assort-tabs">${tabs
      .map(
        ([id, label]) =>
          `<button type="button" class="sc-subtab${active === id ? ' active' : ''}" data-sc-assort="${id}">${label}</button>`
      )
      .join('')}</div>`;
  }

  function copyFieldHtml(label, value) {
    const v = value == null || value === '' ? '—' : String(value);
    return `<div class="sc-id-row">
      <span class="sc-id-label">${esc(label)}</span>
      <span class="sc-id-val">${esc(v)}</span>
      ${v !== '—' ? `<button type="button" class="sc-copy-btn" data-sc-copy="${esc(v)}" title="Копировать">⧉</button>` : ''}
    </div>`;
  }

  function productDetailHtml(p, sales) {
    if (!p) {
      return `<div class="sc-prod-panel-empty">Выбери карточку слева — здесь будет деталь как в ScaleUp</div>`;
    }
    const sku = productSku(p);
    const s = sales[sku] || { qty: 0, revenue: 0, profit: 0 };
    const stock = productStock(p);
    const cost = productCost(p);
    const price = Number(p.sellPrice || p.price || 0) || 0;
    const onSaleBadge = productSaleBadge(p);
    const img = p.image
      ? `<img class="sc-prod-hero-img" src="${esc(p.image)}" alt="" loading="lazy" />`
      : `<div class="sc-prod-hero-img sc-prod-hero-ph">нет фото</div>`;
    const uzumUrl = p.productId ? `https://uzum.uz/ru/product/${p.productId}` : '';
    return `
      <div class="sc-prod-detail">
        <button type="button" class="sc-prod-panel-close" data-sc-close-panel aria-label="Закрыть">×</button>
        ${img}
        <h3 class="sc-prod-detail-title">${esc(p.name || p.title || sku)}</h3>
        <div class="sc-prod-detail-badges">
          ${pill(onSaleBadge.cls, onSaleBadge.txt)}
          ${p.source === 'openapi' ? pill('ok', 'OpenAPI') : pill('warn', 'нет OpenAPI')}
        </div>
        <div class="sc-prod-metrics">
          <div><div class="sc-m-label">Цена</div><div class="sc-m-val">${money(price)}</div></div>
          <div><div class="sc-m-label">Остаток</div><div class="sc-m-val ${stock > 0 ? 'ok' : 'bad'}">${stock} шт</div></div>
          <div><div class="sc-m-label">Рейтинг</div><div class="sc-m-val">${p.rating != null ? Number(p.rating).toFixed(1) : '—'}</div></div>
          <div><div class="sc-m-label">Отзывы</div><div class="sc-m-val">${p.reviews || 0}</div></div>
        </div>
        <button type="button" class="btn-secondary sc-prod-cost-btn" data-sc-open-cost>Редактировать себестоимость</button>
        <div class="sc-prod-section">
          <div class="sc-prod-section-title">Воронка товара</div>
          <div class="sc-muted-note">Продажи за период: ${s.qty} шт · ${money(s.revenue)}
            ${s.qty ? '' : '<br>Нет данных воронки по этому SKU за выбранный период'}</div>
        </div>
        <div class="sc-prod-section">
          <div class="sc-prod-section-title">Идентификаторы</div>
          ${copyFieldHtml('SKU', sku)}
          ${copyFieldHtml('PRODUCT ID', p.productId)}
          ${copyFieldHtml('ШК', p.barcode)}
        </div>
        <div class="sc-prod-section">
          <div class="sc-prod-section-title">Данные карточки</div>
          ${copyFieldHtml('Категория', p.category)}
          ${copyFieldHtml('Комиссия', p.commission ? `${p.commission}%` : '')}
          ${copyFieldHtml('Shop ID', p.shopId)}
          ${copyFieldHtml('SKU ID', p.skuId)}
          ${copyFieldHtml('Оборачиваемость', p.turnoverDays != null ? `${p.turnoverDays} дн.` : '')}
          ${copyFieldHtml('Себестоимость YO', cost ? money(cost) : 'нет в базе (добавь Uzum SKU)')}
          ${
            p.paidStorage
              ? `<div class="sc-paid-badge">Платно: ${esc(String(p.paidStorageAmount || '—'))}</div>`
              : ''
          }
        </div>
        ${
          uzumUrl
            ? `<a class="sc-uzum-link" href="${esc(uzumUrl)}" target="_blank" rel="noopener">Открыть на Uzum</a>`
            : ''
        }
      </div>`;
  }

  function productSaleBadge(p) {
    if (p.archived || statusIsArchived(p.cardStatusRaw || p.cardStatus)) return { cls: 'warn', txt: 'АРХИВ' };
    if (p.blocked || statusIsBlocked(p.statusRaw || p.status)) return { cls: 'bad', txt: 'БЛОК' };
    if (/MODERAT|МОДЕР/i.test(String(p.moderationStatus || ''))) {
      /* moderated OK */
    }
    if (/NOT_MODERATED|НА МОДЕР|WAITING/i.test(String(p.moderationStatus || ''))) {
      return { cls: 'warn', txt: 'НА МОДЕРАЦИИ' };
    }
    const stock = productStock(p);
    if (statusIsOnSale(p.cardStatusRaw || p.statusRaw || p.status) || (stock > 0 && !p.archived)) {
      return { cls: 'ok', txt: 'В ПРОДАЖЕ' };
    }
    if (stock <= 0 || /RUN_OUT|OUT|ЗАКОНЧ|TUGADI/i.test(String(p.status || ''))) {
      return { cls: 'bad', txt: 'ЗАКОНЧИЛИСЬ' };
    }
    return { cls: 'warn', txt: p.status || p.cardStatus || '—' };
  }

  function viewProducts() {
    const sales = salesBySku();
    const shopName = getSyncMeta().shopName || 'Uzum';
    const rows = _products
      .map((p) => {
        const sku = productSku(p);
        const s = sales[sku] || { qty: 0, revenue: 0, profit: 0 };
        const cost = productCost(p);
        const stock = productStock(p);
        const key = p._key || sku;
        const badge = productSaleBadge(p);
        return { p, sku, s, cost, stock, hasc: cost > 0, key, badge };
      })
      .sort((a, b) => b.stock - a.stock || b.s.revenue - a.s.revenue);

    if (!_selectedSkuKey && rows[0]) _selectedSkuKey = rows[0].key;
    const selected = rows.find((r) => r.key === _selectedSkuKey)?.p || null;

    const withStock = rows.filter((r) => r.stock > 0);
    const outStock = rows.filter((r) => r.stock <= 0).length;
    const inSale = rows.filter((r) => r.badge.txt === 'В ПРОДАЖЕ').length;
    const archived = rows.filter((r) => r.badge.txt === 'АРХИВ').length;
    const blocked = rows.filter((r) => r.badge.txt === 'БЛОК').length;
    const ended = rows.filter((r) => r.badge.txt === 'ЗАКОНЧИЛИСЬ').length;
    const units = withStock.reduce((s, r) => s + r.stock, 0);
    const fromApi = _products.some((p) => p.source === 'openapi');

    return `${assortTabsHtml('products')}
      <div class="sc-source-banner ${fromApi ? 'ok' : 'warn'}">
        ${
          fromApi
            ? `Ассортимент из <strong>Uzum OpenAPI</strong> (${esc(shopName)}) · себестоимость автоматом из базы YO по SKU`
            : 'Кэш OpenAPI пуст. Открой <strong>Настройки</strong> → Синхронизировать (ключ без Bearer).'
        }
      </div>
      <div class="sc-prod-layout">
        <div class="sc-prod-main">
          <div class="sc-kpi-row cols-4">
            ${kpiCard('Всего товаров', `${rows.length} SKU`, '', 'blue')}
            ${kpiCard('В продаже', `${inSale} SKU`, '', 'green')}
            ${kpiCard('Архивные', `${archived} SKU`, '', 'orange')}
            ${kpiCard('Заблокировано', `${blocked} SKU`, '', blocked ? 'orange' : 'green')}
          </div>
          <div class="sc-kpi-row cols-4">
            ${kpiCard('Закончились', `${ended} SKU`, '', ended ? 'orange' : 'green')}
            ${kpiCard('С остатком', `${withStock.length} SKU`, `${units.toLocaleString('ru-RU')} шт`, 'green')}
            ${kpiCard('Без остатка', `${outStock} SKU`, '', outStock ? 'orange' : 'green')}
            ${kpiCard('Заказы в кэше', String(_orders.length), 'finance/orders', 'blue')}
          </div>
          <div class="sc-toolbar">
            <input class="sc-search" id="sc-prod-q" placeholder="Поиск: название, SKU, штрихкод, productId" />
            <button type="button" class="sc-chip active" data-f="all">Все</button>
            <button type="button" class="sc-chip" data-f="stock">С остатком</button>
            <button type="button" class="sc-chip" data-f="cost">С себестоимостью</button>
            <button type="button" class="sc-chip" data-f="nocost">Без себест.</button>
            <button type="button" class="sc-export" data-sc-export="products">CSV</button>
          </div>
          ${
            !rows.length
              ? `<div class="sc-empty">Нет товаров OpenAPI. Синхронизируй API-ключ в Настройках.</div>`
              : `<div class="sc-sku-grid" id="sc-prod-grid">
            ${rows
              .map((r) => {
                const active = r.key === _selectedSkuKey ? ' active' : '';
                const img = r.p.image
                  ? `<img src="${esc(r.p.image)}" alt="" loading="lazy" decoding="async" />`
                  : `<div class="sc-sku-ph">нет фото</div>`;
                const avgd = r.p.avgdsales != null && r.p.avgdsales > 0 ? Number(r.p.avgdsales).toFixed(1) : '—';
                const turn = r.p.turnoverDays != null ? `${r.p.turnoverDays} дн.` : '—';
                const conv = r.p.conversion != null ? `${Number(r.p.conversion).toFixed(1)}%` : '—';
                return `<button type="button" class="sc-sku-card${active}" data-sc-sku="${esc(r.key)}"
                  data-hascost="${r.hasc}" data-hasstock="${r.stock > 0}">
                  <div class="sc-sku-img">${img}</div>
                  <div class="sc-sku-body">
                    <div class="sc-sku-brand">${esc(shopName)}</div>
                    ${pill(r.badge.cls, r.badge.txt)}
                    <div class="sc-sku-name">${esc(r.p.name || r.p.title || r.sku)}</div>
                    <div class="sc-sku-sku">${esc(r.sku)}</div>
                    <div class="sc-sku-stats">
                      <div><span>Остаток</span><b class="${r.stock > 0 ? 'ok' : 'bad'}">${r.stock}</b></div>
                      <div><span>Ср. продаж/день</span><b>${avgd}</b></div>
                      <div><span>Оборачив.</span><b>${turn}</b></div>
                      <div><span>Конверсия</span><b>${conv}</b></div>
                      <div><span>Цена</span><b>${money(r.p.sellPrice || r.p.price || 0)}</b></div>
                      <div><span>Рейтинг</span><b>${r.p.rating != null ? Number(r.p.rating).toFixed(1) : '—'}</b></div>
                      <div><span>Отзывы</span><b>${r.p.reviews || 0}</b></div>
                      <div><span>Продажи</span><b>${r.s.qty}</b></div>
                    </div>
                  </div>
                </button>`;
              })
              .join('')}
          </div>`
          }
        </div>
        <aside class="sc-prod-panel" id="sc-prod-panel">${productDetailHtml(selected, sales)}</aside>
      </div>`;
  }

  function classifyABC(rows) {
    const sorted = [...rows].sort((a, b) => b.s.revenue - a.s.revenue);
    const total = sorted.reduce((s, r) => s + r.s.revenue, 0) || 1;
    let cum = 0;
    return sorted.map((r) => {
      cum += r.s.revenue;
      const sh = cum / total;
      return { ...r, abc: sh <= 0.8 ? 'A' : sh <= 0.95 ? 'B' : 'C' };
    });
  }

  function classifyXYZ(rows) {
    return rows.map((r) => {
      const cv = r.s.qty > 10 ? 0.08 : r.s.qty > 3 ? 0.2 : r.s.qty > 0 ? 0.4 : 1;
      return { ...r, xyz: cv <= 0.1 ? 'X' : cv <= 0.25 ? 'Y' : cv <= 0.5 ? 'Z' : 'N' };
    });
  }

  function viewAbcXyz() {
    const sales = salesBySku();
    let rows = _products.map((p) => {
      const sku = productSku(p);
      return { p, sku, s: sales[sku] || { qty: 0, revenue: 0 }, stock: productStock(p) };
    });
    rows = classifyXYZ(classifyABC(rows));
    const M = { A: { X: 0, Y: 0, Z: 0, N: 0 }, B: { X: 0, Y: 0, Z: 0, N: 0 }, C: { X: 0, Y: 0, Z: 0, N: 0 } };
    rows.forEach((r) => {
      if (M[r.abc] && M[r.abc][r.xyz] != null) M[r.abc][r.xyz] += 1;
    });
    return `<div class="sc-assort-tabs">
        <button type="button" class="sc-subtab" data-sc-assort="products">Товары</button>
        <button type="button" class="sc-subtab active" data-sc-assort="abcxyz">ABC/XYZ</button>
        <button type="button" class="sc-subtab" data-sc-assort="profit-share">Доли прибыли</button>
        <button type="button" class="sc-subtab" data-sc-assort="unit-economics">Юнит-экономика</button>
        <button type="button" class="sc-subtab" data-sc-assort="cost">Себестоимость</button>
        <button type="button" class="sc-subtab" data-sc-assort="new-calc">Калькулятор</button>
      </div>
      <div class="sc-card"><div class="sc-card-title">Матрица ABC × XYZ</div>
        <table class="sc-abc-matrix"><thead><tr><th></th><th>X</th><th>Y</th><th>Z</th><th>N</th></tr></thead>
        <tbody>${['A', 'B', 'C']
          .map(
            (a) =>
              `<tr><th>${a}</th>${['X', 'Y', 'Z', 'N']
                .map((x) => `<td class="sc-abc-cell"><div class="sc-abc-count">${M[a][x]}</div></td>`)
                .join('')}</tr>`
          )
          .join('')}</tbody></table>
      </div>
      <div class="sc-table-wrap"><table class="sc-table">
        <thead><tr><th>SKU</th><th>ABC</th><th>XYZ</th><th>Продажи</th><th>Выручка</th></tr></thead>
        <tbody>${rows
          .slice(0, 200)
          .map(
            (r) =>
              `<tr><td>${esc(r.sku)}</td><td>${pill(r.abc.toLowerCase(), r.abc)}</td><td>${pill(r.xyz.toLowerCase(), r.xyz)}</td><td>${r.s.qty}</td><td>${money(r.s.revenue)}</td></tr>`
          )
          .join('')}</tbody>
      </table></div>`;
  }

  function viewProfitShare() {
    const sales = salesBySku();
    const rows = Object.keys(sales)
      .map((sku) => ({ sku, ...sales[sku], cost: lookupYoCost(sku) * sales[sku].qty }))
      .sort((a, b) => b.profit - a.profit);
    const total = rows.reduce((s, r) => s + Math.max(r.profit, 0), 0) || 1;
    return `<div class="sc-assort-tabs">
        <button type="button" class="sc-subtab" data-sc-assort="products">Товары</button>
        <button type="button" class="sc-subtab" data-sc-assort="abcxyz">ABC/XYZ</button>
        <button type="button" class="sc-subtab active" data-sc-assort="profit-share">Доли прибыли</button>
        <button type="button" class="sc-subtab" data-sc-assort="unit-economics">Юнит-экономика</button>
        <button type="button" class="sc-subtab" data-sc-assort="cost">Себестоимость</button>
        <button type="button" class="sc-subtab" data-sc-assort="new-calc">Калькулятор</button>
      </div>
      <div class="sc-kpi-row cols-3">
        ${kpiCard('SKU с прибылью', String(rows.filter((r) => r.profit > 0).length), '', 'green')}
        ${kpiCard('Сумма прибыли', money(rows.reduce((s, r) => s + r.profit, 0)), '', 'green')}
        ${kpiCard('Топ-1 доля', rows[0] ? pct((Math.max(rows[0].profit, 0) / total) * 100) : '—', rows[0]?.sku || '', 'blue')}
      </div>
      <div class="sc-card"><div class="sc-card-title">Распределение</div>
        <div class="sc-treemap">${rows
          .slice(0, 40)
          .map((r) => {
            const share = ((Math.max(r.profit, 0) / total) * 100).toFixed(1);
            return `<div class="sc-tm-cell" style="flex:${Math.max(r.profit, 1)};background:var(--accent)">
              <div class="sc-tm-name">${esc(r.sku)}</div>
              <div class="sc-tm-val">${moneyShort(r.profit)}</div>
              <div class="sc-tm-pct">${share}%</div>
            </div>`;
          })
          .join('')}</div>
      </div>`;
  }

  function viewUnitEconomics() {
    const sales = salesBySku();
    const { vatPct, commPct, minMarginPct } = _settings;
    const rows = _products.map((p) => {
      const sku = productSku(p);
      const cost = productCost(p);
      const price = Number(p.sellPrice || p.price || 0) || 0;
      const s = sales[sku] || { qty: 0, revenue: 0, profit: 0 };
      const comm = (price * commPct) / 100;
      const vat = (price * vatPct) / (100 + vatPct);
      const profit = price - cost - comm - vat;
      const margin = price > 0 ? (profit / price) * 100 : 0;
      return { sku, name: p.name || p.title, stock: productStock(p), cost, price, s, profit, margin };
    });
    return `<div class="sc-assort-tabs">
        <button type="button" class="sc-subtab" data-sc-assort="products">Товары</button>
        <button type="button" class="sc-subtab" data-sc-assort="abcxyz">ABC/XYZ</button>
        <button type="button" class="sc-subtab" data-sc-assort="profit-share">Доли прибыли</button>
        <button type="button" class="sc-subtab active" data-sc-assort="unit-economics">Юнит-экономика</button>
        <button type="button" class="sc-subtab" data-sc-assort="cost">Себестоимость</button>
        <button type="button" class="sc-subtab" data-sc-assort="new-calc">Калькулятор</button>
      </div>
      <p class="sub">Комиссия ${commPct}% · НДС ${vatPct}% · мин. маржа ${minMarginPct}%
        <button type="button" class="btn-secondary" data-sc-save-settings style="margin-left:8px">Параметры</button></p>
      <div class="sc-table-wrap"><table class="sc-table">
        <thead><tr><th>SKU</th><th>Цена</th><th>Себест.</th><th>Прибыль/шт</th><th>Маржа</th><th>Продано</th><th>Остаток</th></tr></thead>
        <tbody>${rows
          .slice(0, 300)
          .map(
            (r) =>
              `<tr><td>${esc(r.sku)}</td><td>${money(r.price)}</td><td>${r.cost ? money(r.cost) : '—'}</td>
              <td>${money(r.profit)}</td><td>${pct(r.margin)}</td><td>${r.s.qty}</td><td>${r.stock}</td></tr>`
          )
          .join('')}</tbody>
      </table></div>`;
  }

  function viewCost() {
    const stats = yoCostMatchStats();
    let rows = _products.map((p) => ({
      sku: productSku(p),
      name: p.name || p.title,
      cost: productCost(p),
      stock: productStock(p)
    }));
    if (_costFilter === 'has') rows = rows.filter((r) => r.cost > 0);
    if (_costFilter === 'miss') rows = rows.filter((r) => !(r.cost > 0));
    rows.sort((a, b) => (b.cost > 0) - (a.cost > 0) || String(a.sku).localeCompare(String(b.sku), 'ru'));
    return `<div class="sc-assort-tabs">
        <button type="button" class="sc-subtab" data-sc-assort="products">Товары</button>
        <button type="button" class="sc-subtab" data-sc-assort="abcxyz">ABC/XYZ</button>
        <button type="button" class="sc-subtab" data-sc-assort="profit-share">Доли прибыли</button>
        <button type="button" class="sc-subtab" data-sc-assort="unit-economics">Юнит-экономика</button>
        <button type="button" class="sc-subtab active" data-sc-assort="cost">Себестоимость</button>
        <button type="button" class="sc-subtab" data-sc-assort="new-calc">Калькулятор</button>
      </div>
      <p class="sub">Себестоимость берётся из базы YO по полю <strong>SKU Uzum</strong>. Редактирование —
        <button type="button" class="btn-secondary" data-sc-open-cost>Открыть Себестоимость YO</button></p>
      <div class="sc-kpi-row cols-3">
        ${kpiCard('Совпало с YO', `${stats.withCost} / ${stats.total}`, 'SKU с себестоимостью', 'green')}
        ${kpiCard('Без себестоимости', String(stats.miss), 'нет в базе YO или другой SKU', 'orange')}
        ${kpiCard('В базе YO', String(stats.yoProducts), 'товаров с costGross', 'blue')}
      </div>
      <div class="sc-toolbar" style="gap:8px;flex-wrap:wrap">
        <button type="button" class="sc-chip${_costFilter === 'all' ? ' active' : ''}" data-sc-costfilter="all">Все</button>
        <button type="button" class="sc-chip${_costFilter === 'has' ? ' active' : ''}" data-sc-costfilter="has">С себестоимостью</button>
        <button type="button" class="sc-chip${_costFilter === 'miss' ? ' active' : ''}" data-sc-costfilter="miss">Только «нет»</button>
        <button type="button" class="sc-export" data-sc-export="cost">CSV</button>
      </div>
      <p class="sub">Если SKU в OpenAPI нет в YO (например новые комплекты) — будет «нет». Добавьте товар в YO с тем же SKU Uzum.</p>
      <div class="sc-table-wrap"><table class="sc-table">
        <thead><tr><th>SKU</th><th>Название</th><th>Себестоимость</th><th>Остаток</th></tr></thead>
        <tbody>${rows
          .map(
            (r) =>
              `<tr><td>${esc(r.sku)}</td><td>${esc(r.name || '—')}</td><td>${r.cost ? money(r.cost) : pill('bad', 'нет')}</td><td>${r.stock}</td></tr>`
          )
          .join('')}</tbody>
      </table></div>`;
  }

  function viewNewCalc() {
    const { vatPct, commPct } = _settings;
    return `<div class="sc-assort-tabs">
        <button type="button" class="sc-subtab" data-sc-assort="products">Товары</button>
        <button type="button" class="sc-subtab" data-sc-assort="abcxyz">ABC/XYZ</button>
        <button type="button" class="sc-subtab" data-sc-assort="profit-share">Доли прибыли</button>
        <button type="button" class="sc-subtab" data-sc-assort="unit-economics">Юнит-экономика</button>
        <button type="button" class="sc-subtab" data-sc-assort="cost">Себестоимость</button>
        <button type="button" class="sc-subtab active" data-sc-assort="new-calc">Калькулятор</button>
      </div>
      <div class="sc-calc-grid">
        <div class="sc-card">
          <div class="sc-card-title">Новый товар</div>
          ${[
            ['nc-cost', 'Себестоимость', '0'],
            ['nc-price', 'Цена продажи', '0'],
            ['nc-comm', 'Комиссия %', String(commPct)],
            ['nc-vat', 'НДС %', String(vatPct)],
            ['nc-drr', 'ДРР %', '0'],
            ['nc-other', 'Прочее', '0'],
            ['nc-liters', 'Литраж', '1'],
            ['nc-turn', 'Оборачиваемость, дн', '30']
          ]
            .map(
              ([id, lab, val]) =>
                `<label class="sc-calc-line"><span>${lab}</span><input class="sc-num-input" id="${id}" data-sc-recalc value="${val}" type="number"></label>`
            )
            .join('')}
        </div>
        <div class="sc-calc-result">
          <div class="sc-card-title">Результат</div>
          <div>Мин. цена</div><div class="sc-calc-minprice" id="nc-minprice">—</div>
          <div class="sc-calc-line"><span>Прибыль</span><span id="nc-profit">—</span></div>
          <div class="sc-calc-line"><span>Маржа</span><span id="nc-margin">—</span></div>
          <div class="sc-calc-line"><span>ROI</span><span id="nc-roi">—</span></div>
        </div>
      </div>`;
  }

  function viewStock() {
    const rows = _products
      .map((p) => ({ sku: productSku(p), name: p.name || p.title, stock: productStock(p), cost: productCost(p) }))
      .sort((a, b) => a.stock - b.stock);
    const zero = rows.filter((r) => r.stock <= 0).length;
    const value = rows.reduce((s, r) => s + r.stock * r.cost, 0);
    return `<div class="sc-kpi-row cols-3">
        ${kpiCard('SKU', String(rows.length), '', 'blue')}
        ${kpiCard('Нулевой остаток', String(zero), '', 'red')}
        ${kpiCard('Стоимость склада', money(value), 'по себестоимости YO', 'green')}
      </div>
      <div class="sc-table-wrap"><table class="sc-table">
        <thead><tr><th>SKU</th><th>Название</th><th>Остаток</th><th>Себест.</th><th>Сумма</th></tr></thead>
        <tbody>${rows
          .slice(0, 400)
          .map(
            (r) =>
              `<tr><td>${esc(r.sku)}</td><td>${esc(r.name || '—')}</td><td>${r.stock}</td><td>${money(r.cost)}</td><td>${money(r.stock * r.cost)}</td></tr>`
          )
          .join('')}</tbody>
      </table></div>`;
  }

  function viewShipments() {
    const by = (st) => _fbsOrders.filter((o) => String(o._status || o.status) === st).length;
    const created = by('CREATED') + by('PACKING');
    const pending = by('PENDING_DELIVERY');
    const delivering = by('DELIVERING');
    const done = by('COMPLETED');
    const canceled = by('CANCELED');
    return `<div class="sc-kpi-row cols-4">
        ${kpiCard('Нужно собрать', String(created), 'CREATED / PACKING', 'orange')}
        ${kpiCard('Передать', String(pending), 'PENDING_DELIVERY', 'blue')}
        ${kpiCard('В пути', String(delivering), 'DELIVERING', 'blue')}
        ${kpiCard('Выкуплено', String(done), `отмены: ${canceled}`, 'green')}
      </div>
      <div class="sc-table-wrap"><table class="sc-table">
        <thead><tr><th>ID</th><th>Статус</th><th>Схема</th><th>Дата</th></tr></thead>
        <tbody>
          ${_fbsOrders
            .slice(0, 200)
            .map((o) => {
              const t = Number(o.dateCreated || o.createdAt || o.date || 0);
              return `<tr>
                <td>${esc(o.id || o.orderId || '—')}</td>
                <td>${esc(o._status || o.status || '—')}</td>
                <td>${esc(o.scheme || o.deliveryScheme || '—')}</td>
                <td>${t ? new Date(t).toLocaleString('ru-RU') : '—'}</td>
              </tr>`;
            })
            .join('') || '<tr><td colspan="4">Нет FBS-заказов — выполни синхронизацию</td></tr>'}
        </tbody>
      </table></div>`;
  }

  function viewTurnover() {
    const sales = salesBySku();
    const rows = _products.map((p) => {
      const sku = productSku(p);
      const s = sales[sku] || { qty: 0 };
      const stock = productStock(p);
      const daysNoSale = s.qty > 0 ? 0 : periodDaysCount();
      const speed = s.qty / Math.max(periodDaysCount(), 1);
      const daysLeft = speed > 0 ? stock / speed : stock > 0 ? 999 : 0;
      return { sku, name: p.name || p.title, stock, sold: s.qty, daysNoSale, daysLeft, cost: productCost(p) };
    });
    const noSales = rows.filter((r) => r.sold === 0 && r.stock > 0).length;
    const storageHint = rows.filter((r) => r.daysNoSale >= 30 && r.stock > 0).length;
    return `<div class="sc-kpi-row cols-3">
        ${kpiCard('Без продаж + остаток', String(noSales), `за ${periodDaysCount()} дн`, 'orange')}
        ${kpiCard('Риск платного хранения', String(storageHint), 'нет продаж ≥ периода', 'red')}
        ${kpiCard('SKU в анализе', String(rows.length), '', 'blue')}
      </div>
      <div class="sc-card"><div class="sc-card-title">Оборачиваемость</div>
        <p class="sub">Платное хранение FBO детально зависит от тарифов Uzum — здесь сигнал по отсутствию продаж и остатку.</p>
      </div>
      <div class="sc-table-wrap"><table class="sc-table">
        <thead><tr><th>SKU</th><th>Остаток</th><th>Продано</th><th>Дней без продаж</th><th>Запас, дн</th></tr></thead>
        <tbody>${rows
          .sort((a, b) => b.daysNoSale - a.daysNoSale || a.daysLeft - b.daysLeft)
          .slice(0, 300)
          .map(
            (r) =>
              `<tr><td>${esc(r.sku)}</td><td>${r.stock}</td><td>${r.sold}</td><td>${r.daysNoSale}</td><td>${r.daysLeft >= 999 ? '—' : r.daysLeft.toFixed(0)}</td></tr>`
          )
          .join('')}</tbody>
      </table></div>`;
  }

  function recalcNew() {
    const num = (id) => Number(document.getElementById(id)?.value) || 0;
    const cost = num('nc-cost');
    const price = num('nc-price');
    const commPct = num('nc-comm');
    const vatPct = num('nc-vat');
    const drrPct = num('nc-drr');
    const other = num('nc-other');
    const L = num('nc-liters');
    const log = typeof calcLogistics === 'function' ? calcLogistics(L) : L > 0 ? Math.min(5250 + (L - 1) * 250, 50000) : 0;
    const commission = (price * commPct) / 100;
    const vatOut = (price * vatPct) / (100 + vatPct);
    const drr = (price * drrPct) / 100;
    const totalExp = cost + log + commission + vatOut + drr + other;
    const den = 1 - commPct / 100 - vatPct / (100 + vatPct) - drrPct / 100;
    const minPrice = cost > 0 && den > 0 ? Math.ceil((cost + log + other) / den) : 0;
    const profit = price - totalExp;
    const margin = price > 0 ? (profit / price) * 100 : 0;
    const roi = cost > 0 ? (profit / cost) * 100 : 0;
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    set('nc-minprice', minPrice ? money(minPrice) : '—');
    set('nc-profit', money(profit));
    set('nc-margin', pct(margin));
    set('nc-roi', pct(roi));
  }

  function setSyncBusy(busy, msg) {
    const saveBtn = document.querySelector('[data-sc-save-token]');
    const syncBtn = document.querySelector('[data-sc-sync]');
    const status = document.getElementById('sc-sync-status');
    if (saveBtn) {
      saveBtn.disabled = !!busy;
      saveBtn.textContent = busy ? 'Синхронизация…' : 'Сохранить и синхронизировать';
    }
    if (syncBtn) {
      syncBtn.disabled = !!busy;
      syncBtn.textContent = busy ? 'Ждите…' : 'Синхронизировать';
    }
    if (status && msg) status.textContent = msg;
  }

  function wireSettingsButtons() {
    const root = document.getElementById('settingsTabContent');
    if (!root) return;
    const on = (sel, fn) => {
      const el = root.querySelector(sel);
      if (!el || el.dataset.scWired === '1') return;
      el.dataset.scWired = '1';
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
    };
    on('[data-sc-toggle-token]', () => toggleToken());
    on('[data-sc-save-token]', () => saveToken());
    on('[data-sc-sync]', () => {
      void syncUzum();
    });
    on('[data-sc-clear-token]', () => clearToken());
  }

  function renderSettingsPage() {
    void renderSettingsPageAsync();
  }

  async function renderSettingsPageAsync() {
    bindEvents();
    const root = document.getElementById('settingsTabContent');
    if (!root) return;
    const token = getToken();
    const meta = getSyncMeta();
    const apiProducts = await readCache(API_PRODUCTS_KEY, []);
    const cachedOrders = await readCache(ORDERS_KEY, []);
    const cachedExpenses = await readCache(EXPENSES_KEY, []);
    const cachedFbs = await readCache(FBS_KEY, []);
    const lastSync = meta.lastSyncAt ? new Date(meta.lastSyncAt).toLocaleString('ru-RU') : 'ещё не было';
    const apiSkuCount =
      flattenApiProducts(apiProducts).length || meta.skuCount || _products.length || meta.productsCount || 0;
    const ordersN = cachedOrders.length || _orders.length || meta.ordersCount || 0;
    const expensesN = cachedExpenses.length || _expenses.length || meta.expensesCount || 0;
    const fbsN = cachedFbs.length || _fbsOrders.length || meta.fbsCount || 0;
    root.innerHTML = `
      <div class="sc-settings-wrap">
        <div class="sc-settings-block">
          <div class="sc-settings-title">Uzum Seller OpenAPI
            <span style="margin-left:auto">${tokenStatusHtml(token)}</span>
          </div>
          <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:14px;margin-bottom:14px;font-size:13px;line-height:1.5">
            Официальный OpenAPI (не сессия кабинета).<br>
            <a href="https://seller.uzum.uz/seller/api-keys" target="_blank" rel="noopener">Создать API-ключ</a> ·
            <a href="https://api-seller.uzum.uz/api/seller-openapi/swagger/swagger-ui/webjars/swagger-ui/index.html" target="_blank" rel="noopener">Swagger</a>
            <br><br>
            Заказы/товары пишутся в <strong>IndexedDB</strong> (не в localStorage) — иначе браузер падает с QuotaExceeded на 3000+ заказов.
            При <strong>HTTP 429</strong> подожди 2–5 минут и синхронизируй снова.
          </div>
          <label style="display:block;margin-bottom:12px">
            <div style="font-size:13px;font-weight:600;margin-bottom:6px">API-ключ (без Bearer)</div>
            <div style="display:flex;gap:8px">
              <input type="password" id="sc-token-inp" class="sc-token-input" placeholder="Вставь API-ключ" value="" autocomplete="off">
              <button type="button" class="btn-secondary" data-sc-toggle-token>👁</button>
            </div>
          </label>
          <div class="toolbar" style="gap:10px;flex-wrap:wrap">
            <button type="button" class="btn-primary" data-sc-save-token>Сохранить и синхронизировать</button>
            <button type="button" class="btn-secondary" data-sc-sync>Синхронизировать</button>
            <button type="button" class="btn-danger" data-sc-clear-token>Удалить</button>
          </div>
          <p class="sub" style="margin-top:12px" id="sc-sync-status">Последняя синхронизация: <strong>${esc(lastSync)}</strong>
            ${meta.lastStatus ? ` · статус: ${esc(meta.lastStatus)}` : ''}
            ${meta.storage ? ` · ${esc(meta.storage)}` : ''}
            ${ordersN ? ` · заказы: ${ordersN}` : ''}
            ${meta.productsCount != null ? ` · товары: ${meta.productsCount}` : ''}
            ${fbsN ? ` · FBS: ${fbsN}` : ''}
            ${meta.lastError ? `<br><span style="color:var(--bad)">Ошибка/предупреждение: ${esc(meta.lastError)}</span>` : ''}
          </p>
        </div>
        <div class="sc-settings-block">
          <div class="sc-settings-title">Что тянем из OpenAPI</div>
          <div class="sc-sync-grid">
            <div class="sc-sync-item"><div class="sc-sync-icon">📋</div><div class="sc-sync-body">
              <div class="sc-sync-name">Товары OpenAPI</div><div class="sc-sync-stat">${apiSkuCount} SKU${meta.productsCount != null ? ` · ${meta.productsCount} карт.` : ''}</div>
            </div></div>
            <div class="sc-sync-item"><div class="sc-sync-icon">🛒</div><div class="sc-sync-body">
              <div class="sc-sync-name">Finance orders</div><div class="sc-sync-stat">${ordersN}</div>
            </div></div>
            <div class="sc-sync-item"><div class="sc-sync-icon">💰</div><div class="sc-sync-body">
              <div class="sc-sync-name">Expenses</div><div class="sc-sync-stat">${expensesN}</div>
            </div></div>
            <div class="sc-sync-item"><div class="sc-sync-icon">🚚</div><div class="sc-sync-body">
              <div class="sc-sync-name">FBS orders</div><div class="sc-sync-stat">${fbsN}</div>
            </div></div>
          </div>
          <p class="sub" style="margin-top:10px">Ассортимент в Аналитике строится из OpenAPI (не из Firebase YO). YO нужен только для себестоимости.</p>
        </div>
        <div class="sc-settings-block">
          <div class="sc-settings-title">Firebase</div>
          <p style="margin:0;font-size:14px">${
            window.db ? pill('ok', 'Подключён') + ' yoa123' : pill('bad', 'localStorage')
          }</p>
        </div>
      </div>`;
    wireSettingsButtons();
  }

  function assortView() {
    if (_assortTab === 'abcxyz') return viewAbcXyz();
    if (_assortTab === 'profit-share') return viewProfitShare();
    if (_assortTab === 'unit-economics') return viewUnitEconomics();
    if (_assortTab === 'cost') return viewCost();
    if (_assortTab === 'new-calc') return viewNewCalc();
    return viewProducts();
  }

  function render() {
    const el = document.getElementById('sc-content');
    if (!el) return;
    let html = '';
    switch (_view) {
      case 'dashboard':
        html = viewDashboard();
        break;
      case 'finance':
        html = viewFinance();
        break;
      case 'products':
      case 'abcxyz':
      case 'profit-share':
      case 'unit-economics':
      case 'cost':
      case 'new-calc':
        _assortTab = _view;
        html = assortView();
        break;
      case 'stock':
        html = viewStock();
        break;
      case 'shipments':
        html = viewShipments();
        break;
      case 'turnover':
        html = viewTurnover();
        break;
      default:
        html = viewDashboard();
    }
    el.innerHTML = html;

    document.querySelectorAll('.sc-sidebar .sc-nav[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-view') === _view);
    });
    document.querySelectorAll('.sc-period[data-sc-period]').forEach((btn) => {
      const mode = btn.getAttribute('data-sc-period');
      let active = mode === _periodMode;
      if (mode === 'days') {
        active = _periodMode === 'days' && Number(btn.getAttribute('data-days')) === _periodDays;
      }
      btn.classList.toggle('active', active);
    });

    if (_view === 'dashboard') drawSimpleChart('sc-dash-chart', dailySeries(_dynMode));
    if (_view === 'finance' && _finSub === 'overview') drawSimpleChart('sc-fin-chart', dailySeries('revenue'));
    if (_view === 'new-calc' || _assortTab === 'new-calc') recalcNew();
    if (_view === 'products' || _assortTab === 'products') applyProdFilter();
  }

  function goView(view) {
    if (view === '__settings') {
      if (typeof openPage === 'function') openPage('settings-tab');
      return;
    }
    if (!view) return;
    if (view === 'finance-expenses') {
      _view = 'finance';
      _finSub = 'expenses';
      render();
      return;
    }
    const assort = ['products', 'abcxyz', 'profit-share', 'unit-economics', 'cost', 'new-calc'];
    if (assort.includes(view)) {
      _view = view;
      _assortTab = view;
    } else {
      _view = view;
    }
    render();
  }

  function setFinSub(sub) {
    _finSub = ['pnl', 'payout', 'expenses'].includes(sub) ? sub : 'overview';
    render();
  }

  function dismiss(key) {
    if (!key) return;
    _dismissed.add(key);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([..._dismissed]));
    render();
  }

  function saveSettings() {
    const vat = Number(prompt('НДС %', _settings.vatPct));
    const comm = Number(prompt('Комиссия %', _settings.commPct));
    const margin = Number(prompt('Мин. маржа %', _settings.minMarginPct));
    if (Number.isFinite(vat)) _settings.vatPct = vat;
    if (Number.isFinite(comm)) _settings.commPct = comm;
    if (Number.isFinite(margin)) _settings.minMarginPct = margin;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings));
    render();
  }

  function filterProd() {
    applyProdFilter();
  }

  function chipProd(btn) {
    document.querySelectorAll('.sc-chip[data-f]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    _prodFilter = btn.getAttribute('data-f') || 'all';
    applyProdFilter();
  }

  function applyProdFilter() {
    const q = String(document.getElementById('sc-prod-q')?.value || '')
      .toLowerCase()
      .trim();
    const cards = document.querySelectorAll('#sc-prod-grid .sc-sku-card');
    if (cards.length) {
      cards.forEach((card) => {
        const text = card.textContent.toLowerCase();
        const hasc = card.getAttribute('data-hascost') === 'true';
        const hasstock = card.getAttribute('data-hasstock') === 'true';
        let ok = !q || text.includes(q);
        if (_prodFilter === 'cost') ok = ok && hasc;
        if (_prodFilter === 'nocost') ok = ok && !hasc;
        if (_prodFilter === 'stock') ok = ok && hasstock;
        card.style.display = ok ? '' : 'none';
      });
      return;
    }
    document.querySelectorAll('#sc-prod-table .sc-prod-row').forEach((tr) => {
      const text = tr.textContent.toLowerCase();
      const hasc = tr.getAttribute('data-hascost') === 'true';
      const hasstock = tr.getAttribute('data-hasstock') === 'true';
      let ok = !q || text.includes(q);
      if (_prodFilter === 'cost') ok = ok && hasc;
      if (_prodFilter === 'nocost') ok = ok && !hasc;
      if (_prodFilter === 'stock') ok = ok && hasstock;
      tr.style.display = ok ? '' : 'none';
    });
  }

  function exportCsv(filename, rows) {
    const bom = '\uFEFF';
    const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bom + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = filename;
    a.click();
  }

  function exportProducts() {
    const sales = salesBySku();
    exportCsv('yo-products.csv', [
      ['sku', 'name', 'stock', 'cost', 'sold', 'revenue'],
      ..._products.map((p) => {
        const sku = productSku(p);
        const s = sales[sku] || {};
        return [sku, p.name || p.title, productStock(p), productCost(p), s.qty || 0, s.revenue || 0];
      })
    ]);
  }

  function exportAbcXyz() {
    exportProducts();
  }

  function exportCost() {
    exportCsv('yo-cost.csv', [
      ['sku', 'name', 'cost', 'stock'],
      ..._products.map((p) => [productSku(p), p.name || p.title, productCost(p), productStock(p)])
    ]);
  }

  function editProd() {
    /* reserved */
  }

  function matGroup() {
    /* reserved */
  }

  function closeScMobileNav() {
    document.body.classList.remove('sc-nav-open');
    document.getElementById('scSidebar')?.classList.remove('open');
    const overlay = document.getElementById('scSidebarOverlay');
    if (overlay) overlay.hidden = true;
    document.getElementById('scMenuBtn')?.setAttribute('aria-expanded', 'false');
  }

  function openScMobileNav() {
    document.body.classList.add('sc-nav-open');
    document.getElementById('scSidebar')?.classList.add('open');
    const overlay = document.getElementById('scSidebarOverlay');
    if (overlay) overlay.hidden = false;
    document.getElementById('scMenuBtn')?.setAttribute('aria-expanded', 'true');
  }

  function bindEvents() {
    if (_wired) return;
    _wired = true;
    const root = document.getElementById('analytics-scaleup-tab');
    root?.addEventListener('click', (e) => {
      if (e.target.closest('#scBackToYo')) {
        e.preventDefault();
        closeScMobileNav();
        if (typeof openPage === 'function') openPage('dashboard-page');
        return;
      }
      if (e.target.closest('#scMenuBtn')) {
        e.preventDefault();
        if (document.body.classList.contains('sc-nav-open')) closeScMobileNav();
        else openScMobileNav();
        return;
      }
      if (e.target.closest('#scSidebarOverlay')) {
        closeScMobileNav();
        return;
      }
      if (e.target.closest('[data-sc-open-settings]')) {
        closeScMobileNav();
        if (typeof openPage === 'function') openPage('settings-tab');
        return;
      }
      const nav = e.target.closest('.sc-nav[data-view]');
      if (nav) {
        goView(nav.getAttribute('data-view'));
        closeScMobileNav();
        return;
      }
      const period = e.target.closest('.sc-period[data-sc-period]');
      if (period) {
        const mode = period.getAttribute('data-sc-period') || 'today';
        _periodMode = mode;
        if (mode === 'days') {
          _periodDays = Number(period.getAttribute('data-days')) || 90;
        }
        if (mode === 'day' && !_periodDay) _periodDay = isoDateLocal();
        if (mode === 'custom') {
          if (!_periodCustomFrom) _periodCustomFrom = isoDateLocal(new Date(Date.now() - 7 * 86400000));
          if (!_periodCustomTo) _periodCustomTo = isoDateLocal();
        }
        render();
        return;
      }
      const expf = e.target.closest('[data-sc-expfilter]');
      if (expf) {
        _expFilter = expf.getAttribute('data-sc-expfilter') || 'all';
        render();
        return;
      }
      if (e.target.closest('#sc-refresh-btn')) {
        void syncOrdersFresh({ silent: false });
        return;
      }
      const dyn = e.target.closest('[data-sc-dyn]');
      if (dyn) {
        _dynMode = dyn.getAttribute('data-sc-dyn') || 'orders';
        render();
        return;
      }
      const assort = e.target.closest('[data-sc-assort]');
      if (assort) {
        goView(assort.getAttribute('data-sc-assort'));
        return;
      }
      const costf = e.target.closest('[data-sc-costfilter]');
      if (costf) {
        _costFilter = costf.getAttribute('data-sc-costfilter') || 'all';
        render();
        return;
      }
      const gov = e.target.closest('[data-sc-goview]');
      if (gov) {
        goView(gov.getAttribute('data-sc-goview'));
        return;
      }
      const dis = e.target.closest('[data-sc-dismiss]');
      if (dis) {
        dismiss(dis.getAttribute('data-sc-dismiss'));
        return;
      }
      const fin = e.target.closest('[data-sc-finsub]');
      if (fin) {
        setFinSub(fin.getAttribute('data-sc-finsub'));
        return;
      }
      const chip = e.target.closest('.sc-chip[data-f]');
      if (chip) {
        chipProd(chip);
        return;
      }
      const skuCard = e.target.closest('[data-sc-sku]');
      if (skuCard) {
        _selectedSkuKey = skuCard.getAttribute('data-sc-sku') || '';
        render();
        return;
      }
      const copyBtn = e.target.closest('[data-sc-copy]');
      if (copyBtn) {
        const val = copyBtn.getAttribute('data-sc-copy') || '';
        if (val && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(val);
          copyBtn.textContent = '✓';
          setTimeout(() => {
            copyBtn.textContent = '⧉';
          }, 900);
        }
        return;
      }
      if (e.target.closest('[data-sc-close-panel]')) {
        _selectedSkuKey = '';
        render();
        return;
      }
      const exp = e.target.closest('[data-sc-export]');
      if (exp) {
        const kind = exp.getAttribute('data-sc-export');
        if (kind === 'products') exportProducts();
        if (kind === 'abcxyz') exportAbcXyz();
        if (kind === 'cost') exportCost();
        return;
      }
      if (e.target.closest('[data-sc-save-settings]')) {
        saveSettings();
        return;
      }
      if (e.target.closest('[data-sc-open-cost]')) {
        if (typeof openPage === 'function') openPage('cost-tab');
      }
    });

    root?.addEventListener('input', (e) => {
      if (e.target?.id === 'sc-prod-q') filterProd();
      if (e.target?.hasAttribute?.('data-sc-recalc')) recalcNew();
      if (e.target?.id === 'sc-period-day') {
        _periodDay = e.target.value || isoDateLocal();
        _periodMode = 'day';
        render();
      }
      if (e.target?.id === 'sc-period-from') {
        _periodCustomFrom = e.target.value || isoDateLocal();
        _periodMode = 'custom';
        render();
      }
      if (e.target?.id === 'sc-period-to') {
        _periodCustomTo = e.target.value || isoDateLocal();
        _periodMode = 'custom';
        render();
      }
    });

    root?.addEventListener('change', (e) => {
      if (e.target?.id === 'sc-period-day') {
        _periodDay = e.target.value || isoDateLocal();
        _periodMode = 'day';
        render();
      }
      if (e.target?.id === 'sc-period-from' || e.target?.id === 'sc-period-to') {
        if (e.target.id === 'sc-period-from') _periodCustomFrom = e.target.value;
        if (e.target.id === 'sc-period-to') _periodCustomTo = e.target.value;
        _periodMode = 'custom';
        render();
      }
    });

    document.getElementById('settings-tab')?.addEventListener('click', (e) => {
      if (e.target.closest('#scSettingsBackAnalytics')) {
        if (typeof openPage === 'function') openPage('analytics-scaleup-tab');
        return;
      }
      if (e.target.closest('#scSettingsBackYo')) {
        if (typeof openPage === 'function') openPage('dashboard-page');
        return;
      }
      if (e.target.closest('[data-sc-toggle-token]')) toggleToken();
      if (e.target.closest('[data-sc-save-token]')) saveToken();
      if (e.target.closest('[data-sc-clear-token]')) clearToken();
      if (e.target.closest('[data-sc-sync]')) void syncUzum();
    });
  }

  function init(force) {
    bindEvents();
    ensureAutoOrdersRefresh();
    if (!_initialized || force) {
      _initialized = true;
      void loadAllData().then(() => {
        ensureAutoOrdersRefresh();
      });
    } else {
      updateDataSourceBadge();
      render();
    }
  }

  window.ScaleUpYO = {
    init,
    loadAllData,
    goView,
    setFinSub,
    dismiss,
    saveSettings,
    filterProd,
    chipProd,
    exportProducts,
    exportAbcXyz,
    exportCost,
    editProd,
    matGroup,
    recalcNew,
    toggleToken,
    saveToken,
    clearToken,
    syncUzum,
    syncOrdersFresh,
    renderSettingsPage
  };
})();
