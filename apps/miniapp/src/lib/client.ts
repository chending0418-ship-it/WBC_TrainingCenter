import type { ApiFailure } from '../../../../packages/shared/contracts.js';

const apiBase = 'http://127.0.0.1:3000';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export class RequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function send<T>(path: string, method: Method, data?: object, token?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: apiBase + path,
      method,
      // 微信会给无正文请求带 JSON 请求头，DELETE 传空对象供服务端解析。
      data: method === 'DELETE' ? (data ?? {}) : data,
      header: token ? { Authorization: 'Bearer ' + token } : {},
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
        reject(new RequestError('NETWORK', '无法连接本地 API，请检查服务后重试', 0));
      }
    });
  });
}

let session: Promise<{ token: string }> | undefined;

function login() {
  session ??= send<{ token: string }>('/api/dev/session', 'POST', { profile: 'parent' }).catch(error => {
    session = undefined;
    throw error;
  });
  return session;
}

export async function api<T>(path: string, method: Method = 'GET', data?: object): Promise<T> {
  const activeSession = login();
  try {
    return await send<T>(path, method, data, (await activeSession).token);
  } catch (error) {
    if (!(error instanceof RequestError) || error.status !== 401) throw error;
    if (session === activeSession) session = undefined;
    return send<T>(path, method, data, (await login()).token);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof RequestError ? error.message : '操作失败，请重试';
}
