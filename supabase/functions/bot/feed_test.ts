// тесты подкормки: deno test supabase/functions/bot/feed_test.ts
// feedDue решает, когда карточка и сводка просят полить с удобрением. чистая функция, сеть и база не нужны
import { assertEquals } from "jsr:@std/assert@1";
import { feedDue } from "./watering.ts";
import type { PlantLike } from "./watering.ts";

const plant = (feed: number | null): PlantLike => ({
  id: "p1", nickname: null, common_name: null, location: "indoor",
  water_every_days: 7, water_winter_days: null, feed_every_days: feed,
  cold_min_c: null, heat_sensitive: false,
  last_watered_at: "", last_fed_at: null, snoozed_until: null, created_at: "2026-01-01T00:00:00Z",
});

const CREATED = "2026-01-01";

Deno.test("подкормка: без срока подкормки — никогда", () => {
  assertEquals(feedDue(plant(null), "2026-06-15", null, CREATED), false);
  assertEquals(feedDue(plant(0), "2026-06-15", null, CREATED), false);
});

Deno.test("подкормка: ровно в срок пора, на день раньше нет", () => {
  assertEquals(feedDue(plant(14), "2026-06-15", "2026-06-01", CREATED), true);
  assertEquals(feedDue(plant(14), "2026-06-14", "2026-06-01", CREATED), false);
  assertEquals(feedDue(plant(14), "2026-06-30", "2026-06-01", CREATED), true);
});

Deno.test("подкормка: ни разу не кормили — считаем от добавления растения", () => {
  assertEquals(feedDue(plant(30), "2026-05-10", null, "2026-04-20"), false);
  assertEquals(feedDue(plant(30), "2026-05-20", null, "2026-04-20"), true);
});

Deno.test("подкормка: только с марта по октябрь", () => {
  // кормили давно, срок прошёл, но зимой удобрение не просим
  for (const d of ["2026-01-15", "2026-02-28", "2026-11-01", "2026-12-31"]) {
    assertEquals(feedDue(plant(14), d, "2025-09-01", CREATED), false, d);
  }
  for (const d of ["2026-03-01", "2026-10-31"]) {
    assertEquals(feedDue(plant(14), d, "2025-09-01", CREATED), true, d);
  }
});

Deno.test("подкормка: срок считается через границу месяцев и года", () => {
  assertEquals(feedDue(plant(30), "2026-03-02", "2026-01-31", CREATED), true);
  assertEquals(feedDue(plant(60), "2026-03-02", "2026-01-31", CREATED), false);
});
