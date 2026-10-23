// входящие сообщения: фото, команды, ответы в режимах ожидания, свободный чат
import { b, send, sendWelcome, setIcons } from "../telegram.ts";
import * as D from "../db.ts";
import type { User } from "../db.ts";
import { ICON_KEYS, T } from "../texts.ts";
import { askLastWatered, askLocation, askRoom, diagPlantRows, identifyPhoto } from "./add.ts";
import { card, history } from "./card.ts";
import { list } from "./garden.ts";
import { digest } from "./digest.ts";
import { weatherReport } from "./forecast.ts";
import { diagnose, freeChat } from "./ai.ts";
import { iconsMenu, settings } from "./settings.ts";
import { week } from "./week.ts";

// ---------- сообщения

export async function onMessage(u: User, chat: number, msg: any) {
  const uid = u.telegram_id;
  const s = await D.getSession(uid);

  if (msg.photo?.length) {
    const fileId = msg.photo.at(-1).file_id; // самое большое разрешение
    if (s.state === "await_new_photo" && s.data.plant_id) {
      // photo_path сбрасываем: иначе превью покажет старую копию из хранилища, photoPreview заведёт новую
      await D.updatePlant(uid, s.data.plant_id, { photo_file_id: fileId, photo_path: null });
      await D.logEvent(uid, s.data.plant_id, "photo", undefined, fileId);
      await D.saveSession(uid, { state: null, data: {} });
      return card(u, chat, s.data.plant_id);
    }
    if (s.state === "await_diag_photo" && s.data.plant_id) {
      await D.saveSession(uid, { state: null, data: {} });
      return diagnose(u, chat, fileId, s.data.plant_id, msg.caption);
    }
    const photoData = { photo: fileId, caption: msg.caption ?? null };
    if (s.state === "await_id_photo") {
      await D.saveSession(uid, { state: null, data: photoData });
      const m = await send(chat, T.identifying);
      return identifyPhoto(u, chat, photoData, "id", m.message_id);
    }
    if (s.state === "await_doc_photo") {
      await D.saveSession(uid, { state: null, data: photoData });
      return send(chat, T.pickPlantForDiagnosis, await diagPlantRows(uid));
    }
    await D.saveSession(uid, { state: null, data: photoData });
    return send(chat, T.photoWhat, [
      [b("добавить в коллекцию", "ph:add", "success")],
      [b("просто узнать, что это", "ph:id", "primary")],
      [b("что с ним не так", "ph:diag", undefined, "diag")],
    ]);
  }

  const text: string = (msg.text ?? "").trim();

  // ждём премиум-эмодзи для иконки. любая команда выводит из этого режима и обрабатывается как обычно.
  if (s.state === "await_icon" && s.data.key && !text.startsWith("/")) {
    const ent = (msg.entities ?? []).find((e: any) => e.type === "custom_emoji");
    if (!ent) return send(chat, T.iconNotCustom);
    await D.setIcon(uid, s.data.key, ent.custom_emoji_id);
    await D.saveSession(uid, { state: null, data: {} });
    setIcons(await D.icons(uid));
    const label = ICON_KEYS.find((k) => k.key === s.data.key)?.label ?? "";
    return iconsMenu(chat, T.iconSaved(label));
  }

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
      case "/icons": return iconsMenu(chat);
      case "/identify":
        await D.saveSession(uid, { state: "await_id_photo", data: {} });
        return send(chat, T.idAsk);
      case "/doctor":
        await D.saveSession(uid, { state: "await_doc_photo", data: {} });
        return send(chat, T.docAsk);
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
    case "await_note":
      await D.logEvent(uid, s.data.plant_id, "note", text.slice(0, 500));
      await D.saveSession(uid, { state: null, data: {} });
      return history(u, chat, s.data.plant_id);
    case "await_rename":
      await D.updatePlant(uid, s.data.plant_id, { nickname: text.slice(0, 40) });
      await D.saveSession(uid, { state: null, data: {} });
      return card(u, chat, s.data.plant_id);
  }

  return freeChat(u, chat, text, s.history ?? []);
}
