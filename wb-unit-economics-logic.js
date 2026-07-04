/**
 * =============================================================================
 * ЮНИТ-ЭКОНОМИКА WILDBERRIES (Узбекистан) — полная логика расчёта
 * =============================================================================
 * Вынесено из script.js (computeWbUnitEconomics, wbUzLogistics, vatFromAmount).
 * Самодостаточный файл: можно скачать, переслать, запустить в Node или браузере.
 *
 * Все суммы в сумах (UZS), если не указано иное.
 *
 * ЦЕПОЧКА:
 *   комиссия / эквайринг / реклама  = цена × %
 *   логистика                       = wbUzLogistics(литры, выкуп, запас, возврат)
 *   хранение                        = литры × тариф × дни
 *   к_перечислению                  = цена − все удержания WB
 *   НДС_к_оплате                    = исходящий(цена) − входящий(себестоимость)
 *   чистая_прибыль                  = к_перечислению − себестоимость − НДС_к_оплате
 * =============================================================================
 */

// ── Дефолты справочника ──────────────────────────────────────────────────────
const WB_UZ_DEFAULTS = {
  exchangeRate: 168,        // 1 руб = N сум
  buyoutPct: 87,            // % выкупа
  vatPct: 12,               // НДС %
  storageTariff: 42,        // сум/л/день
  safetyMarginPct: 10,      // запас к логистике %
  returnFixed: 7200,        // возврат фиксированный, сум
};

/**
 * Зачёт входящего НДС по услугам WB (комиссия, логистика и т.д.).
 * Сейчас выключен — включать только после подтверждения бухгалтером
 * (счёт-фактура с НДС от WB).
 */
const CREDIT_VAT_ON_WB_SERVICES = false;

