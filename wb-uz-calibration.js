/**
 * Calibrated WB UZ unit-economics patch.
 * Built from uploaded WB weekly reports + current prices + cost table.
 * Use this over the old pure-volume logistics model.
 */

const WB_UZ_GLOBAL_CALIBRATION = {
  "logisticsCoef": 0.9515,
  "bfPerUnit": 3071,
  "sellerPayoutRatio": 1.0541,
  "sppPct": 24.65,
  "minSkuSampleQty": 5
};

const WB_UZ_CATEGORY_CALIBRATION = {
  "Крашёное постельное": {
    "logisticsCoef": 1.0192,
    "bfPerUnit": 5617,
    "sellerPayoutRatio": 1.0929,
    "sppPct": 27.1,
    "buyoutPct": 78.9,
    "sampleQty": 1257
  },
  "Простыни 160x200": {
    "logisticsCoef": 0.7116,
    "bfPerUnit": 1893,
    "sellerPayoutRatio": 0.969,
    "sppPct": 18.56,
    "buyoutPct": 88.81,
    "sampleQty": 756
  },
  "Наволочки 70x70": {
    "logisticsCoef": 0.9487,
    "bfPerUnit": 949,
    "sellerPayoutRatio": 1.047,
    "sppPct": 24.44,
    "buyoutPct": 89.05,
    "sampleQty": 468
  },
  "Наволочки 50x70": {
    "logisticsCoef": 0.9002,
    "bfPerUnit": 854,
    "sellerPayoutRatio": 1.0413,
    "sppPct": 24.03,
    "buyoutPct": 91.27,
    "sampleQty": 423
  },
  "Простыни 140x200": {
    "logisticsCoef": 0.9771,
    "bfPerUnit": 1589,
    "sellerPayoutRatio": 0.9674,
    "sppPct": 18.76,
    "buyoutPct": 92.89,
    "sampleQty": 290
  },
  "Простыни 180x200": {
    "logisticsCoef": 1.0021,
    "bfPerUnit": 1962,
    "sellerPayoutRatio": 0.9596,
    "sppPct": 17.87,
    "buyoutPct": 84.59,
    "sampleQty": 160
  },
  "Постельное Kids": {
    "logisticsCoef": 1.0552,
    "bfPerUnit": 3840,
    "sellerPayoutRatio": 1.0565,
    "sppPct": 24.72,
    "buyoutPct": 83.57,
    "sampleQty": 141
  },
  "Постельное сатин/stripe": {
    "logisticsCoef": 0.8847,
    "bfPerUnit": 6380,
    "sellerPayoutRatio": 0.9817,
    "sppPct": 19.11,
    "buyoutPct": 74.63,
    "sampleQty": 36
  }
};

