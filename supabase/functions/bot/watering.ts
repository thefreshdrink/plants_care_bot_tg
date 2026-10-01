// логика полива и погодных предупреждений. чистые функции, без сети и базы.
import type { Day, Weather } from "./weather.ts";

export type Location = "indoor" | "covered" | "outdoor_pot" | "outdoor_ground";

export type PlantLike = {
  id: string;
  nickname: string | null;
  common_name: string | null;
  location: Location;
  water_every_days: number;
  water_winter_days: number | null;
  feed_every_days: number | null;
  cold_min_c: number | null;
  heat_sensitive: boolean;
  last_watered_at: string;
  last_fed_at: string | null;
  snoozed_until: string | null;
  created_at: string;
};

// эталонный день: жаркий летний день в лимассоле, эвапотранспирация ~6 мм.
// интервал полива уличных растений задаётся «в таких днях».
// зимой испаряется 1.5–2 мм в день, и тот же интервал растягивается в 3–4 раза сам.
export const ET0_REF = 6;
export const RAIN_RESET_MM = 3;   // дождь от 3 мм за день считаем полным поливом
export const RAIN_MIN_MM = 1;     // от 1 до 3 мм: не обнуляет, а уменьшает накопленную сухость
export const RAIN_FORECAST_PROB = 60; // дождь из прогноза учитываем, только если он вероятен
export const MAX_GAP_DAYS = 40;   // для улицы не ждём дольше, даже если прохладно

export const isOutdoor = (l: Location) => l !== "indoor";
export const getsRain = (l: Location) => l === "outdoor_pot" || l === "outdoor_ground";

const DAY = 86_400_000;
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
const addDays = (a: string, k: number) => new Date(Date.parse(a + "T00:00:00Z") + k * DAY).toISOString().slice(0, 10);

export const isWarmSeason = (date: string) => {
  const m = Number(date.slice(5, 7));
  return m >= 4 && m <= 10; // апрель–октябрь
};

// один день для уличного растения: испарение добавляет сухости, дождь её снимает.
// score меряется в эталонных днях (испарение / ET0_REF). сегодняшний дождь не считаем,
// он ещё не прошёл: для него есть rainExpectedToday.
function dryStep(score: number, d: Day, wet: boolean, today: string): number {
  score += d.et0 / ET0_REF;
  if (!wet || d.date === today) return score;
  if (d.date > today && d.rainProb < RAIN_FORECAST_PROB) return score;
  if (d.rain >= RAIN_RESET_MM) return 0;
  if (d.rain >= RAIN_MIN_MM) return Math.max(0, score - d.rain / ET0_REF);
  return score;
}

export type WaterStatus = {
  due: boolean;
  daysLeft: number;          // через сколько дней полив (0 = сегодня)
  reason: "schedule" | "heat" | "overdue" | null;
  rainedOn: string | null;   // дата дождя, который засчитали как полив
  rainExpectedToday: boolean;
  progress: number;          // 0..1+, насколько растение «высохло»
};

export function waterStatus(p: PlantLike, w: Weather, lastWateredLocal: string): WaterStatus {
  const today = w.today;
  const snoozed = !!p.snoozed_until && p.snoozed_until >= today;
  const todayDay = w.days.find((d) => d.date === today);
  const rainExpectedToday = getsRain(p.location) && !!todayDay && todayDay.rain >= RAIN_RESET_MM && todayDay.rainProb >= 60;

  // --- дом: простой календарный интервал, летом и зимой разный
  if (!isOutdoor(p.location)) {
    const interval = isWarmSeason(today) ? p.water_every_days : (p.water_winter_days ?? p.water_every_days * 1.6);
    const passed = daysBetween(lastWateredLocal, today);
    const daysLeft = Math.max(0, Math.ceil(interval - passed));
    return {
      due: !snoozed && passed >= interval,
      daysLeft: snoozed ? Math.max(daysLeft, daysBetween(today, p.snoozed_until!)) : daysLeft,
      reason: passed >= interval ? "schedule" : null,
      rainedOn: null, rainExpectedToday: false,
      progress: passed / interval,
    };
  }

  // --- улица и балкон: считаем, сколько воды ушло с момента полива
  const wet = getsRain(p.location);
  let start = lastWateredLocal;
  let rainedOn: string | null = null;
  if (wet) {
    for (const d of w.days) {
      if (d.date > start && d.date < today && d.rain >= RAIN_RESET_MM) { start = d.date; rainedOn = d.date; }
    }
  }
  const interval = p.water_every_days;
  const gap = daysBetween(start, today);
  const byDate = new Map(w.days.map((d) => [d.date, d] as const));

  let score = 0;
  let missing = false;
  for (let k = 1; k <= gap; k++) {
    const d = byDate.get(addDays(start, k));
    if (!d) { missing = true; break; }
    score = dryStep(score, d, wet, today);
  }

  const overdue = missing || gap >= MAX_GAP_DAYS;
  const heat = !!todayDay && todayDay.tmax >= 35 && score >= interval * 0.75;
  const due = !snoozed && (overdue || score >= interval || heat);

  // прогноз: через сколько дней накопится интервал
  let daysLeft = 0;
  if (!due) {
    let s = score;
    const lastEt0 = w.days.at(-1)?.et0 || ET0_REF / 2;
    for (let k = 1; k <= MAX_GAP_DAYS; k++) {
      const d = byDate.get(addDays(today, k));
      s = d ? dryStep(s, d, wet, today) : s + lastEt0 / ET0_REF;
      if (s >= interval) { daysLeft = k; break; }
      daysLeft = k;
    }
    if (snoozed) daysLeft = Math.max(daysLeft, daysBetween(today, p.snoozed_until!));
  }

  return {
    due,
    daysLeft,
    reason: overdue ? "overdue" : heat && score < interval ? "heat" : due ? "schedule" : null,
    rainedOn,
    rainExpectedToday,
    progress: overdue ? 9 : score / interval,
  };
}

