// вся логика диалога
import { answer, send, setIcons, syncCommands } from "./telegram.ts";
import * as D from "./db.ts";
import { COMMANDS, T } from "./texts.ts";
import { onMessage } from "./handlers/messages.ts";
import { onCallback } from "./handlers/callbacks.ts";

// утренний дайджест зовёт и крон в index.ts
export { digest } from "./handlers/digest.ts";

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
  // меню команд обновляем параллельно с ответом, но дожидаемся в конце:
  // иначе функция может уснуть раньше, чем телеграм его примет
  const commands = syncCommands(COMMANDS);
  try {
    if (cb) await onCallback(u, chat, cb);
    else if (msg) await onMessage(u, chat, msg);
  } catch (e) {
    console.error(e);
    if (cb) await answer(cb.id);
    await send(chat, T.error).catch(() => {});
  }
  await commands;
}
