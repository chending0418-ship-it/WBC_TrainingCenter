import { roleRequest, wechatIdentity } from './session';
import { RequestError } from './request';

type Role = 'ADMIN' | 'PARENT';
type Receipt = { requestKey: string; templateIds: string[] };
const inFlight = new Map<string, Promise<void>>();

export function subscriptionPath(role: Role) { return '/api/wechat/subscriptions/' + role.toLowerCase(); }

function stored(key: string): Receipt[] {
  try {
    const list: unknown = wx.getStorageSync(key);
    return Array.isArray(list) ? list.filter(r => r && typeof r.requestKey === 'string' && Array.isArray(r.templateIds)) : [];
  } catch { return []; }
}

function store(key: string, list: Receipt[]) {
  try {
    if (list.length) wx.setStorageSync(key, list);
    else wx.removeStorageSync(key);
  } catch { /* The current request can still be sent if device storage is full. */ }
}

function sendReceipt(role: Role, accountId: string, key: string, receipt: Receipt) {
  const id = key + '/' + receipt.requestKey;
  let pending = inFlight.get(id);
  if (!pending) {
    pending = (async () => {
      if (wechatIdentity()?.accountId !== accountId) throw new Error('登录身份已切换');
      try {
        await roleRequest(role, subscriptionPath(role), 'POST', receipt);
      } catch (error) {
        // An obsolete template or a rejected idempotency key cannot be repaired by replaying it.
        if (error instanceof RequestError && (error.status === 400 || error.status === 409)) {
          store(key, stored(key).filter(r => r.requestKey !== receipt.requestKey));
        }
        throw error;
      }
      store(key, stored(key).filter(r => r.requestKey !== receipt.requestKey));
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, pending);
  }
  return pending;
}

export function recordGrant(role: Role, accountId: string, templateIds: string[]) {
  const key = 'subscription-grants/' + role + '/' + accountId;
  const receipt = { requestKey: Date.now() + '-' + Math.random().toString(36).slice(2), templateIds };
  store(key, [...stored(key), receipt]);
  return sendReceipt(role, accountId, key, receipt);
}

export function retryGrants(role: Role, accountId: string) {
  const key = 'subscription-grants/' + role + '/' + accountId;
  for (const receipt of stored(key)) void sendReceipt(role, accountId, key, receipt).catch(() => {});
}
