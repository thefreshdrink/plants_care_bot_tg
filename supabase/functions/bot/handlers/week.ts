// неделя полива: по дням и сеткой
import { b, edit, esc, Keyboard, send } from "../telegram.ts";
import * as D from "../db.ts";
import type { User } from "../db.ts";
import { localDate } from "../weather.ts";
import { addDays, projectWaterDays } from "../watering.ts";
import { T, WEEK_SHORT } from "../texts.ts";
import { byRoom, nameOf, status, weather } from "./common.ts";

// ---------- неделя сеткой (с понедельника)

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

function weekTitle(mon: string, sun: string): string {
  const d1 = Number(mon.slice(8)), d2 = Number(sun.slice(8));
  const m1 = MONTHS_GEN[Number(mon.slice(5, 7)) - 1], m2 = MONTHS_GEN[Number(sun.slice(5, 7)) - 1];
  return m1 === m2 ? `${d1}–${d2} ${m2}` : `${d1} ${m1} – ${d2} ${m2}`;
}

export async function week(u: User, chat: number, offset: number, editMid?: number, mode: "d" | "g" = "d") {
  const ps = await D.plants(u.telegram_id);
  if (!ps.length) return send(chat, T.emptyCollection);
  const w = await weather(u);
  const today = w.today;
  const dow = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7; // пн = 0
  const mon = addDays(today, -dow + offset * 7);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
  const sun = dates[6];

  // что уже полито на этой неделе
  const done = new Map<string, Set<string>>();
  if (mon <= today) {
    const evs = await D.waterEvents(u.telegram_id, new Date(Date.parse(mon + "T00:00:00Z") - 86_400_000).toISOString());
    for (const e of evs) {
      const d = localDate(u.tz, new Date(e.created_at));
      if (!done.has(e.plant_id)) done.set(e.plant_id, new Set());
      done.get(e.plant_id)!.add(d);
    }
  }

  const rows = ps.map((p) => {
    const st = status(u, p, w);
    const from = mon > today ? mon : today;
    const plan = new Set(projectWaterDays(p, w, st, from, sun));
    const cells = dates.map((d) => (done.get(p.id)?.has(d) ? "•" : plan.has(d) ? "○" : "·"));
    return { p, cells };
  });
  const groups = byRoom(rows);
  const totals = dates.map((_, i) => rows.filter((r) => r.cells[i] === "○").length);

  const title = `<b>неделя ${weekTitle(mon, sun)}</b>`;
  // полоска-сводка: сколько поливов в какой день
  const strip = dates.map((d, i) => {
    const n = totals[i] + rows.filter((r) => r.cells[i] === "•").length;
    const lbl = d === today ? `<u>${WEEK_SHORT[i]}</u>` : WEEK_SHORT[i];
    return n ? `${lbl} ${n}` : lbl;
  }).join(" · ");

  let text: string;
  if (mode === "g") {
    // компактная сетка: влезает в ширину телефона
    const W = 9;
    const cut = (n: string) => (n.length > W ? n.slice(0, W - 1) + "…" : n.padEnd(W));
    const head = " ".repeat(W) + dates.map((d, i) => " " + (d === today ? WEEK_SHORT[i].toUpperCase() : WEEK_SHORT[i])).join("");
    const lines = [head];
    for (const [room, rs] of groups) {
      lines.push("", room);
      for (const { p, cells } of rs) lines.push(cut(nameOf(p)) + cells.map((c) => "  " + c).join(""));
    }
    text = `${title}\n<pre>${esc(lines.join("\n"))}</pre>\n<i>${T.weekLegend}</i>`;
  } else {
    // по дням: на каждый день только те, кого поливать, по комнатам
    const blocks: string[] = [];
    dates.forEach((d, i) => {
      const lines: string[] = [];
      for (const [room, rs] of groups) {
        const names = rs.filter((r) => r.cells[i] !== "·")
          .map((r) => r.cells[i] === "•" ? `<s>${esc(nameOf(r.p))}</s>` : esc(nameOf(r.p)));
        if (names.length) lines.push(`<i>${esc(room)}:</i> ${names.join(", ")}`);
      }
      const day = `${WEEK_SHORT[i]} ${Number(d.slice(8))}`;
      if (!lines.length) return;
      blocks.push(`<b>${day}</b>${d === today ? " · сегодня" : ""}\n${lines.join("\n")}`);
    });
    text = `${title}\n${strip}\n\n` +
      (blocks.length ? blocks.join("\n\n") : T.weekEmpty) +
      (blocks.some((x) => x.includes("<s>")) ? `\n<i>${T.weekDoneHint}</i>` : "");
  }

  const nav: Keyboard = [
    [
      ...(offset > 0 ? [b("← раньше", `wk:${offset - 1}:${mode}`)] : []),
      ...(offset < 3 ? [b("дальше →", `wk:${offset + 1}:${mode}`, "primary")] : []),
    ],
    [mode === "g" ? b("по дням", `wk:${offset}:d`, undefined, "week") : b("сеткой", `wk:${offset}:g`, undefined, "week")],
    [b("← сегодня", "today", undefined, "today"), b("сад", "list", undefined, "list")],
  ];
  if (editMid) {
    try { return await edit(chat, editMid, text, nav); } catch (e) { console.error("week edit", e); }
  }
  return send(chat, text, nav);
}
