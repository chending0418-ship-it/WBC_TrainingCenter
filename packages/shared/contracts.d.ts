export interface Coach {
  avatarKey?: string | null;
  id: string;
  name: string;
}

export interface ManagedCoach extends Coach {
  /** Total price of a 60-minute private lesson. */
  pointsPerSlot: number;
  points90: number;
  points120: number;
  enabled: boolean;
  privateCourseTypeId: string | null;
}

export interface CourseType {
  id: string;
  name: string;
  maxStudents: number;
  refundPercent: number;
}

export interface PublicCourse {
  id: string;
  title: string;
  coachName: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  courseTypeName: string | null;
}

export interface Course extends PublicCourse {
  trainingPlan: string;
  points: number;
  capacity: number;
  bookedCount: number;
  bookedByMe: boolean;
}

export interface PublicSchedule {
  today: string;
  lastDate: string;
  courses: PublicCourse[];
}

export interface Schedule extends PublicSchedule {
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
  | { type: 'PRIVATE'; coachId: string; startsAt: string; endsAt: string; courseTypeId?: string };

export interface Quote extends PrivateSlot {
  title: string;
  coachName: string;
  venue: string;
  refundPoints: number;
}

export interface BookingQuote extends Quote {
  revision: string;
}

export interface Booking extends Quote {
  id: string;
  type: BookingSelection['type'];
  status: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'REJECTED';
}

export interface Account {
  balance: number;
  reservedPoints: number;
  ledger: { id: number; delta: number; reason: string; createdAt: string; trainingTitle: string | null; trainingStart: string | null }[];
}

export interface Child {
  name: string;
  birthMonth: string | null;
  gender: 'MALE' | 'FEMALE' | null;
}

export interface ParentContact {
  name: string;
  phone: string;
}

export interface ApiFailure {
  code: string;
  message: string;
}

export type ClassStatus = 'PUBLISHED' | 'CLOSED';

export interface ClassDraft {
  trainingPlan?: string;
  coachIds?: string[];
  courseTypeId?: string | null;
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

export interface ManagedTemplate extends ClassPlan {
  trainingPlan: string;
  courseTypeName: string | null;
  courseTypeMaxStudents: number | null;
  coachIds: string[];
  id: string;
  coachName: string;
  enabled: boolean;
}

export interface ManagedClass extends ClassDraft {
  trainingPlan: string;
  courseTypeMaxStudents: number | null;
  coachIds: string[];
  courseTypeId: string | null;
  courseTypeName: string | null;
  id: string;
  coachName: string;
  startsAt: string;
  endsAt: string;
  status: ClassStatus;
  bookable: boolean;
  bookedCount: number;
  attendees: { userId: string; childName: string }[];
}

export type ManagedLesson = (ManagedClass & { type: 'GROUP' }) | {
  type: 'PRIVATE';
  id: string;
  date: string;
  title: string;
  venue: string;
  coachId: string;
  coachName: string;
  startsAt: string;
  endsAt: string;
  childName: string;
};

export interface ManagedBooking extends Booking {
  userId: string;
  childName: string;
  staffCreated: boolean;
  staffCancelled: boolean;
  canCancel: boolean;
  canApprove: boolean;
}

export interface ManagedUser {
  id: string;
  childName: string | null;
  balance: number;
}

export interface ManagedParent extends ManagedUser {
  jerseyNumber: string | null;
  registrationStatus: RegistrationStatus | null;
  reservedPoints: number;
  contact: ParentContact | null;
  child: Child | null;
}

export interface MinuteWindow {
  start: number;
  end: number;
}

export interface CoachHours {
  windows: MinuteWindow[];
  exceptions: (MinuteWindow & { id: string; reason: string })[];
}

export type StaffLedgerSource = 'OFFLINE_CREDIT' | 'ADJUSTMENT' | 'REVERSAL';

export interface StaffAccount extends Account {
  childName: string | null;
  ledger: (Account['ledger'][number] & {
    source: 'SEED' | 'BOOKING' | 'BOOKING_REFUND' | StaffLedgerSource;
    operator: string | null;
    reference: string | null;
    bookingId: string | null;
    reversalOf: number | null;
    reversalId: number | null;
  })[];
}

export interface CoachLesson {
  trainingPlan: string | null;
  id: string;
  type: BookingSelection['type'];
  title: string;
  venue: string;
  startsAt: string;
  endsAt: string;
  childNames: string[];
  bookedCount: number;
}

export interface CoachSchedule {
  avatarKey: string | null;
  coachName: string;
  from: string;
  to: string;
  lessons: CoachLesson[];
}

export type SessionRole = 'PARENT' | 'COACH' | 'ADMIN';

export interface RoleSession {
  role: SessionRole;
  token: string;
}

export interface WechatLogin {
  accountId: string;
  roles: SessionRole[];
  token: string;
}


export type RegistrationStatus = 'PENDING' | 'APPROVED' | 'RETURNED';

export interface Registration {
  userId: string;
  child: Child;
  contact: ParentContact | null;
  status: RegistrationStatus;
  submittedAt: string;
  reviewedAt: string | null;
  reason: string | null;
  revision: string;
}
