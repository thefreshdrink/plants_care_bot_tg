// тесты общих помощников обработчиков без сети: deno test supabase/functions/bot/handlers/common_test.ts
// common.ts: погода с кешем на один запрос, показ экрана (правка на месте или
// новое сообщение), превью фото растения из хранилища, строка «куда дальше».
// код бота не меняется — тест фиксирует то, что есть. streamer и photoOf
// (печать ответа claude и скачивание фото) — тонкие обёртки, не покрыты.
// телеграм и open-meteo — подменённый fetch; база и хранилище — заглушка
// через _setDb, которая запоминает вызовы.
// db.ts при загрузке создаёт клиент supabase из переменных окружения, поэтому
// ставим пустышки и грузим модули уже после этого.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { Plant, User } from "../db.ts";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const D = await import("../db.ts");
const C = await import("./common.ts");

type Call = { url: string; method: string; body: any };
type Reply = (c: Call) => Response | Promise<Response>;

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
const fail = (description: string) => new Response(JSON.stringify({ ok: false, description }), { status: 200 });

// подменяем fetch на время одного теста; console.error глушим и считаем
async function withFetch(reply: Reply, f: (calls: Call[], errors: unknown[][]) => Promise<void>) {
  const calls: Call[] = [];
  const errors: unknown[][] = [];
  const origFetch = globalThis.fetch;
  const origErr = console.error;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const c = { url, method: url.split("?")[0].split("/").pop()!, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    return await reply(c);
  }) as typeof fetch;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    await f(calls, errors);
  } finally {
    globalThis.fetch = origFetch;
    console.error = origErr;
  }
}

// ответ open-meteo: два дня и пыль
const meteo = () =>
  new Response(JSON.stringify({
    daily: {
      time: ["2026-11-23", "2026-11-24"],
      temperature_2m_max: [22, 21], temperature_2m_min: [14, 13], precipitation_sum: [0, 3],
      precipitation_probability_max: [5, 70], et0_fao_evapotranspiration: [2, 1],
      wind_gusts_10m_max: [20, 30], uv_index_max: [4, 3], weather_code: [1, 61],
    },
  }), { status: 200 });

const user = (lat: number): User => ({
  telegram_id: 7, first_name: "a", lat, lon: 33, tz: "Asia/Nicosia",
  digest_hour: 8, last_digest_on: null, evening_hour: null, last_evening_on: null,
});
// каждый тест погоды — своя широта, чтобы кеш модуля не мешал соседям
const forecasts = (calls: Call[]) => calls.filter((c) => c.url.startsWith("https://api.open-meteo.com/"));

Deno.test("weather: два вызова для одного места — один запрос и одно обещание", async () => {
  await withFetch((c) => c.url.includes("air-quality") ? new Response("{}") : meteo(), async (calls) => {
    const u = user(34.1);
    const a = C.weather(u);
    const b = C.weather(u);
    assert(a === b, "второй вызов отдаёт то же обещание");
    const w = await a;
    assertEquals(forecasts(calls).length, 1);
    assertEquals(w.days.map((d) => d.date), ["2026-11-23", "2026-11-24"]);
    await C.weather(u);
    assertEquals(forecasts(calls).length, 1, "после ответа тоже из кеша");
  });
});

Deno.test("weather: другое место — свой запрос", async () => {
  await withFetch((c) => c.url.includes("air-quality") ? new Response("{}") : meteo(), async (calls) => {
    await C.weather(user(34.2));
    await C.weather({ ...user(34.2), lon: 32 });
    await C.weather({ ...user(34.2), tz: "Europe/Athens" });
    assertEquals(forecasts(calls).length, 3, "ключ кеша — широта, долгота и пояс");
  });
});

Deno.test("weather: ошибка не остаётся в кеше, следующий вызов спрашивает заново", async () => {
  let down = true;
  await withFetch(
    (c) => c.url.includes("air-quality") ? new Response("{}") : down ? new Response("", { status: 503 }) : meteo(),
    async (calls) => {
      const u = user(34.3);
      await assertRejects(() => C.weather(u), Error, "open-meteo 503");
      down = false;
      const w = await C.weather(u);
      assertEquals(forecasts(calls).length, 2);
      assertEquals(w.days.length, 2);
    },
  );
});

Deno.test("showScreen: с номером сообщения правит его на месте", async () => {
  await withFetch(() => ok({ message_id: 9 }), async (calls) => {
    const k = [[{ text: "x", callback_data: "x" }]];
    await C.showScreen(100, "текст", k, 9, "экран");
    assertEquals(calls.map((c) => c.method), ["editMessageText"]);
    assertEquals(calls[0].body.chat_id, 100);
    assertEquals(calls[0].body.message_id, 9);
    assertEquals(calls[0].body.text, "текст");
    assertEquals(calls[0].body.reply_markup.inline_keyboard, k);
  });
});

Deno.test("showScreen: правка не вышла — пишет ошибку с именем экрана и шлёт новое", async () => {
  await withFetch(
    (c) => c.method === "editMessageText" ? fail("there is no text in the message to edit") : ok({ message_id: 10 }),
    async (calls, errors) => {
      const r = await C.showScreen(100, "текст", [], 9, "карточка");
      assertEquals(calls.map((c) => c.method), ["editMessageText", "sendMessage"]);
      assertEquals(calls[1].body.text, "текст");
      assertEquals(r, { message_id: 10 });
      assertEquals(errors.length, 1);
      assertEquals(errors[0][0], "карточка edit");
    },
  );
});

