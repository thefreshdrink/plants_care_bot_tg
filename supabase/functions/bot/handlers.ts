// вся логика диалога
import * as tgm from "./telegram.ts";
import { answer, b, draft, edit, editKeyboard, esc, Keyboard, Preview, send, sendPhoto, sendWelcome, sendRich, setIcons, syncCommands, typing } from "./telegram.ts";
import * as D from "./db.ts";
import type { Plant, User } from "./db.ts";
import * as C from "./claude.ts";
import { plantnetEnabled, plantnetIdentify } from "./plantnet.ts";
import { fetchWeather, localDate, sky, Weather } from "./weather.ts";
import { addDays, feedDue, getsRain, isOutdoor, projectWaterDays, waterStatus, WaterStatus, weatherAlerts } from "./watering.ts";
import { COMMANDS, days, LOC_SHORT, plural, ruDate, T, waterBar, WEEK_SHORT, whenWater } from "./texts.ts";

// ---------- утилиты

const nameOf = (p: Plant) => p.nickname || p.common_name || p.species || "растение";
const roomOf = (p: Plant) => p.room || LOC_SHORT[p.location].split(" · ")[0];

// группировка по комнатам с сохранением порядка
function byRoom<T extends { p: Plant }>(rows: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = roomOf(r.p);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return [...m.entries()];
}

