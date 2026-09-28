import http from 'node:http';

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export async function startMockUpstream() {
  const requests = [];
  const pollCounts = new Map();
  const server = http.createServer(async (req, res) => {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method || '') ? await readBody(req) : Buffer.alloc(0);
    const auth = String(req.headers.authorization || '');
    requests.push({
      method: req.method,
      url: req.url,
      auth,
      contentType: String(req.headers['content-type'] || ''),
      body,
    });

    if (auth === 'Bearer invalid-key') {
      return sendJson(res, 401, { error: { message: 'invalid token' } });
    }
    if (auth === 'Bearer rate-key') {
      return sendJson(res, 429, { message: 'quota exhausted' });
    }
    if (auth === 'Bearer down-key') {
      const html = '<html><body>temporary outage</body></html>';
      res.writeHead(503, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html) });
      return res.end(html);
    }
    if (auth === 'Bearer slow-key') {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: [{ id: 'mojiang-h3-ref2va' }] });
    }

    if (req.method === 'POST' && req.url === '/v1/videos') {
      let payload = {};
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        // Tests assert malformed forwarding separately.
      }
      const hasMedia = (payload.images?.length || 0) > 0 || (payload.audios?.length || 0) > 0;
      return sendJson(res, 200, {
        id: hasMedia ? 'task_media' : 'task_json',
        object: 'video',
        model: 'mojiang-h3-ref2va',
        status: 'queued',
        progress: 0,
        created_at: 1_789_459_200,
      });
    }

    const contentMatch = req.url?.match(/^\/v1\/videos\/([A-Za-z0-9_-]+)\/content$/);
    if (req.method === 'GET' && contentMatch) {
      if (contentMatch[1] === 'task_no_content') {
        return sendJson(res, 409, { message: 'video is still finalizing' });
      }
      if (contentMatch[1] === 'task_broken_stream') {
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 4096 });
        res.write('partial-video');
        setTimeout(() => res.destroy(), 25);
        return;
      }
      const video = Buffer.from('fake-mp4-video-content');
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': video.length,
        'Content-Disposition': 'attachment; filename="result.mp4"',
      });
      return res.end(video);
    }

    const taskMatch = req.url?.match(/^\/v1\/videos\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && taskMatch) {
      const taskId = taskMatch[1];
      const count = (pollCounts.get(taskId) || 0) + 1;
      pollCounts.set(taskId, count);
      if (taskId === 'task_failed') {
        return sendJson(res, 200, { id: taskId, status: 'failed', progress: 42, error: { message: 'generation failed' } });
      }
      if (taskId === 'task_no_content') {
        return sendJson(res, 200, { id: taskId, status: 'completed', progress: 99 });
      }
      const status = count === 1 ? 'queued' : count === 2 ? 'processing' : 'completed';
      const progress = count === 1 ? 0 : count === 2 ? 54 : 100;
      return sendJson(res, 200, { id: taskId, status, progress, created_at: 1_789_459_200 });
    }

    sendJson(res, 404, { message: 'not found' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async stop() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
