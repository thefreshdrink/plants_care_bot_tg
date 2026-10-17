// карточка растения, «инфо» и история
import { b, esc, Keyboard, send, sendRich } from "../telegram.ts";
import * as D from "../db.ts";
import type { User } from "../db.ts";
import { localDate } from "../weather.ts";
import { getsRain, isOutdoor } from "../watering.ts";
import { days, LOC_SHORT, ruDate, T, waterBar, whenWater } from "../texts.ts";
import { nameOf, photoPreview, roomOf, showScreen, status, weather } from "./common.ts";
import { needsFeed } from "./water.ts";

// ---------- карточка растения

export async function card(u: User, chat: number, id: string, editMid?: number) {
  const p = await D.plant(u.telegram_id, id);
  if (!p) return send(chat, "такого растения нет в коллекции.");
  const w = await weather(u);
  const st = status(u, p, w);

  // карточка отвечает на один вопрос: поливать или нет. всё остальное живёт в «инфо».
  const lines = [
    `<b>${esc(nameOf(p))}</b>`,
    `${esc(roomOf(p))} · ${LOC_SHORT[p.location]}`,
    "",
    `${waterBar(st.progress)}  ${whenWater(st.daysLeft, st.due)}`,
  ];
  if (st.rainExpectedToday && st.due) lines.push("сегодня обещают дождь, можно не поливать");
  if (st.rainedOn) lines.push(`дождь ${ruDate(st.rainedOn)} засчитан как полив`);
  lines.push(`последний полив: ${ruDate(localDate(u.tz, new Date(p.last_watered_at)))}`);

  const fedDue = needsFeed(u, p);
  if (fedDue) lines.push(st.due ? "сегодня полить с удобрением" : "удобрение: со следующим поливом");
  const k: Keyboard = [];
  if (fedDue) {
    k.push([
      b("полито с удобрением", `w:${id}`, "success", "water"),
      b("без удобрения", `wn:${id}`, undefined, "nofeed"),
    ]);
    k.push([b("не сегодня", `snz:${id}`, undefined, "snooze"), b("инфо", `care:${id}`, undefined, "care")]);
  } else {
    k.push([
      b("полито", `w:${id}`, "success", "water"),
      b("не сегодня", `snz:${id}`, undefined, "snooze"),
      b("инфо", `care:${id}`, undefined, "care"),
    ]);
  }
  // дождь поливает только тех, кто под открытым небом: у домашних кнопка не нужна
  if (getsRain(p.location)) k.push([b("был дождь", `rain:c:${id}`, undefined, "rain")]);
  // фото стоит крупно над текстом, а если его нет, предлагаем добавить
  if (!p.photo_file_id) k.push([b("добавить фото", `nph:${id}`, "primary", "photo")]);
  k.push([
    b("история", `hist:${id}`, undefined, "history"),
    b("ещё", `ed:${id}`, undefined, "edit"),
    b("весь сад", "list", undefined, "list"),
  ]);

  const pv = await photoPreview(u, p);
  return showScreen(chat, lines.join("\n"), k, editMid, "card", pv ? { ...pv, above: true, large: true } : undefined);
}

export async function careText(u: User, chat: number, id: string) {
  const p = await D.plant(u.telegram_id, id);
  if (!p) return;
  const c = p.care ?? {};
  const out = isOutdoor(p.location);
  const interval = out
    ? `в жаркие дни раз в ${days(Math.round(p.water_every_days))}, в прохладу реже: бот считает испарение и дождь сам`
    : `летом раз в ${days(Math.round(p.water_every_days))}` +
      (p.water_winter_days ? `, зимой раз в ${days(Math.round(p.water_winter_days))}` : "");

  // шапка: фото блоком над текстом, под ним кто это и какой характер.
  // отдельным сообщением, потому что rich-сообщение ниже превью не принимает.
  const pv = await photoPreview(u, p);
  const head = [
    `<b>${esc(nameOf(p))}</b>`,
    `<i>${esc(p.species ?? "")}</i> · ${esc(roomOf(p))} · ${LOC_SHORT[p.location]}`,
    c.summary ? `\n<i>${esc(c.summary)}</i>` : "",
  ].filter(Boolean).join("\n");
  await send(chat, head, undefined, pv ? { ...pv, above: true } : undefined);

  // разделы: раскрывающийся список, ради него и нужно rich-сообщение
  const det = (title: string, v?: string, open = false) =>
    v ? `<details${open ? " open" : ""}><summary><b>${title}</b></summary><p>${esc(v).replace(/\n/g, "<br/>")}</p></details>` : "";
  const block = (title: string, v?: string) => (v ? `<b>${title}</b>\n${esc(v)}\n` : "");
  const sections: [string, string | undefined, boolean?][] = [
    ["полив", `${c.water_how ?? ""}\n${interval}`, true],
    ["свет", c.light],
    ["подкормка", c.feed_what],
    ["почва", c.soil],
    ["температура", `переносит до ${p.cold_min_c ?? "?"}°${p.heat_sensitive ? ", в сильную жару нужна тень" : ""}`],
    ["для лимассола", c.local_tips],
    ["частые проблемы", c.trouble_signs],
    ["безопасность", c.toxic],
  ];
  const rich = sections.map(([t, v, open]) => det(t, v, open)).join("");
  const plain = sections.map(([t, v]) => block(t, v)).join("\n");
  return sendRich(chat, rich, plain, [[b("← к растению", `p:${id}`, "primary")]]);
}

// ---------- история растения

export const QUICK_NOTES = ["пересажено", "подрезано", "новый лист", "цветёт"];

const EVENT_LABEL: Record<string, string> = {
  water: "полито", rain: "дождь", feed: "удобрение", photo: "фото", diagnosis: "диагноз", note: "",
};

export async function history(u: User, chat: number, id: string, editMid?: number) {
  const p = await D.plant(u.telegram_id, id);
  if (!p) return send(chat, "такого растения нет в коллекции.");
  const evs = await D.plantEvents(u.telegram_id, id);
  const line = (e: D.PlantEvent) => {
    const day = ruDate(localDate(u.tz, new Date(e.created_at)));
    if (e.kind === "note") return `${day} · <b>${esc(e.note ?? "")}</b>`;
    if (e.kind === "photo" && e.note === "добавлено") return `${day} · добавлено в сад`;
    if (e.kind === "diagnosis") return `${day} · диагноз: <i>${esc((e.note ?? "").split("\n")[0].slice(0, 80))}</i>`;
    return `${day} · ${EVENT_LABEL[e.kind] ?? e.kind}`;
  };
  const text = [
    `<b>${esc(nameOf(p))}</b> · история`,
    "",
    evs.length ? evs.map(line).join("\n") : T.historyEmpty,
  ].join("\n");
  const quick: Keyboard = [];
  for (let i = 0; i < QUICK_NOTES.length; i += 2) {
    quick.push(QUICK_NOTES.slice(i, i + 2).map((n, j) => b(n, `hq:${id}:${i + j}`)));
  }
  return showScreen(chat, text, [
    [b("написать заметку", `hn:${id}`, "primary", "note")],
    ...quick,
    [b("← к растению", `p:${id}`)],
  ], editMid, "history");
}
