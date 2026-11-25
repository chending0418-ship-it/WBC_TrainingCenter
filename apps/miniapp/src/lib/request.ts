import type { ApiFailure } from '../../../../packages/shared/contracts.js';
import { config } from './config';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export class RequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function send<T>(path: string, method: Method, data?: object, token?: string, playerId?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.apiBase + path,
      method,
      // 微信会给无正文请求带 JSON 请求头，DELETE 传空对象供服务端解析。
      data: method === 'DELETE' ? (data ?? {}) : data,
      header: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(playerId ? { 'X-Player-ID': playerId } : {}) },
      timeout: 8000,
      success(result) {
        if (result.statusCode >= 200 && result.statusCode < 300) {
          resolve(result.data as T);
          return;
        }
        const body = result.data as ApiFailure | undefined;
        reject(new RequestError(body?.code ?? 'REQUEST_FAILED', body?.message ?? '请求失败，请重试', result.statusCode));
      },
      fail() {
        const message = config.mode === 'demo' ? '无法连接本地 API，请检查服务后重试' : '暂时无法连接服务器，请重试';
        reject(new RequestError('NETWORK', message, 0));
      }
    });
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof RequestError ? error.message : '操作失败，请重试';
}
