// строка истории растения: дата по часовому поясу пользователя и что случилось.
// чистая функция без базы и сети — её проверяет history_line_test.ts
import { esc } from "../telegram.ts";
import type { PlantEvent } from "../db.ts";
import { localDate } from "../weather.ts";
import { ruDate } from "../texts.ts";

const EVENT_LABEL: Record<string, string> = {
  water: "полито", rain: "дождь", feed: "удобрение", photo: "фото", diagnosis: "диагноз", note: "",
};

export function historyLine(tz: string, e: PlantEvent): string {
  const day = ruDate(localDate(tz, new Date(e.created_at)));
  if (e.kind === "note") return `${day} · <b>${esc(e.note ?? "")}</b>`;
  if (e.kind === "photo" && e.note === "добавлено") return `${day} · добавлено в сад`;
  if (e.kind === "diagnosis") return `${day} · диагноз: <i>${esc((e.note ?? "").split("\n")[0].slice(0, 80))}</i>`;
  return `${day} · ${EVENT_LABEL[e.kind] ?? e.kind}`;
}
