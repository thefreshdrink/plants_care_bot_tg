// пора ли подкормка этому растению сегодня, по дате у пользователя. чистая функция без базы — её проверяет feed_due_test.ts
import type { Plant, User } from "../db.ts";
import { localDate } from "../weather.ts";
import { feedDue } from "../watering.ts";

// подкормка это удобрение в воде, поэтому отдельно она не приходит:
// если растению пора, она засчитывается вместе с поливом. дождь не подкармливает.
// at — «сейчас»; задаётся только в тестах
export function needsFeed(u: User, p: Plant, at: Date = new Date()): boolean {
  return feedDue(
    p, localDate(u.tz, at),
    p.last_fed_at ? localDate(u.tz, new Date(p.last_fed_at)) : null,
    localDate(u.tz, new Date(p.created_at)),
  );
}