// печатает ответ claude на глазах и потом отправляет его целиком
function streamer(chat: number) {
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
function weather(u: User): Promise<Weather> {
  const k = `${u.lat},${u.lon},${u.tz}`;
  if (!wxCache.has(k)) {
    const p = fetchWeather(u.lat, u.lon, u.tz);
    p.catch(() => wxCache.delete(k));
    wxCache.set(k, p);
  }
  return wxCache.get(k)!;
}

function status(u: User, p: Plant, w: Weather): WaterStatus {
  return waterStatus(p, w, localDate(u.tz, new Date(p.last_watered_at)));
}

async function photoOf(fileId: string) {
  const { bytes, mime } = await tgm.download(fileId);
  return { bytes, mime, base64: tgm.toBase64(bytes) };
}

// ---------- точка входа для апдейтов телеграма

export async function handleUpdate(update: any) {
  const msg = update.message;
  const cb = update.callback_query;
  const from = msg?.from ?? cb?.from;
  const chat: number | undefined = msg?.chat?.id ?? cb?.message?.chat?.id;
  if (!from || !chat) return;

  const u = await D.authorize(from.id, from.first_name ?? "");
  if (!u) {
    if (cb) await answer(cb.id, T.notOwner);
    else await send(chat, T.notOwner);
    return;
  }

  setIcons(await D.icons(u.telegram_id).catch(() => ({})));
  syncCommands(COMMANDS);
  try {
    if (cb) await onCallback(u, chat, cb);
    else if (msg) await onMessage(u, chat, msg);
  } catch (e) {
    console.error(e);
    if (cb) await answer(cb.id);
    await send(chat, T.error).catch(() => {});
  }
}

// ---------- сообщения

async function onMessage(u: User, chat: number, msg: any) {
  const uid = u.telegram_id;
  const s = await D.getSession(uid);

  if (msg.photo?.length) {
    const fileId = msg.photo.at(-1).file_id; // самое большое разрешение
    if (s.state === "await_new_photo" && s.data.plant_id) {
      await D.updatePlant(uid, s.data.plant_id, { photo_file_id: fileId });
      await D.logEvent(uid, s.data.plant_id, "photo", undefined, fileId);
      await D.saveSession(uid, { state: null, data: {} });
      return card(u, chat, s.data.plant_id);
    }
    if (s.state === "await_diag_photo" && s.data.plant_id) {
      await D.saveSession(uid, { state: null, data: {} });
      return diagnose(u, chat, fileId, s.data.plant_id, msg.caption);
    }
    await D.saveSession(uid, { state: null, data: { photo: fileId, caption: msg.caption ?? null } });
    return send(chat, T.photoWhat, [
      [b("добавить в коллекцию", "ph:add", "success")],
      [b("просто узнать, что это", "ph:id", "primary")],
      [b("что с ним не так", "ph:diag", undefined, "diag")],
    ]);
  }

  const text: string = (msg.text ?? "").trim();
  if (!text) return;

  if (text.startsWith("/")) {
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    await D.saveSession(uid, { state: null });
    switch (cmd) {
      case "/start": case "/help": case "/menu": return sendWelcome(chat, T.welcome(u.first_name ?? ""));
      case "/week": return week(u, chat, 0);
      case "/today": return digest(u, chat, true);
      case "/plants": return list(u, chat);
      case "/weather": return weatherReport(u, chat);
      case "/settings": return settings(u, chat);
    }
  }

  switch (s.state) {
    case "await_species_text":
      return askRoom(u, chat, { ...s.data, chosen: { latin: text, common: text } });
    case "await_room_new":
      return askLocation(u, chat, { ...s.data, room: text.toLowerCase().slice(0, 30) });
    case "await_room_edit":
      await D.updatePlant(uid, s.data.plant_id, { room: text.toLowerCase().slice(0, 30) });
      await D.saveSession(uid, { state: null, data: {} });
      return card(u, chat, s.data.plant_id);
    case "await_nickname":
      return askLastWatered(u, chat, { ...s.data, nickname: text.slice(0, 40) });
    case "await_rename":
      await D.updatePlant(uid, s.data.plant_id, { nickname: text.slice(0, 40) });
      await D.saveSession(uid, { state: null, data: {} });
      return card(u, chat, s.data.plant_id);
  }

  return freeChat(u, chat, text, s.history ?? []);
}

// ---------- кнопки

async function onCallback(u: User, chat: number, cb: any) {
  const uid = u.telegram_id;
  const data: string = cb.data ?? "";
  const mid: number = cb.message.message_id;
  const [cmd, a, arg2] = data.split(":");
  const s = await D.getSession(uid);

  switch (cmd) {
    // --- фото: что с ним делать
    case "ph": {
      if (!s.data.photo) { await answer(cb.id, "фото потерялось, пришли ещё раз"); return; }
      await answer(cb.id);
      if (a === "diag") {
        const ps = await D.plants(uid);
        const rows: Keyboard = ps.map((p) => [b(nameOf(p), `dgp:${p.id}`)]);
        rows.push([b("его нет в коллекции", "dgp:none")]);
        return edit(chat, mid, T.pickPlantForDiagnosis, rows);
      }
      await edit(chat, mid, T.identifying);
      await typing(chat);
      const img = await photoOf(s.data.photo);
      let candidates: C.Candidate[] = [];
      let isPlant = true;
      if (plantnetEnabled) candidates = await plantnetIdentify(img.bytes, img.mime).catch(() => []);
      if (!candidates.length) ({ isPlant, candidates } = await C.identify(img));
      if (!isPlant || !candidates.length) return edit(chat, mid, T.notAPlant);
      await D.saveSession(uid, { data: { ...s.data, candidates } });

      if (a === "id") {
        const lines = candidates.map((c, i) =>
          `${i === 0 ? "<b>" : ""}${esc(c.common)}${i === 0 ? "</b>" : ""} · <i>${esc(c.latin)}</i> · ${Math.round(c.confidence * 100)}%`
        );
        return edit(chat, mid, lines.join("\n"), [[b("добавить в коллекцию", "ph2:add", "success")]]);
      }
      return edit(chat, mid, T.pickCandidate, candidateButtons(candidates));
    }
    case "ph2": {
      await answer(cb.id);
      return edit(chat, mid, T.pickCandidate, candidateButtons(s.data.candidates ?? []));
    }

    // --- выбор вида
    case "cand": {
      await answer(cb.id);
      if (a === "x") {
        await D.saveSession(uid, { state: "await_species_text" });
        return edit(chat, mid, T.typeNameInstead);
      }
      const c = s.data.candidates?.[Number(a)];
      if (!c) return;
      return askRoom(u, chat, { ...s.data, chosen: { latin: c.latin, common: c.common } }, mid);
    }
    case "loc": {
      await answer(cb.id);
      await D.saveSession(uid, { state: "await_nickname", data: { ...s.data, location: a } });
      return edit(chat, mid, T.askNickname, [[b("без имени", "nick:skip")]]);
    }
    case "rm": {
      await answer(cb.id);
      if (a === "new") {
        await D.saveSession(uid, { state: "await_room_new" });
        return edit(chat, mid, T.newRoomAsk);
      }
      const room: string | undefined = s.data.rooms?.[Number(a)];
      if (!room) return;
      const loc = await D.roomLocation(uid, room);
      const data = { ...s.data, room };
      if (!loc) return askLocation(u, chat, data, mid);
      await D.saveSession(uid, { state: "await_nickname", data: { ...data, location: loc } });
      return edit(chat, mid, T.askNickname, [[b("без имени", "nick:skip")]]);
    }
    case "rme": {
      await answer(cb.id);
      if (a === "new") {
        await D.saveSession(uid, { state: "await_room_edit", data: { plant_id: arg2 } });
        return edit(chat, mid, T.newRoomAsk);
      }
      const room = (await D.rooms(uid))[Number(a)];
      if (room) await D.updatePlant(uid, arg2, { room });
      return card(u, chat, arg2, mid);
    }
    case "rmpick": {
      await answer(cb.id);
      const rs = await D.rooms(uid);
      const rows: Keyboard = rs.map((r, i) => [b(r, `rme:${i}:${a}`)]);
      rows.push([b("новая комната", `rme:new:${a}`, "primary")]);
      return edit(chat, mid, "в какую комнату?", rows);
    }
    case "wk": await answer(cb.id); return week(u, chat, Number(a), mid, arg2 === "g" ? "g" : "d");
    case "wr": {
      const room = data.slice(3);
      const w = await weather(u);
      const due = (await D.plants(uid)).filter((p) => roomOf(p) === room && status(u, p, w).due);
      for (const p of due) await water(u, p);
      await answer(cb.id, `полито: ${room}`);
      return digestUpdateKeyboard(cb, chat, mid, data, due.map((p) => `wd:${p.id}`));
    }

    case "nick": {
      await answer(cb.id);
      return askLastWatered(u, chat, { ...s.data, nickname: null }, mid);
    }
    case "lw": {
      await answer(cb.id);
      return finishAdd(u, chat, { ...s.data, lastWateredDaysAgo: Number(a) }, mid);
    }

    // --- коллекция и карточка
    case "today": await answer(cb.id); await digest(u, chat, true); return;
    case "list": await answer(cb.id); return list(u, chat, mid);
    case "rmv": await answer(cb.id); return roomScreen(u, chat, Number(a), mid);
    case "wrv": {
      const g = await garden(u);
      const name = g.names[Number(a)];
      if (!name) return answer(cb.id);
      for (const r of g.inRoom(name).filter((x) => x.st.due)) await water(u, r.p);
      await answer(cb.id, `полито: ${name}`);
      return arg2 === "r" ? roomScreen(u, chat, Number(a), mid) : list(u, chat, mid);
    }
    case "p": await answer(cb.id); return card(u, chat, a);
    case "care": await answer(cb.id); return careText(u, chat, a);
    case "pho": {
      await answer(cb.id);
      const p = await D.plant(uid, a);
      if (!p?.photo_file_id) return;
      return sendPhoto(chat, p.photo_file_id, `<b>${esc(nameOf(p))}</b>`, [[b("← к растению", `p:${a}`, "primary")]]);
    }

    case "w": case "wd": {
      const p = await D.plant(uid, a);
      if (!p) return answer(cb.id);
      await water(u, p);
      await answer(cb.id, T.watered(nameOf(p)));
      if (cmd === "w") return card(u, chat, a, mid);
      return digestUpdateKeyboard(cb, chat, mid, data, []);
    }
    case "wall": {
      const w = await weather(u);
      const due = (await D.plants(uid)).filter((p) => status(u, p, w).due);
      for (const p of due) await water(u, p);
      await answer(cb.id, "всё полито");
      return editKeyboard(chat, mid, []);
    }
    case "rain": {
      // rain:d из дайджеста, rain:c:<id> из карточки
      const wet = await rainWater(u);
      await answer(cb.id, "засчитала дождь как полив");
      if (a === "c") return card(u, chat, arg2, mid);
      return digestUpdateKeyboard(cb, chat, mid, data, wet.map((p) => `wd:${p.id}`));
    }
    case "f": case "fd": {
      const p = await D.plant(uid, a);
      if (!p) return answer(cb.id);
      await D.updatePlant(uid, a, { last_fed_at: new Date().toISOString() });
      await D.logEvent(uid, a, "feed");
      await answer(cb.id, T.fed(nameOf(p)));
      if (cmd === "f") return card(u, chat, a, mid);
      return digestUpdateKeyboard(cb, chat, mid, data, []);
    }
    case "snz": {
      const tomorrow = localDate(u.tz, new Date(Date.now() + 86_400_000));
      await D.updatePlant(uid, a, { snoozed_until: tomorrow });
      await answer(cb.id, "напомню завтра");
      return card(u, chat, a, mid);
    }
    case "more": case "less": {
      const p = await D.plant(uid, a);
      if (!p) return answer(cb.id);
      const k = cmd === "more" ? 0.8 : 1.25; // чаще = интервал короче
      const next = Math.max(0.5, Math.round(p.water_every_days * k * 2) / 2);
      const patch: Partial<Plant> = { water_every_days: next };
      if (p.water_winter_days) patch.water_winter_days = Math.max(1, Math.round(p.water_winter_days * k * 2) / 2);
      await D.updatePlant(uid, a, patch);
      await answer(cb.id, cmd === "more" ? "буду напоминать чаще" : "буду напоминать реже");
      return card(u, chat, a, mid);
    }
    case "dg": {
      await answer(cb.id);
      await D.saveSession(uid, { state: "await_diag_photo", data: { plant_id: a } });
      const p = await D.plant(uid, a);
      return send(chat, T.diagnosePhoto(p ? nameOf(p) : ""));
    }
    case "dgp": {
      await answer(cb.id);
      if (!s.data.photo) return;
      await edit(chat, mid, T.diagnosing);
      await D.saveSession(uid, { state: null, data: {} });
      return diagnose(u, chat, s.data.photo, a === "none" ? null : a, s.data.caption, mid);
    }

    // --- редактирование
    case "ed": {
      await answer(cb.id);
      const p = await D.plant(uid, a);
      if (!p) return;
      return showScreen(chat, T.moreWhat(nameOf(p)), [
        [b("чаще", `more:${a}`, undefined, "more"), b("реже", `less:${a}`, undefined, "less")],
        [b("что с ним", `dg:${a}`, "primary", "diag")],
        [b("переименовать", `rn:${a}`), b("комната", `rmpick:${a}`)],
        [b("дом или улица", `mv:${a}`), b("обновить фото", `nph:${a}`)],
        [b("убрать из сада", `del:${a}`, "danger")],
        [b("← к растению", `p:${a}`)],
      ], mid, "more");
    }
    case "rn": {
      await answer(cb.id);
      await D.saveSession(uid, { state: "await_rename", data: { plant_id: a } });
      return edit(chat, mid, T.renameAsk);
    }
    case "mv": {
      await answer(cb.id);
      return edit(chat, mid, "куда переехало?", locationButtons((l) => `mvl:${l}:${a}`));
    }
    case "mvl": {
      await answer(cb.id, "переехало");
      // при переезде между домом и улицей интервалы другие, поэтому пересчитываем карточку
      const p = await D.plant(uid, arg2);
      if (!p) return;
      await edit(chat, mid, T.writingCard);
      const care = await C.careCard(p.species ?? p.common_name ?? "", p.common_name ?? "", a, C.locationRu(a));
      await D.updatePlant(uid, arg2, { location: a as Plant["location"], ...careColumns(care), care });
      return card(u, chat, arg2, mid);
    }
    case "nph": {
      await answer(cb.id);
      await D.saveSession(uid, { state: "await_new_photo", data: { plant_id: a } });
      return edit(chat, mid, "пришли новое фото.");
    }
    case "del": {
      await answer(cb.id);
      return edit(chat, mid, "точно убрать? история сохранится.", [[
        b("да, убрать", `delok:${a}`, "danger"),
        b("нет", `p:${a}`),
      ]]);
    }
    case "delok": {
      const p = await D.plant(uid, a);
      // не удаляем: каскад стёр бы всю историю в events
      await D.updatePlant(uid, a, { archived: true });
      await answer(cb.id);
      return edit(chat, mid, T.deleted(p ? nameOf(p) : ""));
    }

    // --- настройки
    case "hr": {
      const h = Number(a);
      await D.db.from("users").update({ digest_hour: h }).eq("telegram_id", uid);
      await answer(cb.id);
      return edit(chat, mid, T.settingsSaved(h));
    }
  }
  await answer(cb.id);
}

// ---------- добавление растения

function candidateButtons(cs: C.Candidate[]): Keyboard {
  const rows: Keyboard = cs.map((c, i) => [b(`${c.common} · ${Math.round(c.confidence * 100)}%`, `cand:${i}`, i === 0 ? "primary" : undefined)]);
  rows.push([b("ни то, напишу сама", "cand:x")]);
  return rows;
}

function locationButtons(cb: (l: string) => string): Keyboard {
  return [
    [b("дом", cb("indoor")), b("балкон под крышей", cb("covered"))],
    [b("улица · горшок", cb("outdoor_pot")), b("улица · грунт", cb("outdoor_ground"))],
  ];
}

async function askRoom(u: User, chat: number, data: Record<string, any>, mid?: number) {
  const rooms = await D.rooms(u.telegram_id);
  await D.saveSession(u.telegram_id, { state: null, data: { ...data, rooms } });
  const k: Keyboard = [];
  for (let i = 0; i < rooms.length; i += 2) k.push(rooms.slice(i, i + 2).map((r, j) => b(r, `rm:${i + j}`)));
  k.push([b("новая комната", "rm:new", "primary")]);
  const text = T.askRoom(data.chosen.common);
  return mid ? edit(chat, mid, text, k) : send(chat, text, k);
}

async function askLocation(u: User, chat: number, data: Record<string, any>, mid?: number) {
  await D.saveSession(u.telegram_id, { state: null, data });
  const text = T.askLocation(data.room ? `${data.chosen.common} · ${data.room}` : data.chosen.common);
  const k = locationButtons((l) => `loc:${l}`);
  return mid ? edit(chat, mid, text, k) : send(chat, text, k);
}

async function askLastWatered(u: User, chat: number, data: Record<string, any>, mid?: number) {
  await D.saveSession(u.telegram_id, { state: null, data });
  const text = "когда поливала последний раз?";
  const k: Keyboard = [
    [b("сегодня", "lw:0"), b("вчера", "lw:1")],
    [b("пару дней назад", "lw:3"), b("неделю назад", "lw:7")],
    [b("не помню", "lw:99")],
  ];
  return mid ? edit(chat, mid, text, k) : send(chat, text, k);
}

function careColumns(c: C.Care): Partial<Plant> {
  return {
    common_name: c.common_name,
    water_every_days: Math.max(0.5, Number(c.water_every_days) || 7),
    water_winter_days: c.water_winter_days ? Number(c.water_winter_days) : null,
    feed_every_days: c.feed_every_days ? Math.round(Number(c.feed_every_days)) : null,
    cold_min_c: Number.isFinite(Number(c.cold_min_c)) ? Number(c.cold_min_c) : null,
    heat_sensitive: !!c.heat_sensitive,
  };
}

async function finishAdd(u: User, chat: number, data: Record<string, any>, mid: number) {
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

// ---------- карточка растения

async function card(u: User, chat: number, id: string, editMid?: number) {
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

  const fedDue = !!p.feed_every_days && feedDue(
    p, w.today,
    p.last_fed_at ? localDate(u.tz, new Date(p.last_fed_at)) : null,
    localDate(u.tz, new Date(p.created_at)),
  );
  const k: Keyboard = [];
  if (fedDue) k.push([b("подкормлено", `f:${id}`, "success", "feed")]);
  k.push([
    b("полито", `w:${id}`, "success", "water"),
    b("не сегодня", `snz:${id}`, undefined, "snooze"),
    b("инфо", `care:${id}`, undefined, "care"),
  ]);
  if ((await D.plants(u.telegram_id)).some((x) => getsRain(x.location))) k.push([b("был дождь", `rain:c:${id}`)]);
  const nav = [b("ещё", `ed:${id}`, undefined, "edit"), b("весь сад", "list", undefined, "list")];
  if (p.photo_file_id) nav.unshift(b("фото", `pho:${id}`));
  k.push(nav);

  return showScreen(chat, lines.join("\n"), k, editMid, "card", await photoPreview(u, p));
}

async function careText(u: User, chat: number, id: string) {
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

async function water(u: User, p: Plant, kind: "water" | "rain" = "water") {
  await D.updatePlant(u.telegram_id, p.id, { last_watered_at: new Date().toISOString(), snoozed_until: null });
  await D.logEvent(u.telegram_id, p.id, kind);
}

// дождь поливает всех, кто под открытым небом
async function rainWater(u: User): Promise<Plant[]> {
  const wet = (await D.plants(u.telegram_id)).filter((p) => getsRain(p.location));
  for (const p of wet) await water(u, p, "rain");
  return wet;
}

// ---------- сад: комнаты, самая срочная раскрыта

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

async function garden(u: User) {
  const ps = await D.plants(u.telegram_id);
  const w = await weather(u);
  const rows: Row[] = ps.map((p) => ({ p, st: status(u, p, w) }));
  const names = roomsOf(ps);
  const inRoom = (n: string) => rows.filter((r) => roomOf(r.p) === n);
  const dueIn = (n: string) => inRoom(n).filter((r) => r.st.due).length;
  return { ps, rows, names, inRoom, dueIn };
}

async function list(u: User, chat: number, editMid?: number) {
  const { ps, rows, names, inRoom, dueIn } = await garden(u);
  if (!ps.length) return send(chat, T.emptyCollection);

  // первой идёт комната, которая ждёт дольше всех
  const urgency = (n: string) => Math.min(...inRoom(n).map((r) => r.st.daysLeft));
  const order = [...names].sort((a, b) => urgency(a) - urgency(b));
  const first = order[0];
  const rest = order.slice(1);
  const totalDue = rows.filter((r) => r.st.due).length;

  const out = [T.gardenTitle(ps.length), totalDue ? T.waterToday(totalDue) : T.nothingToday, ""];
  out.push(`<b>${esc(first)}</b>${dueIn(first) ? ` · ждут ${dueIn(first)}` : ""}`);
  for (const r of inRoom(first)) out.push(plantLine(r));
  if (rest.length) {
    out.push("", `<i>${T.roomRest}: ${rest.map((n) => `${esc(n)}${dueIn(n) ? ` ${dueIn(n)}` : ""}`).join(" · ")}</i>`);
  }

  const k: Keyboard = [];
  if (dueIn(first)) {
    k.push([b(`полито: ${first} · ${dueIn(first)}`, `wrv:${names.indexOf(first)}:g`, "success", "water")]);
  }
  const roomBtn = (n: string) =>
    b(dueIn(n) ? `${n} · ${dueIn(n)}` : n, `rmv:${names.indexOf(n)}`, dueIn(n) ? "success" : undefined);
  for (let i = 0; i < rest.length; i += 2) k.push(rest.slice(i, i + 2).map(roomBtn));
  k.push([b("неделя", "wk:0", "primary", "week")]);

  return showScreen(chat, out.join("\n"), k, editMid, "garden");
}

// ---------- одна комната: обход сада по кругу

async function roomScreen(u: User, chat: number, idx: number, editMid?: number) {
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

  // следующая комната по кругу, где ещё ждут: обход квартиры за один проход
  let next = -1;
  for (let step = 1; step < names.length; step++) {
    const j = (idx + step) % names.length;
    if (inRoom(names[j]).some((r) => r.st.due)) { next = j; break; }
  }
  const nav = [b("← сад", "list", undefined, "list")];
  if (next >= 0) nav.push(b(`${names[next]} →`, `rmv:${next}`, "primary"));
  k.push(nav);

  return showScreen(chat, out.join("\n"), k, editMid, "room");
}

// правим сообщение на месте, а если это не выходит (например, под фото), шлём новое
async function showScreen(chat: number, text: string, k: Keyboard, editMid: number | undefined, what: string, pv?: Preview) {
  if (editMid) {
    try { return await edit(chat, editMid, text, k, pv); } catch (e) { console.error(`${what} edit`, e); }
  }
  return send(chat, text, k, pv);
}

// превью берёт ссылку прямо на файл в хранилище: так блок с картинкой работает, проверено.
// копия в хранилище может отсутствовать у растений, которым фото меняли раньше, — заводим её здесь же.
async function photoPreview(u: User, p: Plant): Promise<Preview | undefined> {
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

// ---------- утренний дайджест

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

export async function digest(u: User, chat: number, manual: boolean): Promise<boolean> {
  const ps = await D.plants(u.telegram_id);
  if (!ps.length) {
    if (manual) await send(chat, T.emptyCollection);
    return false;
  }
  const w = await weather(u);
  const today = w.days.find((d) => d.date === w.today);
  const rows = ps.map((p) => ({ p, st: status(u, p, w) }));
  const due = rows.filter((r) => r.st.due);
  const feed = ps.filter((p) =>
    feedDue(p, w.today, p.last_fed_at ? localDate(u.tz, new Date(p.last_fed_at)) : null, localDate(u.tz, new Date(p.created_at)))
  );
  const alerts = weatherAlerts(w, ps, nameOf);

  if (!manual && !due.length && !feed.length && !alerts.length) return false; // тихий день, не пишем

  const wd = WEEKDAYS[new Date(w.today + "T12:00:00Z").getUTCDay()];
  const out: string[] = [`<b>${wd}, ${ruDate(w.today)}</b>`];
  if (today) {
    out.push(
      `${Math.round(today.tmax)}° / ${Math.round(today.tmin)}° · ${sky(today.code)}` +
        (today.rain >= 1 ? ` · дождь ${Math.round(today.rain)} мм` : ""),
    );
  }

  if (due.length) {
    out.push("", "<b>полить</b>");
    for (const [room, rows] of byRoom(due)) {
      out.push(`<i>${esc(room)}</i>`);
      for (const { p, st } of rows) {
        let note = "";
        if (st.rainExpectedToday) note = " · обещают дождь, можно подождать";
        else if (st.reason === "heat") note = " · раньше срока из-за жары";
        else if (st.reason === "overdue") note = " · давно не поливали";
        out.push(`  ${esc(nameOf(p))}${note ? `<i>${note}</i>` : ""}`);
      }
    }
  } else {
    const next = rows.sort((a, b) => a.st.daysLeft - b.st.daysLeft)[0];
    out.push("", T.nothingToday);
    if (next) out.push(`<i>следующий: ${esc(nameOf(next.p))}, ${whenWater(next.st.daysLeft, false).replace("полив ", "")}</i>`);
  }

  if (feed.length) {
    out.push("", "<b>подкормить</b>", ...feed.map((p) => esc(nameOf(p))));
  }

  for (const a of alerts) {
    out.push("", `<b>${esc(a.title)}</b>`, esc(a.text));
    if (a.plants.length) out.push(`<i>касается: ${a.plants.map(esc).join(", ")}</i>`);
  }

  const k: Keyboard = [];
  for (const [room, rows] of byRoom(due)) {
    if (rows.length > 1 && new TextEncoder().encode(`wr:${room}`).length <= 64) {
      k.push([b(`полито: ${room} · ${rows.length}`, `wr:${room}`, "success", "water")]);
    }
    for (const { p } of rows) k.push([b(`полито: ${nameOf(p)}`, `wd:${p.id}`, undefined, "water")]);
  }
  if (due.length > 1) k.push([b("всё полито", "wall", "success", "water")]);
  if (ps.some((p) => getsRain(p.location))) k.push([b("был дождь", "rain:d")]);
  for (const p of feed) k.push([b(`подкормлено: ${nameOf(p)}`, `fd:${p.id}`, undefined, "feed")]);

  await send(chat, out.join("\n"), k.length ? k : undefined);
  return true;
}

// убираем нажатую кнопку из дайджеста, чтобы было видно, что осталось
async function digestUpdateKeyboard(cb: any, chat: number, mid: number, pressed: string, alsoRemove: string[]) {
  const old: Keyboard = cb.message.reply_markup?.inline_keyboard ?? [];
  const gone = new Set([pressed, ...alsoRemove]);
  let rest = old.filter((row) => !gone.has(row[0]?.callback_data ?? ""));
  // если в комнате осталось меньше двух, кнопка «вся комната» не нужна
  rest = rest.filter((row) => {
    const d = row[0]?.callback_data ?? "";
    return !d.startsWith("wr:") || /· ([2-9]|\d\d)$/.test(row[0].text);
  });
  const left = rest.filter((row) => row[0]?.callback_data?.startsWith("wd:")).length;
  if (left < 2) rest = rest.filter((row) => row[0]?.callback_data !== "wall");
  return editKeyboard(chat, mid, rest);
}

// ---------- погода

async function weatherReport(u: User, chat: number) {
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
  return send(chat, text);
}

// ---------- диагностика

async function diagnose(u: User, chat: number, fileId: string, plantId: string | null, question?: string, mid?: number) {
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

async function freeChat(u: User, chat: number, text: string, history: any[]) {
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
  const ctx = `сегодня ${w.today}.\n\nколлекция:\n${plantsCtx}\n\nпрогноз:\n${wx}`;

  const msgs = [...history.slice(-10), { role: "user", content: text }];
  const reply = await C.chat(msgs, ctx, streamer(chat));
  await D.saveSession(u.telegram_id, { history: [...msgs, { role: "assistant", content: reply }].slice(-12) });
  return send(chat, esc(reply));
}

// ---------- настройки

async function settings(u: User, chat: number) {
  const hours = [6, 7, 8, 9, 10, 20];
  return send(chat, T.settings(u.digest_hour), [
    hours.slice(0, 3).map((h) => b(`${h}:00`, `hr:${h}`, h === u.digest_hour ? "primary" : undefined)),
    hours.slice(3).map((h) => b(`${h}:00`, `hr:${h}`, h === u.digest_hour ? "primary" : undefined)),
  ]);
}

// ---------- неделя сеткой (с понедельника)

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

function weekTitle(mon: string, sun: string): string {
  const d1 = Number(mon.slice(8)), d2 = Number(sun.slice(8));
  const m1 = MONTHS_GEN[Number(mon.slice(5, 7)) - 1], m2 = MONTHS_GEN[Number(sun.slice(5, 7)) - 1];
  return m1 === m2 ? `${d1}–${d2} ${m2}` : `${d1} ${m1} – ${d2} ${m2}`;
}

async function week(u: User, chat: number, offset: number, editMid?: number, mode: "d" | "g" = "d") {
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
