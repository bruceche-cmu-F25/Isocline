/** What devices get from the calendar module (StateResponse.modules.calendar). */
export interface CalendarEvent {
  /** `<calendar id>:<event id>`, unique within an account. */
  id: string;
  account: string;
  calendarId: string;
  calendar: string;
  title: string;
  allDay: boolean;
  /** Local dates, inclusive: the days the event covers. */
  startDate: string;
  endDate: string;
  /** Instants (ISO), for events with a time. */
  start?: string;
  end?: string;
  location?: string;
  /** The event in Google Calendar, and its video call, if any. */
  link?: string;
  meeting?: string;
  organizer?: string;
  /** The user's own answer to an invitation. */
  response?: "accepted" | "declined" | "tentative" | "needsAction";
  attendees: number;
  /** Its colour slot (tokens.css `data-k`): its series' own in one of the user's calendars, else its calendar's. */
  k: string;
  /** Alfred may propose moving it: the user organizes it, in a calendar they may change. */
  editable: boolean;
  /** An invitation the user can answer. */
  invited: boolean;
  /** One time of an event that repeats: what names the repeating event, the same for all its times. (Not the
   * colour's "series", which is events of one title.) */
  recurring?: string;
}

/** One connected account's calendars, and how its last read went. */
export interface CalendarSource {
  account: string;
  syncedAt: string | null;
  error: string | null;
  /** The account must be connected again in Settings. */
  reconnect: boolean;
  /** The user let Alfred change this account's calendar (Settings: 日历：替你加和改). */
  canWrite: boolean;
  /** `varied`: one of the user's own, whose events are coloured series by series; the others are all `k`. */
  calendars: Array<{ id: string; name: string; k: string; writable: boolean; varied: boolean }>;
}

/** When an event is: a time span (instants) or whole days (local dates, the last one included). */
export type CalendarWhen = { start: string; end: string } | { date: string; endDate: string };

/** A change to the calendar that Google has not answered yet (typed in on the calendar page, or a proposal just
 * accepted). The page draws it already, marked as on its way; when Google answers it is an event like any other, or,
 * refused, it is gone and a notice says why. */
export interface CalendarPending {
  /** `<calendar id>:<event id>`: the event it changes, or the one it adds. */
  id: string;
  account: string;
  calendarId: string;
  added: boolean;
  /** What it sets; what is left out stays as it is. */
  title?: string;
  when?: CalendarWhen;
  location?: string;
  /** The colour it will have, when that is known before Google answers. */
  k?: string;
  /** It deletes the event: the page leaves it out already. */
  removed?: boolean;
}

export interface CalendarSnapshot {
  /** The home node's local date. */
  today: string;
  /** The days the mirror holds, inclusive: this month and the next, and a week on either side. Outside them nothing
   * is known. */
  from: string;
  to: string;
  /** Every event touching those days, by start. */
  events: CalendarEvent[];
  /** Changes on their way to Google, oldest first. */
  pending: CalendarPending[];
  /** Empty until a Google account with calendar access is connected. */
  sources: CalendarSource[];
}

/** The operations a device may ask of this module (POST /api/ops/<name>), as the module defines them. A test on the
 * home node checks this list against the module's own, so a device cannot name one that is not there. */
export const CALENDAR_OPS = ["calendar.add", "calendar.move", "calendar.respond", "calendar.retime", "calendar.create", "calendar.edit", "calendar.delete"] as const;
export type CalendarOp = (typeof CALENDAR_OPS)[number];
