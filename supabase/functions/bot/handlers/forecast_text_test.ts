// тесты текста /weather: deno test supabase/functions/bot/handlers/forecast_text_test.ts
// чистая функция, сеть и база не нужны
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Day } from "../weather.ts";
import { weatherText } from "./forecast_text.ts";

const day = (date: string, o: Partial<Day> = {}): Day => ({
  date, tmax: 20, tmin: 10, rain: 0, rainProb: 0, et0: 2, gust: 10, uv: 3, code: 0, ...o,
});
// 1–20 ноября 2026, сегодня 11-е (среда)
const days = Array.from({ length: 20 }, (_, k) => day(`2026-11-${String(k + 1).padStart(2, "0")}`));
const code = (t: string) => t.split("<code>")[1].split("</code>")[0].split("\n");

Deno.test("пять дней с сегодняшнего, день недели и число без нуля", () => {
  const t = weatherText({ days, today: "2026-11-11", dustToday: null });
  assertEquals(code(t).map((l) => l.split("  ")[0]), ["ср 11", "чт 12", "пт 13", "сб 14", "вс 15"]);
});

Deno.test("температура и небо округлены, дождь от 1 мм", () => {
  const d = days.map((x) => x.date === "2026-11-11" ? { ...x, tmax: 21.6, tmin: 9.4, code: 63, rain: 4.6 } :
    x.date === "2026-11-12" ? { ...x, rain: 0.9, code: 3 } : x);
  const [a, b] = code(weatherText({ days: d, today: "2026-11-11", dustToday: null }));
  assertEquals(a, "ср 11  22°/9°  дождь · 5 мм");
  assertEquals(b, "чт 12  20°/10°  пасмурно");
});

Deno.test("дождь за неделю: семь дней до сегодня, сегодня не входит", () => {
  const d = days.map((x, k) => ({ ...x, rain: k + 1 })); // 1-е: 1 мм … 11-е: 11 мм
  const t = weatherText({ days: d, today: "2026-11-11", dustToday: null });
  assert(t.includes("дождь за неделю: 49 мм"), t); // 4+5+…+10
});

Deno.test("испарение сегодня с одним знаком", () => {
  const d = days.map((x) => x.date === "2026-11-11" ? { ...x, et0: 1.26 } : x);
  assert(weatherText({ days: d, today: "2026-11-11", dustToday: null }).includes("испарение сегодня: 1.3 мм"));
});

Deno.test("пыль: нет строки без данных, «сильно» от 150", () => {
  assert(!weatherText({ days, today: "2026-11-11", dustToday: null }).includes("пыль"));
  assert(weatherText({ days, today: "2026-11-11", dustToday: 149.4 }).includes("пыль: 149 мкг/м³\n") ||
    weatherText({ days, today: "2026-11-11", dustToday: 149.4 }).endsWith("пыль: 149 мкг/м³"));
  assert(weatherText({ days, today: "2026-11-11", dustToday: 150 }).endsWith("пыль: 150 мкг/м³ · сильно"));
});

Deno.test("начало ряда: прошлых дней меньше семи", () => {
  const d = days.map((x) => ({ ...x, rain: 2 }));
  assert(weatherText({ days: d, today: "2026-11-03", dustToday: null }).includes("дождь за неделю: 4 мм"));
});
