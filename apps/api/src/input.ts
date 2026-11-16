import type { BookingSelection } from '../../../packages/shared/contracts.js';
import { ApiError } from './booking.ts';
import { isInstant, isVenueDate } from './time.ts';

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || !value || Array.isArray(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', '请求参数有误');
  }
  return value as Record<string, unknown>;
}

export function requiredText(value: unknown, limit = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new ApiError(400, 'VALIDATION_ERROR', '请求参数有误');
  }
  return value.trim();
}

export function selection(body: Record<string, unknown>): BookingSelection {
  if (body.type === 'GROUP') return { type: 'GROUP', classSessionId: requiredText(body.classSessionId) };
  if (body.type === 'PRIVATE') {
    const coachId = requiredText(body.coachId);
    const startsAt = requiredText(body.startsAt);
    const endsAt = requiredText(body.endsAt);
    if (isInstant(startsAt) && isInstant(endsAt)) return { type: 'PRIVATE', coachId, startsAt, endsAt };
  }
  throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效的课程或时段');
}

export function dateInput(value: unknown): string {
  const date = requiredText(value);
  if (!isVenueDate(date)) throw new ApiError(400, 'VALIDATION_ERROR', '请选择有效的日期');
  return date;
}

export function integer(value: unknown, min: number, max: number, message = '请求参数有误'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError(400, 'VALIDATION_ERROR', message);
  }
  return value;
}

export function expectedRevision(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredText(value, 64);
}
