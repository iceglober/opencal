/**
 * OpenCal — a provider-agnostic interface for calendar services.
 *
 * This package contains types only. It has no runtime code and no
 * dependencies. Providers (Google, Microsoft, CalDAV, JMAP, in-memory, …)
 * implement {@link OpenCalProvider}; applications program against it.
 *
 * The event data model is a profile of JSCalendar (RFC 8984). Property names
 * and value formats match the RFC so that events can be exchanged with any
 * JSCalendar or JMAP for Calendars implementation without translation.
 *
 * See SPEC.md for normative requirements.
 *
 * @packageDocumentation
 */

/* ------------------------------------------------------------------------ */
/* Primitive value types (RFC 8984 §1.4)                                    */
/* ------------------------------------------------------------------------ */

/** Opaque identifier. 1–255 octets of `A-Za-z0-9-_`. */
export type Id = string;

/** `YYYY-MM-DDTHH:MM:SS(.sss)Z` — a UTC instant. */
export type UTCDateTime = string;

/** `YYYY-MM-DDTHH:MM:SS(.sss)` — wall-clock time with no offset. */
export type LocalDateTime = string;

/** ISO 8601 duration restricted per RFC 8984 §1.4.6, e.g. `PT1H30M`, `P1D`. */
export type Duration = string;

/** ISO 8601 duration that may be negative, e.g. `-PT15M`. */
export type SignedDuration = string;

/** IANA time zone name, e.g. `America/Los_Angeles`. `null` means floating time. */
export type TimeZoneId = string;

/** A URI such as `mailto:ada@example.com` or `https://meet.example.com/abc`. */
export type URI = string;

/** RFC 8984 PatchObject: JSON-pointer-ish paths mapped to new values (`null` deletes). */
export type PatchObject = { readonly [path: string]: unknown };

/** Vendor extension properties. Keys SHOULD be namespaced, e.g. `example.com:foo`. */
export type Extensions = { readonly [vendorProperty: `${string}:${string}`]: unknown };

/* ------------------------------------------------------------------------ */
/* JSCalendar Event profile                                                 */
/* ------------------------------------------------------------------------ */

export type EventStatus = "confirmed" | "cancelled" | "tentative";
export type FreeBusyStatus = "free" | "busy";
export type Privacy = "public" | "private" | "secret";

export type DayOfWeek = "mo" | "tu" | "we" | "th" | "fr" | "sa" | "su";

/** RFC 8984 §4.3.3 NDay. */
export interface NDay {
  readonly "@type"?: "NDay";
  readonly day: DayOfWeek;
  /** e.g. `-1` for "last" in a monthly rule. */
  readonly nthOfPeriod?: number;
}

/** RFC 8984 §4.3.3 RecurrenceRule (equivalent to iCalendar RRULE). */
export interface RecurrenceRule {
  readonly "@type"?: "RecurrenceRule";
  readonly frequency:
    | "yearly"
    | "monthly"
    | "weekly"
    | "daily"
    | "hourly"
    | "minutely"
    | "secondly";
  readonly interval?: number;
  /** Calendar system, default `gregorian` (RFC 7529). */
  readonly rscale?: string;
  readonly skip?: "omit" | "backward" | "forward";
  readonly firstDayOfWeek?: DayOfWeek;
  readonly byDay?: readonly NDay[];
  readonly byMonthDay?: readonly number[];
  /** Month numbers as strings; `"5L"` is a leap month in some rscales. */
  readonly byMonth?: readonly string[];
  readonly byYearDay?: readonly number[];
  readonly byWeekNo?: readonly number[];
  readonly byHour?: readonly number[];
  readonly byMinute?: readonly number[];
  readonly bySecond?: readonly number[];
  readonly bySetPosition?: readonly number[];
  /** Mutually exclusive with `until`. */
  readonly count?: number;
  /** Interpreted in the event's time zone. Mutually exclusive with `count`. */
  readonly until?: LocalDateTime;
}

export type ParticipantKind = "individual" | "group" | "location" | "resource";

export type ParticipantRole =
  | "owner"
  | "attendee"
  | "optional"
  | "informational"
  | "chair"
  | "contact";

export type ParticipationStatus =
  | "needs-action"
  | "accepted"
  | "declined"
  | "tentative"
  | "delegated";

