// edge function «bot»: принимает апдейты телеграма, ежечасный крон и разовую настройку
import { handleUpdate, digest } from "./handlers.ts";
import * as D from "./db.ts";
import { syncCommands, tg } from "./telegram.ts";
import { localDate, localHour } from "./weather.ts";
import { COMMANDS } from "./texts.ts";

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const background = (p: Promise<unknown>) => {
  const safe = p.catch((e) => console.error(e));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(safe);
};

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 1. разовая настройка: открыть в браузере .../functions/v1/bot?setup=<CRON_SECRET>
  if (url.searchParams.has("setup")) {
    if (!CRON_SECRET || url.searchParams.get("setup") !== CRON_SECRET) return new Response("forbidden", { status: 403 });
    const hook = `${Deno.env.get("SUPABASE_URL")}/functions/v1/bot`;
    await tg("setWebhook", {
      url: hook, secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
    });
    await syncCommands(COMMANDS, true);
    const info = await tg("getWebhookInfo");
    return ok({ ok: true, webhook: info.url, pending: info.pending_update_count, note: "готово, иди в телеграм и нажми /start" });
  }

  // 2. крон раз в час: кому пора, тому утреннее сообщение
  if (url.searchParams.has("cron")) {
    if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return new Response("forbidden", { status: 403 });
    const { data: users } = await D.db.from("users").select("*");
    const sent: number[] = [];
    for (const u of (users ?? []) as D.User[]) {
      const today = localDate(u.tz);
      if (localHour(u.tz) !== u.digest_hour || u.last_digest_on === today) continue;
      try {
        await D.db.from("users").update({ last_digest_on: today }).eq("telegram_id", u.telegram_id);
        if (await digest(u, u.telegram_id, false)) sent.push(u.telegram_id);
      } catch (e) { console.error("digest", u.telegram_id, e); }
    }
    return ok({ ok: true, sent: sent.length });
  }

  // 3. апдейт от телеграма
  if (req.method === "POST") {
    if (!WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const update = await req.json();
    if (typeof update.update_id === "number" && !(await D.firstTime(update.update_id))) return ok();
    // отвечаем телеграму сразу, а думаем в фоне: claude может отвечать 10–30 секунд
    background(handleUpdate(update));
    return ok();
  }

  return new Response("plant bot", { status: 200 });
});
