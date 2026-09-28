import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, 'public');
const DEFAULT_GATEWAY = 'http://81.71.25.7';
const DEFAULT_PORT = 4317;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BODY_BYTES = 120 * 1024 * 1024;
const MAX_H3_JSON_BODY_BYTES = 35 * 1024 * 1024;
const MAX_ERROR_TEXT = 1_500;

const IMAGE_UPLOAD_FIELDS = [
  ['reference_image', 'reference_image'],
  ['character_1_image', 'character_1_image'],
  ['character_2_image', 'character_2_image'],
  ['background_image', 'background_image'],
];

const AUDIO_UPLOAD_FIELDS = [
  ['audio_1', 'character-1', 0],
  ['audio_2', 'character-2', 1],
];

const ALLOWED_IMAGE_UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_UPLOAD_TYPES = new Set([
  'audio/aac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/x-wav',
  'application/octet-stream',
]);

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, type = 'workbench_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function jsonResponse(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function normalizeGateway(value) {
  const parsed = new URL(value || DEFAULT_GATEWAY);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('H3_GATEWAY_BASE_URL must use http or https');
  }
  return parsed.href.replace(/\/$/, '');
}

function sanitizeApiPath(pathname) {
  if (pathname === '/api/models') return '/v1/models';
  if (pathname === '/api/videos') return '/v1/videos';

  const contentMatch = pathname.match(/^\/api\/videos\/([A-Za-z0-9_-]{1,128})\/content$/);
  if (contentMatch) return `/v1/videos/${contentMatch[1]}/content`;

  const taskMatch = pathname.match(/^\/api\/videos\/([A-Za-z0-9_-]{1,128})$/);
  if (taskMatch) return `/v1/videos/${taskMatch[1]}`;

  return null;
}

function extractApiKey(req) {
  const raw = req.headers['x-workbench-api-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || typeof key !== 'string' || !key.trim()) {
    throw new HttpError(401, '请先填写 API 密钥。', 'missing_api_key');
  }
  if (key.length > 512) {
    throw new HttpError(400, 'API 密钥格式不正确。', 'invalid_api_key');
  }
  return key.trim();
}

async function readRequestBody(req, maxBodyBytes) {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > maxBodyBytes) {
    throw new HttpError(413, '上传内容超过本地工作台允许的大小。', 'payload_too_large');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      throw new HttpError(413, '上传内容超过本地工作台允许的大小。', 'payload_too_large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function normalizeVideoPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, '请求内容必须是 JSON 对象。', 'invalid_request');
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) throw new HttpError(400, '请填写视频提示词。', 'missing_prompt');
  if (prompt.length > 12_000) {
    throw new HttpError(400, '提示词不能超过 12000 个字符。', 'prompt_too_long');
  }

  const duration = Number(payload.duration ?? 15);
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) {
    throw new HttpError(400, '视频时长必须是 1 到 15 秒的整数。', 'invalid_duration');
  }

  const allowedResolutions = new Set(['480p', '720p']);
  if (!allowedResolutions.has(payload.resolution ?? '720p')) {
    throw new HttpError(400, '分辨率只支持 480p 或 720p。', 'invalid_resolution');
  }

  const allowedRatios = new Set(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
  if (!allowedRatios.has(payload.ratio ?? '16:9')) {
    throw new HttpError(400, '画面比例不受支持。', 'invalid_ratio');
  }

  const seed = Number(payload.seed ?? -1);
  if (!Number.isInteger(seed)) {
    throw new HttpError(400, '随机种子必须是整数。', 'invalid_seed');
  }

  payload.model = 'mojiang-h3-ref2va';
  payload.prompt = prompt;
  payload.duration = duration;
  payload.resolution = payload.resolution ?? '720p';
  payload.ratio = payload.ratio ?? '16:9';
  payload.seed = seed;
  return payload;
}

