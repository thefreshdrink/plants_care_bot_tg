// тесты полива и дождя без сети: deno test supabase/functions/bot/handlers/water_test.ts
// water() пишет в базу дату полива и событие в историю, а rainWater() поливает
// только тех, кто под открытым небом. базу подменяем записывающей заглушкой через _setDb.
// db.ts при загрузке создаёт клиент supabase из переменных окружения, поэтому
// ставим пустышки и грузим модули уже после этого (сеть клиент при создании не трогает).
import { assertEquals } from "jsr:@std/assert@1";
import type { Plant, User } from "../db.ts";

Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
const D = await import("../db.ts");
const { water, rainWater } = await import("./water.ts");

type Call = { table: string; op: string; arg?: unknown; eq: [string, unknown][] };

// цепочка как у supabase-js: from().update()/insert()/select() → .eq()… → await
function fakeDb(rows: Plant[] = []) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, op: "", eq: [] };
      const chain = {
        update(arg: unknown) { call.op = "update"; call.arg = arg; calls.push(call); return chain; },
        insert(arg: unknown) { call.op = "insert"; call.arg = arg; calls.push(call); return chain; },
        select() { call.op = "select"; calls.push(call); return chain; },
        eq(k: string, v: unknown) { call.eq.push([k, v]); return chain; },
        order() { return chain; },
        then(ok: (r: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: call.op === "select" ? rows : null, error: null }).then(ok);
        },
      };
      return chain;
    },
  };
  D._setDb(db);
  return calls;
}

const user: User = {
  telegram_id: 7, first_name: "a", lat: 34.68, lon: 33.04, tz: "Asia/Nicosia",
  digest_hour: 8, last_digest_on: null, evening_hour: null, last_evening_on: null,
};

const plant = (id: string, location: Plant["location"], feed: number | null = null, lastFed: string | null = null): Plant => ({
  id, user_id: 7, nickname: null, species: null, common_name: null, room: null, location,
  photo_file_id: null, photo_path: null, care: {},
  water_every_days: 7, water_winter_days: null, feed_every_days: feed,
  cold_min_c: null, heat_sensitive: false,
  last_watered_at: "2026-01-01T00:00:00Z", last_fed_at: lastFed, snoozed_until: null,
  archived: false, created_at: "2025-01-01T00:00:00Z",
});

const events = (calls: Call[]) =>
  calls.filter((c) => c.table === "events").map((c) => (c.arg as { kind: string; plant_id: string }));

Deno.test("water: без подкормки — дата полива, снят отложенный, одно событие water", async () => {
  const calls = fakeDb();
  const fed = await water(user, plant("p1", "indoor"));
  assertEquals(fed, false);
  const upd = calls.find((c) => c.op === "update")!;
  assertEquals(upd.table, "plants");
  assertEquals(upd.eq, [["user_id", 7], ["id", "p1"]]);
  const patch = upd.arg as Record<string, unknown>;
  assertEquals(Object.keys(patch).sort(), ["last_watered_at", "snoozed_until"]);
  assertEquals(patch.snoozed_until, null);
  assertEquals(events(calls).map((e) => [e.kind, e.plant_id]), [["water", "p1"]]);
});

// подкормка сезонная (март–октябрь), поэтому часы ставим на июль и на декабрь
function at<T>(iso: string, f: () => Promise<T>): Promise<T> {
  const Real = Date;
  class Fixed extends Real {
    constructor(...a: unknown[]) {
      // без аргументов — зафиксированное «сейчас»
      // @ts-ignore: аргументы Date как есть
      super(...(a.length ? a : [iso]));
    }
    static override now() { return new Real(iso).getTime(); }
  }
  globalThis.Date = Fixed as DateConstructor;
  return f().finally(() => { globalThis.Date = Real; });
}

Deno.test("water: летом пора подкормить — та же дата в last_fed_at и второе событие feed", async () => {
  const calls = fakeDb();
  const fed = await at("2026-07-10T09:00:00Z", () => water(user, plant("p2", "indoor", 14, "2026-06-01T00:00:00Z")));
  assertEquals(fed, true);
  const patch = calls.find((c) => c.op === "update")!.arg as Record<string, unknown>;
  assertEquals(patch.last_watered_at, "2026-07-10T09:00:00.000Z");
  assertEquals(patch.last_fed_at, patch.last_watered_at);
  assertEquals(events(calls).map((e) => e.kind), ["water", "feed"]);
});

Deno.test("water: зимой подкормку не засчитывает, даже если давно не кормили", async () => {
  const calls = fakeDb();
  const fed = await at("2026-12-10T09:00:00Z", () => water(user, plant("p2", "indoor", 14, "2026-06-01T00:00:00Z")));
  assertEquals(fed, false);
  const patch = calls.find((c) => c.op === "update")!.arg as Record<string, unknown>;
  assertEquals("last_fed_at" in patch, false);
  assertEquals(events(calls).map((e) => e.kind), ["water"]);
});

Deno.test("water: noFeed и дождь подкормку не засчитывают", async () => {
  // летом и давно не кормили: обычный полив подкормку засчитал бы
  const p = plant("p3", "outdoor_pot", 14, "2026-06-01T00:00:00Z");
  for (const [kind, noFeed] of [["water", true], ["rain", false]] as const) {
    const calls = fakeDb();
    assertEquals(await at("2026-07-10T09:00:00Z", () => water(user, p, kind, noFeed)), false);
    const patch = calls.find((c) => c.op === "update")!.arg as Record<string, unknown>;
    assertEquals("last_fed_at" in patch, false);
    assertEquals(events(calls).map((e) => e.kind), [kind]);
  }
});

Deno.test("rainWater: поливает только под открытым небом, событие rain", async () => {
  const rows = [plant("in", "indoor"), plant("cov", "covered"), plant("pot", "outdoor_pot"), plant("gr", "outdoor_ground")];
  const calls = fakeDb(rows);
  const wet = await rainWater(user);
  assertEquals(wet.map((p) => p.id), ["pot", "gr"]);
  assertEquals(events(calls).map((e) => [e.kind, e.plant_id]), [["rain", "pot"], ["rain", "gr"]]);
  // список берётся только свой и только не архивный
  const sel = calls.find((c) => c.op === "select")!;
  assertEquals(sel.eq, [["user_id", 7], ["archived", false]]);
});
