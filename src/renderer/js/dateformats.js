/** Date pattern helpers shared by the import view and settings. */

export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';

export const DATE_FORMATS = [
  { value: 'YYYY-MM-DD', label: '2026-08-19' },
  { value: 'YYYY/MM/DD', label: '2026/08/19 — nested folders' },
  { value: 'YYYY/MM', label: '2026/08 — year/month folders' },
  { value: 'YYYY', label: '2026 — year folder' },
  { value: 'YYYYMMDD', label: '20260819' },
  { value: 'DD-MM-YYYY', label: '19-08-2026' },
  { value: 'MM-DD-YYYY', label: '08-19-2026' },
];

export function normalizeDateFormat(fmt) {
  const s = String(fmt ?? '').trim();
  if (!s || s.length > 48) return DEFAULT_DATE_FORMAT;
  if (!/(YYYY|YY|MM|DD)/.test(s)) return DEFAULT_DATE_FORMAT;
  if (/[<>:"|?*\u0000-\u001f]/.test(s)) return DEFAULT_DATE_FORMAT;
  return s;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function formatDatePattern(date, fmt) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const norm = normalizeDateFormat(fmt);
  return norm
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/YY/g, String(d.getFullYear()).slice(-2))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/DD/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

export function isKnownDateFormat(fmt) {
  return DATE_FORMATS.some((f) => f.value === fmt);
}
