/** Date + text helpers. Every page formats through these — never inline. */

const DATE_FMT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MONTH_FMT = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' });

/** 2026.11.02 — editorial, unambiguous, sorts alphabetically too. */
export function formatDate(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = toDate(input);
  if (!d) return '—';
  const parts = DATE_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}.${get('month')}.${get('day')}`;
}

/** 11月2日 — compact, used inside dense lists. */
export function formatMonthDay(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = toDate(input);
  if (!d) return '—';
  return MONTH_FMT.format(d).replace(/\//g, '月').replace(/$/, '日');
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

const RTF = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

/** “3 天前” / “刚刚”. Falls back to a date beyond a year. */
export function formatRelative(input: string | Date | null | undefined, now = Date.now()): string {
  if (!input) return '—';
  const d = toDate(input);
  if (!d) return '—';
  const diff = (d.getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 90) return '刚刚';
  for (const [unit, secs] of RELATIVE_UNITS) {
    if (abs >= secs) {
      return RTF.format(Math.round(diff / secs), unit);
    }
  }
  return formatDate(d);
}

/** ISO-ish date for <time dateTime>. */
export function toIsoDate(input: string | Date | null | undefined): string | undefined {
  const d = toDate(input);
  return d ? d.toISOString() : undefined;
}

function toDate(input: string | Date | null | undefined): Date | null {
  if (input === null || input === undefined) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Storage-safe slug for tags in URLs. */
export function slugifyTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, '-');
}

export function pluralCount(n: number, unit = ''): string {
  return unit ? `${n} ${unit}` : String(n);
}

/** Split a search string into lowercase tokens (AND semantics). */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，、]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function includesAll(haystack: string, needles: string[]): boolean {
  return needles.every((n) => haystack.includes(n));
}

/** Copy to clipboard with a legacy fallback for non-secure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea path */
  }
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
