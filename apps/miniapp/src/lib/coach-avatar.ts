import { config } from './config';

export function coachLabel(name: string) {
  return name.endsWith('教练') ? name : name + '教练';
}

export function coachIdentity(name: string, key?: string | null) {
  return {
    label: coachLabel(name),
    initial: Array.from(name.trim())[0] || '教',
    avatarUrl: key ? config.apiBase + '/api/coach-avatars/' + encodeURIComponent(key) : ''
  };
}
