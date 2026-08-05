/**
 * Аналитика YO — модуль дашборда (ABC/XYZ, юнит-экономика, P&L, товары).
 * Самодостаточный IIFE по образцу finances.js. Данные: Firestore + localStorage fallback.
 */
(function () {
  'use strict';

  // ─── STATE ───────────────────────────────────────────────────────────
  const analyticsState = {
    products: [],
    payments: [],
    shipments: [],
    activeTab: 'overview', // overview | abcxyz | unit-economics | pnl | products
    period: 3, // месяцев: 1 | 3 | 6 | 9 | 12
    loading: false,
    initialized: false,
    filters: {
      category: 'all',
      abcClass: [],
      search: ''
    },
    unitSettings: {
      vatPct: 12,
      minMarginPct: 18,
      uzumCommPct: 22,
      avgLogistics: 6250,
      avgStorage: 84
    },
    chart: null
  };

  // ─── DB ACCESS ───────────────────────────────────────────────────────
  function getDb() {
    try {
      if (typeof window.db !== 'undefined' && window.db) return window.db;
    } catch (_) { /* ignore */ }
    return null;
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────
  function formatSum(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return `${Math.round(Number(n)).toLocaleString('ru-RU')} сум`;
  }

  function formatPct(n, decimals = 1) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return `${Number(n).toFixed(decimals)}%`;
  }

  function formatNum(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('ru-RU');
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function navigateTo(pageId) {
    const btn = document.querySelector(`.nav-btn[data-page="${pageId}"]`);
    if (btn) btn.click();
    else if (typeof window.openPage === 'function') window.openPage(pageId);
  }

  function getPeriodRange(months) {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - (Number(months) || 1) + 1, 1);
    from.setHours(0, 0, 0, 0);
    return { from, to: now };
  }

  function buildKpiCard({ label, value, delta, colorClass = '' }) {
    const deltaHtml =
      delta !== undefined && delta !== null
        ? `<div class="kpi-delta ${delta >= 0 ? 'positive' : 'negative'}">
            ${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta).toFixed(1)}% vs пред. период
           </div>`
        : '';
    return `
      <div class="kpi-card ${colorClass}">
        <div class="kpi-label">${escapeHtml(label)}</div>
        <div class="kpi-value">${value}</div>
        ${deltaHtml}
      </div>
    `;
  }

  function buildEmptyState(icon, title, desc, actionLabel, actionPage) {
    const actionAttr = actionPage
      ? ` data-ayo-nav="${escapeHtml(actionPage)}"`
      : '';
    const btn = actionLabel
      ? `<button type="button" class="btn-primary"${actionAttr}>${escapeHtml(actionLabel)}</button>`
      : '';
    return `
      <div class="empty-state">
        <div class="empty-state-icon">${icon}</div>
        <div class="empty-state-title">${escapeHtml(title)}</div>
        <div class="empty-state-desc">${escapeHtml(desc)}</div>
        ${btn}
      </div>
    `;
  }

  function renderLoading() {
    const el = document.getElementById('analyticsYoContent');
    if (!el) return;
    el.innerHTML = `<div class="analytics-loader">Загрузка данных…</div>`;
  }

  // ─── HTML SHELL ──────────────────────────────────────────────────────
  function buildAnalyticsHTML() {
    return `
      <div class="analytics-yo-wrap">
        <div class="analytics-header card">
          <div>
            <h2 class="section-title">📊 Аналитика YO</h2>
            <p class="sub" style="margin:6px 0 0;">KPI, ABC/XYZ, юнит-экономика и P&amp;L по данным Firebase и базы товаров.</p>
          </div>
          <div class="analytics-controls">
            <div class="period-switcher" id="ayoPeriodSwitcher" role="group" aria-label="Период">
              <button type="button" class="period-btn" data-period="1">1 мес</button>
              <button type="button" class="period-btn active" data-period="3">3 мес</button>
              <button type="button" class="period-btn" data-period="6">6 мес</button>
              <button type="button" class="period-btn" data-period="9">9 мес</button>
              <button type="button" class="period-btn" data-period="12">12 мес</button>
            </div>
            <button type="button" class="btn-secondary" id="analyticsYoRefresh">🔄 Обновить</button>
          </div>
        </div>

        <div class="analytics-subnav" id="ayoSubnav" role="tablist" aria-label="Разделы аналитики">
          <button type="button" class="analytics-tab-btn active" data-subtab="overview" role="tab" aria-selected="true">Обзор</button>
          <button type="button" class="analytics-tab-btn" data-subtab="abcxyz" role="tab" aria-selected="false">ABC/XYZ</button>
          <button type="button" class="analytics-tab-btn" data-subtab="unit-economics" role="tab" aria-selected="false">Юнит-экономика</button>
          <button type="button" class="analytics-tab-btn" data-subtab="pnl" role="tab" aria-selected="false">P&amp;L</button>
          <button type="button" class="analytics-tab-btn" data-subtab="products" role="tab" aria-selected="false">Товары</button>
        </div>

        <div id="analyticsYoContent" class="analytics-content" aria-live="polite">
          <div class="analytics-loader">Загрузка данных…</div>
        </div>
      </div>
    `;
  }

  // ─── TAB RENDERERS (шаг 1 — заглушки; данные — шаги 2–7) ─────────────
  function renderOverview() {
    const el = document.getElementById('analyticsYoContent');
    if (!el) return;
    const productCount = analyticsState.products.length;
    el.innerHTML = `
      <div class="kpi-grid">
        ${buildKpiCard({ label: 'Выручка', value: formatSum(0), delta: undefined, colorClass: '' })}
        ${buildKpiCard({ label: 'Валовая прибыль', value: formatSum(0), colorClass: 'kpi-green' })}
        ${buildKpiCard({ label: 'Маржа средняя', value: formatPct(0), colorClass: 'kpi-blue' })}
        ${buildKpiCard({ label: 'Товаров в базе', value: formatNum(productCount), colorClass: 'kpi-orange' })}
      </div>
      <div class="ayo-overview-grid">
        <div class="card">
          <h3 style="margin:0 0 12px;font-size:16px;">Динамика</h3>
          <div class="canvas-box" style="min-height:260px;">
            <canvas id="ayoOverviewChart" aria-label="График выручки и прибыли"></canvas>
            <p class="sub" id="ayoOverviewChartHint" style="margin-top:12px;">График появится после загрузки выплат (шаг 6).</p>
          </div>
        </div>
        <div class="insights-panel">
          <h3 style="margin:0 0 8px;font-size:16px;">Что важно сейчас</h3>
          <p class="sub" style="margin:0 0 12px;">Автодиагностика по базе товаров и финансам.</p>
          <div id="ayoInsightsList">
            <div class="insight-item">
              <span class="insight-icon">📦</span>
              <div class="insight-info">
                <div class="insight-title">Товаров в базе</div>
                <div class="insight-value">${formatNum(productCount)} SKU</div>
              </div>
              <button type="button" class="insight-action" data-ayo-nav="products-tab">Открыть</button>
            </div>
            <div class="insight-item">
              <span class="insight-icon">💡</span>
              <div class="insight-info">
                <div class="insight-title">Модуль в сборке</div>
                <div class="insight-value">Шаг 1: каркас готов. Далее — загрузка данных и вкладки.</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderAbcXyz() {
    const el = document.getElementById('analyticsYoContent');
    if (!el) return;
    el.innerHTML = buildEmptyState(
      '🧩',
      'ABC/XYZ',
      'Матрица классификации и таблица со sparklines появятся на шаге 5.',
      'К базе товаров',
      'products-tab'
    );
  }

  function renderUnitEconomics() {
    const el = document.getElementById('analyticsYoContent');
    if (!el) return;
    el.innerHTML = `
      <div class="ue-settings-bar card" style="margin-bottom:16px;">
        <label>НДС, %: <input type="number" id="ue-vat-pct" class="input" style="width:88px;display:inline-block;" value="${analyticsState.unitSettings.vatPct}" min="0" max="50" step="0.1" disabled /></label>
        <label>Мин. рентабельность, %: <input type="number" id="ue-min-margin" class="input" style="width:88px;display:inline-block;" value="${analyticsState.unitSettings.minMarginPct}" min="0" max="100" step="0.1" disabled /></label>
        <button type="button" class="btn-primary" disabled title="Доступно после шага 4">Пересчитать</button>
      </div>
      ${buildEmptyState(
        '📐',
        'Юнит-экономика по SKU',
        'Таблица с прибылью, маржой, ROI и мин. ценой — шаг 4 спецификации.',
        null,
        null
      )}
    `;
  }

  function renderPnl() {
    const el = document.getElementById('analyticsYoContent');
    if (!el) return;
    el.innerHTML = buildEmptyState(
      '📑',
      'P&L (ОПиУ)',
      'Отчёт о прибылях и убытках по месяцам — шаг 7.',
      'К финансам',
      'finances-tab'
    );
  }

  function renderProducts() {
    const el = document.getElementById('analyticsYoContent');
    if (!el) return;
    const n = analyticsState.products.length;
    el.innerHTML = `
      <div class="kpi-grid">
        ${buildKpiCard({ label: 'Всего SKU', value: formatNum(n) })}
        ${buildKpiCard({ label: 'С продажами', value: '—', colorClass: 'kpi-blue' })}
        ${buildKpiCard({ label: 'Без С/С', value: '—', colorClass: 'kpi-orange' })}
        ${buildKpiCard({ label: 'Отриц. маржа', value: '—', colorClass: 'kpi-green' })}
      </div>
      ${buildEmptyState(
        '📦',
        n ? `Загружено ${formatNum(n)} товаров` : 'Нет данных о товарах',
        n
          ? 'Полная таблица со статусами себестоимости — шаг 3.'
          : 'Добавьте товары в «База товаров» или дождитесь синхронизации Firebase (шаг 2).',
        'Перейти к товарам',
        'products-tab'
      )}
    `;
  }

  function renderActiveTab() {
    switch (analyticsState.activeTab) {
      case 'overview':
        renderOverview();
        break;
      case 'abcxyz':
        renderAbcXyz();
        break;
      case 'unit-economics':
        renderUnitEconomics();
        break;
      case 'pnl':
        renderPnl();
        break;
      case 'products':
        renderProducts();
        break;
      default:
        renderOverview();
    }
  }

  function setSubtab(subtab) {
    if (!subtab) return;
    analyticsState.activeTab = subtab;
    document.querySelectorAll('#ayoSubnav .analytics-tab-btn').forEach((btn) => {
      const on = btn.getAttribute('data-subtab') === subtab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderActiveTab();
  }

  function setPeriod(months) {
    const m = Number(months) || 3;
    analyticsState.period = m;
    document.querySelectorAll('#ayoPeriodSwitcher .period-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.getAttribute('data-period')) === m);
    });
    renderActiveTab();
  }

  // ─── DATA (шаг 2 — заготовка: products из appState / localStorage) ───
  function readProductsFallback() {
    try {
      if (window.appState && Array.isArray(window.appState.products)) {
        return window.appState.products.slice();
      }
    } catch (_) { /* ignore */ }
    try {
      const raw =
        localStorage.getItem('yo_products_v1') ||
        localStorage.getItem('products') ||
        '';
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function loadAnalyticsData() {
    analyticsState.loading = true;
    renderLoading();

    try {
      const db = getDb();
      if (db) {
        try {
          const productsSnap = await db.collection('products').limit(4000).get();
          analyticsState.products = productsSnap.docs.map((d) => ({
            id: d.id,
            ...(d.data() || {})
          }));
        } catch (err) {
          console.warn('AnalyticsYo: products из Firestore недоступны, fallback', err);
          analyticsState.products = readProductsFallback();
        }
        // payments / shipments — полноценно на шаге 2
        analyticsState.payments = analyticsState.payments || [];
        analyticsState.shipments = analyticsState.shipments || [];
      } else {
        analyticsState.products = readProductsFallback();
      }
    } catch (err) {
      console.error('AnalyticsYo: ошибка загрузки', err);
      analyticsState.products = readProductsFallback();
    }

    analyticsState.loading = false;
    renderActiveTab();
  }

  // ─── EVENTS ──────────────────────────────────────────────────────────
  function bindAnalyticsEvents() {
    const root = document.getElementById('analytics-yo-tab');
    if (!root || root.dataset.ayoWired === '1') return;
    root.dataset.ayoWired = '1';

    root.addEventListener('click', (e) => {
      const periodBtn = e.target.closest('#ayoPeriodSwitcher .period-btn');
      if (periodBtn) {
        e.preventDefault();
        setPeriod(periodBtn.getAttribute('data-period'));
        return;
      }

      const subBtn = e.target.closest('#ayoSubnav .analytics-tab-btn');
      if (subBtn) {
        e.preventDefault();
        setSubtab(subBtn.getAttribute('data-subtab'));
        return;
      }

      if (e.target.closest('#analyticsYoRefresh')) {
        e.preventDefault();
        void loadAnalyticsData();
        return;
      }

      const navBtn = e.target.closest('[data-ayo-nav]');
      if (navBtn) {
        e.preventDefault();
        navigateTo(navBtn.getAttribute('data-ayo-nav'));
      }
    });
  }

  // ─── INIT ────────────────────────────────────────────────────────────
  function initAnalyticsYo(force) {
    const container = document.getElementById('analyticsYoRoot');
    if (!container) {
      console.warn('AnalyticsYo: #analyticsYoRoot не найден');
      return;
    }

    if (!analyticsState.initialized || force) {
      container.innerHTML = buildAnalyticsHTML();
      bindAnalyticsEvents();
      analyticsState.initialized = true;
      window.AnalyticsYo._initialized = true;
    }

    setPeriod(analyticsState.period);
    setSubtab(analyticsState.activeTab);
    void loadAnalyticsData();
  }

  function onAnalyticsYoPageOpen() {
    if (!analyticsState.initialized) initAnalyticsYo();
    else renderActiveTab();
  }

  function wireNavHook() {
    document.querySelectorAll('.nav-btn[data-page="analytics-yo-tab"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        // openPage уже покажет секцию; чуть позже инициализируем контент
        setTimeout(onAnalyticsYoPageOpen, 0);
      });
    });

    // Если раздел уже активен при загрузке
    if (document.getElementById('analytics-yo-tab')?.classList.contains('active')) {
      onAnalyticsYoPageOpen();
    }
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────
  window.AnalyticsYo = {
    init: initAnalyticsYo,
    refresh: loadAnalyticsData,
    setSubtab,
    setPeriod,
    navigateTo,
    getState: () => analyticsState,
    _initialized: false
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireNavHook);
  } else {
    wireNavHook();
  }
})();