// Справочник объёмов (для UI-таблицы тарифов; в расчёте юнита не обязателен)
const WB_UZ_LOGISTICS_TARIFFS = [
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

// ── НДС ──────────────────────────────────────────────────────────────────────

/**
 * Выделить НДС из суммы.
 * mode = 'with'    → сумма включает НДС:  amount × rate / (100 + rate)
 * mode = 'without' → сумма без НДС:       amount × rate / 100
 *
 * Пример: 112 000 сум с НДС 12% → 112 000 × 12 / 112 = 12 000
 */
function vatFromAmount(amount, rate, mode) {
  if (rate <= 0 || amount <= 0) return 0;
  return mode === 'with'
    ? amount * rate / (100 + rate)
    : amount * rate / 100;
}

// ── Логистика ────────────────────────────────────────────────────────────────

/**
 * Двухсегментная формула доставки (регрессия по реальному отчёту WB, R²≈0.98).
 * Погрешность ~4%.
 *
 *   литры ≤ 1.5:  1403 + 4600 × литры
 *   литры > 1.5:  4584 + 2068 × литры
 */
function wbUzDeliveryByVolume(liters) {
  const l = Math.max(0, liters);
  return l <= 1.5
    ? Math.round(1403 + 4600 * l)
    : Math.round(4584 + 2068 * l);
}

/**
 * Полный тариф логистики с запасом и выкупом.
 *
 *   deliverySafe = delivery × (1 + safetyPct / 100)
 *   logistics    = deliverySafe / buyoutRate + returnFixed / buyoutRate − returnFixed
 *
 * buyoutRate — доля выкупа (0..1), например 0.87 для 87%.
 */
function wbUzLogistics(liters, buyoutRate, safetyPct, returnFixed) {
  const delivery = wbUzDeliveryByVolume(liters);
  const deliverySafe = Math.round(delivery * (1 + safetyPct / 100));
  const r = Math.max(0.01, buyoutRate);
  return Math.round(deliverySafe / r + returnFixed / r - returnFixed);
}

// ── Главный расчёт юнит-экономики ────────────────────────────────────────────

/**
 * Полный расчёт юнит-экономики WB UZ.
 *
 * @param {object} input
 * @param {number} input.priceUzs        — цена продажи, сум
 * @param {number} input.commPct         — комиссия WB, %
 * @param {number} [input.drrPct]        — ДРР (реклама), %
 * @param {number} [input.acquiPct]      — эквайринг, %
 * @param {number} [input.sppPct]        — СПП (скидка покупателя), % — только для цены покупателя
 * @param {number} [input.costUzs]       — себестоимость, сум (приоритет)
 * @param {number} [input.costRub]       — себестоимость, руб (если costUzs = 0)
 * @param {number} [input.liters]        — объём, литры
 * @param {number} [input.buyoutPct]     — % выкупа (дефолт 87)
 * @param {number} [input.vatPct]        — ставка НДС (дефолт 12)
 * @param {number} [input.storageTariff] — сум/л/день (дефолт 42)
 * @param {number} [input.turnoverDays]  — дни оборачиваемости
 * @param {number} [input.returnFixed]   — фикс возврата, сум (дефолт 7200)
 * @param {number} [input.safetyPct]     — запас к логистике, % (дефолт 10)
 * @param {number} [input.exchangeRate]  — курс руб→сум (дефолт 168)
 * @param {number} [input.acceptanceUzs] — платная приёмка, сум
 * @param {number} [input.inputVat]      — входящий НДС из себестоимости (если товар привязан)
 * @param {boolean} [input.creditVatOnWbServices] — зачёт НДС по услугам WB
 *
 * @returns {object} результат расчёта
 */
function computeWbUnitEconomics(input = {}) {
  const d = WB_UZ_DEFAULTS;

  // --- Цена и параметры WB ---
  const priceUzs = Math.max(0, Number(input.priceUzs) || 0);
  const commPct = Math.max(0, Number(input.commPct) || 0);
  const drrPct = Math.max(0, Number(input.drrPct) || 0);
  const acquiPct = Math.max(0, Math.min(100, Number(input.acquiPct) || 0));
  const sppPct = Math.max(0, Math.min(100, Number(input.sppPct) || 0));

  // --- Параметры справочника ---
  const buyoutPct = Math.max(1, Math.min(100, Number(input.buyoutPct) || d.buyoutPct));
  const vatPct = Math.max(0, Number(input.vatPct) ?? d.vatPct);
  const storageTariff = Math.max(0, Number(input.storageTariff) ?? d.storageTariff);
  const turnoverDays = Math.max(0, Number(input.turnoverDays) || 0);
  const returnFixed = Math.max(0, Number(input.returnFixed) ?? d.returnFixed);
  const safetyPct = Math.max(0, Number(input.safetyPct) ?? d.safetyMarginPct);
  const exchangeRate = Math.max(1, Number(input.exchangeRate) || d.exchangeRate);

  // --- Себестоимость: costUzs приоритетнее costRub × курс ---
  const costRubRaw = Math.max(0, Number(input.costRub) || 0);
  const costUzsRaw = Math.max(0, Number(input.costUzs) || 0);
  const costUzs = costUzsRaw > 0 ? costUzsRaw : Math.round(costRubRaw * exchangeRate);

  // --- Объём ---
  const liters = Math.max(0, Number(input.liters) || 0);

  // --- Удержания WB ---
  const fee = Math.round(priceUzs * commPct / 100);           // комиссия
  const acquiring = Math.round(priceUzs * acquiPct / 100);    // эквайринг
  const ads = Math.round(priceUzs * drrPct / 100);            // реклама (ДРР)

  // Логистика
  const buyoutRate = buyoutPct / 100;
  const totalLogUzs = liters > 0
    ? wbUzLogistics(liters, buyoutRate, safetyPct, returnFixed)
    : 0;

  // Хранение
  const storageTotal = Math.round(liters * storageTariff * turnoverDays);

  // Платная приёмка
  const acceptanceUzs = Math.max(0, Number(input.acceptanceUzs) || 0);

  // --- К перечислению (сумма вывода продавцу) ---
  const toSeller = priceUzs - fee - acquiring - ads - totalLogUzs - storageTotal - acceptanceUzs;

  // --- НДС: исходящий от цены − входящий от себестоимости [+ услуги WB] ---
  // Цена всегда считается «с НДС» (mode = 'with')
  const outputVat = Math.round(vatFromAmount(priceUzs, vatPct, 'with'));

  // Входящий НДС: если передан inputVat (из калькулятора себестоимости) — берём его,
  // иначе выделяем из себестоимости по той же ставке
  const hasLinkedInputVat = input.inputVat != null && Number(input.inputVat) > 0.0001;
  const inputVatCost = hasLinkedInputVat
    ? Number(input.inputVat)
    : Math.round(vatFromAmount(costUzs, vatPct, 'with'));

  const wbServicesTotal = fee + acquiring + ads + totalLogUzs + storageTotal + acceptanceUzs;
  const creditServices = input.creditVatOnWbServices ?? CREDIT_VAT_ON_WB_SERVICES;
  const inputVatServices = creditServices
    ? Math.round(vatFromAmount(wbServicesTotal, vatPct, 'with'))
    : 0;

  const inputVat = inputVatCost + inputVatServices;
  const vatPayable = outputVat - inputVat;

  // --- Итог ---
  const netProfit = toSeller - costUzs - vatPayable;
  const marginPct = priceUzs > 0 ? (netProfit / priceUzs) * 100 : 0;
  const roiPct = costUzs > 0 ? (netProfit / costUzs) * 100 : 0;
  const buyerPrice = priceUzs > 0 ? Math.round(priceUzs * (1 - sppPct / 100)) : 0;

  return {
    // входы (нормализованные)
    priceUzs,
    sppPct,
    acquiPct,
    buyerPrice,
    liters,
    buyoutPct,
    turnoverDays,
    exchangeRate,
    costUzs,
    costRubRaw,

    // удержания WB
    fee,              // комиссия
    acquiring,        // эквайринг
    ads,              // реклама (ДРР)
    totalLogUzs,      // логистика
    storageTotal,     // хранение
    acceptanceUzs,    // приёмка

    // вывод и НДС
    toSeller,         // к перечислению
    outputVat,        // исходящий НДС
    inputVatCost,     // входящий НДС (себестоимость)
    inputVatServices, // входящий НДС (услуги WB), обычно 0
    inputVat,         // входящий НДС итого
    vatPayable,       // НДС к оплате

    // прибыль
    netProfit,        // чистая прибыль
    marginPct,        // маржа %
    roiPct,           // ROI %
  };
}

// ── Пример запуска ───────────────────────────────────────────────────────────
//
// Node:   node wb-unit-economics-logic.js
// Браузер: подключить <script src="wb-unit-economics-logic.js"></script>
//
// const result = computeWbUnitEconomics({
//   priceUzs: 150000,
//   commPct: 15,
//   drrPct: 5,
//   acquiPct: 1.5,
//   costUzs: 60000,
//   liters: 2.28,
//   buyoutPct: 87,
//   vatPct: 12,
//   storageTariff: 42,
//   turnoverDays: 30,
//   safetyPct: 10,
//   returnFixed: 7200,
// });
// console.log(result);

// Экспорт для Node / модулей
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WB_UZ_DEFAULTS,
    WB_UZ_LOGISTICS_TARIFFS,
    CREDIT_VAT_ON_WB_SERVICES,
    vatFromAmount,
    wbUzDeliveryByVolume,
    wbUzLogistics,
    computeWbUnitEconomics,
  };
}

