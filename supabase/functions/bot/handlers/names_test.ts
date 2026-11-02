// тесты имён растений и комнат: deno test supabase/functions/bot/handlers/names_test.ts
// чистые функции, сеть и база не нужны
import { assertEquals } from "jsr:@std/assert@1";
import type { Plant } from "../db.ts";
import { byRoom, nameOf, roomOf } from "./names.ts";

// растение с пустыми полями; в тесте задаём только нужные
const plant = (f: Partial<Plant>): Plant =>
  ({ nickname: null, common_name: null, species: null, room: null, location: "indoor", ...f }) as Plant;

Deno.test("имя: своё имя важнее обычного названия и латыни", () => {
  assertEquals(nameOf(plant({ nickname: "Фёдор", common_name: "фикус", species: "Ficus elastica" })), "Фёдор");
  assertEquals(nameOf(plant({ common_name: "фикус", species: "Ficus elastica" })), "фикус");
  assertEquals(nameOf(plant({ species: "Ficus elastica" })), "Ficus elastica");
});

Deno.test("имя: без всего — «растение», пустая строка не считается", () => {
  assertEquals(nameOf(plant({})), "растение");
  assertEquals(nameOf(plant({ nickname: "", common_name: "фикус" })), "фикус");
});

Deno.test("комната: своя комната, иначе место без уточнения", () => {
  assertEquals(roomOf(plant({ room: "кухня", location: "outdoor_pot" })), "кухня");
  assertEquals(roomOf(plant({ location: "indoor" })), "дом");
  assertEquals(roomOf(plant({ location: "covered" })), "балкон");
  assertEquals(roomOf(plant({ location: "outdoor_pot" })), "улица");
  assertEquals(roomOf(plant({ location: "outdoor_ground" })), "улица");
});

Deno.test("по комнатам: порядок первого появления, внутри комнаты порядок строк", () => {
  const a = { p: plant({ nickname: "a", room: "кухня" }) };
  const b = { p: plant({ nickname: "b", location: "outdoor_pot" }) };
  const c = { p: plant({ nickname: "c", room: "кухня" }) };
  const d = { p: plant({ nickname: "d", location: "outdoor_ground" }) };
  const groups = byRoom([a, b, c, d]);
  assertEquals(groups.map(([k, rows]) => [k, rows.map((r) => nameOf(r.p))]), [
    ["кухня", ["a", "c"]],
    ["улица", ["b", "d"]],
  ]);
});

Deno.test("по комнатам: пустой список — пусто", () => {
  assertEquals(byRoom([]), []);
});
