import type { RoleSession, SessionRole, WechatLogin } from '../../../../packages/shared/contracts.js';
import { demoCoachProfilesPath, invalidatePublicRead, publicSchedulePath } from './public-read';
import { ReadCache } from './read-cache';
import { staffReadAffected } from './staff-read-dependencies';
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
const noticePages = {
  'admin-bookings': { role: 'ADMIN', read: '/api/admin/bookings?pending=1' },
  'admin-registrations': { role: 'ADMIN', read: '/api/admin/registrations?view=pending' },
  bookings: { role: 'PARENT', read: '/api/me/bookings' },
  child: { role: 'PARENT', read: '/api/me/registration' }
} as const;
export type NoticePage = keyof typeof noticePages;
export function noticePage(value?: string): NoticePage | undefined {
  return value && Object.prototype.hasOwnProperty.call(noticePages, value) ? value as NoticePage : undefined;
}
let demoProfile = '';
export function parentAccountId() {
  return wechat?.accountId ?? demoProfile;
}
let active: RoleSession | undefined;
let wechat: WechatLogin | undefined;

function openCurrentHome(courseId?: string, notice?: NoticePage) {
  if (notice && active?.role === noticePages[notice].role) {
    if (notice === 'bookings') {
      reads.get(active)?.invalidate(key => parentReadAffected('/api/bookings', key));
    } else invalidateRead(noticePages[notice].read);
    wx.reLaunch({ url: '/pages/' + notice + '/index' });
    return;
  }
  const url = courseId && active?.role === 'PARENT'
    ? '/pages/child/index?course=' + encodeURIComponent(courseId)
    : active ? home[active.role] : entry;
  wx.reLaunch({ url });
}

export function allowEntry(courseId?: string, notice?: NoticePage): boolean {
  if (!active) return true;
  if (notice && wechat && active.role !== noticePages[notice].role) return true;
  openCurrentHome(courseId, notice);
  return false;
}

export function allowPage(role: SessionRole | 'SIGNED_IN'): boolean {
  if (!active || (role !== 'SIGNED_IN' && active.role !== role)) {
    openCurrentHome();
    return false;
  }
  return true;
}

export function showParentTab(page: Pick<WechatMiniprogram.Page.TrivialInstance, 'route' | 'getTabBar'>) {
  const authorized = allowPage('PARENT');
  const tab = page.getTabBar();
  const activePath = authorized ? page.route : '';
  if (tab && (tab.data as { activePath?: string }).activePath !== activePath) tab.setData({ activePath });
  return authorized;
}

export async function signIn(role: SessionRole, data: object, courseId?: string) {
  if (active) throw new RequestError('ALREADY_SIGNED_IN', '请先退出当前身份', 409);
  const session = await send<RoleSession>(endpoint[role], 'POST', data);
  if (session.role !== role || !session.token) throw new RequestError('INVALID_SESSION', '登录会话无效，请重试', 500);
  demoProfile = role === 'PARENT' && 'profile' in data ? String(data.profile) : '';
  active = session;
  openCurrentHome(courseId);
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

export async function selectWechatRole(role: SessionRole, courseId?: string, notice?: NoticePage) {
  if (!wechat) throw new RequestError('NOT_AUTHORIZED', '请先使用微信登录', 401);
  try {
    if (notice && active && active.role !== role && active.role !== 'ADMIN') await signInWechat();
    const session = await send<RoleSession>('/api/auth/role', 'POST', { role }, wechat.token);
    wechat = { ...wechat, token: session.token };
    active = session;
    openCurrentHome(courseId, notice);
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

const reads = new WeakMap<RoleSession, ReadCache>();

export function readVersion(path: string): number {
  return active ? reads.get(active)?.version(path) ?? 0 : 0;
}

export function hasFreshRead(path: string): boolean {
  return readVersion(path) !== 0;
}

export function invalidateRead(path: string) {
  if (active) reads.get(active)?.invalidate(key => key === path);
}

function parentReadAffected(write: string, read: string, data?: object) {
  if (write === '/api/me/contact') return read === write || read === '/api/me/registration';
  if (write === '/api/me/registration' || write === '/api/me/child')
    return ['/api/me/registration', '/api/me/child', '/api/me/contact'].includes(read);
  if (write === '/api/bookings' || write.startsWith('/api/me/bookings/')) {
    if (read === '/api/me/bookings' || read === '/api/me/account') return true;
    if (data && 'type' in data && data.type === 'GROUP') return read.startsWith('/api/schedule');
    if (data && 'coachId' in data) return read.startsWith('/api/coaches/' + data.coachId + '/slots?');
    return read.startsWith('/api/schedule') || read.startsWith('/api/coaches/');
  }
  return false;
}

export async function roleRequest<T>(role: SessionRole, path: string, method: Method = 'GET', data?: object): Promise<T> {
  const session = active;
  if (session?.role !== role) throw new RequestError('NOT_AUTHORIZED', '请使用对应身份登录', 401);
  let cache = reads.get(session);
  if (!cache) {
    cache = new ReadCache();
    reads.set(session, cache);
  }
  const perform = async () => {
    if (session !== active) throw new RequestError('NOT_AUTHORIZED', '登录身份已切换', 401);
    const result = await send<T>(path, method, data, session.token);
    if (session !== active) throw new RequestError('NOT_AUTHORIZED', '登录身份已切换', 401);
    return result;
  };
  const invalidateAffected = () => {
    cache.invalidate(key => role === 'PARENT' ? parentReadAffected(path, key, data) : staffReadAffected(path, key));
    if (role === 'ADMIN') {
      const coachChanged = /^\/api\/admin\/coaches(?:\/[^/]+)?$/.test(path);
      if (coachChanged) invalidatePublicRead(demoCoachProfilesPath);
      if (coachChanged || /^\/api\/admin\/(classes|class-sessions|class-templates)(?:\/|$)/.test(path))
        invalidatePublicRead(publicSchedulePath);
    }
  };
  const mutation = method !== 'GET' && !path.endsWith('/quote');
  try {
    const result = method === 'GET' && !data ? await cache.read(path, perform) : await perform();
    if (session !== active) throw new RequestError('NOT_AUTHORIZED', '登录身份已切换', 401);
    if (mutation) invalidateAffected();
    return result;
  } catch (error) {
    if (mutation && (!(error instanceof RequestError) || error.status !== 400)) invalidateAffected();
    if (error instanceof RequestError && error.status === 401 && session === active) {
      active = undefined;
      wechat = undefined;
      wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' });
      openCurrentHome();
    }
    throw error;
  }
}
