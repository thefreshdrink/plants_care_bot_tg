// тесты недели полива (/week) без сети: deno test supabase/functions/bot/handlers/week_test.ts
// week() строит неделю по дням или сеткой и даёт кнопки листать вперёд-назад.
// база — заглушка через _setDb (растения и события полива отдельно),
// сеть (open-meteo и телеграм) — подменённый fetch, как в digest_test.ts.
// db.ts при загрузке создаёт клиент supabase из переменных окружения, поэтому
// ставим пустышки и грузим модули уже после этого.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Plant, User } from "../db.ts";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const D = await import("../db.ts");
const { week } = await import("./week.ts");
const { localDate } = await import("../weather.ts");
const { T } = await import("../texts.ts");

const TZ = "Asia/Nicosia";
const today = localDate(TZ);
const shift = (date: string, k: number) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};

type Ev = { plant_id: string; created_at: string };
// база: таблица plants отдаёт растения, events — поливы
function fakeDb(rows: Plant[], events: Ev[]) {
  const db = {
    from(table: string) {
      const data = table === "events" ? events : rows;
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        in() { return chain; },
        gte() { return chain; },
        order() { return chain; },
        then(ok: (r: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data, error: null }).then(ok);
        },
      };
      return chain;
    },
  };
  D._setDb(db);
}

// ровная погода: тепло, сухо, без ветра
function weatherJson() {
  const time: string[] = [];
  for (let k = -45; k <= 30; k++) time.push(shift(today, k));
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
async function run(rows: Plant[], events: Ev[], f: (sent: Sent[]) => Promise<void>) {
  fakeDb(rows, events);
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
let uid = 1000;
const user = (): User => {
  uid++;
  return {
    telegram_id: uid, first_name: "a", lat: 35 + uid / 10000, lon: 33, tz: TZ,
    digest_hour: 8, last_digest_on: null, evening_hour: null, last_evening_on: null,
  };
};

// комнатное растение раз в 7 дней
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

Deno.test("пустой сад: подсказка вместо недели", async () => {
  await run([], [], async (sent) => {
    await week(user(), 1, 0);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].body.text, T.emptyCollection);
  });
});

Deno.test("кнопки: эта неделя — только «дальше», третья вперёд — только «раньше»", async () => {
  await run([plant("фикус", "кухня", 2)], [], async (sent) => {
    await week(user(), 1, 0);
    assertEquals(datas(sent[0]), ["wk:1:d", "wk:0:g", "today", "list"]);
    await week(user(), 1, 1);
    assertEquals(datas(sent[1]), ["wk:0:d", "wk:2:d", "wk:1:g", "today", "list"]);
    await week(user(), 1, 3);
    assertEquals(datas(sent[2]), ["wk:2:d", "wk:3:g", "today", "list"]);
  });
});

Deno.test("сеткой: таблица с легендой, кнопка обратно «по дням»", async () => {
  await run([plant("фикус", "кухня", 2)], [], async (sent) => {
    await week(user(), 1, 0, undefined, "g");
    const text: string = sent[0].body.text;
    assert(text.includes("<pre>") && text.includes("фикус"), text);
    assert(text.includes(T.weekLegend), text);
    assertEquals(datas(sent[0]), ["wk:1:g", "wk:0:d", "today", "list"]);
  });
});

Deno.test("по дням: пора поливать — в сегодняшнем дне, не зачёркнуто", async () => {
  await run([plant("фикус", "кухня", 30)], [], async (sent) => {
    await week(user(), 1, 0);
    const text: string = sent[0].body.text;
    const todayBlock = text.split("\n\n").find((x) => x.includes("· сегодня"));
    assert(todayBlock, text);
    assert(todayBlock.includes("<i>кухня:</i> фикус"), todayBlock);
    assert(!text.includes("<s>") && !text.includes(T.weekDoneHint), text);
  });
});

Deno.test("по дням: полито сегодня — зачёркнуто и подсказка под неделей", async () => {
  const p = plant("фикус", "кухня", 0);
  await run([p], [{ plant_id: p.id, created_at: new Date().toISOString() }], async (sent) => {
    await week(user(), 1, 0);
    const text: string = sent[0].body.text;
    assert(text.includes("<s>фикус</s>"), text);
    assert(text.includes(T.weekDoneHint), text);
  });
});

Deno.test("следующая неделя: поливы прошлого не запрашиваются и не зачёркиваются", async () => {
  const p = plant("фикус", "кухня", 0);
  await run([p], [{ plant_id: p.id, created_at: new Date().toISOString() }], async (sent) => {
    await week(user(), 1, 1);
    const text: string = sent[0].body.text;
    assert(!text.includes("<s>"), text);
    assert(!text.includes("· сегодня"), text);
  });
});
