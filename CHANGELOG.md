# Changelog


## 0.1.2 (2026-10-23)

Real 0.1.2 release (the MCP Registry previously carried a phantom 0.1.2 entry pointing at the 0.1.1 packages). Fixes from production validation: `parked` now populates `lastCommitAt`/`ageDays` from the branch head commit (the branches API returns no date, so the head commit is fetched per branch); claim detection recognises first-person fix intent ("I'd like to fix this", "I would like to fix this", "I'll fix this", "I'd like to work on this"); GitHub API base URL can be overridden with `CLAIMCHECK_GITHUB_BASE_URL` (fallback `GITHUB_BASE_URL`) so the tool can run through a local proxy. 35 tests passing.


## 0.1.1 (2026-10-15)

Ships on npm as @reneturcios/claimcheck and in the official MCP Registry. Adds the `claimcheck mcp` subcommand so the MCP server starts from the single published bin, the form the npm package and the MCP Registry entry invoke. 23 tests passing.


## 0.1.0 (2026-10-13)

First release: stale-claim tracking for claimed issues (FRESH / WATCH / STALE / DEAD) and detection of finished fixes parked on forks that were never opened as PRs. CLI and MCP server.
