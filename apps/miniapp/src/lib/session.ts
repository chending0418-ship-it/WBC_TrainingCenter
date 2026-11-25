import { config } from './config';
import type { FamilyPlayer, RoleSession, SessionRole, WechatLogin } from '../../../../packages/shared/contracts.js';
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
  bookings: { role: 'PARENT', read: '/api/me/bookings?view=pages' },
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
      reads.get(active)?.invalidate(key => parentReadAffected('/api/bookings', key.split('|')[0]));
    } else invalidateRead(noticePages[notice].read);
    wx.reLaunch({ url: '/pages/' + notice + '/index' + (notice === 'admin-bookings' ? '?pending=1' : '') });
    return;
  }
  const url = courseId && active?.role === 'PARENT'
    ? '/pages/child/index?course=' + encodeURIComponent(courseId)
    : active ? home[active.role] : entry;
  wx.reLaunch({ url });
}

export function allowEntry(courseId?: string, notice?: NoticePage): boolean {
  if (!active) return true;
  if (notice && active.role !== noticePages[notice].role && wechat?.roles.includes(noticePages[notice].role)) return true;
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
    const session = await send<RoleSession>('/api/auth/role', 'POST', { role }, wechat.token);
    wechat = { ...wechat, token: session.token };
    active = session;
    openCurrentHome(courseId, notice);
  } catch (error) {
    if (error instanceof RequestError && (error.status === 401 || error.status === 403)) {
      active = undefined;
      wechat = undefined;
    }
    throw error;
  }
}

export function canSwitchRole() {
  return wechat ? wechat.roles.length > 1 : active?.role === 'ADMIN';
}

export function switchRole() {
  if (!active || !canSwitchRole()) return;
  if (!wechat) void send(endpoint.ADMIN, 'DELETE', undefined, active.token).catch(() => undefined);
  active = undefined;
  wx.reLaunch({ url: entry + '?login=1' });
}

const reads = new WeakMap<RoleSession, ReadCache>();

const selectedPlayers = new WeakMap<RoleSession,string>();
export function currentPlayerId() { return active ? selectedPlayers.get(active) || '' : ''; }
export function choosePlayer(id: string) {
  if (active?.role !== 'PARENT' || id === currentPlayerId()) return;
  selectedPlayers.set(active,id);
}
export async function familyContext() {
  const family = await roleRequest<{ players: FamilyPlayer[]; defaultId: string }>('PARENT','/api/me/players');
  const available = family.players.filter(row => row.status === 'APPROVED' || row.kind === 'CREATE');
  const current = available.find(row => row.id === currentPlayerId()) ?? available.find(row => row.id === family.defaultId);
  choosePlayer(current?.id ?? '');
  return { players: family.players, available, current };
}

function playerScoped(path: string) {
  return path.startsWith('/api/schedule') || path.startsWith('/api/bookings') ||
    ['/api/me/account','/api/me/bookings','/api/me/registration','/api/me/child'].includes(path.split('?')[0]);
}
function cacheKey(path: string) {
  return active?.role === 'PARENT' && playerScoped(path) ? path + '|' + currentPlayerId() : path;
}

export function readVersion(path: string): number {
  return active ? reads.get(active)?.version(cacheKey(path)) ?? 0 : 0;
}

export function hasFreshRead(path: string): boolean {
  return readVersion(path) !== 0;
}

export function invalidateRead(path: string) {
  if (active) reads.get(active)?.invalidate(key => key === cacheKey(path));
}

function parentReadAffected(write: string, read: string, data?: object) {
  if (['/api/me/players','/api/me/player-links','/api/me/registration','/api/me/child'].includes(write))
    return ['/api/me/players','/api/me/registration','/api/me/child','/api/me/contact'].includes(read);
  if (write === '/api/me/contact') return read === write || read === '/api/me/registration';
  if (write === '/api/bookings' || write.startsWith('/api/me/bookings/')) {
    read = read.split('?')[0];
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
  const scoped = role === 'PARENT' && playerScoped(path);
  const playerId = scoped ? currentPlayerId() : undefined;
  const perform = async () => {
    if (session !== active) throw new RequestError('NOT_AUTHORIZED', '登录身份已切换', 401);
    const result = await send<T>(path, method, data, session.token, playerId);
    if (scoped && playerId !== currentPlayerId()) throw new RequestError('PLAYER_CHANGED','已切换队员，请重新查看',409);
    if (session !== active) throw new RequestError('NOT_AUTHORIZED', '登录身份已切换', 401);
    return result;
  };
  const invalidateAffected = () => {
    cache.invalidate(key => {
      if (role !== 'PARENT') return staffReadAffected(path,key);
      const [resource,owner] = key.split('|');
      // A group booking changes capacity for every player, but only one player's balance and history.
      if (owner !== undefined && owner !== playerId && !resource.startsWith('/api/schedule') && !['/api/me/players','/api/me/contact'].includes(path)) return false;
      return parentReadAffected(path,resource,data);
    });
    if (role === 'ADMIN') {
      const coachChanged = /^\/api\/admin\/coaches(?:\/[^/]+)?$/.test(path);
      if (coachChanged) invalidatePublicRead(demoCoachProfilesPath);
      if (coachChanged || /^\/api\/admin\/(classes|class-sessions|class-templates)(?:\/|$)/.test(path))
        invalidatePublicRead(publicSchedulePath);
    }
  };
  const mutation = method !== 'GET' && !path.endsWith('/quote');
  try {
    const result = method === 'GET' && !data ? await cache.read(cacheKey(path), perform) : await perform();
    if (session !== active) throw new RequestError('NOT_AUTHORIZED', '登录身份已切换', 401);
    if (mutation) invalidateAffected();
    return result;
  } catch (error) {
    if (mutation && (!(error instanceof RequestError) || error.status !== 400)) invalidateAffected();
    if (error instanceof RequestError && error.code === 'PLAYER_ACCESS_DENIED') {
      cache.invalidate(key => key === '/api/me/players' || key.endsWith('|' + playerId));
    }
    if (error instanceof RequestError && error.status === 401 && session === active) {
      active = undefined;
      wechat = undefined;
      wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' });
      openCurrentHome();
    }
    throw error;
  }
}

export function fetchAdminFile(path: string): Promise<ArrayBuffer> {
  const session = active;
  if (session?.role !== 'ADMIN') return Promise.reject(new RequestError('NOT_AUTHORIZED', '请登录管理端', 401));
  return new Promise((resolve, reject) => wx.request({
    url: config.apiBase + '/api/admin/exports/' + path, responseType: 'arraybuffer',
    header: { Authorization: 'Bearer ' + session.token }, timeout: 60000,
    success(result) {
      if (session !== active || result.statusCode !== 200) {
        reject(new RequestError('EXPORT_FAILED', '导出失败，请确认登录状态后重试', result.statusCode));
      } else resolve(result.data as ArrayBuffer);
    },
    fail: () => reject(new RequestError('NETWORK', '下载失败，请检查网络后重试', 0))
  }));
}