export function feedDue(p: PlantLike, today: string, lastFedLocal: string | null, createdLocal: string): boolean {
  if (!p.feed_every_days) return false;
  const m = Number(today.slice(5, 7));
  if (m < 3 || m > 10) return false; // подкормки март–октябрь
  return daysBetween(lastFedLocal ?? createdLocal, today) >= p.feed_every_days;
}

export type Alert = { key: string; title: string; text: string; plants: string[] };

// погодные предупреждения на сегодня и ближайшую ночь
export function weatherAlerts<P extends PlantLike>(w: Weather, plants: P[], name: (p: P) => string): Alert[] {
  const out = plants.filter((p) => isOutdoor(p.location));
  if (!out.length) return [];
  const i = w.days.findIndex((d) => d.date === w.today);
  if (i < 0) return [];
  const t: Day = w.days[i];
  const next: Day | undefined = w.days[i + 1];
  const alerts: Alert[] = [];

  if (t.tmax >= 35) {
    const sensitive = out.filter((p) => p.heat_sensitive).map(name);
    alerts.push({
      key: "heat", title: `жара ${Math.round(t.tmax)}°`,
      text: "уличные поливать до 9 утра или после заката, не днём. нежным нужна тень с 11 до 16.",
      plants: sensitive,
    });
  }

  const coldest = Math.min(t.tmin, next?.tmin ?? 99);
  const cold = out.filter((p) => p.cold_min_c != null && coldest <= p.cold_min_c + 1);
  if (cold.length) {
    alerts.push({
      key: "cold", title: `ночью до ${Math.round(coldest)}°`,
      text: "укрыть или занести в дом. горшки поставить ближе к стене.",
      plants: cold.map(name),
    });
  }

  if (t.gust >= 55) {
    alerts.push({
      key: "wind", title: `ветер, порывы до ${Math.round(t.gust)} км/ч`,
      text: "высокие горшки поставить на пол или к стене, проверить опоры.",
      plants: out.filter((p) => p.location !== "outdoor_ground").map(name),
    });
  }

  if (t.rain >= 10 && t.rainProb >= 50) {
    alerts.push({
      key: "rain", title: `ливень, до ${Math.round(t.rain)} мм`,
      text: "улицу не поливать. проверить, что из горшков уходит вода и поддоны пустые.",
      plants: [],
    });
  }

  if (w.dustToday != null && w.dustToday >= 150) {
    alerts.push({
      key: "dust", title: "пыльная буря",
      text: "после неё сполоснуть листья водой: пыль забивает поры листьев и мешает фотосинтезу.",
      plants: [],
    });
  }

  return alerts;
}

// прогноз поливов на период [from, to]: список дат (YYYY-MM-DD), когда растение попросит воды.
// первая дата берётся из waterStatus, дальше симулируем: дом по интервалу, улица по испарению.
export function projectWaterDays(p: PlantLike, w: Weather, st: WaterStatus, from: string, to: string): string[] {
  const out: string[] = [];
  const today = w.today;
  let next = addDays(today, st.due ? 0 : st.daysLeft);
  const byDate = new Map(w.days.map((d) => [d.date, d] as const));
  const lastEt0 = w.days.at(-1)?.et0 || ET0_REF / 2;
  const wet = getsRain(p.location);
  let guard = 0;
  while (next <= to && guard++ < 60) {
    if (next >= from) out.push(next);
    if (!isOutdoor(p.location)) {
      const interval = isWarmSeason(next) ? p.water_every_days : (p.water_winter_days ?? p.water_every_days * 1.6);
      next = addDays(next, Math.max(1, Math.round(interval)));
    } else {
      let s = 0, k = 0;
      while (s < p.water_every_days && k < MAX_GAP_DAYS) {
        k++;
        const d = byDate.get(addDays(next, k));
        s = d ? dryStep(s, d, wet, today) : s + lastEt0 / ET0_REF;
      }
      next = addDays(next, Math.max(1, k));
    }
  }
  return out;
}

export { addDays };
