import { parsePdfFile } from './pdf-parser.js';
import { classifyAll } from './classifier.js';
import { GitHubClient, loadAllData } from './github-api.js';
import {
  collectExistingTxnIds,
  buildLedgerEntries,
  mergeData,
  buildCommitFiles,
  addApartment,
  removeApartment,
  canRemoveApartment,
  extractStatementSnapshot,
  updateAccountBalance,
  collectPendingCredits,
  mergePendingCredits,
  removePendingCredits,
  suggestPendingApartments,
  pendingReadyToImport,
  collectAllTransactions,
  applyTagCorrections,
} from './ledger-store.js';
import { formatAmount, formatDisplayDate, escapeHtml, getCookie, setCookie } from './utils.js';

const COOKIE_OWNER = 'kg_gh_owner';
const COOKIE_REPO = 'kg_gh_repo';
const COOKIE_TOKEN = 'kg_gh_token';

// pdf.js from CDN
const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

const state = {
  data: null,
  classified: [],
  parseWarnings: [],
  fileName: '',
  /** Unsaved Transactions-tab edits: txnId → { apartment?, category?, origin, type, mappingKey, details } */
  txnEdits: new Map(),
};

function $(sel) {
  return document.querySelector(sel);
}

function loadSettings() {
  return {
    owner: getCookie(COOKIE_OWNER) || '',
    repo: getCookie(COOKIE_REPO) || 'kg_ledger',
    token: getCookie(COOKIE_TOKEN) || '',
  };
}

function saveSettings(owner, repo, tokenInput) {
  const existing = loadSettings();
  const token = tokenInput || existing.token;
  if (!owner || !repo) throw new Error('GitHub username and repository are required');
  if (!token) throw new Error('Personal Access Token is required');
  setCookie(COOKIE_OWNER, owner);
  setCookie(COOKIE_REPO, repo);
  setCookie(COOKIE_TOKEN, token);
}

function hasGitHubSettings() {
  const s = loadSettings();
  return Boolean(s.token && s.owner && s.repo);
}

function ensureGitHubSettings() {
  if (hasGitHubSettings()) return true;
  switchTab('settings');
  $('#settings-status').innerHTML =
    '<span class="alert alert-warn" style="display:inline-block;margin-top:0.5rem">Enter GitHub username, repository, and PAT below before saving.</span>';
  $('#gh-token').focus();
  alert('Please configure GitHub settings (username, repository, and PAT) before saving to GitHub.');
  return false;
}

function getBaseUrl() {
  const { origin, pathname } = window.location;
  // Always resolve the project root, even if opened as /repo or /repo/index.html
  let path = pathname;
  if (path.endsWith('/index.html')) path = path.slice(0, -'index.html'.length);
  if (!path.endsWith('/')) path += '/';
  return origin + path;
}

function ghClient() {
  const s = loadSettings();
  if (!s.token || !s.owner || !s.repo) throw new Error('Configure GitHub settings first');
  return new GitHubClient(s.token, s.owner, s.repo);
}

/** Prefer GitHub API (authoritative). Pages CDN is cache-busted fallback only. */
async function fetchLatestData({ requireApi = false } = {}) {
  if (hasGitHubSettings()) {
    try {
      return await ghClient().loadAllData('main');
    } catch (err) {
      if (requireApi) throw err;
      console.warn('GitHub API load failed; falling back to Pages', err);
    }
  } else if (requireApi) {
    throw new Error('GitHub settings required to load authoritative data');
  }
  return loadAllData(getBaseUrl());
}

function applyLoadedData(data, { keepTxnEdits = false } = {}) {
  state.data = data;
  if (!keepTxnEdits) state.txnEdits = new Map();
  if (!Array.isArray(state.data.pendingCredits)) state.data.pendingCredits = [];
  state.data.pendingCredits = suggestPendingApartments(
    state.data.pendingCredits,
    state.data.accounts,
    state.data.config.apartments
  );
  document.getElementById('complex-name').textContent =
    `${state.data.config.complexName} — Maintenance Ledger`;
  renderAccountBalance();
  renderPendingCredits();
  renderSettingsTags();
  renderBrowseApartments();
  if ($('#panel-transactions')?.classList.contains('active')) renderTransactions();
}

async function reloadData({ requireApi = false } = {}) {
  const data = await fetchLatestData({ requireApi });
  applyLoadedData(data);
  return data;
}

/** Refresh from git before any write so stale Pages cache cannot overwrite real data */
async function refreshBeforeWrite() {
  await reloadData({ requireApi: true });
}

function renderAccountBalance() {
  const bal = state.data?.accountBalance;
  const amountEl = $('#balance-amount');
  const footprintEl = $('#balance-footprint');

  if (bal?.balance == null) {
    amountEl.textContent = '—';
    footprintEl.textContent = 'No statement uploaded yet';
    return;
  }

  amountEl.textContent = `₹ ${formatAmount(bal.balance)} Cr`;
  const asOf = bal.lastTransactionDate ? `As of ${formatDisplayDate(bal.lastTransactionDate)}` : '';
  const src = state.data?.source === 'github-api' ? ' · live from GitHub' : '';
  footprintEl.textContent = `${asOf}${src}`.trim();
}

