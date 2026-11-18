import { ApiError } from './booking.ts';

export interface WechatLoginConfig {
  appId: string;
  exchangeCode: (code: string) => Promise<string>;
}

export function wechatLoginConfig(appId: string, secret: string, request = fetch): WechatLoginConfig {
  return {
    appId,
    async exchangeCode(code) {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.search = new URLSearchParams({
        appid: appId, secret, js_code: code, grant_type: 'authorization_code'
      }).toString();
      let payload: unknown;
      try {
        const response = await request(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (!response.ok) throw new Error('WeChat login HTTP request failed');
        payload = await response.json();
      } catch {
        throw new ApiError(502, 'WECHAT_UNAVAILABLE', '暂时无法连接微信登录服务，请重试');
      }
      if (!payload || typeof payload !== 'object') {
        throw new ApiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务返回异常，请重试');
      }
      if ('errcode' in payload && (payload.errcode === 40029 || payload.errcode === 40163)) {
        throw new ApiError(401, 'INVALID_WECHAT_CODE', '微信登录凭证已失效，请重试');
      }
      if (('errcode' in payload && payload.errcode !== 0) ||
          !('openid' in payload) || typeof payload.openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.openid)) {
        throw new ApiError(502, 'WECHAT_UNAVAILABLE', '微信登录服务暂不可用，请重试');
      }
      return payload.openid;
    }
  };
}
