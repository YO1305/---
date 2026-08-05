/**
 * Vercel Serverless: прокси к Uzum Seller OpenAPI (обход CORS).
 *
 * GET /api/uzum-proxy?path=v1/shops
 * Header: Authorization: <api-key>   ← БЕЗ префикса Bearer (так требует OpenAPI)
 *
 * Docs: https://api-seller.uzum.uz/api/seller-openapi/swagger/...
 */
const OPENAPI_BASE = 'https://api-seller.uzum.uz/api/seller-openapi';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Accept-Language');
}

function isAllowedOpenApiPath(p) {
  return /^(v1|v2|v3)\//i.test(p);
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

  let rawPath = String(req.query?.path || '').trim().replace(/^\/+/, '');
  // Совместимость: если кто-то передал seller-openapi/v1/...
  rawPath = rawPath.replace(/^seller-openapi\/+/i, '');

  if (!rawPath || !isAllowedOpenApiPath(rawPath)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        error: 'Query path required, e.g. path=v1/shops or path=v1/product/shop/{shopId}'
      })
    );
    return;
  }

  if (rawPath.includes('://') || rawPath.includes('..')) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  // OpenAPI: Authorization = сырой API-ключ (без "Bearer ")
  let auth = String(req.headers.authorization || '').trim();
  if (!auth) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Missing Authorization API key' }));
    return;
  }
  // Если клиент по ошибке прислал Bearer — снимем префикс
  auth = auth.replace(/^Bearer\s+/i, '').trim();
  if (!auth) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Empty Authorization API key' }));
    return;
  }

  const url = `${OPENAPI_BASE}/${rawPath}`;
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
