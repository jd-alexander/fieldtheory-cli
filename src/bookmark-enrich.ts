import { controlledFetch, isHttpSafetyStop, type ControlledFetchMetadata } from './http-safety.js';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { Agent } from 'undici';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { Worker } from 'node:worker_threads';
import { marked } from 'marked';

/**
 * Article extraction for link-heavy bookmarks.
 *
 * Fetches linked page content and extracts readable text so it becomes
 * searchable via FTS5. Used by syncGaps as "Gap 3".
 *
 * Strategies:
 *   1. HTML fetch → extract <article>, <main>, or body text
 *   2. JSON-LD structured data
 *   3. OpenGraph / meta description fallback
 */

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_TEXT_CHARS = 250_000;

// ── Types ──────────────────────────────────────────────────────────────────

export interface ArticleContent {
  title: string;
  text: string;
  siteName?: string;
  previewText?: string;
  summaryText?: string;
  firstPublishedAt?: string;
  modifiedAt?: string;
  articleRestId?: string;
  articleId?: string;
  contentState?: unknown;
  coverMedia?: unknown;
  mediaEntities?: unknown[];
  url?: string;
  format?: 'html' | 'text' | 'markdown' | 'json' | 'pdf' | 'asset';
  markdown?: string;
  images?: string[];
  videos?: string[];
  links?: string[];
  partialReason?: string;
}

export interface LinkedResource {
  url: string;
  resolvedUrl?: string;
  status: 'captured' | 'partial' | 'failed' | 'skipped';
  attempts: number;
  attemptedAt: string;
  nextRetryAt?: string;
  reason?: string;
  content?: ArticleContent;
}

// ── HTML helpers ───────────────────────────────────────────────────────────

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)));
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ── Extraction ─────────────────────────────────────────────────────────────

function legacyExtractReadableText(html: string): ArticleContent | null {
  const ogTitle = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]*)"[^>]*>/i);
  const htmlTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = stripHtml(ogTitle?.[1] ?? htmlTitle?.[1] ?? '');

  const siteMatch = html.match(/<meta\s+(?:property|name)="og:site_name"\s+content="([^"]*)"[^>]*>/i);
  const siteName = siteMatch ? decodeEntities(siteMatch[1]) : undefined;

  // Remove non-content blocks
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Try content selectors in specificity order
  let text = '';
  const articleMatch = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  if (articleMatch) text = stripHtml(articleMatch[1]);
  else if (mainMatch) text = stripHtml(mainMatch[1]);
  else text = stripHtml(cleaned);

  // Fallback to meta description
  if (text.length < 100) {
    const ogDesc = html.match(/<meta\s+(?:property|name)="(?:og:)?description"\s+content="([^"]*)"[^>]*>/i);
    if (ogDesc && ogDesc[1].length > text.length) {
      text = stripHtml(ogDesc[1]);
    }
  }

  // Fallback to JSON-LD
  if (text.length < 100) {
    const jsonLd = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLd) {
      try {
        const data = JSON.parse(jsonLd[1]);
        const body = data.articleBody ?? data.text ?? data.description ?? '';
        if (body.length > text.length) text = body;
      } catch { /* invalid JSON-LD */ }
    }
  }

  if (text.length < 50) return null;
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);

  return { title, text, siteName };
}

// ── URL filtering ──────────────────────────────────────────────────────────

export function isTwitterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/\.$/, '');
    return host === 'twitter.com' || host === 'x.com' || host.endsWith('.twitter.com') || host.endsWith('.x.com');
  } catch { return false; }
}

