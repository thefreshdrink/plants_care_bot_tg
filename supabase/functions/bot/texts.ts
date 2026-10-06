// голос и внешний вид бота. всё, что видит пользователь, живёт здесь:
// меняешь текст или символ в этом файле, и бот меняется целиком.
import { esc } from "./telegram.ts";

// как говорит claude внутри бота
export const VOICE =
  "пиши по-русски, строчными буквами, без эмодзи, без длинного тире (вместо него запятая, двоеточие или точка). " +
  "тон спокойный и тёплый, без восклицаний и без сюсюканья. коротко.";

export const LOC_SHORT: Record<string, string> = {
  indoor: "дом",
  covered: "балкон",
  outdoor_pot: "улица · горшок",
  outdoor_ground: "улица · грунт",
};

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const ruDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

export const plural = (k: number, one: string, few: string, many: string) => {
  const a = Math.abs(k) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
export const days = (k: number) => `${k} ${plural(k, "день", "дня", "дней")}`;

// запас воды: полная шкала сразу после полива, пустая, когда пора поливать
export function waterBar(progress: number): string {
  const left = Math.max(0, Math.min(1, 1 - progress));
  const filled = Math.round(left * 6);
  return "▰".repeat(filled) + "▱".repeat(6 - filled);
}

export function whenWater(daysLeft: number, due: boolean): string {
  if (due || daysLeft <= 0) return "полить сегодня";
  if (daysLeft === 1) return "полив завтра";
  return `полив через ${days(daysLeft)}`;
}

export const T = {
  welcome: (name: string) =>
    `привет, ${esc(name.toLowerCase())}.\n\n` +
    "я слежу за твоими растениями и погодой в лимассоле.\n\n" +
    "<b>как начать</b>\n" +
    "пришли фото растения, я определю его и заведу карточку ухода.\n\n" +
    "<b>что ещё умею</b>\n" +
    "/today · что сделать сегодня\n" +
    "/week · полив на неделю\n" +
    "/plants · мой сад\n" +
    "/weather · погода для сада\n" +
    "/settings · время утреннего сообщения\n" +
    "/icons · иконки на кнопках\n\n" +
    "команды всегда под рукой в меню слева от поля ввода. на любой вопрос текстом отвечу, зная твои растения и прогноз.",
  notOwner: "это личный бот, он отвечает только своей хозяйке.",
  photoWhat: "что делаем с фото?",
  identifying: "смотрю…",
  notAPlant: "не вижу на фото растения. попробуй крупнее, при дневном свете.",
  pickCandidate: "похоже на это. какое верно?",
  typeNameInstead: "напиши название сама (можно по-русски или латынью).",
  askLocation: (n: string) => `<b>${esc(n)}</b>\n\nгде оно живёт?`,
  askNickname: "как его звать? напиши имя или нажми «без имени».",
  writingCard: "пишу карточку ухода…",
  added: (n: string) => `готово, <b>${esc(n)}</b> в коллекции.`,
  emptyCollection: "в саду пока пусто. пришли фото растения, и начнём.",
  watered: (n: string) => `полито: ${n}`,
  fed: (n: string) => `подкормлено: ${n}`,
  diagnosePhoto: (n: string) => `пришли фото, где видно проблему у «${esc(n)}». можно добавить вопрос в подпись.`,
  diagnosing: "разглядываю…",
  pickPlantForDiagnosis: "у какого растения проблема?",
  settings: (h: number) => `утреннее сообщение приходит в <b>${h}:00</b>. когда удобнее?`,
  settingsSaved: (h: number) => `договорились, буду писать в ${h}:00.`,
  renameAsk: "новое имя:",
  deleted: (n: string) => `«${esc(n)}» убрано из коллекции.`,
  error: "что-то сломалось на моей стороне. попробуй ещё раз через минуту.",
  askRoom: (n: string) => `<b>${esc(n)}</b>\n\nв какой комнате?`,
  newRoomAsk: "как называется комната? одним-двумя словами, например «спальня».",
  iconsIntro: "иконки на кнопках. нажми на действие и пришли один премиум-эмодзи, он встанет на кнопку.",
  iconAsk: (label: string) => `пришли премиум-эмодзи для «${esc(label)}». обычные эмодзи не подойдут, нужен из набора custom emoji. передумала: любая команда, например /plants.`,
  iconSaved: (label: string) => `готово, иконка для «${esc(label)}» стоит.`,
  iconNotCustom: "это обычный эмодзи. нужен премиум-эмодзи из набора (они анимированные или с особым рисунком).",
  iconsCleared: "иконки убраны.",
  weekLegend: "○ полить · • полито",
  weekEmpty: "на этой неделе поливать никого не нужно.",
  weekDoneHint: "зачёркнуто: уже полито",
  nothingToday: "сегодня поливать никого не нужно.",
  moreWhat: (n: string) => `<b>${esc(n)}</b>\n\nчто сделать?`,
  gardenTitle: (n: number) => `<b>мой сад</b> · ${n}`,
  waterToday: (n: number) => `сегодня полить ${n}`,
  roomRest: "остальные комнаты",
  roomWalk: "обход: дальше туда, где ждут",
};

// какие иконки можно настроить: ключ совпадает с последним аргументом b() у кнопки
export const ICON_KEYS: { key: string; label: string }[] = [
  { key: "water", label: "полито" },
  { key: "feed", label: "подкормлено" },
  { key: "snooze", label: "не сегодня" },
  { key: "rain", label: "был дождь" },
  { key: "care", label: "инфо" },
  { key: "photo", label: "добавить фото" },
  { key: "diag", label: "что с ним" },
  { key: "more", label: "чаще" },
  { key: "less", label: "реже" },
  { key: "edit", label: "ещё" },
  { key: "list", label: "сад" },
  { key: "week", label: "неделя" },
  { key: "today", label: "сегодня" },
];

export const WEEK_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

// команды в меню телеграма. телеграм хранит этот список у себя, бот пересылает его сам.
export const COMMANDS: { command: string; description: string }[] = [
  { command: "today", description: "что сделать сегодня" },
  { command: "week", description: "полив на неделю" },
  { command: "plants", description: "мой сад" },
  { command: "weather", description: "погода для сада" },
  { command: "settings", description: "время утреннего сообщения" },
  { command: "icons", description: "иконки на кнопках" },
];
