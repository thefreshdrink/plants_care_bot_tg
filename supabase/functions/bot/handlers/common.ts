// общие помощники обработчиков: имена, комнаты, погода, статус полива, показ экрана, превью фото
import * as tgm from "../telegram.ts";
import { b, draft, edit, Keyboard, Preview, send } from "../telegram.ts";
import * as D from "../db.ts";
import type { Plant, User } from "../db.ts";
import { fetchWeather, localDate, Weather } from "../weather.ts";
import { waterStatus, WaterStatus } from "../watering.ts";
import { LOC_SHORT } from "../texts.ts";

// ---------- утилиты

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

// печатает ответ claude на глазах и потом отправляет его целиком
export function streamer(chat: number) {
  const id = Math.floor(Math.random() * 2_000_000_000) + 1;
  let last = 0;
  draft(chat, id, "");
  return (t: string) => {
    const now = Date.now();
    if (now - last < 600) return;
    last = now;
    draft(chat, id, t);
  };
}

// погода кешируется на время одного запроса
const wxCache = new Map<string, Promise<Weather>>();
export function weather(u: User): Promise<Weather> {
  const k = `${u.lat},${u.lon},${u.tz}`;
  if (!wxCache.has(k)) {
    const p = fetchWeather(u.lat, u.lon, u.tz);
    p.catch(() => wxCache.delete(k));
    wxCache.set(k, p);
  }
  return wxCache.get(k)!;
}

export function status(u: User, p: Plant, w: Weather): WaterStatus {
  return waterStatus(p, w, localDate(u.tz, new Date(p.last_watered_at)));
}

export async function photoOf(fileId: string) {
  const { bytes, mime } = await tgm.download(fileId);
  return { bytes, mime, base64: tgm.toBase64(bytes) };
}

// строка «куда дальше» для экранов, у которых своих кнопок нет
export const homeNav = (): Keyboard => [[b("сегодня", "today", undefined, "today"), b("сад", "list", undefined, "list")]];

// правим сообщение на месте, а если это не выходит (например, под фото), шлём новое
export async function showScreen(chat: number, text: string, k: Keyboard, editMid: number | undefined, what: string, pv?: Preview) {
  if (editMid) {
    try { return await edit(chat, editMid, text, k, pv); } catch (e) { console.error(`${what} edit`, e); }
  }
  return send(chat, text, k, pv);
}

// превью берёт ссылку прямо на файл в хранилище: так блок с картинкой работает, проверено.
// копия в хранилище может отсутствовать у растений, которым фото меняли раньше, — заводим её здесь же.
export async function photoPreview(u: User, p: Plant): Promise<Preview | undefined> {
  if (!p.photo_file_id) return undefined;
  let path = p.photo_path;
  try {
    if (!path) {
      const img = await tgm.download(p.photo_file_id);
      path = `${u.telegram_id}/${p.id}.jpg`;
      await D.db.storage.from("plants").upload(path, img.bytes, { contentType: img.mime, upsert: true });
      await D.updatePlant(u.telegram_id, p.id, { photo_path: path });
    }
    const { data } = await D.db.storage.from("plants").createSignedUrl(path, 86_400);
    return data?.signedUrl ? { url: data.signedUrl } : undefined;
  } catch (e) {
    console.error("photo preview", e);
    return undefined;
  }
}
