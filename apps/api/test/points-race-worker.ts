import { once } from 'node:events';
import { parentPort, workerData } from 'node:worker_threads';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/database.ts';
import { dateAt } from '../src/time.ts';

if (!parentPort) throw new Error('Expected a test worker');
const { path, today, isStaff } = workerData as { path: string; today: string; isStaff: boolean };
const app = createApp(openDatabase(path), () => new Date(dateAt(today, 480)));
try {
  const login = await app.inject({
    method: 'POST', url: isStaff ? '/api/admin/session' : '/api/dev/session',
    payload: isStaff ? { password: process.env.WBC_ADMIN_PASSWORD ?? 'wbc-demo-2026' } : { profile: 'parent' }
  });
  if (login.statusCode !== 200) throw new Error('Test login failed: ' + login.statusCode);
  const headers = { authorization: 'Bearer ' + login.json<{ token: string }>().token };
  const start = once(parentPort, 'message');
  parentPort.postMessage('ready');
  await start;

  const result = isStaff ? await app.inject({
    method: 'POST', url: '/api/admin/accounts/parent/ledger', headers,
    payload: { source: 'ADJUSTMENT', delta: -300, reason: '测试调减', requestKey: 'race-adjust' }
  }) : await app.inject({
    method: 'POST', url: '/api/bookings', headers,
    payload: { type: 'GROUP', classSessionId: today + '-strength', requestKey: 'race-book' }
  });
  parentPort.postMessage({ isStaff, status: result.statusCode, body: result.json() });
} finally {
  await app.close();
  parentPort.close();
}
