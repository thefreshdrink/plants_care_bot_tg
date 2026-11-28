// тесты кнопок карточки растения: deno test supabase/functions/bot/handlers/card_keyboard_test.ts
// чистая функция, сеть и база не нужны
import { assertEquals } from "jsr:@std/assert@1";
import { cardKeyboard } from "./card_keyboard.ts";

const ID = "abc";
const texts = (k: ReturnType<typeof cardKeyboard>) => k.map((r) => r.map((x) => x.text));
const data = (k: ReturnType<typeof cardKeyboard>) => k.map((r) => r.map((x) => x.callback_data));

Deno.test("без подкормки: «полито / не сегодня / инфо» в один ряд, внизу история", () => {
  const k = cardKeyboard(ID, "indoor", true, false);
  assertEquals(texts(k), [["полито", "не сегодня", "инфо"], ["история", "ещё", "весь сад"]]);
  assertEquals(data(k), [["w:abc", "snz:abc", "care:abc"], ["hist:abc", "ed:abc", "list"]]);
  assertEquals(k[0][0].style, "success");
});

Deno.test("пора подкормить: «с удобрением / без», затем «не сегодня / инфо»", () => {
  const k = cardKeyboard(ID, "indoor", true, true);
  assertEquals(texts(k).slice(0, 2), [["с удобрением", "без"], ["не сегодня", "инфо"]]);
  // «с удобрением» шлёт тот же w:, что и «полито»; «без» — отдельный wn:
  assertEquals(data(k).slice(0, 2), [["w:abc", "wn:abc"], ["snz:abc", "care:abc"]]);
  assertEquals(k[0][0].style, "success");
});

Deno.test("«был дождь» только под открытым небом", () => {
  const has = (l: Parameters<typeof cardKeyboard>[1]) =>
    data(cardKeyboard(ID, l, true, false)).flat().includes("rain:c:abc");
  assertEquals(has("indoor"), false);
  assertEquals(has("covered"), false);
  assertEquals(has("outdoor_pot"), true);
  assertEquals(has("outdoor_ground"), true);
});

Deno.test("без фото — кнопка «добавить фото», с фото её нет", () => {
  const without = cardKeyboard(ID, "indoor", false, false);
  assertEquals(texts(without), [["полито", "не сегодня", "инфо"], ["добавить фото"], ["история", "ещё", "весь сад"]]);
  assertEquals(without[1][0].callback_data, "nph:abc");
  assertEquals(without[1][0].style, "primary");
  assertEquals(data(cardKeyboard(ID, "indoor", true, false)).flat().includes("nph:abc"), false);
});

Deno.test("порядок рядов на улице без фото: полив, дождь, фото, история", () => {
  const k = cardKeyboard(ID, "outdoor_ground", false, true);
  assertEquals(data(k), [
    ["w:abc", "wn:abc"],
    ["snz:abc", "care:abc"],
    ["rain:c:abc"],
    ["nph:abc"],
    ["hist:abc", "ed:abc", "list"],
  ]);
});
