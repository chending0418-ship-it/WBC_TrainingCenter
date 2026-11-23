import { config } from './config';

export function coachLabel(name: string) {
  return name.split('、').map(part => part.trim()).filter(Boolean)
    .map(part => part.endsWith('教练') ? part : part + '教练').join('、');
}

export function coachIdentity(name: string, key?: string | null) {
  return {
    label: coachLabel(name),
    initial: Array.from(name.trim())[0] || '教',
    avatarUrl: key ? config.apiBase + '/api/coach-avatars/' + encodeURIComponent(key) : ''
  };
}
