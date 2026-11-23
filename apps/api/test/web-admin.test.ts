import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/database.ts';

const base = '/wbctraining/admin';
test('Web 管理端静态资源可访问，生产数据需要独立管理员凭据，退出使会话失效', async context => {
  const app = createApp(openDatabase(':memory:'), undefined, { demo: false, webAdminPassword: 'test-password' });
  context.after(() => app.close());
  for (const path of ['', '/', '/admin.css', '/icons/parents.svg']) {
    assert.equal((await app.inject(base + path)).statusCode, 200);
  }
  assert.equal((await app.inject(base + '/api/overview')).statusCode, 401);
  const login = (password: string) => app.inject({ url: base + '/api/session', method: 'POST', payload: { password } });
  assert.equal((await login('wbc-demo-2026')).statusCode, 401);
  const response = await login('test-password');
  assert.equal(response.statusCode, 200);
  const headers = { authorization: 'Bearer ' + response.json<{ token: string }>().token };
  assert.equal((await app.inject({ url: base + '/api/overview', headers })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/schedule', headers })).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: base + '/api/session', headers })).statusCode, 204);
  assert.equal((await app.inject({ url: base + '/api/overview', headers })).statusCode, 401);
});

test('生产环境未配置 Web 密码时关闭密码登录', async context => {
  const app = createApp(openDatabase(':memory:'), undefined, { demo: false });
  context.after(() => app.close());
  const response = await app.inject({ url: base + '/api/session', method: 'POST', payload: { password: 'wbc-demo-2026' } });
  assert.equal(response.statusCode, 503);
});
