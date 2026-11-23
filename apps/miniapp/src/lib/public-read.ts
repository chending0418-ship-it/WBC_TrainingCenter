import { ReadCache } from './read-cache';
import { send } from './request';

const reads = new ReadCache();
export const publicSchedulePath = '/api/public/schedule';
export const demoCoachProfilesPath = '/api/dev/coach-profiles';

export function publicRead<T>(path: typeof publicSchedulePath | typeof demoCoachProfilesPath) {
  return reads.read(path, () => send<T>(path, 'GET'));
}

export function publicReadVersion(path: string) { return reads.version(path); }
export function invalidatePublicRead(path: string) { reads.invalidate(key => key === path); }