function pendingRows() {
  return state.data?.pendingCredits || [];
}

function renderPendingCredits() {
  const rows = pendingRows();
  const section = $('#pending-section');
  if (!rows.length) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  const ready = pendingReadyToImport(rows);
  const untagged = rows.filter((r) => !r.apartment || r.skipped);

  $('#pending-summary').innerHTML = `
    <div class="summary-card"><div class="num">${rows.length}</div><div class="lbl">Pending</div></div>
    <div class="summary-card"><div class="num">${untagged.length}</div><div class="lbl">Still untagged</div></div>
    <div class="summary-card"><div class="num">${ready.length}</div><div class="lbl">Ready to commit</div></div>
  `;

  $('#pending-table tbody').innerHTML = rows
    .map((t, idx) => {
      const status = t.apartment
        ? '<span class="badge badge-ok">Ready</span>'
        : t.skipped
          ? '<span class="badge badge-info">Skipped</span>'
          : '<span class="badge badge-warn">Unmapped</span>';
      const source = t.fileName || t.sourceUpload || '—';
      return `<tr data-pending-idx="${idx}">
        <td>${formatDisplayDate(t.date)}</td>
        <td class="amount">${formatAmount(t.creditAmount)}</td>
        <td>${escapeHtml(t.details)}</td>
        <td>${escapeHtml(source)}</td>
        <td><select class="inline-select pending-apt-select" data-idx="${idx}">${aptOptions(t.apartment || '')}</select></td>
        <td>
          ${status}
          <label><input type="checkbox" class="pending-dismiss-check" data-idx="${idx}"> Dismiss</label>
        </td>
      </tr>`;
    })
    .join('');

  document.querySelectorAll('.pending-apt-select').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const idx = +e.target.dataset.idx;
      const apt = e.target.value || null;
      state.data.pendingCredits[idx].apartment = apt;
      state.data.pendingCredits[idx].needsReview = !apt;
      state.data.pendingCredits[idx].skipped = !apt;
      renderPendingCredits();
    });
  });
}

function aptOptions(selected = '', { allowEmpty = true } = {}) {
  const apts = state.data?.config?.apartments || [];
  return (
    (allowEmpty ? `<option value="">—</option>` : '') +
    apts.map((a) => `<option value="${a}"${a === selected ? ' selected' : ''}>${a}</option>`).join('')
  );
}

function catOptions(selected = '') {
  const cats = ['', ...(state.data?.config?.expenseCategories || [])];
  return cats
    .map((c) => `<option value="${escapeHtml(c)}"${c === selected ? ' selected' : ''}>${c || '—'}</option>`)
    .join('');
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
  document.getElementById(`panel-${tab}`).classList.add('active');
  if (tab === 'browse') renderBrowse();
  if (tab === 'transactions') renderTransactions();
}

function txnEffectiveRow(row) {
  const edit = state.txnEdits.get(row.txnId);
  if (!edit) return row;
  return {
    ...row,
    apartment: edit.apartment !== undefined ? edit.apartment : row.apartment,
    category: edit.category !== undefined ? edit.category : row.category,
  };
}

function isTxnDirty(row) {
  const edit = state.txnEdits.get(row.txnId);
  if (!edit) return false;
  if (row.origin === 'expenditure') {
    return (edit.category || '') !== (row.category || '');
  }
  if (row.origin === 'ledger' || row.origin === 'pending') {
    return (edit.apartment || '') !== (row.apartment || '');
  }
  return false;
}

function updateTxnSaveButton() {
  const dirtyCount = [...state.txnEdits.keys()].filter((id) => {
    const base = collectAllTransactions(state.data || {}).find((r) => r.txnId === id);
    return base && isTxnDirty(base);
  }).length;
  const btn = $('#save-txn-tags-btn');
  if (btn) {
    btn.disabled = dirtyCount === 0;
    btn.textContent =
      dirtyCount > 0 ? `Save tag corrections (${dirtyCount})` : 'Save tag corrections';
  }
}

function setTxnEdit(row, patch) {
  const prev = state.txnEdits.get(row.txnId) || {
    txnId: row.txnId,
    origin: row.origin,
    type: row.type,
    mappingKey: row.mappingKey,
    details: row.details,
    apartment: row.apartment || '',
    category: row.category || '',
  };
  const next = { ...prev, ...patch };
  const baselineApt = row.apartment || '';
  const baselineCat = row.category || '';
  const aptChanged =
    (row.origin === 'ledger' || row.origin === 'pending') &&
    (next.apartment || '') !== baselineApt;
  const catChanged = row.origin === 'expenditure' && (next.category || '') !== baselineCat;
  if (aptChanged || catChanged) {
    state.txnEdits.set(row.txnId, next);
  } else {
    state.txnEdits.delete(row.txnId);
  }
  updateTxnSaveButton();
}

