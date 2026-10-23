/**
 * claimcheck MCP server (stdio). Same engines as the CLI, exposed as tools
 * so coding agents (Claude, Cursor, Cline) can find contestable stale claims
 * and parked fixes without manual archaeology.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
} from "./github.js";
import { detectClaims, strongClaims, claimStatus } from "./claims.js";
import { classifyBranches, parkedBranches } from "./parked.js";
import type { BranchSnapshot } from "./parked.js";

const server = new McpServer({ name: "claimcheck", version: "0.1.2" });

const text = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
});

server.tool(
  "stale_claims",
  "Scan a repo's open issues for stale claims: comments where someone said they would take an issue but never opened a PR. Buckets are FRESH (<14d), WATCH (14-44d), STALE (45-89d, contestable), DEAD (90d+). Call this to find issues you can legitimately claim because the last claimant walked away.",
  {
    repo: z.string().describe("owner/repo, e.g. modelcontextprotocol/python-sdk"),
    stale_days: z.number().optional().describe("Age in days that counts as stale (default 45)"),
  },
  async ({ repo, stale_days }) => {
    try {
      const { owner, repo: repoName } = parseRepoRef(repo);
      const threshold = stale_days ?? 45;
      const issues = await listOpenIssues(owner, repoName, 30);
      const flagged: Array<Record<string, unknown>> = [];
      for (const issue of issues) {
        if (issue.commentsCount === 0) continue;
        try {
          const [comments, linkedPRs] = await Promise.all([
            fetchComments(owner, repoName, issue.number),
            fetchLinkedPRs(owner, repoName, issue.number),
          ]);
          const claims = strongClaims(detectClaims(comments, { issueAuthor: issue.author, linkedPRs }));
          for (const c of claims) {
            const stale = c.hasLinkedPR ? false : c.ageDays >= threshold;
            if (!stale) continue;
            flagged.push({
              issue: `${owner}/${repoName}#${issue.number}`,
              title: issue.title,
              url: issue.url,
              claimant: c.author,
              age_days: c.ageDays,
              bucket: c.bucket,
              phrase: c.phrase,
            });
          }
        } catch { /* skip issues that fail to load */ }
      }
      flagged.sort((a, b) => (b.age_days as number) - (a.age_days as number));
      return text({ repo, stale_threshold_days: threshold, stale_claims: flagged });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "parked_branches",
  "List parked fixes on a fork: branches ahead of the upstream default branch with no open PR. Age from the last commit: PARKED_RECENT (<7d), PARKED_STALE (7-30d), PARKED_DEAD (30d+). Call this to find finished work that never shipped.",
  {
    fork: z.string().describe("owner/fork-repo, e.g. CloudCorpRecords/pdfcn"),
  },
  async ({ fork }) => {
    try {
      const { owner, repo } = parseRepoRef(fork);
      const info = await fetchRepo(owner, repo);
      if (!info.parent) return text({ error: `${fork} is not a fork of another repo` });
      const upstream = info.parent;
      const upstreamInfo = await fetchRepo(upstream.owner, upstream.repo);
      const branches = (await listBranches(owner, repo)).filter((b) => b.name !== info.defaultBranch);
      const snapshots: BranchSnapshot[] = [];
      for (const branch of branches) {
        const [cmp, prs] = await Promise.all([
          compareBranch(upstream.owner, upstream.repo, upstreamInfo.defaultBranch, owner, branch.name),
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
      return text({ fork, upstream: `${upstream.owner}/${upstream.repo}`, parked: parkedBranches(classified), all: classified });
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

server.tool(
  "issue_claim_status",
  "Claim status of one GitHub issue: every claimant found in the comments, their age bucket, and whether a linked PR exists (work in flight). Call this before commenting on or claiming an issue.",
  {
    url: z.string().describe("Full GitHub issue URL, e.g. https://github.com/owner/repo/issues/123"),
  },
  async ({ url }) => {
    try {
      const { owner, repo, number } = parseIssueUrl(url);
      const [issueList, comments, linkedPRs] = await Promise.all([
        listOpenIssues(owner, repo, 100),
        fetchComments(owner, repo, number),
        fetchLinkedPRs(owner, repo, number),
      ]);
      const issue = issueList.find((i) => i.number === number);
      if (!issue) return text({ error: `Issue #${number} not found among open issues in ${owner}/${repo}` });
      const claims = detectClaims(comments, { issueAuthor: issue.author, linkedPRs });
      return text(claimStatus(owner, repo, number, issue.title, claims));
    } catch (err) {
      return text({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("claimcheck MCP server running on stdio");
