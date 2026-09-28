import { createWorkbenchServer } from '../server.mjs';
import { startMockUpstream } from './mock-upstream.mjs';

const mock = await startMockUpstream();
const workbench = createWorkbenchServer({
  gatewayBaseUrl: mock.baseUrl,
  host: '127.0.0.1',
  port: Number(process.env.PORT || 4318),
});

const address = await workbench.start();
console.log(`[mock-ui] 工作台：http://127.0.0.1:${address.port}`);
console.log(`[mock-ui] 模拟上游：${mock.baseUrl}`);

async function shutdown() {
  await workbench.stop();
  await mock.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
