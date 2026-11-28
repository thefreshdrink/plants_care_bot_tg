// тесты входящих сообщений без сети: deno test supabase/functions/bot/handlers/messages_test.ts
// onMessage() решает по сессии, что делать с фото, командой или текстом.
// здесь проверяем развилки и то, что уходит в базу; сами экраны (карточка,
// история, сводка) покрыты своими тестами. свободный чат и диагноз ходят в
// claude — не покрыты.
// база — заглушка через _setDb: sessions отдаёт заданную сессию, остальное
// пусто; каждая запись (upsert/insert/update/delete) запоминается.
// телеграм — подменённый fetch, как в add_test.ts.
// db.ts при загрузке создаёт клиент supabase из переменных окружения, поэтому
// ставим пустышки и грузим модули уже после этого.
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { User } from "../db.ts";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const D = await import("../db.ts");
const { onMessage } = await import("./messages.ts");
const { T } = await import("../texts.ts");

type Write = { table: string; op: string; row: Record<string, any> };
type Sess = { state: string | null; data: Record<string, any> };

function fakeDb(session: Sess, writes: Write[]) {
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
          return Promise.resolve({ data, error: null }).then(ok);
        },
      };
      // select, eq, in, order, limit… — всё возвращает ту же цепочку
      const proxy: unknown = new Proxy(chain, {
        get(t, k) { return k in t ? t[k as string] : () => proxy; },
      });
      return proxy;
    },
  });
}

