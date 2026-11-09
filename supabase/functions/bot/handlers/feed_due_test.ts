// тесты needsFeed: deno test supabase/functions/bot/handlers/feed_due_test.ts
// карточка и сводка спрашивают needsFeed, пора ли «полито с удобрением». важно, что даты берутся
// по часовому поясу пользователя, а не по UTC: на Кипре полночь наступает на 2–3 часа раньше.
import { assertEquals } from "jsr:@std/assert@1";
import { needsFeed } from "./feed_due.ts";
import type { Plant, User } from "../db.ts";

const user = (tz = "Asia/Nicosia"): User => ({
  telegram_id: 1, first_name: null, lat: 34.68, lon: 33.04, tz,
  digest_hour: 7, last_digest_on: null, evening_hour: null, last_evening_on: null,
});

const plant = (o: Partial<Plant> = {}): Plant => ({
  id: "p1", user_id: 1, nickname: null, species: null, common_name: null, room: null,
  location: "indoor", photo_file_id: null, photo_path: null, care: {},
  water_every_days: 7, water_winter_days: null, feed_every_days: 14,
  cold_min_c: null, heat_sensitive: false,
  last_watered_at: "2026-06-01T09:00:00Z", last_fed_at: null, snoozed_until: null,
  archived: false, created_at: "2026-01-01T09:00:00Z", ...o,
});

Deno.test("needsFeed: без срока подкормки — никогда", () => {
  assertEquals(needsFeed(user(), plant({ feed_every_days: null }), new Date("2026-06-15T09:00:00Z")), false);
});

Deno.test("needsFeed: срок от прошлой подкормки, ровно в день срока — пора", () => {
  const p = plant({ last_fed_at: "2026-06-01T09:00:00Z" });
  assertEquals(needsFeed(user(), p, new Date("2026-06-14T09:00:00Z")), false);
  assertEquals(needsFeed(user(), p, new Date("2026-06-15T09:00:00Z")), true);
});

Deno.test("needsFeed: подкормка поздно вечером по UTC — это уже следующий день на Кипре", () => {
  // 22:30 UTC 1 июня = 01:30 2 июня в Никосии, значит 14 дней истекают 16-го, а не 15-го
  const p = plant({ last_fed_at: "2026-06-01T22:30:00Z" });
  assertEquals(needsFeed(user(), p, new Date("2026-06-15T09:00:00Z")), false);
  assertEquals(needsFeed(user(), p, new Date("2026-06-16T09:00:00Z")), true);
  // тот же момент в поясе UTC — ещё 1 июня, и 15-го уже пора
  assertEquals(needsFeed(user("UTC"), p, new Date("2026-06-15T09:00:00Z")), true);
});

Deno.test("needsFeed: «сегодня» тоже по поясу пользователя — сезон кончается в полночь по Кипру", () => {
  const p = plant({ last_fed_at: "2026-09-01T09:00:00Z" });
  // 31 октября 23:30 UTC = 1 ноября 01:30 в Никосии (зимнее время, +2): сезон март–октябрь кончился
  assertEquals(needsFeed(user(), p, new Date("2026-10-31T21:00:00Z")), true);
  assertEquals(needsFeed(user(), p, new Date("2026-10-31T23:30:00Z")), false);
  assertEquals(needsFeed(user("UTC"), p, new Date("2026-10-31T23:30:00Z")), true);
});

Deno.test("needsFeed: ни разу не кормили — считаем от добавления по местной дате", () => {
  // добавлено 22:30 UTC 19 апреля = 20 апреля в Никосии; 30 дней — 20 мая
  const p = plant({ feed_every_days: 30, created_at: "2026-04-19T22:30:00Z" });
  assertEquals(needsFeed(user(), p, new Date("2026-05-19T09:00:00Z")), false);
  assertEquals(needsFeed(user(), p, new Date("2026-05-20T09:00:00Z")), true);
});
