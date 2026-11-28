// у каждой кнопки бота должен быть обработчик: deno test --allow-read callbacks_wiring_test.ts
// кнопка, чей callback_data никто не разбирает, в телеграме просто «молчит»:
// часики крутятся, ничего не происходит. тест читает исходники (без сети и базы),
// собирает префиксы callback_data у всех кнопок b(...) и сверяет их с case в onCallback.
import { assert, assertEquals } from "jsr:@std/assert@1";

const DIR = new URL("./", import.meta.url);

// все .ts бота, кроме тестов
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

// префиксы callback_data у кнопок:
// b("текст", "list") / b(nameOf(p), `dgp:${p.id}`) — второй аргумент b(...), один уровень вложенных скобок;
// locationButtons((l) => `loc:${l}`) — строители данных стрелкой
export function producedPrefixes(src: string): Set<string> {
  const out = new Set<string>();
  const btn = /\bb\((?:[^()]|\([^()]*\))*?,\s*["`]([a-z][a-z0-9]*)(?=[:"`])/g;
  const arrow = /=>\s*`([a-z][a-z0-9]*):/g;
  for (const m of src.matchAll(btn)) out.add(m[1]);
  for (const m of src.matchAll(arrow)) out.add(m[1]);
  return out;
}

// команды, которые разбирает onCallback: case "x":
export function handledCommands(src: string): Set<string> {
  return new Set([...src.matchAll(/case "([a-z][a-z0-9]*)"/g)].map((m) => m[1]));
}

Deno.test("разбор: второй аргумент b(), вложенные скобки, стрелка", () => {
  const src = [
    'b("сад", "list", undefined, "list")',
    'b(nameOf(p), `dgp:${p.id}`)',
    'b(`${c.common} · ${Math.round(c.confidence * 100)}%`, `cand:${i}`)',
    'locationButtons((l) => `mvl:${l}:${a}`)',
    'b(r, `rm:${i + j}`)',
    'new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime })', // не кнопка
  ].join("\n");
  assertEquals([...producedPrefixes(src)].sort(), ["cand", "dgp", "list", "mvl", "rm"]);
  assertEquals([...handledCommands('case "w": case "wd": {\ncase "list":')].sort(), ["list", "w", "wd"]);
});

Deno.test("у каждой кнопки есть обработчик в onCallback", async () => {
  const all = await sources();
  const handled = handledCommands(all.get("handlers/callbacks.ts")!);
  const produced = new Map<string, string>(); // префикс → файл, где кнопка
  for (const [file, src] of all) for (const p of producedPrefixes(src)) produced.set(p, file);

  // защита от тихого прохода: если разбор сломается и ничего не найдёт, тест не должен зеленеть
  assert(produced.size >= 30, `найдено подозрительно мало кнопок: ${produced.size}`);
  assert(handled.size >= 30, `найдено подозрительно мало обработчиков: ${handled.size}`);

  const orphans = [...produced].filter(([p]) => !handled.has(p)).map(([p, f]) => `${p} (${f})`);
  assertEquals(orphans, [], `кнопки без обработчика: ${orphans.join(", ")}`);
});