const WB_UZ_SKU_CALIBRATION = {
  "BHKRASH-BEJ": {
    "category": "Крашёное постельное",
    "logisticsCoef": 1.335,
    "bfPerUnit": 9975,
    "sellerPayoutRatio": 1.1896,
    "sppPct": 31.83,
    "buyoutPct": 80.0,
    "sampleQty": 9
  },
  "BHKRASH-KOR": {
    "category": "Крашёное постельное",
    "logisticsCoef": 1.0006,
    "bfPerUnit": 5908,
    "sellerPayoutRatio": 1.112,
    "sppPct": 28.24,
    "buyoutPct": 76.71,
    "sampleQty": 318
  },
  "BHKRASH-SIN": {
    "category": "Крашёное постельное",
    "logisticsCoef": 0.9471,
    "bfPerUnit": 5516,
    "sellerPayoutRatio": 1.1249,
    "sppPct": 29.04,
    "buyoutPct": 79.22,
    "sampleQty": 346
  },
  "BHKRASH-SER": {
    "category": "Крашёное постельное",
    "logisticsCoef": 1.2057,
    "bfPerUnit": 5858,
    "sellerPayoutRatio": 1.0966,
    "sppPct": 27.3,
    "buyoutPct": 77.05,
    "sampleQty": 421
  },
  "BHKIDS-KIN1": {
    "category": "Постельное Kids",
    "logisticsCoef": 1.3092,
    "bfPerUnit": 5606,
    "sellerPayoutRatio": 1.2619,
    "sppPct": 36.29,
    "buyoutPct": 73.91,
    "sampleQty": 11
  },
  "BHKIDS1": {
    "category": "Постельное Kids",
    "logisticsCoef": 0.9388,
    "bfPerUnit": 4439,
    "sellerPayoutRatio": 1.0914,
    "sppPct": 26.85,
    "buyoutPct": 76.6,
    "sampleQty": 25
  },
  "BHKIDS2": {
    "category": "Постельное Kids",
    "logisticsCoef": 1.0758,
    "bfPerUnit": 3536,
    "sellerPayoutRatio": 1.0568,
    "sppPct": 24.78,
    "buyoutPct": 85.71,
    "sampleQty": 85
  },
  "BHR2": {
    "category": "Постельное сатин/stripe",
    "logisticsCoef": 0.9407,
    "bfPerUnit": 6487,
    "sellerPayoutRatio": 0.9902,
    "sppPct": 19.82,
    "buyoutPct": 68.75,
    "sampleQty": 12
  },
  "BHR3": {
    "category": "Постельное сатин/stripe",
    "logisticsCoef": 0.951,
    "bfPerUnit": 8602,
    "sellerPayoutRatio": 1.0068,
    "sppPct": 21.1,
    "buyoutPct": 67.65,
    "sampleQty": 12
  },
  "BHKRASH-BOLOT": {
    "category": "Крашёное постельное",
    "logisticsCoef": 0.8159,
    "bfPerUnit": 4955,
    "sellerPayoutRatio": 1.0455,
    "sppPct": 24.3,
    "buyoutPct": 85.19,
    "sampleQty": 57
  },
  "BHR1": {
    "category": "Постельное сатин/stripe",
    "logisticsCoef": 0.7184,
    "bfPerUnit": 4051,
    "sellerPayoutRatio": 0.9446,
    "sppPct": 15.95,
    "buyoutPct": 87.5,
    "sampleQty": 12
  },
  "BHPROS-1": {
    "category": "Простыни 160x200",
    "logisticsCoef": 0.59,
    "bfPerUnit": 1627,
    "sellerPayoutRatio": 0.9639,
    "sppPct": 18.1,
    "buyoutPct": 89.52,
    "sampleQty": 181
  },
  "BHPROS-2": {
    "category": "Простыни 160x200",
    "logisticsCoef": 0.6329,
    "bfPerUnit": 1953,
    "sellerPayoutRatio": 0.994,
    "sppPct": 20.5,
    "buyoutPct": 90.65,
    "sampleQty": 191
  },
  "BHPROS": {
    "category": "Простыни 160x200",
    "logisticsCoef": 0.6628,
    "bfPerUnit": 1941,
    "sellerPayoutRatio": 0.9722,
    "sppPct": 18.73,
    "buyoutPct": 86.28,
    "sampleQty": 196
  },
  "BHKRASH-GOLUB": {
    "category": "Крашёное постельное",
    "logisticsCoef": 0.5422,
    "bfPerUnit": 4399,
    "sellerPayoutRatio": 0.9354,
    "sppPct": 15.55,
    "buyoutPct": 83.53,
    "sampleQty": 57
  },
  "BHNAV5": {
    "category": "Наволочки 50x70",
    "logisticsCoef": 0.8591,
    "bfPerUnit": 807,
    "sellerPayoutRatio": 1.0421,
    "sppPct": 24.04,
    "buyoutPct": 92.11,
    "sampleQty": 64
  },
  "BHPROS-4": {
    "category": "Простыни 160x200",
    "logisticsCoef": 0.9773,
    "bfPerUnit": 2051,
    "sellerPayoutRatio": 0.955,
    "sppPct": 17.69,
    "buyoutPct": 90.11,
    "sampleQty": 73
  },
  "BHPROS180-1": {
    "category": "Простыни 180x200",
    "logisticsCoef": 0.9935,
    "bfPerUnit": 1900,
    "sellerPayoutRatio": 0.9635,
    "sppPct": 18.19,
    "buyoutPct": 80.95,
    "sampleQty": 26
  },
  "BHNAV6": {
    "category": "Наволочки 50x70",
    "logisticsCoef": 0.8077,
    "bfPerUnit": 906,
    "sellerPayoutRatio": 1.0321,
    "sppPct": 23.07,
    "buyoutPct": 92.75,
    "sampleQty": 59
  },
  "BHNAV2": {
    "category": "Наволочки 50x70",
    "logisticsCoef": 0.9357,
    "bfPerUnit": 898,
    "sellerPayoutRatio": 1.0431,
    "sppPct": 24.23,
    "buyoutPct": 91.8,
    "sampleQty": 51
  },
  "BHNAV": {
    "category": "Наволочки 50x70",
    "logisticsCoef": 0.8863,
    "bfPerUnit": 789,
    "sellerPayoutRatio": 1.031,
    "sppPct": 23.25,
    "buyoutPct": 90.0,
    "sampleQty": 56
  },
  "BHNAV3": {
    "category": "Наволочки 50x70",
    "logisticsCoef": 0.8739,
    "bfPerUnit": 818,
    "sellerPayoutRatio": 1.0464,
    "sppPct": 24.63,
    "buyoutPct": 91.25,
    "sampleQty": 66
  },
  "BHNAV1": {
    "category": "Наволочки 50x70",
    "logisticsCoef": 1.094,
    "bfPerUnit": 888,
    "sellerPayoutRatio": 1.0466,
    "sppPct": 24.45,
    "buyoutPct": 90.24,
    "sampleQty": 66
  },
  "BHNAV4": {
    "category": "Наволочки 50x70",
    "logisticsCoef": 0.8732,
    "bfPerUnit": 875,
    "sellerPayoutRatio": 1.0473,
    "sppPct": 24.47,
    "buyoutPct": 90.79,
    "sampleQty": 61
  },
  "BHPROS-5": {
    "category": "Простыни 160x200",
    "logisticsCoef": 0.9415,
    "bfPerUnit": 2051,
    "sellerPayoutRatio": 0.9532,
    "sppPct": 17.23,
    "buyoutPct": 89.47,
    "sampleQty": 60
  },
  "BHNAV70-4": {
    "category": "Наволочки 70x70",
    "logisticsCoef": 1.0322,
    "bfPerUnit": 1003,
    "sellerPayoutRatio": 1.0564,
    "sppPct": 25.07,
    "buyoutPct": 90.74,
    "sampleQty": 88
  },
  "BHNAV70-1": {
    "category": "Наволочки 70x70",
    "logisticsCoef": 0.9109,
    "bfPerUnit": 791,
    "sellerPayoutRatio": 1.0326,
    "sppPct": 23.32,
    "buyoutPct": 93.1,
    "sampleQty": 50
  },
  "BHPROS-3": {
    "category": "Простыни 160x200",
    "logisticsCoef": 0.951,
    "bfPerUnit": 2015,
    "sellerPayoutRatio": 0.9422,
    "sppPct": 16.49,
    "buyoutPct": 86.67,
    "sampleQty": 55
  },
  "BHNAV70-3": {
    "category": "Наволочки 70x70",
    "logisticsCoef": 0.8991,
    "bfPerUnit": 829,
    "sellerPayoutRatio": 1.0413,
    "sppPct": 23.92,
    "buyoutPct": 90.62,
    "sampleQty": 78
  },
  "BHPROS180-2": {
    "category": "Простыни 180x200",
    "logisticsCoef": 0.9151,
    "bfPerUnit": 1971,
    "sellerPayoutRatio": 0.9488,
    "sppPct": 17.38,
    "buyoutPct": 92.86,
    "sampleQty": 24
  },
  "BHNAV70-6": {
    "category": "Наволочки 70x70",
    "logisticsCoef": 0.8825,
    "bfPerUnit": 1075,
    "sellerPayoutRatio": 1.0456,
    "sppPct": 24.3,
    "buyoutPct": 86.67,
    "sampleQty": 66
  },
  "BHPROS140-2": {
    "category": "Простыни 140x200",
    "logisticsCoef": 0.9558,
    "bfPerUnit": 1628,
    "sellerPayoutRatio": 0.9676,
    "sppPct": 18.48,
    "buyoutPct": 91.43,
    "sampleQty": 58
  },
  "BHPROS180": {
    "category": "Простыни 180x200",
    "logisticsCoef": 1.0158,
    "bfPerUnit": 2010,
    "sellerPayoutRatio": 0.951,
    "sppPct": 16.78,
    "buyoutPct": 84.38,
    "sampleQty": 22
  },
  "BHPROS140": {
    "category": "Простыни 140x200",
    "logisticsCoef": 0.9484,
    "bfPerUnit": 1400,
    "sellerPayoutRatio": 0.9663,
    "sppPct": 18.76,
    "buyoutPct": 96.0,
    "sampleQty": 46
  },
  "BHPROS140-1": {
    "category": "Простыни 140x200",
    "logisticsCoef": 0.9832,
    "bfPerUnit": 1768,
    "sellerPayoutRatio": 0.9742,
    "sppPct": 19.49,
    "buyoutPct": 89.53,
    "sampleQty": 68
  },
  "BHPROS180-5": {
    "category": "Простыни 180x200",
    "logisticsCoef": 1.0299,
    "bfPerUnit": 1676,
    "sellerPayoutRatio": 0.9768,
    "sppPct": 19.09,
    "buyoutPct": 83.02,
    "sampleQty": 35
  },
  "BHNAV70": {
    "category": "Наволочки 70x70",
    "logisticsCoef": 0.9337,
    "bfPerUnit": 999,
    "sellerPayoutRatio": 1.0497,
    "sppPct": 24.78,
    "buyoutPct": 90.2,
    "sampleQty": 82
  },
  "BHNAV70-5": {
    "category": "Наволочки 70x70",
    "logisticsCoef": 1.0147,
    "bfPerUnit": 1109,
    "sellerPayoutRatio": 1.0521,
    "sppPct": 24.63,
    "buyoutPct": 80.3,
    "sampleQty": 40
  },
  "BHNAV70-2": {
    "category": "Наволочки 70x70",
    "logisticsCoef": 0.9331,
    "bfPerUnit": 849,
    "sellerPayoutRatio": 1.0496,
    "sppPct": 24.81,
    "buyoutPct": 88.1,
    "sampleQty": 64
  },
  "BHKIDS1-GIR": {
    "category": "Постельное Kids",
    "logisticsCoef": 0.9629,
    "bfPerUnit": 3415,
    "sellerPayoutRatio": 0.9319,
    "sppPct": 15.44,
    "buyoutPct": 88.46,
    "sampleQty": 20
  },
  "BHKRASH1-SIN": {
    "category": "Крашёное постельное",
    "logisticsCoef": 0.941,
    "bfPerUnit": 4927,
    "sellerPayoutRatio": 0.9524,
    "sppPct": 17.49,
    "buyoutPct": 95.83,
    "sampleQty": 22
  },
  "BHPROS140-5": {
    "category": "Простыни 140x200",
    "logisticsCoef": 1.0272,
    "bfPerUnit": 1633,
    "sellerPayoutRatio": 0.9551,
    "sppPct": 17.9,
    "buyoutPct": 91.23,
    "sampleQty": 47
  },
  "BHPROS140-3": {
    "category": "Простыни 140x200",
    "logisticsCoef": 0.9928,
    "bfPerUnit": 1633,
    "sellerPayoutRatio": 0.9733,
    "sppPct": 19.21,
    "buyoutPct": 93.02,
    "sampleQty": 37
  },
  "BHPROS180-4": {
    "category": "Простыни 180x200",
    "logisticsCoef": 0.9991,
    "bfPerUnit": 2203,
    "sellerPayoutRatio": 0.9534,
    "sppPct": 17.6,
    "buyoutPct": 86.49,
    "sampleQty": 27
  },
  "BHPROS140-4": {
    "category": "Простыни 140x200",
    "logisticsCoef": 0.9464,
    "bfPerUnit": 1310,
    "sellerPayoutRatio": 0.9662,
    "sppPct": 18.5,
    "buyoutPct": 100,
    "sampleQty": 34
  },
  "BHPROS180-3": {
    "category": "Простыни 180x200",
    "logisticsCoef": 1.0462,
    "bfPerUnit": 2111,
    "sellerPayoutRatio": 0.9569,
    "sppPct": 17.56,
    "buyoutPct": 80.95,
    "sampleQty": 26
  },
  "BHKRASH1-SER": {
    "category": "Крашёное постельное",
    "logisticsCoef": 1.1246,
    "bfPerUnit": 3940,
    "sellerPayoutRatio": 0.9818,
    "sppPct": 19.93,
    "buyoutPct": 84.21,
    "sampleQty": 13
  },
  "BHKRASH1-KOR": {
    "category": "Крашёное постельное",
    "logisticsCoef": 0.9834,
    "bfPerUnit": 1748,
    "sellerPayoutRatio": 0.9065,
    "sppPct": 14.5,
    "buyoutPct": 100,
    "sampleQty": 14
  }
};

