// погода для сада (/weather)
import { send } from "../telegram.ts";
import type { User } from "../db.ts";
import { homeNav, weather } from "./common.ts";
import { weatherText } from "./forecast_text.ts";

// ---------- погода

export async function weatherReport(u: User, chat: number) {
  return send(chat, weatherText(await weather(u)), homeNav());
}
