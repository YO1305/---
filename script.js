const firebaseConfig = {
  apiKey: "AIzaSyAFwkbZoRiuCU1NR3-4V_bBCPwh5ZQ5n9g",
  authDomain: "yoa123.firebaseapp.com",
  projectId: "yoa123",
  storageBucket: "yoa123.firebasestorage.app",
  messagingSenderId: "775220046806",
  appId: "1:775220046806:web:46a516f517dabef6f59277"
};

// Инициализируем Firebase БЕЗ изменения остального кода
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
console.log("Firebase успешно подключен к проекту!");
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.warn('Firestore persistence не включен:', err?.code || err?.message || err);
});

window.appState = { products: [], shipments: [], categories: [] };
Object.assign(window.appState, {
  components: [],
  activityLog: [],
  loading: true,
  loadingMap: { products: true, shipments: true, components: true, activityLog: true },
  selectedMarketplace: 'uzum',
  themeDark: false,
  uiMemory: Object.create(null),
  // Uzum payout теперь вводится вручную (без API/кеша).
});
window.state = window.appState;
window.appData = window.appState;
const realtimeState = window.appState;
const FIRESTORE_LIMITS = { products: 4000, shipments: 4000, components: 2000, activityLog: 200 };

// ── WB Узбекистан: справочник и расчёт логистики ──────────────
let WB_UZ_LOGISTICS_TARIFFS = JSON.parse(
  localStorage.getItem('wbUzTariffs') || 'null'
) || [
  { name: 'Салфетки/мелкие', vol: 0.35 },
  { name: 'Наволочки 50×70', vol: 0.54 },
  { name: 'Наволочки 70×70', vol: 0.81 },
  { name: 'Наволочки 70×70 доп', vol: 1.16 },
  { name: 'Простыни 140×200', vol: 2.28 },
  { name: 'Простыни 140 доп', vol: 2.34 },
  { name: 'Простыни 160/180', vol: 3.24 },
  { name: 'Простыни 180 доп', vol: 3.36 },
  { name: 'Постельное (kids)', vol: 4.68 },
  { name: 'Крашёное', vol: 5.58 },
  { name: 'Постельное атлас', vol: 7.77 },
];

// Настройки справочника (редактируются в UI)
const WB_UZ_DEFAULTS = {
  exchangeRate: 168,        // 1 руб = N сум
  buyoutPct: 87,            // % выкупа
  vatPct: 12,               // НДС %
  storageTariff: 42,        // сум/л/день
  safetyMarginPct: 10,      // запас к логистике %
  returnFixed: 7200,        // возврат фиксированный, сум
};

// Двухсегментная формула доставки (из регрессии реального отчёта WB, R²=0.98)
// Погрешность ~4% — лучше чем таблица по объёму
function wbUzDeliveryByVolume(liters) {
  const l = Math.max(0, liters);
  return l <= 1.5
    ? Math.round(1403 + 4600 * l)
    : Math.round(4584 + 2068 * l);
}

// Полный тариф логистики с учётом запаса и выкупа
function wbUzLogistics(liters, buyoutRate, safetyPct, returnFixed) {
  const delivery = wbUzDeliveryByVolume(liters);
  const deliverySafe = Math.round(delivery * (1 + safetyPct / 100));
  const r = Math.max(0.01, buyoutRate);
  return Math.round(deliverySafe / r + returnFixed / r - returnFixed);
}

function wbUzSaveTariffs() {
  try {
    localStorage.setItem('wbUzTariffs', JSON.stringify(WB_UZ_LOGISTICS_TARIFFS));
  } catch {}
}

function wbUzAddTariffRow() {
  WB_UZ_LOGISTICS_TARIFFS = Array.isArray(WB_UZ_LOGISTICS_TARIFFS) ? WB_UZ_LOGISTICS_TARIFFS : [];
  WB_UZ_LOGISTICS_TARIFFS.push({ name: 'Новый товар', vol: 1 });
  wbUzSaveTariffs();
  wbUzRenderTariffsTable();
}

function wbUzRenderTariffsTable() {
  const tbody = document.getElementById('wbUzTariffsBody');
  if (!tbody) return;
  const safetyPct = Math.max(0, n(document.getElementById('wbSafetyPct')?.value) || WB_UZ_DEFAULTS.safetyMarginPct);
  const returnFixed = Math.max(0, n(document.getElementById('wbReturnFixed')?.value) || WB_UZ_DEFAULTS.returnFixed);

  const list = Array.isArray(WB_UZ_LOGISTICS_TARIFFS) ? WB_UZ_LOGISTICS_TARIFFS : [];
  list.sort((a, b) => (Number(a?.vol) || 0) - (Number(b?.vol) || 0));

  const fmt = (v) => new Intl.NumberFormat('ru-RU').format(v);
  tbody.innerHTML = list.map((row, i) => {
    const vol = Math.max(0, Number(row?.vol) || 0);
    const dlv = wbUzDeliveryByVolume(vol);
    const dlvSafe = Math.round(dlv * (1 + safetyPct / 100));
    const name = String(row?.name || '').replace(/"/g, '&quot;');
    return `
      <tr>
        <td><input class="wbuz-name-input" data-idx="${i}" value="${name}" style="width:160px" /></td>
        <td><input class="wbuz-vol-input" data-idx="${i}" type="number" value="${vol}" min="0.1" max="20" step="0.01" style="width:80px" /></td>
        <td class="tar-auto">${fmt(dlv)} сум</td>
        <td class="tar-auto tar-safe">${fmt(dlvSafe)} сум</td>
        <td class="tar-auto">${fmt(returnFixed)} сум</td>
        <td><button class="wbuz-del-btn btn-danger-sm" data-idx="${i}" title="Удалить">✕</button></td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.wbuz-name-input').forEach((el) => {
    el.addEventListener('input', (e) => {
      const idx = Number(e.currentTarget?.dataset?.idx);
      if (!Number.isFinite(idx) || !list[idx]) return;
      list[idx].name = String(e.currentTarget.value || '');
      wbUzSaveTariffs();
    });
  });

  tbody.querySelectorAll('.wbuz-vol-input').forEach((el) => {
    el.addEventListener('input', (e) => {
      const idx = Number(e.currentTarget?.dataset?.idx);
      if (!Number.isFinite(idx) || !list[idx]) return;
      list[idx].vol = Math.max(0, n(e.currentTarget.value));
      wbUzSaveTariffs();
      wbUzRenderTariffsTable();
    });
  });

  tbody.querySelectorAll('.wbuz-del-btn').forEach((el) => {
    el.addEventListener('click', (e) => {
      const idx = Number(e.currentTarget?.dataset?.idx);
      if (!Number.isFinite(idx)) return;
      list.splice(idx, 1);
      WB_UZ_LOGISTICS_TARIFFS = list;
      wbUzSaveTariffs();
      wbUzRenderTariffsTable();
      renderWbUnitEconomics();
    });
  });
}

const initialSnapshotGate = {
  products: { done: false, resolve: null, promise: null },
  shipments: { done: false, resolve: null, promise: null },
  components: { done: false, resolve: null, promise: null }
};

Object.keys(initialSnapshotGate).forEach((k) => {
  initialSnapshotGate[k].promise = new Promise((resolve) => { initialSnapshotGate[k].resolve = resolve; });
});

function markInitialSnapshotReady(key) {
  const slot = initialSnapshotGate[key];
  if (!slot || slot.done) return;
  slot.done = true;
  if (typeof slot.resolve === 'function') slot.resolve(true);
}

function logFirestoreError(context, error) {
  const msg = String(error?.message || '');
  const indexUrl = (msg.match(/https:\/\/console\.firebase\.google\.com\/[^\s)]+/i) || [])[0] || '';
  console.error(`[${context}]`, error);
  if (indexUrl) console.error(`[${context}] Создайте индекс: ${indexUrl}`);
}

function ensureBootSkeleton() {
  let el = document.getElementById('appBootSkeleton');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'appBootSkeleton';
  el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--bg,#f8fafc);display:flex;align-items:center;justify-content:center;padding:24px;';
  el.innerHTML = '<div style="width:min(760px,92vw);display:grid;gap:10px;"><div style="height:16px;background:var(--border-color,#e5e7eb);border-radius:8px;opacity:.8;"></div><div style="height:16px;background:var(--border-color,#e5e7eb);border-radius:8px;opacity:.65;"></div><div style="height:16px;background:var(--border-color,#e5e7eb);border-radius:8px;opacity:.5;"></div><div style="height:220px;background:var(--card-bg,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:14px;"></div></div>';
  document.body.appendChild(el);
  return el;
}

function setBootLoading(active) {
  realtimeState.loading = !!active;
  const el = ensureBootSkeleton();
  el.style.display = active ? 'flex' : 'none';
}

// Делаем тестовую запись, чтобы проверить связь
db.collection('system').doc('test').set({
    status: "Connected",
    time: new Date().toLocaleString()
}).then(() => {
    console.log("Тестовая запись в базу прошла успешно!");
}).catch((error) => {
    console.error("Ошибка записи в базу: ", error);
});

// --- Firestore sync layer (минимально, без вмешательства в расчёты/верстку) ---
function getProductsCollectionRef() {
  try {
    if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') return null;
    return db.collection('products');
  } catch (e) {
    return null;
  }
}

function upsertProductToFirestore(product) {
  const col = getProductsCollectionRef();
  const rid = product?.recordId != null ? String(product.recordId) : '';
  if (!col || !rid) {
    console.error('upsertProductToFirestore: нет коллекции products или recordId.', { hasCol: !!col, rid });
    return Promise.resolve(false);
  }
  // set() в compat SDK = setDoc с merge по смыслу для полной карточки
  return col.doc(rid).set(product)
    .then(() => true)
    .catch((error) => {
      console.error('Ошибка записи товара в Firestore (set): ', error);
      return false;
    });
}

function deleteProductFromFirestore(recordId) {
  const col = getProductsCollectionRef();
  const rid = recordId != null ? String(recordId) : '';
  if (!col || !rid) return;
  col.doc(rid).delete()
    .catch((error) => console.error('Ошибка удаления товара из Firestore: ', error));
}

function getComponentsCollectionRef() {
  try {
    if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') return null;
    return db.collection('components');
  } catch (e) {
    return null;
  }
}

function upsertComponentToFirestore(component) {
  const col = getComponentsCollectionRef();
  const id = component?.id != null ? String(component.id) : '';
  if (!col || !id) return;
  col.doc(id).set(component)
    .catch((error) => console.error('Ошибка записи компонента в Firestore: ', error));
}

function deleteComponentFromFirestore(id) {
  const col = getComponentsCollectionRef();
  const rid = id != null ? String(id) : '';
  if (!col || !rid) return;
  col.doc(rid).delete()
    .catch((error) => console.error('Ошибка удаления компонента в Firestore: ', error));
}

let _componentsRealtimeUnsub = null;
function startComponentsRealtimeSync() {
  const col = getComponentsCollectionRef();
  if (!col) return;
  if (typeof _componentsRealtimeUnsub === 'function') return;
  _componentsRealtimeUnsub = col.limit(FIRESTORE_LIMITS.components).onSnapshot((snap) => {
    const prevLen = realtimeState.components.length;
    const next = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};
      const id = data.id != null && String(data.id) !== '' ? data.id : doc.id;
      next.push({ ...data, id, createdAt: data.createdAt || new Date().toISOString() });
    });
    realtimeState.loadingMap.components = false;
    markInitialSnapshotReady('components');
    writeStore(STORAGE_KEYS.components, next);
    realtimeState.categories = Array.from(new Set(readProductsSafe().map((p) => String(extractProductCategory(p) || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));
    const changed = next.length !== prevLen;
    if (document.querySelector('.page-panel.active')?.id === 'components-tab' || changed) renderComponentsList();
    updateComponentsAutocomplete();
    if (wmsState.assemblingOpen) renderWmsBoxes();
  }, (error) => {
    logFirestoreError('onSnapshot(components)', error);
  });
}

let _productsRealtimeUnsub = null;
function startProductsRealtimeSync() {
  const col = getProductsCollectionRef();
  if (!col) return;
  if (typeof _productsRealtimeUnsub === 'function') return; // уже запущено
  _productsRealtimeUnsub = col.limit(FIRESTORE_LIMITS.products).onSnapshot((snap) => {
    const hadRows = realtimeState.products.length > 0;
    const changes = snap.docChanges();
    const next = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};
      const recordId = data.recordId != null && String(data.recordId) !== '' ? data.recordId : doc.id;
      next.push({ ...data, recordId, id: data.id ?? String(recordId) });
    });
    realtimeState.loadingMap.products = false;
    markInitialSnapshotReady('products');
    if (!next.length && hadRows) console.warn('products snapshot пустой после непустого состояния.');
    writeStore(STORAGE_KEYS.products, next);
    realtimeState.categories = Array.from(new Set(next.map((p) => String(extractProductCategory(p) || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ru'));
    if (changes.some((x) => x.type !== 'added') && wmsState.assemblingOpen) renderWmsDraftSummary();
    renderEverything();
  }, (error) => {
    logFirestoreError('onSnapshot(products)', error);
  });
}

function getShipmentsCollectionRef() {
  try {
    if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') return null;
    return db.collection('shipments');
  } catch (e) {
    return null;
  }
}

/** Запись поставки в Firestore (set с полным документом — аналог setDoc merge). */
function upsertShipmentToFirestore(shipment) {
  const col = getShipmentsCollectionRef();
  const id = shipment?.id != null ? String(shipment.id) : '';
  if (!col || !id) {
    console.error('upsertShipmentToFirestore: нет коллекции shipments или id поставки.', shipment);
    return Promise.resolve(false);
  }
  return col.doc(id).set(shipment, { merge: true })
    .then(() => true)
    .catch((err) => {
      console.error('Ошибка записи поставки в Firestore (set): ', err);
      return false;
    });
}

async function deleteShipmentFromFirestore(shipmentId) {
  const col = getShipmentsCollectionRef();
  const id = shipmentId != null ? String(shipmentId) : '';
  if (!col || !id) return false;
  try {
    // compat-API: эквивалент await deleteDoc(docRef)
    await col.doc(id).delete();
    return true;
  } catch (err) {
    console.error('Ошибка удаления поставки из Firestore: ', err);
    return false;
  }
}

let _shipmentsRealtimeUnsub = null;
function startShipmentsRealtimeSync() {
  const col = getShipmentsCollectionRef();
  if (!col) return;
  if (typeof _shipmentsRealtimeUnsub === 'function') return;
  _shipmentsRealtimeUnsub = col.limit(FIRESTORE_LIMITS.shipments).onSnapshot((snap) => {
    const hadRows = realtimeState.shipments.length > 0;
    const next = [];
    snap.forEach((doc) => {
      const data = doc.data() || {};
      const id = data.id != null && String(data.id) !== '' ? String(data.id) : doc.id;
      next.push({ ...data, id });
    });
    realtimeState.loadingMap.shipments = false;
    markInitialSnapshotReady('shipments');
    if (!next.length && hadRows) console.warn('shipments snapshot пустой после непустого состояния.');
    writeStore(STORAGE_KEYS.shipments, next);
    if (wmsState.assemblingOpen) renderWmsHistory();
    if (wmsState.assemblingOpen) renderWmsDraftSummary();
    renderEverything();
  }, (error) => {
    logFirestoreError('onSnapshot(shipments)', error);
  });
}

let _activityRealtimeUnsub = null;
function startActivityLogRealtimeSync() {
  const col = getActivityLogCollectionRef();
  if (!col || typeof _activityRealtimeUnsub === 'function') return;
  _activityRealtimeUnsub = col.orderBy('timestamp', 'desc').limit(FIRESTORE_LIMITS.activityLog).onSnapshot((snap) => {
    const rows = [];
    snap.forEach((doc) => rows.push({ id: doc.id, ...(doc.data() || {}) }));
    realtimeState.activityLog = rows;
    realtimeState.loadingMap.activityLog = false;
    if (document.querySelector('.page-panel.active')?.id === 'stock-analytics-tab') {
      void renderStockAnalyticsPage();
    }
  }, (error) => {
    logFirestoreError('onSnapshot(activity_log)', error);
  });
}

function refreshProductsFromFirestoreAndRender() {
  filterProducts();
}

function renderEverything() {
  const activeId = document.querySelector('.page-panel.active')?.id || 'products-tab';
  if (activeId === 'products-tab' || activeId === 'dashboard-page') filterProducts();
  if (activeId === 'shipments-tab') renderWmsHistory();
  if (activeId === 'stock-analytics-tab') void renderStockAnalyticsPage();
  if (activeId === 'components-tab') renderComponentsList();
  if (currentDetailRecordId != null && String(currentDetailRecordId) !== '') {
    const p = findProductByRecordId(readProductsSafe(), currentDetailRecordId);
    if (p) renderProductDetail(p);
  }
}

function startUnifiedRealtimeListeners() {
  const tasks = [startProductsRealtimeSync, startShipmentsRealtimeSync, startComponentsRealtimeSync, startActivityLogRealtimeSync];
  tasks.forEach((fn) => { try { fn(); } catch (e) { console.error('bootstrapRealtimeData: ', e); } });
}
setBootLoading(true);
startUnifiedRealtimeListeners();
Promise.all([
  initialSnapshotGate.products.promise,
  initialSnapshotGate.shipments.promise,
  initialSnapshotGate.components.promise
]).then(() => {
  setBootLoading(false);
  renderEverything();
}).catch((e) => {
  logFirestoreError('initial_snapshot_bundle', e);
  setBootLoading(false);
});

// ——— Audit log (activity_log) + история остатков (inventory_history) ———
function getAuditUserId() {
  if (!realtimeState.auditUserId) {
    realtimeState.auditUserId = `staff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
  return realtimeState.auditUserId;
}

function getActivityLogCollectionRef() {
  try {
    if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') return null;
    return db.collection('activity_log');
  } catch {
    return null;
  }
}

function getInventoryHistoryCollectionRef() {
  try {
    if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') return null;
    return db.collection('inventory_history');
  } catch {
    return null;
  }
}

function writeActivityLogToFirestore(entry) {
  const col = getActivityLogCollectionRef();
  if (!col) {
    console.error('activity_log: коллекция недоступна (проверьте Firebase и правила).');
    return Promise.resolve(null);
  }
  const doc = {
    timestamp: entry.timestamp || new Date().toISOString(),
    user_id: getAuditUserId(),
    action_type: String(entry.action_type || 'unknown'),
    product_id: entry.product_id != null ? String(entry.product_id) : '',
    old_value: entry.old_value !== undefined ? entry.old_value : null,
    new_value: entry.new_value !== undefined ? entry.new_value : null,
    context: entry.context && typeof entry.context === 'object' ? entry.context : null
  };
  return col.add(doc).catch((err) => {
    console.error('activity_log.add: ', err);
    return null;
  });
}

function writeInventoryHistoryToFirestore(entry) {
  const col = getInventoryHistoryCollectionRef();
  if (!col) {
    console.error('inventory_history: коллекция недоступна (проверьте Firebase и правила).');
    return Promise.resolve(null);
  }
  const doc = {
    timestamp: entry.timestamp || new Date().toISOString(),
    user_id: getAuditUserId(),
    product_id: String(entry.product_id || ''),
    old_qty: Math.max(0, Math.floor(Number(entry.old_qty ?? 0))),
    new_qty: Math.max(0, Math.floor(Number(entry.new_qty ?? 0))),
    source: String(entry.source || entry.action_type || 'unknown'),
    action_type: entry.action_type || null
  };
  return col.add(doc).catch((err) => {
    console.error('inventory_history.add: ', err);
    return null;
  });
}

/** Синхронная фиксация в Firestore: история остатков + запись в activity_log (формат по ТЗ). */
function recordProductStockAudit(productId, oldQty, newQty, actionType, context) {
  const pid = productId != null ? String(productId) : '';
  const o = Math.max(0, Math.floor(Number(oldQty ?? 0)));
  const n = Math.max(0, Math.floor(Number(newQty ?? 0)));
  if (!pid || o === n) return;
  void writeInventoryHistoryToFirestore({
    product_id: pid,
    old_qty: o,
    new_qty: n,
    source: actionType,
    action_type: actionType
  });
  void writeActivityLogToFirestore({
    action_type: actionType,
    product_id: pid,
    old_value: o,
    new_value: n,
    context: context && typeof context === 'object' ? context : null
  });
}

function recordActivityLogOnly(actionType, productId, oldValue, newValue, context) {
  void writeActivityLogToFirestore({
    action_type: actionType,
    product_id: productId != null ? String(productId) : '',
    old_value: oldValue !== undefined ? oldValue : null,
    new_value: newValue !== undefined ? newValue : null,
    context: context && typeof context === 'object' ? context : null
  });
}

function parseShipmentRecordDate(sh) {
  const raw = String(sh?.date || sh?.shipmentDate || (sh?.updatedAt || '').slice(0, 10) || '').trim();
  if (!raw) return null;
  const d = new Date(raw.length <= 10 ? `${raw}T12:00:00` : raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mondayKeyFromDate(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x.toISOString().slice(0, 10);
}

function isCurrentCalendarMonth(d) {
  if (!d) return false;
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
}

function collectShipmentFlatLinesForAnalytics(sh) {
  if (sh?.version === 2 && Array.isArray(sh.boxes)) {
    const out = [];
    sh.boxes.forEach(b => (b.items || []).forEach(it => out.push(it)));
    return out;
  }
  return Array.isArray(sh?.items) ? sh.items : [];
}

function lineProductRecordId(it) {
  return it?.productRecordId != null && String(it.productRecordId) !== '' ? String(it.productRecordId) : '';
}

/** Агрегация отправленных поставок: текущий месяц по productRecordId и недели (понедельник ISO-дата). */
function buildShippedQtyAnalytics(shipments) {
  const byProductMonth = new Map();
  const byWeekTotal = new Map();
  const byProductWeek = new Map();
  const arr = Array.isArray(shipments) ? shipments : [];
  arr.forEach(sh => {
    if (shipmentRecordStatus(sh) === 'draft') return;
    const d = parseShipmentRecordDate(sh);
    if (!d) return;
    const wk = mondayKeyFromDate(d);
    const inMonth = isCurrentCalendarMonth(d);
    const lines = collectShipmentFlatLinesForAnalytics(sh);
    lines.forEach(it => {
      const q = Math.max(0, Math.floor(Number(it?.qty ?? it?.quantity ?? 0)));
      if (!q) return;
      const rid = lineProductRecordId(it);
      if (!rid) return;
      if (inMonth) {
        byProductMonth.set(rid, (byProductMonth.get(rid) || 0) + q);
      }
      const wkKey = `${wk}`;
      byWeekTotal.set(wkKey, (byWeekTotal.get(wkKey) || 0) + q);
      const pw = `${rid}\t${wkKey}`;
      byProductWeek.set(pw, (byProductWeek.get(pw) || 0) + q);
    });
  });
  return { byProductMonth, byWeekTotal, byProductWeek };
}

let _stockWeekChartInstance = null;

function fetchRecentActivityLogs(limit) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 80));
  return (Array.isArray(realtimeState.activityLog) ? realtimeState.activityLog : []).slice(0, lim);
}

async function renderStockAnalyticsPage() {
  const topHost = document.getElementById('stockAnalyticsTopBody');
  const weekMeta = document.getElementById('stockAnalyticsWeekMeta');
  const auditHost = document.getElementById('stockAuditLogBody');
  const canvas = document.getElementById('stockAnalyticsWeekChart');
  if (!topHost || !auditHost) return;

  const shipments = readShipmentsSafe();
  const { byProductMonth, byWeekTotal } = buildShippedQtyAnalytics(shipments);
  const products = readProductsSafe();
  const byId = new Map(products.map(p => [String(p.recordId), p]));

  const topRows = Array.from(byProductMonth.entries())
    .map(([rid, qty]) => {
      const p = byId.get(String(rid));
      const sku = String(p?.uzumSku ?? p?.uzum_sku ?? p?.calc?.mpSkuUzum ?? p?.sku ?? '').trim();
      const a1 = String(p?.article1c ?? '').trim();
      const c1 = String(p?.code1c ?? '').trim();
      return {
        rid,
        qty,
        name: (p?.name || a1 || sku || rid).toString(),
        article1c: a1,
        code1c: c1,
        sku: sku || '—'
      };
    })
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 40);

  topHost.innerHTML = topRows.length
    ? `<div class="table-wrap"><table class="stock-analytics-table"><thead><tr><th>#</th><th>Товар</th><th>Артикул 1С</th><th>Код 1С</th><th>SKU</th><th>Отгружено, шт (месяц)</th></tr></thead><tbody>${
      topRows.map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.article1c || '—')}</td><td>${escapeHtml(r.code1c || '—')}</td><td>${escapeHtml(r.sku)}</td><td><strong>${r.qty.toLocaleString('ru-RU')}</strong></td></tr>`).join('')
    }</tbody></table></div>`
    : '<p class="muted">Нет отправленных поставок с датой в текущем календарном месяце.</p>';

  const weeksSorted = Array.from(byWeekTotal.keys()).sort();
  const labels = weeksSorted;
  const values = weeksSorted.map(k => byWeekTotal.get(k) || 0);
  if (weekMeta) {
    weekMeta.textContent = weeksSorted.length
      ? `Недели по понедельнику строки даты поставки: ${weeksSorted[0]} … ${weeksSorted[weeksSorted.length - 1]}`
      : 'Нет данных по неделям.';
  }

  if (canvas && typeof Chart !== 'undefined') {
    if (_stockWeekChartInstance) {
      _stockWeekChartInstance.destroy();
      _stockWeekChartInstance = null;
    }
    _stockWeekChartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Отправлено, шт (все товары)',
          data: values,
          backgroundColor: 'rgba(109, 40, 217, 0.55)',
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: true } },
        scales: {
          x: { ticks: { maxRotation: 45, minRotation: 0 } },
          y: { beginAtZero: true }
        }
      }
    });
  }

  const logs = fetchRecentActivityLogs(80);
  auditHost.innerHTML = logs.length
    ? `<div class="table-wrap"><table class="stock-analytics-table"><thead><tr><th>Время</th><th>Действие</th><th>Товар</th><th>Было</th><th>Стало</th><th>Пользователь</th></tr></thead><tbody>${
      logs.map(row => {
        const ts = row.timestamp ? escapeHtml(fmtDateTime(row.timestamp)) : '—';
        const ov = row.old_value != null ? escapeHtml(String(row.old_value)) : '—';
        const nv = row.new_value != null ? escapeHtml(String(row.new_value)) : '—';
        return `<tr><td>${ts}</td><td>${escapeHtml(row.action_type || '—')}</td><td>${escapeHtml(String(row.product_id || '—'))}</td><td>${ov}</td><td>${nv}</td><td class="muted">${escapeHtml(String(row.user_id || '—'))}</td></tr>`;
      }).join('')
    }</tbody></table></div>`
    : '<p class="muted">Журнал пуст или нет доступа к коллекции <code>activity_log</code>.</p>';
}

const moneyFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const pctFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

function n(v) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}
function fmtMoney(v) {
  return `${moneyFmt.format(v)} сум`;
}
const rubFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
function fmtRub(v) {
  return `${rubFmt.format(Number(v) || 0)} ₽`;
}
function fmtPct(v) {
  return `${pctFmt.format(v)}%`;
}

/** Фиксированный курс для справочного пересчёта ₽ в экспорте товара (без UI). */
const RUB_UZS_FOR_EXPORT = 130;

function vatFromAmount(amount, rate, mode) {
  if (rate <= 0 || amount <= 0) return 0;
  return mode === 'with'
    ? amount * rate / (100 + rate)
    : amount * rate / 100;
}
function purchaseInputVat(amount, rate, mode) {
  if (rate <= 0 || amount <= 0) return 0;
  return mode === 'with' ? amount * rate / (100 + rate) : 0;
}
function calcLogistics(roundedLiters) {
  if (roundedLiters <= 0) return 0;
  // Uzum (новый тариф по литрам): базовая ставка для МГТ — 5 000 сум за первый литр
  const value = 5000 + Math.max(0, roundedLiters - 1) * 250;
  return Math.min(value, 50000);
}

function oldTariffCategoryBySumCm(sumCm) {
  if (sumCm <= 60) return 'MGT';
  if (sumCm <= 170) return 'SGT';
  return 'KGT';
}

function calcLogisticsOldTariff(sumCm, price) {
  const category = oldTariffCategoryBySumCm(sumCm);
  // Uzum (старый тариф по габаритам): базовые ставки по категориям.
  // МГТ: 5 000 сум, СГТ: 8 000 сум.
  const table = {
    MGT: 5000,
    SGT: 8000,
    KGT: 30000
  };
  return { category, amount: table[category] ?? 0 };
}

function calcStoragePerDayOldTariff(category, turnover, stockStatus, newSkuDays) {
  // Оставляем правило "новый SKU: первые 30 дней бесплатно" как и в текущем калькуляторе
  if (stockStatus === 'new' && Number(newSkuDays || 0) <= 30) {
    return { amount: 0, rate: 0, reason: 'Новый SKU: первые 30 дней хранения бесплатные.' };
  }

  const cfg = {
    MGT: { rate: 60, freeDays: 60, label: 'МГТ' },
    SGT: { rate: 250, freeDays: 30, label: 'СГТ' },
    KGT: { rate: 1500, freeDays: 15, label: 'КГТ' }
  }[category] || { rate: 0, freeDays: 0, label: '' };

  const t = Number(turnover || 0);
  if (t <= cfg.freeDays) {
    return { amount: 0, rate: 0, reason: `${cfg.label}: хранение бесплатное первые ${cfg.freeDays} дней.`.trim() };
  }
  return { amount: cfg.rate, rate: cfg.rate, reason: `${cfg.label}: ${cfg.rate} сум/день, бесплатно первые ${cfg.freeDays} дней.`.trim() };
}
function calcStoragePerDay(roundedLiters, turnover, stockStatus, newSkuDays) {
  let rate = 0;
  let reason = '';

  if (stockStatus === 'new' && newSkuDays <= 30) {
    reason = 'Новый SKU: первые 30 дней хранения бесплатные.';
    return { amount: 0, rate: 0, reason };
  }
  if (turnover <= 60) {
    reason = 'Оборачиваемость до 60 дней включительно: хранение бесплатное.';
    return { amount: 0, rate: 0, reason };
  }
  if (turnover <= 180) {
    rate = 12;
    reason = 'Оборачиваемость 61–180 дней: 12 сум за литр в день.';
  } else if (turnover <= 360) {
    rate = 18;
    reason = 'Оборачиваемость 181–360 дней: 18 сум за литр в день.';
  } else {
    rate = 24;
    reason = 'Оборачиваемость 361+ дней: 24 сум за литр в день.';
  }
  const amount = Math.min(roundedLiters * rate, 5000);
  return { amount, rate, reason };
}

const state = {
  linkedProduct: {
    active: false,
    sku: '',
    costGross: 0,
    costNet: 0,
    inputVat: 0,
    hasVat: false,
    storageLinked: false,
    stockStatus: 'existing',
    turnover: 0,
    newSkuDays: 0,
    length: 0,
    width: 0,
    height: 0
  },
  /** null — следующее «Сохранить в базу» создаёт новую строку; иначе обновляем строку с этим recordId */
  productsEdit: { recordId: null },
  /** После «Редактировать» из детализации — вернуть в модалку после сохранения */
  costEditSession: { returnToDetailModal: false }
};

const wmsState = {
  assemblingOpen: false,
  /** При сохранении/редактировании черновика — id записи текущей сессии */
  editingDraftId: null,
  /** Снапшот исходной поставки при редактировании уже отправленной (sent). */
  editingOriginalSent: null,
  /** Новая сборка (ещё не привязана к сохранённому черновику) — при закрытии возвращаем остатки по строкам. */
  sessionIsNewAssembly: false,
  modalBoxId: null,
  pickSelected: null,
  draft: { boxes: [] },
  shipmentCalcEdit: { active: false, boxId: null, lineId: null },
  _costFormBackup: null,
  _unitEconModal: { ctx: null },
  _draftToastTimer: null
};

function newWmsBoxId() {
  return `wb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function recordIdsEqual(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/** Нормализует штрихкод Uzum Market (строка, по умолчанию пустая). */
function normalizeUzumBarcode(value) {
  return value == null ? '' : String(value).trim();
}

/** Всегда массив товаров из real-time снимка Firestore. */
function readProductsSafe() {
  const arr = Array.isArray(realtimeState.products) ? realtimeState.products : [];
  return arr
    .filter(p => p && typeof p === 'object')
    .map((p, i) => {
      const next = { ...p };
      if (next.recordId == null || String(next.recordId) === '') {
        next.recordId = next.id != null ? String(next.id) : `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 9)}`;
      }
      if (!String(next.article1c || '').trim() && String(next.name || '').trim()) {
        next.article1c = String(next.name).trim();
      }
      next.uzum_barcode = normalizeUzumBarcode(next.uzum_barcode);
      return next;
    });
}

function findProductByRecordId(products, recordId) {
  return products.find(p => recordIdsEqual(p.recordId, recordId));
}

/** Поиск по базе и в модалке поставки: артикул 1С, коды МП, имя, внутренний ключ. */
function productSearchMatchesQuery(p, qq) {
  if (!qq) return true;
  const fields = [
    p.name,
    p.title,
    p.article1c,
    p.article_1c,
    // Новая схема хранения "публичных" SKU маркетплейсов
    p.uzumSku,
    p.uzum_barcode,
    p.wbSku,
    p.yandexSku,
    p.uzum_sku,
    p.wb_nmid,
    p.wb_nm_id,
    p.nmid,
    p.yandex_sku,
    p.sku,
    p.code1c,
    p.sku_wb,
    p.wb_sku,
    p.mp_wb_sku,
    p.calc?.mpSkuUzum,
    p.calc?.mpWbNmid,
    p.calc?.mpSkuYandex
  ];
  return fields.some(x => String(x ?? '').toLowerCase().includes(qq));
}

/** Скрытое поле sku: для WMS/легаси — артикул 1С или первый заполненный код МП. */
function syncCostFormHiddenSku() {
  const el = document.getElementById('sku');
  if (!el) return;
  const a = document.getElementById('productArticle1c')?.value.trim() || '';
  const u = document.getElementById('mpSkuUzum')?.value.trim() || '';
  const w = document.getElementById('mpWbNmid')?.value.trim() || '';
  const y = document.getElementById('mpSkuYandex')?.value.trim() || '';
  el.value = a || u || w || y;
}

function getCurrentMarketplace() {
  return String(realtimeState.selectedMarketplace || 'uzum');
}

function initUzumCostWarehouseListeners() {
  const ids = [
    'uzumLengthCm', 'uzumWidthCm', 'uzumHeightCm',
    'productOnWarehouse', 'productStorageDays', 'productTurnover', 'productStockStatus', 'productNewSkuDays'
  ];
  ids.forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      updateUzumLitersDisplay();
      syncUzumCostWarehouseUi();
      renderProductCost();
      renderUnit();
    });
    document.getElementById(id)?.addEventListener('change', () => {
      updateUzumLitersDisplay();
      syncUzumCostWarehouseUi();
      renderProductCost();
      renderUnit();
    });
  });
}

/** Вкладка «Себестоимость»: полная форма для Uzum и WB; для Yandex — заглушка. */
function applyCostTabMarketplaceLayout() {
  const mp = getCurrentMarketplace();
  const yandexStub = mp === 'yandex';
  const nonUz = mp !== 'uzum';
  document.querySelectorAll('.cost-uzum-only').forEach(el => el.classList.toggle('hidden', nonUz));
  document.querySelectorAll('.cost-uzum-storage-only').forEach(el => el.classList.toggle('hidden', nonUz));
  document.querySelectorAll('.cost-wb-dims-hint').forEach(el => el.classList.toggle('hidden', mp !== 'wb'));
  const flow = document.getElementById('costTabUzumFlow');
  if (flow) flow.classList.toggle('hidden', yandexStub);
  const resUz = document.getElementById('costTabResultsUzum');
  if (resUz) resUz.classList.toggle('hidden', yandexStub);
  document.getElementById('costWbRubWrap')?.classList.toggle('hidden', mp !== 'wb');
  const stubStack = document.getElementById('costTabMpStubStack');
  if (stubStack) {
    if (yandexStub) {
      stubStack.innerHTML = '<h2>Калькуляция</h2><p>Раздел в разработке</p>';
      stubStack.classList.remove('hidden');
    } else {
      stubStack.innerHTML = '';
      stubStack.classList.add('hidden');
    }
  }
  const stubRes = document.getElementById('costTabMpStubResults');
  if (stubRes) {
    if (yandexStub) {
      stubRes.innerHTML = '<h2>Итоги</h2><p>Раздел в разработке</p>';
      stubRes.classList.remove('hidden');
    } else {
      stubRes.innerHTML = '';
      stubRes.classList.add('hidden');
    }
  }
  const sendBtn = document.getElementById('sendToUnitBtn');
  if (sendBtn) {
    sendBtn.closest('div')?.classList.toggle('hidden', yandexStub);
    if (!yandexStub) {
      sendBtn.textContent = mp === 'wb' ? '➕ Перейти к Unit-экономике WB' : 'Перенести в юнит-экономику →';
    }
  }
  const sendHint = document.getElementById('sendToUnitHint');
  if (sendHint && !yandexStub) {
    sendHint.textContent = mp === 'wb'
      ? 'Переносит в WB-юнит: артикул 1С, литраж по габаритам и себестоимость в ₽ по курсу из поля выше.'
      : 'При переносе подставятся себестоимость в сумах, НДС и ВГХ (если товар на складе Uzum) в юнит Uzum.';
  }
}

/** Вкладка «Юнит-экономика»: Uzum (сум) vs WB (₽, отдельная модель). */
function applyUnitTabMarketplaceLayout() {
  const mp = getCurrentMarketplace();
  const isWb = mp === 'wb';
  document.querySelectorAll('.unit-tab-wb-only').forEach(el => el.classList.toggle('hidden', !isWb));
  document.querySelectorAll('.unit-tab-uzum-only').forEach(el => el.classList.toggle('hidden', isWb));
}

function updateMpContextHint() {
  const el = document.getElementById('mpContextHint');
  if (!el) return;
  const mp = getCurrentMarketplace();
  if (mp === 'wb') {
    el.innerHTML = 'Сейчас <strong>WB</strong>: калькуляция в сумах с пересчётом в ₽; юнит-экономика — в рублях по модели 2026. Во вкладке «Аналитика» — глубокая аналитика по еженедельной детализации WB (все суммы в сумах); «Поставки» — заглушка.';
  } else if (mp === 'yandex') {
    el.innerHTML = 'Сейчас <strong>Yandex</strong>: «Себестоимость» в разработке; «Аналитика» и «Поставки» — заглушка. Юнит — по модели Uzum.';
  } else {
    el.innerHTML = '<strong>Uzum</strong>: блоки А–Г ниже; калькуляция товара — во вкладке «Себестоимость».';
  }
}

/** Поставки и аналитика Uzum — только при выбранном uzum; база и калькуляция всегда. */
function applyMarketplaceSectionVisibility() {
  const mp = getCurrentMarketplace();
  const uzumOnly = mp === 'uzum';
  const analyticsEnabled = mp === 'uzum' || mp === 'wb';
  document.getElementById('shipmentsTabMpBody')?.classList.toggle('hidden', !uzumOnly);
  document.getElementById('shipmentsTabMpStub')?.classList.toggle('hidden', uzumOnly);
  document.getElementById('stockAnalyticsUzumBody')?.classList.toggle('hidden', !uzumOnly);
  document.getElementById('stockAnalyticsMpStub')?.classList.toggle('hidden', uzumOnly);
  document.getElementById('analyticsTabMpBody')?.classList.toggle('hidden', !analyticsEnabled);
  document.getElementById('analyticsTabMpStub')?.classList.toggle('hidden', analyticsEnabled);
  applyAnalyticsTabMarketplaceLayout();
  if (mp === 'wb') {
    if (typeof loadWbReportingUzsIntoInputs === 'function') loadWbReportingUzsIntoInputs();
    if (typeof updateWbReportingUzsDisplay === 'function') updateWbReportingUzsDisplay();
  }
  const activeId = document.querySelector('.page-panel.active')?.id || '';
  if (activeId === 'shipments-tab' && uzumOnly) {
    if (typeof renderWmsHistory === 'function') renderWmsHistory();
    if (typeof renderWmsDraftSummary === 'function') renderWmsDraftSummary();
  }
  if (activeId === 'analytics-tab' && analyticsEnabled) {
    if (mp === 'uzum' && typeof renderAnalyticsReportsList === 'function') renderAnalyticsReportsList();
    if (mp === 'wb' && typeof renderWbAnalyticsReportsList === 'function') renderWbAnalyticsReportsList();
  }
  if (activeId === 'stock-analytics-tab' && uzumOnly && typeof renderStockAnalyticsPage === 'function') {
    void renderStockAnalyticsPage();
  }
}

// ——— Печать этикеток (термопринтер) ———
const labelPrintState = {
  selectedRecordId: null,
  dropdownOpen: false
};

const LABEL_SIZE_PRESETS = {
  '58x40': { width: 58, height: 40 },
  '75x120': { width: 75, height: 120 },
  '100x50': { width: 100, height: 50 }
};

function getProductLabelSkuLines(product) {
  const p = product || {};
  const lines = [];
  const wb = String(p.wbSku ?? p.wb_nmid ?? p.wb_nm_id ?? p.nmid ?? p.calc?.mpWbNmid ?? '').trim();
  const uz = String(p.uzumSku ?? p.uzum_sku ?? p.calc?.mpSkuUzum ?? '').trim();
  const ya = String(p.yandexSku ?? p.yandex_sku ?? p.calc?.mpSkuYandex ?? '').trim();
  if (wb) lines.push({ label: 'SKU WB', value: wb });
  if (uz) lines.push({ label: 'SKU Uzum', value: uz });
  if (ya) lines.push({ label: 'SKU Yandex', value: ya });
  return lines;
}

function sanitizePdfFilenamePart(value) {
  return String(value || 'товар')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'товар';
}

function getSelectedLabelProduct() {
  const rid = labelPrintState.selectedRecordId;
  if (rid == null || String(rid) === '') return null;
  return findProductByRecordId(readProductsSafe(), rid);
}

function renderLabelProductPreview(product) {
  const preview = document.getElementById('labelProductPreview');
  const articleEl = document.getElementById('labelPreviewArticle1c');
  const codeEl = document.getElementById('labelPreviewCode1c');
  const skuList = document.getElementById('labelPreviewSkuList');
  if (!preview || !product) return;
  const article1c = String(product.article1c || product.name || '').trim() || '—';
  const code1c = String(product.code1c || '').trim() || '—';
  if (articleEl) articleEl.textContent = article1c;
  if (codeEl) codeEl.textContent = code1c;
  if (skuList) {
    const skuLines = getProductLabelSkuLines(product);
    skuList.innerHTML = skuLines.length
      ? skuLines.map((line) => `<div class="sku-line"><strong>${escapeHtml(line.label)}:</strong> ${escapeHtml(line.value)}</div>`).join('')
      : '<div class="sku-line muted">SKU маркетплейсов не заполнены</div>';
  }
  preview.classList.remove('hidden');
}

function clearLabelProductSelection() {
  labelPrintState.selectedRecordId = null;
  document.getElementById('labelProductPreview')?.classList.add('hidden');
}

function setLabelProductSelection(product) {
  if (!product?.recordId) return;
  labelPrintState.selectedRecordId = String(product.recordId);
  const search = document.getElementById('labelProductSearch');
  const article1c = String(product.article1c || product.name || '').trim();
  const code1c = String(product.code1c || '').trim();
  if (search) {
    search.value = [article1c, code1c].filter(Boolean).join(' · ');
  }
  renderLabelProductPreview(product);
  hideLabelProductDropdown();
}

function hideLabelProductDropdown() {
  labelPrintState.dropdownOpen = false;
  const dropdown = document.getElementById('labelProductSearchDropdown');
  if (dropdown) {
    dropdown.classList.add('hidden');
    dropdown.innerHTML = '';
  }
}

function showLabelProductDropdown() {
  labelPrintState.dropdownOpen = true;
  document.getElementById('labelProductSearchDropdown')?.classList.remove('hidden');
}

function renderLabelProductSearchDropdown(query) {
  const dropdown = document.getElementById('labelProductSearchDropdown');
  if (!dropdown) return;
  const qq = String(query || '').trim();
  const products = readProductsSafe();
  const filtered = qq ? products.filter((p) => productSearchMatchesQuery(p, qq)) : products;
  dropdown.innerHTML = '';
  if (!filtered.length) {
    dropdown.innerHTML = '<div class="label-product-option muted">Ничего не найдено</div>';
    showLabelProductDropdown();
    return;
  }
  filtered.slice(0, 40).forEach((p) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'label-product-option';
    if (recordIdsEqual(p.recordId, labelPrintState.selectedRecordId)) {
      option.classList.add('active');
    }
    const article1c = String(p.article1c || p.name || '').trim() || '—';
    const code1c = String(p.code1c || '').trim() || '—';
    const skuLines = getProductLabelSkuLines(p);
    const skuHint = skuLines.length
      ? skuLines.map((line) => `${line.label}: ${line.value}`).join(' · ')
      : 'SKU не заполнены';
    option.innerHTML = `
      <div class="title">${escapeHtml(article1c)}</div>
      <div class="meta">Код 1С: ${escapeHtml(code1c)} · ${escapeHtml(skuHint)}</div>
    `;
    option.addEventListener('mousedown', (e) => {
      e.preventDefault();
      setLabelProductSelection(p);
    });
    dropdown.appendChild(option);
  });
  showLabelProductDropdown();
}

function syncLabelCustomSizeVisibility() {
  const preset = document.getElementById('labelSizePreset')?.value || '58x40';
  const custom = document.getElementById('labelCustomSizeFields');
  if (custom) custom.classList.toggle('hidden', preset !== 'custom');
}

function getLabelDimensionsFromUi() {
  const preset = document.getElementById('labelSizePreset')?.value || '58x40';
  if (preset !== 'custom') {
    const size = LABEL_SIZE_PRESETS[preset] || LABEL_SIZE_PRESETS['58x40'];
    return { width: size.width, height: size.height };
  }
  const width = Math.max(20, Math.min(300, Number(document.getElementById('labelCustomWidth')?.value) || 58));
  const height = Math.max(20, Math.min(300, Number(document.getElementById('labelCustomHeight')?.value) || 40));
  return { width, height };
}

function wrapCanvasLines(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = words[0];
  for (let i = 1; i < words.length; i += 1) {
    const next = `${current} ${words[i]}`;
    if (ctx.measureText(next).width <= maxWidth) {
      current = next;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

function renderLabelCanvas(product, widthMm, heightMm) {
  const pxPerMm = 8;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(widthMm * pxPerMm));
  canvas.height = Math.max(1, Math.round(heightMm * pxPerMm));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D недоступен.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const minSide = Math.min(widthMm, heightMm);
  const articlePt = Math.max(9, Math.min(28, minSide * 0.24));
  const codePt = Math.max(7, Math.min(18, minSide * 0.16));
  const skuPt = Math.max(6, Math.min(14, minSide * 0.13));
  const articlePx = articlePt * (pxPerMm / 2.83465);
  const codePx = codePt * (pxPerMm / 2.83465);
  const skuPx = skuPt * (pxPerMm / 2.83465);
  const paddingY = Math.max(pxPerMm * 2, canvas.height * 0.08);
  const centerX = canvas.width / 2;
  const maxTextWidth = canvas.width * 0.92;
  let y = paddingY;

  const article1c = String(product.article1c || product.name || '').trim() || '—';
  const code1c = String(product.code1c || '').trim() || '—';
  const skuLines = getProductLabelSkuLines(product);

  ctx.font = `bold ${articlePx}px Arial, sans-serif`;
  wrapCanvasLines(ctx, article1c, maxTextWidth).forEach((line) => {
    ctx.fillText(line, centerX, y);
    y += articlePx * 1.15;
  });

  y += articlePx * 0.2;
  ctx.font = `${codePx}px Arial, sans-serif`;
  wrapCanvasLines(ctx, code1c, maxTextWidth).forEach((line) => {
    ctx.fillText(line, centerX, y);
    y += codePx * 1.2;
  });

  if (skuLines.length) {
    y += codePx * 0.35;
    ctx.font = `${skuPx}px Arial, sans-serif`;
    skuLines.forEach((line) => {
      const text = `${line.label}: ${line.value}`;
      wrapCanvasLines(ctx, text, maxTextWidth).forEach((part) => {
        ctx.fillText(part, centerX, y);
        y += skuPx * 1.18;
      });
    });
  }

  return canvas;
}

function ensureJsPdfReady() {
  const JsPDF = window.jspdf?.jsPDF || window.jsPDF;
  if (!JsPDF) {
    throw new Error('jsPDF не загрузился. Проверьте подключение jspdf.umd.min.js.');
  }
  return JsPDF;
}

function drawLabelOnPdfPage(doc, product, widthMm, heightMm) {
  const canvas = renderLabelCanvas(product, widthMm, heightMm);
  const dataUrl = canvas.toDataURL('image/png');
  doc.addImage(dataUrl, 'PNG', 0, 0, widthMm, heightMm, undefined, 'FAST');
}

function generateLabelPdfForPrint() {
  const product = getSelectedLabelProduct();
  if (!product) {
    alert('Выберите товар из списка поиска.');
    return;
  }
  const copies = Math.max(1, Math.floor(Number(document.getElementById('labelCopies')?.value) || 1));
  const { width, height } = getLabelDimensionsFromUi();
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    alert('Укажите корректный размер этикетки.');
    return;
  }

  let JsPDF;
  try {
    JsPDF = ensureJsPdfReady();
  } catch (e) {
    alert(e?.message || String(e));
    return;
  }

  const orientation = width >= height ? 'landscape' : 'portrait';
  const doc = new JsPDF({
    unit: 'mm',
    format: [width, height],
    orientation,
    compress: true
  });

  for (let i = 0; i < copies; i += 1) {
    if (i > 0) doc.addPage([width, height], orientation);
    drawLabelOnPdfPage(doc, product, width, height);
  }

  const articlePart = sanitizePdfFilenamePart(product.article1c || product.name || 'товар');
  doc.save(`Этикетка_${articlePart}_${copies}шт.pdf`);
}

function initLabelPrintPage() {
  const search = document.getElementById('labelProductSearch');
  const preset = document.getElementById('labelSizePreset');
  const generateBtn = document.getElementById('labelGeneratePdfBtn');

  search?.addEventListener('input', () => {
    const q = search.value;
    if (!String(q || '').trim()) {
      clearLabelProductSelection();
      hideLabelProductDropdown();
      return;
    }
    if (labelPrintState.selectedRecordId) {
      const selected = getSelectedLabelProduct();
      const selectedText = selected
        ? [String(selected.article1c || selected.name || '').trim(), String(selected.code1c || '').trim()].filter(Boolean).join(' · ')
        : '';
      if (q !== selectedText) clearLabelProductSelection();
    }
    renderLabelProductSearchDropdown(q);
  });

  search?.addEventListener('focus', () => {
    renderLabelProductSearchDropdown(search.value);
  });

  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideLabelProductDropdown();
  });

  document.addEventListener('click', (e) => {
    if (!labelPrintState.dropdownOpen) return;
    const field = document.querySelector('.labels-search-field');
    if (field && !field.contains(e.target)) hideLabelProductDropdown();
  });

  preset?.addEventListener('change', syncLabelCustomSizeVisibility);
  generateBtn?.addEventListener('click', generateLabelPdfForPrint);
  syncLabelCustomSizeVisibility();
}

function initMarketplaceSwitcher() {
  const wrap = document.getElementById('mpSwitcher');
  if (!wrap) return;
  const saved = getCurrentMarketplace();
  wrap.querySelectorAll('.mp-btn').forEach(btn => {
    const mp = btn.getAttribute('data-mp');
    btn.classList.toggle('active', mp === saved);
    btn.addEventListener('click', () => {
      realtimeState.selectedMarketplace = mp;
      wrap.querySelectorAll('.mp-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-mp') === mp);
      });
      applyMarketplaceSectionVisibility();
      applyCostTabMarketplaceLayout();
      applyUnitTabMarketplaceLayout();
      updateMpContextHint();
      applyAnalyticsTabMarketplaceLayout();
      renderProductCost();
    });
  });
  applyMarketplaceSectionVisibility();
  applyCostTabMarketplaceLayout();
  applyUnitTabMarketplaceLayout();
  updateMpContextHint();
  applyAnalyticsTabMarketplaceLayout();
}

function syncThemeToggleButton(isDark) {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
  btn.setAttribute('aria-label', isDark ? 'Включить светлую тему' : 'Включить тёмную тему');
  btn.setAttribute('title', isDark ? 'Светлая тема' : 'Тёмная тема');
}

function applyStoredTheme() {
  const dark = !!realtimeState.themeDark;
  document.body.classList.toggle('dark-mode', dark);
  syncThemeToggleButton(dark);
}

function initThemeToggle() {
  applyStoredTheme();
  document.getElementById('themeToggle')?.addEventListener('click', () => {
    const nextDark = !document.body.classList.contains('dark-mode');
    document.body.classList.toggle('dark-mode', nextDark);
    realtimeState.themeDark = nextDark;
    syncThemeToggleButton(nextDark);
    if (typeof wbRefreshChartAfterTheme === 'function') wbRefreshChartAfterTheme();
  });
}

function getCurrentStoragePerDay() {
  const length = n(document.getElementById('length').value);
  const width = n(document.getElementById('width').value);
  const height = n(document.getElementById('height').value);
  const turnover = n(document.getElementById('turnover').value);
  const stockStatus = document.getElementById('stockStatus').value;
  const newSkuDays = n(document.getElementById('newSkuDays').value);
  const liters = (length * width * height) / 1000000;
  const roundedLiters = liters > 0 ? Math.ceil(liters) : 0;
  return calcStoragePerDay(roundedLiters, turnover, stockStatus, newSkuDays).amount;
}

function emptyUzumStorageData() {
  return {
    enabled: false,
    liters: 0,
    roundedLiters: 0,
    perDay: 0,
    rate: 0,
    reason: '',
    storageReserve: 0,
    productStorageDays: 0,
    productStockStatus: 'existing',
    productTurnover: 0,
    productNewSkuDays: 0
  };
}

function getUzumStorageComputationFromDims(Lcm, Wcm, Hcm, onWarehouse, storageDays, turnover, stockStatus, newSkuDays) {
  const liters = (n(Lcm) * n(Wcm) * n(Hcm)) / 1000;
  const roundedLiters = liters > 0 ? Math.ceil(liters) : 0;
  const enabled = onWarehouse === 'yes' || onWarehouse === true;
  const days = Math.max(0, n(storageDays));
  const turnoverN = n(turnover);
  const stStat = stockStatus || 'existing';
  const newDays = n(newSkuDays);
  if (!enabled) {
    return {
      enabled: false,
      liters,
      roundedLiters,
      perDay: 0,
      rate: 0,
      reason: 'Товар не на складе — резерв на хранение не начисляется.',
      storageReserve: 0,
      productStorageDays: days,
      productStockStatus: stStat,
      productTurnover: turnoverN,
      productNewSkuDays: newDays
    };
  }
  const st = calcStoragePerDay(roundedLiters, turnoverN, stStat, newDays);
  const storageReserve = st.amount * days;
  return {
    enabled: true,
    liters,
    roundedLiters,
    perDay: st.amount,
    rate: st.rate,
    reason: st.reason,
    storageReserve,
    productStorageDays: days,
    productStockStatus: stStat,
    productTurnover: turnoverN,
    productNewSkuDays: newDays
  };
}

function getProductStorageData() {
  if (getCurrentMarketplace() !== 'uzum') return emptyUzumStorageData();
  const L = n(document.getElementById('uzumLengthCm')?.value);
  const W = n(document.getElementById('uzumWidthCm')?.value);
  const H = n(document.getElementById('uzumHeightCm')?.value);
  const onW = document.getElementById('productOnWarehouse')?.value || 'no';
  const days = n(document.getElementById('productStorageDays')?.value);
  const turnover = n(document.getElementById('productTurnover')?.value);
  const stockStatus = document.getElementById('productStockStatus')?.value || 'existing';
  const newSkuDays = n(document.getElementById('productNewSkuDays')?.value);
  return getUzumStorageComputationFromDims(L, W, H, onW, days, turnover, stockStatus, newSkuDays);
}

function getProductStorageDataFromCalc(calc) {
  const c = calc || {};
  const hasDims = n(c.uzumLengthCm) > 0 || n(c.uzumWidthCm) > 0 || n(c.uzumHeightCm) > 0;
  if (!hasDims) return emptyUzumStorageData();
  return getUzumStorageComputationFromDims(
    c.uzumLengthCm,
    c.uzumWidthCm,
    c.uzumHeightCm,
    c.productOnWarehouse,
    c.productStorageDays,
    c.productTurnover,
    c.productStockStatus,
    c.productNewSkuDays
  );
}

function updateUzumLitersDisplay() {
  const L = n(document.getElementById('uzumLengthCm')?.value);
  const W = n(document.getElementById('uzumWidthCm')?.value);
  const H = n(document.getElementById('uzumHeightCm')?.value);
  const lit = (L * W * H) / 1000;
  const el = document.getElementById('uzumLitersVal');
  if (el) el.textContent = String(Math.round(lit * 10000) / 10000);
}

function syncUzumCostWarehouseUi() {
  if (getCurrentMarketplace() !== 'uzum') return;
  const on = document.getElementById('productOnWarehouse')?.value === 'yes';
  document.getElementById('productWarehouseDetails')?.classList.toggle('hidden', !on);
  const st = document.getElementById('productStockStatus')?.value;
  document.getElementById('productNewSkuBlock')?.classList.toggle('hidden', st !== 'new');
  const ps = getProductStorageData();
  const hint = document.getElementById('productStorageRuleText');
  if (hint) {
    const stockText = ps.productStockStatus === 'new'
      ? `Статус: новый SKU. Дней с первой поставки: ${ps.productNewSkuDays}.`
      : 'Статус: уже на складе.';
    const extra = ps.rate > 0 ? ` Текущая ставка: ${ps.rate} сум/л в день.` : '';
    hint.textContent = `${stockText} ${ps.reason}${extra}`.trim();
  }
}

function purchaseLine(amountId, modeId, rate) {
  const gross = n(document.getElementById(amountId).value);
  const inputVat = purchaseInputVat(gross, rate, document.getElementById(modeId).value);
  const net = gross - inputVat;
  return { gross, inputVat, net };
}

function purchaseLineFromValues(grossRaw, modeVal, rate) {
  const gross = n(grossRaw);
  const inputVat = purchaseInputVat(gross, rate, modeVal || 'with');
  return { gross, inputVat, net: gross - inputVat };
}

function getProductCost() {
  const defaultVatRate = n(document.getElementById('vatRate').value) || 12;
  const fabricVatRate = n(document.getElementById('fabricVatRate').value) || defaultVatRate;

  const fabricPrice = n(document.getElementById('fabricPrice').value);
  const fabricConsumption = n(document.getElementById('fabricConsumption').value);
  const fabricGross = fabricPrice * fabricConsumption;
  const fabricMode = document.getElementById('fabricVatIncluded').value;
  const fabricInputVat = purchaseInputVat(fabricGross, fabricVatRate, fabricMode);

  const sewing = purchaseLine('sewingCost', 'sewingCostVatIncluded', defaultVatRate);
  const packageCost = purchaseLine('packageCost', 'packageCostVatIncluded', defaultVatRate);
  const zipperCost = purchaseLine('zipperCost', 'zipperCostVatIncluded', defaultVatRate);
  const elasticCost = purchaseLine('elasticCost', 'elasticCostVatIncluded', defaultVatRate);
  const polygraphyCost = purchaseLine('polygraphyCost', 'polygraphyCostVatIncluded', defaultVatRate);
  const stickersCost = purchaseLine('stickersCost', 'stickersCostVatIncluded', defaultVatRate);
  const promoPolygraphyCost = purchaseLine('promoPolygraphyCost', 'promoPolygraphyCostVatIncluded', defaultVatRate);
  const inboundLogisticsCost = purchaseLine('inboundLogisticsCost', 'inboundLogisticsCostVatIncluded', defaultVatRate);
  const transportBoxCost = purchaseLine('transportBoxCost', 'transportBoxCostVatIncluded', defaultVatRate);
  const otherProductCost = purchaseLine('otherProductCost', 'otherProductCostVatIncluded', defaultVatRate);

  const productStorage = getProductStorageData();
  const storageReserve = productStorage.storageReserve;

  const totalGross = fabricGross + sewing.gross + packageCost.gross + zipperCost.gross + elasticCost.gross + polygraphyCost.gross + stickersCost.gross + promoPolygraphyCost.gross + inboundLogisticsCost.gross + transportBoxCost.gross + storageReserve + otherProductCost.gross;
  const totalInputVat = fabricInputVat + sewing.inputVat + packageCost.inputVat + zipperCost.inputVat + elasticCost.inputVat + polygraphyCost.inputVat + stickersCost.inputVat + promoPolygraphyCost.inputVat + inboundLogisticsCost.inputVat + transportBoxCost.inputVat + otherProductCost.inputVat;
  const totalNet = totalGross - totalInputVat;

  return {
    total: totalGross,
    totalInputVat,
    totalNet,
    fabricCost: fabricGross,
    fabricInputVat,
    sewingCost: sewing.gross,
    packageCost: packageCost.gross,
    zipperCost: zipperCost.gross,
    elasticCost: elasticCost.gross,
    polygraphyCost: polygraphyCost.gross,
    stickersCost: stickersCost.gross,
    promoPolygraphyCost: promoPolygraphyCost.gross,
    inboundLogisticsCost: inboundLogisticsCost.gross,
    transportBoxCost: transportBoxCost.gross,
    storageReserve,
    otherProductCost: otherProductCost.gross,
    productStorage
  };
}

/** Себестоимость по объекту calc (как на вкладке себестоимости), без DOM. */
function getProductCostFromCalc(calc, defaultVatRate) {
  const c = calc || {};
  const rate = n(defaultVatRate) || 12;
  const fabricVatRate = n(c.fabricVatRate) || rate;
  const fabricPrice = n(c.fabricPrice);
  const fabricConsumption = n(c.fabricConsumption);
  const fabricGross = fabricPrice * fabricConsumption;
  const fabricInputVat = purchaseInputVat(fabricGross, fabricVatRate, c.fabricVatIncluded || 'with');

  const sewing = purchaseLineFromValues(c.sewingCost, c.sewingCostVatIncluded, rate);
  const packageCost = purchaseLineFromValues(c.packageCost, c.packageCostVatIncluded, rate);
  const zipperCost = purchaseLineFromValues(c.zipperCost, c.zipperCostVatIncluded, rate);
  const elasticCost = purchaseLineFromValues(c.elasticCost, c.elasticCostVatIncluded, rate);
  const polygraphyCost = purchaseLineFromValues(c.polygraphyCost, c.polygraphyCostVatIncluded, rate);
  const stickersCost = purchaseLineFromValues(c.stickersCost, c.stickersCostVatIncluded, rate);
  const promoPolygraphyCost = purchaseLineFromValues(c.promoPolygraphyCost, c.promoPolygraphyCostVatIncluded, rate);
  const inboundLogisticsCost = purchaseLineFromValues(c.inboundLogisticsCost, c.inboundLogisticsCostVatIncluded, rate);
  const transportBoxCost = purchaseLineFromValues(c.transportBoxCost, c.transportBoxCostVatIncluded, rate);
  const otherProductCost = purchaseLineFromValues(c.otherProductCost, c.otherProductCostVatIncluded, rate);

  const productStorage = getProductStorageDataFromCalc(c);
  const storageReserve = productStorage.storageReserve;

  const totalGross = fabricGross + sewing.gross + packageCost.gross + zipperCost.gross + elasticCost.gross
    + polygraphyCost.gross + stickersCost.gross + promoPolygraphyCost.gross + inboundLogisticsCost.gross
    + transportBoxCost.gross + storageReserve + otherProductCost.gross;
  const totalInputVat = fabricInputVat + sewing.inputVat + packageCost.inputVat + zipperCost.inputVat
    + elasticCost.inputVat + polygraphyCost.inputVat + stickersCost.inputVat + promoPolygraphyCost.inputVat
    + inboundLogisticsCost.inputVat + transportBoxCost.inputVat + otherProductCost.inputVat;
  const totalNet = totalGross - totalInputVat;

  const purchaseZakupka = fabricGross + sewing.gross + zipperCost.gross + elasticCost.gross
    + otherProductCost.gross + storageReserve;
  const packagingSum = packageCost.gross + transportBoxCost.gross + polygraphyCost.gross
    + stickersCost.gross + promoPolygraphyCost.gross;

  return {
    total: totalGross,
    totalInputVat,
    totalNet,
    fabricCost: fabricGross,
    fabricInputVat,
    inboundLogisticsCost: inboundLogisticsCost.gross,
    transportBoxCost: transportBoxCost.gross,
    purchaseZakupka,
    packagingSum,
    productStorage
  };
}

function getProfitByPrice(testPrice, base) {
  const commissionAmount = testPrice * base.commissionPct / 100;
  const outputVat = vatFromAmount(testPrice, base.vatRate, base.saleVatMode);
  const vatPayable = outputVat - base.inputVat;
  const totalCosts = base.cost + commissionAmount + base.logistics + base.storage + vatPayable;
  return testPrice - totalCosts;
}

function calcBreakEven(base) {
  if (base.commissionPct >= 100) return Infinity;
  let low = 0;
  let high = Math.max(base.cost + base.logistics + base.storage + 10000, 1);
  while (getProfitByPrice(high, base) < 0 && high < 1e9) {
    high *= 2;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (getProfitByPrice(mid, base) >= 0) high = mid;
    else low = mid;
  }
  return high;
}

function renderProductCost() {
  applyCostTabMarketplaceLayout();
  if (getCurrentMarketplace() === 'yandex') {
    renderUnit();
    return;
  }
  syncCostFormHiddenSku();
  const productArticle1c = document.getElementById('productArticle1c').value.trim();
  const productCode1c = document.getElementById('productCode1c').value.trim();
  const productStockQty = Math.max(0, Math.floor(n(document.getElementById('productStockQty').value) || 0));
  const productLink = document.getElementById('productLink').value.trim();
  const vals = getProductCost();

  const elArtVal = document.getElementById('productArticle1cVal');
  if (elArtVal) elArtVal.textContent = productArticle1c || '—';
  document.getElementById('productLinkVal').innerHTML = productLink ? `<a href="${productLink}" target="_blank">открыть</a>` : '—';
  document.getElementById('fabricCostVal').textContent = fmtMoney(vals.fabricCost);
  document.getElementById('productCostMain').textContent = fmtMoney(vals.total);
  document.getElementById('productInputVatVal').textContent = fmtMoney(vals.totalInputVat);
  document.getElementById('productCostNetVatVal').textContent = fmtMoney(vals.totalNet);

  document.getElementById('fabricCostDetail').textContent = fmtMoney(vals.fabricCost);
  document.getElementById('fabricInputVatDetail').textContent = fmtMoney(vals.fabricInputVat);
  document.getElementById('sewingCostVal').textContent = fmtMoney(vals.sewingCost);
  document.getElementById('packageCostVal').textContent = fmtMoney(vals.packageCost);
  document.getElementById('zipperCostVal').textContent = fmtMoney(vals.zipperCost);
  document.getElementById('elasticCostVal').textContent = fmtMoney(vals.elasticCost);
  document.getElementById('polygraphyCostVal').textContent = fmtMoney(vals.polygraphyCost);
  document.getElementById('stickersCostVal').textContent = fmtMoney(vals.stickersCost);
  document.getElementById('promoPolygraphyCostVal').textContent = fmtMoney(vals.promoPolygraphyCost);
  document.getElementById('inboundLogisticsCostVal').textContent = fmtMoney(vals.inboundLogisticsCost);
  document.getElementById('transportBoxCostVal').textContent = fmtMoney(vals.transportBoxCost);
  document.getElementById('otherProductCostVal').textContent = fmtMoney(vals.otherProductCost);
  const srv = document.getElementById('storageReserveVal');
  if (srv) srv.textContent = fmtMoney(vals.storageReserve || 0);
  document.getElementById('productAllInputVatVal').textContent = fmtMoney(vals.totalInputVat);
  document.getElementById('productTotalNoVatVal').textContent = fmtMoney(vals.totalNet);
  document.getElementById('productTotalCostVal').textContent = fmtMoney(vals.total);

  const mp = getCurrentMarketplace();
  if (mp === 'uzum' || mp === 'wb') {
    updateUzumLitersDisplay();
    if (mp === 'uzum') syncUzumCostWarehouseUi();
  }
  if (getCurrentMarketplace() === 'wb') {
    const rate = getCostRubCourseForDisplayAndSave();
    const rubTotal = rate > 0 ? vals.total / rate : 0;
    const sumPart = document.getElementById('costWbTotalSumPart');
    const rubPart = document.getElementById('costWbTotalRubPart');
    if (sumPart) sumPart.textContent = fmtMoney(vals.total);
    if (rubPart) rubPart.textContent = rubTotal > 0 ? fmtRubPlain(rubTotal) : '—';
  }
  if (document.getElementById('useProductCost').checked) {
    state.linkedProduct.active = true;
    state.linkedProduct.sku = document.getElementById('sku').value.trim() || productArticle1c || '—';
    state.linkedProduct.costGross = vals.total;
    state.linkedProduct.costNet = vals.totalNet;
    state.linkedProduct.inputVat = vals.totalInputVat;
    state.linkedProduct.hasVat = vals.totalInputVat > 0.0001;
    if (mp === 'uzum') {
      const onWh = document.getElementById('productOnWarehouse')?.value === 'yes';
      state.linkedProduct.storageLinked = onWh;
      if (onWh) {
        state.linkedProduct.length = n(document.getElementById('uzumLengthCm')?.value) * 10;
        state.linkedProduct.width = n(document.getElementById('uzumWidthCm')?.value) * 10;
        state.linkedProduct.height = n(document.getElementById('uzumHeightCm')?.value) * 10;
        state.linkedProduct.turnover = n(document.getElementById('productTurnover')?.value);
        state.linkedProduct.stockStatus = document.getElementById('productStockStatus')?.value || 'existing';
        state.linkedProduct.newSkuDays = n(document.getElementById('productNewSkuDays')?.value);
      }
    } else {
      state.linkedProduct.storageLinked = false;
    }
    document.getElementById('costVatMode').value = state.linkedProduct.hasVat ? 'with' : 'without';
    const mode = document.getElementById('costVatMode').value;
    document.getElementById('cost').value = (mode === 'with' ? vals.total : vals.totalNet).toFixed(2);
  }
  renderUnit();
}

/** Литраж из габаритов калькуляции (см): Д×Ш×В / 1000 */
function getWbLitersFromCostFormCm() {
  const L = n(document.getElementById('uzumLengthCm')?.value);
  const W = n(document.getElementById('uzumWidthCm')?.value);
  const H = n(document.getElementById('uzumHeightCm')?.value);
  return (L * W * H) / 1000;
}

function computeWbUnitEconomics() {
  // --- Цена и параметры WB ---
  const priceUzs = Math.max(0, n(document.getElementById('wbPriceUzs')?.value));
  const commPct = Math.max(0, n(document.getElementById('wbCommissionPct')?.value));
  const drrPct = Math.max(0, n(document.getElementById('wbDrrPct')?.value));
  const acquiPct = Math.max(0, Math.min(100, n(document.getElementById('wbAcquiringPct')?.value)));
  const sppPct = Math.max(0, Math.min(100, n(document.getElementById('wbSppPct')?.value)));

  // --- Параметры справочника ---
  const buyoutPct = Math.max(1, Math.min(100, n(document.getElementById('wbBuyoutPct')?.value) || WB_UZ_DEFAULTS.buyoutPct));
  const vatPct = Math.max(0, n(document.getElementById('wbVatPct')?.value) || WB_UZ_DEFAULTS.vatPct);
  const storageTariff = Math.max(0, n(document.getElementById('wbStorageTariff')?.value) || WB_UZ_DEFAULTS.storageTariff);
  const turnoverDays = Math.max(0, n(document.getElementById('wbTurnoverDays')?.value));
  const returnFixed = Math.max(0, n(document.getElementById('wbReturnFixed')?.value) || WB_UZ_DEFAULTS.returnFixed);
  const safetyPct = Math.max(0, n(document.getElementById('wbSafetyPct')?.value) || WB_UZ_DEFAULTS.safetyMarginPct);
  const exchangeRate = Math.max(1, n(document.getElementById('wbExchangeRate')?.value) || WB_UZ_DEFAULTS.exchangeRate);

  // --- Себестоимость ---
  // Приоритет: поле wbCostUzs → wbCostRub * курс (для совместимости с переносом из себестоимости)
  const costRubRaw = Math.max(0, n(document.getElementById('wbCostRub')?.value));
  const costUzsRaw = Math.max(0, n(document.getElementById('wbCostUzs')?.value));
  const costUzs = costUzsRaw > 0 ? costUzsRaw : Math.round(costRubRaw * exchangeRate);

  // --- Габариты и объём ---
  // Объём берём из скрытого поля (туда пишет перенос из себестоимости)
  const liters = Math.max(0, n(document.getElementById('wbUnitLitersHidden')?.value));

  // --- Расчёт расходов ---
  const fee = Math.round(priceUzs * commPct / 100);
  const acquiring = Math.round(priceUzs * acquiPct / 100);
  const ads = Math.round(priceUzs * drrPct / 100);

  // Логистика (наша формула из отчёта WB, в сумах)
  const buyoutRate = buyoutPct / 100;
  const totalLogUzs = liters > 0
    ? wbUzLogistics(liters, buyoutRate, safetyPct, returnFixed)
    : 0;

  // Хранение
  const storageTotal = Math.round(liters * storageTariff * turnoverDays);

  // Платная приёмка (если есть поле)
  const acceptanceUzs = Math.max(0, n(document.getElementById('wbAcceptanceUzs')?.value));

  // --- К перечислению (сумма вывода) ---
  const toSeller = priceUzs - fee - acquiring - ads - totalLogUzs - storageTotal - acceptanceUzs;

  // --- НДС (выделяется из суммы вывода: × 12/112) ---
  const vatPayable = toSeller > 0
    ? Math.round(toSeller * vatPct / (100 + vatPct))
    : 0;

  // --- Итог ---
  const afterVat = toSeller - vatPayable;
  const netProfit = afterVat - costUzs;
  const marginPct = priceUzs > 0 ? (netProfit / priceUzs) * 100 : 0;
  const roiPct = costUzs > 0 ? (netProfit / costUzs) * 100 : 0;
  const buyerPrice = priceUzs > 0 ? Math.round(priceUzs * (1 - sppPct / 100)) : 0;

  return {
    priceUzs, sppPct, acquiPct, buyerPrice,
    fee, acquiring, ads,
    totalLogUzs, storageTotal, acceptanceUzs,
    toSeller, vatPayable, afterVat,
    costUzs, costRubRaw,
    netProfit, marginPct, roiPct,
    liters, buyoutPct, turnoverDays,
    exchangeRate,
  };
}

function fmtRubPlain(v) {
  return rubFmt.format(Number(v) || 0);
}

/** Группы разрядов пробелом (как 17 066 160) для плиток WB-аналитики */
const wbDashRubFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
function fmtRubSpaces(v) {
  return wbDashRubFmt.format(Number(v) || 0);
}

function renderWbUnitEconomics() {
  const u = computeWbUnitEconomics();
  const fmt = (v) => new Intl.NumberFormat('ru-RU').format(Math.round(v)) + ' сум';
  const fmtPctLocal = (v) => (Math.round(v * 10) / 10).toFixed(1).replace('.', ',') + '%';
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

  const costDisp = document.getElementById('wbUnitCostRubDisplay');
  if (costDisp) costDisp.textContent = u.costUzs > 0 ? fmt(u.costUzs) : '—';

  set('wbUnitNetProfitVal', fmt(u.netProfit));
  const netEl = document.getElementById('wbUnitNetProfitVal');
  if (netEl) {
    netEl.classList.remove('wb-unit-profit-pos', 'wb-unit-profit-neg');
    if (u.priceUzs > 0 || u.costUzs > 0) {
      netEl.classList.add(u.netProfit >= 0 ? 'wb-unit-profit-pos' : 'wb-unit-profit-neg');
    }
  }
  set('wbUnitMarginVal', fmtPctLocal(u.marginPct));
  set('wbUnitRoiVal', fmtPctLocal(u.roiPct));
  set('wbUnitFeeVal', fmt(u.fee));
  const acqLab = document.getElementById('wbUnitAcqLabel');
  if (acqLab) {
    const ap = Math.round(u.acquiPct * 100) / 100;
    const apStr = Math.abs(ap - Math.round(ap)) < 1e-9 ? String(Math.round(ap)) : ap.toFixed(2).replace('.', ',');
    acqLab.textContent = `Эквайринг (${apStr}%)`;
  }
  set('wbUnitAcqVal', fmt(u.acquiring));
  set('wbUnitAdsVal', fmt(u.ads));
  set('wbUnitLogisticsVal', fmt(u.totalLogUzs));
  set('wbUnitStorageVal', fmt(u.storageTotal));
  set('wbUnitVatVal', fmt(u.vatPayable));
  set('wbUnitToSellerVal', fmt(u.toSeller));
  set('wbUnitCostLineVal', fmt(u.costUzs));

  const buyerVal = document.getElementById('wbUnitBuyerPriceVal');
  if (buyerVal) buyerVal.textContent = u.priceUzs > 0 ? fmt(u.buyerPrice) : '—';
  const sppEcho = document.getElementById('wbUnitSppPctEcho');
  if (sppEcho) {
    const s = Math.round(u.sppPct * 10) / 10;
    const isInt = Math.abs(s - Math.round(s)) < 1e-9;
    sppEcho.textContent = isInt ? String(Math.round(s)) : s.toFixed(1).replace('.', ',');
  }

  const card = document.getElementById('wbUnitResultsCard');
  if (card) {
    if (u.priceUzs <= 0 && u.costUzs <= 0) {
      card.dataset.profitState = 'neutral';
    } else {
      card.dataset.profitState = u.netProfit >= 0 ? 'profit' : 'loss';
    }
  }

  // Обновить таблицу справочника (пересчёт с новым safetyPct / returnFixed)
  wbUzRenderTariffsTable();
}

function renderUnit() {
  applyUnitTabMarketplaceLayout();
  const mp = getCurrentMarketplace();
  if (mp === 'wb') {
    renderWbUnitEconomics();
    return;
  }
  const useProductCost = document.getElementById('useProductCost').checked;
  if (useProductCost) {
    const productVals = getProductCost();
    const mpU = getCurrentMarketplace();
    state.linkedProduct.active = true;
    syncCostFormHiddenSku();
    state.linkedProduct.sku = document.getElementById('sku').value.trim() || document.getElementById('productArticle1c').value.trim() || '—';
    state.linkedProduct.costGross = productVals.total;
    state.linkedProduct.costNet = productVals.totalNet;
    state.linkedProduct.inputVat = productVals.totalInputVat;
    state.linkedProduct.hasVat = productVals.totalInputVat > 0.0001;
    if (mpU === 'uzum') {
      const onWh = document.getElementById('productOnWarehouse')?.value === 'yes';
      state.linkedProduct.storageLinked = onWh;
      // Габариты всегда берём из формы себестоимости (нужны для логистики),
      // а параметры хранения — только если товар отмечен "на складе".
      state.linkedProduct.length = n(document.getElementById('uzumLengthCm')?.value) * 10;
      state.linkedProduct.width = n(document.getElementById('uzumWidthCm')?.value) * 10;
      state.linkedProduct.height = n(document.getElementById('uzumHeightCm')?.value) * 10;
      if (onWh) {
        state.linkedProduct.turnover = n(document.getElementById('productTurnover')?.value);
        state.linkedProduct.stockStatus = document.getElementById('productStockStatus')?.value || 'existing';
        state.linkedProduct.newSkuDays = n(document.getElementById('productNewSkuDays')?.value);
      } else {
        state.linkedProduct.turnover = 0;
        state.linkedProduct.stockStatus = 'existing';
        state.linkedProduct.newSkuDays = 0;
      }
    } else {
      state.linkedProduct.storageLinked = false;
    }
    document.getElementById('costVatMode').value = state.linkedProduct.hasVat ? 'with' : 'without';
    const mode = document.getElementById('costVatMode').value;
    document.getElementById('cost').value = (mode === 'with' ? productVals.total : productVals.totalNet).toFixed(2);
  }

  const price = n(document.getElementById('price').value);
  const commissionPct = n(document.getElementById('commission').value);
  const cost = n(document.getElementById('cost').value);
  let length = n(document.getElementById('length').value);
  let width = n(document.getElementById('width').value);
  let height = n(document.getElementById('height').value);
  let turnover = n(document.getElementById('turnover').value);
  const logisticsTariff = (document.getElementById('logisticsTariff')?.value || 'new');
  const vatRate = n(document.getElementById('vatRate').value);
  const saleVatMode = document.getElementById('saleVatMode').value;
  const costVatMode = document.getElementById('costVatMode').value;
  let stockStatus = document.getElementById('stockStatus').value;
  let newSkuDays = n(document.getElementById('newSkuDays').value);

  if (useProductCost && state.linkedProduct.active && state.linkedProduct.storageLinked) {
    length = state.linkedProduct.length;
    width = state.linkedProduct.width;
    height = state.linkedProduct.height;
    turnover = state.linkedProduct.turnover;
    stockStatus = state.linkedProduct.stockStatus;
    newSkuDays = state.linkedProduct.newSkuDays;

    document.getElementById('length').value = length || 0;
    document.getElementById('width').value = width || 0;
    document.getElementById('height').value = height || 0;
    document.getElementById('turnover').value = turnover || 0;
    document.getElementById('stockStatus').value = stockStatus || 'existing';
    document.getElementById('newSkuDays').value = newSkuDays || 0;
  }

  // Если товар не отмечен "на складе", не обнуляем габариты (они нужны для расчёта логистики),
  // сбрасываем только параметры хранения.
  if (useProductCost && state.linkedProduct.active && !state.linkedProduct.storageLinked) {
    document.getElementById('turnover').value = 0;
    document.getElementById('stockStatus').value = 'existing';
    document.getElementById('newSkuDays').value = 0;
    turnover = 0; stockStatus = 'existing'; newSkuDays = 0;
  }

  document.getElementById('newSkuBlock').classList.toggle('hidden', stockStatus !== 'new');

  const liters = (length * width * height) / 1000000;
  const roundedLiters = liters > 0 ? Math.ceil(liters) : 0;
  const sumCm = (Number(length || 0) + Number(width || 0) + Number(height || 0)) / 10;
  const oldLog = calcLogisticsOldTariff(sumCm, price);

  const logistics = logisticsTariff === 'old'
    ? oldLog.amount
    : calcLogistics(roundedLiters);

  const storage = logisticsTariff === 'old'
    ? calcStoragePerDayOldTariff(oldLog.category, turnover, stockStatus, newSkuDays)
    : calcStoragePerDay(roundedLiters, turnover, stockStatus, newSkuDays);
  const commissionAmount = price * commissionPct / 100;
  const outputVat = vatFromAmount(price, vatRate, saleVatMode);
  const linkedMode = useProductCost && state.linkedProduct.active;
  const inputVat = linkedMode
    ? state.linkedProduct.inputVat
    : vatFromAmount(cost, vatRate, costVatMode);
  const vatPayable = outputVat - inputVat;
  const totalCosts = cost + commissionAmount + logistics + storage.amount + vatPayable;
  const profit = price - totalCosts;
  const margin = price > 0 ? (profit / price) * 100 : 0;
  const markup = cost > 0 ? (profit / cost) * 100 : 0;
  const roi = cost > 0 ? (profit / cost) * 100 : 0;
  const bep = calcBreakEven({ cost, commissionPct, logistics, storage: storage.amount, vatRate, saleVatMode, inputVat });

  const profitEl = document.getElementById('profitMain');
  profitEl.textContent = fmtMoney(profit);
  profitEl.className = `value ${profit >= 0 ? 'positive' : 'negative'}`;
  document.getElementById('marginVal').textContent = fmtPct(margin);
  document.getElementById('markupVal').textContent = fmtPct(markup);
  document.getElementById('roiVal').textContent = fmtPct(roi);
  document.getElementById('bepVal').textContent = Number.isFinite(bep) ? fmtMoney(bep) : 'н/д';

  document.getElementById('litersVal').textContent = liters.toFixed(2).replace('.', ',');
  document.getElementById('roundedLitersVal').textContent = roundedLiters.toLocaleString('ru-RU');
  document.getElementById('commissionVal').textContent = fmtMoney(commissionAmount);
  document.getElementById('logisticsVal').textContent = fmtMoney(logistics);
  document.getElementById('storageVal').textContent = fmtMoney(storage.amount);
  document.getElementById('outputVatVal').textContent = fmtMoney(outputVat);
  document.getElementById('inputVatVal').textContent = fmtMoney(inputVat);
  document.getElementById('vatPayableVal').textContent = fmtMoney(vatPayable);
  document.getElementById('totalCostsVal').innerHTML = `<strong>${fmtMoney(totalCosts)}</strong>`;

  const linkLabel =
    (document.getElementById('productArticle1c')?.value || '').trim() || state.linkedProduct.sku || '—';
  const syncText = useProductCost && state.linkedProduct.active
    ? `Юнит-экономика считает товар по артикулу 1С: ${linkLabel}. Себестоимость и входящий НДС подтягиваются из вкладки «Себестоимость».`
    : 'Сейчас можно считать юнит отдельно, без привязки к вкладке себестоимости.';
  document.getElementById('productCostSyncText').textContent = syncText;
  document.getElementById('inputVatSourceVal').textContent = useProductCost && state.linkedProduct.active
    ? `из себестоимости (артикул 1С: ${linkLabel}) = ${fmtMoney(inputVat)}`
    : 'ручной режим';
  document.getElementById('linkedProductVal').textContent = useProductCost && state.linkedProduct.active
    ? `связано с артикулом 1С: ${linkLabel}`
    : 'нет связи';

  const storageSyncText = useProductCost && state.linkedProduct.active && state.linkedProduct.storageLinked
    ? `Параметры ВГХ, оборачиваемости и статуса перенесены из себестоимости (артикул 1С: ${linkLabel}).`
    : (useProductCost && state.linkedProduct.active
      ? 'У товара в себестоимости не отмечено, что он уже на складе. В юнит-экономике параметры хранения и ВГХ сброшены в ноль.'
      : 'Пока расчёт юнит-экономики использует свои параметры ВГХ и хранения.');
  document.getElementById('storageSyncText').textContent = storageSyncText;

  const stockText = stockStatus === 'new'
    ? `Статус: новый SKU. Дней с первой поставки: ${newSkuDays}.`
    : 'Статус: уже на складе.';
  const extra = storage.rate > 0 ? ` Текущая ставка: ${storage.rate} сум/л в день.` : '';
  document.getElementById('storageRuleText').textContent = `${stockText} ${storage.reason}${extra}`.trim();
}

function openPage(pageId) {
  document.querySelectorAll('.nav-btn').forEach(x => x.classList.toggle('active', x.dataset.page === pageId));
  document.querySelectorAll('.page-panel').forEach(x => x.classList.remove('active'));
  const page = document.getElementById(pageId);
  if (page) page.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (pageId === 'components-tab' && typeof renderComponentsList === 'function') renderComponentsList();
  const mp = getCurrentMarketplace();
  if (pageId === 'shipments-tab' && mp === 'uzum') {
    if (typeof renderWmsHistory === 'function') renderWmsHistory();
    if (typeof renderWmsDraftSummary === 'function') renderWmsDraftSummary();
  }
  applyMarketplaceSectionVisibility();
  applyCostTabMarketplaceLayout();
  applyUnitTabMarketplaceLayout();
  updateMpContextHint();
  if (pageId === 'unit-tab') renderUnit();
  renderEverything();
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => openPage(btn.dataset.page));
});

document.querySelectorAll('[data-open-page]').forEach(card => {
  card.addEventListener('click', () => openPage(card.dataset.openPage));
});

const codeBase1C = {
  productType: {"КПБ": "01", "КПБ на резинке": "02", "Неполный комплект": "03", "Салфетки": "04", "Скатерть": "05", "Декоративная подушка": "06", "Наволочки": "07", "Стеганное одеяло": "08", "Прихватка": "09", "Рукавица": "10", "Комплект Прихватка+Рукавица": "11", "Простыня на резинке": "12"},
  size: {"1 Спальный": "01", "1,5 Спальный": "02", "2 Спальный": "03", "Евро": "04", "Семейный": "05", "25*70": "06", "35*60": "07", "35*65": "08", "35*70": "09", "40*60": "10", "40*65": "12", "45*65": "13", "145*200": "14", "145*250": "15", "150*200": "16", "150*250": "17", "30*30": "18", "35*35": "19", "40*40": "20", "50*70": "21", "70*70": "22", "160*20*25": "23", "180*200*25": "24", "140*200*20": "25", "190*85*25": "26"},
  fabricType: {"Бязь": "01", "Поплин": "02", "Перкаль": "03", "Сатин": "04", "Страйп сатин": "05", "Ранфорс": "06", "Вафелька": "07", "Рогожка": "08", "Диагональ": "09"},
  finishType: {"Отбелка": "01", "Крашение": "02", "Ротационная печать": "03", "Цифровая печать": "04", "Суровая": "05", "РП+КР": "06"},
  density: {"100": "01", "105": "02", "110": "03", "120": "04", "125": "05", "130": "06", "135": "07", "140": "08", "145": "09", "150": "10", "155": "11", "160": "12", "165": "13", "170": "14", "175": "15", "180": "16", "185": "17", "190": "18", "195": "19", "200": "20", "205": "21", "210": "22", "215": "23", "220": "24", "225": "25", "230": "26", "235": "27", "240": "28", "245": "29", "250": "30", "255": "31", "260": "32", "265": "33", "270": "34", "275": "35", "280": "36", "285": "37", "290": "38", "295": "39", "300": "40", "115": "41"},
  width: {"100": "01", "150": "02", "160": "03", "180": "04", "190": "05", "200": "06", "220": "07", "240": "08", "250": "09", "260": "10"}
};

const GENERATOR_1C_LABELS = ['Вид продукта', 'Размер', 'Вид ткани', 'Вид отделки', 'Плотность', 'Ширина'];
const GENERATOR_1C_KEYS = ['productType', 'size', 'fabricType', 'finishType', 'density', 'width'];
const GENERATOR_SELECT_IDS = ['genProductType', 'genSize', 'genFabricType', 'genFinishType', 'genDensity', 'genWidth'];

function fillGeneratorSelectFromCodeBase(selectId, categoryKey) {
  const sel = document.getElementById(selectId);
  if (!sel || !codeBase1C[categoryKey]) return;
  const frag = document.createDocumentFragment();
  Object.keys(codeBase1C[categoryKey]).forEach((label) => {
    const o = document.createElement('option');
    o.value = label;
    o.textContent = label;
    frag.appendChild(o);
  });
  sel.innerHTML = '';
  sel.appendChild(frag);
}

function findLabelByCodeInCategory(categoryKey, code) {
  const map = codeBase1C[categoryKey];
  if (!map) return null;
  const pair = String(code || '').trim();
  const hit = Object.entries(map).find(([, v]) => v === pair);
  return hit ? hit[0] : null;
}

function initCodeGenerator1C() {
  GENERATOR_SELECT_IDS.forEach((id, i) => fillGeneratorSelectFromCodeBase(id, GENERATOR_1C_KEYS[i]));

  document.getElementById('btnGenerate')?.addEventListener('click', () => {
    const vals = GENERATOR_SELECT_IDS.map((id) => document.getElementById(id)?.value);
    const chunks = GENERATOR_1C_KEYS.map((key, i) => codeBase1C[key][vals[i]]);
    const missingIdx = chunks.findIndex((c) => !c);
    const outEl = document.getElementById('resultGeneratedCode');
    if (!outEl) return;
    if (missingIdx !== -1) {
      outEl.textContent = '';
      return;
    }
    let out = chunks.join('');
    const colorRaw = String(document.getElementById('genColor')?.value || '').trim();
    if (colorRaw) out += `-${colorRaw}`;
    outEl.textContent = out;
  });

  document.getElementById('btnDecode')?.addEventListener('click', () => {
    const ul = document.getElementById('decodeResultList');
    if (!ul) return;
    ul.innerHTML = '';
    let raw = String(document.getElementById('decodeInput')?.value || '').trim();
    let colorSuffix = '';
    const dash = raw.indexOf('-');
    if (dash !== -1) {
      colorSuffix = raw.slice(dash + 1).trim();
      raw = raw.slice(0, dash);
    }
    const digits = raw.replace(/\D/g, '').slice(0, 12);
    if (digits.length < 12) {
      const li = document.createElement('li');
      li.textContent = `Введите 12 цифр кода (сейчас ${digits.length}).`;
      ul.appendChild(li);
      return;
    }
    for (let i = 0; i < 6; i += 1) {
      const pair = digits.slice(i * 2, i * 2 + 2);
      const name = findLabelByCodeInCategory(GENERATOR_1C_KEYS[i], pair);
      const li = document.createElement('li');
      li.textContent = `${GENERATOR_1C_LABELS[i]}: ${name || `— (код ${pair})`}`;
      ul.appendChild(li);
    }
    if (colorSuffix) {
      const li = document.createElement('li');
      li.textContent = `Цвет: ${colorSuffix}`;
      ul.appendChild(li);
    }
  });

  const navGen = document.getElementById('nav-generator');
  navGen?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPage('generator-section');
    }
  });
}

const FABRIC_FIT_ERROR = 'Не помещается в ширину ткани';

function readFabricCalcNumber(id, label, opts = {}) {
  const el = document.getElementById(id);
  const raw = el?.value;
  const v = opts.allowZero ? Number(raw) : parseFloat(raw);
  if (!Number.isFinite(v) || (opts.allowZero ? v < 0 : v <= 0)) {
    throw new Error(`Укажите корректное значение: ${label}`);
  }
  return v;
}

function fabricFmtCm(v) {
  return `${(Math.round(v * 10) / 10).toFixed(1)} см`;
}

function buildDuvetCut(length, width, duvetType, allowance) {
  const zipperExtra = duvetType === 'zipper' ? 2 : 0;
  const cutLength = length + allowance * 2;
  const cutWidth = width + allowance * 2 + zipperExtra;
  const notes = [
    duvetType === 'zipper' ? 'На молнии (+2 см к стороне молнии)' : 'Обычный с вырезом',
    '2 детали (верх / низ)'
  ];
  return {
    cutLength,
    cutWidth,
    finishedLength: length,
    finishedWidth: width,
    pieceCount: 2,
    notes
  };
}

function buildSheetCut(length, width, sheetType, allowance, mattressHeight) {
  const isElastic = sheetType !== 'plain';
  const cutLength = isElastic
    ? length + mattressHeight * 2 + allowance
    : length + allowance * 2;
  const cutWidth = isElastic
    ? width + mattressHeight * 2 + allowance
    : width + allowance * 2;
  const notes = [isElastic
    ? `На резинке (${sheetType === 'elastic_corners' ? 'углы' : 'периметр'}), загиб ${mattressHeight} см`
    : 'Обычная'];
  return {
    cutLength,
    cutWidth,
    finishedLength: length,
    finishedWidth: width,
    pieceCount: 1,
    notes
  };
}

function buildPillowZipperCut(pillowHeight, pillowWidth, allowance) {
  return {
    cutLength: pillowHeight + allowance * 2,
    cutWidth: pillowWidth + allowance * 2,
    finishedLength: pillowHeight,
    finishedWidth: pillowWidth,
    pieceCount: 2,
    notes: ['На молнии', '2 детали на наволочку']
  };
}

function buildFlapPillowUnfold(pillowHeight, pillowWidth, allowance, flapSize) {
  const axisH = pillowHeight + allowance * 2;
  const axisW = pillowWidth * 2 + flapSize + allowance * 2;
  return {
    axisH,
    axisW,
    pillowHeight,
    pillowWidth,
    flapSize,
    pieceCount: 1,
    notes: [
      `С клапаном ${flapSize} см`,
      'Единая развёртка: обхват по ширине, высота вдоль рисунка'
    ]
  };
}

const FLAP_PILLOW_FIT_ERROR = 'Развёртка наволочки не помещается в ширину ткани';

function nestPillowLayout(layoutLength, layoutWidth, fabWidth, pillowQty) {
  const itemsPerRow = Math.floor(fabWidth / layoutWidth);
  if (itemsPerRow < 1) return null;
  const rows = Math.ceil(pillowQty / itemsPerRow);
  const totalPillowFabric = rows * layoutLength;
  return { itemsPerRow, rows, totalPillowFabric, layoutLength, layoutWidth };
}

function buildPillowDetailLine(pillowQty, totalPillowFabric, itemsPerRow) {
  const perOne = totalPillowFabric / pillowQty;
  return `Наволочки (${pillowQty} шт): Общий расход ${Math.round(totalPillowFabric)} см (Расход на 1 шт: ${perOne.toFixed(1)} см). В один ряд по ширине рулона помещается ${itemsPerRow} шт.`;
}

function calculateFlapPillowcasesConsumption(unfold, fabric, pillowQty, pillowPatternDir) {
  const { axisH, axisW } = unfold;
  const candidates = [];

  const addCandidate = (layoutLength, layoutWidth, layoutLabel) => {
    const nest = nestPillowLayout(layoutLength, layoutWidth, fabric.width, pillowQty);
    if (!nest) return;
    candidates.push({ ...nest, layoutLabel });
  };

  if (fabric.isSolid) {
    addCandidate(axisH, axisW, 'вдоль рулона (AxisH по длине)');
    addCandidate(axisW, axisH, 'поперёк рулона (AxisW по длине, оптимальный поворот)');
  } else {
    const matched = fabric.patternDir === pillowPatternDir;
    const layoutLength = matched ? axisH : axisW;
    const layoutWidth = matched ? axisW : axisH;
    const layoutLabel = matched
      ? 'направления рисунка совпадают (AxisH вдоль рулона)'
      : 'направления отличаются (AxisW вдоль рулона)';
    addCandidate(layoutLength, layoutWidth, layoutLabel);
  }

  if (!candidates.length) {
    return { ok: false, error: FLAP_PILLOW_FIT_ERROR };
  }

  const best = candidates.reduce((min, cur) => (
    cur.totalPillowFabric < min.totalPillowFabric ? cur : min
  ));

  return {
    ok: true,
    consumption: best.totalPillowFabric,
    perPieceCm: best.totalPillowFabric / pillowQty,
    pieceCount: 1,
    layoutLabel: best.layoutLabel,
    alongRoll: best.layoutLength,
    acrossRoll: best.layoutWidth,
    cutLength: axisW,
    cutWidth: axisH,
    axisH,
    axisW,
    unfoldLabel: `${fabricFmtCm(axisW)} × ${fabricFmtCm(axisH)}`,
    isFlapUnfold: true,
    nesting: {
      countPerRow: best.itemsPerRow,
      rows: best.rows,
      totalPieces: pillowQty
    },
    detailLine: buildPillowDetailLine(pillowQty, best.totalPillowFabric, best.itemsPerRow)
  };
}

function fitsAcrossRoll(cutAcross, finishedAcross, fabWidth, useSelvedge) {
  if (useSelvedge) {
    if (Math.abs(finishedAcross - fabWidth) < 0.05) return true;
    return finishedAcross <= fabWidth + 0.05;
  }
  return cutAcross <= fabWidth + 0.05;
}

function nestingAcrossDim(cutAcross, finishedAcross, useSelvedge, fabWidth) {
  if (useSelvedge && Math.abs(finishedAcross - fabWidth) < 0.05) return fabWidth;
  return cutAcross;
}

function layoutFromPattern(cutLength, cutWidth, finishedLength, finishedWidth, fabPatternDir, itemPatternWish) {
  const matched = fabPatternDir === itemPatternWish;
  if (matched) {
    return {
      alongRoll: cutLength,
      acrossRoll: cutWidth,
      finishedAcross: finishedWidth,
      layoutLabel: 'вдоль рулона (рисунок совпадает)'
    };
  }
  return {
    alongRoll: cutWidth,
    acrossRoll: cutLength,
    finishedAcross: finishedLength,
    layoutLabel: 'поперёк рулона (рисунок повёрнут на 90°)'
  };
}

function evaluateLayout(alongRoll, acrossRoll, finishedAcross, fabric) {
  if (!fitsAcrossRoll(acrossRoll, finishedAcross, fabric.width, fabric.useSelvedge)) {
    return null;
  }
  return {
    alongRoll,
    acrossRoll,
    finishedAcross,
    consumption: alongRoll
  };
}

function calculatePieceConsumption(cut, fabric, itemPatternWish) {
  const { cutLength, cutWidth, finishedLength, finishedWidth, pieceCount } = cut;
  const layouts = [];

  if (fabric.isSolid) {
    const a = evaluateLayout(cutLength, cutWidth, finishedWidth, fabric);
    const b = evaluateLayout(cutWidth, cutLength, finishedLength, fabric);
    if (a) layouts.push({ ...a, layoutLabel: 'вдоль рулона', rotated: false });
    if (b) layouts.push({ ...b, layoutLabel: 'поперёк рулона (оптимальный поворот)', rotated: true });
  } else {
    const p = layoutFromPattern(cutLength, cutWidth, finishedLength, finishedWidth, fabric.patternDir, itemPatternWish);
    const one = evaluateLayout(p.alongRoll, p.acrossRoll, p.finishedAcross, fabric);
    if (one) layouts.push({ ...one, layoutLabel: p.layoutLabel, rotated: false });
  }

  if (!layouts.length) {
    return { ok: false, error: FABRIC_FIT_ERROR };
  }

  const best = layouts.reduce((min, cur) => (cur.consumption < min.consumption ? cur : min));
  const perPieceCm = best.consumption;
  const totalCm = perPieceCm * pieceCount;

  return {
    ok: true,
    consumption: totalCm,
    perPieceCm,
    pieceCount,
    layoutLabel: best.layoutLabel,
    alongRoll: best.alongRoll,
    acrossRoll: best.acrossRoll,
    cutLength,
    cutWidth
  };
}

function calculatePillowcasesNesting(cut, fabric, pillowPatternDir, pillowQty) {
  const totalPieces = pillowQty * cut.pieceCount;

  function nestOnePiece(cutLength, cutWidth, finishedLength, finishedWidth, layoutLabel, rotated) {
    const acrossForNesting = nestingAcrossDim(
      rotated ? cutLength : cutWidth,
      rotated ? finishedLength : finishedWidth,
      fabric.useSelvedge,
      fabric.width
    );
    if (!fitsAcrossRoll(
      rotated ? cutLength : cutWidth,
      rotated ? finishedLength : finishedWidth,
      fabric.width,
      fabric.useSelvedge
    )) {
      return null;
    }
    const countPerRow = Math.max(1, Math.floor(fabric.width / acrossForNesting));
    const rows = Math.ceil(totalPieces / countPerRow);
    const alongRoll = rotated ? cutWidth : cutLength;
    return {
      consumption: rows * alongRoll,
      countPerRow,
      rows,
      layoutLabel,
      alongRoll,
      acrossRoll: rotated ? cutLength : cutWidth
    };
  }

  const options = [];

  if (fabric.isSolid) {
    const a = nestOnePiece(cut.cutLength, cut.cutWidth, cut.finishedLength, cut.finishedWidth, 'вдоль рулона', false);
    const b = nestOnePiece(cut.cutWidth, cut.cutLength, cut.finishedWidth, cut.finishedLength, 'поперёк рулона (оптимальный поворот)', true);
    if (a) options.push(a);
    if (b) options.push(b);
  } else {
    const p = layoutFromPattern(
      cut.cutLength, cut.cutWidth, cut.finishedLength, cut.finishedWidth,
      fabric.patternDir, pillowPatternDir
    );
    const one = nestOnePiece(
      cut.cutLength, cut.cutWidth, cut.finishedLength, cut.finishedWidth,
      p.layoutLabel, p.alongRoll === cut.cutWidth
    );
    if (one) options.push(one);
  }

  if (!options.length) {
    return { ok: false, error: FABRIC_FIT_ERROR };
  }

  const best = options.reduce((min, cur) => (cur.consumption < min.consumption ? cur : min));
  const pillowCount = pillowQty;
  return {
    ok: true,
    consumption: best.consumption,
    perPieceCm: best.consumption / pillowCount,
    pieceCount: cut.pieceCount,
    layoutLabel: best.layoutLabel,
    alongRoll: best.alongRoll,
    acrossRoll: best.acrossRoll,
    cutLength: cut.cutLength,
    cutWidth: cut.cutWidth,
    nesting: { countPerRow: best.countPerRow, rows: best.rows, totalPieces },
    detailLine: buildPillowDetailLine(pillowCount, best.consumption, best.countPerRow)
  };
}

function getFabricCalcContext() {
  const allowance = readFabricCalcNumber('seamAllowance', 'припуск на 1 шов', { allowZero: true });
  const isSolid = document.getElementById('fabType')?.value === 'solid';
  return {
    width: readFabricCalcNumber('fabWidth', 'ширина ткани'),
    isSolid,
    patternDir: document.getElementById('fabPatternDir')?.value || 'along',
    useSelvedge: !!document.getElementById('useSelvedge')?.checked,
    allowance
  };
}

function calculateFabricConsumption() {
  const fabric = getFabricCalcContext();
  const pillowQty = Math.max(1, Math.round(readFabricCalcNumber('pillowcaseQty', 'количество наволочек')));

  const duvetCut = buildDuvetCut(
    readFabricCalcNumber('duvetLength', 'длина пододеяльника'),
    readFabricCalcNumber('duvetWidth', 'ширина пододеяльника'),
    document.getElementById('duvetType')?.value || 'envelope',
    fabric.allowance
  );
  const sheetType = document.getElementById('sheetType')?.value || 'plain';
  const mattressHeight = sheetType === 'plain'
    ? 0
    : readFabricCalcNumber('mattressHeight', 'высота матраса', { allowZero: true });
  const sheetCut = buildSheetCut(
    readFabricCalcNumber('sheetLength', 'длина простыни'),
    readFabricCalcNumber('sheetWidth', 'ширина простыни'),
    sheetType,
    fabric.allowance,
    mattressHeight
  );
  const pillowType = document.getElementById('pillowType')?.value || 'zipper';
  const pillowHeight = readFabricCalcNumber('pillowHeight', 'высота наволочки');
  const pillowWidth = readFabricCalcNumber('pillowWidth', 'ширина наволочки');
  const flapSize = pillowType === 'flap'
    ? readFabricCalcNumber('flapSize', 'размер клапана')
    : 0;

  const duvetWish = document.getElementById('duvetPatternWish')?.value || 'along';
  const sheetWish = document.getElementById('sheetPatternWish')?.value || 'along';
  const pillowPatternDir = document.getElementById('pillowPatternDir')?.value || 'along';

  const duvetRes = calculatePieceConsumption(duvetCut, fabric, duvetWish);
  if (!duvetRes.ok) return { ok: false, error: `Пододеяльник: ${duvetRes.error}` };

  const sheetRes = calculatePieceConsumption(sheetCut, fabric, sheetWish);
  if (!sheetRes.ok) return { ok: false, error: `Простыня: ${sheetRes.error}` };

  let pillowRes;
  let pillowMeta;
  if (pillowType === 'flap') {
    const unfold = buildFlapPillowUnfold(pillowHeight, pillowWidth, fabric.allowance, flapSize);
    pillowRes = calculateFlapPillowcasesConsumption(unfold, fabric, pillowQty, pillowPatternDir);
    pillowMeta = {
      notes: unfold.notes,
      finishedSize: `${fabricFmtCm(pillowHeight)} (вдоль рис.) × ${fabricFmtCm(pillowWidth)} (поперёк)`
    };
  } else {
    const pillowCut = buildPillowZipperCut(pillowHeight, pillowWidth, fabric.allowance);
    pillowRes = calculatePillowcasesNesting(pillowCut, fabric, pillowPatternDir, pillowQty);
    pillowMeta = {
      notes: pillowCut.notes,
      finishedSize: `${fabricFmtCm(pillowHeight)} × ${fabricFmtCm(pillowWidth)}`
    };
  }
  if (!pillowRes.ok) return { ok: false, error: `Наволочки: ${pillowRes.error}` };

  const items = [
    {
      name: 'Пододеяльник',
      ...duvetRes,
      notes: duvetCut.notes,
      finishedSize: `${fabricFmtCm(duvetCut.finishedLength)} × ${fabricFmtCm(duvetCut.finishedWidth)}`
    },
    {
      name: 'Простыня',
      ...sheetRes,
      notes: sheetCut.notes,
      finishedSize: `${fabricFmtCm(sheetCut.finishedLength)} × ${fabricFmtCm(sheetCut.finishedWidth)}`
    },
    {
      name: `Наволочки (${pillowQty} шт)`,
      ...pillowRes,
      ...pillowMeta
    }
  ];

  const totalCm = items.reduce((s, it) => s + it.consumption, 0);

  return {
    ok: true,
    totalMeters: totalCm / 100,
    totalCm,
    pillowQty,
    fabric,
    items
  };
}

function escapeFabricHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderFabricCalcResult(result) {
  const box = document.getElementById('fabricCalcResult');
  if (!box) return;

  if (!result.ok) {
    box.className = 'fabric-calc-result fabric-calc-result--error';
    box.innerHTML = `<p class="fabric-calc-result-title">Ошибка расчёта</p><p>${escapeFabricHtml(result.error)}</p>`;
    box.classList.remove('hidden');
    return;
  }

  const selvedgeNote = result.fabric.useSelvedge
    ? '<p class="fabric-calc-result-note">Учтена кромка: по ширине рулона припуски на боковые швы не добавляются.</p>'
    : '';

  const rows = result.items.map((it) => {
    const cutSize = it.isFlapUnfold
      ? `Развёртка ${escapeFabricHtml(it.unfoldLabel)}<br><span class="fabric-calc-muted">AxisH: ${fabricFmtCm(it.axisH)} · AxisW: ${fabricFmtCm(it.axisW)}</span>`
      : `${fabricFmtCm(it.cutLength)} × ${fabricFmtCm(it.cutWidth)}`;
    const nestInfo = it.nesting && !it.isFlapUnfold
      ? `<br><span class="fabric-calc-muted">Раскладка: ${it.nesting.countPerRow} шт/ряд × ${it.nesting.rows} ряд(ов), всего лекал ${it.nesting.totalPieces}</span>`
      : (it.nesting && it.isFlapUnfold
        ? `<br><span class="fabric-calc-muted">${it.nesting.rows} ряд(ов) × ${fabricFmtCm(it.alongRoll)} по длине рулона</span>`
        : (it.pieceCount > 1
          ? `<br><span class="fabric-calc-muted">${it.pieceCount} лекала на изделие</span>`
          : ''));
    const notes = it.notes.map((n) => escapeFabricHtml(n)).join(' · ');
    const consumptionCell = it.detailLine
      ? `<span>${escapeFabricHtml(it.detailLine)}</span>`
      : `<strong>${fabricFmtCm(it.consumption)}</strong>`;
    return `
      <tr>
        <td><strong>${escapeFabricHtml(it.name)}</strong><br><span class="fabric-calc-muted">Готовое: ${escapeFabricHtml(it.finishedSize)}</span></td>
        <td>${cutSize}<br><span class="fabric-calc-muted">${notes}</span></td>
        <td>${escapeFabricHtml(it.layoutLabel)}${nestInfo}</td>
        <td>${consumptionCell}</td>
      </tr>
    `;
  }).join('');

  box.className = 'fabric-calc-result fabric-calc-result--ok';
  box.innerHTML = `
    <p class="fabric-calc-result-title">Итоговый расход ткани: <strong>${result.totalMeters.toFixed(2)} м</strong> <span class="fabric-calc-muted">(${fabricFmtCm(result.totalCm)} по длине рулона)</span></p>
    ${selvedgeNote}
    <p class="fabric-calc-result-sub">Подробный расчёт по деталям</p>
    <div class="fabric-calc-table-wrap">
      <table class="fabric-calc-table">
        <thead>
          <tr>
            <th>Деталь</th>
            <th>Габарит кроя (Д × Ш)</th>
            <th>Укладка на рулоне</th>
            <th>Расход</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
  box.classList.remove('hidden');
}

const FABRIC_PREVIEW_ITEMS = [
  { selectId: 'duvetPatternWish', previewId: 'preview-duvet' },
  { selectId: 'sheetPatternWish', previewId: 'preview-sheet' },
  { selectId: 'pillowPatternDir', previewId: 'preview-pillow' }
];

function updateVisualPreview() {
  const isPattern = document.getElementById('fabType')?.value === 'pattern';
  const container = document.querySelector('.calc-preview-container');
  container?.classList.toggle('calc-preview-container--solid', !isPattern);

  FABRIC_PREVIEW_ITEMS.forEach(({ selectId, previewId }) => {
    const box = document.getElementById(previewId);
    const texture = box?.querySelector('.fabric-texture');
    const wish = document.getElementById(selectId)?.value || 'along';
    if (!texture) return;

    texture.classList.toggle('fabric-texture--across', isPattern && wish === 'across');
    if (!isPattern || wish === 'along') {
      texture.style.transform = 'rotate(0deg)';
    } else {
      texture.style.transform = 'rotate(90deg)';
    }
  });
}

function initFabricCalculator() {
  const fabType = document.getElementById('fabType');
  const sheetType = document.getElementById('sheetType');
  const pillowType = document.getElementById('pillowType');

  const syncPatternVisibility = () => {
    const isPattern = fabType?.value === 'pattern';
    document.querySelectorAll('.fabric-pattern-only').forEach((el) => {
      el.classList.toggle('hidden', !isPattern);
    });
    document.querySelectorAll('.fabric-pillow-pattern-only').forEach((el) => {
      el.classList.toggle('hidden', !isPattern);
    });
    updateVisualPreview();
  };

  const syncFlapVisibility = () => {
    document.querySelectorAll('.fabric-pillow-flap-only').forEach((el) => {
      el.classList.toggle('hidden', pillowType?.value !== 'flap');
    });
  };

  const syncSheetVisibility = () => {
    const isElastic = sheetType?.value !== 'plain';
    document.querySelectorAll('.fabric-sheet-elastic-only').forEach((el) => {
      el.classList.toggle('hidden', !isElastic);
    });
  };

  const syncVisibility = () => {
    syncPatternVisibility();
    syncFlapVisibility();
    syncSheetVisibility();
  };

  fabType?.addEventListener('change', syncVisibility);
  sheetType?.addEventListener('change', syncSheetVisibility);
  pillowType?.addEventListener('change', syncFlapVisibility);
  document.querySelectorAll('.fabric-item-pattern').forEach((el) => {
    el.addEventListener('change', updateVisualPreview);
  });
  syncVisibility();

  document.getElementById('btnFabricCalc')?.addEventListener('click', () => {
    const box = document.getElementById('fabricCalcResult');
    try {
      renderFabricCalcResult(calculateFabricConsumption());
    } catch (err) {
      renderFabricCalcResult({ ok: false, error: err?.message || 'Проверьте введённые данные' });
    }
    box?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

[
  'price','commission','cost','costVatMode','length','width','height','stockStatus','logisticsTariff',
  'turnover','newSkuDays','vatRate','saleVatMode','useProductCost'
].forEach(id => {
  document.getElementById(id).addEventListener('input', () => { renderProductCost(); renderUnit(); });
  document.getElementById(id).addEventListener('change', () => { renderProductCost(); renderUnit(); });
});

[
  'wbPriceUzs', 'wbCommissionPct', 'wbDrrPct', 'wbAcquiringPct', 'wbSppPct',
  'wbBuyoutPct', 'wbVatPct', 'wbStorageTariff', 'wbTurnoverDays',
  'wbReturnFixed', 'wbSafetyPct', 'wbExchangeRate', 'wbCostUzs', 'wbAcceptanceUzs'
].forEach(id => {
  document.getElementById(id)?.addEventListener('input', renderWbUnitEconomics);
});

// Кнопка добавить строку в справочник
document.getElementById('wbUzAddTariffBtn')?.addEventListener('click', wbUzAddTariffRow);

// Перерисовать справочник при старте
wbUzRenderTariffsTable();

[
  'productArticle1c', 'productCode1c', 'productStockQty', 'productLink',
  'mpSkuUzum', 'mpWbNmid', 'mpSkuYandex',
  'fabricPrice', 'fabricConsumption', 'fabricUnit', 'fabricVatIncluded', 'fabricVatRate', 'sewingCost', 'packageCost',
  'zipperCost', 'elasticCost', 'polygraphyCost', 'stickersCost', 'promoPolygraphyCost', 'inboundLogisticsCost',
  'transportBoxCost', 'otherProductCost',
  'sewingCostVatIncluded', 'packageCostVatIncluded', 'zipperCostVatIncluded', 'elasticCostVatIncluded',
  'polygraphyCostVatIncluded', 'stickersCostVatIncluded', 'promoPolygraphyCostVatIncluded',
  'inboundLogisticsCostVatIncluded', 'transportBoxCostVatIncluded', 'otherProductCostVatIncluded'
].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => {
    syncCostFormHiddenSku();
    renderProductCost();
  });
  document.getElementById(id)?.addEventListener('change', () => {
    syncCostFormHiddenSku();
    renderProductCost();
  });
});

document.getElementById('costRubUzRate')?.addEventListener('input', () => {
  renderProductCost();
});
document.getElementById('costRubUzRate')?.addEventListener('change', () => {
  renderProductCost();
});

document.getElementById('sendToUnitBtn')?.addEventListener('click', () => {
  const setValAndDispatch = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = String(value);
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
  };

  document.getElementById('useProductCost').checked = true;
  const vals = getProductCost();
  syncCostFormHiddenSku();
  const mp = getCurrentMarketplace();
  if (mp === 'wb') {
    const art = (document.getElementById('productArticle1c')?.value || '').trim();
    const liters = getWbLitersFromCostFormCm();
    const rate = getCostRubCourseForDisplayAndSave();
    const costRub = rate > 0 ? vals.total / rate : 0;
    const artEl = document.getElementById('wbUnitArticleVal');
    if (artEl) artEl.textContent = art || '—';
    const litDisp = document.getElementById('wbUnitLitersDisplay');
    const litHid = document.getElementById('wbUnitLitersHidden');
    const litRounded = liters > 0 ? Math.round(liters * 10000) / 10000 : 0;
    if (litDisp) litDisp.textContent = litRounded > 0 ? String(litRounded) : '—';
    if (litHid) litHid.value = String(litRounded);
    const costDisp = document.getElementById('wbUnitCostRubDisplay');
    if (costDisp) costDisp.textContent = costRub > 0 ? `${fmtRubPlain(costRub)} ₽` : '—';
    const wbCostIn = document.getElementById('wbCostRub');
    if (wbCostIn) wbCostIn.value = costRub > 0 ? String(Math.round(costRub * 100) / 100) : '0';
    const uxRate = n(document.getElementById('wbExchangeRate')?.value) || WB_UZ_DEFAULTS.exchangeRate;
    const costUzsEl = document.getElementById('wbCostUzs');
    if (costUzsEl && costRub > 0) {
      costUzsEl.value = String(Math.round(costRub * uxRate));
    }
  }
  const sku = document.getElementById('sku').value.trim() || '—';
  state.linkedProduct.active = true;
  state.linkedProduct.sku = sku;
  state.linkedProduct.costGross = vals.total;
  state.linkedProduct.costNet = vals.totalNet;
  state.linkedProduct.inputVat = vals.totalInputVat;
  state.linkedProduct.hasVat = vals.totalInputVat > 0.0001;
  const l = n(document.getElementById('uzumLengthCm')?.value) * 10;
  const w = n(document.getElementById('uzumWidthCm')?.value) * 10;
  const h = n(document.getElementById('uzumHeightCm')?.value) * 10;
  if (mp === 'uzum') {
    const onWh = document.getElementById('productOnWarehouse')?.value === 'yes';
    state.linkedProduct.storageLinked = onWh;
    // Габариты переносим ВСЕГДА (нужны для логистики сразу после переноса),
    // а параметры хранения — только если товар отмечен "на складе".
    // Основные поля юнита (в текущей верстке — мм)
    setValAndDispatch('length', l || 0);
    setValAndDispatch('width', w || 0);
    setValAndDispatch('height', h || 0);
    // Если в верстке есть отдельные поля Uzum-гобаритов (например #uzumLength/#uzumWidth/#uzumHeight) — поддержим тоже.
    setValAndDispatch('uzumLength', l || 0);
    setValAndDispatch('uzumWidth', w || 0);
    setValAndDispatch('uzumHeight', h || 0);
    state.linkedProduct.length = l;
    state.linkedProduct.width = w;
    state.linkedProduct.height = h;

    if (onWh) {
      setValAndDispatch('turnover', n(document.getElementById('productTurnover')?.value));
      setValAndDispatch('stockStatus', document.getElementById('productStockStatus')?.value || 'existing');
      setValAndDispatch('newSkuDays', n(document.getElementById('productNewSkuDays')?.value));
      state.linkedProduct.turnover = n(document.getElementById('productTurnover')?.value);
      state.linkedProduct.stockStatus = document.getElementById('productStockStatus')?.value || 'existing';
      state.linkedProduct.newSkuDays = n(document.getElementById('productNewSkuDays')?.value);
    } else {
      setValAndDispatch('turnover', 0);
      setValAndDispatch('stockStatus', 'existing');
      setValAndDispatch('newSkuDays', 0);
    }
  } else {
    state.linkedProduct.storageLinked = false;
    if (l || w || h) {
      document.getElementById('length').value = String(l || 0);
      document.getElementById('width').value = String(w || 0);
      document.getElementById('height').value = String(h || 0);
      state.linkedProduct.length = l;
      state.linkedProduct.width = w;
      state.linkedProduct.height = h;
    }
  }
  document.getElementById('costVatMode').value = state.linkedProduct.hasVat ? 'with' : 'without';
  const mode = document.getElementById('costVatMode').value;
  document.getElementById('cost').value = (mode === 'with' ? vals.total : vals.totalNet).toFixed(2);

  openPage('unit-tab');
  // Рендерим сразу после программной подстановки значений (события input/change не срабатывают)
  renderProductCost();
  renderUnit();
});

document.getElementById('useProductCost').addEventListener('change', () => {
  if (!document.getElementById('useProductCost').checked) {
    state.linkedProduct.active = false;
  }
  renderProductCost();
  renderUnit();
});

const STORAGE_KEYS = {
  products: 'uzum_products_db_v1',
  shipments: 'uzum_shipments_db_v1',
  components: 'uzum_components_db_v1',
  mpReports: 'uzum_mp_monthly_reports_v1',
  reportsHistory: 'uzum_analytics_reports_history_v1',
  wbAnalyticsReports: 'wb_analytics_reports_history_v4',
  wbAnalyticsReportingUzs: 'wb_analytics_reporting_uzs_v3',
  wbAnalyticsSettings: 'wb_analytics_settings_v1'
};

/** Легаси-черновик (старый UI поставок); WMS резервирует остаток через wmsState */
const shipmentDraft = { items: [] };

function readStore(key, fallback) {
  if (key === STORAGE_KEYS.products) return Array.isArray(realtimeState.products) ? realtimeState.products : [];
  if (key === STORAGE_KEYS.shipments) return Array.isArray(realtimeState.shipments) ? realtimeState.shipments : [];
  if (key === STORAGE_KEYS.components) return Array.isArray(realtimeState.components) ? realtimeState.components : [];
  if (!realtimeState.uiMemory || typeof realtimeState.uiMemory !== 'object') realtimeState.uiMemory = Object.create(null);
  const val = realtimeState.uiMemory[key];
  return val === undefined ? fallback : deepCloneJson(val);
}
function writeStore(key, value) {
  if (key === STORAGE_KEYS.products) {
    realtimeState.products = Array.isArray(value) ? value : [];
    return;
  }
  if (key === STORAGE_KEYS.shipments) {
    realtimeState.shipments = Array.isArray(value) ? value : [];
    return;
  }
  if (key === STORAGE_KEYS.components) {
    realtimeState.components = Array.isArray(value) ? value : [];
    return;
  }
  if (!realtimeState.uiMemory || typeof realtimeState.uiMemory !== 'object') realtimeState.uiMemory = Object.create(null);
  realtimeState.uiMemory[key] = deepCloneJson(value);
}
function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString('ru-RU');
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('ru-RU');
}
function todayIso() {
  return new Date().toISOString().slice(0,10);
}

function deepCloneJson(obj) {
  if (obj === undefined || obj === null) return obj;
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return obj;
  }
}

/** Снимок финансовых/калькуляционных данных товара для строки поставки (не меняется при правках базы). */
function buildProductFinancialSnapshot(product) {
  if (!product) return null;
  const p = product;
  return {
    capturedAt: new Date().toISOString(),
    productRecordId: p.recordId,
    sku: p.sku,
    // Для UI в поставках: сначала "Название", иначе артикул 1С
    name: (String(p.name || '').trim() || String(p.article1c || '').trim() || ''),
    article1c: p.article1c,
    code1c: p.code1c,
    costGross: Number(p.costGross || 0),
    costPriceUzs: Number(p.costPriceUzs ?? p.costGross ?? 0),
    costNet: Number(p.costNet || 0),
    inputVat: Number(p.inputVat || 0),
    length: Number(p.length || 0),
    width: Number(p.width || 0),
    height: Number(p.height || 0),
    volumeLiters: Number(p.volumeLiters || 0),
    calc: deepCloneJson(p.calc || {})
  };
}

function normalizeWmsMarketplaceKey(mp) {
  const v = normalizeShipmentMarketplace({ marketplace: mp });
  if (v === 'Wildberries') return 'wb';
  if (v === 'Yandex Market') return 'yandex';
  return 'uzum';
}

function getMarketplaceSkuForProduct(product, marketplaceKey) {
  const p = product || {};
  const c = p.calc || {};
  const key = String(marketplaceKey || '').toLowerCase();
  if (key === 'wb') {
    const wb = String(p.wbSku ?? p.wb_nmid ?? p.wb_nm_id ?? p.nmid ?? c.mpWbNmid ?? '').trim();
    return { label: 'WB SKU', value: wb };
  }
  if (key === 'yandex') {
    const y = String(p.yandexSku ?? p.yandex_sku ?? c.mpSkuYandex ?? '').trim();
    return { label: 'Yandex SKU', value: y };
  }
  const u = String(p.uzumSku ?? p.uzum_sku ?? c.mpSkuUzum ?? '').trim();
  return { label: 'Uzum SKU', value: u };
}

function getWmsReservedQtyForProduct(product) {
  // Живой учёт: остаток в базе уже уменьшен на количество в коробках — не вычитаем повторно.
  if (!wmsState.assemblingOpen || !product) return 0;
  return 0;
}

function getReservedQtyInDraft(product) {
  const sku = String(product?.sku || '').trim();
  const legacy = shipmentDraft.items
    .filter(item => String(item?.sku || '').trim() === sku)
    .reduce((sum, item) => sum + Number(item.qty || 0), 0);
  return legacy + getWmsReservedQtyForProduct(product);
}

function getAvailableStockForProduct(product) {
  const baseStock = Math.max(0, Math.floor(Number(product?.stockQty || 0)));
  return Math.max(0, baseStock - getReservedQtyInDraft(product));
}

/** addToWarehouse > 0 — вернуть на склад; < 0 — списать. Firestore — источник правды, локально только live-снимок в памяти. */
async function applyWmsWarehouseStockDelta(productRecordId, addToWarehouse, auditContext) {
  const rid = productRecordId != null ? String(productRecordId).trim() : '';
  const d = Math.floor(Number(addToWarehouse || 0));
  if (!rid || !d) return;
  const col = getProductsCollectionRef();
  const FieldValue = firebase?.firestore?.FieldValue;
  if (!col || !FieldValue || typeof FieldValue.increment !== 'function') {
    console.error('applyWmsWarehouseStockDelta: Firestore или FieldValue недоступны.');
    throw new Error('Не удалось обновить остаток: Firebase недоступен.');
  }
  const products = readProductsSafe();
  const idx = products.findIndex(p => recordIdsEqual(p.recordId, rid));
  if (idx < 0) {
    console.error('applyWmsWarehouseStockDelta: товар не найден', rid);
    throw new Error(`Товар (запись ${rid}) не найден в базе.`);
  }
  const cur = Math.max(0, Math.floor(Number(products[idx].stockQty || 0)));
  const rawNext = cur + d;
  if (rawNext < 0) {
    throw new Error('Недостаточно остатка на складе для этой операции.');
  }
  const nowIso = new Date().toISOString();
  products[idx] = { ...products[idx], stockQty: rawNext, updatedAt: nowIso };
  writeStore(STORAGE_KEYS.products, products);
  try {
    const actionType = (auditContext && auditContext.action_type) ? String(auditContext.action_type) : '';
    const mustSyncDraftFirst = wmsState.assemblingOpen && (actionType.startsWith('wms_shipment_') || actionType === 'draft_reserve_stock');
    if (mustSyncDraftFirst) {
      const shipmentId = wmsState.editingDraftId != null ? wmsState.editingDraftId : Date.now();
      wmsState.editingDraftId = shipmentId;
      const draftShipment = buildWmsShipmentRecordFromUi('draft', shipmentId);
      await db.runTransaction(async (tx) => {
        const shipmentRef = getShipmentsCollectionRef()?.doc(String(shipmentId));
        if (!shipmentRef) throw new Error('Коллекция shipments недоступна.');
        tx.set(shipmentRef, draftShipment, { merge: true });
        tx.set(col.doc(rid), {
          stockQty: FieldValue.increment(d),
          updatedAt: nowIso
        }, { merge: true });
      });
      const shipments = readShipmentsSafe();
      const shIdx = shipments.findIndex((s) => String(s.id) === String(shipmentId));
      if (shIdx >= 0) shipments[shIdx] = draftShipment;
      else shipments.push(draftShipment);
      writeStore(STORAGE_KEYS.shipments, shipments);
    } else {
      await col.doc(rid).set({
        stockQty: FieldValue.increment(d),
        updatedAt: nowIso
      }, { merge: true });
    }
  } catch (e) {
    console.error('applyWmsWarehouseStockDelta: ошибка записи в Firestore: ', e);
    throw e;
  }
  const at = (auditContext && auditContext.action_type) ? auditContext.action_type : 'wms_stock_delta';
  recordProductStockAudit(rid, cur, rawNext, at, auditContext || {});
  filterProducts();
  renderWmsLiveTotals();
  renderWmsDraftSummary();
}

async function restoreWmsDraftLinesToWarehouse(flatLines) {
  const list = Array.isArray(flatLines) ? flatLines : [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const rid = it?.productRecordId != null && String(it.productRecordId) !== '' ? String(it.productRecordId) : '';
    const q = Math.max(0, Math.floor(Number(it.qty || 0)));
    if (!rid || !q) continue;
    await applyWmsWarehouseStockDelta(rid, q, { action_type: 'wms_assemble_close_restore' });
  }
}

function roundLitersFromDimensions(length, width, height) {
  const liters = (Number(length || 0) * Number(width || 0) * Number(height || 0)) / 1000000;
  return { liters, rounded: Math.ceil(liters) };
}

function getSelectedStockAdjustProduct() {
  return null;
}

function renderStockAdjustSelector() {}

function setModalOpen(modalId, open) {
  const el = document.getElementById(modalId);
  if (!el) return;
  el.classList.toggle('open', !!open);
}

/** Габариты в мм + объём; при нулевом снимке подтягиваем из базы. Uzum (см) в calc не затираем, если в новом снимке пусто. */
function mergeProductVghFromExisting(snap, existing) {
  if (!snap || !existing) return snap;
  const L = Number(snap.length) || Number(existing.length) || 0;
  const W = Number(snap.width) || Number(existing.width) || 0;
  const H = Number(snap.height) || Number(existing.height) || 0;
  const volumeLiters = Number((((L * W * H) / 1000000) || 0).toFixed(2));
  const calc = { ...(snap.calc || {}) };
  const ec = existing.calc || {};
  const noUz = !n(calc.uzumLengthCm) && !n(calc.uzumWidthCm) && !n(calc.uzumHeightCm);
  if (noUz && (n(ec.uzumLengthCm) || n(ec.uzumWidthCm) || n(ec.uzumHeightCm))) {
    calc.uzumLengthCm = ec.uzumLengthCm;
    calc.uzumWidthCm = ec.uzumWidthCm;
    calc.uzumHeightCm = ec.uzumHeightCm;
    if (ec.productOnWarehouse != null) calc.productOnWarehouse = ec.productOnWarehouse;
    if (ec.productStorageDays != null) calc.productStorageDays = ec.productStorageDays;
    if (ec.productTurnover != null) calc.productTurnover = ec.productTurnover;
    if (ec.productStockStatus != null) calc.productStockStatus = ec.productStockStatus;
    if (ec.productNewSkuDays != null) calc.productNewSkuDays = ec.productNewSkuDays;
  }
  return { ...snap, length: L, width: W, height: H, volumeLiters, calc };
}

function applyStockAdjustment() {
  return;
}

function getCostRubCourseForDisplayAndSave() {
  const mp = getCurrentMarketplace();
  if (mp === 'wb') {
    const r = n(document.getElementById('costRubUzRate')?.value);
    return r > 0 ? r : 130;
  }
  return RUB_UZS_FOR_EXPORT;
}

function resolveCurrentUzumBarcode() {
  const inputEl = document.getElementById('mpUzumBarcode');
  if (inputEl) return normalizeUzumBarcode(inputEl.value);
  const editingId = state?.productsEdit?.recordId;
  if (editingId != null && String(editingId) !== '') {
    const p = findProductByRecordId(readProductsSafe(), editingId);
    if (p) return normalizeUzumBarcode(p.uzum_barcode);
  }
  return '';
}

function snapshotCurrentProduct() {
  const mpGuard = getCurrentMarketplace();
  if (mpGuard === 'yandex' && !wmsState.shipmentCalcEdit?.active) {
    return null;
  }
  syncCostFormHiddenSku();
  const vals = getProductCost();
  // Источник SKU: блок "Связки с маркетплейсами" (конкретные ID инпутов)
  const mpUz = document.getElementById('mpSkuUzum')?.value.trim() || '';
  const mpWb = document.getElementById('mpWbNmid')?.value.trim() || '';
  const mpYa = document.getElementById('mpSkuYandex')?.value.trim() || '';
  const productArticle1c = document.getElementById('productArticle1c').value.trim();
  const sku = productArticle1c || mpUz || mpWb || mpYa;
  const productCode1c = document.getElementById('productCode1c').value.trim();
  const productStockQty = Math.max(0, Math.floor(n(document.getElementById('productStockQty').value) || 0));
  const productCategory = (document.getElementById('productCategory')?.value || '').trim();
  const productLink = document.getElementById('productLink').value.trim();
  if (!sku) {
    alert('Укажите артикул 1С или хотя бы один код в блоке «Связки с маркетплейсами» (Uzum, WB, Yandex).');
    return null;
  }
  if (!productCategory) {
    alert('Выберите категорию товара.');
    return null;
  }
  const rubCourse = getCostRubCourseForDisplayAndSave();
  const costGrossRub = rubCourse > 0 ? vals.total / rubCourse : 0;
  const mpSnap = getCurrentMarketplace();
  const uzL = n(document.getElementById('uzumLengthCm')?.value);
  const uzW = n(document.getElementById('uzumWidthCm')?.value);
  const uzH = n(document.getElementById('uzumHeightCm')?.value);
  let lengthMm = 0;
  let widthMm = 0;
  let heightMm = 0;
  let volumeLiters = 0;
  if (mpSnap === 'uzum' || mpSnap === 'wb') {
    lengthMm = uzL * 10;
    widthMm = uzW * 10;
    heightMm = uzH * 10;
    volumeLiters = Number(((uzL * uzW * uzH) / 1000).toFixed(4));
  }

  const calc = {
    productLink, productArticle1c, productCode1c, productStockQty, productCategory,
    fabricPrice: n(document.getElementById('fabricPrice').value),
    fabricConsumption: n(document.getElementById('fabricConsumption').value),
    fabricUnit: document.getElementById('fabricUnit').value,
    fabricVatIncluded: document.getElementById('fabricVatIncluded').value,
    fabricVatRate: n(document.getElementById('fabricVatRate').value),
    sewingCost: n(document.getElementById('sewingCost').value),
    packageCost: n(document.getElementById('packageCost').value),
    zipperCost: n(document.getElementById('zipperCost').value),
    elasticCost: n(document.getElementById('elasticCost').value),
    polygraphyCost: n(document.getElementById('polygraphyCost').value),
    stickersCost: n(document.getElementById('stickersCost').value),
    promoPolygraphyCost: n(document.getElementById('promoPolygraphyCost').value),
    inboundLogisticsCost: n(document.getElementById('inboundLogisticsCost').value),
    transportBoxCost: n(document.getElementById('transportBoxCost').value),
    otherProductCost: n(document.getElementById('otherProductCost').value),
    sewingCostVatIncluded: document.getElementById('sewingCostVatIncluded').value,
    packageCostVatIncluded: document.getElementById('packageCostVatIncluded').value,
    zipperCostVatIncluded: document.getElementById('zipperCostVatIncluded').value,
    elasticCostVatIncluded: document.getElementById('elasticCostVatIncluded').value,
    polygraphyCostVatIncluded: document.getElementById('polygraphyCostVatIncluded').value,
    stickersCostVatIncluded: document.getElementById('stickersCostVatIncluded').value,
    promoPolygraphyCostVatIncluded: document.getElementById('promoPolygraphyCostVatIncluded').value,
    inboundLogisticsCostVatIncluded: document.getElementById('inboundLogisticsCostVatIncluded').value,
    transportBoxCostVatIncluded: document.getElementById('transportBoxCostVatIncluded').value,
    otherProductCostVatIncluded: document.getElementById('otherProductCostVatIncluded').value,
    mpSkuUzum: mpUz,
    mpWbNmid: mpWb,
    mpSkuYandex: mpYa,
    uzumLengthCm: uzL,
    uzumWidthCm: uzW,
    uzumHeightCm: uzH,
    productOnWarehouse: document.getElementById('productOnWarehouse')?.value || 'no',
    productStorageDays: n(document.getElementById('productStorageDays')?.value),
    productTurnover: n(document.getElementById('productTurnover')?.value),
    productStockStatus: document.getElementById('productStockStatus')?.value || 'existing',
    productNewSkuDays: n(document.getElementById('productNewSkuDays')?.value),
    costRubUzRate: rubCourse
  };

  return {
    sku,
    // Явные поля для Firebase / UI (новая схема)
    uzumSku: mpUz,
    wbSku: mpWb,
    yandexSku: mpYa,
    uzum_barcode: resolveCurrentUzumBarcode(),
    // Легаси-поля (оставляем для обратной совместимости)
    uzum_sku: mpUz,
    wb_nmid: mpWb,
    yandex_sku: mpYa,
    name: productArticle1c,
    article1c: productArticle1c,
    code1c: productCode1c,
    stockQty: productStockQty,
    category: productCategory,
    link: productLink,
    updatedAt: new Date().toISOString(),
    costGross: vals.total,
    // Каноническая себестоимость для склада (UZS)
    costPriceUzs: vals.total,
    costNet: vals.totalNet,
    inputVat: vals.totalInputVat,
    costGrossRub,
    rubCourse,
    length: lengthMm,
    width: widthMm,
    height: heightMm,
    volumeLiters,
    calc
  };
}

function suggestCategoryFromName(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return '';
  if (s.includes('наволоч')) return '5-Наволочки';
  if (s.includes('простын')) return '6-Простыни';
  if (s.includes('салфет')) return '7-Салфетки';
  if (s.includes('рукавиц') || s.includes('прихват')) return '8-Рукавицы';
  if (s.includes('кухон') && (s.includes('набор') || s.includes('комплект'))) return '9-Кухонные наборы';
  if (s.includes('скатерт')) return '10-Скатерть';
  if (s.includes('фартук')) return '11 - Фартук';

  if (s.includes('евро')) return '4-постельное белье Евро';
  if (s.includes('2сп') || s.includes('2-сп') || s.includes('2 сп') || s.includes('двусп')) return '3-постельное белье 2сп';
  if (s.includes('1,5') || s.includes('1.5') || s.includes('полутор')) return '1-Постельное белье 1,5';
  if (s.includes('1сп') || s.includes('1 сп') || s.includes('односп')) return '2-постельное белье 1 сп';
  if (s.includes('постель') || s.includes('кпб') || s.includes('комплект')) return '4-постельное белье Евро';
  return '';
}

function applySuggestedCategoryIfEmpty() {
  const catEl = document.getElementById('productCategory');
  if (!catEl) return;
  if (String(catEl.value || '').trim()) return;
  const nm = (document.getElementById('productArticle1c')?.value || '').trim();
  const sug = suggestCategoryFromName(nm);
  if (sug) catEl.value = sug;
}

const HISTORY_TOP_LABELS = {
  sku: 'Ключ записи',
  uzum_sku: 'SKU Uzum',
  uzum_barcode: 'Штрихкод Uzum',
  wb_nmid: 'nmId WB',
  yandex_sku: 'SKU Yandex',
  name: 'Имя записи (легаси, как правило = артикул 1С)',
  article1c: 'Артикул 1С',
  code1c: 'Код 1С',
  stockQty: 'Остаток, шт',
  link: 'Ссылка',
  costGross: 'Себестоимость (гросс)',
  costNet: 'Себестоимость без НДС',
  inputVat: 'Входящий НДС',
  costGrossRub: 'Себестоимость в ₽',
  rubCourse: 'Курс RUB/UZS',
  length: 'Длина, мм',
  width: 'Ширина, мм',
  height: 'Высота, мм',
  volumeLiters: 'Объём, л'
};

const HISTORY_CALC_LABELS = {
  productLink: 'Калькуляция · Ссылка',
  productArticle1c: 'Калькуляция · Артикул 1С',
  productCode1c: 'Калькуляция · Код 1С',
  productStockQty: 'Калькуляция · Остаток в форме',
  fabricPrice: 'Калькуляция · Цена ткани',
  fabricConsumption: 'Калькуляция · Расход ткани',
  fabricUnit: 'Калькуляция · Ед. расхода ткани',
  fabricVatIncluded: 'Калькуляция · Ткань с НДС',
  fabricVatRate: 'Калькуляция · Ставка НДС ткани',
  sewingCost: 'Калькуляция · Пошив',
  packageCost: 'Калькуляция · Пакет',
  zipperCost: 'Калькуляция · Замок',
  elasticCost: 'Калькуляция · Резинка',
  polygraphyCost: 'Калькуляция · Полиграфия',
  stickersCost: 'Калькуляция · Стикеры',
  promoPolygraphyCost: 'Калькуляция · Рекл. полиграфия',
  inboundLogisticsCost: 'Калькуляция · Логистика до склада',
  transportBoxCost: 'Калькуляция · Трансп. коробка',
  otherProductCost: 'Калькуляция · Прочие расходы',
  sewingCostVatIncluded: 'Калькуляция · Пошив: НДС',
  packageCostVatIncluded: 'Калькуляция · Пакет: НДС',
  zipperCostVatIncluded: 'Калькуляция · Замок: НДС',
  elasticCostVatIncluded: 'Калькуляция · Резинка: НДС',
  polygraphyCostVatIncluded: 'Калькуляция · Полиграфия: НДС',
  stickersCostVatIncluded: 'Калькуляция · Стикеры: НДС',
  promoPolygraphyCostVatIncluded: 'Калькуляция · Рекл. полиграфия: НДС',
  inboundLogisticsCostVatIncluded: 'Калькуляция · Логистика: НДС',
  transportBoxCostVatIncluded: 'Калькуляция · Коробка: НДС',
  otherProductCostVatIncluded: 'Калькуляция · Прочее: НДС',
  productOnWarehouse: 'Калькуляция · Товар на складе',
  productStorageDays: 'Калькуляция · Дней хранения',
  productTurnover: 'Калькуляция · Оборачиваемость',
  productStockStatus: 'Калькуляция · Статус SKU',
  productLength: 'Калькуляция · Длина (форма)',
  productWidth: 'Калькуляция · Ширина (форма)',
  productHeight: 'Калькуляция · Высота (форма)',
  productNewSkuDays: 'Калькуляция · Дней нового SKU',
  mpSkuUzum: 'Калькуляция · SKU Uzum',
  mpWbNmid: 'Калькуляция · nmId WB',
  mpSkuYandex: 'Калькуляция · SKU Yandex',
  uzumLengthCm: 'Калькуляция · Uzum Длина, см',
  uzumWidthCm: 'Калькуляция · Uzum Ширина, см',
  uzumHeightCm: 'Калькуляция · Uzum Высота, см',
  costRubUzRate: 'Калькуляция · Курс RUB/UZS'
};

const HISTORY_CALC_MONEY_KEYS = new Set([
  'fabricPrice', 'sewingCost', 'packageCost', 'zipperCost', 'elasticCost', 'polygraphyCost',
  'stickersCost', 'promoPolygraphyCost', 'inboundLogisticsCost', 'transportBoxCost', 'otherProductCost'
]);

function formatHistoryTopValue(key, v) {
  if (v === undefined || v === null) return '—';
  if (key === 'stockQty') return String(Math.max(0, Math.floor(Number(v))));
  if (['costGross', 'costNet', 'inputVat'].includes(key)) return fmtMoney(Number(v) || 0);
  if (key === 'costGrossRub') return fmtRub(Number(v) || 0);
  if (key === 'rubCourse') return String(rubFmt.format(Number(v) || 0));
  if (['length', 'width', 'height', 'volumeLiters'].includes(key)) return String(Number(v) || 0);
  return String(v);
}

function formatHistoryCalcCell(key, v) {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'number') {
    if (HISTORY_CALC_MONEY_KEYS.has(key)) return fmtMoney(v);
    return String(v);
  }
  return String(v);
}

function diffProductForChangeHistory(oldP, snap) {
  const out = [];
  Object.keys(HISTORY_TOP_LABELS).forEach(k => {
    const label = HISTORY_TOP_LABELS[k];
    const a = oldP[k];
    const b = snap[k];
    if (k === 'stockQty') {
      const ia = Math.max(0, Math.floor(Number(a || 0)));
      const ib = Math.max(0, Math.floor(Number(b || 0)));
      if (ia !== ib) {
        out.push({ field: label, oldVal: String(ia), newVal: String(ib) });
      }
      return;
    }
    if (['costGross', 'costNet', 'inputVat', 'costGrossRub', 'rubCourse', 'length', 'width', 'height', 'volumeLiters'].includes(k)) {
      const na = Number(a || 0);
      const nb = Number(b || 0);
      if (Math.abs(na - nb) > 1e-9) {
        out.push({ field: label, oldVal: formatHistoryTopValue(k, na), newVal: formatHistoryTopValue(k, nb) });
      }
      return;
    }
    if (String(a ?? '').trim() !== String(b ?? '').trim()) {
      out.push({ field: label, oldVal: String(a ?? ''), newVal: String(b ?? '') });
    }
  });
  const cOld = oldP.calc || {};
  const cNew = snap.calc || {};
  const keys = new Set([...Object.keys(cOld), ...Object.keys(cNew)]);
  keys.forEach(key => {
    const ov = cOld[key];
    const nv = cNew[key];
    const sa = typeof ov === 'number' ? ov : JSON.stringify(ov ?? '');
    const sb = typeof nv === 'number' ? nv : JSON.stringify(nv ?? '');
    if (sa !== sb) {
      const label = HISTORY_CALC_LABELS[key] || `Калькуляция · ${key}`;
      out.push({
        field: label,
        oldVal: formatHistoryCalcCell(key, ov),
        newVal: formatHistoryCalcCell(key, nv)
      });
    }
  });
  return out;
}

function resetCostCalculatorForm() {
  state.productsEdit.recordId = null;
  const textIds = [
    'sku',
    'productArticle1c',
    'productCode1c',
    'productLink',
    'mpSkuUzum',
    'mpUzumBarcode',
    'mpWbNmid',
    'mpSkuYandex'
  ];
  textIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const productStockQty = document.getElementById('productStockQty');
  if (productStockQty) productStockQty.value = '0';
  const rubEl = document.getElementById('costRubUzRate');
  if (rubEl) rubEl.value = '130';
  const numDefaults = [
    ['fabricPrice', '0'], ['fabricConsumption', '0'], ['fabricVatRate', '12'],
    ['sewingCost', '0'], ['packageCost', '0'], ['zipperCost', '0'], ['elasticCost', '0'],
    ['polygraphyCost', '0'], ['stickersCost', '0'], ['promoPolygraphyCost', '0'],
    ['inboundLogisticsCost', '0'], ['transportBoxCost', '0'], ['otherProductCost', '0']
  ];
  numDefaults.forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  });
  const sel = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  sel('fabricVatIncluded', 'with');
  sel('fabricUnit', 'm');
  ['sewingCostVatIncluded', 'packageCostVatIncluded', 'zipperCostVatIncluded', 'elasticCostVatIncluded',
    'polygraphyCostVatIncluded', 'stickersCostVatIncluded', 'promoPolygraphyCostVatIncluded',
    'inboundLogisticsCostVatIncluded', 'transportBoxCostVatIncluded', 'otherProductCostVatIncluded'].forEach(id => sel(id, 'with'));
  [['uzumLengthCm', '0'], ['uzumWidthCm', '0'], ['uzumHeightCm', '0'],
    ['productStorageDays', '0'], ['productTurnover', '90'], ['productNewSkuDays', '10']].forEach(([id, v]) => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  });
  const pow = document.getElementById('productOnWarehouse');
  if (pow) pow.value = 'no';
  const pss = document.getElementById('productStockStatus');
  if (pss) pss.value = 'existing';
  document.getElementById('productWarehouseDetails')?.classList.add('hidden');
  document.getElementById('productNewSkuBlock')?.classList.add('hidden');
  updateUzumLitersDisplay();
  syncCostFormHiddenSku();
}

function updateCostSaveToolbar() {
  const shipmentMode = !!wmsState.shipmentCalcEdit?.active;
  const shipBar = document.getElementById('shipmentCalcModeBar');
  if (shipBar) shipBar.classList.toggle('hidden', !shipmentMode);
  if (shipmentMode) {
    document.getElementById('costEditActions')?.classList.add('hidden');
    document.getElementById('saveProductToDbBtn')?.classList.add('hidden');
    document.getElementById('exportToDbBtn')?.classList.add('hidden');
    return;
  }
  const editing = state.productsEdit.recordId != null && String(state.productsEdit.recordId) !== '';
  const costBar = document.getElementById('costEditActions');
  const saveDb = document.getElementById('saveProductToDbBtn');
  const exportDb = document.getElementById('exportToDbBtn');
  if (costBar) costBar.classList.toggle('hidden', !editing);
  if (saveDb) saveDb.classList.toggle('hidden', !!editing);
  if (exportDb) exportDb.classList.toggle('hidden', !!editing);
}

function saveProductChangesFromCalculator() {
  if (wmsState.shipmentCalcEdit?.active) {
    alert('Сейчас открыт режим поставки — используйте «Сохранить в поставку» или «Отмена».');
    return;
  }
  if (!['uzum', 'wb'].includes(getCurrentMarketplace())) {
    alert('Калькуляция для этого маркетплейса в разработке. Переключитесь на Uzum или WB для сохранения.');
    return;
  }
  const editingId = state.productsEdit.recordId;
  if (editingId == null || String(editingId) === '') {
    alert('Откройте товар для редактирования из базы или из детализации.');
    return;
  }
  let snap = snapshotCurrentProduct();
  if (!snap) return;
  const products = readProductsSafe();
  const idx = products.findIndex(p => recordIdsEqual(p.recordId, editingId));
  if (idx < 0) {
    alert('Товар не найден в базе.');
    return;
  }
  const existing = products[idx];
  snap = mergeProductVghFromExisting(snap, existing);
  // Разрешаем редактирование карточки без создания новой: сохраняем recordId и исходный sku как ключ записи.
  // Иначе любое изменение артикулов/полей может "пересчитать" sku и заблокировать сохранение.
  snap.sku = existing.sku;

  // Защита от дублей по паре (Артикул 1С + Код 1С): если меняли эти поля и такой товар уже есть — не сохраняем.
  const nextA1 = String(snap.article1c || '').trim();
  const nextC1 = String(snap.code1c || '').trim();
  const dupIdx = products.findIndex(p =>
    !recordIdsEqual(p.recordId, existing.recordId)
    && String(p.article1c || '').trim() === nextA1
    && String(p.code1c || '').trim() === nextC1
  );
  if (nextA1 && nextC1 && dupIdx >= 0) {
    alert('Товар с таким Артикулом 1С и Кодом 1С уже существует в базе. Измените значения или редактируйте существующую карточку.');
    return;
  }
  const changes = diffProductForChangeHistory(existing, snap);
  if (!changes.length) {
    alert('Нет изменений для сохранения.');
    return;
  }
  const prevHist = Array.isArray(existing.changeHistory) ? existing.changeHistory : [];
  const entry = { at: new Date().toISOString(), changes };
  const savedRid = existing.recordId;
  const returnModal = !!state.costEditSession.returnToDetailModal;
  const prevStock = Math.max(0, Math.floor(Number(existing.stockQty || 0)));
  const nextStock = Math.max(0, Math.floor(Number(snap.stockQty ?? existing.stockQty ?? 0)));
  products[idx] = {
    ...existing,
    ...snap,
    recordId: existing.recordId,
    id: String(existing.recordId),
    stockQty: nextStock,
    updatedAt: new Date().toISOString(),
    changeHistory: [...prevHist, entry]
  };
  writeStore(STORAGE_KEYS.products, products);
  upsertProductToFirestore(products[idx]);
  recordProductStockAudit(String(savedRid), prevStock, nextStock, 'product_edit_save', { source: 'calculator' });
  renderProductsDb();
  if (typeof renderShipmentSelectors === 'function') renderShipmentSelectors();
  if (typeof renderAnalyticsSelectors === 'function') renderAnalyticsSelectors();
  if (typeof renderStockAdjustSelector === 'function') renderStockAdjustSelector();

  state.costEditSession.returnToDetailModal = false;
  state.productsEdit.recordId = null;
  resetCostCalculatorForm();
  updateCostSaveToolbar();
  renderProductCost();

  if (returnModal) {
    openProductDetail(String(savedRid));
  } else {
    openPage('products-tab');
  }
  alert('Изменения сохранены.');
}

function saveCurrentProductToDb() {
  if (wmsState.shipmentCalcEdit?.active) {
    alert('Сейчас открыт режим поставки — используйте «Сохранить в поставку» или «Отмена».');
    return;
  }
  if (!['uzum', 'wb'].includes(getCurrentMarketplace())) {
    alert('Калькуляция для этого маркетплейса в разработке. Переключитесь на Uzum или WB для сохранения в базу.');
    return;
  }
  let snap = snapshotCurrentProduct();
  if (!snap) return;
  const products = readProductsSafe();
  const prevStockByRid = new Map(
    products.map(p => [String(p.recordId), Math.max(0, Math.floor(Number(p.stockQty || 0)))])
  );
  const editingId = state.productsEdit.recordId;
  const mergeIdx = editingId != null ? products.findIndex(p => recordIdsEqual(p.recordId, editingId)) : -1;
  if (mergeIdx >= 0) snap = mergeProductVghFromExisting(snap, products[mergeIdx]);
  const now = new Date().toISOString();
  const newRecordId = Date.now();

  const basePayload = {
    ...snap,
    updatedAt: now,
    stockQty: Math.max(0, Math.floor(Number(snap.stockQty ?? 0)))
  };

  let nextEditRecordId = state.productsEdit.recordId;

  if (editingId != null) {
    const idx = products.findIndex(p => recordIdsEqual(p.recordId, editingId));
    if (idx >= 0) {
      const existing = products[idx];
      const skuChanged = String(existing.sku || '').trim() !== String(snap.sku || '').trim();
      if (skuChanged) {
        const rid = newRecordId;
        products.push({
          ...mergeProductVghFromExisting(basePayload, existing),
          recordId: rid,
          id: String(rid),
          stockQty: Math.max(0, Math.floor(Number(snap.stockQty ?? 0))),
          changeHistory: Array.isArray(existing.changeHistory) ? deepCloneJson(existing.changeHistory) : []
        });
        nextEditRecordId = rid;
      } else {
        products[idx] = {
          ...existing,
          ...basePayload,
          recordId: existing.recordId,
          id: String(existing.recordId),
          stockQty: Math.max(0, Math.floor(Number(snap.stockQty ?? existing.stockQty ?? 0)))
        };
        nextEditRecordId = existing.recordId;
      }
    } else {
      const rid = newRecordId;
      products.push({
        ...basePayload,
        recordId: rid,
        id: String(rid),
        stockQty: Math.max(0, Math.floor(Number(snap.stockQty ?? 0)))
      });
      nextEditRecordId = rid;
    }
  } else {
    const rid = newRecordId;
    products.push({
      ...basePayload,
      recordId: rid,
      id: String(rid)
    });
    nextEditRecordId = rid;
  }

  state.productsEdit.recordId = nextEditRecordId;

  writeStore(STORAGE_KEYS.products, products);
  const saved = findProductByRecordId(products, nextEditRecordId);
  if (saved) {
    const prevS = prevStockByRid.has(String(nextEditRecordId)) ? prevStockByRid.get(String(nextEditRecordId)) : 0;
    const newS = Math.max(0, Math.floor(Number(saved.stockQty || 0)));
    if (prevS !== newS) recordProductStockAudit(String(nextEditRecordId), prevS, newS, 'product_save_db', { path: 'saveCurrentProductToDb' });
    if (!prevStockByRid.has(String(nextEditRecordId))) {
      recordActivityLogOnly('product_create', String(nextEditRecordId), null, newS, { article1c: saved.article1c, code1c: saved.code1c });
    }
    upsertProductToFirestore(saved);
  }
  renderProductsDb();
  if (typeof renderShipmentSelectors === 'function') renderShipmentSelectors();
  if (typeof renderAnalyticsSelectors === 'function') renderAnalyticsSelectors();
  if (typeof renderStockAdjustSelector === 'function') renderStockAdjustSelector();
  updateCostSaveToolbar();
  alert('Товар сохранён в базу.');
}

function exportToDbFromCalculator() {
  if (wmsState.shipmentCalcEdit?.active) {
    alert('Сейчас открыт режим поставки — используйте «Сохранить в поставку» или «Отмена».');
    return;
  }
  if (!['uzum', 'wb'].includes(getCurrentMarketplace())) {
    alert('Калькуляция для этого маркетплейса в разработке. Переключитесь на Uzum или WB для экспорта в базу.');
    return;
  }
  const article1c = (document.getElementById('productArticle1c')?.value || '').trim();
  const mpUz = (document.getElementById('mpSkuUzum')?.value || '').trim();
  const mpWb = (document.getElementById('mpWbNmid')?.value || '').trim();
  const mpYa = (document.getElementById('mpSkuYandex')?.value || '').trim();
  if (!article1c && !mpUz && !mpWb && !mpYa) {
    alert('Укажите артикул 1С или хотя бы один код в блоке «Связки с маркетплейсами».');
    return;
  }
  const snap = snapshotCurrentProduct();
  if (!snap) return;
  const products = readProductsSafe();
  const code1c = (document.getElementById('productCode1c')?.value || '').trim();
  const normArticle1c = article1c.trim();
  const normCode1c = code1c.trim();
  // Уникальность товара: ТОЛЬКО по паре (Артикул 1С + Код 1С).
  // Если артикул совпал, но код другой — это новая позиция.
  const dupIdx = products.findIndex(p =>
    normArticle1c
    && String(p.article1c || '').trim() === normArticle1c
    && String(p.code1c || '').trim() === normCode1c
  );
  const now = new Date().toISOString();
  if (dupIdx >= 0) {
    if (!confirm('Товар с таким Артикулом 1С и Кодом 1С уже в базе. Обновить карточку?')) return;
    const existing = products[dupIdx];
    const prevHist = Array.isArray(existing.changeHistory) ? existing.changeHistory : [];
    const merged = mergeProductVghFromExisting(snap, existing);
    const changes = diffProductForChangeHistory(existing, merged);
    const entry = changes.length ? { at: now, changes } : null;
    const prevStock = Math.max(0, Math.floor(Number(existing.stockQty || 0)));
    const newStock = Math.max(0, Math.floor(Number(snap.stockQty ?? existing.stockQty ?? 0)));
    products[dupIdx] = {
      ...existing,
      ...merged,
      recordId: existing.recordId,
      id: String(existing.recordId),
      stockQty: newStock,
      updatedAt: now,
      changeHistory: entry ? [...prevHist, entry] : prevHist
    };
    if (prevStock !== newStock) {
      recordProductStockAudit(String(existing.recordId), prevStock, newStock, 'product_export_update', { path: 'exportToDbFromCalculator' });
    }
    upsertProductToFirestore(products[dupIdx]);
  } else {
    const rid = Date.now();
    const created = {
      ...snap,
      recordId: rid,
      id: String(rid),
      updatedAt: now,
      changeHistory: []
    };
    products.push(created);
    const ns = Math.max(0, Math.floor(Number(created.stockQty || 0)));
    if (ns) recordProductStockAudit(String(rid), 0, ns, 'product_create', { path: 'exportToDbFromCalculator' });
    else recordActivityLogOnly('product_create', String(rid), null, created.article1c || '', { code1c: created.code1c, stockQty: 0 });
    upsertProductToFirestore(created);
  }
  writeStore(STORAGE_KEYS.products, products);
  state.productsEdit.recordId = null;
  renderProductsDb();
  if (typeof renderShipmentSelectors === 'function') renderShipmentSelectors();
  if (typeof renderAnalyticsSelectors === 'function') renderAnalyticsSelectors();
  if (typeof renderStockAdjustSelector === 'function') renderStockAdjustSelector();
  updateCostSaveToolbar();
  resetCostCalculatorForm();
  renderProductCost();
  alert(dupIdx >= 0 ? 'Товар успешно обновлён в Базе' : 'Товар успешно добавлен в Базу');
}

function loadProductIntoCalculator(product, preserveTab=false, options = {}) {
  if (typeof options.returnToDetailModal === 'boolean') {
    state.costEditSession.returnToDetailModal = options.returnToDetailModal;
  }
  state.productsEdit.recordId = product.recordId != null && String(product.recordId) !== ''
    ? product.recordId
    : null;
  document.getElementById('productArticle1c').value = product.article1c || '';
  document.getElementById('productCode1c').value = product.code1c || '';
  document.getElementById('productStockQty').value = Math.max(0, Math.floor(Number(product.stockQty || 0)));
  if (document.getElementById('productCategory')) {
    document.getElementById('productCategory').value = String(product.category || product.calc?.productCategory || '').trim();
  }
  document.getElementById('productLink').value = product.link || '';
  const c = product.calc || {};
  const ids = [
    'productArticle1c','productCode1c','productStockQty',
    'fabricPrice','fabricConsumption','fabricUnit','fabricVatIncluded','fabricVatRate',
    'sewingCost','packageCost','zipperCost','elasticCost','polygraphyCost','stickersCost',
    'promoPolygraphyCost','inboundLogisticsCost','transportBoxCost','otherProductCost',
    'sewingCostVatIncluded','packageCostVatIncluded','zipperCostVatIncluded','elasticCostVatIncluded',
    'polygraphyCostVatIncluded','stickersCostVatIncluded','promoPolygraphyCostVatIncluded',
    'inboundLogisticsCostVatIncluded','transportBoxCostVatIncluded','otherProductCostVatIncluded'
  ];
  ids.forEach(id => {
    if (c[id] !== undefined && document.getElementById(id)) {
      document.getElementById(id).value = c[id];
    }
  });
  const mpU = document.getElementById('mpSkuUzum');
  const mpW = document.getElementById('mpWbNmid');
  const mpY = document.getElementById('mpSkuYandex');
  if (mpU) mpU.value = String(product.uzumSku ?? product.uzum_sku ?? c.mpSkuUzum ?? '').trim();
  const mpBc = document.getElementById('mpUzumBarcode');
  if (mpBc) mpBc.value = normalizeUzumBarcode(product.uzum_barcode);
  if (mpW) mpW.value = String(product.wbSku ?? product.wb_nmid ?? c.mpWbNmid ?? '').trim();
  if (mpY) mpY.value = String(product.yandexSku ?? product.yandex_sku ?? c.mpSkuYandex ?? '').trim();
  const uzl = c.uzumLengthCm != null ? n(c.uzumLengthCm) : n(product.length) / 10;
  const uzw = c.uzumWidthCm != null ? n(c.uzumWidthCm) : n(product.width) / 10;
  const uzh = c.uzumHeightCm != null ? n(c.uzumHeightCm) : n(product.height) / 10;
  const setIf = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.value = String(v);
  };
  setIf('uzumLengthCm', uzl);
  setIf('uzumWidthCm', uzw);
  setIf('uzumHeightCm', uzh);
  if (c.productOnWarehouse != null && document.getElementById('productOnWarehouse')) {
    document.getElementById('productOnWarehouse').value = String(c.productOnWarehouse);
  }
  if (c.productStorageDays != null) setIf('productStorageDays', n(c.productStorageDays));
  if (c.productTurnover != null) setIf('productTurnover', n(c.productTurnover));
  if (c.productStockStatus != null && document.getElementById('productStockStatus')) {
    document.getElementById('productStockStatus').value = String(c.productStockStatus);
  }
  if (c.productNewSkuDays != null) setIf('productNewSkuDays', n(c.productNewSkuDays));
  const rubSaved = c.costRubUzRate != null ? n(c.costRubUzRate) : n(product.rubCourse);
  if (document.getElementById('costRubUzRate') && rubSaved > 0) {
    document.getElementById('costRubUzRate').value = String(rubSaved);
  }
  updateUzumLitersDisplay();
  syncUzumCostWarehouseUi();
  syncCostFormHiddenSku();
  renderProductCost();
  if (!preserveTab) {
    openPage('cost-tab');
  }
  updateCostSaveToolbar();
}

function deleteProductFromDb(recordId) {
  recordActivityLogOnly('product_delete', String(recordId), 'deleted', null, {});
  const products = readProductsSafe().filter(p => !recordIdsEqual(p.recordId, recordId));
  writeStore(STORAGE_KEYS.products, products);
  deleteProductFromFirestore(recordId);
  renderProductsDb();
  // Эти функции могут отсутствовать в ранней версии файла — поэтому проверяем.
  if (typeof renderShipmentSelectors === 'function') renderShipmentSelectors();
  if (typeof renderAnalyticsSelectors === 'function') renderAnalyticsSelectors();
  if (typeof renderStockAdjustSelector === 'function') renderStockAdjustSelector();
}

function renderProductsDb() {
  // Backward-compatible entry point for older calls.
  filterProducts();
}

function updateProductStockInline(recordId, qty) {
  const products = readProductsSafe();
  const idx = products.findIndex(p => recordIdsEqual(p.recordId, recordId));
  if (idx < 0) return;
  const prev = Math.max(0, Math.floor(Number(products[idx].stockQty || 0)));
  const next = Math.max(0, Math.floor(Number(qty || 0)));
  products[idx] = { ...products[idx], stockQty: next, updatedAt: new Date().toISOString() };
  writeStore(STORAGE_KEYS.products, products);
  upsertProductToFirestore(products[idx]);
  recordProductStockAudit(String(recordId), prev, next, 'manual_stock_inline', {});
  renderProductsDb();
}

let currentDetailRecordId = null;

function openProductDetail(recordId) {
  const product = findProductByRecordId(readProductsSafe(), recordId);
  if (!product) return;
  currentDetailRecordId = recordId;
  renderProductDetail(product);
  setModalOpen('productDetailModal', true);
}

function closeProductDetail() {
  currentDetailRecordId = null;
  setModalOpen('productDetailModal', false);
}

function saveProductUzumBarcodeFromDetail() {
  const rid = currentDetailRecordId;
  if (rid == null || String(rid) === '') return;
  const products = readProductsSafe();
  const idx = products.findIndex(p => recordIdsEqual(p.recordId, rid));
  if (idx < 0) {
    alert('Товар не найден в базе.');
    return;
  }
  const input = document.getElementById('productDetailUzumBarcode');
  const nextBarcode = normalizeUzumBarcode(input?.value);
  const existing = products[idx];
  const prevBarcode = normalizeUzumBarcode(existing.uzum_barcode);
  if (prevBarcode === nextBarcode) {
    alert('Нет изменений для сохранения.');
    return;
  }
  const prevHist = Array.isArray(existing.changeHistory) ? existing.changeHistory : [];
  const updated = {
    ...existing,
    uzum_barcode: nextBarcode,
    updatedAt: new Date().toISOString(),
    changeHistory: [...prevHist, {
      at: new Date().toISOString(),
      changes: [{ field: 'Штрихкод Uzum', oldVal: prevBarcode || '—', newVal: nextBarcode || '—' }]
    }]
  };
  products[idx] = updated;
  writeStore(STORAGE_KEYS.products, products);
  upsertProductToFirestore(updated);
  renderProductsDb();
  if (typeof renderShipmentSelectors === 'function') renderShipmentSelectors();
  if (typeof renderAnalyticsSelectors === 'function') renderAnalyticsSelectors();
  if (typeof renderStockAdjustSelector === 'function') renderStockAdjustSelector();
  alert('Штрихкод Uzum сохранён.');
}

function renderProductDetail(product) {
  const title = document.getElementById('productDetailTitle');
  const sub = document.getElementById('productDetailSub');
  const barcode = document.getElementById('productDetailBarcode');
  const linkBtn = document.getElementById('productDetailLinkBtn');
  const avatar = document.getElementById('productDetailAvatar');
  const uzumSkuEl = document.getElementById('productDetailUzumSku');
  const uzumBarcodeInput = document.getElementById('productDetailUzumBarcode');

  const art = String(product.article1c || '').trim();
  const uzumSku = String(product.uzumSku ?? product.uzum_sku ?? product.calc?.mpSkuUzum ?? '').trim();
  if (avatar) avatar.textContent = getInitials(art || product.sku || 'YO');
  if (title) title.textContent = art || 'Нет артикула 1С';
  if (sub) sub.textContent = `Артикул 1С: ${art || '—'}`;
  if (barcode) barcode.textContent = product.barcode ? String(product.barcode) : '—';
  if (uzumSkuEl) uzumSkuEl.textContent = uzumSku || '—';
  if (uzumBarcodeInput) uzumBarcodeInput.value = normalizeUzumBarcode(product.uzum_barcode);
  if (linkBtn) {
    const has = !!product.link;
    linkBtn.href = has ? product.link : '#';
    linkBtn.classList.toggle('disabled', !has);
    linkBtn.setAttribute('aria-disabled', has ? 'false' : 'true');
    if (!has) linkBtn.setAttribute('tabindex', '-1'); else linkBtn.removeAttribute('tabindex');
  }

  // Калькуляция (используем текущие параметры из юнита)
  const unit = computeUnitEconomicsForProduct(product);
  setText('detailSkuVal', product.article1c || product.sku || '—');
  setText('detailLitersVal', unit.liters.toFixed(2).replace('.', ','));
  setText('detailRoundedLitersVal', unit.roundedLiters.toLocaleString('ru-RU'));
  setText('detailCostVal', fmtMoney(unit.cost));
  setText('detailLogisticsVal', fmtMoney(unit.logistics));
  setText('detailPriceVal', fmtMoney(unit.price));
  setText('detailProfitVal', fmtMoney(unit.profit));
  setText('detailTotalCostsVal', fmtMoney(unit.totalCosts));
  setText('detailMarginVal', fmtPct(unit.margin));
  setText('detailRoiVal', fmtPct(unit.roi));

  // Аналитика по поставкам (live-снимок Firestore, структура — гибкая)
  renderDetailShipments(product.sku || '');
  renderProductHistory(product);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function computeUnitEconomicsForProduct(product) {
  const price = n(document.getElementById('price')?.value);
  const commissionPct = n(document.getElementById('commission')?.value);
  const vatRate = n(document.getElementById('vatRate')?.value);
  const saleVatMode = document.getElementById('saleVatMode')?.value || 'with';
  const costVatMode = document.getElementById('costVatMode')?.value || 'with';
  const logisticsTariff = document.getElementById('logisticsTariff')?.value || 'new';

  const cost = Number(product?.costGross ?? 0) || n(document.getElementById('cost')?.value);
  const length = Number(product?.length ?? 0) || n(document.getElementById('length')?.value);
  const width = Number(product?.width ?? 0) || n(document.getElementById('width')?.value);
  const height = Number(product?.height ?? 0) || n(document.getElementById('height')?.value);
  const turnover = n(document.getElementById('turnover')?.value);
  const stockStatus = document.getElementById('stockStatus')?.value || 'existing';
  const newSkuDays = n(document.getElementById('newSkuDays')?.value);

  const liters = (length * width * height) / 1000000;
  const roundedLiters = liters > 0 ? Math.ceil(liters) : 0;
  const sumCm = (Number(length || 0) + Number(width || 0) + Number(height || 0)) / 10;
  const oldLog = calcLogisticsOldTariff(sumCm, price);

  const logistics = logisticsTariff === 'old'
    ? oldLog.amount
    : calcLogistics(roundedLiters);

  const storage = logisticsTariff === 'old'
    ? calcStoragePerDayOldTariff(oldLog.category, turnover, stockStatus, newSkuDays)
    : calcStoragePerDay(roundedLiters, turnover, stockStatus, newSkuDays);

  const commissionAmount = price * commissionPct / 100;
  const outputVat = vatFromAmount(price, vatRate, saleVatMode);
  const inputVat = Number(product?.inputVat ?? 0) || vatFromAmount(cost, vatRate, costVatMode);
  const vatPayable = outputVat - inputVat;
  const totalCosts = cost + commissionAmount + logistics + storage.amount + vatPayable;
  const profit = price - totalCosts;
  const margin = price > 0 ? (profit / price) * 100 : 0;
  const roi = cost > 0 ? (profit / cost) * 100 : 0;

  return {
    price,
    cost,
    liters,
    roundedLiters,
    logistics,
    storagePerDay: storage.amount,
    totalCosts,
    profit,
    margin,
    roi,
    commissionAmount,
    outputVat,
    inputVat,
    vatPayable
  };
}

function renderDetailShipments(sku) {
  const shipments = readStore(STORAGE_KEYS.shipments, []);
  const rows = collectSkuShipmentRows(shipments, sku);

  const byDay = groupRows(rows, r => r.dayKey);
  const byWeek = groupRows(rows, r => r.weekKey);
  const byMonth = groupRows(rows, r => r.monthKey);

  renderAggTable('detailShipmentsByDayBody', 'detailShipmentsEmptyDay', byDay, true);
  renderAggTable('detailShipmentsByWeekBody', 'detailShipmentsEmptyWeek', byWeek, false);
  renderAggTable('detailShipmentsByMonthBody', 'detailShipmentsEmptyMonth', byMonth, false);
}

function collectSkuShipmentRows(shipments, sku) {
  const out = [];
  const arr = Array.isArray(shipments) ? shipments : [];
  arr.forEach(sh => {
    if (shipmentRecordStatus(sh) === 'draft') return;
    const date = sh?.date || sh?.shipmentDate || sh?.createdAt || sh?.updatedAt || '';
    const d = date ? new Date(date) : null;
    const isoDay = d && !Number.isNaN(d.valueOf()) ? d.toISOString().slice(0,10) : (String(date).slice(0,10) || '—');
    const weekKey = isoWeekKey(d);
    const monthKey = isoDay !== '—' ? isoDay.slice(0,7) : '—';
    let items = Array.isArray(sh?.items) ? sh.items : (Array.isArray(sh?.positions) ? sh.positions : []);
    if (sh?.version === 2 && Array.isArray(sh.boxes)) {
      const flat = [];
      sh.boxes.forEach(box => {
        (box.items || []).forEach(it => flat.push(it));
      });
      items = flat.length ? flat : items;
    }
    items.forEach(it => {
      const itSku = String(it?.sku || it?.SKU || '').trim();
      if (!itSku || itSku !== sku) return;
      const qty = Number(it?.qty ?? it?.quantity ?? 0) || 0;
      const unitCost = Number(
        it?.unitCost ?? it?.financialSnapshot?.costGross ?? it?.cost ?? it?.cogs ?? 0
      ) || 0;
      out.push({
        dayKey: isoDay,
        weekKey,
        monthKey,
        qty,
        amount: qty * unitCost
      });
    });
  });
  return out;
}

function groupRows(rows, keyFn) {
  const m = new Map();
  rows.forEach(r => {
    const k = keyFn(r) || '—';
    const prev = m.get(k) || { key: k, qty: 0, amount: 0 };
    prev.qty += Number(r.qty || 0);
    prev.amount += Number(r.amount || 0);
    m.set(k, prev);
  });
  const res = Array.from(m.values());
  res.sort((a,b) => String(b.key).localeCompare(String(a.key)));
  return res;
}

function renderAggTable(tbodyId, emptyId, rows, isDay) {
  const tbody = document.getElementById(tbodyId);
  const empty = document.getElementById(emptyId);
  if (!tbody || !empty) return;
  tbody.innerHTML = '';
  empty.classList.toggle('hidden', rows.length !== 0);
  rows.forEach(r => {
    const tr = document.createElement('tr');
    const label = isDay && r.key !== '—' ? fmtDate(r.key) : r.key;
    tr.innerHTML = `<td>${escapeHtml(label)}</td><td>${Number(r.qty||0).toLocaleString('ru-RU')}</td><td>${escapeHtml(fmtMoney(r.amount||0))}</td>`;
    tbody.appendChild(tr);
  });
}

function isoWeekKey(d) {
  if (!(d instanceof Date) || Number.isNaN(d.valueOf())) return '—';
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
}

function getInitials(text) {
  const s = String(text || '').trim();
  if (!s) return 'YO';
  const parts = s.split(/\s+/).filter(Boolean);
  const a = (parts[0] || s).slice(0,1).toUpperCase();
  const b = (parts[1] || '').slice(0,1).toUpperCase();
  return (a + b) || 'YO';
}

function cssEscape(s) {
  try { return CSS.escape(s); } catch { return String(s).replace(/["\\]/g, '\\$&'); }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, '&#96;');
}

function setDetailTab(tab) {
  document.querySelectorAll('[data-detail-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-detail-tab') === tab);
  });
  document.getElementById('detail-tab-calc')?.classList.toggle('active', tab === 'calc');
  document.getElementById('detail-tab-analytics')?.classList.toggle('active', tab === 'analytics');
  document.getElementById('detail-tab-history')?.classList.toggle('active', tab === 'history');
}

function renderProductHistory(product) {
  const list = document.getElementById('productHistoryList');
  const empty = document.getElementById('productHistoryEmpty');
  if (!list || !empty) return;
  list.innerHTML = '';
  const hist = Array.isArray(product?.changeHistory) ? product.changeHistory : [];
  empty.classList.toggle('hidden', hist.length > 0);
  if (!hist.length) return;
  hist.slice().reverse().forEach(block => {
    const wrap = document.createElement('div');
    wrap.className = 'product-history-block';
    const at = block.at ? fmtDateTime(block.at) : '—';
    const ch = Array.isArray(block.changes) ? block.changes : [];
    let rows = '';
    ch.forEach(c => {
      rows += `<tr><td>${escapeHtml(c.field || '—')}</td><td>${escapeHtml(c.oldVal ?? '—')}</td><td>${escapeHtml(c.newVal ?? '—')}</td></tr>`;
    });
    wrap.innerHTML = `
      <div class="product-history-block-head">${escapeHtml(at)}</div>
      <div class="table-wrap"><table class="product-history-table"><thead><tr><th>Поле</th><th>Было</th><th>Стало</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="muted">Нет деталей</td></tr>'}</tbody></table></div>
    `;
    list.appendChild(wrap);
  });
}

function exportProductHistoryXlsx() {
  const rid = currentDetailRecordId || '';
  const product = findProductByRecordId(readProductsSafe(), rid);
  if (!product) return;
  if (typeof window === 'undefined' || !window.XLSX) {
    alert('SheetJS (XLSX) не загрузился. Проверь подключение к интернету.');
    return;
  }
  const hist = Array.isArray(product.changeHistory) ? product.changeHistory : [];
  const aoa = [['Дата изменения', 'Что изменилось', 'Старое значение', 'Новое значение']];
  hist.forEach(block => {
    const at = block.at ? fmtDateTime(block.at) : '—';
    (Array.isArray(block.changes) ? block.changes : []).forEach(c => {
      aoa.push([at, c.field || '—', c.oldVal ?? '—', c.newVal ?? '—']);
    });
  });
  if (aoa.length === 1) {
    alert('История пуста — нечего выгружать.');
    return;
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 22 }, { wch: 36 }, { wch: 28 }, { wch: 28 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'История');
  const safe = String(product.sku || 'sku').replace(/[^\w\-]+/g, '_');
  XLSX.writeFile(wb, `history_${safe}.xlsx`);
}

function exportDetailXlsx() {
  const rid = currentDetailRecordId || '';
  const product = findProductByRecordId(readProductsSafe(), rid);
  if (!product) return;
  if (typeof window === 'undefined' || !window.XLSX) {
    alert('SheetJS (XLSX) не загрузился. Проверь подключение к интернету.');
    return;
  }
  const unit = computeUnitEconomicsForProduct(product);
  const rows = [
    ['Артикул 1С', product.article1c || '—'],
    ['Ключ / SKU', product.sku || '—'],
    ['Ссылка', product.link || '—'],
    ['Цена (юнит)', unit.price],
    ['Себестоимость (COGS)', unit.cost],
    ['Логистика', unit.logistics],
    ['Хранение / день', unit.storagePerDay],
    ['Все расходы', unit.totalCosts],
    ['Прибыль', unit.profit],
    ['Маржа %', unit.margin],
    ['ROI %', unit.roi]
  ];
  const ws = XLSX.utils.aoa_to_sheet([['Показатель','Значение'], ...rows]);
  ws['!cols'] = [{ wch: 26 }, { wch: 40 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Калькуляция');
  XLSX.writeFile(wb, `product_${(product.sku || 'sku').replace(/[^\w\-]+/g,'_')}.xlsx`);
}

// ——— Импорт / Экспорт базы товаров (products) ———

function ensureXlsxReady() {
  if (typeof window === 'undefined' || !window.XLSX) {
    throw new Error('Библиотека SheetJS (XLSX) не загружена. Проверьте подключение xlsx.full.min.js.');
  }
}

function normalizeHeaderKey(h) {
  return String(h ?? '')
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function productLinkKey(article1c, code1c) {
  const a = String(article1c ?? '').trim();
  const c = String(code1c ?? '').trim();
  return `${a}_${c}`;
}

function asExcelTextSku(v) {
  const s = String(v ?? '').trim();
  return s ? `'${s}` : '';
}

function numOrZero(v) {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(x) ? x : 0;
}

function intOrZero(v) {
  const x = Math.floor(numOrZero(v));
  return x > 0 ? x : 0;
}

async function fetchAllProductsFromFirebase() {
  return readProductsSafe();
}

function extractProductName(p) {
  const name = String(p?.name ?? '').trim();
  if (name) return name;
  const a1 = String(p?.article1c ?? '').trim();
  return a1 || '';
}

function extractProductCategory(p) {
  const cat = p?.category ?? p?.cat ?? p?.productCategory;
  return String(cat ?? '').trim();
}

function extractDimsMm(p) {
  const L = Math.max(0, Math.round(numOrZero(p?.length)));
  const W = Math.max(0, Math.round(numOrZero(p?.width)));
  const H = Math.max(0, Math.round(numOrZero(p?.height)));
  return { length: L, width: W, height: H };
}

// Фильтры базы товаров (UI → логика)
if (typeof state === 'object' && state) {
  state.productsDbFilters = state.productsDbFilters || { stockMode: 'all' };
}

function getProductsDbFiltersFromUi() {
  const q = (document.getElementById('productsLiveSearch')?.value || '').trim().toLowerCase();
  const category = (document.getElementById('categoryFilter')?.value || '').trim();
  const ltRaw = (document.getElementById('productsStockLtInput')?.value || '').trim();
  const ltVal = ltRaw === '' ? null : Math.max(0, Math.floor(Number(ltRaw)));
  const stockMode = (state?.productsDbFilters?.stockMode || 'all');
  return {
    q,
    category,
    stockMode,
    stockLt: Number.isFinite(ltVal) ? ltVal : null
  };
}

function applyProductsDbFilters(products, filters) {
  const sortedAll = [...(Array.isArray(products) ? products : [])]
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  let out = sortedAll;

  if (filters?.q) out = out.filter(p => productSearchMatchesQuery(p, filters.q));

  const selectedCategory = String(filters?.category || '').trim();
  if (selectedCategory && selectedCategory !== 'Все') {
    out = out.filter(item => {
      const itemCategory = String(extractProductCategory(item) || '').trim();
      console.log(
        'Фильтр по категории:',
        selectedCategory,
        'Товар:',
        item?.name,
        'Категория товара:',
        itemCategory
      );
      return itemCategory === selectedCategory;
    });
  }

  const mode = filters?.stockMode || 'all';
  if (mode === 'zero') {
    out = out.filter(p => Math.max(0, Math.floor(Number(p.stockQty || 0))) === 0);
  } else if (mode === 'low') {
    out = out.filter(p => Math.max(0, Math.floor(Number(p.stockQty || 0))) < 10);
  } else if (mode === 'in') {
    out = out.filter(p => Math.max(0, Math.floor(Number(p.stockQty || 0))) > 10);
  }

  if (filters?.stockLt != null) {
    out = out.filter(p => Math.max(0, Math.floor(Number(p.stockQty || 0))) < filters.stockLt);
  }

  return out;
}

// Алгоритм фильтра по категориям (требуется для отладки)
function filterProducts() {
  const allProducts = readProductsSafe();
  refreshProductCategorySelectors(allProducts);
  const filters = getProductsDbFiltersFromUi();
  const selectedCategory = String(filters?.category || '').trim();

  console.log('Выбранная категория:', selectedCategory);
  console.log('Всего товаров в базе:', allProducts.length);

  const filtered = applyProductsDbFilters(allProducts, filters);
  renderProducts(filtered);
}

function refreshProductCategorySelectors(products) {
  const values = Array.from(new Set((Array.isArray(products) ? products : [])
    .map((p) => String(extractProductCategory(p) || '').trim())
    .filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'ru'));
  const filterEl = document.getElementById('categoryFilter');
  if (filterEl) {
    const cur = String(filterEl.value || '').trim();
    filterEl.innerHTML = `<option value="" selected>Все категории</option>${values.map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join('')}`;
    if (cur && values.includes(cur)) filterEl.value = cur;
  }
  const productCatEl = document.getElementById('productCategory');
  if (productCatEl) {
    const cur = String(productCatEl.value || '').trim();
    const staticOpts = Array.from(productCatEl.querySelectorAll('option')).map((o) => String(o.value || '').trim()).filter(Boolean);
    const merged = Array.from(new Set([...staticOpts, ...values])).sort((a, b) => a.localeCompare(b, 'ru'));
    productCatEl.innerHTML = `<option value="">— выберите категорию —</option>${merged.map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join('')}`;
    if (cur && merged.includes(cur)) productCatEl.value = cur;
  }
}

function renderProducts(filteredArray) {
  const products = readProductsSafe();
  const list = document.getElementById('productsCardsList');
  if (!list) return;
  list.innerHTML = '';

  document.getElementById('productsEmpty')?.classList.toggle('hidden', products.length !== 0);
  document.getElementById('productsCountVal').textContent = products.length.toLocaleString('ru-RU');
  const totalStock = products.reduce((s, p) => s + Math.max(0, Math.floor(Number(p.stockQty || 0))), 0);
  document.getElementById('productsStockTotalVal').textContent = totalStock.toLocaleString('ru-RU');
  document.getElementById('productsZeroStockVal').textContent = products.filter(p => Math.max(0, Math.floor(Number(p.stockQty || 0))) === 0).length.toLocaleString('ru-RU');
  const avgCost = products.length ? products.reduce((s,p)=>s+Number(p.costGross || 0),0) / products.length : 0;
  document.getElementById('productsAvgCostVal').textContent = fmtMoney(avgCost);
  const sorted = [...products].sort((a,b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  document.getElementById('productsLastUpdatedVal').textContent = sorted[0] ? fmtDateTime(sorted[0].updatedAt) : '—';

  const filtered = Array.isArray(filteredArray) ? filteredArray : [];
  const chip = document.getElementById('productsFilteredCountChip');
  if (chip) chip.textContent = `${filtered.length.toLocaleString('ru-RU')} найдено`;

  // Верхняя сводка (по видимым товарам)
  const stockValueUzs = computeProductsStockValueUzs(filtered);
  const stockValueEl = document.getElementById('productsStockValueTotalVal');
  if (stockValueEl) stockValueEl.textContent = fmtMoney(stockValueUzs);
  const uniqEl = document.getElementById('productsUniqueCountVal');
  if (uniqEl) uniqEl.textContent = filtered.length.toLocaleString('ru-RU');
  const outEl = document.getElementById('productsOutOfStockCountVal');
  if (outEl) outEl.textContent = filtered.filter(p => Math.max(0, Math.floor(Number(p.stockQty || 0))) === 0).length.toLocaleString('ru-RU');

  if (!products.length) return;

  const shipAgg = buildShippedQtyAnalytics(readShipmentsSafe());
  const shippedMonthByRid = shipAgg.byProductMonth;

  filtered.forEach(p => {
    const recordId = p.recordId != null ? String(p.recordId) : '';
    const card = document.createElement('div');
    card.className = 'product-card';
    if (recordId) card.dataset.recordId = recordId;
    const displayTitle = (p.article1c || '').trim();
    const safeTitle = displayTitle ? escapeHtml(displayTitle) : '';
    const safeCode = p.code1c ? escapeHtml(p.code1c) : '—';
    const stock = Math.max(0, Math.floor(Number(p.stockQty || 0)));
    const initials = getInitials(p.article1c || p.sku || 'YO');
    const costGross = Number(p.costGross || 0);
    const costNet = Number(p.costNet || 0);
    const inputVat = Number(p.inputVat || 0);
    const costRub = Number(p.costGrossRub || 0);
    const uzumSku = String(p.uzumSku ?? p.uzum_sku ?? p.calc?.mpSkuUzum ?? '').trim();
    const uzumBarcode = normalizeUzumBarcode(p.uzum_barcode);
    const wbSku = String(p.wbSku ?? p.wb_nmid ?? p.wb_nm_id ?? p.nmid ?? p.calc?.mpWbNmid ?? '').trim();
    const yandexSku = String(p.yandexSku ?? p.yandex_sku ?? p.calc?.mpSkuYandex ?? '').trim();
    const category = extractProductCategory(p);
    const monthShip = recordId ? (shippedMonthByRid.get(String(recordId)) || 0) : 0;
    const stockOutpace = monthShip > 0 && monthShip >= stock;

    const linkDisabled = !p.link ? 'disabled' : '';
    const linkHref = p.link ? escapeAttr(p.link) : '#';

    card.innerHTML = `
      <div class="product-card-top">
        <div class="product-avatar">${escapeHtml(initials)}</div>
        <div>
          <h3 class="product-card-title">${safeTitle || '<span class="muted">Нет артикула 1С</span>'}</h3>
          <div class="product-meta">
            <span class="meta-pill"><span class="k">Код</span>${safeCode}</span>
            ${category ? `<span class="meta-pill"><span class="k">Категория</span>${escapeHtml(category)}</span>` : ''}
            <span class="meta-pill"><span class="k">Обновл.</span>${p.updatedAt ? escapeHtml(fmtDateTime(p.updatedAt)) : '—'}</span>
          </div>
        </div>
      </div>

      <div class="product-metrics-primary">
        <div class="metric-box product-metric-cell">
          <div class="label">Себестоимость</div>
          <div class="value">${escapeHtml(fmtMoney(costGross))}</div>
        </div>
        <div class="metric-box product-metric-cell">
          <div class="label">Без НДС</div>
          <div class="value">${escapeHtml(fmtMoney(costNet))}</div>
        </div>
        <div class="metric-box product-metric-cell">
          <div class="label">Входящий НДС</div>
          <div class="value">${escapeHtml(fmtMoney(inputVat))}</div>
        </div>
      </div>
      <div class="product-cost-rub-banner">
        <span class="product-rub-icon" aria-hidden="true">₽</span>
        <div class="product-cost-rub-body">
          <div class="label">Себестоимость в рублях</div>
          <div class="value">${costRub > 0 ? escapeHtml(fmtRub(costRub)) : '—'}</div>
        </div>
      </div>

      ${(uzumSku || uzumBarcode || wbSku || yandexSku) ? `
        <div class="product-mp-skus" aria-label="SKU маркетплейсов">
          ${uzumSku ? `
            <div class="product-mp-sku-pill product-mp-sku-pill--uzum">
              <span class="k">Uzum SKU</span>
              <span class="v">${escapeHtml(uzumSku)}</span>
            </div>
          ` : ''}
          ${uzumBarcode ? `
            <div class="product-mp-sku-pill product-mp-sku-pill--uzum">
              <span class="k">Штрихкод Uzum</span>
              <span class="v">${escapeHtml(uzumBarcode)}</span>
            </div>
          ` : ''}
          ${wbSku ? `
            <div class="product-mp-sku-pill product-mp-sku-pill--wb">
              <span class="k">WB SKU</span>
              <span class="v">${escapeHtml(wbSku)}</span>
            </div>
          ` : ''}
          ${yandexSku ? `
            <div class="product-mp-sku-pill product-mp-sku-pill--yandex">
              <span class="k">Yandex SKU</span>
              <span class="v">${escapeHtml(yandexSku)}</span>
            </div>
          ` : ''}
        </div>
      ` : ''}

      <div class="product-ship-analytics${stockOutpace ? ' product-ship-analytics--risk' : ''}">
        <div class="label">Продажи / склад (календарный месяц)</div>
        <div class="value">Продано (отгрузки): <strong>${monthShip.toLocaleString('ru-RU')}</strong> шт · Текущий остаток: <strong class="${stockOutpace ? 'stock-value--outpace' : ''}">${stock.toLocaleString('ru-RU')}</strong> шт</div>
        ${stockOutpace ? '<p class="hint product-ship-warn">Темп отгрузок за месяц не ниже остатка — риск Out-of-stock.</p>' : ''}
      </div>

      <div class="metric-box">
        <div class="label">Остаток</div>
        <div class="stock-inline">
          <div class="stock-value ${stock > 0 ? '' : 'negative'}${stockOutpace ? ' stock-value--outpace' : ''}">${stock.toLocaleString('ru-RU')}</div>
          <div class="stock-edit">
            <input class="stock-input" type="number" min="0" step="1" value="${stock}" data-stock-input="${escapeAttr(recordId)}" />
            <button class="btn-secondary" data-stock-save="${escapeAttr(recordId)}">Сохранить</button>
          </div>
        </div>
        <div class="hint" style="margin-top:6px;">Кликни, измени цифру и нажми «Сохранить» — без открытия товара.</div>
      </div>

      <div class="product-card-actions">
        <a class="btn-secondary product-link-btn ${linkDisabled}" href="${linkHref}" target="_blank" rel="noopener" ${linkDisabled ? 'tabindex="-1" aria-disabled="true"' : ''}>Ссылка на товар</a>
        <button class="btn-secondary" data-product-details="${escapeAttr(recordId)}">Детализация</button>
        <button class="btn-secondary" data-load-product="${escapeAttr(recordId)}">Редактировать</button>
        <button class="btn-danger" data-delete-product="${escapeAttr(recordId)}">Удалить</button>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('[data-load-product]').forEach(btn => btn.addEventListener('click', () => {
    const recordId = btn.getAttribute('data-load-product');
    const product = findProductByRecordId(readProductsSafe(), recordId);
    if (product) loadProductIntoCalculator(product, false, { returnToDetailModal: false });
  }));
  list.querySelectorAll('[data-delete-product]').forEach(btn => btn.addEventListener('click', () => {
    const recordId = btn.getAttribute('data-delete-product');
    const product = findProductByRecordId(readProductsSafe(), recordId);
    const label = product?.article1c || product?.sku || recordId;
    if (confirm(`Удалить товар ${label} из базы?`)) deleteProductFromDb(recordId);
  }));
  list.querySelectorAll('[data-stock-save]').forEach(btn => btn.addEventListener('click', () => {
    const card = btn.closest('.product-card');
    const input = card ? card.querySelector('[data-stock-input]') : null;
    const recordId = btn.getAttribute('data-stock-save') || '';
    const qty = Math.max(0, Math.floor(Number(input?.value || 0)));
    updateProductStockInline(recordId, qty);
  }));
  list.querySelectorAll('[data-product-details]').forEach(btn => btn.addEventListener('click', () => {
    const recordId = btn.getAttribute('data-product-details');
    if (recordId) openProductDetail(recordId);
  }));
}

function productCostPriceUzs(p) {
  const v = (p && typeof p === 'object')
    ? (p.costPriceUzs ?? p.costGross ?? p.cost ?? p.costUzs)
    : 0;
  const x = Number(v);
  return Number.isFinite(x) ? Math.max(0, x) : 0;
}

function computeProductsStockValueUzs(products) {
  let sum = 0;
  (Array.isArray(products) ? products : []).forEach(p => {
    const qty = Math.max(0, Math.floor(Number(p.stockQty || 0)));
    sum += qty * productCostPriceUzs(p);
  });
  return Math.round(sum * 100) / 100;
}

async function exportProductsDbToExcelDirect() {
  ensureXlsxReady();

  const productsAll = await fetchAllProductsFromFirebase();
  const filters = getProductsDbFiltersFromUi();
  const products = applyProductsDbFilters(productsAll, filters);
  products.sort((a, b) => {
    const aa = String(a.article1c || '').localeCompare(String(b.article1c || ''), 'ru');
    if (aa !== 0) return aa;
    return String(a.code1c || '').localeCompare(String(b.code1c || ''), 'ru');
  });

  const header = [
    'Ключ-связка',
    'Название товара',
    'Артикул 1С',
    'Код 1С (Характеристика)',
    'SKU Uzum (uzumSku)',
    'Штрихкод Uzum (uzum_barcode)',
    'SKU Wildberries (wbSku)',
    'SKU Яндекс (yandexSku)',
    'Себестоимость, сум',
    'Остаток шт',
    'Категория',
    'Длина мм',
    'Ширина мм',
    'Высота мм'
  ];

  const aoa = [header];
  products.forEach(p => {
    const article1c = String(p.article1c ?? '').trim();
    const code1c = String(p.code1c ?? '').trim();
    const key = productLinkKey(article1c, code1c);
    const uz = String(p.uzumSku ?? p.uzum_sku ?? p.calc?.mpSkuUzum ?? '').trim();
    const uzBc = normalizeUzumBarcode(p.uzum_barcode);
    const wb = String(p.wbSku ?? p.wb_nmid ?? p.wb_nm_id ?? p.nmid ?? p.calc?.mpWbNmid ?? '').trim();
    const ya = String(p.yandexSku ?? p.yandex_sku ?? p.calc?.mpSkuYandex ?? '').trim();
    const costUzs = Math.round(productCostPriceUzs(p) * 100) / 100;
    const stockQty = intOrZero(p.stockQty);
    const category = String(p?.category ?? '').trim(); // выгружаем как есть; если пусто — пусто
    const dims = extractDimsMm(p);

    aoa.push([
      key,
      extractProductName(p),
      article1c,
      code1c,
      asExcelTextSku(uz),
      asExcelTextSku(uzBc),
      asExcelTextSku(wb),
      asExcelTextSku(ya),
      costUzs,
      stockQty,
      category,
      dims.length,
      dims.width,
      dims.height
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { hidden: true, wch: 18 }, // ключ-связка (для ВПР)
    { wch: 34 },
    { wch: 18 },
    { wch: 22 },
    { wch: 20 },
    { wch: 22 },
    { wch: 22 },
    { wch: 22 },
    { wch: 16 },
    { wch: 12 },
    { wch: 18 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'products');
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  XLSX.writeFile(wb, `products_export_${stamp}.xlsx`);
}

async function exportProductsDeficitToExcel() {
  ensureXlsxReady();
  const productsAll = await fetchAllProductsFromFirebase();
  const filters = getProductsDbFiltersFromUi();
  const filtered = applyProductsDbFilters(productsAll, filters);
  const deficit = filtered.filter(p => Math.max(0, Math.floor(Number(p.stockQty || 0))) === 0);
  if (!deficit.length) {
    alert('В текущих фильтрах нет товаров с остатком 0.');
    return;
  }
  const header = [
    'Ключ-связка',
    'Название товара',
    'Артикул 1С',
    'Код 1С (Характеристика)',
    'SKU Uzum (uzumSku)',
    'Штрихкод Uzum (uzum_barcode)',
    'SKU Wildberries (wbSku)',
    'SKU Яндекс (yandexSku)',
    'Себестоимость, сум',
    'Упущенная выгода, сум',
    'Остаток шт',
    'Категория',
    'Длина мм',
    'Ширина мм',
    'Высота мм'
  ];
  const aoa = [header];
  deficit.forEach(p => {
    const article1c = String(p.article1c ?? '').trim();
    const code1c = String(p.code1c ?? '').trim();
    const key = productLinkKey(article1c, code1c);
    const uz = String(p.uzumSku ?? p.uzum_sku ?? p.calc?.mpSkuUzum ?? '').trim();
    const uzBc = normalizeUzumBarcode(p.uzum_barcode);
    const wbSku = String(p.wbSku ?? p.wb_nmid ?? p.wb_nm_id ?? p.nmid ?? p.calc?.mpWbNmid ?? '').trim();
    const ya = String(p.yandexSku ?? p.yandex_sku ?? p.calc?.mpSkuYandex ?? '').trim();
    const costUzs = Math.round(productCostPriceUzs(p) * 100) / 100;
    // Упущенная выгода: минимальная оценка на базе себестоимости (без цены продажи).
    const missed = costUzs;
    const stockQty = intOrZero(p.stockQty);
    const category = extractProductCategory(p);
    const dims = extractDimsMm(p);
    aoa.push([
      key,
      extractProductName(p),
      article1c,
      code1c,
      asExcelTextSku(uz),
      asExcelTextSku(uzBc),
      asExcelTextSku(wbSku),
      asExcelTextSku(ya),
      costUzs,
      missed,
      stockQty,
      category,
      dims.length,
      dims.width,
      dims.height
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { hidden: true, wch: 18 },
    { wch: 34 },
    { wch: 18 },
    { wch: 22 },
    { wch: 20 },
    { wch: 22 },
    { wch: 22 },
    { wch: 22 },
    { wch: 16 },
    { wch: 12 },
    { wch: 18 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'дефицит');
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  XLSX.writeFile(wb, `products_deficit_${stamp}.xlsx`);
}

function buildProductsImportTemplateWorkbook() {
  ensureXlsxReady();
  const header = [
    'Ключ-связка',
    'Название товара',
    'Артикул 1С',
    'Код 1С (Характеристика)',
    'SKU Uzum (uzumSku)',
    'Штрихкод Uzum (uzum_barcode)',
    'SKU Wildberries (wbSku)',
    'SKU Яндекс (yandexSku)',
    'Себестоимость, сум',
    'Остаток шт',
    'Категория',
    'Длина мм',
    'Ширина мм',
    'Высота мм'
  ];
  const ws = XLSX.utils.aoa_to_sheet([header]);
  ws['!cols'] = [
    { hidden: true, wch: 18 }, // ключ-связка можно оставить пустым — он пересчитается при импорте
    { wch: 34 },
    { wch: 18 },
    { wch: 22 },
    { wch: 20 },
    { wch: 22 },
    { wch: 22 },
    { wch: 22 },
    { wch: 16 },
    { wch: 12 },
    { wch: 18 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'template');
  return wb;
}

function downloadProductsImportTemplate() {
  const wb = buildProductsImportTemplateWorkbook();
  XLSX.writeFile(wb, 'products_import_template.xlsx');
}

function readXlsxFirstSheetToMatrix(arrayBuffer) {
  ensureXlsxReady();
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  if (!wb.SheetNames || !wb.SheetNames.length) throw new Error('Пустой Excel.');
  const ws = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  return matrix;
}

function buildHeaderIndexMap(headerRow) {
  const idx = new Map();
  (headerRow || []).forEach((h, i) => {
    const key = normalizeHeaderKey(h);
    if (!key) return;
    if (!idx.has(key)) idx.set(key, i);
  });
  return idx;
}

function pickCell(row, headerIdx, ...possibleHeaders) {
  for (const h of possibleHeaders) {
    const key = normalizeHeaderKey(h);
    const i = headerIdx.get(key);
    if (i != null && i >= 0) return row[i];
  }
  return '';
}

function stripLeadingApostrophe(v) {
  const s = String(v ?? '').trim();
  return s.startsWith("'") ? s.slice(1) : s;
}

async function importProductsFromXlsxFile(file) {
  ensureXlsxReady();
  if (!file) return;
  if (!String(file.name || '').toLowerCase().endsWith('.xlsx')) {
    alert('Нужен файл .xlsx');
    return;
  }

  const arrayBuffer = await file.arrayBuffer();
  const matrix = readXlsxFirstSheetToMatrix(arrayBuffer);
  if (!matrix.length) throw new Error('Пустая таблица.');

  const headerRow = matrix[0] || [];
  const headerIdx = buildHeaderIndexMap(headerRow);

  const required = [
    'Артикул 1С',
    'Код 1С (Характеристика)'
  ];
  const missing = required.filter(h => !headerIdx.has(normalizeHeaderKey(h)) && !headerIdx.has(normalizeHeaderKey(h.replace(' (Характеристика)', ''))));
  if (missing.length) {
    throw new Error(`Не найдены обязательные столбцы: ${missing.join(', ')}`);
  }

  const col = getProductsCollectionRef();
  if (!col) throw new Error('Firebase/Firestore не подключен: коллекция products недоступна.');

  const existing = await fetchAllProductsFromFirebase();
  const existingMap = new Map();
  existing.forEach(p => {
    const key = productLinkKey(p.article1c, p.code1c);
    if (key && !existingMap.has(key)) existingMap.set(key, p);
  });

  let updated = 0;
  let added = 0;

  const now = new Date().toISOString();
  let batch = db.batch();
  let ops = 0;
  const pendingImportStockAudits = [];
  const commitAndResetBatch = async () => {
    if (!ops) return;
    try {
      await batch.commit();
    } catch (e) {
      console.error('Импорт Excel: ошибка записи batch в Firestore: ', e);
      throw e;
    }
    pendingImportStockAudits.splice(0).forEach((x) => {
      recordProductStockAudit(x.rid, x.prev, x.next, 'import_xlsx', { row: x.row, key: x.key });
    });
    batch = db.batch();
    ops = 0;
  };

  const rows = matrix.slice(1);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const article1c = String(pickCell(row, headerIdx, 'Артикул 1С', 'артикул 1с', 'article1c')).trim();
    const code1c = String(pickCell(row, headerIdx, 'Код 1С (Характеристика)', 'Код 1С', 'code1c')).trim();
    if (!article1c && !code1c) continue;
    if (!article1c || !code1c) continue;

    const key = productLinkKey(article1c, code1c);
    const name = String(pickCell(row, headerIdx, 'Название товара', 'name')).trim() || article1c;
    const uzumSku = stripLeadingApostrophe(pickCell(row, headerIdx, 'SKU Uzum (uzumSku)', 'SKU Uzum', 'uzumSku', 'uzum_sku'));
    const uzumBarcodeRaw = stripLeadingApostrophe(pickCell(
      row,
      headerIdx,
      'Штрихкод Uzum (uzum_barcode)',
      'Штрихкод Uzum',
      'uzum_barcode'
    ));
    const uzumBarcode = normalizeUzumBarcode(uzumBarcodeRaw);
    const wbSku = stripLeadingApostrophe(pickCell(row, headerIdx, 'SKU Wildberries (wbSku)', 'SKU Wildberries', 'wbSku', 'wb_nmid', 'nmId WB'));
    const yandexSku = stripLeadingApostrophe(pickCell(row, headerIdx, 'SKU Яндекс (yandexSku)', 'SKU Яндекс', 'yandexSku', 'yandex_sku'));
    const costUzs = numOrZero(pickCell(
      row,
      headerIdx,
      'Себестоимость, сум',
      'Себестоимость сум',
      'Себестоимость (сум)',
      'Себестоимость',
      'costPriceUzs',
      'costGross'
    ));
    const stockQty = intOrZero(pickCell(row, headerIdx, 'Остаток шт', 'Остаток, шт', 'stockQty'));
    const categoryRaw = pickCell(row, headerIdx, 'Категория', 'category');
    const categoryTrim = String(categoryRaw ?? '').trim();
    console.log('Импорт категории:', { article1c, code1c, category: categoryTrim });

    const lengthMm = Math.max(0, Math.round(numOrZero(pickCell(row, headerIdx, 'Длина мм', 'Длина, мм', 'length'))));
    const widthMm = Math.max(0, Math.round(numOrZero(pickCell(row, headerIdx, 'Ширина мм', 'Ширина, мм', 'width'))));
    const heightMm = Math.max(0, Math.round(numOrZero(pickCell(row, headerIdx, 'Высота мм', 'Высота, мм', 'height'))));

    const existingProduct = existingMap.get(key);

    if (existingProduct) {
      const rid = existingProduct.recordId != null && String(existingProduct.recordId) !== '' ? String(existingProduct.recordId) : String(existingProduct.id || '');
      if (!rid) continue;
      const ref = col.doc(String(rid));
      const patch = {
        name,
        article1c,
        code1c,
        uzumSku: String(uzumSku ?? '').trim(),
        wbSku: String(wbSku ?? '').trim(),
        yandexSku: String(yandexSku ?? '').trim(),
        uzum_sku: String(uzumSku ?? '').trim(),
        wb_nmid: String(wbSku ?? '').trim(),
        yandex_sku: String(yandexSku ?? '').trim(),
        stockQty,
        updatedAt: now
      };
      if (uzumBarcode) patch.uzum_barcode = uzumBarcode;
      if (Number.isFinite(costUzs) && costUzs > 0) {
        const v = Math.round(costUzs * 100) / 100;
        patch.costPriceUzs = v;
        patch.costGross = v;
      }
      // Категория: обновляем только если колонка заполнена (пустая ячейка не затирает существующую категорию)
      if (String(categoryRaw ?? '').trim() !== '') patch.category = categoryTrim;
      if (lengthMm || widthMm || heightMm) {
        patch.length = lengthMm;
        patch.width = widthMm;
        patch.height = heightMm;
        patch.volumeLiters = Number((((lengthMm / 10) * (widthMm / 10) * (heightMm / 10)) / 1000).toFixed(4));
      }
      const prevStockImp = Math.max(0, Math.floor(Number(existingProduct.stockQty || 0)));
      if (stockQty !== prevStockImp) {
        pendingImportStockAudits.push({ rid, prev: prevStockImp, next: stockQty, row: r, key });
      }
      batch.set(ref, patch, { merge: true });
      updated += 1;
    } else {
      const rid = Date.now() + r;
      const ref = col.doc(String(rid));
      const doc = {
        recordId: rid,
        id: String(rid),
        sku: article1c || String(uzumSku || wbSku || yandexSku || '').trim(),
        name,
        article1c,
        code1c,
        uzumSku: String(uzumSku ?? '').trim(),
        wbSku: String(wbSku ?? '').trim(),
        yandexSku: String(yandexSku ?? '').trim(),
        uzum_barcode: uzumBarcode,
        uzum_sku: String(uzumSku ?? '').trim(),
        wb_nmid: String(wbSku ?? '').trim(),
        yandex_sku: String(yandexSku ?? '').trim(),
        stockQty,
        updatedAt: now,
        changeHistory: []
      };
      if (Number.isFinite(costUzs) && costUzs > 0) {
        const v = Math.round(costUzs * 100) / 100;
        doc.costPriceUzs = v;
        doc.costGross = v;
      }
      if (String(categoryRaw ?? '').trim() !== '') doc.category = categoryTrim;
      if (lengthMm || widthMm || heightMm) {
        doc.length = lengthMm;
        doc.width = widthMm;
        doc.height = heightMm;
        doc.volumeLiters = Number((((lengthMm / 10) * (widthMm / 10) * (heightMm / 10)) / 1000).toFixed(4));
      }
      if (stockQty > 0) {
        pendingImportStockAudits.push({ rid: String(rid), prev: 0, next: stockQty, row: r, key });
      }
      batch.set(ref, doc, { merge: true });
      added += 1;
    }

    ops += 1;
    if (ops >= 450) {
      await commitAndResetBatch();
    }
  }

  if (ops) await commitAndResetBatch();

  recordActivityLogOnly('import_xlsx_complete', '', String(updated), String(added), { updated, added });
  alert(`Импорт завершен. Обновлено: ${updated} товаров, Добавлено: ${added} новых`);
}

// ——— Справочник комплектующих + WMS поставки ———

function readComponentsSafe() {
  const arr = readStore(STORAGE_KEYS.components, []);
  return Array.isArray(arr) ? arr : [];
}

function readShipmentsSafe() {
  const arr = readStore(STORAGE_KEYS.shipments, []);
  return Array.isArray(arr) ? arr : [];
}

const WMS_MARKETPLACE_OPTIONS = ['Uzum Market', 'Wildberries', 'Yandex Market'];

function getWmsMarketplaceFromUi() {
  const el = document.getElementById('wmsMarketplace');
  const v = (el?.value || 'Uzum Market').trim();
  return WMS_MARKETPLACE_OPTIONS.includes(v) ? v : 'Uzum Market';
}

function setWmsMarketplaceUi(value) {
  const el = document.getElementById('wmsMarketplace');
  if (!el) return;
  const v = WMS_MARKETPLACE_OPTIONS.includes(String(value || '').trim())
    ? String(value).trim()
    : 'Uzum Market';
  el.value = v;
}

function isWmsUzumMarketplaceSelected() {
  return normalizeWmsMarketplaceKey(getWmsMarketplaceFromUi()) === 'uzum';
}

function normalizeSkuKey(sku) {
  // Нормализация артикула/SKU для Uzum: убираем любые пробелы (частая проблема в базе/кабинете).
  return String(sku || '').trim().replace(/\s+/g, '');
}

/** Для старых поставок без поля marketplace. */
function normalizeShipmentMarketplace(sh) {
  const v = sh?.marketplace;
  if (v && WMS_MARKETPLACE_OPTIONS.includes(String(v).trim())) return String(v).trim();
  return 'Uzum Market';
}

/** Подпись для колонки «Кимга» в накладной (заглавными). */
function marketplaceToNakladnayaRecipient(mp) {
  const map = {
    'Uzum Market': 'UZUM MARKET',
    Wildberries: 'WILDBERRIES',
    'Yandex Market': 'YANDEX MARKET'
  };
  const key = normalizeShipmentMarketplace({ marketplace: mp });
  return map[key] || String(mp || '').toUpperCase();
}

function formatShipmentDateDdMmYyyy(iso) {
  if (!iso) return '';
  const s = String(iso).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Старые записи без поля status считаем отправленными (как раньше — с списанием остатков). */
function shipmentRecordStatus(sh) {
  if (!sh || typeof sh !== 'object') return 'sent';
  return sh.status === 'draft' ? 'draft' : 'sent';
}

function showWmsDraftSavedToast() {
  const el = document.getElementById('wmsDraftToast');
  if (!el) return;
  el.classList.add('wms-toast--visible');
  el.setAttribute('aria-hidden', 'false');
}

function showWmsToast(msg) {
  const el = document.getElementById('wmsDraftToast');
  if (!el) return;
  el.textContent = String(msg || '').trim() || 'Сохранено';
  el.classList.add('wms-toast--visible');
  el.setAttribute('aria-hidden', 'false');
  if (wmsState._draftToastTimer) clearTimeout(wmsState._draftToastTimer);
  wmsState._draftToastTimer = setTimeout(() => {
    el.classList.remove('wms-toast--visible');
    el.setAttribute('aria-hidden', 'true');
  }, 1600);
}

function collectWmsFlatLinesFromDraft() {
  const flat = [];
  (wmsState.draft.boxes || []).forEach(box => {
    (box.items || []).forEach(it => flat.push(it));
  });
  return flat;
}

function renderComponentsList() {
  const list = document.getElementById('componentsList');
  const empty = document.getElementById('componentsEmpty');
  if (!list) return;
  const items = readComponentsSafe();
  list.innerHTML = '';
  empty?.classList.toggle('hidden', items.length > 0);
  const catLabel = { box: 'Коробка', package: 'Пакет', polygraphy: 'Полиграфия', other: 'Прочее' };
  items.forEach(c => {
    const row = document.createElement('div');
    row.className = 'component-row';
    row.innerHTML = `
      <div class="meta">
        <span class="tag">${escapeHtml(catLabel[c.category] || c.category || '—')}</span>
        <h4>${escapeHtml(c.name || '—')}</h4>
        <div class="hint">${escapeHtml(c.note || '')}</div>
      </div>
      <div><strong>${escapeHtml(fmtMoney(Number(c.deliveryCostTashkent || 0)))}</strong> до Ташкента</div>
      <button type="button" class="btn-danger" data-del-component="${escapeAttr(String(c.id))}">Удалить</button>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-del-component]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-del-component');
      const next = readComponentsSafe().filter(x => String(x.id) !== String(id));
      writeStore(STORAGE_KEYS.components, next);
      deleteComponentFromFirestore(id);
      renderComponentsList();
      renderWmsBoxes();
    });
  });
}

function updateComponentsAutocomplete() {
  const dl = document.getElementById('componentsNameDatalist');
  if (!dl) return;
  const items = readComponentsSafe();
  const unique = Array.from(new Set(items.map(x => String(x?.name || '').trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'ru'));
  dl.innerHTML = unique.map(name => `<option value="${escapeAttr(name)}"></option>`).join('');
}

function maybeAutofillComponentFieldsByName() {
  const nameEl = document.getElementById('componentName');
  if (!nameEl) return;
  const name = String(nameEl.value || '').trim().toLowerCase();
  if (!name) return;
  const items = readComponentsSafe();
  const found = items.find(x => String(x?.name || '').trim().toLowerCase() === name);
  if (!found) return;
  const dc = document.getElementById('componentDeliveryCost');
  if (dc) dc.value = String(Math.max(0, Math.round(Number(found.deliveryCostTashkent || 0))));
  const note = document.getElementById('componentNote');
  if (note && !String(note.value || '').trim()) note.value = String(found.note || '');
}

function getBoxComponentsForSelect() {
  return readComponentsSafe().filter(c => c.category === 'box');
}

function getComponentById(id) {
  if (id == null || id === '') return null;
  return readComponentsSafe().find(c => String(c.id) === String(id)) || null;
}

function ensureWmsLineCalc(line) {
  if (!line.financialSnapshot) line.financialSnapshot = {};
  if (!line.financialSnapshot.calc || typeof line.financialSnapshot.calc !== 'object') {
    line.financialSnapshot.calc = {};
  }
  return line.financialSnapshot.calc;
}

function syncWmsLineFinancials(line) {
  const calc = deepCloneJson(ensureWmsLineCalc(line));
  const vr = n(document.getElementById('vatRate')?.value) || 12;
  const vals = getProductCostFromCalc(calc, vr);
  const nextTotal = Math.max(0, Number(vals.total) || 0);
  const prevTotal = Math.max(
    0,
    Number(line?.unitCost ?? line?.financialSnapshot?.costPriceUzs ?? line?.financialSnapshot?.costGross ?? 0) || 0
  );
  const costTotal = nextTotal > 0 ? nextTotal : prevTotal;
  line.unitCost = costTotal;
  if (!line.financialSnapshot) line.financialSnapshot = {};
  line.financialSnapshot.costGross = costTotal;
  line.financialSnapshot.costPriceUzs = costTotal;
  if (nextTotal > 0) {
    line.financialSnapshot.costNet = vals.totalNet;
    line.financialSnapshot.inputVat = vals.totalInputVat;
  }
  line.financialSnapshot.calc = calc;
  const pl = n(calc.productLength);
  const pw = n(calc.productWidth);
  const ph = n(calc.productHeight);
  line.financialSnapshot.length = pl;
  line.financialSnapshot.width = pw;
  line.financialSnapshot.height = ph;
  line.financialSnapshot.volumeLiters = Number((((pl * pw * ph) / 1000000) || 0).toFixed(2));
}

function finalizeWmsDraftLinesBeforeSave() {
  (wmsState.draft.boxes || []).forEach(box => {
    (box.items || []).forEach(it => syncWmsLineFinancials(it));
  });
}

function computeUnitEconomicsForWmsLine(line) {
  syncWmsLineFinancials(line);
  const snap = line.financialSnapshot || {};
  const product = {
    costGross: Number(line.unitCost ?? snap.costGross ?? 0),
    costNet: Number(snap.costNet ?? 0),
    inputVat: Number(snap.inputVat ?? 0),
    length: Number(snap.length ?? 0),
    width: Number(snap.width ?? 0),
    height: Number(snap.height ?? 0)
  };
  return computeUnitEconomicsForProduct(product);
}

function computeUnitEconomicsForShipmentLineReadonly(line) {
  const snap = line.financialSnapshot || {};
  const calc = snap.calc || {};
  const vr = n(document.getElementById('vatRate')?.value) || 12;
  const cv = getProductCostFromCalc(calc, vr);
  const product = {
    costGross: Number(line.unitCost ?? snap.costGross ?? cv.total),
    costNet: Number(snap.costNet ?? cv.totalNet),
    inputVat: Number(snap.inputVat ?? cv.totalInputVat),
    length: Number(snap.length ?? n(calc.productLength)),
    width: Number(snap.width ?? n(calc.productWidth)),
    height: Number(snap.height ?? n(calc.productHeight))
  };
  return computeUnitEconomicsForProduct(product);
}

function getShipmentLineBreakdown(line, fromDraft) {
  if (fromDraft) syncWmsLineFinancials(line);
  const snap = line.financialSnapshot || {};
  const calc = snap.calc || {};
  const vr = n(document.getElementById('vatRate')?.value) || 12;
  const pc = getProductCostFromCalc(calc, vr);
  const u = fromDraft ? computeUnitEconomicsForWmsLine(line) : computeUnitEconomicsForShipmentLineReadonly(line);
  let zakupka = pc.purchaseZakupka;
  let logistikaSklad = pc.inboundLogisticsCost;
  let transportBox = pc.transportBoxCost;
  let upakovka = Math.max(0, Number(pc.packagingSum || 0) - Number(transportBox || 0));
  if (pc.total < 0.01 && u.cost > 0) {
    zakupka = u.cost;
    logistikaSklad = 0;
    transportBox = 0;
    upakovka = 0;
  }
  const fulfillment = Number(u.logistics || 0) + Number(u.storagePerDay || 0);
  return {
    zakupka,
    logistikaSklad,
    transportBox,
    upakovka,
    commission: u.commissionAmount,
    nalog: u.vatPayable,
    fulfillment,
    totalSebestoimost: u.totalCosts,
    marginPct: u.margin,
    internalCogs: u.cost
  };
}

const COST_CALC_BACKUP_IDS = [
  'sku', 'productArticle1c', 'productCode1c', 'productStockQty', 'productLink',
  'mpSkuUzum', 'mpUzumBarcode', 'mpWbNmid', 'mpSkuYandex', 'costRubUzRate',
  'fabricPrice', 'fabricConsumption', 'fabricUnit', 'fabricVatIncluded', 'fabricVatRate',
  'sewingCost', 'packageCost', 'zipperCost', 'elasticCost', 'polygraphyCost', 'stickersCost',
  'promoPolygraphyCost', 'inboundLogisticsCost', 'transportBoxCost', 'otherProductCost',
  'sewingCostVatIncluded', 'packageCostVatIncluded', 'zipperCostVatIncluded', 'elasticCostVatIncluded',
  'polygraphyCostVatIncluded', 'stickersCostVatIncluded', 'promoPolygraphyCostVatIncluded',
  'inboundLogisticsCostVatIncluded', 'transportBoxCostVatIncluded', 'otherProductCostVatIncluded',
  'uzumLengthCm', 'uzumWidthCm', 'uzumHeightCm',
  'productOnWarehouse', 'productStorageDays', 'productTurnover', 'productStockStatus', 'productNewSkuDays'
];

function serializeCostCalculatorState() {
  const o = {};
  COST_CALC_BACKUP_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    o[id] = el.value;
  });
  return o;
}

function restoreCostCalculatorState(o) {
  if (!o) return;
  Object.keys(o).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = o[id];
  });
  syncCostFormHiddenSku();
  renderProductCost();
}

function findWmsDraftLine(boxId, lineId) {
  const box = (wmsState.draft.boxes || []).find(b => String(b.id) === String(boxId));
  if (!box) return null;
  const line = (box.items || []).find(l => l.lineId === lineId);
  return line ? { box, line } : null;
}

function loadProductIntoCalculatorFromWmsLine(line) {
  state.productsEdit.recordId = null;
  const fs = line.financialSnapshot || {};
  const c = deepCloneJson(ensureWmsLineCalc(line));
  const a1 = document.getElementById('productArticle1c');
  const c1 = document.getElementById('productCode1c');
  if (a1) a1.value = fs.article1c != null ? String(fs.article1c) : (c.productArticle1c != null ? String(c.productArticle1c) : '');
  if (c1) c1.value = fs.code1c != null ? String(fs.code1c) : (c.productCode1c != null ? String(c.productCode1c) : '');
  if (a1 && !String(a1.value || '').trim() && line.sku) a1.value = String(line.sku);
  const ids = [
    'productLink', 'productArticle1c', 'productCode1c', 'productStockQty',
    'fabricPrice', 'fabricConsumption', 'fabricUnit', 'fabricVatIncluded', 'fabricVatRate',
    'sewingCost', 'packageCost', 'zipperCost', 'elasticCost', 'polygraphyCost', 'stickersCost',
    'promoPolygraphyCost', 'inboundLogisticsCost', 'transportBoxCost', 'otherProductCost',
    'sewingCostVatIncluded', 'packageCostVatIncluded', 'zipperCostVatIncluded', 'elasticCostVatIncluded',
    'polygraphyCostVatIncluded', 'stickersCostVatIncluded', 'promoPolygraphyCostVatIncluded',
    'inboundLogisticsCostVatIncluded', 'transportBoxCostVatIncluded', 'otherProductCostVatIncluded'
  ];
  ids.forEach(id => {
    if (c[id] !== undefined && document.getElementById(id)) {
      document.getElementById(id).value = c[id];
    }
  });
  syncCostFormHiddenSku();
  renderProductCost();
}

function openWmsLineDeepEditor(boxId, lineId) {
  const found = findWmsDraftLine(boxId, lineId);
  if (!found) return;
  closeWmsUnitEconModal();
  state.costEditSession.returnToDetailModal = false;
  wmsState._costFormBackup = serializeCostCalculatorState();
  wmsState.shipmentCalcEdit = { active: true, boxId, lineId };
  loadProductIntoCalculatorFromWmsLine(found.line);
  openPage('cost-tab');
  updateCostSaveToolbar();
}

function saveShipmentCalcFromForm() {
  if (!wmsState.shipmentCalcEdit?.active) return;
  const { boxId, lineId } = wmsState.shipmentCalcEdit;
  const found = findWmsDraftLine(boxId, lineId);
  if (!found) {
    cancelShipmentCalcEdit();
    return;
  }
  const snap = snapshotCurrentProduct();
  if (!snap) return;
  const line = found.line;
  const fs = line.financialSnapshot || {};
  line.financialSnapshot = {
    ...fs,
    capturedAt: new Date().toISOString(),
    productRecordId: line.productRecordId,
    sku: snap.sku,
    name: snap.name,
    article1c: snap.article1c,
    code1c: snap.code1c,
    costGross: snap.costGross,
    costNet: snap.costNet,
    inputVat: snap.inputVat,
    length: snap.length,
    width: snap.width,
    height: snap.height,
    volumeLiters: snap.volumeLiters,
    calc: deepCloneJson(snap.calc)
  };
  line.sku = snap.sku;
  line.name = snap.name;
  syncWmsLineFinancials(line);
  const backup = wmsState._costFormBackup;
  wmsState.shipmentCalcEdit = { active: false, boxId: null, lineId: null };
  wmsState._costFormBackup = null;
  restoreCostCalculatorState(backup);
  openPage('shipments-tab');
  updateCostSaveToolbar();
  renderWmsBoxes();
  renderWmsLiveTotals();
  renderWmsDraftSummary();
}

function cancelShipmentCalcEdit() {
  if (!wmsState.shipmentCalcEdit?.active) return;
  const backup = wmsState._costFormBackup;
  wmsState.shipmentCalcEdit = { active: false, boxId: null, lineId: null };
  wmsState._costFormBackup = null;
  restoreCostCalculatorState(backup);
  openPage('shipments-tab');
  updateCostSaveToolbar();
  renderWmsBoxes();
}

function findSavedShipmentLine(shipmentId, boxIdx, lineIdx) {
  const sh = readShipmentsSafe().find(s => String(s.id) === String(shipmentId));
  if (!sh || sh.version !== 2 || !Array.isArray(sh.boxes)) return null;
  const box = sh.boxes[boxIdx];
  const line = box?.items?.[lineIdx];
  return line ? { shipment: sh, box, line } : null;
}

function closeWmsUnitEconModal() {
  setModalOpen('wmsUnitEconModal', false);
  document.getElementById('wmsUnitEconModal')?.setAttribute('aria-hidden', 'true');
  wmsState._unitEconModal = { ctx: null };
}

function fillWmsUnitEconModal(line, fromDraft) {
  const b = getShipmentLineBreakdown(line, fromDraft);
  const skuEl = document.getElementById('wmsUnitEconSku');
  const rowsEl = document.getElementById('wmsUnitEconRows');
  if (skuEl) skuEl.textContent = `${line.financialSnapshot?.article1c || line.name || '—'} · ${line.sku || '—'}`;
  if (rowsEl) {
    rowsEl.innerHTML = `
      <div class="wms-unit-econ-row"><span class="k">Закупка</span><span class="v">${escapeHtml(fmtMoney(b.zakupka))}</span></div>
      <div class="wms-unit-econ-row"><span class="k">Логистика до склада</span><span class="v">${escapeHtml(fmtMoney(b.logistikaSklad))}</span></div>
      <div class="wms-unit-econ-row"><span class="k">Коробка транспортная</span><span class="v">${escapeHtml(fmtMoney(b.transportBox))}</span></div>
      <div class="wms-unit-econ-row"><span class="k">Комиссия</span><span class="v">${escapeHtml(fmtMoney(b.commission))}</span></div>
      <div class="wms-unit-econ-row"><span class="k">Налог (НДС к уплате)</span><span class="v">${escapeHtml(fmtMoney(b.nalog))}</span></div>
      <div class="wms-unit-econ-row"><span class="k">Фулфилмент</span><span class="v">${escapeHtml(fmtMoney(b.fulfillment))}</span></div>
      <div class="wms-unit-econ-row"><span class="k">Итоговая себестоимость</span><span class="v">${escapeHtml(fmtMoney(b.totalSebestoimost))}</span></div>
      <div class="wms-unit-econ-row"><span class="k">Маржа</span><span class="v">${escapeHtml(fmtPct(b.marginPct))}</span></div>
    `;
  }
}

function openWmsUnitEconModal(line, ctx) {
  if (!line) return;
  wmsState._unitEconModal = { ctx };
  fillWmsUnitEconModal(line, ctx.kind === 'draft');
  setModalOpen('wmsUnitEconModal', true);
  document.getElementById('wmsUnitEconModal')?.setAttribute('aria-hidden', 'false');
}

function toggleWmsUnitEconModalDraft(boxId, lineId) {
  const cur = wmsState._unitEconModal?.ctx;
  if (cur?.kind === 'draft' && String(cur.boxId) === String(boxId) && cur.lineId === lineId) {
    closeWmsUnitEconModal();
    return;
  }
  const found = findWmsDraftLine(boxId, lineId);
  if (!found) return;
  openWmsUnitEconModal(found.line, { kind: 'draft', boxId, lineId });
}

function openWmsUnitEconModalSaved(shipmentId, boxIdx, lineIdx) {
  const row = findSavedShipmentLine(shipmentId, boxIdx, lineIdx);
  if (!row) return;
  const cur = wmsState._unitEconModal?.ctx;
  if (cur?.kind === 'saved'
    && String(cur.shipmentId) === String(shipmentId)
    && cur.boxIdx === boxIdx
    && cur.lineIdx === lineIdx) {
    closeWmsUnitEconModal();
    return;
  }
  openWmsUnitEconModal(row.line, { kind: 'saved', shipmentId, boxIdx, lineIdx });
}

function refreshWmsUnitEconModalIfDraftLine(boxId, lineId) {
  const ctx = wmsState._unitEconModal?.ctx;
  if (!ctx || ctx.kind !== 'draft') return;
  if (String(ctx.boxId) !== String(boxId) || ctx.lineId !== lineId) return;
  const found = findWmsDraftLine(boxId, lineId);
  const modal = document.getElementById('wmsUnitEconModal');
  if (found && modal?.classList.contains('open')) fillWmsUnitEconModal(found.line, true);
}

function resetWmsDraft() {
  wmsState.draft = { boxes: [{ id: newWmsBoxId(), componentId: '', items: [] }] };
}

function openWmsAssemble() {
  if (wmsState.shipmentCalcEdit?.active) cancelShipmentCalcEdit();
  closeWmsUnitEconModal();
  wmsState.editingDraftId = null;
  wmsState.editingOriginalSent = null;
  wmsState.sessionIsNewAssembly = true;
  wmsState.assemblingOpen = true;
  resetWmsDraft();
  const panel = document.getElementById('wmsAssemblePanel');
  const nameEl = document.getElementById('wmsShipmentName');
  const dateEl = document.getElementById('wmsShipmentDate');
  if (nameEl) nameEl.value = '';
  if (dateEl) dateEl.value = todayIso();
  const truck = document.getElementById('wmsTruckCost');
  const load = document.getElementById('wmsLoaderCost');
  if (truck) truck.value = '200000';
  if (load) load.value = '50000';
  setWmsMarketplaceUi('Uzum Market');
  panel?.classList.remove('hidden');
  renderWmsBoxes();
  renderWmsLiveTotals();
  renderWmsDraftSummary();
}

function dismissWmsAssembleUiOnly() {
  closeWmsUnitEconModal();
  if (wmsState.shipmentCalcEdit?.active) cancelShipmentCalcEdit();
  wmsState.editingDraftId = null;
  wmsState.editingOriginalSent = null;
  wmsState.sessionIsNewAssembly = false;
  wmsState.assemblingOpen = false;
  document.getElementById('wmsAssemblePanel')?.classList.add('hidden');
  renderWmsDraftSummary();
}

async function closeWmsAssemble() {
  closeWmsUnitEconModal();
  if (wmsState.shipmentCalcEdit?.active) cancelShipmentCalcEdit();
  if (wmsState.assemblingOpen && wmsState.sessionIsNewAssembly) {
    const flat = collectWmsFlatLinesFromDraft();
    if (flat.length) {
      try {
        await restoreWmsDraftLinesToWarehouse(flat);
      } catch (e) {
        console.error('closeWmsAssemble: не удалось вернуть остатки по несохранённой сборке: ', e);
      }
    }
  } else if (wmsState.assemblingOpen && wmsState.editingDraftId) {
    try {
      await refreshProductsFromFirestoreAndRender();
    } catch (e) {
      console.error('closeWmsAssemble: обновление остатков из Firestore: ', e);
    }
  }
  wmsState.editingDraftId = null;
  wmsState.editingOriginalSent = null;
  wmsState.sessionIsNewAssembly = false;
  wmsState.assemblingOpen = false;
  document.getElementById('wmsAssemblePanel')?.classList.add('hidden');
  renderWmsDraftSummary();
}

async function openWmsEditDraft(shipmentId) {
  let sh = readShipmentsSafe().find(s => String(s.id) === String(shipmentId));
  if (!sh || sh.version !== 2) return;
  const status = shipmentRecordStatus(sh);
  if (!['draft', 'sent'].includes(status)) return;
  if (wmsState.shipmentCalcEdit?.active) cancelShipmentCalcEdit();
  closeWmsUnitEconModal();

  if (status === 'draft' && !sh.liveStockAllocated) {
    const flatPre = [];
    (sh.boxes || []).forEach(b => (b.items || []).forEach(it => flatPre.push(it)));
    if (flatPre.length) {
      try {
        const deltas = buildShipmentStockDeltasByRecordId(sh, -1);
        await applyProductStockDeltasInFirestore(deltas, { action_type: 'draft_reserve_stock', shipment_id: String(shipmentId) });
        applyStockDeltasToLocalProducts(deltas);
        const arr = readShipmentsSafe();
        const si = arr.findIndex(s => String(s.id) === String(shipmentId));
        if (si >= 0) {
          arr[si] = { ...arr[si], liveStockAllocated: true };
          writeStore(STORAGE_KEYS.shipments, arr);
          await upsertShipmentToFirestore(arr[si]);
        }
        sh = readShipmentsSafe().find(s => String(s.id) === String(shipmentId)) || sh;
      } catch (e) {
        console.error('openWmsEditDraft: резерв остатков под черновик в Firebase: ', e);
        alert('Не удалось зарезервировать остатки в облаке. Проверьте Firestore и повторите.');
        return;
      }
    }
  }

  wmsState.assemblingOpen = true;
  wmsState.sessionIsNewAssembly = false;
  wmsState.editingDraftId = sh.id;
  wmsState.editingOriginalSent = status === 'sent' ? deepCloneJson(sh) : null;
  const boxes = Array.isArray(sh.boxes) ? sh.boxes : [];
  wmsState.draft = {
    boxes: boxes.length
      ? boxes.map(box => ({
        id: (box?.id != null && String(box.id) !== '') ? box.id : newWmsBoxId(),
        componentId: box.componentId || '',
        items: (box.items || []).map(it => deepCloneJson(it))
      }))
      : [{ id: newWmsBoxId(), componentId: '', items: [] }]
  };
  const nameEl = document.getElementById('wmsShipmentName');
  const dateEl = document.getElementById('wmsShipmentDate');
  const truck = document.getElementById('wmsTruckCost');
  const load = document.getElementById('wmsLoaderCost');
  if (nameEl) nameEl.value = sh.name || '';
  if (dateEl) dateEl.value = sh.date || sh.shipmentDate || todayIso();
  if (truck) truck.value = String(sh.truckCost != null ? sh.truckCost : 200000);
  if (load) load.value = String(sh.loaderCost != null ? sh.loaderCost : 50000);
  setWmsMarketplaceUi(sh.marketplace);
  document.getElementById('wmsAssemblePanel')?.classList.remove('hidden');
  renderWmsBoxes();
  renderWmsLiveTotals();
  renderWmsDraftSummary();
}

function renderWmsDraftSummary() {
  const mode = document.getElementById('wmsDraftModeVal');
  const bc = document.getElementById('wmsDraftBoxesCountVal');
  const qv = document.getElementById('wmsDraftQtyVal');
  if (mode) mode.textContent = wmsState.assemblingOpen ? 'Сборка поставки' : 'Просмотр';
  const boxes = wmsState.assemblingOpen ? (wmsState.draft.boxes || []) : [];
  let qty = 0;
  boxes.forEach(b => (b.items || []).forEach(it => { qty += Math.max(0, Math.floor(Number(it.qty || 0))); }));
  if (bc) bc.textContent = String(boxes.length);
  if (qv) qv.textContent = qty.toLocaleString('ru-RU');
}

function isEditingSentShipmentNow() {
  return !!wmsState.editingOriginalSent && shipmentRecordStatus(wmsState.editingOriginalSent) === 'sent';
}

async function handleWmsLineQtyCommit(inp) {
  const boxId = inp.getAttribute('data-wms-qty');
  const lineId = inp.getAttribute('data-line');
  const found = findWmsDraftLine(boxId, lineId);
  if (!found) return;
  const rid = found.line.productRecordId != null && String(found.line.productRecordId) !== '' ? String(found.line.productRecordId) : '';
  if (!rid) {
    alert('У строки нет привязки к товару в базе (productRecordId).');
    return;
  }
  const oldQty = Math.max(0, Math.floor(Number(inp.dataset.prevQty ?? found.line.qty ?? 0)));
  let newQty = Math.max(0, Math.floor(Number(inp.value ?? 0)));
  const products = readProductsSafe();
  const p = products.find(x => recordIdsEqual(x.recordId, rid));
  const stock = p ? Math.max(0, Math.floor(Number(p.stockQty || 0))) : 0;
  const maxAllowed = stock + oldQty;
  if (newQty > maxAllowed) {
    alert(`Недостаточно остатка на складе. Доступно ещё ${maxAllowed.toLocaleString('ru-RU')} шт (с учётом уже стоящих в коробке ${oldQty.toLocaleString('ru-RU')} шт).`);
    inp.value = String(oldQty);
    newQty = oldQty;
    return;
  }
  if (newQty === oldQty) return;
  try {
    if (!isEditingSentShipmentNow()) {
      const deltaWh = oldQty - newQty; // >0 вернуть на склад; <0 списать
      await applyWmsWarehouseStockDelta(rid, deltaWh, {
        action_type: 'wms_shipment_line_qty',
        line_old_qty: oldQty,
        line_new_qty: newQty
      });
    }
    if (newQty <= 0) {
      // qty=0 — удаляем строку (а пустую коробку подчистим сразу, чтобы не плодить "пустые №11")
      const box = found.box;
      if (box) box.items = (box.items || []).filter(l => l.lineId !== lineId);
      if (box && (!box.items || box.items.length === 0)) {
        wmsState.draft.boxes = (wmsState.draft.boxes || []).filter(b => String(b.id) !== String(box.id));
        if (!wmsState.draft.boxes.length) wmsState.draft.boxes.push({ id: newWmsBoxId(), componentId: '', items: [] });
      }
    } else {
      found.line.qty = newQty;
      inp.dataset.prevQty = String(newQty);
      const tr = inp.closest('tr');
      const uc = Number(found.line.unitCost ?? found.line.financialSnapshot?.costGross ?? 0);
      const sumCell = tr?.querySelector('[data-wms-cell-sum]');
      if (sumCell) sumCell.textContent = fmtMoney(newQty * uc);
    }
    const tr = inp.closest('tr');
    renderWmsLiveTotals();
    renderWmsDraftSummary();
    refreshWmsUnitEconModalIfDraftLine(boxId, lineId);
  } catch (e) {
    console.error('handleWmsLineQtyCommit: ', e);
    alert(e?.message || 'Не удалось обновить остаток в Firebase.');
    inp.value = String(oldQty);
  }
}

function renderWmsBoxes() {
  const container = document.getElementById('wmsBoxesContainer');
  if (!container) return;
  const boxComponents = getBoxComponentsForSelect();
  const boxes = wmsState.draft.boxes || [];
  const uzumOnly = isWmsUzumMarketplaceSelected();
  container.innerHTML = '';
  boxes.forEach((box, idx) => {
    const comp = getComponentById(box.componentId);
    const costHint = comp ? fmtMoney(Number(comp.deliveryCostTashkent || 0)) : '—';
    const card = document.createElement('div');
    card.className = 'wms-box-card';
    card.dataset.boxId = box.id;
    let opts = '<option value="">— Выберите размер коробки —</option>';
    boxComponents.forEach(c => {
      const sel = String(c.id) === String(box.componentId) ? ' selected' : '';
      opts += `<option value="${escapeAttr(String(c.id))}"${sel}>${escapeHtml(c.name)} (${escapeHtml(fmtMoney(Number(c.deliveryCostTashkent || 0)))})</option>`;
    });
    let rows = '';
    (box.items || []).forEach(line => {
      syncWmsLineFinancials(line);
      const calc = ensureWmsLineCalc(line);
      const inboundVal = n(calc.inboundLogisticsCost);
      const transportBoxVal = n(calc.transportBoxCost);
      const q = Math.max(0, Math.floor(Number(line.qty || 0)));
      const uc = Number(line.unitCost ?? line.financialSnapshot?.costGross ?? 0);
      // Snapshot: fixedUzumPayout (не перезаписывается и не триггерит API при открытии)
      const fixed = uzumOnly && Number.isFinite(Number(line.fixedUzumPayout)) ? Number(line.fixedUzumPayout) : null;
      const payoutCell = uzumOnly
        ? `<td data-wms-cell-payout title="Сумма к выводу за 1 шт (ручной ввод)">
            <input
              type="number"
              class="manual-uzum-payout"
              placeholder="Впишите сумму..."
              value="${fixed != null ? escapeAttr(String(fixed)) : ''}"
              data-wms-payout="${escapeAttr(box.id)}"
              data-line="${escapeAttr(line.lineId)}"
            />
          </td>`
        : '';
      rows += `<tr data-line-id="${escapeAttr(line.lineId)}">
        <td>${escapeHtml(line.financialSnapshot?.name || line.name || '—')}</td>
        <td class="sku-cell">${escapeHtml(line.sku || '—')}</td>
        <td><input class="input wms-qty-input" type="number" min="1" step="1" value="${q}" data-wms-qty="${escapeAttr(box.id)}" data-line="${escapeAttr(line.lineId)}" data-prev-qty="${q}" title="Количество в коробке (остаток на складе пересчитывается сразу)" /></td>
        <td><input class="input wms-inbound-input" type="number" min="0" step="0.01" value="${Number.isFinite(inboundVal) ? inboundVal : 0}" data-wms-inbound="${escapeAttr(box.id)}" data-line="${escapeAttr(line.lineId)}" title="Логистика до склада (в себестоимость)" /></td>
        <td><input class="input wms-inbound-input" type="number" min="0" step="0.01" value="${Number.isFinite(transportBoxVal) ? transportBoxVal : 0}" data-wms-transport-box="${escapeAttr(box.id)}" data-line="${escapeAttr(line.lineId)}" title="Коробка транспортная (в себестоимость)" /></td>
        <td data-wms-cell-unit>${escapeHtml(fmtMoney(uc))}</td>
        <td data-wms-cell-sum>${escapeHtml(fmtMoney(q * uc))}</td>
        ${payoutCell}
        <td class="wms-line-actions">
          <button type="button" class="wms-calc-icon-btn" title="Калькуляция по поставке" data-wms-preview-box="${escapeAttr(box.id)}" data-line="${escapeAttr(line.lineId)}">🧮</button>
          <button type="button" class="wms-icon-btn" title="Глубокое редактирование" data-wms-deep="${escapeAttr(box.id)}" data-line="${escapeAttr(line.lineId)}">⚙️</button>
          <button type="button" class="btn-danger" data-wms-remove-line="${escapeAttr(box.id)}" data-line="${escapeAttr(line.lineId)}">×</button>
        </td>
      </tr>`;

      // ВАЖНО: никаких запросов к API.
    });
    if (!rows) {
      rows = `<tr><td colspan="${uzumOnly ? 9 : 8}" class="muted" style="padding:12px;">Нет товаров. Нажми «Добавить товар».</td></tr>`;
    }
    const payoutHead = uzumOnly ? '<th>К ВЫВОДУ (СУМ)</th>' : '';
    card.innerHTML = `
      <div class="wms-box-card-head">
        <div>
          <h3>Коробка ${idx + 1}</h3>
          <div class="wms-box-meta">Логистика коробки: <strong>${escapeHtml(costHint)}</strong></div>
        </div>
        <div class="toolbar" style="margin:0;">
          ${boxes.length > 1 ? `<button type="button" class="btn-secondary" data-wms-remove-box="${escapeAttr(box.id)}">Удалить коробку</button>` : ''}
          <button type="button" class="btn-primary" data-wms-open-pick="${escapeAttr(box.id)}">Добавить товар</button>
        </div>
      </div>
      <div class="field">
        <label>Размер коробки</label>
        <select class="select" data-wms-box-component="${escapeAttr(box.id)}">${opts}</select>
      </div>
      <div class="table-wrap wms-box-items">
        <table><thead><tr><th>Товар</th><th>SKU</th><th>Шт</th><th>Логистика до склада</th><th>Коробка трансп.</th><th>Себест. 1 шт</th><th>Сумма</th>${payoutHead}<th></th></tr></thead><tbody>${rows}</tbody></table>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('[data-wms-box-component]').forEach(sel => {
    sel.addEventListener('change', () => {
      const boxId = sel.getAttribute('data-wms-box-component');
      const b = wmsState.draft.boxes.find(x => String(x.id) === String(boxId));
      if (b) b.componentId = sel.value;
      renderWmsBoxes();
      renderWmsLiveTotals();
    });
  });
  container.querySelectorAll('[data-wms-remove-box]').forEach(btn => {
    btn.addEventListener('click', () => void (async () => {
      const id = btn.getAttribute('data-wms-remove-box');
      const box = wmsState.draft.boxes.find(x => String(x.id) === String(id));
      if (!isEditingSentShipmentNow() && box && Array.isArray(box.items)) {
        for (let i = 0; i < box.items.length; i++) {
          const line = box.items[i];
          const rid = line?.productRecordId != null && String(line.productRecordId) !== '' ? String(line.productRecordId) : '';
          const q = Math.max(0, Math.floor(Number(line?.qty || 0)));
          if (!rid || !q) continue;
          try {
            await applyWmsWarehouseStockDelta(rid, q, { action_type: 'wms_shipment_remove_box' });
          } catch (e) {
            console.error('Удаление коробки: не удалось вернуть остаток по строке: ', e);
            alert(e?.message || 'Не удалось вернуть остаток в Firebase.');
            return;
          }
        }
      }
      wmsState.draft.boxes = wmsState.draft.boxes.filter(x => String(x.id) !== String(id));
      if (!wmsState.draft.boxes.length) wmsState.draft.boxes.push({ id: newWmsBoxId(), componentId: '', items: [] });
      renderWmsBoxes();
      renderWmsLiveTotals();
      renderWmsDraftSummary();
    })());
  });
  container.querySelectorAll('[data-wms-remove-line]').forEach(btn => {
    btn.addEventListener('click', () => void (async () => {
      const boxId = btn.getAttribute('data-wms-remove-line');
      const lineId = btn.getAttribute('data-line');
      const uctx = wmsState._unitEconModal?.ctx;
      if (uctx?.kind === 'draft' && uctx.lineId === lineId) closeWmsUnitEconModal();
      const box = wmsState.draft.boxes.find(x => String(x.id) === String(boxId));
      const line = box ? (box.items || []).find(l => l.lineId === lineId) : null;
      const rid = line?.productRecordId != null && String(line.productRecordId) !== '' ? String(line.productRecordId) : '';
      const q = Math.max(0, Math.floor(Number(line?.qty || 0)));
      if (!isEditingSentShipmentNow() && line && rid && q) {
        try {
          await applyWmsWarehouseStockDelta(rid, q, { action_type: 'wms_shipment_remove_line' });
        } catch (e) {
          console.error('Удаление строки: возврат остатка в Firebase: ', e);
          alert(e?.message || 'Не удалось вернуть остаток на склад.');
          return;
        }
      }
      if (box) box.items = (box.items || []).filter(l => l.lineId !== lineId);
      if (box && (!box.items || box.items.length === 0)) {
        wmsState.draft.boxes = (wmsState.draft.boxes || []).filter(b => String(b.id) !== String(box.id));
        if (!wmsState.draft.boxes.length) wmsState.draft.boxes.push({ id: newWmsBoxId(), componentId: '', items: [] });
      }
      renderWmsBoxes();
      renderWmsLiveTotals();
      renderWmsDraftSummary();
    })());
  });
  container.querySelectorAll('[data-wms-open-pick]').forEach(btn => {
    btn.addEventListener('click', () => {
      wmsState.modalBoxId = btn.getAttribute('data-wms-open-pick');
      openWmsProductPickModal();
    });
  });
  function bindWmsLineCostInput(inp, calcField) {
    inp.addEventListener('input', () => {
      const boxId = inp.getAttribute(`data-wms-${calcField === 'inboundLogisticsCost' ? 'inbound' : 'transport-box'}`);
      const lineId = inp.getAttribute('data-line');
      const found = findWmsDraftLine(boxId, lineId);
      if (!found) return;
      ensureWmsLineCalc(found.line)[calcField] = n(inp.value);
      syncWmsLineFinancials(found.line);
      const tr = inp.closest('tr');
      const q = Math.max(0, Math.floor(Number(found.line.qty || 0)));
      const uc = Number(found.line.unitCost || 0);
      const unitCell = tr?.querySelector('[data-wms-cell-unit]');
      const sumCell = tr?.querySelector('[data-wms-cell-sum]');
      if (unitCell) unitCell.textContent = fmtMoney(uc);
      if (sumCell) sumCell.textContent = fmtMoney(q * uc);
      renderWmsLiveTotals();
      refreshWmsUnitEconModalIfDraftLine(boxId, lineId);
    });
  }
  container.querySelectorAll('[data-wms-inbound]').forEach(inp => bindWmsLineCostInput(inp, 'inboundLogisticsCost'));
  container.querySelectorAll('[data-wms-transport-box]').forEach(inp => bindWmsLineCostInput(inp, 'transportBoxCost'));
  container.querySelectorAll('[data-wms-qty]').forEach(inp => {
    inp.addEventListener('change', () => void handleWmsLineQtyCommit(inp));
  });
  container.querySelectorAll('[data-wms-preview-box]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleWmsUnitEconModalDraft(btn.getAttribute('data-wms-preview-box'), btn.getAttribute('data-line'));
    });
  });
  container.querySelectorAll('[data-wms-deep]').forEach(btn => {
    btn.addEventListener('click', () => {
      openWmsLineDeepEditor(btn.getAttribute('data-wms-deep'), btn.getAttribute('data-line'));
    });
  });

  async function persistWmsDraftAfterPayoutEdit() {
    const name = (document.getElementById('wmsShipmentName')?.value || '').trim();
    const date = document.getElementById('wmsShipmentDate')?.value || '';
    if (!name || !date) return;
    const shipmentId = wmsState.editingDraftId != null ? wmsState.editingDraftId : Date.now();
    const shipment = buildWmsShipmentRecordFromUi('draft', shipmentId);
    try {
      await saveWmsShipmentToFirestoreTransaction(shipment, new Map(), { action_type: 'wms_payout_manual_save', shipment_id: String(shipmentId) });
      upsertShipmentInStore(shipment);
      wmsState.editingDraftId = shipmentId;
      wmsState.sessionIsNewAssembly = false;
      renderWmsHistory();
      showWmsToast('Сумма сохранена');
    } catch (e) {
      console.error('persistWmsDraftAfterPayoutEdit: ', e);
      showWmsToast('Не удалось сохранить');
    }
  }

  container.querySelectorAll('[data-wms-payout]').forEach(inp => {
    const commit = () => {
      const boxId = inp.getAttribute('data-wms-payout');
      const lineId = inp.getAttribute('data-line');
      const found = findWmsDraftLine(boxId, lineId);
      if (!found) return;
      const v = Math.max(0, Math.floor(Number(inp.value || 0)));
      found.line.fixedUzumPayout = v;
      renderWmsLiveTotals();
      renderWmsDraftSummary();
      void persistWmsDraftAfterPayoutEdit();
    };
    inp.addEventListener('change', commit);
    inp.addEventListener('blur', commit);
  });
}

function computeWmsDraftTotals() {
  let boxLog = 0;
  let goods = 0;
  let qtyTotal = 0;
  (wmsState.draft.boxes || []).forEach(box => {
    const c = getComponentById(box.componentId);
    boxLog += Number(c?.deliveryCostTashkent || 0);
    (box.items || []).forEach(it => {
      const q = Math.max(0, Math.floor(Number(it.qty || 0)));
      const uc = Number(it.unitCost ?? it.financialSnapshot?.costGross ?? 0);
      qtyTotal += q;
      goods += q * uc;
    });
  });
  const truck = n(document.getElementById('wmsTruckCost')?.value);
  const loader = n(document.getElementById('wmsLoaderCost')?.value);
  const totalLog = boxLog + truck + loader;
  return { boxLog, truck, loader, totalLog, goods, qtyTotal, grand: goods + totalLog };
}

function renderWmsLiveTotals() {
  const el = document.getElementById('wmsLiveTotals');
  if (!el) return;
  const t = computeWmsDraftTotals();
  el.innerHTML = `
    <div>Товаров, шт: <strong>${t.qtyTotal.toLocaleString('ru-RU')}</strong></div>
    <div>Себестоимость товаров: <strong>${escapeHtml(fmtMoney(t.goods))}</strong></div>
    <div>Логистика (коробки + грузовик + грузчик): <strong>${escapeHtml(fmtMoney(t.totalLog))}</strong></div>
    <div>Всего: <strong>${escapeHtml(fmtMoney(t.grand))}</strong></div>
  `;
}

function openWmsProductPickModal() {
  wmsState.pickSelected = null;
  const search = document.getElementById('wmsProductPickSearch');
  const list = document.getElementById('wmsProductPickList');
  const panel = document.getElementById('wmsPickSelectedPanel');
  const hint = document.getElementById('wmsPickEmptyHint');
  if (search) search.value = '';
  if (list) list.innerHTML = '';
  panel?.classList.add('hidden');
  hint?.classList.remove('hidden');
  setModalOpen('wmsProductPickModal', true);
  renderWmsProductPickList('');
}

function closeWmsProductPickModal() {
  setModalOpen('wmsProductPickModal', false);
  wmsState.modalBoxId = null;
  wmsState.pickSelected = null;
}

function renderWmsProductPickList(q) {
  const list = document.getElementById('wmsProductPickList');
  if (!list) return;
  const qq = String(q || '').trim().toLowerCase();
  const products = readProductsSafe();
  const filtered = qq ? products.filter(p => productSearchMatchesQuery(p, qq)) : products;
  const mpKey = normalizeWmsMarketplaceKey(getWmsMarketplaceFromUi());
  list.innerHTML = '';
  filtered.slice(0, 80).forEach(p => {
    const row = document.createElement('div');
    row.className = 'wms-pick-row';
    row.dataset.recordId = String(p.recordId);
    const title = String(p.name || '').trim() || String(p.article1c || '').trim() || '—';
    const a1 = String(p.article1c || '').trim();
    const code1c = String(p.code1c || '').trim();
    const mpSku = getMarketplaceSkuForProduct(p, mpKey);
    const badgeClass =
      mpKey === 'wb' ? 'wms-sku-badge wms-sku-badge--wb'
      : mpKey === 'uzum' ? 'wms-sku-badge wms-sku-badge--uzum'
      : mpKey === 'yandex' ? 'wms-sku-badge wms-sku-badge--yandex'
      : 'wms-sku-badge';
    const badgeText =
      mpKey === 'wb' ? 'WB'
      : mpKey === 'yandex' ? 'Yandex'
      : 'Uzum';
    row.innerHTML = `
      <div class="sku wms-pick-article">${escapeHtml(a1 || title)}</div>
      <div class="nm">
        <span class="${badgeClass}">${escapeHtml(badgeText)}</span>
        <span><strong>Код 1С:</strong> ${escapeHtml(code1c || '—')} · <strong>${escapeHtml(mpSku.label)}:</strong> ${escapeHtml(mpSku.value || '—')}</span>
      </div>
      <div class="hint" style="margin-top:4px;">Остаток: <strong>${Math.max(0, Math.floor(Number(p.stockQty || 0))).toLocaleString('ru-RU')}</strong> шт</div>
    `;
    row.addEventListener('click', () => {
      list.querySelectorAll('.wms-pick-row').forEach(r => r.classList.remove('active'));
      row.classList.add('active');
      wmsState.pickSelected = p;
      document.getElementById('wmsPickSelectedPanel')?.classList.remove('hidden');
      document.getElementById('wmsPickEmptyHint')?.classList.add('hidden');
      const pickedTitle = String(p.name || '').trim() || String(p.article1c || '').trim() || '—';
      const pickedCode = String(p.code1c || '').trim();
      const pickedSku = String(getMarketplaceSkuForProduct(p, mpKey).value || '').trim();
      document.getElementById('wmsPickSelectedName').textContent =
        `${pickedTitle}${pickedCode || pickedSku ? ` (Код 1С: ${pickedCode || '—'} | SKU: ${pickedSku || '—'})` : ''}`;
      document.getElementById('wmsPickQty').value = '1';
    });
    list.appendChild(row);
  });
  if (!filtered.length) {
    list.innerHTML = '<div class="wms-pick-row muted">Ничего не найдено</div>';
  }
}

async function confirmWmsPickProduct() {
  const boxId = wmsState.modalBoxId;
  const product = wmsState.pickSelected;
  if (!boxId || !product) {
    alert('Сначала выбери товар в списке, затем укажи количество.');
    return;
  }
  const mpKey = normalizeWmsMarketplaceKey(getWmsMarketplaceFromUi());
  const mpSku = getMarketplaceSkuForProduct(product, mpKey);
  const qty = Math.max(1, Math.floor(n(document.getElementById('wmsPickQty')?.value)));
  const box = wmsState.draft.boxes.find(x => String(x.id) === String(boxId));
  if (!box) return;
  const rid = product.recordId != null && String(product.recordId) !== '' ? String(product.recordId) : '';
  if (!rid) {
    alert('У товара нет recordId — сохраните карточку в базе и повторите.');
    return;
  }
  const fresh = findProductByRecordId(readProductsSafe(), rid) || product;
  const stock = Math.max(0, Math.floor(Number(fresh.stockQty || 0)));
  if (qty > stock) {
    alert(`Недостаточно остатка на складе: есть ${stock} шт, запрошено ${qty} шт.`);
    return;
  }
  try {
    if (!isEditingSentShipmentNow()) {
      await applyWmsWarehouseStockDelta(rid, -qty, { action_type: 'wms_shipment_add_line', qty });
    }
  } catch (e) {
    console.error('confirmWmsPickProduct: списание остатка: ', e);
    alert(e?.message || 'Не удалось зарезервировать остаток в Firebase.');
    return;
  }
  if (!box.items) box.items = [];
  const financialSnapshot = buildProductFinancialSnapshot(product);
  const newLine = {
    lineId: `ln_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    productRecordId: product.recordId,
    sku: String(mpSku.value || '').trim() || String(product.sku || '').trim(),
    name: (String(product.name || '').trim() || String(product.article1c || '').trim() || String(product.sku || '').trim() || ''),
    qty,
    unitCost: productCostPriceUzs(product),
    financialSnapshot,
    // Жёсткий снапшот: заполняется ТОЛЬКО при первичном добавлении в коробку (Uzum only)
    fixedUzumPayout: null
  };
  box.items.push(newLine);
  syncWmsLineFinancials(newLine);
  closeWmsProductPickModal();
  renderWmsBoxes();
  renderWmsLiveTotals();
  renderWmsDraftSummary();
}

function buildWmsShipmentRecordFromUi(status, shipmentId) {
  const name = (document.getElementById('wmsShipmentName')?.value || '').trim();
  const date = document.getElementById('wmsShipmentDate')?.value || '';
  const marketplace = getWmsMarketplaceFromUi();
  finalizeWmsDraftLinesBeforeSave();
  const flat = collectWmsFlatLinesFromDraft();
  const rawBoxes = (wmsState.draft.boxes || []);
  const boxesSnapshot = rawBoxes.map(box => {
    const comp = getComponentById(box.componentId);
    const nextItems = (box.items || [])
      .map(it => deepCloneJson(it))
      .filter(it => Math.max(0, Math.floor(Number(it?.qty || 0))) > 0);
    return {
      id: (box?.id != null && String(box.id) !== '') ? box.id : newWmsBoxId(),
      componentId: box.componentId || '',
      componentName: comp?.name || '',
      deliveryCostTashkent: Number(comp?.deliveryCostTashkent || 0),
      items: nextItems
    };
  }).filter(b => Array.isArray(b.items) && b.items.length > 0); // не сохраняем пустые коробки
  const t = computeWmsDraftTotals();
  const nowIso = new Date().toISOString();
  const shipments = readShipmentsSafe();
  const prev = shipments.find(s => String(s.id) === String(shipmentId));
  const createdAt = prev?.createdAt || nowIso;
  return {
    version: 2,
    id: shipmentId,
    name,
    date,
    shipmentDate: date,
    marketplace,
    status,
    createdAt,
    updatedAt: nowIso,
    truckCost: t.truck,
    loaderCost: t.loader,
    boxes: boxesSnapshot,
    items: flat.map(it => {
      const clone = deepCloneJson(it);
      return {
        sku: clone.sku,
        qty: Math.max(0, Math.floor(Number(clone.qty || 0))),
        unitCost: Number(clone.unitCost || clone.financialSnapshot?.costGross || 0),
        name: clone.name,
        productRecordId: clone.productRecordId,
        lineId: clone.lineId,
        financialSnapshot: clone.financialSnapshot,
        // Жёсткая фиксация выплаты Uzum на момент сборки
        fixedUzumPayout: clone.fixedUzumPayout != null && Number.isFinite(Number(clone.fixedUzumPayout))
          ? Number(clone.fixedUzumPayout)
          : 0
      };
    }),
    totalQuantity: Math.max(0, Math.floor(Number(t.qtyTotal || 0))),
    totalCost: Number(t.goods || 0),
    totalAmount: Number(t.grand || 0),
    totals: {
      boxLogistics: t.boxLog,
      totalLogistics: t.totalLog,
      goodsCost: t.goods,
      grandTotal: t.grand
    },
    liveStockAllocated: true
  };
}

function buildShipmentQtyByRecordId(sh) {
  const map = new Map();
  if (!sh) return map;
  let flat = [];
  if (sh.version === 2 && Array.isArray(sh.boxes)) {
    sh.boxes.forEach(b => (b.items || []).forEach(it => flat.push(it)));
  } else {
    flat = Array.isArray(sh.items) ? sh.items : [];
  }
  flat.forEach(it => {
    const rid = it?.productRecordId != null && String(it.productRecordId) !== '' ? String(it.productRecordId) : '';
    const q = Math.max(0, Math.floor(Number(it?.qty ?? it?.quantity ?? 0)));
    if (!rid || !q) return;
    map.set(rid, (map.get(rid) || 0) + q);
  });
  return map;
}

function buildShipmentEditStockDeltaByRecordId(oldShipment, newShipment) {
  // Delta-принцип: delta = oldQty - newQty ( >0 вернуть, <0 списать )
  const a = buildShipmentQtyByRecordId(oldShipment);
  const b = buildShipmentQtyByRecordId(newShipment);
  const out = new Map();
  const keys = new Set([...Array.from(a.keys()), ...Array.from(b.keys())]);
  keys.forEach((rid) => {
    const oldQ = Math.max(0, Math.floor(Number(a.get(rid) || 0)));
    const newQ = Math.max(0, Math.floor(Number(b.get(rid) || 0)));
    const delta = oldQ - newQ;
    if (delta) out.set(String(rid), delta);
  });
  return out;
}

async function saveWmsShipmentToFirestoreTransaction(shipment, stockDeltasByRecordId, auditContext) {
  const shipmentsCol = getShipmentsCollectionRef();
  const productsCol = getProductsCollectionRef();
  const id = shipment?.id != null ? String(shipment.id) : '';
  if (!shipmentsCol || !productsCol || !id) throw new Error('Firebase: недоступны коллекции или id поставки.');
  const FieldValue = firebase?.firestore?.FieldValue;
  if (!FieldValue || typeof FieldValue.increment !== 'function') throw new Error('Firebase FieldValue недоступен.');

  const entries = Array.from((stockDeltasByRecordId instanceof Map) ? stockDeltasByRecordId.entries() : []);

  await db.runTransaction(async (tx) => {
    // 1) проверить остатки, если нужно списывать (delta < 0)
    if (entries.length) {
      const reads = entries.map(([rid]) => productsCol.doc(String(rid)));
      const snaps = await Promise.all(reads.map(ref => tx.get(ref)));
      const curStock = new Map();
      snaps.forEach((snap, i) => {
        const rid = String(entries[i][0]);
        const v = snap?.exists ? Number(snap.data()?.stockQty || 0) : 0;
        curStock.set(rid, Math.max(0, Math.floor(v)));
      });
      entries.forEach(([rid, delta]) => {
        const d = Math.floor(Number(delta || 0));
        if (!d) return;
        const cur = curStock.get(String(rid)) ?? 0;
        if (cur + d < 0) {
          throw new Error(`Недостаточно остатка для записи ${rid}: нужно ${-d}, на складе ${cur}.`);
        }
      });
      const nowIso = new Date().toISOString();
      entries.forEach(([rid, delta]) => {
        const d = Math.floor(Number(delta || 0));
        if (!d) return;
        tx.set(productsCol.doc(String(rid)), { stockQty: FieldValue.increment(d), updatedAt: nowIso }, { merge: true });
      });
    }

    // 2) сохранить поставку (totals и boxes записываем только если транзакция целиком успешна)
    tx.set(shipmentsCol.doc(id), shipment, { merge: true });
  });

  // локально: применяем delta к памяти сразу, чтобы главная страница показала верные остатки без ожидания onSnapshot
  if (entries.length) {
    applyStockDeltasToLocalProducts(stockDeltasByRecordId);
    const act = auditContext?.action_type || 'wms_shipment_save_delta';
    entries.forEach(([rid, delta]) => {
      const d = Math.floor(Number(delta || 0));
      if (!d) return;
      const p = findProductByRecordId(readProductsSafe(), String(rid));
      const next = p ? Math.max(0, Math.floor(Number(p.stockQty || 0))) : 0;
      const prev = Math.max(0, next - d);
      recordProductStockAudit(String(rid), prev, next, act, auditContext || {});
    });
  }
  return true;
}

function upsertShipmentInStore(shipment) {
  const shipments = readShipmentsSafe();
  const idx = shipments.findIndex(s => String(s.id) === String(shipment.id));
  if (idx >= 0) shipments[idx] = shipment;
  else shipments.push(shipment);
  writeStore(STORAGE_KEYS.shipments, shipments);
  upsertShipmentToFirestore(shipment).then((ok) => {
    if (!ok) console.error('Поставка не сохранена в облако (см. ошибку выше). id=', shipment?.id);
  });
}

async function saveWmsShipmentDraft() {
  const name = (document.getElementById('wmsShipmentName')?.value || '').trim();
  const date = document.getElementById('wmsShipmentDate')?.value || '';
  if (!name) {
    alert('Укажи название поставки.');
    return;
  }
  if (!date) {
    alert('Укажи дату.');
    return;
  }
  const shipmentId = wmsState.editingDraftId != null ? wmsState.editingDraftId : Date.now();
  const shipment = buildWmsShipmentRecordFromUi('draft', shipmentId);
  // принудительный пересчёт totals уже внутри buildWmsShipmentRecordFromUi
  try {
    await saveWmsShipmentToFirestoreTransaction(shipment, new Map(), { action_type: 'wms_draft_save', shipment_id: String(shipmentId) });
    upsertShipmentInStore(shipment);
    wmsState.editingDraftId = shipmentId;
    wmsState.sessionIsNewAssembly = false;
    renderWmsHistory();
    showWmsDraftSavedToast();
  } catch (e) {
    console.error('saveWmsShipmentDraft: transaction: ', e);
    alert(e?.message || 'Не удалось сохранить черновик в Firebase.');
  }
}

async function sendWmsShipment() {
  const name = (document.getElementById('wmsShipmentName')?.value || '').trim();
  const date = document.getElementById('wmsShipmentDate')?.value || '';
  if (!name) {
    alert('Укажи название поставки.');
    return;
  }
  if (!date) {
    alert('Укажи дату.');
    return;
  }
  const flat = collectWmsFlatLinesFromDraft();
  if (!flat.length) {
    alert('Добавь хотя бы один товар в коробки.');
    return;
  }
  const products = readProductsSafe();
  for (let i = 0; i < flat.length; i++) {
    const it = flat[i];
    const rid = it?.productRecordId != null && String(it.productRecordId) !== '' ? String(it.productRecordId) : '';
    if (!rid) continue;
    const idx = products.findIndex(p => recordIdsEqual(p.recordId, rid));
    if (idx < 0) {
      alert(`Товар (запись ${rid}) не найден в базе.`);
      return;
    }
    const stock = Math.max(0, Math.floor(Number(products[idx].stockQty || 0)));
    if (stock < 0) {
      alert(`Некорректный остаток для ${products[idx].sku || rid}. Проверьте количества в коробках.`);
      return;
    }
  }

  const isEditingSent = !!wmsState.editingOriginalSent && shipmentRecordStatus(wmsState.editingOriginalSent) === 'sent';
  // Для sent-редактирования — применяем Delta при сохранении (одной транзакцией), а не "по ходу" ввода.

  const shipmentId = wmsState.editingDraftId != null ? wmsState.editingDraftId : Date.now();
  const shipment = buildWmsShipmentRecordFromUi('sent', shipmentId);
  try {
    const deltas = isEditingSent ? buildShipmentEditStockDeltaByRecordId(wmsState.editingOriginalSent, shipment) : new Map();
    await saveWmsShipmentToFirestoreTransaction(shipment, deltas, {
      action_type: isEditingSent ? 'wms_shipment_sent_edit_save' : 'wms_shipment_sent_save',
      shipment_id: String(shipmentId)
    });
    upsertShipmentInStore(shipment);
  } catch (e) {
    console.error('sendWmsShipment: transaction: ', e);
    alert(e?.message || 'Не удалось сохранить поставку в Firebase.');
    return;
  }
  wmsState.sessionIsNewAssembly = false;
  recordActivityLogOnly(
    'shipment_sent',
    String(shipmentId),
    isEditingSent ? 'sent_update' : 'sent_new',
    shipment.name || '',
    { shipment_id: String(shipmentId), qty_lines: flat.length }
  );

  closeWmsAssemble();
  renderWmsHistory();
  renderProductsDb();
  alert(isEditingSent ? 'Поставка обновлена.' : 'Поставка отправлена.');
}

function summarizeBoxesForCard(boxes) {
  const map = new Map();
  (boxes || []).forEach(b => {
    const label = b.componentName || 'Коробка';
    map.set(label, (map.get(label) || 0) + 1);
  });
  return Array.from(map.entries()).map(([label, cnt]) => `${cnt} шт ${label}`).join(', ') || '—';
}

/** Суммы по товарам для возврата остатка при удалении отправленной поставки. */
function aggregateShipmentQtyForStockRestore(sh) {
  const byRecordId = new Map();
  const bySku = new Map();
  let flat = [];
  if (sh.version === 2 && Array.isArray(sh.boxes)) {
    sh.boxes.forEach(b => (b.items || []).forEach(it => flat.push(it)));
  } else {
    flat = Array.isArray(sh.items) ? sh.items : [];
  }
  flat.forEach(it => {
    const q = Math.max(0, Math.floor(Number(it.qty ?? it.quantity ?? 0)));
    if (!q) return;
    const rid = it.productRecordId != null && String(it.productRecordId) !== '' ? String(it.productRecordId) : '';
    const sku = String(it.sku || '').trim();
    if (rid) {
      byRecordId.set(rid, (byRecordId.get(rid) || 0) + q);
    } else if (sku) {
      bySku.set(sku, (bySku.get(sku) || 0) + q);
    }
  });
  return { byRecordId, bySku };
}

function buildShipmentStockDeltasByRecordId(sh, multiplier) {
  const { byRecordId, bySku } = aggregateShipmentQtyForStockRestore(sh);
  const deltas = new Map();
  byRecordId.forEach((qty, rid) => {
    const k = String(rid);
    deltas.set(k, (deltas.get(k) || 0) + Math.floor(Number(qty || 0)) * multiplier);
  });
  // Если в строках есть только sku — пробуем сопоставить через локальную базу (без лишних запросов).
  if (bySku.size) {
    const products = readProductsSafe();
    bySku.forEach((qty, sku) => {
      const p = products.find(x => String(x?.sku || '').trim() === String(sku || '').trim());
      const rid = p?.recordId != null && String(p.recordId) !== '' ? String(p.recordId) : '';
      if (!rid) return;
      deltas.set(rid, (deltas.get(rid) || 0) + Math.floor(Number(qty || 0)) * multiplier);
    });
  }
  // Чистим нули
  Array.from(deltas.entries()).forEach(([rid, delta]) => {
    if (!delta) deltas.delete(rid);
  });
  return deltas;
}

async function applyProductStockDeltasInFirestore(deltasByRecordId, auditContext) {
  const col = getProductsCollectionRef();
  if (!col) {
    console.error('applyProductStockDeltasInFirestore: коллекция products недоступна.');
    throw new Error('Firebase: коллекция products недоступна.');
  }
  const entries = Array.from((deltasByRecordId instanceof Map) ? deltasByRecordId.entries() : []);
  if (!entries.length) return true;

  const FieldValue = firebase?.firestore?.FieldValue;
  if (!FieldValue || typeof FieldValue.increment !== 'function') {
    console.error('applyProductStockDeltasInFirestore: FieldValue.increment недоступен.');
    throw new Error('Firebase FieldValue недоступен для списания остатков.');
  }

  const productsSnapshot = readProductsSafe();
  const batch = db.batch();
  const nowIso = new Date().toISOString();
  entries.forEach(([rid, delta]) => {
    const docRef = col.doc(String(rid));
    batch.set(docRef, {
      stockQty: FieldValue.increment(Number(delta)),
      updatedAt: nowIso
    }, { merge: true });
  });
  try {
    await batch.commit();
  } catch (e) {
    console.error('applyProductStockDeltasInFirestore: batch.commit: ', e);
    throw e;
  }
  const act = auditContext?.action_type || 'bulk_stock_delta';
  entries.forEach(([rid, delta]) => {
    const d = Math.floor(Number(delta || 0));
    if (!d) return;
    const p = productsSnapshot.find(x => recordIdsEqual(x.recordId, rid));
    const cur = p ? Math.max(0, Math.floor(Number(p.stockQty || 0))) : 0;
    const next = Math.max(0, cur + d);
    recordProductStockAudit(String(rid), cur, next, act, auditContext || {});
  });
  return true;
}

async function applyProductStockDeltasInFirestoreTransaction(deltasByRecordId, auditContext) {
  const col = getProductsCollectionRef();
  if (!col) {
    console.error('applyProductStockDeltasInFirestoreTransaction: коллекция products недоступна.');
    throw new Error('Firebase: коллекция products недоступна.');
  }
  const entries = Array.from((deltasByRecordId instanceof Map) ? deltasByRecordId.entries() : []);
  if (!entries.length) return true;
  const FieldValue = firebase?.firestore?.FieldValue;
  if (!FieldValue || typeof FieldValue.increment !== 'function') {
    console.error('applyProductStockDeltasInFirestoreTransaction: FieldValue.increment недоступен.');
    throw new Error('Firebase FieldValue недоступен.');
  }

  const auditRows = [];
  // Транзакция нужна, чтобы не уйти в минус при увеличении количества в уже отправленной поставке.
  await db.runTransaction(async (tx) => {
    // 1) прочитать текущие остатки
    const reads = entries.map(([rid]) => col.doc(String(rid)));
    const snaps = await Promise.all(reads.map(ref => tx.get(ref)));
    const curStock = new Map();
    snaps.forEach((snap, i) => {
      const rid = String(entries[i][0]);
      const v = snap?.exists ? Number(snap.data()?.stockQty || 0) : 0;
      curStock.set(rid, Math.max(0, Math.floor(v)));
    });

    // 2) проверка на отрицательный остаток
    entries.forEach(([rid, delta]) => {
      const d = Math.floor(Number(delta || 0));
      if (!d) return;
      const cur = curStock.get(String(rid)) ?? 0;
      if (cur + d < 0) {
        throw new Error(`Недостаточно остатка для записи ${rid}: нужно ${-d}, на складе ${cur}.`);
      }
    });

    // 3) применить инкременты
    const nowIso = new Date().toISOString();
    entries.forEach(([rid, delta]) => {
      const d = Math.floor(Number(delta || 0));
      if (!d) return;
      const cur = curStock.get(String(rid)) ?? 0;
      auditRows.push({ rid: String(rid), prev: cur, next: Math.max(0, cur + d) });
      tx.set(col.doc(String(rid)), {
        stockQty: FieldValue.increment(d),
        updatedAt: nowIso
      }, { merge: true });
    });
  });

  const act = auditContext?.action_type || 'bulk_stock_tx';
  auditRows.forEach(({ rid, prev, next }) => {
    if (prev === next) return;
    recordProductStockAudit(rid, prev, next, act, auditContext || {});
  });

  return true;
}

function restoreProductStockFromDeletedShipment(sh) {
  const { byRecordId, bySku } = aggregateShipmentQtyForStockRestore(sh);
  if (!byRecordId.size && !bySku.size) return;
  const products = readProductsSafe();
  const now = new Date().toISOString();
  byRecordId.forEach((addQty, rid) => {
    const idx = products.findIndex(p => recordIdsEqual(p.recordId, rid));
    if (idx < 0) return;
    const cur = Math.max(0, Math.floor(Number(products[idx].stockQty || 0)));
    products[idx] = {
      ...products[idx],
      stockQty: cur + addQty,
      updatedAt: now
    };
  });
  bySku.forEach((addQty, sku) => {
    const idx = products.findIndex(p => String(p.sku || '').trim() === sku);
    if (idx < 0) return;
    const cur = Math.max(0, Math.floor(Number(products[idx].stockQty || 0)));
    products[idx] = {
      ...products[idx],
      stockQty: cur + addQty,
      updatedAt: now
    };
  });
  writeStore(STORAGE_KEYS.products, products);
}

function applyStockDeltasToLocalProducts(deltasByRecordId) {
  const entries = Array.from((deltasByRecordId instanceof Map) ? deltasByRecordId.entries() : []);
  if (!entries.length) return;
  const products = readProductsSafe();
  const now = new Date().toISOString();
  entries.forEach(([rid, delta]) => {
    const idx = products.findIndex(p => recordIdsEqual(p.recordId, rid));
    if (idx < 0) return;
    const cur = Math.max(0, Math.floor(Number(products[idx].stockQty || 0)));
    const next = Math.max(0, cur + Math.floor(Number(delta || 0)));
    products[idx] = { ...products[idx], stockQty: next, updatedAt: now };
  });
  writeStore(STORAGE_KEYS.products, products);
}

async function deleteWmsShipmentById(shipmentId) {
  if (!confirm('Вы уверены, что хотите удалить эту поставку?')) return;
  const shipments = readShipmentsSafe();
  const idx = shipments.findIndex(s => String(s.id) === String(shipmentId));
  if (idx < 0) return;
  const sh = shipments[idx];

  if (wmsState.editingDraftId != null && String(wmsState.editingDraftId) === String(shipmentId)) {
    dismissWmsAssembleUiOnly();
  }
  closeWmsUnitEconModal();

  const st = shipmentRecordStatus(sh);
  const mustRestoreStock = st === 'sent' || (st === 'draft' && sh.liveStockAllocated);
  if (mustRestoreStock) {
    try {
      const deltas = buildShipmentStockDeltasByRecordId(sh, +1);
      await applyProductStockDeltasInFirestore(deltas, { action_type: 'shipment_delete_restore', shipment_id: String(shipmentId) });
      restoreProductStockFromDeletedShipment(sh);
    } catch (e) {
      console.error('Ошибка возврата остатков при удалении поставки: ', e);
      alert('Не удалось вернуть остатки в Firebase. Поставка НЕ удалена.');
      return;
    }
  }

  // 1) СНАЧАЛА удаляем документ из Firestore
  const ok = await deleteShipmentFromFirestore(shipmentId);
  if (!ok) {
    alert('Не удалось удалить поставку из Firebase. Локально запись не удалена.');
    return;
  }
  // 2) Только после подтверждения Firebase — удаляем локально
  shipments.splice(idx, 1);
  writeStore(STORAGE_KEYS.shipments, shipments);
  // чистим старые localStorage кеши, если остались (на всякий случай)
  try {
    localStorage.removeItem(STORAGE_KEYS.shipments);
    localStorage.removeItem('shipments');
    localStorage.removeItem('uzum_shipments_db_v1');
  } catch {}
  recordActivityLogOnly('shipment_deleted', '', sh.name || '', String(sh.id), { shipment_id: String(sh.id), status: st });
  renderWmsHistory();
  renderProductsDb();
}

function renderWmsHistory() {
  const host = document.getElementById('wmsShipmentsHistory');
  const empty = document.getElementById('wmsShipmentsEmpty');
  if (!host) return;
  const list = readShipmentsSafe().slice().sort((a, b) => String(b.createdAt || b.date || '').localeCompare(String(a.createdAt || a.date || '')));
  host.innerHTML = '';
  empty?.classList.toggle('hidden', list.length > 0);
  list.forEach(sh => {
    if (sh.version !== 2) {
      if (!Array.isArray(sh.items) || !sh.items.length) return;
    }
    const card = document.createElement('div');
    card.dataset.shipmentId = String(sh.id);
    let qty = 0;
    let detailHtml = '';
    if (sh.version === 2 && sh.boxes) {
      sh.boxes.forEach((box, i) => {
        let inner = '';
        (box.items || []).forEach((it, j) => {
          qty += Math.max(0, Math.floor(Number(it.qty || 0)));
          const uc = Number(it.unitCost ?? it.financialSnapshot?.costGross ?? 0);
          inner += `<tr><td>${escapeHtml(it.financialSnapshot?.name || it.name || '—')}</td><td>${escapeHtml(it.sku || '—')}</td><td>${Math.floor(Number(it.qty || 0)).toLocaleString('ru-RU')}</td><td>${escapeHtml(fmtMoney(uc))}</td><td><button type="button" class="wms-calc-icon-btn" title="Калькуляция из поставки" data-wms-saved-calc="${escapeAttr(String(sh.id))}" data-wms-box-idx="${i}" data-wms-line-idx="${j}">🧮</button></td></tr>`;
        });
        detailHtml += `<div class="wms-ship-detail-box"><h4>Коробка ${i + 1} · ${escapeHtml(box.componentName || '—')} (${escapeHtml(fmtMoney(Number(box.deliveryCostTashkent || 0)))})</h4>
          <div class="table-wrap"><table><thead><tr><th>Товар</th><th>SKU</th><th>Шт</th><th>Себест. 1 шт</th><th title="Калькуляция">Кальк.</th></tr></thead><tbody>${inner || '<tr><td colspan="5" class="muted">Пусто</td></tr>'}</tbody></table></div></div>`;
      });
    } else {
      (sh.items || []).forEach(it => {
        qty += Math.max(0, Math.floor(Number(it.qty || it.quantity || 0)));
      });
      detailHtml = '<div class="note">Старая запись без коробок. Детали в таблице items.</div>';
    }
    const tot = sh.totals || {};
    const goods = Number(tot.goodsCost != null ? tot.goodsCost : (sh.items || []).reduce((s, it) => {
      const q = Math.floor(Number(it.qty ?? it.quantity ?? 0));
      return s + q * Number(it.unitCost ?? it.cost ?? it.cogs ?? 0);
    }, 0));
    const log = Number(tot.totalLogistics != null ? tot.totalLogistics : 0);
    const boxSummary = sh.version === 2 ? summarizeBoxesForCard(sh.boxes) : '—';
    const isDraft = shipmentRecordStatus(sh) === 'draft';
    card.className = isDraft ? 'wms-ship-card wms-ship-card--draft' : 'wms-ship-card';
    const mpLabel = normalizeShipmentMarketplace(sh);
    const mpBadge = `<span class="wms-mp-badge" title="Маркетплейс">${escapeHtml(mpLabel)}</span>`;
    const editDraftBtn = isDraft
      ? `<button type="button" class="btn-primary" data-wms-edit-draft="${escapeAttr(String(sh.id))}">Редактировать</button>`
      : '';
    const editSentBtn = !isDraft && shipmentRecordStatus(sh) === 'sent'
      ? `<button type="button" class="btn-primary" data-wms-edit-sent="${escapeAttr(String(sh.id))}">Редактировать</button>`
      : '';
    card.innerHTML = `
      <div class="wms-ship-card-top">
        <div>
          <div class="wms-ship-card-title-row">
            <h3 style="margin:0;">${escapeHtml(sh.name || 'Поставка')}</h3>
            ${mpBadge}
            ${isDraft ? '<span class="wms-draft-badge">Черновик</span>' : ''}
          </div>
          <div class="muted" style="font-weight:700;">${escapeHtml(fmtDate(sh.date || sh.shipmentDate))}</div>
        </div>
      </div>
      <div class="wms-ship-stats">
        <span class="chip">Товаров, шт: ${qty.toLocaleString('ru-RU')}</span>
        <span class="chip">Коробки: ${escapeHtml(boxSummary)}</span>
        <span class="chip">Логистика: ${escapeHtml(fmtMoney(log))}</span>
        <span class="chip">Себестоимость: ${escapeHtml(fmtMoney(goods))}</span>
      </div>
      <div class="wms-ship-actions">
        ${editDraftBtn || editSentBtn}
        <button type="button" class="btn-secondary" data-wms-toggle-detail="${escapeAttr(String(sh.id))}">Детализация</button>
        <button type="button" class="btn-secondary" data-wms-detail-xlsx="${escapeAttr(String(sh.id))}">Скачать детализацию (Excel)</button>
        <button type="button" class="btn-secondary btn-download-finance" data-wms-finance-xlsx="${escapeAttr(String(sh.id))}">Скачать Финансовый отчет (Excel)</button>
        <button type="button" class="btn-primary" data-wms-xlsx="${escapeAttr(String(sh.id))}">Скачать поставку (Excel)</button>
        <button type="button" class="btn-secondary" data-wms-1c-xlsx="${escapeAttr(String(sh.id))}">Скачать расходную для 1С</button>
        ${normalizeShipmentMarketplace(sh) === 'Uzum Market' ? `<button type="button" class="btn-secondary" data-wms-uzum-invoices-zip="${escapeAttr(String(sh.id))}">Скачать накладные Uzum</button>` : ''}
        <button type="button" class="wms-ship-delete-btn" data-wms-delete-shipment="${escapeAttr(String(sh.id))}" title="Удалить поставку" aria-label="Удалить поставку"><span class="wms-del-icon" aria-hidden="true">🗑</span>Удалить</button>
      </div>
      <div class="wms-ship-detail" id="wms-ship-detail-${sh.id}">${detailHtml}</div>
    `;
    host.appendChild(card);
  });
  host.querySelectorAll('[data-wms-edit-draft]').forEach(btn => {
    btn.addEventListener('click', () => {
      void openWmsEditDraft(btn.getAttribute('data-wms-edit-draft'));
    });
  });
  host.querySelectorAll('[data-wms-edit-sent]').forEach(btn => {
    btn.addEventListener('click', () => {
      void openWmsEditDraft(btn.getAttribute('data-wms-edit-sent'));
    });
  });
  async function fetchShipmentFreshIntoStore(id) {
    const col = getShipmentsCollectionRef();
    if (!col) return null;
    try {
      const snap = await col.doc(String(id)).get();
      if (!snap?.exists) return null;
      const data = snap.data() || {};
      const rowId = data.id != null && String(data.id) !== '' ? String(data.id) : String(id);
      const fresh = { ...data, id: rowId };
      upsertShipmentInStore(fresh);
      return fresh;
    } catch (e) {
      console.error('fetchShipmentFreshIntoStore: ', e);
      return null;
    }
  }

  host.querySelectorAll('[data-wms-toggle-detail]').forEach(btn => {
    btn.addEventListener('click', () => void (async () => {
      const id = btn.getAttribute('data-wms-toggle-detail');
      const panel = document.getElementById(`wms-ship-detail-${id}`);
      if (!panel) return;
      // Подтягиваем актуальные boxes прямо из Firebase, затем открываем панель.
      const fresh = await fetchShipmentFreshIntoStore(id);
      if (fresh && fresh.version === 2 && Array.isArray(fresh.boxes)) {
        // Перерисовать весь список проще и безопаснее, чем точечно править DOM разметку деталей.
        renderWmsHistory();
        const reopened = document.getElementById(`wms-ship-detail-${id}`);
        reopened?.classList.add('open');
      } else {
        panel.classList.toggle('open');
      }
    })());
  });
  host.querySelectorAll('[data-wms-xlsx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-wms-xlsx');
      exportWmsShipmentToXlsx(Number(id) || id);
    });
  });
  host.querySelectorAll('[data-wms-1c-xlsx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-wms-1c-xlsx');
      exportWmsShipmentTo1cXlsx(Number(id) || id);
    });
  });
  host.querySelectorAll('[data-wms-uzum-invoices-zip]').forEach(btn => {
    btn.addEventListener('click', () => {
      void exportUzumInvoicesZip(btn.getAttribute('data-wms-uzum-invoices-zip'));
    });
  });
  host.querySelectorAll('[data-wms-detail-xlsx]').forEach(btn => {
    btn.addEventListener('click', () => {
      exportWmsShipmentDetailCalcXlsx(btn.getAttribute('data-wms-detail-xlsx'));
    });
  });
  host.querySelectorAll('[data-wms-finance-xlsx]').forEach(btn => {
    btn.addEventListener('click', () => {
      exportShipmentFinanceToExcel(btn.getAttribute('data-wms-finance-xlsx'));
    });
  });
  host.querySelectorAll('[data-wms-saved-calc]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openWmsUnitEconModalSaved(
        btn.getAttribute('data-wms-saved-calc'),
        Number(btn.getAttribute('data-wms-box-idx')),
        Number(btn.getAttribute('data-wms-line-idx'))
      );
    });
  });
  host.querySelectorAll('[data-wms-delete-shipment]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteWmsShipmentById(btn.getAttribute('data-wms-delete-shipment'));
    });
  });
}

function resolveShipmentLineProduct(it) {
  if (!it || typeof it !== 'object') return null;
  const rid = it.productRecordId != null ? String(it.productRecordId) : '';
  if (rid) {
    const byRid = findProductByRecordId(readProductsSafe(), rid);
    if (byRid) return byRid;
  }
  const sku = String(it.sku || it.financialSnapshot?.sku || '').trim();
  if (!sku) return null;
  return readProductsSafe().find((p) => {
    const keys = [
      p.sku,
      p.article1c,
      p.uzumSku,
      p.uzum_sku,
      p.wbSku,
      p.wb_nmid,
      p.yandexSku,
      p.yandex_sku
    ].map((v) => String(v || '').trim()).filter(Boolean);
    return keys.includes(sku);
  }) || null;
}

function getShipmentLineArticle1c(it) {
  const fs = it?.financialSnapshot || {};
  const calc = fs.calc || {};
  const a1 = fs.article1c != null ? String(fs.article1c).trim() : '';
  if (a1) return a1;
  const c1 = calc.productArticle1c != null ? String(calc.productArticle1c).trim() : '';
  if (c1) return c1;
  const p = resolveShipmentLineProduct(it);
  return p ? String(p.article1c || p.name || '').trim() : '';
}

function getShipmentLineCode1c(it) {
  const fs = it?.financialSnapshot || {};
  const calc = fs.calc || {};
  const c1 = fs.code1c != null ? String(fs.code1c).trim() : '';
  if (c1) return c1;
  const c2 = calc.productCode1c != null ? String(calc.productCode1c).trim() : '';
  if (c2) return c2;
  const p = resolveShipmentLineProduct(it);
  return p ? String(p.code1c || '').trim() : '';
}

/** Себестоимость 1 шт в сумах для строки поставки (снапшот → unitCost → база товаров). */
function getShipmentLineUnitCostUzs(it) {
  const fs = it?.financialSnapshot || {};
  let v = productCostPriceUzs(fs);
  if (v > 0) return v;
  v = Number(it?.unitCost ?? it?.cost ?? it?.cogs ?? 0);
  if (Number.isFinite(v) && v > 0) return v;
  const p = resolveShipmentLineProduct(it);
  return p ? productCostPriceUzs(p) : 0;
}

function getShipmentLineUzumBarcode(it) {
  const p = resolveShipmentLineProduct(it);
  return p ? normalizeUzumBarcode(p.uzum_barcode) : '';
}

function ensureExcelJsReady() {
  if (typeof window === 'undefined' || typeof window.ExcelJS === 'undefined') {
    throw new Error('ExcelJS не загрузился. Проверьте подключение exceljs.min.js.');
  }
}

function ensureJsZipReady() {
  if (typeof window === 'undefined' || typeof window.JSZip === 'undefined') {
    throw new Error('JSZip не загрузился. Проверьте подключение jszip.min.js.');
  }
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function collectShipmentBoxesForExport(sh) {
  if (sh?.version === 2 && Array.isArray(sh.boxes) && sh.boxes.length) {
    return sh.boxes.map((box, idx) => ({ box, index: idx + 1 }));
  }
  const flat = Array.isArray(sh?.items) ? sh.items : [];
  if (!flat.length) return [];
  return [{ box: { items: flat }, index: 1 }];
}

const UZUM_INVOICE_TEMPLATE_URL = 'assets/uzum-invoice-template.xlsx';
const UZUM_INVOICE_DATA_START_ROW = 2;
let uzumInvoiceTemplateBufferCache = null;

function cloneArrayBuffer(buffer) {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(new Uint8Array(buffer));
  return copy;
}

function excelCellText(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => String(part?.text ?? '')).join('');
    }
    if (value.text != null) return String(value.text);
    if (value.result != null) return String(value.result);
  }
  return String(value);
}

function resolveUzumInvoiceDataSheet(workbook) {
  const sheets = Array.isArray(workbook?.worksheets) ? workbook.worksheets : [];
  const byHeader = sheets.find((ws) => {
    const row = ws.getRow(1);
    const headers = [1, 2, 3].map((col) => excelCellText(row.getCell(col).value).toLowerCase());
    return headers.some((h) => h.includes('штрихкод')) && headers.some((h) => h.includes('себестоим'));
  });
  if (byHeader) return byHeader;
  if (sheets.length > 1) return sheets[1];
  return sheets[0] || null;
}

function base64ToArrayBuffer(base64) {
  const normalized = String(base64 || '').replace(/\s+/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function loadUzumInvoiceTemplateFromEmbeddedBase64() {
  const embedded = (typeof window !== 'undefined' && window.UZUM_INVOICE_TEMPLATE_BASE64)
    ? String(window.UZUM_INVOICE_TEMPLATE_BASE64).trim()
    : '';
  if (!embedded) return null;
  return base64ToArrayBuffer(embedded);
}

async function loadUzumInvoiceTemplateBuffer() {
  if (uzumInvoiceTemplateBufferCache) return uzumInvoiceTemplateBufferCache;

  const embeddedBuffer = loadUzumInvoiceTemplateFromEmbeddedBase64();
  if (embeddedBuffer) {
    uzumInvoiceTemplateBufferCache = embeddedBuffer;
    return uzumInvoiceTemplateBufferCache;
  }

  // fetch работает только по http(s):// — при file:// браузер блокирует локальные файлы
  if (typeof window !== 'undefined' && window.location?.protocol === 'file:') {
    throw new Error(
      'Шаблон Uzum недоступен при открытии index.html напрямую (file://). ' +
      'Подключите assets/uzum-invoice-template.base64.js или откройте проект через локальный сервер.'
    );
  }

  try {
    const resp = await fetch(UZUM_INVOICE_TEMPLATE_URL, { cache: 'no-store' });
    if (resp.ok) {
      uzumInvoiceTemplateBufferCache = await resp.arrayBuffer();
      return uzumInvoiceTemplateBufferCache;
    }
  } catch (e) {
    console.warn('loadUzumInvoiceTemplateBuffer: fetch не удался', e);
  }

  throw new Error(`Не удалось загрузить шаблон Uzum. Проверьте ${UZUM_INVOICE_TEMPLATE_URL} или assets/uzum-invoice-template.base64.js.`);
}

function clearUzumInvoiceDataRows(sheet, fromRow, toRow) {
  for (let rowNum = fromRow; rowNum <= toRow; rowNum += 1) {
    const row = sheet.getRow(rowNum);
    [1, 2, 3].forEach((col) => {
      const cell = row.getCell(col);
      cell.value = null;
    });
  }
}

function setUzumInvoiceBarcodeCell(cell, barcode) {
  const normalized = normalizeUzumBarcode(barcode);
  if (!normalized) {
    cell.value = null;
    return;
  }
  if (/^\d+$/.test(normalized)) {
    cell.value = Number(normalized);
    cell.numFmt = '0';
    return;
  }
  cell.value = normalized;
  cell.numFmt = '@';
}

async function buildUzumInvoiceWorkbookBuffer(boxItems) {
  ensureExcelJsReady();
  const templateBuffer = cloneArrayBuffer(await loadUzumInvoiceTemplateBuffer());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);

  const sheet = resolveUzumInvoiceDataSheet(workbook);
  if (!sheet) {
    throw new Error('В шаблоне Uzum не найден лист с таблицей накладной.');
  }

  const dataLines = boxItems.filter((it) => Math.max(0, Math.floor(Number(it?.qty ?? it?.quantity ?? 0))) > 0);
  const clearToRow = Math.max(sheet.rowCount || 0, UZUM_INVOICE_DATA_START_ROW + dataLines.length + 20, 1000);
  clearUzumInvoiceDataRows(sheet, UZUM_INVOICE_DATA_START_ROW, clearToRow);

  let rowNum = UZUM_INVOICE_DATA_START_ROW;
  let rowsWritten = 0;
  let missingBarcode = 0;

  dataLines.forEach((it) => {
    const qty = Math.max(0, Math.floor(Number(it?.qty ?? it?.quantity ?? 0)));
    if (!qty) return;
    const barcode = getShipmentLineUzumBarcode(it);
    if (!barcode) missingBarcode += 1;
    const costUzs = Math.round(getShipmentLineUnitCostUzs(it) * 100) / 100;
    const row = sheet.getRow(rowNum);
    setUzumInvoiceBarcodeCell(row.getCell(1), barcode);
    row.getCell(2).value = costUzs;
    row.getCell(3).value = qty;
    rowNum += 1;
    rowsWritten += 1;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, rows: rowsWritten, missingBarcode };
}

/** Накладные Uzum Market: отдельный Excel на каждую коробку, всё в одном ZIP. */
async function exportUzumInvoicesZip(shipmentId) {
  const sh = readShipmentsSafe().find(s => String(s.id) === String(shipmentId));
  if (!sh) return;
  if (normalizeShipmentMarketplace(sh) !== 'Uzum Market') {
    alert('Выгрузка накладных Uzum доступна только для поставок Uzum Market.');
    return;
  }

  try {
    ensureExcelJsReady();
    ensureJsZipReady();
  } catch (e) {
    alert(e?.message || String(e));
    return;
  }

  const boxEntries = collectShipmentBoxesForExport(sh);
  if (!boxEntries.length) {
    alert('В поставке нет коробок для выгрузки.');
    return;
  }

  let zip;
  let filesAdded = 0;
  let totalMissingBarcode = 0;

  try {
    await loadUzumInvoiceTemplateBuffer();
    zip = new JSZip();

    for (const { box, index } of boxEntries) {
      const lines = (box.items || []).filter((it) => Math.max(0, Math.floor(Number(it?.qty ?? it?.quantity ?? 0))) > 0);
      if (!lines.length) continue;

      const { buffer, rows, missingBarcode } = await buildUzumInvoiceWorkbookBuffer(lines);
      if (!rows) continue;

      zip.file(`Накладная_Коробка_${index}.xlsx`, buffer);
      filesAdded += 1;
      totalMissingBarcode += missingBarcode;
    }
  } catch (e) {
    console.error('exportUzumInvoicesZip:', e);
    alert(e?.message || 'Не удалось сформировать накладные Uzum по шаблону.');
    return;
  }

  if (!filesAdded) {
    alert('Нет коробок с товарами для выгрузки накладных Uzum.');
    return;
  }

  try {
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const sid = String(sh.id ?? shipmentId).trim() || 'shipment';
    triggerBlobDownload(zipBlob, `Uzum_Invoices_Delivery_${sid}.zip`);
    if (totalMissingBarcode > 0) {
      alert(`Архив сформирован (${filesAdded} файл(ов)). У ${totalMissingBarcode} строк нет штрихкода Uzum — проверьте поле uzum_barcode в базе товаров.`);
    }
  } catch (e) {
    console.error('exportUzumInvoicesZip zip:', e);
    alert(e?.message || 'Не удалось сформировать ZIP-архив накладных Uzum.');
  }
}

function exportWmsShipmentTo1cXlsx(shipmentId) {
  const sh = readShipmentsSafe().find(s => String(s.id) === String(shipmentId));
  if (!sh) return;
  if (typeof window === 'undefined' || !window.XLSX) {
    alert('SheetJS не загрузился.');
    return;
  }

  // Собираем все строки из всех коробок поставки (или legacy items).
  // Шаблон 1С: Номенклатура = Артикул 1С, Характеристика = Код 1С, Цена = себестоимость (сум).
  const map = new Map(); // key: article1c__code1c -> { article1c, code1c, qty, sumUzs }
  let flat = [];
  if (sh.version === 2 && Array.isArray(sh.boxes)) {
    sh.boxes.forEach(b => (b.items || []).forEach(it => flat.push(it)));
  } else {
    flat = Array.isArray(sh.items) ? sh.items : [];
  }

  flat.forEach(it => {
    const article1c = String(getShipmentLineArticle1c(it) || '').trim();
    const code1c = String(getShipmentLineCode1c(it) || '').trim();
    if (!article1c || !code1c) return;
    const qty = Math.max(0, Math.floor(Number(it?.qty ?? it?.quantity ?? 0)));
    if (!qty) return;
    const unitPriceUzs = getShipmentLineUnitCostUzs(it);
    const key = `${article1c}__${code1c}`;
    const prev = map.get(key) || { article1c, code1c, qty: 0, sumUzs: 0 };
    prev.qty += qty;
    prev.sumUzs += qty * unitPriceUzs;
    map.set(key, prev);
  });

  const items = Array.from(map.values()).sort((a, b) => {
    const aa = a.article1c.localeCompare(b.article1c, 'ru');
    if (aa !== 0) return aa;
    return a.code1c.localeCompare(b.code1c, 'ru');
  });

  if (!items.length) {
    alert('В поставке нет строк с заполненными Артикулом 1С и Кодом 1С.');
    return;
  }

  const missingCostCount = items.filter((x) => (Number(x.qty) || 0) > 0 && !(Number(x.sumUzs) > 0)).length;

  // Заголовки строго по шаблону импорта расходной накладной в 1С
  const header = ['Номенклатура', 'Характеристика', 'Партия', 'Количество', 'Резерв', 'Ед. изм.', 'Цена', 'Сумма', '% НДС', 'НДС', 'Всего'];
  const aoa = [header];
  items.forEach(x => {
    const qty = Number(x.qty) || 0;
    const sumUzs = Math.round(Number(x.sumUzs || 0) * 100) / 100;
    const priceUzs = qty > 0 ? Math.round((sumUzs / qty) * 100) / 100 : 0;
    // Цена/Сумма/Всего — числа для импорта в 1С; Номенклатура и Характеристика — артикул и код 1С.
    aoa.push([x.article1c, x.code1c, '', qty, '', 'шт', priceUzs, sumUzs, '', '', sumUzs]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 22 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 },
    { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 12 }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Лист1');

  const num = String(sh.id ?? '').trim() || '—';
  const dateStr = formatShipmentDateDdMmYyyy(sh.date || sh.shipmentDate || '');
  const safeDate = dateStr ? `_${dateStr}` : '';
  XLSX.writeFile(wb, `Расходная_1С_Поставка_№${num}${safeDate}.xlsx`);
  if (missingCostCount > 0) {
    alert(`Файл сформирован. У ${missingCostCount} позиций не найдена себестоимость — колонка «Цена» будет 0. Проверьте себестоимость в базе товаров.`);
  }
}

/** Агрегация строк для накладной: одна строка на товар (по productRecordId или SKU), цена — средневзвешенная. */
function aggregateShipmentLinesForNakladnaya(sh) {
  const map = new Map();
  let flat = [];
  if (sh.version === 2 && sh.boxes) {
    sh.boxes.forEach(b => (b.items || []).forEach(it => flat.push(it)));
  } else {
    flat = sh.items || [];
  }
  flat.forEach(it => {
    const rid = it.productRecordId != null && String(it.productRecordId) !== '' ? String(it.productRecordId) : '';
    const sku = String(it.sku || '').trim();
    const key = rid || sku;
    if (!key) return;
    const qty = Math.max(0, Math.floor(Number(it.qty ?? it.quantity ?? 0)));
    if (!qty) return;
    const uc = Number(it.unitCost ?? it.financialSnapshot?.costGross ?? it.cost ?? it.cogs ?? 0);
    const art = getShipmentLineArticle1c(it);
    const prev = map.get(key) || { article1c: art || '', qty: 0, costSum: 0 };
    if (art && !prev.article1c) prev.article1c = art;
    prev.qty += qty;
    prev.costSum += qty * uc;
    map.set(key, prev);
  });
  return Array.from(map.values())
    .filter(x => x.qty > 0)
    .map(x => ({
      article1c: (x.article1c && String(x.article1c).trim()) ? String(x.article1c).trim() : '—',
      qty: x.qty,
      unitCost: x.qty > 0 ? x.costSum / x.qty : 0,
      lineTotal: x.costSum
    }));
}

function wmsNakladnayaBorderAll() {
  const edge = { style: 'thin', color: { rgb: 'FF000000' } };
  return { top: edge, bottom: edge, left: edge, right: edge };
}

function wmsNakladnayaCellStyle(partial) {
  return {
    alignment: { vertical: 'center', wrapText: true, ...(partial.alignment || {}) },
    border: wmsNakladnayaBorderAll(),
    ...(partial.fill ? { fill: { patternType: 'solid', fgColor: { rgb: partial.fill } } } : {})
  };
}

function exportWmsShipmentToXlsx(shipmentId) {
  const sh = readShipmentsSafe().find(s => String(s.id) === String(shipmentId));
  if (!sh) return;
  if (typeof window === 'undefined' || !window.XLSX) {
    alert('SheetJS не загрузился.');
    return;
  }

  const marketplaceName = (() => {
    const mp = normalizeShipmentMarketplace(sh);
    const map = {
      'Uzum Market': 'Узум маркет',
      Wildberries: 'Вайлдберриз',
      'Yandex Market': 'Яндекс маркет'
    };
    return map[mp] || mp;
  })();

  const dateObj = (() => {
    const raw = String(sh.date || sh.shipmentDate || '').trim();
    if (!raw) return null;
    const d = new Date(raw.length <= 10 ? `${raw}T00:00:00` : raw);
    return Number.isNaN(d.valueOf()) ? null : d;
  })();
  const dateStr = dateObj ? dateObj.toLocaleDateString('ru-RU') : '';

  // Группировка товаров по productRecordId (если есть), иначе по SKU.
  const map = new Map();
  let flat = [];
  if (sh.version === 2 && sh.boxes) {
    sh.boxes.forEach(b => (b.items || []).forEach(it => flat.push(it)));
  } else {
    flat = sh.items || [];
  }
  flat.forEach(it => {
    const rid = it?.productRecordId != null && String(it.productRecordId) !== '' ? String(it.productRecordId) : '';
    const sku = String(it?.sku || '').trim();
    const key = rid || sku;
    if (!key) return;
    const qty = Math.max(0, Math.floor(Number(it?.qty ?? it?.quantity ?? 0)));
    if (!qty) return;
    const unitCost = Number(it?.unitCost ?? it?.financialSnapshot?.costGross ?? it?.cost ?? it?.cogs ?? 0) || 0;
    const article1c = getShipmentLineArticle1c(it) || '—';
    const prev = map.get(key) || { article1c, qty: 0, costSum: 0 };
    if (article1c && prev.article1c === '—') prev.article1c = article1c;
    prev.qty += qty;
    prev.costSum += qty * unitCost;
    map.set(key, prev);
  });
  const items = Array.from(map.values()).filter(x => x.qty > 0).map(x => ({
    article1c: (x.article1c && String(x.article1c).trim()) ? String(x.article1c).trim() : '—',
    qty: x.qty,
    unitCost: x.qty > 0 ? x.costSum / x.qty : 0,
    lineTotal: x.costSum
  }));
  if (!items.length) {
    alert('В поставке нет строк для выгрузки.');
    return;
  }

  const aoa = [];
  // Строка 1 (Шапка)
  aoa.push(['Юкланган махсулот бўйича маълумот', '', '', '', '', '', '', '', '', '']);
  // Строка 2 (Дата)
  aoa.push(['', '', '', '', '', '', '', 'Сана:', dateStr, '']);
  // Строка 3 (Заголовки)
  aoa.push(['№', 'Махсулот номи', '', 'Нархи ҚҚС билан', 'Суммаси', 'Жами сумма ҚҚС б-н', 'Фирма, ташкилот номи', 'Кимдан', 'Кимга', 'Изох']);

  // Строки данных
  items.forEach((r, idx) => {
    aoa.push([
      idx + 1,
      r.article1c,
      r.qty,
      r.unitCost,
      r.lineTotal,
      r.lineTotal,
      '',
      'ЮНУСОВ ОТАБЕК',
      marketplaceName,
      ''
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Объединения
  const dataStartRow = 3; // 0-based: после 3 строк шапки
  const dataEndRow = dataStartRow + items.length - 1;
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } },
    ...(items.length
      ? [
        { s: { r: dataStartRow, c: 7 }, e: { r: dataEndRow, c: 7 } },
        { s: { r: dataStartRow, c: 8 }, e: { r: dataEndRow, c: 8 } }
      ]
      : [])
  ];

  const fileName = `${marketplaceName} ${dateStr} год.xlsx`;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Накладная');
  XLSX.writeFile(wb, fileName);
}

function exportWmsShipmentDetailCalcXlsx(shipmentId) {
  const sh = readShipmentsSafe().find(s => String(s.id) === String(shipmentId));
  if (!sh) return;
  if (typeof window === 'undefined' || !window.XLSX) {
    alert('SheetJS не загрузился.');
    return;
  }
  const header = ['Артикул 1С', 'SKU', 'Коробка', 'Кол-во', 'Закупка', 'Логистика', 'Коробка трансп.', 'Упаковка', 'Налог', 'Комиссия', 'Итоговая себестоимость 1 шт', 'Маржа'];
  const aoa = [header];
  const pushRow = (it, boxLabel) => {
    const b = getShipmentLineBreakdown(it, false);
    aoa.push([
      it.financialSnapshot?.article1c || it.name || '',
      it.sku || '',
      boxLabel,
      Math.max(0, Math.floor(Number(it.qty ?? it.quantity ?? 0))),
      b.zakupka,
      b.logistikaSklad,
      b.transportBox,
      b.upakovka,
      b.nalog,
      b.commission,
      b.totalSebestoimost,
      b.marginPct
    ]);
  };
  if (sh.version === 2 && Array.isArray(sh.boxes)) {
    sh.boxes.forEach((box, bi) => {
      const boxLabel = `Коробка ${bi + 1} · ${box.componentName || '—'}`;
      (box.items || []).forEach(it => pushRow(it, boxLabel));
    });
  } else {
    (sh.items || []).forEach(it => pushRow(it, '—'));
  }
  if (aoa.length === 1) {
    alert('В поставке нет строк для выгрузки.');
    return;
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 26 }, { wch: 14 }, { wch: 28 }, { wch: 8 },
    { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 22 }, { wch: 10 }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Детализация');
  const safeName = String(sh.name || 'shipment').replace(/[^\w\-]+/g, '_').slice(0, 40);
  XLSX.writeFile(wb, `shipment_detail_${safeName}_${sh.id}.xlsx`);
}

function exportShipmentFinanceToExcel(shipmentId) {
  const sh = readShipmentsSafe().find(s => String(s.id) === String(shipmentId));
  if (!sh) return;
  if (typeof window === 'undefined' || !window.XLSX) {
    alert('SheetJS не загрузился.');
    return;
  }

  const flat = [];
  if (sh.version === 2 && Array.isArray(sh.boxes)) {
    sh.boxes.forEach((b) => (b.items || []).forEach((it) => flat.push(it)));
  } else {
    (sh.items || []).forEach((it) => flat.push(it));
  }
  if (!flat.length) {
    alert('В поставке нет строк для выгрузки.');
    return;
  }

  const rows = flat.map((it, idx) => {
    const qty = Math.max(0, Math.floor(Number(it?.qty ?? it?.quantity ?? 0)));
    const unitCost = Number(it?.unitCost ?? it?.financialSnapshot?.costGross ?? it?.costPrice ?? it?.cost ?? 0) || 0;
    const sum = qty * unitCost;
    const inbound = Number(
      it?.financialSnapshot?.calc?.inboundLogisticsCost
      ?? it?.financialSnapshot?.calc?.inbound_logistics_cost
      ?? it?.calc?.inboundLogisticsCost
      ?? it?.calc?.inbound_logistics_cost
      ?? 0
    ) || 0;
    const transportBox = Number(
      it?.financialSnapshot?.calc?.transportBoxCost
      ?? it?.calc?.transportBoxCost
      ?? 0
    ) || 0;
    const payout = Number(it?.fixedUzumPayout ?? 0) || 0;
    const totalPayout = qty * payout;
    const article1c = String(getShipmentLineArticle1c(it) || '').trim() || '—';
    return {
      '№': idx + 1,
      'Артикул 1С': article1c,
      'Количество': qty,
      'Себестоимость': unitCost,
      'Сумма': sum,
      'Логистика': inbound,
      'Коробка трансп.': transportBox,
      'Сумма к выводу': payout,
      'Общая сумма к выводу': totalPayout
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows, { skipHeader: false });
  ws['!cols'] = [
    { wch: 6 },
    { wch: 26 },
    { wch: 12 },
    { wch: 16 },
    { wch: 16 },
    { wch: 14 },
    { wch: 16 },
    { wch: 16 },
    { wch: 22 }
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Финансы');

  const safeId = String(sh.id || shipmentId || '—').replace(/[^\w\-]+/g, '_');
  const dateStr = formatShipmentDateDdMmYyyy(sh.date || sh.shipmentDate || '');
  const stamp = dateStr ? `${safeId}_${dateStr}` : safeId;
  XLSX.writeFile(wb, `Финансы_Поставка_${stamp}.xlsx`);
}

// Инициализация раздела "База товаров"
if (document.getElementById('saveProductToDbBtn')) {
  document.getElementById('saveProductToDbBtn').addEventListener('click', saveCurrentProductToDb);
}
document.getElementById('exportToDbBtn')?.addEventListener('click', exportToDbFromCalculator);
if (document.getElementById('refreshProductsBtn')) {
  document.getElementById('refreshProductsBtn').addEventListener('click', renderProductsDb);
}
if (document.getElementById('productsLiveSearch')) {
  document.getElementById('productsLiveSearch').addEventListener('input', renderProductsDb);
}
{
  const el = document.getElementById('categoryFilter');
  if (el) el.addEventListener('change', filterProducts);
}
document.getElementById('productsStockLtInput')?.addEventListener('input', () => {
  // Ввод порога автоматически включает режим "меньше N"
  renderProductsDb();
});
document.getElementById('productsStockFilterZeroBtn')?.addEventListener('click', () => {
  if (state?.productsDbFilters) state.productsDbFilters.stockMode = 'zero';
  renderProductsDb();
});
document.getElementById('productsStockFilterLowBtn')?.addEventListener('click', () => {
  if (state?.productsDbFilters) state.productsDbFilters.stockMode = 'low';
  renderProductsDb();
});
document.getElementById('productsStockFilterInBtn')?.addEventListener('click', () => {
  if (state?.productsDbFilters) state.productsDbFilters.stockMode = 'in';
  renderProductsDb();
});
document.getElementById('productsFiltersResetBtn')?.addEventListener('click', () => {
  const cat = document.getElementById('categoryFilter');
  const lt = document.getElementById('productsStockLtInput');
  if (cat) cat.value = '';
  if (lt) lt.value = '';
  if (state?.productsDbFilters) state.productsDbFilters.stockMode = 'all';
  const q = document.getElementById('productsLiveSearch');
  if (q) q.value = '';
  renderProductsDb();
});
document.getElementById('productsExportXlsxBtn')?.addEventListener('click', async () => {
  try {
    await exportProductsDbToExcelDirect();
  } catch (e) {
    alert(e?.message || String(e));
  }
});
document.getElementById('productsExportDeficitBtn')?.addEventListener('click', async () => {
  try {
    await exportProductsDeficitToExcel();
  } catch (e) {
    alert(e?.message || String(e));
  }
});
document.getElementById('productsDownloadTemplateBtn')?.addEventListener('click', () => {
  try {
    downloadProductsImportTemplate();
  } catch (e) {
    alert(e?.message || String(e));
  }
});
document.getElementById('productsImportXlsxInput')?.addEventListener('change', async (e) => {
  const input = e?.target;
  const file = input?.files && input.files[0] ? input.files[0] : null;
  try {
    if (file) await importProductsFromXlsxFile(file);
  } catch (err) {
    alert(err?.message || String(err));
  } finally {
    if (input) input.value = '';
  }
});

// Модалка детализации
document.getElementById('productDetailBackBtn')?.addEventListener('click', closeProductDetail);
document.getElementById('productDetailCloseBtn')?.addEventListener('click', closeProductDetail);
document.getElementById('productDetailModal')?.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'productDetailModal') closeProductDetail();
});
document.querySelectorAll('[data-detail-tab]').forEach(btn => {
  btn.addEventListener('click', () => setDetailTab(btn.getAttribute('data-detail-tab')));
});
document.getElementById('productDetailExportXlsxBtn')?.addEventListener('click', exportDetailXlsx);
document.getElementById('productDetailEditBtn')?.addEventListener('click', () => {
  const rid = currentDetailRecordId || '';
  const product = findProductByRecordId(readProductsSafe(), rid);
  if (!product) return;
  closeProductDetail();
  loadProductIntoCalculator(product, false, { returnToDetailModal: true });
});
document.getElementById('productDetailSaveUzumBarcodeBtn')?.addEventListener('click', saveProductUzumBarcodeFromDetail);

document.getElementById('saveProductChangesBtn')?.addEventListener('click', saveProductChangesFromCalculator);
document.getElementById('cancelCostEditBtn')?.addEventListener('click', () => {
  const editingId = state.productsEdit.recordId;
  if (editingId == null || String(editingId) === '') return;
  const product = findProductByRecordId(readProductsSafe(), editingId);
  if (product) loadProductIntoCalculator(product, true);
  else {
    state.productsEdit.recordId = null;
    state.costEditSession.returnToDetailModal = false;
    resetCostCalculatorForm();
    updateCostSaveToolbar();
    renderProductCost();
  }
});
document.getElementById('productHistoryExportXlsxBtn')?.addEventListener('click', exportProductHistoryXlsx);

document.getElementById('productArticle1c')?.addEventListener('input', () => {
  applySuggestedCategoryIfEmpty();
});
document.getElementById('productArticle1c')?.addEventListener('change', () => {
  applySuggestedCategoryIfEmpty();
});

document.getElementById('componentName')?.addEventListener('input', () => {
  maybeAutofillComponentFieldsByName();
});
document.getElementById('componentName')?.addEventListener('change', () => {
  maybeAutofillComponentFieldsByName();
});

document.getElementById('addComponentBtn')?.addEventListener('click', () => {
  const category = document.getElementById('componentCategory')?.value || 'box';
  const name = (document.getElementById('componentName')?.value || '').trim();
  const deliveryCostTashkent = n(document.getElementById('componentDeliveryCost')?.value);
  const note = (document.getElementById('componentNote')?.value || '').trim();
  if (!name) {
    alert('Введи название позиции.');
    return;
  }
  const arr = readComponentsSafe();
  const entry = {
    id: Date.now(),
    category,
    name,
    deliveryCostTashkent,
    note,
    meta: {},
    createdAt: new Date().toISOString()
  };
  arr.push(entry);
  writeStore(STORAGE_KEYS.components, arr);
  upsertComponentToFirestore(entry);
  document.getElementById('componentName').value = '';
  document.getElementById('componentDeliveryCost').value = '0';
  document.getElementById('componentNote').value = '';
  renderComponentsList();
  updateComponentsAutocomplete();
  if (wmsState.assemblingOpen) renderWmsBoxes();
});

document.getElementById('wmsOpenAssembleBtn')?.addEventListener('click', openWmsAssemble);
document.getElementById('wmsCloseAssembleBtn')?.addEventListener('click', () => void closeWmsAssemble());
document.getElementById('wmsMarketplace')?.addEventListener('change', () => {
  // Uzum-only колонка/подгрузки
  renderWmsBoxes();
  renderWmsLiveTotals();
  renderWmsDraftSummary();
  const hint = document.getElementById('wmsUzumPayoutHint');
  if (hint) {
    hint.textContent = isWmsUzumMarketplaceSelected()
      ? 'Uzum: «К ВЫВОДУ (шт)» подтягивается из Uzum API и фиксируется в истории поставок.'
      : '';
    hint.classList.toggle('hidden', !isWmsUzumMarketplaceSelected());
  }
});
document.getElementById('wmsAddBoxBtn')?.addEventListener('click', () => {
  wmsState.draft.boxes.push({ id: newWmsBoxId(), componentId: '', items: [] });
  renderWmsBoxes();
  renderWmsLiveTotals();
  renderWmsDraftSummary();
});
document.getElementById('wmsSaveDraftBtn')?.addEventListener('click', () => void saveWmsShipmentDraft());
document.getElementById('wmsSendShipmentBtn')?.addEventListener('click', () => void sendWmsShipment());
document.getElementById('shipmentCalcSaveBtn')?.addEventListener('click', saveShipmentCalcFromForm);
document.getElementById('shipmentCalcCancelBtn')?.addEventListener('click', cancelShipmentCalcEdit);
document.getElementById('wmsUnitEconModalCloseBtn')?.addEventListener('click', closeWmsUnitEconModal);
document.getElementById('wmsUnitEconModal')?.addEventListener('click', e => {
  if (e.target && e.target.id === 'wmsUnitEconModal') closeWmsUnitEconModal();
});
document.getElementById('wmsUnitEconModalSheet')?.addEventListener('click', e => e.stopPropagation());
document.getElementById('wmsTruckCost')?.addEventListener('input', renderWmsLiveTotals);
document.getElementById('wmsLoaderCost')?.addEventListener('input', renderWmsLiveTotals);

document.getElementById('wmsProductPickSearch')?.addEventListener('input', e => {
  renderWmsProductPickList(e.target.value);
});
document.getElementById('wmsProductPickCloseBtn')?.addEventListener('click', closeWmsProductPickModal);
document.getElementById('wmsPickConfirmBtn')?.addEventListener('click', () => void confirmWmsPickProduct());
document.getElementById('wmsProductPickModal')?.addEventListener('click', e => {
  if (e.target && e.target.id === 'wmsProductPickModal') closeWmsProductPickModal();
});

renderComponentsList();
renderWmsHistory();
renderWmsDraftSummary();
updateComponentsAutocomplete();

/** Ежемесячные отчёты маркетплейсов (Excel → JSON), вкладка «Аналитика» */
function applyAnalyticsTabMarketplaceLayout() {
  const mp = getCurrentMarketplace();
  document.getElementById('analyticsUzumRoot')?.classList.toggle('hidden', mp !== 'uzum');
  document.getElementById('analyticsWbRoot')?.classList.toggle('hidden', mp !== 'wb');
}

const wbAnalyticsState = {
  parsed: null,
  fileName: '',
  reportTitle: '',
  computed: null,
  currentReportId: null,
  chart: null
};

function readWbAnalyticsReportsHistory() {
  const list = readStore(STORAGE_KEYS.wbAnalyticsReports, []);
  return Array.isArray(list) ? list : [];
}
function writeWbAnalyticsReportsHistory(arr) {
  writeStore(STORAGE_KEYS.wbAnalyticsReports, Array.isArray(arr) ? arr : []);
}

function readWbReportingUzs() {
  const o = readStore(STORAGE_KEYS.wbAnalyticsReportingUzs, {}) || {};
  return {
    withdrawnMonthUz: Math.max(0, Number(o.withdrawnMonthUz) || 0),
    goodsSentUz: Math.max(0, Number(o.goodsSentUz) || 0)
  };
}

function writeWbReportingUzs(data) {
  const cur = readWbReportingUzs();
  writeStore(STORAGE_KEYS.wbAnalyticsReportingUzs, {
    withdrawnMonthUz: Math.max(0, Number(data.withdrawnMonthUz ?? cur.withdrawnMonthUz) || 0),
    goodsSentUz: Math.max(0, Number(data.goodsSentUz ?? cur.goodsSentUz) || 0)
  });
}

function wbReadOpsFromInputs() {
  return {
    withdrawnMonthUz: n(document.getElementById('wbReportWithdrawnMonthUz')?.value),
    goodsSentUz: n(document.getElementById('wbReportGoodsSentUz')?.value)
  };
}

function loadWbReportingUzsIntoInputs() {
  const d = readWbReportingUzs();
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = String(val);
  };
  set('wbReportWithdrawnMonthUz', Math.round(d.withdrawnMonthUz));
  set('wbReportGoodsSentUz', Math.round(d.goodsSentUz));
}

function updateWbReportingUzsDisplay() {
  /* поля в плитках; числовая сводка обновляется в paintWbAnalyticsDashboard */
}

/**
 * Нормализация для нечёткого сравнения заголовков WB: нижний регистр, без пробелов, табов и переносов.
 */
function normalizeString(str) {
  return String(str ?? '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * Числа из WB: строки с пробелами и запятой как десятичным разделителем («1 200,50»).
 */
function parseWBNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const s = String(val)
    .replace(/\u00a0/g, '')
    .replace(/\s/g, '')
    .replace(',', '.');
  const x = parseFloat(s);
  return Number.isFinite(x) ? x : 0;
}

/** Первый индекс колонки в строке шапки, удовлетворяющий предикату по normalizeString(заголовок). */
function wbFindColByHeaderPredicate(headerRowArr, predicate) {
  const row = headerRowArr || [];
  for (let i = 0; i < row.length; i++) {
    const n = normalizeString(row[i]);
    if (n && predicate(n)) return i;
  }
  return -1;
}

/** Настройки аналитики еженедельного отчёта WB (UZ). */
const WB_SETTINGS_DEFAULT = {
  wb_exchange_rate: 168.54789,
  vat_rate: 0.12,
  currency: 'UZS',
  abc_thresholds: [0.8, 0.95]
};

function readWbAnalyticsSettings() {
  const o = readStore(STORAGE_KEYS.wbAnalyticsSettings, {}) || {};
  const rate = Number(o.wb_exchange_rate);
  const vat = Number(o.vat_rate);
  return {
    wb_exchange_rate: Number.isFinite(rate) && rate > 0 ? rate : WB_SETTINGS_DEFAULT.wb_exchange_rate,
    vat_rate: Number.isFinite(vat) && vat >= 0 ? vat : WB_SETTINGS_DEFAULT.vat_rate,
    currency: 'UZS',
    abc_thresholds: WB_SETTINGS_DEFAULT.abc_thresholds
  };
}

function writeWbAnalyticsSettings(patch) {
  const cur = readWbAnalyticsSettings();
  writeStore(STORAGE_KEYS.wbAnalyticsSettings, {
    wb_exchange_rate: Math.max(0.0001, Number(patch.wb_exchange_rate ?? cur.wb_exchange_rate) || cur.wb_exchange_rate),
    vat_rate: Math.max(0, Math.min(1, Number(patch.vat_rate ?? cur.vat_rate) || cur.vat_rate))
  });
}

/** Ключевые фрагменты нормализованных заголовков (детализация WB). */
const WB_REPORT_HEADER_KEYS = {
  docType: 'типдокумента',
  supplierSku: 'артикулпоставщика',
  qty: 'колво',
  priceRetail: 'ценарозничная',
  priceFact: 'вайлдберризреализовалтовар',
  toTransfer: 'кперечислениюпродавцузареализованныйтовар',
  commission: 'вознаграждениевайлдберриз',
  commissionVatOnVv: 'ндссвознаграждения',
  platformDiscountPct: 'платформенныескидки',
  logistics: 'услугиподоставкетоварапокупателю',
  storage: 'хранение',
  deductions: 'удержания',
  saleDate: 'датапродажи',
  fines: 'штраф'
};

/** Денежные суммы в аналитике WB: значения из отчёта и себестоимость уже в сумах (UZS). */
function fmtWbRubLocale(value) {
  const x = Number(value);
  if (!Number.isFinite(x)) return '0 сум';
  return `${x.toLocaleString('ru-RU')} сум`;
}

function fmtWbPctLocale(value) {
  const x = Number(value);
  if (!Number.isFinite(x)) return '0%';
  return `${x.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%`;
}

function wbNormalizeSku(raw) {
  return String(raw ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function wbDisplaySku(raw) {
  return String(raw ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseWbSaleDateCell(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) return val.toISOString().slice(0, 10);
  if (typeof val === 'number' && val > 20000 && typeof XLSX !== 'undefined' && XLSX.SSF?.parse_date_code) {
    const d = XLSX.SSF.parse_date_code(val);
    if (d?.y) {
      return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }
  }
  const s = String(val).trim();
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const ru = s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

function wbDocTypeKind(raw) {
  const n = normalizeString(raw);
  if (!n) return 'service';
  if (n === 'продажа') return 'sale';
  if (n === 'возврат') return 'return';
  return 'other';
}

let wbProductCostLookupCache = null;
function buildWbProductCostLookup() {
  if (wbProductCostLookupCache) return wbProductCostLookupCache;
  const map = new Map();
  readProductsSafe().forEach(p => {
    const cost = Number(p.costGross ?? p.costPriceUzs ?? 0);
    if (!Number.isFinite(cost) || cost <= 0) return;
    [p.article1c, p.sku, p.wbSku]
      .map(k => wbNormalizeSku(k))
      .filter(Boolean)
      .forEach(k => {
        if (!map.has(k)) map.set(k, cost);
      });
  });
  wbProductCostLookupCache = map;
  return map;
}

function invalidateWbProductCostLookup() {
  wbProductCostLookupCache = null;
}

function findWbProductNameBySkuKey(skuKey) {
  const key = wbNormalizeSku(skuKey);
  if (!key) return '';
  const hit = readProductsSafe().find(p => {
    return [p.article1c, p.sku, p.wbSku].some(v => wbNormalizeSku(v) === key);
  });
  if (!hit) return '';
  return String(hit.name || hit.article1c || '').trim();
}

function wbReportSkuRows(parsed) {
  return (parsed.skuKeys || [])
    .map(k => parsed.bySku[k])
    .filter(r => r && (r.sales_qty > 0 || r.revenue_fact > 0 || r.payout_sales > 0));
}

/** Себестоимость ед.: ручной ввод или join lower(trim) артикула отчёта ↔ sku в БД. */
function resolveWbUnitCost(skuKey, displaySku, costOverrides = {}) {
  const manual = n(costOverrides[displaySku] ?? costOverrides[skuKey]);
  if (manual > 0) return manual;
  const fromDb = getWbCostSumFromProductsDb(displaySku || skuKey);
  return fromDb != null && fromDb > 0 ? fromDb : null;
}

function findMissingWbCogsSkus(parsed, costOverrides = {}) {
  const missing = [];
  wbReportSkuRows(parsed).forEach(row => {
    const cost = resolveWbUnitCost(row.skuKey, row.displaySku, costOverrides);
    if (cost == null || !(cost > 0)) missing.push(row.displaySku || row.skuKey);
  });
  return [...new Set(missing)].sort((a, b) => a.localeCompare(b, 'ru'));
}

function formatWbMissingCogsMessage(missing) {
  const count = missing.length;
  if (!count) return '';
  return `Не найдена себестоимость для ${count} артикулов: ${missing.join(', ')}`;
}

function updateWbCogsValidationUi(parsed, costOverrides) {
  const missing = findMissingWbCogsSkus(parsed, costOverrides);
  const errEl = document.getElementById('wbAnalyticsCogsError');
  const btn = document.getElementById('wbAnalyticsCalcBtn');
  if (errEl) {
    if (missing.length) {
      errEl.classList.remove('hidden');
      errEl.textContent = formatWbMissingCogsMessage(missing);
    } else {
      errEl.classList.add('hidden');
      errEl.textContent = '';
    }
  }
  if (btn) {
    btn.disabled = missing.length > 0;
    btn.title = missing.length > 0 ? 'Заполните себестоимость по всем артикулам' : '';
  }
  document.querySelectorAll('#wbAnalyticsCogsTableBody tr[data-wb-art]').forEach(tr => {
    const art = tr.getAttribute('data-wb-art') || '';
    const inp = tr.querySelector('[data-wb-cogs-input]');
    if (inp) inp.classList.toggle('wb-cogs-input--missing', missing.includes(art));
  });
}

function normalizeHeaderKey(str) {
  return normalizeString(str).replace(/[-‑–—.,:;]/g, '');
}


function wbFindQtyColumn(headerCells) {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < headerCells.length; i++) {
    const raw = String(headerCells[i] ?? '').trim();
    if (!raw) continue;
    const n = normalizeHeaderKey(raw);
    let score = 0;
    if (n === 'колво') score = 100;
    else if (n === 'количество') score = 95;
    else if (n.startsWith('колво') && n.length <= 8) score = 90;
    else if (n.includes('колво') && !n.includes('возврат')) score = 80;
    else if (n.includes('количество') && !n.includes('возврат')) score = 70;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Если «Кол-во» пустое, в детализации WB обычно 1 строка = 1 единица. */
function wbEffectiveRowQty(kind, rawQty, priceFact, toTransfer, priceRetail) {
  const q = Math.abs(parseWBNumber(rawQty));
  if (q > 0) return q;
  if (kind !== 'sale' && kind !== 'return') return 0;
  if (
    Math.abs(priceFact) > 0.0001 ||
    Math.abs(toTransfer) > 0.0001 ||
    Math.abs(priceRetail) > 0.0001
  ) {
    return 1;
  }
  return 0;
}

function wbFindArticleColumn(headerRowArr) {
  let idx = wbFindColByHeaderPredicate(headerRowArr, n => n.includes('артикулпоставщика'));
  if (idx >= 0) return { idx, label: 'Артикул поставщика' };
  idx = wbFindColByHeaderPredicate(headerRowArr, n => n.includes('артикулпродавца'));
  if (idx >= 0) return { idx, label: 'Артикул продавца' };
  idx = wbFindColByHeaderPredicate(headerRowArr, n => n.includes('артикул1с'));
  if (idx >= 0) return { idx, label: 'Артикул 1С' };
  return { idx: -1, label: '' };
}

function findWbReportHeaderRowIndex(matrix, maxScan = 15) {
  const markers = [
    WB_REPORT_HEADER_KEYS.priceFact,
    WB_REPORT_HEADER_KEYS.toTransfer,
    WB_REPORT_HEADER_KEYS.docType
  ];
  const lim = Math.min(matrix.length, maxScan);
  for (let r = 0; r < lim; r++) {
    const row = matrix[r] || [];
    for (let c = 0; c < row.length; c++) {
      const n = normalizeString(row[c]);
      if (markers.some(m => n.includes(m))) return r;
    }
  }
  return -1;
}

function findWbReportHeaderAndColumns(matrix, maxScan = 15) {
  const headerRow = findWbReportHeaderRowIndex(matrix, maxScan);
  if (headerRow < 0) {
    throw new Error(
      `В первых ${maxScan} строках не найдена шапка. Нужны столбцы «Вайлдберриз реализовал Товар», «К перечислению…» или «Тип документа».`
    );
  }

  const headerCells = matrix[headerRow] || [];
  const priceFact = wbFindColByHeaderPredicate(
    headerCells,
    n => n.includes(WB_REPORT_HEADER_KEYS.priceFact) || (n.includes('вайлдберриз') && n.includes('реализовал'))
  );
  const priceRetail = wbFindColByHeaderPredicate(
    headerCells,
    n => n.includes(WB_REPORT_HEADER_KEYS.priceRetail) && !n.includes('вайлдберриз')
  );
  const toSeller = wbFindColByHeaderPredicate(headerCells, n => n.includes(WB_REPORT_HEADER_KEYS.toTransfer));
  const logistics = wbFindColByHeaderPredicate(headerCells, n => n.includes(WB_REPORT_HEADER_KEYS.logistics));
  const storage = wbFindColByHeaderPredicate(headerCells, n => n === 'хранение' || n.includes('хранение'));
  const deductions = wbFindColByHeaderPredicate(headerCells, n => n.includes(WB_REPORT_HEADER_KEYS.deductions));
  const commissionVv = wbFindColByHeaderPredicate(
    headerCells,
    n => n.includes('вознаграждение') && n.includes('вв') && n.includes('безндс')
  );
  let commissionVvCol = commissionVv;
  if (commissionVvCol < 0) {
    commissionVvCol = wbFindColByHeaderPredicate(
      headerCells,
      n => n.includes('вознаграждение') && n.includes('вв') && !n.includes('ндсс')
    );
  }
  const commissionVatOnVv = wbFindColByHeaderPredicate(
    headerCells,
    n => n.includes('ндс') && n.includes('вознагражден') && !n.includes('безндс')
  );
  const platformDiscountPct = wbFindColByHeaderPredicate(
    headerCells,
    n => n.includes('платформенн') && n.includes('скидк')
  );
  const docType = wbFindColByHeaderPredicate(headerCells, n => n.includes(WB_REPORT_HEADER_KEYS.docType));
  const qty = wbFindQtyColumn(headerCells);
  const saleDate = wbFindColByHeaderPredicate(headerCells, n => n.includes(WB_REPORT_HEADER_KEYS.saleDate));
  const fines = wbFindColByHeaderPredicate(headerCells, n => n.includes(WB_REPORT_HEADER_KEYS.fines));
  const { idx: articleCol, label: articleHeaderUsed } = wbFindArticleColumn(headerCells);

  const col = {
    priceFact,
    priceRetail: priceRetail >= 0 ? priceRetail : -1,
    toSeller,
    logistics,
    storage: storage >= 0 ? storage : -1,
    deductions: deductions >= 0 ? deductions : -1,
    commissionVv: commissionVvCol >= 0 ? commissionVvCol : -1,
    commissionVatOnVv: commissionVatOnVv >= 0 ? commissionVatOnVv : -1,
    platformDiscountPct: platformDiscountPct >= 0 ? platformDiscountPct : -1,
    fines: fines >= 0 ? fines : -1,
    qty: qty >= 0 ? qty : -1,
    saleDate: saleDate >= 0 ? saleDate : -1,
    docType,
    article: articleCol,
    articleHeaderUsed:
      articleHeaderUsed || (articleCol >= 0 ? String(headerCells[articleCol] ?? '').replace(/\s+/g, ' ').trim() : '')
  };

  const missing = [];
  if (col.priceFact < 0) missing.push('«Вайлдберриз реализовал Товар (Пр)»');
  if (col.toSeller < 0) missing.push('«К перечислению Продавцу за реализованный Товар»');
  if (col.docType < 0) missing.push('«Тип документа»');
  if (col.article < 0) missing.push('«Артикул поставщика»');
  if (col.qty < 0) missing.push('«Кол-во»');

  if (missing.length) {
    throw new Error(`Строка заголовков ${headerRow + 1}: не сопоставлены колонки: ${missing.join('; ')}.`);
  }

  return { headerRow, col };
}

function wbWorksheetToMatrix(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
}

function wbCalcSppPct(priceRetail, priceFact, platformPctCell) {
  const fromCol = parseWBNumber(platformPctCell);
  if (Number.isFinite(fromCol) && fromCol > 0) return fromCol;
  if (priceRetail > 0.0001 && priceFact >= 0) {
    return Math.max(0, ((priceRetail - priceFact) / priceRetail) * 100);
  }
  return 0;
}

function touchWbSkuBucket(bySku, skuKey, displaySku) {
  if (!bySku[skuKey]) {
    bySku[skuKey] = {
      skuKey,
      displaySku: displaySku || skuKey,
      sales_qty: 0,
      returns_qty: 0,
      revenue_fact: 0,
      revenue_retail: 0,
      payout_sales: 0,
      payout_returns: 0,
      commission_vv: 0,
      commission_vat_on_vv: 0,
      spp_retail_weight: 0,
      spp_pct_weighted_sum: 0
    };
  } else if (displaySku && !bySku[skuKey].displaySku) {
    bySku[skuKey].displaySku = displaySku;
  }
  return bySku[skuKey];
}

/**
 * Парсинг еженедельного детализированного отчёта WB (.xlsx).
 * Все суммы в файле — в сумах (UZS).
 */
function parseWbReport(arrayBuffer) {
  if (typeof XLSX === 'undefined') throw new Error('Библиотека SheetJS (XLSX) не загружена.');
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  if (!wb.SheetNames?.length) throw new Error('Пустой Excel.');

  let chosen = null;
  for (let si = 0; si < wb.SheetNames.length; si++) {
    const name = wb.SheetNames[si];
    const matrix = wbWorksheetToMatrix(wb.Sheets[name]);
    if (!matrix.length) continue;
    try {
      const { headerRow, col } = findWbReportHeaderAndColumns(matrix, 15);
      chosen = { matrix, sheetName: name, headerRow, col };
      break;
    } catch (e) {
      /* следующий лист */
    }
  }
  if (!chosen) {
    const firstName = wb.SheetNames[0];
    findWbReportHeaderAndColumns(wbWorksheetToMatrix(wb.Sheets[firstName]), 15);
  }

  const { matrix, sheetName, headerRow: hRow, col: C } = chosen;
  const cellAt = (row, i) => (i >= 0 && i < row.length ? parseWBNumber(row[i]) : 0);

  const aggregates = {
    revenue_fact_sum: 0,
    revenue_retail_sum: 0,
    sales_qty: 0,
    returns_qty: 0,
    payout_sum: 0,
    commission_vv_sum: 0,
    commission_vat_on_vv_sum: 0,
    commission_sum: 0,
    logistics_sum: 0,
    storage_sum: 0,
    deductions_sum: 0,
    fines_sum: 0
  };
  const bySku = {};
  const saleDates = [];

  let commissionVvRawSum = 0;
  let commissionVatOnVvRawSum = 0;
  let sppWeightedSum = 0;
  let sppRetailWeight = 0;

  for (let r = hRow + 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row?.length) continue;

    const kind = wbDocTypeKind(row[C.docType]);
    const rawQty = C.qty >= 0 ? row[C.qty] : 0;
    const priceFact = cellAt(row, C.priceFact);
    const priceRetail = C.priceRetail >= 0 ? cellAt(row, C.priceRetail) : 0;
    const toTransfer = cellAt(row, C.toSeller);
    const qty = wbEffectiveRowQty(kind, rawQty, priceFact, toTransfer, priceRetail);
    const logistics = cellAt(row, C.logistics);
    const storage = C.storage >= 0 ? cellAt(row, C.storage) : 0;
    const deductions = C.deductions >= 0 ? cellAt(row, C.deductions) : 0;
    const fines = C.fines >= 0 ? cellAt(row, C.fines) : 0;
    const commissionVv = C.commissionVv >= 0 ? cellAt(row, C.commissionVv) : 0;
    const commissionVatOnVv = C.commissionVatOnVv >= 0 ? cellAt(row, C.commissionVatOnVv) : 0;
    const platformPctCell = C.platformDiscountPct >= 0 ? row[C.platformDiscountPct] : '';

    aggregates.logistics_sum += logistics;
    aggregates.storage_sum += storage;
    aggregates.deductions_sum += deductions;
    aggregates.fines_sum += fines;
    commissionVvRawSum += commissionVv;
    commissionVatOnVvRawSum += commissionVatOnVv;

    if (C.saleDate >= 0) {
      const d = parseWbSaleDateCell(row[C.saleDate]);
      if (d) saleDates.push(d);
    }

    const displaySku = wbDisplaySku(row[C.article]);
    const skuKey = wbNormalizeSku(displaySku);

    if (kind === 'sale') {
      aggregates.revenue_fact_sum += priceFact;
      aggregates.revenue_retail_sum += priceRetail;
      aggregates.sales_qty += qty;
      aggregates.payout_sum += toTransfer;
      if (skuKey) {
        const bucket = touchWbSkuBucket(bySku, skuKey, displaySku);
        bucket.sales_qty += qty;
        bucket.revenue_fact += priceFact;
        bucket.revenue_retail += priceRetail;
        bucket.payout_sales += toTransfer;
        bucket.commission_vv += commissionVv;
        bucket.commission_vat_on_vv += commissionVatOnVv;
        const sppRow = wbCalcSppPct(priceRetail, priceFact, platformPctCell);
        const sppWeight = priceRetail > 0.0001 ? priceRetail : priceFact;
        if (sppWeight > 0.0001) {
          bucket.spp_retail_weight += sppWeight;
          bucket.spp_pct_weighted_sum += sppRow * sppWeight;
          sppRetailWeight += sppWeight;
          sppWeightedSum += sppRow * sppWeight;
        }
      }
    } else if (kind === 'return') {
      aggregates.returns_qty += qty;
      aggregates.payout_sum += toTransfer;
      if (skuKey) {
        const bucket = touchWbSkuBucket(bySku, skuKey, displaySku);
        bucket.returns_qty += qty;
        bucket.payout_returns += toTransfer;
      }
    }
  }

  aggregates.commission_vv_sum = Math.abs(commissionVvRawSum);
  aggregates.commission_vat_on_vv_sum = Math.abs(commissionVatOnVvRawSum);
  aggregates.commission_sum = aggregates.commission_vv_sum + aggregates.commission_vat_on_vv_sum;
  aggregates.spp_pct =
    sppRetailWeight > 0.0001
      ? sppWeightedSum / sppRetailWeight
      : aggregates.revenue_retail_sum > 0.0001
        ? ((aggregates.revenue_retail_sum - aggregates.revenue_fact_sum) / aggregates.revenue_retail_sum) * 100
        : 0;
  aggregates.wb_withheld_pct =
    aggregates.revenue_fact_sum > 0.0001
      ? ((aggregates.revenue_fact_sum - aggregates.payout_sum) / aggregates.revenue_fact_sum) * 100
      : 0;

  const period = { date_from: '', date_to: '' };
  if (saleDates.length) {
    saleDates.sort();
    period.date_from = saleDates[0];
    period.date_to = saleDates[saleDates.length - 1];
  }

  const skuKeys = Object.keys(bySku).sort((a, b) => bySku[a].displaySku.localeCompare(bySku[b].displaySku, 'ru'));

  return {
    formatVersion: 2,
    sheetName,
    headerRow: hRow,
    articleSourceColumn: C.articleHeaderUsed || '',
    colIndices: { ...C },
    period,
    aggregates,
    bySku,
    skuKeys
  };
}

const parseWbWeeklyDetailWorkbook = parseWbReport;
const processWBReport = parseWbReport;

function getWbCostSumFromProductsDb(article) {
  const key = wbNormalizeSku(article);
  if (!key) return null;
  const cost = buildWbProductCostLookup().get(key);
  return cost != null && cost > 0 ? cost : null;
}

/**
 * Join с БД себестоимостей + ручные значения из шага COGS.
 * @param {ReturnType<typeof parseWbReport>} raw
 * @param {Record<string, number>} costOverrides — себестоимость ед. в сумах по displaySku
 */
function enrichWithCosts(raw, costOverrides = {}) {
  const costBySku = {};
  const nameBySku = {};
  const skusWithoutCost = [];
  let totalCogsSum = 0;

  wbReportSkuRows(raw).forEach(row => {
    const key = row.skuKey;
    if (!key) return;
    const display = row.displaySku || key;
    const unitCost = resolveWbUnitCost(key, display, costOverrides);
    nameBySku[key] = findWbProductNameBySkuKey(key) || display;
    if (unitCost == null || !(unitCost > 0)) {
      skusWithoutCost.push(display);
      return;
    }
    costBySku[key] = unitCost;
    totalCogsSum += unitCost * row.sales_qty;
  });

  const uniqueMissing = [...new Set(skusWithoutCost)].sort((a, b) => a.localeCompare(b, 'ru'));
  return {
    costBySku,
    nameBySku,
    totalCogsSum,
    skusWithoutCost: uniqueMissing,
    costsComplete: uniqueMissing.length === 0
  };
}

/**
 * Расчёт сводки и детализации по артикулам (спецификация WB UZ).
 */
function calculateWbReportAnalytics(raw, enriched, settings) {
  if (!enriched.costsComplete) {
    throw new Error(formatWbMissingCogsMessage(enriched.skusWithoutCost));
  }
  const s = { ...WB_SETTINGS_DEFAULT, ...settings };
  const agg = raw.aggregates;
  const rate = s.wb_exchange_rate;
  const vatRate = s.vat_rate;
  const [abcA, abcB] = s.abc_thresholds;

  const payout = agg.payout_sum;
  const vat = payout * vatRate;
  const cogs = enriched.totalCogsSum;
  const netProfit = payout - cogs - vat;
  const revFact = agg.revenue_fact_sum;
  const revRetail = agg.revenue_retail_sum;
  const salesQty = agg.sales_qty;
  const returnsQty = agg.returns_qty;
  const buyoutDenom = salesQty + returnsQty;
  const buyoutRate = buyoutDenom > 0 ? (salesQty / buyoutDenom) * 100 : 0;

  const netMargin = revFact > 0.0001 ? (netProfit / revFact) * 100 : 0;
  const netMarginRetail = revRetail > 0.0001 ? (netProfit / revRetail) * 100 : 0;
  const roiPct = cogs > 0.0001 ? (netProfit / cogs) * 100 : 0;

  const wbCommissionSum = agg.commission_sum;
  const wbCommissionVvSum = agg.commission_vv_sum;
  const wbCommissionVatOnVvSum = agg.commission_vat_on_vv_sum;
  const wbCommissionPct = revFact > 0.0001 ? (wbCommissionSum / revFact) * 100 : 0;
  const wbCommissionVvPct = revFact > 0.0001 ? (wbCommissionVvSum / revFact) * 100 : 0;
  const wbCommissionVatOnVvPct = revFact > 0.0001 ? (wbCommissionVatOnVvSum / revFact) * 100 : 0;
  const sppPct = agg.spp_pct || 0;
  const wbWithheldPct = agg.wb_withheld_pct || 0;

  const costBreakdown =
    revFact > 0.0001
      ? {
          cogs_pct: (cogs / revFact) * 100,
          cogs_sum: cogs,
          commission_pct: wbCommissionPct,
          commission_sum: wbCommissionSum,
          commission_vv_pct: wbCommissionVvPct,
          commission_vv_sum: wbCommissionVvSum,
          commission_vat_on_vv_pct: wbCommissionVatOnVvPct,
          commission_vat_on_vv_sum: wbCommissionVatOnVvSum,
          logistics_pct: (agg.logistics_sum / revFact) * 100,
          logistics_sum: agg.logistics_sum,
          storage_pct: (agg.storage_sum / revFact) * 100,
          storage_sum: agg.storage_sum,
          vat_pct: (vat / revFact) * 100,
          vat_sum: vat,
          profit_pct: netMargin,
          profit_sum: netProfit,
          payout_sum: payout,
          vat_rate_pct: vatRate * 100
        }
      : {
          cogs_pct: 0,
          cogs_sum: 0,
          commission_pct: 0,
          commission_sum: 0,
          commission_vv_pct: 0,
          commission_vv_sum: 0,
          commission_vat_on_vv_pct: 0,
          commission_vat_on_vv_sum: 0,
          logistics_pct: 0,
          logistics_sum: 0,
          storage_pct: 0,
          storage_sum: 0,
          vat_pct: 0,
          vat_sum: 0,
          profit_pct: 0,
          profit_sum: 0,
          payout_sum: payout,
          vat_rate_pct: vatRate * 100
        };

  const logisticsTotal = agg.logistics_sum;
  const storageTotal = agg.storage_sum;

  const bySku = (raw.skuKeys || Object.keys(raw.bySku || {}))
    .map(skuKey => {
      const row = raw.bySku[skuKey];
      if (!row) return null;
      const unitCost = enriched.costBySku[skuKey];
      if (!(unitCost > 0)) return null;
      const payoutSku = row.payout_sales + row.payout_returns;
      const cogsSku = unitCost * row.sales_qty;
      const vatSku = payoutSku * vatRate;
      const profitSku = payoutSku - cogsSku - vatSku;
      const revSku = row.revenue_fact;
      const marginSku = revSku > 0.0001 ? (profitSku / revSku) * 100 : 0;
      const buyoutSku =
        row.sales_qty + row.returns_qty > 0 ? (row.sales_qty / (row.sales_qty + row.returns_qty)) * 100 : 0;
      const logisticsAlloc = revFact > 0.0001 ? logisticsTotal * (revSku / revFact) : 0;
      const storageAlloc = revFact > 0.0001 ? storageTotal * (revSku / revFact) : 0;
      const vvSku = Math.abs(row.commission_vv || 0);
      const vatVvSku = Math.abs(row.commission_vat_on_vv || 0);
      const wbCommSku = vvSku + vatVvSku;
      const wbCommPct = revSku > 0.0001 ? (wbCommSku / revSku) * 100 : 0;
      const sppSku =
        row.spp_retail_weight > 0.0001
          ? row.spp_pct_weighted_sum / row.spp_retail_weight
          : row.revenue_retail > 0.0001
            ? ((row.revenue_retail - revSku) / row.revenue_retail) * 100
            : 0;
      return {
        sku: row.displaySku || skuKey,
        skuKey,
        name: enriched.nameBySku[skuKey] || row.displaySku || skuKey,
        sales_qty: row.sales_qty,
        returns_qty: row.returns_qty,
        buyout_rate: buyoutSku,
        revenue_sum: revSku,
        payout_sum: payoutSku,
        cogs_sum: cogsSku,
        logistics_alloc: logisticsAlloc,
        storage_alloc: storageAlloc,
        net_profit_sum: profitSku,
        net_margin_pct: marginSku,
        spp_pct: sppSku,
        wb_commission_sum: wbCommSku,
        wb_commission_pct: wbCommPct
      };
    })
    .filter(Boolean)
    .filter(r => r.sales_qty > 0 || r.returns_qty > 0);

  bySku.sort((a, b) => b.net_profit_sum - a.net_profit_sum);

  const positiveProfit = bySku.filter(r => r.net_profit_sum > 0);
  const totalPosProfit = positiveProfit.reduce((sum, r) => sum + r.net_profit_sum, 0);
  let cumulative = 0;
  bySku.forEach(r => {
    if (r.net_profit_sum <= 0) {
      r.abc_class = 'C';
      return;
    }
    const share = totalPosProfit > 0.0001 ? (r.net_profit_sum / totalPosProfit) * 100 : 0;
    cumulative += share;
    if (cumulative <= abcA * 100) r.abc_class = 'A';
    else if (cumulative <= abcB * 100) r.abc_class = 'B';
    else r.abc_class = 'C';
  });

  return {
    period: raw.period,
    summary: {
      sales_qty: salesQty,
      returns_qty: returnsQty,
      buyout_rate: buyoutRate,
      revenue_retail_sum: revRetail,
      revenue_fact_sum: revFact,
      revenue_fact_rub: rate > 0 ? revFact / rate : 0,
      wb_commission_sum: wbCommissionSum,
      wb_commission_vv_sum: wbCommissionVvSum,
      wb_commission_vat_on_vv_sum: wbCommissionVatOnVvSum,
      wb_commission_pct: wbCommissionPct,
      wb_commission_vv_pct: wbCommissionVvPct,
      wb_commission_vat_on_vv_pct: wbCommissionVatOnVvPct,
      spp_pct: sppPct,
      wb_withheld_pct: wbWithheldPct,
      wb_logistics_sum: agg.logistics_sum,
      wb_storage_sum: agg.storage_sum,
      wb_deductions_sum: agg.deductions_sum,
      wb_fines_sum: agg.fines_sum,
      cogs_sum: cogs,
      vat_sum: vat,
      payout_sum: payout,
      net_profit_sum: netProfit,
      net_profit_rub: rate > 0 ? netProfit / rate : 0,
      net_margin_pct: netMargin,
      net_margin_retail_pct: netMarginRetail,
      roi_pct: roiPct,
      cost_breakdown: costBreakdown,
      skus_without_cost: enriched.skusWithoutCost
    },
    by_sku: bySku
  };
}

function buildWbAnalyticsFromParsed(parsed, cogsMap, settings) {
  const enriched = enrichWithCosts(parsed, cogsMap);
  if (!enriched.costsComplete) {
    return {
      enriched,
      costsComplete: false,
      missingSkus: enriched.skusWithoutCost,
      cogsByArticle: cogsMap,
      settings: settings || readWbAnalyticsSettings()
    };
  }
  const analytics = calculateWbReportAnalytics(parsed, enriched, settings || readWbAnalyticsSettings());
  return {
    analytics,
    enriched,
    costsComplete: true,
    cogsByArticle: cogsMap,
    settings: settings || readWbAnalyticsSettings()
  };
}

function isLegacyWbParsed(parsed) {
  return parsed && !parsed.formatVersion && (parsed.sumSalesBase != null || parsed.articleQty != null);
}

function resetWbAnalyticsUi() {
  destroyWbAnalyticsChart();
  wbAnalyticsState.parsed = null;
  wbAnalyticsState.computed = null;
  wbAnalyticsState.fileName = '';
  wbAnalyticsState.reportTitle = '';
  wbAnalyticsState.currentReportId = null;
  document.getElementById('wbAnalyticsPlaceholder')?.classList.remove('hidden');
  document.getElementById('wbAnalyticsCogsPanel')?.classList.add('hidden');
  document.getElementById('wbAnalyticsResultsPanel')?.classList.add('hidden');
  const cogsErr = document.getElementById('wbAnalyticsCogsError');
  if (cogsErr) {
    cogsErr.classList.add('hidden');
    cogsErr.textContent = '';
  }
  const calcBtn = document.getElementById('wbAnalyticsCalcBtn');
  if (calcBtn) calcBtn.disabled = false;
}

function showWbCogsStep(parsed, metaText, title) {
  wbAnalyticsState.parsed = parsed;
  wbAnalyticsState.computed = null;
  wbAnalyticsState.reportTitle = title;
  const meta = document.getElementById('wbAnalyticsParseMeta');
  if (meta) meta.textContent = metaText;
  document.getElementById('wbAnalyticsPlaceholder')?.classList.add('hidden');
  document.getElementById('wbAnalyticsCogsPanel')?.classList.remove('hidden');
  document.getElementById('wbAnalyticsResultsPanel')?.classList.add('hidden');

  const arts = (parsed.skuKeys || [])
    .map(k => parsed.bySku[k])
    .filter(r => r && (r.sales_qty > 0 || r.revenue_fact > 0 || r.payout_sales > 0))
    .sort((a, b) => a.displaySku.localeCompare(b.displaySku, 'ru'));
  const tb = document.getElementById('wbAnalyticsCogsTableBody');
  if (!tb) return;
  tb.innerHTML = arts.length
    ? arts
        .map(row => {
          const art = row.displaySku;
          const esc = escapeHtml(art);
          const qty = row.sales_qty;
          const sumDb = getWbCostSumFromProductsDb(art);
          const hasDb = sumDb != null;
          const val = hasDb ? String(Math.round(sumDb * 100) / 100) : '';
          const cls = hasDb ? 'input wb-cogs-input' : 'input wb-cogs-input wb-cogs-input--missing';
          return `<tr data-wb-art="${escapeAttr(art)}"><td class="wb-cogs-article">${esc}</td><td>${fmtAnalyticsInt(qty)}</td><td><input type="number" class="${cls}" min="0" step="0.01" data-wb-cogs-input value="${val}" placeholder="Себестоимость ед. (сум)" aria-label="Себестоимость ед. (сум), ${esc}" /></td></tr>`;
        })
        .join('')
    : '<tr><td colspan="3" class="muted">Нет строк продаж с артикулами.</td></tr>';
  updateWbCogsValidationUi(parsed, collectWbCogsInputs());
}

function collectWbCogsInputs() {
  const map = {};
  document.querySelectorAll('#wbAnalyticsCogsTableBody tr[data-wb-art]').forEach(tr => {
    const art = tr.getAttribute('data-wb-art') || '';
    const inp = tr.querySelector('[data-wb-cogs-input]');
    map[art] = Math.max(0, n(inp?.value));
  });
  return map;
}

function destroyWbAnalyticsChart() {
  if (wbAnalyticsState.chart) {
    try {
      wbAnalyticsState.chart.destroy();
    } catch (e) {
      /* ignore */
    }
    wbAnalyticsState.chart = null;
  }
}

function loadWbAnalyticsSettingsIntoInputs() {
  const s = readWbAnalyticsSettings();
  const rateEl = document.getElementById('wbAnalyticsExchangeRate');
  if (rateEl) rateEl.value = String(s.wb_exchange_rate);
  const vatEl = document.getElementById('wbAnalyticsVatPct');
  if (vatEl) vatEl.value = String(Math.round(s.vat_rate * 10000) / 100);
}

function readWbAnalyticsSettingsFromInputs() {
  const rate = n(document.getElementById('wbAnalyticsExchangeRate')?.value);
  const vatPct = n(document.getElementById('wbAnalyticsVatPct')?.value);
  const cur = readWbAnalyticsSettings();
  return {
    wb_exchange_rate: rate > 0 ? rate : cur.wb_exchange_rate,
    vat_rate: vatPct >= 0 ? vatPct / 100 : cur.vat_rate,
    currency: 'UZS',
    abc_thresholds: WB_SETTINGS_DEFAULT.abc_thresholds
  };
}

function wbRefreshChartAfterTheme() {
  if (!wbAnalyticsState.computed?.analytics || !wbAnalyticsState.parsed) return;
  const panel = document.getElementById('wbAnalyticsResultsPanel');
  if (!panel || panel.classList.contains('hidden')) return;
  renderWbTopProfitChart(wbAnalyticsState.computed.analytics.by_sku || []);
}

function renderWbTopProfitChart(abcRows) {
  destroyWbAnalyticsChart();
  const canvas = document.getElementById('wbTopProfitChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const top = (abcRows || []).slice(0, 25);
  const rev = [...top].reverse();
  const labels = rev.map(r => {
    const a = String(r.sku || r.name || '');
    return a.length > 30 ? `${a.slice(0, 28)}…` : a;
  });
  const data = rev.map(r => Math.round((r.net_profit_sum || 0) * 100) / 100);
  const dark = document.body.classList.contains('dark-mode');
  const tick = dark ? '#94a3b8' : '#475569';
  const grid = dark ? '#334155' : '#e2e8f0';
  wbAnalyticsState.chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'ТОП по прибыли, сум',
          data,
          backgroundColor: dark ? 'rgba(167, 139, 250, 0.72)' : 'rgba(109, 40, 217, 0.5)',
          borderRadius: 6
        }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              return fmtWbRubLocale(ctx.parsed.x);
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: tick, font: { size: 11 } },
          grid: { color: grid }
        },
        y: {
          ticks: { color: tick, font: { size: 10 } },
          grid: { display: false }
        }
      }
    }
  });
}

function paintWbAnalyticsDashboard(computed, parsed) {
  let bundle = computed;
  if (!bundle?.analytics) {
    if (isLegacyWbParsed(parsed)) {
      alert('Этот отчёт сохранён в старом формате. Загрузите файл .xlsx заново.');
      return;
    }
    const cogsMap = computed?.cogsByArticle || computed?.cogsByArticleRub || {};
    bundle = buildWbAnalyticsFromParsed(parsed, cogsMap, readWbAnalyticsSettingsFromInputs());
    wbAnalyticsState.computed = bundle;
  }

  const { analytics } = bundle;
  if (!analytics) return;
  const s = analytics.summary;
  const bd = s.cost_breakdown || {};

  const setTxt = (id, t) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t;
  };

  const periodEl = document.getElementById('wbAnalyticsPeriod');
  if (periodEl) {
    const p = analytics.period || {};
    periodEl.textContent =
      p.date_from && p.date_to ? `Период: ${fmtDate(p.date_from)} — ${fmtDate(p.date_to)}` : 'Период: не определён';
  }

  setTxt('wbStatRevenueFact', fmtWbRubLocale(s.revenue_fact_sum));
  setTxt('wbStatRevenueRetail', fmtWbRubLocale(s.revenue_retail_sum));
  setTxt('wbStatSalesQty', fmtAnalyticsInt(s.sales_qty));
  setTxt('wbStatReturnsQty', fmtAnalyticsInt(s.returns_qty));
  setTxt('wbStatBuyout', fmtWbPctLocale(s.buyout_rate));
  setTxt('wbStatToTransfer', fmtWbRubLocale(s.payout_sum));
  setTxt('wbStatNet', fmtWbRubLocale(s.net_profit_sum));
  const netHero = document.getElementById('wbStatNet');
  if (netHero) netHero.style.color = s.net_profit_sum < 0 ? 'var(--bad)' : '';
  setTxt('wbStatNetRub', `${(s.net_profit_rub || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`);
  setTxt('wbStatRoi', fmtWbPctLocale(s.roi_pct));
  setTxt('wbStatMargin', fmtWbPctLocale(s.net_margin_pct));
  setTxt('wbStatMarginRetail', fmtWbPctLocale(s.net_margin_retail_pct));

  setTxt('wbStatComm', fmtWbRubLocale(s.wb_commission_sum));
  setTxt('wbStatSppPct', fmtWbPctLocale(s.spp_pct));
  setTxt('wbStatCommVv', fmtWbRubLocale(s.wb_commission_vv_sum));
  setTxt('wbStatCommVvPct', `${fmtWbPctLocale(s.wb_commission_vv_pct)} от факт. выручки`);
  setTxt('wbStatCommVatVv', fmtWbRubLocale(s.wb_commission_vat_on_vv_sum));
  setTxt('wbStatCommVatVvPct', `${fmtWbPctLocale(s.wb_commission_vat_on_vv_pct)} от факт. выручки`);
  setTxt('wbStatCommTotal', fmtWbRubLocale(s.wb_commission_sum));
  setTxt('wbStatCommTotalPct', `${fmtWbPctLocale(s.wb_commission_pct)} от факт. выручки`);
  setTxt('wbStatWithheldPct', fmtWbPctLocale(s.wb_withheld_pct));
  const sppHint = document.getElementById('wbStatSppHint');
  if (sppHint) {
    sppHint.textContent =
      'Скидка, которую Wildberries сделал покупателю из своего бюджета. Вы её не платите — WB платит сам.';
  }
  const commBdHint = document.getElementById('wbStatBdCommHint');
  if (commBdHint) {
    const vv = s.wb_commission_vv_sum || 0;
    const vvat = s.wb_commission_vat_on_vv_sum || 0;
    commBdHint.innerHTML = `<span class="wb-breakdown-info-icon" aria-hidden="true">ℹ️</span> Реальное вознаграждение WB: ВВ ${escapeHtml(vv.toLocaleString('ru-RU'))} сум + НДС с ВВ ${escapeHtml(vvat.toLocaleString('ru-RU'))} сум. Уже вычтено в «К перечислению» — повторно не вычитается.`;
  }
  setTxt('wbStatLog', fmtWbRubLocale(s.wb_logistics_sum));
  setTxt('wbStatStorage', fmtWbRubLocale(s.wb_storage_sum));
  setTxt('wbStatDeductions', fmtWbRubLocale(s.wb_deductions_sum));
  setTxt('wbStatPen', fmtWbRubLocale(s.wb_fines_sum));
  setTxt('wbStatVat', fmtWbRubLocale(s.vat_sum));
  setTxt('wbStatCogs', fmtWbRubLocale(s.cogs_sum));

  setTxt('wbStatBdCogs', `(${fmtWbPctLocale(bd.cogs_pct)})`);
  setTxt('wbStatBdComm', `(${fmtWbPctLocale(bd.commission_pct)})`);
  setTxt('wbStatBdLog', `(${fmtWbPctLocale(bd.logistics_pct)})`);
  setTxt('wbStatBdStorage', `(${fmtWbPctLocale(bd.storage_pct)})`);
  setTxt('wbStatBdVat', `(${fmtWbPctLocale(bd.vat_pct)})`);
  setTxt('wbStatBdProfit', `(${fmtWbPctLocale(bd.profit_pct)})`);
  setTxt('wbStatBdCogsSum', fmtWbRubLocale(bd.cogs_sum ?? s.cogs_sum));
  setTxt('wbStatBdCommSum', fmtWbRubLocale(bd.commission_sum ?? s.wb_commission_sum));
  setTxt('wbStatBdLogSum', fmtWbRubLocale(bd.logistics_sum ?? s.wb_logistics_sum));
  setTxt('wbStatBdStorageSum', fmtWbRubLocale(bd.storage_sum ?? s.wb_storage_sum));
  setTxt('wbStatBdVatSum', fmtWbRubLocale(bd.vat_sum ?? s.vat_sum));
  setTxt('wbStatBdProfitSum', fmtWbRubLocale(bd.profit_sum ?? s.net_profit_sum));
  const vatRatePct = bd.vat_rate_pct ?? (bundle.settings?.vat_rate ?? 0.12) * 100;
  setTxt('wbStatBdVatLabel', `${Math.round(vatRatePct * 100) / 100}%`);
  const vatHint = document.getElementById('wbStatBdVatHint');
  if (vatHint) {
    const payoutForVat = bd.payout_sum ?? s.payout_sum ?? 0;
    const rateLabel = Math.round(vatRatePct * 100) / 100;
    vatHint.innerHTML = `<span class="wb-breakdown-info-icon" aria-hidden="true">ℹ️</span> Налог на добавленную стоимость Узбекистана.<br>Считается от суммы к перечислению: ${escapeHtml(payoutForVat.toLocaleString('ru-RU'))} × ${escapeHtml(String(rateLabel))}%`;
  }

  const warnEl = document.getElementById('wbAnalyticsCostWarnings');
  if (warnEl) {
    warnEl.classList.add('hidden');
    warnEl.textContent = '';
  }

  const topRows = analytics.by_sku || [];
  const topBody = document.getElementById('wbTopProductsBody');
  if (topBody) {
    topBody.innerHTML = topRows.length
      ? topRows
          .map(r => {
            const gcls =
              r.abc_class === 'A' ? 'wb-abc-a' : r.abc_class === 'B' ? 'wb-abc-b' : 'wb-abc-c';
            return `<tr>
              <td class="wb-cogs-article">${escapeHtml(r.sku)}<div class="analytics-abc-sku-inline">${escapeHtml(r.name || '')}</div></td>
              <td>${fmtAnalyticsInt(r.sales_qty)}</td>
              <td>${fmtAnalyticsInt(r.returns_qty)}</td>
              <td>${escapeHtml(fmtWbPctLocale(r.buyout_rate))}</td>
              <td>${escapeHtml(fmtWbRubLocale(r.revenue_sum))}</td>
              <td>${escapeHtml(fmtWbPctLocale(r.spp_pct))}</td>
              <td>${escapeHtml(fmtWbPctLocale(r.wb_commission_pct))}</td>
              <td>${escapeHtml(fmtWbRubLocale(r.payout_sum))}</td>
              <td>${escapeHtml(fmtWbRubLocale(r.cogs_sum))}</td>
              <td class="wb-net-cell">${escapeHtml(fmtWbRubLocale(r.net_profit_sum))}</td>
              <td>${escapeHtml(fmtWbPctLocale(r.net_margin_pct))}</td>
              <td><span class="wb-abc-badge ${gcls}">${escapeHtml(r.abc_class)}</span></td>
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="12" class="muted">Нет данных по артикулам.</td></tr>';
  }
  renderWbTopProfitChart(topRows);

  const list = document.getElementById('wbAnalyticsDetailList');
  if (list) {
    const settings = bundle.settings || readWbAnalyticsSettings();
    const rows = [
      ['Выручка фактическая (после СПП), сум', fmtWbRubLocale(s.revenue_fact_sum)],
      ['Выручка розничная (до СПП), сум', fmtWbRubLocale(s.revenue_retail_sum)],
      ['К перечислению (продажи + возвраты), сум', fmtWbRubLocale(s.payout_sum)],
      ['СПП (скидка платформы), %', fmtWbPctLocale(s.spp_pct)],
      ['Комиссия WB (ВВ без НДС), сум', fmtWbRubLocale(s.wb_commission_vv_sum)],
      ['НДС с ВВ, сум', fmtWbRubLocale(s.wb_commission_vat_on_vv_sum)],
      ['Итого комиссия WB, сум', fmtWbRubLocale(s.wb_commission_sum)],
      ['Комиссия WB, % от факт. выручки', fmtWbPctLocale(s.wb_commission_pct)],
      ['Удержано WB (справочно), %', fmtWbPctLocale(s.wb_withheld_pct)],
      ['Логистика, сум', fmtWbRubLocale(s.wb_logistics_sum)],
      ['Хранение, сум', fmtWbRubLocale(s.wb_storage_sum)],
      ['Удержания, сум', fmtWbRubLocale(s.wb_deductions_sum)],
      ['Штрафы, сум', fmtWbRubLocale(s.wb_fines_sum)],
      ['Себестоимость проданного, сум', fmtWbRubLocale(s.cogs_sum)],
      [`НДС ${Math.round(settings.vat_rate * 100)}% от к перечислению, сум`, fmtWbRubLocale(s.vat_sum)],
      ['Чистая прибыль = к перечислению − COGS − НДС, сум', fmtWbRubLocale(s.net_profit_sum)],
      ['Маржа от факт. выручки, %', fmtWbPctLocale(s.net_margin_pct)],
      ['Маржа от розничной цены, %', fmtWbPctLocale(s.net_margin_retail_pct)],
      ['Рентабельность (прибыль / себест.), %', fmtWbPctLocale(s.roi_pct)],
      ['Курс WB (сум за 1 ₽)', String(settings.wb_exchange_rate)]
    ];
    list.innerHTML = rows
      .map(([k, v]) => `<div class="row"><div class="key">${escapeHtml(k)}</div><div class="val">${escapeHtml(v)}</div></div>`)
      .join('');
  }
}

function renderWbAnalyticsReportsList() {
  const ul = document.getElementById('wbAnalyticsReportsList');
  const empty = document.getElementById('wbAnalyticsReportsEmpty');
  if (!ul) return;
  const list = readWbAnalyticsReportsHistory();
  ul.innerHTML = '';
  if (!list.length) {
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');
  list.forEach(rep => {
    if (!rep || !rep.id) return;
    const li = document.createElement('li');
    li.className = 'analytics-report-item';
    const title = document.createElement('div');
    title.className = 'analytics-report-item-title';
    title.textContent = rep.title || 'Отчёт WB';
    const meta = document.createElement('div');
    meta.className = 'analytics-report-item-meta';
    meta.textContent = fmtDateTime(rep.savedAt);
    const actions = document.createElement('div');
    actions.className = 'analytics-report-actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn-secondary';
    openBtn.textContent = 'Открыть';
    openBtn.addEventListener('click', () => openWbAnalyticsReportById(rep.id));
    actions.append(openBtn);
    li.append(title, meta, actions);
    ul.appendChild(li);
  });
}

function openWbAnalyticsReportById(id) {
  const rep = readWbAnalyticsReportsHistory().find(r => r && String(r.id) === String(id));
  if (!rep || !rep.parsed) return;
  if (isLegacyWbParsed(rep.parsed)) {
    alert('Отчёт в старом формате. Загрузите файл .xlsx заново для пересчёта по новой спецификации.');
    return;
  }
  wbAnalyticsState.parsed = rep.parsed;
  wbAnalyticsState.computed = rep.computed || null;
  wbAnalyticsState.fileName = rep.fileName || '';
  wbAnalyticsState.reportTitle = rep.title || 'Отчёт WB';
  wbAnalyticsState.currentReportId = rep.id;
  loadWbAnalyticsSettingsIntoInputs();
  loadWbReportingUzsIntoInputs();
  if (rep.settings) writeWbAnalyticsSettings(rep.settings);
  document.getElementById('wbAnalyticsReportTitle') &&
    (document.getElementById('wbAnalyticsReportTitle').textContent = wbAnalyticsState.reportTitle);
  document.getElementById('wbAnalyticsReportMeta') &&
    (document.getElementById('wbAnalyticsReportMeta').textContent = `${rep.fileName || ''} · лист «${rep.parsed.sheetName || ''}»`);
  document.getElementById('wbAnalyticsPlaceholder')?.classList.add('hidden');
  if (rep.computed?.analytics) {
    document.getElementById('wbAnalyticsCogsPanel')?.classList.add('hidden');
    document.getElementById('wbAnalyticsResultsPanel')?.classList.remove('hidden');
    paintWbAnalyticsDashboard(rep.computed, rep.parsed);
  } else {
    document.getElementById('wbAnalyticsResultsPanel')?.classList.add('hidden');
    showWbCogsStep(
      rep.parsed,
      'Укажите себестоимость ед. в сумах и нажмите «Показать аналитику».',
      wbAnalyticsState.reportTitle
    );
  }
}

async function handleWbAnalyticsFileSelected(ev) {
  const input = ev.target;
  const file = input.files && input.files[0];
  if (input) input.value = '';
  if (!file) return;
  if (!String(file.name || '').toLowerCase().endsWith('.xlsx')) {
    alert('Нужен файл .xlsx');
    return;
  }
  try {
    invalidateWbProductCostLookup();
    const buf = await file.arrayBuffer();
    const parsed = parseWbReport(buf);
    const title = deriveReportNameFromFileName(file.name);
    const agg = parsed.aggregates;
    const artCol = parsed.articleSourceColumn ? `Колонка артикула: «${parsed.articleSourceColumn}». ` : '';
    const period =
      parsed.period?.date_from && parsed.period?.date_to
        ? `Период ${fmtDate(parsed.period.date_from)} — ${fmtDate(parsed.period.date_to)}. `
        : '';
    const meta = `${period}Лист «${parsed.sheetName}» · ${artCol}шапка: строка ${parsed.headerRow + 1}. Выручка факт.: ${fmtWbRubLocale(agg.revenue_fact_sum)} · к перечислению: ${fmtWbRubLocale(agg.payout_sum)} · продано/возврат шт: ${fmtAnalyticsInt(agg.sales_qty)} / ${fmtAnalyticsInt(agg.returns_qty)}. Артикулов: ${(parsed.skuKeys || []).length}.`;
    wbAnalyticsState.fileName = file.name;
    wbAnalyticsState.currentReportId = null;
    loadWbAnalyticsSettingsIntoInputs();
    showWbCogsStep(parsed, meta, title);
    document.getElementById('wbAnalyticsReportTitle') &&
      (document.getElementById('wbAnalyticsReportTitle').textContent = title);
    document.getElementById('wbAnalyticsReportMeta') &&
      (document.getElementById('wbAnalyticsReportMeta').textContent = file.name);
  } catch (err) {
    console.error(err);
    alert(err && err.message ? err.message : 'Ошибка чтения WB Excel.');
  }
}

function wireWbAnalyticsUiOnce() {
  if (wireWbAnalyticsUiOnce.done) return;
  wireWbAnalyticsUiOnce.done = true;
  loadWbAnalyticsSettingsIntoInputs();
  document.getElementById('wbAnalyticsFileInput')?.addEventListener('change', handleWbAnalyticsFileSelected);
  document.getElementById('wbAnalyticsCancelCogsBtn')?.addEventListener('click', () => {
    resetWbAnalyticsUi();
  });
  document.getElementById('wbAnalyticsCalcBtn')?.addEventListener('click', () => {
    const parsed = wbAnalyticsState.parsed;
    if (!parsed) return;
    const cogsMap = collectWbCogsInputs();
    const missing = findMissingWbCogsSkus(parsed, cogsMap);
    if (missing.length) {
      updateWbCogsValidationUi(parsed, cogsMap);
      alert(formatWbMissingCogsMessage(missing));
      return;
    }
    const settings = readWbAnalyticsSettingsFromInputs();
    writeWbAnalyticsSettings(settings);
    const computed = buildWbAnalyticsFromParsed(parsed, cogsMap, settings);
    if (!computed.costsComplete || !computed.analytics) {
      alert(formatWbMissingCogsMessage(computed.missingSkus || missing));
      return;
    }
    wbAnalyticsState.computed = computed;
    document.getElementById('wbAnalyticsCogsPanel')?.classList.add('hidden');
    document.getElementById('wbAnalyticsResultsPanel')?.classList.remove('hidden');
    paintWbAnalyticsDashboard(wbAnalyticsState.computed, parsed);
  });
  document.getElementById('wbAnalyticsCogsTableBody')?.addEventListener('input', () => {
    const parsed = wbAnalyticsState.parsed;
    if (!parsed) return;
    updateWbCogsValidationUi(parsed, collectWbCogsInputs());
  });
  document.getElementById('wbAnalyticsCogsTableBody')?.addEventListener('change', () => {
    const parsed = wbAnalyticsState.parsed;
    if (!parsed) return;
    updateWbCogsValidationUi(parsed, collectWbCogsInputs());
  });
  document.getElementById('wbAnalyticsNewFileBtn')?.addEventListener('click', () => {
    resetWbAnalyticsUi();
  });
  document.getElementById('wbReportSaveUzsBtn')?.addEventListener('click', () => {
    writeWbReportingUzs(wbReadOpsFromInputs());
    writeWbAnalyticsSettings(readWbAnalyticsSettingsFromInputs());
    alert('Сохранено');
  });
  const wbSettingsRefreshPaint = () => {
    writeWbAnalyticsSettings(readWbAnalyticsSettingsFromInputs());
    if (wbAnalyticsState.computed?.costsComplete && wbAnalyticsState.parsed) {
      const cogsMap =
        wbAnalyticsState.computed.cogsByArticle ||
        wbAnalyticsState.computed.cogsByArticleRub ||
        {};
      const next = buildWbAnalyticsFromParsed(
        wbAnalyticsState.parsed,
        cogsMap,
        readWbAnalyticsSettingsFromInputs()
      );
      if (next.costsComplete && next.analytics) {
        wbAnalyticsState.computed = next;
        paintWbAnalyticsDashboard(wbAnalyticsState.computed, wbAnalyticsState.parsed);
      }
    }
  };
  ['wbAnalyticsExchangeRate', 'wbAnalyticsVatPct'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', wbSettingsRefreshPaint);
    document.getElementById(id)?.addEventListener('change', wbSettingsRefreshPaint);
  });
  document.getElementById('wbAnalyticsSaveReportBtn')?.addEventListener('click', () => {
    const parsed = wbAnalyticsState.parsed;
    const computed = wbAnalyticsState.computed;
    if (!parsed || !computed?.analytics) {
      alert('Сначала откройте аналитику (себестоимость и кнопка «Показать аналитику»).');
      return;
    }
    const settings = readWbAnalyticsSettingsFromInputs();
    writeWbAnalyticsSettings(settings);
    const entry = {
      id: String(Date.now()),
      title: wbAnalyticsState.reportTitle || 'Отчёт WB',
      fileName: wbAnalyticsState.fileName,
      savedAt: new Date().toISOString(),
      parsed,
      computed,
      settings
    };
    const hist = readWbAnalyticsReportsHistory();
    hist.unshift(entry);
    writeWbAnalyticsReportsHistory(hist);
    wbAnalyticsState.currentReportId = entry.id;
    renderWbAnalyticsReportsList();
    alert('Отчёт WB сохранён в историю');
  });
}
wireWbAnalyticsUiOnce.done = false;

const analyticsState = {
  activeReportId: null,
  activeRows: null,
  lastAgg: null
};
/** Имя отчёта (умное по дате в имени файла) для PDF, withdrawn_* и истории */
let currentReportName = '';
/** Снимок текущего отчёта для «Сохранить в историю» и PDF */
let currentReportData = null;

const ANALYTICS_MONTHS_GEN = [
  'Января',
  'Февраля',
  'Марта',
  'Апреля',
  'Мая',
  'Июня',
  'Июля',
  'Августа',
  'Сентября',
  'Октября',
  'Ноября',
  'Декабря'
];

function deriveReportNameFromFileName(fileName) {
  let reportMonthName = 'Новый отчет';
  const m = String(fileName || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) {
    const monthNum = parseInt(m[2], 10);
    if (monthNum >= 1 && monthNum <= 12) {
      reportMonthName = `Отчет за ${ANALYTICS_MONTHS_GEN[monthNum - 1]} ${m[3]}`;
    }
  }
  return reportMonthName;
}

function readReportsHistory() {
  let list = readStore(STORAGE_KEYS.reportsHistory, []);
  if (!Array.isArray(list)) list = [];
  if (!list.length) {
    const legacy = readStore(STORAGE_KEYS.mpReports, []);
    if (Array.isArray(legacy) && legacy.length) {
      list = legacy.map(r => ({
        id: String(r.id || `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`),
        currentReportName: String(r.label || r.fileName || 'Отчёт').trim(),
        rows: Array.isArray(r.rows) ? r.rows : [],
        withdrawn: '',
        savedAt: r.createdAt || new Date().toISOString(),
        sourceFileName: r.fileName || ''
      }));
      try {
        writeStore(STORAGE_KEYS.reportsHistory, list);
      } catch (e) {
        /* ignore */
      }
    }
  }
  return list;
}

function writeReportsHistory(arr) {
  writeStore(STORAGE_KEYS.reportsHistory, Array.isArray(arr) ? arr : []);
}

/** Колонки сгруппированного отчёта Uzum Market (первая строка листа пропускается). */
const UZUM_SALES_COL = {
  name: 'Наименование',
  sku: 'SKU',
  sold: 'Продано (ед.)',
  returns: 'Количество возвратов (ед.)',
  revenue: 'Выручка (сумы)',
  netRevenue: 'Выручка с вычетом комиссии и логистики (сумы)',
  cogs: 'Себестоимость (сумы)'
};

const analyticsIntFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const analyticsPctOneFmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 1 });

function fmtAnalyticsInt(v) {
  return analyticsIntFmt.format(Math.round(Number(v) || 0));
}

function fmtAnalyticsPctOne(v) {
  return `${analyticsPctOneFmt.format(Number(v) || 0)}%`;
}

function nReportCell(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v).replace(/\s/g, '').replace(',', '.');
  const x = parseFloat(s);
  return Number.isFinite(x) ? x : 0;
}

function loadAnalyticsLocalProducts() {
  return readProductsSafe();
}

function findAnalyticsProductBySku(localProducts, skuRaw) {
  const s = String(skuRaw ?? '').trim();
  if (!s || !Array.isArray(localProducts)) return null;
  return localProducts.find(p => {
    if (!p || typeof p !== 'object') return false;
    const a1 = String(p.article_1c ?? p.article1c ?? '').trim();
    const uz = String(p.uzum_sku ?? '').trim();
    const sk = String(p.sku ?? '').trim();
    const wb = String(p.wb_nmid ?? '').trim();
    const ya = String(p.yandex_sku ?? '').trim();
    return a1 === s || uz === s || sk === s || wb === s || ya === s;
  });
}

function computeUzumSalesAggregates(data) {
  let totalSold = 0;
  let totalReturns = 0;
  let totalRevenue = 0;
  let totalNetRevenue = 0;
  let totalCogs = 0;

  const localProducts = loadAnalyticsLocalProducts();
  let totalOutgoingVat = 0;
  let totalUzumVat = 0;
  let totalCogsVat = 0;

  const C = UZUM_SALES_COL;
  const arr = Array.isArray(data) ? data : [];
  arr.forEach(row => {
    if (!row || typeof row !== 'object') return;

    const rowRev = nReportCell(row[C.revenue]);
    const rowNetRev = nReportCell(row[C.netRevenue]);
    const uzumServices = rowRev - rowNetRev;
    const soldQty = nReportCell(row[C.sold]);

    totalSold += nReportCell(row[C.sold]);
    totalReturns += nReportCell(row[C.returns]);
    totalRevenue += rowRev;
    totalNetRevenue += rowNetRev;
    totalCogs += nReportCell(row[C.cogs]);

    totalOutgoingVat += rowRev * 12 / 112;
    totalUzumVat += uzumServices * 12 / 112;

    const dbItem = findAnalyticsProductBySku(localProducts, row[C.sku]);
    const itemIncomingVat =
      dbItem && dbItem.totalIncomingVat != null && Number.isFinite(Number(dbItem.totalIncomingVat))
        ? Number(dbItem.totalIncomingVat)
        : 0;
    totalCogsVat += itemIncomingVat * soldQty;
  });

  const grossProfit = totalNetRevenue - totalCogs;
  const vatToPay = totalOutgoingVat - totalUzumVat - totalCogsVat;
  const cleanProfit = grossProfit - vatToPay;

  const outgoingVat = totalNetRevenue * 12 / 112;
  const incomingVat = totalCogs * 12 / 112;
  const netProfit = (totalNetRevenue - outgoingVat) - (totalCogs - incomingVat);
  const marginPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
  const denom = totalSold + totalReturns;
  const buyoutPct = denom <= 0 ? 100 : (totalSold / denom) * 100;
  return {
    totalSold,
    totalReturns,
    totalRevenue,
    totalNetRevenue,
    totalCogs,
    grossProfit,
    outgoingVat,
    incomingVat,
    netProfit,
    totalOutgoingVat,
    totalUzumVat,
    totalCogsVat,
    vatToPay,
    cleanProfit,
    marginPct,
    buyoutPct
  };
}

function analyticsAbcGroupBadgeHtml(group) {
  const base =
    'padding:4px 10px;border-radius:999px;font-weight:700;font-size:12px;display:inline-block;text-align:center;min-width:28px;';
  const styles = {
    A: `${base}background:#16a34a;color:#fff;`,
    B: `${base}background:#f59e0b;color:#fff;`,
    C: `${base}background:#6b7280;color:#fff;`
  };
  const g = group === 'A' || group === 'B' || group === 'C' ? group : 'C';
  return `<span style="${styles[g]}">${g}</span>`;
}

function updatePdfContentTitle() {
  const el = document.getElementById('pdfContentTitle');
  if (el) el.textContent = currentReportName || 'Финансовый отчёт';
}

function paintAnalyticsMetrics(agg, sentTotal) {
  const setTxt = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  setTxt('dashMetricSoldQty', fmtAnalyticsInt(agg.totalSold));
  setTxt('dashMetricSentWh', fmtAnalyticsInt(sentTotal));
  setTxt('dashMetricRevenue', fmtMoney(agg.totalRevenue));
  setTxt('dashMetricRevenueNet', fmtMoney(agg.totalNetRevenue));
  setTxt('dashMetricCogs', fmtMoney(agg.totalCogs));
  setTxt('dashMetricCleanProfit', fmtMoney(agg.cleanProfit));
  setTxt('dashMetricMarginPct', fmtAnalyticsPctOne(agg.marginPct));
  setTxt('dashMetricBuyoutPct', fmtAnalyticsPctOne(agg.buyoutPct));
}

/** Таблица ABC по уже сгруппированным позициям (только наименование). */
function renderAnalyticsAbcTableGrouped(abcGrouped) {
  const tb = document.getElementById('analyticsAbcBody');
  if (!tb) return;
  if (!abcGrouped.length) {
    tb.innerHTML =
      '<tr class="analytics-abc-empty-row"><td colspan="4">Нет строк с продажами (Продано &gt; 0).</td></tr>';
    return;
  }
  tb.innerHTML = abcGrouped
    .map(r => {
      const nm = escapeHtml(r.name);
      const sold = fmtAnalyticsInt(r.sold);
      const net = escapeHtml(fmtMoney(r.netRevenue));
      const badge = analyticsAbcGroupBadgeHtml(r.group);
      return `<tr><td>${badge}</td><td class="analytics-abc-product">${nm}</td><td>${sold}</td><td>${net}</td></tr>`;
    })
    .join('');
}

/** Сумма штук по всем отправленным поставкам (WMS, live-снимок shipments из Firestore). */
function countSentShipmentsTotalQty() {
  const shipments = readShipmentsSafe();
  let sum = 0;
  shipments.forEach(sh => {
    if (shipmentRecordStatus(sh) !== 'sent') return;
    let flat = [];
    if (sh.version === 2 && Array.isArray(sh.boxes)) {
      sh.boxes.forEach(b => (b.items || []).forEach(it => flat.push(it)));
    } else {
      flat = Array.isArray(sh.items) ? sh.items : [];
    }
    flat.forEach(it => {
      sum += Math.max(0, Math.floor(Number(it.qty ?? it.quantity ?? 0)));
    });
  });
  return sum;
}

/** Агрегация строк отчёта только по наименованию (SKU игнорируются). */
function groupUzumRowsByProductName(data) {
  const C = UZUM_SALES_COL;
  const map = new Map();
  (Array.isArray(data) ? data : []).forEach(row => {
    if (!row || typeof row !== 'object') return;
    const name = String(row[C.name] ?? '').trim() || '—';
    const sold = nReportCell(row[C.sold]);
    const net = nReportCell(row[C.netRevenue]);
    if (!map.has(name)) map.set(name, { name, sold: 0, netRevenue: 0 });
    const g = map.get(name);
    g.sold += sold;
    g.netRevenue += net;
  });
  return Array.from(map.values());
}

/** ABC 80 / 95 / 100 по сгруппированным позициям. */
function buildAbcFromGroupedNameItems(grouped) {
  const withSales = grouped.filter(g => g.sold > 0);
  const list = withSales.length ? withSales : grouped.slice();
  const sorted = [...list].sort((a, b) => b.netRevenue - a.netRevenue);
  const sumAll = sorted.reduce((s, x) => s + x.netRevenue, 0);
  let cumulative = 0;
  return sorted.map(x => {
    cumulative += x.netRevenue;
    const cumPct = sumAll > 0 ? (cumulative / sumAll) * 100 : 100;
    let group = 'C';
    if (sumAll > 0) {
      if (cumPct <= 80) group = 'A';
      else if (cumPct <= 95) group = 'B';
      else group = 'C';
    }
    return { name: x.name, sold: x.sold, netRevenue: x.netRevenue, group };
  });
}

function syncWithdrawnInputForCurrentReport() {
  const input = document.getElementById('withdrawnInput');
  if (!input) return;
  if (!currentReportName) {
    input.value = '';
    return;
  }
  const raw = realtimeState.uiMemory ? realtimeState.uiMemory[`withdrawn_${currentReportName}`] : '';
  input.value = raw != null && raw !== '' ? raw : '';
}

function downloadReportPDF() {
  if (typeof html2pdf === 'undefined') {
    alert('Библиотека PDF не загружена. Проверьте подключение к сети.');
    return;
  }
  const element = document.getElementById('pdfContent');
  if (!element || !analyticsState.activeRows?.length || !currentReportName) {
    alert('Сначала загрузите или откройте отчёт.');
    return;
  }
  updatePdfContentTitle();
  const safe = String(currentReportName).replace(/[/\\?%*:|"<>]/g, '_');
  html2pdf()
    .set({
      margin: 10,
      filename: `${safe}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
    })
    .from(element)
    .save();
}

/** Восстановление дашборда из снимка истории (без пересчёта, если есть agg/abc). */
function applyAnalyticsFromSnapshot(snap) {
  const rows = Array.isArray(snap.rows) ? snap.rows : [];
  if (!rows.length) return;
  const sentTotal =
    snap.sentTotal != null && Number.isFinite(Number(snap.sentTotal))
      ? Number(snap.sentTotal)
      : countSentShipmentsTotalQty();
  const agg =
    snap.agg && typeof snap.agg === 'object' ? snap.agg : computeUzumSalesAggregates(rows);
  let abcGrouped = Array.isArray(snap.abcGrouped) && snap.abcGrouped.length
    ? snap.abcGrouped
    : buildAbcFromGroupedNameItems(groupUzumRowsByProductName(rows));
  analyticsState.activeRows = rows;
  analyticsState.lastAgg = agg;
  currentReportData = { rows, agg, abcGrouped, sentTotal };
  paintAnalyticsMetrics(agg, sentTotal);
  const wi = document.getElementById('withdrawnInput');
  if (wi && snap.withdrawn !== undefined && snap.withdrawn !== null) {
    wi.value = String(snap.withdrawn);
  } else {
    syncWithdrawnInputForCurrentReport();
  }
  renderAnalyticsAbcTableGrouped(abcGrouped);
  updatePdfContentTitle();
}

function applyUzumDashboardFromRows(rows) {
  const data = Array.isArray(rows) ? rows : [];
  if (!data.length) {
    resetAnalyticsDashboardMetrics();
    return;
  }
  const agg = computeUzumSalesAggregates(data);
  const sentTotal = countSentShipmentsTotalQty();
  const grouped = groupUzumRowsByProductName(data);
  const abcGrouped = buildAbcFromGroupedNameItems(grouped);
  analyticsState.activeRows = data;
  analyticsState.lastAgg = agg;
  currentReportData = {
    rows: data,
    agg,
    abcGrouped,
    sentTotal
  };
  paintAnalyticsMetrics(agg, sentTotal);
  syncWithdrawnInputForCurrentReport();
  renderAnalyticsAbcTableGrouped(abcGrouped);
  updatePdfContentTitle();
}

function parseUzumXlsxToJsonRows(arrayBuffer) {
  if (typeof XLSX === 'undefined') {
    throw new Error('Библиотека SheetJS (XLSX) не загружена.');
  }
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { range: 1, defval: 0 });
  return { sheetName, rows };
}

function resetAnalyticsDashboardMetrics() {
  const ids = [
    ['dashMetricSoldQty', '0'],
    ['dashMetricRevenue', '0 сум'],
    ['dashMetricRevenueNet', '0 сум'],
    ['dashMetricCogs', '0 сум'],
    ['dashMetricCleanProfit', '0 сум'],
    ['dashMetricMarginPct', '0%'],
    ['dashMetricBuyoutPct', '0%']
  ];
  ids.forEach(([id, text]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  });
  const wh = document.getElementById('dashMetricSentWh');
  if (wh) wh.textContent = '0';
  const wi = document.getElementById('withdrawnInput');
  if (wi) wi.value = '';
  analyticsState.activeRows = null;
  analyticsState.lastAgg = null;
  const abc = document.getElementById('analyticsAbcBody');
  if (abc) {
    abc.innerHTML = '<tr class="analytics-abc-empty-row"><td colspan="4">Нет данных — загрузите отчёт Uzum.</td></tr>';
  }
  document.getElementById('analyticsReportActions')?.classList.add('hidden');
  const pdfTitle = document.getElementById('pdfContentTitle');
  if (pdfTitle) pdfTitle.textContent = 'Финансовый отчёт';
  currentReportData = null;
}

function showAnalyticsDashboardShell(visible, report) {
  const ph = document.getElementById('analyticsDashboardPlaceholder');
  const dash = document.getElementById('analyticsDashboard');
  const titleEl = document.getElementById('analyticsReportTitle');
  const metaEl = document.getElementById('analyticsReportMeta');
  const actions = document.getElementById('analyticsReportActions');
  if (!ph || !dash) return;
  if (visible && report) {
    ph.classList.add('hidden');
    dash.classList.remove('hidden');
    actions?.classList.remove('hidden');

    currentReportName = String(
      report.currentReportName ||
        report.label ||
        report.fileName ||
        (report.id ? `report_${report.id}` : '')
    ).trim() || 'Новый отчет';

    if (titleEl) titleEl.textContent = currentReportName;
    updatePdfContentTitle();

    const rowCount = Array.isArray(report.rows) ? report.rows.length : 0;
    const src = report.sourceFileName || report.fileName;
    if (metaEl) {
      metaEl.textContent = src ? `${rowCount} строк · ${src}` : `${rowCount} строк в отчёте`;
    }

    if (report.agg && Array.isArray(report.abcGrouped) && report.abcGrouped.length) {
      applyAnalyticsFromSnapshot({
        rows: report.rows,
        agg: report.agg,
        abcGrouped: report.abcGrouped,
        sentTotal: report.sentTotal,
        withdrawn: report.withdrawn
      });
    } else {
      applyUzumDashboardFromRows(report.rows);
      if (report.withdrawn !== undefined && report.withdrawn !== null) {
        const wi = document.getElementById('withdrawnInput');
        if (wi) wi.value = String(report.withdrawn);
      }
    }
    analyticsState.activeReportId = report.id != null ? report.id : null;
  } else {
    ph.classList.remove('hidden');
    dash.classList.add('hidden');
    actions?.classList.add('hidden');
    analyticsState.activeReportId = null;
    analyticsState.activeRows = null;
    analyticsState.lastAgg = null;
    currentReportName = '';
    currentReportData = null;
    const wi = document.getElementById('withdrawnInput');
    if (wi) wi.value = '';
    const pdfTitle = document.getElementById('pdfContentTitle');
    if (pdfTitle) pdfTitle.textContent = 'Финансовый отчёт';
  }
}

function openAnalyticsReportById(id) {
  const list = readReportsHistory();
  const report = list.find(r => r && String(r.id) === String(id));
  if (!report) return;
  showAnalyticsDashboardShell(true, report);
}

function renderAnalyticsReportsList() {
  const ul = document.getElementById('analyticsReportsList');
  const empty = document.getElementById('analyticsReportsEmpty');
  if (!ul) return;
  const list = readReportsHistory();
  ul.innerHTML = '';
  if (!list.length) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');
  list.forEach(rep => {
    if (!rep || !rep.id) return;
    const li = document.createElement('li');
    li.className = 'analytics-report-item';
    const title = document.createElement('div');
    title.className = 'analytics-report-item-title';
    title.textContent = rep.currentReportName || rep.label || 'Без названия';
    const meta = document.createElement('div');
    meta.className = 'analytics-report-item-meta';
    meta.textContent = fmtDateTime(rep.savedAt || rep.createdAt);
    const actions = document.createElement('div');
    actions.className = 'analytics-report-actions';
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn-secondary';
    openBtn.textContent = 'Открыть';
    openBtn.addEventListener('click', () => openAnalyticsReportById(rep.id));
    actions.append(openBtn);
    li.append(title, meta, actions);
    ul.appendChild(li);
  });
}

async function handleAnalyticsUzumFileSelected(ev) {
  const input = ev.target;
  const file = input.files && input.files[0];
  if (input) input.value = '';
  if (!file) return;
  const name = String(file.name || '').toLowerCase();
  if (!name.endsWith('.xlsx')) {
    alert('Выберите файл в формате .xlsx');
    return;
  }
  try {
    const buf = await file.arrayBuffer();
    const { sheetName, rows } = parseUzumXlsxToJsonRows(buf);
    console.log('Uzum Excel:', sheetName, 'строк:', rows.length, rows.slice(0, 2));
    const smartName = deriveReportNameFromFileName(file.name);
    showAnalyticsDashboardShell(true, {
      rows,
      currentReportName: smartName,
      label: smartName,
      fileName: file.name,
      sourceFileName: file.name,
      sheetName
    });
  } catch (err) {
    console.error(err);
    alert(err && err.message ? err.message : 'Не удалось прочитать файл Excel.');
  }
}

document.getElementById('analyticsUzumFileInput')?.addEventListener('change', handleAnalyticsUzumFileSelected);
document.getElementById('saveReportBtn')?.addEventListener('click', () => {
  if (!currentReportData || !Array.isArray(currentReportData.rows) || !currentReportData.rows.length) {
    alert('Нет данных отчёта для сохранения.');
    return;
  }
  const withdrawn = String(document.getElementById('withdrawnInput')?.value ?? '').trim();
  const entry = {
    id: String(Date.now()),
    currentReportName: currentReportName || 'Новый отчет',
    rows: currentReportData.rows,
    withdrawn,
    savedAt: new Date().toISOString(),
    agg: currentReportData.agg,
    abcGrouped: currentReportData.abcGrouped,
    sentTotal: currentReportData.sentTotal,
    sourceFileName: ''
  };
  const hist = readReportsHistory();
  hist.unshift(entry);
  writeReportsHistory(hist);
  if (!realtimeState.uiMemory || typeof realtimeState.uiMemory !== 'object') realtimeState.uiMemory = Object.create(null);
  realtimeState.uiMemory[`withdrawn_${entry.currentReportName}`] = withdrawn;
  renderAnalyticsReportsList();
  alert('Отчет сохранен');
});
document.getElementById('saveWithdrawnBtn')?.addEventListener('click', () => {
  if (!currentReportName) {
    alert('Откройте или загрузите отчёт.');
    return;
  }
  const input = document.getElementById('withdrawnInput');
  const v = input ? String(input.value).trim() : '';
  if (!realtimeState.uiMemory || typeof realtimeState.uiMemory !== 'object') realtimeState.uiMemory = Object.create(null);
  realtimeState.uiMemory[`withdrawn_${currentReportName}`] = v;
  alert('Сохранено');
});
document.getElementById('downloadPdfBtn')?.addEventListener('click', downloadReportPDF);
renderAnalyticsReportsList();

initUzumCostWarehouseListeners();
initMarketplaceSwitcher();
initThemeToggle();
initCodeGenerator1C();
initFabricCalculator();
initLabelPrintPage();
document.getElementById('stockAnalyticsRefreshBtn')?.addEventListener('click', () => {
  if (getCurrentMarketplace() === 'uzum') void renderStockAnalyticsPage();
});
wireWbAnalyticsUiOnce();
// Первичный рендер
updateCostSaveToolbar();
renderProductCost();
renderProductsDb();
openPage('products-tab');
