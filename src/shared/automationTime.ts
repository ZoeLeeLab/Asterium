import { AUTOMATION_ON_TIME_MS, type Automation } from './automations';

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(at: number, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); formatters.set(zone, formatter); }
  const p = Object.fromEntries(formatter.formatToParts(at).map(item => [item.type, item.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
export const automationDate = (at: number, zone: string) => parts(at, zone).date;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
function matchesDay(definition: Automation, date: string) {
  return definition.schedule.type !== 'weekly' || definition.schedule.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay());
}
/** Earliest repeated wall time; a DST gap advances to its first valid minute on that date. */
export function automationWallTime(date: string, time: string, zone: string): number | undefined {
  const nominal = Date.parse(`${date}T${time}:00Z`), target = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const candidates = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const probe = nominal + h * 3600000, p = parts(probe, zone);
    const wall = Date.parse(`${p.date}T00:00:00Z`) + p.minute * 60000;
    const candidate = nominal - (wall - probe);
    const c = parts(candidate, zone); if (c.date === date && c.minute === target) candidates.add(candidate);
  }
  if (candidates.size) return Math.min(...candidates);
  // Only used for nonexistent wall times, not for ordinary clock ticks.
  for (let at = nominal - 16 * 3600000; at <= nominal + 16 * 3600000; at += 60000) {
    const p = parts(at, zone); if (p.date === date && p.minute >= target) return at;
  }
  return undefined;
}
export function dueAutomation(definition: Automation, now: number): number | undefined {
  if (!definition.enabled || definition.deletedAt) return undefined;
  const effective = Date.parse(definition.effectiveFrom), s = definition.schedule;
  if (now < effective) return undefined;
  let due: number | undefined;
  if (s.type === 'once') due = Date.parse(s.at);
  else if (s.type === 'interval') {
    const anchor = effective - 1, interval = s.minutes * 60000;
    const n = Math.floor((now - anchor) / interval); if (n < 1) return undefined; due = anchor + n * interval;
  } else {
    const date = automationDate(now, definition.timezone); if (!matchesDay(definition, date)) return undefined;
    due = automationWallTime(date, s.time, definition.timezone);
  }
  if (due === undefined || due < effective || due > now) return undefined;
  if (definition.catchUp === 'skip' && now - due >= AUTOMATION_ON_TIME_MS) return undefined;
  return due;
}
export function nextAutomation(definition: Automation, now: number): number | undefined {
  if (!definition.enabled || definition.deletedAt) return undefined;
  const effective = Date.parse(definition.effectiveFrom), s = definition.schedule, after = Math.max(now, effective - 1);
  if (s.type === 'once') { const at = Date.parse(s.at); return at > after && at >= effective ? at : undefined; }
  if (s.type === 'interval') {
    const anchor = effective - 1, interval = s.minutes * 60000;
    return anchor + (Math.floor((after - anchor) / interval) + 1) * interval;
  }
  const today = automationDate(after, definition.timezone);
  for (let index = 0; index < 15; index++) {
    const date = addDays(today, index); if (!matchesDay(definition, date)) continue;
    const at = automationWallTime(date, s.time, definition.timezone); if (at !== undefined && at > after && at >= effective) return at;
  }
  return undefined;
}
export function automationOccurrenceId(definition: Automation, at: number) { return `${definition.id}:${definition.scheduleRevision}:${new Date(at).toISOString()}`; }
export function automationRunExpired(run: { trigger: string; scheduledAt: string; definition: Automation }, now: number) {
  const s = run.definition.schedule;
  return run.trigger === 'scheduled' && (s.type === 'daily' || s.type === 'weekly')
    && automationDate(Date.parse(run.scheduledAt), run.definition.timezone) !== automationDate(now, run.definition.timezone);
}
