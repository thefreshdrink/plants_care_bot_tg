// всё общение с anthropic api
import { VOICE } from "./texts.ts";

const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5";

type Img = { base64: string; mime: string };
type Msg = { role: "user" | "assistant"; content: any };

async function call(body: Record<string, unknown>): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, ...body }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${j?.error?.message ?? ""}`);
  return j;
}

// потоковый ответ: onText получает весь накопленный текст по мере генерации
async function callStream(body: Record<string, unknown>, onText: (t: string) => void): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: true, ...body }),
  });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`anthropic ${res.status}: ${j?.error?.message ?? ""}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      try {
        const ev = JSON.parse(line.slice(5));
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          out += ev.delta.text;
          onText(out);
        }
      } catch { /* неполная строка */ }
    }
  }
  return out.trim();
}

const imageBlock = (i: Img) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.base64 } });
const text = (j: any) => (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();

// структурированный ответ: заставляем модель вызвать «инструмент» с нужной схемой
async function structured<T>(system: string, content: any[], name: string, schema: Record<string, unknown>, maxTokens = 1500): Promise<T> {
  const j = await call({
    max_tokens: maxTokens,
    system,
    tools: [{ name, description: "верни результат строго по схеме", input_schema: schema }],
    tool_choice: { type: "tool", name },
    messages: [{ role: "user", content }],
  });
  const block = j.content.find((b: any) => b.type === "tool_use");
  if (!block) throw new Error("claude не вернул структуру");
  return block.input as T;
}

// ---------- определение растения по фото

export type Candidate = { latin: string; common: string; confidence: number };

export async function identify(img: Img): Promise<{ isPlant: boolean; candidates: Candidate[] }> {
  const r = await structured<{ is_plant: boolean; candidates: Candidate[] }>(
    "ты ботаник. определи растение на фото. дай до 3 вариантов, самый вероятный первым. " +
      "latin: научное название без автора. common: общепринятое русское название (если нет, то латынь). " +
      "confidence: 0..1, будь честным, не завышай.",
    [imageBlock(img), { type: "text", text: "что это за растение?" }],
    "report_candidates",
    {
      type: "object",
      properties: {
        is_plant: { type: "boolean" },
        candidates: {
          type: "array", maxItems: 3,
          items: {
            type: "object",
            properties: { latin: { type: "string" }, common: { type: "string" }, confidence: { type: "number" } },
            required: ["latin", "common", "confidence"],
          },
        },
      },
      required: ["is_plant", "candidates"],
    },
    600,
  );
  return { isPlant: r.is_plant, candidates: r.candidates ?? [] };
}

// ---------- карточка ухода

export type Care = {
  common_name: string;
  summary: string;
  light: string;
  water_how: string;
  water_every_days: number;
  water_winter_days: number | null;
  feed_every_days: number | null;
  feed_what: string;
  soil: string;
  cold_min_c: number;
  heat_sensitive: boolean;
  toxic: string;
  local_tips: string;
  trouble_signs: string;
};

const LOCATION_RU: Record<string, string> = {
  indoor: "дома, в комнате",
  covered: "на балконе или террасе под крышей (жара и ветер есть, дождь не попадает)",
  outdoor_pot: "на улице в горшке",
  outdoor_ground: "на улице в грунте",
};

export async function careCard(latin: string, common: string, location: string, place: string): Promise<Care> {
  const outdoor = location !== "indoor";
  return await structured<Care>(
    `ты опытный садовник в средиземноморском климате. ${VOICE}\n` +
      `составь карточку ухода для растения, которое растёт в ${place} (кипр, побережье: жаркое сухое лето до 35–40°, ` +
      `мягкая дождливая зима 8–18°, редкие ночи около 3–5°, ветра, пыльные бури).\n` +
      (outdoor
        ? "water_every_days: через сколько дней поливать, если все эти дни были жаркие летние (около 32°, солнце). " +
          "бот сам растянет интервал в прохладную погоду и учтёт дождь. water_winter_days верни null.\n"
        : "water_every_days: интервал полива в тёплый сезон (апрель–октябрь) дома с кондиционером. " +
          "water_winter_days: интервал зимой.\n") +
      "feed_every_days: раз в сколько дней подкармливать в сезон роста, null если не нужно. " +
      "cold_min_c: минимальная ночная температура, которую растение переносит без укрытия. " +
      "heat_sensitive: true, если в жару выше 35° ему нужна тень. " +
      "все текстовые поля: 1–2 коротких предложения, конкретно, без воды.",
    [{ type: "text", text: `растение: ${latin} (${common}). где стоит: ${LOCATION_RU[location]}.` }],
    "care_card",
    {
      type: "object",
      properties: {
        common_name: { type: "string" },
        summary: { type: "string", description: "одна фраза: характер растения" },
        light: { type: "string" },
        water_how: { type: "string", description: "как поливать: как понять, что пора, сколько воды" },
        water_every_days: { type: "number" },
        water_winter_days: { type: ["number", "null"] },
        feed_every_days: { type: ["number", "null"] },
        feed_what: { type: "string" },
        soil: { type: "string" },
        cold_min_c: { type: "number" },
        heat_sensitive: { type: "boolean" },
        toxic: { type: "string", description: "ядовито ли для кошек, собак, детей" },
        local_tips: { type: "string", description: "особенности именно для лимассола" },
        trouble_signs: { type: "string", description: "частые проблемы и как их узнать" },
      },
      required: ["common_name", "summary", "light", "water_how", "water_every_days", "water_winter_days",
        "feed_every_days", "feed_what", "soil", "cold_min_c", "heat_sensitive", "toxic", "local_tips", "trouble_signs"],
    },
  );
}

export const locationRu = (l: string) => LOCATION_RU[l] ?? l;

// ---------- диагностика по фото

export async function diagnose(img: Img, plantContext: string, weatherContext: string, question?: string, onText: (t: string) => void = () => {}): Promise<string> {
  return await callStream({
    max_tokens: 900,
    system:
      `ты фитопатолог и садовник на кипре. ${VOICE}\n` +
      "по фото оцени состояние растения. структура ответа, каждый пункт с новой строки:\n" +
      "что вижу: ...\nвероятная причина: ... (если причин несколько, по убыванию вероятности)\n" +
      "что сделать: 2–4 коротких шага\nкогда бить тревогу: ...\n" +
      "если растение выглядит здоровым, так и скажи. если по фото не понять, скажи, какое фото нужно. " +
      "не используй markdown.",
    messages: [{
      role: "user",
      content: [
        imageBlock(img),
        { type: "text", text: `${plantContext}\n\nпогода последних дней: ${weatherContext}\n\n${question || "что с ним?"}` },
      ],
    }],
  }, onText);
}

// ---------- свободный чат

export async function chat(history: Msg[], context: string, onText: (t: string) => void = () => {}): Promise<string> {
  return await callStream({
    max_tokens: 900,
    system:
      `ты садовник-помощник в телеграм-боте. хозяйка живёт в лимассоле, кипр. ${VOICE}\n` +
      "отвечай по делу, коротко. не используй markdown. если вопрос про конкретное растение из коллекции, опирайся на данные ниже.\n\n" +
      context,
    messages: history,
  }, onText);
}
