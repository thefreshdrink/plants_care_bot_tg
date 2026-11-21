// карточка ухода от Claude → колонки растения в базе (без базы и сети, поэтому тестируется отдельно)
import type { Plant } from "../db.ts";
import type { Care } from "../claude.ts";

export function careColumns(c: Care): Partial<Plant> {
  return {
    common_name: c.common_name,
    water_every_days: Math.max(0.5, Number(c.water_every_days) || 7),
    water_winter_days: c.water_winter_days ? Number(c.water_winter_days) : null,
    feed_every_days: c.feed_every_days ? Math.round(Number(c.feed_every_days)) : null,
    cold_min_c: Number.isFinite(Number(c.cold_min_c)) ? Number(c.cold_min_c) : null,
    heat_sensitive: !!c.heat_sensitive,
  };
}
