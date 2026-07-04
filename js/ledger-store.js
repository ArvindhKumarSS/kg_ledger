/** Ledger merge, dedup, and data operations */

import { hashTxnId } from './utils.js';

export async function makeTxnId(txn) {
  const amount = txn.creditAmount || txn.debitAmount || 0;
  return hashTxnId([txn.date, amount, txn.details, txn.chequeNumber || '']);
}

export function collectExistingTxnIds(data) {
  const ids = new Set();
  for (const rows of Object.values(data.ledgers || {})) {
    for (const r of rows) if (r.txnId) ids.add(r.txnId);
  }
  for (const r of data.expenditures || []) if (r.txnId) ids.add(r.txnId);
  for (const r of data.interest || []) if (r.txnId) ids.add(r.txnId);
  return ids;
}

export async function buildLedgerEntries(classified, sourceUpload, existingIds) {
  const newMappings = {};
  const ledgerUpdates = {};
  const expenditures = [];
  const interest = [];
  const importedTxnIds = [];
  const skipped = [];

  for (const txn of classified) {
    if (txn.skip) continue;

    const txnId = await makeTxnId(txn);
    if (existingIds.has(txnId)) {
      skipped.push(txn);
      continue;
    }

    if (txn.txnType === 'interest' && txn.creditAmount) {
      interest.push({
        date: txn.date,
        creditAmount: txn.creditAmount,
        details: txn.details,
        sourceUpload,
        txnId,
      });
      importedTxnIds.push(txnId);
      continue;
    }

    if (txn.txnType === 'credit' && txn.creditAmount && txn.apartment) {
      if (!ledgerUpdates[txn.apartment]) ledgerUpdates[txn.apartment] = [];
      ledgerUpdates[txn.apartment].push({
        date: txn.date,
        creditAmount: txn.creditAmount,
        details: txn.details,
        sourceUpload,
        txnId,
      });
      if (txn.mappingKey && txn.apartment) {
        newMappings[txn.mappingKey] = txn.apartment;
      }
      importedTxnIds.push(txnId);
      continue;
    }

    if (txn.txnType === 'debit' && txn.debitAmount) {
      expenditures.push({
        date: txn.date,
        debitAmount: txn.debitAmount,
        details: txn.details,
        category: txn.category || '',
        sourceUpload,
        txnId,
      });
      importedTxnIds.push(txnId);
    }
  }

  return { newMappings, ledgerUpdates, expenditures, interest, importedTxnIds, skipped };
}

export function mergeData(existing, updates) {
  const merged = {
    config: { ...existing.config },
    accounts: { ...existing.accounts, ...updates.newMappings },
    expenditures: [...existing.expenditures, ...updates.expenditures],
    interest: [...existing.interest, ...updates.interest],
    ledgers: { ...existing.ledgers },
  };

  for (const [apt, rows] of Object.entries(updates.ledgerUpdates)) {
    merged.ledgers[apt] = [...(merged.ledgers[apt] || []), ...rows];
  }

  return merged;
}

export function buildCommitFiles(merged, uploadMeta) {
  const files = {
    'data/config.json': merged.config,
    'data/mappings/accounts.json': merged.accounts,
    'data/expenditures.json': merged.expenditures,
    'data/interest.json': merged.interest,
  };

  for (const [apt, rows] of Object.entries(merged.ledgers)) {
    files[`data/ledgers/${apt}.json`] = rows;
  }

  if (uploadMeta) {
    files[`data/uploads/${uploadMeta.statementMonth}.json`] = uploadMeta;
  }

  return files;
}

export function canRemoveApartment(apt, ledgers) {
  const rows = ledgers[apt] || [];
  return rows.length === 0;
}

export function addApartment(config, ledgers, aptId) {
  const id = aptId.trim().toUpperCase();
  if (!id) throw new Error('Apartment ID required');
  if (config.apartments.includes(id)) throw new Error(`${id} already exists`);
  config.apartments.push(id);
  config.apartments.sort((a, b) => {
    const af = parseInt(a[0], 10);
    const bf = parseInt(b[0], 10);
    if (af !== bf) return af - bf;
    return a.slice(1).localeCompare(b.slice(1));
  });
  ledgers[id] = [];
  return id;
}

export function removeApartment(config, ledgers, aptId) {
  if (!canRemoveApartment(aptId, ledgers)) {
    throw new Error(`${aptId} has transactions and cannot be removed`);
  }
  config.apartments = config.apartments.filter((a) => a !== aptId);
  delete ledgers[aptId];
}