function getWbCalibration(sku, category) {
  const s = String(sku || '').trim().toUpperCase();
  const skuCal = WB_UZ_SKU_CALIBRATION[s];
  if (skuCal && skuCal.sampleQty >= WB_UZ_GLOBAL_CALIBRATION.minSkuSampleQty) return { ...skuCal, source: 'SKU' };
  const catCal = WB_UZ_CATEGORY_CALIBRATION[category || (skuCal && skuCal.category)];
  if (catCal) return { ...catCal, source: 'CATEGORY' };
  return { ...WB_UZ_GLOBAL_CALIBRATION, source: 'GLOBAL' };
}

// Requires existing functions: wbUzLogistics(), vatFromAmount()
function computeWbUnitEconomicsCalibrated(input = {}) {
  const vatPct = Number(input.vatPct ?? 12);
  const sku = String(input.sku || '').trim().toUpperCase();
  const category = input.category || '';
  const priceUzs = Math.max(0, Number(input.priceUzs) || 0); // seller price after seller discount, before WB SPP
  const drrPct = Math.max(0, Number(input.drrPct) || 0);
  const liters = Math.max(0, Number(input.liters) || 0);
  const costUzs = Math.max(0, Number(input.costUzs) || 0);
  const inputVatCost = Math.max(0, Number(input.inputVat) || vatFromAmount(costUzs, vatPct, 'with'));
  const safetyPct = Math.max(0, Number(input.safetyPct ?? 10));
  const returnFixed = Math.max(0, Number(input.returnFixed ?? 7200));

  const cal = getWbCalibration(sku, category);
  const buyoutRate = Math.max(0.01, Math.min(1, Number(input.buyoutPct || cal.buyoutPct || 87) / 100));
  const sppPct = Math.max(0, Math.min(100, Number(input.sppPct ?? cal.sppPct ?? 0)));
  const sellerPayoutRatio = Number(input.sellerPayoutRatio ?? cal.sellerPayoutRatio ?? 1);
  const logisticsCoef = Number(input.logisticsCoef ?? cal.logisticsCoef ?? 1);
  const bfPerUnit = Math.max(0, Number(input.bfPerUnit ?? cal.bfPerUnit ?? 0));

  const buyerPriceAfterSpp = Math.round(priceUzs * (1 - sppPct / 100));
  const toSellerGoods = Math.round(buyerPriceAfterSpp * sellerPayoutRatio);
  const baseLogistics = liters > 0 ? wbUzLogistics(liters, buyoutRate, safetyPct, returnFixed) : 0;
  const logistics = Math.round(baseLogistics * logisticsCoef);
  const bf = Math.round(bfPerUnit);
  const ads = Math.round(priceUzs * drrPct / 100);
  const outputVat = Math.round(vatFromAmount(buyerPriceAfterSpp, vatPct, 'with'));
  const vatPayable = outputVat - inputVatCost;
  const netProfit = toSellerGoods - logistics - bf - ads - costUzs - vatPayable;
  const marginPct = buyerPriceAfterSpp > 0 ? netProfit / buyerPriceAfterSpp * 100 : 0;
  const roiPct = costUzs > 0 ? netProfit / costUzs * 100 : 0;

  return {
    sku, category, calibrationSource: cal.source,
    priceUzs, sppPct, buyerPriceAfterSpp,
    sellerPayoutRatio, toSellerGoods,
    baseLogistics, logisticsCoef, logistics, bf,
    drrPct, ads,
    costUzs, inputVatCost, outputVat, vatPayable,
    netProfit, marginPct, roiPct,
  };
}


