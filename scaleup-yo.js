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
  let _periodDays = 90;
  let _finSub = 'overview';
  let _dynMode = 'orders';
  let _products = [];
  let _yoCostMap = {};
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

  function periodStartMs(days) {
    return Date.now() - (Number(days) || 90) * 86400000;
  }

  function periodEndMs() {
    return Date.now();
  }

  function inPeriodMs(ms) {
    const t = Number(ms);
    if (!Number.isFinite(t) || t <= 0) return false;
    return t >= periodStartMs(_periodDays) && t <= periodEndMs() + 86400000;
  }

  function orderDateMs(o) {
    return Number(o?.dateIssued || o?.date || o?.createdAt || 0) || 0;
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
    return String(p?.sku || p?.skuTitle || p?.article1c || p?.skuId || p?.id || '').trim();
  }

  function productCost(p) {
    const sku = productSku(p);
    if (_yoCostMap[sku] != null) return _yoCostMap[sku];
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

  function buildYoCostMap(list) {
    const map = {};
    (list || []).forEach((p) => {
      const sku = String(p?.sku || p?.article1c || '').trim();
      const c = Number(p?.costGross ?? p?.costPrice ?? p?.cost ?? 0) || 0;
      if (sku && c > 0) map[sku] = c;
    });
    return map;
  }

  function statusLabel(status) {
    if (!status) return '';
    if (typeof status === 'string') return status;
    return String(status.value || status.name || status.title || status.description || '').trim();
  }

  function statusIsOnSale(status) {
    const s = statusLabel(status).toUpperCase();
    return /IN_STOCK|ON_SALE|ACTIVE|SALE|В ПРОДАЖ|ПРОДАЖ|AVAILABLE/.test(s) || s === '1';
  }

  function flattenApiProducts(apiList) {
    const out = [];
    const shopIdFallback = getSyncMeta().shopId || null;
    (apiList || []).forEach((card) => {
      const skus = Array.isArray(card.skuList) && card.skuList.length ? card.skuList : [null];
      skus.forEach((sku) => {
        const skuCode = String(
          sku?.skuTitle || sku?.skuFullTitle || sku?.article || sku?.barcode || card.skuTitle || card.productId || ''
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
        const avgd = Number(sku?.avgdsales ?? 0) || 0;
        const turnoverDays = avgd > 0 ? Math.round(stock / avgd) : null;
        const paidStorage =
          sku?.pstorage || Number(sku?.paidStorageAmount ?? sku?.paidStoragePriceItem ?? 0) > 0;
        const paidStorageAmount = Number(sku?.paidStorageAmount ?? sku?.paidStoragePriceItem ?? 0) || 0;
        out.push({
          id: sku?.skuId || card.productId,
          productId: card.productId,
          skuId: sku?.skuId,
          sku: skuCode,
          barcode: sku?.barcode != null ? String(sku.barcode) : '',
          name: card.title || sku?.productTitle || card.skuTitle || skuCode,
          title: card.title || sku?.productTitle || card.skuTitle || skuCode,
          image: card.previewImg || sku?.previewImage || card.image || '',
          rating: card.rating != null ? Number(card.rating) : null,
          reviews: Number(card.reviewsCount || card.feedbackQuantity || card.reviews || 0) || 0,
          category: card.categoryTitle || card.category?.title || card.category || '',
          status: statusLabel(card.status),
          statusRaw: card.status,
          commission,
          stockQty: stock,
          quantityActive: qActive,
          quantityFbo: qFbo,
          quantityFbs: qFbs,
          price,
          sellPrice: price,
          cost: _yoCostMap[skuCode] || 0,
          shopId: card.shopId || shopIdFallback,
          turnoverDays,
          paidStorage,
          paidStorageAmount,
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

    _orders = readLocal(ORDERS_KEY, []);
    _expenses = readLocal(EXPENSES_KEY, []);
    _fbsOrders = readLocal(FBS_KEY, []);
    const apiProducts = readLocal(API_PRODUCTS_KEY, []);

    // Ассортимент = Uzum OpenAPI. YO только для себестоимости (и fallback, если кэша API нет).
    if (apiProducts.length) {
      _products = flattenApiProducts(apiProducts);
      _hasApiData = true;
    } else {
      _products = yoProducts.map((yp) => ({
        ...yp,
        name: yp.name || yp.title || productSku(yp),
        title: yp.title || yp.name || productSku(yp),
        stockQty: productStock(yp),
        cost: productCost(yp),
        source: 'yo',
        _key: `yo:${productSku(yp)}`
      }));
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
    el.textContent = `${parts.join(' · ')} · ${_products.length} SKU${meta.shopId ? ` · shop #${meta.shopId}` : ''}`;
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
    if (Array.isArray(data?.payload)) return data.payload;
    if (Array.isArray(data?.content)) return data.content;
    return [];
  }

  async function fetchPaged(buildPath, extract, maxPages, pageDelayMs) {
    const out = [];
    const limit = maxPages || 8;
    const delay = pageDelayMs == null ? 900 : pageDelayMs;
    for (let page = 0; page < limit; page++) {
      if (page > 0 && delay > 0) await sleep(delay);
      const data = await uzumJson(buildPath(page));
      const chunk = extract(data);
      if (!chunk.length) break;
      out.push(...chunk);
      const total = data?.totalElements ?? data?.totalProductsAmount ?? data?.total ?? null;
      if (total != null && out.length >= total) break;
      if (chunk.length < 20) break;
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

    let productCards = readLocal(API_PRODUCTS_KEY, []);
    let orders = readLocal(ORDERS_KEY, []);
    let expenses = readLocal(EXPENSES_KEY, []);
    let fbs = readLocal(FBS_KEY, []);
    let shopId = getSyncMeta().shopId || null;
    const warnings = [];

    try {
      const shopsRaw = await uzumJson('v1/shops');
      const shops = unwrapList(shopsRaw, ['shops', 'organizations']);
      const shop = shops[0] || null;
      shopId = shop?.id || shop?.shopId || shopId;
      if (!shopId) throw new Error('Магазины не найдены по API-ключу');

      const dateFrom = periodStartMs(Math.min(Math.max(_periodDays, 30), 90));
      const dateTo = periodEndMs();

      // 1) Товары — приоритет (карточки ScaleUp)
      setSyncBusy(true, 'Загрузка товаров (медленно, без 429)…');
      await sleep(400);
      try {
        productCards = await fetchPaged(
          (page) =>
            `v1/product/shop/${shopId}?searchQuery=&sortBy=DEFAULT&order=DESC&size=50&page=${page}`,
          (data) => unwrapList(data, ['productList']),
          8,
          1100
        );
        writeLocal(API_PRODUCTS_KEY, productCards);
      } catch (e) {
        if (productCards.length) {
          warnings.push(`Товары: ${e?.message || e} (оставлен прошлый кэш ${productCards.length})`);
        } else {
          throw e;
        }
      }

      // 2) Finance orders — меньше страниц
      setSyncBusy(true, 'Загрузка заказов…');
      await sleep(1200);
      try {
        orders = await fetchPaged(
          (page) =>
            `v1/finance/orders?page=${page}&size=50&group=false&dateFrom=${dateFrom}&dateTo=${dateTo}`,
          (data) => unwrapList(data, ['orderItems']),
          6,
          1200
        );
        writeLocal(ORDERS_KEY, orders);
      } catch (e) {
        warnings.push(`Заказы: ${e?.message || e}`);
      }

      // 3) Expenses — soft
      setSyncBusy(true, 'Загрузка расходов…');
      await sleep(1000);
      try {
        expenses = await fetchPaged(
          (page) =>
            `v1/finance/expenses?page=${page}&size=50&dateFrom=${dateFrom}&dateTo=${dateTo}&shopIds=${shopId}`,
          (data) => {
            if (Array.isArray(data?.paymentList)) return data.paymentList;
            if (Array.isArray(data?.payload?.paymentList)) return data.payload.paymentList;
            return unwrapList(data, ['payments', 'expenses', 'items', 'content']);
          },
          3,
          1000
        );
        writeLocal(EXPENSES_KEY, expenses);
      } catch (e) {
        warnings.push(`Расходы: ${e?.message || e}`);
      }

      // 4) FBS — только активные статусы, по 1 странице
      setSyncBusy(true, 'Загрузка FBS…');
      const fbsNew = [];
      const statuses = ['CREATED', 'PACKING', 'DELIVERING'];
      for (const st of statuses) {
        await sleep(900);
        try {
          const chunk = await fetchPaged(
            (page) =>
              `v2/fbs/orders?shopIds=${shopId}&status=${st}&page=${page}&size=50&dateFrom=${dateFrom}&dateTo=${dateTo}`,
            (data) => {
              const list = unwrapList(data, ['orders', 'payload']);
              return list.map((o) => ({ ...o, _status: st }));
            },
            1,
            0
          );
          fbsNew.push(...chunk);
        } catch (e) {
          warnings.push(`FBS ${st}: ${e?.message || e}`);
        }
      }
      if (fbsNew.length || !warnings.some((w) => w.startsWith('FBS'))) {
        fbs = fbsNew;
        writeLocal(FBS_KEY, fbs);
      }

      saveSyncMeta({
        lastSyncAt: new Date().toISOString(),
        lastStatus: warnings.length ? 'partial' : 'ok',
        shopId,
        shopsCount: shops.length,
        ordersCount: orders.length,
        productsCount: productCards.length,
        expensesCount: expenses.length,
        fbsCount: fbs.length,
        api: 'seller-openapi',
        lastError: warnings.join(' | ').slice(0, 500)
      });

      await loadAllData();
      _syncBusy = false;
      setSyncBusy(false);
      const warnTxt = warnings.length ? `\n\nЧастично:\n${warnings.slice(0, 4).join('\n')}` : '';
      alert(
        `Синхронизация ${warnings.length ? 'частичная' : 'OK'}\n` +
          `Магазин #${shopId}\nТовары OpenAPI: ${productCards.length}\n` +
          `Заказы: ${orders.length}\nРасходы: ${expenses.length}\nFBS: ${fbs.length}` +
          warnTxt
      );
      renderSettingsPage();
    } catch (err) {
      const status = err?.status;
      const msg = explainUzumHttpError(status, err?.body || err?.message);
      saveSyncMeta({
        lastSyncAt: new Date().toISOString(),
        lastStatus: productCards.length ? 'partial' : 'error',
        shopId,
        productsCount: productCards.length,
        ordersCount: orders.length,
        expensesCount: expenses.length,
        fbsCount: fbs.length,
        lastError: String(err?.message || err)
      });
      if (productCards.length) await loadAllData();
      _syncBusy = false;
      setSyncBusy(false);
      alert(msg);
      renderSettingsPage();
    }
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
    if (!confirm('Удалить API-ключ Uzum?')) return;
    localStorage.removeItem(TOKEN_KEY);
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
      const price = Number(o.sellerPrice || o.purchasePrice || 0) || 0;
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
      const unitCost = _yoCostMap[sku] || Number(o.purchasePrice || 0) || 0;
      cogs += unitCost * Math.max(amt - ret, 0);
    });
    const sold = Math.max(qty - returns, 0);
    const buyoutDenom = qty + canceled;
    const buyout = buyoutDenom > 0 ? (sold / buyoutDenom) * 100 : 0;
    const gross = sellerProfit || revenue - commission - logistics - cogs;
    const speed = sold / Math.max(_periodDays, 1);
    return { qty, sold, returns, canceled, revenue, commission, logistics, sellerProfit, withdraw, cogs, buyout, gross, speed };
  }

  function currentMetrics() {
    return metricsFor(ordersInRange(periodStartMs(_periodDays), periodEndMs()));
  }

  function prevMetrics() {
    const end = periodStartMs(_periodDays);
    const start = end - _periodDays * 86400000;
    return metricsFor(ordersInRange(start, end));
  }

  function expensesInPeriod() {
    const from = periodStartMs(_periodDays);
    return _expenses.filter((e) => {
      const t = Date.parse(e.dateCreated || e.dateService || e.dateUpdated || '') || Number(e.date) || 0;
      return t >= from;
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
    const from = periodStartMs(_periodDays);
    _orders.forEach((o) => {
      const t = orderDateMs(o);
      if (t < from) return;
      const day = new Date(t).toISOString().slice(0, 10);
      if (!map[day]) map[day] = { orders: 0, buyouts: 0, returns: 0, revenue: 0 };
      const amt = Number(o.amount || 0) || 0;
      const ret = Number(o.amountReturns || 0) || 0;
      map[day].orders += amt;
      map[day].buyouts += Math.max(amt - ret, 0);
      map[day].returns += ret;
      map[day].revenue += (Number(o.sellerPrice || 0) || 0) * Math.max(amt - ret, 0);
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
    const from = periodStartMs(_periodDays);
    _orders.forEach((o) => {
      const t = orderDateMs(o);
      if (t < from) return;
      const dt = new Date(t);
      const dow = (dt.getDay() + 6) % 7;
      grid[dow][dt.getHours()] += Number(o.amount || 1) || 1;
    });
    return grid;
  }

  function insightCards() {
    const m = currentMetrics();
    const cards = [];
    if (m.buyout > 0 && m.buyout < 70) {
      cards.push({
        key: 'buyout-low',
        type: 'danger',
        title: 'Выкуп ниже нормы',
        val: pct(m.buyout),
        actions: [{ label: 'Открыть Финансы', view: 'finance' }]
      });
    }
    const noStock = _products.filter((p) => productStock(p) <= 0).length;
    if (noStock > 0) {
      cards.push({
        key: 'oos',
        type: 'warn',
        title: 'Закончились товары',
        val: `${noStock} SKU`,
        actions: [{ label: 'Ассортимент', view: 'products' }]
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
        actions: [{ label: 'Товары', view: 'products' }]
      });
    }
    if (!_orders.length) {
      cards.push({
        key: 'nosync',
        type: 'info',
        title: 'Нет данных OpenAPI',
        val: 'Синхронизируй API-ключ',
        actions: [{ label: 'Настройки', view: '__settings' }]
      });
    }
    const created = _fbsOrders.filter((o) => o._status === 'CREATED' || o.status === 'CREATED').length;
    if (created > 0) {
      cards.push({
        key: 'fbs-pack',
        type: 'warn',
        title: 'Нужно собрать FBS',
        val: `${created} заказов`,
        actions: [{ label: 'Отгрузки', view: 'shipments' }]
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
        <div class="sc-insight-title">${esc(c.title)}</div>
        <div class="sc-insight-val">${c.val}</div>
        <div class="sc-insight-btns">
          ${btns}
          <button type="button" class="sc-insight-dismiss" data-sc-dismiss="${esc(c.key)}">Отложить</button>
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

    return `<div class="sc-dash-grid">
      <div>
        <div class="sc-kpi-row cols-3">
          ${kpiCard('Заказы', `${cur.qty} шт`, `${moneyShort(cur.revenue)} сум · ${deltaHtml(cur.qty, prev.qty)}`, 'blue')}
          ${kpiCard('Скорость продаж', `${cur.speed.toFixed(1)} шт/день`, deltaHtml(cur.speed, prev.speed), 'orange')}
          ${kpiCard('Выкуп', pct(cur.buyout), deltaHtml(cur.buyout, prev.buyout, 'pp'), cur.buyout >= 70 ? 'green' : 'red')}
        </div>
        <div class="sc-kpi-row cols-3">
          ${kpiCard('Валовая прибыль', money(cur.gross), deltaHtml(cur.gross, prev.gross), 'green')}
          ${kpiCard('Выручка за период', money(cur.revenue), deltaHtml(cur.revenue, prev.revenue), 'blue')}
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
          <span class="sc-pill sc-pill-bad" style="margin-left:auto">${insights.length}</span>
        </div>
        ${insights.length ? insights.map(insightHtml).join('') : '<div class="sc-empty-sub">Пока спокойно — критичных сигналов нет</div>'}
      </div>
    </div>`;
  }

  function viewFinanceOverview() {
    const cur = currentMetrics();
    const prev = prevMetrics();
    const exp = expenseTotal(expensesInPeriod());
    const net = cur.gross - exp;
    return `<div class="sc-subtabs">
        <button type="button" class="sc-subtab active" data-sc-finsub="overview">Обзор</button>
        <button type="button" class="sc-subtab" data-sc-finsub="pnl">ОПиУ</button>
        <button type="button" class="sc-subtab" data-sc-finsub="payout">Календарь выплат</button>
      </div>
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
    return `<div class="sc-subtabs">
        <button type="button" class="sc-subtab" data-sc-finsub="overview">Обзор</button>
        <button type="button" class="sc-subtab active" data-sc-finsub="pnl">ОПиУ</button>
        <button type="button" class="sc-subtab" data-sc-finsub="payout">Календарь выплат</button>
      </div>
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
    return `<div class="sc-subtabs">
        <button type="button" class="sc-subtab" data-sc-finsub="overview">Обзор</button>
        <button type="button" class="sc-subtab" data-sc-finsub="pnl">ОПиУ</button>
        <button type="button" class="sc-subtab active" data-sc-finsub="payout">Календарь выплат</button>
      </div>
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
    return viewFinanceOverview();
  }

  function salesBySku() {
    const map = {};
    const from = periodStartMs(_periodDays);
    _orders.forEach((o) => {
      if (orderDateMs(o) < from) return;
      const sku = String(o.skuTitle || '').trim();
      if (!sku) return;
      if (!map[sku]) map[sku] = { qty: 0, revenue: 0, profit: 0, returns: 0 };
      const amt = Number(o.amount || 0) || 0;
      const ret = Number(o.amountReturns || 0) || 0;
      map[sku].qty += Math.max(amt - ret, 0);
      map[sku].returns += ret;
      map[sku].revenue += (Number(o.sellerPrice || 0) || 0) * Math.max(amt - ret, 0);
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
    const onSale = statusIsOnSale(p.statusRaw || p.status);
    const statusTxt = onSale ? 'В ПРОДАЖЕ' : p.status || (stock > 0 ? 'В ПРОДАЖЕ' : '—');
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
          ${pill(onSale || stock > 0 ? 'ok' : 'bad', statusTxt)}
          ${p.source === 'openapi' ? pill('ok', 'OpenAPI') : pill('warn', 'YO база')}
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
          ${copyFieldHtml('Себестоимость YO', cost ? money(cost) : 'не задана')}
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

  function viewProducts() {
    const sales = salesBySku();
    const rows = _products
      .map((p) => {
        const sku = productSku(p);
        const s = sales[sku] || { qty: 0, revenue: 0, profit: 0 };
        const cost = productCost(p);
        const stock = productStock(p);
        const key = p._key || sku;
        return { p, sku, s, cost, stock, hasc: cost > 0, key };
      })
      .sort((a, b) => b.stock - a.stock || b.s.revenue - a.s.revenue);

    if (!_selectedSkuKey && rows[0]) _selectedSkuKey = rows[0].key;
    const selected = rows.find((r) => r.key === _selectedSkuKey)?.p || null;

    const withStock = rows.filter((r) => r.stock > 0).length;
    const outStock = rows.filter((r) => r.stock <= 0).length;
    const fromApi = _products.some((p) => p.source === 'openapi');

    return `${assortTabsHtml('products')}
      <div class="sc-source-banner ${fromApi ? 'ok' : 'warn'}">
        ${
          fromApi
            ? 'Карточки из <strong>Uzum OpenAPI</strong> · себестоимость подмешивается из YO'
            : 'Кэш OpenAPI пуст — сейчас показана <strong>база YO</strong>. Подожди 2–5 мин после 429 и нажми Синхронизировать.'
        }
      </div>
      <div class="sc-prod-layout">
        <div class="sc-prod-main">
          <div class="sc-kpi-row cols-4">
            ${kpiCard('Всего', String(rows.length), '', 'blue')}
            ${kpiCard('Без остатка', String(outStock), '', outStock ? 'orange' : 'green')}
            ${kpiCard('С остатком', String(withStock), '', 'green')}
            ${kpiCard('Выручка периода', money(rows.reduce((s, r) => s + r.s.revenue, 0)), '', 'blue')}
          </div>
          <div class="sc-toolbar">
            <input class="sc-search" id="sc-prod-q" placeholder="Поиск по SKU, названию…" />
            <button type="button" class="sc-chip active" data-f="all">Все</button>
            <button type="button" class="sc-chip" data-f="cost">С себестоимостью</button>
            <button type="button" class="sc-chip" data-f="nocost">Без</button>
            <button type="button" class="sc-chip" data-f="stock">С остатком</button>
            <button type="button" class="sc-export" data-sc-export="products">CSV</button>
          </div>
          <div class="sc-sku-grid" id="sc-prod-grid">
            ${rows
              .map((r) => {
                const active = r.key === _selectedSkuKey ? ' active' : '';
                const img = r.p.image
                  ? `<img src="${esc(r.p.image)}" alt="" loading="lazy" />`
                  : `<div class="sc-sku-ph">нет фото</div>`;
                return `<button type="button" class="sc-sku-card${active}" data-sc-sku="${esc(r.key)}"
                  data-hascost="${r.hasc}" data-hasstock="${r.stock > 0}">
                  <div class="sc-sku-img">${img}</div>
                  <div class="sc-sku-body">
                    <div class="sc-sku-name">${esc(r.p.name || r.p.title || r.sku)}</div>
                    <div class="sc-sku-row">
                      <span class="sc-sku-stock ${r.stock > 0 ? 'ok' : 'bad'}">${r.stock}</span>
                      <span class="sc-sku-price">${money(r.p.sellPrice || r.p.price || 0)}</span>
                    </div>
                    <div class="sc-sku-sku">${esc(r.sku)}</div>
                  </div>
                </button>`;
              })
              .join('')}
          </div>
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
      .map((sku) => ({ sku, ...sales[sku], cost: (_yoCostMap[sku] || 0) * sales[sku].qty }))
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
    const rows = _products.map((p) => ({
      sku: productSku(p),
      name: p.name || p.title,
      cost: productCost(p),
      stock: productStock(p)
    }));
    return `<div class="sc-assort-tabs">
        <button type="button" class="sc-subtab" data-sc-assort="products">Товары</button>
        <button type="button" class="sc-subtab" data-sc-assort="abcxyz">ABC/XYZ</button>
        <button type="button" class="sc-subtab" data-sc-assort="profit-share">Доли прибыли</button>
        <button type="button" class="sc-subtab" data-sc-assort="unit-economics">Юнит-экономика</button>
        <button type="button" class="sc-subtab active" data-sc-assort="cost">Себестоимость</button>
        <button type="button" class="sc-subtab" data-sc-assort="new-calc">Калькулятор</button>
      </div>
      <p class="sub">Себестоимость берётся из базы YO. Редактирование —
        <button type="button" class="btn-secondary" data-sc-open-cost>Открыть Себестоимость YO</button></p>
      <div class="sc-toolbar"><button type="button" class="sc-export" data-sc-export="cost">CSV</button></div>
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
      const daysNoSale = s.qty > 0 ? 0 : _periodDays;
      const speed = s.qty / Math.max(_periodDays, 1);
      const daysLeft = speed > 0 ? stock / speed : stock > 0 ? 999 : 0;
      return { sku, name: p.name || p.title, stock, sold: s.qty, daysNoSale, daysLeft, cost: productCost(p) };
    });
    const noSales = rows.filter((r) => r.sold === 0 && r.stock > 0).length;
    const storageHint = rows.filter((r) => r.daysNoSale >= 30 && r.stock > 0).length;
    return `<div class="sc-kpi-row cols-3">
        ${kpiCard('Без продаж + остаток', String(noSales), `за ${_periodDays} дн`, 'orange')}
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
    bindEvents();
    const root = document.getElementById('settingsTabContent');
    if (!root) return;
    const token = getToken();
    const meta = getSyncMeta();
    const apiProducts = readLocal(API_PRODUCTS_KEY, []);
    const lastSync = meta.lastSyncAt ? new Date(meta.lastSyncAt).toLocaleString('ru-RU') : 'ещё не было';
    const apiSkuCount = flattenApiProducts(apiProducts).length || meta.productsCount || 0;
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
            При <strong>HTTP 429</strong> Uzum режет частоту запросов. Синхронизация теперь медленная и с паузами —
            подожди 2–5 минут и нажми ещё раз. Товары сохраняются первыми.
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
            ${meta.ordersCount != null ? ` · заказы: ${meta.ordersCount}` : ''}
            ${meta.productsCount != null ? ` · товары: ${meta.productsCount}` : ''}
            ${meta.fbsCount != null ? ` · FBS: ${meta.fbsCount}` : ''}
            ${meta.lastError ? `<br><span style="color:var(--bad)">Ошибка/предупреждение: ${esc(meta.lastError)}</span>` : ''}
          </p>
        </div>
        <div class="sc-settings-block">
          <div class="sc-settings-title">Что тянем из OpenAPI</div>
          <div class="sc-sync-grid">
            <div class="sc-sync-item"><div class="sc-sync-icon">📋</div><div class="sc-sync-body">
              <div class="sc-sync-name">Товары OpenAPI</div><div class="sc-sync-stat">${apiSkuCount} SKU</div>
            </div></div>
            <div class="sc-sync-item"><div class="sc-sync-icon">🛒</div><div class="sc-sync-body">
              <div class="sc-sync-name">Finance orders</div><div class="sc-sync-stat">${_orders.length}</div>
            </div></div>
            <div class="sc-sync-item"><div class="sc-sync-icon">💰</div><div class="sc-sync-body">
              <div class="sc-sync-name">Expenses</div><div class="sc-sync-stat">${_expenses.length}</div>
            </div></div>
            <div class="sc-sync-item"><div class="sc-sync-icon">🚚</div><div class="sc-sync-body">
              <div class="sc-sync-name">FBS orders</div><div class="sc-sync-stat">${_fbsOrders.length}</div>
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
    document.querySelectorAll('.sc-period').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.getAttribute('data-days')) === _periodDays);
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
    _finSub = ['pnl', 'payout'].includes(sub) ? sub : 'overview';
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
      const period = e.target.closest('.sc-period[data-days]');
      if (period) {
        _periodDays = Number(period.getAttribute('data-days')) || 90;
        render();
        return;
      }
      if (e.target.closest('#sc-refresh-btn')) {
        void loadAllData();
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
    if (!_initialized || force) {
      _initialized = true;
      void loadAllData();
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
    renderSettingsPage
  };
})();
