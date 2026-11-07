// утренний дайджест, вечернее напоминание и их кнопки
import { b, editKeyboard, esc, Keyboard, send } from "../telegram.ts";
import * as D from "../db.ts";
import type { User } from "../db.ts";
import { sky } from "../weather.ts";
import { getsRain, weatherAlerts } from "../watering.ts";
import { ruDate, T, whenWater } from "../texts.ts";
import { byRoom, nameOf, status, weather } from "./common.ts";
import { needsFeed } from "./water.ts";
import { keyboardAfterPress } from "./digest_keyboard.ts";

// ---------- утренний дайджест

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

// evening: вечернее напоминание — только то, что сегодня ещё не полито, без погоды и предупреждений
export async function digest(u: User, chat: number, manual: boolean, evening = false): Promise<boolean> {
  const ps = await D.plants(u.telegram_id);
  if (!ps.length) {
    if (manual) await send(chat, T.emptyCollection);
    return false;
  }
  const w = await weather(u);
  const today = w.days.find((d) => d.date === w.today);
  const rows = ps.map((p) => ({ p, st: status(u, p, w) }));
  const due = rows.filter((r) => r.st.due);
  const feed = new Set(ps.filter((p) => needsFeed(u, p)).map((p) => p.id));
  const alerts = evening ? [] : weatherAlerts(w, ps, nameOf);

  // подкормка без полива не повод писать: она подождёт ближайшего полива
  if (!manual && !due.length && !alerts.length) return false; // тихий день, не пишем
  if (evening && !due.length) return false; // к вечеру всё полито, не пишем

  const wd = WEEKDAYS[new Date(w.today + "T12:00:00Z").getUTCDay()];
  const out: string[] = [evening ? `<b>${T.eveningHead}</b>` : `<b>${wd}, ${ruDate(w.today)}</b>`];
  if (today && !evening) {
    out.push(
      `${Math.round(today.tmax)}° / ${Math.round(today.tmin)}° · ${sky(today.code)}` +
        (today.rain >= 1 ? ` · дождь ${Math.round(today.rain)} мм` : ""),
    );
  }

  if (due.length) {
    out.push("", evening ? `<b>${T.eveningDue}</b>` : "<b>полить</b>");
    for (const [room, rows] of byRoom(due)) {
      out.push(`<i>${esc(room)}</i>`);
      for (const { p, st } of rows) {
        let note = "";
        if (feed.has(p.id)) note = " · с удобрением";
        if (st.rainExpectedToday) note += " · обещают дождь, можно подождать";
        else if (st.reason === "heat") note += " · раньше срока из-за жары";
        else if (st.reason === "overdue") note += " · давно не поливали";
        out.push(`  ${esc(nameOf(p))}${note ? `<i>${note}</i>` : ""}`);
      }
    }
  } else {
    const next = rows.sort((a, b) => a.st.daysLeft - b.st.daysLeft)[0];
    out.push("", T.nothingToday);
    if (next) out.push(`<i>следующий: ${esc(nameOf(next.p))}, ${whenWater(next.st.daysLeft, false).replace("полив ", "")}</i>`);
  }

  for (const a of alerts) {
    out.push("", `<b>${esc(a.title)}</b>`, esc(a.text));
    if (a.plants.length) out.push(`<i>касается: ${a.plants.map(esc).join(", ")}</i>`);
  }

  const k: Keyboard = [];
  for (const [room, rows] of byRoom(due)) {
    if (rows.length > 1 && new TextEncoder().encode(`wr:${room}`).length <= 64) {
      k.push([b(`полито: ${room} · ${rows.length}`, `wr:${room}`, "success", "water", `${room} · ${rows.length}`)]);
    }
    for (const { p } of rows) {
      // кнопка полива всегда первая в ряду: по ней digestUpdateKeyboard убирает ряд целиком
      const plus = feed.has(p.id) ? " + удобрение" : "";
      const row = [b(`полито: ${nameOf(p)}${plus}`, `wd:${p.id}`, undefined, "water", `${nameOf(p)}${plus}`)];
      if (feed.has(p.id)) row.push(b("без", `wdn:${p.id}`, undefined, "nofeed"));
      k.push(row);
    }
  }
  if (due.length > 1) k.push([b("всё полито", "wall", "success", "water")]);
  if (ps.some((p) => getsRain(p.location))) k.push([b("был дождь", "rain:d", undefined, "rain")]);

  await send(chat, out.join("\n"), k.length ? k : undefined);
  return true;
}

// убираем нажатую кнопку из дайджеста, чтобы было видно, что осталось
export async function digestUpdateKeyboard(cb: any, chat: number, mid: number, pressed: string, alsoRemove: string[]) {
  const old: Keyboard = cb.message.reply_markup?.inline_keyboard ?? [];
  return editKeyboard(chat, mid, keyboardAfterPress(old, pressed, alsoRemove));
}
