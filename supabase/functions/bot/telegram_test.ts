// тесты обёртки над telegram bot api: deno test supabase/functions/bot/telegram_test.ts
// сеть не нужна: fetch подменяется ответами в формате api.telegram.org
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { b, esc, send, sendPhoto, setIcons, tg, toBase64 } from "./telegram.ts";

type Sent = { url: string; body: any };

// подменить fetch очередью ответов; вернуть отправленные запросы
async function withFetch(replies: unknown[], run: () => Promise<void>): Promise<Sent[]> {
  const sent: Sent[] = [];
  const orig = globalThis.fetch;
  const origErr = console.error;
  console.error = () => {};
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    const r = replies[Math.min(sent.length - 1, replies.length - 1)];
    return Promise.resolve(new Response(JSON.stringify(r)));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = orig;
    console.error = origErr;
  }
  return sent;
}

const ok = (result: unknown = true) => ({ ok: true, result });
const fail = (description: string) => ({ ok: false, description });

Deno.test("b: без иконок — полный текст, без цвета и иконки", () => {
  setIcons({});
  assertEquals(b("полито: фикус", "w:1", undefined, "water", "фикус"), { text: "полито: фикус", callback_data: "w:1" });
});

Deno.test("b: иконка есть — короткий текст и id эмодзи, цвет сохраняется", () => {
  setIcons({ water: "123" });
  assertEquals(b("полито: фикус", "w:1", "success", "water", "фикус"), {
    text: "фикус", callback_data: "w:1", style: "success", icon_custom_emoji_id: "123",
  });
  // без short текст прежний, даже если иконка стоит
  assertEquals(b("инфо", "i:1", undefined, "water").text, "инфо");
  // ключа нет в словаре — как без иконки
  assertEquals(b("полито: фикус", "w:1", undefined, "nope", "фикус"), { text: "полито: фикус", callback_data: "w:1" });
  setIcons({});
});

Deno.test("tg: успешный ответ отдаёт result", async () => {
  let got: unknown;
  const sent = await withFetch([ok({ message_id: 7 })], async () => {
    got = await tg("sendMessage", { chat_id: 1, text: "hi" });
  });
  assertEquals(got, { message_id: 7 });
  assertEquals(sent.length, 1);
  assertEquals(sent[0].url.endsWith("/sendMessage"), true);
  assertEquals(sent[0].body, { chat_id: 1, text: "hi" });
});

Deno.test("tg: «message is not modified» — не ошибка", async () => {
  await withFetch([fail("Bad Request: message is not modified")], async () => {
    await tg("editMessageText", { chat_id: 1, message_id: 2, text: "same" });
  });
});

Deno.test("tg: телеграм не принял иконку — повтор без иконок и цветов у всех кнопок", async () => {
  const markup = {
    inline_keyboard: [
      [{ text: "фикус", callback_data: "w:1", style: "success", icon_custom_emoji_id: "123" }],
      [{ text: "инфо", callback_data: "i:1" }],
    ],
  };
  let got: unknown;
  const sent = await withFetch([fail("Bad Request: invalid custom emoji identifier"), ok("sent")], async () => {
    got = await tg("sendMessage", { chat_id: 1, text: "x", reply_markup: markup });
  });
  assertEquals(got, "sent");
  assertEquals(sent.length, 2);
  assertEquals(sent[1].body.reply_markup, {
    inline_keyboard: [[{ text: "фикус", callback_data: "w:1" }], [{ text: "инфо", callback_data: "i:1" }]],
  });
  assertEquals(sent[1].body.text, "x");
});

Deno.test("tg: повтор без иконок тоже не прошёл — ошибка, без третьей попытки", async () => {
  const markup = { inline_keyboard: [[{ text: "a", callback_data: "a", style: "danger" }]] };
  let err: unknown;
  const sent = await withFetch([fail("Bad Request: unsupported button style")], async () => {
    await tg("sendMessage", { chat_id: 1, text: "x", reply_markup: markup }).catch((e) => { err = e; });
  });
  assertEquals(sent.length, 2);
  assertEquals((err as Error).message, "telegram sendMessage: Bad Request: unsupported button style");
});

Deno.test("tg: чужая ошибка без кнопок — сразу исключение", async () => {
  await assertRejects(
    () => withFetch([fail("Forbidden: bot was blocked by the user")], async () => {
      await tg("sendMessage", { chat_id: 1, text: "x" });
    }),
    Error,
    "telegram sendMessage: Forbidden: bot was blocked by the user",
  );
});

Deno.test("send: html, превью выключено, клавиатура в inline_keyboard", async () => {
  const sent = await withFetch([ok()], async () => {
    await send(5, "<b>hi</b>", [[{ text: "a", callback_data: "a" }]]);
  });
  assertEquals(sent[0].body, {
    chat_id: 5, text: "<b>hi</b>", parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: "a", callback_data: "a" }]] },
  });
});

Deno.test("send: крупное превью над текстом", async () => {
  const sent = await withFetch([ok()], async () => {
    await send(5, "hi", undefined, { url: "https://x/p.jpg", above: true, large: true });
  });
  assertEquals(sent[0].body.link_preview_options, { url: "https://x/p.jpg", prefer_large_media: true, show_above_text: true });
  assertEquals("reply_markup" in sent[0].body, false);
});

Deno.test("sendPhoto: подпись обрезается до 1024 знаков", async () => {
  const sent = await withFetch([ok()], async () => {
    await sendPhoto(5, "file-id", "я".repeat(2000));
  });
  assertEquals(sent[0].body.caption.length, 1024);
  assertEquals(sent[0].url.endsWith("/sendPhoto"), true);
});

Deno.test("esc и toBase64", () => {
  assertEquals(esc("<a & b>"), "&lt;a &amp; b&gt;");
  assertEquals(esc(null), "");
  assertEquals(toBase64(new TextEncoder().encode("plant")), "cGxhbnQ=");
  // больше одного куска по 0x8000 байт
  const big = new Uint8Array(0x8000 * 2 + 3).fill(65);
  assertEquals(atob(toBase64(big)).length, big.length);
});