function serializeVideoPayload(payload) {
  const body = Buffer.from(JSON.stringify(normalizeVideoPayload(payload)));
  if (body.length > MAX_H3_JSON_BODY_BYTES) {
    throw new HttpError(413, '图片或音频合计过大，请压缩媒体后重试。', 'media_payload_too_large');
  }
  return body;
}

function validateJsonRequest(buffer) {
  let payload;
  try {
    payload = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, '请求 JSON 无法解析。', 'invalid_json');
  }
  return serializeVideoPayload(payload);
}

function isUploadedFile(value) {
  return Boolean(value && typeof value === 'object' && typeof value.arrayBuffer === 'function' && Number.isFinite(value.size));
}

function multipartText(form, field, fallback = '') {
  const value = form.get(field);
  return typeof value === 'string' ? value : fallback;
}

async function uploadedFileDataUrl(file, allowedTypes, label) {
  const mimeType = String(file.type || '').toLowerCase();
  if (!allowedTypes.has(mimeType)) {
    throw new HttpError(400, `${label}格式不受支持。`, 'unsupported_media_type');
  }
  if (file.size <= 0) throw new HttpError(400, `${label}为空。`, 'empty_media_file');
  const bytes = Buffer.from(await file.arrayBuffer());
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

async function convertMultipartRequest(buffer, contentType) {
  let form;
  try {
    const request = new Request('http://127.0.0.1/api/videos', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: buffer,
    });
    form = await request.formData();
  } catch {
    throw new HttpError(400, '上传表单无法解析，请重新选择文件。', 'invalid_multipart');
  }

  const payload = {
    model: multipartText(form, 'model', 'mojiang-h3-ref2va'),
    prompt: multipartText(form, 'prompt'),
    duration: Number(multipartText(form, 'duration', '15')),
    resolution: multipartText(form, 'resolution', '720p'),
    ratio: multipartText(form, 'ratio', '16:9'),
    seed: Number(multipartText(form, 'seed', '-1')),
  };

  const images = [];
  for (const [field, role] of IMAGE_UPLOAD_FIELDS) {
    const file = form.get(field);
    if (!isUploadedFile(file) || file.size === 0) continue;
    images.push({
      url: await uploadedFileDataUrl(file, ALLOWED_IMAGE_UPLOAD_TYPES, field),
      role,
    });
  }

  const audios = [];
  for (const [field, character, imageIndex] of AUDIO_UPLOAD_FIELDS) {
    const file = form.get(field);
    if (!isUploadedFile(file) || file.size === 0) continue;
    audios.push({
      url: await uploadedFileDataUrl(file, ALLOWED_AUDIO_UPLOAD_TYPES, field),
      role: 'reference_audio',
      character,
      imageIndex,
    });
  }

  if (images.length) payload.images = images;
  if (audios.length) payload.audios = audios;
  return {
    body: serializeVideoPayload(payload),
    media: { images: images.length, audios: audios.length },
  };
}

function safeUpstreamMessage(status, contentType, text) {
  const shortened = text.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_TEXT);
  if (contentType.includes('application/json') || shortened.startsWith('{')) {
    try {
      const payload = JSON.parse(text);
      const message = payload?.error?.message || payload?.message || payload?.detail;
      if (typeof message === 'string' && message.trim()) return message.trim().slice(0, MAX_ERROR_TEXT);
    } catch {
      // Fall through to a status-specific message.
    }
  }
  if (status === 401 || status === 403) return 'API 密钥无效、已失效或没有调用权限。';
  if (status === 429) return '调用频率或账户额度已达到限制，请稍后重试或检查额度。';
  if (status >= 500) return 'H3 服务暂时不可用，请稍后重试。';
  if (contentType.includes('text/html')) return `上游服务返回了网页错误（HTTP ${status}）。`;
  return shortened || `H3 请求失败（HTTP ${status}）。`;
}

