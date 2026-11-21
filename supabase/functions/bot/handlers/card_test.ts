// тесты карточки растения и истории без сети: deno test supabase/functions/bot/handlers/card_test.ts
// card() — экран одного растения, history() — его история с быстрыми заметками,
// careText() — «инфо». кнопки карточки уже покрыты в card_keyboard_test.ts,
// строки истории — в history_line_test.ts; здесь — как экраны собираются из базы.
// база — заглушка через _setDb, сеть (open-meteo и телеграм) — подменённый fetch,
// как в garden_test.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Plant, PlantEvent, User } from "../db.ts";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const D = await import("../db.ts");
const { card, careText, history, QUICK_NOTES } = await import("./card.ts");
const { historyLine } = await import("./history_line.ts");
const { localDate } = await import("../weather.ts");
const { LOC_SHORT, T } = await import("../texts.ts");

const TZ = "Asia/Nicosia";
const today = localDate(TZ);
const shift = (date: string, k: number) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};

// база: plants отдаёт растение по id (maybeSingle), events — историю
function fakeDb(rows: Plant[], events: PlantEvent[]) {
  const db = {
    from(table: string) {
      let id: string | null = null;
      let single = false;
      const chain = {
        select() { return chain; },
        eq(col: string, v: unknown) { if (col === "id") id = String(v); return chain; },
        in() { return chain; },
        gte() { return chain; },
        order() { return chain; },
        limit() { return chain; },
        maybeSingle() { single = true; return chain; },
        then(ok: (r: { data: unknown; error: null }) => unknown) {
          let data: unknown = table === "events" ? events : rows;
          if (single) data = rows.find((p) => p.id === id) ?? null;
          return Promise.resolve({ data, error: null }).then(ok);
        },
      };
      return chain;
    },
    storage: {
      from() {
        return {
          createSignedUrl(path: string) {
            return Promise.resolve({ data: { signedUrl: `https://store.test/${path}` }, error: null });
          },
        };
      },
    },
  };
  D._setDb(db);
}

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
async function run(rows: Plant[], events: PlantEvent[], f: (sent: Sent[]) => Promise<void>) {
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

let uid = 2000;
const user = (): User => {
  uid++;
  return {
    telegram_id: uid, first_name: "a", lat: 35 + uid / 10000, lon: 33, tz: TZ,
    digest_hour: 8, last_digest_on: null, evening_hour: null, last_evening_on: null,
  };
};

const plant = (id: string, wateredDaysAgo: number, extra: Partial<Plant> = {}): Plant => ({
  id, user_id: 0, nickname: id, species: null, common_name: null, room: "кухня", location: "indoor",
  photo_file_id: null, photo_path: null, care: {},
  water_every_days: 7, water_winter_days: null, feed_every_days: null,
  cold_min_c: null, heat_sensitive: false,
  last_watered_at: shift(today, -wateredDaysAgo) + "T09:00:00Z", last_fed_at: null, snoozed_until: null,
  archived: false, created_at: "2025-01-01T00:00:00Z", ...extra,
});

const datas = (s: Sent) =>
  (s.body.reply_markup?.inline_keyboard ?? []).flat().map((x: { callback_data: string }) => x.callback_data);
const rows = (s: Sent) =>
  (s.body.reply_markup?.inline_keyboard ?? []).map((r: { callback_data: string }[]) => r.map((x) => x.callback_data));

// ---------- карточка

Deno.test("карточка: растения нет — короткий ответ без кнопок", async () => {
  await run([], [], async (sent) => {
    await card(user(), 1, "нет");
    assertEquals(sent.length, 1);
    assertEquals(sent[0].body.text, "такого растения нет в коллекции.");
    assertEquals(datas(sent[0]), []);
  });
});

Deno.test("карточка: имя, комната, шкала и последний полив; кнопки как у cardKeyboard", async () => {
  await run([plant("фикус", 30)], [], async (sent) => {
    await card(user(), 1, "фикус");
    assertEquals(sent.length, 1);
    assertEquals(sent[0].method, "sendMessage");
    const lines = sent[0].body.text.split("\n");
    assertEquals(lines[0], "<b>фикус</b>");
    assert(lines[1].startsWith("кухня · "), lines[1]);
    assertEquals(lines[2], "");
    assert(lines.some((l: string) => l.startsWith("последний полив: ")), sent[0].body.text);
    // комнатное, без фото, подкормка не задана
    assertEquals(datas(sent[0]), ["w:фикус", "snz:фикус", "care:фикус", "nph:фикус", "hist:фикус", "ed:фикус", "list"]);
    assertEquals(sent[0].body.link_preview_options, { is_disabled: true });
  });
});

Deno.test("карточка: имя экранируется", async () => {
  await run([plant("<b>", 1)], [], async (sent) => {
    await card(user(), 1, "<b>");
    assertEquals(sent[0].body.text.split("\n")[0], "<b>&lt;b&gt;</b>");
  });
});

Deno.test("карточка: с фото — крупно над текстом, без кнопки «добавить фото»", async () => {
  const p = plant("кактус", 1, { photo_file_id: "f1", photo_path: "7/кактус.jpg" });
  await run([p], [], async (sent) => {
    await card(user(), 1, "кактус");
    assertEquals(sent[0].body.link_preview_options, {
      url: "https://store.test/7/кактус.jpg", prefer_large_media: true, show_above_text: true,
    });
    assert(!datas(sent[0]).includes("nph:кактус"));
  });
});

Deno.test("карточка: на улице — есть кнопка «был дождь»", async () => {
  await run([plant("роза", 1, { location: "outdoor_pot" })], [], async (sent) => {
    await card(user(), 1, "роза");
    assert(datas(sent[0]).includes("rain:c:роза"), datas(sent[0]).join(" "));
  });
});

Deno.test("карточка: со старым сообщением — правит его, а не шлёт новое", async () => {
  await run([plant("фикус", 3)], [], async (sent) => {
    await card(user(), 1, "фикус", 55);
    assertEquals(sent.length, 1);
    assertEquals(sent[0].method, "editMessageText");
    assertEquals(sent[0].body.message_id, 55);
  });
});

// ---------- история

Deno.test("история: растения нет — короткий ответ", async () => {
  await run([], [], async (sent) => {
    await history(user(), 1, "нет");
    assertEquals(sent[0].body.text, "такого растения нет в коллекции.");
  });
});

Deno.test("история: пусто — подсказка, заметка, быстрые заметки по две, назад к растению", async () => {
  await run([plant("фикус", 3)], [], async (sent) => {
    await history(user(), 1, "фикус");
    assertEquals(sent.length, 1);
    assertEquals(sent[0].body.text, ["<b>фикус</b> · история", "", T.historyEmpty].join("\n"));
    assertEquals(QUICK_NOTES.length, 4);
    assertEquals(rows(sent[0]), [
      ["hn:фикус"],
      ["hq:фикус:0", "hq:фикус:1"],
      ["hq:фикус:2", "hq:фикус:3"],
      ["p:фикус"],
    ]);
  });
});

Deno.test("история: события строками historyLine в порядке базы", async () => {
  const evs: PlantEvent[] = [
    { kind: "note", note: "новый лист", created_at: shift(today, -1) + "T10:00:00Z" },
    { kind: "water", note: null, created_at: shift(today, -5) + "T10:00:00Z" },
  ] as PlantEvent[];
  await run([plant("фикус", 1)], evs, async (sent) => {
    const u = user();
    await history(u, 1, "фикус");
    const lines = sent[0].body.text.split("\n");
    assertEquals(lines.slice(2), evs.map((e) => historyLine(u.tz, e)));
  });
});

// ---------- инфо

Deno.test("инфо: растения нет — молчит", async () => {
  await run([], [], async (sent) => {
    await careText(user(), 1, "нет");
    assertEquals(sent.length, 0);
  });
});

Deno.test("инфо: шапка отдельно, потом разделы раскрывающимся списком, назад к растению", async () => {
  const p = plant("фикус", 1, {
    species: "Ficus elastica",
    care: { summary: "неприхотлив", water_how: "до просыхания", light: "яркий рассеянный" },
    water_winter_days: 14, cold_min_c: 10,
  });
  await run([p], [], async (sent) => {
    await careText(user(), 1, "фикус");
    assertEquals(sent.map((s) => s.method), ["sendMessage", "sendRichMessage"]);
    assertEquals(sent[0].body.text, `<b>фикус</b>\n<i>Ficus elastica</i> · кухня · ${LOC_SHORT.indoor}\n\n<i>неприхотлив</i>`);
    const html: string = sent[1].body.rich_message.html;
    // полив раскрыт сразу, пустые разделы не показываются
    assert(html.startsWith("<details open><summary><b>полив</b></summary><p>до просыхания<br/>летом раз в "), html);
    assert(html.includes("зимой раз в "), html);
    assert(html.includes("<summary><b>свет</b></summary>"), html);
    assert(!html.includes("<summary><b>почва</b></summary>"), html);
    assert(html.includes("переносит до 10°"), html);
    assertEquals(datas(sent[1]), ["p:фикус"]);
  });
});
