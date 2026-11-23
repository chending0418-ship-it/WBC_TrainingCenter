import type { messageBody } from './subscription-config.ts';

export interface MessageClient {
  token(): Promise<string>;
  invalidate(token: string): void;
  send(token: string, body: ReturnType<typeof messageBody>): Promise<number>;
}

export function wechatMessageClient(appId: string, secret: string, request = fetch, clock = Date.now): MessageClient {
  let cached: { value: string; until: number } | undefined;
  let refreshing: Promise<string> | undefined;
  let forceRefresh = false;

  async function obtain() {
    const response = await request('https://api.weixin.qq.com/cgi-bin/stable_token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ grant_type: 'client_credential', appid: appId, secret, force_refresh: forceRefresh })
    });
    if (!response.ok) throw Error('WeChat token service unavailable');
    const data = await response.json();
    if (typeof data?.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw Error('WeChat token service rejected request');
    }
    cached = { value: data.access_token, until: clock() + Math.max(0, data.expires_in - 120) * 1000 };
    forceRefresh = false;
    return cached.value;
  }
  return {
    async token() {
      if (cached && cached.until > clock()) return cached.value;
      refreshing ??= obtain().finally(() => { refreshing = undefined; });
      return refreshing;
    },
    invalidate(token) {
      if (cached?.value === token) { cached = undefined; forceRefresh = true; }
    },
    async send(token, body) {
      const url = new URL('https://api.weixin.qq.com/cgi-bin/message/subscribe/send');
      url.searchParams.set('access_token', token);
      const response = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error('WeChat send outcome unknown');
      const data = await response.json();
      if (!Number.isSafeInteger(data?.errcode)) throw Error('WeChat send outcome unknown');
      return data.errcode as number;
    }
  };
}
