/**
 * Stale-claim detection engine (pure, testable offline).
 *
 * A stale claim is an "I'll take this" comment that never turned into a PR.
 * Claims age through buckets: FRESH (<14d), WATCH (14-44d),
 * STALE (45-89d, contestable), DEAD (90d+, almost certainly abandoned).
 * A claim with any linked PR is WORK_IN_FLIGHT instead of a bucket:
 * the claimant did the work, it just has not landed yet.
 */
import type { CommentSignal, LinkedPR } from "./github.js";

export type ClaimBucket = "FRESH" | "WATCH" | "STALE" | "DEAD" | "WORK_IN_FLIGHT";

export interface ClaimSignal {
  author: string;
  createdAt: string;
  ageDays: number;
  strength: "strong" | "soft";
  phrase: string;
  bucket: ClaimBucket;
  hasLinkedPR: boolean;
  stale: boolean;
}

interface ClaimPattern {
  name: string;
  regex: RegExp;
  strength: "strong" | "soft";
}

// Strong: explicit claim of work or a concrete "I am doing it" statement.
const STRONG_PATTERNS: ClaimPattern[] = [
  { name: "explicit-claim", regex: /i would like to (work on|take|handle) this/i, strength: "strong" },
  { name: "please-assign", regex: /please assign (this|it|me)/i, strength: "strong" },
  { name: "assign-to-me", regex: /\bassign (it |this )?to me\b/i, strength: "strong" },
  { name: "assign-request", regex: /\bassign me\b/i, strength: "strong" },
  { name: "will-take", regex: /i (will|shall) (take|work on|handle) this/i, strength: "strong" },
  { name: "working-on", regex: /i('| a)m (currently |now )?working on this/i, strength: "strong" },
  { name: "taking-it", regex: /\btak(e|ing) this (on|up)\b/i, strength: "strong" },
  { name: "pr-opened", regex: /i('ve| have) opened (a |the )?pr\b/i, strength: "strong" },
  { name: "fix-ready", regex: /\bfix (is )?ready\b/i, strength: "strong" },
  { name: "fix-in-progress", regex: /\bfix is in progress\b/i, strength: "strong" },
  { name: "pr-incoming", regex: /\bpr (is |will be |to be )?(incoming|coming|ready|prepared)\b/i, strength: "strong" },
  { name: "started-work", regex: /\bi('ve| have) started (working )?on this/i, strength: "strong" },
  { name: "want-to-work", regex: /i('d| would) like to (take|pick) (this|it) (on|up)/i, strength: "strong" },
];

// Soft: interest or an offer, not a claim. Recorded for context, never a verdict.
const SOFT_PATTERNS: ClaimPattern[] = [
  { name: "soft-offer", regex: /happy to (fix|work|help|take)/i, strength: "soft" },
  { name: "can-take", regex: /i can take this/i, strength: "soft" },
  { name: "interested", regex: /\binterested in (working on|taking|this)\b/i, strength: "soft" },
  { name: "looking-into", regex: /\blooking into this\b/i, strength: "soft" },
  { name: "have-fork", regex: /\b(my fork|on my fork|branch on my fork)\b/i, strength: "soft" },
];

const ALL_PATTERNS = [...STRONG_PATTERNS, ...SOFT_PATTERNS];

// Authors that are bots, not humans claiming work.
const BOT_NAME_PATTERNS = [
  /\[bot\]$/i,
  /^dependabot/i,
  /^github-actions/i,
  /sweeper/i,
  /open-swe/i,
  /yolo\d*-bot/i,
  /claw-bot/i,
];

export function isBotAuthor(login: string): boolean {
  return BOT_NAME_PATTERNS.some((re) => re.test(login));
}

export const FRESH_DAYS = 14;
export const WATCH_DAYS = 45;
export const STALE_DAYS = 90;

/** Age a claim into a bucket. Any linked PR means the work exists: WORK_IN_FLIGHT. */
export function claimBucket(ageDays: number, hasLinkedPR: boolean): ClaimBucket {
  if (hasLinkedPR) return "WORK_IN_FLIGHT";
  if (ageDays < FRESH_DAYS) return "FRESH";
  if (ageDays < WATCH_DAYS) return "WATCH";
  if (ageDays < STALE_DAYS) return "STALE";
  return "DEAD";
}

/** A claim counts as stale (contestable or worse) at WATCH_DAYS. */
export function isStaleBucket(bucket: ClaimBucket): boolean {
  return bucket === "STALE" || bucket === "DEAD";
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)));
}

export interface DetectClaimsOptions {
  issueAuthor: string;
  maintainers?: Set<string>;
  linkedPRs?: LinkedPR[];
  now?: Date;
  staleThresholdDays?: number;
}

/**
 * Scan comments for claim signals. Skips bots, the issue author (unless they
 * announce a ready/in-progress fix), and repo maintainers (a maintainer's
 * "I'll take this" is triage, not a claim that can go stale). Returns at most
 * one signal per author, keeping the strongest match.
 */
export function detectClaims(
  comments: CommentSignal[],
  opts: DetectClaimsOptions
): ClaimSignal[] {
  const now = opts.now ?? new Date();
  const maintainers = opts.maintainers ?? new Set<string>();
  const linked = opts.linkedPRs ?? [];
  const byAuthor = new Map<string, ClaimSignal>();

  for (const comment of comments) {
    const author = comment.author;
    if (isBotAuthor(author)) continue;
    if (maintainers.has(author)) continue;

    let matched: ClaimPattern | undefined;
    for (const pattern of ALL_PATTERNS) {
      if (pattern.regex.test(comment.body)) {
        matched = pattern;
        break; // strong patterns come first, so first match wins
      }
    }
    if (!matched) continue;

    // Skip the issue author unless they announce real work in progress.
    if (
      author === opts.issueAuthor &&
      matched.name !== "fix-ready" &&
      matched.name !== "fix-in-progress" &&
      matched.name !== "pr-opened"
    ) {
      continue;
    }

    const ageDays = daysBetween(new Date(comment.createdAt), now);
    const hasLinkedPR = linked.some((pr) => pr.author === author) || linked.length > 0;
    const bucket = claimBucket(ageDays, hasLinkedPR);
    const existing = byAuthor.get(author);
    const signal: ClaimSignal = {
      author,
      createdAt: comment.createdAt,
      ageDays,
      strength: matched.strength,
      phrase: matched.name,
      bucket,
      hasLinkedPR,
      stale: isStaleBucket(bucket),
    };
    if (!existing) {
      byAuthor.set(author, signal);
    } else if (existing.strength === "soft" && signal.strength === "strong") {
      byAuthor.set(author, signal);
    }
  }

  return [...byAuthor.values()].sort((a, b) => b.ageDays - a.ageDays);
}

/** Strong claims only, oldest first. */
export function strongClaims(claims: ClaimSignal[]): ClaimSignal[] {
  return claims.filter((c) => c.strength === "strong");
}

export interface ClaimStatus {
  issue: string;
  number: number;
  title: string;
  claims: ClaimSignal[];
  strongest: ClaimSignal | undefined;
  summary: string;
}

/**
 * Summarize the claim status of a single issue for the `issue` command and
 * the issue_claim_status MCP tool.
 */
export function claimStatus(
  owner: string,
  repo: string,
  number: number,
  title: string,
  claims: ClaimSignal[]
): ClaimStatus {
  const strong = strongClaims(claims);
  const strongest = strong[0];
  let summary: string;
  if (!strongest) {
    summary = "no claims on this issue";
  } else if (strongest.bucket === "WORK_IN_FLIGHT") {
    summary = `${strongest.author} claimed ${strongest.ageDays} day(s) ago and a PR exists: work in flight`;
  } else if (isStaleBucket(strongest.bucket)) {
    summary = `${strongest.author} claimed ${strongest.ageDays} day(s) ago with no PR: ${strongest.bucket}, contestable`;
  } else {
    summary = `${strongest.author} claimed ${strongest.ageDays} day(s) ago: ${strongest.bucket}`;
  }
  return {
    issue: `${owner}/${repo}#${number}`,
    number,
    title,
    claims,
    strongest,
    summary,
  };
}
