// @ts-check
import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';
/** @typedef {import('./_types.js').Provider} Provider */

// Generic RSS 2.0 provider (this fork only) - reads one public job feed, named
// by the entry's `careers_url`, for remote boards that publish a feed but have
// no provider of their own. Upstream keeps one source per provider (Source
// Indexing Policy, rule 5), so this reader is not proposed there.
//
// No detect(): a feed URL says nothing about the board, so an entry wires it
// with an explicit `provider: rss`. The feed host is config-derived with no
// vendor domain to allowlist (the phenom.mjs shape): the URL must be https with
// no credentials or port, the central IP guard covers every ctx.fetch*, and
// redirects are refused. A job link is kept only when it is https on the
// feed's own site, so a feed cannot point a later JD read anywhere else.
//
// Per <item>: <title>, <link>, <pubDate>, <description>, plus company and
// location from the first tag of COMPANY_TAGS / LOCATION_TAGS present (any
// namespace prefix), else a "Role at Company" title. A workplace tag such as
// "Hybrid" is appended to the location, so location_filter's block_hard sees it.

const COMPANY_TAGS = ['company', 'companyName', 'company_name'];
const LOCATION_TAGS = ['location', 'job_location', 'region'];
const WORKPLACE_TAGS = ['locationType', 'work_model', 'workplace_type'];

/** @param {unknown} raw */
function assertFeedUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw ?? ''));
  } catch {
    throw new Error(`rss: careers_url is not a URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`rss: careers_url must use HTTPS (host ${parsed.host})`);
  if (parsed.username || parsed.password || parsed.port) {
    throw new Error(`rss: careers_url must not carry credentials or a port (host ${parsed.hostname})`);
  }
  return parsed;
}

// NaN-safe Date.parse - `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// A tag's inner text: unwrap a CDATA section, else decode entities.
function extractText(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1].trim() : decodeEntities(inner).trim();
}

// Text of the first tag in `names` that the item carries, with any namespace prefix; '' when none.
function firstTag(item, names) {
  for (const name of names) {
    const m = item.match(new RegExp(`<((?:[\\w-]+:)?${name})\\b[^>]*>([\\s\\S]*?)</\\1>`, 'i'));
    const text = m ? extractText(m[2]) : '';
    if (text) return text;
  }
  return '';
}

// The item's <link> when it is https on the feed's site (the feed host without "www.") or a subdomain of it.
function itemUrl(item, site) {
  try {
    const url = new URL(firstTag(item, ['link']));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === site || host.endsWith(`.${site}`)) ? url.href : '';
  } catch {
    return '';
  }
}

// "Staff Engineer at Acme" -> role and company (the last " at " wins); a known company is trimmed off the title.
function splitTitle(raw, company) {
  if (company) {
    const suffix = ` at ${company}`;
    const ends = raw.toLowerCase().endsWith(suffix.toLowerCase());
    return { title: ends ? raw.slice(0, -suffix.length).trim() : raw, company };
  }
  const at = raw.lastIndexOf(' at ');
  return at > 0 ? { title: raw.slice(0, at).trim(), company: raw.slice(at + 4).trim() } : { title: raw, company: '' };
}

function itemLocation(item) {
  const location = firstTag(item, LOCATION_TAGS);
  const workplace = firstTag(item, WORKPLACE_TAGS);
  if (!workplace || location.toLowerCase().includes(workplace.toLowerCase())) return location;
  return location ? `${location} (${workplace})` : workplace;
}

function parseItem(item, site, fallbackCompany) {
  const url = itemUrl(item, site);
  const rawTitle = firstTag(item, ['title']);
  if (!url || !rawTitle) return null;
  const { title, company } = splitTitle(rawTitle, firstTag(item, COMPANY_TAGS));
  const description = htmlToText(firstTag(item, ['description']));
  return { title, url, company: company || fallbackCompany, location: itemLocation(item),
    postedAt: toEpochMs(firstTag(item, ['pubDate'])), ...(description ? { description } : {}) };
}

/**
 * Parse an RSS 2.0 job feed. Exported for unit tests.
 *
 * A body with no <channel> is not an RSS feed and throws; a channel without
 * items is an empty board and returns []. Items without a title or a usable
 * same-site https link are dropped.
 *
 * @param {unknown} xml - raw feed body
 * @param {string} feedHost - hostname of the feed URL
 * @param {string} fallbackCompany - company for items that name none
 * @returns {Array<{title: string, url: string, company: string, location: string, postedAt?: number, description?: string}>}
 */
export function parseRssFeed(xml, feedHost, fallbackCompany) {
  if (typeof xml !== 'string' || !/<channel\b/i.test(xml)) {
    const got = typeof xml === 'string' ? JSON.stringify(xml.slice(0, 60)) : typeof xml;
    throw new Error(`rss: not an RSS 2.0 feed, no <channel> (got ${got})`);
  }
  const site = feedHost.toLowerCase().replace(/^www\./, '');
  const items = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? [];
  return items.map((item) => parseItem(item, site, fallbackCompany)).filter((job) => job !== null);
}

/** @type {Provider} */
export default {
  id: 'rss',

  async fetch(entry, ctx) {
    const feed = assertFeedUrl(entry?.careers_url);
    const name = typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : feed.hostname;
    const text = await ctx.fetchText(feed.href, { redirect: 'error' });
    return parseRssFeed(text, feed.hostname, name);
  },
};
