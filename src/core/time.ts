export interface LocalTime {
  /** YYYY-MM-DD in the local zone */
  date: string;
  /** 1 = Monday ... 7 = Sunday */
  weekday: number;
  /** minutes since local midnight */
  minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Local date, weekday and minute of day for a unix-seconds timestamp. */
export function local(ts: number, tz: string): LocalTime {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ts * 1000))) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WEEKDAYS[parts.weekday],
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** "HH:MM" -> minutes since midnight */
export function hm(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

/** Date (YYYY-MM-DD) of the Monday of the week containing `date`. */
export function weekKey(date: string, weekday: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (weekday - 1));
  return d.toISOString().slice(0, 10);
}