function renderTransactions() {
  const tbody = $('#txn-tbody');
  const summary = $('#txn-summary');
  if (!tbody || !summary) return;

  const rows = collectAllTransactions(state.data || {});
  const filter = ($('#txn-filter')?.value || 'all').toLowerCase();
  const filtered =
    filter === 'all'
      ? rows
      : rows.filter((r) => {
          if (filter === 'credit') return r.type === 'credit' || r.type === 'bulk_cash';
          if (filter === 'debit') return r.type === 'debit';
          if (filter === 'interest') return r.type === 'interest';
          if (filter === 'pending') return String(r.status).startsWith('Pending');
          if (filter === 'edited') return isTxnDirty(r);
          return true;
        });

  const credits = filtered.filter((r) => r.creditAmount != null);
  const debits = filtered.filter((r) => r.debitAmount != null);
  const creditTotal = credits.reduce((s, r) => s + (r.creditAmount || 0), 0);
  const debitTotal = debits.reduce((s, r) => s + (r.debitAmount || 0), 0);
  const dirtyCount = rows.filter((r) => isTxnDirty(r)).length;

  summary.textContent =
    `${filtered.length} transaction(s)` +
    (credits.length ? ` · credits ₹${formatAmount(creditTotal)}` : '') +
    (debits.length ? ` · debits ₹${formatAmount(debitTotal)}` : '') +
    (dirtyCount ? ` · ${dirtyCount} unsaved correction(s)` : '');

  updateTxnSaveButton();

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7">No committed transactions yet</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .map((r) => {
      const view = txnEffectiveRow(r);
      const dirty = isTxnDirty(r);
      const amount =
        view.debitAmount != null
          ? `− ${formatAmount(view.debitAmount)}`
          : formatAmount(view.creditAmount || 0);

      let tagCell;
      if (r.origin === 'expenditure') {
        tagCell = `<select class="inline-select txn-cat-select" data-txn-id="${escapeHtml(r.txnId)}">${catOptions(view.category || '')}</select>`;
      } else if (r.origin === 'ledger') {
        // Already-mapped credits must keep an apartment; change to correct unit
        tagCell = `<select class="inline-select txn-apt-select" data-txn-id="${escapeHtml(r.txnId)}">${aptOptions(view.apartment || '', { allowEmpty: false })}</select>`;
      } else if (r.origin === 'pending') {
        tagCell = `<select class="inline-select txn-apt-select" data-txn-id="${escapeHtml(r.txnId)}">${aptOptions(view.apartment || '')}</select>`;
      } else {
        tagCell = 'Interest';
      }

      const statusLabel = dirty ? `${r.status} · edited` : r.status;
      const badgeClass = dirty
        ? 'badge-warn'
        : String(r.status).startsWith('Pending')
          ? 'badge-warn'
          : r.type === 'debit'
            ? 'badge-info'
            : 'badge-ok';
      return `<tr class="${dirty ? 'txn-dirty' : ''}" data-txn-id="${escapeHtml(r.txnId)}">
        <td>${formatDisplayDate(r.date)}</td>
        <td>${escapeHtml(r.type)}</td>
        <td class="amount">${amount}</td>
        <td>${escapeHtml(r.details)}</td>
        <td>${tagCell}</td>
        <td><span class="badge ${badgeClass}">${escapeHtml(statusLabel)}</span></td>
        <td>${escapeHtml(r.sourceUpload || '—')}</td>
      </tr>`;
    })
    .join('');

  const byId = new Map(rows.map((r) => [r.txnId, r]));

  document.querySelectorAll('.txn-apt-select').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const row = byId.get(e.target.dataset.txnId);
      if (!row) return;
      setTxnEdit(row, { apartment: e.target.value || '' });
      renderTransactions();
    });
  });

  document.querySelectorAll('.txn-cat-select').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const row = byId.get(e.target.dataset.txnId);
      if (!row) return;
      setTxnEdit(row, { category: e.target.value || '' });
      renderTransactions();
    });
  });
}