/**
 * Block any URL that would resolve to a loopback, private, link-local,
 * or unique-local address in either IPv4 or IPv6, including numeric
 * encodings and IPv4-mapped-in-IPv6 forms. Also rejects non-http(s) schemes.
 *
 * This is called on the initial URL AND every redirect hop.
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;

    // URL.hostname for IPv6 normalizes brackets differently across Node versions;
    // strip them so downstream string checks are uniform.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

    if (host === 'localhost' || /\.(?:localhost|local|internal|home\.arpa)$/.test(host)) return false;

    // ─── Numeric IPv4 encodings (decimal, hex, octal) ───────────────
    // new URL('http://2130706433/').hostname === '2130706433'
    // new URL('http://0x7f000001/').hostname === '0x7f000001'
    if (/^\d+$/.test(host)) return false;           // decimal: 2130706433
    if (/^0x[0-9a-f]+$/.test(host)) return false;   // hex: 0x7f000001
    if (/^0\d/.test(host) && /^\d+$/.test(host.slice(1))) return false; // octal leading zero

    // ─── Standard IPv4 dotted quad checks ───────────────────────────
    // Match as dotted quad first so startsWith tests don't accidentally match domains
    // starting with "10" or "127" that happen to contain a dot.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      if (/^0\./.test(host) || Number(host.split('.')[0]) >= 224) return false;
      if (/^127\./.test(host)) return false;                    // 127.0.0.0/8 loopback
      if (/^10\./.test(host)) return false;                     // 10.0.0.0/8
      if (/^192\.168\./.test(host)) return false;               // 192.168.0.0/16
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false; // 172.16.0.0/12
      if (/^169\.254\./.test(host)) return false;               // 169.254.0.0/16 link-local + metadata
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false; // 100.64/10 CGNAT
      if (/^192\.0\.(?:0|2)\.|^198\.(?:18|19)\.|^198\.51\.100\.|^203\.0\.113\./.test(host)) return false;
    }

    // ─── IPv6 checks ────────────────────────────────────────────────
    if (host === '::' || host === '::1') return false;
    if (/^fe[89ab]/.test(host)) return false;  // fe80::/10 link-local
    if (host.startsWith('fc') && host.includes(':')) return false; // fc00::/8 unique-local
    if (host.startsWith('fd') && host.includes(':')) return false; // fd00::/8 unique-local
    if (host.startsWith('::ffff:')) return false; // IPv4-mapped IPv6: ::ffff:127.0.0.1 etc.
    if (host.startsWith('::') && /\./.test(host)) return false; // IPv4-compat IPv6
    if (host.includes(':') && !/^[23][0-9a-f]{3}:/.test(host)) return false; // global IPv6 unicast only

    return true;
  } catch { return false; }
}

// Validate DNS at connection time, not in a separate check vulnerable to rebinding.
const publicDispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (!addresses.length || addresses.some(({ address }) => !isSafeUrl(`https://${isIP(address) === 6 ? `[${address}]` : address}/`))) {
      return callback(Object.assign(new Error('URL resolves to a non-public address'), { code: 'ENOTFOUND' }), []);
    }
    const family = typeof options === 'number' ? options : options.family;
    const allowed = family ? addresses.filter((entry) => entry.family === family) : addresses;
    if (!allowed.length) return callback(Object.assign(new Error('No public address for requested family'), { code: 'ENOTFOUND' }), []);
    if (typeof options === 'object' && options.all) callback(null, allowed);
    else callback(null, allowed[0].address, allowed[0].family);
  });
} } });

function absoluteUrl(value: string | null, base: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value, base); return isSafeUrl(url.href) ? url.href : undefined; } catch { return undefined; }
}

export function extractReadableText(html: string, url = 'https://example.invalid/'): ArticleContent | null {
  // Parsing only: no page scripts, resource loading, cookies or browser control.
  const dom = new JSDOM(html, { url });
  try {
    const document = dom.window.document;
    const article = new Readability(document.cloneNode(true) as Document, { charThreshold: 100, maxElemsToParse: 50_000 }).parse();
    const fallback = legacyExtractReadableText(html);
    const content = document.createElement('div');
    content.innerHTML = article?.content ?? '';
    const hasBody = (article?.textContent?.trim().length ?? 0) >= 100;
    if (!hasBody) {
      const main = document.querySelector('article, main, [role="main"]');
      if (main) content.innerHTML = main.innerHTML;
      else {
        document.querySelectorAll('script,style,nav,header,footer,aside,form,noscript').forEach((node) => node.remove());
        content.innerHTML = document.body.innerHTML;
      }
    }
    content.querySelectorAll('script,style,iframe,form,object,embed').forEach((node) => node.remove());
    const links: string[] = [];
    for (const anchor of content.querySelectorAll('a')) {
      const target = absoluteUrl(anchor.getAttribute('href'), url);
      if (target) { anchor.setAttribute('href', target); links.push(target); }
      else anchor.removeAttribute('href');
    }
    const images: string[] = [];
    for (const image of content.querySelectorAll('img')) {
      const target = absoluteUrl(image.getAttribute('data-src') ?? image.getAttribute('src'), url);
      if (target && images.length < 40) images.push(target);
      image.remove();
    }
    const videos = [...content.querySelectorAll('video[src],video source[src]'),
      ...(document.querySelector('article,main')?.querySelectorAll('video[src],video source[src]') ?? [])]
      .map((node) => absoluteUrl(node.getAttribute('src'), url)).filter((value): value is string => Boolean(value)).slice(0, 10);
    content.querySelectorAll('video,audio,source').forEach((node) => node.remove());
    const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(content);
    content.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,tr,div,section').forEach((node) => {
      node.prepend(document.createTextNode('\n')); node.append(document.createTextNode('\n'));
    });
    const text = content.textContent?.replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() ?? '';
    const body = text.length >= 50 ? text : fallback?.text ?? '';
    if (body.length < 50) return null;
    const metadataOnly = text.length < 100 && (fallback?.text.length ?? 0) > text.length;
    return {
      title: article?.title || fallback?.title || document.title || new URL(url).hostname,
      text: body.slice(0, MAX_TEXT_CHARS), markdown: (text.length >= 50 ? markdown || body : body).slice(0, MAX_TEXT_CHARS),
      siteName: article?.siteName ?? fallback?.siteName, url, format: 'html',
      links: [...new Set(links)], images: [...new Set(images)], videos: [...new Set(videos)],
      partialReason: body.length > MAX_TEXT_CHARS ? 'text limit reached' : metadataOnly ? 'only metadata/preview text available'
        : /enable javascript|javascript (?:is )?required|access denied|verify (?:you are|that you)/i.test(body) && body.length < 1000 ? 'access/JavaScript interstitial, not full content' : undefined,
    };
  } finally { dom.window.close(); }
}

// ── Manual redirect walker ─────────────────────────────────────────────────

const MAX_REDIRECT_HOPS = 5;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/**
 * Fetch a URL, walking redirects manually and re-validating every hop
 * against isSafeUrl. A safe-looking URL that redirects to 127.0.0.1 or
 * AWS metadata is blocked on the next hop, not allowed through.
 *
 * Returns null for unsafe destinations; transport errors and safety holds propagate.
 */
