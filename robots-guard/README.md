# robots-guard

Fork-only addition: makes every request career-ops sends obey the target site's
`robots.txt` (RFC 9309, cautious reading — see the header of `robots-guard.mjs`).

| Use | Command |
|-----|---------|
| Guard every `fetch()` of a script | `node --import ./robots-guard/preload.mjs scan.mjs` |
| Check one URL | `node robots-guard/robots-guard.mjs check <url>` (exit 0 allowed, 1 disallowed) |
| Guard Claude Code's WebFetch, browser tools and `curl`/`wget` commands | PreToolUse hook running `node robots-guard/robots-guard.mjs hook` |
| Test | `node --test robots-guard/*.test.mjs` |

A blocked request fails with `RobotsDisallowedError` (`code: 'ROBOTS_DISALLOWED'`)
and one `[robots-guard] blocked …` line on stderr per site and rule. Answers are
cached for 24 hours in `~/.cache/robots-guard`. Environment variables are listed in
the module header.
