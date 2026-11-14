// кнопки карточки растения: чистая функция, без базы и сети
// (перенесено из card.ts как есть)
import { b, Keyboard } from "../telegram.ts";
import type { Plant } from "../db.ts";
import { getsRain } from "../watering.ts";

export function cardKeyboard(id: string, location: Plant["location"], hasPhoto: boolean, fedDue: boolean): Keyboard {
  const k: Keyboard = [];
  if (fedDue) {
    k.push([
      b("с удобрением", `w:${id}`, "success", "water"),
      b("без", `wn:${id}`, undefined, "nofeed"),
    ]);
    k.push([b("не сегодня", `snz:${id}`, undefined, "snooze"), b("инфо", `care:${id}`, undefined, "care")]);
  } else {
    k.push([
      b("полито", `w:${id}`, "success", "water"),
      b("не сегодня", `snz:${id}`, undefined, "snooze"),
      b("инфо", `care:${id}`, undefined, "care"),
    ]);
  }
  // дождь поливает только тех, кто под открытым небом: у домашних кнопка не нужна
  if (getsRain(location)) k.push([b("был дождь", `rain:c:${id}`, undefined, "rain")]);
  // фото стоит крупно над текстом, а если его нет, предлагаем добавить
  if (!hasPhoto) k.push([b("добавить фото", `nph:${id}`, "primary", "photo")]);
  k.push([
    b("история", `hist:${id}`, undefined, "history"),
    b("ещё", `ed:${id}`, undefined, "edit"),
    b("весь сад", "list", undefined, "list"),
  ]);
  return k;
}
