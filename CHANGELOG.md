# Changelog


## 0.1.4 (2026-10-25)

Test cache isolation fix (PT-2). The GitHub response cache directory is no longer fixed at load time: a new `cacheDir()` resolver honors `CLAIMCHECK_CACHE_DIR`, then the generic `CACHE_DIR`, then the default `~/.cache/claimcheck`, and is read on every cache access. The PT-2 `listBranches` test now points the cache at a per-test temp directory, so it passes with a warm or poisoned real cache, in repeated runs, and cold; before this fix it passed cold and failed warm (34/35) because a fresh `branches-pt2-owner-pt2-repo.json` in the real cache was served without any fetch. New `cacheDir` tests plus a test asserting cache files land in the isolated directory. 40 tests passing.


## 0.1.3 (2026-10-23)

Registry metadata correction release (repo health sweep). The MCP Registry's 0.1.2 listing was a phantom entry published 2026-10-18 whose package fields still pointed at the 0.1.1 npm package and the 0.1.1 GHCR image, and Registry versions are immutable, so the corrected listing ships as 0.1.3. No code changes from 0.1.2; server.json, package files, and the MCP server version string all move to 0.1.3 together. 35 tests passing.


## 0.1.2 (2026-10-23)

Real 0.1.2 release (the MCP Registry previously carried a phantom 0.1.2 entry pointing at the 0.1.1 packages). Fixes from production validation: `parked` now populates `lastCommitAt`/`ageDays` from the branch head commit (the branches API returns no date, so the head commit is fetched per branch); claim detection recognises first-person fix intent ("I'd like to fix this", "I would like to fix this", "I'll fix this", "I'd like to work on this"); GitHub API base URL can be overridden with `CLAIMCHECK_GITHUB_BASE_URL` (fallback `GITHUB_BASE_URL`) so the tool can run through a local proxy. 35 tests passing.


## 0.1.1 (2026-10-15)

Ships on npm as @reneturcios/claimcheck and in the official MCP Registry. Adds the `claimcheck mcp` subcommand so the MCP server starts from the single published bin, the form the npm package and the MCP Registry entry invoke. 23 tests passing.


## 0.1.0 (2026-10-13)

First release: stale-claim tracking for claimed issues (FRESH / WATCH / STALE / DEAD) and detection of finished fixes parked on forks that were never opened as PRs. CLI and MCP server.