export async function fetchFollowingRedirects(
  url: string,
  options: { signal?: AbortSignal; method?: 'GET' | 'HEAD'; metadata?: ControlledFetchMetadata } = {},
): Promise<{ response: Response; finalUrl: string } | null> {
  const method = options.method ?? 'GET';
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!isSafeUrl(current)) return null;

    let res: Response;
    try {
      res = await controlledFetch(current, {
        method,
        headers: BROWSER_HEADERS,
        redirect: 'manual',
        signal: options.signal,
        dispatcher: publicDispatcher,
      } as RequestInit, {
        operation: method === 'HEAD' ? 'ResolveArticleLink' : 'FetchArticle',
        category: 'external',
        cursorPresent: hop > 0,
        ...options.metadata,
      });
    } catch (error) {
      if (isHttpSafetyStop(error)) throw error;
      throw error;
    }

    // 304 Not Modified is in the 3xx range but isn't a redirect.
    const isRedirect = res.status >= 300 && res.status < 400 && res.status !== 304;
    if (!isRedirect) {
      return { response: res, finalUrl: current };
    }

    const location = res.headers.get('location');
    if (!location) {
      return { response: res, finalUrl: current };
    }

    try { await res.body?.cancel(); } catch { /* ignore */ }

    try {
      // Relative redirects resolve against the current URL.
      current = new URL(location, current).toString();
    } catch {
      return null;
    }
  }

  throw new Error('redirect limit exceeded');
}

// ── Fetch with size limit ──────────────────────────────────────────────────

