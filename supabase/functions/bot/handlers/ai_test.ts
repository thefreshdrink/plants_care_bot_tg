// тесты ответов claude без сети: deno test supabase/functions/bot/handlers/ai_test.ts
// ai.ts: diagnose() — диагноз по фото (с растением из коллекции или без),
// freeChat() — свободный чат с контекстом сада и памятью на 12 реплик.
// код бота не меняется — тест фиксирует то, что есть. сами подсказки claude
// (system) не проверяются: это тексты, а не поведение.
// телеграм, open-meteo и anthropic — подменённый fetch (anthropic отвечает
// потоком событий, как настоящий); база — заглушка через _setDb.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Plant, User } from "../db.ts";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const D = await import("../db.ts");
const { diagnose, freeChat } = await import("./ai.ts");
const { localDate } = await import("../weather.ts");

const TZ = "Asia/Nicosia";
const today = localDate(TZ);
const shift = (date: string, k: number) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};

// у каждого теста своя широта: погода кешируется в модуле по месту
let lat = 30;
const user = (): User => ({
  telegram_id: 7, first_name: "a", lat: (lat += 0.01), lon: 33, tz: TZ,
  digest_hour: 8, last_digest_on: null, evening_hour: null, last_evening_on: null,
});

const plant = (id: string, extra: Partial<Plant> = {}): Plant => ({
  id, user_id: 7, nickname: id, species: "Ficus elastica", common_name: null, room: "кухня", location: "indoor",
  photo_file_id: null, photo_path: null, care: {},
  water_every_days: 7, water_winter_days: null, feed_every_days: null,
  cold_min_c: 5, heat_sensitive: false,
  last_watered_at: shift(today, -2) + "T09:00:00Z", last_fed_at: null, snoozed_until: null,
  archived: false, created_at: "2025-01-01T00:00:00Z",
  ...extra,
});

// база: plants — коллекция (по id — maybeSingle), events и sessions запоминают запись
type Write = { table: string; op: string; row: any };
function fakeDb(rows: Plant[]) {
  const writes: Write[] = [];
  D._setDb({
    from(table: string) {
      let id: string | null = null;
      let single = false;
      const chain = {
        select() { return chain; },
        eq(col: string, v: unknown) { if (col === "id") id = String(v); return chain; },
        order() { return chain; },
        maybeSingle() { single = true; return chain; },
        insert(row: any) { writes.push({ table, op: "insert", row }); return chain; },
        upsert(row: any) { writes.push({ table, op: "upsert", row }); return chain; },
        then(ok: (r: { data: unknown; error: null }) => unknown) {
          const data = single ? rows.find((p) => p.id === id) ?? null : rows;
          return Promise.resolve({ data, error: null }).then(ok);
        },
      };
      return chain;
    },
  });
  return writes;
}

// погода: по 22/15°, без дождя, на 10 дней назад и 5 вперёд
function meteo() {
  const time: string[] = [];
  for (let k = -10; k <= 5; k++) time.push(shift(today, k));
  const fill = (v: number) => time.map(() => v);
  return new Response(JSON.stringify({
    daily: {
      time,
      temperature_2m_max: fill(22), temperature_2m_min: fill(15),
      precipitation_sum: fill(0), precipitation_probability_max: fill(0),
      et0_fao_evapotranspiration: fill(2), wind_gusts_10m_max: fill(10),
      uv_index_max: fill(3), weather_code: fill(1),
    },
  }), { status: 200 });
}

// ответ anthropic потоком: текст приходит двумя кусками
function stream(parts: string[]) {
  const ev = parts.map((t) => `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: t } })}\n`);
  return new Response(["event: message_start\n", ...ev, "data: {\"type\":\"message_stop\"}\n"].join(""), { status: 200 });
}

type Call = { url: string; method: string; body: any };
async function withNet(answer: string[], f: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let body: any = null;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = init?.body; }
    const method = url.split("?")[0].split("/").pop()!;
    calls.push({ url, method, body });
    if (url.includes("air-quality")) return new Response("{}");
    if (url.startsWith("https://api.open-meteo.com/")) return meteo();
    if (url.startsWith("https://api.anthropic.com/")) return stream(answer);
    if (url.includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    if (method === "getFile") return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/a.jpg" } }));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 50 } }));
  }) as typeof fetch;
  try {
    await f(calls);
  } finally {
    globalThis.fetch = orig;
  }
}

const claudeCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith("https://api.anthropic.com/"));
const tgOut = (calls: Call[], m: string) => calls.filter((c) => c.url.startsWith("https://api.telegram.org/bot") && c.method === m);

// ---------- диагностика

Deno.test("diagnose: растение из коллекции — его данные в вопросе, запись в истории, кнопка к карточке", async () => {
  const writes = fakeDb([plant("p1", { nickname: "фикус" })]);
  await withNet(["листья ", "в порядке"], async (calls) => {
    await diagnose(user(), 100, "FILE1", "p1", "почему желтеет?");
    assertEquals(tgOut(calls, "sendChatAction").length, 1, "сначала «печатает»");
    const [c] = claudeCalls(calls);
    assert(c, "claude спрошен");
    assertEquals(c.body.stream, true);
    const [img, txt] = c.body.messages[0].content;
    assertEquals(img.type, "image");
    assertEquals(img.source.data, "AQID", "фото из телеграма уходит в base64");
    assert(txt.text.includes("растение: фикус (Ficus elastica)"), txt.text);
    assert(txt.text.includes("раз в 7 дн."), txt.text);
    assert(txt.text.endsWith("почему желтеет?"), "вопрос в конце");
    // погода: последние 7 дней и сегодня
    assertEquals((txt.text.match(/22\/15°/g) ?? []).length, 8);

    assertEquals(writes, [{
      table: "events", op: "insert",
      row: { user_id: 7, plant_id: "p1", kind: "diagnosis", note: "листья в порядке", photo_file_id: "FILE1" },
    }]);
    const [m] = tgOut(calls, "sendMessage");
    assertEquals(m.body.text, "листья в порядке");
    assertEquals(m.body.reply_markup.inline_keyboard.flat().map((x: any) => x.callback_data), ["p:p1"]);
  });
});

