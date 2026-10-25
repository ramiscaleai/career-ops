// robots-guard.mjs: never request a URL that the site's robots.txt disallows.
//
// Rules follow RFC 9309, on the cautious side (the same choices as
// ai-job-search's tools/robots_check.py, MIT):
//   - the group for our bot AND the group for all bots ("*") both apply;
//     a Disallow in either one blocks the request
//   - the longest matching rule wins; on a tie, Disallow wins
//   - a missing robots.txt (4xx) allows everything; a server error (5xx) or a
//     network failure blocks the whole site, as RFC 9309 requires
//   - blank lines do not end a group; a leading byte-order mark is skipped
//   - Crawl-delay is honoured per site; a delay above the cap blocks the request
//     instead of stalling the run
//
// Entry points:
//   node --import ./robots-guard/preload.mjs scan.mjs   every fetch() in that process is checked
//   node robots-guard/robots-guard.mjs check <url>        exit 0 allowed, 1 disallowed
//   node robots-guard/robots-guard.mjs hook               Claude Code PreToolUse hook (JSON on stdin)
//
// Environment:
//   ROBOTS_GUARD_AGENT         product token matched against User-agent lines
//                              (default career-ops; the hook defaults to Claude-User)
//   ROBOTS_GUARD_EXEMPT_HOSTS  comma-separated hosts, subdomains included, that are never
//                              checked: they are APIs, not websites. Default: DEFAULT_EXEMPT_HOSTS.
//                              An empty value exempts nothing.
//   ROBOTS_GUARD_CACHE_DIR     where robots.txt answers are kept for 24 hours
//                              (default ~/.cache/robots-guard). An empty value keeps them in memory only.
//   ROBOTS_GUARD_MAX_DELAY_S   largest Crawl-delay honoured by waiting (default 30)

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_USER_AGENT } from '../user-agent.mjs';

const DAY_MS = 24 * 3600 * 1000;
const UNREACHABLE_TTL_MS = 10 * 60 * 1000;
const MAX_ROBOTS_CHARS = 512 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export const DEFAULT_EXEMPT_HOSTS = Object.freeze([
  'localhost', '127.0.0.1', '::1',
  'api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'openrouter.ai',
  'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com',
]);

export class RobotsDisallowedError extends Error {
  constructor(url, reason) {
    super(`robots.txt disallows ${url}: ${reason}`);
    this.name = 'RobotsDisallowedError';
    this.code = 'ROBOTS_DISALLOWED';
    this.url = url;
    this.reason = reason;
  }
}

// ── Parsing and matching ────────────────────────────────────────────

export function parseRobots(text) {
  const groups = [];
  let group = null;
  let inAgentLines = false;
  for (const raw of String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === 'user-agent') {
      if (!inAgentLines) {
        group = { agents: [], rules: [], crawlDelayMs: 0 };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase().split(/[/\s]/)[0]);
      inAgentLines = true;
    } else if (key === 'allow' || key === 'disallow') {
      inAgentLines = false;
      if (!group || value === '') continue;
      const label = key === 'allow' ? 'Allow' : 'Disallow';
      group.rules.push({ allow: key === 'allow', pattern: canonical(value), text: `${label}: ${value}` });
    } else if (key === 'crawl-delay') {
      inAgentLines = false;
      const seconds = Number(value);
      if (group && Number.isFinite(seconds) && seconds > 0) {
        group.crawlDelayMs = Math.max(group.crawlDelayMs, seconds * 1000);
      }
    }
  }
  return { groups };
}

