// сад: список комнат и одна комната
import { b, esc, Keyboard, send } from "../telegram.ts";
import * as D from "../db.ts";
import type { Plant, User } from "../db.ts";
import { WaterStatus } from "../watering.ts";
import { days, LOC_SHORT, plural, T, waterBar } from "../texts.ts";
import { nameOf, roomOf, showScreen, status, weather } from "./common.ts";

// ---------- сад: список комнат

type Row = { p: Plant; st: WaterStatus };

// комнаты в стабильном порядке: как растения легли в базу
function roomsOf(ps: Plant[]): string[] {
  const out: string[] = [];
  for (const p of ps) {
    const r = roomOf(p);
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

const whenShort = (st: WaterStatus) =>
  st.due ? "сегодня" : st.daysLeft === 1 ? "завтра" : `через ${days(st.daysLeft)}`;

const plantLine = ({ p, st }: Row) => `${waterBar(st.progress)}  ${esc(nameOf(p))} · ${whenShort(st)}`;

export async function garden(u: User) {
  const ps = await D.plants(u.telegram_id);
  const w = await weather(u);
  const rows: Row[] = ps.map((p) => ({ p, st: status(u, p, w) }));
  const names = roomsOf(ps);
  const inRoom = (n: string) => rows.filter((r) => roomOf(r.p) === n);
  const dueIn = (n: string) => inRoom(n).filter((r) => r.st.due).length;
  return { ps, rows, names, inRoom, dueIn };
}

export async function list(u: User, chat: number, editMid?: number) {
  const { ps, rows, names, inRoom, dueIn } = await garden(u);
  if (!ps.length) return send(chat, T.emptyCollection);

  // сад как справочник: сначала все комнаты, растения внутри комнаты
  const totalDue = rows.filter((r) => r.st.due).length;
  const out = [T.gardenTitle(ps.length), totalDue ? T.waterToday(totalDue) : T.nothingToday, ""];
  for (const n of names) {
    const cnt = inRoom(n).length;
    out.push(`<b>${esc(n)}</b> · ${cnt} ${plural(cnt, "растение", "растения", "растений")}${dueIn(n) ? ` · ждут ${dueIn(n)}` : ""}`);
  }

  const k: Keyboard = [];
  const roomBtn = (n: string) =>
    b(dueIn(n) ? `${n} · ${dueIn(n)}` : n, `rmv:${names.indexOf(n)}`, dueIn(n) ? "success" : undefined);
  for (let i = 0; i < names.length; i += 2) k.push(names.slice(i, i + 2).map(roomBtn));
  k.push([b("неделя", "wk:0", "primary", "week")]);

  return showScreen(chat, out.join("\n"), k, editMid, "garden");
}

// ---------- одна комната

export async function roomScreen(u: User, chat: number, idx: number, editMid?: number) {
  const { names, inRoom } = await garden(u);
  const name = names[idx];
  if (!name) return list(u, chat, editMid);
  const rows = inRoom(name);
  const due = rows.filter((r) => r.st.due);
  const loc = rows[0]?.p.location;

  const out = [
    `<b>${esc(name)}</b>${loc ? ` · ${LOC_SHORT[loc]}` : ""}`,
    `${rows.length} ${plural(rows.length, "растение", "растения", "растений")}` +
      (due.length ? `, ждут ${due.length}` : ", все политы"),
    "",
    ...rows.map(plantLine),
  ];

  const k: Keyboard = [];
  if (due.length) k.push([b(`полито: ${name} · ${due.length}`, `wrv:${idx}:r`, "success", "water")]);
  for (let i = 0; i < rows.length; i += 2) {
    k.push(rows.slice(i, i + 2).map(({ p, st }) => b(nameOf(p), `p:${p.id}`, st.due ? "success" : undefined)));
  }

  k.push([b("← сад", "list", undefined, "list")]);

  return showScreen(chat, out.join("\n"), k, editMid, "room");
}
