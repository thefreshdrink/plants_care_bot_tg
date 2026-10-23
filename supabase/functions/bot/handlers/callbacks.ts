// нажатия на кнопки
import { answer, b, edit, editKeyboard, esc, Keyboard, send, sendPhoto, setIcons } from "../telegram.ts";
import * as D from "../db.ts";
import type { Plant, User } from "../db.ts";
import * as C from "../claude.ts";
import { localDate } from "../weather.ts";
import { ICON_KEYS, T } from "../texts.ts";
import { homeNav, nameOf, roomOf, showScreen, status, weather } from "./common.ts";
import { rainWater, water } from "./water.ts";
import { askLastWatered, askLocation, askRoom, candidateButtons, careColumns, diagPlantRows, finishAdd, identifyPhoto, locationButtons } from "./add.ts";
import { card, careText, history, QUICK_NOTES } from "./card.ts";
import { garden, list, roomScreen } from "./garden.ts";
import { digest, digestUpdateKeyboard } from "./digest.ts";
import { diagnose } from "./ai.ts";
import { week } from "./week.ts";

// ---------- кнопки

export async function onCallback(u: User, chat: number, cb: any) {
  const uid = u.telegram_id;
  const data: string = cb.data ?? "";
  const mid: number = cb.message.message_id;
  const [cmd, a, arg2] = data.split(":");
  const s = await D.getSession(uid);
  // нажала другую кнопку, пока бот ждал эмодзи: значит, передумала, не держим режим иконки
  if (s.state === "await_icon" && cmd !== "ic") await D.saveSession(uid, { state: null, data: {} });

  switch (cmd) {
    // --- фото: что с ним делать
    case "ph": {
      if (!s.data.photo) { await answer(cb.id, "фото потерялось, пришли ещё раз"); return; }
      await answer(cb.id);
      if (a === "diag") return edit(chat, mid, T.pickPlantForDiagnosis, await diagPlantRows(uid));
      return identifyPhoto(u, chat, s.data, a === "id" ? "id" : "add", mid);
    }
    case "noadd": {
      await answer(cb.id, "хорошо, в сад не добавляю");
      await D.saveSession(uid, { state: null, data: {} });
      return editKeyboard(chat, mid, []);
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
    case "ic": {
      await answer(cb.id);
      if (a === "clear") {
        await D.db.from("icons").delete().eq("user_id", uid);
        setIcons({});
        return send(chat, T.iconsCleared);
      }
      await D.saveSession(uid, { state: "await_icon", data: { key: a } });
      return edit(chat, mid, T.iconAsk(ICON_KEYS.find((k) => k.key === a)?.label ?? a));
    }
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
    case "p": await answer(cb.id); return card(u, chat, a, mid);
    case "hist": await answer(cb.id); return history(u, chat, a, mid);
    case "hn": {
      await answer(cb.id);
      await D.saveSession(uid, { state: "await_note", data: { plant_id: a } });
      return edit(chat, mid, T.noteAsk);
    }
    case "hq": {
      // быстрые заметки одной кнопкой
      const note = QUICK_NOTES[Number(arg2)];
      if (!note) return answer(cb.id);
      await D.logEvent(uid, a, "note", note);
      await answer(cb.id, `записала: ${note}`);
      return history(u, chat, a, mid);
    }
    case "care": await answer(cb.id); return careText(u, chat, a);
    case "pho": {
      await answer(cb.id);
      const p = await D.plant(uid, a);
      if (!p?.photo_file_id) return;
      return sendPhoto(chat, p.photo_file_id, `<b>${esc(nameOf(p))}</b>`, [[b("← к растению", `p:${a}`, "primary")]]);
    }

    case "w": case "wd": case "wn": case "wdn": {
      // wn и wdn: полито без удобрения, из карточки и из утреннего сообщения
      const p = await D.plant(uid, a);
      if (!p) return answer(cb.id);
      const fed = await water(u, p, "water", cmd === "wn" || cmd === "wdn");
      await answer(cb.id, fed ? T.wateredFed(nameOf(p)) : T.watered(nameOf(p)));
      if (cmd === "w" || cmd === "wn") return card(u, chat, a, mid);
      return digestUpdateKeyboard(cb, chat, mid, data, [`wd:${a}`]);
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
      const wetRooms = [...new Set(wet.map((p) => `wr:${roomOf(p)}`))];
      return digestUpdateKeyboard(cb, chat, mid, data, [...wet.map((p) => `wd:${p.id}`), ...wetRooms]);
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
      return edit(chat, mid, T.settingsSaved(h), homeNav());
    }
  }
  await answer(cb.id);
}
