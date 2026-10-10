# OpenCal Specification

**Version:** 1.0.0-draft.1
**Status:** Draft
**Date:** 2026-10-10

OpenCal defines a provider-agnostic interface for reading and writing calendars, querying availability, and responding to invitations. Applications program against one interface; providers adapt it to Google Calendar, Microsoft 365, CalDAV, JMAP, or anything else.

OpenCal does not invent a new event format. Events are JSCalendar objects ([RFC 8984]), so data moves between OpenCal, JMAP for Calendars, and iCalendar converters without lossy translation.

The TypeScript definitions in [`src/index.ts`](./src/index.ts) are the reference binding of this document. Where prose and types disagree, this document is normative and the types are a bug.

---

## 1. Goals and non-goals

**Goals**

1. One interface for the operations nearly every calendar integration needs: list calendars; query, create, update, move and delete events (including recurring ones); query free/busy; respond to invitations.
2. A portable event payload with a published, versioned standard behind it.
3. Honest capability reporting. A provider that can't do something says so up front and fails predictably, instead of silently approximating.
4. Implementable without depending on any library. A provider needs no runtime import from this package, the same model as Standard Schema.

**Non-goals for v1**

- Authentication and account discovery. Providers are constructed already authenticated.
- Incremental sync, change feeds and push notifications. Planned for v1.x as an optional capability.
- Tasks (`VTODO`), journals, contacts and calendar sharing/ACL management.
- Defining a wire protocol. OpenCal is an in-process interface. CalDAV and JMAP are the wire protocols.

## 2. Conventions

The key words MUST, MUST NOT, REQUIRED, SHALL, SHOULD, SHOULD NOT, RECOMMENDED, MAY and OPTIONAL are to be interpreted as described in [RFC 2119] and [RFC 8174] when, and only when, they appear in all capitals.

- **Provider**: an object implementing the interface in §4.
- **Consumer**: code calling a provider.
- **Series master**: a stored event with one or more `recurrenceRules`.
- **Occurrence**: one instance of a series, identified by its `recurrenceId`.
- **Calendar user address**: a URI identifying a person or resource for scheduling, normally `mailto:`.

Primitive formats (`UTCDateTime`, `LocalDateTime`, `Duration`, `SignedDuration`, `Id`, `PatchObject`) are exactly as defined in RFC 8984 §1.4. Time zone identifiers are IANA tzdb names.

## 3. Data model

### 3.1 Events are JSCalendar

An `Event` is a JSCalendar Event object (RFC 8984 §5.1). OpenCal defines a *profile*: a subset every provider MUST understand, plus rules for everything else.

Every provider MUST support reading and writing these properties:

| Group | Properties |
|---|---|
| Identity | `@type`, `uid`, `created`, `updated`, `sequence` |
| Content | `title`, `description`, `locale`, `keywords`, `color` |
| Time | `start`, `timeZone`, `duration`, `showWithoutTime` |
| Recurrence | `recurrenceRules`, `recurrenceOverrides`, `recurrenceId`, `recurrenceIdTimeZone`, `excluded` |
| Place | `locations`, `virtualLocations` |
| People | `participants`, `replyTo` |
| Display | `status`, `freeBusyStatus`, `privacy` |
| Alerts | `alerts`, `useDefaultAlerts` |

Providers SHOULD support every other RFC 8984 Event property they can represent. Missing properties take the RFC 8984 defaults. In particular, `freeBusyStatus` defaults to `"busy"`, `status` to `"confirmed"`, `duration` to `"PT0S"` and `privacy` to `"public"`.

### 3.2 Unknown and unsupported properties

When a consumer writes a property the provider cannot store:

- If the property is in the §3.1 table, the provider MUST reject the write with `invalid-input` or `unsupported`.
- If the property is any other RFC 8984 property or a vendor extension, the provider SHOULD store it. If it cannot, it MAY drop it but MUST NOT reject the write for that reason.

