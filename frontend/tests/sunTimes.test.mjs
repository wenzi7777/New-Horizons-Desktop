import assert from "node:assert/strict";
import test from "node:test";

import { daylightAt, sunEvent } from "../src/lib/sunTimes.ts";

// Published times for Aizu-Wakamatsu (JST): within a few minutes is enough
// for a theme switch.
const near = (date, hhmm, minutes = 4) => {
  const [h, m] = hhmm.split(":").map(Number);
  const jstMinutes = (date.getUTCHours() * 60 + date.getUTCMinutes() + 9 * 60) % (24 * 60);
  assert.ok(Math.abs(jstMinutes - (h * 60 + m)) <= minutes, `${date.toISOString()} is not near ${hhmm} JST`);
};

test("sunrise and sunset at the lab match the almanac", () => {
  process.env.TZ = "Asia/Tokyo";
  const midsummer = new Date("2026-06-21T12:00:00+09:00");
  near(sunEvent(midsummer, true), "04:20");
  near(sunEvent(midsummer, false), "19:07");
  const midwinter = new Date("2026-12-22T12:00:00+09:00");
  near(sunEvent(midwinter, true), "06:55");
  near(sunEvent(midwinter, false), "16:28");
});

test("daylight says what it is now and when that changes", () => {
  process.env.TZ = "Asia/Tokyo";
  const noon = daylightAt(new Date("2026-10-28T12:00:00+09:00"));
  assert.equal(noon.day, true);
  assert.ok(noon.nextChange > new Date("2026-10-28T16:00:00+09:00"));
  const night = daylightAt(new Date("2026-10-28T22:00:00+09:00"));
  assert.equal(night.day, false);
  // After sunset the next change is tomorrow's sunrise, not today's.
  assert.ok(night.nextChange > new Date("2026-10-29T05:30:00+09:00"));
  assert.ok(night.nextChange < new Date("2026-10-29T06:30:00+09:00"));
});
