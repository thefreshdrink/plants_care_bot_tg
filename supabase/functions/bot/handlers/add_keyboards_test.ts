// тесты кнопок добавления растения и даты последнего полива: deno test supabase/functions/bot/handlers/add_keyboards_test.ts
// чистые функции, сеть и база не нужны
import { assertEquals } from "jsr:@std/assert@1";
import { candidateButtons, lastWateredAt, locationButtons } from "./add_keyboards.ts";

const DAY = 86_400_000;

Deno.test("варианты вида: процент округлён, первый выделен, в конце «напишу сама»", () => {
  const k = candidateButtons([
    { latin: "Ficus elastica", common: "фикус", confidence: 0.834 },
    { latin: "Ficus lyrata", common: "фикус лировидный", confidence: 0.125 },
  ]);
  assertEquals(k.length, 3);
  assertEquals(k[0][0].text, "фикус · 83%");
  assertEquals(k[0][0].callback_data, "cand:0");
  assertEquals(k[0][0].style, "primary");
  assertEquals(k[1][0].text, "фикус лировидный · 13%");
  assertEquals(k[1][0].callback_data, "cand:1");
  assertEquals(k[1][0].style, undefined);
  assertEquals(k[2], [{ text: "ни то, напишу сама", callback_data: "cand:x" }]);
});

Deno.test("варианты вида: без кандидатов остаётся одна кнопка «напишу сама»", () => {
  assertEquals(candidateButtons([]).map((r) => r[0].callback_data), ["cand:x"]);
});

Deno.test("место: четыре кнопки по две, данные строит переданная функция", () => {
  const k = locationButtons((l) => `mvl:${l}:7`);
  assertEquals(k.map((r) => r.map((x) => x.text)), [["дом", "балкон под крышей"], ["улица · горшок", "улица · грунт"]]);
  assertEquals(k.flat().map((x) => x.callback_data), ["mvl:indoor:7", "mvl:covered:7", "mvl:outdoor_pot:7", "mvl:outdoor_ground:7"]);
});

Deno.test("последний полив: дни назад от «сейчас», «не помню» = 60 дней", () => {
  const now = Date.UTC(2026, 10, 12, 9, 30);
  assertEquals(lastWateredAt(0, now), "2026-11-12T09:30:00.000Z");
  assertEquals(lastWateredAt(1, now), "2026-11-11T09:30:00.000Z");
  assertEquals(lastWateredAt(7, now), new Date(now - 7 * DAY).toISOString());
  assertEquals(lastWateredAt(99, now), "2026-09-13T09:30:00.000Z");
});