type Sent = { method: string; body: any };
async function run(session: Sess, msg: any, f: (sent: Sent[], writes: Write[]) => void) {
  const writes: Write[] = [];
  fakeDb(session, writes);
  const sent: Sent[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({ method: String(input).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), { status: 200 }));
  }) as typeof fetch;
  try {
    await onMessage(user, 100, msg);
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
const photo = { photo: [{ file_id: "small" }, { file_id: "big" }] };
const of = (ws: Write[], table: string, op: string) => ws.filter((w) => w.table === table && w.op === op);
const buttons = (s: Sent) => (s.body.reply_markup?.inline_keyboard ?? []).flat().map((k: any) => k.callback_data);

Deno.test("фото без режима: берём самое большое, спрашиваем, что делать", async () => {
  await run(idle, { ...photo, caption: "листья" }, (sent, ws) => {
    assertEquals(sent.length, 1);
    assertEquals(sent[0].body.text, T.photoWhat);
    assertEquals(buttons(sent[0]), ["ph:add", "ph:id", "ph:diag"]);
    const s = of(ws, "sessions", "upsert");
    assertEquals(s.length, 1);
    assertEquals(s[0].row.state, null);
    assertEquals(s[0].row.data, { photo: "big", caption: "листья" });
  });
});

Deno.test("новое фото растения: фото в растение, старая копия сброшена, событие в историю", async () => {
  await run({ state: "await_new_photo", data: { plant_id: "p1" } }, photo, (sent, ws) => {
    assertEquals(of(ws, "plants", "update").map((w) => w.row), [{ photo_file_id: "big", photo_path: null }]);
    const ev = of(ws, "events", "insert");
    assertEquals(ev.length, 1);
    assertEquals(ev[0].row.kind, "photo");
    assertEquals(ev[0].row.plant_id, "p1");
    assertEquals(ev[0].row.photo_file_id, "big");
    assertEquals(of(ws, "sessions", "upsert")[0].row.state, null);
    // дальше открывается карточка; растения в заглушке нет — значит, она и ответила
    assertEquals(sent.at(-1)!.body.text, "такого растения нет в коллекции.");
  });
});

Deno.test("фото для /doctor: фото в сессии, спрашиваем, у какого растения", async () => {
  await run({ state: "await_doc_photo", data: {} }, photo, (sent, ws) => {
    assertEquals(of(ws, "sessions", "upsert")[0].row.data, { photo: "big", caption: null });
    assertEquals(sent.length, 1);
    assertEquals(sent[0].body.text, T.pickPlantForDiagnosis);
  });
});

Deno.test("иконка: премиум-эмодзи сохраняется, обычный — просим другой", async () => {
  const s = { state: "await_icon", data: { key: "water" } };
  const custom = { text: "x", entities: [{ type: "custom_emoji", custom_emoji_id: "e42" }] };
  await run(s, custom, (sent, ws) => {
    const ic = of(ws, "icons", "upsert");
    assertEquals(ic.map((w) => w.row), [{ user_id: 7, key: "water", custom_emoji_id: "e42" }]);
    assertEquals(of(ws, "sessions", "upsert")[0].row.state, null);
    assert(sent.at(-1)!.body.text.startsWith(T.iconSaved("полито")));
  });
  await run(s, { text: "🌱" }, (sent, ws) => {
    assertEquals(ws.length, 0);
    assertEquals(sent.map((x) => x.body.text), [T.iconNotCustom]);
  });
});

Deno.test("иконка: команда выводит из режима и выполняется", async () => {
  await run({ state: "await_icon", data: { key: "water" } }, { text: "/settings" }, (sent, ws) => {
    assertEquals(of(ws, "icons", "upsert").length, 0);
    assertEquals(of(ws, "sessions", "upsert")[0].row.state, null);
    assertEquals(sent.map((x) => x.body.text), [T.settings(8)]);
  });
});

Deno.test("команды: регистр и @имя_бота не мешают, /identify и /doctor ждут фото", async () => {
  await run(idle, { text: "/IDENTIFY@plants_bot" }, (sent, ws) => {
    assertEquals(of(ws, "sessions", "upsert").at(-1)!.row.state, "await_id_photo");
    assertEquals(sent.map((x) => x.body.text), [T.idAsk]);
  });
  await run(idle, { text: "/doctor" }, (sent, ws) => {
    assertEquals(of(ws, "sessions", "upsert").at(-1)!.row.state, "await_doc_photo");
    assertEquals(sent.map((x) => x.body.text), [T.docAsk]);
  });
});

Deno.test("новая комната: строчными и не длиннее 30 знаков", async () => {
  const data = { chosen: { latin: "Ficus", common: "фикус" } };
  await run({ state: "await_room_new", data }, { text: "  Большая Светлая Гостиная У Окна На Юг  " }, (_sent, ws) => {
    const room = of(ws, "sessions", "upsert").at(-1)!.row.data.room;
    assertEquals(room, "большая светлая гостиная у окна на юг".slice(0, 30));
    assertEquals(room.length, 30);
  });
});

Deno.test("заметка, имя, комната растения: обрезаются и пишутся в своё растение", async () => {
  const long = "а".repeat(600);
  await run({ state: "await_note", data: { plant_id: "p1" } }, { text: long }, (_s, ws) => {
    const ev = of(ws, "events", "insert");
    assertEquals(ev.length, 1);
    assertEquals(ev[0].row.kind, "note");
    assertEquals(ev[0].row.note.length, 500);
  });
  await run({ state: "await_rename", data: { plant_id: "p1" } }, { text: long }, (_s, ws) => {
    assertEquals(of(ws, "plants", "update")[0].row.nickname.length, 40);
  });
  await run({ state: "await_room_edit", data: { plant_id: "p1" } }, { text: "КУХНЯ" }, (_s, ws) => {
    assertEquals(of(ws, "plants", "update")[0].row, { room: "кухня" });
  });
});

Deno.test("пустой текст без фото: ничего не пишем и не отвечаем", async () => {
  await run(idle, { text: "   " }, (sent, ws) => {
    assertEquals(sent.length, 0);
    assertEquals(ws.length, 0);
  });
  await run(idle, { sticker: {} }, (sent, ws) => {
    assertEquals(sent.length, 0);
    assertEquals(ws.length, 0);
  });
});