async function fetchWithLimit(url: string): Promise<{ bytes: Uint8Array; contentType: string; url: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const result = await fetchFollowingRedirects(url, { signal: controller.signal });
    if (!result) throw new Error('unsafe URL or redirect');
    const res = result.response;
    if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }

    const contentType = res.headers.get('content-type') ?? '';
    if (/^(image|video)\//.test(contentType)) {
      await res.body?.cancel();
      return { bytes: new Uint8Array(), contentType, url: result.finalUrl };
    }
    const maxBytes = contentType.includes('application/pdf') ? MAX_RESPONSE_BYTES : 2 * 1024 * 1024;
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) { await res.body?.cancel(); throw new Error(`response exceeds ${maxBytes / 1024 / 1024} MiB limit`); }

    // Read body with size limit
    const reader = res.body?.getReader();
    if (!reader) throw new Error('empty response body');

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`response exceeds ${maxBytes / 1024 / 1024} MiB limit`);
      }
      chunks.push(value);
    }

    return { bytes: new Uint8Array(Buffer.concat(chunks)), contentType, url: result.finalUrl };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function fetchArticle(url: string): Promise<ArticleContent | null> {
  if (isTwitterUrl(url)) return null;
  if (!isSafeUrl(url)) throw new Error('unsafe URL');
  // GitHub exposes repository README Markdown without an API token.
  const parsed = new URL(url);
  if (parsed.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/?$/.test(parsed.pathname)) {
    url = `https://raw.githubusercontent.com${parsed.pathname.replace(/\/$/, '').replace(/\.git$/, '')}/HEAD/README.md`;
  } else if (parsed.hostname === 'gist.github.com' && /^\/(?:[^/]+\/)?[a-f0-9]+\/?$/i.test(parsed.pathname)) {
    const id = parsed.pathname.split('/').filter(Boolean).pop();
    const gist = JSON.parse(new TextDecoder().decode((await fetchWithLimit(`https://api.github.com/gists/${id}`)).bytes));
    const files = Object.values(gist.files ?? {}) as Array<{ filename: string; content?: string; truncated?: boolean; raw_url?: string }>;
    const sections: string[] = [];
    let partial = files.length > 10 ? 'gist file limit reached (10 files)' : undefined;
    for (const file of files.slice(0, 10)) {
      let body = file.content ?? '';
      if (file.truncated && file.raw_url) body = new TextDecoder().decode((await fetchWithLimit(file.raw_url)).bytes);
      if (file.truncated && !file.raw_url) partial = 'gist file content truncated';
      sections.push(`## ${file.filename}\n\n${/\.md$/i.test(file.filename) ? body : fencedText(body)}`);
    }
    let combined = sections.join('\n\n');
    if (combined.length > MAX_TEXT_CHARS) { combined = combined.slice(0, MAX_TEXT_CHARS); partial = 'gist text limit reached'; }
    const extracted = extractReadableText(`<main>${marked.parse(combined, { async: false })}</main>`, parsed.href);
    return extracted ? { ...extracted, title: gist.description || files[0]?.filename || 'GitHub Gist', format: 'markdown', partialReason: partial ?? extracted.partialReason }
      : sections.length ? { title: gist.description || 'GitHub Gist', text: combined, markdown: fencedText(combined),
        url: parsed.href, format: 'markdown', partialReason: partial } : null;
  } else if (parsed.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/blob\//.test(parsed.pathname)) {
    url = `https://raw.githubusercontent.com${parsed.pathname.replace('/blob/', '/')}`;
  }
  const result = await fetchWithLimit(url);
  if (/^(image|video)\//.test(result.contentType)) {
    return { title: new URL(result.url).pathname.split('/').pop() || 'Linked Media',
      text: `Linked media: ${result.url}`, url: result.url, format: 'asset',
      images: result.contentType.startsWith('image/') ? [result.url] : [],
      videos: result.contentType.startsWith('video/') ? [result.url] : [] };
  }
  const text = new TextDecoder().decode(result.bytes);
  if (result.contentType.includes('application/pdf') || text.startsWith('%PDF-')) {
    return extractPdfText(result.bytes, result.url);
  }
  if (/text\/html|application\/xhtml/.test(result.contentType) || /^\s*(?:<!doctype html|<html)/i.test(text)) {
    return extractReadableText(text, result.url);
  }
  const format = /json/.test(result.contentType) ? 'json' : /markdown|\.md(?:$|\?)/.test(result.contentType + result.url) ? 'markdown' : 'text';
  if (!/text\/|json|xml|javascript/.test(result.contentType)) throw new Error(`unsupported content type: ${result.contentType || 'missing'}`);
  const body = format === 'json' ? JSON.stringify(JSON.parse(text), null, 2) : text.trim();
  if (!body.length) return null;
  if (format === 'markdown') {
    const extracted = extractReadableText(`<main>${marked.parse(body, { async: false })}</main>`, result.url);
    if (extracted) return { ...extracted, format };
  }
  return { title: decodeURIComponent(new URL(result.url).pathname.split('/').pop() || new URL(result.url).hostname),
    text: body.slice(0, MAX_TEXT_CHARS), markdown: fencedText(body.slice(0, MAX_TEXT_CHARS)), url: result.url, format,
    partialReason: body.length > MAX_TEXT_CHARS ? 'text limit reached' : undefined };
}

