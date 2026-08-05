/**
 * Vercel Serverless: прокси к Uzum Seller API (обход CORS из браузера).
 * GET/POST /api/uzum-proxy?path=seller/products/?page=0&size=1
 * Заголовок Authorization: Bearer <token> пробрасывается как есть.
 */
const UZUM_BASE = 'https://api-seller.uzum.uz/api';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const rawPath = String(req.query?.path || '').trim().replace(/^\/+/, '');
  if (!rawPath || !rawPath.startsWith('seller/')) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Query path required, e.g. path=seller/products/?page=0&size=1' }));
    return;
  }

  // Защита от path traversal / чужих хостов
  if (rawPath.includes('://') || rawPath.includes('..')) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  const auth = req.headers.authorization || '';
  if (!auth || !/^Bearer\s+\S+/i.test(auth)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Missing Authorization Bearer token' }));
    return;
  }

  const url = `${UZUM_BASE}/${rawPath}`;
  const headers = {
    Authorization: auth,
    Accept: 'application/json',
    'Accept-Language': 'ru-RU',
    'Content-Type': 'application/json'
  };

  try {
    const init = { method: req.method, headers };
    if (req.method === 'POST' && req.body != null) {
      init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }
    const upstream = await fetch(url, init);
    const text = await upstream.text();
    const ct = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', ct);
    res.end(text);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Upstream fetch failed', detail: String(err?.message || err) }));
  }
};
