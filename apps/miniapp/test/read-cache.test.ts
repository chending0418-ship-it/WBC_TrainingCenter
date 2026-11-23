import assert from 'node:assert/strict';
import test from 'node:test';
import { ReadCache } from '../src/lib/read-cache.ts';

test('同一个读取合并在途请求，缓存仅在本次登录和上海当日内有效', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-23T23:59:55+08:00') });
  const cache = new ReadCache();
  let calls = 0;
  const load = async () => ++calls;
  assert.deepEqual(await Promise.all([cache.read('/week', load), cache.read('/week', load)]), [1, 1]);
  const version = cache.version('/week');
  assert.ok(version > 0);
  assert.equal(await cache.read('/week', load), 1);
  t.mock.timers.tick(5000);
  assert.equal(cache.version('/week'), 0);
  assert.equal(await cache.read('/week', load), 2);
  assert.notEqual(cache.version('/week'), version);
  t.mock.timers.tick(30_000);
  assert.equal(await cache.read('/week', load), 3);
  assert.equal(await new ReadCache().read('/week', load), 4);
});

test('写入使对应的在途请求失效，新旧读取共享写后结果，其他列表继续复用', async () => {
  const cache = new ReadCache();
  const old = Promise.withResolvers<number>();
  let calls = 0;
  const load = () => ++calls === 1 ? old.promise : Promise.resolve(2);
  const pending = cache.read('/booking', load);
  await cache.read('/courses', async () => 4);
  cache.invalidate(path => path === '/booking');
  assert.equal(await cache.read('/booking', load), 2);
  old.resolve(1);
  assert.equal(await pending, 2);
  assert.equal(calls, 2);
  assert.equal(await cache.read('/courses', async () => 5), 4);
});

test('失败后重试重新请求，旧请求失败不会清除较新的成功结果', async () => {
  const cache = new ReadCache();
  const old = Promise.withResolvers<number>();
  const pending = cache.read('/account', () => old.promise);
  cache.invalidate(() => true);
  await assert.rejects(cache.read('/account', async () => { throw Error('temporary'); }));
  assert.equal(await cache.read('/account', async () => 3), 3);
  old.reject(Error('old'));
  await assert.rejects(pending);
  assert.equal(await cache.read('/account', async () => 4), 3);
});
