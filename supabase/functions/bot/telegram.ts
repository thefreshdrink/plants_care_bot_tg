// тонкая обёртка над telegram bot api, без библиотек
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const API = `https://api.telegram.org/bot${TOKEN}`;

export type Style = "success" | "primary" | "danger";
export type Button = { text: string; callback_data?: string; url?: string; style?: Style; icon_custom_emoji_id?: string };
export type Keyboard = Button[][];

// иконки кнопок (custom emoji). загружаются из базы в начале каждого апдейта.
let ICONS: Record<string, string> = {};
export const setIcons = (m: Record<string, string>) => { ICONS = m; };

// кнопка: текст, действие, цвет и ключ иконки
export function b(text: string, data: string, style?: Style, icon?: string): Button {
  const btn: Button = { text, callback_data: data };
  if (style) btn.style = style;
  if (icon && ICONS[icon]) btn.icon_custom_emoji_id = ICONS[icon];
  return btn;
}

// кнопка нижнего меню (reply keyboard)
export function mb(text: string, style?: Style, icon?: string) {
  const btn: Record<string, string> = { text };
  if (style) btn.style = style;
  if (icon && ICONS[icon]) btn.icon_custom_emoji_id = ICONS[icon];
  return btn;
}

export async function tg<T = any>(method: string, body: Record<string, any> = {}, retry = false): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.ok) {
    const why = String(j.description);
    // «message is not modified» не ошибка, просто нажали ту же кнопку дважды
    if (why.includes("not modified")) return j.result;
    // если телеграм не принял иконки или цвета кнопок, отправляем без них, но отправляем
    if (!retry && body.reply_markup && /emoji|style|icon/i.test(why)) {
      console.error("buttons fallback", why);
      return tg<T>(method, { ...body, reply_markup: plainMarkup(body.reply_markup) }, true);
    }
    throw new Error(`telegram ${method}: ${why}`);
  }
  return j.result;
}

function plainMarkup(m: any): any {
  const strip = (rows: any[][]) => rows.map((r) => r.map(({ style: _s, icon_custom_emoji_id: _i, ...rest }) => rest));
  if (m?.inline_keyboard) return { ...m, inline_keyboard: strip(m.inline_keyboard) };
  if (m?.keyboard) return { ...m, keyboard: strip(m.keyboard) };
  return m;
}

const kb = (k?: Keyboard) => (k ? { reply_markup: { inline_keyboard: k } } : {});

// превью ссылки: телеграм показывает картинку маленькой сбоку от текста.
// ссылка должна вести прямо на файл: html-страницу с разметкой он не обходит, это проверено на живом боте.
export type Preview = { url: string; above?: boolean };
const preview = (pv?: Preview) => ({
  link_preview_options: pv
    ? { url: pv.url, prefer_small_media: true, show_above_text: !!pv.above }
    : { is_disabled: true },
});


export const send = (chat: number, text: string, k?: Keyboard, pv?: Preview) =>
  tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", ...preview(pv), ...kb(k) });

export const sendPhoto = (chat: number, photo: string, caption: string, k?: Keyboard) =>
  tg("sendPhoto", { chat_id: chat, photo, caption: caption.slice(0, 1024), parse_mode: "HTML", ...kb(k) });

export const edit = (chat: number, messageId: number, text: string, k?: Keyboard, pv?: Preview) =>
  tg("editMessageText", {
    chat_id: chat, message_id: messageId, text, parse_mode: "HTML",
    ...preview(pv), ...kb(k),
  });

export const editKeyboard = (chat: number, messageId: number, k?: Keyboard) =>
  tg("editMessageReplyMarkup", { chat_id: chat, message_id: messageId, reply_markup: { inline_keyboard: k ?? [] } });

// постоянное меню внизу экрана
export const sendMenu = (chat: number, text: string, rows: Record<string, string>[][]) =>
  tg("sendMessage", {
    chat_id: chat, text, parse_mode: "HTML",
    reply_markup: { keyboard: rows, resize_keyboard: true, is_persistent: true },
  });

// черновик, который печатается на глазах (только личные чаты). пустой текст = «думаю…»
export const draft = (chat: number, draftId: number, text: string) =>
  tg("sendMessageDraft", { chat_id: chat, draft_id: draftId, text: text.slice(0, 4096) }).catch(() => {});

// rich message: html с заголовками, таблицами, сворачиваемыми блоками. если не вышло, обычный html.
// rich-сообщение: заголовки и раскрывающиеся разделы. превью оно молча выбрасывает,
// поэтому картинка живёт в отдельном сообщении над ним.
export async function sendRich(chat: number, html: string, fallbackHtml: string, k?: Keyboard) {
  try {
    return await tg("sendRichMessage", { chat_id: chat, rich_message: { html }, ...kb(k) });
  } catch (e) {
    console.error("rich fallback", e);
    return send(chat, fallbackHtml, k);
  }
}

// список команд живёт на стороне телеграма и сам не обновляется после деплоя.
// шлём его один раз за запуск функции, чтобы новая версия доезжала до меню без ручных шагов.
let commandsSent = false;
export async function syncCommands(commands: { command: string; description: string }[], force = false) {
  if (commandsSent && !force) return;
  commandsSent = true;
  try {
    await tg("setMyCommands", { commands });
  } catch (e) {
    commandsSent = false;
    console.error("setMyCommands", e);
  }
}

export const answer = (id: string, text?: string) =>
  tg("answerCallbackQuery", { callback_query_id: id, text }).catch(() => {});

export const typing = (chat: number, action: "typing" | "upload_photo" = "typing") =>
  tg("sendChatAction", { chat_id: chat, action }).catch(() => {});

export async function download(fileId: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const f = await tg<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mime = f.file_path.endsWith(".png") ? "image/png" : f.file_path.endsWith(".webp") ? "image/webp" : "image/jpeg";
  return { bytes, mime };
}

export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