async function fetchUpstream(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new HttpError(504, 'H3 服务响应超时，任务可能仍在运行，请稍后用任务 ID 查询。', 'upstream_timeout');
    }
    throw new HttpError(502, '无法连接 H3 服务，请检查网关或云端实例状态。', 'upstream_unreachable');
  } finally {
    clearTimeout(timer);
  }
}

async function sendUpstreamError(res, upstreamResponse) {
  const contentType = upstreamResponse.headers.get('content-type') || '';
  const text = await upstreamResponse.text();
  const message = safeUpstreamMessage(upstreamResponse.status, contentType, text);
  jsonResponse(res, upstreamResponse.status, {
    error: {
      message,
      type: 'upstream_error',
      status: upstreamResponse.status,
      request_id: upstreamResponse.headers.get('x-request-id') || undefined,
    },
  });
}

async function proxyApiRequest(req, res, pathname, config) {
  const upstreamPath = sanitizeApiPath(pathname);
  if (!upstreamPath) throw new HttpError(404, '接口不存在。', 'not_found');

  const apiKey = extractApiKey(req);
  const method = req.method || 'GET';
  const isContent = upstreamPath.endsWith('/content');
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: isContent ? 'video/*, application/octet-stream;q=0.9, application/json;q=0.8' : 'application/json',
  };

  let body;
  if (method === 'POST') {
    const rawContentType = String(req.headers['content-type'] || '');
    const contentType = rawContentType.toLowerCase();
    if (!contentType.startsWith('application/json') && !contentType.startsWith('multipart/form-data')) {
      throw new HttpError(415, '只支持 JSON 或 multipart/form-data 请求。', 'unsupported_media_type');
    }
    body = await readRequestBody(req, config.maxBodyBytes);
    if (!body.length) throw new HttpError(400, '请求内容不能为空。', 'empty_body');
    if (contentType.startsWith('application/json')) {
      body = validateJsonRequest(body);
    } else {
      const converted = await convertMultipartRequest(body, rawContentType);
      body = converted.body;
      config.logger.info?.(`[workbench] media-normalized images=${converted.media.images} audios=${converted.media.audios} jsonBytes=${body.length}`);
    }
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(body.length);
  }

  const upstreamResponse = await fetchUpstream(`${config.gatewayBaseUrl}${upstreamPath}`, {
    method,
    headers,
    body,
    redirect: 'manual',
  }, isContent ? Math.max(config.upstreamTimeoutMs, 300_000) : config.upstreamTimeoutMs);

  if (!upstreamResponse.ok) {
    await sendUpstreamError(res, upstreamResponse);
    return;
  }

  if (isContent) {
    const responseHeaders = {
      'Content-Type': upstreamResponse.headers.get('content-type') || 'video/mp4',
      'Cache-Control': 'no-store',
    };
    for (const name of ['content-length', 'content-disposition', 'accept-ranges']) {
      const value = upstreamResponse.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    res.writeHead(upstreamResponse.status, responseHeaders);
    if (!upstreamResponse.body) return res.end();
    const upstreamStream = Readable.fromWeb(upstreamResponse.body);
    upstreamStream.on('error', (error) => {
      config.logger.error?.(`[workbench] upstream-stream-error path=${upstreamPath} code=${error?.code || error?.name || 'stream_error'}`);
      if (!res.destroyed) res.destroy(error);
    });
    res.on('close', () => {
      if (!upstreamStream.destroyed) upstreamStream.destroy();
    });
    upstreamStream.pipe(res);
    return;
  }

  const contentType = upstreamResponse.headers.get('content-type') || '';
  const text = await upstreamResponse.text();
  if (!contentType.includes('application/json')) {
    throw new HttpError(502, 'H3 服务返回了无法识别的响应格式。', 'invalid_upstream_response');
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new HttpError(502, 'H3 服务返回了无效 JSON。', 'invalid_upstream_json');
  }
  jsonResponse(res, upstreamResponse.status, payload);
}

function addSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
}

