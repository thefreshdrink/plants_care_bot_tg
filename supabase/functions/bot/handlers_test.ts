// тесты точки входа handleUpdate и пропуска в бота (authorize) без сети:
// deno test supabase/functions/bot/handlers_test.ts
// апдейт без отправителя или чата — тишина; чужому — «это личный бот» (на
// кнопку — во всплывашке, на сообщение — сообщением), дальше не идём; первая
// настоящая хозяйка забирает заранее загруженный сад (user_id 0) и удаляет
// временную хозяйку; ALLOWED_TELEGRAM_IDS пускает второго человека; иконки
// грузятся до ответа, их ошибка не ломает апдейт; меню команд уходит один раз
// на запуск функции; если обработчик упал — «что-то сломалось», на кнопку ещё
// и снимаем часики.
// база — заглушка через _setDb: запоминает каждую цепочку (таблица, операция,
// фильтры); телеграм — подменённый fetch.
// db.ts при загрузке создаёт клиент supabase из переменных окружения, поэтому
// ставим пустышки и грузим модули уже после этого.
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const D = await import("./db.ts");
const { handleUpdate } = await import("./handlers.ts");
const { T } = await import("./texts.ts");

type Call = { table: string; op: string; row?: any; eq: [string, unknown][] };
type World = {
  user: Record<string, unknown> | null; // что вернёт users по telegram_id
  others: number;                        // сколько настоящих пользователей уже есть
  icons?: { key: string; custom_emoji_id: string }[];
  iconsFail?: boolean;
  sessionFail?: boolean;
};

function fakeDb(w: World, calls: Call[]) {
  D._setDb({
    from(table: string) {
      const c: Call = { table, op: "select", eq: [] };
      calls.push(c);
      let single = false;
      const chain: Record<string, unknown> = {
        select(_: unknown, opt?: { head?: boolean }) { if (opt?.head) c.op = "count"; return proxy; },
        insert(row: any) { c.op = "insert"; c.row = row; return proxy; },
        update(row: any) { c.op = "update"; c.row = row; return proxy; },
        upsert(row: any) { c.op = "upsert"; c.row = row; return proxy; },
        delete() { c.op = "delete"; return proxy; },
        eq(k: string, v: unknown) { c.eq.push([k, v]); return proxy; },
        maybeSingle() { single = true; return proxy; },
        single() { single = true; return proxy; },
        then(ok: (r: unknown) => unknown, bad?: (e: unknown) => unknown) {
          if (table === "icons" && w.iconsFail) return Promise.reject(new Error("icons down")).then(ok, bad);
          let r: any = { data: single ? null : [], error: null };
          if (table === "users" && c.op === "select" && single) r.data = w.user;
          if (table === "users" && c.op === "count") r = { count: w.others, error: null };
          if (table === "users" && c.op === "insert") r.data = { telegram_id: c.row.telegram_id, first_name: c.row.first_name, tz: "Asia/Nicosia", digest_hour: 8 };
          if (table === "icons" && c.op === "select") r.data = w.icons ?? [];
          if (table === "sessions" && single) {
            r = w.sessionFail ? { data: null, error: { message: "sessions down" } } : { data: { user_id: 7, state: null, data: {}, history: [] }, error: null };
          }
          return Promise.resolve(r).then(ok, bad);
        },
      };
      // neq, in, order, limit… — всё возвращает ту же цепочку
      const proxy: unknown = new Proxy(chain, {
        get(t, k) { return k in t ? t[k as string] : () => proxy; },
      });
      return proxy;
    },
  });
}

type Sent = { method: string; body: any };
async function run(w: World, update: any): Promise<{ sent: Sent[]; calls: Call[]; errors: unknown[] }> {
  const calls: Call[] = [];
  fakeDb(w, calls);
  const sent: Sent[] = [];
  const errors: unknown[] = [];
  const orig = globalThis.fetch;
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: String(input).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), { status: 200 }));
  }) as typeof fetch;
  try {
    await handleUpdate(update);
  } finally {
    globalThis.fetch = orig;
    console.error = origErr;
  }
  return { sent, calls, errors };
}

const owner = { telegram_id: 7, first_name: "алиса", lat: 35, lon: 33, tz: "Asia/Nicosia", digest_hour: 8 };
const msg = (id: number, text: string) => ({ message: { from: { id, first_name: "кто-то" }, chat: { id: 100 }, text } });
const cb = (id: number, data: string) => ({
  callback_query: { id: "cb1", from: { id, first_name: "кто-то" }, message: { chat: { id: 100 }, message_id: 9 }, data },
});
const methods = (s: Sent[]) => s.map((x) => x.method);
const of = (calls: Call[], table: string, op: string) => calls.filter((c) => c.table === table && c.op === op);

// первым: меню команд — состояние модуля telegram.ts, уходит один раз на запуск
Deno.test("хозяйка пишет /start: приветствие и меню команд; второй раз меню не шлём", async () => {
  const first = await run({ user: owner, others: 1 }, msg(7, "/start"));
  assert(methods(first.sent).includes("setMyCommands"));
  assert(first.sent.some((s) => s.method === "sendMessage" && s.body.text === T.welcome("алиса")), "нет приветствия");
  assertEquals(of(first.calls, "users", "insert").length, 0);
  const second = await run({ user: owner, others: 1 }, msg(7, "/start"));
  assert(!methods(second.sent).includes("setMyCommands"));
});

