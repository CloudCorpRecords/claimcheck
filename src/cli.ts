#!/usr/bin/env node
/**
 * claimcheck CLI.
 *
 *   claimcheck claims owner/repo [--days 45] [--json]
 *   claimcheck parked owner/fork [--json]
 *   claimcheck issue <issue-url> [--json]
 *
 * Set GITHUB_TOKEN (or GH_TOKEN) for the 5000 req/hr authenticated rate limit.
 */
import {
  parseRepoRef,
  parseIssueUrl,
  listOpenIssues,
  fetchComments,
  fetchLinkedPRs,
  fetchRepo,
  listBranches,
  compareBranch,
  listOpenPRsFromBranch,
  RateLimitError,
} from "./github.js";
import { detectClaims, strongClaims, claimStatus, isStaleBucket } from "./claims.js";
import { classifyBranches, parkedBranches } from "./parked.js";
import type { BranchSnapshot } from "./parked.js";

function usage(): void {
  console.log("claimcheck: track the two ways open-source work silently dies");
  console.log("");
  console.log("  claimcheck claims owner/repo [--days 45] [--json]   scan open issues for stale claims");
  console.log("  claimcheck parked owner/fork [--json]               find finished work parked on fork branches");
  console.log("  claimcheck issue <issue-url> [--json]               claim status of one issue");
  console.log("");
  console.log("Set GITHUB_TOKEN (or GH_TOKEN) to raise the GitHub API rate limit (60 -> 5000 req/hr).");
}

function flag(name: string, args: string[]): string | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

async function cmdClaims(repoRef: string, staleThresholdDays: number, asJson: boolean): Promise<void> {
  const { owner, repo } = parseRepoRef(repoRef);
  const issues = await listOpenIssues(owner, repo, 30);
  const rows: Array<{
    issue: string;
    title: string;
    url: string;
    claimant: string;
    ageDays: number;
    bucket: string;
    phrase: string;
    stale: boolean;
  }> = [];

  for (const issue of issues) {
    if (issue.commentsCount === 0) continue;
    try {
      const [comments, linkedPRs] = await Promise.all([
        fetchComments(owner, repo, issue.number),
        fetchLinkedPRs(owner, repo, issue.number),
      ]);
      const claims = strongClaims(detectClaims(comments, { issueAuthor: issue.author, linkedPRs }));
      for (const c of claims) {
        // Respect a custom --days threshold for what counts as stale.
        const stale = staleThresholdDays !== 45 ? c.ageDays >= staleThresholdDays && !c.hasLinkedPR : c.stale;
        rows.push({
          issue: `${owner}/${repo}#${issue.number}`,
          title: issue.title,
          url: issue.url,
          claimant: c.author,
          ageDays: c.ageDays,
          bucket: c.bucket,
          phrase: c.phrase,
          stale,
        });
      }
    } catch (err) {
      rows.push({
        issue: `${owner}/${repo}#${issue.number}`,
        title: issue.title,
        url: issue.url,
        claimant: "(error)",
        ageDays: 0,
        bucket: "ERROR",
        phrase: err instanceof Error ? err.message : String(err),
        stale: false,
      });
    }
  }

  rows.sort((a, b) => b.ageDays - a.ageDays);
  const flagged = rows.filter((r) => r.stale);

  if (asJson) {
    console.log(JSON.stringify({ repo: `${owner}/${repo}`, staleThresholdDays, claims: rows, flaggedCount: flagged.length }, null, 2));
    return;
  }

  console.log(`Stale claims in ${owner}/${repo}: ${flagged.length} stale of ${rows.length} claimed issues (threshold ${staleThresholdDays}d)`);
  if (rows.length === 0) console.log("  no claim signals found on scanned issues");
  for (const r of rows) {
    const mark = r.stale ? "[STALE]" : r.bucket === "WORK_IN_FLIGHT" ? "[IN FLIGHT]" : `[${r.bucket}]`;
    console.log(`\n${mark} ${r.issue}`);
    console.log(`  ${r.title}`);
    console.log(`  ${r.url}`);
    console.log(`  claimant: ${r.claimant}, ${r.ageDays}d ago (${r.phrase})`);
  }
}

