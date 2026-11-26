// тесты кнопок без сети: deno test supabase/functions/bot/handlers/callbacks_test.ts
// onCallback() разбирает callback_data и решает, что ответить и что записать.
// здесь — развилки, которые не уходят в другие экраны: режимы ожидания
// (переименовать, новое фото, заметка, новая комната, эмодзи), отмена
// добавления, подтверждение «убрать из сада», час сводки, «напомню завтра»,
// «чаще/реже». сами экраны (карточка, сад, сводка, неделя) покрыты своими
// тестами; что у каждой кнопки есть case — callbacks_wiring_test.ts.
// база — заглушка через _setDb, как в messages_test.ts: sessions отдаёт
// заданную сессию, plants — заданное растение, остальное пусто; записи
// запоминаются. телеграм — подменённый fetch.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { Plant, User } from "../db.ts";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const D = await import("../db.ts");
const { onCallback } = await import("./callbacks.ts");
const { T } = await import("../texts.ts");
const { localDate } = await import("../weather.ts");

type Write = { table: string; op: string; row: Record<string, any> };
type Sess = { state: string | null; data: Record<string, any> };

function fakeDb(session: Sess, plant: Partial<Plant> | null, writes: Write[]) {
  D._setDb({
    from(table: string) {
      let single = false;
      const chain: Record<string, unknown> = {
        upsert(row: Record<string, any>) { writes.push({ table, op: "upsert", row }); return proxy; },
        insert(row: Record<string, any>) { writes.push({ table, op: "insert", row }); return proxy; },
        update(row: Record<string, any>) { writes.push({ table, op: "update", row }); return proxy; },
        delete() { writes.push({ table, op: "delete", row: {} }); return proxy; },
        maybeSingle() { single = true; return proxy; },
        single() { single = true; return proxy; },
        then(ok: (r: { data: unknown; error: null }) => unknown) {
          let data: unknown = single ? null : [];
          if (table === "sessions" && single) data = { user_id: 7, history: [], ...session };
          if (table === "plants" && single) data = plant;
          return Promise.resolve({ data, error: null }).then(ok);
        },
      };
      const proxy: unknown = new Proxy(chain, {
        get(t, k) { return k in t ? t[k as string] : () => proxy; },
      });
      return proxy;
    },
  });
}