/** RFC 8984 §4.4.6 Participant (subset). */
export interface Participant {
  readonly "@type"?: "Participant";
  readonly name?: string;
  readonly email?: string;
  readonly description?: string;
  /** Delivery addresses keyed by method, usually `{ imip: "mailto:…" }`. */
  readonly sendTo?: { readonly [method: string]: URI };
  readonly kind?: ParticipantKind;
  /** Set of roles, e.g. `{ attendee: true, optional: true }`. */
  readonly roles?: { readonly [R in ParticipantRole]?: true } & {
    readonly [vendorRole: string]: true | undefined;
  };
  readonly participationStatus?: ParticipationStatus;
  readonly participationComment?: string;
  readonly expectReply?: boolean;
  /** Who sends scheduling messages for this participant. Default `server`. */
  readonly scheduleAgent?: "server" | "client" | "none";
  readonly scheduleSequence?: number;
  readonly scheduleUpdated?: UTCDateTime;
  readonly delegatedTo?: { readonly [participantId: Id]: true };
  readonly delegatedFrom?: { readonly [participantId: Id]: true };
  readonly memberOf?: { readonly [participantId: Id]: true };
}

/** RFC 8984 §4.2.5 Location. */
export interface Location {
  readonly "@type"?: "Location";
  readonly name?: string;
  readonly description?: string;
  readonly timeZone?: TimeZoneId;
  /** `geo:` URI (RFC 5870). */
  readonly coordinates?: URI;
  readonly locationTypes?: { readonly [type: string]: true };
}

/** RFC 8984 §4.2.6 VirtualLocation. */
export interface VirtualLocation {
  readonly "@type"?: "VirtualLocation";
  readonly name?: string;
  readonly description?: string;
  readonly uri: URI;
  readonly features?: {
    readonly [F in "audio" | "chat" | "feed" | "moderator" | "phone" | "screen" | "video"]?: true;
  };
}

export interface OffsetTrigger {
  readonly "@type": "OffsetTrigger";
  readonly offset: SignedDuration;
  readonly relativeTo?: "start" | "end";
}

export interface AbsoluteTrigger {
  readonly "@type": "AbsoluteTrigger";
  readonly when: UTCDateTime;
}

/** RFC 8984 §4.5.2 Alert (subset). */
export interface Alert {
  readonly "@type"?: "Alert";
  readonly trigger: OffsetTrigger | AbsoluteTrigger;
  readonly action?: "display" | "email";
}

/**
 * A calendar event, as a JSCalendar (RFC 8984) Event object.
 *
 * This is the portable payload. Provider bookkeeping (id, calendarId, etag)
 * lives in {@link EventRecord}, never inside the event.
 */
export interface Event extends Extensions {
  readonly "@type": "Event";

  /* Identity & metadata */
  /** Globally unique, stable across providers (iCalendar UID). */
  readonly uid: string;
  readonly created?: UTCDateTime;
  readonly updated?: UTCDateTime;
  readonly sequence?: number;
  readonly prodId?: string;

  /* What */
  readonly title?: string;
  readonly description?: string;
  readonly descriptionContentType?: string;
  readonly locale?: string;
  readonly keywords?: { readonly [keyword: string]: true };
  readonly categories?: { readonly [uri: string]: true };
  readonly color?: string;

  /* When */
  /** Wall-clock start, interpreted in `timeZone`. */
  readonly start: LocalDateTime;
  /** `null` or absent means floating time. */
  readonly timeZone?: TimeZoneId | null;
  /** Default `PT0S`. */
  readonly duration?: Duration;
  /** All-day / date-only events. */
  readonly showWithoutTime?: boolean;

  /* Recurrence */
  readonly recurrenceRules?: readonly RecurrenceRule[];
  readonly excludedRecurrenceRules?: readonly RecurrenceRule[];
  /** Keyed by the original occurrence's start (LocalDateTime in `timeZone`). */
  readonly recurrenceOverrides?: { readonly [recurrenceId: LocalDateTime]: PatchObject };
  /** Set on expanded occurrences: which occurrence of the series this is. */
  readonly recurrenceId?: LocalDateTime;
  readonly recurrenceIdTimeZone?: TimeZoneId | null;
  /** In an override, `true` removes that occurrence. */
  readonly excluded?: boolean;

  /* Where */
  readonly locations?: { readonly [id: Id]: Location };
  readonly virtualLocations?: { readonly [id: Id]: VirtualLocation };

  /* Who */
  readonly participants?: { readonly [id: Id]: Participant };
  /** Where replies go, usually `{ imip: "mailto:organizer@…" }`. */
  readonly replyTo?: { readonly [method: string]: URI };

  /* How it shows */
  readonly status?: EventStatus;
  readonly freeBusyStatus?: FreeBusyStatus;
  readonly privacy?: Privacy;
  readonly priority?: number;

