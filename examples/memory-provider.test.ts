import { test } from "node:test";
import assert from "node:assert/strict";
import type { OpenCalError, OpenCalProvider } from "../src/index.ts";
import { MemoryProvider } from "./memory-provider.ts";

const SELF = "ada@example.com";

function setup(): OpenCalProvider {
  return new MemoryProvider({
    self: SELF,
    calendars: [
      { id: "work", name: "Work", timeZone: "America/Los_Angeles", isDefault: true },
      { id: "home", name: "Home" },
    ],
  });
}

async function rejectsWith(p: Promise<unknown>, code: OpenCalError["code"]) {
  await assert.rejects(p, (e: OpenCalError) => {
    assert.equal(e["~opencal"], "calendar-error");
    assert.equal(e.code, code);
    return true;
  });
}

test("exposes ~opencal props", () => {
  const p = setup();
  assert.equal(p["~opencal"].version, 1);
  assert.equal(p["~opencal"].vendor, "memory");
  assert.equal(p["~opencal"].capabilities.recurrence.expand, true);
});

test("lists calendars with pagination", async () => {
  const p = setup();
  const first = await p.listCalendars({ limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await p.listCalendars({ limit: 1, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, undefined);
});

test("create, get, update with etag, delete", async () => {
  const p = setup();
  const created = await p.createEvent({
    calendarId: "work",
    event: {
      "@type": "Event",
      title: "Design review",
      start: "2026-10-12T10:00:00",
      timeZone: "America/Los_Angeles",
      duration: "PT1H",
    },
  });
  assert.ok(created.event.uid, "provider generates uid");
  assert.equal(created.event.sequence, 0);

  const updated = await p.updateEvent(
    { id: created.id, patch: { title: "Design review (moved)", start: "2026-10-12T11:00:00" } },
    { ifMatch: created.etag },
  );
  assert.equal(updated.event.title, "Design review (moved)");
  assert.equal(updated.event.sequence, 1);
  assert.notEqual(updated.etag, created.etag);

  await rejectsWith(p.updateEvent({ id: created.id, patch: { title: "x" } }, { ifMatch: created.etag }), "conflict");
  await rejectsWith(p.updateEvent({ id: created.id, patch: { uid: "other" } }), "invalid-input");

  await p.deleteEvent({ id: created.id });
  await rejectsWith(p.getEvent(created.id), "not-found");
});

test("rejects duplicate uid in the same calendar", async () => {
  const p = setup();
  const ev = { "@type": "Event" as const, uid: "dup@example.com", start: "2026-10-12T10:00:00" };
  await p.createEvent({ calendarId: "work", event: ev });
  await rejectsWith(p.createEvent({ calendarId: "work", event: ev }), "conflict");
  await p.createEvent({ calendarId: "home", event: ev }); // different calendar is fine
});

test("expands a weekly series in its own time zone across DST", async () => {
  const p = setup();
  await p.createEvent({
    calendarId: "work",
    event: {
      "@type": "Event",
      title: "Standup",
      start: "2026-10-26T09:00:00",
      timeZone: "America/Los_Angeles",
      duration: "PT15M",
      recurrenceRules: [{ frequency: "weekly", byDay: [{ day: "mo" }, { day: "we" }], count: 6 }],
    },
  });
  const { items } = await p.queryEvents({
    after: "2026-10-01T00:00:00Z",
    before: "2026-12-01T00:00:00Z",
    expand: true,
  });
  assert.deepEqual(
    items.map((r) => r.event.recurrenceId),
    [
      "2026-10-26T09:00:00",
      "2026-10-28T09:00:00",
      "2026-11-02T09:00:00",
      "2026-11-04T09:00:00",
      "2026-11-09T09:00:00",
      "2026-11-11T09:00:00",
    ],
  );
  for (const r of items) assert.equal(r.event.recurrenceRules, undefined);

  // 09:00 PDT = 16:00Z before Nov 1; 09:00 PST = 17:00Z after.
  const fb = await p.queryFreeBusy({ start: "2026-10-28T00:00:00Z", end: "2026-11-03T00:00:00Z", calendarIds: ["work"] });
  const work = fb.results["work"];
  assert.ok(work && "busy" in work);
  assert.deepEqual(work.busy.map((b) => b.start), ["2026-10-28T16:00:00Z", "2026-11-02T17:00:00Z"]);
});

test("non-expanded query returns the master once", async () => {
  const p = setup();
  await p.createEvent({
    calendarId: "work",
    event: { "@type": "Event", start: "2026-10-01T08:00:00", timeZone: "UTC", duration: "PT1H", recurrenceRules: [{ frequency: "daily" }] },
  });
  const { items } = await p.queryEvents({ after: "2026-10-05T00:00:00Z", before: "2026-10-10T00:00:00Z" });
  assert.equal(items.length, 1);
  assert.ok(items[0]!.event.recurrenceRules);
  await rejectsWith(p.queryEvents({ after: "2026-10-05T00:00:00Z", expand: true }), "invalid-input");
});

test("occurrence edits and deletes become overrides", async () => {
  const p = setup();
  const rec = await p.createEvent({
    calendarId: "work",
    event: { "@type": "Event", title: "1:1", start: "2026-10-05T14:00:00", timeZone: "UTC", duration: "PT30M", recurrenceRules: [{ frequency: "weekly", count: 4 }] },
  });
  await p.updateEvent({ id: rec.id, scope: "occurrence", recurrenceId: "2026-10-12T14:00:00", patch: { start: "2026-10-13T15:00:00", title: "1:1 (Tue)" } });
  await p.deleteEvent({ id: rec.id, scope: "occurrence", recurrenceId: "2026-10-19T14:00:00" });
  await rejectsWith(p.updateEvent({ id: rec.id, scope: "occurrence", recurrenceId: "2026-10-06T14:00:00", patch: {} }), "not-found");
  await rejectsWith(p.updateEvent({ id: rec.id, scope: "thisAndFollowing", recurrenceId: "2026-10-12T14:00:00", patch: {} }), "unsupported");

  const { items } = await p.queryEvents({ after: "2026-10-01T00:00:00Z", before: "2026-11-01T00:00:00Z", expand: true });
  assert.deepEqual(
    items.map((r) => [r.event.recurrenceId, r.event.start, r.event.title]),
    [
      ["2026-10-05T14:00:00", "2026-10-05T14:00:00", "1:1"],
      ["2026-10-12T14:00:00", "2026-10-13T15:00:00", "1:1 (Tue)"],
      ["2026-10-26T14:00:00", "2026-10-26T14:00:00", "1:1"],
    ],
  );
});

test("respond updates own participation and affects free/busy", async () => {
  const p = setup();
  const ev = await p.createEvent({
    calendarId: "work",
    event: {
      "@type": "Event",
      title: "Offsite planning",
      start: "2026-10-14T13:00:00",
      timeZone: "UTC",
      duration: "PT2H",
      replyTo: { imip: "mailto:grace@example.com" },
      participants: {
        org: { email: "grace@example.com", roles: { owner: true, attendee: true }, participationStatus: "accepted" },
        me: { email: SELF, roles: { attendee: true }, participationStatus: "needs-action", expectReply: true },
      },
    },
  });
  const window = { start: "2026-10-14T00:00:00Z", end: "2026-10-15T00:00:00Z", calendarIds: ["work"] } as const;

  await p.respond({ id: ev.id, participationStatus: "tentative", comment: "Might be late" });
  let fb = await p.queryFreeBusy(window);
  assert.deepEqual(fb.results["work"], { busy: [{ start: "2026-10-14T13:00:00Z", end: "2026-10-14T15:00:00Z", busyType: "tentative" }] });

  const declined = await p.respond({ id: ev.id, participationStatus: "declined" });
  assert.equal(declined.event.participants?.["me"]?.participationStatus, "declined");
  fb = await p.queryFreeBusy(window);
  assert.deepEqual(fb.results["work"], { busy: [] });
});

test("unsupported features fail loudly", async () => {
  const p = setup();
  await rejectsWith(
    p.createEvent({ calendarId: "work", event: { "@type": "Event", start: "2026-10-01T00:00:00", recurrenceRules: [{ frequency: "monthly" }] } }),
    "unsupported",
  );
  const fb = await p.queryFreeBusy({ start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z", attendees: ["mailto:x@example.com"] });
  const r = fb.results["mailto:x@example.com"];
  assert.ok(r && "error" in r && r.error.code === "unsupported");
});

test("free-text search and move", async () => {
  const p = setup();
  const ev = await p.createEvent({ calendarId: "work", event: { "@type": "Event", title: "Dentist", start: "2026-10-20T09:00:00", timeZone: "UTC", duration: "PT1H" } });
  assert.equal((await p.queryEvents({ text: "dent" })).items.length, 1);
  assert.equal((await p.queryEvents({ text: "dent", calendarIds: ["home"] })).items.length, 0);
  await p.moveEvent({ id: ev.id, toCalendarId: "home" });
  assert.equal((await p.queryEvents({ text: "dent", calendarIds: ["home"] })).items.length, 1);
});

test("aborted calls reject with an OpenCal error", async () => {
  const p = setup();
  const ac = new AbortController();
  ac.abort();
  await rejectsWith(p.listCalendars({ signal: ac.signal }), "aborted");
  await rejectsWith(
    p.createEvent({ calendarId: "work", event: { "@type": "Event", start: "2026-10-01T00:00:00" } }, { signal: ac.signal }),
    "aborted",
  );
});
