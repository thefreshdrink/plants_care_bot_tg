// тесты шагов добавления растения без сети: deno test supabase/functions/bot/handlers/add_test.ts
// askRoom → askLocation → askLastWatered и список растений для /doctor (diagPlantRows).
// определение по фото и finishAdd ходят в claude — здесь не покрыты.
// база — заглушка через _setDb: plants отдаёт растения, sessions запоминает upsert;
// телеграм — подменённый fetch, как в garden_test.ts.
// db.ts при загрузке создаёт клиент supabase из переменных окружения, поэтому
// ставим пустышки и грузим модули уже после этого.
import { assertEquals } from "jsr:@std/assert@1";
import type { Plant, User } from "../db.ts";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const D = await import("../db.ts");
const { askLastWatered, askLocation, askRoom, diagPlantRows } = await import("./add.ts");
const { T } = await import("../texts.ts");

type Saved = { table: string; row: Record<string, any> };
function fakeDb(rows: Plant[], saved: Saved[]) {
  D._setDb({
    from(table: string) {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        order() { return chain; },
        upsert(row: Record<string, any>) { saved.push({ table, row }); return chain; },
        then(ok: (r: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: table === "plants" ? rows : null, error: null }).then(ok);
        },
      };
      return chain;
    },
  });
}

type Sent = { method: string; body: any };
async function run(rows: Plant[], f: (sent: Sent[], saved: Saved[]) => Promise<void>) {
  const saved: Saved[] = [];
  fakeDb(rows, saved);
  const sent: Sent[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: String(input).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
  }) as typeof fetch;
  try {
    await f(sent, saved);
  } finally {
    globalThis.fetch = orig;
  }
}

const user: User = {
  telegram_id: 7, first_name: "a", lat: 35, lon: 33, tz: "Asia/Nicosia",
  digest_hour: 8, last_digest_on: null, evening_hour: null, last_evening_on: null,
};

const plant = (id: string, room: string | null, nickname: string | null = id): Plant => ({
  id, user_id: 7, nickname, species: null, common_name: null, room, location: "indoor",
  photo_file_id: null, photo_path: null, care: {},
  water_every_days: 7, water_winter_days: null, feed_every_days: null,
  cold_min_c: null, heat_sensitive: false,
  last_watered_at: "2026-01-01T09:00:00Z", last_fed_at: null, snoozed_until: null,
  archived: false, created_at: "2025-01-01T00:00:00Z",
});

const btns = (s: Sent) =>
  (s.body.reply_markup?.inline_keyboard ?? []).map((row: { text: string; callback_data: string }[]) =>
    row.map((x) => `${x.text}|${x.callback_data}`));

const chosen = { latin: "Ficus elastica", common: "фикус" };

Deno.test("комната: свои комнаты по две в ряд, без повторов и пустых, «новая комната» последней", async () => {
  const rows = [plant("1", "кухня"), plant("2", null), plant("3", "спальня"), plant("4", "кухня"), plant("5", "балкон")];
  await run(rows, async (sent, saved) => {
    await askRoom(user, 1, { chosen });
    assertEquals(sent.length, 1);
    assertEquals(sent[0].method, "sendMessage");
    assertEquals(sent[0].body.text, T.askRoom("фикус"));
    assertEquals(btns(sent[0]), [["кухня|rm:0", "спальня|rm:1"], ["балкон|rm:2"], ["новая комната|rm:new"]]);
    // rm:<номер> читается из сессии — номер кнопки должен совпадать с местом в сохранённом списке
    assertEquals(saved.length, 1);
    assertEquals(saved[0].table, "sessions");
    assertEquals(saved[0].row.user_id, 7);
    assertEquals(saved[0].row.state, null);
    assertEquals(saved[0].row.data, { chosen, rooms: ["кухня", "спальня", "балкон"] });
  });
});

Deno.test("комната: пустой сад — только «новая комната»", async () => {
  await run([], async (sent, saved) => {
    await askRoom(user, 1, { chosen });
    assertEquals(btns(sent[0]), [["новая комната|rm:new"]]);
    assertEquals(saved[0].row.data.rooms, []);
  });
});

Deno.test("комната: с номером сообщения правит его, а не шлёт новое", async () => {
  await run([plant("1", "кухня")], async (sent) => {
    await askRoom(user, 1, { chosen }, 55);
    assertEquals(sent[0].method, "editMessageText");
    assertEquals(sent[0].body.message_id, 55);
    assertEquals(sent[0].body.text, T.askRoom("фикус"));
  });
});

Deno.test("место: в шапке вид и комната, четыре места по два, данные в сессии как есть", async () => {
  await run([], async (sent, saved) => {
    const data = { chosen, room: "кухня" };
    await askLocation(user, 1, data);
    assertEquals(sent[0].body.text, T.askLocation("фикус · кухня"));
    assertEquals(btns(sent[0]), [
      ["дом|loc:indoor", "балкон под крышей|loc:covered"],
      ["улица · горшок|loc:outdoor_pot", "улица · грунт|loc:outdoor_ground"],
    ]);
    assertEquals(saved[0].row.data, data);
  });
});

Deno.test("место: без комнаты в шапке только вид; с номером — правка", async () => {
  await run([], async (sent) => {
    await askLocation(user, 1, { chosen }, 9);
    assertEquals(sent[0].method, "editMessageText");
    assertEquals(sent[0].body.text, T.askLocation("фикус"));
  });
});

Deno.test("последний полив: пять ответов, дни в данных кнопок", async () => {
  await run([], async (sent, saved) => {
    const data = { chosen, room: "кухня", location: "indoor", nickname: null };
    await askLastWatered(user, 1, data);
    assertEquals(sent[0].body.text, "когда поливала последний раз?");
    assertEquals(btns(sent[0]), [
      ["сегодня|lw:0", "вчера|lw:1"],
      ["пару дней назад|lw:3", "неделю назад|lw:7"],
      ["не помню|lw:99"],
    ]);
    assertEquals(saved[0].row.data, data);
  });
});

Deno.test("/doctor: растения по одному в ряд по имени, в конце «его нет в коллекции»", async () => {
  await run([plant("a1", "кухня", "Фикус"), plant("b2", null, null)], async (sent) => {
    const k = await diagPlantRows(7);
    assertEquals(sent.length, 0);
    assertEquals(k.map((row) => row.map((x) => `${x.text}|${x.callback_data}`)), [
      ["Фикус|dgp:a1"],
      ["растение|dgp:b2"],
      ["его нет в коллекции|dgp:none"],
    ]);
  });
});
