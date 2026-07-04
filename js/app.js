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
} from './ledger-store.js';
import { formatAmount, formatDisplayDate, previousMonth, escapeHtml } from './utils.js';

// pdf.js from CDN
const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

const state = {
  data: null,
  classified: [],
  parseWarnings: [],
  fileName: '',
};

function $(sel) {
  return document.querySelector(sel);
}

function loadSettings() {
  return {
    owner: sessionStorage.getItem('gh-owner') || '',
    repo: sessionStorage.getItem('gh-repo') || 'kg_ledger',
    token: sessionStorage.getItem('gh-token') || '',
  };
}

function saveSettings(owner, repo, token) {
  sessionStorage.setItem('gh-owner', owner);
  sessionStorage.setItem('gh-repo', repo);
  sessionStorage.setItem('gh-token', token);
}

function getBaseUrl() {
  return window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/');
}

function ghClient() {
  const s = loadSettings();
  if (!s.token || !s.owner || !s.repo) throw new Error('Configure GitHub settings first');
  return new GitHubClient(s.token, s.owner, s.repo);
}

async function reloadData() {
  state.data = await loadAllData(getBaseUrl());
  document.getElementById('complex-name').textContent =
    `${state.data.config.complexName} — Maintenance Ledger`;
  renderSettingsTags();
  renderBrowseApartments();
}

function aptOptions(selected = '') {
  const apts = state.data?.config?.apartments || [];
  return (
    `<option value="">—</option>` +
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

async function handleCommit() {
  const month = $('#statement-month').value;
  if (!month) {
    alert('Select a statement month');
    return;
  }

  const unmapped = state.classified.filter(
    (t) => (t.txnType === 'credit' || t.txnType === 'bulk_cash') && !t.skip && !t.apartment
  );
  if (unmapped.length) {
    if (!confirm(`${unmapped.length} credit(s) are unmapped and will be skipped. Continue?`)) return;
  }

  $('#commit-btn').disabled = true;
  $('#commit-status').textContent = 'Committing…';

  try {
    const existingIds = collectExistingTxnIds(state.data);
    const updates = await buildLedgerEntries(state.classified, month, existingIds);
    const merged = mergeData(state.data, updates);

    const uploadMeta = {
      uploadedAt: new Date().toISOString(),
      statementMonth: month,
      fileName: state.fileName,
      transactionCount: updates.importedTxnIds.length,
      importedTxnIds: updates.importedTxnIds,
    };

    const files = buildCommitFiles(merged, uploadMeta);
    const client = ghClient();
    const sha = await client.commitFiles(`Import statement ${month}`, files);

    state.data = merged;
    $('#commit-status').textContent = `Committed (${sha.slice(0, 7)})`;
    alert(`Successfully imported ${updates.importedTxnIds.length} transactions.${updates.skipped.length ? ` Skipped ${updates.skipped.length} duplicates.` : ''}`);
  } catch (err) {
    $('#commit-status').textContent = '';
    alert(`Commit failed: ${err.message}`);
  } finally {
    $('#commit-btn').disabled = false;
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
  $('#settings-status').textContent = 'Saving…';
  try {
    const files = buildCommitFiles(state.data, null);
    const client = ghClient();
    await client.commitFiles('Update config', {
      'data/config.json': files['data/config.json'],
      ...Object.fromEntries(
        Object.entries(files).filter(([k]) => k.startsWith('data/ledgers/'))
      ),
    });
    $('#settings-status').textContent = 'Saved';
  } catch (e) {
    $('#settings-status').textContent = `Error: ${e.message}`;
  }
}

function initSettings() {
  const detected = new GitHubClient('', '', '').detectRepoFromUrl();
  const s = loadSettings();
  $('#gh-owner').value = s.owner || detected?.owner || '';
  $('#gh-repo').value = s.repo || detected?.repo || 'kg_ledger';
  $('#gh-token').value = s.token;

  $('#save-settings-btn').addEventListener('click', () => {
    saveSettings($('#gh-owner').value.trim(), $('#gh-repo').value.trim(), $('#gh-token').value.trim());
    $('#settings-status').textContent = 'Settings saved for this session';
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
  $('#statement-month').value = previousMonth();

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
}

function initBrowse() {
  $('#browse-view').addEventListener('change', renderBrowse);
  $('#browse-apartment').addEventListener('change', renderBrowse);
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

initSettings();
initUpload();
initBrowse();
await reloadData();
