// тесты разбора погоды: deno test supabase/functions/bot/weather_test.ts
// сеть не нужна: fetch подменяется ответами в формате open-meteo
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { fetchWeather, localDate, localHour, sky } from "./weather.ts";
import type { Weather } from "./weather.ts";

const TZ = "Asia/Nicosia";

type Reply = { status?: number; body?: unknown; throws?: boolean };

// подменить fetch: прогноз и пыль отвечают по-своему; вернуть запрошенные адреса
async function withFetch(forecast: Reply, air: Reply, run: () => Promise<void>): Promise<string[]> {
  const urls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const r = url.includes("air-quality") ? air : forecast;
    if (r.throws) return Promise.reject(new Error("offline"));
    return Promise.resolve(new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 }));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = orig;
  }
  return urls;
}

const daily = {
  time: ["2026-10-25", "2026-10-26"],
  temperature_2m_max: [27.1, 25],
  temperature_2m_min: [18, null],
  precipitation_sum: [0, 4.2],
  precipitation_probability_max: [null, 80],
  et0_fao_evapotranspiration: [3.1, 1.2],
  wind_gusts_10m_max: [20, 55],
  uv_index_max: [5, 3],
  weather_code: [0, 63],
};

Deno.test("разбор дней: поля по местам, пустые значения → 0", async () => {
  let w: Weather | undefined;
  await withFetch({ body: { daily } }, { body: { hourly: { dust: [10, null, 42, 7] } } }, async () => {
    w = await fetchWeather(34.68, 33.04, TZ);
  });
  assertEquals(w!.days.length, 2);
  assertEquals(w!.days[1], {
    date: "2026-10-26", tmax: 25, tmin: 0, rain: 4.2, rainProb: 80,
    et0: 1.2, gust: 55, uv: 3, code: 63,
  });
  assertEquals(w!.days[0].rainProb, 0);
  assertEquals(w!.dustToday, 42);
});

Deno.test("нет вероятности осадков в ответе вовсе → 0, а не падение", async () => {
  const { precipitation_probability_max: _, ...noProb } = daily;
  let w: Weather | undefined;
  await withFetch({ body: { daily: noProb } }, { body: {} }, async () => {
    w = await fetchWeather(34.68, 33.04, TZ);
  });
  assertEquals(w!.days.map((d) => d.rainProb), [0, 0]);
});

Deno.test("пыль не критична: ошибка, пустой ответ или обрыв → null", async () => {
  for (const air of [{ status: 500 }, { body: { hourly: { dust: [] } } }, { throws: true }]) {
    let w: Weather | undefined;
    await withFetch({ body: { daily } }, air, async () => {
      w = await fetchWeather(34.68, 33.04, TZ);
    });
    assertEquals(w!.dustToday, null);
    assertEquals(w!.days.length, 2);
  }
});

Deno.test("ошибка прогноза — исключение с кодом ответа", async () => {
  await withFetch({ status: 429 }, { body: {} }, async () => {
    await assertRejects(() => fetchWeather(34.68, 33.04, TZ), Error, "open-meteo 429");
  });
});

Deno.test("запрос: координаты, часовой пояс, прошлые дни", async () => {
  const urls = await withFetch({ body: { daily } }, { body: {} }, async () => {
    await fetchWeather(34.68, 33.04, TZ, 10);
  });
  const u = new URL(urls[0]);
  assertEquals(u.searchParams.get("latitude"), "34.68");
  assertEquals(u.searchParams.get("longitude"), "33.04");
  assertEquals(u.searchParams.get("timezone"), TZ);
  assertEquals(u.searchParams.get("past_days"), "10");
  assertEquals(u.searchParams.get("forecast_days"), "7");
});

Deno.test("местные дата и час: Никосия до и после смены времени 25.10", () => {
  // летом UTC+3: 21:30 UTC — уже следующий день
  assertEquals(localDate(TZ, new Date("2026-10-24T21:30:00Z")), "2026-10-25");
  assertEquals(localHour(TZ, new Date("2026-10-24T21:30:00Z")), 0);
  // зимой UTC+2: 21:30 UTC — ещё тот же день
  assertEquals(localDate(TZ, new Date("2026-10-26T21:30:00Z")), "2026-10-26");
  assertEquals(localHour(TZ, new Date("2026-10-26T21:30:00Z")), 23);
});

Deno.test("небо словами по коду wmo", () => {
  const cases: [number, string][] = [
    [0, "ясно"], [2, "малооблачно"], [3, "пасмурно"], [45, "туман"], [53, "морось"],
    [63, "дождь"], [71, "снег"], [81, "ливни"], [95, "гроза"],
  ];
  for (const [code, word] of cases) assertEquals(sky(code), word);
});
