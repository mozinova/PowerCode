const UNITS = ["B", "KB", "MB", "GB"];

const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** IntelliJ-style commit date: "Today 14:05", "Yesterday 09:12", or the date. */
export function formatCommitDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday.getTime() - date.getTime()) / 86_400_000) + 1;
  if (date >= startOfToday) return `Today ${TIME.format(date)}`;
  if (days === 1) return `Yesterday ${TIME.format(date)}`;
  return DATE.format(date);
}

export function formatDateTime(seconds: number): string {
  return DATE_TIME.format(new Date(seconds * 1000));
}

/** Human-readable byte size, e.g. `1.4 MB`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}