  /* Reminders */
  readonly useDefaultAlerts?: boolean;
  readonly alerts?: { readonly [id: Id]: Alert };
}

/** An event to create. `uid` is optional; the provider generates one if absent. */
export type EventInput = Omit<Event, "uid" | "created" | "updated" | "sequence"> & {
  readonly uid?: string;
};

/* ------------------------------------------------------------------------ */
/* Provider envelope types                                                  */
/* ------------------------------------------------------------------------ */

/** A calendar (collection of events) as exposed by a provider. */
export interface Calendar {
  readonly id: Id;
  readonly name: string;
  readonly description?: string;
  readonly color?: string;
  /** Default time zone for new events and floating-time display. */
  readonly timeZone?: TimeZoneId;
  readonly isDefault?: boolean;
  /** Whether events in this calendar count toward free/busy. */
  readonly includeInAvailability?: boolean;
  readonly rights: CalendarRights;
}

export interface CalendarRights {
  readonly mayReadFreeBusy: boolean;
  readonly mayReadItems: boolean;
  readonly mayWriteAll: boolean;
  /** May change own participation status on events in this calendar. */
  readonly mayRSVP: boolean;
  readonly mayDelete: boolean;
}

/** A stored event plus the provider bookkeeping needed to address it. */
export interface EventRecord {
  /** Provider-assigned id, unique within the provider. Not the same as `event.uid`. */
  readonly id: Id;
  readonly calendarId: Id;
  /** Opaque version token for optimistic concurrency. */
  readonly etag?: string;
  readonly event: Event;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Absent when there are no more results. */
  readonly nextCursor?: string;
}

/* ------------------------------------------------------------------------ */
/* Operation inputs                                                         */
/* ------------------------------------------------------------------------ */

