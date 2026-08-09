# KG Srivatsa Garden — Maintenance Ledger

A static web app for maintaining apartment maintenance ledgers from Indian Overseas Bank (IOB) monthly statements.

## Features

- Upload IOB bank statement PDFs (parsed in browser)
- Auto-map credit transactions to apartments via account mapping
- Tag unmapped payers — saved for future statements
- Per-apartment credit ledgers (Date, Amount, Details)
- Expenditure ledger for debits with optional categories
- Separate interest credit tracking
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

1. Download an IOB statement PDF (any period — uploads are ad-hoc)
2. Open the GitHub Pages site
3. Go to **Settings**, enter your GitHub username, repo name, and PAT
4. Go to **Upload**, optionally label the statement month, drop the PDF
5. Review auto-mapped credits; tag any unmapped payers (or bulk cash) to apartments
6. Assign categories to debits if needed
7. Click **Commit to GitHub**

Transactions are stored by content hash (`date|amount|details|cheque`). Re-uploading the same statement (or overlapping statements) silently ignores duplicates and merges new rows. Tagging a payer to an apartment updates `mappings/accounts.json`, moves matching past ledger rows, and auto-maps future imports.

## Local development

```bash
python3 -m http.server 8080
# Open http://localhost:8080
```

Note: ES modules and pdf.js CDN require serving over HTTP (not `file://`).

## Data structure

```
data/
├── config.json              # Apartments, expense categories
├── mappings/accounts.json   # Payer → apartment mapping
├── ledgers/1A.json …        # One file per apartment
├── expenditures.json
├── interest.json
└── uploads/<id>.json        # Import audit log (month label or timestamp)
```

## Apartments

Default seed: floors 1–5, units A–G (35 apartments). Add or remove units in Settings.