Deno.test("diagnose: без растения — «не из коллекции», в историю не пишет, без кнопок, вопрос по умолчанию", async () => {
  const writes = fakeDb([]);
  await withNet(["всё хорошо"], async (calls) => {
    await diagnose(user(), 100, "FILE2", null);
    const txt = claudeCalls(calls)[0].body.messages[0].content[1].text;
    assert(txt.startsWith("растение не из коллекции."), txt);
    assert(txt.endsWith("что с ним?"), txt);
    assertEquals(writes, []);
    const [m] = tgOut(calls, "sendMessage");
    assertEquals(m.body.reply_markup, undefined);
  });
});

Deno.test("diagnose: растение убрано в архив — как будто не из коллекции, но запись в историю есть", async () => {
  const writes = fakeDb([]); // plant() архивные не отдаёт
  await withNet(["ok"], async (calls) => {
    await diagnose(user(), 100, "FILE3", "gone");
    assert(claudeCalls(calls)[0].body.messages[0].content[1].text.startsWith("растение не из коллекции."));
    assertEquals(writes.map((w) => [w.table, w.row.plant_id]), [["events", "gone"]]);
  });
});

Deno.test("diagnose: с номером сообщения правит его, а не шлёт новое", async () => {
  fakeDb([plant("p1")]);
  await withNet(["ответ"], async (calls) => {
    await diagnose(user(), 100, "FILE1", "p1", undefined, 42);
    assertEquals(tgOut(calls, "sendMessage").length, 0);
    const [e] = tgOut(calls, "editMessageText");
    assertEquals(e.body.message_id, 42);
    assertEquals(e.body.text, "ответ");
  });
});

Deno.test("diagnose: ответ claude экранируется для html телеграма", async () => {
  fakeDb([]);
  await withNet(["pH <6 & влага >70%"], async (calls) => {
    await diagnose(user(), 100, "FILE1", null);
    assertEquals(tgOut(calls, "sendMessage")[0].body.text, "pH &lt;6 &amp; влага &gt;70%");
  });
});

// ---------- свободный чат

Deno.test("freeChat: в claude уходят 10 последних реплик и новый вопрос, в сессии — 12 последних", async () => {
  const writes = fakeDb([plant("p1", { nickname: "фикус" })]);
  const history = Array.from({ length: 14 }, (_, k) => ({ role: k % 2 ? "assistant" : "user", content: `r${k}` }));
  await withNet(["поли", "вай завтра"], async (calls) => {
    await freeChat(user(), 100, "когда поливать?", history);
    const [c] = claudeCalls(calls);
    assertEquals(c.body.messages.map((m: any) => m.content), [
      "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "r13", "когда поливать?",
    ]);
    assert(c.body.system.includes(`сегодня ${today}.`), "дата в контексте");
    assert(c.body.system.includes("- фикус (Ficus elastica), кухня,"), "коллекция в контексте");
    assert(c.body.system.includes("переносит до 5°"));

    const [s] = writes;
    assertEquals([s.table, s.op, s.row.user_id], ["sessions", "upsert", 7]);
    assertEquals(s.row.history.map((m: any) => m.content), [
      "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "r13", "когда поливать?", "поливай завтра",
    ].slice(-12));
    assertEquals(s.row.history.at(-1), { role: "assistant", content: "поливай завтра" });
    assertEquals(writes.length, 1, "только сессия, в историю растений не пишет");

    assertEquals(tgOut(calls, "sendMessage")[0].body.text, "поливай завтра");
  });
});

Deno.test("freeChat: пустой сад — так и сказано; прогноз на сегодня и три дня вперёд", async () => {
  fakeDb([]);
  await withNet(["ок"], async (calls) => {
    await freeChat(user(), 100, "привет", []);
    const sys = claudeCalls(calls)[0].body.system;
    assert(sys.includes("коллекция:\nколлекция пока пустая"), sys);
    const forecast = sys.split("прогноз:\n")[1].split("\n\n")[0].split("\n");
    assertEquals(forecast.map((l: string) => l.slice(0, 10)), [0, 1, 2, 3].map((k) => shift(today, k)));
  });
});

Deno.test("freeChat: короткая история уходит целиком", async () => {
  const writes = fakeDb([]);
  await withNet(["да"], async (calls) => {
    const history = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
    await freeChat(user(), 100, "c", history);
    assertEquals(claudeCalls(calls)[0].body.messages.map((m: any) => m.content), ["a", "b", "c"]);
    assertEquals(writes[0].row.history.map((m: any) => m.content), ["a", "b", "c", "да"]);
    assertEquals(history.length, 2, "переданную историю не меняет");
  });
});