function fencedText(text: string): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}\n${text}\n${fence}`;
}

async function extractPdfText(bytes: Uint8Array, url: string): Promise<ArticleContent> {
  // Isolate untrusted PDF parsing with time/memory/page bounds; never execute PDF scripts.
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { getDocumentProxy } = await import(${JSON.stringify(import.meta.resolve('unpdf'))});
        const pdf = await getDocumentProxy(workerData, { isEvalSupported: false, useSystemFonts: false,
          disableFontFace: true, useWorkerFetch: false, maxImageSize: 0 });
        try {
          const pages = [];
          for (let i = 1; i <= Math.min(pdf.numPages, 100); i++) {
            const page = await pdf.getPage(i), content = await page.getTextContent();
            pages.push(content.items.map(item => item.str ? item.str + (item.hasEOL ? '\\n' : ' ') : '').join(''));
          }
          const metadata = await pdf.getMetadata().catch(() => ({}));
          parentPort.postMessage({ text: pages.join('\\n\\n'), title: metadata.info?.Title, pages: pdf.numPages });
        } finally { await pdf.destroy(); }
      })().catch(error => parentPort.postMessage({ error: error.message }));
    `, { eval: true, workerData: bytes, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('PDF parsing timeout')); }, 15_000);
    worker.once('error', (error) => { clearTimeout(timer); reject(error); });
    worker.once('exit', (code) => { clearTimeout(timer); if (code) reject(new Error(`PDF parser exited ${code}`)); });
    worker.once('message', (message) => {
      clearTimeout(timer); void worker.terminate();
      if (message.error) return reject(new Error(`PDF extraction: ${message.error}`));
      if (message.text.trim().length < 50) return reject(new Error('PDF has no extractable text; OCR may be required'));
      resolve({ title: (typeof message.title === 'string' ? message.title : '') || new URL(url).pathname.split('/').pop() || 'PDF', text: message.text.slice(0, MAX_TEXT_CHARS),
        format: 'pdf', url, partialReason: message.pages > 100 ? 'PDF page limit reached (100 pages)' : message.text.length > MAX_TEXT_CHARS ? 'text limit reached' : undefined });
    });
  });
}

/**
 * Resolve t.co shortlinks — returns the expanded URL after walking
 * redirects, with isSafeUrl re-checked on every hop. Returns null if any
 * hop points at a blocked host or resolution fails.
 */
export async function resolveTcoLink(url: string): Promise<string | null> {
  if (!url.includes('t.co/')) return url;

  const result = await fetchFollowingRedirects(url, {
    method: 'HEAD',
    signal: AbortSignal.timeout(5_000),
  });
  if (!result) return null;

  try { await result.response.body?.cancel(); } catch { /* ignore */ }

  const resolved = result.finalUrl;
  if (new URL(resolved).hostname !== 't.co') return resolved;
  // Some shorteners return 200/405 to HEAD, or use an HTML refresh instead of a redirect.
  const fallback = await fetchWithLimit(url);
  if (new URL(fallback.url).hostname !== 't.co') return fallback.url;
  const dom = new JSDOM(new TextDecoder().decode(fallback.bytes), { url: fallback.url });
  try {
    const document = dom.window.document;
    const refresh = document.querySelector('meta[http-equiv="refresh" i]')?.getAttribute('content')?.match(/url\s*=\s*["']?([^"']+)/i)?.[1]?.trim();
    const target = absoluteUrl(refresh ?? document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null, fallback.url);
    return target && new URL(target).hostname !== 't.co' ? target : null;
  } finally { dom.window.close(); }
}
