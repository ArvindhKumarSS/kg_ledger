/** Ledger merge, dedup, and data operations */

import { extractMappingKey } from './classifier.js';
import { hashTxnId } from './utils.js';

function isApartmentCredit(txn) {
  return (
    (txn.txnType === 'credit' || txn.txnType === 'bulk_cash') &&
    txn.creditAmount &&
    txn.apartment
  );
}

/** Persist payer→apartment for normal credits; skip generic bulk-cash keys */
function shouldPersistMapping(txn) {
  return txn.txnType === 'credit' && Boolean(txn.mappingKey && txn.apartment);
}

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

function isPendingCreditCandidate(txn) {
  return txn.txnType === 'credit' || txn.txnType === 'bulk_cash';
}

/** Credits deferred for later tagging: explicitly skipped or still unmapped */
export function isDeferredCredit(txn) {
  return isPendingCreditCandidate(txn) && (txn.skip || !txn.apartment);
}

/**
 * Build durable pending-credit rows from a classified statement.
 * Skips anything already imported to a ledger (or already queued).
 */
export async function collectPendingCredits(classified, sourceUpload, fileName, existingIds, existingPendingIds) {
  const pending = [];
  const seen = new Set(existingPendingIds || []);

  for (const txn of classified) {
    if (!isDeferredCredit(txn)) continue;

    const txnId = await makeTxnId(txn);
    if (existingIds.has(txnId) || seen.has(txnId)) continue;
    seen.add(txnId);

    const apartment = txn.apartment || null;
    pending.push({
      txnId,
      date: txn.date,
      creditAmount: txn.creditAmount,
      details: txn.details,
      chequeNumber: txn.chequeNumber || '',
      mappingKey: txn.mappingKey || extractMappingKey(txn.details),
      txnType: txn.txnType,
      sourceUpload,
      fileName: fileName || '',
      // Explicit skip without an apartment stays "skipped"; tagged-but-deferred is ready later
      skipped: Boolean(txn.skip) && !apartment,
      apartment,
      needsReview: !apartment,
      addedAt: new Date().toISOString(),
    });
  }

  return pending;
}

/** Merge by txnId; newer rows win for metadata, preserve earlier addedAt when present */
export function mergePendingCredits(existing, incoming) {
  const byId = new Map();
  for (const row of existing || []) {
    if (row?.txnId) byId.set(row.txnId, row);
  }
  for (const row of incoming || []) {
    if (!row?.txnId) continue;
    const prev = byId.get(row.txnId);
    byId.set(row.txnId, {
      ...prev,
      ...row,
      addedAt: prev?.addedAt || row.addedAt || new Date().toISOString(),
    });
  }
  return [...byId.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.txnId || '').localeCompare(b.txnId || '');
  });
}

export function removePendingCredits(pending, txnIds) {
  const remove = new Set(txnIds || []);
  return (pending || []).filter((row) => !remove.has(row.txnId));
}

/** Apply known payer→apartment maps onto pending rows (in place for UI preview) */
export function suggestPendingApartments(pending, accounts, apartments) {
  const aptSet = new Set(apartments || []);
  return (pending || []).map((row) => {
    if (row.apartment) return row;
    const mapped = row.mappingKey ? accounts?.[row.mappingKey] : null;
    if (mapped && aptSet.has(mapped)) {
      return { ...row, apartment: mapped, needsReview: false, skipped: false };
    }
    return row;
  });
}

/** Pending rows that have an apartment chosen and are ready to import */
export function pendingReadyToImport(pending) {
  return (pending || []).filter(
    (row) => row.apartment && (row.txnType === 'credit' || row.txnType === 'bulk_cash')
  );
}

function rememberApartmentTag(txn, txnId, newMappings, relocations) {
  if (!isApartmentCredit(txn)) return;
  const mappingKey = txn.mappingKey || extractMappingKey(txn.details);
  if (shouldPersistMapping(txn)) {
    newMappings[txn.mappingKey] = txn.apartment;
  }
  // Exact txn placement (covers bulk cash and retags on re-upload)
  relocations.push({ txnId, apartment: txn.apartment, mappingKey });
}

