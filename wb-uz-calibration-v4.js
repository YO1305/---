/**
 * =============================================================================
 * WB UZ UNIT ECONOMICS — PATCH v4
 * Исправление: прогнозная комиссия WB берется ТОЛЬКО из commPct,
 * а исторический AH/P используется только как справочная калибровка.
 * =============================================================================
 *
 * Что исправлено относительно v3:
 * 1) sellerPayoutRatio больше НЕ заменяет комиссию WB в прогнозе.
 * 2) Комиссия WB в прогнозе = priceUzs * commPct / 100.
 * 3) AH/P, СПП факт и прочие исторические коэффициенты выводятся справочно.
 * 4) Логистика, BF и хранение могут калиброваться по истории WB.
 * 5) Есть отдельный факт-режим для расчета по отчету WB: AH - AK - BF - ...
 *
 * Подключение:
 * - Вставь этот файл ПОСЛЕ основного wb-unit-economics-logic.js,
 *   чтобы были доступны vatFromAmount(), wbUzLogistics() и WB_UZ_DEFAULTS.
 * - Используй computeWbUnitEconomicsForecastV4(input) для прогноза цены.
 * - Используй computeWbUnitEconomicsFactV4(input) для анализа загруженного отчета WB.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Калибровки из ваших WB-отчетов
// ─────────────────────────────────────────────────────────────────────────────

const WB_UZ_GLOBAL_CALIBRATION_V4 = {
  logisticsCoef: 0.95,      // факт AK / прогнозная логистика SaaS
  bfPerUnit: 3071,          // средний BF на 1 продажу, сум
  storagePctOfPrice: 1.15,  // хранение как минимум % от цены/реализации
  historicalSppPct: 24.65,  // справочно: средний факт СПП
  historicalSellerPayoutRatio: 1.054, // справочно: AH / P
};

const WB_UZ_CATEGORY_CALIBRATION_V4 = {
  'Крашёное постельное': {
    logisticsCoef: 1.02,
    bfPerUnit: 5617,
    historicalSppPct: 27.1,
    historicalSellerPayoutRatio: 1.093,
  },
  'Простыни 160×200': {
    logisticsCoef: 0.71,
    bfPerUnit: 1893,
    historicalSppPct: 18.6,
    historicalSellerPayoutRatio: 0.969,
  },
  'Наволочки 70×70': {
    logisticsCoef: 0.95,
    bfPerUnit: 949,
    historicalSppPct: 24.4,
    historicalSellerPayoutRatio: 1.047,
  },
  'Наволочки 50×70': {
    logisticsCoef: 0.90,
    bfPerUnit: 854,
    historicalSppPct: 24.0,
    historicalSellerPayoutRatio: 1.041,
  },
  'Простыни 140×200': {
    logisticsCoef: 0.98,
    bfPerUnit: 1589,
    historicalSppPct: 18.8,
    historicalSellerPayoutRatio: 0.967,
  },
  'Простыни 180×200': {
    logisticsCoef: 1.00,
    bfPerUnit: 1962,
    historicalSppPct: 17.9,
    historicalSellerPayoutRatio: 0.960,
  },
  'Kids': {
    logisticsCoef: 1.06,
    bfPerUnit: 3840,
    historicalSppPct: 24.7,
    historicalSellerPayoutRatio: 1.056,
  },
  'Сатин / stripe': {
    logisticsCoef: 0.88,
    bfPerUnit: 6380,
    historicalSppPct: 19.1,
    historicalSellerPayoutRatio: 0.982,
  },
};

// Можно постепенно заполнять после накопления факта по каждому SKU.
// Если SKU есть здесь — он имеет приоритет над категорией.
const WB_UZ_SKU_CALIBRATION_V4 = {
  'BHKRASH1-SIN': {
    logisticsCoef: 1.02,
    bfPerUnit: 4927,
    historicalSppPct: 27.1,
    historicalSellerPayoutRatio: 1.093,
    sampleSales: 22,
  },
};

function roundUzs(value) {
  return Math.round(Number(value) || 0);
}

function clampNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getWbCalibrationV4(input = {}) {
  const sku = String(input.sku || input.vendorCode || '').trim().toUpperCase();
  const category = String(input.category || '').trim();

  const globalCal = WB_UZ_GLOBAL_CALIBRATION_V4;
  const categoryCal = WB_UZ_CATEGORY_CALIBRATION_V4[category] || {};
  const skuCal = WB_UZ_SKU_CALIBRATION_V4[sku] || {};

  // Приоритет: ручной override → SKU → категория → глобально.
  return {
    source: Object.keys(skuCal).length ? 'sku' : (Object.keys(categoryCal).length ? 'category' : 'global'),
    sku,
    category,
    logisticsCoef: Number(input.logisticsCoefOverride || skuCal.logisticsCoef || categoryCal.logisticsCoef || globalCal.logisticsCoef),
    bfPerUnit: roundUzs(input.bfPerUnitOverride ?? skuCal.bfPerUnit ?? categoryCal.bfPerUnit ?? globalCal.bfPerUnit),
    storagePctOfPrice: Number(input.storagePctOverride ?? skuCal.storagePctOfPrice ?? categoryCal.storagePctOfPrice ?? globalCal.storagePctOfPrice),
    historicalSppPct: Number(skuCal.historicalSppPct ?? categoryCal.historicalSppPct ?? globalCal.historicalSppPct),
    historicalSellerPayoutRatio: Number(skuCal.historicalSellerPayoutRatio ?? categoryCal.historicalSellerPayoutRatio ?? globalCal.historicalSellerPayoutRatio),
    sampleSales: Number(skuCal.sampleSales || 0),
  };
}

/**
 * Прогнозная логистика:
 * базовая логистика из старой формулы × коэффициент факта WB.
 */
