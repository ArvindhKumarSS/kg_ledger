/** Account → apartment classification */

import { normalizeKey } from './utils.js';

const BANK_CHARGE_PATTERNS = [
  /^Charges for PORD/i,
  /^CHRGS-/i,
  /^Cheque book Issue/i,
  /^PCBHomeDelivery/i,
];

const INTEREST_PATTERN = /^Int\.Pd:/i;
const BULK_CASH_PATTERN = /^BY CASH KG SRIVATSA/i;

export function extractMappingKey(details) {
  const d = details.trim();

  const impsMatch = d.match(/^IMPS\/\d+\/([^/]+)\/([^/]+)\//i);
  if (impsMatch) return normalizeKey(`${impsMatch[1]} ${impsMatch[2]}`);

  const upiMatch = d.match(/^UPI\/\d+\/CR\/([^/]+)\//i);
  if (upiMatch) return normalizeKey(upiMatch[1]);

  const mbMatch = d.match(/^MB\/\d+\/[^/]+\/(.+)/i);
  if (mbMatch) return normalizeKey(mbMatch[1].replace(/\s+(Maint|Mntc).*$/i, ''));

  const neftMatch = d.match(/^NEFT-[^-]+-[^-]+-(.+?)(?:-\d{4})?$/i);
  if (neftMatch) return normalizeKey(neftMatch[1].replace(/-$/, ''));

  const byMatch = d.match(/^By\s+(.+)/i);
  if (byMatch) return normalizeKey(byMatch[1]);

  return normalizeKey(d.slice(0, 60));
}

export function extractApartmentHint(details, apartments) {
  const aptSet = new Set(apartments.map((a) => a.toUpperCase()));
  const patterns = [
    /Kgs?\s*(\d[A-G])\b/i,
    /\/(\d[A-G])\b(?:\s|$|ma|mai|maint|mt)/i,
    /\b(\d[A-G])\s*(?:ma|mai|maint|mt)\b/i,
    /\b(\d[A-G])\b\s*$/i,
    /\bP(\d[A-G])\b/i,
  ];

  for (const pat of patterns) {
    const m = details.match(pat);
    if (m) {
      const candidate = m[1].toUpperCase();
      if (aptSet.has(candidate)) return candidate;
      const withP = `P${candidate}`;
      if (aptSet.has(withP)) return withP;
    }
  }
  return null;
}

export function classifyTransaction(txn, accounts, apartments) {
  const result = {
    ...txn,
    mappingKey: extractMappingKey(txn.details),
    apartment: null,
    category: null,
    txnType: 'unknown',
    needsReview: false,
    skip: false,
  };

  if (txn.creditAmount) {
    if (INTEREST_PATTERN.test(txn.details)) {
      result.txnType = 'interest';
      return result;
    }
    if (BULK_CASH_PATTERN.test(txn.details)) {
      result.txnType = 'bulk_cash';
      result.needsReview = true;
      return result;
    }

    result.txnType = 'credit';
    const mapped = accounts[result.mappingKey];
    if (mapped && apartments.includes(mapped)) {
      result.apartment = mapped;
    } else {
      const hint = extractApartmentHint(txn.details, apartments);
      if (hint) {
        result.apartment = hint;
        result.needsReview = true;
      } else {
        result.needsReview = true;
      }
    }
    return result;
  }

  if (txn.debitAmount) {
    result.txnType = 'debit';
    if (BANK_CHARGE_PATTERNS.some((p) => p.test(txn.details))) {
      result.category = 'Bank Charges';
    } else if (/RHINO SENTINEL/i.test(txn.details)) {
      result.category = 'Security';
    } else if (/GENERATOR CARE/i.test(txn.details)) {
      result.category = 'Generator';
    } else if (/^TO CASH/i.test(txn.details)) {
      result.category = 'Salaries';
    }
    return result;
  }

  return result;
}

export function classifyAll(transactions, accounts, apartments) {
  return transactions.map((t) => classifyTransaction(t, accounts, apartments));
}
