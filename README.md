# OpenCal

A provider-agnostic interface for calendars. It plays the role OpenFeature plays for feature flags and Standard Schema plays for validators.

Write calendar code once against `OpenCalProvider`, then plug in Google, Microsoft 365, CalDAV, JMAP or an in-memory fake. Events are plain [JSCalendar (RFC 8984)](https://www.rfc-editor.org/rfc/rfc8984) objects, so the data model is an existing IETF standard rather than a new one.

> **Status:** draft 1. The interface may change before 1.0. Feedback welcome in issues.

## Why

Calendar data formats and protocols are well standardized (iCalendar, CalDAV, iTIP, JSCalendar, JMAP). What's missing is a standard *in-process interface*. Every app that integrates more than one calendar backend writes its own adapter layer, or buys a proprietary unified API.

OpenCal is that interface, with three design rules:

1. **Don't invent a data model.** Events are JSCalendar, property for property.
2. **Report capabilities honestly.** Providers declare what they support. Anything else fails with `unsupported` instead of being approximated.
3. **No runtime dependency.** `@opencal/spec` is types only. Providers implement the shape; they don't import anything.

## What's covered in v1

- Calendars: list and get
- Events: query (with server-side recurrence expansion), get, create, update, delete, move
- Recurring events: edit or delete a single occurrence, the whole series, or this-and-following
- Free/busy across your calendars and other attendees
- Scheduling: send invites and updates, and RSVP to events
- Optimistic concurrency (etags), pagination, cancellation, typed errors

Sync and change feeds, auth, tasks and sharing are out of scope for now. See [SPEC.md §15](./SPEC.md#15-open-questions).

## Usage

```ts
import type { OpenCalProvider } from "@opencal/spec";

async function nextWeek(cal: OpenCalProvider) {
  const now = new Date();
  const { items } = await cal.queryEvents({
    after: now.toISOString(),
    before: new Date(+now + 7 * 864e5).toISOString(),
    expand: cal["~opencal"].capabilities.recurrence.expand,
  });
  return items.map((r) => `${r.event.start} ${r.event.timeZone ?? ""} ${r.event.title ?? "(untitled)"}`);
}

async function book(cal: OpenCalProvider, calendarId: string) {
  return cal.createEvent({
    calendarId,
    event: {
      "@type": "Event",
      title: "Design review",
      start: "2026-10-12T10:00:00",
      timeZone: "America/Los_Angeles",
      duration: "PT1H",
      participants: {
        a: { email: "ada@example.com", roles: { owner: true, attendee: true } },
        b: { email: "grace@example.com", roles: { attendee: true }, expectReply: true },
      },
    },
  });
}
```

## Implementing a provider

Implement `OpenCalProvider` and expose a `"~opencal"` property:

```ts
import type { OpenCalProvider } from "@opencal/spec";

export class MyProvider implements OpenCalProvider {
  readonly "~opencal" = {
    version: 1,
    vendor: "my-backend",
    capabilities: { /* see SPEC.md §4.1 */ },
  } as const;
  // listCalendars, queryEvents, createEvent, …
}
```

[`examples/memory-provider.ts`](./examples/memory-provider.ts) is a complete reference implementation, with tests covering recurrence across DST, occurrence overrides, RSVP and free/busy.

## Repository layout

| Path | |
|---|---|
| [`SPEC.md`](./SPEC.md) | The normative specification |
| [`src/index.ts`](./src/index.ts) | TypeScript binding, published as `@opencal/spec` |
| [`examples/`](./examples) | In-memory reference provider and tests |

## Development

Requires Node 22.18+ (tests run TypeScript directly).

```sh
npm install
npm run typecheck
npm test
npm run build   # emits dist/index.d.ts
```

## Related standards

[iCalendar (RFC 5545)](https://www.rfc-editor.org/rfc/rfc5545) · [iTIP (RFC 5546)](https://www.rfc-editor.org/rfc/rfc5546) · [CalDAV (RFC 4791)](https://www.rfc-editor.org/rfc/rfc4791) · [CalDAV Scheduling (RFC 6638)](https://www.rfc-editor.org/rfc/rfc6638) · [JSCalendar (RFC 8984)](https://www.rfc-editor.org/rfc/rfc8984) · [JMAP (RFC 8620)](https://www.rfc-editor.org/rfc/rfc8620)

## License

MIT