Deno.test("апдейт без отправителя или без чата — ни базы, ни телеграма", async () => {
  for (const u of [{}, { message: { chat: { id: 1 }, text: "hi" } }, { message: { from: { id: 7 }, text: "hi" } },
    { callback_query: { id: "x", from: { id: 7 } } }, { edited_message: { from: { id: 7 }, chat: { id: 1 } } }]) {
    const r = await run({ user: owner, others: 1 }, u);
    assertEquals(r.sent, []);
    assertEquals(r.calls, []);
  }
});

Deno.test("чужой пишет сообщение: «это личный бот», в базу не пишем, сад не трогаем", async () => {
  const r = await run({ user: null, others: 1 }, msg(99, "/start"));
  assertEquals(methods(r.sent), ["sendMessage"]);
  assertEquals(r.sent[0].body.text, T.notOwner);
  assertEquals(r.sent[0].body.chat_id, 100);
  for (const op of ["insert", "update", "delete", "upsert"]) {
    assertEquals(r.calls.filter((c) => c.op === op), []);
  }
  assertEquals(of(r.calls, "icons", "select"), []);
});

Deno.test("чужой жмёт кнопку: ответ во всплывашке, сообщением не пишем", async () => {
  const r = await run({ user: null, others: 1 }, cb(99, "w:abc"));
  assertEquals(methods(r.sent), ["answerCallbackQuery"]);
  assertEquals(r.sent[0].body.callback_query_id, "cb1");
  assertEquals(r.sent[0].body.text, T.notOwner);
  assertEquals(r.calls.filter((c) => c.op !== "select" && c.op !== "count"), []);
});

Deno.test("первая настоящая хозяйка: заводится и забирает сад временной хозяйки (user_id 0)", async () => {
  const r = await run({ user: null, others: 0 }, msg(42, "/start"));
  const ins = of(r.calls, "users", "insert");
  assertEquals(ins.length, 1);
  assertEquals(ins[0].row, { telegram_id: 42, first_name: "кто-то" });
  for (const t of ["plants", "events"]) {
    const up = of(r.calls, t, "update");
    assertEquals(up.length, 1, t);
    assertEquals(up[0].row, { user_id: 42 });
    assertEquals(up[0].eq, [["user_id", 0]]);
  }
  const del = of(r.calls, "users", "delete");
  assertEquals(del.length, 1);
  assertEquals(del[0].eq, [["telegram_id", 0]]);
  assert(!r.sent.some((s) => s.body.text === T.notOwner));
});

Deno.test("второй человек из ALLOWED_TELEGRAM_IDS заводится, но чужой сад не забирает", async () => {
  Deno.env.set("ALLOWED_TELEGRAM_IDS", " 5, 55 ,555");
  try {
    const r = await run({ user: null, others: 1 }, msg(55, "/start"));
    assertEquals(of(r.calls, "users", "insert").length, 1);
    assertEquals(of(r.calls, "plants", "update"), []);
    assertEquals(of(r.calls, "events", "update"), []);
    assertEquals(of(r.calls, "users", "delete"), []);
    assert(!r.sent.some((s) => s.body.text === T.notOwner));
    // 5 и 555 в списке не делают своим 50 или 5555
    const stranger = await run({ user: null, others: 1 }, msg(5555, "/start"));
    assertEquals(stranger.sent[0].body.text, T.notOwner);
  } finally {
    Deno.env.delete("ALLOWED_TELEGRAM_IDS");
  }
});

Deno.test("иконки хозяйки грузятся до ответа и попадают на кнопки", async () => {
  // «что делать с фото»: кнопка «что с ним не так» несёт ключ иконки diag
  const r = await run(
    { user: owner, others: 1, icons: [{ key: "diag", custom_emoji_id: "e1" }] },
    { message: { from: { id: 7 }, chat: { id: 100 }, photo: [{ file_id: "p" }] } },
  );
  const icons = of(r.calls, "icons", "select");
  assertEquals(icons.length, 1);
  assertEquals(icons[0].eq, [["user_id", 7]]);
  const kb = r.sent.find((s) => s.body.text === T.photoWhat)?.body.reply_markup.inline_keyboard.flat();
  assertEquals(kb.find((k: any) => k.callback_data === "ph:diag").icon_custom_emoji_id, "e1");
});

Deno.test("иконки не загрузились — отвечаем без них, ошибки пользователю нет", async () => {
  const r = await run(
    { user: owner, others: 1, iconsFail: true },
    { message: { from: { id: 7 }, chat: { id: 100 }, photo: [{ file_id: "p" }] } },
  );
  const kb = r.sent.find((s) => s.body.text === T.photoWhat)?.body.reply_markup.inline_keyboard.flat();
  assert(kb, "нет вопроса про фото");
  assert(kb.every((k: any) => !k.icon_custom_emoji_id));
  assert(!r.sent.some((s) => s.body.text === T.error));
});

Deno.test("сообщение: обработчик упал — «что-то сломалось», ошибка в лог", async () => {
  const r = await run({ user: owner, others: 1, sessionFail: true }, msg(7, "привет"));
  assertEquals(methods(r.sent), ["sendMessage"]);
  assertEquals(r.sent[0].body.text, T.error);
  assertEquals(r.sent[0].body.chat_id, 100);
  assert(r.errors.length >= 1);
});

Deno.test("кнопка: обработчик упал — сначала снимаем часики, потом «что-то сломалось»", async () => {
  const r = await run({ user: owner, others: 1, sessionFail: true }, cb(7, "rn:abc"));
  const tail = r.sent.slice(-2);
  assertEquals(methods(tail), ["answerCallbackQuery", "sendMessage"]);
  assertEquals(tail[0].body.callback_query_id, "cb1");
  assertEquals(tail[0].body.text, undefined);
  assertEquals(tail[1].body.text, T.error);
});
