// настройки: час утреннего сообщения и иконки кнопок
import { b, Keyboard, send } from "../telegram.ts";
import type { User } from "../db.ts";
import { ICON_KEYS, T } from "../texts.ts";

// ---------- настройки

export async function settings(u: User, chat: number) {
  const hours = [6, 7, 8, 9, 10, 20];
  return send(chat, T.settings(u.digest_hour), [
    hours.slice(0, 3).map((h) => b(`${h}:00`, `hr:${h}`, h === u.digest_hour ? "primary" : undefined)),
    hours.slice(3).map((h) => b(`${h}:00`, `hr:${h}`, h === u.digest_hour ? "primary" : undefined)),
  ]);
}

// ---------- иконки кнопок

export async function iconsMenu(chat: number, head?: string) {
  const k: Keyboard = [];
  for (let i = 0; i < ICON_KEYS.length; i += 3) {
    k.push(ICON_KEYS.slice(i, i + 3).map((x) => b(x.label, `ic:${x.key}`, undefined, x.key)));
  }
  k.push([b("убрать все иконки", "ic:clear", "danger")]);
  return send(chat, head ? `${head}\n\n${T.iconsIntro}` : T.iconsIntro, k);
}
