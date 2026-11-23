import type { PublicCourse } from '../../../../packages/shared/contracts.js';
import { coachLabel } from './coach-avatar';
import { localTimestamp, timeRange } from './display';

export type PublicLesson = PublicCourse & { hours: string; coachLabel: string; hasStarted: boolean };

export function publicLessonDays(courses: PublicCourse[]) {
  const lessons = new Map<string, PublicLesson[]>();
  const now = Date.now();
  let nextCourseStart = Infinity;
  for (const course of courses) {
    const date = localTimestamp(course.startsAt).slice(0, 10);
    const day = lessons.get(date) ?? [];
    const start = Date.parse(course.startsAt);
    if (start > now) nextCourseStart = Math.min(nextCourseStart, start);
    day.push({ ...course, hasStarted: start <= now, hours: timeRange(course.startsAt, course.endsAt),
      coachLabel: coachLabel(course.coachName) });
    lessons.set(date, day);
  }
  return { lessons, nextCourseStart };
}
