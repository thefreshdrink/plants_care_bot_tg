// имена растений и комнаты: чистые функции, без базы и сети (перенесены из common.ts как есть)
import type { Plant } from "../db.ts";
import { LOC_SHORT } from "../texts.ts";

export const nameOf = (p: Plant) => p.nickname || p.common_name || p.species || "растение";
export const roomOf = (p: Plant) => p.room || LOC_SHORT[p.location].split(" · ")[0];

// группировка по комнатам с сохранением порядка
export function byRoom<T extends { p: Plant }>(rows: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = roomOf(r.p);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return [...m.entries()];
}