export interface ListCalendarsOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface EventQuery {
  /** Calendars to search. Omitted means all calendars the caller can read. */
  readonly calendarIds?: readonly Id[];
  /** Only events (or occurrences) ending after this instant. */
  readonly after?: UTCDateTime;
  /** Only events (or occurrences) starting before this instant. */
  readonly before?: UTCDateTime;
  /**
   * `true`: return one record per occurrence in [after, before), each with
   * `recurrenceId` set and no `recurrenceRules`. Requires both bounds.
   * `false` (default): return series masters with rules and overrides intact.
   */
  readonly expand?: boolean;
  /** Free-text match against title, description, location and participants. */
  readonly text?: string;
  readonly uid?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/** Which recurring-event instances a write applies to. */
export type RecurrenceScope =
  /** One occurrence, identified by `recurrenceId`. Stored as an override. */
  | "occurrence"
  /** That occurrence and all later ones. Requires `capabilities.recurrence.thisAndFollowing`. */
  | "thisAndFollowing"
  /** The entire series (the default). */
  | "series";

export interface WriteOptions {
  /** Fail with `conflict` unless the stored etag matches. */
  readonly ifMatch?: string;
  /**
   * Send iTIP scheduling messages (invites, updates, cancellations) to
   * participants. Default `true` when the provider supports scheduling.
   */
  readonly sendSchedulingMessages?: boolean;
  readonly signal?: AbortSignal;
}

export interface OccurrenceTarget {
  readonly scope?: RecurrenceScope;
  /** Required when `scope` is `occurrence` or `thisAndFollowing`. */
  readonly recurrenceId?: LocalDateTime;
}

export interface CreateEventInput {
  readonly calendarId: Id;
  readonly event: EventInput;
}

export interface UpdateEventInput extends OccurrenceTarget {
  readonly id: Id;
  /** RFC 8984 PatchObject applied to the event (or occurrence). */
  readonly patch: PatchObject;
}

export interface DeleteEventInput extends OccurrenceTarget {
  readonly id: Id;
}

export interface MoveEventInput {
  readonly id: Id;
  readonly toCalendarId: Id;
}

export interface RespondInput extends OccurrenceTarget {
  readonly id: Id;
  readonly participationStatus: Exclude<ParticipationStatus, "needs-action" | "delegated">;
  readonly comment?: string;
}

export interface FreeBusyQuery {
  readonly start: UTCDateTime;
  readonly end: UTCDateTime;
  /** The caller's own calendars to include. */
  readonly calendarIds?: readonly Id[];
  /** Other people/resources, as calendar user addresses (e.g. `mailto:`). */
  readonly attendees?: readonly URI[];
  readonly signal?: AbortSignal;
}

export type BusyType = "busy" | "tentative" | "unavailable";

export interface BusyPeriod {
  readonly start: UTCDateTime;
  readonly end: UTCDateTime;
  readonly busyType: BusyType;
}

export interface FreeBusyResult {
  /** Keyed by calendar id (own calendars) or attendee URI. */
  readonly results: {
    readonly [calendarIdOrAttendee: string]:
      | { readonly busy: readonly BusyPeriod[] }
      | { readonly error: OpenCalError };
  };
}

/* ------------------------------------------------------------------------ */
/* Capabilities                                                             */
/* ------------------------------------------------------------------------ */

export interface Capabilities {
  /** Provider cannot create, update or delete anything. */
  readonly readOnly: boolean;
  readonly recurrence: {
    /** Server can expand series into occurrences (`EventQuery.expand`). */
    readonly expand: boolean;
    /** Supports `RecurrenceScope` `thisAndFollowing`. */
    readonly thisAndFollowing: boolean;
    /** Calendar systems accepted in `RecurrenceRule.rscale`. Always includes `gregorian`. */
    readonly rscales: readonly string[];
  };
  readonly freeBusy: {
    readonly ownCalendars: boolean;
    readonly attendees: boolean;
  };
  readonly scheduling: {
    /** Provider sends invites/updates/cancellations to participants. */
    readonly sendsMessages: boolean;
    /** `respond()` is implemented. */
    readonly respond: boolean;
  };
  readonly search: {
    readonly text: boolean;
  };
  readonly move: boolean;
  /** Vendor-specific capabilities, namespaced. */
  readonly extensions?: Extensions;
}

/* ------------------------------------------------------------------------ */
/* Errors                                                                   */
/* ------------------------------------------------------------------------ */

export type ErrorCode =
  | "not-found"
  | "conflict"
  | "forbidden"
  | "unauthenticated"
  | "invalid-input"
  | "unsupported"
  | "rate-limited"
  | "unavailable"
  | "aborted"
  | "unknown";

/**
 * Shape of every error a provider rejects with. Providers may throw a
 * subclass of `Error` as long as it carries these properties.
 */
export interface OpenCalError {
  readonly "~opencal": "calendar-error";
  readonly code: ErrorCode;
  readonly message: string;
  /** Safe to retry the same call unchanged. */
  readonly retryable: boolean;
  /** For `rate-limited`: suggested wait in milliseconds. */
  readonly retryAfterMs?: number;
  /** For `invalid-input`: JSON pointer to the offending property. */
  readonly path?: string;
  /** The underlying provider error, for debugging. */
  readonly cause?: unknown;
}

/* ------------------------------------------------------------------------ */
/* The provider interface                                                   */
/* ------------------------------------------------------------------------ */

export interface OpenCalProps {
  /** Spec major version this provider implements. */
  readonly version: 1;
  /** Provider name, e.g. `google`, `microsoft`, `caldav`, `memory`. */
  readonly vendor: string;
  readonly capabilities: Capabilities;
}

/**
 * The interface every OpenCal provider implements.
 *
 * Methods whose capability is `false` MUST reject with code `unsupported`.
 * All methods MUST reject with a {@link OpenCalError}.
 */
export interface OpenCalProvider {
  readonly "~opencal": OpenCalProps;

  /* Calendars */
  listCalendars(options?: ListCalendarsOptions): Promise<Page<Calendar>>;
  getCalendar(id: Id, options?: { signal?: AbortSignal }): Promise<Calendar>;

  /* Events */
  queryEvents(query: EventQuery): Promise<Page<EventRecord>>;
  getEvent(id: Id, options?: { signal?: AbortSignal }): Promise<EventRecord>;
  createEvent(input: CreateEventInput, options?: WriteOptions): Promise<EventRecord>;
  updateEvent(input: UpdateEventInput, options?: WriteOptions): Promise<EventRecord>;
  deleteEvent(input: DeleteEventInput, options?: WriteOptions): Promise<void>;
  moveEvent(input: MoveEventInput, options?: WriteOptions): Promise<EventRecord>;

  /* Availability */
  queryFreeBusy(query: FreeBusyQuery): Promise<FreeBusyResult>;

  /* Scheduling */
  respond(input: RespondInput, options?: WriteOptions): Promise<EventRecord>;
}

/* ------------------------------------------------------------------------ */
/* Helper types                                                             */
/* ------------------------------------------------------------------------ */

/** The literal vendor name of a provider type. */
export type InferVendor<P extends OpenCalProvider> = P["~opencal"]["vendor"];
