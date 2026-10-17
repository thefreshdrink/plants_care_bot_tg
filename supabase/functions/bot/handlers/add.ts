// добавление растения: определение по фото, выбор вида, комнаты, места, имени, последнего полива
import * as tgm from "../telegram.ts";
import { b, edit, esc, Keyboard, send, typing } from "../telegram.ts";
import * as D from "../db.ts";
import type { Plant, User } from "../db.ts";
import * as C from "../claude.ts";
import { plantnetEnabled, plantnetIdentify } from "../plantnet.ts";
import { T } from "../texts.ts";
import { nameOf, photoOf } from "./common.ts";
import { card } from "./card.ts";

// ---------- добавление растения

// определить растение по фото. id: просто узнать (и по желанию добавить), add: сразу к добавлению в сад
export async function identifyPhoto(u: User, chat: number, data: Record<string, any>, mode: "id" | "add", mid: number) {
  await edit(chat, mid, T.identifying);
  await typing(chat);
  const img = await photoOf(data.photo);
  let candidates: C.Candidate[] = [];
  let isPlant = true;
  // определяет claude; pl@ntnet только запасной, если claude упал
  try {
    ({ isPlant, candidates } = await C.identify(img, data.caption));
  } catch (e) {
    if (!plantnetEnabled) throw e;
    console.error("identify", e);
    candidates = await plantnetIdentify(img.bytes, img.mime).catch(() => []);
  }
  if (!isPlant || !candidates.length) return edit(chat, mid, T.notAPlant);
  await D.saveSession(u.telegram_id, { state: null, data: { ...data, candidates } });

  if (mode === "id") {
    const lines = candidates.map((c, i) =>
      `${i === 0 ? "<b>" : ""}${esc(c.common)}${i === 0 ? "</b>" : ""} · <i>${esc(c.latin)}</i> · ${Math.round(c.confidence * 100)}%`
    );
    // сразу варианты: выбрать верный и добавить, написать свой или не добавлять вовсе
    const k = candidateButtons(candidates);
    k.push([b("не добавлять в сад", "noadd")]);
    return edit(chat, mid, `${lines.join("\n")}\n\n${T.idAddHint}`, k);
  }
  return edit(chat, mid, T.pickCandidate, candidateButtons(candidates));
}

export async function diagPlantRows(uid: number): Promise<Keyboard> {
  const ps = await D.plants(uid);
  const rows: Keyboard = ps.map((p) => [b(nameOf(p), `dgp:${p.id}`)]);
  rows.push([b("его нет в коллекции", "dgp:none")]);
  return rows;
}

export function candidateButtons(cs: C.Candidate[]): Keyboard {
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

export async function askRoom(u: User, chat: number, data: Record<string, any>, mid?: number) {
  const rooms = await D.rooms(u.telegram_id);
  await D.saveSession(u.telegram_id, { state: null, data: { ...data, rooms } });
  const k: Keyboard = [];
  for (let i = 0; i < rooms.length; i += 2) k.push(rooms.slice(i, i + 2).map((r, j) => b(r, `rm:${i + j}`)));
  k.push([b("новая комната", "rm:new", "primary")]);
  const text = T.askRoom(data.chosen.common);
  return mid ? edit(chat, mid, text, k) : send(chat, text, k);
}

export async function askLocation(u: User, chat: number, data: Record<string, any>, mid?: number) {
  await D.saveSession(u.telegram_id, { state: null, data });
  const text = T.askLocation(data.room ? `${data.chosen.common} · ${data.room}` : data.chosen.common);
  const k = locationButtons((l) => `loc:${l}`);
  return mid ? edit(chat, mid, text, k) : send(chat, text, k);
}

export async function askLastWatered(u: User, chat: number, data: Record<string, any>, mid?: number) {
  await D.saveSession(u.telegram_id, { state: null, data });
  const text = "когда поливала последний раз?";
  const k: Keyboard = [
    [b("сегодня", "lw:0"), b("вчера", "lw:1")],
    [b("пару дней назад", "lw:3"), b("неделю назад", "lw:7")],
    [b("не помню", "lw:99")],
  ];
  return mid ? edit(chat, mid, text, k) : send(chat, text, k);
}

export function careColumns(c: C.Care): Partial<Plant> {
  return {
    common_name: c.common_name,
    water_every_days: Math.max(0.5, Number(c.water_every_days) || 7),
    water_winter_days: c.water_winter_days ? Number(c.water_winter_days) : null,
    feed_every_days: c.feed_every_days ? Math.round(Number(c.feed_every_days)) : null,
    cold_min_c: Number.isFinite(Number(c.cold_min_c)) ? Number(c.cold_min_c) : null,
    heat_sensitive: !!c.heat_sensitive,
  };
}

export async function finishAdd(u: User, chat: number, data: Record<string, any>, mid: number) {
  const uid = u.telegram_id;
  await edit(chat, mid, T.writingCard);
  await typing(chat);
  const { latin, common } = data.chosen;
  const care = await C.careCard(latin, common, data.location, C.locationRu(data.location));

  // «не помню» = считаем, что полить надо уже сегодня
  const ago = data.lastWateredDaysAgo === 99 ? 60 : data.lastWateredDaysAgo;
  const lastWatered = new Date(Date.now() - ago * 86_400_000).toISOString();

  const { data: row, error } = await D.db.from("plants").insert({
    user_id: uid,
    nickname: data.nickname,
    room: data.room ?? null,
    species: latin,
    location: data.location,
    photo_file_id: data.photo,
    care,
    last_watered_at: lastWatered,
    ...careColumns(care),
  }).select().single();
  if (error) throw error;

  // копия фото в хранилище supabase (пригодится для mini app)
  try {
    const img = await tgm.download(data.photo);
    const path = `${uid}/${row.id}.jpg`;
    await D.db.storage.from("plants").upload(path, img.bytes, { contentType: img.mime, upsert: true });
    await D.updatePlant(uid, row.id, { photo_path: path });
  } catch (e) { console.error("storage", e); }

  await D.logEvent(uid, row.id, "photo", "добавлено", data.photo);
  await D.saveSession(uid, { state: null, data: {} });
  await edit(chat, mid, T.added(nameOf(row)));
  return card(u, chat, row.id);
}
