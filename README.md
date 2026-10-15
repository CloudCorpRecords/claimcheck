# claimcheck

Two quiet ways open-source work dies, tracked before they cost you weeks:

1. **Stale claims.** Someone comments "I'll take this" on an issue, then vanishes. The issue still shows "unassigned," so the next volunteer writes code that collides with a ghost.
2. **Parked fixes.** Finished work sitting on a fork branch that never became a PR. Real commits, real diffs, zero visibility.

claimcheck scans for both. It is the follow-up to [greenlight](https://github.com/CloudCorpRecords/greenlight): greenlight asks "is this issue landable?", claimcheck asks "did everyone who said yes actually show up, and did their work ever ship?"

## Install

```bash
npm install -g @reneturcios/claimcheck
# or
npx @reneturcios/claimcheck claims owner/repo
```

Needs Node 20+. Set `GITHUB_TOKEN` (or `GH_TOKEN`) for the 5000 req/hr authenticated rate limit; without it you get 60 req/hr. Responses are cached in `~/.cache/claimcheck`.

## CLI

### Find stale claims in a repo

```bash
claimcheck claims modelcontextprotocol/python-sdk
```

Scans open unassigned issues, detects claim comments (explicit claims, work intentions, assignment requests; bots, maintainers, and the issue author are excluded), checks whether a linked PR ever appeared, and ranks the results with the oldest claims first:

```
Stale claims in modelcontextprotocol/python-sdk: 2 stale of 5 claimed issues (threshold 45d)

[STALE] modelcontextprotocol/python-sdk#3287
  Fix: handle empty result sets
  https://github.com/modelcontextprotocol/python-sdk/issues/3287
  claimant: helpfuldev, 63d ago (want-to-work)

[IN FLIGHT] modelcontextprotocol/python-sdk#3290
  ...
  claimant: shipitdev, 5d ago (explicit-claim)
```

Flags: `--days 45` changes the stale threshold, `--json` prints machine output.

**Claim age buckets**

| Bucket | Age | Meaning |
|---|---|---|
| FRESH | <14 days | Claimant probably still active |
| WATCH | 14 to 44 days | Check before duplicating work |
| STALE | 45 to 89 days | Contestable, likely abandoned |
| DEAD | 90+ days | Almost certainly abandoned |
| WORK_IN_FLIGHT | any | A linked PR exists, the work is real |

### Find parked fixes on a fork

```bash
claimcheck parked CloudCorpRecords/pdfcn
```

Lists branches on a fork (excluding the default branch), compares each against the upstream default branch, and checks for open PRs from that fork. A branch ahead by 1+ commits with no open PR is PARKED:

```
Parked branches on CloudCorpRecords/pdfcn (upstream shadcn-labs/pdfcn): 1 parked of 4 branches

[PARKED_STALE] fix-typos
  ahead by 5 commit(s), last commit 20d ago
  no open PR on upstream
```

**Parked age buckets** (from the branch tip commit date)

| Verdict | Age | Meaning |
|---|---|---|
| PARKED_RECENT | <7 days | Probably still being finished |
| PARKED_STALE | 7 to 30 days | Likely forgotten, easy to revive |
| PARKED_DEAD | 30+ days | May need rebasing onto upstream |

Branches with an open PR show as IN_PR, branches even with upstream as EVEN. Neither is parked.

### Claim status of one issue

```bash
claimcheck issue https://github.com/modelcontextprotocol/python-sdk/issues/3287
```

Every claimant found in the comments, their age bucket, and whether a linked PR exists.

## MCP server

The same engines as tools, for agents that should check before they comment or code:

```json
{
  "mcpServers": {
    "claimcheck": {
      "command": "npx",
      "args": ["-y", "claimcheck", "mcp"],
      "env": { "GITHUB_TOKEN": "ghp_your_token_here" }
    }
  }
}
```

| Tool | Input | Returns |
|---|---|---|
| `stale_claims` | `repo` (owner/repo), optional `stale_days` | Ranked stale claims, oldest first |
| `parked_branches` | `fork` (owner/repo) | Parked branches with compare data, plus all branches |
| `issue_claim_status` | `url` (issue URL) | Claimants, age buckets, linked PRs, summary |

Or run the server directly: `npx @reneturcios/claimcheck mcp` (stdio).

## How detection works

Claim heuristics (clean reimplementation of the patterns proven in greenlight's dogfooding):

- **Strong claims:** "I'd like to take this", "please assign it to me", "I'm working on this", "I've started working on this", "PR incoming", and similar.
- **Soft interest:** "happy to help", "interested in this", "looking into this". Recorded, never treated as a claim.
- **Excluded:** bot accounts, repo maintainers (their "I'll take this" is triage, not a contestable claim), and the issue author unless they announce a real PR.

A claim with any linked PR is WORK_IN_FLIGHT at any age: the claimant did the work, it just has not landed yet. Only PR-less claims age into STALE and DEAD.

## Development

```bash
npm install
npm test        # 23 offline tests, node:test via tsx
npm run build   # tsc to dist/
```

Engines (`src/claims.ts`, `src/parked.ts`) are pure functions over fetched data, fully testable offline against fixtures in `test/fixtures/`. `src/github.ts` holds the REST client (issues, comments, PR search, branches, compare, fork info) with file caching.

## License

MIT, Rene Turcios 2026.

## The toolkit

This tool is one of four in a lifecycle for open-source contribution work, all published under the `@reneturcios` npm scope and each available as a CLI and an MCP server (`<tool> mcp`):

1. **gatefile** (`npx @reneturcios/gatefile`) extracts a repo's contribution gates into a committed `contribution-gates.json`.
2. **greenlight** (`npx @reneturcios/greenlight`) pre-flights issues (GO / RISKY / TAKEN / GATED / STALE), consumes gatefile's output in `check` and `scan`, then claims, preps, and opens PRs.
3. **claimcheck** (`npx @reneturcios/claimcheck`) watches for stale claims and fixes parked on forks.
4. **prwatch** (`npx @reneturcios/prwatch`) triages your open PRs by what needs you right now.
