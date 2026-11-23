/**
 * Vercel: прокси WB Feedbacks API.
 * Токен только из env WB_FEEDBACKS_TOKEN. Клиент передаёт x-app-secret.
 *
 * GET  /api/wb-proxy?path=api/v1/feedbacks/count-unanswered
 * GET  /api/wb-proxy?path=api/v1/feedbacks&isAnswered=false&take=100&skip=0&order=dateAsc
 * POST /api/wb-proxy?path=api/v1/feedbacks/answer   body: { id, text }
 *
 * Docs: https://dev.wildberries.ru/docs/openapi/user-communication
 */
const {
  readBody,
  setCors,
  sendJson,
  checkAppSecret,
  handleOptions,
  mapUpstreamStatus
} = require('./_app-secret');

const WB_BASE = 'https://feedbacks-api.wildberries.ru';

const ALLOWED_GET = new Set([
  'api/v1/feedbacks/count-unanswered',
  'api/v1/feedbacks'
]);
const ALLOWED_POST = new Set(['api/v1/feedbacks/answer']);

function normalizePath(raw) {
  let p = String(raw || '').trim().replace(/^\/+/, '');
  p = p.replace(/^feedbacks-api\.wildberries\.ru\/+/i, '');
  return p;
}

function isAllowed(method, path) {
  if (method === 'GET') return ALLOWED_GET.has(path);
  if (method === 'POST') return ALLOWED_POST.has(path);
  return false;
}

function pickQuery(req) {
  const q = req.query || {};
  const out = new URLSearchParams();
  ['isAnswered', 'take', 'skip', 'order', 'nmId', 'dateFrom', 'dateTo'].forEach((key) => {
    if (q[key] == null || q[key] === '') return;
    out.set(key, String(q[key]));
  });
  const s = out.toString();
  return s ? `?${s}` : '';
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  if (!checkAppSecret(req, res)) return;

  const token = String(process.env.WB_FEEDBACKS_TOKEN || '').trim();
  if (!token) {
    sendJson(res, 503, {
      error: 'WB_FEEDBACKS_TOKEN не задан на сервере. Добавьте токен WB категории «Вопросы и отзывы» в Vercel.'
    });
    return;
  }

  const path = normalizePath(req.query?.path);
  if (!path || path.includes('..') || path.includes('://') || !isAllowed(req.method, path)) {
    sendJson(res, 400, {
      error: 'Разрешены только GET api/v1/feedbacks/count-unanswered, GET api/v1/feedbacks и POST api/v1/feedbacks/answer.'
    });
    return;
  }

  const url = `${WB_BASE}/${path}${req.method === 'GET' ? pickQuery(req) : ''}`;
  const headers = {
    Authorization: token,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };

  try {
    const init = { method: req.method, headers };
    if (req.method === 'POST') {
      const body = readBody(req);
      const id = String(body.id || '').trim();
      const text = String(body.text || '').trim();
      if (!id || !text) {
        sendJson(res, 400, { error: 'Для ответа нужны id и text.' });
        return;
      }
      init.body = JSON.stringify({ id, text });
    }
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    if (!upstream.ok) {
      sendJson(res, upstream.status, mapUpstreamStatus(upstream.status, text));
      return;
    }
    const ct = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', ct);
    res.end(text || '{"ok":true}');
  } catch (err) {
    sendJson(res, 502, { error: 'Не удалось связаться с WB.', detail: String(err?.message || err) });
  }
};