// ── Платное хранение WB: калибровка по отчету 2026-01-01 — 2026-07-04 ──
// Отчет по хранению WB в рублях: 25,800.80 RUB. Курс для управленки: 168 UZS/RUB.
// Важно: отчет агрегирован по складам, не по SKU, поэтому это глобальная калибровка.
const WB_UZ_STORAGE_REPORT_CALIBRATION = {
  periodFrom: '2026-01-01',
  periodTo: '2026-07-04',
  daysInclusive: 185,
  currency: 'RUB',
  exchangeRate: 168,
  storageRub: 25800.8,
  storageUzs: 4334534,
  storagePctOfRevenue: 0.01148773,
  storagePerNetUnitUzs: 1228,
  storagePerReportPieceUzs: 49.39,
  storagePerDayUzs: 23430,
  note: 'Использовать как fallback/проверку. Для точного SKU-прогноза нужен отчет хранения/остатков по SKU-дням.'
};

function forecastStorageCalibrated({ priceUzs = 0, liters = 0, turnoverDays = 0, storageTariff = 42, useActualFallback = true } = {}) {
  const theoretical = Math.round(Math.max(0, liters) * Math.max(0, storageTariff) * Math.max(0, turnoverDays));
  if (!useActualFallback) return theoretical;
  const pctBased = Math.round(Math.max(0, priceUzs) * WB_UZ_STORAGE_REPORT_CALIBRATION.storagePctOfRevenue);
  // Берем максимум из теории по литрам и среднего факта от выручки, чтобы не занизить хранение.
  return Math.max(theoretical, pctBased);
}