async function handleSaveTxnTags() {
  if (!ensureGitHubSettings()) return;

  const baseRows = collectAllTransactions(state.data || {});
  const byId = new Map(baseRows.map((r) => [r.txnId, r]));
  const corrections = [];
  for (const [txnId, edit] of state.txnEdits) {
    const base = byId.get(txnId);
    if (!base || !isTxnDirty(base)) continue;
    corrections.push({
      txnId,
      origin: base.origin,
      type: base.type,
      mappingKey: base.mappingKey,
      details: base.details,
      apartment: edit.apartment !== undefined ? edit.apartment || null : base.apartment || null,
      category: edit.category !== undefined ? edit.category || '' : base.category || '',
    });
  }

  if (!corrections.length) {
    alert('No tag corrections to save.');
    return;
  }

  const creditMoves = corrections.filter((c) => c.origin === 'ledger').length;
  const pendingEdits = corrections.filter((c) => c.origin === 'pending').length;
  const debitEdits = corrections.filter((c) => c.origin === 'expenditure').length;
  const msg =
    `Save ${corrections.length} correction(s)?` +
    (creditMoves ? `\n• ${creditMoves} mapped credit(s) will move apartment (and update payer mapping)` : '') +
    (pendingEdits ? `\n• ${pendingEdits} pending credit(s)` : '') +
    (debitEdits ? `\n• ${debitEdits} debit categor${debitEdits === 1 ? 'y' : 'ies'}` : '');
  if (!confirm(msg)) return;

  const btn = $('#save-txn-tags-btn');
  const status = $('#txn-save-status');
  btn.disabled = true;
  status.textContent = 'Saving…';

  try {
    const pendingEditsById = new Map(
      corrections.filter((c) => c.origin === 'pending').map((c) => [c.txnId, c])
    );
    await refreshBeforeWrite();

    // Re-resolve corrections against fresh git data
    const freshRows = collectAllTransactions(state.data || {});
    const freshById = new Map(freshRows.map((r) => [r.txnId, r]));
    const freshCorrections = [];
    for (const edit of corrections) {
      const fresh = freshById.get(edit.txnId);
      if (!fresh) continue;
      if (edit.origin === 'ledger' || edit.origin === 'pending') {
        if ((edit.apartment || '') === (fresh.apartment || '')) continue;
        freshCorrections.push({
          ...edit,
          origin: fresh.origin,
          type: fresh.type,
          mappingKey: fresh.mappingKey,
          details: fresh.details,
        });
      } else if (edit.origin === 'expenditure') {
        if ((edit.category || '') === (fresh.category || '')) continue;
        freshCorrections.push({ ...edit, origin: fresh.origin });
      }
    }

    // Pending apartment choices from UI may not be on git yet
    for (const [txnId, edit] of pendingEditsById) {
      if (freshCorrections.some((c) => c.txnId === txnId)) continue;
      const fresh = freshById.get(txnId);
      if (!fresh || fresh.origin !== 'pending') continue;
      if ((edit.apartment || '') === (fresh.apartment || '')) continue;
      freshCorrections.push({
        txnId,
        origin: 'pending',
        type: fresh.type,
        mappingKey: fresh.mappingKey,
        details: fresh.details,
        apartment: edit.apartment || null,
        category: '',
      });
    }

    if (!freshCorrections.length) {
      state.txnEdits = new Map();
      status.textContent = 'Already up to date';
      renderTransactions();
      return;
    }

    const merged = applyTagCorrections(state.data, freshCorrections);
    const files = buildCommitFiles({ ...merged, source: undefined }, null);
    const client = ghClient();
    const sha = await client.commitFiles(
      `Correct tags on ${freshCorrections.length} transaction(s)`,
      files
    );

    state.txnEdits = new Map();
    applyLoadedData({ ...merged, source: 'github-api' }, { keepTxnEdits: false });
    renderTransactions();
    status.textContent = `Saved (${sha.slice(0, 7)})`;
    alert(`Saved ${freshCorrections.length} tag correction(s).`);
  } catch (err) {
    status.textContent = '';
    alert(`Save failed: ${err.message}`);
  } finally {
    updateTxnSaveButton();
  }
}

function renderSummary(classified) {
  const credits = classified.filter((t) => t.txnType === 'credit');
  const debits = classified.filter((t) => t.txnType === 'debit');
  const interest = classified.filter((t) => t.txnType === 'interest');
  const unmapped = credits.filter((t) => !t.apartment || t.needsReview);
  const mapped = credits.filter((t) => t.apartment && !t.needsReview);

  $('#summary-grid').innerHTML = `
    <div class="summary-card"><div class="num">${credits.length}</div><div class="lbl">Credits</div></div>
    <div class="summary-card"><div class="num">${mapped.length}</div><div class="lbl">Auto-mapped</div></div>
    <div class="summary-card"><div class="num">${unmapped.length}</div><div class="lbl">Need review</div></div>
    <div class="summary-card"><div class="num">${debits.length}</div><div class="lbl">Debits</div></div>
    <div class="summary-card"><div class="num">${interest.length}</div><div class="lbl">Interest</div></div>
  `;
}

