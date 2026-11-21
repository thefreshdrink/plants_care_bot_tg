// тесты погодных предупреждений и мелких помощников полива: deno test supabase/functions/bot/weather_alerts_test.ts
// пороги взяты из watering.ts как есть; тест фиксирует нынешнее поведение, не меняет его.
import { assertEquals } from "jsr:@std/assert@1";
import { addDays, daysBetween, getsRain, isOutdoor, isWarmSeason, Location, PlantLike, weatherAlerts } from "./watering.ts";
import type { Day, Weather } from "./weather.ts";

const TODAY = "2026-07-15";

const plant = (id: string, o: Partial<PlantLike> = {}): PlantLike => ({
  id, nickname: id, common_name: null, location: "outdoor_pot",
  water_every_days: 5, water_winter_days: null, feed_every_days: null,
  cold_min_c: null, heat_sensitive: false,
  last_watered_at: "", last_fed_at: null, snoozed_until: null, created_at: "2026-01-01T00:00:00Z",
  ...o,
});

const calm = (date: string): Day => ({ date, tmax: 28, tmin: 18, rain: 0, rainProb: 0, et0: 5, gust: 20, uv: 0, code: 0 });

// вчера, сегодня, завтра; правки дня — по дате
function weather(today: Partial<Day> = {}, tomorrow: Partial<Day> = {}, dust: number | null = null): Weather {
  const days = [calm(addDays(TODAY, -1)), { ...calm(TODAY), ...today }, { ...calm(addDays(TODAY, 1)), ...tomorrow }];
  return { days, today: TODAY, dustToday: dust };
}

const name = (p: PlantLike) => p.nickname!;
const keys = (w: Weather, ps: PlantLike[]) => weatherAlerts(w, ps, name).map((a) => a.key);

Deno.test("спокойный день — предупреждений нет", () => {
  assertEquals(keys(weather(), [plant("a")]), []);
});

Deno.test("без уличных растений предупреждений нет, даже в бурю", () => {
  const w = weather({ tmax: 40, tmin: -2, gust: 90, rain: 30, rainProb: 90 }, {}, 400);
  assertEquals(keys(w, [plant("a", { location: "indoor", cold_min_c: 5 })]), []);
  assertEquals(keys(w, []), []);
});

Deno.test("сегодняшнего дня нет в прогнозе — предупреждений нет", () => {
  const w = weather({ tmax: 40 });
  assertEquals(weatherAlerts({ ...w, today: "2026-08-01" }, [plant("a")], name), []);
});

Deno.test("жара: с 35°, в списке только нежные", () => {
  assertEquals(keys(weather({ tmax: 34.9 }), [plant("a")]), []);
  const [heat] = weatherAlerts(weather({ tmax: 35.4 }), [plant("a"), plant("b", { heat_sensitive: true })], name);
  assertEquals(heat.key, "heat");
  assertEquals(heat.title, "жара 35°");
  assertEquals(heat.plants, ["b"]);
});

Deno.test("холод: порог растения плюс градус, считается и следующая ночь", () => {
  const ps = [plant("a", { cold_min_c: 5 }), plant("b", { cold_min_c: 0 }), plant("c")];
  // 6.1° — выше 5+1, никого
  assertEquals(keys(weather({ tmin: 6.1 }), ps), []);
  // ровно 6° — «a» попадает, «b» (порог 0) и «c» (порога нет) нет
  const [cold] = weatherAlerts(weather({ tmin: 6 }), ps, name);
  assertEquals([cold.key, cold.plants], ["cold", ["a"]]);
  // сегодня тепло, завтра ночью 1° — берётся самая холодная из двух
  const [night] = weatherAlerts(weather({ tmin: 15 }, { tmin: 0.6 }), ps, name);
  assertEquals(night.title, "ночью до 1°");
  assertEquals(night.plants, ["a", "b"]);
});

Deno.test("холод: если завтрашнего дня нет, смотрим только сегодня", () => {
  const w = weather({ tmin: 10 });
  w.days.pop();
  assertEquals(keys(w, [plant("a", { cold_min_c: 8 })]), []);
});

Deno.test("ветер: с 55 км/ч, растения в грунте не в списке", () => {
  const ps = [plant("pot"), plant("ground", { location: "outdoor_ground" }), plant("roof", { location: "covered" })];
  assertEquals(keys(weather({ gust: 54 }), ps), []);
  const [wind] = weatherAlerts(weather({ gust: 55 }), ps, name);
  assertEquals(wind.key, "wind");
  assertEquals(wind.plants, ["pot", "roof"]);
});

Deno.test("ливень: от 10 мм и вероятности 50%", () => {
  const ps = [plant("a")];
  assertEquals(keys(weather({ rain: 9.9, rainProb: 90 }), ps), []);
  assertEquals(keys(weather({ rain: 20, rainProb: 49 }), ps), []);
  const [rain] = weatherAlerts(weather({ rain: 12.4, rainProb: 50 }), ps, name);
  assertEquals([rain.key, rain.title, rain.plants], ["rain", "ливень, до 12 мм", []]);
});

Deno.test("пыль: от 150, без данных о пыли молчим", () => {
  const ps = [plant("a")];
  assertEquals(keys(weather({}, {}, null), ps), []);
  assertEquals(keys(weather({}, {}, 149), ps), []);
  assertEquals(keys(weather({}, {}, 150), ps), ["dust"]);
});

Deno.test("всё сразу — порядок: жара, холод, ветер, ливень, пыль", () => {
  const w = weather({ tmax: 36, tmin: 2, gust: 70, rain: 15, rainProb: 80 }, {}, 300);
  assertEquals(keys(w, [plant("a", { cold_min_c: 3 })]), ["heat", "cold", "wind", "rain", "dust"]);
});

Deno.test("места: что считается улицей и что мокнет под дождём", () => {
  const all: Location[] = ["indoor", "covered", "outdoor_pot", "outdoor_ground"];
  assertEquals(all.map(isOutdoor), [false, true, true, true]);
  assertEquals(all.map(getsRain), [false, false, true, true]);
});

Deno.test("тёплый сезон — апрель–октябрь", () => {
  const months = Array.from({ length: 12 }, (_, i) => isWarmSeason(`2026-${String(i + 1).padStart(2, "0")}-15`));
  assertEquals(months, [false, false, false, true, true, true, true, true, true, true, false, false]);
});

Deno.test("дни между датами: через месяц, год и смену времени", () => {
  assertEquals(daysBetween("2026-07-15", "2026-07-15"), 0);
  assertEquals(daysBetween("2026-02-27", "2026-03-01"), 2);
  assertEquals(daysBetween("2025-12-31", "2026-01-01"), 1);
  assertEquals(daysBetween("2026-10-24", "2026-10-26"), 2); // смена времени 25.10 не сдвигает счёт
  assertEquals(daysBetween("2026-07-15", "2026-07-10"), -5);
});
