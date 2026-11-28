// чистые помощники экрана «сад»: порядок комнат и «когда поливать» коротко.
// без базы и сети, чтобы их можно было проверить тестами (garden_lines_test.ts)
import type { Plant } from "../db.ts";
import type { WaterStatus } from "../watering.ts";
import { days } from "../texts.ts";
import { roomOf } from "./names.ts";

// комнаты в стабильном порядке: как растения легли в базу
export function roomsOf(ps: Plant[]): string[] {
  const out: string[] = [];
  for (const p of ps) {
    const r = roomOf(p);
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

export const whenShort = (st: WaterStatus) =>
  st.due ? "сегодня" : st.daysLeft === 1 ? "завтра" : `через ${days(st.daysLeft)}`;