async function cmdParked(forkRef: string, asJson: boolean): Promise<void> {
  const { owner, repo } = parseRepoRef(forkRef);
  const fork = await fetchRepo(owner, repo);
  if (!fork.parent) {
    throw new Error(`${owner}/${repo} is not a fork of another repo; cannot compute parked branches without an upstream`);
  }
  const upstream = fork.parent;

  const branches = (await listBranches(owner, repo)).filter((b) => b.name !== fork.defaultBranch);
  if (branches.length === 0) {
    console.log(`No non-default branches on ${owner}/${repo}.`);
    return;
  }

  const snapshots: BranchSnapshot[] = [];
  for (const branch of branches) {
    const [cmp, prs] = await Promise.all([
      compareBranch(upstream.owner, upstream.repo, (await fetchUpstreamDefault(upstream)), owner, branch.name),
      listOpenPRsFromBranch(upstream.owner, upstream.repo, owner, branch.name),
    ]);
    snapshots.push({
      name: branch.name,
      aheadBy: cmp.aheadBy,
      behindBy: cmp.behindBy,
      lastCommitAt: branch.lastCommitAt,
      openPRs: prs.map((p) => ({ number: p.number, title: p.title, url: p.url })),
    });
  }

  const classified = classifyBranches(snapshots);
  const parked = parkedBranches(classified);

  if (asJson) {
    console.log(JSON.stringify({ fork: `${owner}/${repo}`, upstream: `${upstream.owner}/${upstream.repo}`, branches: classified, parkedCount: parked.length }, null, 2));
    return;
  }

  console.log(`Parked branches on ${owner}/${repo} (upstream ${upstream.owner}/${upstream.repo}): ${parked.length} parked of ${classified.length} branches`);
  for (const b of classified) {
    if (!b.parked) continue;
    console.log(`\n[${b.verdict}] ${b.name}`);
    console.log(`  ahead by ${b.aheadBy} commit(s), last commit ${b.ageDays}d ago`);
    console.log(`  no open PR on upstream`);
  }
  if (parked.length === 0) console.log("  nothing parked: every branch is even or has an open PR");
}

const upstreamDefaultCache = new Map<string, string>();
async function fetchUpstreamDefault(upstream: { owner: string; repo: string }): Promise<string> {
  const key = `${upstream.owner}/${upstream.repo}`;
  const cached = upstreamDefaultCache.get(key);
  if (cached) return cached;
  const info = await fetchRepo(upstream.owner, upstream.repo);
  upstreamDefaultCache.set(key, info.defaultBranch);
  return info.defaultBranch;
}

async function cmdIssue(issueUrl: string, asJson: boolean): Promise<void> {
  const { owner, repo, number } = parseIssueUrl(issueUrl);
  const [issueList, comments, linkedPRs] = await Promise.all([
    listOpenIssues(owner, repo, 100),
    fetchComments(owner, repo, number),
    fetchLinkedPRs(owner, repo, number),
  ]);
  const issue = issueList.find((i) => i.number === number);
  if (!issue) throw new Error(`Issue #${number} not found among open issues in ${owner}/${repo} (it may be closed or assigned)`);
  const claims = detectClaims(comments, { issueAuthor: issue.author, linkedPRs });
  const status = claimStatus(owner, repo, number, issue.title, claims);

  if (asJson) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(`${status.issue} ${isStaleBucket(status.strongest?.bucket ?? "FRESH") ? "[STALE CLAIM]" : ""}`);
  console.log(`  ${status.title}`);
  console.log(`  ${status.summary}`);
  if (claims.length === 0) console.log("  no claim signals in comments");
  for (const c of claims) {
    console.log(`  - ${c.author}: ${c.ageDays}d ago (${c.phrase}), ${c.bucket}${c.hasLinkedPR ? ", PR linked" : ""}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const clean: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") continue;
    if (args[i] === "--days") { i++; continue; }
    clean.push(args[i]);
  }
  const [command, target] = clean;
  const daysFlag = flag("--days", args);
  const staleThresholdDays = daysFlag !== undefined ? Number(daysFlag) : 45;

  try {
    if (command === "claims" && target) return await cmdClaims(target, staleThresholdDays, asJson);
    if (command === "parked" && target) return await cmdParked(target, asJson);
    if (command === "issue" && target) return await cmdIssue(target, asJson);
    usage();
    process.exitCode = command ? 1 : 0;
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.error(`Rate limited: ${err.message}`);
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

await main();
