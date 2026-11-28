// тесты заголовка недели: deno test supabase/functions/bot/handlers/week_title_test.ts
// чистая функция, сеть и база не нужны
import { assertEquals } from "jsr:@std/assert@1";
import { weekTitle } from "./week_title.ts";

Deno.test("неделя внутри месяца: одно название месяца", () => {
  assertEquals(weekTitle("2026-11-02", "2026-11-08"), "2–8 ноября");
});

Deno.test("неделя через границу месяцев: оба месяца", () => {
  assertEquals(weekTitle("2026-11-30", "2026-12-06"), "30 ноября – 6 декабря");
});

Deno.test("неделя через новый год: декабрь и январь", () => {
  assertEquals(weekTitle("2026-12-28", "2027-01-03"), "28 декабря – 3 января");
});

Deno.test("числа без ведущего нуля", () => {
  assertEquals(weekTitle("2027-03-01", "2027-03-07"), "1–7 марта");
});
