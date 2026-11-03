// тесты перевода карточки ухода в колонки растения: deno test supabase/functions/bot/handlers/care_columns_test.ts
// чистая функция, сеть и база не нужны
import { assertEquals } from "jsr:@std/assert@1";
import type { Care } from "../claude.ts";
import { careColumns } from "./care_columns.ts";

// карточка с обычными значениями; в тесте меняем только нужное
const care = (f: Partial<Record<keyof Care, unknown>>): Care =>
  ({
    common_name: "фикус", summary: "", light: "", water_how: "", water_every_days: 7, water_winter_days: 14,
    feed_every_days: 30, feed_what: "", soil: "", cold_min_c: 10, heat_sensitive: false, toxic: "",
    local_tips: "", trouble_signs: "", ...f,
  }) as Care;

Deno.test("уход: обычная карточка переходит в колонки как есть", () => {
  assertEquals(careColumns(care({})), {
    common_name: "фикус", water_every_days: 7, water_winter_days: 14, feed_every_days: 30,
    cold_min_c: 10, heat_sensitive: false,
  });
});

Deno.test("уход: полив не реже раза в полдня, без числа — раз в неделю", () => {
  assertEquals(careColumns(care({ water_every_days: 0.2 })).water_every_days, 0.5);
  assertEquals(careColumns(care({ water_every_days: 0 })).water_every_days, 7);
  assertEquals(careColumns(care({ water_every_days: "abc" })).water_every_days, 7);
  assertEquals(careColumns(care({ water_every_days: "3" })).water_every_days, 3);
});

Deno.test("уход: зимний полив и подкормка — пусто, если нет числа; подкормка округляется", () => {
  const c = careColumns(care({ water_winter_days: null, feed_every_days: 0 }));
  assertEquals(c.water_winter_days, null);
  assertEquals(c.feed_every_days, null);
  assertEquals(careColumns(care({ feed_every_days: 14.6 })).feed_every_days, 15);
});

Deno.test("уход: холод — число или пусто, минус сохраняется", () => {
  assertEquals(careColumns(care({ cold_min_c: -3 })).cold_min_c, -3);
  assertEquals(careColumns(care({ cold_min_c: "5" })).cold_min_c, 5);
  assertEquals(careColumns(care({ cold_min_c: undefined })).cold_min_c, null);
  // так сейчас: null превращается в 0°, а не в «неизвестно» (схема Claude требует число, поэтому редкость)
  assertEquals(careColumns(care({ cold_min_c: null })).cold_min_c, 0);
});

Deno.test("уход: чувствительность к жаре — всегда да/нет", () => {
  assertEquals(careColumns(care({ heat_sensitive: true })).heat_sensitive, true);
  assertEquals(careColumns(care({ heat_sensitive: undefined })).heat_sensitive, false);
});
