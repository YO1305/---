/**
 * Vercel: генерация ответа на отзыв через Gemini (ключ только на сервере).
 * POST /api/ai-reply  header x-app-secret  body: rating, userName, productName, category, design, text, pros, cons
 */
const { readBody, setCors, sendJson, checkAppSecret, handleOptions } = require('./_app-secret');

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];

const SYSTEM_PROMPT = `Ты — сотрудник службы заботы о клиентах бренда домашнего текстиля BAHMAL HOME
(постельное бельё, полотенца, текстиль для дома). Пишешь ответ на отзыв покупателя
на Wildberries.

ПРАВИЛА:
1. Отвечай на том же языке, на котором написан отзыв (русский, узбекский
   латиница/кириллица, казахский и т.д.).
2. Обращение строго на «Вы» (с заглавной). Без фамильярности.
3. Если указано имя покупателя и оно выглядит как настоящее имя, обратись по имени.
4. Длина 2–4 предложения, до 500 символов. Без эмодзи.
5. Отреагируй на конкретику из отзыва (что понравилось, как использует, кому
   подарил), без шаблонных общих фраз.
6. Подпись в конце, отдельной строкой: «Команда BAHMAL HOME» (на узбекском:
   «BAHMAL HOME jamoasi»).
7. ЗАПРЕЩЕНО: упоминать цены, скидки, акции, сроки доставки; обещать компенсации,
   возвраты, замены; упоминать конкурентов и другие маркетплейсы; давать ссылки
   и контакты; выдумывать состав ткани, плотность, размеры, способы ухода;
   рекомендовать другие товары. Состава, ухода и комплектации в данных товара нет — не утверждай их.
8. Если в отзыве есть ЛЮБАЯ претензия к товару или доставке (брак, швы, нитки,
   размер, цвет, усадка, линяет, запах, пятна, некомплект, не пришло, возврат,
   несоответствие описанию), поставь has_complaint = true. reply в этом случае
   оставь пустым.

ВЕРНИ ТОЛЬКО JSON:
{
  "lang": "ru | uz_latn | uz_cyrl | kk | en | other",
  "sentiment": "positive | neutral | negative",
  "has_complaint": true/false,
  "complaint_types": ["брак","размер","цвет","усадка","запах","доставка","некомплект","другое"],
  "reply": "текст ответа или пустая строка"
}`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    lang: { type: 'string', enum: ['ru', 'uz_latn', 'uz_cyrl', 'kk', 'en', 'other'] },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
    has_complaint: { type: 'boolean' },
    complaint_types: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['брак', 'размер', 'цвет', 'усадка', 'запах', 'доставка', 'некомплект', 'другое']
      }
    },
    reply: { type: 'string' }
  },
  required: ['lang', 'sentiment', 'has_complaint', 'complaint_types', 'reply']
};

function buildUserMessage(body) {
  return [
    `Оценка: ${body.rating != null ? body.rating : '—'} из 5`,
    `Имя покупателя: ${body.userName || '—'}`,
    `Товар: ${body.productName || '—'} | категория: ${body.category || '—'} | дизайн: ${body.design || '—'}`,
    `Текст отзыва: ${body.text || '—'}`,
    `Достоинства: ${body.pros || '—'}`,
    `Недостатки: ${body.cons || '—'}`
  ].join('\n');
}

function parseModelJson(raw) {
  const s = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  const data = JSON.parse(s);
  return {
    lang: String(data.lang || 'other'),
    sentiment: String(data.sentiment || 'neutral'),
    has_complaint: !!data.has_complaint,
    complaint_types: Array.isArray(data.complaint_types) ? data.complaint_types.map(String) : [],
    reply: String(data.reply || '')
  };
}

async function callGemini(apiKey, model, userText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA
      }
    })
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  if (!checkAppSecret(req, res)) return;

  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    sendJson(res, 503, {
      error: 'GEMINI_API_KEY не задан на сервере. Добавьте ключ Gemini в Vercel.'
    });
    return;
  }

  const body = readBody(req);
  const userText = buildUserMessage(body);
  let lastErr = null;

  for (const model of GEMINI_MODELS) {
    try {
      const out = await callGemini(apiKey, model, userText);
      if (out.status === 429) {
        sendJson(res, 429, { error: 'Gemini ограничил частоту запросов (429). Подождите и повторите.' });
        return;
      }
      if (out.status === 401 || out.status === 403) {
        sendJson(res, 502, { error: 'Gemini отклонил ключ. Проверьте GEMINI_API_KEY.' });
        return;
      }
      if (!out.ok) {
        lastErr = `HTTP ${out.status}: ${String(out.text || '').slice(0, 200)}`;
        continue;
      }
      const raw = out.json?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      const parsed = parseModelJson(raw);
      sendJson(res, 200, Object.assign({ model }, parsed));
      return;
    } catch (err) {
      lastErr = String(err?.message || err);
    }
  }

  sendJson(res, 502, { error: 'Не удалось получить ответ Gemini.', detail: lastErr });
};
