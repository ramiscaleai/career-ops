// tests/providers/rss.test.mjs - generic RSS 2.0 provider (this fork only).
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — rss');

const check = (ok, okMsg, failMsg) => (ok ? pass(okMsg) : fail(failMsg));

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ex="https://jobs.example.com/ns">
  <channel>
    <title>Example Jobs</title>
    <item>
      <title>R&amp;D Staff Engineer at Acme &amp; Co</title>
      <link>https://jobs.example.com/j/1</link>
      <pubDate>Thu, 13 Nov 2025 14:10:41 +0000</pubDate>
      <description>&lt;p&gt;Build things. &lt;b&gt;Remote&lt;/b&gt;, worldwide.&lt;/p&gt;</description>
    </item>
    <item>
      <title><![CDATA[Lead Backend Engineer]]></title>
      <link>https://www.jobs.example.com/j/2</link>
      <ex:companyName>ExampleCo</ex:companyName>
      <ex:companyLogo>https://jobs.example.com/logo.png</ex:companyLogo>
      <ex:location>Berlin</ex:location>
      <ex:locationType>Hybrid</ex:locationType>
    </item>
    <item>
      <title>Senior SRE at BigCo</title>
      <link>https://jobs.example.com/j/3</link>
      <company>BigCo</company>
      <location>Remote</location>
      <work_model>Remote</work_model>
      <pubDate>not a date</pubDate>
    </item>
    <item>
      <title>Principal Architect</title>
      <link>https://jobs.example.com/j/4</link>
    </item>
    <item><title>No Link at Acme</title></item>
    <item><title>Relative at Acme</title><link>/j/5</link></item>
    <item><title>Off Site at Acme</title><link>https://evil.example/j/6</link></item>
    <item><title>Look Alike at Acme</title><link>https://notjobs.example.com/j/7</link></item>
    <item><title>Plain HTTP at Acme</title><link>http://jobs.example.com/j/8</link></item>
    <item><link>https://jobs.example.com/j/9</link></item>
  </channel>
</rss>`;

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/rss.mjs')).href);
  const rss = mod.default;
  const { parseRssFeed } = mod;

  check(rss.id === 'rss', 'rss.id is "rss"', `rss.id is ${JSON.stringify(rss.id)}`);
  check(rss.detect === undefined, 'rss has no detect(): wired by an explicit provider: rss',
    'rss must not auto-detect: a feed URL says nothing about the board');

  const jobs = parseRssFeed(FEED, 'jobs.example.com', 'Example Board');
  check(jobs.length === 4, 'parseRssFeed keeps 4 items (drops no/relative/off-site/look-alike/http link, no title)',
    `parseRssFeed returned ${jobs.length} jobs: ${JSON.stringify(jobs.map((j) => j.url))}`);

  const [first, second, third, fourth] = jobs;
  check(first?.title === 'R&D Staff Engineer' && first?.company === 'Acme & Co',
    'a "Role at Company" title splits on the last " at ", entities decoded first',
    `row 0 title/company = ${JSON.stringify({ title: first?.title, company: first?.company })}`);
  check(first?.postedAt === Date.parse('Thu, 13 Nov 2025 14:10:41 +0000') && first?.location === '',
    'pubDate -> postedAt; no location tag -> empty location', `row 0 = ${JSON.stringify(first)}`);
  // htmlToText turns each tag into a space, hence "Remote ," from "<b>Remote</b>,".
  check(first?.description === 'Build things. Remote , worldwide.',
    'entity-escaped HTML description -> plain text', `row 0 description = ${JSON.stringify(first?.description)}`);
  check(second?.company === 'ExampleCo' && second?.title === 'Lead Backend Engineer' && second?.location === 'Berlin (Hybrid)',
    'namespaced companyName/location tags read; workplace type appended to the location',
    `row 1 = ${JSON.stringify(second)}`);
  check(second?.url === 'https://www.jobs.example.com/j/2' && second?.description === undefined,
    'a www. link on the feed site is kept; no description -> key absent', `row 1 = ${JSON.stringify(second)}`);
  check(third?.title === 'Senior SRE' && third?.company === 'BigCo' && third?.location === 'Remote' && third?.postedAt === undefined,
    'company tag trims " at Company" off the title; repeated workplace not appended; bad date -> undefined',
    `row 2 = ${JSON.stringify(third)}`);
  check(fourth?.company === 'Example Board' && fourth?.title === 'Principal Architect',
    'no company anywhere -> the entry name', `row 3 = ${JSON.stringify(fourth)}`);

  const empty = parseRssFeed('<rss><channel><title>None</title></channel></rss>', 'jobs.example.com', 'X');
  check(Array.isArray(empty) && empty.length === 0, 'a channel with no items -> []', `empty channel -> ${JSON.stringify(empty)}`);
  for (const [label, body] of [['an HTML page', '<html><body>jobs</body></html>'], ['an empty body', ''], ['null', null], ['an Atom feed', '<feed><entry></entry></feed>']]) {
    let threw = false;
    try { parseRssFeed(body, 'jobs.example.com', 'X'); } catch (e) { threw = /no <channel>/.test(e.message); }
    check(threw, `${label} is not an RSS feed -> descriptive throw`, `${label} should throw "no <channel>"`);
  }

  const calls = [];
  const ctx = { fetchText: async (url, opts) => { calls.push({ url, opts }); return FEED; } };
  const fetched = await rss.fetch({ name: 'Example Board', provider: 'rss', careers_url: 'https://jobs.example.com/feed.rss' }, ctx);
  check(calls.length === 1 && calls[0].url === 'https://jobs.example.com/feed.rss', 'fetch() reads careers_url once',
    `fetch() calls = ${JSON.stringify(calls)}`);
  check(calls[0]?.opts?.redirect === 'error', 'fetch() passes redirect:"error"', `opts = ${JSON.stringify(calls[0]?.opts)}`);
  check(fetched.length === 4 && fetched[0].company === 'Acme & Co', 'fetch() returns normalized jobs', `fetched = ${JSON.stringify(fetched[0])}`);

  for (const url of ['http://jobs.example.com/feed.rss', 'https://user:secret@jobs.example.com/feed', 'https://jobs.example.com:8443/feed', 'not a url', undefined]) {
    let entered = 0;
    let threw = false;
    try {
      await rss.fetch({ name: 'X', provider: 'rss', careers_url: url }, { fetchText: async () => { entered += 1; return FEED; } });
    } catch (e) {
      threw = /^rss: careers_url/.test(e.message) && !e.message.includes('secret');
    }
    check(threw && entered === 0, `careers_url ${JSON.stringify(url)} is refused before any request`,
      `careers_url ${JSON.stringify(url)}: threw=${threw}, fetchText entered ${entered} times`);
  }

  const failure = new Error('HTTP 503');
  let rejected = null;
  try {
    await rss.fetch({ name: 'X', provider: 'rss', careers_url: 'https://jobs.example.com/feed.rss' },
      { maxPages: 1, fetchText: async () => { throw failure; } });
  } catch (e) {
    rejected = e;
  }
  check(rejected === failure, 'a fetchText rejection under a health probe propagates unwrapped',
    `probe rejection = ${rejected?.message}`);
} catch (e) {
  fail(`rss provider tests crashed: ${e.message}`);
}