Providers MUST preserve, unchanged, every property they returned when a consumer writes an event back (read-modify-write MUST be lossless for anything the provider itself produced).

Vendor-specific data goes in namespaced properties per RFC 8984 §3.3, e.g. `"google.com:conferenceData"`. Providers SHOULD expose provider-only fields this way rather than dropping them.

### 3.3 Event identity: `uid` vs `id`

These are different and both are required.

- `event.uid` is the globally unique, cross-provider identifier (iCalendar `UID`). It MUST NOT change after creation. Two copies of the same meeting in two people's calendars share a `uid`.
- `EventRecord.id` is the provider's handle for one stored event in one calendar. Consumers use it to address `get`, `update`, `delete`, `move` and `respond` calls. It MUST be stable for the life of the stored event, including across `moveEvent` unless the provider documents otherwise.

Within one calendar, `uid` MUST be unique among series masters. Providers MUST reject a `createEvent` that would duplicate a `uid` within the same calendar with `conflict`.

When creating, consumers MAY omit `uid`. The provider then MUST generate one. Providers MUST set `created`, `updated` and `sequence` themselves and MUST ignore consumer-supplied values for them.

### 3.4 Envelope types

The event payload never carries provider bookkeeping. Instead, providers return:

- **`EventRecord`**: `{ id, calendarId, etag?, event }`.
- **`Calendar`**: `{ id, name, description?, color?, timeZone?, isDefault?, includeInAvailability?, rights }`, where `rights` reports `mayReadFreeBusy`, `mayReadItems`, `mayWriteAll`, `mayRSVP` and `mayDelete` (names follow JMAP for Calendars).
- **`Page<T>`**: `{ items, nextCursor? }`.

## 4. The provider object

A provider is any object with a `"~opencal"` property and the methods in §5. Consumers MUST detect providers structurally by that property, not by `instanceof`.

```ts
provider["~opencal"] = {
  version: 1,              // spec major version
  vendor: "google",        // short provider name
  capabilities: { ... },   // §4.1
};
```

The tilde prefix keeps the property out of autocomplete and away from collisions, following Standard Schema.

### 4.1 Capabilities

| Capability | Meaning when `true` |
|---|---|
| `readOnly` | All write methods reject with `unsupported` (inverted sense). |
| `recurrence.expand` | `queryEvents({ expand: true })` works. |
| `recurrence.thisAndFollowing` | `scope: "thisAndFollowing"` works for update and delete. |
| `recurrence.rscales` | Calendar systems accepted in `rscale`. MUST include `"gregorian"`. |
| `freeBusy.ownCalendars` | `queryFreeBusy` works for the caller's calendars. |
| `freeBusy.attendees` | `queryFreeBusy` works for other calendar user addresses. |
| `scheduling.sendsMessages` | The provider delivers invitations, updates and cancellations to participants. |
| `scheduling.respond` | `respond()` works. |
| `search.text` | `EventQuery.text` is honored. |
| `move` | `moveEvent()` works. |
| `extensions` | Namespaced vendor capabilities. |

Capabilities MUST NOT change during the lifetime of a provider object. When a method or option depends on a capability that is `false`, the provider MUST reject with `unsupported` rather than approximate. For example, a provider without `search.text` MUST NOT ignore `text` and return unfiltered results.

## 5. Operations

All methods are asynchronous and MUST reject only with an `OpenCalError` (§9). All options objects accept an `AbortSignal` (§10).

### 5.1 `listCalendars(options?)` → `Page<Calendar>`

Returns calendars the caller can see. Paginated (§11).

### 5.2 `getCalendar(id)` → `Calendar`

Rejects with `not-found` if no such calendar is visible.

### 5.3 `queryEvents(query)` → `Page<EventRecord>`

| Field | Meaning |
|---|---|
| `calendarIds` | Restrict to these calendars. Absent means all readable calendars. |
| `after` | Only events or occurrences whose end is after this instant. |
| `before` | Only events or occurrences whose start is before this instant. |
| `expand` | See below. Default `false`. |
| `text` | Case-insensitive substring match over title, description, location names and participant names/emails. Requires `search.text`. |
| `uid` | Exact match on `event.uid`. |
| `cursor`, `limit` | Pagination. |

