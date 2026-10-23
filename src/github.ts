/**
 * GitHub API client. Native fetch only, no extra dependencies.
 * Optional GITHUB_TOKEN or GH_TOKEN env var raises the rate limit
 * from 60 to 5000 req/hr. Responses are cached under
 * ~/.cache/claimcheck so repeated scans do not burn quota.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const DEFAULT_API = "https://api.github.com";

/**
 * The GitHub API base in use. CLAIMCHECK_GITHUB_BASE_URL wins, then the
 * generic GITHUB_BASE_URL, then the public API. Lets the tool run through a
 * vault-backed localhost proxy (gh-proxy) that attaches a stored token, the
 * same pattern as Greenlight's GREENLIGHT_GITHUB_BASE_URL. Trailing slashes
 * are stripped.
 */
export function githubApiBase(): string {
  for (const raw of [process.env.CLAIMCHECK_GITHUB_BASE_URL, process.env.GITHUB_BASE_URL]) {
    if (raw && raw.trim().length > 0) return raw.trim().replace(/\/+$/, "");
  }
  return DEFAULT_API;
}

const CACHE_DIR = join(homedir(), ".cache", "claimcheck");

function ensureCache(): void {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
}

const TTL_MS: Record<string, number> = {
  issues: 60 * 60 * 1000,
  comments: 60 * 60 * 1000,
  prs: 60 * 60 * 1000,
  branches: 30 * 60 * 1000,
  commit: 30 * 60 * 1000,
  compare: 30 * 60 * 1000,
  pulls: 30 * 60 * 1000,
  repo: 6 * 60 * 60 * 1000,
};

function cacheKey(kind: string, parts: string[]): string {
  return `${kind}-${parts.join("-").replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`;
}

function cacheGet(kind: string, parts: string[]): unknown | undefined {
  ensureCache();
  const file = join(CACHE_DIR, cacheKey(kind, parts));
  if (!existsSync(file)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(file, "utf8"));
    if (Date.now() - entry.savedAt > (TTL_MS[kind] ?? TTL_MS.issues)) return undefined;
    return entry.data;
  } catch {
    return undefined;
  }
}

function cacheSet(kind: string, parts: string[], data: unknown): void {
  ensureCache();
  const file = join(CACHE_DIR, cacheKey(kind, parts));
  try {
    writeFileSync(file, JSON.stringify({ savedAt: Date.now(), data }), "utf8");
  } catch { /* cache is best-effort */ }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export function githubToken(): string | undefined {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
}

async function apiGet(path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "claimcheck-cli",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = githubToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${githubApiBase()}${path}`, { headers });
  if (res.status === 403 || res.status === 429) {
    const body = await res.text().catch(() => "");
    const reset = res.headers.get("x-ratelimit-reset");
    const wait = reset ? ` Rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}.` : "";
    const hint = token
      ? "Authenticated limit also exhausted."
      : "Set GITHUB_TOKEN (a classic PAT, no scopes needed for public repos) to raise the limit from 60 to 5000 req/hr.";
    throw new RateLimitError(`GitHub rate limit hit (${res.status}).${wait} ${hint} ${body.slice(0, 120)}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

async function paginate<T>(path: string, perPage = 100, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = (await apiGet(`${path}${sep}per_page=${perPage}&page=${page}`)) as T[];
    out.push(...data);
    if (data.length < perPage) break;
  }
  return out;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  url: string;
  author: string;
  assignees: string[];
  labels: string[];
  updatedAt: string;
  commentsCount: number;
}

export interface CommentSignal {
  author: string;
  body: string;
  createdAt: string;
}

export interface LinkedPR {
  number: number;
  state: "open" | "closed" | "merged";
  title: string;
  url: string;
  author?: string;
}

export interface BranchInfo {
  name: string;
  lastCommitAt: string;
  sha: string;
}

export interface CompareInfo {
  aheadBy: number;
  behindBy: number;
}

export interface RepoInfo {
  defaultBranch: string;
  parent: RepoRef | undefined;
  fork: boolean;
}

/** Parse owner/repo from a string. */
export function parseRepoRef(ref: string): RepoRef {
  const m = /^([^/]+)\/([^/]+)$/.exec(ref.trim());
  if (!m) throw new Error(`Expected owner/repo, got: ${ref}`);
  return { owner: m[1], repo: m[2] };
}

