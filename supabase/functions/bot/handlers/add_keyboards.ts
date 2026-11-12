// кнопки добавления растения и дата последнего полива: чистые функции, без базы и сети
// (перенесены из add.ts как есть)
import { b, Keyboard } from "../telegram.ts";
import type { Candidate } from "../claude.ts";

export function candidateButtons(cs: Candidate[]): Keyboard {
  const rows: Keyboard = cs.map((c, i) => [b(`${c.common} · ${Math.round(c.confidence * 100)}%`, `cand:${i}`, i === 0 ? "primary" : undefined)]);
  rows.push([b("ни то, напишу сама", "cand:x")]);
  return rows;
}

export function locationButtons(cb: (l: string) => string): Keyboard {
  return [
    [b("дом", cb("indoor")), b("балкон под крышей", cb("covered"))],
    [b("улица · горшок", cb("outdoor_pot")), b("улица · грунт", cb("outdoor_ground"))],
  ];
}

// ответ на «когда поливала последний раз?» (кнопки lw:0/1/3/7/99) → дата в ISO.
// «не помню» (99) = 60 дней назад: считаем, что полить надо уже сегодня
export function lastWateredAt(daysAgo: number, now = Date.now()): string {
  const ago = daysAgo === 99 ? 60 : daysAgo;
  return new Date(now - ago * 86_400_000).toISOString();
}
