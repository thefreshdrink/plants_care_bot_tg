// у каждой команды из меню телеграма должен быть обработчик: deno test --allow-read commands_wiring_test.ts
// меню команд (COMMANDS в texts.ts) бот сам пересылает в телеграм, а разбирает их onMessage
// в handlers/messages.ts. команда в меню без case "/x" молча уйдёт в свободный чат с ИИ.
// тест читает исходник (без сети и базы) и сверяет одно с другим, плюс правила телеграма
// для setMyCommands: имя 1–32 знака из a–z, 0–9 и _, описание 1–256 знаков, не больше 100 команд.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { COMMANDS } from "./texts.ts";

const MESSAGES = new URL("./handlers/messages.ts", import.meta.url);

// команды, которые разбирает onMessage: case "/x":
export function handledSlashCommands(src: string): Set<string> {
  return new Set([...src.matchAll(/case "\/([a-z0-9_]+)"/g)].map((m) => m[1]));
}

Deno.test("разбор: case \"/x\" в одну строку и подряд", () => {
  const src = 'case "/start": case "/help": return x;\n    case "/week": return w;\n case "wr": ...';
  assertEquals([...handledSlashCommands(src)].sort(), ["help", "start", "week"]);
});

Deno.test("каждая команда меню разбирается в onMessage", async () => {
  const handled = handledSlashCommands(await Deno.readTextFile(MESSAGES));
  const missing = COMMANDS.map((c) => c.command).filter((c) => !handled.has(c));
  assertEquals(missing, [], `в меню есть, а обработчика нет: ${missing.join(", ")}`);
});

Deno.test("меню команд по правилам телеграма", () => {
  assert(COMMANDS.length >= 1 && COMMANDS.length <= 100, `команд ${COMMANDS.length}`);
  const seen = new Set<string>();
  for (const { command, description } of COMMANDS) {
    assert(/^[a-z0-9_]{1,32}$/.test(command), `имя «${command}» телеграм не примет`);
    assert(!seen.has(command), `«${command}» в меню дважды`);
    seen.add(command);
    const len = [...description].length;
    assert(len >= 1 && len <= 256, `описание «${command}»: ${len} знаков`);
  }
});

Deno.test("/start и /help разбираются, хотя их нет в меню", async () => {
  // /start телеграм шлёт сам при первом входе, без него бот не здоровается
  const handled = handledSlashCommands(await Deno.readTextFile(MESSAGES));
  assert(handled.has("start"));
  assert(handled.has("help"));
});