/** Parse an issue URL into owner, repo, number. */
export function parseIssueUrl(url: string): RepoRef & { number: number } {
  const m = /github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/.exec(url);
  if (!m) throw new Error(`Not a GitHub issue URL: ${url}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** List open unassigned issues on a repo (pull requests filtered out). */
export async function listOpenIssues(owner: string, repo: string, limit = 30): Promise<IssueSummary[]> {
  const cached = cacheGet("issues", [owner, repo, String(limit)]) as IssueSummary[] | undefined;
  if (cached) return cached;
  const data = await paginate<Record<string, unknown>>(`/repos/${owner}/${repo}/issues?state=open&no=assignee&sort=updated&direction=desc`, 100, 3);
  const issues = data
    .filter((i) => !(i as { pull_request?: unknown }).pull_request)
    .slice(0, limit)
    .map((i) => ({
      number: i.number as number,
      title: String(i.title ?? ""),
      url: String(i.html_url ?? `https://github.com/${owner}/${repo}/issues/${i.number}`),
      author: ((i.user as Record<string, string> | undefined)?.login ?? ""),
      assignees: ((i.assignees as Array<Record<string, string>> | undefined) ?? []).map((a) => a.login),
      labels: ((i.labels as Array<Record<string, string>> | undefined) ?? []).map((l) => l.name),
      updatedAt: String(i.updated_at),
      commentsCount: Number(i.comments ?? 0),
    }));
  cacheSet("issues", [owner, repo, String(limit)], issues);
  return issues;
}

/** Fetch comments on an issue. */
export async function fetchComments(owner: string, repo: string, number: number): Promise<CommentSignal[]> {
  const cached = cacheGet("comments", [owner, repo, String(number)]) as CommentSignal[] | undefined;
  if (cached) return cached;
  const data = await paginate<Record<string, unknown>>(`/repos/${owner}/${repo}/issues/${number}/comments`);
  const comments: CommentSignal[] = data.map((c) => ({
    author: (c.user as Record<string, string>).login,
    body: String(c.body ?? ""),
    createdAt: String(c.created_at),
  }));
  cacheSet("comments", [owner, repo, String(number)], comments);
  return comments;
}

/**
 * Find PRs that reference an issue: timeline cross-reference events plus a
 * search for the issue number in PRs of the repo. Used to tell a real claim
 * from a claim that turned into work.
 */
export async function fetchLinkedPRs(owner: string, repo: string, number: number): Promise<LinkedPR[]> {
  const cached = cacheGet("prs", [owner, repo, String(number)]) as LinkedPR[] | undefined;
  if (cached) return cached;

  const found = new Map<number, LinkedPR>();

  try {
    const timeline = await paginate<Record<string, unknown>>(`/repos/${owner}/${repo}/issues/${number}/timeline`);
    for (const event of timeline) {
      if (event.event !== "cross-referenced") continue;
      const src = event.source as Record<string, unknown> | undefined;
      if (!src || src.type !== "issue") continue;
      const pull = src.pull_request as Record<string, unknown> | undefined;
      if (!pull) continue;
      const prUrl = String(src.html_url ?? "");
      const nm = /\/pull\/(\d+)/.exec(prUrl);
      if (!nm) continue;
      found.set(Number(nm[1]), {
        number: Number(nm[1]),
        state: "open",
        title: String(src.title ?? ""),
        url: prUrl,
      });
    }
  } catch { /* timeline is best-effort */ }

  try {
    const q = encodeURIComponent(`repo:${owner}/${repo} type:pr #${number}`);
    const data = (await apiGet(`/search/issues?q=${q}&per_page=20`)) as {
      items: Array<{
        number: number;
        state: string;
        title: string;
        html_url: string;
        user: { login: string };
        pull_request?: { merged_at: string | null };
      }>;
    };
    for (const item of data.items ?? []) {
      const state: LinkedPR["state"] =
        item.pull_request?.merged_at ? "merged" : item.state === "open" ? "open" : "closed";
      found.set(item.number, {
        number: item.number,
        state,
        title: item.title,
        url: item.html_url,
        author: item.user?.login,
      });
    }
  } catch { /* search is best-effort */ }

  const prs = [...found.values()];
  cacheSet("prs", [owner, repo, String(number)], prs);
  return prs;
}

