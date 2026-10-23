import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { githubApiBase, listBranches } from "../src/github.js";

const ENV_KEYS = ["CLAIMCHECK_GITHUB_BASE_URL", "GITHUB_BASE_URL"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("githubApiBase (PT-1)", () => {
  it("defaults to https://api.github.com", () => {
    assert.equal(githubApiBase(), "https://api.github.com");
  });

  it("honors CLAIMCHECK_GITHUB_BASE_URL", () => {
    process.env.CLAIMCHECK_GITHUB_BASE_URL = "http://127.0.0.1:8792";
    assert.equal(githubApiBase(), "http://127.0.0.1:8792");
  });

  it("falls back to GITHUB_BASE_URL", () => {
    process.env.GITHUB_BASE_URL = "http://127.0.0.1:9999";
    assert.equal(githubApiBase(), "http://127.0.0.1:9999");
  });

  it("tool-specific env wins over the generic fallback", () => {
    process.env.CLAIMCHECK_GITHUB_BASE_URL = "http://127.0.0.1:8792";
    process.env.GITHUB_BASE_URL = "http://127.0.0.1:9999";
    assert.equal(githubApiBase(), "http://127.0.0.1:8792");
  });

  it("strips trailing slashes", () => {
    process.env.CLAIMCHECK_GITHUB_BASE_URL = "http://127.0.0.1:8792/";
    assert.equal(githubApiBase(), "http://127.0.0.1:8792");
  });
});

describe("listBranches populates lastCommitAt from the commits API (PT-2)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("fills lastCommitAt/age data from the branch head commit, via the configured base URL", async () => {
    process.env.CLAIMCHECK_GITHUB_BASE_URL = "http://proxy.invalid:8792";
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      seen.push(u);
      const json = (data: unknown) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => data,
        text: async () => JSON.stringify(data),
      });
      if (u.includes("/branches")) {
        // Real GitHub branches API shape: commit carries sha + url only, no date.
        return json([
          { name: "fix/thing", commit: { sha: "abc123", url: "https://api.github.com/repos/o/r/commits/abc123" }, protected: false },
        ]);
      }
      if (u.includes("/commits/abc123")) {
        return json({
          sha: "abc123",
          commit: {
            author: { name: "Dev", date: "2026-10-20T21:21:07Z" },
            committer: { name: "Dev", date: "2026-10-20T21:21:07Z" },
            message: "fix: thing",
          },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;

    const branches = await listBranches("pt2-owner", "pt2-repo");
    assert.equal(branches.length, 1);
    assert.equal(branches[0].name, "fix/thing");
    assert.equal(branches[0].sha, "abc123");
    assert.equal(branches[0].lastCommitAt, "2026-10-20T21:21:07Z");
    assert.ok(seen.length >= 2, "expected a follow-up commits request");
    assert.ok(seen.every((u) => u.startsWith("http://proxy.invalid:8792")), `base URL not honored: ${seen.join(", ")}`);
  });
});
