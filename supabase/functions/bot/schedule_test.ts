// тесты расписания крона: deno test supabase/functions/bot/schedule_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { dueEvening, dueMorning } from "./schedule.ts";

const TZ = "Asia/Nicosia";
const user = (o = {}) => ({
  tz: TZ, digest_hour: 7, last_digest_on: null, evening_hour: 20, last_evening_on: null, ...o,
});

// 24.10.2026 летнее время (UTC+3): 04:00Z = 07:00 по Никосии, 17:00Z = 20:00
const MORNING = new Date("2026-10-24T04:00:00Z");
const EVENING = new Date("2026-10-24T17:00:00Z");

Deno.test("утро: в свой час пишем", () => {
  assertEquals(dueMorning(user(), MORNING), true);
});

Deno.test("утро: не в свой час молчим", () => {
  assertEquals(dueMorning(user(), new Date("2026-10-24T05:00:00Z")), false);
  assertEquals(dueMorning(user({ digest_hour: 8 }), MORNING), false);
});

Deno.test("утро: второй раз за день не пишем", () => {
  assertEquals(dueMorning(user({ last_digest_on: "2026-10-24" }), MORNING), false);
  assertEquals(dueMorning(user({ last_digest_on: "2026-10-23" }), MORNING), true);
});

Deno.test("вечер: в свой час пишем, утро не мешает", () => {
  assertEquals(dueEvening(user({ last_digest_on: "2026-10-24" }), EVENING), true);
  assertEquals(dueMorning(user(), EVENING), false);
  assertEquals(dueEvening(user(), MORNING), false);
});

Deno.test("вечер: null — выключено, второй раз за день не пишем", () => {
  assertEquals(dueEvening(user({ evening_hour: null }), EVENING), false);
  assertEquals(dueEvening(user({ last_evening_on: "2026-10-24" }), EVENING), false);
});

Deno.test("смена времени 25.10: после перехода на UTC+2 утро в 05:00Z", () => {
  assertEquals(dueMorning(user(), new Date("2026-10-26T05:00:00Z")), true);
  assertEquals(dueMorning(user(), new Date("2026-10-26T04:00:00Z")), false);
});

Deno.test("день считается по часам пользователя, а не по UTC", () => {
  // 21:30Z 23.10 — уже 00:30 24.10 по Никосии
  const u = user({ digest_hour: 0, last_digest_on: "2026-10-23" });
  assertEquals(dueMorning(u, new Date("2026-10-23T21:30:00Z")), true);
});
