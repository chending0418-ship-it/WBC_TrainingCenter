import { randomUUID } from 'node:crypto';
import type { RoleSession, SessionRole } from '../../../packages/shared/contracts.js';
import { ApiError } from './booking.ts';

const sessionDuration = 8 * 60 * 60 * 1000;

export function roleSessions(role: SessionRole, clock: () => Date, signInMessage: string) {
  const sessions = new Map<string, { subject: string; expiresAt: number }>();

  function create(subject: string): RoleSession {
    const now = clock().getTime();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token);
    }
    const token = randomUUID();
    sessions.set(token, { subject, expiresAt: now + sessionDuration });
    return { role, token };
  }

  function authorize(authorization: string | undefined) {
    const token = authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
    const session = sessions.get(token);
    if (!session || session.expiresAt <= clock().getTime()) {
      sessions.delete(token);
      throw new ApiError(401, 'NOT_AUTHORIZED', signInMessage);
    }
    return { token, subject: session.subject };
  }

  function revoke(authorization: string | undefined) {
    sessions.delete(authorize(authorization).token);
  }

  return { create, authorize, revoke };
}
