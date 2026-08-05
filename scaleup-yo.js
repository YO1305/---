/**
 * ScaleUp Clone — аналитический модуль YO
 * Excel-отчёты Uzum/WB остаются в разделе «Отчёты МП» (#analytics-tab).
 */
(function () {
  'use strict';

  const UZUM_API = 'https://api-seller.uzum.uz/api';
  const TOKEN_KEY = 'yo_uzum_bearer_token';
  const SYNC_KEY = 'yo_scaleup_sync_meta';
  const ORDERS_KEY = 'yo_uzum_orders_v1';
  const FINANCE_KEY = 'yo_uzum_finance_raw_v1';
  const DISMISSED_KEY = 'yo_scaleup_dismissed_insights';
  const SETTINGS_KEY = 'yo_scaleup_settings';

  let _view = 'dashboard';
  let _period = 3;
  let _finSub = 'overview';
  let _products = [];
  let _shipments = [];
  let _orders = [];
  let _finance = [];
  let _dismissed = new Set();
  let _settings = { vatPct: 12, commPct: 22, minMarginPct: 18 };
  let _hasApiData = false;
  let _hasFirebase = false;
  let _initialized = false;
  let _prodFilter = 'all';
  let _wired = false;

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

  function pct(v) {
    if (typeof fmtPct === 'function') return fmtPct(v);
    const x = Number(v);
    if (!Number.isFinite(x)) return '—';
    return `${x.toFixed(1)}%`;
  }

  function productSku(p) {
    return String(p?.sku || p?.article1c || p?.id || '').trim();
  }

  function productCost(p) {
    return Number(p?.costGross ?? p?.costPrice ?? p?.cost ?? 0) || 0;
  }

  function productStock(p) {
    return Math.max(0, Number(p?.stockQty ?? 0) || 0);
  }

  function productLiters(p) {
    const v = Number(p?.volumeLiters);
    if (Number.isFinite(v) && v > 0) return v;
    const L = Number(p?.length || p?.calc?.uzumLengthCm || 0);
    const W = Number(p?.width || p?.calc?.uzumWidthCm || 0);
    const H = Number(p?.height || p?.calc?.uzumHeightCm || 0);
    if (L > 0 && W > 0 && H > 0) return (L * W * H) / 1000;
    return 0;
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

  /** Разбор JWT exp (без проверки подписи). */
  function readJwtMeta(token) {
    try {
      const parts = String(token || '').split('.');
      if (parts.length < 2) return null;
      const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
      const payload = JSON.parse(json);
      const exp = Number(payload.exp);
      const iat = Number(payload.iat);
      return {
        exp: Number.isFinite(exp) ? exp : null,
        iat: Number.isFinite(iat) ? iat : null,
        expired: Number.isFinite(exp) ? exp * 1000 < Date.now() : null,
        secondsLeft: Number.isFinite(exp) ? Math.floor(exp - Date.now() / 1000) : null
      };
    } catch {
      return null;
    }
  }

  function tokenStatusHtml(token) {
    if (!token) return pill('bad', '❌ Не подключён');
    const meta = readJwtMeta(token);
    if (meta?.expired) return pill('bad', '⛔ Токен просрочен');
    if (meta?.secondsLeft != null && meta.secondsLeft < 600) {
      return pill('warn', `⏳ ~${Math.max(1, Math.ceil(meta.secondsLeft / 60))} мин`);
    }
    if (meta?.secondsLeft != null) {
      return pill('ok', `✅ ~${Math.ceil(meta.secondsLeft / 60)} мин`);
    }
    return pill('ok', '✅ Токен есть');
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
      if (typeof readStore === 'function') return readStore(key, fallback);
    } catch (_) { /* ignore */ }
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
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

  async function loadAllData() {
    showLoader();
    const fbProducts = await loadFromFirebase('products');
    const fbShipments = await loadFromFirebase('shipments');
    const fbFinance = await loadFromFirebase('finance_payments');
    _hasFirebase = !!(fbProducts && fbProducts.length);

    if (fbProducts && fbProducts.length) {
      _products = fbProducts;
    } else if (window.appState && Array.isArray(window.appState.products) && window.appState.products.length) {
      _products = window.appState.products.slice();
    } else {
      _products = readLocal('uzum_products_db_v1', []);
    }

    if (fbShipments && fbShipments.length) {
      _shipments = fbShipments;
    } else if (window.appState && Array.isArray(window.appState.shipments) && window.appState.shipments.length) {
      _shipments = window.appState.shipments.slice();
    } else {
      _shipments = readLocal('uzum_shipments_db_v1', []);
    }

    let localFinance = [];
    try {
      const fin = JSON.parse(localStorage.getItem('yo_finances_uzum_v1') || '{"payments":[]}');
      localFinance = Array.isArray(fin.payments) ? fin.payments : [];
    } catch (_) { /* ignore */ }
    _finance = (fbFinance && fbFinance.length ? fbFinance : localFinance).slice();

    _orders = readLocal(ORDERS_KEY, []);
    const apiFinance = readLocal(FINANCE_KEY, []);
    if (Array.isArray(apiFinance) && apiFinance.length) {
      _finance = _finance.concat(apiFinance);
    }
    _hasApiData = Array.isArray(_orders) && _orders.length > 0;

    updateDataSourceBadge();
    render();
  }

  function updateDataSourceBadge() {
    const el = document.getElementById('sc-data-source');
    if (!el) return;
    const parts = [];
    if (_hasFirebase) parts.push('🔥 Firebase');
    if (_hasApiData) parts.push('🔌 Uzum API');
    if (!_hasFirebase && !_hasApiData) parts.push('💾 localStorage');
    el.textContent = `${parts.join(' · ')} · ${_products.length} SKU`;
  }

  function periodFrom(months) {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  }

  function inPeriod(dateStr) {
    return String(dateStr || '').slice(0, 10) >= periodFrom(_period);
  }

  function shipmentsPeriod() {
    return _shipments.filter((s) => inPeriod(s.date || s.createdAt || ''));
  }

  function prevShipments() {
    const from = periodFrom(_period * 2);
    const to = periodFrom(_period);
    return _shipments.filter((s) => {
      const d = String(s.date || s.createdAt || '').slice(0, 10);
      return d >= from && d < to;
    });
  }

  function totalShipCost(list) {
    return list.reduce((s, x) => {
      if (x.totals && x.totals.totalCost != null) return s + Number(x.totals.totalCost || 0);
      const items = x.items || x.boxes?.flatMap((b) => b.items || []) || [];
      return (
        s +
        items.reduce((ss, i) => ss + Number(i.totalCost || i.lineTotal || (i.qty || 0) * (i.unitCost || 0) || 0), 0)
      );
    }, 0);
  }

  function totalShipQty(list) {
    return list.reduce((s, x) => {
      if (x.totals && x.totals.totalQty != null) return s + Number(x.totals.totalQty || 0);
      const items = x.items || x.boxes?.flatMap((b) => b.items || []) || [];
      return s + items.reduce((ss, i) => ss + Number(i.qty || 0), 0);
    }, 0);
  }

  function shipmentItems(s) {
    if (Array.isArray(s.items) && s.items.length) return s.items;
    if (Array.isArray(s.boxes)) return s.boxes.flatMap((b) => b.items || []);
    return [];
  }

  function skuCostMap(shipList) {
    const map = {};
    shipList.forEach((s) => {
      shipmentItems(s).forEach((i) => {
        const key = String(i.sku || i.article1c || '').trim();
        if (!key) return;
        if (!map[key]) map[key] = { qty: 0, cost: 0 };
        map[key].qty += Number(i.qty || 0);
        map[key].cost += Number(i.totalCost || i.lineTotal || (i.qty || 0) * (i.unitCost || 0) || 0);
      });
    });
    return map;
  }

  function skuMonthlyMap() {
    const map = {};
    _shipments.forEach((s) => {
      const m = String(s.date || s.createdAt || '').slice(0, 7);
      if (!m) return;
      shipmentItems(s).forEach((i) => {
        const key = String(i.sku || i.article1c || '').trim();
        if (!key) return;
        if (!map[key]) map[key] = {};
        map[key][m] =
          (map[key][m] || 0) + Number(i.totalCost || i.lineTotal || (i.qty || 0) * (i.unitCost || 0) || 0);
      });
    });
    return map;
  }

  function monthlyChart(shipList) {
    const map = {};
    shipList.forEach((s) => {
      const m = String(s.date || s.createdAt || '').slice(0, 7);
      if (!m) return;
      map[m] = (map[m] || 0) + (s.totals?.totalCost != null ? Number(s.totals.totalCost) : totalShipCost([s]));
    });
    return Object.keys(map)
      .sort()
      .map((m) => ({ label: m.slice(5), value: map[m] }));
  }

  function classifyABC(prods, costMap) {
    const sorted = [...prods].sort((a, b) => (costMap[productSku(b)]?.cost || 0) - (costMap[productSku(a)]?.cost || 0));
    const total = sorted.reduce((s, p) => s + (costMap[productSku(p)]?.cost || 0), 0);
    let cum = 0;
    return sorted.map((p) => {
      const sku = productSku(p);
      cum += costMap[sku]?.cost || 0;
      const sh = total > 0 ? cum / total : 0;
      return {
        ...p,
        abc: sh <= 0.8 ? 'A' : sh <= 0.95 ? 'B' : 'C',
        shipCost: costMap[sku]?.cost || 0,
        shipQty: costMap[sku]?.qty || 0
      };
    });
  }

  function classifyXYZ(prods) {
    const monthly = skuMonthlyMap();
    return prods.map((p) => {
      const vals = Object.values(monthly[productSku(p)] || {});
      if (vals.length < 2) return { ...p, xyz: 'N', monthVals: vals };
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
      const cv = mean > 0 ? std / mean : 1;
      return {
        ...p,
        xyz: cv <= 0.1 ? 'X' : cv <= 0.25 ? 'Y' : cv <= 0.5 ? 'Z' : 'N',
        monthVals: vals,
        cv
      };
    });
  }

  function showLoader() {
    const el = document.getElementById('sc-content');
    if (el) el.innerHTML = '<div class="sc-loader"><div class="sc-spinner"></div>Загрузка данных…</div>';
  }

  function kpi(label, val, sub = '', color = '') {
    return `<div class="sc-kpi${color ? ' ' + color : ''}">
      <div class="sc-kpi-label">${esc(label)}</div>
      <div class="sc-kpi-val">${val}</div>
      ${sub ? `<div class="sc-kpi-sub">${sub}</div>` : ''}
    </div>`;
  }

  function pill(cls, txt) {
    return `<span class="sc-pill sc-pill-${cls}">${esc(txt)}</span>`;
  }

  function spark(vals, w = 56, h = 20) {
    if (!vals?.length || vals.length < 2) return '—';
    const max = Math.max(...vals, 1);
    const pts = vals
      .map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
      .join(' ');
    return `<svg width="${w}" height="${h}" style="vertical-align:middle"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }

  function drawSimpleChart(elId, points) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!points.length) {
      el.innerHTML = '<div style="color:var(--muted);padding:24px;text-align:center">Нет данных за период</div>';
      return;
    }
    const w = 720;
    const h = 220;
    const max = Math.max(...points.map((p) => p.value), 1);
    const step = points.length > 1 ? w / (points.length - 1) : w;
    const pts = points
      .map((p, i) => `${(i * step).toFixed(1)},${(h - 20 - (p.value / max) * (h - 40)).toFixed(1)}`)
      .join(' ');
    const labels = points
      .map(
        (p, i) =>
          `<text x="${(i * step).toFixed(1)}" y="${h - 2}" font-size="11" fill="var(--muted)" text-anchor="middle">${esc(p.label)}</text>`
      )
      .join('');
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      ${labels}
    </svg>`;
  }

  function insight(key, type, icon, title, valHtml, actions = []) {
    if (_dismissed.has(key)) return '';
    const btns = actions
      .map((a) => `<button type="button" class="sc-insight-action" data-sc-goview="${esc(a.view || '')}">${esc(a.label)}</button>`)
      .join('');
    return `<div class="sc-insight ${type}">
      <span style="font-size:20px">${icon}</span>
      <div class="sc-insight-body">
        <div class="sc-insight-title">${esc(title)}</div>
        <div class="sc-insight-val">${valHtml}</div>
        <div class="sc-insight-btns">
          ${btns}
          <button type="button" class="sc-insight-dismiss" data-sc-dismiss="${esc(key)}">Отложить</button>
        </div>
      </div>
    </div>`;
  }

  function csvExport(rows, filename) {
    const bom = '\uFEFF';
    const blob = new Blob([bom + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function logisticsFor(p) {
    const L = Math.ceil(productLiters(p) || 0);
    if (typeof calcLogistics === 'function') return calcLogistics(L);
    return L > 0 ? Math.min(5250 + (L - 1) * 250, 50000) : 0;
  }

  function storageMonthFor(p) {
    const L = Math.ceil(productLiters(p) || 0);
    const t = Number(p.calc?.productTurnover || 30);
    const ss = p.calc?.productStockStatus || 'existing';
    if (typeof calcStoragePerDay === 'function') {
      return (calcStoragePerDay(L, t, ss, 0).amount || 0) * 30;
    }
    return 0;
  }

  function revenueFromOrders() {
    if (!_hasApiData) return null;
    return _orders
      .filter((o) => inPeriod(String(o.createdAt || o.date || '').slice(0, 10)) && o.status === 'DELIVERED')
      .reduce((s, o) => s + Number(o.totalPrice || o.amount || 0), 0);
  }

  // ── VIEWS ───────────────────────────────────────────────────

  function viewDashboard() {
    const sh = shipmentsPeriod();
    const shPrev = prevShipments();
    const cur = totalShipCost(sh);
    const prev = totalShipCost(shPrev);
    const withCost = _products.filter((p) => productCost(p) > 0);
    const avgCost = withCost.length
      ? withCost.reduce((s, p) => s + productCost(p), 0) / withCost.length
      : 0;
    const delta = prev > 0 ? ((cur - prev) / prev) * 100 : null;
    const deltaHtml =
      delta !== null
        ? `<span class="${delta >= 0 ? 'sc-kpi-delta-up' : 'sc-kpi-delta-down'}">${delta >= 0 ? '↑' : '↓'}${Math.abs(delta).toFixed(1)}% vs пред.</span>`
        : '';
    const noCost = _products.filter((p) => !productCost(p)).length;
    const noStock = _products.filter((p) => !productStock(p)).length;
    const apiRev = revenueFromOrders();

    const insights = [
      noCost > 0
        ? insight(
            'no-cost',
            'warn',
            '⚠️',
            'Товары без себестоимости',
            `<span style="color:#ef4444">${noCost} SKU</span> — расчёт недоступен`,
            [{ label: 'Заполнить →', view: 'cost' }]
          )
        : '',
      noStock > 0
        ? insight('no-stock', 'warn', '📦', 'Нулевой остаток', `${noStock} SKU`, [
            { label: 'Посмотреть →', view: 'stock' }
          ])
        : '',
      !getToken()
        ? insight(
            'no-api',
            'info',
            '🔌',
            'Подключи Uzum API',
            'Получай реальные данные о заказах и остатках',
            [{ label: 'Настройки →', view: '__settings' }]
          )
        : '',
      insight('abcxyz-tip', 'good', '📊', 'ABC/XYZ анализ готов', `${_products.length} SKU классифицированы`, [
        { label: 'Открыть →', view: 'abcxyz' }
      ])
    ]
      .filter(Boolean)
      .join('');

    return `
      <h2 style="margin:0 0 20px;font-size:20px;font-weight:800">🏠 Главная</h2>
      <div class="sc-dash-grid">
        <div>
          <div class="sc-kpi-row cols-3">
            ${kpi('СТОИМОСТЬ ПОСТАВОК', money(cur), deltaHtml)}
            ${apiRev !== null ? kpi('ВЫРУЧКА (РЕАЛЬНАЯ)', money(apiRev), 'из Uzum API', 'blue') : ''}
            ${kpi('СРЕДНЯЯ СЕБЕСТ./ЕД', money(avgCost), `${withCost.length} SKU`, 'blue')}
            ${kpi('ТОВАРОВ В БАЗЕ', `${_products.length} SKU`, `с себест.: ${withCost.length}`, 'green')}
          </div>
          <div class="sc-kpi-row cols-2">
            ${kpi('БЕЗ СЕБЕСТОИМОСТИ', `${noCost} SKU`, '⚠ заполни', 'red')}
            ${kpi('НУЛЕВОЙ ОСТАТОК', `${noStock} SKU`, '', 'orange')}
          </div>
          <div class="sc-card">
            <div class="sc-card-title">📈 Динамика поставок</div>
            <div id="sc-dash-chart"></div>
          </div>
        </div>
        <div class="sc-card">
          <div class="sc-card-title">💡 Что важно сейчас</div>
          ${insights || '<div style="color:var(--muted);font-size:13px;text-align:center;padding:20px">Всё в порядке ✅</div>'}
        </div>
      </div>`;
  }

  function viewPnl() {
    const sh = shipmentsPeriod();
    const shPrev = prevShipments();
    function calc(list) {
      const gross = totalShipCost(list);
      const inVat = list.reduce((s, x) => {
        return (
          s +
          shipmentItems(x).reduce((ss, i) => {
            const p = _products.find((pp) => productSku(pp) === String(i.sku || '').trim());
            return ss + Number(p?.inputVat || 0) * Number(i.qty || 0);
          }, 0)
        );
      }, 0);
      return { gross, inVat, net: gross - inVat };
    }
    const cur = calc(sh);
    const prev = calc(shPrev);
    function row(label, c, p, opts = {}) {
      const d = c - p;
      const dp = p !== 0 ? (d / Math.abs(p)) * 100 : null;
      return `<div class="sc-pnl-row${opts.tot ? ' tot' : opts.sub ? ' sub' : opts.sep ? ' sep' : ''}">
        <span>${label}</span>
        <span>${money(p)}</span>
        <span>${money(c)}</span>
        <span class="${d >= 0 ? 'sc-pnl-up' : 'sc-pnl-dn'}">${d >= 0 ? '+' : ''}${money(d)}</span>
        <span class="${d >= 0 ? 'sc-pnl-up' : 'sc-pnl-dn'}">${dp !== null ? pct(dp) : '—'}</span>
      </div>`;
    }
    return `
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:800">💰 Финансы</h2>
      <div class="sc-subtabs">
        <button type="button" class="sc-subtab" data-sc-finsub="overview">Обзор</button>
        <button type="button" class="sc-subtab active" data-sc-finsub="pnl">ОПиУ</button>
      </div>
      <div class="sc-pnl">
        <div class="sc-pnl-row hdr"><span>Показатель</span><span>Пред. период</span><span>Тек. период</span><span>Изм.</span><span>%</span></div>
        ${row('Стоимость поставок (брутто)', cur.gross, prev.gross, { tot: true })}
        ${row('В т.ч. входящий НДС', cur.inVat, prev.inVat, { sub: true })}
        ${row('Стоимость поставок (нетто)', cur.net, prev.net, { tot: true })}
        <div class="sc-pnl-row sep"><span>Рентабельность нетто, %</span>
          <span>${pct(prev.gross > 0 ? (prev.net / prev.gross) * 100 : 0)}</span>
          <span>${pct(cur.gross > 0 ? (cur.net / cur.gross) * 100 : 0)}</span>
          <span></span><span></span>
        </div>
      </div>`;
  }

  function viewFinance() {
    if (_finSub === 'pnl') return viewPnl();
    const sh = shipmentsPeriod();
    const cur = totalShipCost(sh);
    const qty = totalShipQty(sh);
    const avgPerUnit = qty > 0 ? cur / qty : 0;
    const rows = [...sh]
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .map((s) => {
        const items = shipmentItems(s);
        const cost = s.totals?.totalCost != null ? Number(s.totals.totalCost) : totalShipCost([s]);
        const q = s.totals?.totalQty != null ? Number(s.totals.totalQty) : items.reduce((x, i) => x + Number(i.qty || 0), 0);
        return `<tr>
          <td>${esc(String(s.date || '').slice(0, 10))}</td>
          <td style="color:var(--muted);font-size:11px">${esc(s.id || s.name || '—')}</td>
          <td>${items.length} SKU</td>
          <td>${q.toLocaleString('ru-RU')} ед.</td>
          <td style="font-weight:600">${money(cost)}</td>
        </tr>`;
      })
      .join('');

    const finRows = _finance
      .filter((f) => inPeriod(String(f.date || '').slice(0, 10)))
      .slice(0, 30)
      .map((f) => {
        const amt = Number(f.amount || 0);
        return `<tr>
          <td>${esc(String(f.date || '').slice(0, 10))}</td>
          <td>${pill(f.type === 'PAYOUT' ? 'ok' : f.type === 'FINE' ? 'bad' : 'n', f.type || '—')}</td>
          <td>${esc(f.description || '—')}</td>
          <td style="font-weight:600;color:${amt >= 0 ? '#10b981' : '#ef4444'}">${money(Math.abs(amt))}</td>
        </tr>`;
      })
      .join('');

    return `
      <h2 style="margin:0 0 16px;font-size:20px;font-weight:800">💰 Финансы</h2>
      <div class="sc-subtabs">
        <button type="button" class="sc-subtab active" data-sc-finsub="overview">Обзор</button>
        <button type="button" class="sc-subtab" data-sc-finsub="pnl">ОПиУ</button>
      </div>
      <div class="sc-kpi-row cols-4">
        ${kpi('СТОИМОСТЬ ПОСТАВОК', money(cur))}
        ${kpi('ЕДИНИЦ ПОСТАВЛЕНО', qty.toLocaleString('ru-RU'), '', 'blue')}
        ${kpi('ПОСТАВОК ВСЕГО', sh.length, '', 'green')}
        ${kpi('СРЕДНЯЯ СЕБЕСТ./ЕД', money(avgPerUnit), '', 'orange')}
      </div>
      <div class="sc-card">
        <div class="sc-card-title">📊 Динамика поставок</div>
        <div id="sc-fin-chart"></div>
      </div>
      ${
        sh.length
          ? `<div class="sc-table-wrap"><table class="sc-table">
        <thead><tr><th>Дата</th><th>ID</th><th>SKU</th><th>Кол-во</th><th>Стоимость</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
          : '<div class="sc-empty"><div class="sc-empty-title">Нет поставок за период</div></div>'
      }
      ${
        finRows
          ? `<div class="sc-card" style="margin-top:16px"><div class="sc-card-title">💳 Транзакции</div>
        <div class="sc-table-wrap" style="margin:0"><table class="sc-table">
        <thead><tr><th>Дата</th><th>Тип</th><th>Описание</th><th>Сумма</th></tr></thead>
        <tbody>${finRows}</tbody></table></div></div>`
          : ''
      }`;
  }

  function viewProducts() {
    const hasCost = _products.filter((p) => productCost(p) > 0).length;
    const noStock = _products.filter((p) => !productStock(p)).length;
    const rows = _products
      .map((p) => {
        const cost = productCost(p);
        const L = Math.ceil(productLiters(p) || 0);
        const log = logisticsFor(p);
        const stor = storageMonthFor(p);
        const hasc = cost > 0;
        const stock = productStock(p);
        const sku = productSku(p);
        return `<tr class="sc-prod-row" data-hascost="${hasc}" data-hasstock="${stock > 0}">
          <td><strong>${esc(p.name || sku)}</strong><br><span style="font-size:11px;color:var(--muted)">${esc(p.article1c || sku)}</span></td>
          <td style="font-family:monospace;font-size:12px">${esc(sku)}</td>
          <td>${hasc ? money(cost) : '—'}</td>
          <td>${productLiters(p) ? productLiters(p).toFixed(2) + ' л' : '—'}</td>
          <td>${stock} шт</td>
          <td>${L > 0 ? money(log) : '—'}</td>
          <td>${stor > 0 ? money(stor) : 'бесплатно'}</td>
          <td>${pill(hasc ? 'ok' : 'bad', hasc ? '✅ Есть' : '❌ Нет')}</td>
          <td><button type="button" class="sc-icon-btn" data-sc-edit="${esc(sku)}" title="Редактировать">✏️</button></td>
        </tr>`;
      })
      .join('');

    return `
      <h2 style="margin:0 0 20px;font-size:20px;font-weight:800">📦 Товары</h2>
      <div class="sc-kpi-row cols-4">
        ${kpi('ВСЕГО SKU', _products.length)}
        ${kpi('С СЕБЕСТОИМОСТЬЮ', hasCost, '', 'green')}
        ${kpi('БЕЗ СЕБЕСТОИМОСТИ', _products.length - hasCost, '⚠ заполни', 'red')}
        ${kpi('НУЛЕВОЙ ОСТАТОК', noStock, '', 'orange')}
      </div>
      <div class="sc-toolbar">
        <input class="sc-search" id="sc-prod-q" placeholder="Поиск по SKU, названию…" />
        <button type="button" class="sc-chip active" data-f="all">Все</button>
        <button type="button" class="sc-chip" data-f="cost">С себестоимостью</button>
        <button type="button" class="sc-chip" data-f="nocost">Без</button>
        <button type="button" class="sc-chip" data-f="stock">С остатком</button>
        <button type="button" class="sc-export" data-sc-export="products">⬇ CSV</button>
      </div>
      <div class="sc-table-wrap">
        <table class="sc-table" id="sc-prod-table">
          <thead><tr>
            <th>Товар</th><th>SKU</th><th>Себест.</th><th>Объём</th>
            <th>Остаток</th><th>Логистика</th><th>Хранение/мес</th>
            <th>Статус С/С</th><th></th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="9">Нет товаров</td></tr>'}</tbody>
        </table>
      </div>`;
  }

  function viewAbcXyz() {
    const sh = shipmentsPeriod();
    const cm = skuCostMap(sh);
    const withAbc = classifyABC(_products, cm);
    const withXyz = classifyXYZ(withAbc);
    const M = {};
    const MS = {};
    ['A', 'B', 'C'].forEach((a) => {
      M[a] = {};
      MS[a] = {};
      ['X', 'Y', 'Z', 'N'].forEach((x) => {
        M[a][x] = 0;
        MS[a][x] = 0;
      });
    });
    withXyz.forEach((p) => {
      M[p.abc][p.xyz]++;
      MS[p.abc][p.xyz] += p.shipCost || 0;
    });
    const bg = {
      AX: '#dcfce7',
      AY: '#d1fae5',
      AZ: '#fef9c3',
      AN: '#e0f2fe',
      BX: '#dbeafe',
      BY: '#e0f2fe',
      BZ: '#fef3c7',
      BN: '#f3f4f6',
      CX: '#f3f4f6',
      CY: '#fef9c3',
      CZ: '#fee2e2',
      CN: '#fef2f2'
    };
    const matHtml = ['A', 'B', 'C']
      .map(
        (a) =>
          `<tr><td style="font-weight:800;color:var(--accent);text-align:center">${a}</td>` +
          ['X', 'Y', 'Z', 'N']
            .map(
              (x) =>
                `<td class="sc-abc-cell" style="background:${bg[a + x] || '#f9fafb'}" data-sc-mat="${a}|${x}">
            <div class="sc-abc-count">${M[a][x]}</div>
            <div class="sc-abc-sum">${M[a][x] > 0 ? (MS[a][x] / 1e6).toFixed(1) + 'M' : ''}</div>
          </td>`
            )
            .join('') +
          `<td style="text-align:center;font-weight:700">${['X', 'Y', 'Z', 'N'].reduce((s, x) => s + M[a][x], 0)}</td></tr>`
      )
      .join('');

    const totals = withXyz.reduce((s, p) => ({ cost: s.cost + (p.shipCost || 0), qty: s.qty + (p.shipQty || 0) }), {
      cost: 0,
      qty: 0
    });
    const rows = withXyz
      .slice(0, 150)
      .map((p) => {
        const sku = productSku(p);
        const abcCls = { A: 'a', B: 'b', C: 'c' }[p.abc] || 'n';
        const xyzCls = { X: 'x', Y: 'y', Z: 'z', N: 'n' }[p.xyz] || 'n';
        return `<tr data-abc="${p.abc}" data-xyz="${p.xyz}">
          <td>${esc(p.name || sku)}<br><span style="font-size:11px;color:var(--muted)">${esc(sku)}</span></td>
          <td>${money(p.shipCost)}</td>
          <td>${(p.shipQty || 0).toLocaleString('ru-RU')}</td>
          <td>${pct(totals.cost > 0 ? (p.shipCost / totals.cost) * 100 : 0)}</td>
          <td>${pill(abcCls, p.abc)}</td>
          <td>${pill(xyzCls, p.xyz)}</td>
          <td>${spark(p.monthVals)}</td>
        </tr>`;
      })
      .join('');

    return `
      <h2 style="margin:0 0 20px;font-size:20px;font-weight:800">📊 ABC/XYZ</h2>
      <div class="sc-kpi-row cols-4">
        ${kpi('ВСЕГО SKU', withXyz.length)}
        ${kpi('СТОИМОСТЬ ПОСТАВОК', money(totals.cost), '', 'blue')}
        ${kpi('КЛАСС A', withXyz.filter((p) => p.abc === 'A').length, 'топ 80%', 'green')}
        ${kpi('СТАБИЛЬНЫЕ (X+Y)', withXyz.filter((p) => ['X', 'Y'].includes(p.xyz)).length, 'CV≤25%')}
      </div>
      <div class="sc-card">
        <div class="sc-card-title">Матрица ABC × XYZ</div>
        <div style="overflow-x:auto">
          <table class="sc-abc-matrix">
            <tr><th></th><th>X</th><th>Y</th><th>Z</th><th>N</th><th>Итого</th></tr>
            ${matHtml}
            <tr>
              <td style="text-align:center;font-weight:700;color:var(--muted)">Итого</td>
              ${['X', 'Y', 'Z', 'N'].map((x) => `<td style="text-align:center;font-weight:700">${['A', 'B', 'C'].reduce((s, a) => s + M[a][x], 0)}</td>`).join('')}
              <td style="text-align:center;font-weight:700">${withXyz.length}</td>
            </tr>
          </table>
        </div>
        <div id="sc-mat-detail" class="sub" style="margin-top:12px"></div>
      </div>
      <div class="sc-toolbar">
        <button type="button" class="sc-export" data-sc-export="abcxyz">⬇ CSV</button>
      </div>
      <div class="sc-table-wrap">
        <table class="sc-table" id="sc-abc-table">
          <thead><tr><th>Товар</th><th>Стоимость пост.</th><th>Кол-во ед.</th><th>Доля%</th><th>ABC</th><th>XYZ</th><th>Динамика</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function viewProfitShare() {
    const sh = shipmentsPeriod();
    const cm = skuCostMap(sh);
    const total = Object.values(cm).reduce((s, v) => s + v.cost, 0);
    const sorted = _products
      .map((p) => ({ name: p.name || productSku(p), sku: productSku(p), cost: cm[productSku(p)]?.cost || 0 }))
      .filter((p) => p.cost > 0)
      .sort((a, b) => b.cost - a.cost);
    const top = sorted[0]?.cost || 1;
    const cells = sorted
      .map((p) => {
        const ratio = p.cost / top;
        const opacity = Math.max(0.35, ratio);
        const share = total > 0 ? ((p.cost / total) * 100).toFixed(1) : 0;
        return `<div class="sc-tm-cell" style="flex:${Math.max(p.cost, 1)};opacity:${opacity};background:var(--accent)" title="${esc(p.sku)}: ${money(p.cost)} (${share}%)">
          <div class="sc-tm-name">${esc(p.name)}</div>
          <div class="sc-tm-val">${(p.cost / 1e6).toFixed(1)}M</div>
          <div class="sc-tm-pct">${share}%</div>
        </div>`;
      })
      .join('');

    return `
      <h2 style="margin:0 0 20px;font-size:20px;font-weight:800">🍕 Доли прибыли</h2>
      <div class="sc-kpi-row cols-3">
        ${kpi('ВСЕГО СТОИМОСТЬ', money(total))}
        ${kpi('SKU С ПОСТАВКАМИ', sorted.length, '', 'green')}
        ${kpi('БЕЗ ПОСТАВОК', _products.length - sorted.length, '', 'orange')}
      </div>
      <div class="sc-card">
        <div class="sc-card-title">Распределение по SKU</div>
        <div class="sc-treemap" style="background:var(--surface-2,#fafafa)">${
          cells || '<div style="padding:40px;color:var(--muted);text-align:center;width:100%">Нет данных о поставках</div>'
        }</div>
      </div>`;
  }

  function viewUnitEconomics() {
    const { vatPct, commPct, minMarginPct } = _settings;
    const rows = _products
      .map((p) => {
        const cost = productCost(p);
        const inVat = Number(p.inputVat || 0);
        const L = Math.ceil(productLiters(p) || 0);
        const log = logisticsFor(p);
        const stor = storageMonthFor(p);
        const den = 1 - commPct / 100 - vatPct / (100 + vatPct);
        const minP = cost > 0 && den > 0 ? Math.ceil((cost + log + stor) / den) : 0;
        const sku = productSku(p);
        return `<tr>
          <td>${esc(p.name || sku)}<br><span style="font-size:11px;color:var(--muted)">${esc(sku)}</span></td>
          <td>${cost ? money(cost) : '—'}</td>
          <td>${inVat ? money(inVat) : '—'}</td>
          <td>${L > 0 ? L + ' л' : '—'}</td>
          <td>${L > 0 ? money(log) : '—'}</td>
          <td>${stor > 0 ? money(stor) : 'бесплатно'}</td>
          <td style="color:var(--accent);font-weight:700">${minP ? money(minP) : '—'}</td>
          <td>${pill(cost ? 'ok' : 'bad', cost ? 'Есть' : 'Нет')}</td>
        </tr>`;
      })
      .join('');

    return `
      <h2 style="margin:0 0 20px;font-size:20px;font-weight:800">💹 Юнит-экономика</h2>
      <div class="sc-card">
        <div class="sc-card-title">⚙️ Настройки расчёта</div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:flex-end">
          <label style="font-size:13px">НДС, %
            <input type="number" id="ue-vat" value="${vatPct}" min="0" max="50" class="sc-num-input">
          </label>
          <label style="font-size:13px">Комиссия Uzum, %
            <input type="number" id="ue-comm" value="${commPct}" min="0" max="60" class="sc-num-input">
          </label>
          <label style="font-size:13px">Мин. маржа, %
            <input type="number" id="ue-margin" value="${minMarginPct}" min="0" max="100" class="sc-num-input">
          </label>
          <button type="button" class="btn-primary" data-sc-save-settings>Пересчитать</button>
        </div>
      </div>
      <div class="sc-table-wrap">
        <table class="sc-table">
          <thead><tr><th>Товар</th><th>Себест.</th><th>НДС вход.</th><th>Объём</th><th>Логистика</th><th>Хранение/мес</th><th>Мин. цена</th><th>Статус С/С</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function viewCost() {
    const hasc = _products.filter((p) => productCost(p) > 0).length;
    const rows = _products
      .map((p) => {
        const sku = productSku(p);
        const cost = productCost(p);
        return `<tr>
          <td>${esc(p.name || sku)}<br><span style="font-size:11px;color:var(--muted)">${esc(sku)}</span></td>
          <td style="font-family:monospace;font-size:12px">${esc(sku)}</td>
          <td>${productLiters(p) ? productLiters(p).toFixed(2) + ' л' : '—'}</td>
          <td>${cost ? money(cost) : '—'}</td>
          <td>${p.costNet ? money(p.costNet) : '—'}</td>
          <td>${p.inputVat ? money(p.inputVat) : '—'}</td>
          <td>${pill(cost ? 'ok' : 'bad', cost ? '✅ Заполнена' : '❌ Нет')}</td>
          <td><button type="button" class="sc-icon-btn" data-sc-edit="${esc(sku)}">✏️</button></td>
        </tr>`;
      })
      .join('');

    return `
      <h2 style="margin:0 0 20px;font-size:20px;font-weight:800">🧵 Себестоимость</h2>
      <div class="sc-kpi-row cols-4">
        ${kpi('ВСЕГО SKU', _products.length)}
        ${kpi('ЗАПОЛНЕНО', hasc, pct(_products.length ? (hasc / _products.length) * 100 : 0), 'green')}
        ${kpi('НЕ ЗАПОЛНЕНО', _products.length - hasc, '⚠ нужно заполнить', 'red')}
        ${kpi('ПОКРЫТИЕ', pct(_products.length ? (hasc / _products.length) * 100 : 0))}
      </div>
      <div class="sc-toolbar">
        <button type="button" class="btn-secondary" data-sc-open-cost>+ Добавить / Редактировать →</button>
        <button type="button" class="sc-export" data-sc-export="cost">⬇ CSV</button>
      </div>
      <div class="sc-table-wrap">
        <table class="sc-table">
          <thead><tr><th>Товар</th><th>SKU</th><th>Объём</th><th>Себест.брутто</th><th>Себест.нетто</th><th>НДС вход.</th><th>Статус</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function viewNewCalc() {
    return `
      <h2 style="margin:0 0 20px;font-size:20px;font-weight:800">🧮 Калькулятор нового товара</h2>
      <div class="sc-calc-grid">
        <div class="sc-card">
          <div class="sc-card-title">Параметры товара</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            ${[
              ['nc-price', 'Цена продажи, сум', '0'],
              ['nc-cost', 'Себестоимость, сум', '0'],
              ['nc-l', 'Длина, см', '0'],
              ['nc-w', 'Ширина, см', '0'],
              ['nc-h', 'Высота, см', '0'],
              ['nc-turn', 'Оборачиваемость, дней', '30'],
              ['nc-comm', 'Комиссия Uzum, %', String(_settings.commPct)],
              ['nc-vat', 'НДС, %', String(_settings.vatPct)],
              ['nc-drr', 'ДРР (реклама), %', '0'],
              ['nc-other', 'Прочее, сум', '0']
            ]
              .map(
                ([id, label, def]) => `<label style="font-size:13px;display:flex;flex-direction:column;gap:5px">
              ${label}
              <input type="number" id="${id}" value="${def}" class="sc-num-input" data-sc-recalc style="width:100%">
            </label>`
              )
              .join('')}
          </div>
        </div>
        <div class="sc-calc-result">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.6px;color:var(--muted)">МИН. ЦЕНА (безубыток)</div>
          <div class="sc-calc-minprice" id="nc-minprice">—</div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:12px">При заданной цене:</div>
          <div class="sc-calc-line"><span>Прибыль</span><span id="nc-profit">—</span></div>
          <div class="sc-calc-line"><span>Маржа</span><span id="nc-margin">—</span></div>
          <div class="sc-calc-line"><span>ROI</span><span id="nc-roi">—</span></div>
          <div style="margin:14px 0 8px;font-size:11px;text-transform:uppercase;color:var(--muted)">Детализация</div>
          ${[
            ['nc-r-cost', 'Себестоимость'],
            ['nc-r-log', 'Логистика'],
            ['nc-r-stor', 'Хранение/мес'],
            ['nc-r-comm', 'Комиссия Uzum'],
            ['nc-r-vat', 'НДС к уплате'],
            ['nc-r-drr', 'ДРР'],
            ['nc-r-other', 'Прочее'],
            ['nc-r-total', 'Итого расходов']
          ]
            .map(([id, label]) => {
              const isTotal = id === 'nc-r-total';
              return `<div class="sc-calc-line" style="${isTotal ? 'border-top:2px solid var(--border-color);margin-top:8px;padding-top:12px;font-weight:700' : ''}">
              <span>${label}</span><span id="${id}">—</span>
            </div>`;
            })
            .join('')}
        </div>
      </div>`;
  }

  function viewStock() {
    const sorted = [..._products]
      .filter((p) => productStock(p) > 0)
      .sort((a, b) => productStock(b) * productCost(b) - productStock(a) * productCost(a));
    const totalVal = _products.reduce((s, p) => s + productStock(p) * productCost(p), 0);
    const totalQty = _products.reduce((s, p) => s + productStock(p), 0);
    const rows = sorted
      .map((p) => {
        const stock = productStock(p);
        const cost = productCost(p);
        const val = stock * cost;
        const stor = storageMonthFor(p);
        const t = Number(p.calc?.productTurnover || 30);
        const sku = productSku(p);
        return `<tr>
          <td>${esc(p.name || sku)}<br><span style="font-size:11px;color:var(--muted)">${esc(sku)}</span></td>
          <td><strong>${stock.toLocaleString('ru-RU')}</strong> шт</td>
          <td>${cost ? money(cost) : '—'}</td>
          <td style="font-weight:700;color:var(--accent)">${val ? money(val) : '—'}</td>
          <td>${productLiters(p) ? productLiters(p).toFixed(2) + ' л' : '—'}</td>
          <td>${stor ? money(stor) : 'бесплатно'}</td>
          <td>${t} дн.</td>
        </tr>`;
      })
      .join('');

    return `
      <h2 style="margin:0 0 20px;font-size:20px;font-weight:800">📦 Склад</h2>
      <div class="sc-kpi-row cols-4">
        ${kpi('ОБЩИЙ ОСТАТОК', totalQty.toLocaleString('ru-RU') + ' шт')}
        ${kpi('СТОИМОСТЬ СКЛАДА', money(totalVal), 'по себестоимости', 'blue')}
        ${kpi('SKU С ОСТАТКОМ', sorted.length, '', 'green')}
        ${kpi('SKU В НОЛЬ', _products.length - sorted.length, '', 'red')}
      </div>
      <div class="sc-table-wrap">
        <table class="sc-table">
          <thead><tr><th>Товар</th><th>Остаток</th><th>Себест./ед</th><th>Стоимость склада</th><th>Объём</th><th>Хранение/мес</th><th>Оборачив.</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7">Нет остатков</td></tr>'}</tbody>
        </table>
      </div>`;
  }

  function bookmarkletHref() {
    // Важно: код выполняется на seller.uzum.uz — токен кладём в буфер + показываем,
    // чтобы пользователь вставил его в YO (localStorage чужого домена недоступен).
    const code = `(function(){function pick(){var keys=['access_token','accessToken','token','sellerToken','bearerToken','id_token','access-token'];var i,v,k,m,o;function jwt(s){m=String(s||'').match(/eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/);return m?m[0]:null;}for(i=0;i<keys.length;i++){v=localStorage.getItem(keys[i]);if(v&&v.length>80){m=jwt(v)||String(v).replace(/^Bearer\\s+/i,'').trim();if(m&&m.length>80)return m;}}try{for(i=0;i<sessionStorage.length;i++){k=sessionStorage.key(i)||'';v=sessionStorage.getItem(k);m=jwt(v);if(m&&/token|auth|bearer|oauth|keycloak/i.test(k+v))return m;}}catch(e){}try{for(i=0;i<localStorage.length;i++){k=localStorage.key(i)||'';v=localStorage.getItem(k);if(!v||v.length<40)continue;m=jwt(v);if(!m)continue;if(/token|auth|bearer|oauth|oidc|keycloak|access/i.test(k)||k.indexOf('oidc')>=0)return m;if(v.charAt(0)==='{'){try{o=JSON.parse(v);if(o.access_token)return jwt(o.access_token)||o.access_token;if(o.accessToken)return jwt(o.accessToken)||o.accessToken;}catch(e){}}}}catch(e){}return null;}var t=pick();if(!t){alert('❌ Токен не найден.\\n\\nСделай так:\\n1) F12 → Console\\n2) Вставь код из YO → Настройки\\nИли Application → Local Storage → ищи access_token');return;}t=String(t).replace(/^Bearer\\s+/i,'').trim();function done(ok){prompt((ok?'✅ Скопировано в буфер. ':'')+'Вставь этот токен в YO → Настройки:',t);}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){done(true);}).catch(function(){done(false);});}else{done(false);}})();`;
    return 'javascript:' + encodeURIComponent(code);
  }

  function consoleSnippet() {
    return `(() => { const jwt = s => (String(s||'').match(/eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+/)||[])[0]; const keys=['access_token','accessToken','token','sellerToken','bearerToken']; for (const k of keys) { const v = localStorage.getItem(k); const t = jwt(v)||v; if (t && t.length>80) { console.log('KEY',k); copy(t); return alert('Токен скопирован (ключ '+k+'). Вставь в YO → Настройки'); } } for (const store of [localStorage, sessionStorage]) { for (let i=0;i<store.length;i++){ const k=store.key(i); const v=store.getItem(k); const t=jwt(v); if(t && /token|auth|oauth|access|oidc|keycloak/i.test(k+String(v).slice(0,200))){ console.log('FOUND',k); copy(t); return alert('Токен скопирован из '+k+'. Вставь в YO'); } } } alert('Токен не найден. Обнови seller.uzum.uz и попробуй снова'); })();`;
  }

  function renderSettingsPage() {
    const root = document.getElementById('settingsTabContent');
    if (!root) return;
    const token = getToken();
    const meta = getSyncMeta();
    const lastSync = meta.lastSyncAt
      ? new Date(meta.lastSyncAt).toLocaleString('ru-RU')
      : 'ещё не было';
    const snip = consoleSnippet();
    root.innerHTML = `
      <h2 style="margin:0 0 20px;font-size:20px;font-weight:800">⚙️ Настройки</h2>
      <div class="sc-settings-wrap">
        <div class="sc-settings-block">
          <div class="sc-settings-title">
            🔌 Uzum Market API
            <span style="margin-left:auto">${tokenStatusHtml(token)}</span>
          </div>
          <label style="display:block;margin-bottom:12px">
            <div style="font-size:13px;font-weight:600;margin-bottom:6px">Вставь access_token сюда</div>
            <div style="display:flex;gap:8px">
              <input type="password" id="sc-token-inp" class="sc-token-input" placeholder="Вставь токен (начинается с eyJ...)" value="" autocomplete="off">
              <button type="button" class="btn-secondary" data-sc-toggle-token title="Показать/скрыть">👁</button>
            </div>
            <div style="font-size:12px;color:var(--muted);margin-top:6px">⏱ Живёт ~30–40 мин. Network искать не нужно — используй Console или закладку ниже.</div>
          </label>

          <div style="background:var(--accent-soft);border:1px solid #c4b5fd;border-radius:12px;padding:16px;margin-bottom:16px">
            <div style="font-size:13px;font-weight:600;margin-bottom:8px">✅ Способ 1 — Console (самый простой)</div>
            <ol style="margin:0 0 12px;padding-left:18px;font-size:13px;color:var(--muted);line-height:1.55">
              <li>Открой <a href="https://seller.uzum.uz" target="_blank" rel="noopener">seller.uzum.uz</a> и войди</li>
              <li>Нажми <strong>F12</strong> → вкладка <strong>Console</strong> (не Network)</li>
              <li>Вставь код ниже и Enter — токен скопируется</li>
              <li>Вернись сюда → Ctrl+V в поле → «Сохранить и проверить»</li>
            </ol>
            <textarea id="sc-console-snip" class="sc-token-input" readonly rows="4" style="font-size:11px;line-height:1.35;resize:vertical">${esc(snip)}</textarea>
            <div class="toolbar" style="margin-top:10px;gap:8px">
              <button type="button" class="btn-primary" data-sc-copy-console>📋 Скопировать код для Console</button>
            </div>
          </div>

          <div style="background:var(--surface-2);border:1px solid var(--border-color);border-radius:12px;padding:16px;margin-bottom:16px">
            <div style="font-size:13px;font-weight:600;margin-bottom:8px">⚡ Способ 2 — закладка</div>
            <ol style="margin:0 0 12px;padding-left:18px;font-size:13px;color:var(--muted);line-height:1.5">
              <li>Перетащи кнопку в панель закладок</li>
              <li>На вкладке seller.uzum.uz нажми закладку</li>
              <li>В окне будет токен — скопируй и вставь сюда</li>
            </ol>
            <a class="sc-bookmarklet" href="${bookmarkletHref()}">📎 YO: Получить токен Uzum</a>
          </div>

          <div class="toolbar" style="gap:10px;flex-wrap:wrap">
            <button type="button" class="btn-primary" data-sc-save-token>✅ Сохранить и проверить</button>
            <button type="button" class="btn-secondary" data-sc-sync>🔄 Синхронизировать</button>
            <button type="button" class="btn-danger" data-sc-clear-token>🗑 Удалить</button>
          </div>
          <p class="sub" style="margin-top:12px">Последняя синхронизация: <strong>${esc(lastSync)}</strong></p>
        </div>

        <div class="sc-settings-block">
          <div class="sc-settings-title">📋 Что синхронизируется</div>
          <div class="sc-sync-grid">
            <div class="sc-sync-item"><div class="sc-sync-icon">📋</div><div class="sc-sync-body">
              <div class="sc-sync-name">Товары и SKU</div>
              <div class="sc-sync-desc">Каталог seller API</div>
              <div class="sc-sync-stat">${_products.length} SKU в базе YO</div>
            </div></div>
            <div class="sc-sync-item"><div class="sc-sync-icon">🛒</div><div class="sc-sync-body">
              <div class="sc-sync-name">Заказы и продажи</div>
              <div class="sc-sync-desc">yo_uzum_orders_v1</div>
              <div class="sc-sync-stat">${_orders.length} записей</div>
            </div></div>
            <div class="sc-sync-item"><div class="sc-sync-icon">💰</div><div class="sc-sync-body">
              <div class="sc-sync-name">Выплаты и расходы</div>
              <div class="sc-sync-desc">finance_payments + API</div>
              <div class="sc-sync-stat">${_finance.length} записей</div>
            </div></div>
            <div class="sc-sync-item"><div class="sc-sync-icon">📦</div><div class="sc-sync-body">
              <div class="sc-sync-name">Остатки FBO</div>
              <div class="sc-sync-desc">через sync stocks</div>
              <div class="sc-sync-stat">${_products.reduce((s, p) => s + productStock(p), 0)} шт в базе</div>
            </div></div>
          </div>
        </div>

        <div class="sc-settings-block">
          <div class="sc-settings-title">🔥 Firebase Firestore</div>
          <p style="margin:0;font-size:14px">
            ${
              window.db
                ? `${pill('ok', '● Подключён')} проект: <code>yoa123</code><br>
              <span class="sub">products: ${_products.length} · shipments: ${_shipments.length} · finance: ${_finance.length}</span>`
                : `${pill('bad', '● Не подключён')} — используется localStorage`
            }
          </p>
        </div>

        <div class="sc-settings-block">
          <div class="sc-settings-title">📖 Если Console тоже пусто</div>
          <ol style="margin:0;padding-left:18px;font-size:13px;line-height:1.55;color:var(--muted)">
            <li>F12 → <strong>Application</strong> (Приложение) → Local Storage → <code>https://seller.uzum.uz</code></li>
            <li>Ищи ключ с <code>access_token</code> / <code>token</code> / <code>oidc</code> — значение начинается с <code>eyJ</code></li>
            <li>Скопируй значение (без слова Bearer) и вставь сюда</li>
            <li>Network часто пустой из‑за фильтра — его можно не использовать</li>
          </ol>
        </div>
      </div>`;
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
        html = viewProducts();
        break;
      case 'abcxyz':
        html = viewAbcXyz();
        break;
      case 'profit-share':
        html = viewProfitShare();
        break;
      case 'unit-economics':
        html = viewUnitEconomics();
        break;
      case 'cost':
        html = viewCost();
        break;
      case 'new-calc':
        html = viewNewCalc();
        break;
      case 'stock':
        html = viewStock();
        break;
      default:
        html = viewDashboard();
    }
    el.innerHTML = html;

    document.querySelectorAll('.sc-sidebar .sc-nav').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-view') === _view);
    });
    document.querySelectorAll('.sc-period').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.getAttribute('data-p')) === _period);
    });

    if (_view === 'dashboard') drawSimpleChart('sc-dash-chart', monthlyChart(shipmentsPeriod()));
    if (_view === 'finance' && _finSub === 'overview') drawSimpleChart('sc-fin-chart', monthlyChart(shipmentsPeriod()));
    if (_view === 'new-calc') recalcNew();
    if (_view === 'products') applyProdFilter();
  }

  function goView(view) {
    if (view === '__settings') {
      if (typeof openPage === 'function') openPage('settings-tab');
      return;
    }
    if (!view) return;
    _view = view;
    render();
  }

  function setFinSub(sub) {
    _finSub = sub === 'pnl' ? 'pnl' : 'overview';
    render();
  }

  function dismiss(key) {
    _dismissed.add(key);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([..._dismissed]));
    render();
  }

  function saveSettings() {
    const vat = Number(document.getElementById('ue-vat')?.value);
    const comm = Number(document.getElementById('ue-comm')?.value);
    const margin = Number(document.getElementById('ue-margin')?.value);
    if (Number.isFinite(vat)) _settings.vatPct = vat;
    if (Number.isFinite(comm)) _settings.commPct = comm;
    if (Number.isFinite(margin)) _settings.minMarginPct = margin;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings));
    render();
  }

  function editProd(sku) {
    const p = _products.find((x) => productSku(x) === sku);
    if (p && typeof loadProductIntoCalculator === 'function') {
      try {
        loadProductIntoCalculator(p, false);
      } catch (e) {
        console.warn(e);
      }
    }
    if (typeof openPage === 'function') openPage('cost-tab');
  }

  function filterProd() {
    applyProdFilter();
  }

  function applyProdFilter() {
    const q = String(document.getElementById('sc-prod-q')?.value || '')
      .trim()
      .toLowerCase();
    document.querySelectorAll('#sc-prod-table .sc-prod-row').forEach((tr) => {
      const text = tr.textContent.toLowerCase();
      const hasCost = tr.getAttribute('data-hascost') === 'true';
      const hasStock = tr.getAttribute('data-hasstock') === 'true';
      let ok = !q || text.includes(q);
      if (_prodFilter === 'cost') ok = ok && hasCost;
      if (_prodFilter === 'nocost') ok = ok && !hasCost;
      if (_prodFilter === 'stock') ok = ok && hasStock;
      tr.style.display = ok ? '' : 'none';
    });
  }

  function chipProd(btn) {
    _prodFilter = btn?.getAttribute('data-f') || 'all';
    document.querySelectorAll('.sc-chip[data-f]').forEach((b) => b.classList.toggle('active', b === btn));
    applyProdFilter();
  }

  function exportProducts() {
    const rows = ['SKU;Название;Себестоимость;Остаток;Объём'];
    _products.forEach((p) => {
      rows.push(
        [productSku(p), p.name || '', productCost(p), productStock(p), productLiters(p).toFixed(2)]
          .map((x) => `"${String(x).replace(/"/g, '""')}"`)
          .join(';')
      );
    });
    csvExport(rows, 'yo-products.csv');
  }

  function exportAbcXyz() {
    const cm = skuCostMap(shipmentsPeriod());
    const list = classifyXYZ(classifyABC(_products, cm));
    const rows = ['SKU;Название;Стоимость;Кол-во;ABC;XYZ'];
    list.forEach((p) => {
      rows.push(
        [productSku(p), p.name || '', p.shipCost || 0, p.shipQty || 0, p.abc, p.xyz]
          .map((x) => `"${String(x).replace(/"/g, '""')}"`)
          .join(';')
      );
    });
    csvExport(rows, 'yo-abcxyz.csv');
  }

  function exportCost() {
    const rows = ['SKU;Название;СебестБрутто;СебестНетто;НДС'];
    _products.forEach((p) => {
      rows.push(
        [productSku(p), p.name || '', productCost(p), p.costNet || 0, p.inputVat || 0]
          .map((x) => `"${String(x).replace(/"/g, '""')}"`)
          .join(';')
      );
    });
    csvExport(rows, 'yo-cost.csv');
  }

  function matGroup(a, x) {
    const detail = document.getElementById('sc-mat-detail');
    const table = document.getElementById('sc-abc-table');
    if (table) {
      table.querySelectorAll('tbody tr').forEach((tr) => {
        const ok = tr.getAttribute('data-abc') === a && tr.getAttribute('data-xyz') === x;
        tr.style.display = ok ? '' : 'none';
      });
    }
    if (detail) detail.textContent = `Показаны SKU группы ${a}${x}. Обновите страницу раздела, чтобы сбросить фильтр.`;
  }

  function recalcNew() {
    const num = (id) => Number(document.getElementById(id)?.value) || 0;
    const price = num('nc-price');
    const cost = num('nc-cost');
    const L = Math.ceil((num('nc-l') * num('nc-w') * num('nc-h')) / 1000) || 0;
    const turn = num('nc-turn') || 30;
    const commPct = num('nc-comm');
    const vatPct = num('nc-vat');
    const drrPct = num('nc-drr');
    const other = num('nc-other');
    const log = typeof calcLogistics === 'function' ? calcLogistics(L) : L > 0 ? Math.min(5250 + (L - 1) * 250, 50000) : 0;
    const stor =
      typeof calcStoragePerDay === 'function' ? (calcStoragePerDay(L, turn, 'existing', 0).amount || 0) * 30 : 0;
    const commission = (price * commPct) / 100;
    const vatOut = (price * vatPct) / (100 + vatPct);
    const drr = (price * drrPct) / 100;
    const totalExp = cost + log + stor + commission + vatOut + drr + other;
    const den = 1 - commPct / 100 - vatPct / (100 + vatPct) - drrPct / 100;
    const minPrice = cost > 0 && den > 0 ? Math.ceil((cost + log + stor + other) / den) : 0;
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
    set('nc-r-cost', money(cost));
    set('nc-r-log', money(log));
    set('nc-r-stor', money(stor));
    set('nc-r-comm', money(commission));
    set('nc-r-vat', money(vatOut));
    set('nc-r-drr', money(drr));
    set('nc-r-other', money(other));
    set('nc-r-total', money(totalExp));
  }

  function toggleToken() {
    const inp = document.getElementById('sc-token-inp');
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
  }

  function saveToken() {
    const inp = document.getElementById('sc-token-inp');
    let raw = String(inp?.value || '').trim();
    if (!raw || raw.startsWith('••••')) {
      if (!getToken()) {
        alert('Вставьте Bearer токен');
        return;
      }
      void syncUzum();
      return;
    }
    raw = cleanToken(raw);
    if (raw.length < 40) {
      alert('Токен слишком короткий. Скопируй access_token целиком (обычно начинается с eyJ).');
      return;
    }
    localStorage.setItem(TOKEN_KEY, raw);
    const meta = readJwtMeta(raw);
    if (meta?.expired) {
      alert('Токен уже просрочен. Открой seller.uzum.uz и возьми свежий Authorization → Bearer.');
      renderSettingsPage();
      return;
    }
    void syncUzum();
  }

  function clearToken() {
    if (!confirm('Удалить сохранённый токен Uzum?')) return;
    localStorage.removeItem(TOKEN_KEY);
    renderSettingsPage();
  }

  function uzumProxyUrl(apiPath) {
    const path = String(apiPath || '').replace(/^\/+/, '');
    return `/api/uzum-proxy?path=${encodeURIComponent(path)}`;
  }

  async function uzumFetch(apiPath, options = {}) {
    const token = getToken();
    if (!token) throw new Error('Нет токена');
    const headers = Object.assign(
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Accept-Language': 'ru-RU'
      },
      options.headers || {}
    );
    const path = String(apiPath || '').replace(/^\/+/, '');
    try {
      const proxied = await fetch(uzumProxyUrl(path), { ...options, headers });
      const ct = proxied.headers.get('content-type') || '';
      if (proxied.status === 404 && ct.includes('text/html')) {
        throw new Error('proxy-missing');
      }
      return proxied;
    } catch (e) {
      if (String(e?.message) !== 'proxy-missing' && !(e instanceof TypeError)) throw e;
      return fetch(`${UZUM_API}/${path}`, { ...options, headers });
    }
  }

  function explainUzumHttpError(status, errText) {
    if (status === 401 || /unauthorized/i.test(errText)) {
      return (
        'Uzum отклонил токен (HTTP 401 Unauthorized).\n\n' +
        'Это не CORS и не поломка прокси — access_token недействителен или истёк (~30–40 мин).\n\n' +
        'Что сделать:\n' +
        '1) Открой https://seller.uzum.uz\n' +
        '2) F12 → Console (не Network)\n' +
        '3) В YO → Настройки нажми «Скопировать код для Console» и вставь в Console\n' +
        '4) Вернись в YO, вставь токен → «Сохранить и проверить»'
      );
    }
    if (status === 403) {
      return 'Доступ запрещён (403). Проверь, что токен от нужного магазина/аккаунта продавца.';
    }
    if (String(errText).includes('proxy-missing') || status === 404) {
      return 'Прокси /api/uzum-proxy не найден. Задеплой на Vercel папку api/.';
    }
    return `HTTP ${status}${errText ? ': ' + errText.slice(0, 220) : ''}`;
  }

  async function syncUzum() {
    const token = cleanToken(getToken());
    if (!token) {
      alert('Сначала сохрани Bearer токен');
      return;
    }
    if (token !== getToken()) localStorage.setItem(TOKEN_KEY, token);

    const meta = readJwtMeta(token);
    if (meta?.expired) {
      alert(
        'Токен просрочен (поле exp в JWT уже в прошлом).\n\n' +
          'Возьми новый access_token в seller.uzum.uz и сохрани снова.'
      );
      renderSettingsPage();
      return;
    }

    try {
      // Правильный endpoint кабинета: список магазинов (не /seller/products/)
      const res = await uzumFetch('seller/shop/');
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(explainUzumHttpError(res.status, errText));
      }
      let data = null;
      try {
        data = await res.json();
      } catch (_) { /* ignore */ }

      const shops = Array.isArray(data)
        ? data
        : Array.isArray(data?.payload)
          ? data.payload
          : Array.isArray(data?.content)
            ? data.content
            : [];
      const shop = shops[0] || null;
      const shopId = shop?.id || shop?.shopId || shop?.sellerId || null;
      let productHint = '';

      if (shopId) {
        const q =
          `seller/shop/${shopId}/product/getProducts?searchQuery=&filter=ALL&sortBy=id&order=descending&size=1&page=0`;
        const pRes = await uzumFetch(q);
        if (pRes.ok) {
          let pData = null;
          try {
            pData = await pRes.json();
          } catch (_) { /* ignore */ }
          const total =
            pData?.totalElements ??
            pData?.payload?.totalElements ??
            pData?.total ??
            null;
          productHint =
            total != null
              ? `\nТовары API: ${total} (магазин #${shopId}).`
              : `\nКаталог магазина #${shopId} доступен.`;
        } else {
          productHint = `\nМагазин #${shopId} найден, каталог: HTTP ${pRes.status}.`;
        }
      }

      saveSyncMeta({
        lastSyncAt: new Date().toISOString(),
        lastStatus: 'ok',
        lastHttp: res.status,
        shopId: shopId || null,
        shopsCount: shops.length
      });
      const left =
        meta?.secondsLeft != null
          ? `\nТокену осталось ~${Math.max(1, Math.ceil(meta.secondsLeft / 60))} мин.`
          : '';
      alert(
        `✅ Токен рабочий. Магазинов: ${shops.length}.${productHint}${left}\n` +
          'Полный импорт заказов/остатков — следующим шагом.'
      );
    } catch (err) {
      saveSyncMeta({
        lastSyncAt: new Date().toISOString(),
        lastStatus: 'error',
        lastError: String(err?.message || err)
      });
      const msg = String(err?.message || err);
      alert(msg.startsWith('Uzum отклонил') || msg.startsWith('Токен') || msg.startsWith('Доступ') || msg.startsWith('Прокси')
        ? msg
        : 'Не удалось проверить токен через API.\n\n' + msg);
    }
    renderSettingsPage();
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
        e.preventDefault();
        closeScMobileNav();
        return;
      }
      if (e.target.closest('[data-sc-open-settings]')) {
        e.preventDefault();
        closeScMobileNav();
        if (typeof openPage === 'function') openPage('settings-tab');
        return;
      }
      const nav = e.target.closest('.sc-nav[data-view]');
      if (nav) {
        e.preventDefault();
        goView(nav.getAttribute('data-view'));
        closeScMobileNav();
        return;
      }
      const period = e.target.closest('.sc-period[data-p]');
      if (period) {
        e.preventDefault();
        _period = Number(period.getAttribute('data-p')) || 3;
        render();
        return;
      }
      if (e.target.closest('#sc-refresh-btn')) {
        e.preventDefault();
        void loadAllData();
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
      const edit = e.target.closest('[data-sc-edit]');
      if (edit) {
        editProd(edit.getAttribute('data-sc-edit'));
        return;
      }
      const chip = e.target.closest('.sc-chip[data-f]');
      if (chip) {
        chipProd(chip);
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
        return;
      }
      const mat = e.target.closest('[data-sc-mat]');
      if (mat) {
        const [a, x] = String(mat.getAttribute('data-sc-mat') || '').split('|');
        matGroup(a, x);
      }
    });

    root?.addEventListener('input', (e) => {
      if (e.target?.id === 'sc-prod-q') filterProd();
      if (e.target?.hasAttribute?.('data-sc-recalc')) recalcNew();
    });

    const settings = document.getElementById('settings-tab');
    settings?.addEventListener('click', (e) => {
      if (e.target.closest('#scSettingsBackAnalytics')) {
        if (typeof openPage === 'function') openPage('analytics-scaleup-tab');
        return;
      }
      if (e.target.closest('#scSettingsBackYo')) {
        if (typeof openPage === 'function') openPage('dashboard-page');
        return;
      }
      if (e.target.closest('[data-sc-copy-console]')) {
        const ta = document.getElementById('sc-console-snip');
        const text = ta?.value || consoleSnippet();
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(text).then(
            () => alert('Код скопирован. Открой seller.uzum.uz → F12 → Console → Ctrl+V → Enter'),
            () => {
              ta?.select();
              alert('Выдели код вручную (Ctrl+C), потом вставь в Console на seller.uzum.uz');
            }
          );
        } else {
          ta?.select();
          alert('Выдели код вручную (Ctrl+C), потом вставь в Console на seller.uzum.uz');
        }
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
