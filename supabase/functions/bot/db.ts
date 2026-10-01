// доступ к базе supabase (service role: функция видит всё, снаружи не видно ничего)
import { createClient } from "npm:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
export let db: any = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
// только для тестов
export const _setDb = (x: unknown) => { db = x; };

export type User = {
  telegram_id: number; first_name: string | null; lat: number; lon: number; tz: string;
  digest_hour: number; last_digest_on: string | null;
};

export type Plant = {
  id: string; user_id: number; nickname: string | null; species: string | null; common_name: string | null;
  room: string | null;
  location: "indoor" | "covered" | "outdoor_pot" | "outdoor_ground";
  photo_file_id: string | null; photo_path: string | null; care: Record<string, any>;
  water_every_days: number; water_winter_days: number | null; feed_every_days: number | null;
  cold_min_c: number | null; heat_sensitive: boolean;
  last_watered_at: string; last_fed_at: string | null; snoozed_until: string | null;
  archived: boolean; created_at: string;
};

export type Session = { user_id: number; state: string | null; data: Record<string, any>; history: any[] };

function check<T>(r: { data: T; error: any }): T {
  if (r.error) throw new Error(`db: ${r.error.message}`);
  return r.data;
}

export async function getUser(id: number): Promise<User | null> {
  return check(await db.from("users").select("*").eq("telegram_id", id).maybeSingle());
}

// первый, кто нажал /start, становится хозяйкой. остальных пускаем, только если они в ALLOWED_TELEGRAM_IDS.
export async function authorize(id: number, firstName: string): Promise<User | null> {
  const existing = await getUser(id);
  if (existing) return existing;
  const allowed = (Deno.env.get("ALLOWED_TELEGRAM_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // telegram_id = 0: временная хозяйка, на неё заранее загружены растения
  const { count } = await db.from("users").select("*", { count: "exact", head: true }).neq("telegram_id", 0);
  if ((count ?? 0) > 0 && !allowed.includes(String(id))) return null;
  const user = check(await db.from("users").insert({ telegram_id: id, first_name: firstName }).select().single()) as User;
  if ((count ?? 0) === 0) {
    // первая настоящая хозяйка забирает заранее загруженную коллекцию
    await db.from("plants").update({ user_id: id }).eq("user_id", 0);
    await db.from("wishlist").update({ user_id: id }).eq("user_id", 0);
    await db.from("events").update({ user_id: id }).eq("user_id", 0);
    await db.from("users").delete().eq("telegram_id", 0);
  }
  return user;
}

export async function getSession(uid: number): Promise<Session> {
  const s = check(await db.from("sessions").select("*").eq("user_id", uid).maybeSingle()) as Session | null;
  return s ?? { user_id: uid, state: null, data: {}, history: [] };
}

export async function saveSession(uid: number, patch: Partial<Session>) {
  check(await db.from("sessions").upsert({ user_id: uid, ...patch, updated_at: new Date().toISOString() }));
}

export async function plants(uid: number): Promise<Plant[]> {
  return (check(await db.from("plants").select("*").eq("user_id", uid).eq("archived", false).order("created_at")) ?? []) as Plant[];
}

export async function plant(uid: number, id: string): Promise<Plant | null> {
  return check(await db.from("plants").select("*").eq("user_id", uid).eq("id", id).maybeSingle());
}

export async function updatePlant(uid: number, id: string, patch: Partial<Plant>) {
  check(await db.from("plants").update(patch).eq("user_id", uid).eq("id", id));
}

export async function logEvent(uid: number, plantId: string | null, kind: string, note?: string, photo?: string) {
  check(await db.from("events").insert({ user_id: uid, plant_id: plantId, kind, note, photo_file_id: photo }));
}

// true, если апдейт новый; false, если телеграм прислал его повторно
export async function firstTime(updateId: number): Promise<boolean> {
  const { error } = await db.from("processed_updates").insert({ update_id: updateId });
  return !error;
}

// иконки кнопок: key -> custom_emoji_id
export async function icons(uid: number): Promise<Record<string, string>> {
  const { data } = await db.from("icons").select("key, custom_emoji_id").eq("user_id", uid);
  return Object.fromEntries((data ?? []).map((r: any) => [r.key, r.custom_emoji_id]));
}

export async function setIcon(uid: number, key: string, id: string | null) {
  if (id) check(await db.from("icons").upsert({ user_id: uid, key, custom_emoji_id: id }));
  else check(await db.from("icons").delete().eq("user_id", uid).eq("key", key));
}

// комнаты в порядке добавления растений
export async function rooms(uid: number): Promise<string[]> {
  const ps = await plants(uid);
  return [...new Set(ps.map((p) => p.room).filter((r): r is string => !!r))];
}

// где обычно стоят растения этой комнаты (дом, балкон, улица)
export async function roomLocation(uid: number, room: string): Promise<Plant["location"] | null> {
  const ps = (await plants(uid)).filter((p) => p.room === room);
  if (!ps.length) return null;
  const count: Record<string, number> = {};
  for (const p of ps) count[p.location] = (count[p.location] ?? 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0][0] as Plant["location"];
}

export async function waterEvents(uid: number, sinceIso: string): Promise<{ plant_id: string; created_at: string }[]> {
  const { data } = await db.from("events").select("plant_id, created_at").eq("user_id", uid).eq("kind", "water").gte("created_at", sinceIso);
  return data ?? [];
}
