import type { RoleSession, SessionRole, WechatLogin } from '../../../../packages/shared/contracts.js';
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
let wechat: WechatLogin | undefined;

function openCurrentHome() {
  wx.reLaunch({ url: active ? home[active.role] : entry });
}

export function allowEntry(): boolean {
  if (!active) return true;
  openCurrentHome();
  return false;
}

export function allowPage(role: SessionRole | 'SIGNED_IN', tabPage = false): boolean {
  if (!active || (role !== 'SIGNED_IN' && active.role !== role)) {
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

export function wechatIdentity(): WechatLogin | undefined {
  return wechat;
}

export async function signInWechat(): Promise<WechatLogin> {
  const code = await new Promise<string>((resolve, reject) => {
    const failed = () => reject(new RequestError('WECHAT_LOGIN_FAILED', '无法获取微信登录凭证，请重试', 0));
    wx.login({ success: result => { if (result.code) resolve(result.code); else failed(); }, fail: failed });
  });
  wechat = await send<WechatLogin>('/api/auth/wechat', 'POST', { code });
  return wechat;
}

export async function selectWechatRole(role: SessionRole) {
  if (!wechat) throw new RequestError('NOT_AUTHORIZED', '请先使用微信登录', 401);
  try {
    const session = await send<RoleSession>('/api/auth/role', 'POST', { role }, wechat.token);
    wechat = { ...wechat, token: session.token };
    active = session;
    openCurrentHome();
  } catch (error) {
    if (error instanceof RequestError && (error.status === 401 || error.status === 403)) wechat = undefined;
    throw error;
  }
}

export function switchRole() {
  if (active?.role !== 'ADMIN') return;
  if (!wechat) void send(endpoint.ADMIN, 'DELETE', undefined, active.token).catch(() => undefined);
  active = undefined;
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
      wechat = undefined;
      wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' });
      openCurrentHome();
    }
    throw error;
  }
}