function renderReviewTables(classified) {
  const credits = classified.filter((t) => t.txnType === 'credit' || t.txnType === 'bulk_cash');
  const debits = classified.filter((t) => t.txnType === 'debit');
  const interest = classified.filter((t) => t.txnType === 'interest');

  $('#credits-table tbody').innerHTML = credits
    .map((t, i) => {
      const idx = classified.indexOf(t);
      const status = !t.apartment
        ? '<span class="badge badge-warn">Unmapped</span>'
        : t.needsReview
          ? '<span class="badge badge-warn">Review</span>'
          : '<span class="badge badge-ok">Mapped</span>';
      return `<tr data-idx="${idx}">
        <td>${formatDisplayDate(t.date)}</td>
        <td class="amount">${formatAmount(t.creditAmount)}</td>
        <td>${escapeHtml(t.details)}</td>
        <td><select class="inline-select apt-select" data-idx="${idx}">${aptOptions(t.apartment || '')}</select></td>
        <td>${status} <label><input type="checkbox" class="skip-check" data-idx="${idx}" ${t.skip ? 'checked' : ''}> Skip</label></td>
      </tr>`;
    })
    .join('');

  $('#debits-table tbody').innerHTML = debits
    .map((t) => {
      const idx = classified.indexOf(t);
      return `<tr>
        <td>${formatDisplayDate(t.date)}</td>
        <td class="amount">${formatAmount(t.debitAmount)}</td>
        <td>${escapeHtml(t.details)}</td>
        <td><select class="inline-select cat-select" data-idx="${idx}">${catOptions(t.category || '')}</select></td>
      </tr>`;
    })
    .join('');

  $('#interest-table tbody').innerHTML = interest
    .map(
      (t) => `<tr>
      <td>${formatDisplayDate(t.date)}</td>
      <td class="amount">${formatAmount(t.creditAmount)}</td>
      <td>${escapeHtml(t.details)}</td>
    </tr>`
    )
    .join('');

  document.querySelectorAll('.apt-select').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const idx = +e.target.dataset.idx;
      state.classified[idx].apartment = e.target.value || null;
      state.classified[idx].needsReview = false;
      if (e.target.value) state.classified[idx].skip = false;
      renderSummary(state.classified);
      renderReviewTables(state.classified);
    });
  });

  document.querySelectorAll('.cat-select').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      state.classified[+e.target.dataset.idx].category = e.target.value;
    });
  });

  document.querySelectorAll('.skip-check').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const idx = +e.target.dataset.idx;
      state.classified[idx].skip = e.target.checked;
      renderSummary(state.classified);
    });
  });
}

async function handlePdf(file) {
  $('#parse-status').innerHTML = '<div class="alert alert-info">Parsing PDF…</div>';
  state.fileName = file.name;

  try {
    const { transactions, parseWarnings } = await parsePdfFile(file, pdfjsLib);
    state.parseWarnings = parseWarnings;
    state.classified = classifyAll(
      transactions,
      state.data.accounts,
      state.data.config.apartments
    );

    if (parseWarnings.length) {
      $('#warnings-box').classList.remove('hidden');
      $('#warnings-list').innerHTML = parseWarnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('');
    } else {
      $('#warnings-box').classList.add('hidden');
    }

    $('#parse-status').innerHTML = `<div class="alert alert-success">Parsed ${transactions.length} transactions from ${escapeHtml(file.name)}</div>`;
    $('#review-section').classList.remove('hidden');
    renderSummary(state.classified);
    renderReviewTables(state.classified);
  } catch (err) {
    $('#parse-status').innerHTML = `<div class="alert alert-error">Parse error: ${escapeHtml(err.message)}</div>`;
  }
}

