/**
 * Reference in-memory OpenCal provider.
 *
 * Not production code. It exists to prove the interface is implementable,
 * to show how recurrence expansion and free/busy fit together, and to give
 * conformance tests something to run against.
 *
 * Recurrence support is deliberately limited to `daily` and `weekly` rules
 * (with `interval`, `count`, `until` and plain `byDay`). Anything else is
 * rejected with `unsupported`, as the spec requires, rather than silently
 * mis-expanded.
 */
import type {
  BusyPeriod,
  Calendar,
  Capabilities,
  CreateEventInput,
  DeleteEventInput,
  ErrorCode,
  Event,
  EventQuery,
  EventRecord,
  FreeBusyQuery,
  FreeBusyResult,
  Id,
  ListCalendarsOptions,
  LocalDateTime,
  MoveEventInput,
  OpenCalError,
  OpenCalProvider,
  Page,
  Participant,
  PatchObject,
  RecurrenceRule,
  RespondInput,
  UpdateEventInput,
  UTCDateTime,
  WriteOptions,
} from "../src/index.ts";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export class MemoryCalendarError extends Error implements OpenCalError {
  readonly "~opencal" = "calendar-error" as const;
  readonly retryable = false;
  readonly code: ErrorCode;
  readonly path?: string;
  constructor(code: ErrorCode, message: string, path?: string) {
    super(message);
    this.name = "MemoryCalendarError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

const fail = (code: ErrorCode, message: string, path?: string): never => {
  throw new MemoryCalendarError(code, message, path);
};

/* ------------------------------------------------------------------ */
/* Time helpers                                                        */
/* ------------------------------------------------------------------ */

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** Treat a LocalDateTime as if it were UTC, for calendar arithmetic. */
function naive(local: LocalDateTime): number {
  const m = LOCAL_RE.exec(local) ?? fail("invalid-input", `Bad LocalDateTime: ${local}`);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
}

function fromNaive(ms: number): LocalDateTime {
  return new Date(ms).toISOString().slice(0, 19);
}

/** Offset (ms) of `timeZone` from UTC at a given instant. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Wall-clock time in a zone → UTC epoch ms. Floating time is read as UTC. */
function toInstant(local: LocalDateTime, timeZone: string | null | undefined): number {
  const n = naive(local);
  if (!timeZone) return n;
  // Two passes handle DST boundaries well enough for a reference provider.
  let t = n - offsetAt(n, timeZone);
  t = n - offsetAt(t, timeZone);
  return t;
}

const DURATION_RE = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function durationMs(d: string | undefined): number {
  if (!d) return 0;
  const m = DURATION_RE.exec(d) ?? fail("invalid-input", `Bad Duration: ${d}`, "/duration");
  const [w, dd, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
  return ((((w! * 7 + dd!) * 24 + h!) * 60 + mi!) * 60 + s!) * 1000;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail("aborted", "Operation aborted");
}

const iso = (ms: number): UTCDateTime => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/* ------------------------------------------------------------------ */
/* Patch application (RFC 8984 §1.4.9, simplified)                     */
/* ------------------------------------------------------------------ */

function applyPatch<T extends object>(target: T, patch: PatchObject): T {
  const out = structuredClone(target) as Record<string, unknown>;
  for (const [rawPath, value] of Object.entries(patch)) {
    const keys = rawPath.split("/").map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
    let node = out;
    for (const k of keys.slice(0, -1)) {
      if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
    const last = keys.at(-1)!;
    if (value === null) delete node[last];
    else node[last] = structuredClone(value);
  }
  return out as T;
}

/* ------------------------------------------------------------------ */
/* Recurrence expansion (daily/weekly subset)                          */
/* ------------------------------------------------------------------ */

const DAY_INDEX = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 } as const;
const DAY_MS = 86_400_000;
const MAX_OCCURRENCES = 10_000;

function assertSupported(rule: RecurrenceRule): void {
  const supportedKeys = new Set(["@type", "frequency", "interval", "count", "until", "byDay", "firstDayOfWeek", "rscale"]);
  for (const k of Object.keys(rule)) {
    if (!supportedKeys.has(k)) fail("unsupported", `Memory provider does not support RecurrenceRule.${k}`);
  }
  if (rule.frequency !== "daily" && rule.frequency !== "weekly") {
    fail("unsupported", `Memory provider does not support frequency "${rule.frequency}"`);
  }
  if (rule.rscale && rule.rscale !== "gregorian") fail("unsupported", `rscale "${rule.rscale}"`);
  if (rule.byDay?.some((d) => d.nthOfPeriod !== undefined)) fail("unsupported", "byDay.nthOfPeriod");
  if (rule.count !== undefined && rule.until !== undefined) {
    fail("invalid-input", "count and until are mutually exclusive", "/recurrenceRules");
  }
}

/** Yields recurrence ids (LocalDateTime) in order, up to `limitNaive`. */
function* occurrenceStarts(event: Event, limitNaive: number): Generator<LocalDateTime> {
  const rules = event.recurrenceRules;
  if (!rules?.length) {
    yield event.start;
    return;
  }
  if (rules.length > 1) fail("unsupported", "Memory provider supports a single recurrence rule");
  const rule = rules[0]!;
  assertSupported(rule);

  const startN = naive(event.start);
  const interval = rule.interval ?? 1;
  const untilN = rule.until ? naive(rule.until) : Infinity;
  const timeOfDay = startN % DAY_MS;
  let emitted = 0;

  if (rule.frequency === "daily") {
    for (let t = startN; t <= untilN && t < limitNaive; t += interval * DAY_MS) {
      if (rule.count !== undefined && emitted >= rule.count) return;
      if (++emitted > MAX_OCCURRENCES) return;
      yield fromNaive(t);
    }
    return;
  }

  // weekly
  const weekStart = DAY_INDEX[rule.firstDayOfWeek ?? "mo"];
  const days = rule.byDay?.length
    ? [...new Set(rule.byDay.map((d) => DAY_INDEX[d.day]))]
    : [new Date(startN).getUTCDay()];
  const startDay = startN - timeOfDay;
  const dow = new Date(startDay).getUTCDay();
  const firstWeek = startDay - ((dow - weekStart + 7) % 7) * DAY_MS;
  const offsets = days.map((d) => ((d - weekStart + 7) % 7) * DAY_MS).sort((a, b) => a - b);

  for (let week = firstWeek; ; week += interval * 7 * DAY_MS) {
    for (const off of offsets) {
      const t = week + off + timeOfDay;
      if (t < startN) continue; // DTSTART is always the first instance
      if (t > untilN || t >= limitNaive) return;
      if (rule.count !== undefined && emitted >= rule.count) return;
      if (++emitted > MAX_OCCURRENCES) return;
      yield fromNaive(t);
    }
  }
}

/** Expand a stored event into concrete occurrences overlapping [after, before). */
function expand(event: Event, after: number, before: number): Event[] {
  const tz = event.timeZone ?? null;
  const dur = durationMs(event.duration);
  // Local times can be up to ~14h either side of UTC; pad the naive search bound.
  const limitNaive = before + 15 * 3_600_000;
  const out: Event[] = [];
  const isRecurring = !!event.recurrenceRules?.length;

  for (const recurrenceId of occurrenceStarts(event, limitNaive)) {
    const override = event.recurrenceOverrides?.[recurrenceId];
    if (override && override["excluded"] === true) continue;

    let occ: Event = isRecurring
      ? {
          ...event,
          recurrenceId,
          recurrenceIdTimeZone: tz,
          start: recurrenceId,
          recurrenceRules: undefined,
          excludedRecurrenceRules: undefined,
          recurrenceOverrides: undefined,
        }
      : event;
    if (override) occ = applyPatch(occ, override);

    const s = toInstant(occ.start, occ.timeZone ?? null);
    const e = s + durationMs(occ.duration ?? event.duration) ;
    // Zero-length events overlap if they start inside the window.
    if (e > after && s < before) out.push(stripUndefined(occ));
    else if (dur === 0 && s >= after && s < before) out.push(stripUndefined(occ));
  }
  return out;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/* ------------------------------------------------------------------ */
/* The provider                                                        */
/* ------------------------------------------------------------------ */

interface Stored {
  id: Id;
  calendarId: Id;
  etag: string;
  event: Event;
}

export interface MemoryProviderOptions {
  /** Calendar user address of the current user, used by `respond()`. */
  readonly self: string;
  readonly calendars?: readonly Omit<Calendar, "rights">[];
}

export class MemoryProvider implements OpenCalProvider {
  readonly "~opencal" = {
    version: 1,
    vendor: "memory",
    capabilities: {
      readOnly: false,
      recurrence: { expand: true, thisAndFollowing: false, rscales: ["gregorian"] },
      freeBusy: { ownCalendars: true, attendees: false },
      scheduling: { sendsMessages: false, respond: true },
      search: { text: true },
      move: true,
    } satisfies Capabilities,
  } as const;

  readonly #self: string;
  readonly #calendars = new Map<Id, Calendar>();
  readonly #events = new Map<Id, Stored>();
  #seq = 0;

  constructor(options: MemoryProviderOptions) {
    this.#self = options.self.toLowerCase();
    const cals = options.calendars ?? [{ id: "default", name: "Calendar", isDefault: true }];
    for (const c of cals) {
      this.#calendars.set(c.id, {
        includeInAvailability: true,
        ...c,
        rights: { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayRSVP: true, mayDelete: true },
      });
    }
  }

  /* ---------- calendars ---------- */

  async listCalendars(options?: ListCalendarsOptions): Promise<Page<Calendar>> {
    checkAbort(options?.signal);
    return paginate([...this.#calendars.values()], options?.cursor, options?.limit);
  }

  async getCalendar(id: Id): Promise<Calendar> {
    return this.#calendars.get(id) ?? fail("not-found", `Calendar ${id} not found`);
  }

  /* ---------- events ---------- */

  async queryEvents(q: EventQuery): Promise<Page<EventRecord>> {
    checkAbort(q.signal);
    if (q.expand && (!q.after || !q.before)) {
      fail("invalid-input", "expand requires both after and before", q.after ? "/before" : "/after");
    }
    const after = q.after ? Date.parse(q.after) : -Infinity;
    const before = q.before ? Date.parse(q.before) : Infinity;
    const calendarIds = q.calendarIds ? new Set(q.calendarIds) : null;
    const text = q.text?.toLowerCase();

    const results: EventRecord[] = [];
    for (const s of this.#events.values()) {
      if (calendarIds && !calendarIds.has(s.calendarId)) continue;
      if (q.uid && s.event.uid !== q.uid) continue;
      if (text && !matchesText(s.event, text)) continue;

      const finiteBefore = Number.isFinite(before) ? before : Date.now() + 366 * DAY_MS * 50;
      const occurrences = expand(s.event, after, finiteBefore);
      if (!occurrences.length) continue;

      if (q.expand) {
        for (const occ of occurrences) results.push({ id: s.id, calendarId: s.calendarId, etag: s.etag, event: occ });
      } else {
        results.push({ id: s.id, calendarId: s.calendarId, etag: s.etag, event: s.event });
      }
    }
    results.sort((a, b) =>
      toInstant(a.event.start, a.event.timeZone) - toInstant(b.event.start, b.event.timeZone),
    );
    return paginate(results, q.cursor, q.limit);
  }

  async getEvent(id: Id): Promise<EventRecord> {
    return { ...this.#get(id) };
  }

  async createEvent({ calendarId, event }: CreateEventInput, options?: WriteOptions): Promise<EventRecord> {
    checkAbort(options?.signal);
    await this.getCalendar(calendarId);
    if (event["@type"] !== "Event") fail("invalid-input", '@type must be "Event"', "/@type");
    const now = iso(Date.now());
    const full: Event = {
      ...event,
      uid: event.uid ?? crypto.randomUUID(),
      created: now,
      updated: now,
      sequence: 0,
    };
    validate(full);
    for (const s of this.#events.values()) {
      if (s.calendarId === calendarId && s.event.uid === full.uid) {
        fail("conflict", `An event with uid ${full.uid} already exists in ${calendarId}`, "/uid");
      }
    }
    const stored: Stored = { id: `evt_${++this.#seq}`, calendarId, etag: this.#etag(), event: full };
    this.#events.set(stored.id, stored);
    return { ...stored };
  }

  async updateEvent(input: UpdateEventInput, options?: WriteOptions): Promise<EventRecord> {
    checkAbort(options?.signal);
    const s = this.#get(input.id);
    this.#checkEtag(s, options);
    const scope = input.scope ?? "series";

    let next: Event;
    if (scope === "series") {
      next = applyPatch(s.event, input.patch);
    } else if (scope === "occurrence") {
      const rid = this.#requireRecurrenceId(s, input.recurrenceId);
      const existing = s.event.recurrenceOverrides?.[rid] ?? {};
      next = {
        ...s.event,
        recurrenceOverrides: { ...s.event.recurrenceOverrides, [rid]: { ...existing, ...input.patch } },
      };
    } else {
      return fail("unsupported", "thisAndFollowing is not supported by the memory provider");
    }

    // Identity is immutable.
    if (next.uid !== s.event.uid) fail("invalid-input", "uid cannot be changed", "/uid");
    next = { ...next, updated: iso(Date.now()), sequence: (s.event.sequence ?? 0) + 1 };
    validate(next);
    s.event = next;
    s.etag = this.#etag();
    return { ...s };
  }

  async deleteEvent(input: DeleteEventInput, options?: WriteOptions): Promise<void> {
    checkAbort(options?.signal);
    const s = this.#get(input.id);
    this.#checkEtag(s, options);
    const scope = input.scope ?? "series";
    if (scope === "series") {
      this.#events.delete(s.id);
      return;
    }
    if (scope === "occurrence") {
      const rid = this.#requireRecurrenceId(s, input.recurrenceId);
      s.event = {
        ...s.event,
        recurrenceOverrides: { ...s.event.recurrenceOverrides, [rid]: { excluded: true } },
        updated: iso(Date.now()),
        sequence: (s.event.sequence ?? 0) + 1,
      };
      s.etag = this.#etag();
      return;
    }
    fail("unsupported", "thisAndFollowing is not supported by the memory provider");
  }

  async moveEvent(input: MoveEventInput, options?: WriteOptions): Promise<EventRecord> {
    checkAbort(options?.signal);
    const s = this.#get(input.id);
    this.#checkEtag(s, options);
    await this.getCalendar(input.toCalendarId);
    s.calendarId = input.toCalendarId;
    s.etag = this.#etag();
    return { ...s };
  }

  /* ---------- availability ---------- */

  async queryFreeBusy(q: FreeBusyQuery): Promise<FreeBusyResult> {
    checkAbort(q.signal);
    const start = Date.parse(q.start);
    const end = Date.parse(q.end);
    if (!(end > start)) fail("invalid-input", "end must be after start", "/end");

    const results: Record<string, { busy: BusyPeriod[] } | { error: OpenCalError }> = {};
    for (const attendee of q.attendees ?? []) {
      results[attendee] = { error: new MemoryCalendarError("unsupported", "Attendee free/busy is not supported") };
    }

    const ids = q.calendarIds ?? (q.attendees ? [] : [...this.#calendars.values()].filter((c) => c.includeInAvailability !== false).map((c) => c.id));
    for (const calendarId of ids) {
      if (!this.#calendars.has(calendarId)) {
        results[calendarId] = { error: new MemoryCalendarError("not-found", `Calendar ${calendarId} not found`) };
        continue;
      }
      const periods: BusyPeriod[] = [];
      for (const s of this.#events.values()) {
        if (s.calendarId !== calendarId) continue;
        for (const occ of expand(s.event, start, end)) {
          if (occ.status === "cancelled") continue;
          if ((occ.freeBusyStatus ?? "busy") === "free") continue;
          const self = findSelf(occ.participants, this.#self);
          if (self?.participationStatus === "declined") continue;
          const os = toInstant(occ.start, occ.timeZone);
          const oe = os + durationMs(occ.duration);
          periods.push({
            start: iso(Math.max(os, start)),
            end: iso(Math.min(oe, end)),
            busyType: occ.status === "tentative" || self?.participationStatus === "tentative" ? "tentative" : "busy",
          });
        }
      }
      results[calendarId] = { busy: mergePeriods(periods) };
    }
    return { results };
  }

  /* ---------- scheduling ---------- */

  async respond(input: RespondInput, options?: WriteOptions): Promise<EventRecord> {
    const s = this.#get(input.id);
    const base = input.scope === "occurrence" && input.recurrenceId
      ? (expand(s.event, -Infinity, Infinity).find((e) => e.recurrenceId === input.recurrenceId)
          ?? fail("not-found", `No occurrence ${input.recurrenceId}`))
      : s.event;
    const entry = Object.entries(base.participants ?? {}).find(([, p]) => isSelf(p, this.#self));
    if (!entry) return fail("forbidden", "Current user is not a participant of this event");
    const [pid] = entry;
    const patch: Record<string, unknown> = {
      [`participants/${pid}/participationStatus`]: input.participationStatus,
      [`participants/${pid}/scheduleUpdated`]: iso(Date.now()),
    };
    if (input.comment !== undefined) patch[`participants/${pid}/participationComment`] = input.comment;
    return this.updateEvent({ id: input.id, scope: input.scope, recurrenceId: input.recurrenceId, patch }, options);
  }

  /* ---------- internals ---------- */

  #get(id: Id): Stored {
    return this.#events.get(id) ?? fail("not-found", `Event ${id} not found`);
  }

  #etag(): string {
    return `"${++this.#seq}"`;
  }

  #checkEtag(s: Stored, options?: WriteOptions): void {
    if (options?.ifMatch !== undefined && options.ifMatch !== s.etag) {
      fail("conflict", `etag mismatch: have ${s.etag}, got ${options.ifMatch}`);
    }
  }

  #requireRecurrenceId(s: Stored, rid: LocalDateTime | undefined): LocalDateTime {
    if (!s.event.recurrenceRules?.length) fail("invalid-input", "Event is not recurring", "/scope");
    if (!rid) return fail("invalid-input", "recurrenceId is required for this scope", "/recurrenceId");
    const exists = [...occurrenceStarts(s.event, naive(rid) + 1)].includes(rid);
    if (!exists) fail("not-found", `No occurrence with recurrenceId ${rid}`);
    return rid;
  }
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function validate(e: Event): void {
  naive(e.start);
  durationMs(e.duration);
  if (e.timeZone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: e.timeZone });
    } catch {
      fail("invalid-input", `Unknown time zone ${e.timeZone}`, "/timeZone");
    }
  }
  for (const r of e.recurrenceRules ?? []) assertSupported(r);
}

function paginate<T>(items: T[], cursor?: string, limit?: number): Page<T> {
  const start = cursor ? Number(cursor) : 0;
  if (!Number.isInteger(start) || start < 0) fail("invalid-input", "Bad cursor", "/cursor");
  const end = limit ? start + limit : items.length;
  const page = items.slice(start, end);
  return end < items.length ? { items: page, nextCursor: String(end) } : { items: page };
}

function matchesText(e: Event, needle: string): boolean {
  const hay = [
    e.title,
    e.description,
    ...Object.values(e.locations ?? {}).map((l) => l.name),
    ...Object.values(e.participants ?? {}).flatMap((p) => [p.name, p.email]),
  ];
  return hay.some((h) => h?.toLowerCase().includes(needle));
}

function isSelf(p: Participant, self: string): boolean {
  const addrs = [p.email, ...Object.values(p.sendTo ?? {})].filter(Boolean).map((a) => a!.toLowerCase());
  return addrs.includes(self) || addrs.includes(`mailto:${self}`);
}

function findSelf(ps: Event["participants"], self: string): Participant | undefined {
  return Object.values(ps ?? {}).find((p) => isSelf(p, self));
}

function mergePeriods(periods: BusyPeriod[]): BusyPeriod[] {
  const sorted = [...periods].sort((a, b) => a.start.localeCompare(b.start));
  const out: BusyPeriod[] = [];
  for (const p of sorted) {
    const last = out.at(-1);
    if (last && last.busyType === p.busyType && p.start <= last.end) {
      if (p.end > last.end) out[out.length - 1] = { ...last, end: p.end };
    } else {
      out.push(p);
    }
  }
  return out;
}