The time window is half-open: `[after, before)`. An event with zero duration overlaps when `after <= start < before`.

**Without `expand`** the provider returns stored events (series masters and single events), each once, with recurrence rules and overrides intact. A series master MUST be included if at least one of its occurrences overlaps the window, and SHOULD NOT be included otherwise.

**With `expand: true`** both `after` and `before` are REQUIRED; otherwise the provider MUST reject with `invalid-input`. The provider returns one `EventRecord` per overlapping occurrence. Each occurrence's `event`:

- MUST have `recurrenceId` set (and `recurrenceIdTimeZone` matching the master's `timeZone`) if it came from a series;
- MUST NOT contain `recurrenceRules`, `excludedRecurrenceRules` or `recurrenceOverrides`;
- MUST have any override for that `recurrenceId` already applied;
- MUST share the master's `id` and `etag` in its `EventRecord`.

Excluded occurrences MUST NOT be returned.

Results SHOULD be ordered by start instant ascending.

### 5.4 `getEvent(id)` → `EventRecord`

Returns the stored event (series master for a recurring event), unexpanded.

### 5.5 `createEvent({ calendarId, event }, options?)` → `EventRecord`

Creates an event. `event["@type"]` MUST be `"Event"`. See §3.3 for `uid` and server-set fields. If the event has participants and `sendSchedulingMessages` is not `false`, the provider sends invitations per §8.

### 5.6 `updateEvent({ id, patch, scope?, recurrenceId? }, options?)` → `EventRecord`

Applies an RFC 8984 PatchObject. `scope` selects what the patch applies to (§6.2). The provider MUST increment `sequence` when the change is significant per RFC 5546 §2.1.4 (time, recurrence or location changes), and MAY increment it on any change. A patch that changes `uid` MUST be rejected with `invalid-input`.

### 5.7 `deleteEvent({ id, scope?, recurrenceId? }, options?)` → `void`

Deletes the event, or the occurrences selected by `scope` (§6.2). Deleting an event with participants sends cancellations per §8.

### 5.8 `moveEvent({ id, toCalendarId }, options?)` → `EventRecord`

Moves a stored event between calendars of the same provider. Requires `move`.

### 5.9 `queryFreeBusy(query)` → `FreeBusyResult`

See §7.

### 5.10 `respond({ id, participationStatus, comment?, scope?, recurrenceId? }, options?)` → `EventRecord`

See §8.2.

## 6. Recurrence

### 6.1 Model

Recurrence is JSCalendar recurrence, which maps one-to-one to iCalendar `RRULE`/`EXDATE`/`RECURRENCE-ID` (RFC 8984 §4.3). Occurrences are generated in the event's `timeZone`, so a 09:00 weekly meeting stays at 09:00 local time across DST transitions. The first occurrence is always `start`, whether or not it matches the rules.

A `recurrenceId` is the occurrence's *original* start as a `LocalDateTime` in the master's time zone. It does not change when that occurrence is rescheduled.

Providers MUST either expand every rule they accept correctly or reject the rule with `unsupported` on write. Accepting a rule and expanding it incorrectly is non-conformant.

### 6.2 Scopes

| `scope` | Effect |
|---|---|
| `"series"` (default) | Patch or delete the master. Existing overrides are kept unless the patch changes them. |
| `"occurrence"` | Requires `recurrenceId`. Update stores the patch in `recurrenceOverrides[recurrenceId]` (merging with any existing override). Delete stores `{ excluded: true }`. |
| `"thisAndFollowing"` | Requires `recurrenceId` and `recurrence.thisAndFollowing`. Ends the original series before `recurrenceId` and creates a new series from that point with the patch applied. The new series MUST get a new `uid`. |

For `"occurrence"` and `"thisAndFollowing"`, the provider MUST reject with `invalid-input` if the event is not recurring or `recurrenceId` is missing, and with `not-found` if `recurrenceId` is not an occurrence of the series.

Patch paths in an occurrence-scoped update are relative to the occurrence, e.g. `{ "start": "2026-10-13T15:00:00" }`, not prefixed with `recurrenceOverrides/…`.

## 7. Free/busy

`queryFreeBusy({ start, end, calendarIds?, attendees? })`:

- `start`/`end` are UTC instants; `end` MUST be after `start`.
- `calendarIds` lists the caller's own calendars (requires `freeBusy.ownCalendars`). If both `calendarIds` and `attendees` are absent, the provider uses every calendar with `includeInAvailability !== false`.
- `attendees` lists calendar user addresses (requires `freeBusy.attendees`).

The result maps each requested calendar id or attendee address to either `{ busy: BusyPeriod[] }` or `{ error: OpenCalError }`. One failing entry MUST NOT fail the whole call. If the provider lacks the capability for a whole category, those entries report `unsupported`.

For the caller's own calendars, an occurrence contributes busy time unless any of these hold:

- `status` is `"cancelled"`;
- `freeBusyStatus` is `"free"`;
- the calendar's owner is a participant whose `participationStatus` is `"declined"`.

`busyType` is `"tentative"` when the event `status` is `"tentative"` or the owner's `participationStatus` is `"tentative"`, otherwise `"busy"`. `"unavailable"` is for out-of-office or working-hours data where the backend exposes it.

Busy periods MUST be clipped to `[start, end)`, sorted ascending, and SHOULD merge adjacent or overlapping periods of the same `busyType`. Free/busy results MUST NOT reveal event details.

## 8. Scheduling

### 8.1 Sending messages

Scheduling follows the semantics of iTIP ([RFC 5546]) regardless of the transport the backend uses (iMIP email, CalDAV scheduling, Exchange, Google).

When `scheduling.sendsMessages` is `true` and `WriteOptions.sendSchedulingMessages` is not `false`:

- creating an event with participants sends a REQUEST to each participant whose `scheduleAgent` is `"server"` (the default);
- a significant update sends a REQUEST with an incremented `sequence`;
- deleting the event, or setting `status: "cancelled"`, sends a CANCEL;
- removing a participant sends that participant a CANCEL.

When `sendSchedulingMessages` is `false`, the provider MUST NOT send anything. When `scheduling.sendsMessages` is `false`, the provider never sends messages, and the consumer is responsible (for example, by generating iMIP itself).

The organizer is the participant with role `owner`. Writes by a non-organizer to fields other than their own participant entry SHOULD be rejected with `forbidden` unless the backend allows it.

### 8.2 Responding

`respond()` sets the *caller's* own `participationStatus` (`accepted`, `declined` or `tentative`) and optional `participationComment`, then sends a REPLY to the organizer when messages are enabled. The provider identifies the caller's participant entry by matching its account addresses against `email` and `sendTo`. If the caller is not a participant, the provider MUST reject with `forbidden`.

`scope: "occurrence"` with a `recurrenceId` responds to one occurrence. The default responds to the whole series.

## 9. Errors

Every rejection MUST be an object with:

| Field | Type | |
|---|---|---|
| `~opencal` | `"calendar-error"` | Marker for structural detection. |
| `code` | `ErrorCode` | Below. |
| `message` | `string` | Human-readable. |
| `retryable` | `boolean` | Safe to retry the identical call. |
| `retryAfterMs` | `number?` | For `rate-limited`. |
| `path` | `string?` | For `invalid-input`: JSON pointer to the offending input. |
| `cause` | `unknown?` | Underlying backend error. |

Providers SHOULD throw an `Error` subclass carrying these fields, so stack traces survive.

| `code` | Use |
|---|---|
| `not-found` | Calendar, event or occurrence doesn't exist or isn't visible. |
| `conflict` | `ifMatch` mismatch, or duplicate `uid`. |
| `forbidden` | Authenticated but not allowed. |
| `unauthenticated` | Credentials missing, expired or revoked. |
| `invalid-input` | Malformed input or violated constraint. |
| `unsupported` | Valid input the provider can't honor (§4.1). |
| `rate-limited` | Backend throttling. `retryable: true`. |
| `unavailable` | Backend down or timing out. `retryable: true`. |
| `aborted` | The `AbortSignal` fired. |
| `unknown` | Anything else. |

## 10. Cancellation and concurrency

- If an `AbortSignal` is already aborted or fires during the call, the provider SHOULD stop work and reject with `aborted`. A write that was already committed is not rolled back.
- If an `EventRecord` has an `etag`, it MUST change on every modification of the stored event. With `WriteOptions.ifMatch`, the provider MUST reject with `conflict` when the stored etag differs. Providers whose backend has no versioning MAY omit `etag`; they MUST then reject any `ifMatch` with `unsupported`.

## 11. Pagination

List methods accept `cursor` and `limit` and return `{ items, nextCursor? }`. `nextCursor` is absent on the last page. Cursors are opaque, MUST be passed back unchanged with otherwise identical arguments, and MAY expire (reject with `invalid-input`, path `/cursor`). `limit` is a maximum; providers MAY return fewer items, including zero, on a non-final page.

## 12. Mapping guidance (informative)

| OpenCal | Google Calendar API | Microsoft Graph | CalDAV |
|---|---|---|---|
| `event.uid` | `iCalUID` | `iCalUId` | `UID` |
| `EventRecord.id` | event `id` | event `id` | resource href |
| `etag` | `etag` | `@odata.etag` / `changeKey` | `ETag` |
| `queryEvents({ expand: true })` | `singleEvents=true` | `calendarView` | `calendar-query` with `expand` |
| Occurrence override | exception instance | `exception` occurrence | `VEVENT` with `RECURRENCE-ID` |
| `sendSchedulingMessages` | `sendUpdates` | implicit on save | server scheduling (RFC 6638) |
| `respond()` | patch own attendee `responseStatus` | `accept` / `decline` / `tentativelyAccept` | update own `PARTSTAT` |
| `queryFreeBusy` | `freebusy.query` | `getSchedule` | `free-busy-query` REPORT / schedule outbox |

For JMAP for Calendars backends, OpenCal is close to a direct pass-through: event objects are the same JSCalendar objects.

## 13. Conformance

A conformant provider:

1. Exposes `~opencal` with `version: 1`, a `vendor` and an accurate `capabilities` object.
2. Implements every method in §5. Methods behind a `false` capability reject with `unsupported`.
3. Reads and writes every §3.1 property without loss.
4. Expands every recurrence rule it accepts correctly in the event's time zone, or rejects it on write.
5. Rejects only with `OpenCalError` objects using the codes in §9.

The example in [`examples/memory-provider.ts`](./examples/memory-provider.ts) and its tests demonstrate these rules. A reusable conformance suite is planned.

## 14. Versioning

`version` is the spec major version. Additive changes (new optional fields, capabilities, error codes, methods behind a new capability) are minor versions and do not change `version`. Consumers MUST tolerate unknown capability keys and unknown error codes (treating the latter as `unknown`). Breaking changes increment `version`.

## 15. Open questions

- **Sync.** Model as `getChanges(sinceState)` like JMAP, or a watch/subscribe API? Leaning JMAP-style for v1.x.
- **Working hours and out-of-office.** Expose via `Calendar` metadata, VAVAILABILITY ([RFC 7953]), or only through `busyType: "unavailable"`?
- **Attachments and conference creation.** Common in practice (Meet/Teams links) but highly provider-specific.
- **Batch writes.** Useful for import; may belong in a capability.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174
[RFC 5546]: https://www.rfc-editor.org/rfc/rfc5546
[RFC 7953]: https://www.rfc-editor.org/rfc/rfc7953
[RFC 8984]: https://www.rfc-editor.org/rfc/rfc8984
