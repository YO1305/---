/**
 * Раздел «Автоответ» на отзывы Wildberries.
 * Не связан со ScaleUp. Ключи WB/Gemini только на сервере.
 */
(function () {
  'use strict';

  const SECRET_KEY = 'yo_autoreply_secret';
  const COL_FEEDBACKS = 'wb_feedbacks';
  const DOC_INBOX = 'autoreply_inbox';
  const DOC_TEMPLATES = 'autoreply_templates';
  const DOC_STOPWORDS = 'autoreply_stopwords';
  const DOC_CONFIG = 'autoreply_config';
  const MAX_BATCH = 100;
  const WB_GAP_MS = 1100;
  const WB_RETRY = 3;

  const DEFAULT_STOP_WORDS = [
    'брак', 'бракован', 'дыр', 'порван', 'разошл', 'шов', 'швы', 'нитк', 'торчат', 'линя', 'полинял', 'выцвет',
    'сел', 'села', 'усадк', 'садит', 'размер', 'маленьк', 'большой', 'не подош', 'не соответ', 'не тот', 'не та',
    'другой цвет', 'цвет не', 'пятн', 'грязн', 'запах', 'воня', 'катышк', 'скатал', 'тонк', 'просвечива',
    'кривой', 'кривая', 'вернул', 'возврат', 'верну', 'обман', 'подделк', 'не пришл', 'не доставл', 'пустая',
    'некомплект', 'не хватает', 'нет наволоч',
    'yirtiq', 'sifatsiz', 'kichik', 'katta', 'rangi', 'hidi', 'qaytar', 'nuqson'
  ];

  const DEFAULT_TEMPLATES = {
    5: [
      'Благодарим Вас за высокую оценку! Рады, что выбрали BAHMAL HOME. Пусть наш текстиль дарит Вам уют каждый день.\nКоманда BAHMAL HOME',
      'Спасибо Вам за 5 звёзд! Нам приятно, что BAHMAL HOME оказался Вам по вкусу. Пусть дома будет тепло и уютно.\nКоманда BAHMAL HOME',
      'Благодарим за доверие и высокую оценку. Рады быть частью Вашего дома.\nКоманда BAHMAL HOME'
    ],
    4: [
      'Спасибо Вам за оценку! Нам важно Ваше мнение, и мы стараемся становиться лучше.\nКоманда BAHMAL HOME',
      'Благодарим Вас за отзыв и 4 звезды. Ценим, что выбрали BAHMAL HOME, и продолжаем работать над качеством.\nКоманда BAHMAL HOME',
      'Спасибо за Вашу оценку. Рады, что товар Вам пригодился, и будем рады видеть Вас снова.\nКоманда BAHMAL HOME'
    ],
    3: [
      'Благодарим Вас за оценку. Будем признательны, если расскажете подробнее, что нам стоит улучшить.\nКоманда BAHMAL HOME',
      'Спасибо, что уделили время оценке. Нам важно понять, чем мы можем стать лучше для Вас.\nКоманда BAHMAL HOME',
      'Благодарим за обратную связь. Если будет минута — напишите, что ожидали увидеть иначе.\nКоманда BAHMAL HOME'
    ],
    1: [
      'Нам жаль, что товар не оправдал Ваших ожиданий. Пожалуйста, напишите нам в чат с продавцом, что именно не понравилось, и мы обязательно разберёмся.\nКоманда BAHMAL HOME',
      'Сожалеем, что опыт оказался не таким, как Вы ждали. Напишите, пожалуйста, в чат с продавцом — разберём ситуацию.\nКоманда BAHMAL HOME',
      'Благодарим за оценку. Нам жаль разочарования. Опишите проблему в чате с продавцом, и мы займёмся ей.\nКоманда BAHMAL HOME'
    ]
  };

  const UZ_WORDS = ['rahmat', 'juda', 'yaxshi', "zo'r", 'zor', 'sifat', 'rahmatlar', 'yoqdi', 'yaxshimisiz'];

  let _busy = false;
  let _cache = [];
  let _unanswered = null;
  let _tab = 'pending';
  let _filterRating = '';
  let _filterDateFrom = '';
  let _filterDateTo = '';
  let _stopWords = DEFAULT_STOP_WORDS.slice();
  let _templates = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
  let _testMode = true;

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function getSecret() {
    try {
      return String(localStorage.getItem(SECRET_KEY) || '').trim();
    } catch {
      return '';
    }
  }

  function setSecret(v) {
    localStorage.setItem(SECRET_KEY, String(v || '').trim());
  }

  function dbRef() {
    return typeof db !== 'undefined' ? db : window.db;
  }

  function combinedReviewText(fb) {
    return [fb.text, fb.pros, fb.cons].map((x) => String(x || '')).join(' \n ');
  }

  function isBlankReview(fb) {
    return !String(fb.text || '').trim() && !String(fb.pros || '').trim() && !String(fb.cons || '').trim();
  }

  function isPendingRow(r) {
    if (!r) return false;
    if (r.status === 'pending') return true;
    if (r.sentToWb === false && r.status === 'answered') return true;
    return r.status === 'answered' && String(r.error || '') === 'test';
  }

  function isSentRow(r) {
    return r && r.status === 'answered' && !isPendingRow(r);
  }

  function readFiltersFromDom() {
    _filterRating = String(document.getElementById('arFilterRating')?.value || '');
    _filterDateFrom = String(document.getElementById('arFilterFrom')?.value || '');
    _filterDateTo = String(document.getElementById('arFilterTo')?.value || '');
  }

  function dateToUnix(dateStr, endOfDay) {
    if (!dateStr) return '';
    const iso = endOfDay ? `${dateStr}T23:59:59` : `${dateStr}T00:00:00`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : '';
  }

  function matchesFilters(fb, rating, from, to) {
    if (rating && Number(fb.rating) !== Number(rating)) return false;
    const d = String(fb.createdDate || fb.answeredAt || '').slice(0, 10);
    if (from && d && d < from) return false;
    if (to && d && d > to) return false;
    return true;
  }

  function detectLang(text) {
    const raw = String(text || '').trim();
    if (!raw) return 'ru';
    const lower = raw.toLowerCase();
    if (/[ўқғҳ]/i.test(raw)) return 'uz_cyrl';
    if (/[а-яё]/i.test(raw)) return 'ru';
    const hasUzMark = /o[ʻ'’`]|g[ʻ'’`]|o'|g'/.test(lower);
    const hasUzWord = UZ_WORDS.some((w) => lower.includes(w));
    if (/[a-z]/i.test(raw) && (hasUzMark || hasUzWord)) return 'uz_latn';
    if (/[a-z]/i.test(raw)) return 'en';
    return 'other';
  }

  function matchStopWords(text, words) {
    const hay = String(text || '').toLowerCase();
    if (!hay.trim()) return [];
    const list = Array.isArray(words) && words.length ? words : DEFAULT_STOP_WORDS;
    return list.filter((w) => {
      const stem = String(w || '').trim().toLowerCase();
      return stem && hay.includes(stem);
    });
  }

  function pickTemplate(templates, rating) {
    const key = Number(rating) <= 2 ? 1 : Number(rating) >= 5 ? 5 : Number(rating);
    const arr = (templates && templates[key]) || DEFAULT_TEMPLATES[key] || DEFAULT_TEMPLATES[5];
    if (!arr || !arr.length) return DEFAULT_TEMPLATES[5][0];
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function validateReply(text) {
    const t = String(text || '').trim();
    if (t.length < 20 || t.length > 1000) return 'Длина ответа должна быть 20–1000 символов.';
    if (!/команда bahmal home|bahmal home jamoasi/i.test(t)) return 'Нет подписи BAHMAL HOME.';
    if (/\d/.test(t) && /(сум|руб|%|so['ʻm]|сумм)/i.test(t)) return 'В ответе есть цена/процент.';
    if (/https?:\/\/|www\.|t\.me\/|@\w+/i.test(t)) return 'В ответе есть ссылка или контакт.';
    return '';
  }

  function findProductByNmId(nmId) {
    const id = String(nmId || '').trim();
    if (!id || typeof readProductsSafe !== 'function') return null;
    return readProductsSafe().find((p) => {
      const c = p?.calc || {};
      const keys = [p.wbSku, p.wb_nmid, p.wb_nm_id, p.nmid, c.mpWbNmid];
      return keys.some((v) => String(v || '').trim() === id);
    }) || null;
  }

  function wbCardUrl(nmId) {
    const id = String(nmId || '').trim();
    return id ? `https://www.wildberries.ru/catalog/${encodeURIComponent(id)}/detail.aspx` : '';
  }

  function normalizeFeedback(raw) {
    const details = raw.productDetails || {};
    return {
      id: String(raw.id || ''),
      nmId: String(details.nmId || raw.nmId || ''),
      productName: String(details.productName || raw.productName || ''),
      rating: Number(raw.productValuation ?? raw.rating ?? 0) || 0,
      text: String(raw.text || ''),
      pros: String(raw.pros || ''),
      cons: String(raw.cons || ''),
      userName: String(raw.userName || raw.userNameDisplay || ''),
      createdDate: raw.createdDate || raw.createdDt || '',
      answered: !!(raw.answer && (raw.answer.text || raw.isAnswered))
    };
  }

  async function apiJson(url, options) {
    const secret = getSecret();
    if (!secret) throw new Error('Укажите пароль автоответа в настройках раздела.');
    const headers = Object.assign(
      { Accept: 'application/json', 'Content-Type': 'application/json', 'x-app-secret': secret },
      options?.headers || {}
    );
    const res = await fetch(url, Object.assign({}, options, { headers }));
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: text.slice(0, 200) };
    }
    if (!res.ok) {
      const err = new Error(json?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  async function wbGet(path, query) {
    const qs = new URLSearchParams(Object.assign({ path }, query || {}));
    return apiJson(`/api/wb-proxy?${qs.toString()}`);
  }

  async function wbAnswer(id, text) {
    return apiJson('/api/wb-proxy?path=api/v1/feedbacks/answer', {
      method: 'POST',
      body: JSON.stringify({ id, text })
    });
  }

  async function wbAnswerWithRetry(id, text) {
    let last = null;
    for (let i = 0; i < WB_RETRY; i += 1) {
      try {
        return await wbAnswer(id, text);
      } catch (e) {
        last = e;
        if (e.status !== 429) throw e;
        await sleep(2000 * (i + 1));
      }
    }
    throw last;
  }

  async function aiReply(payload) {
    return apiJson('/api/ai-reply', { method: 'POST', body: JSON.stringify(payload) });
  }

  let _inbox = null;

  function settingsDoc(id) {
    return dbRef().collection('system').doc(id);
  }

  function isPermissionError(err) {
    const m = String(err?.code || err?.message || err);
    return /permission-denied|insufficient permissions|Missing or insufficient/i.test(m);
  }

  function friendlyError(err) {
    if (isPermissionError(err)) {
      return 'Не удалось сохранить черновик в Firestore. Обновите страницу и попробуйте ещё раз.';
    }
    return err?.message || String(err);
  }

  function safeFbKey(id) {
    return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 700);
  }

  function sanitizePayload(obj) {
    if (obj == null) return null;
    if (Array.isArray(obj)) return obj.map(sanitizePayload).filter((x) => x !== undefined);
    if (typeof obj !== 'object') return obj;
    const out = {};
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      if (v === undefined) return;
      out[k] = typeof v === 'object' && v !== null && !(v instanceof Date) ? sanitizePayload(v) : v;
    });
    return out;
  }

  async function loadInboxMap() {
    const snap = await settingsDoc(DOC_INBOX).get();
    const data = snap.exists ? snap.data() || {} : {};
    _inbox = data.items && typeof data.items === 'object' ? data.items : {};
    return _inbox;
  }

  async function loadSettings() {
    try {
      const [tSnap, sSnap, cSnap] = await Promise.all([
        settingsDoc(DOC_TEMPLATES).get(),
        settingsDoc(DOC_STOPWORDS).get(),
        settingsDoc(DOC_CONFIG).get()
      ]);
      if (tSnap.exists) {
        const data = tSnap.data() || {};
        _templates = {
          5: Array.isArray(data[5]) && data[5].length ? data[5] : DEFAULT_TEMPLATES[5],
          4: Array.isArray(data[4]) && data[4].length ? data[4] : DEFAULT_TEMPLATES[4],
          3: Array.isArray(data[3]) && data[3].length ? data[3] : DEFAULT_TEMPLATES[3],
          1: Array.isArray(data[1]) && data[1].length ? data[1] : DEFAULT_TEMPLATES[1]
        };
      }
      if (sSnap.exists && Array.isArray(sSnap.data()?.words) && sSnap.data().words.length) {
        _stopWords = sSnap.data().words.map(String);
      } else {
        _stopWords = DEFAULT_STOP_WORDS.slice();
      }
      if (cSnap.exists && typeof cSnap.data()?.testMode === 'boolean') {
        _testMode = cSnap.data().testMode;
      }
    } catch (e) {
      console.warn('autoreply settings', e);
    }
  }

  async function saveTemplates(next) {
    _templates = next;
    await settingsDoc(DOC_TEMPLATES).set({
      5: next[5],
      4: next[4],
      3: next[3],
      1: next[1]
    }, { merge: true });
  }

  async function saveStopWords(words) {
    _stopWords = words;
    await settingsDoc(DOC_STOPWORDS).set({ words }, { merge: true });
  }

  async function saveTestMode(on) {
    _testMode = !!on;
    await settingsDoc(DOC_CONFIG).set({ testMode: _testMode }, { merge: true });
  }

  async function getStored(id) {
    if (!id) return null;
    if (!_inbox) {
      try {
        await loadInboxMap();
      } catch {
        _inbox = _inbox || {};
      }
    }
    const row = _inbox[safeFbKey(id)];
    return row ? Object.assign({ id: row.id || id }, row) : null;
  }

  async function upsertFeedback(doc) {
    const id = String(doc.id || '').trim();
    if (!id) return;
    if (!dbRef()) throw new Error('Firestore недоступен.');
    const key = safeFbKey(id);
    const payload = sanitizePayload(Object.assign({ id, _kind: 'wb_feedback' }, doc));
    await settingsDoc(DOC_INBOX).set({ [`items.${key}`]: payload }, { merge: true });
    if (!_inbox) _inbox = {};
    _inbox[key] = payload;
  }

  async function loadFeedbacksFromDb() {
    try {
      await loadInboxMap();
    } catch (e) {
      console.warn('autoreply inbox', e);
      _inbox = _inbox || {};
    }
    _cache = Object.keys(_inbox).map((k) => {
      const row = _inbox[k] || {};
      return Object.assign({ id: row.id || k }, row);
    });
    _cache.sort((a, b) => String(b.createdDate || '').localeCompare(String(a.createdDate || '')));
  }

  async function refreshUnansweredCount() {
    const json = await wbGet('api/v1/feedbacks/count-unanswered');
    const n = json?.data?.countUnanswered ?? json?.countUnanswered ?? json?.data ?? null;
    _unanswered = Number(n);
    if (!Number.isFinite(_unanswered)) _unanswered = null;
    return _unanswered;
  }

  function setProgress(cur, total, extra) {
    const el = document.getElementById('arProgress');
    if (!el) return;
    const bits = [];
    if (total) bits.push(`${cur} / ${total}`);
    if (extra) bits.push(extra);
    el.textContent = bits.join(' · ') || '';
  }

  function setCountLabel() {
    const el = document.getElementById('arUnansweredCount');
    if (!el) return;
    if (_unanswered == null) el.textContent = 'Неотвеченных на WB: —';
    else el.textContent = `Неотвеченных на WB: ${_unanswered}`;
  }

  function productContext(nmId) {
    const p = findProductByNmId(nmId);
    if (!p) return { name: '', category: '', design: '' };
    return {
      name: String(p.article1c || p.name || '').trim(),
      category: String(p.category || '').trim(),
      design: String(p.design || p.calc?.productDesign || '').trim()
    };
  }

  async function processOne(fb, testMode) {
    const stored = await getStored(fb.id);
    if (fb.answered || isSentRow(stored)) {
      return { status: 'skipped', reason: 'уже отвечен' };
    }
    if (isPendingRow(stored)) {
      return { status: 'skipped', reason: 'уже на проверке' };
    }

    const nowIso = new Date().toISOString();
    const base = {
      id: fb.id,
      nmId: fb.nmId,
      productName: fb.productName,
      rating: fb.rating,
      text: fb.text,
      pros: fb.pros,
      cons: fb.cons,
      userName: fb.userName,
      createdDate: fb.createdDate || nowIso
    };

    if (isBlankReview(fb)) {
      const reply = pickTemplate(_templates, fb.rating);
      const bad = validateReply(reply);
      if (bad) {
        const row = Object.assign({}, base, { status: 'error', error: bad, source: 'template', reply });
        await upsertFeedback(row);
        return row;
      }
      if (!testMode) await wbAnswerWithRetry(fb.id, reply);
      const row = Object.assign({}, base, {
        lang: 'ru',
        sentiment: fb.rating >= 4 ? 'positive' : fb.rating === 3 ? 'neutral' : 'negative',
        complaintTypes: [],
        status: testMode ? 'pending' : 'answered',
        reply,
        answeredAt: testMode ? '' : nowIso,
        error: '',
        sentToWb: !testMode,
        source: 'template'
      });
      await upsertFeedback(row);
      return row;
    }

    const hits = matchStopWords(combinedReviewText(fb), _stopWords);
    if (hits.length) {
      const row = Object.assign({}, base, {
        status: 'manual',
        complaintTypes: ['фильтр: ' + hits.slice(0, 6).join(', ')],
        lang: detectLang(combinedReviewText(fb)),
        sentiment: 'negative',
        reply: '',
        source: 'ai'
      });
      await upsertFeedback(row);
      return row;
    }

    const yo = productContext(fb.nmId);
    const ai = await aiReply({
      rating: fb.rating,
      userName: fb.userName,
      productName: yo.name || fb.productName,
      category: yo.category,
      design: yo.design,
      text: fb.text,
      pros: fb.pros,
      cons: fb.cons
    });

    const lang = ai.lang && ai.lang !== 'other' ? ai.lang : detectLang(combinedReviewText(fb));
    if (ai.has_complaint) {
      const row = Object.assign({}, base, {
        lang,
        sentiment: ai.sentiment || 'negative',
        complaintTypes: ai.complaint_types || ['другое'],
        status: 'manual',
        reply: '',
        source: 'ai'
      });
      await upsertFeedback(row);
      return row;
    }

    const reply = String(ai.reply || '').trim();
    const bad = validateReply(reply);
    if (bad) {
      const row = Object.assign({}, base, {
        lang,
        sentiment: ai.sentiment || 'neutral',
        complaintTypes: [],
        status: 'error',
        reply,
        error: bad,
        source: 'ai'
      });
      await upsertFeedback(row);
      return row;
    }

    if (!testMode) await wbAnswerWithRetry(fb.id, reply);
    const row = Object.assign({}, base, {
      lang,
      sentiment: ai.sentiment || 'positive',
      complaintTypes: [],
      status: testMode ? 'pending' : 'answered',
      reply,
      answeredAt: testMode ? '' : nowIso,
      error: '',
      sentToWb: !testMode,
      source: 'ai'
    });
    await upsertFeedback(row);
    return row;
  }

  async function fetchUnansweredForRun() {
    readFiltersFromDom();
    const out = [];
    let skip = 0;
    const take = 100;
    const maxScan = 1000;
    let scanned = 0;
    while (out.length < MAX_BATCH && skip < maxScan) {
      const query = {
        isAnswered: 'false',
        take: String(take),
        skip: String(skip),
        order: 'dateAsc'
      };
      const fromUnix = dateToUnix(_filterDateFrom, false);
      const toUnix = dateToUnix(_filterDateTo, true);
      if (fromUnix) query.dateFrom = fromUnix;
      if (toUnix) query.dateTo = toUnix;
      const listJson = await wbGet('api/v1/feedbacks', query);
      const rawList = listJson?.data?.feedbacks || listJson?.data || listJson?.feedbacks || [];
      const chunk = (Array.isArray(rawList) ? rawList : []).map(normalizeFeedback).filter((x) => x.id);
      scanned += chunk.length;
      if (!chunk.length) break;
      chunk.forEach((fb) => {
        if (out.length >= MAX_BATCH) return;
        if (matchesFilters(fb, _filterRating, _filterDateFrom, _filterDateTo)) out.push(fb);
      });
      if (chunk.length < take) break;
      skip += take;
      await sleep(400);
    }
    return { list: out, scanned };
  }

  async function runBatch() {
    if (_busy) return;
    if (!getSecret()) {
      alert('Сначала укажите пароль автоответа во вкладке «Настройки» раздела.');
      return;
    }
    _busy = true;
    const btn = document.getElementById('arRunBtn');
    if (btn) btn.disabled = true;
    const summary = { loaded: 0, answered: 0, manual: 0, errors: 0, skipped: 0, more: false, testMode: _testMode };
    try {
      await loadSettings();
      readFiltersFromDom();
      const fetched = await fetchUnansweredForRun();
      const list = fetched.list;
      summary.loaded = list.length;
      summary.scanned = fetched.scanned;
      if (list.length >= MAX_BATCH) summary.more = true;

      for (let i = 0; i < list.length; i += 1) {
        setProgress(i + 1, list.length, _testMode ? 'тестовый режим — в WB не отправляем' : 'отправка в WB');
        try {
          const result = await processOne(list[i], _testMode);
          if (result && result.id) {
            const ix = _cache.findIndex((r) => r.id === result.id);
            if (ix >= 0) _cache[ix] = Object.assign({}, _cache[ix], result);
            else _cache.push(result);
          }
          if (result.status === 'answered' || result.status === 'pending') summary.answered += 1;
          else if (result.status === 'manual') summary.manual += 1;
          else if (result.status === 'error') summary.errors += 1;
          else summary.skipped += 1;
        } catch (e) {
          summary.errors += 1;
          try {
            await upsertFeedback({
              id: list[i].id,
              nmId: list[i].nmId,
              productName: list[i].productName,
              rating: list[i].rating,
              text: list[i].text,
              pros: list[i].pros,
              cons: list[i].cons,
              userName: list[i].userName,
              createdDate: list[i].createdDate,
              status: 'error',
              error: friendlyError(e),
              source: 'ai'
            });
          } catch (_) { /* ignore */ }
        }
        await sleep(WB_GAP_MS);
      }

      if (typeof recordActivityLogOnly === 'function') {
        recordActivityLogOnly('wb_autoreply_run', '', null, summary.answered, summary);
      }
      try {
        await refreshUnansweredCount();
      } catch (_) { /* ignore count errors after run */ }
      try {
        await loadFeedbacksFromDb();
      } catch (e) {
        console.warn('autoreply reload', e);
      }
      if (_testMode) switchTab('pending');
      renderLists();
      setCountLabel();
      const extra = summary.more ? ' Нажмите ещё раз — есть следующие 100 подходящих.' : '';
      const starsHint = _filterRating ? ` Фильтр: ${_filterRating}★ (просмотрено ${summary.scanned || list.length} с WB).` : '';
      const mode = _testMode
        ? ' Тестовый режим: ответы на вкладке «На проверке», в WB не отправляли.'
        : '';
      alert(
        `По фильтру: ${summary.loaded}. Черновиков: ${summary.answered}. Ручной ответ: ${summary.manual}. Ошибок: ${summary.errors}. Пропущено: ${summary.skipped}.${starsHint}${mode}${extra}`
      );
    } catch (e) {
      alert(friendlyError(e));
    } finally {
      _busy = false;
      if (btn) btn.disabled = false;
      setProgress('', 0, '');
    }
  }

  function applyFilters(rows) {
    readFiltersFromDom();
    return rows.filter((r) => matchesFilters(r, _filterRating, _filterDateFrom, _filterDateTo));
  }

  function stars(n) {
    const x = Math.max(0, Math.min(5, Number(n) || 0));
    return `${x}★`;
  }

  function reviewPreview(r) {
    const t = [r.text, r.pros && `+ ${r.pros}`, r.cons && `− ${r.cons}`].filter(Boolean).join(' / ');
    return t ? esc(t) : '<span class="muted">только оценка</span>';
  }

  function renderTable(host, rows, kind) {
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = '<p class="muted">Пока пусто.</p>';
      return;
    }
    const extraHead = kind === 'manual' ? '<th>Причина</th><th></th>' : kind === 'error' ? '<th>Ошибка</th><th></th>' : '<th>Наш ответ</th>';
    host.innerHTML = `<div class="table-wrap"><table class="stock-analytics-table ar-table"><thead><tr>
      <th>Дата</th><th>★</th><th>Товар</th><th>Отзыв</th>${extraHead}
    </tr></thead><tbody>${rows.map((r) => {
      const date = esc(String(r.createdDate || r.answeredAt || '').replace('T', ' ').slice(0, 16));
      const name = esc(r.productName || r.nmId || '—');
      if (kind === 'manual') {
        const url = wbCardUrl(r.nmId);
        const reason = esc((r.complaintTypes || []).join(', ') || 'жалоба');
        return `<tr>
          <td>${date}</td><td>${stars(r.rating)}</td><td>${name}</td><td>${reviewPreview(r)}</td>
          <td>${reason}</td>
          <td class="ar-actions">
            ${url ? `<a class="btn-secondary" href="${esc(url)}" target="_blank" rel="noopener">Открыть на WB</a>` : ''}
            <button type="button" class="btn-primary" data-ar-mark="${esc(r.id)}">Отметить как отвеченный</button>
          </td>
        </tr>`;
      }
      if (kind === 'error') {
        return `<tr>
          <td>${date}</td><td>${stars(r.rating)}</td><td>${name}</td><td>${reviewPreview(r)}</td>
          <td>${esc(r.error || 'ошибка')}</td>
          <td><button type="button" class="btn-primary" data-ar-retry="${esc(r.id)}">Повторить</button></td>
        </tr>`;
      }
      return `<tr>
        <td>${date}</td><td>${stars(r.rating)}</td><td>${name}</td><td>${reviewPreview(r)}</td>
        <td>${esc(r.reply || '')}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
  }

  function renderPendingList(host, rows) {
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = '<p class="muted">Пока нет черновиков. Нажмите «Ответить на новые отзывы» в тестовом режиме — они появятся здесь.</p>';
      return;
    }
    host.innerHTML = rows.map((r) => {
      const date = esc(String(r.createdDate || '').replace('T', ' ').slice(0, 16));
      const name = esc(r.productName || r.nmId || '—');
      const user = esc(r.userName || '');
      const review = [r.text, r.pros && `+ ${r.pros}`, r.cons && `− ${r.cons}`].filter(Boolean).join('\n') || 'только оценка';
      return `<article class="ar-review-card" data-ar-card="${esc(r.id)}">
        <div class="ar-review-meta">${stars(r.rating)} · ${date}${user ? ` · ${user}` : ''} · ${name}</div>
        <div class="ar-review-label">Отзыв</div>
        <div class="ar-review-body">${esc(review)}</div>
        <div class="ar-review-label">Наш ответ</div>
        <div class="ar-reply-view">${esc(r.reply || '')}</div>
        <textarea class="input ar-textarea ar-reply-edit">${esc(r.reply || '')}</textarea>
        <div class="ar-actions" style="margin-top:10px;">
          <button type="button" class="btn-secondary" data-ar-edit="${esc(r.id)}">Изменить</button>
          <button type="button" class="btn-secondary" data-ar-save="${esc(r.id)}">Сохранить</button>
          <button type="button" class="btn-secondary" data-ar-cancel="${esc(r.id)}">Отмена</button>
          <button type="button" class="btn-primary" data-ar-confirm="${esc(r.id)}">Подтвердить</button>
        </div>
      </article>`;
    }).join('');
  }

  function renderLists() {
    const pending = applyFilters(_cache.filter(isPendingRow));
    const answered = applyFilters(_cache.filter(isSentRow));
    const manual = applyFilters(_cache.filter((r) => r.status === 'manual'));
    const errors = applyFilters(_cache.filter((r) => r.status === 'error'));
    renderPendingList(document.getElementById('arListPending'), pending);
    renderTable(document.getElementById('arListAnswered'), answered, 'answered');
    renderTable(document.getElementById('arListManual'), manual, 'manual');
    renderTable(document.getElementById('arListErrors'), errors, 'error');
    const badgePend = document.getElementById('arBadgePending');
    const badgeMan = document.getElementById('arBadgeManual');
    const badgeErr = document.getElementById('arBadgeError');
    if (badgePend) badgePend.textContent = String(pending.length);
    if (badgeMan) badgeMan.textContent = String(manual.length);
    if (badgeErr) badgeErr.textContent = String(errors.length);
    const allBtn = document.getElementById('arConfirmAllBtn');
    if (allBtn) allBtn.textContent = pending.length ? `Подтвердить все (${pending.length})` : 'Подтвердить все';
  }

  function fillSettingsForm() {
    const secret = document.getElementById('arSecretInput');
    if (secret) secret.value = getSecret();
    const testEl = document.getElementById('arTestMode');
    if (testEl) testEl.checked = !!_testMode;
    const sw = document.getElementById('arStopWords');
    if (sw) sw.value = _stopWords.join('\n');
    [5, 4, 3, 1].forEach((key) => {
      (_templates[key] || []).forEach((text, i) => {
        const el = document.getElementById(`arTpl_${key}_${i}`);
        if (el) el.value = text;
      });
    });
  }

  async function saveSettingsFromForm() {
    const secret = document.getElementById('arSecretInput')?.value || '';
    setSecret(secret);
    const sync = document.getElementById('arSecretInputSettings');
    if (sync) sync.value = secret;
    const next = { 5: [], 4: [], 3: [], 1: [] };
    [5, 4, 3, 1].forEach((key) => {
      for (let i = 0; i < 3; i += 1) {
        const v = String(document.getElementById(`arTpl_${key}_${i}`)?.value || '').trim();
        if (v) next[key].push(v);
      }
      if (!next[key].length) next[key] = DEFAULT_TEMPLATES[key].slice();
    });
    const words = String(document.getElementById('arStopWords')?.value || '')
      .split(/\n+/)
      .map((w) => w.trim())
      .filter(Boolean);
    await saveTemplates(next);
    await saveStopWords(words.length ? words : DEFAULT_STOP_WORDS.slice());
    await saveTestMode(!!document.getElementById('arTestMode')?.checked);
    alert('Настройки автоответа сохранены.');
  }

  function switchTab(name) {
    _tab = name;
    document.querySelectorAll('[data-ar-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-ar-tab') === name);
    });
    document.getElementById('arPanePending')?.classList.toggle('hidden', name !== 'pending');
    document.getElementById('arPaneAnswered')?.classList.toggle('hidden', name !== 'answered');
    document.getElementById('arPaneManual')?.classList.toggle('hidden', name !== 'manual');
    document.getElementById('arPaneErrors')?.classList.toggle('hidden', name !== 'error');
    document.getElementById('arPaneSettings')?.classList.toggle('hidden', name !== 'settings');
    if (name === 'settings') fillSettingsForm();
  }

  function cardById(id) {
    const safe = String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return document.querySelector(`[data-ar-card="${safe}"]`);
  }

  async function savePendingReply(id) {
    const card = cardById(id);
    const text = String(card?.querySelector('.ar-reply-edit')?.value || '').trim();
    const bad = validateReply(text);
    if (bad) {
      alert(bad);
      return null;
    }
    await upsertFeedback({ id, reply: text, status: 'pending', sentToWb: false, error: '' });
    const row = _cache.find((r) => r.id === id);
    if (row) row.reply = text;
    if (card) {
      const view = card.querySelector('.ar-reply-view');
      if (view) view.textContent = text;
      card.classList.remove('is-editing');
    }
    return text;
  }

  async function confirmOne(id, { silent } = {}) {
    if (_busy && !silent) return;
    const row = _cache.find((r) => r.id === id);
    if (!row) return;
    const card = cardById(id);
    let reply = String(card?.querySelector('.ar-reply-edit')?.value || row.reply || '').trim();
    const bad = validateReply(reply);
    if (bad) throw new Error(bad);
    await wbAnswerWithRetry(id, reply);
    await upsertFeedback({
      id,
      reply,
      status: 'answered',
      sentToWb: true,
      error: '',
      answeredAt: new Date().toISOString()
    });
    return true;
  }

  async function confirmAllPending() {
    if (_busy) return;
    if (!getSecret()) {
      alert('Сначала укажите пароль автоответа во вкладке «Настройки» раздела.');
      return;
    }
    const list = applyFilters(_cache.filter(isPendingRow));
    if (!list.length) {
      alert('Нет черновиков для отправки.');
      return;
    }
    if (!window.confirm(`Отправить ${list.length} ответов в Wildberries?`)) return;
    _busy = true;
    const btn = document.getElementById('arConfirmAllBtn');
    if (btn) btn.disabled = true;
    let ok = 0;
    let fail = 0;
    try {
      for (let i = 0; i < list.length; i += 1) {
        setProgress(i + 1, list.length, 'отправка в WB');
        try {
          await confirmOne(list[i].id, { silent: true });
          ok += 1;
        } catch (e) {
          fail += 1;
          await upsertFeedback({
            id: list[i].id,
            status: 'error',
            error: friendlyError(e),
            sentToWb: false
          });
        }
        await sleep(WB_GAP_MS);
      }
      await loadFeedbacksFromDb();
      renderLists();
      try {
        await refreshUnansweredCount();
        setCountLabel();
      } catch (_) { /* ignore */ }
      alert(`Отправлено в WB: ${ok}. Ошибок: ${fail}.`);
      if (ok && !fail) switchTab('answered');
    } finally {
      _busy = false;
      if (btn) btn.disabled = false;
      setProgress('', 0, '');
    }
  }

  async function markAnswered(id) {
    await upsertFeedback({
      id,
      status: 'answered',
      sentToWb: true,
      answeredAt: new Date().toISOString(),
      error: ''
    });
    await loadFeedbacksFromDb();
    renderLists();
  }

  async function retryOne(id) {
    const row = _cache.find((r) => r.id === id);
    if (!row) return;
    try {
      await loadSettings();
      const fb = normalizeFeedback(row);
      fb.id = id;
      await processOne(fb, _testMode);
      await loadFeedbacksFromDb();
      renderLists();
    } catch (e) {
      alert(friendlyError(e));
    }
  }

  function wire() {
    document.getElementById('arRefreshCountBtn')?.addEventListener('click', async () => {
      try {
        await refreshUnansweredCount();
        setCountLabel();
      } catch (e) {
        alert(friendlyError(e));
      }
    });
    document.getElementById('arRunBtn')?.addEventListener('click', () => void runBatch());
    document.getElementById('arConfirmAllBtn')?.addEventListener('click', () => void confirmAllPending());
    document.querySelectorAll('[data-ar-tab]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.getAttribute('data-ar-tab')));
    });
    document.getElementById('arFilterRating')?.addEventListener('change', (e) => {
      _filterRating = e.target.value;
      renderLists();
    });
    document.getElementById('arFilterFrom')?.addEventListener('change', (e) => {
      _filterDateFrom = e.target.value;
      renderLists();
    });
    document.getElementById('arFilterTo')?.addEventListener('change', (e) => {
      _filterDateTo = e.target.value;
      renderLists();
    });
    document.getElementById('arSaveSettingsBtn')?.addEventListener('click', () => void saveSettingsFromForm());
    document.getElementById('arSecretSaveSettings')?.addEventListener('click', () => {
      setSecret(document.getElementById('arSecretInputSettings')?.value || '');
      const a = document.getElementById('arSecretInput');
      if (a) a.value = getSecret();
      alert('Пароль автоответа сохранён в этом браузере.');
    });
    document.getElementById('arListManual')?.addEventListener('click', (e) => {
      const id = e.target?.getAttribute?.('data-ar-mark');
      if (id) void markAnswered(id);
    });
    document.getElementById('arListErrors')?.addEventListener('click', (e) => {
      const id = e.target?.getAttribute?.('data-ar-retry');
      if (id) void retryOne(id);
    });
    document.getElementById('arListPending')?.addEventListener('click', (e) => {
      const t = e.target;
      if (!t?.getAttribute) return;
      const editId = t.getAttribute('data-ar-edit');
      const saveId = t.getAttribute('data-ar-save');
      const cancelId = t.getAttribute('data-ar-cancel');
      const confirmId = t.getAttribute('data-ar-confirm');
      if (editId) cardById(editId)?.classList.add('is-editing');
      if (cancelId) cardById(cancelId)?.classList.remove('is-editing');
      if (saveId) void savePendingReply(saveId);
      if (confirmId) {
        if (_busy) return;
        if (!window.confirm('Отправить этот ответ в Wildberries?')) return;
        _busy = true;
        void confirmOne(confirmId)
          .then(async () => {
            await loadFeedbacksFromDb();
            renderLists();
            try {
              await refreshUnansweredCount();
              setCountLabel();
            } catch (_) { /* ignore */ }
          })
          .catch((err) => alert(friendlyError(err)))
          .finally(() => { _busy = false; });
      }
    });
  }

  async function onShow() {
    fillSettingsForm();
    try {
      await loadSettings();
      fillSettingsForm();
      await loadFeedbacksFromDb();
      renderLists();
    } catch (e) {
      console.warn('autoreply onShow', e);
    }
    if (getSecret()) {
      try {
        await refreshUnansweredCount();
        setCountLabel();
      } catch (e) {
        setCountLabel();
        const el = document.getElementById('arUnansweredCount');
        if (el) el.title = e.message || String(e);
      }
    } else {
      setCountLabel();
    }
  }

  function init() {
    if (init._done) return;
    init._done = true;
    wire();
    const settingsSecret = document.getElementById('arSecretInputSettings');
    if (settingsSecret) settingsSecret.value = getSecret();
  }

  window.WbAutoreply = {
    init,
    onShow,
    matchStopWords,
    detectLang,
    validateReply,
    isBlankReview,
    isPendingRow,
    isSentRow,
    matchesFilters,
    pickTemplate,
    DEFAULT_STOP_WORDS,
    DEFAULT_TEMPLATES
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