function forecastLogisticsCalibratedV4({ liters, buyoutPct, safetyPct, returnFixed, calibration }) {
  const buyoutRate = clampNumber(buyoutPct, 1, 100, 87) / 100;
  const base = liters > 0 ? wbUzLogistics(liters, buyoutRate, safetyPct, returnFixed) : 0;
  const coef = Number(calibration?.logisticsCoef || 1);
  return {
    baseLogisticsUzs: roundUzs(base),
    logisticsCoef: coef,
    logisticsUzs: roundUzs(base * coef),
  };
}

/**
 * Прогноз хранения:
 * max(литры × тариф × дни, цена × исторический % хранения).
 */
function forecastStorageCalibratedV4({ priceUzs, liters, storageTariff, turnoverDays, calibration }) {
  const byLiters = roundUzs(liters * storageTariff * turnoverDays);
  const pct = Number(calibration?.storagePctOfPrice || 0);
  const byPct = roundUzs(priceUzs * pct / 100);
  return {
    storageByLitersUzs: byLiters,
    storageByPctUzs: byPct,
    storagePctOfPrice: pct,
    storageTotalUzs: Math.max(byLiters, byPct),
  };
}

/**
 * =============================================================================
 * ПРОГНОЗ ДО ПРОДАЖИ
 * =============================================================================
 * ВАЖНО:
 * - Комиссия WB считается только из input.commPct.
 * - AH/P не используется для прибыли, только выводится как историческая справка.
 */
