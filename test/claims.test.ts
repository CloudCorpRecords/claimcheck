import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectClaims,
  strongClaims,
  claimBucket,
  isStaleBucket,
  claimStatus,
  isBotAuthor,
  FRESH_DAYS,
  WATCH_DAYS,
  STALE_DAYS,
} from "../src/claims.js";
import type { CommentSignal, LinkedPR } from "../src/github.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

const NOW = new Date("2026-10-13T00:00:00Z");
const comment = (author: string, body: string, createdAt = "2026-10-01T00:00:00Z"): CommentSignal => ({
  author,
  body,
  createdAt,
});

describe("claim detection variants", () => {
  it("detects an explicit claim", () => {
    const claims = detectClaims([comment("alice", "I'd like to take this one. Can I work on this?")], {
      issueAuthor: "opener",
      now: NOW,
    });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].author, "alice");
    assert.equal(claims[0].strength, "strong");
    assert.equal(claims[0].phrase, "want-to-work");
  });

  it("detects assignment requests", () => {
    const claims = detectClaims([comment("bob", "Please assign this to me, happy to help")], {
      issueAuthor: "opener",
      now: NOW,
    });
    assert.equal(claims[0].strength, "strong");
    assert.equal(claims[0].phrase, "please-assign");
  });

  it("detects work intentions", () => {
    const claims = detectClaims([comment("carol", "I've started working on this, PR incoming soon")], {
      issueAuthor: "opener",
      now: NOW,
    });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].strength, "strong");
  });

  it("records soft interest without counting it as a claim", () => {
    const claims = detectClaims([comment("dave", "This looks interesting, happy to help if needed")], {
      issueAuthor: "opener",
      now: NOW,
    });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].strength, "soft");
    assert.equal(strongClaims(claims).length, 0);
  });

  it("ignores comments with no claim signal", () => {
    const claims = detectClaims([comment("erin", "+1, this is blocking my project too")], {
      issueAuthor: "opener",
      now: NOW,
    });
    assert.equal(claims.length, 0);
  });
});

describe("author exclusions", () => {
  it("skips the issue author unless they announce real work", () => {
    const claims = detectClaims([comment("opener", "I would like to take this on")], {
      issueAuthor: "opener",
      now: NOW,
    });
    assert.equal(claims.length, 0);
  });

  it("keeps the issue author when they announce a PR", () => {
    const claims = detectClaims([comment("opener", "I've opened a PR for this")], {
      issueAuthor: "opener",
      now: NOW,
    });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].phrase, "pr-opened");
  });

  it("skips bot authors", () => {
    const claims = detectClaims(
      [
        comment("github-actions[bot]", "I'd like to take this one"),
        comment("dependabot", "I'd like to take this one"),
      ],
      { issueAuthor: "opener", now: NOW }
    );
    assert.equal(claims.length, 0);
    assert.ok(isBotAuthor("github-actions[bot]"));
    assert.ok(!isBotAuthor("human-dev"));
  });

  it("skips maintainers: their claim is triage, not a contestable claim", () => {
    const claims = detectClaims([comment("maintainer-sam", "I'll take this one, assigning myself")], {
      issueAuthor: "opener",
      maintainers: new Set(["maintainer-sam"]),
      now: NOW,
    });
    assert.equal(claims.length, 0);
  });
});

describe("aging buckets", () => {
  it("buckets claims by age with correct boundaries", () => {
    assert.equal(claimBucket(0, false), "FRESH");
    assert.equal(claimBucket(FRESH_DAYS - 1, false), "FRESH");
    assert.equal(claimBucket(FRESH_DAYS, false), "WATCH");
    assert.equal(claimBucket(WATCH_DAYS - 1, false), "WATCH");
    assert.equal(claimBucket(WATCH_DAYS, false), "STALE");
    assert.equal(claimBucket(STALE_DAYS - 1, false), "STALE");
    assert.equal(claimBucket(STALE_DAYS, false), "DEAD");
  });

  it("a linked PR always beats age: WORK_IN_FLIGHT", () => {
    assert.equal(claimBucket(200, true), "WORK_IN_FLIGHT");
  });

  it("only STALE and DEAD count as stale", () => {
    assert.ok(!isStaleBucket("FRESH"));
    assert.ok(!isStaleBucket("WATCH"));
    assert.ok(!isStaleBucket("WORK_IN_FLIGHT"));
    assert.ok(isStaleBucket("STALE"));
    assert.ok(isStaleBucket("DEAD"));
  });
});

describe("fixtures", () => {
  it("python-sdk#3287-like claim: claimed 2026-08-11, no PR 63 days later => STALE", () => {
    const f = fixture("stale-claim.json");
    const claims = strongClaims(
      detectClaims(f.comments, {
        issueAuthor: f.issueAuthor,
        maintainers: new Set<string>(f.maintainers),
        linkedPRs: f.linkedPRs as LinkedPR[],
        now: new Date(f.now),
      })
    );
    assert.equal(claims.length, 1);
    assert.equal(claims[0].author, "helpfuldev");
    assert.equal(claims[0].ageDays, 63);
    assert.equal(claims[0].bucket, "STALE");
    assert.ok(claims[0].stale);
    // Maintainer and bot comments are excluded.
    const all = detectClaims(f.comments, {
      issueAuthor: f.issueAuthor,
      maintainers: new Set<string>(f.maintainers),
      now: new Date(f.now),
    });
    assert.ok(!all.some((c) => c.author === "maintainer-sam"));
    assert.ok(!all.some((c) => c.author === "github-actions[bot]"));
  });

  it("fresh claim with a linked open PR is never stale: work in flight", () => {
    const f = fixture("fresh-claim-with-pr.json");
    const claims = strongClaims(
      detectClaims(f.comments, {
        issueAuthor: f.issueAuthor,
        linkedPRs: f.linkedPRs as LinkedPR[],
        now: new Date(f.now),
      })
    );
    assert.equal(claims.length, 1);
    assert.equal(claims[0].bucket, "WORK_IN_FLIGHT");
    assert.ok(!claims[0].stale);
    assert.ok(claims[0].hasLinkedPR);
  });

  it("claimStatus summarizes stale, in-flight, and unclaimed issues", () => {
    const stale = claimStatus("o", "r", 1, "Title", [
      { author: "x", createdAt: "", ageDays: 63, strength: "strong", phrase: "explicit-claim", bucket: "STALE", hasLinkedPR: false, stale: true },
    ]);
    assert.ok(stale.summary.includes("contestable"));
    const flight = claimStatus("o", "r", 2, "Title", [
      { author: "y", createdAt: "", ageDays: 5, strength: "strong", phrase: "explicit-claim", bucket: "WORK_IN_FLIGHT", hasLinkedPR: true, stale: false },
    ]);
    assert.ok(flight.summary.includes("work in flight"));
    const none = claimStatus("o", "r", 3, "Title", []);
    assert.ok(none.summary.includes("no claims"));
  });
});
