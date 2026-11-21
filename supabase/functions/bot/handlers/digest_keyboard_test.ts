// тесты кнопок дайджеста после нажатия: deno test supabase/functions/bot/handlers/digest_keyboard_test.ts
// чистая функция, сеть и база не нужны
import { assertEquals } from "jsr:@std/assert@1";
import type { Keyboard } from "../telegram.ts";
import { keyboardAfterPress } from "./digest_keyboard.ts";

// клавиатура в том виде, как её собирает digest(): комната с двумя и больше —
// кнопка «полито: комната · N», потом растения; «всё полито»; «был дождь»
const kb = (...rows: [string, string][]): Keyboard => rows.map(([text, d]) => [{ text, callback_data: d }]);
const data = (k: Keyboard) => k.map((row) => row[0].callback_data);

const kitchen3 = kb(
  ["полито: кухня · 3", "wr:кухня"],
  ["полито: базилик", "wd:1"],
  ["полито: мята", "wd:2"],
  ["полито: розмарин", "wd:3"],
  ["полито: фикус", "wd:4"],
  ["всё полито", "wall"],
  ["был дождь", "rain:d"],
);

Deno.test("нажатое растение уходит, остальное на месте", () => {
  assertEquals(data(keyboardAfterPress(kitchen3, "wd:2", [])), ["wr:кухня", "wd:1", "wd:3", "wd:4", "wall", "rain:d"]);
});

Deno.test("комната целиком: уходят кнопка комнаты и её растения", () => {
  const k = keyboardAfterPress(kitchen3, "wr:кухня", ["wd:1", "wd:2", "wd:3"]);
  // осталось одно растение — «всё полито» больше не нужна
  assertEquals(data(k), ["wd:4", "rain:d"]);
});

Deno.test("«всё полито» пропадает, когда растений меньше двух", () => {
  const two = kb(["полито: мята", "wd:2"], ["полито: фикус", "wd:4"], ["всё полито", "wall"]);
  assertEquals(data(keyboardAfterPress(two, "wd:2", [])), ["wd:4"]);
});

Deno.test("кнопка комнаты с иконкой (короткая подпись) читается так же", () => {
  const k: Keyboard = [
    [{ text: "кухня · 2", callback_data: "wr:кухня", icon_custom_emoji_id: "1" }],
    [{ text: "мята", callback_data: "wd:2" }],
    [{ text: "базилик", callback_data: "wd:1" }],
  ];
  assertEquals(data(keyboardAfterPress(k, "rain:d", [])), ["wr:кухня", "wd:2", "wd:1"]);
});

Deno.test("кнопка «без» в ряду растения уходит вместе с рядом", () => {
  const k: Keyboard = [
    [{ text: "полито: мята + удобрение", callback_data: "wd:2" }, { text: "без", callback_data: "wdn:2" }],
    [{ text: "полито: фикус", callback_data: "wd:4" }],
  ];
  assertEquals(keyboardAfterPress(k, "wdn:2", ["wd:2"]), [[{ text: "полито: фикус", callback_data: "wd:4" }]]);
});

Deno.test("пустая клавиатура остаётся пустой", () => {
  assertEquals(keyboardAfterPress([], "wd:1", []), []);
});

// так сейчас: проверка смотрит на число в подписи, а не на то, сколько растений
// комнаты осталось. в комнате на двоих после одного нажатия кнопка комнаты не уходит,
// хотя комментарий в коде обещает обратное (см. бэклог 18)
Deno.test("сейчас: комната на двоих после одного нажатия держит кнопку комнаты", () => {
  const k = kb(["полито: кухня · 2", "wr:кухня"], ["полито: мята", "wd:2"], ["полито: базилик", "wd:1"]);
  assertEquals(data(keyboardAfterPress(k, "wd:2", [])), ["wr:кухня", "wd:1"]);
});