function buildUploadId(month) {
  if (month) return month;
  // Ad-hoc uploads: unique id so re-uploads never clobber prior audit files
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function handleCommit() {
  if (!ensureGitHubSettings()) return;

  if (!state.classified.length) {
    alert('Parse a statement before committing');
    return;
  }

  const month = $('#statement-month').value || '';
  const uploadId = buildUploadId(month);
  const sourceUpload = month || uploadId;

  const deferred = state.classified.filter(
    (t) => (t.txnType === 'credit' || t.txnType === 'bulk_cash') && (t.skip || !t.apartment)
  );
  if (deferred.length) {
    if (
      !confirm(
        `${deferred.length} credit(s) are untagged or skipped and will be saved to Pending for later tagging. Continue?`
      )
    ) {
      return;
    }
  }

  $('#commit-btn').disabled = true;
  $('#commit-status').textContent = 'Committing…';

  try {
    // Always merge against live git — never against a stale Pages-cached snapshot
    const uiPending = [...(state.data.pendingCredits || [])];
    await refreshBeforeWrite();
    if (uiPending.length) {
      const uiById = new Map(uiPending.map((r) => [r.txnId, r]));
      state.data.pendingCredits = (state.data.pendingCredits || []).map((row) => {
        const ui = uiById.get(row.txnId);
        if (!ui?.apartment) return row;
        return {
          ...row,
          apartment: ui.apartment,
          skipped: false,
          needsReview: false,
        };
      });
    }

    const existingIds = collectExistingTxnIds(state.data);
    const updates = await buildLedgerEntries(state.classified, sourceUpload, existingIds);

    const existingPendingIds = new Set((state.data.pendingCredits || []).map((r) => r.txnId));
    const newPending = await collectPendingCredits(
      state.classified,
      sourceUpload,
      state.fileName,
      existingIds,
      existingPendingIds
    );
    let pendingCredits = mergePendingCredits(state.data.pendingCredits || [], newPending);
    // Drop anything imported or relocated in this commit
    pendingCredits = removePendingCredits(pendingCredits, [
      ...updates.importedTxnIds,
      ...(updates.relocations || []).map((r) => r.txnId),
    ]);
    updates.pendingCredits = pendingCredits;

    const merged = mergeData(state.data, updates);

    const snapshot = extractStatementSnapshot(state.classified);
    merged.accountBalance = updateAccountBalance(
      state.data.accountBalance,
      snapshot,
      month || sourceUpload
    );

    const uploadMeta = {
      uploadedAt: new Date().toISOString(),
      uploadId,
      statementMonth: month || null,
      fileName: state.fileName,
      transactionCount: updates.importedTxnIds.length,
      importedTxnIds: updates.importedTxnIds,
      skippedDuplicates: updates.skipped.length,
      pendingCreditsAdded: newPending.length,
      pendingCreditsTotal: pendingCredits.length,
    };

    const files = buildCommitFiles(merged, uploadMeta);
    const client = ghClient();
    const label = month || state.fileName || uploadId;
    const sha = await client.commitFiles(`Import statement ${label}`, files);

    state.data = { ...merged, source: 'github-api' };
    renderAccountBalance();
    renderPendingCredits();
    renderTransactions();
    $('#commit-status').textContent = `Committed (${sha.slice(0, 7)})`;
    const dupNote = updates.skipped.length
      ? ` ${updates.skipped.length} duplicate(s) ignored.`
      : '';
    const pendingNote = newPending.length
      ? ` ${newPending.length} credit(s) saved to Pending.`
      : '';
    alert(
      `Successfully imported ${updates.importedTxnIds.length} transactions.${dupNote}${pendingNote}`
    );
  } catch (err) {
    $('#commit-status').textContent = '';
    alert(`Commit failed: ${err.message}`);
  } finally {
    $('#commit-btn').disabled = false;
  }
}

async function handleCommitPending() {
  if (!ensureGitHubSettings()) return;

  // Capture UI tags first — refresh replaces pending rows from git
  const uiPending = [...(state.data.pendingCredits || [])];
  const readyFromUi = pendingReadyToImport(uiPending);
  if (!readyFromUi.length) {
    alert('Tag at least one pending credit with an apartment before committing.');
    return;
  }

  if (!confirm(`Import ${readyFromUi.length} tagged pending credit(s) to apartment ledgers?`)) return;

  $('#commit-pending-btn').disabled = true;
  $('#dismiss-pending-btn').disabled = true;
  $('#pending-commit-status').textContent = 'Committing…';

  try {
    await refreshBeforeWrite();

    // Re-apply apartment choices from the UI onto the fresh git pending list
    const uiById = new Map(uiPending.map((r) => [r.txnId, r]));
    state.data.pendingCredits = (state.data.pendingCredits || []).map((row) => {
      const ui = uiById.get(row.txnId);
      if (!ui) return row;
      return {
        ...row,
        apartment: ui.apartment || row.apartment,
        skipped: ui.apartment ? false : row.skipped,
        needsReview: !ui.apartment,
      };
    });

    const ready = pendingReadyToImport(state.data.pendingCredits || []);
    if (!ready.length) {
      alert('No tagged pending credits found after refresh. Tag again and retry.');
      return;
    }

    const existingIds = collectExistingTxnIds(state.data);
    // Reuse ledger import path; sourceUpload kept from original statement
    const classified = ready.map((row) => ({
      ...row,
      skip: false,
      needsReview: false,
      debitAmount: null,
    }));

    // Group by sourceUpload so audit trails stay meaningful
    const bySource = new Map();
    for (const txn of classified) {
      const key = txn.sourceUpload || 'pending';
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key).push(txn);
    }

    let working = { ...state.data, pendingCredits: [...(state.data.pendingCredits || [])] };
    let importedTotal = 0;
    let dupTotal = 0;

    for (const [sourceUpload, txns] of bySource) {
      const updates = await buildLedgerEntries(txns, sourceUpload, existingIds);
      for (const id of updates.importedTxnIds) existingIds.add(id);
      importedTotal += updates.importedTxnIds.length;
      dupTotal += updates.skipped.length;
      updates.pendingCredits = removePendingCredits(working.pendingCredits, [
        ...updates.importedTxnIds,
        ...(updates.relocations || []).map((r) => r.txnId),
        ...txns.map((t) => t.txnId),
      ]);
      working = mergeData(working, updates);
    }

    const files = buildCommitFiles(working, null);
    const client = ghClient();
    const sha = await client.commitFiles(
      `Import ${importedTotal} pending credit(s)`,
      files
    );

    state.data = { ...working, source: 'github-api' };
    renderAccountBalance();
    renderPendingCredits();
    renderTransactions();
    $('#pending-commit-status').textContent = `Committed (${sha.slice(0, 7)})`;
    const dupNote = dupTotal ? ` ${dupTotal} already in ledgers (tags updated).` : '';
    alert(`Imported ${importedTotal} pending credit(s).${dupNote}`);
  } catch (err) {
    $('#pending-commit-status').textContent = '';
    alert(`Commit failed: ${err.message}`);
  } finally {
    $('#commit-pending-btn').disabled = false;
    $('#dismiss-pending-btn').disabled = false;
  }
}