function computeWbUnitEconomicsForecastV4(input = {}) {
  const d = typeof WB_UZ_DEFAULTS !== 'undefined'
    ? WB_UZ_DEFAULTS
    : {
        exchangeRate: 168,
        buyoutPct: 87,
        vatPct: 12,
        storageTariff: 42,
        safetyMarginPct: 10,
        returnFixed: 7200,
      };

  const priceUzs = Math.max(0, Number(input.priceUzs) || 0);
  const commPct = Math.max(0, Number(input.commPct) || 0);
  const acquiPct = clampNumber(input.acquiPct, 0, 100, 0);
  const drrPct = clampNumber(input.drrPct, 0, 100, 0);
  const sppPct = clampNumber(input.sppPct, 0, 100, 0);

  const buyoutPct = clampNumber(input.buyoutPct ?? d.buyoutPct, 1, 100, d.buyoutPct || 87);
  const vatPct = Math.max(0, Number(input.vatPct ?? d.vatPct ?? 12));
  const storageTariff = Math.max(0, Number(input.storageTariff ?? d.storageTariff ?? 42));
  const turnoverDays = Math.max(0, Number(input.turnoverDays) || 0);
  const safetyPct = Math.max(0, Number(input.safetyPct ?? d.safetyMarginPct ?? 10));
  const returnFixed = Math.max(0, Number(input.returnFixed ?? d.returnFixed ?? 7200));
  const exchangeRate = Math.max(1, Number(input.exchangeRate ?? d.exchangeRate ?? 168));

  const costRubRaw = Math.max(0, Number(input.costRub) || 0);
  const costUzsRaw = Math.max(0, Number(input.costUzs) || 0);
  const costUzs = costUzsRaw > 0 ? costUzsRaw : roundUzs(costRubRaw * exchangeRate);
  const liters = Math.max(0, Number(input.liters) || 0);

  const calibration = getWbCalibrationV4(input);

  // Покупательская цена после СПП — только для отображения.
  // Комиссия WB в прогнозе считается от priceUzs, а не от buyerPrice.
  const buyerPrice = roundUzs(priceUzs * (1 - sppPct / 100));

  // Главная правка: комиссия WB только по настройке commPct.
  const commissionTariffUzs = roundUzs(priceUzs * commPct / 100);
  const acquiringUzs = roundUzs(priceUzs * acquiPct / 100);
  const adsUzs = roundUzs(priceUzs * drrPct / 100);

  const logistics = forecastLogisticsCalibratedV4({
    liters,
    buyoutPct,
    safetyPct,
    returnFixed,
    calibration,
  });

  const bfForecastUzs = roundUzs(input.bfUzs ?? calibration.bfPerUnit);

  const storage = forecastStorageCalibratedV4({
    priceUzs,
    liters,
    storageTariff,
    turnoverDays,
    calibration,
  });

  const acceptanceUzs = Math.max(0, Number(input.acceptanceUzs) || 0);

  // Прогноз к перечислению продавцу: НЕ используем AH/P.
  const toSellerForecast =
    priceUzs
    - commissionTariffUzs
    - acquiringUzs
    - adsUzs
    - logistics.logisticsUzs
    - bfForecastUzs
    - storage.storageTotalUzs
    - acceptanceUzs;

  const outputVat = roundUzs(vatFromAmount(priceUzs, vatPct, 'with'));

  const hasLinkedInputVat = input.inputVat != null && Number(input.inputVat) > 0.0001;
  const inputVatCost = hasLinkedInputVat
    ? roundUzs(input.inputVat)
    : roundUzs(vatFromAmount(costUzs, vatPct, 'with'));

  const creditVatOnWbServices = Boolean(input.creditVatOnWbServices || false);
  const wbServicesTotal = commissionTariffUzs + acquiringUzs + adsUzs + logistics.logisticsUzs + bfForecastUzs + storage.storageTotalUzs + acceptanceUzs;
  const inputVatServices = creditVatOnWbServices
    ? roundUzs(vatFromAmount(wbServicesTotal, vatPct, 'with'))
    : 0;

  const inputVat = inputVatCost + inputVatServices;
  const vatPayable = outputVat - inputVat;

  const netProfit = roundUzs(toSellerForecast - costUzs - vatPayable);
  const marginPct = priceUzs > 0 ? (netProfit / priceUzs) * 100 : 0;
  const roiPct = costUzs > 0 ? (netProfit / costUzs) * 100 : 0;

  // Справочно: что показала история WB, но не участвует в прогнозе прибыли.
  const historicalPayoutByRatio = roundUzs(priceUzs * calibration.historicalSellerPayoutRatio);
  const historicalEffectiveGoodsDeductionUzs = roundUzs(priceUzs - historicalPayoutByRatio);
  const historicalEffectiveGoodsDeductionPct = priceUzs > 0
    ? historicalEffectiveGoodsDeductionUzs / priceUzs * 100
    : 0;

  return {
    mode: 'forecast_commission_pct',

    // Входы
    priceUzs,
    buyerPrice,
    sppPct,
    commPct,
    acquiPct,
    drrPct,
    liters,
    buyoutPct,
    turnoverDays,
    costUzs,

    // Прямые удержания прогноза
    commissionTariffUzs,
    acquiringUzs,
    adsUzs,
    baseLogisticsUzs: logistics.baseLogisticsUzs,
    logisticsCoef: logistics.logisticsCoef,
    logisticsUzs: logistics.logisticsUzs,
    bfForecastUzs,
    storageByLitersUzs: storage.storageByLitersUzs,
    storageByPctUzs: storage.storageByPctUzs,
    storagePctOfPrice: storage.storagePctOfPrice,
    storageTotalUzs: storage.storageTotalUzs,
    acceptanceUzs,

    // Вывод / НДС / прибыль
    toSellerForecast,
    outputVat,
    inputVatCost,
    inputVatServices,
    inputVat,
    vatPayable,
    netProfit,
    marginPct,
    roiPct,

    // История WB — только справочно
    calibrationSource: calibration.source,
    historicalSppPct: calibration.historicalSppPct,
    historicalSellerPayoutRatio: calibration.historicalSellerPayoutRatio,
    historicalPayoutByRatio,
    historicalEffectiveGoodsDeductionUzs,
    historicalEffectiveGoodsDeductionPct,
    commissionNote: 'В прогнозе комиссия WB считается только по commPct. AH/P показан справочно и не заменяет комиссию.',
  };
}

