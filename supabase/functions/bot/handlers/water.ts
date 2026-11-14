// полив и подкормка: что засчитать и записать в историю
import * as D from "../db.ts";
import type { Plant, User } from "../db.ts";
import { getsRain } from "../watering.ts";
import { needsFeed } from "./feed_due.ts";

export { needsFeed };

// возвращает true, если вместе с поливом засчитана подкормка.
// noFeed: полила простой водой, хотя удобрение уже пора; оно подождёт следующего полива
export async function water(u: User, p: Plant, kind: "water" | "rain" = "water", noFeed = false): Promise<boolean> {
  const now = new Date().toISOString();
  const fed = kind === "water" && !noFeed && needsFeed(u, p);
  await D.updatePlant(u.telegram_id, p.id, { last_watered_at: now, snoozed_until: null, ...(fed ? { last_fed_at: now } : {}) });
  await D.logEvent(u.telegram_id, p.id, kind);
  if (fed) await D.logEvent(u.telegram_id, p.id, "feed");
  return fed;
}

// дождь поливает всех, кто под открытым небом
export async function rainWater(u: User): Promise<Plant[]> {
  const wet = (await D.plants(u.telegram_id)).filter((p) => getsRain(p.location));
  for (const p of wet) await water(u, p, "rain");
  return wet;
}