// RFC 9309 §2.2.2: compare percent-encoded forms; decode unreserved characters.
function canonical(s) {
  return s
    .replace(/[^\x21-\x7E]/gu, (ch) => encodeURIComponent(ch))
    .replace(/%([0-9a-fA-F]{2})/g, (m, hex) => {
      const ch = String.fromCharCode(parseInt(hex, 16));
      return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${hex.toUpperCase()}`;
    });
}

const regexCache = new Map();
function matches(pattern, path) {
  let re = regexCache.get(pattern);
  if (!re) {
    let p = pattern.startsWith('/') || pattern.startsWith('*') ? pattern : `/${pattern}`;
    const anchored = p.endsWith('$');
    if (anchored) p = p.slice(0, -1);
    const body = p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    re = new RegExp(`^${body}${anchored ? '$' : ''}`);
    regexCache.set(pattern, re);
  }
  return re.test(path);
}

function decide(rules, path) {
  let best = null;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    const longer = !best || rule.pattern.length > best.pattern.length;
    const tieToDisallow = best && rule.pattern.length === best.pattern.length && !rule.allow;
    if (longer || tieToDisallow) best = rule;
  }
  return best ? { allowed: best.allow, rule: best.text } : { allowed: true, rule: null };
}

export function evaluate(parsed, pathAndQuery, agentTokens) {
  const path = canonical(pathAndQuery || '/');
  if (path === '/robots.txt') return { allowed: true, rule: null, crawlDelayMs: 0 };
  const tokens = agentTokens.map((t) => t.toLowerCase());
  const own = parsed.groups.filter((g) => g.agents.some((a) => a !== '*' && tokens.includes(a)));
  const all = parsed.groups.filter((g) => g.agents.includes('*'));
  const verdicts = [own, all].filter((gs) => gs.length > 0).map((gs) => decide(gs.flatMap((g) => g.rules), path));
  const blocking = verdicts.find((v) => !v.allowed);
  const deciding = blocking ?? verdicts.find((v) => v.rule);
  const crawlDelayMs = Math.max(0, ...[...own, ...all].map((g) => g.crawlDelayMs));
  return { allowed: !blocking, rule: deciding?.rule ?? null, crawlDelayMs };
}

// ── Fetching robots.txt ─────────────────────────────────────────────

function defaultCacheDir() {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'robots-guard');
}

export function optionsFromEnv(env = process.env) {
  const options = {};
  if (env.ROBOTS_GUARD_AGENT) options.agentTokens = [env.ROBOTS_GUARD_AGENT];
  if (env.ROBOTS_GUARD_EXEMPT_HOSTS !== undefined) {
    options.exemptHosts = env.ROBOTS_GUARD_EXEMPT_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  }
  if (env.ROBOTS_GUARD_CACHE_DIR !== undefined) options.cacheDir = env.ROBOTS_GUARD_CACHE_DIR || null;
  if (env.ROBOTS_GUARD_MAX_DELAY_S) options.maxCrawlDelayMs = Number(env.ROBOTS_GUARD_MAX_DELAY_S) * 1000;
  return options;
}

export class RobotsGuard {
  constructor({
    fetchImpl = globalThis.fetch,
    agentTokens = ['career-ops'],
    userAgent = DEFAULT_USER_AGENT,
    cacheDir = defaultCacheDir(),
    exemptHosts = DEFAULT_EXEMPT_HOSTS,
    maxCrawlDelayMs = 30_000,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    Object.assign(this, { fetchImpl, agentTokens, userAgent, cacheDir, exemptHosts, maxCrawlDelayMs, now, sleep });
    this.memory = new Map();
    this.nextSlot = new Map();
  }

  isExempt(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return this.exemptHosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  // One robots.txt answer per origin: { status, body } or { error }.
  robotsFor(origin) {
    const cached = this.memory.get(origin);
    if (cached && cached.expiresAt > this.now()) return cached.promise;
    const promise = this.loadRobots(origin);
    const entry = { promise, expiresAt: Infinity };
    this.memory.set(origin, entry);
    promise.then((answer) => { entry.expiresAt = answer.fetchedAt + ttlOf(answer); });
    return promise;
  }

  async loadRobots(origin) {
    const file = this.cacheDir && join(this.cacheDir, `${createHash('sha256').update(origin).digest('hex').slice(0, 32)}.json`);
    if (file) {
      try {
        const answer = JSON.parse(readFileSync(file, 'utf8'));
        if (answer.origin === origin && this.now() - answer.fetchedAt < ttlOf(answer)) return answer;
      } catch { /* no usable cache entry */ }
    }
    const answer = { origin, fetchedAt: this.now() };
    try {
      const res = await this.fetchImpl(`${origin}/robots.txt`, {
        headers: { 'user-agent': this.userAgent, accept: 'text/plain,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      answer.status = res.status;
      answer.body = res.ok ? (await res.text()).slice(0, MAX_ROBOTS_CHARS) : '';
    } catch (err) {
      answer.error = err?.message || String(err);
    }
    if (file) {
      try {
        mkdirSync(this.cacheDir, { recursive: true });
        writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(answer));
        renameSync(`${file}.${process.pid}.tmp`, file);
      } catch (err) {
        process.stderr.write(`[robots-guard] could not cache robots.txt of ${origin} in ${this.cacheDir}: ${err.message}\n`);
      }
    }
    return answer;
  }

  async check(url) {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { allowed: true, reason: `${u.protocol} is not fetched over HTTP`, crawlDelayMs: 0 };
    if (this.isExempt(u.hostname)) return { allowed: true, reason: 'exempt host', crawlDelayMs: 0 };
    const answer = await this.robotsFor(u.origin);
    const source = `robots.txt of ${u.origin}`;
    if (answer.error || answer.status >= 500 || (answer.status >= 300 && answer.status < 400)) {
      const why = answer.error ?? `HTTP ${answer.status}`;
      return { allowed: false, reason: `${source} unreachable (${why}), so RFC 9309 treats the whole site as disallowed`, crawlDelayMs: 0 };
    }
    if (answer.status >= 400) return { allowed: true, reason: `${source} is missing (HTTP ${answer.status})`, crawlDelayMs: 0 };
    const v = evaluate(parseRobots(answer.body), u.pathname + u.search, this.agentTokens);
    return { allowed: v.allowed, reason: v.rule ? `${v.rule} (${source})` : `no rule in ${source} matches`, crawlDelayMs: v.crawlDelayMs };
  }

  // Throws RobotsDisallowedError, or waits until the site's Crawl-delay has passed.
  async beforeRequest(url) {
    const v = await this.check(url);
    if (!v.allowed) throw new RobotsDisallowedError(url, v.reason);
    if (v.crawlDelayMs > this.maxCrawlDelayMs) {
      throw new RobotsDisallowedError(url, `Crawl-delay ${v.crawlDelayMs / 1000}s exceeds the ${this.maxCrawlDelayMs / 1000}s cap`);
    }
    if (v.crawlDelayMs > 0) {
      const { origin } = new URL(url);
      const slot = Math.max(this.now(), this.nextSlot.get(origin) ?? 0);
      this.nextSlot.set(origin, slot + v.crawlDelayMs);
      const wait = slot - this.now();
      if (wait > 0) await this.sleep(wait);
    }
  }
}

function ttlOf(answer) {
  return answer.error || answer.status >= 500 ? UNREACHABLE_TTL_MS : DAY_MS;
}

// ── fetch() wrapper ─────────────────────────────────────────────────

export function wrapFetch(originalFetch, guard, onBlock = () => {}) {
  return async function robotsCheckedFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (url) {
      try {
        await guard.beforeRequest(url);
      } catch (err) {
        if (err instanceof RobotsDisallowedError) onBlock(err);
        throw err;
      }
    }
    return originalFetch(input, init);
  };
}

export function install(options = {}) {
  if (globalThis.fetch?.robotsGuard) return globalThis.fetch.robotsGuard;
  const original = globalThis.fetch;
  const guard = new RobotsGuard({ fetchImpl: original, ...optionsFromEnv(), ...options });
  const logged = new Set();
  const wrapped = wrapFetch(original, guard, (err) => {
    const key = `${new URL(err.url).origin} ${err.reason}`;
    if (logged.has(key)) return;
    logged.add(key);
    process.stderr.write(`[robots-guard] blocked ${err.url}: ${err.reason}\n`);
  });
  wrapped.robotsGuard = guard;
  wrapped.original = original;
  globalThis.fetch = wrapped;
  return guard;
}

// ── Claude Code PreToolUse hook ─────────────────────────────────────

export async function runHook(stdinText, guard) {
  let url;
  try {
    url = JSON.parse(stdinText)?.tool_input?.url;
  } catch {
    return { exitCode: 0, stderr: '' };
  }
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { exitCode: 0, stderr: '' };
  const v = await guard.check(url);
  if (v.allowed) return { exitCode: 0, stderr: '' };
  return { exitCode: 2, stderr: `robots.txt disallows ${url}: ${v.reason}. Skip this page and do not fetch it another way.\n` };
}

// ── CLI ─────────────────────────────────────────────────────────────

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main([command, url]) {
  const fetchImpl = globalThis.fetch.original ?? globalThis.fetch;
  if (command === 'check' && url) {
    const v = await new RobotsGuard({ fetchImpl, ...optionsFromEnv() }).check(url);
    const delay = v.crawlDelayMs ? ` (Crawl-delay ${v.crawlDelayMs / 1000}s)` : '';
    console.log(`${v.allowed ? 'allowed' : 'DISALLOWED'}: ${url}: ${v.reason}${delay}`);
    return v.allowed ? 0 : 1;
  }
  if (command === 'hook') {
    const guard = new RobotsGuard({ fetchImpl, agentTokens: ['Claude-User'], ...optionsFromEnv() });
    const r = await runHook(await readStdin(), guard);
    process.stderr.write(r.stderr);
    return r.exitCode;
  }
  console.error('usage: node robots-guard.mjs check <url> | hook');
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
