# KG Srivatsa Garden — Association Ledger

A static web app for apartment association ledgers from Indian Overseas Bank (IOB) statements. The association keeps two bank accounts:

- **Maintenance** — monthly dues
- **Corpus** — one-time / capital collections (new lift, major works). Same upload, tagging, pending queue, transactions, browse, and expenditure features; not billed as monthly maintenance.

Click the header cards to switch accounts. Upload uses the same review flow for whichever account is selected.

## Features

- Upload IOB bank statement PDFs (parsed in browser) into maintenance or corpus
- Optional IOB A/C numbers in Settings — the PDF A/C line auto-selects the account
- Auto-map credit transactions to apartments via shared payer mapping
- Tag unmapped payers — saved for future statements (both accounts)
- Pending credits queue — untagged/skipped credits persist across uploads and reloads (per account)
- Transactions tab — unique committed transactions for the selected account; correct apartment/category tags anytime
- Loads from GitHub API when a PAT is configured (avoids GitHub Pages CDN cache lag)
- Per-apartment credit ledgers (Date, Amount, Details) for each account
- Apartment Sq.Ft + rate (₹/Sq.Ft) in Settings; monthly dues / collected / deficit on Browse (maintenance)
- One-time corpus due per apartment in Settings; collected vs due on Browse (corpus)
- Expenditure ledger for debits with categories (maintenance vs corpus categories)
- Separate interest credit tracking per account
- Data stored as JSON files in git
- Commit changes via GitHub API (Personal Access Token)

## Setup

### 1. Push to GitHub

```bash
git add .
git commit -m "Initial ledger app"
git remote add origin https://github.com/YOUR_USERNAME/kg_ledger.git
git push -u origin main
```

### 2. Enable GitHub Pages

- Repo **Settings → Pages**
- Source: `main` branch, `/ (root)` folder
- Site URL: `https://YOUR_USERNAME.github.io/kg_ledger/`

### 3. Create a Personal Access Token

- GitHub **Settings → Developer settings → Personal access tokens → Fine-grained tokens**
- Repository access: only `kg_ledger`
- Permissions: **Contents: Read and write**
- Copy the token — enter it in **Settings**; it is saved in a browser cookie on your device (365 days)

## Upload workflow

1. Download an IOB statement PDF (maintenance or corpus — any period)
2. Open the GitHub Pages site
3. Go to **Settings**, enter your GitHub username, repo name, and PAT
4. Optionally save the two IOB A/C numbers so future PDFs auto-select the account
5. Go to **Upload**, pick **Maintenance** or **Corpus** (or click the header card), optionally label the statement month, drop the PDF
6. Review auto-mapped credits; tag any unmapped payers (or bulk cash) to apartments
7. Assign categories to debits if needed
8. Click **Commit to GitHub** — untagged or skipped credits are saved to **Pending credits** for that account

You can return later (even after reload or more uploads), tag pending rows, and click **Commit tagged pending**. Use **Dismiss selected** only to drop credits you never want to import.

Transactions are stored by content hash (`date|amount|details|cheque`). Corpus hashes are namespaced so the same line in both bank accounts cannot collide. Re-uploading the same statement (or overlapping statements) silently ignores duplicates and merges new rows. Tagging a payer to an apartment updates `mappings/accounts.json` (shared), moves matching past ledger rows **in that account**, and auto-maps future imports.

## Local development

```bash
python3 -m http.server 8080
# Open http://localhost:8080
```

Note: ES modules and pdf.js CDN require serving over HTTP (not `file://`).

## Data structure

```
data/
├── config.json                 # Apartments, categories, Sq.Ft/rates, corpus due, bank A/C nos
├── mappings/accounts.json      # Payer → apartment mapping (shared)
├── ledgers/1A.json …           # Maintenance credits per apartment
├── expenditures.json           # Maintenance debits
├── interest.json
├── pending-credits.json
├── account-balance.json
├── uploads/<id>.json
└── corpus/
    ├── ledgers/1A.json …       # Corpus credits per apartment
    ├── expenditures.json
    ├── interest.json
    ├── pending-credits.json
    ├── account-balance.json
    └── uploads/<id>.json
```

## Apartments

Default seed: floors 1–5, units A–G (35 apartments). Add or remove units in Settings.
