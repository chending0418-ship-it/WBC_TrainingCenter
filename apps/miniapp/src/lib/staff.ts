import type { Coach } from '../../../../packages/shared/contracts.js';
import { RequestError } from './request';
import type { Method } from './request';
import { roleRequest } from './session';

const pending = new Map<string, { requestKey: string; expectedRevision?: string }>();

export function staffApi<T>(path: string, method: Method = 'GET', data?: object): Promise<T> {
  return roleRequest<T>('ADMIN', '/api/admin' + path, method, data);
}

export function hasPendingStaffWrite(path: string, data: object) {
  return pending.has(path + JSON.stringify(data));
}

export async function staffWrite<T>(path: string, data: object, expectedRevision?: string, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  const signature = (method === 'PUT' ? 'PUT:' : '') + path + JSON.stringify(data);
  const confirmation = pending.get(signature) ?? {
    requestKey: Date.now() + '-' + Math.random().toString(36).slice(2), expectedRevision
  };
  pending.set(signature, confirmation);
  try {
    const result = await staffApi<T>(path, method, { ...data, ...confirmation });
    pending.delete(signature);
    return result;
  } catch (error) {
    if (error instanceof RequestError && error.status >= 400 && error.status < 500 && error.status !== 401) {
      pending.delete(signature);
    }
    throw error;
  }
}

export function staffContext() {
  return staffApi<{ today: string; lastDate: string; coaches: Coach[] }>('/context');
}

export function confirmAction(title: string, content: string, confirmText: string): Promise<boolean> {
  return new Promise(resolve => wx.showModal({
    title, content, confirmText, confirmColor: '#761F32',
    success: response => resolve(response.confirm),
    fail: () => resolve(false)
  }));
}

export function minuteString(minute: number) {
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}

export function parseMinutes(value: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new RequestError('VALIDATION_ERROR', '请按 HH:MM 填写时间，例如 14:30', 400);
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function dayOfWeek(date: string) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}
