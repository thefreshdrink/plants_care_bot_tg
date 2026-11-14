// кому пора писать в этот час крона: утреннее сообщение и вечернее напоминание
import type { User } from "./db.ts";
import { localDate, localHour } from "./weather.ts";

type Slot = Pick<User, "tz" | "digest_hour" | "last_digest_on" | "evening_hour" | "last_evening_on">;

// утро: наступил час сводки по часам пользователя, и сегодня сводки ещё не было
export function dueMorning(u: Slot, at: Date = new Date()): boolean {
  return localHour(u.tz, at) === u.digest_hour && u.last_digest_on !== localDate(u.tz, at);
}

// вечер: то же по evening_hour; null — напоминание выключено
export function dueEvening(u: Slot, at: Date = new Date()): boolean {
  if (u.evening_hour == null) return false;
  return localHour(u.tz, at) === u.evening_hour && u.last_evening_on !== localDate(u.tz, at);
}
