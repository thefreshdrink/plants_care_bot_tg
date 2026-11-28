// кнопки настроек: час утреннего сообщения и меню иконок. чистые функции, без базы и сети
// (перенесено из settings.ts как есть)
import { b, Keyboard } from "../telegram.ts";
import { ICON_KEYS } from "../texts.ts";

// часы, которые можно выбрать для утреннего сообщения
export const DIGEST_HOURS = [6, 7, 8, 9, 10, 20];

export function hoursKeyboard(current: number): Keyboard {
  const hours = DIGEST_HOURS;
  return [
    hours.slice(0, 3).map((h) => b(`${h}:00`, `hr:${h}`, h === current ? "primary" : undefined)),
    hours.slice(3).map((h) => b(`${h}:00`, `hr:${h}`, h === current ? "primary" : undefined)),
  ];
}

export function iconsKeyboard(): Keyboard {
  const k: Keyboard = [];
  for (let i = 0; i < ICON_KEYS.length; i += 3) {
    k.push(ICON_KEYS.slice(i, i + 3).map((x) => b(x.label, `ic:${x.key}`, undefined, x.key)));
  }
  k.push([b("убрать все иконки", "ic:clear", "danger")]);
  return k;
}
