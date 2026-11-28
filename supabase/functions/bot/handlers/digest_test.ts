// тесты утренней сводки и вечернего напоминания без сети: deno test supabase/functions/bot/handlers/digest_test.ts
// digest() решает, писать ли вообще (тихий день — молчим), что сказать и какие кнопки дать.
// база — заглушка через _setDb, сеть (open-meteo и телеграм) — подменённый fetch,
// который отдаёт ровную погоду и записывает каждое сообщение в телеграм.
// db.ts при загрузке создаёт клиент supabase из переменных окружения, поэтому
// ставим пустышки и грузим модули уже после этого.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Plant, User } from "../db.ts";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const D = await import("../db.ts");
const { digest } = await import("./digest.ts");
const { localDate } = await import("../weather.ts");
const { T } = await import("../texts.ts");

const TZ = "Asia/Nicosia";
const today = localDate(TZ);
const shift = (date: string, k: number) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};

// база отдаёт только список растений
function fakeDb(rows: Plant[]) {
  const db = {
    from() {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        order() { return chain; },
        then(ok: (r: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: rows, error: null }).then(ok);
        },
      };
      return chain;
    },
  };
  D._setDb(db);
}

// ровная погода: тепло, сухо, без ветра — ни одного погодного предупреждения
function weatherJson() {
  const time: string[] = [];
  for (let k = -45; k <= 6; k++) time.push(shift(today, k));
  const fill = (v: number) => time.map(() => v);
  return {
    daily: {
      time,
      temperature_2m_max: fill(22), temperature_2m_min: fill(15),
      precipitation_sum: fill(0), precipitation_probability_max: fill(0),
      et0_fao_evapotranspiration: fill(2), wind_gusts_10m_max: fill(10),
      uv_index_max: fill(3), weather_code: fill(1),
    },
  };
}

type Sent = { method: string; body: any };
async function run(rows: Plant[], f: (sent: Sent[]) => Promise<void>) {
  fakeDb(rows);
  const sent: Sent[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let j: unknown = { ok: true, result: {} };
    if (url.includes("air-quality")) j = { hourly: { time: [], dust: [] } };
    else if (url.includes("open-meteo")) j = weatherJson();
    else sent.push({ method: url.split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
    return Promise.resolve(new Response(JSON.stringify(j), { status: 200 }));
  }) as typeof fetch;
  try {
    await f(sent);
  } finally {
    globalThis.fetch = orig;
  }
}

// у каждого теста свои координаты: погода кешируется по ним на время запроса
let uid = 0;
const user = (): User => {
  uid++;
  return {
    telegram_id: uid, first_name: "a", lat: 34 + uid / 100, lon: 33, tz: TZ,
    digest_hour: 8, last_digest_on: null, evening_hour: null, last_evening_on: null,
  };
};

// комнатное растение раз в 7 дней: полито 30 дней назад — пора, вчера — нет
const plant = (id: string, room: string, wateredDaysAgo: number): Plant => ({
  id, user_id: 0, nickname: id, species: null, common_name: null, room, location: "indoor",
  photo_file_id: null, photo_path: null, care: {},
  water_every_days: 7, water_winter_days: null, feed_every_days: null,
  cold_min_c: null, heat_sensitive: false,
  last_watered_at: shift(today, -wateredDaysAgo) + "T09:00:00Z", last_fed_at: null, snoozed_until: null,
  archived: false, created_at: "2025-01-01T00:00:00Z",
});

const datas = (s: Sent) =>
  (s.body.reply_markup?.inline_keyboard ?? []).flat().map((x: { callback_data: string }) => x.callback_data);

Deno.test("пустой сад: по расписанию молчим, по кнопке — подсказка", async () => {
  await run([], async (sent) => {
    assertEquals(await digest(user(), 1, false), false);
    assertEquals(sent.length, 0);
    assertEquals(await digest(user(), 1, true), false);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].body.text, T.emptyCollection);
  });
});

Deno.test("тихий день: по расписанию не пишем, по кнопке — «никого» и следующий полив", async () => {
  const ps = [plant("фикус", "кухня", 1), plant("монстера", "кухня", 3)];
  await run(ps, async (sent) => {
    assertEquals(await digest(user(), 1, false), false);
    assertEquals(sent.length, 0);
    assertEquals(await digest(user(), 1, true), true);
    assertEquals(sent.length, 1);
    const text: string = sent[0].body.text;
    assert(text.includes(T.nothingToday), text);
    // следующий — тот, кого поливали раньше
    assert(text.includes("следующий: монстера"), text);
    assertEquals(datas(sent[0]), []);
  });
});

Deno.test("вечер: всё полито — молчим, даже по кнопке погода не нужна", async () => {
  await run([plant("фикус", "кухня", 1)], async (sent) => {
    assertEquals(await digest(user(), 1, false, true), false);
    assertEquals(sent.length, 0);
  });
});

Deno.test("пора поливать: кнопки на каждое растение, комнату и «всё полито»", async () => {
  const ps = [plant("фикус", "кухня", 30), plant("монстера", "кухня", 30), plant("кактус", "спальня", 30), plant("пальма", "спальня", 1)];
  await run(ps, async (sent) => {
    assertEquals(await digest(user(), 1, false), true);
    assertEquals(sent.length, 1);
    const text: string = sent[0].body.text;
    assert(text.includes("<b>полить</b>"), text);
    assert(text.includes("<i>кухня</i>") && text.includes("<i>спальня</i>"), text);
    assert(!text.includes("пальма"), "кого не пора поливать, в сводке нет");
    assertEquals(datas(sent[0]), ["wr:кухня", "wd:фикус", "wd:монстера", "wd:кактус", "wall"]);
  });
});

Deno.test("одно растение к поливу: без кнопки комнаты и без «всё полито»", async () => {
  await run([plant("фикус", "кухня", 30), plant("монстера", "кухня", 1)], async (sent) => {
    assertEquals(await digest(user(), 1, false), true);
    assertEquals(datas(sent[0]), ["wd:фикус"]);
  });
});

Deno.test("вечер: только неполитое, без погоды", async () => {
  await run([plant("фикус", "кухня", 30), plant("монстера", "кухня", 1)], async (sent) => {
    assertEquals(await digest(user(), 1, false, true), true);
    const text: string = sent[0].body.text;
    assert(text.startsWith(`<b>${T.eveningHead}</b>`), text);
    assert(text.includes(T.eveningDue), text);
    assert(!text.includes("°"), "вечером без температуры");
  });
});
