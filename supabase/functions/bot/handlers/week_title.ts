// заголовок недели «2–8 ноября» / «30 ноября – 6 декабря»; чистая функция, база и сеть не нужны
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

export function weekTitle(mon: string, sun: string): string {
  const d1 = Number(mon.slice(8)), d2 = Number(sun.slice(8));
  const m1 = MONTHS_GEN[Number(mon.slice(5, 7)) - 1], m2 = MONTHS_GEN[Number(sun.slice(5, 7)) - 1];
  return m1 === m2 ? `${d1}–${d2} ${m2}` : `${d1} ${m1} – ${d2} ${m2}`;
}
