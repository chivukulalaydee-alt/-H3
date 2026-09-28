import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createWorkbenchServer } from '../server.mjs';
import { startMockUpstream } from './mock-upstream.mjs';

let mock;
let workbench;
let baseUrl;
const logs = [];

before(async () => {
  mock = await startMockUpstream();
  workbench = createWorkbenchServer({
    gatewayBaseUrl: mock.baseUrl,
    host: '127.0.0.1',
    port: 0,
    upstreamTimeoutMs: 80,
    maxBodyBytes: 1024 * 1024,
    logger: { info: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) },
  });
  const address = await workbench.start();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await workbench.stop();
  await mock.stop();
});

async function jsonRequest(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json();
  return { response, payload };
}

test('health endpoint is available without a key', async () => {
  const { response, payload } = await jsonRequest('/api/health');
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.gateway, new URL(mock.baseUrl).host);
});

test('serves fresh static assets and hides the completed-video placeholder', async () => {
  const response = await fetch(`${baseUrl}/styles.css`);
  const css = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(css, /\.video-empty\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(css, /\.video-empty\[hidden\]\s*\{\s*display:\s*none;\s*\}/s);
});

test('rejects a missing API key before contacting upstream', async () => {
  const requestCount = mock.requests.length;
  const { response, payload } = await jsonRequest('/api/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '测试视频' }),
  });
  assert.equal(response.status, 401);
  assert.equal(payload.error.type, 'missing_api_key');
  assert.equal(mock.requests.length, requestCount);
});

test('validates JSON parameters locally', async () => {
  const { response, payload } = await jsonRequest('/api/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Api-Key': 'test-secret-key' },
    body: JSON.stringify({ prompt: '测试视频', duration: 16, resolution: '1080p' }),
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error.type, 'invalid_duration');
});

test('forwards a normalized JSON video request', async () => {
  const { response, payload } = await jsonRequest('/api/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Api-Key': 'test-secret-key' },
    body: JSON.stringify({
      model: 'untrusted-model',
      prompt: '  一个真实的街头镜头  ',
      duration: 15,
      resolution: '720p',
      ratio: '16:9',
      seed: -1,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(payload.id, 'task_json');
  const request = mock.requests.at(-1);
  assert.equal(request.auth, 'Bearer test-secret-key');
  const upstreamPayload = JSON.parse(request.body.toString('utf8'));
  assert.equal(upstreamPayload.model, 'mojiang-h3-ref2va');
  assert.equal(upstreamPayload.prompt, '一个真实的街头镜头');
});

test('normalizes multipart image and audio files into H3 data URL inputs', async () => {
  const form = new FormData();
  form.set('model', 'mojiang-h3-ref2va');
  form.set('prompt', '人物对话测试');
  form.set('duration', '15');
  form.set('resolution', '720p');
  form.set('ratio', '16:9');
  form.set('seed', '-1');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const wav = Buffer.from('524946462400000057415645666d74201000000001000100401f0000803e0000020010006461746100000000', 'hex');
  form.set('reference_image', new Blob([png], { type: 'image/png' }), 'reference.png');
  form.set('audio_1', new Blob([wav], { type: 'audio/wav' }), 'voice.wav');

  const { response, payload } = await jsonRequest('/api/videos', {
    method: 'POST',
    headers: { 'X-Workbench-Api-Key': 'test-secret-key' },
    body: form,
  });
  assert.equal(response.status, 200);
  assert.equal(payload.id, 'task_media');
  const request = mock.requests.at(-1);
  assert.equal(request.contentType, 'application/json');
  const upstreamPayload = JSON.parse(request.body.toString('utf8'));
  assert.equal(upstreamPayload.prompt, '人物对话测试');
  assert.equal(upstreamPayload.images[0].role, 'reference_image');
  assert.match(upstreamPayload.images[0].url, /^data:image\/png;base64,/);
  assert.equal(upstreamPayload.audios[0].role, 'reference_audio');
  assert.equal(upstreamPayload.audios[0].character, 'character-1');
  assert.equal(upstreamPayload.audios[0].imageIndex, 0);
  assert.match(upstreamPayload.audios[0].url, /^data:audio\/wav;base64,/);
});

test('rejects unsupported uploaded image formats before contacting upstream', async () => {
  const requestCount = mock.requests.length;
  const form = new FormData();
  form.set('prompt', '格式故障测试');
  form.set('reference_image', new Blob(['not-an-image'], { type: 'text/plain' }), 'reference.txt');

  const { response, payload } = await jsonRequest('/api/videos', {
    method: 'POST',
    headers: { 'X-Workbench-Api-Key': 'test-secret-key' },
    body: form,
  });

  assert.equal(response.status, 400);
  assert.equal(payload.error.type, 'unsupported_media_type');
  assert.equal(mock.requests.length, requestCount);
});

test('queries queued, processing and completed task states', async () => {
  const states = [];
  for (let index = 0; index < 3; index += 1) {
    const { response, payload } = await jsonRequest('/api/videos/task_json', {
      headers: { 'X-Workbench-Api-Key': 'test-secret-key' },
    });
    assert.equal(response.status, 200);
    states.push(payload.status);
  }
  assert.deepEqual(states, ['queued', 'processing', 'completed']);
});

test('streams authenticated video content', async () => {
  const response = await fetch(`${baseUrl}/api/videos/task_json/content`, {
    headers: { 'X-Workbench-Api-Key': 'test-secret-key' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'fake-mp4-video-content');
  assert.equal(mock.requests.at(-1).auth, 'Bearer test-secret-key');
});

test('survives an upstream video stream disconnect', async () => {
  await fetch(`${baseUrl}/api/videos/task_broken_stream/content`, {
    headers: { 'X-Workbench-Api-Key': 'test-secret-key' },
  }).then((response) => response.arrayBuffer()).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 20));
  const { response, payload } = await jsonRequest('/api/health');
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.match(logs.join('\n'), /upstream-stream-error/);
});

test('normalizes 401, 429 and HTML 503 upstream errors', async () => {
  const cases = [
    ['invalid-key', 401, 'invalid token'],
    ['rate-key', 429, 'quota exhausted'],
    ['down-key', 503, 'H3 服务暂时不可用'],
  ];
  for (const [key, expectedStatus, messagePart] of cases) {
    const { response, payload } = await jsonRequest('/api/models', {
      headers: { 'X-Workbench-Api-Key': key },
    });
    assert.equal(response.status, expectedStatus);
    assert.match(payload.error.message, new RegExp(messagePart));
  }
});

test('converts an upstream timeout into a resumable error', async () => {
  const { response, payload } = await jsonRequest('/api/models', {
    headers: { 'X-Workbench-Api-Key': 'slow-key' },
  });
  assert.equal(response.status, 504);
  assert.equal(payload.error.type, 'upstream_timeout');
});

test('does not include API keys in request logs', () => {
  const combined = logs.join('\n');
  for (const key of ['test-secret-key', 'invalid-key', 'rate-key', 'down-key', 'slow-key']) {
    assert.equal(combined.includes(key), false);
  }
  assert.match(combined, /POST \/api\/videos/);
});
