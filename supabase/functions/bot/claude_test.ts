// тесты общения с anthropic api: deno test supabase/functions/bot/claude_test.ts
// сеть не нужна: fetch подменяется ответами в формате api.anthropic.com
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { diagnose, identify, locationRu } from "./claude.ts";

type Sent = { url: string; body: any };

// подменить fetch одним ответом; вернуть отправленные запросы
async function withFetch(reply: () => Response, run: () => Promise<void>): Promise<Sent[]> {
  const sent: Sent[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return Promise.resolve(reply());
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = orig;
  }
  return sent;
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

// поток sse кусками: куски режут строки где попало, как в сети
const stream = (chunks: string[]) => () =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    }),
    { status: 200 },
  );

const delta = (text: string) =>
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`;

const photo = { base64: "AAAA", mime: "image/jpeg" };

Deno.test("identify: кандидаты из вызова инструмента, в запросе фото и подпись", async () => {
  let r: Awaited<ReturnType<typeof identify>> | undefined;
  const sent = await withFetch(
    json({
      content: [
        { type: "text", text: "смотрю" },
        {
          type: "tool_use",
          name: "report_candidates",
          input: {
            traits: "мясистые листья",
            is_plant: true,
            candidates: [{ latin: "Aloe vera", common: "алоэ", confidence: 0.8 }],
          },
        },
      ],
    }),
    async () => {
      r = await identify(photo, "на балконе");
    },
  );
  assertEquals(r, { isPlant: true, candidates: [{ latin: "Aloe vera", common: "алоэ", confidence: 0.8 }] });
  assertEquals(sent.length, 1);
  assertEquals(sent[0].url, "https://api.anthropic.com/v1/messages");
  const b = sent[0].body;
  assertEquals(typeof b.model, "string");
  assertEquals(b.tool_choice, { type: "tool", name: "report_candidates" });
  const [img, txt] = b.messages[0].content;
  assertEquals(img.source, { type: "base64", media_type: "image/jpeg", data: "AAAA" });
  assertEquals(txt.text, "подпись к фото: на балконе\n\nчто это за растение?");
});

Deno.test("identify: не растение и без кандидатов — пустой список", async () => {
  let r: Awaited<ReturnType<typeof identify>> | undefined;
  await withFetch(
    json({ content: [{ type: "tool_use", input: { traits: "кот", is_plant: false } }] }),
    async () => {
      r = await identify(photo);
    },
  );
  assertEquals(r, { isPlant: false, candidates: [] });
});

Deno.test("identify: ответ без вызова инструмента — исключение", async () => {
  await withFetch(json({ content: [{ type: "text", text: "не знаю" }] }), async () => {
    await assertRejects(() => identify(photo), Error, "claude не вернул структуру");
  });
});

Deno.test("ошибка api — исключение с кодом и текстом", async () => {
  await withFetch(json({ error: { message: "overloaded" } }, 529), async () => {
    await assertRejects(() => identify(photo), Error, "anthropic 529: overloaded");
  });
});

Deno.test("diagnose: поток склеивается из кусков, onText видит накопленный текст", async () => {
  const seen: string[] = [];
  let out = "";
  const whole = delta("что вижу: ") + delta("здоровое растение") +
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } })}\n\n` +
    `data: ${JSON.stringify({ type: "message_stop" })}\n\n` + delta("\n");
  // режем посреди строки data:, чтобы проверить перенос хвоста в следующий кусок
  const cut = whole.indexOf("здоровое") + 3;
  const sent = await withFetch(stream([whole.slice(0, cut), whole.slice(cut)]), async () => {
    out = await diagnose(photo, "алоэ на балконе", "сухо, 30°", undefined, (t) => seen.push(t));
  });
  assertEquals(out, "что вижу: здоровое растение");
  assertEquals(seen, ["что вижу: ", "что вижу: здоровое растение", "что вижу: здоровое растение\n"]);
  assertEquals(sent[0].body.stream, true);
  const txt = sent[0].body.messages[0].content[1].text;
  assertEquals(txt, "алоэ на балконе\n\nпогода последних дней: сухо, 30°\n\nчто с ним?");
});

Deno.test("diagnose: ошибка потока — исключение с кодом", async () => {
  await withFetch(json({ error: { message: "bad image" } }, 400), async () => {
    await assertRejects(() => diagnose(photo, "", ""), Error, "anthropic 400: bad image");
  });
});

Deno.test("locationRu: известные места словами, незнакомое как есть", () => {
  assertEquals(locationRu("indoor"), "дома, в комнате");
  assertEquals(locationRu("outdoor_ground"), "на улице в грунте");
  assertEquals(locationRu("roof"), "roof");
});
