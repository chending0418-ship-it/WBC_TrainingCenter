import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { askSubscription, requestOnSubmit, templateIdsFor } from '../src/lib/subscription-request.ts';

afterEach(() => { Reflect.deleteProperty(globalThis, 'wx'); });

test('按事件去重，预约确认与拒绝共用一次授权，取消与管理员待办保持独立', () => {
  const templates = [
    { kind: 'BOOKING_CONFIRMED', templateId: 'result' }, { kind: 'BOOKING_REJECTED', templateId: 'result' },
    { kind: 'BOOKING_CANCELLED', templateId: 'cancel' }, { kind: 'REGISTRATION_APPROVED', templateId: 'review' },
    { kind: 'REGISTRATION_SUBMITTED', templateId: 'new-player' }, { kind: 'BOOKING_SUBMITTED', templateId: 'new-booking' }
  ];
  assert.deepEqual(templateIdsFor('booking', templates), ['result', 'cancel']);
  assert.deepEqual(templateIdsFor('registration', templates), ['review']);
  assert.deepEqual(templateIdsFor('admin', templates), ['new-player', 'new-booking']);
});

test('直接在点击调用栈弹出授权，只登记明确接受的模板', async () => {
  let tapping = true;
  Reflect.set(globalThis, 'wx', { requestSubscribeMessage(options: WechatMiniprogram.RequestSubscribeMessageOption) {
    assert(tapping);
    options.success?.({ errMsg: 'requestSubscribeMessage:ok', result: 'accept', cancel: 'reject', other: 'accept' });
  } });
  const recorded: string[][] = [];
  const pending = askSubscription(['result', 'cancel'], async ids => { recorded.push(ids); });
  tapping = false;
  assert.equal(await pending, 'partial');
  assert.deepEqual(recorded, [['result']]);
});

test('拒绝、关闭订阅和配置不可用都不登记额度', async () => {
  let sent = false;
  const record = async () => { sent = true; };
  Reflect.set(globalThis, 'wx', { requestSubscribeMessage(o: WechatMiniprogram.RequestSubscribeMessageOption) {
    o.success?.({ errMsg: 'requestSubscribeMessage:ok', review: 'reject' });
  } });
  assert.equal(await askSubscription(['review'], record), 'declined');
  Reflect.set(globalThis, 'wx', { requestSubscribeMessage(o: WechatMiniprogram.RequestSubscribeMessageOption) {
    o.fail?.({ errCode: 20004, errMsg: 'main switch off' });
  } });
  assert.equal(await askSubscription(['review'], record), 'disabled');
  Reflect.set(globalThis, 'wx', {});
  assert.equal(await askSubscription([], record), 'unavailable');
  assert.equal(sent, false);
});

test('服务器确认失败时不显示已登记', async () => {
  Reflect.set(globalThis, 'wx', { requestSubscribeMessage(o: WechatMiniprogram.RequestSubscribeMessageOption) {
    o.success?.({ errMsg: 'requestSubscribeMessage:ok', review: 'accept' });
  } });
  assert.equal(await askSubscription(['review'], async () => { throw new Error('offline'); }), 'unrecorded');
});

test('订阅组件失败或微信弹窗未返回时，提交可继续', async t => {
  const page = (request: () => Promise<void>) => ({
    selectComponent() { return { request }; }
  }) as unknown as Pick<WechatMiniprogram.Page.TrivialInstance, 'selectComponent'>;
  await requestOnSubmit(page(async () => { throw new Error('failed'); }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opened = false;
  const prompt = Promise.withResolvers<void>();
  const allowed = requestOnSubmit(page(() => { opened = true; return prompt.promise; }));
  assert.equal(opened, true);
  t.mock.timers.tick(8000);
  await allowed;
  prompt.resolve();
});
