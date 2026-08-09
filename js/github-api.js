/** GitHub API — read files and atomic multi-file commits */

const API = 'https://api.github.com';

export class GitHubClient {
  constructor(token, owner, repo) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async fetchJson(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { ...this.headers(), ...options.headers } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub API error ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async getFile(path) {
    const data = await this.fetchJson(`${API}/repos/${this.owner}/${this.repo}/contents/${path}`);
    if (Array.isArray(data)) throw new Error(`${path} is a directory`);
    const content = JSON.parse(atob(data.content.replace(/\n/g, '')));
    return { content, sha: data.sha };
  }

  async getFileRaw(path, branch = 'main') {
    const res = await fetch(
      `${API}/repos/${this.owner}/${this.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
      {
        headers: this.headers(),
        cache: 'no-store',
      }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to read ${path}`);
    const data = await res.json();
    if (Array.isArray(data)) return null;
    return JSON.parse(atob(data.content.replace(/\n/g, '')));
  }

  async getRef(branch = 'main') {
    return this.fetchJson(`${API}/repos/${this.owner}/${this.repo}/git/ref/heads/${branch}`);
  }

  async createBlob(content) {
    const data = await this.fetchJson(`${API}/repos/${this.owner}/${this.repo}/git/blobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: JSON.stringify(content, null, 2), encoding: 'utf-8' }),
    });
    return data.sha;
  }

  async createTree(baseTreeSha, entries) {
    const data = await this.fetchJson(`${API}/repos/${this.owner}/${this.repo}/git/trees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }),
    });
    return data.sha;
  }

  async createCommit(message, treeSha, parentSha) {
    const data = await this.fetchJson(`${API}/repos/${this.owner}/${this.repo}/git/commits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
    });
    return data.sha;
  }

  async updateRef(refSha, branch = 'main') {
    await this.fetchJson(`${API}/repos/${this.owner}/${this.repo}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: refSha, force: false }),
    });
  }

  /** Atomic commit of multiple file changes: { path: contentObject } */
  async commitFiles(message, files, branch = 'main') {
    const ref = await this.getRef(branch);
    const baseCommitSha = ref.object.sha;

    const commit = await this.fetchJson(`${API}/repos/${this.owner}/${this.repo}/git/commits/${baseCommitSha}`);
    const baseTreeSha = commit.tree.sha;

    const treeEntries = [];
    for (const [path, content] of Object.entries(files)) {
      const blobSha = await this.createBlob(content);
      treeEntries.push({ path, mode: '100644', type: 'blob', sha: blobSha });
    }

    const newTreeSha = await this.createTree(baseTreeSha, treeEntries);
    const newCommitSha = await this.createCommit(message, newTreeSha, baseCommitSha);
    await this.updateRef(newCommitSha, branch);
    return newCommitSha;
  }

  detectRepoFromUrl() {
    const m = window.location.pathname.match(/^\/([^/]+)\/?/);
    if (m && !['', 'index.html'].includes(m[1])) {
      const repo = m[1];
      const host = window.location.hostname;
      if (host.endsWith('.github.io')) {
        const owner = host.replace('.github.io', '');
        return { owner, repo };
      }
    }
    return null;
  }

  /** Authoritative load from git (bypasses GitHub Pages CDN cache) */
  async loadAllData(branch = 'main') {
    const fetchJson = (path) => this.getFileRaw(path, branch);

    const config = await fetchJson('data/config.json');
    if (!config) throw new Error('data/config.json missing from repository');

    const accounts = (await fetchJson('data/mappings/accounts.json')) || {};
    const expenditures = (await fetchJson('data/expenditures.json')) || [];
    const interest = (await fetchJson('data/interest.json')) || [];
    const pendingCredits = (await fetchJson('data/pending-credits.json')) || [];
    const accountBalance = (await fetchJson('data/account-balance.json')) || {
      balance: null,
      lastTransactionDate: null,
      statementMonth: null,
      updatedAt: null,
    };

    const ledgers = {};
    await Promise.all(
      (config.apartments || []).map(async (apt) => {
        ledgers[apt] = (await fetchJson(`data/ledgers/${apt}.json`)) || [];
      })
    );

    return {
      config,
      accounts,
      expenditures,
      interest,
      accountBalance,
      ledgers,
      pendingCredits,
      source: 'github-api',
    };
  }
}

/** Public Pages load — always bypass HTTP cache (Pages uses max-age=600) */
export async function loadAllData(baseUrl) {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const bust = `t=${Date.now()}`;

  const fetchJson = async (path) => {
    const res = await fetch(`${root}${path}?${bust}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load ${path}`);
    return res.json();
  };

  const config = await fetchJson('data/config.json');
  if (!config) throw new Error('Failed to load data/config.json');

  const accounts = (await fetchJson('data/mappings/accounts.json')) || {};
  const expenditures = (await fetchJson('data/expenditures.json')) || [];
  const interest = (await fetchJson('data/interest.json')) || [];
  const pendingCredits = (await fetchJson('data/pending-credits.json')) || [];
  const accountBalance = (await fetchJson('data/account-balance.json')) || {
    balance: null,
    lastTransactionDate: null,
    statementMonth: null,
    updatedAt: null,
  };

  const ledgers = {};
  await Promise.all(
    (config.apartments || []).map(async (apt) => {
      ledgers[apt] = (await fetchJson(`data/ledgers/${apt}.json`)) || [];
    })
  );

  return {
    config,
    accounts,
    expenditures,
    interest,
    accountBalance,
    ledgers,
    pendingCredits,
    source: 'pages',
  };
}
