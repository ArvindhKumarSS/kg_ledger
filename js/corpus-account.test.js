/** Node smoke tests for corpus vs maintenance ledger helpers */
import {
  ACCOUNT_CORPUS,
  ACCOUNT_MAINTENANCE,
  accountFilePaths,
  detectAccountKind,
  accountTitle,
} from './account.js';
import {
  makeTxnId,
  buildCommitFiles,
  addApartment,
  removeApartment,
  canRemoveApartment,
  computeCorpusDues,
  collectExistingTxnIds,
  buildLedgerEntries,
  mergeData,
} from './ledger-store.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const config = {
  apartments: ['1A', '1B'],
  apartmentRates: {},
  bankAccounts: {
    maintenance: { accountNumber: '111122223333' },
    corpus: { accountNumber: '999988887777' },
  },
};

assert(accountTitle(ACCOUNT_CORPUS) === 'Corpus', 'title');
assert(detectAccountKind('111122223333', config) === ACCOUNT_MAINTENANCE, 'detect maint');
assert(detectAccountKind('9999-8888-7777', config) === ACCOUNT_CORPUS, 'detect corpus');
assert(detectAccountKind('0000', config) === null, 'detect unknown');

const txn = {
  date: '2026-04-05',
  creditAmount: 12075,
  details: 'IMPS/609518959336/DAVID J/ICIC/XXXXXX3679/IMPS',
  chequeNumber: '',
  txnType: 'credit',
  apartment: '1A',
  mappingKey: 'david j icic',
};
const maintId = await makeTxnId(txn, ACCOUNT_MAINTENANCE);
const corpusId = await makeTxnId(txn, ACCOUNT_CORPUS);
assert(maintId !== corpusId, 'corpus txn ids are namespaced');
assert(maintId === (await makeTxnId(txn)), 'maintenance hash stays default');

const pathsM = accountFilePaths(ACCOUNT_MAINTENANCE);
const pathsC = accountFilePaths(ACCOUNT_CORPUS);
assert(pathsM.ledger('1A') === 'data/ledgers/1A.json', 'maint ledger path');
assert(pathsC.ledger('1A') === 'data/corpus/ledgers/1A.json', 'corpus ledger path');
assert(pathsC.pendingCredits === 'data/corpus/pending-credits.json', 'corpus pending path');

const maintLedgers = { '1A': [], '1B': [] };
const corpusLedgers = { '1A': [], '1B': [] };
addApartment(config, maintLedgers, '2A', [corpusLedgers]);
assert(config.apartments.includes('2A'), 'apt added');
assert(Array.isArray(maintLedgers['2A']) && Array.isArray(corpusLedgers['2A']), 'both ledger maps');
assert(canRemoveApartment('2A', maintLedgers, corpusLedgers), 'empty removable');
corpusLedgers['2A'].push({ txnId: 'x', creditAmount: 1, date: '2026-01-01' });
assert(!canRemoveApartment('2A', maintLedgers, corpusLedgers), 'blocked by corpus txn');
let threw = false;
try {
  removeApartment(config, maintLedgers, '2A', [corpusLedgers]);
} catch {
  threw = true;
}
assert(threw, 'cannot remove apt with corpus rows');
corpusLedgers['2A'] = [];
removeApartment(config, maintLedgers, '2A', [corpusLedgers]);
assert(!config.apartments.includes('2A'), 'removed after both empty');

const dues = computeCorpusDues('1A', {
  config: { apartmentRates: { '1A': { sqFt: 1610, corpusDue: 50000 } } },
  ledgers: { '1A': [{ creditAmount: 20000 }, { creditAmount: 5000 }] },
});
assert(dues.expected === 50000, 'corpus expected');
assert(dues.collected === 25000, 'corpus collected');
assert(dues.deficit === 25000, 'corpus deficit');

const existing = {
  config,
  accounts: {},
  ledgers: { '1A': [], '1B': [] },
  expenditures: [],
  interest: [],
  pendingCredits: [],
  accountBalance: { balance: null },
};
const ids = collectExistingTxnIds(existing);
const updates = await buildLedgerEntries(
  [
    {
      ...txn,
      skip: false,
      debitAmount: null,
    },
  ],
  'test-upload',
  ids,
  ACCOUNT_CORPUS
);
assert(updates.importedTxnIds.length === 1, 'imported');
assert(updates.ledgerUpdates['1A'][0].creditAmount === 12075, 'tagged to apt');
const merged = mergeData(existing, updates);
assert(merged.ledgers['1A'].length === 1, 'merged into ledger');
assert(merged.accounts['david j icic'] === '1A', 'mapping persisted');

const files = buildCommitFiles(merged, { uploadId: 'u1' }, ACCOUNT_CORPUS);
assert(files['data/corpus/ledgers/1A.json'].length === 1, 'writes corpus ledger');
assert(files['data/corpus/uploads/u1.json'].accountKind === ACCOUNT_CORPUS, 'upload meta');
assert(!files['data/ledgers/1A.json'], 'does not rewrite maintenance ledgers');
assert(files['data/mappings/accounts.json']['david j icic'] === '1A', 'shared mapping file');

console.log('All corpus account helper tests passed');