async function serveStatic(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const normalized = normalize(requested);
  const filePath = resolve(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(resolve(PUBLIC_DIR))) throw new HttpError(403, '禁止访问。', 'forbidden');

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    throw new HttpError(404, '页面不存在。', 'not_found');
  }
  if (!fileStat.isFile()) throw new HttpError(404, '页面不存在。', 'not_found');

  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': fileStat.size,
    'Cache-Control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
}

export function createWorkbenchServer(options = {}) {
  const config = {
    gatewayBaseUrl: normalizeGateway(options.gatewayBaseUrl || process.env.H3_GATEWAY_BASE_URL || DEFAULT_GATEWAY),
    host: options.host || process.env.HOST || '127.0.0.1',
    port: Number(options.port ?? process.env.PORT ?? DEFAULT_PORT),
    upstreamTimeoutMs: Number(options.upstreamTimeoutMs ?? process.env.UPSTREAM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    maxBodyBytes: Number(options.maxBodyBytes ?? process.env.MAX_BODY_BYTES ?? DEFAULT_MAX_BODY_BYTES),
    logger: options.logger || console,
  };

  const server = http.createServer(async (req, res) => {
    addSecurityHeaders(res);
    const startedAt = Date.now();
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const logPath = url.pathname.replace(/(\/api\/videos\/)[A-Za-z0-9_-]+/, '$1:taskId');

    try {
      if (url.pathname === '/api/health' && req.method === 'GET') {
        jsonResponse(res, 200, {
          ok: true,
          service: 'mojiang-h3-api-workbench',
          version: '1.0.0',
          gateway: new URL(config.gatewayBaseUrl).host,
          now: new Date().toISOString(),
        });
      } else if (url.pathname.startsWith('/api/')) {
        const allowed = req.method === 'GET' || (req.method === 'POST' && url.pathname === '/api/videos');
        if (!allowed) throw new HttpError(405, '请求方法不受支持。', 'method_not_allowed');
        await proxyApiRequest(req, res, url.pathname, config);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        if (req.method === 'HEAD') {
          const file = url.pathname === '/' ? join(PUBLIC_DIR, 'index.html') : join(PUBLIC_DIR, url.pathname);
          const fileStat = await stat(file);
          res.writeHead(200, { 'Content-Length': fileStat.size });
          res.end();
        } else {
          await serveStatic(res, url.pathname);
        }
      } else {
        throw new HttpError(405, '请求方法不受支持。', 'method_not_allowed');
      }
    } catch (error) {
      if (!res.headersSent) {
        const status = Number(error?.status) || 500;
        jsonResponse(res, status, {
          error: {
            message: status >= 500 && !(error instanceof HttpError) ? '本地工作台发生内部错误。' : error.message,
            type: error?.type || 'internal_error',
            status,
          },
        });
      } else if (!res.writableEnded) {
        res.destroy(error);
      }
    } finally {
      const status = res.statusCode || 500;
      config.logger.info?.(`[workbench] ${req.method} ${logPath} ${status} ${Date.now() - startedAt}ms`);
    }
  });

  return {
    config,
    server,
    async start() {
      await new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(config.port, config.host, () => {
          server.off('error', rejectPromise);
          resolvePromise();
        });
      });
      const address = server.address();
      return typeof address === 'object' && address ? address : { address: config.host, port: config.port };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    },
  };
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  const app = createWorkbenchServer();
  app.start()
    .then(({ address, port }) => {
      const displayHost = address === '::' ? '127.0.0.1' : address;
      console.log(`[workbench] 墨匠 H3 API 工作台已启动：http://${displayHost}:${port}`);
      console.log(`[workbench] H3 网关：${new URL(app.config.gatewayBaseUrl).host}`);
    })
    .catch((error) => {
      console.error(`[workbench] 启动失败：${error.message}`);
      process.exitCode = 1;
    });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await app.stop();
      process.exit(0);
    });
  }
}
