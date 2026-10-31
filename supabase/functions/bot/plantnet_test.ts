// тесты определителя pl@ntnet: deno test supabase/functions/bot/plantnet_test.ts
// сеть не нужна: fetch подменяется ответами в формате my-api.plantnet.org
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { plantnetIdentify } from "./plantnet.ts";

type Reply = { status?: number; body?: unknown };

// подменить fetch одним ответом; вернуть запрошенные адреса
async function withFetch(reply: Reply, run: () => Promise<void>): Promise<string[]> {
  const urls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 }));
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = orig;
  }
  return urls;
}

const photo = new Uint8Array([1, 2, 3]);

const species = (latin: string, common: string[], score: number) => ({
  score,
  species: { scientificNameWithoutAuthor: latin, commonNames: common },
});

Deno.test("plantnet: первые три кандидата — латынь, русское имя, уверенность", async () => {
  const urls = await withFetch({
    body: {
      results: [
        species("Monstera deliciosa", ["Монстера деликатесная", "Монстера"], 0.91),
        species("Epipremnum aureum", ["Эпипремнум золотистый"], 0.05),
        species("Philodendron hederaceum", ["Филодендрон"], 0.02),
        species("Scindapsus pictus", ["Сциндапсус"], 0.01),
      ],
    },
  }, async () => {
    assertEquals(await plantnetIdentify(photo, "image/jpeg"), [
      { latin: "Monstera deliciosa", common: "Монстера деликатесная", confidence: 0.91 },
      { latin: "Epipremnum aureum", common: "Эпипремнум золотистый", confidence: 0.05 },
      { latin: "Philodendron hederaceum", common: "Филодендрон", confidence: 0.02 },
    ]);
  });
  assertEquals(urls.length, 1);
  assertEquals(urls[0].startsWith("https://my-api.plantnet.org/v2/identify/all?"), true);
  assertEquals(urls[0].includes("lang=ru"), true);
  assertEquals(urls[0].includes("nb-results=3"), true);
});

Deno.test("plantnet: без русского имени — латынь, без вида — «?», без оценки — 0", async () => {
  await withFetch({
    body: {
      results: [
        { score: 0.4, species: { scientificNameWithoutAuthor: "Ficus lyrata", commonNames: [] } },
        { species: {} },
      ],
    },
  }, async () => {
    assertEquals(await plantnetIdentify(photo, "image/png"), [
      { latin: "Ficus lyrata", common: "Ficus lyrata", confidence: 0.4 },
      { latin: "?", common: "?", confidence: 0 },
    ]);
  });
});

Deno.test("plantnet: 404 «вид не найден» и пустой ответ — пустой список", async () => {
  await withFetch({ status: 404, body: { message: "Species not found" } }, async () => {
    assertEquals(await plantnetIdentify(photo, "image/jpeg"), []);
  });
  await withFetch({ body: {} }, async () => {
    assertEquals(await plantnetIdentify(photo, "image/jpeg"), []);
  });
});

Deno.test("plantnet: другая ошибка сервиса — исключение с кодом", async () => {
  await withFetch({ status: 429, body: {} }, async () => {
    await assertRejects(() => plantnetIdentify(photo, "image/jpeg"), Error, "plantnet 429");
  });
});
