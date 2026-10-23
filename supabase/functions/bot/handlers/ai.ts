// ответы claude: диагностика по фото и свободный чат
import { b, edit, esc, Keyboard, send, typing } from "../telegram.ts";
import * as D from "../db.ts";
import type { User } from "../db.ts";
import * as C from "../claude.ts";
import { localDate, sky } from "../weather.ts";
import { LOC_SHORT, ruDate, T, whenWater } from "../texts.ts";
import { nameOf, photoOf, roomOf, status, streamer, weather } from "./common.ts";

// ---------- диагностика

export async function diagnose(u: User, chat: number, fileId: string, plantId: string | null, question?: string, mid?: number) {
  await typing(chat);
  const img = await photoOf(fileId);
  let ctx = "растение не из коллекции.";
  if (plantId) {
    const p = await D.plant(u.telegram_id, plantId);
    if (p) {
      ctx = `растение: ${nameOf(p)} (${p.species}). где: ${C.locationRu(p.location)}. ` +
        `последний полив: ${ruDate(localDate(u.tz, new Date(p.last_watered_at)))}. ` +
        `поливать: примерно раз в ${p.water_every_days} дн. в жару.`;
    }
  }
  const w = await weather(u);
  const i = w.days.findIndex((d) => d.date === w.today);
  const week = w.days.slice(Math.max(0, i - 7), i + 1);
  const wctx = week.map((d) => `${d.date}: ${Math.round(d.tmax)}/${Math.round(d.tmin)}°, дождь ${d.rain} мм`).join("; ");

  const answerText = await C.diagnose(img, ctx, wctx, question, streamer(chat));
  if (plantId) await D.logEvent(u.telegram_id, plantId, "diagnosis", answerText, fileId);
  const k: Keyboard | undefined = plantId ? [[b("к карточке", `p:${plantId}`, "primary")]] : undefined;
  return mid ? edit(chat, mid, esc(answerText), k) : send(chat, esc(answerText), k);
}

// ---------- свободный чат

export async function freeChat(u: User, chat: number, text: string, history: any[]) {
  await typing(chat);
  const ps = await D.plants(u.telegram_id);
  const w = await weather(u);
  const i = w.days.findIndex((d) => d.date === w.today);
  const plantsCtx = ps.map((p) => {
    const st = status(u, p, w);
    return `- ${nameOf(p)} (${p.species}), ${roomOf(p)}, ${LOC_SHORT[p.location]}, ${whenWater(st.daysLeft, st.due)}, переносит до ${p.cold_min_c}°`;
  }).join("\n") || "коллекция пока пустая";
  const wx = w.days.slice(i, i + 4)
    .map((d) => `${d.date}: ${Math.round(d.tmax)}/${Math.round(d.tmin)}°, ${sky(d.code)}, дождь ${d.rain} мм`).join("\n");
  const ctx = `сегодня ${w.today}.\n\nколлекция:\n${plantsCtx}\n\nпрогноз:\n${wx}\n\n${T.botGuide}`;

  const msgs = [...history.slice(-10), { role: "user", content: text }];
  const reply = await C.chat(msgs, ctx, streamer(chat));
  await D.saveSession(u.telegram_id, { history: [...msgs, { role: "assistant", content: reply }].slice(-12) });
  return send(chat, esc(reply));
}