Deno.test("showScreen: без номера сообщения сразу шлёт новое, превью передаёт", async () => {
  await withFetch(() => ok({ message_id: 11 }), async (calls) => {
    await C.showScreen(100, "текст", [], undefined, "экран", { url: "https://x/p.jpg" });
    assertEquals(calls.map((c) => c.method), ["sendMessage"]);
    assertEquals(JSON.stringify(calls[0].body).includes("https://x/p.jpg"), true);
  });
});

Deno.test("homeNav: одна строка «сегодня» и «сад»", () => {
  const k = C.homeNav();
  assertEquals(k.length, 1);
  assertEquals(k[0].map((b) => b.callback_data), ["today", "list"]);
  assertEquals(k[0].map((b) => b.text), ["сегодня", "сад"]);
});

// ---------- превью фото

type StoreCall = { op: string; args: unknown[] };
function fakeStore(calls: StoreCall[], opts: { signed?: string | null; uploadError?: boolean } = {}) {
  const updates: Record<string, any>[] = [];
  D._setDb({
    storage: {
      from(bucket: string) {
        return {
          upload(...args: unknown[]) {
            calls.push({ op: `upload:${bucket}`, args });
            if (opts.uploadError) throw new Error("storage down");
            return Promise.resolve({ data: {}, error: null });
          },
          createSignedUrl(...args: unknown[]) {
            calls.push({ op: `sign:${bucket}`, args });
            const url = opts.signed === undefined ? "https://store/signed.jpg" : opts.signed;
            return Promise.resolve({ data: url ? { signedUrl: url } : null, error: null });
          },
        };
      },
    },
    from(table: string) {
      const chain: any = {
        update(row: Record<string, any>) { updates.push({ table, ...row }); calls.push({ op: `update:${table}`, args: [row] }); return chain; },
        eq() { return chain; },
        then(f: (r: unknown) => unknown) { return Promise.resolve({ data: null, error: null }).then(f); },
      };
      return chain;
    },
  });
  return updates;
}

const plant = (over: Partial<Plant>): Plant => ({
  id: "p1", user_id: 7, nickname: "фикус", species: null, common_name: null, room: null,
  location: "indoor", photo_file_id: null, photo_path: null, care: {},
  water_every_days: 7, water_winter_days: null, feed_every_days: null,
  cold_min_c: null, heat_sensitive: false,
  last_watered_at: "2026-11-20T08:00:00Z", last_fed_at: null, snoozed_until: null,
  archived: false, created_at: "2026-10-01T00:00:00Z", ...over,
});

Deno.test("photoPreview: без фото — нет превью, никуда не ходим", async () => {
  const store: StoreCall[] = [];
  fakeStore(store);
  await withFetch(() => ok({}), async (calls) => {
    assertEquals(await C.photoPreview(user(35), plant({})), undefined);
    assertEquals(calls.length, 0);
    assertEquals(store.length, 0);
  });
});

Deno.test("photoPreview: копия в хранилище есть — подписанная ссылка на сутки", async () => {
  const store: StoreCall[] = [];
  fakeStore(store);
  await withFetch(() => ok({}), async (calls) => {
    const pv = await C.photoPreview(user(35), plant({ photo_file_id: "f1", photo_path: "7/p1.jpg" }));
    assertEquals(pv, { url: "https://store/signed.jpg" });
    assertEquals(calls.length, 0, "телеграм не нужен");
    assertEquals(store.map((s) => s.op), ["sign:plants"]);
    assertEquals(store[0].args, ["7/p1.jpg", 86_400]);
  });
});

Deno.test("photoPreview: копии нет — качает из телеграма, кладёт в <id юзера>/<id растения>.jpg и запоминает путь", async () => {
  const store: StoreCall[] = [];
  const updates = fakeStore(store);
  await withFetch(
    (c) => c.method === "getFile" ? ok({ file_path: "photos/x.png" }) : new Response(new Uint8Array([1, 2, 3])),
    async (calls) => {
      const pv = await C.photoPreview(user(35), plant({ photo_file_id: "f1" }));
      assertEquals(pv, { url: "https://store/signed.jpg" });
      assertEquals(calls.map((c) => c.method), ["getFile", "x.png"]);
      assertEquals(calls[0].body, { file_id: "f1" });
      assertEquals(store.map((s) => s.op), ["upload:plants", "update:plants", "sign:plants"]);
      const [path, bytes, o] = store[0].args as [string, Uint8Array, Record<string, unknown>];
      assertEquals(path, "7/p1.jpg");
      assertEquals(Array.from(bytes), [1, 2, 3]);
      assertEquals(o, { contentType: "image/png", upsert: true });
      assertEquals(updates, [{ table: "plants", photo_path: "7/p1.jpg" }]);
      assertEquals(store[2].args, ["7/p1.jpg", 86_400]);
    },
  );
});

Deno.test("photoPreview: хранилище не дало ссылку — превью нет, без ошибки", async () => {
  const store: StoreCall[] = [];
  fakeStore(store, { signed: null });
  await withFetch(() => ok({}), async () => {
    assertEquals(await C.photoPreview(user(35), plant({ photo_file_id: "f1", photo_path: "7/p1.jpg" })), undefined);
  });
});

Deno.test("photoPreview: сбой хранилища — превью нет, ошибка в лог, карточка не падает", async () => {
  const store: StoreCall[] = [];
  const updates = fakeStore(store, { uploadError: true });
  await withFetch(
    (c) => c.method === "getFile" ? ok({ file_path: "photos/x.jpg" }) : new Response(new Uint8Array([1])),
    async (_calls, errors) => {
      assertEquals(await C.photoPreview(user(35), plant({ photo_file_id: "f1" })), undefined);
      assertEquals(updates.length, 0, "путь не записан, раз копии нет");
      assertEquals(errors.length, 1);
      assertEquals(errors[0][0], "photo preview");
    },
  );
});