/** Fetch repo info, including parent for forks. */
export async function fetchRepo(owner: string, repo: string): Promise<RepoInfo> {
  const cached = cacheGet("repo", [owner, repo]) as RepoInfo | undefined;
  if (cached) return cached;
  const data = (await apiGet(`/repos/${owner}/${repo}`)) as Record<string, unknown>;
  const parent = data.parent as Record<string, unknown> | undefined;
  const info: RepoInfo = {
    defaultBranch: String(data.default_branch ?? "main"),
    fork: Boolean(data.fork),
    parent: parent
      ? { owner: (parent.owner as Record<string, string>).login, repo: String(parent.name) }
      : undefined,
  };
  cacheSet("repo", [owner, repo], info);
  return info;
}

/** Fetch one commit's date (committer date, author date as fallback). */
async function fetchCommitDate(owner: string, repo: string, sha: string): Promise<string> {
  if (!sha) return "";
  const cached = cacheGet("commit", [owner, repo, sha]) as string | undefined;
  if (cached !== undefined) return cached;
  let date = "";
  try {
    const data = (await apiGet(`/repos/${owner}/${repo}/commits/${sha}`)) as {
      commit?: { committer?: { date?: string }; author?: { date?: string } };
    };
    date = String(data.commit?.committer?.date ?? data.commit?.author?.date ?? "");
  } catch { /* date is best-effort; the branch itself still reports */ }
  cacheSet("commit", [owner, repo, sha], date);
  return date;
}

/**
 * List branches on a repo (excluding the default branch for parked-fix scans).
 * The branches API returns only the head commit's sha/url — no date — so the
 * head commit is fetched per branch to populate lastCommitAt; without it the
 * parked-age signal was permanently ""/0 (PT-2).
 */
export async function listBranches(owner: string, repo: string): Promise<BranchInfo[]> {
  const cached = cacheGet("branches", [owner, repo]) as BranchInfo[] | undefined;
  if (cached) return cached;
  const data = await paginate<Record<string, unknown>>(`/repos/${owner}/${repo}/branches`);
  const branches: BranchInfo[] = [];
  for (const b of data) {
    const inner = (b.commit as { sha?: string }) ?? {};
    const sha = String(inner.sha ?? "");
    branches.push({
      name: String(b.name),
      sha,
      lastCommitAt: await fetchCommitDate(owner, repo, sha),
    });
  }
  cacheSet("branches", [owner, repo], branches);
  return branches;
}

/**
 * Compare a fork branch against the upstream default branch.
 * base = upstream owner/repo at its default branch, head = fork owner:branch.
 */
export async function compareBranch(
  upstreamOwner: string,
  upstreamRepo: string,
  upstreamBranch: string,
  forkOwner: string,
  branch: string
): Promise<CompareInfo> {
  const cached = cacheGet("compare", [upstreamOwner, upstreamRepo, upstreamBranch, forkOwner, branch]) as CompareInfo | undefined;
  if (cached) return cached;
  const head = encodeURIComponent(`${forkOwner}:${branch}`);
  const data = (await apiGet(
    `/repos/${upstreamOwner}/${upstreamRepo}/compare/${encodeURIComponent(upstreamBranch)}...${head}`
  )) as { ahead_by: number; behind_by: number };
  const info: CompareInfo = { aheadBy: data.ahead_by, behindBy: data.behind_by };
  cacheSet("compare", [upstreamOwner, upstreamRepo, upstreamBranch, forkOwner, branch], info);
  return info;
}

/** List open PRs on the upstream whose head is a given fork branch. */
export async function listOpenPRsFromBranch(
  upstreamOwner: string,
  upstreamRepo: string,
  forkOwner: string,
  branch: string
): Promise<LinkedPR[]> {
  const cached = cacheGet("pulls", [upstreamOwner, upstreamRepo, forkOwner, branch]) as LinkedPR[] | undefined;
  if (cached) return cached;
  const data = await paginate<Record<string, unknown>>(
    `/repos/${upstreamOwner}/${upstreamRepo}/pulls?state=open&head=${encodeURIComponent(`${forkOwner}:${branch}`)}`,
    30,
    1
  );
  const prs: LinkedPR[] = data.map((p) => ({
    number: p.number as number,
    state: "open",
    title: String(p.title ?? ""),
    url: String(p.html_url ?? ""),
    author: ((p.user as Record<string, string> | undefined)?.login ?? ""),
  }));
  cacheSet("pulls", [upstreamOwner, upstreamRepo, forkOwner, branch], prs);
  return prs;
}