// Демо при прямом запуске в Node
if (typeof require !== 'undefined' && require.main === module) {
  const demo = computeWbUnitEconomics({
    priceUzs: 150000,
    commPct: 15,
    drrPct: 5,
    acquiPct: 1.5,
    costUzs: 60000,
    liters: 2.28,
    buyoutPct: 87,
    vatPct: 12,
    storageTariff: 42,
    turnoverDays: 30,
    safetyPct: 10,
    returnFixed: 7200,
  });

  const fmt = (v) => new Intl.NumberFormat('ru-RU').format(Math.round(v));
  console.log('=== Демо: юнит-экономика WB UZ ===');
  console.log('Цена:            ', fmt(demo.priceUzs), 'сум');
  console.log('Комиссия:        ', fmt(demo.fee), 'сум');
  console.log('Эквайринг:       ', fmt(demo.acquiring), 'сум');
  console.log('Реклама (ДРР):   ', fmt(demo.ads), 'сум');
  console.log('Логистика:       ', fmt(demo.totalLogUzs), 'сум');
  console.log('Хранение:        ', fmt(demo.storageTotal), 'сум');
  console.log('К перечислению:  ', fmt(demo.toSeller), 'сум');
  console.log('Исходящий НДС:   ', fmt(demo.outputVat), 'сум');
  console.log('Входящий НДС:    ', fmt(demo.inputVat), 'сум');
  console.log('НДС к оплате:    ', fmt(demo.vatPayable), 'сум');
  console.log('Себестоимость:   ', fmt(demo.costUzs), 'сум');
  console.log('Чистая прибыль:  ', fmt(demo.netProfit), 'сум');
  console.log('Маржа:           ', demo.marginPct.toFixed(1) + '%');
  console.log('ROI:             ', demo.roiPct.toFixed(1) + '%');
}
