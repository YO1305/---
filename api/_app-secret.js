function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body || '{}');
    } catch {
      return {};
    }
  }
  return req.body;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, x-app-secret');
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function checkAppSecret(req, res) {
  const expected = String(process.env.APP_SECRET || '').trim();
  if (!expected) {
    sendJson(res, 503, {
      error: 'APP_SECRET не задан на сервере. Добавьте переменную в Vercel.'
    });
    return false;
  }
  const got = String(req.headers['x-app-secret'] || '').trim();
  if (!got || got !== expected) {
    sendJson(res, 403, { error: 'Неверный пароль автоответа.' });
    return false;
  }
  return true;
}

function handleOptions(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function mapUpstreamStatus(status, text) {
  const snippet = String(text || '').slice(0, 280);
  if (status === 401) return { error: 'WB отклонил токен (401). Проверьте WB_FEEDBACKS_TOKEN категории «Вопросы и отзывы».', detail: snippet };
  if (status === 403) return { error: 'WB запретил доступ (403). Нужен токен с правом «Вопросы и отзывы».', detail: snippet };
  if (status === 429) return { error: 'WB ограничил частоту запросов (429). Подождите и повторите.', detail: snippet };
  if (status >= 500) return { error: `WB временно недоступен (${status}).`, detail: snippet };
  return { error: `WB HTTP ${status}`, detail: snippet };
}

module.exports = {
  readBody,
  setCors,
  sendJson,
  checkAppSecret,
  handleOptions,
  mapUpstreamStatus
};
