// погода: open-meteo, бесплатно и без ключа для некоммерческого использования

export type Day = {
  date: string;          // YYYY-MM-DD, местная дата
  tmax: number;
  tmin: number;
  rain: number;          // мм осадков за сутки
  rainProb: number;      // % вероятность осадков (для прогноза)
  et0: number;           // эвапотранспирация, мм/сутки: сколько воды «уходит» из почвы и листьев
  gust: number;          // порывы ветра, км/ч
  uv: number;
  code: number;          // код погоды wmo
};

export type Weather = {
  days: Day[];
  today: string;
  dustToday: number | null; // пыль, мкг/м³, максимум за сегодня
};

const n = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);

export async function fetchWeather(lat: number, lon: number, tz: string, pastDays = 45): Promise<Weather> {
  const daily = [
    "temperature_2m_max", "temperature_2m_min", "precipitation_sum",
    "precipitation_probability_max", "et0_fao_evapotranspiration",
    "wind_gusts_10m_max", "uv_index_max", "weather_code",
  ].join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=${daily}&timezone=${encodeURIComponent(tz)}&past_days=${pastDays}&forecast_days=7`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const j = await res.json();
  const d = j.daily;
  const days: Day[] = d.time.map((date: string, i: number) => ({
    date,
    tmax: n(d.temperature_2m_max[i]),
    tmin: n(d.temperature_2m_min[i]),
    rain: n(d.precipitation_sum[i]),
    rainProb: n(d.precipitation_probability_max?.[i]),
    et0: n(d.et0_fao_evapotranspiration[i]),
    gust: n(d.wind_gusts_10m_max[i]),
    uv: n(d.uv_index_max[i]),
    code: n(d.weather_code[i]),
  }));

  const today = localDate(tz);
  let dustToday: number | null = null;
  try {
    const aq = await fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}` +
        `&hourly=dust&timezone=${encodeURIComponent(tz)}&forecast_days=1`,
    );
    if (aq.ok) {
      const a = await aq.json();
      const vals: number[] = (a.hourly?.dust ?? []).filter((x: unknown) => typeof x === "number");
      if (vals.length) dustToday = Math.max(...vals);
    }
  } catch { /* пыль не критична */ }

  return { days, today, dustToday };
}

export function localDate(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(at);
}

export function localHour(tz: string, at: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(at)) % 24;
}

// коротко словами по коду wmo
export function sky(code: number): string {
  if (code === 0) return "ясно";
  if (code <= 2) return "малооблачно";
  if (code === 3) return "пасмурно";
  if (code <= 48) return "туман";
  if (code <= 57) return "морось";
  if (code <= 67) return "дождь";
  if (code <= 77) return "снег";
  if (code <= 82) return "ливни";
  return "гроза";
}