async function handleDismissPending() {
  if (!ensureGitHubSettings()) return;

  const checks = [...document.querySelectorAll('.pending-dismiss-check:checked')];
  if (!checks.length) {
    alert('Select one or more pending credits with Dismiss, then try again.');
    return;
  }

  const ids = checks.map((cb) => state.data.pendingCredits[+cb.dataset.idx]?.txnId).filter(Boolean);
  if (!confirm(`Permanently remove ${ids.length} pending credit(s) without importing?`)) return;

  $('#commit-pending-btn').disabled = true;
  $('#dismiss-pending-btn').disabled = true;
  $('#pending-commit-status').textContent = 'Saving…';

  try {
    await refreshBeforeWrite();
    const pendingCredits = removePendingCredits(state.data.pendingCredits || [], ids);
    const merged = { ...state.data, pendingCredits, source: 'github-api' };
    const files = {
      'data/pending-credits.json': pendingCredits,
    };
    const client = ghClient();
    const sha = await client.commitFiles(`Dismiss ${ids.length} pending credit(s)`, files);
    state.data = merged;
    renderPendingCredits();
    renderTransactions();
    $('#pending-commit-status').textContent = `Saved (${sha.slice(0, 7)})`;
  } catch (err) {
    $('#pending-commit-status').textContent = '';
    alert(`Dismiss failed: ${err.message}`);
  } finally {
    $('#commit-pending-btn').disabled = false;
    $('#dismiss-pending-btn').disabled = false;
  }
}

function renderBrowseApartments() {
  const sel = $('#browse-apartment');
  sel.innerHTML = (state.data?.config?.apartments || [])
    .map((a) => `<option value="${a}">${a}</option>`)
    .join('');
}

function renderBrowse() {
  const view = $('#browse-view').value;
  const thead = $('#browse-thead');
  const tbody = $('#browse-tbody');
  $('#apt-select-label').classList.toggle('hidden', view !== 'apartment');

  if (view === 'apartment') {
    const apt = $('#browse-apartment').value;
    const rows = state.data?.ledgers?.[apt] || [];
    thead.innerHTML = '<tr><th>Date</th><th>Credit amount</th><th>Transaction details</th></tr>';
    tbody.innerHTML =
      rows.length === 0
        ? '<tr><td colspan="3">No transactions yet</td></tr>'
        : rows
            .map(
              (r) => `<tr>
          <td>${formatDisplayDate(r.date)}</td>
          <td class="amount">${formatAmount(r.creditAmount)}</td>
          <td>${escapeHtml(r.details)}</td>
        </tr>`
            )
            .join('');
    const total = rows.reduce((s, r) => s + r.creditAmount, 0);
    $('#browse-summary').textContent = `${apt}: ${rows.length} payments, total ₹${formatAmount(total)}`;
  } else if (view === 'expenditures') {
    const rows = state.data?.expenditures || [];
    thead.innerHTML = '<tr><th>Date</th><th>Debit amount</th><th>Details</th><th>Category</th></tr>';
    tbody.innerHTML =
      rows.length === 0
        ? '<tr><td colspan="4">No expenditures yet</td></tr>'
        : rows
            .map(
              (r) => `<tr>
          <td>${formatDisplayDate(r.date)}</td>
          <td class="amount">${formatAmount(r.debitAmount)}</td>
          <td>${escapeHtml(r.details)}</td>
          <td>${escapeHtml(r.category || '')}</td>
        </tr>`
            )
            .join('');
    const total = rows.reduce((s, r) => s + r.debitAmount, 0);
    $('#browse-summary').textContent = `${rows.length} expenditures, total ₹${formatAmount(total)}`;
  } else {
    const rows = state.data?.interest || [];
    thead.innerHTML = '<tr><th>Date</th><th>Amount</th><th>Details</th></tr>';
    tbody.innerHTML =
      rows.length === 0
        ? '<tr><td colspan="3">No interest credits yet</td></tr>'
        : rows
            .map(
              (r) => `<tr>
          <td>${formatDisplayDate(r.date)}</td>
          <td class="amount">${formatAmount(r.creditAmount)}</td>
          <td>${escapeHtml(r.details)}</td>
        </tr>`
            )
            .join('');
    $('#browse-summary').textContent = `${rows.length} interest entries`;
  }
}

function renderSettingsTags() {
  const apts = state.data?.config?.apartments || [];
  $('#apt-tags').innerHTML = apts
    .map((a) => {
      const canDel = canRemoveApartment(a, state.data.ledgers);
      return `<span class="tag">${a}${canDel ? `<button data-rm-apt="${a}" title="Remove">×</button>` : ''}</span>`;
    })
    .join('');

  document.querySelectorAll('[data-rm-apt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      try {
        removeApartment(state.data.config, state.data.ledgers, btn.dataset.rmApt);
        renderSettingsTags();
      } catch (e) {
        alert(e.message);
      }
    });
  });

  const cats = state.data?.config?.expenseCategories || [];
  $('#cat-tags').innerHTML = cats
    .map(
      (c) =>
        `<span class="tag">${escapeHtml(c)}<button data-rm-cat="${escapeHtml(c)}" title="Remove">×</button></span>`
    )
    .join('');

  document.querySelectorAll('[data-rm-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.data.config.expenseCategories = state.data.config.expenseCategories.filter(
        (c) => c !== btn.dataset.rmCat
      );
      renderSettingsTags();
    });
  });
}

