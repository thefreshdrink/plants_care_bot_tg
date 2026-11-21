// тесты кнопок настроек: deno test supabase/functions/bot/handlers/settings_keyboard_test.ts
// чистые функции, сеть и база не нужны
import { assertEquals } from "jsr:@std/assert@1";
import { DIGEST_HOURS, hoursKeyboard, iconsKeyboard } from "./settings_keyboard.ts";
import { ICON_KEYS } from "../texts.ts";

type K = ReturnType<typeof hoursKeyboard>;
const texts = (k: K) => k.map((r) => r.map((x) => x.text));
const data = (k: K) => k.map((r) => r.map((x) => x.callback_data));

Deno.test("часы: два ряда по три, 6–8 и 9, 10, 20", () => {
  const k = hoursKeyboard(8);
  assertEquals(texts(k), [["6:00", "7:00", "8:00"], ["9:00", "10:00", "20:00"]]);
  assertEquals(data(k), [["hr:6", "hr:7", "hr:8"], ["hr:9", "hr:10", "hr:20"]]);
});

Deno.test("часы: выделен только текущий час", () => {
  for (const h of DIGEST_HOURS) {
    const marked = hoursKeyboard(h).flat().filter((x) => x.style === "primary").map((x) => x.text);
    assertEquals(marked, [`${h}:00`]);
  }
});

Deno.test("часы: если текущего часа нет в списке, не выделено ничего", () => {
  assertEquals(hoursKeyboard(13).flat().filter((x) => x.style).length, 0);
});

Deno.test("часы: callback_data разбирается обратно в тот же час (как в callbacks.ts)", () => {
  for (const x of hoursKeyboard(8).flat()) {
    const [cmd, a] = (x.callback_data ?? "").split(":");
    assertEquals(cmd, "hr");
    assertEquals(`${Number(a)}:00`, x.text);
  }
});

Deno.test("иконки: по три в ряд, каждая кнопка из ICON_KEYS ровно один раз, по порядку", () => {
  const k = iconsKeyboard();
  const rows = k.slice(0, -1);
  for (const r of rows.slice(0, -1)) assertEquals(r.length, 3);
  const last = rows[rows.length - 1].length;
  assertEquals(last >= 1 && last <= 3, true);
  assertEquals(rows.flat().map((x) => x.callback_data), ICON_KEYS.map((x) => `ic:${x.key}`));
});

Deno.test("иконки: последний ряд — «убрать все иконки», красная", () => {
  const k = iconsKeyboard();
  const last = k[k.length - 1];
  assertEquals(last.length, 1);
  assertEquals(last[0].text, "убрать все иконки");
  assertEquals(last[0].callback_data, "ic:clear");
  assertEquals(last[0].style, "danger");
});
