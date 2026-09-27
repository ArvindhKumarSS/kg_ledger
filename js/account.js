/** Maintenance vs corpus bank-account helpers */

export const ACCOUNT_MAINTENANCE = 'maintenance';
export const ACCOUNT_CORPUS = 'corpus';
export const ACCOUNT_KINDS = [ACCOUNT_MAINTENANCE, ACCOUNT_CORPUS];

export function accountTitle(kind) {
  return kind === ACCOUNT_CORPUS ? 'Corpus' : 'Maintenance';
}

export function accountCreditLabel(kind) {
  return kind === ACCOUNT_CORPUS ? 'corpus contributions' : 'maintenance payments';
}

export function emptyBalance() {
  return {
    balance: null,
    lastTransactionDate: null,
    statementMonth: null,
    updatedAt: null,
  };
}

export function emptyAccountSlice(apartments = []) {
  const ledgers = {};
  for (const apt of apartments) ledgers[apt] = [];
  return {
    ledgers,
    expenditures: [],
    interest: [],
    pendingCredits: [],
    accountBalance: emptyBalance(),
  };
}

/** Git paths for one association bank account */
export function accountFilePaths(kind) {
  const root = kind === ACCOUNT_CORPUS ? 'data/corpus' : 'data';
  return {
    expenditures: `${root}/expenditures.json`,
    interest: `${root}/interest.json`,
    pendingCredits: `${root}/pending-credits.json`,
    accountBalance: `${root}/account-balance.json`,
    ledger: (apt) => `${root}/ledgers/${apt}.json`,
    upload: (id) => `${root}/uploads/${id}.json`,
  };
}

export function normalizeAccountNumber(value) {
  return String(value || '').replace(/[\s-]/g, '');
}

/** Match a parsed IOB A/C number to a configured account, if numbers are saved */
export function detectAccountKind(accountNumber, config) {
  const parsed = normalizeAccountNumber(accountNumber);
  if (!parsed) return null;
  const banks = config?.bankAccounts || {};
  for (const kind of ACCOUNT_KINDS) {
    const saved = normalizeAccountNumber(banks[kind]?.accountNumber);
    if (saved && saved === parsed) return kind;
  }
  return null;
}

export function expenseCategoriesFor(kind, config) {
  if (kind === ACCOUNT_CORPUS) {
    return config?.corpusExpenseCategories || [];
  }
  return config?.expenseCategories || [];
}

export function ensureBankAccounts(config) {
  if (!config.bankAccounts) config.bankAccounts = {};
  if (!config.bankAccounts.maintenance) {
    config.bankAccounts.maintenance = { accountNumber: '' };
  }
  if (!config.bankAccounts.corpus) {
    config.bankAccounts.corpus = { accountNumber: '' };
  }
  if (!Array.isArray(config.corpusExpenseCategories) || !config.corpusExpenseCategories.length) {
    config.corpusExpenseCategories = ['Lift', 'Capital works', 'Bank Charges', 'Misc'];
  }
}