export async function buildLedgerEntries(classified, sourceUpload, existingIds) {
  const newMappings = {};
  const ledgerUpdates = {};
  const relocations = [];
  const expenditures = [];
  const interest = [];
  const importedTxnIds = [];
  const skipped = [];

  for (const txn of classified) {
    if (txn.skip) continue;

    const txnId = await makeTxnId(txn);
    if (existingIds.has(txnId)) {
      skipped.push(txn);
      // Duplicates are not re-imported, but tags still update mappings + placement
      rememberApartmentTag(txn, txnId, newMappings, relocations);
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

    if (isApartmentCredit(txn)) {
      const mappingKey = txn.mappingKey || extractMappingKey(txn.details);
      if (!ledgerUpdates[txn.apartment]) ledgerUpdates[txn.apartment] = [];
      ledgerUpdates[txn.apartment].push({
        date: txn.date,
        creditAmount: txn.creditAmount,
        details: txn.details,
        sourceUpload,
        txnId,
        mappingKey,
      });
      if (shouldPersistMapping(txn)) {
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

  return {
    newMappings,
    ledgerUpdates,
    relocations,
    expenditures,
    interest,
    importedTxnIds,
    skipped,
  };
}

function entryMappingKey(row) {
  return row.mappingKey || extractMappingKey(row.details || '');
}

function sortLedgerRows(rows) {
  return [...rows].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.txnId || '').localeCompare(b.txnId || '');
  });
}

/**
 * Place specific transactions under the apartment chosen in review.
 * Used when re-uploading (dups) or for bulk cash that has no shared payer map.
 */
export function applyTxnRelocations(ledgers, relocations) {
  if (!relocations?.length) return ledgers;

  const byId = new Map();
  for (const move of relocations) {
    if (move?.txnId && move?.apartment) {
      byId.set(move.txnId, move);
    }
  }
  if (!byId.size) return ledgers;

  const next = {};
  for (const apt of Object.keys(ledgers || {})) next[apt] = [];

  for (const [apt, rows] of Object.entries(ledgers || {})) {
    for (const row of rows) {
      const move = row.txnId ? byId.get(row.txnId) : null;
      const target = move?.apartment || apt;
      if (!next[target]) next[target] = [];
      next[target].push(
        move
          ? {
              ...row,
              mappingKey: move.mappingKey || row.mappingKey || entryMappingKey(row),
            }
          : row
      );
    }
  }

  for (const apt of Object.keys(next)) {
    next[apt] = sortLedgerRows(next[apt]);
  }
  return next;
}

/**
 * Move existing apartment credits to match accounts.json mappings.
 * Applies to past rows (by mappingKey/details) so a new tag updates history.
 */
export function reapplyAccountMappings(ledgers, accounts, apartments = null) {
  const aptSet = apartments ? new Set(apartments) : null;
  const next = {};
  for (const apt of Object.keys(ledgers || {})) {
    next[apt] = [];
  }

  for (const [apt, rows] of Object.entries(ledgers || {})) {
    for (const row of rows) {
      const key = entryMappingKey(row);
      // Bulk cash is tagged per deposit — do not move via shared payer maps
      const bulkCash = /^BY CASH KG SRIVATSA/i.test(row.details || '');
      const mapped = !bulkCash && key ? accounts[key] : null;
      const target =
        mapped && (!aptSet || aptSet.has(mapped)) ? mapped : apt;

      if (!next[target]) next[target] = [];
      const stored = { ...row, mappingKey: key || row.mappingKey };
      next[target].push(stored);
    }
  }

  for (const apt of Object.keys(next)) {
    next[apt] = sortLedgerRows(next[apt]);
  }
  return next;
}

export function mergeData(existing, updates) {
  const merged = {
    config: { ...existing.config },
    accounts: { ...existing.accounts, ...updates.newMappings },
    expenditures: [...existing.expenditures, ...updates.expenditures],
    interest: [...existing.interest, ...updates.interest],
    accountBalance: existing.accountBalance,
    ledgers: { ...existing.ledgers },
    pendingCredits: [...(existing.pendingCredits || [])],
  };

  for (const [apt, rows] of Object.entries(updates.ledgerUpdates)) {
    merged.ledgers[apt] = [...(merged.ledgers[apt] || []), ...rows];
  }

  // Exact tags from this review (incl. bulk cash / retags on duplicate upload)
  merged.ledgers = applyTxnRelocations(merged.ledgers, updates.relocations || []);

  // Payer mappings update past + future for normal maintenance credits
  merged.ledgers = reapplyAccountMappings(
    merged.ledgers,
    merged.accounts,
    merged.config.apartments
  );

  if (updates.pendingCredits) {
    merged.pendingCredits = updates.pendingCredits;
  } else if (updates.importedTxnIds?.length) {
    // Anything just imported should leave the pending queue
    merged.pendingCredits = removePendingCredits(merged.pendingCredits, updates.importedTxnIds);
  }

  // Also drop pending rows that were tagged onto an already-imported duplicate
  if (updates.relocations?.length) {
    merged.pendingCredits = removePendingCredits(
      merged.pendingCredits,
      updates.relocations.map((r) => r.txnId)
    );
  }

  return merged;
}

export function buildCommitFiles(merged, uploadMeta) {
  const files = {
    'data/config.json': merged.config,
    'data/mappings/accounts.json': merged.accounts,
    'data/expenditures.json': merged.expenditures,
    'data/interest.json': merged.interest,
    'data/account-balance.json': merged.accountBalance,
    'data/pending-credits.json': merged.pendingCredits || [],
  };

  for (const [apt, rows] of Object.entries(merged.ledgers)) {
    files[`data/ledgers/${apt}.json`] = rows;
  }

  if (uploadMeta) {
    const uploadKey = uploadMeta.uploadId || uploadMeta.statementMonth;
    if (uploadKey) {
      files[`data/uploads/${uploadKey}.json`] = uploadMeta;
    }
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

/** Closing balance and last txn date from a parsed statement */
export function extractStatementSnapshot(transactions) {
  const withBalance = transactions.filter((t) => t.balance != null);
  if (!withBalance.length) return null;
  const last = withBalance[withBalance.length - 1];
  return {
    balance: last.balance,
    lastTransactionDate: last.date,
  };
}

/** Update stored balance only if this statement is at least as recent */
export function updateAccountBalance(current, snapshot, statementMonth) {
  if (!snapshot) return current || { balance: null, lastTransactionDate: null, statementMonth: null, updatedAt: null };
  const prev = current?.lastTransactionDate;
  if (!prev || snapshot.lastTransactionDate >= prev) {
    return {
      balance: snapshot.balance,
      lastTransactionDate: snapshot.lastTransactionDate,
      statementMonth,
      updatedAt: new Date().toISOString(),
    };
  }
  return current;
}

/**
 * All unique committed transactions for the read-only Transactions tab.
 * Includes apartment credits, expenditures, interest, and still-pending credits.
 */
export function collectAllTransactions(data) {
  const byId = new Map();

  for (const [apt, rows] of Object.entries(data?.ledgers || {})) {
    for (const row of rows || []) {
      if (!row?.txnId) continue;
      byId.set(row.txnId, {
        txnId: row.txnId,
        date: row.date,
        type: 'credit',
        creditAmount: row.creditAmount ?? null,
        debitAmount: null,
        details: row.details || '',
        apartment: apt,
        category: '',
        status: 'Mapped',
        sourceUpload: row.sourceUpload || '',
      });
    }
  }

  for (const row of data?.expenditures || []) {
    if (!row?.txnId) continue;
    byId.set(row.txnId, {
      txnId: row.txnId,
      date: row.date,
      type: 'debit',
      creditAmount: null,
      debitAmount: row.debitAmount ?? null,
      details: row.details || '',
      apartment: '',
      category: row.category || '',
      status: 'Imported',
      sourceUpload: row.sourceUpload || '',
    });
  }

  for (const row of data?.interest || []) {
    if (!row?.txnId) continue;
    byId.set(row.txnId, {
      txnId: row.txnId,
      date: row.date,
      type: 'interest',
      creditAmount: row.creditAmount ?? null,
      debitAmount: null,
      details: row.details || '',
      apartment: '',
      category: 'Interest',
      status: 'Interest',
      sourceUpload: row.sourceUpload || '',
    });
  }

  for (const row of data?.pendingCredits || []) {
    if (!row?.txnId || byId.has(row.txnId)) continue;
    byId.set(row.txnId, {
      txnId: row.txnId,
      date: row.date,
      type: row.txnType === 'bulk_cash' ? 'bulk_cash' : 'credit',
      creditAmount: row.creditAmount ?? null,
      debitAmount: null,
      details: row.details || '',
      apartment: row.apartment || '',
      category: '',
      status: row.apartment ? 'Pending (tagged)' : 'Pending',
      sourceUpload: row.sourceUpload || row.fileName || '',
    });
  }

  return [...byId.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const aAmt = a.creditAmount ?? a.debitAmount ?? 0;
    const bAmt = b.creditAmount ?? b.debitAmount ?? 0;
    if (aAmt !== bAmt) return aAmt - bAmt;
    return (a.txnId || '').localeCompare(b.txnId || '');
  });
}
