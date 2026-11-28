// тесты экрана «сад» (/garden) и одной комнаты без сети: deno test supabase/functions/bot/handlers/garden_test.ts
// list() показывает комнаты со счётом «ждут», roomScreen() — растения одной комнаты.
// база — заглушка через _setDb (растения и события полива отдельно),
// сеть (open-meteo и телеграм) — подменённый fetch, как в digest_test.ts.
// db.ts при загрузке создаёт клиент supabase из переменных окружения, поэтому
// ставим пустышки и грузим модули уже после этого.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Plant, User } from "../db.ts";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const D = await import("../db.ts");
const { list, roomScreen } = await import("./garden.ts");
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

const btns = (s: Sent) =>
  (s.body.reply_markup?.inline_keyboard ?? []).map((row: { text: string; callback_data: string }[]) =>
    row.map((x) => `${x.text}|${x.callback_data}`));

Deno.test("пустой сад: подсказка вместо списка", async () => {
  await run([], [], async (sent) => {
    await list(user(), 1);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].body.text, T.emptyCollection);
  });
});

Deno.test("сад: заголовок с числом, «полить сегодня», комнаты в порядке базы", async () => {
  const rows = [plant("фикус", "кухня", 30), plant("кактус", "спальня", 1), plant("монстера", "кухня", 2)];
  await run(rows, [], async (sent) => {
    await list(user(), 1);
    const lines: string[] = sent[0].body.text.split("\n");
    assertEquals(lines[0], T.gardenTitle(3));
    assertEquals(lines[1], T.waterToday(1));
    assertEquals(lines.slice(3), ["<b>кухня</b> · 2 растения · ждут 1", "<b>спальня</b> · 1 растение"]);
    assertEquals(btns(sent[0]), [["кухня · 1|rmv:0", "спальня|rmv:1"], ["неделя|wk:0"]]);
  });
});

Deno.test("сад: никого поливать — «сегодня никого», кнопки комнат без счёта", async () => {
  await run([plant("фикус", "кухня", 1)], [], async (sent) => {
    await list(user(), 1);
    const lines: string[] = sent[0].body.text.split("\n");
    assertEquals(lines[1], T.nothingToday);
    assertEquals(btns(sent[0]), [["кухня|rmv:0"], ["неделя|wk:0"]]);
  });
});

Deno.test("сад: кнопки комнат по две в ряд", async () => {
  const rows = ["а", "б", "в", "г", "д"].map((r, i) => plant("p" + i, r, 1));
  await run(rows, [], async (sent) => {
    await list(user(), 1);
    assertEquals(btns(sent[0]).map((r: string[]) => r.length), [2, 2, 1, 1]);
  });
});

Deno.test("комната: шапка, «ждут», кнопка полить всю комнату и растения", async () => {
  const rows = [plant("фикус", "кухня", 30), plant("кактус", "спальня", 1), plant("монстера", "кухня", 2)];
  await run(rows, [], async (sent) => {
    await roomScreen(user(), 1, 0);
    const lines: string[] = sent[0].body.text.split("\n");
    assert(lines[0].startsWith("<b>кухня</b> · "), lines[0]);
    assertEquals(lines[1], "2 растения, ждут 1");
    assertEquals(lines.length, 5);
    assert(lines[3].includes("фикус · сегодня"), lines[3]);
    assert(lines[4].includes("монстера · через"), lines[4]);
    assertEquals(btns(sent[0]), [["полито: кухня · 1|wrv:0:r"], ["фикус|p:фикус", "монстера|p:монстера"], ["← сад|list"]]);
  });
});

Deno.test("комната: все политы — без кнопки «полито», подпись «все политы»", async () => {
  await run([plant("кактус", "спальня", 1)], [], async (sent) => {
    await roomScreen(user(), 1, 0);
    const lines: string[] = sent[0].body.text.split("\n");
    assertEquals(lines[1], "1 растение, все политы");
    assert(lines[3].includes("кактус · через"), lines[3]);
    assertEquals(btns(sent[0]), [["кактус|p:кактус"], ["← сад|list"]]);
  });
});

Deno.test("комната по старому номеру, которой уже нет, — возвращает в сад", async () => {
  await run([plant("фикус", "кухня", 1)], [], async (sent) => {
    await roomScreen(user(), 1, 5);
    assertEquals(sent.length, 1);
    assert(sent[0].body.text.startsWith(T.gardenTitle(1)), sent[0].body.text);
  });
});
