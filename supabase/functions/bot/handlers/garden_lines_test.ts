// тесты экрана «сад»: deno test supabase/functions/bot/handlers/garden_lines_test.ts
// чистые функции, сеть и база не нужны
import { assertEquals } from "jsr:@std/assert@1";
import type { Plant } from "../db.ts";
import type { WaterStatus } from "../watering.ts";
import { roomsOf, whenShort } from "./garden_lines.ts";

const plant = (f: Partial<Plant>): Plant =>
  ({ nickname: null, common_name: null, species: null, room: null, location: "indoor", ...f }) as Plant;
const st = (f: Partial<WaterStatus>): WaterStatus =>
  ({ due: false, daysLeft: 3, reason: null, progress: 0.5, ...f }) as WaterStatus;

Deno.test("комнаты сада: порядок первого появления, без повторов", () => {
  const ps = [
    plant({ room: "кухня" }),
    plant({ location: "covered" }),
    plant({ room: "кухня" }),
    plant({ location: "indoor" }),
    plant({ location: "covered" }),
  ];
  assertEquals(roomsOf(ps), ["кухня", "балкон", "дом"]);
});

Deno.test("комнаты сада: пустой сад — пустой список", () => {
  assertEquals(roomsOf([]), []);
});

Deno.test("когда поливать: пора — «сегодня», даже если дней осталось больше", () => {
  assertEquals(whenShort(st({ due: true, daysLeft: 0 })), "сегодня");
  assertEquals(whenShort(st({ due: true, daysLeft: 4 })), "сегодня");
});

Deno.test("когда поливать: «завтра» и «через N дней» с окончаниями", () => {
  assertEquals(whenShort(st({ daysLeft: 1 })), "завтра");
  assertEquals(whenShort(st({ daysLeft: 2 })), "через 2 дня");
  assertEquals(whenShort(st({ daysLeft: 5 })), "через 5 дней");
  assertEquals(whenShort(st({ daysLeft: 21 })), "через 21 день");
});
