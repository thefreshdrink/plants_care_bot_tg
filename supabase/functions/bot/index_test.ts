// тесты входной двери функции (index.ts) без сети:
// deno test supabase/functions/bot/index_test.ts
// разовая настройка ?setup — только с CRON_SECRET, ставит вебхук с секретом и
// меню команд; крон ?cron — только с заголовком x-cron-secret, пишет утро тем,
// у кого сейчас час сводки, и вечер тем, у кого час напоминания, и отмечает
// день, чтобы второй раз не писать; ошибка у одного человека не мешает
// остальным; апдейт телеграма — только с секретом вебхука, повтор того же
// update_id отбрасывается; просто открыть адрес — «plant bot».
// Deno.serve подменяем до загрузки index.ts и забираем обработчик; база —
// заглушка через _setDb; телеграм — подменённый fetch.
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
Deno.env.set("TELEGRAM_WEBHOOK_SECRET", "hook-secret");
Deno.env.set("CRON_SECRET", "cron-secret");

type Handler = (req: Request) => Promise<Response>;
let serve: Handler | null = null;
const origServe = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: Handler) => { serve = h; return { finished: Promise.resolve() }; };
const D = await import("./db.ts");
await import("./index.ts");
// deno-lint-ignore no-explicit-any
(Deno as any).serve = origServe;
const { localDate, localHour } = await import("./weather.ts");

// deno-lint-ignore no-explicit-any
type Call = { table: string; op: string; row?: any; eq: [string, unknown][] };
type World = {
  users?: Record<string, unknown>[];
  duplicate?: boolean;      // processed_updates уже видел этот update_id
  failUpdateFor?: number;   // users.update падает у этого telegram_id
};

function fakeDb(w: World, calls: Call[]) {
  D._setDb({
    from(table: string) {
      const c: Call = { table, op: "select", eq: [] };
      calls.push(c);
      let single = false;
      const chain: Record<string, unknown> = {
        select() { return proxy; },
        // deno-lint-ignore no-explicit-any
        insert(row: any) { c.op = "insert"; c.row = row; return proxy; },
        // deno-lint-ignore no-explicit-any
        update(row: any) { c.op = "update"; c.row = row; return proxy; },
        eq(k: string, v: unknown) { c.eq.push([k, v]); return proxy; },
        maybeSingle() { single = true; return proxy; },
        single() { single = true; return proxy; },
        then(ok: (r: unknown) => unknown, bad?: (e: unknown) => unknown) {
          if (table === "users" && c.op === "update" && c.eq.some(([k, v]) => k === "telegram_id" && v === w.failUpdateFor)) {
            return Promise.reject(new Error("db down")).then(ok, bad);
          }
          // deno-lint-ignore no-explicit-any
          let r: any = { data: single ? null : [], error: null };
          if (table === "users" && c.op === "select" && !single) r.data = w.users ?? [];
          if (table === "processed_updates" && c.op === "insert") r = { data: null, error: w.duplicate ? { code: "23505" } : null };
          return Promise.resolve(r).then(ok, bad);
        },
      };
      const proxy: unknown = new Proxy(chain, {
        get(t, k) { return k in t ? t[k as string] : () => proxy; },
      });
      return proxy;
    },
  });
}

// deno-lint-ignore no-explicit-any
type Sent = { method: string; body: any };
async function call(w: World, req: Request) {
  const calls: Call[] = [];
  fakeDb(w, calls);
  const sent: Sent[] = [];
  const errors: unknown[] = [];
  const orig = globalThis.fetch;
  const origErr = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split("/").pop()!;
    sent.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    const result = method === "getWebhookInfo" ? { url: "http://localhost:54321/functions/v1/bot", pending_update_count: 3 } : true;
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result }), { status: 200 }));
  }) as typeof fetch;
  try {
    const res = await serve!(req);
    const text = await res.text();
    await new Promise((r) => setTimeout(r, 20)); // дать фоновому handleUpdate отработать
    return { status: res.status, text, sent, calls, errors };
  } finally {
    globalThis.fetch = orig;
    console.error = origErr;
  }
}

const BASE = "http://localhost:54321/functions/v1/bot";
const TZ = "Asia/Nicosia";
const nowHour = () => localHour(TZ);
const otherHour = () => (nowHour() + 5) % 24;
const today = () => localDate(TZ);
const person = (id: number, extra: Record<string, unknown> = {}) => ({
  telegram_id: id, first_name: "x", lat: 35, lon: 33, tz: TZ,
  digest_hour: otherHour(), last_digest_on: null, evening_hour: null, last_evening_on: null, ...extra,
});

Deno.test("index: Deno.serve подхвачен при загрузке", () => {
  assert(serve, "index.ts должен звать Deno.serve");
});

Deno.test("index: просто открыть адрес — «plant bot», ни базы, ни телеграма", async () => {
  const r = await call({}, new Request(BASE));
  assertEquals([r.status, r.text], [200, "plant bot"]);
  assertEquals(r.calls.length, 0);
  assertEquals(r.sent.length, 0);
});

Deno.test("index: ?setup без секрета или с чужим — 403, ничего не делаем", async () => {
  for (const q of ["?setup", "?setup=", "?setup=hook-secret", "?setup=cron-secret2"]) {
    const r = await call({}, new Request(BASE + q));
    assertEquals([r.status, r.text], [403, "forbidden"], q);
    assertEquals(r.sent.length, 0, q);
  }
});

