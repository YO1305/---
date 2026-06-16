/**
 * Раздел «Финансы — Узум Маркет»
 * Учёт отгрузок, выплат, баланса ЛК и остатков склада.
 */
(function () {
  'use strict';

  const MP_ID = 'uzum';
  const COL = {
    payments: 'finance_payments',
    shipments: 'finance_shipments',
    snapshots: 'finance_balance_snapshots',
    stock: 'finance_warehouse_stock'
  };

  const financeState = {
    payments: [],
    shipments: [],
    snapshots: [],
    stock: [],
    activeTab: 'summary',
    loading: true,
    importInProgress: false,
    storageMode: 'unknown', // firebase | local
    filters: {
      shipments: { from: '', to: '' },
      payments: { from: '', to: '' }
    },
    stockViewDate: '' // пусто = последний актуальный снимок
  };

  const FINANCE_LOCAL_KEY = 'yo_finances_uzum_v1';
  let financeStoreMode = 'unknown';

  let _unsubs = [];

  function colToStateKey(col) {
    return ({
      [COL.payments]: 'payments',
      [COL.shipments]: 'shipments',
      [COL.snapshots]: 'snapshots',
      [COL.stock]: 'stock'
    })[col] || null;
  }

  function isPermissionError(err) {
    const code = String(err?.code || '');
    const msg = String(err?.message || '');
    return code === 'permission-denied' || /insufficient permissions|missing or insufficient/i.test(msg);
  }

  function loadLocalFinanceData() {
    try {
      const raw = localStorage.getItem(FINANCE_LOCAL_KEY);
      if (!raw) return { payments: [], shipments: [], snapshots: [], stock: [] };
      const data = JSON.parse(raw);
      return {
        payments: Array.isArray(data.payments) ? data.payments : [],
        shipments: Array.isArray(data.shipments) ? data.shipments : [],
        snapshots: Array.isArray(data.snapshots) ? data.snapshots : [],
        stock: Array.isArray(data.stock) ? data.stock : []
      };
    } catch {
      return { payments: [], shipments: [], snapshots: [], stock: [] };
    }
  }

  function persistLocalFinanceData() {
    try {
      localStorage.setItem(FINANCE_LOCAL_KEY, JSON.stringify({
        payments: financeState.payments,
        shipments: financeState.shipments,
        snapshots: financeState.snapshots,
        stock: financeState.stock,
        updated_at: new Date().toISOString()
      }));
    } catch (err) {
      console.error('finance local save:', err);
      throw new Error('Не удалось сохранить данные в браузере (localStorage переполнен?)');
    }
  }

  function activateLocalFinanceStorage(reason) {
    financeStoreMode = 'local';
    financeState.storageMode = 'local';
    _unsubs.forEach((fn) => { try { fn(); } catch {} });
    _unsubs = [];
    const data = loadLocalFinanceData();
    financeState.payments = data.payments;
    financeState.shipments = data.shipments;
    financeState.snapshots = data.snapshots;
    financeState.stock = data.stock;
    financeState.loading = false;
    if (reason) console.warn('Finance: локальное хранилище —', reason);
  }

  async function probeFinanceFirebaseWrite() {
    const database = getDb();
    if (!database) return false;
    const testId = `_finance_probe_${Date.now()}`;
    try {
      await database.collection(COL.shipments).doc(testId).set({
        id: testId,
        marketplace_id: MP_ID,
        _probe: true,
        created_at: new Date().toISOString()
      });
      await database.collection(COL.shipments).doc(testId).delete();
      return true;
    } catch (err) {
      if (isPermissionError(err)) return false;
      console.warn('Finance probe:', err);
      return false;
    }
  }

  async function initFinanceStorage() {
    if (financeStoreMode !== 'unknown') return financeStoreMode;
    const canWrite = await probeFinanceFirebaseWrite();
    if (canWrite) {
      financeStoreMode = 'firebase';
      financeState.storageMode = 'firebase';
    } else {
      activateLocalFinanceStorage('нет прав записи в Firebase (finance_*)');
    }
    return financeStoreMode;
  }

  function bulkWriteFinanceLocal(col, records, deleteIds = []) {
    const stateKey = colToStateKey(col);
    if (!stateKey) throw new Error('Неизвестная коллекция');
    const deleteSet = new Set((deleteIds || []).map(String));
    const map = new Map();
    financeState[stateKey].forEach((item) => {
      if (!deleteSet.has(String(item.id))) map.set(String(item.id), item);
    });
    records.forEach((rec) => map.set(String(rec.id), rec));
    financeState[stateKey] = Array.from(map.values());
    persistLocalFinanceData();
    return records.length;
  }

  function upsertDocLocal(col, doc) {
    const stateKey = colToStateKey(col);
    if (!stateKey || !doc?.id) return false;
    const id = String(doc.id);
    const list = financeState[stateKey];
    const idx = list.findIndex((x) => String(x.id) === id);
    if (idx >= 0) list[idx] = doc;
    else list.push(doc);
    persistLocalFinanceData();
    return true;
  }

  function deleteDocLocal(col, id) {
    const stateKey = colToStateKey(col);
    if (!stateKey || !id) return false;
    financeState[stateKey] = financeState[stateKey].filter((x) => String(x.id) !== String(id));
    persistLocalFinanceData();
    return true;
  }

  function getDb() {
    try {
      return typeof db !== 'undefined' && db ? db : null;
    } catch {
      return null;
    }
  }

  function genId() {
    return `fin_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function fmtSum(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return new Intl.NumberFormat('ru-RU').format(Math.round(Number(n))) + ' сум';
  }

  function fmtNum(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return new Intl.NumberFormat('ru-RU').format(Math.round(Number(n)));
  }

  function toIsoDate(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
    if (typeof v === 'number' && v > 20000) {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const dot = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dot) return `${dot[3]}-${dot[2].padStart(2, '0')}-${dot[1].padStart(2, '0')}`;
    const digitsOnly = s.replace(/\D/g, '');
    if (/^\d{8}$/.test(digitsOnly)) {
      return `${digitsOnly.slice(4, 8)}-${digitsOnly.slice(2, 4)}-${digitsOnly.slice(0, 2)}`;
    }
    const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const a = Number(slash[1]);
      const b = Number(slash[2]);
      const y = slash[3];
      let day;
      let month;
      if (a > 12) { day = a; month = b; }
      else if (b > 12) { day = b; month = a; }
      else { day = a; month = b; }
      return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return s.slice(0, 10);
  }

  function fmtDateRu(v) {
    const iso = toIsoDate(v);
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return v ? String(v) : '—';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  }

  function fmtPeriodRu(from, to) {
    if (!from && !to) return '—';
    if (from && to) return `${fmtDateRu(from)} – ${fmtDateRu(to)}`;
    return fmtDateRu(from || to);
  }

  function exportDateSuffix() {
    return fmtDateRu(new Date().toISOString().slice(0, 10)).replace(/\./g, '-');
  }

  function maskDateDigits(value) {
    const digits = String(value ?? '').replace(/\D/g, '').slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
    return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
  }

  function bindDateInputMask(root = document) {
    root.querySelectorAll('input.fin-date-input').forEach((input) => {
      if (input.dataset.dateMaskBound) return;
      input.dataset.dateMaskBound = '1';
      input.setAttribute('inputmode', 'numeric');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('maxlength', '10');
      input.setAttribute('title', 'Вводите только цифры — точки подставятся сами');

      input.addEventListener('input', () => {
        const pos = input.selectionStart ?? input.value.length;
        const digitsBefore = input.value.slice(0, pos).replace(/\D/g, '').length;
        input.value = maskDateDigits(input.value);
        let nextPos = 0;
        let seen = 0;
        for (let i = 0; i < input.value.length && seen < digitsBefore; i += 1) {
          nextPos = i + 1;
          if (/\d/.test(input.value[i])) seen += 1;
        }
        if (seen === digitsBefore && nextPos < input.value.length && input.value[nextPos] === '.') {
          nextPos += 1;
        }
        try { input.setSelectionRange(nextPos, nextPos); } catch (_) { /* noop */ }
      });

      input.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text').trim();
        const iso = toIsoDate(text);
        input.value = iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? fmtDateRu(iso) : maskDateDigits(text);
      });
    });
  }

  function parseFinanceNumber(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const cleaned = String(v).replace(/\s/g, '').replace(/,/g, '.');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }

  function hasCellValue(v) {
    return v != null && String(v).trim() !== '';
  }

  // ── Calculations ─────────────────────────────────────────────

  function getLatestSnapshot() {
    const list = financeState.snapshots.slice().sort((a, b) =>
      new Date(b.snapshot_date).getTime() - new Date(a.snapshot_date).getTime()
    );
    return list[0] || null;
  }

  function getStockSnapshotDates() {
    return [...new Set(financeState.stock.map((s) => s.snapshot_date).filter(Boolean))]
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
  }

  function getLatestStockDate() {
    return getStockSnapshotDates()[0] || null;
  }

  function getPreviousStockDate(date) {
    const dates = getStockSnapshotDates();
    const idx = dates.indexOf(date);
    return idx >= 0 && idx < dates.length - 1 ? dates[idx + 1] : null;
  }

  function getActiveStockDate() {
    if (financeState.stockViewDate && getStockSnapshotDates().includes(financeState.stockViewDate)) {
      return financeState.stockViewDate;
    }
    return getLatestStockDate();
  }

  function getStockRowsByDate(date) {
    if (!date) return [];
    return financeState.stock
      .filter((s) => s.snapshot_date === date)
      .sort((a, b) => (Number(b.total_sale_sum) || 0) - (Number(a.total_sale_sum) || 0));
  }

  function getLatestStockRows() {
    return getStockRowsByDate(getActiveStockDate());
  }

  function getLatestStockRowsForSummary() {
    return getStockRowsByDate(getLatestStockDate());
  }

  function calcStockTotals(rows) {
    const list = rows || [];
    return {
      positions: list.length,
      qtyInSale: list.reduce((s, r) => s + Number(r.qty_in_sale || 0), 0),
      qtyDispatch: list.reduce((s, r) => s + Number(r.qty_for_dispatch || 0), 0),
      qtyTotal: list.reduce((s, r) => s + Number(r.total_qty || 0), 0),
      saleSum: list.reduce((s, r) => s + Number(r.total_sale_sum || 0), 0),
      costSum: list.reduce((s, r) => s + Number(r.total_cost_sum || 0), 0)
    };
  }

  function fmtDelta(n, suffix = '') {
    const v = Number(n) || 0;
    if (!v) return 'без изменений';
    const sign = v > 0 ? '+' : '';
    return `${sign}${fmtNum(v)}${suffix}`;
  }

  function inDateRange(dateStr, from, to) {
    if (!dateStr) return false;
    const t = new Date(dateStr).getTime();
    if (Number.isNaN(t)) return false;
    if (from && t < new Date(from).getTime()) return false;
    if (to && t > new Date(to).getTime()) return false;
    return true;
  }

  function filterByDateRange(items, dateField, from, to) {
    if (!from && !to) return items;
    return items.filter((item) => inDateRange(item[dateField], from, to));
  }

  function calcShipmentsStats(shipments) {
    const list = shipments || [];
    return {
      lines: list.length,
      qty: list.reduce((s, r) => s + Number(r.quantity || 0), 0),
      sum: list.reduce((s, r) => s + Number(r.total_amount || 0), 0)
    };
  }

  function calcPaymentsStats(payments) {
    const list = payments || [];
    const completed = list.filter((p) => p.status === 'completed');
    const pending = list.filter((p) => p.status === 'pending');
    return {
      totalLines: list.length,
      completedCount: completed.length,
      completedSum: completed.reduce((s, p) => s + Number(p.amount || 0), 0),
      pendingCount: pending.length,
      pendingSum: pending.reduce((s, p) => s + Number(p.amount || 0), 0)
    };
  }

  function renderMiniDash(cards) {
    return `<div class="finance-mini-dash">${cards.map((c) => `
      <div class="finance-mini-dash-card${c.accent ? ` finance-mini-dash-card--${c.accent}` : ''}">
        <div class="finance-mini-dash-label">${c.label}</div>
        <div class="finance-mini-dash-value">${c.value}</div>
        ${c.sub ? `<div class="finance-mini-dash-sub">${c.sub}</div>` : ''}
      </div>`).join('')}</div>`;
  }

  function renderDateFilterBar(tabKey, from, to) {
    return `<div class="finance-mini-filter card">
      <span class="finance-mini-filter-title">Период</span>
      <label class="finance-mini-filter-field">с <input type="text" class="fin-date-input" id="finFilterFrom" placeholder="07062024" value="${escapeAttr(from ? fmtDateRu(from) : '')}" /></label>
      <label class="finance-mini-filter-field">по <input type="text" class="fin-date-input" id="finFilterTo" placeholder="07062024" value="${escapeAttr(to ? fmtDateRu(to) : '')}" /></label>
      <button type="button" class="btn-secondary btn-sm" data-fin-filter-apply="${tabKey}">Применить</button>
      <button type="button" class="btn-secondary btn-sm" data-fin-filter-reset="${tabKey}">Сбросить</button>
      <span class="finance-date-hint">даты: только цифры</span>
    </div>`;
  }

  function detectStockSnapshotDate(file, buffer, rows) {
    const name = String(file?.name || '');
    const nameMatch = name.match(/(\d{2})\.(\d{2})\.(\d{4})/) || name.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (nameMatch) {
      if (nameMatch[0].includes('.')) {
        return `${nameMatch[3]}-${nameMatch[2]}-${nameMatch[1]}`;
      }
      return `${nameMatch[1]}-${nameMatch[2]}-${nameMatch[3]}`;
    }
    const wb = readFinanceWorkbook(buffer);
    const sheetName = wb.SheetNames.find((n) => /остаток|Остат/i.test(n)) ?? wb.SheetNames[0];
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    for (let i = 0; i < Math.min(matrix.length, 8); i++) {
      const rowText = (matrix[i] || []).join(' ');
      const m = rowText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    }
    if (rows?.length && rows[0]?.['Дата']) return toIsoDate(rows[0]['Дата']);
    return new Date().toISOString().slice(0, 10);
  }

  function calculateSummary() {
    const completed = financeState.payments.filter(p => p.status === 'completed');
    const totalReceived = completed.reduce((s, p) => s + Number(p.amount || 0), 0);
    const snap = getLatestSnapshot();
    const lkTotalBalance = Number(snap?.total_balance ?? 0);
    const lkNextPayout = Number(snap?.next_payout_amount ?? 0);
    const lkNextPayoutDate = snap?.next_payout_date ?? null;
    const lkRemainingBalance = snap?.remaining_balance != null
      ? Number(snap.remaining_balance)
      : lkTotalBalance - lkNextPayout;
    const stock = getLatestStockRowsForSummary();
    const stockInSaleQty = stock.filter((s) => Number(s.qty_in_sale) > 0)
      .reduce((s, r) => s + Number(r.qty_in_sale || 0), 0);
    const forDispatch = stock.filter((s) => Number(s.qty_for_dispatch) > 0);
    const stockForDispatchQty = forDispatch.reduce((s, r) => s + Number(r.qty_for_dispatch || 0), 0);
    const lkAvailableToWithdraw = lkTotalBalance;
    const guaranteed = totalReceived + lkAvailableToWithdraw;
    return {
      totalReceived, lkTotalBalance, lkAvailableToWithdraw, lkNextPayout, lkNextPayoutDate,
      lkRemainingBalance, stockInSaleQty, stockForDispatchQty,
      grandTotal: guaranteed,
      guaranteed,
      paymentsCount: completed.length,
      lastSnapshotDate: snap?.snapshot_date ?? null,
      lastStockDate: getLatestStockDate()
    };
  }

  function addRunningTotal(payments) {
    let running = 0;
    return payments
      .filter(p => p.status === 'completed')
      .sort((a, b) => new Date(a.payment_date).getTime() - new Date(b.payment_date).getTime())
      .map(p => {
        running += Number(p.amount || 0);
        return { ...p, running_total: running };
      });
  }

  // ── Firestore ────────────────────────────────────────────────

  function upsertDoc(col, doc, options = {}) {
    if (financeStoreMode === 'local') {
      const ok = upsertDocLocal(col, doc);
      if (!ok && options.strict) return Promise.reject(new Error('Ошибка локального сохранения'));
      return Promise.resolve(ok);
    }
    const database = getDb();
    if (!database || !doc?.id) {
      if (options.strict) return Promise.reject(new Error('Firebase не подключён'));
      return Promise.resolve(false);
    }
    return database.collection(col).doc(String(doc.id)).set(doc, { merge: true })
      .then(() => true)
      .catch((err) => {
        console.error(`finance upsert ${col}:`, err);
        if (isPermissionError(err)) {
          activateLocalFinanceStorage(err.message);
          return upsertDocLocal(col, doc);
        }
        if (options.strict) throw err;
        return false;
      });
  }

  async function bulkWriteFinanceDocs(col, records, deleteIds = []) {
    if (financeStoreMode === 'local') {
      return bulkWriteFinanceLocal(col, records, deleteIds);
    }
    const database = getDb();
    if (!database) throw new Error('Firebase не подключён');
    const ops = [
      ...deleteIds.filter(Boolean).map((id) => ({ type: 'delete', id: String(id) })),
      ...records.filter((r) => r?.id).map((rec) => ({ type: 'set', rec }))
    ];
    if (!ops.length) return 0;

    const CHUNK = 400;
    try {
      for (let i = 0; i < ops.length; i += CHUNK) {
        const batch = database.batch();
        ops.slice(i, i + CHUNK).forEach((op) => {
          const ref = database.collection(col).doc(op.type === 'delete' ? op.id : String(op.rec.id));
          if (op.type === 'delete') batch.delete(ref);
          else batch.set(ref, op.rec, { merge: true });
        });
        await batch.commit();
      }
      return records.length;
    } catch (err) {
      if (isPermissionError(err)) {
        activateLocalFinanceStorage(err.message);
        return bulkWriteFinanceLocal(col, records, deleteIds);
      }
      throw err;
    }
  }

  function setFinanceImportBusy(active, message) {
    financeState.importInProgress = !!active;
    let el = document.getElementById('financeImportOverlay');
    if (!active) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'financeImportOverlay';
      el.className = 'finance-import-overlay';
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <div class="finance-import-box card" role="status" aria-live="polite">
        <div class="finance-import-spinner" aria-hidden="true"></div>
        <p>${escapeHtml(message || 'Импорт данных...')}</p>
      </div>`;
  }

  function deleteDoc(col, id) {
    if (financeStoreMode === 'local') {
      return Promise.resolve(deleteDocLocal(col, id));
    }
    const database = getDb();
    if (!database || !id) return Promise.resolve(false);
    return database.collection(col).doc(String(id)).delete()
      .then(() => true)
      .catch((err) => {
        console.error(`finance delete ${col}:`, err);
        if (isPermissionError(err)) {
          activateLocalFinanceStorage(err.message);
          return deleteDocLocal(col, id);
        }
        return false;
      });
  }

  function renderFinanceStorageBanner() {
    if (financeState.storageMode !== 'local') return '';
    return `<div class="finance-warning finance-storage-banner">
      ⚠️ <strong>Локальный режим.</strong> Firebase не даёт записывать финансы (нет прав на коллекции finance_*).
      Данные сохраняются только в этом браузере.
      <div class="finance-storage-banner-steps">
        <strong>Как включить облако:</strong>
        <ol>
          <li>Нажмите «Правила Firebase» → вставьте текст из файла <code>firestore.rules</code> → <strong>Publish</strong></li>
          <li>Вернитесь сюда → нажмите «Проверить Firebase»</li>
        </ol>
      </div>
      <div class="finance-export-row finance-storage-banner-actions">
        <button type="button" class="btn-primary" id="finRetryFirebaseBtn">🔄 Проверить Firebase</button>
        <a class="btn-secondary" href="https://console.firebase.google.com/project/yoa123/firestore/rules" target="_blank" rel="noopener noreferrer">📋 Правила Firebase</a>
      </div>
    </div>`;
  }

  async function retryFinanceFirebaseSync() {
    const canWrite = await probeFinanceFirebaseWrite();
    if (!canWrite) {
      alert(
        'Firebase ещё не даёт записывать финансы.\n\n' +
        '1. Откройте «Правила Firebase»\n' +
        '2. Скопируйте весь файл firestore.rules из проекта\n' +
        '3. Вставьте в редактор правил → Publish\n' +
        '4. Снова нажмите «Проверить Firebase»'
      );
      return;
    }

    const local = loadLocalFinanceData();
    const localCount = local.shipments.length + local.payments.length + local.snapshots.length + local.stock.length;

    financeStoreMode = 'firebase';
    financeState.storageMode = 'firebase';

    if (localCount > 0) {
      const parts = [];
      if (local.shipments.length) parts.push(`${local.shipments.length} отгрузок`);
      if (local.payments.length) parts.push(`${local.payments.length} выплат`);
      if (local.snapshots.length) parts.push(`${local.snapshots.length} снимков баланса`);
      if (local.stock.length) parts.push(`${local.stock.length} остатков`);
      const merge = confirm(`Найдены локальные данные: ${parts.join(', ')}.\n\nПеренести их в Firebase?`);
      if (merge) {
        setFinanceImportBusy(true, 'Перенос данных в Firebase...');
        try {
          if (local.payments.length) await bulkWriteFinanceDocs(COL.payments, local.payments);
          if (local.shipments.length) await bulkWriteFinanceDocs(COL.shipments, local.shipments);
          if (local.snapshots.length) await bulkWriteFinanceDocs(COL.snapshots, local.snapshots);
          if (local.stock.length) await bulkWriteFinanceDocs(COL.stock, local.stock);
          localStorage.removeItem(FINANCE_LOCAL_KEY);
        } finally {
          setFinanceImportBusy(false);
        }
      }
    }

    _unsubs.forEach((fn) => { try { fn(); } catch {} });
    _unsubs = [];
    _financeSyncStarted = false;
    await startFinanceSyncOnce();
    renderFinancesPage();
    alert('✅ Firebase подключён. Финансы синхронизируются в облаке.');
  }

  async function clearAllFinanceShipments() {
    const count = financeState.shipments.length;
    if (!count) {
      alert('Нет отгрузок для удаления.');
      return;
    }

    if (!confirm(`⚠️ Шаг 1 из 3\n\nУдалить ВСЕ ${count} отгрузок из раздела «Финансы»?`)) return;
    if (!confirm(`⚠️ Шаг 2 из 3\n\nВы точно уверены?\nБудут удалены все ${count} записей. Восстановить будет нельзя.`)) return;

    const typed = prompt(`⚠️ Шаг 3 из 3\n\nЧтобы удалить всё, введите слово:\nУДАЛИТЬ`);
    if (String(typed || '').trim().toUpperCase() !== 'УДАЛИТЬ') {
      alert('Отменено — слово не совпало.');
      return;
    }

    const ids = financeState.shipments.map((s) => s.id).filter(Boolean);
    setFinanceImportBusy(true, `Удаление ${count} отгрузок...`);
    try {
      await bulkWriteFinanceDocs(COL.shipments, [], ids);
      financeState.shipments = [];
      if (financeStoreMode === 'local') persistLocalFinanceData();
      renderFinancesPage();
      alert(`✅ Удалено ${count} отгрузок.`);
    } catch (err) {
      alert(err?.message || 'Ошибка удаления');
    } finally {
      setFinanceImportBusy(false);
    }
  }

  async function clearAllFinancePayments() {
    const count = financeState.payments.length;
    if (!count) {
      alert('Нет выплат для удаления.');
      return;
    }

    if (!confirm(`⚠️ Шаг 1 из 3\n\nУдалить ВСЕ ${count} выплат из раздела «Финансы»?`)) return;
    if (!confirm(`⚠️ Шаг 2 из 3\n\nВы точно уверены?\nБудут удалены все ${count} записей. Восстановить будет нельзя.`)) return;

    const typed = prompt(`⚠️ Шаг 3 из 3\n\nЧтобы удалить всё, введите слово:\nУДАЛИТЬ`);
    if (String(typed || '').trim().toUpperCase() !== 'УДАЛИТЬ') {
      alert('Отменено — слово не совпало.');
      return;
    }

    const ids = financeState.payments.map((p) => p.id).filter(Boolean);
    setFinanceImportBusy(true, `Удаление ${count} выплат...`);
    try {
      await bulkWriteFinanceDocs(COL.payments, [], ids);
      financeState.payments = [];
      if (financeStoreMode === 'local') persistLocalFinanceData();
      renderFinancesPage();
      alert(`✅ Удалено ${count} выплат.`);
    } catch (err) {
      alert(err?.message || 'Ошибка удаления');
    } finally {
      setFinanceImportBusy(false);
    }
  }

  function startFinanceRealtimeSync() {
    const database = getDb();
    if (!database) return;
    _unsubs.forEach(fn => { try { fn(); } catch {} });
    _unsubs = [];

    const cols = [
      { key: 'payments', col: COL.payments, stateKey: 'payments' },
      { key: 'shipments', col: COL.shipments, stateKey: 'shipments' },
      { key: 'snapshots', col: COL.snapshots, stateKey: 'snapshots' },
      { key: 'stock', col: COL.stock, stateKey: 'stock' }
    ];

    let readyCount = 0;
    cols.forEach(({ col, stateKey }) => {
      const unsub = database.collection(col)
        .onSnapshot(snap => {
          const next = [];
          snap.forEach(doc => {
            const data = doc.data() || {};
            next.push({ ...data, id: data.id || doc.id });
          });
          financeState[stateKey] = next;
          readyCount++;
          if (readyCount >= 1) financeState.loading = false;
          if (financeState.importInProgress) return;
          if (document.getElementById('finances-tab')?.classList.contains('active')) {
            renderFinancesPage();
          }
        }, err => console.error(`finance onSnapshot ${col}:`, err));
      _unsubs.push(unsub);
    });
  }

  // ── CRUD helpers ─────────────────────────────────────────────

  function buildPaymentRecord(data, id) {
    return {
      id: id || genId(),
      marketplace_id: MP_ID,
      payment_date: data.payment_date || null,
      amount: Number(data.amount) || 0,
      request_number: data.request_number || null,
      status: data.status || 'completed',
      period_from: data.period_from || null,
      period_to: data.period_to || null,
      notes: data.notes || null,
      created_at: data.created_at || new Date().toISOString()
    };
  }

  function buildShipmentRecord(data, id) {
    const qty = Number(data.quantity) || 0;
    const unitPrice = data.unit_price != null && data.unit_price !== '' ? Number(data.unit_price) : null;
    const total = data.total_amount != null && data.total_amount !== ''
      ? Number(data.total_amount)
      : (unitPrice != null ? qty * unitPrice : 0);
    const article = String(data.article_code || '').trim();
    if (!article) throw new Error('Пустой артикул');
    const shipmentDate = toIsoDate(data.shipment_date);
    if (!shipmentDate) throw new Error(`Некорректная дата для «${article}»`);
    return {
      id: id || genId(),
      marketplace_id: MP_ID,
      shipment_date: shipmentDate,
      article_code: article,
      description: data.description || '',
      quantity: qty,
      unit_price: unitPrice,
      total_amount: total,
      status: data.status || 'accepted',
      notes: data.notes || null,
      created_at: data.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  function buildSnapshotRecord(data) {
    const total = Number(data.total_balance) || 0;
    const next = Number(data.next_payout_amount) || 0;
    return {
      id: data.id || genId(),
      marketplace_id: MP_ID,
      snapshot_date: toIsoDate(data.snapshot_date),
      total_balance: total,
      next_payout_amount: next,
      next_payout_date: data.next_payout_date ? toIsoDate(data.next_payout_date) : null,
      next_payout_period_from: data.next_payout_period_from ? toIsoDate(data.next_payout_period_from) : null,
      next_payout_period_to: data.next_payout_period_to ? toIsoDate(data.next_payout_period_to) : null,
      remaining_balance: data.remaining_balance != null && data.remaining_balance !== ''
        ? Number(data.remaining_balance)
        : total - next,
      notes: data.notes || null,
      created_at: data.created_at || new Date().toISOString()
    };
  }

  async function savePayment(data, id, options = {}) {
    const rec = buildPaymentRecord(data, id);
    const ok = await upsertDoc(COL.payments, rec, { strict: !!options.strict });
    if (!options.skipRender) renderFinancesPage();
    return ok;
  }

  async function saveShipment(data, id, options = {}) {
    const rec = buildShipmentRecord(data, id);
    const ok = await upsertDoc(COL.shipments, rec, { strict: !!options.strict });
    if (!options.skipRender) renderFinancesPage();
    return ok;
  }

  async function saveSnapshot(data, options = {}) {
    const rec = buildSnapshotRecord(data);
    const ok = await upsertDoc(COL.snapshots, rec, { strict: !!options.strict });
    if (!options.skipRender) renderFinancesPage();
    return ok;
  }

  async function importStockReport(snapshotDate, rows) {
    const date = toIsoDate(snapshotDate);
    const existingIds = financeState.stock.filter((s) => s.snapshot_date === date).map((s) => s.id);
    const oldDates = getStockSnapshotDates();
    const prevDateBeforeImport = oldDates.includes(date)
      ? getPreviousStockDate(date)
      : (oldDates[0] || null);
    const uploadedAt = new Date().toISOString();
    const records = rows
      .map((r) => buildStockRecordFromRow(r, date, uploadedAt))
      .filter(Boolean);

    if (!records.length) {
      throw new Error(
        `В файле не найдено товаров для загрузки (0 строк с ID). Строк в отчёте: ${rows.length}.`
      );
    }

    setFinanceImportBusy(true, `Загрузка остатков: ${records.length} позиций...`);
    try {
      const prevTotals = prevDateBeforeImport
        ? calcStockTotals(getStockRowsByDate(prevDateBeforeImport))
        : null;
      await bulkWriteFinanceDocs(COL.stock, records, existingIds);
      financeState.stock = [
        ...financeState.stock.filter((s) => s.snapshot_date !== date),
        ...records
      ];
      financeState.stockViewDate = '';
      renderFinancesPage();
      const totals = calcStockTotals(records);
      return {
        count: records.length,
        date,
        prevDate: prevDateBeforeImport,
        delta: prevTotals ? {
          qtyInSale: totals.qtyInSale - prevTotals.qtyInSale,
          saleSum: totals.saleSum - prevTotals.saleSum,
          costSum: totals.costSum - prevTotals.costSum
        } : null
      };
    } finally {
      setFinanceImportBusy(false);
    }
  }

  // ── Import / Export ──────────────────────────────────────────

  const FIN_SHIPMENT_COLS = [
    'Дата', 'Артикул', 'Описание', 'Кол-во, шт', 'Отп. цена, сум',
    'Сумма (отп.цена), сум', 'Статус', 'Примечание'
  ];
  const FIN_PAYMENT_COLS = [
    'Дата', 'Сумма, сум', 'Период (с)', 'Период (по)', 'Номер запроса', 'Статус', 'Примечание'
  ];
  const FIN_SNAPSHOT_COLS = [
    'Дата снимка', 'Общий баланс, сум', 'К выплате, сум', 'Дата выплаты',
    'Период (с)', 'Период (по)', 'Остаток после выплаты, сум', 'Примечание'
  ];

  function downloadFinanceWorkbook(filename, sheets) {
    const wb = XLSX.utils.book_new();
    sheets.forEach(({ name, sheet }) => XLSX.utils.book_append_sheet(wb, sheet, name));
    XLSX.writeFile(wb, filename);
  }

  function sheetFromRows(columns, rows, colWidths) {
    const ws = rows.length
      ? XLSX.utils.json_to_sheet(rows, { header: columns })
      : XLSX.utils.aoa_to_sheet([columns]);
    if (colWidths?.length) ws['!cols'] = colWidths.map(wch => ({ wch }));
    return ws;
  }

  function hintsSheet(rows) {
    const ws = XLSX.utils.aoa_to_sheet([['Столбец', 'Описание', 'Пример / допустимые значения'], ...rows]);
    ws['!cols'] = [{ wch: 22 }, { wch: 52 }, { wch: 36 }];
    return ws;
  }

  function shipmentRowFromRecord(s) {
    return {
      'Дата': fmtDateRu(s.shipment_date) || '',
      'Артикул': s.article_code || '',
      'Описание': s.description || '',
      'Кол-во, шт': s.quantity ?? '',
      'Отп. цена, сум': s.unit_price ?? '',
      'Сумма (отп.цена), сум': s.total_amount ?? '',
      'Статус': s.status || 'in_sale',
      'Примечание': s.notes || ''
    };
  }

  function paymentRowFromRecord(p) {
    return {
      'Дата': p.payment_date ? fmtDateRu(p.payment_date) : '',
      'Сумма, сум': p.amount ?? '',
      'Период (с)': p.period_from ? fmtDateRu(p.period_from) : '',
      'Период (по)': p.period_to ? fmtDateRu(p.period_to) : '',
      'Номер запроса': p.request_number || '',
      'Статус': p.status || 'completed',
      'Примечание': p.notes || ''
    };
  }

  function isExampleImportRow(article, extraValues) {
    const a = String(article || '').trim().toLowerCase();
    if (a.startsWith('пример') || a.startsWith('example')) return true;
    return (extraValues || []).some((v) => {
      const s = String(v ?? '').trim().toLowerCase();
      return s.includes('удалите эту строк') || s.includes('образец заполн');
    });
  }

  function normalizeFinanceStatus(value, kind) {
    const s = String(value ?? '').trim().toLowerCase();
    if (!s) return kind === 'payment' ? 'completed' : 'in_sale';
    if (kind === 'payment') {
      if (s === 'completed' || s.includes('исполнен')) return 'completed';
      if (s === 'pending' || s.includes('ожида')) return 'pending';
      if (s === 'rejected' || s.includes('отклон')) return 'rejected';
      return s;
    }
    if (s === 'in_transit' || s.includes('пути')) return 'in_transit';
    if (s === 'accepted' || s.includes('принят')) return 'accepted';
    if (s === 'in_sale' || s.includes('продаже')) return 'in_sale';
    if (s === 'sold_out' || s.includes('распрод')) return 'sold_out';
    return s;
  }

  function normalizeHeaderKey(key) {
    return String(key || '')
      .replace(/\ufeff/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/ё/g, 'е');
  }

  function rowLookup(row) {
    const lookup = Object.create(null);
    Object.keys(row || {}).forEach((k) => {
      lookup[normalizeHeaderKey(k)] = row[k];
    });
    return lookup;
  }

  function pickCell(row, aliases) {
    const lookup = row.__lookup || rowLookup(row);
    for (const alias of aliases) {
      const key = normalizeHeaderKey(alias);
      const val = lookup[key];
      if (val !== undefined && val !== null && String(val).trim() !== '') return val;
    }
    return null;
  }

  function readFinanceWorkbook(buffer) {
    return XLSX.read(buffer, { type: 'array', cellDates: true });
  }

  function findFinanceDataSheet(wb, preferredPatterns) {
    const skip = /как заполн|подсказ|readme|инструк|сводк/i;
    const names = (wb.SheetNames || []).filter((n) => !skip.test(String(n)));
    for (const pattern of preferredPatterns) {
      const hit = names.find((n) => pattern.test(String(n)));
      if (hit) return { name: hit, sheet: wb.Sheets[hit] };
    }
    const fallbackName = names[0] || wb.SheetNames[0];
    return { name: fallbackName, sheet: wb.Sheets[fallbackName] };
  }

  function sheetRowsToObjects(ws) {
    if (!ws) return { rows: [], headers: [] };
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const headers = rows.length ? Object.keys(rows[0]) : [];
    if (!headers.length) {
      const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const headerRow = (matrix[0] || []).map((c) => String(c || '').trim()).filter(Boolean);
      return { rows: [], headers: headerRow };
    }
    return { rows, headers };
  }

  function buildImportFailureMessage(kind, headers, totalRows) {
    const expected = kind === 'shipments'
      ? 'Дата, Артикул, Кол-во, шт (обязательные)'
      : kind === 'payments'
        ? 'Сумма, сум (обязательная)'
        : 'Дата снимка, Общий баланс, сум';
    const found = headers.length ? headers.join(' | ') : 'столбцы не найдены';
    return [
      'Не удалось импортировать ни одной строки.',
      '',
      `Строк в файле: ${totalRows}`,
      `Найденные столбцы: ${found}`,
      `Нужны столбцы: ${expected}`,
      '',
      'Скачайте «Шаблон», заполняйте лист с данными (не лист «Как заполнять»).',
      'Дата: 15.06.2026 (день.месяц.год). Суммы — только числа.'
    ].join('\n');
  }

  async function runFinanceImport(kind, buffer) {
    await initFinanceStorage();

    const parsed = kind === 'shipments'
      ? parseShipmentsImport(buffer)
      : kind === 'payments'
        ? parsePaymentsImport(buffer)
        : parseSnapshotsImport(buffer);

    if (!parsed.rows.length) {
      throw new Error(buildImportFailureMessage(kind, parsed.headers, parsed.totalRows));
    }

    const meta = {
      shipments: { col: COL.shipments, stateKey: 'shipments', build: buildShipmentRecord, label: 'отгрузок' },
      payments: { col: COL.payments, stateKey: 'payments', build: buildPaymentRecord, label: 'выплат' },
      snapshots: { col: COL.snapshots, stateKey: 'snapshots', build: buildSnapshotRecord, label: 'снимков баланса' }
    }[kind];

    const records = [];
    const errors = [];
    parsed.rows.forEach((row, i) => {
      try {
        records.push(meta.build(row));
      } catch (err) {
        errors.push(`Строка ${i + 2}: ${err?.message || err}`);
      }
    });

    if (!records.length) {
      throw new Error(`Ни одна строка не подошла для импорта.\n\n${errors.slice(0, 8).join('\n')}`);
    }

    setFinanceImportBusy(true, `Импорт ${records.length} ${meta.label}...`);
    let usedLocalFallback = false;
    try {
      await bulkWriteFinanceDocs(meta.col, records);
      usedLocalFallback = financeStoreMode === 'local';
    } finally {
      setFinanceImportBusy(false);
    }
    renderFinancesPage();

    if (errors.length) {
      alert(`✅ Импортировано: ${records.length} из ${parsed.rows.length}.${usedLocalFallback ? '\n\nСохранено локально в браузере (Firebase без прав).' : ''}\n\nПропущено:\n${errors.slice(0, 8).join('\n')}`);
    } else if (usedLocalFallback) {
      alert(`✅ Импортировано ${records.length} ${meta.label}.\n\nСохранено локально в браузере — в Firebase нет прав на запись.`);
    } else {
      alert(`✅ Импортировано ${records.length} ${meta.label}`);
    }
    return records.length;
  }

  function parseUzumStockReport(buffer) {
    const wb = readFinanceWorkbook(buffer);
    const sheetName = wb.SheetNames.find((n) => /остаток|остат|left-out|stock/i.test(String(n)))
      ?? wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!matrix.length) return [];

    const headerIdx = matrix.findIndex((row) => {
      const cells = (row || []).map((c) => normalizeHeaderKey(c));
      return cells.includes('id') && (cells.includes('наименование') || cells.includes('sku'));
    });
    if (headerIdx < 0) {
      throw new Error(
        'Не найдена строка заголовков (ID, Наименование…) в отчёте Uzum. Скачайте «Остатки» из ЛК → Склад.'
      );
    }

    const headers = (matrix[headerIdx] || []).map((h) => String(h || '').trim());
    const rows = [];
    for (let i = headerIdx + 1; i < matrix.length; i += 1) {
      const line = matrix[i];
      if (!line || !line.some((c) => String(c ?? '').trim() !== '')) continue;
      const obj = {};
      headers.forEach((header, idx) => {
        if (!header) return;
        obj[header] = line[idx] ?? '';
      });
      obj.__lookup = rowLookup(obj);
      rows.push(obj);
    }
    return rows;
  }

  function buildStockRecordFromRow(r, date, uploadedAt) {
    const uzumId = pickCell(r, ['ID', 'Id']);
    if (!hasCellValue(uzumId)) return null;
    return {
      id: genId(),
      marketplace_id: MP_ID,
      snapshot_date: date,
      uzum_id: String(uzumId).replace(/\.0$/, ''),
      product_name: String(pickCell(r, ['Наименование', 'Товар']) || ''),
      sku: pickCell(r, ['SKU', 'Sku']) || null,
      barcode: pickCell(r, ['Штрихкод', 'Barcode']) || null,
      product_id: pickCell(r, ['ID товара', 'Product id']) ? String(pickCell(r, ['ID товара', 'Product id'])).replace(/\.0$/, '') : null,
      qty_for_dispatch: Number(pickCell(r, ['К отправке']) ?? 0),
      qty_in_sale: Number(pickCell(r, ['В продаже']) ?? 0),
      qty_return: Number(pickCell(r, ['Возврат']) ?? 0),
      qty_defect: Number(pickCell(r, ['Брак']) ?? 0),
      cost_price: parseFinanceNumber(pickCell(r, ['Себест. (сумы)', 'Себест. (сумы)'])) ,
      sale_price: parseFinanceNumber(pickCell(r, ['Стоимость продажи (сумы)'])),
      total_qty: Number(pickCell(r, ['Общий остаток']) ?? 0),
      total_sale_sum: parseFinanceNumber(pickCell(r, ['Стоимость продажи (сумма) (сумы)'])),
      total_cost_sum: parseFinanceNumber(pickCell(r, ['Себест. (сумма) (сумы)'])),
      status: pickCell(r, ['Статус']) || null,
      uploaded_at: uploadedAt,
      created_at: uploadedAt
    };
  }

  function parseShipmentsImport(buffer) {
    const wb = readFinanceWorkbook(buffer);
    const { sheet } = findFinanceDataSheet(wb, [/отгруз/i, /shipment/i, /data/i]);
    const { rows: rawRows, headers } = sheetRowsToObjects(sheet);
    const rows = [];

    rawRows.forEach((row) => {
      row.__lookup = rowLookup(row);
      const article = String(pickCell(row, ['Артикул', 'Артикул 1С', 'Код', 'SKU', 'article']) || '').trim();
      const dateRaw = pickCell(row, ['Дата', 'Дата отгрузки', 'date']);
      if (!article || !hasCellValue(dateRaw)) return;
      if (isExampleImportRow(article, [pickCell(row, ['Описание']), pickCell(row, ['Примечание'])])) return;

      const qty = parseFinanceNumber(pickCell(row, ['Кол-во, шт', 'Кол-во', 'Количество', 'Qty', 'Quantity'])) || 0;
      const unitPrice = parseFinanceNumber(pickCell(row, ['Отп. цена, сум', 'Отп. цена', 'Цена', 'Unit price']));
      const totalRaw = pickCell(row, ['Сумма (отп.цена), сум', 'Сумма (отп.цена)', 'Сумма', 'Итого']);
      const total = parseFinanceNumber(totalRaw) ?? (unitPrice != null ? qty * unitPrice : 0);

      rows.push({
        shipment_date: toIsoDate(dateRaw),
        article_code: article,
        description: String(pickCell(row, ['Описание', 'Товар', 'Наименование']) || ''),
        quantity: qty,
        unit_price: unitPrice,
        total_amount: total,
        status: normalizeFinanceStatus(pickCell(row, ['Статус', 'Status']), 'shipment'),
        notes: pickCell(row, ['Примечание', 'Комментарий']) || null
      });
    });

    return { rows, headers, totalRows: rawRows.length };
  }

  function parsePaymentsImport(buffer) {
    const wb = readFinanceWorkbook(buffer);
    const { sheet } = findFinanceDataSheet(wb, [/выплат/i, /payment/i, /data/i]);
    const { rows: rawRows, headers } = sheetRowsToObjects(sheet);
    const rows = [];

    rawRows.forEach((row) => {
      row.__lookup = rowLookup(row);
      const amountRaw = pickCell(row, ['Сумма, сум', 'Сумма', 'Amount', 'amount']);
      const amount = parseFinanceNumber(amountRaw);
      if (amount == null) return;
      if (isExampleImportRow(null, [
        pickCell(row, ['Дата']),
        pickCell(row, ['Номер запроса', 'Запрос']),
        pickCell(row, ['Примечание'])
      ])) return;

      const dateRaw = pickCell(row, ['Дата', 'Date']);
      rows.push({
        payment_date: dateRaw && String(dateRaw).trim() !== '—' ? toIsoDate(dateRaw) : null,
        amount,
        period_from: pickCell(row, ['Период (с)', 'Период с', 'Period from']) ? toIsoDate(pickCell(row, ['Период (с)', 'Период с', 'Period from'])) : null,
        period_to: pickCell(row, ['Период (по)', 'Период по', 'Period to']) ? toIsoDate(pickCell(row, ['Период (по)', 'Период по', 'Period to'])) : null,
        request_number: pickCell(row, ['Номер запроса', 'Запрос', 'Request']) || null,
        status: normalizeFinanceStatus(pickCell(row, ['Статус', 'Status']), 'payment'),
        notes: pickCell(row, ['Примечание', 'Комментарий']) || null
      });
    });

    return { rows, headers, totalRows: rawRows.length };
  }

  function parseSnapshotsImport(buffer) {
    const wb = readFinanceWorkbook(buffer);
    const { sheet } = findFinanceDataSheet(wb, [/баланс/i, /snapshot/i, /сводк/i]);
    const { rows: rawRows, headers } = sheetRowsToObjects(sheet);
    const rows = rawRows
      .filter((row) => {
        row.__lookup = rowLookup(row);
        const date = pickCell(row, ['Дата снимка', 'Дата', 'Snapshot date']);
        const total = parseFinanceNumber(pickCell(row, ['Общий баланс, сум', 'Общий баланс', 'Баланс']));
        return hasCellValue(date) && total != null;
      })
      .map((row) => ({
        snapshot_date: toIsoDate(pickCell(row, ['Дата снимка', 'Дата', 'Snapshot date'])),
        total_balance: parseFinanceNumber(pickCell(row, ['Общий баланс, сум', 'Общий баланс', 'Баланс'])) || 0,
        next_payout_amount: parseFinanceNumber(pickCell(row, ['К выплате, сум', 'К выплате', 'Next payout'])) || 0,
        next_payout_date: pickCell(row, ['Дата выплаты', 'Дата следующей выплаты']) ? toIsoDate(pickCell(row, ['Дата выплаты', 'Дата следующей выплаты'])) : null,
        next_payout_period_from: pickCell(row, ['Период (с)', 'Период с']) ? toIsoDate(pickCell(row, ['Период (с)', 'Период с'])) : null,
        next_payout_period_to: pickCell(row, ['Период (по)', 'Период по']) ? toIsoDate(pickCell(row, ['Период (по)', 'Период по'])) : null,
        remaining_balance: parseFinanceNumber(pickCell(row, ['Остаток после выплаты, сум', 'Остаток после выплаты', 'Остаток'])),
        notes: pickCell(row, ['Примечание', 'Комментарий']) || null
      }));

    return { rows, headers, totalRows: rawRows.length };
  }

  function exportShipmentsTemplate() {
    const blankRows = Array.from({ length: 5 }, () => (
      Object.fromEntries(FIN_SHIPMENT_COLS.map((col) => [col, '']))
    ));
    downloadFinanceWorkbook(`shablon_otgruzki_${exportDateSuffix()}.xlsx`, [
      {
        name: 'Отгрузки',
        sheet: sheetFromRows(FIN_SHIPMENT_COLS, blankRows, [12, 14, 28, 10, 14, 18, 12, 24])
      },
      {
        name: 'Как заполнять',
        sheet: hintsSheet([
          ['Дата', 'Дата отгрузки на склад Uzum', '15.06.2026'],
          ['Артикул', 'Артикул 1С / внутренний код', 'НВ-50-70-бел'],
          ['Описание', 'Название товара (необязательно)', 'Наволочка 50×70'],
          ['Кол-во, шт', 'Количество штук', '24'],
          ['Отп. цена, сум', 'Отпускная цена за 1 шт', '85000'],
          ['Сумма (отп.цена), сум', 'Итого по строке', '2040000'],
          ['Статус', 'in_transit | accepted | in_sale | sold_out', 'in_sale'],
          ['Примечание', 'Любой комментарий', '']
        ])
      }
    ]);
  }

  function exportPaymentsTemplate() {
    const blankRows = Array.from({ length: 5 }, () => (
      Object.fromEntries(FIN_PAYMENT_COLS.map((col) => [col, '']))
    ));
    downloadFinanceWorkbook(`shablon_vyplaty_${exportDateSuffix()}.xlsx`, [
      {
        name: 'Выплаты',
        sheet: sheetFromRows(FIN_PAYMENT_COLS, blankRows, [12, 14, 12, 12, 18, 12, 28])
      },
      {
        name: 'Как заполнять',
        sheet: hintsSheet([
          ['Дата', 'Дата поступления на р/с', '09.06.2026'],
          ['Сумма, сум', 'Сумма выплаты в сумах', '18114131'],
          ['Период (с)', 'Начало отчётного периода Uzum', '27.05.2026'],
          ['Период (по)', 'Конец отчётного периода', '10.06.2026'],
          ['Номер запроса', 'Номер заявки в ЛК', '#5000169479'],
          ['Статус', 'completed | pending | rejected (или Исполнен/Ожидается/Отклонён)', 'completed'],
          ['Примечание', 'Комментарий', '']
        ])
      }
    ]);
  }

  function exportSnapshotsTemplate() {
    downloadFinanceWorkbook(`shablon_balans_lk_${exportDateSuffix()}.xlsx`, [
      {
        name: 'Баланс ЛК',
        sheet: sheetFromRows(FIN_SNAPSHOT_COLS, [
          Object.fromEntries(FIN_SNAPSHOT_COLS.map((col) => [col, '']))
        ], [14, 18, 16, 14, 12, 12, 22, 24])
      },
      {
        name: 'Как заполнять',
        sheet: hintsSheet([
          ['Дата снимка', 'Когда смотрели баланс в ЛК Uzum', '16.06.2026'],
          ['Общий баланс, сум', '«Всего к выплате» в личном кабинете', '98967558'],
          ['К выплате, сум', 'Сумма ближайшей выплаты', '31740152'],
          ['Дата выплаты', 'Дата ближайшей выплаты', '21.06.2026'],
          ['Период (с)', 'Период ближайшей выплаты — начало', '27.05.2026'],
          ['Период (по)', 'Период ближайшей выплаты — конец', '10.06.2026'],
          ['Остаток после выплаты, сум', 'Остаток «следующие периоды» (если пусто — посчитается)', '67227406']
        ])
      }
    ]);
  }

  function exportShipmentsToExcel() {
    const rows = financeState.shipments
      .slice()
      .sort((a, b) => new Date(b.shipment_date).getTime() - new Date(a.shipment_date).getTime())
      .map(shipmentRowFromRecord);
    downloadFinanceWorkbook(`otgruzki_${exportDateSuffix()}.xlsx`, [
      { name: 'Отгрузки', sheet: sheetFromRows(FIN_SHIPMENT_COLS, rows, [12, 14, 28, 10, 14, 18, 12, 24]) }
    ]);
  }

  function exportPaymentsToExcel() {
    const rows = financeState.payments
      .slice()
      .sort((a, b) => {
        if (!a.payment_date) return 1;
        if (!b.payment_date) return -1;
        return new Date(a.payment_date).getTime() - new Date(b.payment_date).getTime();
      })
      .map(paymentRowFromRecord);
    downloadFinanceWorkbook(`vyplaty_${exportDateSuffix()}.xlsx`, [
      { name: 'Выплаты', sheet: sheetFromRows(FIN_PAYMENT_COLS, rows, [12, 14, 12, 12, 18, 12, 28]) }
    ]);
  }

  function exportSnapshotsToExcel() {
    const rows = financeState.snapshots
      .slice()
      .sort((a, b) => new Date(b.snapshot_date).getTime() - new Date(a.snapshot_date).getTime())
      .map(s => ({
        'Дата снимка': fmtDateRu(s.snapshot_date) || '',
        'Общий баланс, сум': s.total_balance ?? '',
        'К выплате, сум': s.next_payout_amount ?? '',
        'Дата выплаты': s.next_payout_date ? fmtDateRu(s.next_payout_date) : '',
        'Период (с)': s.next_payout_period_from ? fmtDateRu(s.next_payout_period_from) : '',
        'Период (по)': s.next_payout_period_to ? fmtDateRu(s.next_payout_period_to) : '',
        'Остаток после выплаты, сум': s.remaining_balance ?? '',
        'Примечание': s.notes || ''
      }));
    downloadFinanceWorkbook(`balans_lk_${exportDateSuffix()}.xlsx`, [
      { name: 'Баланс ЛК', sheet: sheetFromRows(FIN_SNAPSHOT_COLS, rows, [14, 18, 16, 14, 12, 12, 22, 24]) }
    ]);
  }

  function exportStockToExcel() {
    const stock = getLatestStockRows();
    const cols = [
      'ID', 'Наименование', 'SKU', 'Штрихкод', 'ID товара',
      'К отправке', 'В продаже', 'Возврат', 'Брак',
      'Себест. (сумы)', 'Стоимость продажи (сумы)',
      'Общий остаток', 'Стоимость продажи (сумма) (сумы)',
      'Себест. (сумма) (сумы)', 'Статус'
    ];
    const rows = stock.map(s => ({
      'ID': s.uzum_id || '',
      'Наименование': s.product_name || '',
      'SKU': s.sku || '',
      'Штрихкод': s.barcode || '',
      'ID товара': s.product_id || '',
      'К отправке': s.qty_for_dispatch ?? 0,
      'В продаже': s.qty_in_sale ?? 0,
      'Возврат': s.qty_return ?? 0,
      'Брак': s.qty_defect ?? 0,
      'Себест. (сумы)': s.cost_price ?? '',
      'Стоимость продажи (сумы)': s.sale_price ?? '',
      'Общий остаток': s.total_qty ?? 0,
      'Стоимость продажи (сумма) (сумы)': s.total_sale_sum ?? '',
      'Себест. (сумма) (сумы)': s.total_cost_sum ?? '',
      'Статус': s.status || ''
    }));
    downloadFinanceWorkbook(`ostatki_${fmtDateRu(stock[0]?.snapshot_date || new Date().toISOString().slice(0, 10)).replace(/\./g, '-')}.xlsx`, [
      { name: 'Остатки', sheet: sheetFromRows(cols, rows, [10, 32, 14, 16, 12, 12, 12, 10, 10, 14, 18, 14, 22, 18, 14]) }
    ]);
  }

  function exportFullReport() {
    const summary = calculateSummary();
    const stock = getLatestStockRows();
    const shipmentRows = financeState.shipments
      .slice()
      .sort((a, b) => new Date(b.shipment_date).getTime() - new Date(a.shipment_date).getTime())
      .map(shipmentRowFromRecord);
    const paymentRows = financeState.payments
      .slice()
      .sort((a, b) => {
        if (!a.payment_date) return 1;
        if (!b.payment_date) return -1;
        return new Date(a.payment_date).getTime() - new Date(b.payment_date).getTime();
      })
      .map(paymentRowFromRecord);
    const stockCols = ['Товар', 'SKU', 'В продаже', 'К отправке', 'Цена прод., сум', 'Итого по цене прод., сум', 'Статус'];
    const stockRows = stock.map(s => ({
      'Товар': s.product_name,
      'SKU': s.sku ?? '',
      'В продаже': s.qty_in_sale,
      'К отправке': s.qty_for_dispatch,
      'Цена прод., сум': s.sale_price ?? '',
      'Итого по цене прод., сум': s.total_sale_sum ?? '',
      'Статус': s.status ?? ''
    }));

    const summaryRows = [
      ['Показатель', 'Сумма, сум', 'Примечание'],
      ['Получено на расчётный счёт', summary.totalReceived, `${summary.paymentsCount} выплат`],
      ['В ЛК Узума (гарантировано)', summary.lkTotalBalance, `снимок от ${summary.lastSnapshotDate || '—'}`],
      ['  → к выплате ближайшей датой', summary.lkNextPayout, summary.lkNextPayoutDate ?? ''],
      ['  → следующие периоды', summary.lkRemainingBalance, ''],
      ['На складе в продаже', summary.stockInSaleQty, 'шт, без суммы — это не выплата'],
      ['ИТОГО ВСЕГО', summary.grandTotal, '= получено + доступно к выводу в ЛК']
    ];

    downloadFinanceWorkbook(`finansy_uzum_${exportDateSuffix()}.xlsx`, [
      { name: 'Сводка', sheet: XLSX.utils.aoa_to_sheet(summaryRows) },
      { name: 'Отгрузки', sheet: sheetFromRows(FIN_SHIPMENT_COLS, shipmentRows) },
      { name: 'Выплаты', sheet: sheetFromRows(FIN_PAYMENT_COLS, paymentRows) },
      { name: 'Остатки склад', sheet: sheetFromRows(stockCols, stockRows) }
    ]);
  }

  // ── Modals ───────────────────────────────────────────────────

  function showModal(title, bodyHtml, onSave) {
    let overlay = document.getElementById('financeModalOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'financeModalOverlay';
      overlay.className = 'finance-modal-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="finance-modal card" role="dialog" aria-modal="true">
        <div class="finance-modal-header">
          <h3>${escapeHtml(title)}</h3>
          <button type="button" class="finance-modal-close" aria-label="Закрыть">✕</button>
        </div>
        <div class="finance-modal-body">${bodyHtml}</div>
        <div class="finance-modal-footer">
          <button type="button" class="btn-secondary finance-modal-cancel">Отмена</button>
          <button type="button" class="btn-primary finance-modal-save">Сохранить</button>
        </div>
      </div>`;
    overlay.classList.add('active');
    bindDateInputMask(overlay);
    const close = () => overlay.classList.remove('active');
    overlay.querySelector('.finance-modal-close').onclick = close;
    overlay.querySelector('.finance-modal-cancel').onclick = close;
    overlay.onclick = e => { if (e.target === overlay) close(); };
    overlay.querySelector('.finance-modal-save').onclick = async () => {
      try {
        await onSave(overlay);
        close();
      } catch (err) {
        alert(err?.message || 'Ошибка сохранения');
      }
    };
  }

  function askFinanceDate(title, hint, defaultValue) {
    return new Promise((resolve) => {
      let overlay = document.getElementById('financeModalOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'financeModalOverlay';
        overlay.className = 'finance-modal-overlay';
        document.body.appendChild(overlay);
      }
      const defaultRu = defaultValue ? fmtDateRu(defaultValue) : '';
      overlay.innerHTML = `
        <div class="finance-modal card" role="dialog" aria-modal="true">
          <div class="finance-modal-header">
            <h3>${escapeHtml(title)}</h3>
            <button type="button" class="finance-modal-close" aria-label="Закрыть">✕</button>
          </div>
          <div class="finance-modal-body">
            <p class="sub">${escapeHtml(hint)}</p>
            <label class="finance-date-field">Дата
              <input type="text" class="fin-date-input" id="finPromptDate" placeholder="07062024" value="${escapeAttr(defaultRu)}" />
            </label>
            <p class="finance-date-hint">Только цифры — формат дд.мм.гггг подставится сам</p>
          </div>
          <div class="finance-modal-footer">
            <button type="button" class="btn-secondary finance-modal-cancel">Отмена</button>
            <button type="button" class="btn-primary finance-modal-save">OK</button>
          </div>
        </div>`;
      const close = (result) => {
        overlay.classList.remove('active');
        resolve(result);
      };
      overlay.querySelector('.finance-modal-close').onclick = () => close(null);
      overlay.querySelector('.finance-modal-cancel').onclick = () => close(null);
      overlay.onclick = (e) => { if (e.target === overlay) close(null); };
      overlay.querySelector('.finance-modal-save').onclick = () => {
        close(overlay.querySelector('#finPromptDate')?.value?.trim() || null);
      };
      bindDateInputMask(overlay);
      overlay.classList.add('active');
      overlay.querySelector('#finPromptDate')?.focus();
    });
  }

  function openPaymentForm(payment) {
    const p = payment || {};
    const today = fmtDateRu(new Date().toISOString().slice(0, 10));
    showModal(p.id ? 'Редактировать выплату' : 'Добавить выплату', `
      <div class="finance-form-grid">
        <label>Дата<input type="text" class="fin-date-input" id="finPayDate" placeholder="07062024" value="${escapeAttr(p.payment_date ? fmtDateRu(p.payment_date) : today)}" /></label>
        <label>Сумма, сум<input type="number" id="finPayAmount" value="${escapeAttr(p.amount ?? '')}" min="0" step="1" /></label>
        <label>Номер запроса<input type="text" id="finPayRequest" value="${escapeAttr(p.request_number || '')}" /></label>
        <label>Статус
          <select id="finPayStatus">
            <option value="completed" ${p.status === 'completed' ? 'selected' : ''}>Исполнен</option>
            <option value="pending" ${p.status === 'pending' ? 'selected' : ''}>Ожидается</option>
            <option value="rejected" ${p.status === 'rejected' ? 'selected' : ''}>Отклонён</option>
          </select>
        </label>
        <label>Период с<input type="text" class="fin-date-input" id="finPayFrom" placeholder="07062024" value="${escapeAttr(p.period_from ? fmtDateRu(p.period_from) : '')}" /></label>
        <label>Период по<input type="text" class="fin-date-input" id="finPayTo" placeholder="07062024" value="${escapeAttr(p.period_to ? fmtDateRu(p.period_to) : '')}" /></label>
        <p class="finance-date-hint finance-form-full">Даты: только цифры, точки подставятся сами</p>
        <label class="finance-form-full">Примечание<textarea id="finPayNotes" rows="2">${escapeHtml(p.notes || '')}</textarea></label>
      </div>`, async () => {
      await savePayment({
        payment_date: toIsoDate(document.getElementById('finPayDate').value) || null,
        amount: document.getElementById('finPayAmount').value,
        request_number: document.getElementById('finPayRequest').value.trim(),
        status: document.getElementById('finPayStatus').value,
        period_from: toIsoDate(document.getElementById('finPayFrom').value) || null,
        period_to: toIsoDate(document.getElementById('finPayTo').value) || null,
        notes: document.getElementById('finPayNotes').value.trim() || null,
        created_at: p.created_at
      }, p.id);
    });
  }

  function openShipmentForm(shipment) {
    const s = shipment || {};
    const today = fmtDateRu(new Date().toISOString().slice(0, 10));
    showModal(s.id ? 'Редактировать отгрузку' : 'Добавить отгрузку', `
      <div class="finance-form-grid">
        <label>Дата<input type="text" class="fin-date-input" id="finShipDate" placeholder="07062024" value="${escapeAttr(s.shipment_date ? fmtDateRu(s.shipment_date) : today)}" /></label>
        <label>Артикул<input type="text" id="finShipArticle" value="${escapeAttr(s.article_code || '')}" /></label>
        <label>Кол-во, шт<input type="number" id="finShipQty" value="${escapeAttr(s.quantity ?? '')}" min="0" /></label>
        <label>Отп. цена, сум<input type="number" id="finShipUnit" value="${escapeAttr(s.unit_price ?? '')}" min="0" step="1" /></label>
        <label>Сумма, сум<input type="number" id="finShipTotal" value="${escapeAttr(s.total_amount ?? '')}" min="0" step="1" /></label>
        <label>Статус
          <select id="finShipStatus">
            <option value="in_transit" ${s.status === 'in_transit' ? 'selected' : ''}>В пути</option>
            <option value="accepted" ${s.status === 'accepted' ? 'selected' : ''}>Принято</option>
            <option value="in_sale" ${s.status === 'in_sale' ? 'selected' : ''}>В продаже</option>
            <option value="sold_out" ${s.status === 'sold_out' ? 'selected' : ''}>Распродано</option>
          </select>
        </label>
        <label class="finance-form-full">Описание<textarea id="finShipDesc" rows="2">${escapeHtml(s.description || '')}</textarea></label>
        <label class="finance-form-full">Примечание<textarea id="finShipNotes" rows="2">${escapeHtml(s.notes || '')}</textarea></label>
        <p class="finance-date-hint finance-form-full">Дата: только цифры, точки подставятся сами</p>
      </div>`, async () => {
      await saveShipment({
        shipment_date: toIsoDate(document.getElementById('finShipDate').value),
        article_code: document.getElementById('finShipArticle').value.trim(),
        description: document.getElementById('finShipDesc').value.trim(),
        quantity: document.getElementById('finShipQty').value,
        unit_price: document.getElementById('finShipUnit').value,
        total_amount: document.getElementById('finShipTotal').value,
        status: document.getElementById('finShipStatus').value,
        notes: document.getElementById('finShipNotes').value.trim() || null,
        created_at: s.created_at
      }, s.id);
    });
  }

  function openSnapshotForm() {
    const snap = getLatestSnapshot() || {};
    showModal('Обновить баланс ЛК Узума', `
      <p class="sub finance-form-hint">Введите данные из личного кабинета Узума. Создаётся новый снимок.</p>
      <div class="finance-form-grid">
        <label>Дата снимка<input type="text" class="fin-date-input" id="finSnapDate" placeholder="07062024" value="${escapeAttr(fmtDateRu(snap.snapshot_date || new Date().toISOString().slice(0, 10)))}" /></label>
        <label>Общий баланс ЛК, сум<input type="number" id="finSnapTotal" value="${escapeAttr(snap.total_balance ?? '')}" min="0" /></label>
        <label>К выплате, сум<input type="number" id="finSnapNext" value="${escapeAttr(snap.next_payout_amount ?? '')}" min="0" /></label>
        <label>Дата выплаты<input type="text" class="fin-date-input" id="finSnapNextDate" placeholder="07062024" value="${escapeAttr(snap.next_payout_date ? fmtDateRu(snap.next_payout_date) : '')}" /></label>
        <label>Период с<input type="text" class="fin-date-input" id="finSnapFrom" placeholder="07062024" value="${escapeAttr(snap.next_payout_period_from ? fmtDateRu(snap.next_payout_period_from) : '')}" /></label>
        <label>Период по<input type="text" class="fin-date-input" id="finSnapTo" placeholder="07062024" value="${escapeAttr(snap.next_payout_period_to ? fmtDateRu(snap.next_payout_period_to) : '')}" /></label>
        <p class="finance-date-hint finance-form-full">Даты: только цифры, точки подставятся сами</p>
        <label class="finance-form-full">Примечание<textarea id="finSnapNotes" rows="2">${escapeHtml(snap.notes || '')}</textarea></label>
      </div>`, async () => {
      await saveSnapshot({
        snapshot_date: toIsoDate(document.getElementById('finSnapDate').value),
        total_balance: document.getElementById('finSnapTotal').value,
        next_payout_amount: document.getElementById('finSnapNext').value,
        next_payout_date: toIsoDate(document.getElementById('finSnapNextDate').value) || null,
        next_payout_period_from: toIsoDate(document.getElementById('finSnapFrom').value) || null,
        next_payout_period_to: toIsoDate(document.getElementById('finSnapTo').value) || null,
        notes: document.getElementById('finSnapNotes').value.trim() || null
      });
    });
  }

  // ── Render ───────────────────────────────────────────────────

  const STATUS_LABELS = {
    completed: '✅ Исполнен', rejected: '❌ Отклонён', pending: '⏳ Ожидается',
    in_transit: 'В пути', accepted: 'Принято', in_sale: 'В продаже', sold_out: 'Распродано'
  };

  function renderSummaryTab(summary) {
    const snap = getLatestSnapshot();
    return `
      ${renderFinanceStorageBanner()}
      <div class="finance-summary-cards">
        <div class="finance-card finance-card--green">
          <div class="finance-card-label">✅ Уже получено</div>
          <div class="finance-card-value">${fmtSum(summary.totalReceived)}</div>
          <div class="finance-card-meta">${summary.paymentsCount} выплат на расчётный счёт</div>
        </div>
        <div class="finance-card finance-card--yellow">
          <div class="finance-card-label">📅 Ближайшая выплата</div>
          <div class="finance-card-value">${fmtSum(summary.lkNextPayout)}</div>
          <div class="finance-card-meta">${summary.lkNextPayoutDate
            ? `на ${fmtDateRu(summary.lkNextPayoutDate)}`
            : 'Обновите снимок баланса ЛК'}</div>
        </div>
        <div class="finance-card finance-card--blue">
          <div class="finance-card-label">💳 Доступно к выводу</div>
          <div class="finance-card-value">${fmtSum(summary.lkAvailableToWithdraw)}</div>
          <div class="finance-card-meta">${summary.lastSnapshotDate
            ? `баланс ЛК на ${fmtDateRu(summary.lastSnapshotDate)}`
            : 'Нет снимка — нажмите «Обновить баланс»'}</div>
        </div>
      </div>
      <div class="finance-grand-total">
        <div>
          <div class="finance-grand-title">ИТОГО ВСЕГО ОТ УЗУМА</div>
          <div class="finance-grand-sub">= Уже получено + доступно к выводу в ЛК Uzum</div>
        </div>
        <div class="finance-grand-value">${fmtSum(summary.grandTotal)}</div>
      </div>
      <div class="finance-warning">
        <strong>Важно:</strong> Отгрузки и остатки на складе — это учёт товара, <strong>не сумма выплат</strong>.
        «Доступно к выводу» — из снимка баланса ЛK Uzum (уже проданное, ждёт выплат).
      </div>
      <div class="card finance-balance-block">
        <div class="finance-block-header">
          <h3>Баланс ЛК Узума</h3>
          <button type="button" class="btn-primary btn-sm" id="finUpdateSnapshotBtn">Обновить баланс</button>
        </div>
        ${snap ? `
          <p class="sub">Последний снимок: <strong>${fmtDateRu(snap.snapshot_date)}</strong></p>
          <table class="finance-table finance-table--compact">
            <tbody>
              <tr><td>Общий баланс</td><td class="text-right"><strong>${fmtSum(snap.total_balance)}</strong></td></tr>
              <tr><td>К выплате ${snap.next_payout_date ? fmtDateRu(snap.next_payout_date) : ''}</td><td class="text-right">${fmtSum(snap.next_payout_amount)}</td></tr>
              <tr><td>Следующие периоды</td><td class="text-right">${fmtSum(snap.remaining_balance)}</td></tr>
            </tbody>
          </table>
        ` : '<p class="empty">Нет снимка баланса. Нажмите «Обновить баланс».</p>'}
      </div>
      <div class="card finance-payout-table-block">
        <h3>Как придут деньги</h3>
        <table class="finance-table">
          <thead><tr>
            <th>Источник</th><th class="text-right">Сумма</th><th>Примечание</th>
          </tr></thead>
          <tbody>
            <tr><td>Получено на р/с</td><td class="text-right">${fmtSum(summary.totalReceived)}</td><td>${summary.paymentsCount} выплат</td></tr>
            <tr><td>Доступно к выводу (ЛК)</td><td class="text-right"><strong>${fmtSum(summary.lkAvailableToWithdraw)}</strong></td><td>снимок ${summary.lastSnapshotDate ? fmtDateRu(summary.lastSnapshotDate) : '—'}</td></tr>
            <tr><td>→ ближайшая выплата</td><td class="text-right">${fmtSum(summary.lkNextPayout)}</td><td>${summary.lkNextPayoutDate ? fmtDateRu(summary.lkNextPayoutDate) : '—'}</td></tr>
            <tr><td>→ следующие периоды</td><td class="text-right">${fmtSum(summary.lkRemainingBalance)}</td><td></td></tr>
            <tr><td>На складе «в продаже»</td><td class="text-right">—</td><td>${summary.stockInSaleQty} шт (товар, не деньги)</td></tr>
            <tr><td>К отправке</td><td class="text-right">—</td><td>${summary.stockForDispatchQty} шт</td></tr>
          </tbody>
        </table>
        <div class="finance-export-row">
          <button type="button" class="btn-secondary" id="finSnapshotTemplateBtn">📋 Шаблон баланса</button>
          <label class="btn-secondary finance-file-btn">📤 Импорт баланса<input type="file" accept=".xlsx,.xls" hidden id="finSnapshotImportInput" /></label>
          <button type="button" class="btn-secondary" id="finSnapshotExportBtn">📥 Экспорт баланса</button>
          <button type="button" class="btn-secondary" id="finExportFullBtn">📥 Полный отчёт Excel</button>
        </div>
      </div>`;
  }

  function renderPaymentsTab() {
    const filter = financeState.filters.payments;
    const allPayments = financeState.payments.slice().sort((a, b) => {
      if (!a.payment_date) return 1;
      if (!b.payment_date) return -1;
      return new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime();
    });
    const payments = filterByDateRange(allPayments, 'payment_date', filter.from, filter.to);
    const withRT = addRunningTotal(financeState.payments);
    const statsAll = calcPaymentsStats(allPayments);
    const stats = calcPaymentsStats(payments);
    const filtered = !!(filter.from || filter.to);
    const periodLabel = filtered
      ? `${filter.from ? fmtDateRu(filter.from) : '…'} — ${filter.to ? fmtDateRu(filter.to) : '…'}`
      : 'за всё время';

    const dashCards = filtered
      ? [
          { label: 'Сумма за период', value: fmtSum(stats.completedSum), sub: 'только исполненные', accent: 'green' },
          { label: 'Выплат в периоде', value: fmtNum(stats.completedCount), sub: periodLabel }
        ]
      : [
          { label: 'Получено всего', value: fmtSum(statsAll.completedSum), sub: `${statsAll.completedCount} исполненных`, accent: 'green' },
          { label: 'Всего выплат', value: fmtNum(statsAll.totalLines), sub: 'все статусы' },
          { label: 'Ожидается', value: fmtSum(statsAll.pendingSum), sub: `${statsAll.pendingCount} в ожидании`, accent: 'yellow' }
        ];

    const rows = payments.map((p, i) => {
      const rt = withRT.find(w => w.id === p.id);
      const isAdded = /ДОБАВЛЕНА|пропущена/i.test(p.notes || '');
      const rowCls = [
        isAdded ? 'finance-row--added' : '',
        p.status === 'rejected' ? 'finance-row--rejected' : '',
        p.status === 'pending' ? 'finance-row--pending' : ''
      ].filter(Boolean).join(' ');
      const badgeCls = p.status === 'completed' ? 'finance-badge--ok'
        : p.status === 'rejected' ? 'finance-badge--bad' : 'finance-badge--wait';
      return `<tr class="${rowCls}">
        <td>${i + 1}</td>
        <td>${escapeHtml(fmtDateRu(p.payment_date))}</td>
        <td class="text-right"><strong>${fmtNum(p.amount)}</strong></td>
        <td class="text-right text-muted">${rt ? fmtNum(rt.running_total) : '—'}</td>
        <td class="text-xs">${fmtPeriodRu(p.period_from, p.period_to)}</td>
        <td class="font-mono text-xs">${escapeHtml(p.request_number || '—')}</td>
        <td class="text-center"><span class="finance-badge ${badgeCls}">${STATUS_LABELS[p.status] || p.status}</span></td>
        <td class="text-xs text-muted">${escapeHtml(p.notes || '')}</td>
        <td>
          <button type="button" class="finance-icon-btn" data-fin-edit-payment="${escapeAttr(p.id)}" title="Изменить">✏️</button>
          <button type="button" class="finance-icon-btn finance-icon-btn--danger" data-fin-del-payment="${escapeAttr(p.id)}" title="Удалить">🗑</button>
        </td>
      </tr>`;
    }).join('');

    return `
      ${renderFinanceStorageBanner()}
      ${renderMiniDash(dashCards)}
      ${renderDateFilterBar('payments', filter.from, filter.to)}
      <div class="finance-toolbar">
        <span class="text-muted text-sm">Показано: ${payments.length} из ${allPayments.length}<br>
        <span class="text-xs">Шаблон → заполнить → Импорт. Экспорт — текущие данные для дополнения.</span></span>
        <div class="finance-toolbar-actions">
          <button type="button" class="btn-secondary" id="finPaymentsTemplateBtn">📋 Шаблон</button>
          <label class="btn-secondary finance-file-btn">📤 Импорт<input type="file" accept=".xlsx,.xls" hidden id="finPaymentsImportInput" /></label>
          <button type="button" class="btn-secondary" id="finPaymentsExportBtn">📥 Экспорт</button>
          ${allPayments.length ? '<button type="button" class="btn-danger" id="finClearAllPaymentsBtn" title="Тройное подтверждение">🗑 Очистить всё</button>' : ''}
          <button type="button" class="btn-primary" id="finAddPaymentBtn">+ Добавить выплату</button>
        </div>
      </div>
      <div class="finance-table-wrap">
        <table class="finance-table finance-table--payments">
          <thead><tr>
            <th>№</th><th>Дата</th><th class="text-right">Сумма</th><th class="text-right">Накоплено</th>
            <th>Период</th><th>Запрос</th><th class="text-center">Статус</th><th>Примечание</th><th></th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="9" class="empty">Нет выплат</td></tr>'}</tbody>
          <tfoot><tr class="finance-tfoot">
            <td colspan="2">${filtered ? 'ИТОГО ЗА ПЕРИОД' : 'ИТОГО ПОЛУЧЕНО'}</td>
            <td class="text-right">${fmtNum(stats.completedSum)}</td>
            <td colspan="6" class="text-sm">${filtered ? periodLabel : 'Только статус «Исполнен»'}</td>
          </tr></tfoot>
        </table>
      </div>`;
  }

  function renderShipmentsTab() {
    const filter = financeState.filters.shipments;
    const allShipments = financeState.shipments.slice()
      .sort((a, b) => new Date(b.shipment_date).getTime() - new Date(a.shipment_date).getTime());
    const shipments = filterByDateRange(allShipments, 'shipment_date', filter.from, filter.to);
    const statsAll = calcShipmentsStats(allShipments);
    const stats = calcShipmentsStats(shipments);
    const filtered = !!(filter.from || filter.to);
    const periodLabel = filtered
      ? `${filter.from ? fmtDateRu(filter.from) : '…'} — ${filter.to ? fmtDateRu(filter.to) : '…'}`
      : 'за всё время';

    const dashCards = [
      { label: 'Отгрузок', value: fmtNum(filtered ? stats.lines : statsAll.lines), sub: periodLabel },
      { label: 'Штук отправлено', value: fmtNum(filtered ? stats.qty : statsAll.qty), sub: 'учёт поставок, не выплаты' }
    ];

    const rows = shipments.map((s, i) => `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(fmtDateRu(s.shipment_date))}</td>
      <td><strong>${escapeHtml(s.article_code)}</strong></td>
      <td>${escapeHtml(s.description || '')}</td>
      <td class="text-right">${fmtNum(s.quantity)}</td>
      <td class="text-right">${s.unit_price != null ? fmtNum(s.unit_price) : '—'}</td>
      <td class="text-right"><strong>${fmtNum(s.total_amount)}</strong></td>
      <td><span class="finance-badge">${STATUS_LABELS[s.status] || s.status}</span></td>
      <td class="text-xs">${escapeHtml(s.notes || '')}</td>
      <td>
        <button type="button" class="finance-icon-btn" data-fin-edit-shipment="${escapeAttr(s.id)}">✏️</button>
        <button type="button" class="finance-icon-btn finance-icon-btn--danger" data-fin-del-shipment="${escapeAttr(s.id)}">🗑</button>
      </td>
    </tr>`).join('');

    return `
      ${renderFinanceStorageBanner()}
      ${renderMiniDash(dashCards)}
      ${renderDateFilterBar('shipments', filter.from, filter.to)}
      <div class="finance-toolbar">
        <span class="text-muted text-sm">Показано: ${shipments.length} из ${allShipments.length}<br>
        <span class="text-xs">Журнал поставок на склад Uzum. Суммы в таблице — отпускные цены, <strong>не выплаты</strong>.</span></span>
        <div class="finance-toolbar-actions">
          <button type="button" class="btn-secondary" id="finShipmentsTemplateBtn">📋 Шаблон</button>
          <label class="btn-secondary finance-file-btn">📤 Импорт<input type="file" accept=".xlsx,.xls" hidden id="finShipmentsImportInput" /></label>
          <button type="button" class="btn-secondary" id="finShipmentsExportBtn">📥 Экспорт</button>
          ${allShipments.length ? '<button type="button" class="btn-danger" id="finClearAllShipmentsBtn" title="Тройное подтверждение">🗑 Очистить всё</button>' : ''}
          <button type="button" class="btn-primary" id="finAddShipmentBtn">+ Добавить отгрузку</button>
        </div>
      </div>
      <div class="finance-table-wrap">
        <table class="finance-table">
          <thead><tr>
            <th>№</th><th>Дата</th><th>Артикул</th><th>Описание</th>
            <th class="text-right">Кол-во</th><th class="text-right">Отп.цена</th><th class="text-right">Сумма</th>
            <th>Статус</th><th>Примечание</th><th></th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="10" class="empty">Нет отгрузок</td></tr>'}</tbody>
        </table>
      </div>`;
  }

  function renderStockTab() {
    const dates = getStockSnapshotDates();
    const activeDate = getActiveStockDate();
    const latestDate = getLatestStockDate();
    const isLatest = !financeState.stockViewDate || activeDate === latestDate;
    const stock = getStockRowsByDate(activeDate);
    const totals = calcStockTotals(stock);
    const prevDate = getPreviousStockDate(activeDate);
    const prevTotals = prevDate ? calcStockTotals(getStockRowsByDate(prevDate)) : null;
    const delta = prevTotals ? {
      qtyInSale: totals.qtyInSale - prevTotals.qtyInSale,
      saleSum: totals.saleSum - prevTotals.saleSum,
      costSum: totals.costSum - prevTotals.costSum
    } : null;

    const dashCards = [
      {
        label: 'Снимок',
        value: activeDate ? fmtDateRu(activeDate) : '—',
        sub: isLatest ? 'актуальный' : 'архивный',
        accent: isLatest ? 'green' : 'yellow'
      },
      { label: 'Позиций', value: fmtNum(totals.positions), sub: 'SKU в отчёте' },
      { label: 'В продаже', value: fmtNum(totals.qtyInSale), sub: `${fmtNum(totals.qtyDispatch)} к отправке` },
      { label: 'Себестоимость', value: fmtSum(totals.costSum), sub: 'из отчёта Uzum' }
    ];

    const compareBlock = prevDate && delta ? `
      <div class="finance-stock-compare card">
        <strong>Изменение vs снимок ${fmtDateRu(prevDate)}</strong>
        <div class="finance-stock-compare-grid">
          <span>В продаже: <strong>${fmtDelta(delta.qtyInSale, ' шт')}</strong></span>
          <span>Сумма продажи: <strong>${fmtDelta(delta.saleSum, ' сум')}</strong></span>
          <span>Себестоимость: <strong>${fmtDelta(delta.costSum, ' сум')}</strong></span>
        </div>
      </div>` : '';

    const snapshotSelect = dates.length ? `
      <div class="finance-stock-snapshots card">
        <label class="finance-stock-snapshot-label">Снимок остатков
          <select id="finStockSnapshotSelect" class="finance-stock-snapshot-select">
            <option value="" ${isLatest ? 'selected' : ''}>Актуальный (${latestDate ? fmtDateRu(latestDate) : '—'})</option>
            ${dates.map((d) => `<option value="${escapeAttr(d)}" ${d === activeDate && !isLatest ? 'selected' : ''}>${escapeHtml(fmtDateRu(d))}${d === latestDate ? ' — актуальный' : ''}</option>`).join('')}
          </select>
        </label>
        <span class="text-muted text-sm">Снимков: ${dates.length}. Новый файл = новая дата. Повтор за ту же дату заменяет снимок.</span>
      </div>` : '';

    const rows = stock.map(s => `<tr>
      <td>${escapeHtml(s.product_name)}</td>
      <td class="font-mono text-xs">${escapeHtml(s.sku || '—')}</td>
      <td class="text-right">${fmtNum(s.qty_in_sale)}</td>
      <td class="text-right">${fmtNum(s.qty_for_dispatch)}</td>
      <td class="text-right">${s.sale_price != null ? fmtNum(s.sale_price) : '—'}</td>
      <td class="text-right">${s.total_cost_sum != null ? fmtNum(s.total_cost_sum) : '—'}</td>
      <td class="text-right"><strong>${s.total_sale_sum != null ? fmtNum(s.total_sale_sum) : '—'}</strong></td>
      <td class="text-xs">${escapeHtml(s.status || '')}</td>
    </tr>`).join('');

    return `
      ${renderFinanceStorageBanner()}
      ${snapshotSelect}
      ${renderMiniDash(dashCards)}
      ${compareBlock}
      <div class="finance-stock-hint card">
        <strong>Как получить отчёт:</strong> ЛК Uzum → Склад → Остатки → Скачать (.xlsx). Можно каждый день — дата из имени файла или сегодня.
        ${stock.length ? `<div class="finance-export-row" style="margin-top:10px">
          <button type="button" class="btn-secondary" id="finStockExportBtn">📥 Экспорт остатков</button>
        </div>` : ''}
      </div>
      <div class="finance-stock-upload" id="finStockUploadZone">
        <input type="file" accept=".xlsx,.xls" hidden id="finStockFileInput" />
        <div class="finance-stock-upload-inner" id="finStockUploadInner">
          <div class="finance-stock-upload-icon">📊</div>
          <div>Нажмите или перетащите отчёт «Остатки» (.xlsx)</div>
        </div>
      </div>
      <div id="finStockUploadResult" class="hidden"></div>
      ${stock.length ? `
        <p class="sub">Снимок <strong>${fmtDateRu(activeDate)}</strong> — ${stock.length} позиций${isLatest ? ' (актуальный)' : ''}</p>
        <div class="finance-table-wrap">
          <table class="finance-table">
            <thead><tr>
              <th>Товар</th><th>SKU</th><th class="text-right">В продаже</th>
              <th class="text-right">К отправке</th>              <th class="text-right">Цена прод.</th>
              <th class="text-right">Себест.</th>
              <th class="text-right">Итого прод.</th><th>Статус</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      ` : '<p class="empty">Остатки не загружены. Загрузите отчёт из ЛК Узума.</p>'}`;
  }

  function renderFinancesPage() {
    const root = document.getElementById('financesTabContent');
    if (!root) return;
    const summary = calculateSummary();
    const tab = financeState.activeTab;

    let content = '';
    if (tab === 'summary') content = renderSummaryTab(summary);
    else if (tab === 'payments') content = renderPaymentsTab();
    else if (tab === 'shipments') content = renderShipmentsTab();
    else if (tab === 'stock') content = renderStockTab();

    root.innerHTML = content;
    wireFinancesEvents();
    bindDateInputMask(root);
  }

  function setFinanceTab(tabId) {
    financeState.activeTab = tabId;
    document.querySelectorAll('[data-finance-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.financeTab === tabId);
    });
    renderFinancesPage();
  }

  function showStockUploadStatus(kind, text) {
    const resultEl = document.getElementById('finStockUploadResult');
    if (!resultEl) return;
    resultEl.className = `finance-stock-result finance-stock-result--${kind}`;
    resultEl.textContent = text;
    resultEl.classList.remove('hidden');
  }

  async function handleStockFileUpload(fileInput) {
    const file = fileInput?.files?.[0];
    if (!file) return;
    try {
      showStockUploadStatus('wait', 'Читаю файл…');
      const buffer = await file.arrayBuffer();
      const rows = parseUzumStockReport(buffer);
      if (!rows.length) {
        throw new Error('Файл пустой или не похож на отчёт «Остатки» Uzum.');
      }

      let snapshotDate = detectStockSnapshotDate(file, buffer, rows);
      const dateInFileName = /(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})/.test(file.name);
      if (!dateInFileName) {
        const custom = await askFinanceDate(
          'Дата снимка остатков',
          'В имени файла нет даты — укажите дату снимка.',
          snapshotDate
        );
        if (custom === null) {
          showStockUploadStatus('err', 'Загрузка отменена.');
          return;
        }
        if (custom) snapshotDate = toIsoDate(custom);
      }

      showStockUploadStatus('wait', `Загружаю ${rows.length} позиций за ${fmtDateRu(snapshotDate)}…`);
      const result = await importStockReport(snapshotDate, rows);
      const deltaText = result.prevDate && result.delta
        ? ` Изменение vs ${fmtDateRu(result.prevDate)}: в продаже ${fmtDelta(result.delta.qtyInSale, ' шт')}, продажа ${fmtDelta(result.delta.saleSum, ' сум')}.`
        : '';
      showStockUploadStatus(
        'ok',
        `✅ Загружено ${result.count} позиций. Снимок ${fmtDateRu(result.date)} — актуальный.${deltaText}`
      );
    } catch (err) {
      showStockUploadStatus('err', `Ошибка: ${err?.message || err}`);
    } finally {
      fileInput.value = '';
    }
  }

  function wireFinancesEvents() {
    document.getElementById('finUpdateSnapshotBtn')?.addEventListener('click', openSnapshotForm);
    document.getElementById('finExportFullBtn')?.addEventListener('click', exportFullReport);
    document.getElementById('finSnapshotTemplateBtn')?.addEventListener('click', exportSnapshotsTemplate);
    document.getElementById('finSnapshotExportBtn')?.addEventListener('click', exportSnapshotsToExcel);
    document.getElementById('finAddPaymentBtn')?.addEventListener('click', () => openPaymentForm());
    document.getElementById('finPaymentsTemplateBtn')?.addEventListener('click', exportPaymentsTemplate);
    document.getElementById('finPaymentsExportBtn')?.addEventListener('click', exportPaymentsToExcel);
    document.getElementById('finAddShipmentBtn')?.addEventListener('click', () => openShipmentForm());
    document.getElementById('finShipmentsTemplateBtn')?.addEventListener('click', exportShipmentsTemplate);
    document.getElementById('finShipmentsExportBtn')?.addEventListener('click', exportShipmentsToExcel);
    document.getElementById('finClearAllShipmentsBtn')?.addEventListener('click', () => { void clearAllFinanceShipments(); });
    document.getElementById('finClearAllPaymentsBtn')?.addEventListener('click', () => { void clearAllFinancePayments(); });
    document.getElementById('finRetryFirebaseBtn')?.addEventListener('click', () => { void retryFinanceFirebaseSync(); });

    document.querySelectorAll('[data-fin-filter-apply]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tabKey = btn.getAttribute('data-fin-filter-apply');
        if (!tabKey || !financeState.filters[tabKey]) return;
        financeState.filters[tabKey].from = toIsoDate(document.getElementById('finFilterFrom')?.value || '') || '';
        financeState.filters[tabKey].to = toIsoDate(document.getElementById('finFilterTo')?.value || '') || '';
        renderFinancesPage();
      });
    });
    document.querySelectorAll('[data-fin-filter-reset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tabKey = btn.getAttribute('data-fin-filter-reset');
        if (!tabKey || !financeState.filters[tabKey]) return;
        financeState.filters[tabKey] = { from: '', to: '' };
        renderFinancesPage();
      });
    });

    document.getElementById('finStockSnapshotSelect')?.addEventListener('change', (e) => {
      financeState.stockViewDate = e.target.value || '';
      renderFinancesPage();
    });
    document.getElementById('finStockExportBtn')?.addEventListener('click', exportStockToExcel);

    document.getElementById('finSnapshotImportInput')?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await runFinanceImport('snapshots', await file.arrayBuffer());
      } catch (err) {
        alert(err?.message || 'Ошибка импорта');
      }
      e.target.value = '';
    });

    document.getElementById('finPaymentsImportInput')?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await runFinanceImport('payments', await file.arrayBuffer());
      } catch (err) {
        alert(err?.message || 'Ошибка импорта');
      }
      e.target.value = '';
    });

    document.getElementById('finShipmentsImportInput')?.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await runFinanceImport('shipments', await file.arrayBuffer());
      } catch (err) {
        alert(err?.message || 'Ошибка импорта');
      }
      e.target.value = '';
    });

    document.querySelectorAll('[data-fin-edit-payment]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = financeState.payments.find(x => x.id === btn.dataset.finEditPayment);
        if (p) openPaymentForm(p);
      });
    });
    document.querySelectorAll('[data-fin-del-payment]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить выплату?')) return;
        await deleteDoc(COL.payments, btn.dataset.finDelPayment);
        renderFinancesPage();
      });
    });
    document.querySelectorAll('[data-fin-edit-shipment]').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = financeState.shipments.find(x => x.id === btn.dataset.finEditShipment);
        if (s) openShipmentForm(s);
      });
    });
    document.querySelectorAll('[data-fin-del-shipment]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить отгрузку?')) return;
        await deleteDoc(COL.shipments, btn.dataset.finDelShipment);
        renderFinancesPage();
      });
    });
  }

  let _financeTabNavWired = false;
  let _financeSyncStarted = false;

  function wireFinanceTabNav() {
    const nav = document.getElementById('financesTabNav');
    if (!nav || _financeTabNavWired) return;
    _financeTabNavWired = true;
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-finance-tab]');
      if (!btn || !nav.contains(btn)) return;
      e.preventDefault();
      const tabId = btn.getAttribute('data-finance-tab');
      if (tabId) setFinanceTab(tabId);
    });
  }

  async function startFinanceSyncOnce() {
    if (_financeSyncStarted) return;
    const database = getDb();
    if (!database) {
      activateLocalFinanceStorage('Firebase не подключён');
      _financeSyncStarted = true;
      if (document.getElementById('finances-tab')?.classList.contains('active')) {
        renderFinancesPage();
      }
      return;
    }
    _financeSyncStarted = true;
    await initFinanceStorage();
    if (financeStoreMode === 'firebase') {
      startFinanceRealtimeSync();
    } else if (document.getElementById('finances-tab')?.classList.contains('active')) {
      renderFinancesPage();
    }
  }

  function wireFinancesStockUploadOnce() {
    const root = document.getElementById('financesTabContent');
    if (!root || root.dataset.stockUploadWired) return;
    root.dataset.stockUploadWired = '1';
    root.addEventListener('click', (e) => {
      const zone = e.target.closest('#finStockUploadZone');
      if (!zone || e.target.closest('#finStockFileInput')) return;
      zone.querySelector('#finStockFileInput')?.click();
    });
    root.addEventListener('change', (e) => {
      if (e.target?.id === 'finStockFileInput') {
        void handleStockFileUpload(e.target);
      }
    });
  }

  function initFinances() {
    wireFinanceTabNav();
    wireFinancesStockUploadOnce();
    startFinanceSyncOnce();
    if (document.getElementById('finances-tab')?.classList.contains('active')) {
      renderFinancesPage();
    }
  }

  window.renderFinancesPage = renderFinancesPage;
  window.initFinances = initFinances;
  window.setFinanceTab = setFinanceTab;

  initFinances();
})();
