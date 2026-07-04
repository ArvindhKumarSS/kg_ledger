/** Shared utilities */

export function parseIndianAmount(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(/,/g, ''));
}

export function formatAmount(n) {
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function toIsoDate(ddMmYyyy) {
  const [d, m, y] = ddMmYyyy.split('-');
  return `${y}-${m}-${d}`;
}

export function formatDisplayDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

export function normalizeKey(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\w\s@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function hashTxnId(parts) {
  const text = parts.filter(Boolean).join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export function defaultApartments() {
  const apts = [];
  for (let f = 1; f <= 5; f++) {
    for (const u of 'ABCDEFG') {
      apts.push(`${f}${u}`);
    }
  }
  return apts;
}

export function previousMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const COOKIE_DAYS = 365;

function cookieAttrs() {
  const base = 'path=/;SameSite=Strict';
  return location.protocol === 'https:' ? `${base};Secure` : base;
}

export function setCookie(name, value, days = COOKIE_DAYS) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires};${cookieAttrs()}`;
}

export function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

export function deleteCookie(name) {
  document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;${cookieAttrs()}`;
}
