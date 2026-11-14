// тесты строки истории растения: deno test supabase/functions/bot/handlers/history_line_test.ts
// история — единственное место, где видно, что было с растением; дата берётся по часовому поясу
// пользователя, а заметки и диагнозы пишет сам человек или claude, поэтому их надо экранировать.
import { assertEquals } from "jsr:@std/assert@1";
import { historyLine } from "./history_line.ts";

const NIC = "Asia/Nicosia";
const ev = (kind: string, note: string | null = null, created_at = "2026-11-09T10:00:00Z") => ({ kind, note, created_at });

Deno.test("полив, дождь, удобрение, фото — словом", () => {
  assertEquals(historyLine(NIC, ev("water")), "9 ноября · полито");
  assertEquals(historyLine(NIC, ev("rain")), "9 ноября · дождь");
  assertEquals(historyLine(NIC, ev("feed")), "9 ноября · удобрение");
  assertEquals(historyLine(NIC, ev("photo")), "9 ноября · фото");
});

Deno.test("незнакомое событие показывается как есть, а не пропадает", () => {
  assertEquals(historyLine(NIC, ev("repot")), "9 ноября · repot");
});

Deno.test("дата по часовому поясу пользователя: 22:30 UTC — уже следующий день в Никосии", () => {
  assertEquals(historyLine(NIC, ev("water", null, "2026-11-09T22:30:00Z")), "10 ноября · полито");
  assertEquals(historyLine("UTC", ev("water", null, "2026-11-09T22:30:00Z")), "9 ноября · полито");
});

Deno.test("заметка жирным и экранирована", () => {
  assertEquals(historyLine(NIC, ev("note", "новый лист <3 & ура")), "9 ноября · <b>новый лист &lt;3 &amp; ура</b>");
  assertEquals(historyLine(NIC, ev("note", null)), "9 ноября · <b></b>");
});

Deno.test("первое фото при добавлении — «добавлено в сад», новое фото — просто «фото»", () => {
  assertEquals(historyLine(NIC, ev("photo", "добавлено")), "9 ноября · добавлено в сад");
  assertEquals(historyLine(NIC, ev("photo", "другое")), "9 ноября · фото");
});

Deno.test("диагноз: только первая строка, не длиннее 80 знаков, экранирован", () => {
  assertEquals(historyLine(NIC, ev("diagnosis", "перелив <корни>\nподробности ниже")), "9 ноября · диагноз: <i>перелив &lt;корни&gt;</i>");
  const long = "а".repeat(100);
  assertEquals(historyLine(NIC, ev("diagnosis", long)), `9 ноября · диагноз: <i>${"а".repeat(80)}</i>`);
  assertEquals(historyLine(NIC, ev("diagnosis", null)), "9 ноября · диагноз: <i></i>");
});
