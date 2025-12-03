import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

loadEnvFile();

const config = {
  port: Number(process.env.PORT || 3000),
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  defaultChatId: process.env.TELEGRAM_CHAT_ID,
  apiKeys: parseApiKeys(process.env.API_KEYS),
  threadId: process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined,
  disablePreview: process.env.DISABLE_WEB_PAGE_PREVIEW !== 'false'
};

if (!config.botToken) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN in environment.');
}

if (!config.defaultChatId && !hasChatIds(config.apiKeys)) {
  throw new Error(
    'Provide TELEGRAM_CHAT_ID or map chat ids inside API_KEYS (key:chatId) so the relay knows where to send messages.'
  );
}

const MAX_BODY_BYTES = 128 * 1024;
const TELEGRAM_API = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
const recentDeliveries = [];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      const now = Date.now();
      const lastHour = recentDeliveries.filter((d) => now - d.timestamp < 60 * 60 * 1000);
      return sendJson(res, 200, {
        ok: true,
        uptimeSeconds: process.uptime(),
        recentDeliveries: lastHour.length
      });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(res, 200, {
        ok: true,
        message: 'hook2telegram is running. POST JSON with a message field to /webhook.',
        docs: '/health for status, /webhook for delivery'
      });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/webhook')) {
      return await handleWebhook(req, res, url);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('[server] unexpected error', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

server.listen(config.port, () => {
  console.log(`[server] listening on port ${config.port}`);
  console.log(`[server] API key protection ${config.apiKeys.size ? 'enabled' : 'disabled (accepts all requests)'}`);
});

async function handleWebhook(req, res, url) {
  const key = extractApiKey(req, url);
  const keyRecord = config.apiKeys.get(key || '');

  if (config.apiKeys.size > 0 && !keyRecord) {
    return sendJson(res, 401, { error: 'Unauthorized: missing or invalid API key' });
  }

  let chatId = keyRecord?.chatId || config.defaultChatId;
  if (!chatId) {
    return sendJson(res, 500, { error: 'Chat id not configured for this webhook key' });
  }

  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    return sendJson(res, 415, { error: 'Content-Type must be application/json' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: error.message });
  }

  const {
    message,
    text,
    source,
    subject,
    parse_mode,
    thread_id,
    topic_id,
    message_thread_id,
    ...extraFields
  } = body || {};

  const primary = message ?? text;
  if (primary === undefined || primary === null) {
    return sendJson(res, 400, { error: 'Payload must include a message field' });
  }

  const safeMessage = String(primary).trim();
  if (!safeMessage) {
    return sendJson(res, 400, { error: 'Message is empty after trimming' });
  }

  const safeSource = source !== undefined && source !== null ? String(source).trim() : '';
  const safeSubject = subject !== undefined && subject !== null ? String(subject).trim() : '';

  const headerParts = [];
  if (safeSource) headerParts.push(`[${safeSource}]`);
  if (safeSubject) headerParts.push(safeSubject);
  const header = headerParts.join(' ');

  const baseMessage = header ? `${header}\n${safeMessage}` : safeMessage;
  const extra = Object.keys(extraFields || {}).length ? `\n\n---\n${JSON.stringify(extraFields, null, 2)}` : '';
  const combined = `${baseMessage}${extra}`;
  const textToSend = combined.length > 3900 ? `${combined.slice(0, 3900)}\n\n[truncated]` : combined;

  const threadId = resolveThreadId({ thread_id, topic_id, message_thread_id });
  const parseMode = typeof parse_mode === 'string' ? parse_mode : undefined;

  const deliveryId = randomUUID();
  const receivedAt = Date.now();

  try {
    await sendToTelegram({
      chatId,
      text: textToSend,
      threadId,
      parseMode,
      disablePreview: config.disablePreview
    });

    recordDelivery({
      id: deliveryId,
      chatId,
      key: key || 'open',
      messagePreview: safeMessage.slice(0, 120),
      timestamp: receivedAt,
      status: 'delivered'
    });

    return sendJson(res, 200, { ok: true, deliveryId });
  } catch (error) {
    console.error('[telegram] send failed', error);
    recordDelivery({
      id: deliveryId,
      chatId,
      key: key || 'open',
      messagePreview: safeMessage.slice(0, 120),
      timestamp: receivedAt,
      status: 'failed',
      error: error.message
    });
    return sendJson(res, 502, { error: 'Failed to send message to Telegram', details: error.message });
  }
}

function extractApiKey(req, url) {
  const queryKey = url.searchParams.get('api_key');
  const segments = url.pathname.split('/').filter(Boolean);
  const pathKey = segments.length > 1 ? segments[1] : undefined;
  return (queryKey || pathKey || '').toString();
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject({ statusCode: 413, message: 'Payload too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        if (!body) {
          return reject({ statusCode: 400, message: 'Empty body' });
        }
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch {
        reject({ statusCode: 400, message: 'Body must be valid JSON' });
      }
    });
    req.on('error', (err) => reject({ statusCode: 400, message: err.message }));
  });
}

async function sendToTelegram({ chatId, text, threadId, parseMode, disablePreview }) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: disablePreview,
    message_thread_id: threadId,
    parse_mode: parseMode
  };

  Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);

  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(TELEGRAM_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const textResponse = await response.text();
        throw new Error(`Telegram error (${response.status}): ${textResponse}`);
      }

      return;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        break;
      }
      const backoffMs = Math.min(500 * 2 ** attempt, 4000);
      await sleep(backoffMs);
    }
  }

  throw lastError || new Error('Unknown Telegram send failure');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function parseApiKeys(raw) {
  const map = new Map();
  if (!raw) return map;

  raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const [key, chatId] = item.split(':').map((part) => part.trim());
      if (key) {
        map.set(key, { chatId: chatId || undefined });
      }
    });

  return map;
}

function hasChatIds(map) {
  for (const value of map.values()) {
    if (value.chatId) return true;
  }
  return false;
}

function resolveThreadId(payload) {
  const value = payload?.thread_id ?? payload?.topic_id ?? payload?.message_thread_id;
  if (value === undefined || value === null) return config.threadId;

  const maybeNumber = Number(value);
  return Number.isFinite(maybeNumber) ? maybeNumber : config.threadId;
}

function recordDelivery(entry) {
  recentDeliveries.push(entry);
  if (recentDeliveries.length > 50) {
    recentDeliveries.shift();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnvFile(path = `${process.cwd()}/.env`) {
  if (!existsSync(path)) return;
  const contents = readFileSync(path, 'utf8');
  contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .forEach((line) => {
      const idx = line.indexOf('=');
      if (idx === -1) return;
      const key = line.slice(0, idx).trim();
      const rawValue = line.slice(idx + 1).trim();
      const value = rawValue.replace(/^['"]|['"]$/g, '');
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    });
}
