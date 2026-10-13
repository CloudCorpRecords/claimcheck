/**
 * Parked-fix detection engine (pure, testable offline).
 *
 * A parked fix is finished work sitting on a fork branch that never became
 * a PR. A branch is PARKED when it is ahead of the upstream default branch
 * by 1+ commits and has no open PR. Age comes from the branch tip commit
 * date: PARKED_RECENT (<7d), PARKED_STALE (7-30d), PARKED_DEAD (30d+).
 * Branches even with upstream are EVEN, branches with an open PR are IN_PR.
 */
export type BranchVerdict = "PARKED_RECENT" | "PARKED_STALE" | "PARKED_DEAD" | "EVEN" | "IN_PR";

export interface BranchSnapshot {
  name: string;
  aheadBy: number;
  behindBy: number;
  lastCommitAt: string;
  openPRs: Array<{ number: number; title: string; url: string }>;
}

export interface ParkedBranch {
  name: string;
  aheadBy: number;
  behindBy: number;
  lastCommitAt: string;
  ageDays: number;
  verdict: BranchVerdict;
  openPRs: Array<{ number: number; title: string; url: string }>;
  parked: boolean;
}

export const PARKED_RECENT_DAYS = 7;
export const PARKED_DEAD_DAYS = 30;

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24)));
}

/** Classify one branch from compare data and its open PRs. */
export function classifyBranch(snapshot: BranchSnapshot, now: Date = new Date()): ParkedBranch {
  const ageDays = snapshot.lastCommitAt ? daysBetween(new Date(snapshot.lastCommitAt), now) : 0;
  const parkedBranch: ParkedBranch = {
    name: snapshot.name,
    aheadBy: snapshot.aheadBy,
    behindBy: snapshot.behindBy,
    lastCommitAt: snapshot.lastCommitAt,
    ageDays,
    verdict: "EVEN",
    openPRs: snapshot.openPRs,
    parked: false,
  };

  if (snapshot.openPRs.length > 0) {
    parkedBranch.verdict = "IN_PR";
    return parkedBranch;
  }
  if (snapshot.aheadBy <= 0) {
    parkedBranch.verdict = "EVEN";
    return parkedBranch;
  }

  parkedBranch.parked = true;
  if (ageDays < PARKED_RECENT_DAYS) {
    parkedBranch.verdict = "PARKED_RECENT";
  } else if (ageDays < PARKED_DEAD_DAYS) {
    parkedBranch.verdict = "PARKED_STALE";
  } else {
    parkedBranch.verdict = "PARKED_DEAD";
  }
  return parkedBranch;
}

/** Classify every branch and return parked ones first, oldest last-commit first. */
export function classifyBranches(snapshots: BranchSnapshot[], now: Date = new Date()): ParkedBranch[] {
  const results = snapshots.map((s) => classifyBranch(s, now));
  const rank: Record<BranchVerdict, number> = {
    PARKED_DEAD: 0,
    PARKED_STALE: 1,
    PARKED_RECENT: 2,
    IN_PR: 3,
    EVEN: 4,
  };
  return results.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9) || b.ageDays - a.ageDays);
}

/** Parked branches only. */
export function parkedBranches(branches: ParkedBranch[]): ParkedBranch[] {
  return branches.filter((b) => b.parked);
}