Deno.test("index: ?setup с CRON_SECRET — вебхук с секретом, меню команд, ответ с адресом", async () => {
  const r = await call({}, new Request(BASE + "?setup=cron-secret"));
  assertEquals(r.status, 200);
  assertEquals(r.sent.map((s) => s.method), ["setWebhook", "setMyCommands", "getWebhookInfo"]);
  assertEquals(r.sent[0].body, {
    url: BASE, secret_token: "hook-secret",
    allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
  });
  assert(r.sent[1].body.commands.length > 0);
  const body = JSON.parse(r.text);
  assertEquals([body.ok, body.webhook, body.pending], [true, BASE, 3]);
});

Deno.test("index: ?cron без заголовка или с секретом в адресе — 403, база не трогается", async () => {
  for (const req of [
    new Request(BASE + "?cron"),
    new Request(BASE + "?cron=cron-secret"),
    new Request(BASE + "?cron", { headers: { "x-cron-secret": "nope" } }),
  ]) {
    const r = await call({ users: [person(1, { digest_hour: nowHour() })] }, req);
    assertEquals([r.status, r.text], [403, "forbidden"]);
    assertEquals(r.calls.length, 0);
  }
});

Deno.test("index: крон — утро только тем, у кого сейчас час сводки и сегодня её не было", async () => {
  const users = [
    person(1, { digest_hour: nowHour() }),                          // пора
    person(2),                                                       // другой час
    person(3, { digest_hour: nowHour(), last_digest_on: today() }), // сегодня уже было
  ];
  const r = await call({ users }, new Request(BASE + "?cron", { headers: { "x-cron-secret": "cron-secret" } }));
  assertEquals(r.status, 200);
  const marks = r.calls.filter((c) => c.table === "users" && c.op === "update");
  assertEquals(marks.map((c) => [c.row, c.eq]), [[{ last_digest_on: today() }, [["telegram_id", 1]]]]);
  // иконки — свои у того, кому пишем
  assertEquals(r.calls.filter((c) => c.table === "icons").map((c) => c.eq), [[["user_id", 1]]]);
  // растений нет — сводка молчит, счёт отправленных 0
  assertEquals(JSON.parse(r.text), { ok: true, sent: 0, evening: 0 });
  assertEquals(r.sent.length, 0);
});

Deno.test("index: крон — вечер только тем, у кого включён и наступил час напоминания", async () => {
  const users = [
    person(4, { evening_hour: nowHour() }),                            // пора
    person(5, { evening_hour: null }),                                 // выключено
    person(6, { evening_hour: nowHour(), last_evening_on: today() }), // уже было
  ];
  const r = await call({ users }, new Request(BASE + "?cron", { headers: { "x-cron-secret": "cron-secret" } }));
  const marks = r.calls.filter((c) => c.table === "users" && c.op === "update");
  assertEquals(marks.map((c) => [c.row, c.eq]), [[{ last_evening_on: today() }, [["telegram_id", 4]]]]);
  assertEquals(JSON.parse(r.text), { ok: true, sent: 0, evening: 0 });
});

Deno.test("index: крон — ошибка у одного человека не мешает следующему", async () => {
  const users = [person(8, { digest_hour: nowHour() }), person(9, { digest_hour: nowHour() })];
  const r = await call({ users, failUpdateFor: 8 }, new Request(BASE + "?cron", { headers: { "x-cron-secret": "cron-secret" } }));
  assertEquals(r.status, 200);
  const marks = r.calls.filter((c) => c.table === "users" && c.op === "update").map((c) => c.eq[0][1]);
  assertEquals(marks, [8, 9]);
  assertEquals(r.errors.length, 1);
  assertEquals((r.errors[0] as unknown[]).slice(0, 2), ["digest", 8]);
});

Deno.test("index: апдейт без секрета вебхука или с чужим — 403, база не трогается", async () => {
  for (const headers of [{}, { "x-telegram-bot-api-secret-token": "cron-secret" }] as HeadersInit[]) {
    const r = await call({}, new Request(BASE, { method: "POST", headers, body: JSON.stringify({ update_id: 1 }) }));
    assertEquals([r.status, r.text], [403, "forbidden"]);
    assertEquals(r.calls.length, 0);
  }
});

const hook = (update: unknown) =>
  new Request(BASE, {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "hook-secret" },
    body: JSON.stringify(update),
  });

Deno.test("index: повтор того же update_id — сразу ok, дальше не идём", async () => {
  const r = await call({ duplicate: true }, hook({ update_id: 42, message: { chat: { id: 7 }, from: { id: 7 }, text: "/start" } }));
  assertEquals([r.status, JSON.parse(r.text)], [200, { ok: true }]);
  assertEquals(r.calls.map((c) => [c.table, c.op, c.row]), [["processed_updates", "insert", { update_id: 42 }]]);
  assertEquals(r.sent.length, 0);
});

Deno.test("index: новый апдейт — ok сразу, обработка идёт дальше в фоне", async () => {
  // чужой человек: handleUpdate спросит базу и ответит «это личный бот»
  const r = await call({}, hook({ update_id: 43, message: { chat: { id: 999 }, from: { id: 999 }, text: "привет" } }));
  assertEquals([r.status, JSON.parse(r.text)], [200, { ok: true }]);
  assertEquals(r.calls[0].table, "processed_updates");
  assert(r.calls.length > 1, "после отметки апдейт ушёл в handleUpdate");
});

Deno.test("index: апдейт без числового update_id не отмечается, но обрабатывается", async () => {
  const r = await call({}, hook({ message: { chat: { id: 999 }, from: { id: 999 }, text: "привет" } }));
  assertEquals(r.status, 200);
  assert(!r.calls.some((c) => c.table === "processed_updates"));
  assert(r.calls.length > 0);
});
