# robots-guard

Fork-only addition: makes every request career-ops sends obey the target site's
`robots.txt` (RFC 9309, cautious reading).

| File | Holds |
|------|-------|
| `robots-rules.mjs` | parsing and the allow/disallow decision |
| `robots-fetch.mjs` | fetching robots.txt and the 24-hour disk cache |
| `robots-guard.mjs` | the guard (status-code policy, Crawl-delay), `fetch()` wrapper, hook and CLI |
| `robots-modules.mjs` | the same guard for undici's own fetch and for Playwright browsers, patched in when a script loads them |
| `preload.mjs` | `--import` entry that installs all of the above |

| Use | Command |
|-----|---------|
| Guard every request of a script (`fetch()`, undici, Playwright page loads) | `node --import ./robots-guard/preload.mjs scan.mjs` |
| Check one URL | `node robots-guard/robots-guard.mjs check <url>` (exit 0 allowed, 1 disallowed) |
| Guard Claude Code's WebFetch, browser tools, and `curl`/`wget`/browser-CLI commands | PreToolUse hook running `node robots-guard/robots-guard.mjs hook` (wired in `.claude/settings.json`) |
| Test | `node --test tests/robots-guard.test.mjs tests/robots-guard-modules.test.mjs` (also run by `node test-all.mjs`) |

A blocked request fails with `RobotsDisallowedError` (`code: 'ROBOTS_DISALLOWED'`)
and one `[robots-guard] blocked …` line on stderr per site and rule. Answers are
cached for 24 hours in `~/.cache/robots-guard`. Environment variables are listed in
the module header.
