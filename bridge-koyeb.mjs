// OpenAI-compatible bridge -> opencode v2 server (/api, Basic auth, async prompt + wait)
// Flow per request:
//   POST /api/session {model:{id, providerID:"opencode"}} -> data.id
//   POST /api/session/{id}/prompt {text}
//   POST /api/experimental/session/{id}/wait   (fallback: poll GET message)
//   GET  /api/session/{id}/message             -> last assistant message
//   DELETE /api/session/{id}                   (always, in finally)
// Verified against opencode 2.0.29 on 43.133.203.230 (2026-10-21).
// NOTE: upstream uses node:http on purpose - global fetch (undici) has a 300s
// headersTimeout that kills long opencode calls while it retries rate limits.
import http from 'node:http';

const OC = new URL(process.env.OPENCODE_SERVER || 'http://127.0.0.1:4097');
const OC_PASSWORD = process.env.OPENCODE_PASSWORD || '';
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || process.env.PORT || 4200);
const BRIDGE_KEY = process.env.BRIDGE_KEY || '';
const DEFAULT_MODEL = process.env.BRIDGE_MODEL || 'glm-5.3-flash-free';
const UPSTREAM_TIMEOUT_MS = 900_000;

if (!OC_PASSWORD) { console.error('OPENCODE_PASSWORD is required'); process.exit(1); }
if (!BRIDGE_KEY) { console.error('BRIDGE_KEY is required'); process.exit(1); }

const AUTH = 'Basic ' + Buffer.from(`opencode:${OC_PASSWORD}`).toString('base64');

const MODELS = [
  'glm-5.3-flash-free',
  'deepseek-v4.1-flash-free',
  'mimo-v2.6-flash-free',
  'longcat-2.5-preview-free',
];

function oc(path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ?? null;
    const req = http.request({
      hostname: OC.hostname,
      port: OC.port,
      path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AUTH,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(raw); } catch { json = null; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`opencode ${path} -> ${res.statusCode}: ${raw.slice(0, 300)}`);
          err.status = res.statusCode;
          reject(err);
        } else resolve(json);
      });
    });
    req.setTimeout(options.timeout ?? UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error(`opencode ${path} timeout`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function flatten(messages = []) {
  const sys = [], turns = [];
  for (const m of messages) {
    let c = m?.content;
    if (Array.isArray(c)) {
      c = c.filter((p) => p?.type === 'text' || p?.type === 'input_text')
           .map((p) => p.text || '').join('');
    }
    c = String(c ?? '').trim();
    if (!c) continue;
    if (m.role === 'system') sys.push(c);
    else turns.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${c}`);
  }
  const parts = [];
  if (sys.length) parts.push(sys.join('\n\n'));
  parts.push(turns.join('\n\n'));
  return parts.filter(Boolean).join('\n\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lastAssistant(sid) {
  const res = await oc(`/api/session/${sid}/message`, { timeout: 30_000 });
  const msgs = res?.data ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && (m.type === 'assistant' || Array.isArray(m.content))) return m;
  }
  return null;
}

async function ask(modelID, text) {
  const created = await oc('/api/session', {
    method: 'POST',
    body: JSON.stringify({ model: { id: modelID, providerID: 'opencode' } }),
    timeout: 30_000,
  });
  const sid = created?.data?.id;
  if (!sid) throw new Error('create session failed: ' + JSON.stringify(created).slice(0, 300));
  try {
    await oc(`/api/session/${sid}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
      timeout: 30_000,
    });
    let waited = false;
    try {
      await oc(`/api/experimental/session/${sid}/wait`, { method: 'POST' });
      waited = true;
    } catch (e) {
      if (e.status !== 503) throw e;
    }
    if (!waited) {
      const deadline = Date.now() + UPSTREAM_TIMEOUT_MS;
      for (;;) {
        const m = await lastAssistant(sid);
        if (m && (m.finish || m.error)) break;
        if (Date.now() > deadline) throw new Error('poll timeout waiting for assistant message');
        await sleep(3_000);
      }
    }
    const m = await lastAssistant(sid);
    if (!m) throw new Error('no assistant message');
    if (m.error) throw new Error('upstream error: ' + JSON.stringify(m.error).slice(0, 300));
    const reply = (m.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text || '').join('');
    const t = m.tokens ?? {};
    const input = t.input ?? 0, output = t.output ?? 0;
    return { reply, usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } };
  } finally {
    await oc(`/api/session/${sid}`, { method: 'DELETE', timeout: 15_000 }).catch(() => {});
  }
}

http.createServer(async (req, res) => {
  const t0 = Date.now();
  let tag = '';
  res.on('finish', () => console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - t0}ms ${tag}`));
  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  // Public health endpoint for the platform's health checks (no auth).
  if (req.method === 'GET' && req.url.split('?')[0] === '/health') {
    return sendJson(200, { ok: true });
  }
  if (req.headers.authorization !== `Bearer ${BRIDGE_KEY}`) {
    return sendJson(401, { error: { message: 'invalid api key', type: 'authentication_error' } });
  }
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    return sendJson(200, {
      object: 'list',
      data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'opencode' })),
    });
  }
  if (!(req.method === 'POST' && req.url.startsWith('/v1/chat/completions'))) {
    return sendJson(404, { error: { message: 'not found', type: 'invalid_request_error' } });
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const modelID = String(body.model || DEFAULT_MODEL).replace(/^opencode\//, '');
    tag = `model=${modelID}`;
    const text = flatten(body.messages);
    if (!text) throw new Error('no usable text in messages');
    const { reply, usage } = await ask(modelID, text);
    const completion = {
      id: 'chatcmpl-bridge',
      object: 'chat.completion',
      model: modelID,
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage,
    };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = { ...completion, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      const fin = { ...completion, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      res.write(`data: ${JSON.stringify(fin)}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      sendJson(200, completion);
    }
  } catch (e) {
    sendJson(502, { error: { message: String(e.message || e), type: 'upstream_error' } });
  }
}).listen(PORT, HOST, () => console.log(`bridge on http://${HOST}:${PORT} -> ${OC}`));
