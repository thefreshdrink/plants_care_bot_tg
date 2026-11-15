// настройки: час утреннего сообщения и иконки кнопок
// кнопки — в settings_keyboard.ts, без базы и сети, чтобы тестировать
import { send } from "../telegram.ts";
import type { User } from "../db.ts";
import { T } from "../texts.ts";
import { hoursKeyboard, iconsKeyboard } from "./settings_keyboard.ts";

// ---------- настройки

export async function settings(u: User, chat: number) {
  return send(chat, T.settings(u.digest_hour), hoursKeyboard(u.digest_hour));
}

// ---------- иконки кнопок

export async function iconsMenu(chat: number, head?: string) {
  return send(chat, head ? `${head}\n\n${T.iconsIntro}` : T.iconsIntro, iconsKeyboard());
}
