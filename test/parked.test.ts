import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyBranch, classifyBranches, parkedBranches, PARKED_RECENT_DAYS, PARKED_DEAD_DAYS } from "../src/parked.js";
import type { BranchSnapshot } from "../src/parked.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

const NOW = new Date("2026-10-13T00:00:00Z");
const branch = (name: string, aheadBy: number, daysAgo: number, openPRs: BranchSnapshot["openPRs"] = []): BranchSnapshot => ({
  name,
  aheadBy,
  behindBy: 0,
  lastCommitAt: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  openPRs,
});

describe("parked classification", () => {
  it("a branch with an open PR is IN_PR, not parked", () => {
    const b = classifyBranch(
      branch("feature-search", 3, 3, [{ number: 12, title: "Add search", url: "https://x/12" }]),
      NOW
    );
    assert.equal(b.verdict, "IN_PR");
    assert.ok(!b.parked);
  });

  it("a branch even with upstream is EVEN, not parked", () => {
    const b = classifyBranch(branch("old-experiment", 0, 120), NOW);
    assert.equal(b.verdict, "EVEN");
    assert.ok(!b.parked);
  });

  it("a branch ahead with no PR and recent work is PARKED_RECENT", () => {
    const b = classifyBranch(branch("fix-login", 5, 2), NOW);
    assert.equal(b.verdict, "PARKED_RECENT");
    assert.ok(b.parked);
    assert.equal(b.aheadBy, 5);
    assert.equal(b.ageDays, 2);
  });

  it("a branch ahead 20d with no PR is PARKED_STALE", () => {
    const b = classifyBranch(branch("fix-typos", 5, 20), NOW);
    assert.equal(b.verdict, "PARKED_STALE");
    assert.ok(b.parked);
  });

  it("a branch ahead 60d with no PR is PARKED_DEAD", () => {
    const b = classifyBranch(branch("ancient-work", 5, 60), NOW);
    assert.equal(b.verdict, "PARKED_DEAD");
    assert.ok(b.parked);
  });

  it("age boundaries: 7d is STALE, 30d is DEAD", () => {
    assert.equal(classifyBranch(branch("a", 1, PARKED_RECENT_DAYS - 1), NOW).verdict, "PARKED_RECENT");
    assert.equal(classifyBranch(branch("a", 1, PARKED_RECENT_DAYS), NOW).verdict, "PARKED_STALE");
    assert.equal(classifyBranch(branch("a", 1, PARKED_DEAD_DAYS - 1), NOW).verdict, "PARKED_STALE");
    assert.equal(classifyBranch(branch("a", 1, PARKED_DEAD_DAYS), NOW).verdict, "PARKED_DEAD");
  });

  it("an open PR beats even a very old parked branch", () => {
    const b = classifyBranch(
      branch("slow-but-alive", 8, 200, [{ number: 99, title: "Slow PR", url: "https://x/99" }]),
      NOW
    );
    assert.equal(b.verdict, "IN_PR");
  });
});

describe("fixture: fork with three branches", () => {
  it("classifies each branch as expected and ranks parked first", () => {
    const f = fixture("fork-branches.json");
    const now = new Date(f.now);
    const classified = classifyBranches(f.branches as BranchSnapshot[], now);
    const byName = Object.fromEntries(classified.map((b) => [b.name, b]));

    assert.equal(byName["feature-search"].verdict, "IN_PR");
    assert.equal(byName["fix-typos"].verdict, "PARKED_STALE");
    assert.equal(byName["old-experiment"].verdict, "EVEN");

    const parked = parkedBranches(classified);
    assert.equal(parked.length, 1);
    assert.equal(parked[0].name, "fix-typos");
    assert.equal(parked[0].ageDays, 20);

    // Parked first in ranking, oldest first among parked.
    assert.equal(classified[0].name, "fix-typos");
  });
});
