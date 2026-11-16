export interface Coach {
  id: string;
  name: string;
}

export interface Course {
  id: string;
  title: string;
  coachName: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  points: number;
  capacity: number;
  bookedCount: number;
  bookedByMe: boolean;
}

export interface Schedule {
  today: string;
  lastDate: string;
  courses: Course[];
  coaches: Coach[];
}

export interface PrivateSlot {
  startsAt: string;
  endsAt: string;
  points: number;
}

export type BookingSelection =
  | { type: 'GROUP'; classSessionId: string }
  | { type: 'PRIVATE'; coachId: string; startsAt: string; endsAt: string };

export interface Quote extends PrivateSlot {
  title: string;
  coachName: string;
  venue: string;
}

export interface BookingQuote extends Quote {
  revision: string;
}

export interface Booking extends Quote {
  id: string;
  type: BookingSelection['type'];
  status: 'CONFIRMED' | 'CANCELLED';
}

export interface Account {
  balance: number;
  ledger: { id: number; delta: number; reason: string; createdAt: string }[];
}

export interface Child {
  name: string;
}

export interface ApiFailure {
  code: string;
  message: string;
}

export type ClassStatus = 'PUBLISHED' | 'CLOSED';

export interface ClassDraft {
  title: string;
  coachId: string;
  venue: string;
  date: string;
  startMinute: number;
  duration: number;
  capacity: number;
  points: number;
}

export interface ClassPlan extends ClassDraft {
  startMinutes: number[];
  weekdays: number[];
}

export interface ManagedClass extends ClassDraft {
  id: string;
  coachName: string;
  startsAt: string;
  endsAt: string;
  status: ClassStatus;
  bookedCount: number;
  attendees: { userId: string; childName: string }[];
}

export interface ManagedBooking extends Booking {
  userId: string;
  childName: string;
  staffCreated: boolean;
  staffCancelled: boolean;
}

export interface ManagedUser {
  id: string;
  childName: string | null;
  balance: number;
}

export interface MinuteWindow {
  start: number;
  end: number;
}

export interface CoachHours {
  windows: MinuteWindow[];
  exceptions: (MinuteWindow & { id: string; reason: string })[];
}

export interface StaffAccount extends Account {
  ledger: (Account['ledger'][number] & { source: string; operator: string | null; reference: string | null })[];
}
