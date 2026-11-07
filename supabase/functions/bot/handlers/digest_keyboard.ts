// какие кнопки дайджеста остаются после нажатия. чистая функция, без сети и базы
import type { Keyboard } from "../telegram.ts";

// pressed — нажатая кнопка, alsoRemove — кнопки растений, которые она тоже закрыла
export function keyboardAfterPress(old: Keyboard, pressed: string, alsoRemove: string[]): Keyboard {
  const gone = new Set([pressed, ...alsoRemove]);
  let rest = old.filter((row) => !gone.has(row[0]?.callback_data ?? ""));
  // если в комнате осталось меньше двух, кнопка «вся комната» не нужна
  rest = rest.filter((row) => {
    const d = row[0]?.callback_data ?? "";
    return !d.startsWith("wr:") || /· ([2-9]|\d\d)$/.test(row[0].text);
  });
  const left = rest.filter((row) => row[0]?.callback_data?.startsWith("wd:")).length;
  if (left < 2) rest = rest.filter((row) => row[0]?.callback_data !== "wall");
  return rest;
}
