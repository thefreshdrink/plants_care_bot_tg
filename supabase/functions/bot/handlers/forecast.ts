// погода для сада (/weather)
import { send } from "../telegram.ts";
import type { User } from "../db.ts";
import { sky } from "../weather.ts";
import { homeNav, weather } from "./common.ts";

// ---------- погода

export async function weatherReport(u: User, chat: number) {
  const w = await weather(u);
  const i = w.days.findIndex((d) => d.date === w.today);
  const next = w.days.slice(i, i + 5);
  const short = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const past = w.days.slice(Math.max(0, i - 7), i);
  const rain7 = past.reduce((s, d) => s + d.rain, 0);
  const lines = next.map((d) => {
    const wd = short[new Date(d.date + "T12:00:00Z").getUTCDay()];
    const rain = d.rain >= 1 ? ` · ${Math.round(d.rain)} мм` : "";
    return `${wd} ${Number(d.date.slice(8))}  ${Math.round(d.tmax)}°/${Math.round(d.tmin)}°  ${sky(d.code)}${rain}`;
  });
  const text = [
    "<b>погода для сада</b>",
    "",
    `<code>${lines.join("\n")}</code>`,
    "",
    `испарение сегодня: ${next[0]?.et0.toFixed(1)} мм <i>(сколько воды уходит из почвы за день; в жару 6–7, зимой 1–2)</i>`,
    `дождь за неделю: ${Math.round(rain7)} мм`,
    w.dustToday != null ? `пыль: ${Math.round(w.dustToday)} мкг/м³${w.dustToday >= 150 ? " · сильно" : ""}` : null,
  ].filter((x) => x !== null).join("\n");
  return send(chat, text, homeNav());
}
