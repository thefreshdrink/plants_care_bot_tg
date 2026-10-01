// pl@ntnet: необязательный, но более точный определитель. включается, если задан PLANTNET_API_KEY.
import type { Candidate } from "./claude.ts";

const KEY = Deno.env.get("PLANTNET_API_KEY");
export const plantnetEnabled = !!KEY;

export async function plantnetIdentify(bytes: Uint8Array, mime: string): Promise<Candidate[]> {
  const form = new FormData();
  form.append("images", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), "plant.jpg");
  form.append("organs", "auto");
  const res = await fetch(
    `https://my-api.plantnet.org/v2/identify/all?api-key=${KEY}&lang=ru&nb-results=3&include-related-images=false`,
    { method: "POST", body: form },
  );
  if (res.status === 404) return []; // «вид не найден»
  if (!res.ok) throw new Error(`plantnet ${res.status}`);
  const j = await res.json();
  return (j.results ?? []).slice(0, 3).map((r: any) => ({
    latin: r.species?.scientificNameWithoutAuthor ?? "?",
    common: r.species?.commonNames?.[0] ?? r.species?.scientificNameWithoutAuthor ?? "?",
    confidence: r.score ?? 0,
  }));
}