/**
 * =============================================================================
 * ФАКТ ПО ОТЧЕТУ WB
 * =============================================================================
 * Этот режим используется только после загрузки отчета WB.
 * Здесь уже можно брать реальные AH, AK, BF, BH, BI, BJ.
 */
function computeWbUnitEconomicsFactV4(input = {}) {
  const vatPct = Math.max(0, Number(input.vatPct ?? 12));
  const realizedWbUzs = Math.max(0, Number(input.realizedWbUzs) || 0); // P
  const toSellerGoodsUzs = Number(input.toSellerGoodsUzs) || 0;         // AH
  const logisticsFactUzs = Math.max(0, Number(input.logisticsFactUzs) || 0); // AK
  const bfFactUzs = Math.max(0, Number(input.bfFactUzs) || 0);               // BF
  const storageFactUzs = Math.max(0, Number(input.storageFactUzs) || 0);     // BH / распределение
  const adsFactUzs = Math.max(0, Number(input.adsFactUzs) || 0);             // BI / распределение
  const acceptanceFactUzs = Math.max(0, Number(input.acceptanceFactUzs) || 0); // BJ
  const otherCostsUzs = Math.max(0, Number(input.otherCostsUzs) || 0);
  const costUzs = Math.max(0, Number(input.costUzs) || 0);

  const outputVat = roundUzs(vatFromAmount(realizedWbUzs, vatPct, 'with'));
  const inputVatCost = input.inputVat != null && Number(input.inputVat) > 0.0001
    ? roundUzs(input.inputVat)
    : roundUzs(vatFromAmount(costUzs, vatPct, 'with'));
  const vatPayable = outputVat - inputVatCost;

  const wbCostsFact = logisticsFactUzs + bfFactUzs + storageFactUzs + adsFactUzs + acceptanceFactUzs + otherCostsUzs;
  const netProfit = roundUzs(toSellerGoodsUzs - wbCostsFact - costUzs - vatPayable);

  return {
    mode: 'fact_wb_report',
    realizedWbUzs,
    toSellerGoodsUzs,
    logisticsFactUzs,
    bfFactUzs,
    storageFactUzs,
    adsFactUzs,
    acceptanceFactUzs,
    otherCostsUzs,
    wbCostsFact,
    costUzs,
    outputVat,
    inputVatCost,
    vatPayable,
    netProfit,
    marginPct: realizedWbUzs > 0 ? netProfit / realizedWbUzs * 100 : 0,
    roiPct: costUzs > 0 ? netProfit / costUzs * 100 : 0,
    effectiveGoodsDeductionUzs: roundUzs(realizedWbUzs - toSellerGoodsUzs),
    effectiveGoodsDeductionPct: realizedWbUzs > 0 ? (realizedWbUzs - toSellerGoodsUzs) / realizedWbUzs * 100 : 0,
  };
}

// Экспорт для Node / модулей
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WB_UZ_GLOBAL_CALIBRATION_V4,
    WB_UZ_CATEGORY_CALIBRATION_V4,
    WB_UZ_SKU_CALIBRATION_V4,
    getWbCalibrationV4,
    forecastLogisticsCalibratedV4,
    forecastStorageCalibratedV4,
    computeWbUnitEconomicsForecastV4,
    computeWbUnitEconomicsFactV4,
  };
}
