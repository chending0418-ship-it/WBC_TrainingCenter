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
