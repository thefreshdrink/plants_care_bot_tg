// callback_data у каждой кнопки влезает в лимит телеграма: deno test --allow-read callback_data_size_test.ts
// телеграм принимает callback_data не длиннее 64 байт (utf-8). если хоть одна кнопка длиннее,
// телеграм отклоняет всё сообщение целиком (BUTTON_DATA_INVALID): не уходит карточка или утренняя сводка.
// тест читает исходники (без сети и базы), находит каждый шаблон вида `pfx:${...}` и подставляет
// в него самое длинное, что туда может попасть: uuid растения, комнату в 30 кириллических букв и т.д.
// незнакомое выражение в шаблоне — ошибка теста: новую кнопку надо явно описать здесь.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ICON_KEYS } from "./texts.ts";

const DIR = new URL("./", import.meta.url);
const LIMIT = 64;
const bytes = (s: string) => new TextEncoder().encode(s).length;

async function sources(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const sub of ["", "handlers/"]) {
    for await (const e of Deno.readDir(new URL(sub, DIR))) {
      if (!e.isFile || !e.name.endsWith(".ts") || e.name.endsWith("_test.ts")) continue;
      out.set(sub + e.name, await Deno.readTextFile(new URL(sub + e.name, DIR)));
    }
  }
  return out;
}

const UUID = "00000000-0000-0000-0000-000000000000"; // plants.id — uuid, 36 знаков
// комната вводится текстом и режется до 30 знаков (messages.ts); кириллица — 2 байта на знак.
// знаки в 3–4 байта (иероглифы) сюда не берём: для них в digest.ts отдельная проверка, см. последний тест
const ROOM = "ж".repeat(30);
const LOCATION = ["indoor", "covered", "outdoor_pot", "outdoor_ground"]; // locationButtons в add.ts
const LONGEST_LOCATION = LOCATION.reduce((a, b) => (a.length >= b.length ? a : b));
const LONGEST_ICON = ICON_KEYS.map((k) => k.key).reduce((a, b) => (a.length >= b.length ? a : b));

// выражение внутри ${...} → самое длинное значение
function worst(expr: string): string | undefined {
  const e = expr.trim();
  if (/^(id|a|p\.id|plantId)$/.test(e)) return UUID;
  if (/^(room|roomOf\(p\))$/.test(e)) return ROOM;
  if (e === "l") return LONGEST_LOCATION;
  if (e === "x.key") return LONGEST_ICON;
  if (e === "mode") return "g"; // wk: режим недели d / g
  // номера: кандидат определителя, комната в списке, час, смещение недели, индекс — с запасом
  if (/^(i|i \+ j|h|idx|offset|offset [+-] 1|names\.indexOf\(n\))$/.test(e)) return "-9999";
  return undefined;
}

// шаблоны `pfx:${...}...` с файлом и номером строки. после двоеточия до первой подстановки —
// без пробелов и «/»: так отсеиваются адреса (`https://…${KEY}`) и тексты ошибок (`db: ${…}`)
export function templates(src: string): { tpl: string; line: number }[] {
  const out: { tpl: string; line: number }[] = [];
  for (const m of src.matchAll(/`([a-z][a-z0-9]*:[^`\s\/]*?\$\{[^`]*)`/g)) {
    out.push({ tpl: m[1], line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

export function fill(tpl: string): { data: string; unknown: string[] } {
  const unknown: string[] = [];
  const data = tpl.replace(/\$\{([^}]*)\}/g, (_, expr: string) => {
    const v = worst(expr);
    if (v === undefined) unknown.push(expr);
    return v ?? "";
  });
  return { data, unknown };
}

Deno.test("разбор: шаблоны и подстановка худшего случая", () => {
  const src = [
    "b(nameOf(p), `dgp:${p.id}`)",
    "locationButtons((l) => `mvl:${l}:${a}`)",
    "const s = `${n} дней`;", // не кнопка
    "fetch(`https://api.example.org/x?key=${KEY}`)", // адрес
    "throw new Error(`db: ${r.error.message}`)", // текст ошибки
  ].join("\n");
  assertEquals(templates(src).map((t) => t.tpl), ["dgp:${p.id}", "mvl:${l}:${a}"]);
  assertEquals(fill("mvl:${l}:${a}").data, `mvl:outdoor_ground:${UUID}`);
  assertEquals(fill("x:${что-то}").unknown, ["что-то"]);
  assertEquals(bytes(`wr:${ROOM}`), 63);
});

Deno.test("каждая кнопка с подстановкой влезает в 64 байта callback_data", async () => {
  const found: string[] = [];
  const unknown: string[] = [];
  const tooLong: string[] = [];
  for (const [file, src] of await sources()) {
    for (const { tpl, line } of templates(src)) {
      const where = `${file}:${line} \`${tpl}\``;
      found.push(where);
      const f = fill(tpl);
      if (f.unknown.length) unknown.push(`${where} — ${f.unknown.join(", ")}`);
      else if (bytes(f.data) > LIMIT) tooLong.push(`${where} — ${bytes(f.data)} байт`);
    }
  }
  // защита от тихого прохода: если разбор сломается и ничего не найдёт, тест не должен зеленеть
  assert(found.length >= 40, `найдено подозрительно мало шаблонов: ${found.length}`);
  assertEquals(unknown, [], `не знаю, что подставить:\n${unknown.join("\n")}`);
  assertEquals(tooLong, [], `длиннее ${LIMIT} байт:\n${tooLong.join("\n")}`);
});

Deno.test("комната в кнопке «полито: комната» — если не влезает, кнопки нет (digest.ts)", async () => {
  // название комнаты режется до 30 знаков, но знак бывает и в 3–4 байта (иероглиф, эмодзи):
  // тогда `wr:` длиннее 64, и digest.ts такую кнопку не рисует. проверяем, что проверка на месте
  const digest = await Deno.readTextFile(new URL("handlers/digest.ts", DIR));
  assert(/new TextEncoder\(\)\.encode\(`wr:\$\{room\}`\)\.length <= 64/.test(digest), "в digest.ts нет проверки длины wr:");
  const messages = await Deno.readTextFile(new URL("handlers/messages.ts", DIR));
  assertEquals(messages.match(/room: text\.toLowerCase\(\)\.slice\(0, 30\)/g)?.length, 2, "комната больше не режется до 30 знаков");
  assert(bytes(`wr:${"水".repeat(30)}`) > LIMIT); // ради чего проверка в digest.ts
});
