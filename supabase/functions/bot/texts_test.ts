// тесты словесных помощников из texts.ts: deno test --allow-env=TELEGRAM_BOT_TOKEN supabase/functions/bot/texts_test.ts
// (texts.ts тянет telegram.ts, а тот при загрузке читает токен из окружения)
import { assertEquals } from "jsr:@std/assert@1";
import { days, plural, ruDate, waterBar, whenWater } from "./texts.ts";

Deno.test("дни: окончания по числу", () => {
  assertEquals(days(0), "0 дней");
  assertEquals(days(1), "1 день");
  assertEquals(days(2), "2 дня");
  assertEquals(days(4), "4 дня");
  assertEquals(days(5), "5 дней");
  assertEquals(days(21), "21 день");
  assertEquals(days(22), "22 дня");
  assertEquals(days(101), "101 день");
});

Deno.test("дни: от 11 до 14 всегда «дней»", () => {
  for (const k of [11, 12, 13, 14, 111, 112]) assertEquals(days(k), `${k} дней`);
});

Deno.test("plural: отрицательные числа как положительные", () => {
  assertEquals(plural(-1, "день", "дня", "дней"), "день");
  assertEquals(plural(-3, "день", "дня", "дней"), "дня");
});

Deno.test("дата: число без нуля и месяц в родительном", () => {
  assertEquals(ruDate("2026-10-27"), "27 октября");
  assertEquals(ruDate("2026-01-05"), "5 января");
  assertEquals(ruDate("2026-12-31"), "31 декабря");
});

Deno.test("шкала воды: полная после полива, пустая к поливу", () => {
  assertEquals(waterBar(0), "▰▰▰▰▰▰");
  assertEquals(waterBar(0.5), "▰▰▰▱▱▱");
  assertEquals(waterBar(1), "▱▱▱▱▱▱");
});

Deno.test("шкала воды: выход за края не ломает длину", () => {
  assertEquals(waterBar(2), "▱▱▱▱▱▱");
  assertEquals(waterBar(-1), "▰▰▰▰▰▰");
  for (const p of [0, 0.1, 0.25, 0.5, 0.9, 1, 3]) assertEquals([...waterBar(p)].length, 6);
});

Deno.test("когда поливать: сегодня, завтра, через n дней", () => {
  assertEquals(whenWater(0, false), "полить сегодня");
  assertEquals(whenWater(-2, false), "полить сегодня");
  assertEquals(whenWater(5, true), "полить сегодня");
  assertEquals(whenWater(1, false), "полив завтра");
  assertEquals(whenWater(3, false), "полив через 3 дня");
  assertEquals(whenWater(5, false), "полив через 5 дней");
});