async function saveConfigToGitHub() {
  if (!ensureGitHubSettings()) return;

  $('#settings-status').textContent = 'Saving…';
  try {
    // Keep local apartment/category edits; refresh other authoritative fields from git
    const localConfig = state.data.config;
    const localLedgers = state.data.ledgers;
    await refreshBeforeWrite();
    state.data.config = localConfig;
    // Preserve any newly added empty apartment ledgers
    for (const apt of localConfig.apartments) {
      if (!state.data.ledgers[apt]) state.data.ledgers[apt] = localLedgers[apt] || [];
    }
    const files = buildCommitFiles(state.data, null);
    const client = ghClient();
    await client.commitFiles('Update config', {
      'data/config.json': files['data/config.json'],
      ...Object.fromEntries(
        Object.entries(files).filter(([k]) => k.startsWith('data/ledgers/'))
      ),
    });
    $('#settings-status').textContent = 'Saved';
    renderSettingsTags();
    renderBrowseApartments();
  } catch (e) {
    $('#settings-status').textContent = `Error: ${e.message}`;
  }
}

function initSettings() {
  const detected = new GitHubClient('', '', '').detectRepoFromUrl();
  const s = loadSettings();
  $('#gh-owner').value = s.owner || detected?.owner || '';
  $('#gh-repo').value = s.repo || detected?.repo || 'kg_ledger';
  $('#gh-token').value = '';
  $('#gh-token').placeholder = s.token
    ? 'Token saved in cookie — leave blank to keep, or enter new'
    : 'ghp_...';

  $('#save-settings-btn').addEventListener('click', async () => {
    try {
      saveSettings(
        $('#gh-owner').value.trim(),
        $('#gh-repo').value.trim(),
        $('#gh-token').value.trim()
      );
      $('#gh-token').value = '';
      $('#gh-token').placeholder = 'Token saved in cookie — leave blank to keep, or enter new';
      $('#settings-status').innerHTML =
        '<span class="alert alert-success" style="display:inline-block;margin-top:0.5rem">Settings saved. Reloading data from GitHub…</span>';
      await reloadData({ requireApi: true });
      $('#settings-status').innerHTML =
        '<span class="alert alert-success" style="display:inline-block;margin-top:0.5rem">Settings saved. Live data loaded from GitHub (not Pages cache).</span>';
    } catch (e) {
      $('#settings-status').innerHTML = `<span class="alert alert-error" style="display:inline-block;margin-top:0.5rem">${escapeHtml(e.message)}</span>`;
    }
  });

  $('#add-apt-btn').addEventListener('click', () => {
    try {
      addApartment(state.data.config, state.data.ledgers, $('#new-apt').value);
      $('#new-apt').value = '';
      renderSettingsTags();
      renderBrowseApartments();
    } catch (e) {
      alert(e.message);
    }
  });

  $('#add-cat-btn').addEventListener('click', () => {
    const cat = $('#new-cat').value.trim();
    if (!cat) return;
    if (!state.data.config.expenseCategories.includes(cat)) {
      state.data.config.expenseCategories.push(cat);
    }
    $('#new-cat').value = '';
    renderSettingsTags();
  });

  $('#save-config-btn').addEventListener('click', saveConfigToGitHub);
}

function initUpload() {
  // Optional label only — uploads are ad-hoc and deduped by txn hash
  $('#statement-month').value = '';

  const dropZone = $('#drop-zone');
  const input = $('#pdf-input');

  dropZone.addEventListener('click', () => input.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file?.type === 'application/pdf') handlePdf(file);
  });
  input.addEventListener('change', () => {
    if (input.files[0]) handlePdf(input.files[0]);
  });

  $('#commit-btn').addEventListener('click', handleCommit);
  $('#commit-pending-btn').addEventListener('click', handleCommitPending);
  $('#dismiss-pending-btn').addEventListener('click', handleDismissPending);
}

function initBrowse() {
  $('#browse-view').addEventListener('change', renderBrowse);
  $('#browse-apartment').addEventListener('change', renderBrowse);
}

function initTransactions() {
  $('#txn-filter')?.addEventListener('change', renderTransactions);
  $('#save-txn-tags-btn')?.addEventListener('click', handleSaveTxnTags);
  $('#reload-data-btn')?.addEventListener('click', async () => {
    const btn = $('#reload-data-btn');
    btn.disabled = true;
    try {
      if (state.txnEdits.size && !confirm('Reload and discard unsaved tag corrections?')) {
        return;
      }
      await reloadData({ requireApi: hasGitHubSettings() });
      renderTransactions();
      $('#txn-save-status').textContent = '';
    } catch (e) {
      alert(`Reload failed: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  });
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

initSettings();
initUpload();
initBrowse();
initTransactions();
try {
  await reloadData({ requireApi: hasGitHubSettings() });
} catch (err) {
  console.error(err);
  alert(`Failed to load ledger data: ${err.message}`);
}
