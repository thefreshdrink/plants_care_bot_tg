// тесты логики полива: deno test supabase/functions/bot/watering_test.ts
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { addDays, ET0_REF, PlantLike, projectWaterDays, waterStatus } from "./watering.ts";
import type { Day, Weather } from "./weather.ts";

const TODAY = "2026-07-15";

const plant = (o: Partial<PlantLike> = {}): PlantLike => ({
  id: "p1", nickname: null, common_name: null, location: "outdoor_pot",
  water_every_days: 5, water_winter_days: null, feed_every_days: null,
  cold_min_c: null, heat_sensitive: false,
  last_watered_at: "", last_fed_at: null, snoozed_until: null, created_at: "2026-01-01T00:00:00Z",
  ...o,
});

// 10 дней до сегодня и 7 вперёд, каждый день испарение ровно ET0_REF: один «эталонный день» сухости
function weather(rain: Record<string, number> = {}, prob = 0): Weather {
  const days: Day[] = [];
  for (let k = -10; k <= 6; k++) {
    const date = addDays(TODAY, k);
    days.push({ date, tmax: 30, tmin: 20, rain: rain[date] ?? 0, rainProb: prob, et0: ET0_REF, gust: 0, uv: 0, code: 0 });
  }
  return { days, today: TODAY, dustToday: null };
}

// полито 4 дня назад: без дождя накоплено 4 из 5
const WATERED = addDays(TODAY, -4);

Deno.test("без дождя сухость копится по испарению", () => {
  const st = waterStatus(plant(), weather(), WATERED);
  assertAlmostEquals(st.progress, 4 / 5);
  assertEquals(st.due, false);
  assertEquals(st.daysLeft, 1);
  assertEquals(st.rainedOn, null);
});

Deno.test("дождь 2 мм уменьшает сухость, но не обнуляет", () => {
  const st = waterStatus(plant(), weather({ [addDays(TODAY, -2)]: 2 }), WATERED);
  assertAlmostEquals(st.progress, (4 - 2 / ET0_REF) / 5);
  assertEquals(st.rainedOn, null);
  assertEquals(st.daysLeft, 2);
});

Deno.test("дождь 4 мм засчитывается как полный полив", () => {
  const rainDay = addDays(TODAY, -2);
  const st = waterStatus(plant(), weather({ [rainDay]: 4 }), WATERED);
  assertEquals(st.rainedOn, rainDay);
  assertAlmostEquals(st.progress, 2 / 5); // считаем только два дня после дождя
  assertEquals(st.daysLeft, 3);
});

Deno.test("дождь ровно 3 мм уже полный полив, 0.5 мм не считается", () => {
  const rainDay = addDays(TODAY, -2);
  assertEquals(waterStatus(plant(), weather({ [rainDay]: 3 }), WATERED).rainedOn, rainDay);
  assertAlmostEquals(waterStatus(plant(), weather({ [rainDay]: 0.5 }), WATERED).progress, 4 / 5);
});

Deno.test("сухость от мелкого дождя не уходит ниже нуля", () => {
  // прохладный дождливый день: испарение 1 мм, дождь 2.5 мм. без нижней границы вышло бы меньше нуля
  const w = weather({ [addDays(TODAY, -1)]: 2.5 });
  const d = w.days.find((x) => x.date === addDays(TODAY, -1))!;
  d.et0 = 1;
  const st = waterStatus(plant(), w, addDays(TODAY, -2));
  assertAlmostEquals(st.progress, 1 / 5); // вчера 0, сегодня +1
});

Deno.test("дом и балкон под крышей дождь не замечают", () => {
  const rain = { [addDays(TODAY, -2)]: 4 };
  assertEquals(waterStatus(plant({ location: "covered" }), weather(rain), WATERED).rainedOn, null);
  assertAlmostEquals(waterStatus(plant({ location: "covered" }), weather(rain), WATERED).progress, 4 / 5);
});

Deno.test("прогноз на неделю начинается с даты из статуса", () => {
  const w = weather({ [addDays(TODAY, -2)]: 2 });
  const st = waterStatus(plant(), w, WATERED);
  const days = projectWaterDays(plant(), w, st, TODAY, addDays(TODAY, 6));
  assertEquals(days[0], addDays(TODAY, st.daysLeft));
});

Deno.test("вероятный дождь 4 мм в прогнозе сдвигает следующий полив", () => {
  const p = plant();
  const dry = weather({}, 80);
  const st = waterStatus(p, dry, WATERED);
  const base = projectWaterDays(p, dry, st, TODAY, addDays(TODAY, 6));
  assertEquals(base, [addDays(TODAY, 1), addDays(TODAY, 6)]);

  // дождь на третий день после полива: отсчёт начинается заново
  const wet = weather({ [addDays(TODAY, 3)]: 4 }, 80);
  const st2 = waterStatus(p, wet, WATERED);
  assertEquals(st2.daysLeft, st.daysLeft);
  assertEquals(projectWaterDays(p, wet, st2, TODAY, addDays(TODAY, 6)), [addDays(TODAY, 1)]);

  // а 2 мм только чуть отодвигают
  const drizzle = weather({ [addDays(TODAY, 3)]: 2 }, 80);
  assertEquals(projectWaterDays(p, drizzle, waterStatus(p, drizzle, WATERED), TODAY, addDays(TODAY, 6)), [addDays(TODAY, 1)]);
});

Deno.test("маловероятный дождь в прогнозе не учитываем", () => {
  const p = plant();
  const w = weather({ [addDays(TODAY, 3)]: 4 }, 30);
  const st = waterStatus(p, w, WATERED);
  assertEquals(projectWaterDays(p, w, st, TODAY, addDays(TODAY, 6)), [addDays(TODAY, 1), addDays(TODAY, 6)]);
});