function weatherJson() {
  const time: string[] = [];
  const now = Date.now();
  for (let k = -45; k <= 30; k++) time.push(localDate(user.tz, new Date(now + k * 86_400_000)));
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
async function run(
  session: Sess,
  data: string,
  f: (sent: Sent[], writes: Write[]) => void,
  plant: Partial<Plant> | null = null,
) {
  const writes: Write[] = [];
  fakeDb(session, plant, writes);
  const sent: Sent[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    // после snz/more/less открывается карточка — ей нужна погода, отдаём ровную
    const url = String(input);
    let j: unknown = { ok: true, result: { message_id: 55 } };
    if (url.includes("air-quality")) j = { hourly: { time: [], dust: [] } };
    else if (url.includes("open-meteo")) j = weatherJson();
    else sent.push({ method: url.split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
    return Promise.resolve(new Response(JSON.stringify(j), { status: 200 }));
  }) as typeof fetch;
  try {
    await onCallback(user, 100, { id: "cb1", data, message: { message_id: 42 } });
    f(sent, writes);
  } finally {
    globalThis.fetch = orig;
  }
}

const user: User = {
  telegram_id: 7, first_name: "a", lat: 35, lon: 33, tz: "Asia/Nicosia",
  digest_hour: 8, last_digest_on: null, evening_hour: null, last_evening_on: null,
};
const idle: Sess = { state: null, data: {} };
// полное растение: после snz/more/less открывается карточка, ей нужны все поля
const full = (extra: Partial<Plant> = {}): Plant => ({
  id: "p1", user_id: 7, nickname: null, species: "Ficus", common_name: "фикус", room: "кухня",
  location: "indoor", photo_file_id: null, photo_path: null, care: {},
  water_every_days: 5, water_winter_days: null, feed_every_days: null, cold_min_c: null, heat_sensitive: false,
  last_watered_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), last_fed_at: null, snoozed_until: null,
  archived: false, created_at: "2026-10-01T00:00:00Z", ...extra,
});
const of = (ws: Write[], table: string, op: string) => ws.filter((w) => w.table === table && w.op === op);
const answers = (sent: Sent[]) => sent.filter((s) => s.method === "answerCallbackQuery");
const edits = (sent: Sent[]) => sent.filter((s) => s.method === "editMessageText");
const buttons = (s: Sent) => (s.body.reply_markup?.inline_keyboard ?? []).flat().map((k: any) => k.callback_data);
const sessionsSaved = (ws: Write[]) => of(ws, "sessions", "upsert").map((w) => ({ state: w.row.state, data: w.row.data }));

// режимы ожидания: кнопка переводит бота в режим и правит то же сообщение
for (
  const [data, state, sessData, text] of [
    ["rn:p1", "await_rename", { plant_id: "p1" }, () => T.renameAsk],
    ["nph:p1", "await_new_photo", { plant_id: "p1" }, () => "пришли новое фото."],
    ["hn:p1", "await_note", { plant_id: "p1" }, () => T.noteAsk],
    ["rme:new:p1", "await_room_edit", { plant_id: "p1" }, () => T.newRoomAsk],
  ] as const
) {
  Deno.test(`${data}: режим ${state}, правит сообщение`, async () => {
    await run(idle, data, (sent, ws) => {
      assertEquals(answers(sent).length, 1);
      assertEquals(sessionsSaved(ws), [{ state, data: sessData }]);
      const e = edits(sent);
      assertEquals(e.length, 1);
      assertEquals(e[0].body.message_id, 42);
      assertEquals(e[0].body.text, text());
    });
  });
}

Deno.test("ph без фото в сессии: подсказка «пришли ещё раз», больше ничего", async () => {
  await run(idle, "ph:add", (sent, ws) => {
    assertEquals(sent.length, 1);
    assertEquals(sent[0].body.text, "фото потерялось, пришли ещё раз");
    assertEquals(ws.length, 0);
  });
});

Deno.test("noadd: сессия сброшена, кнопки убраны", async () => {
  await run({ state: null, data: { photo: "big" } }, "noadd", (sent, ws) => {
    assertEquals(answers(sent)[0].body.text, "хорошо, в сад не добавляю");
    assertEquals(sessionsSaved(ws), [{ state: null, data: {} }]);
    const k = sent.find((s) => s.method === "editMessageReplyMarkup");
    assert(k);
    assertEquals(k.body.reply_markup.inline_keyboard, []);
  });
});

Deno.test("cand:x: ждём название текстом, кандидаты в сессии не трогаются", async () => {
  await run({ state: null, data: { candidates: [{ latin: "Ficus", common: "фикус" }] } }, "cand:x", (sent, ws) => {
    const s = of(ws, "sessions", "upsert");
    assertEquals(s.length, 1);
    assertEquals(s[0].row.state, "await_species_text");
    assertEquals(edits(sent)[0].body.text, T.typeNameInstead);
  });
});

Deno.test("loc: место в сессию, вопрос про имя с кнопкой «без имени»", async () => {
  await run({ state: null, data: { room: "кухня" } }, "loc:outdoor", (sent, ws) => {
    assertEquals(sessionsSaved(ws), [{ state: "await_nickname", data: { room: "кухня", location: "outdoor" } }]);
    assertEquals(edits(sent)[0].body.text, T.askNickname);
    assertEquals(buttons(edits(sent)[0]), ["nick:skip"]);
  });
});

Deno.test("rm:new при добавлении: ждём новую комнату", async () => {
  await run({ state: null, data: { photo: "big" } }, "rm:new", (sent, ws) => {
    assertEquals(of(ws, "sessions", "upsert")[0].row.state, "await_room_new");
    assertEquals(edits(sent)[0].body.text, T.newRoomAsk);
  });
});

Deno.test("del: переспрашивает, «да» ведёт в delok, «нет» — к карточке", async () => {
  await run(idle, "del:p1", (sent, ws) => {
    assertEquals(ws.length, 0);
    assertEquals(buttons(edits(sent)[0]), ["delok:p1", "p:p1"]);
  });
});

Deno.test("delok: растение уходит в архив, а не удаляется (история цела)", async () => {
  await run(idle, "delok:p1", (sent, ws) => {
    assertEquals(of(ws, "plants", "update").map((w) => w.row), [{ archived: true }]);
    assertEquals(of(ws, "plants", "delete").length, 0);
    assertEquals(of(ws, "events", "delete").length, 0);
    assertEquals(edits(sent)[0].body.text, T.deleted("фикус"));
  }, { id: "p1", nickname: null, common_name: "фикус", species: "Ficus" });
});

Deno.test("hr: час сводки пишется пользователю, ответ «сохранено»", async () => {
  await run(idle, "hr:9", (sent, ws) => {
    assertEquals(of(ws, "users", "update").map((w) => w.row), [{ digest_hour: 9 }]);
    assertEquals(edits(sent)[0].body.text, T.settingsSaved(9));
  });
});

Deno.test("ic:<ключ>: ждём эмодзи для этой иконки", async () => {
  await run(idle, "ic:water", (sent, ws) => {
    assertEquals(sessionsSaved(ws), [{ state: "await_icon", data: { key: "water" } }]);
    assertEquals(edits(sent).length, 1);
  });
});

Deno.test("другая кнопка во время ожидания эмодзи: режим иконки снят", async () => {
  await run({ state: "await_icon", data: { key: "water" } }, "rn:p1", (_sent, ws) => {
    assertEquals(sessionsSaved(ws), [
      { state: null, data: {} },
      { state: "await_rename", data: { plant_id: "p1" } },
    ]);
  });
});

Deno.test("неизвестная кнопка: только снимает часики", async () => {
  await run(idle, "zzz:1", (sent, ws) => {
    assertEquals(sent.length, 1);
    assertEquals(sent[0].method, "answerCallbackQuery");
    assertEquals(ws.length, 0);
  });
});

Deno.test("snz: напоминание откладывается на завтра по часовому поясу пользователя", async () => {
  const tomorrow = localDate(user.tz, new Date(Date.now() + 86_400_000));
  await run(idle, "snz:p1", (sent, ws) => {
    assertEquals(of(ws, "plants", "update")[0].row, { snoozed_until: tomorrow });
    assertEquals(answers(sent)[0].body.text, "напомню завтра");
  }, full());
});

for (
  const [cmd, every, winter, next, nextWinter, text] of [
    ["more", 5, 10, 4, 8, "буду напоминать чаще"],
    ["less", 5, 10, 6.5, 12.5, "буду напоминать реже"],
    ["more", 0.5, null, 0.5, undefined, "буду напоминать чаще"],
  ] as const
) {
  Deno.test(`${cmd}: интервал ${every} → ${next}${winter ? `, зимний ${winter} → ${nextWinter}` : ""}`, async () => {
    await run(idle, `${cmd}:p1`, (sent, ws) => {
      const want: Record<string, number> = { water_every_days: next };
      if (nextWinter !== undefined) want.water_winter_days = nextWinter;
      assertEquals(of(ws, "plants", "update")[0].row, want);
      assertEquals(answers(sent)[0].body.text, text);
    }, full({ water_every_days: every, water_winter_days: winter }));
  });
}
