import type { Method } from './request';
import { roleRequest } from './session';

export { errorMessage, RequestError } from './request';

export function api<T>(path: string, method: Method = 'GET', data?: object): Promise<T> {
  return roleRequest<T>('PARENT', path, method, data);
}
