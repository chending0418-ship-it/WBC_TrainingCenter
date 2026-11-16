import type { RoleSession, SessionRole } from '../../../../packages/shared/contracts.js';
import { RequestError, send } from './request';
import type { Method } from './request';

const home = {
  PARENT: '/pages/schedule/index',
  COACH: '/pages/coach/index',
  ADMIN: '/pages/admin/index'
};

const endpoint = {
  PARENT: '/api/dev/session',
  COACH: '/api/dev/coach-session',
  ADMIN: '/api/admin/session'
};

const entry = '/pages/entry/index';
let active: RoleSession | undefined;

function openCurrentHome() {
  wx.reLaunch({ url: active ? home[active.role] : entry });
}

export function allowEntry(): boolean {
  if (!active) return true;
  openCurrentHome();
  return false;
}

export function allowPage(role: SessionRole, tabPage = false): boolean {
  if (active?.role !== role) {
    if (tabPage) wx.hideTabBar({ fail: () => undefined });
    openCurrentHome();
    return false;
  }
  if (tabPage) wx.showTabBar({ fail: () => undefined });
  return true;
}

export async function signIn(role: SessionRole, data: object) {
  if (active) throw new RequestError('ALREADY_SIGNED_IN', '请先退出当前身份', 409);
  const session = await send<RoleSession>(endpoint[role], 'POST', data);
  if (session.role !== role || !session.token) throw new RequestError('INVALID_SESSION', '登录会话无效，请重试', 500);
  active = session;
  openCurrentHome();
}

export function signOut() {
  const previous = active;
  active = undefined;
  // Local access ends immediately. The server also revokes the token if reachable.
  if (previous) void send(endpoint[previous.role], 'DELETE', undefined, previous.token).catch(() => undefined);
  openCurrentHome();
}

export async function roleRequest<T>(role: SessionRole, path: string, method: Method = 'GET', data?: object): Promise<T> {
  const session = active;
  if (session?.role !== role) throw new RequestError('NOT_AUTHORIZED', '请使用对应身份登录', 401);
  try {
    const result = await send<T>(path, method, data, session.token);
    if (session !== active) throw new RequestError('NOT_AUTHORIZED', '登录身份已切换', 401);
    return result;
  } catch (error) {
    if (error instanceof RequestError && error.status === 401 && session === active) {
      active = undefined;
      wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' });
      openCurrentHome();
    }
    throw error;
  }
}
