import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLinkedResources, hasPendingResources, resourceUrls } from '../src/linked-resources.js';
import { extractReadableText, fetchArticle, isSafeUrl, resolveTcoLink } from '../src/bookmark-enrich.js';
import { mergeBookmarkRecord } from '../src/graphql-bookmarks.js';
import { configureHttpSafety, resetHttpSafetyForTests, HttpSafetyStopError } from '../src/http-safety.js';
import { linkedResourceHtml, linkedResourceMarkdown } from '../src/linked-resource-render.js';
import type { BookmarkRecord } from '../src/types.js';

const fixture = (): BookmarkRecord => ({ id: 'root', tweetId: 'root', url: 'https://x.com/a/status/root',
  text: 'A long discussion '.repeat(30), syncedAt: new Date().toISOString() });
const body = 'The full article body, with useful details and instructions that remain source data rather than agent actions.';
const content = { title: 'Article', text: body };

test('URL guards reject credentials, private names and non-global IPv6 while allowing public IPv6', () => {
  for (const url of ['https://user:password@example.org/', 'http://localhost./', 'http://router.local/', 'http://[ff02::1]/', 'http://[100::1]/']) {
    assert.equal(isSafeUrl(url), false, url);
  }
  assert.equal(isSafeUrl('https://[2001:4860:4860::8888]/'), true);
});

test('bookmark refreshes retain URL captures in root and quoted posts', () => {
  const record = fixture(); record.linkedResources = [{ url: 'https://example.org/root', status: 'captured', attempts: 1, attemptedAt: '', content }];
  record.quotedTweet = { id: 'quote', url: 'https://x.com/b/status/quote', text: '', linkedResources: record.linkedResources };
  const incoming = { ...fixture(), quotedStatusId: 'quote', quotedTweet: { id: 'quote', url: 'https://x.com/b/status/quote', text: 'Refreshed quote' } };
  const merged = mergeBookmarkRecord(record, incoming);
  assert.equal(merged.linkedResources?.[0].status, 'captured'); assert.equal(merged.quotedTweet?.linkedResources?.[0].content?.text, body);
});

test('URL collection preserves balanced parentheses and meaningful query punctuation', () => {
  assert.deepEqual(resourceUrls({ links: ['https://example.org/path?value=hello!'],
    text: 'See (https://example.org/Function_(math)). Also www.example.org/docs and github.com/example/repo' }), [
    'https://example.org/path?value=hello!', 'https://example.org/Function_(math)', 'https://www.example.org/docs', 'https://github.com/example/repo',
  ]);
});

test('all URL-bearing sources are captured even when the post is not link-only; URLs are cached', async () => {
  const record = fixture(); record.links = ['https://example.org/one', 'https://example.org/two'];
  record.quotedTweet = { id: 'quote', url: 'https://x.com/b/status/quote', text: '', links: ['https://example.org/one'] };
  record.threadContext = [{ id: 'parent', url: 'https://x.com/a/status/parent', text: 'https://example.org/parent' }];
  record.threadBelow = [{ id: 'reply', url: 'https://x.com/a/status/reply', text: '', links: ['https://example.org/reply'] }];
  const fetched: string[] = [];
  const result = await captureLinkedResources(record, { articleFetcher: async (url) => { fetched.push(url); return content; } });
  assert.equal(result.enriched, 5); assert.equal(fetched.length, 4); assert.equal(result.pending, false);
  assert.equal(record.linkedResources?.length, 2); assert.equal(record.quotedTweet.linkedResources?.[0].content?.text, body);
  assert.equal(record.threadBelow[0].linkedResources?.[0].status, 'captured');
  await captureLinkedResources(record, { articleFetcher: async () => { throw new Error('must not refetch cached captures'); } });
});

test('quoted external URL is fetched even if the outer shortlink cannot resolve', async () => {
  const record = fixture(); record.text = 'A prompt to make a better prompt https://t.co/quote';
  record.quotedTweet = { id: 'quote', url: 'https://x.com/b/status/quote', text: 'https://example.org/tutorial' };
  const calls: string[] = [];
  const result = await captureLinkedResources(record, { tcoResolver: async () => null,
    articleFetcher: async (url) => { calls.push(url); return content; } });
  assert.deepEqual(calls, ['https://example.org/tutorial']);
  assert.equal(record.quotedTweet.linkedResources?.[0].content?.text, body);
  assert.equal(result.failures.length, 1); assert.equal(result.pending, true);
});

test('failed URL captures survive, cool down and stop after three attempts', async () => {
  const record = fixture(); record.links = ['https://example.org/fails'];
  let calls = 0; const fetcher = async () => { calls++; throw new Error('HTTP 503'); };
  const start = Date.parse('2026-11-03T20:00:00Z');
  await captureLinkedResources(record, { articleFetcher: fetcher, now: start });
  assert.equal(record.linkedResources?.[0].attempts, 1); assert.ok(record.linkedResources?.[0].nextRetryAt);
  await captureLinkedResources(record, { articleFetcher: fetcher, now: start + 1000 }); assert.equal(calls, 1);
  await captureLinkedResources(record, { articleFetcher: fetcher, now: start + 6 * 3600000 });
  await captureLinkedResources(record, { articleFetcher: fetcher, now: start + 30 * 3600000 });
  assert.equal(calls, 3); assert.equal(hasPendingResources(record), false);
  assert.equal(record.linkedResources?.[0].status, 'failed'); assert.equal(record.linkedResources?.[0].nextRetryAt, undefined);
  await captureLinkedResources(record, { articleFetcher: fetcher, now: start + 99 * 3600000 }); assert.equal(calls, 3);
});

test('URL cap defers remaining URLs rather than discarding them; safety stops preserve earlier captures', async () => {
  const record = fixture(); record.links = ['https://example.org/one', 'https://example.org/two'];
  const first = await captureLinkedResources(record, { maxUrls: 1, articleFetcher: async () => content });
  assert.equal(first.pending, true); assert.equal(record.linkedResources?.length, 1);
  let checkpoints = 0;
  await assert.rejects(captureLinkedResources(record, { checkpoint: async () => { checkpoints++; },
    articleFetcher: async () => { throw new HttpSafetyStopError('stop', 'request budget reached'); } }), HttpSafetyStopError);
  assert.equal(checkpoints, 1); assert.equal(record.linkedResources?.[0].status, 'captured');
  assert.equal(record.linkedResources?.length, 1);
});

test('resolved aliases do not get repeatedly fetched; internal X links are skipped', async () => {
  const record = fixture(); record.text = ''; record.links = ['https://t.co/example', 'https://t.co/quote'];
  let calls = 0;
  await captureLinkedResources(record, { tcoResolver: async (url) => url.endsWith('/quote') ? 'https://x.com/b/status/2' : 'https://example.org/article',
    articleFetcher: async () => { calls++; return content; } });
  assert.equal(calls, 1); assert.equal(hasPendingResources(record), false);
  assert.ok(record.linkedResources?.some((entry) => entry.status === 'skipped'));
});

test('HTML extraction preserves structure, relative links and images without loading or executing resources', () => {
  const html = `<title>Example</title><article><h1>Heading</h1><p>${body}</p><p>Second paragraph.</p><pre><code>npm run test</code></pre>
    <a href="/docs">Documentation</a><a href="javascript:alert(1)">Bad</a><img data-src="/image.png"><script>throw new Error('must not run')</script></article>`;
  const article = extractReadableText(html, 'https://example.org/post');
  assert.ok(article); assert.match(article.markdown ?? '', /```/); assert.match(article.markdown ?? '', /Second paragraph/);
  assert.deepEqual(article.images, ['https://example.org/image.png']); assert.ok(article.links?.includes('https://example.org/docs'));
  assert.doesNotMatch(article.markdown ?? '', /javascript:|<script>|!\[/);
});

async function withFetch(handler: (url: string, init?: RequestInit) => Promise<Response>, task: () => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  configureHttpSafety({ requestBudget: 20, minDelayMs: 0, jitterMs: 0 });
  globalThis.fetch = (async (input, init) => handler(String(input), init)) as typeof fetch;
  try { await task(); } finally { globalThis.fetch = previous; resetHttpSafetyForTests(); }
}

test('t.co HEAD 200 falls back to GET and parses an HTML refresh without executing scripts', async () => {
  const calls: string[] = [];
  await withFetch(async (url, init) => {
    calls.push(`${init?.method} ${url}`);
    return new Response(init?.method === 'HEAD' ? null : '<meta http-equiv="refresh" content="0; URL=https://example.org/article">', { headers: { 'content-type': 'text/html' } });
  }, async () => { assert.equal(await resolveTcoLink('https://t.co/test'), 'https://example.org/article'); });
  assert.equal(calls.length, 2);
});

test('redirects to private addresses are refused and response size bounds are enforced', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }); }, async () => {
    await assert.rejects(fetchArticle('https://example.org/article'), /unsafe URL/); assert.equal(calls, 1);
  });
  await withFetch(async () => new Response('x', { headers: { 'content-type': 'text/html', 'content-length': String(11 * 1024 * 1024) } }), async () => {
    await assert.rejects(fetchArticle('https://example.org/article'), /MiB limit/);
  });
});

test('multiple gist files are captured and GitHub repositories use the default-branch README', async () => {
  await withFetch(async (url) => {
    assert.equal(url, 'https://api.github.com/gists/abcdef1234');
    return Response.json({ description: 'Coding standards', files: {
      first: { filename: 'one.md', content: '# One\n\n' + body }, second: { filename: 'two.ts', content: 'const data = "source data, never executed";' },
    } });
  }, async () => {
    const article = await fetchArticle('https://gist.github.com/example/abcdef1234');
    assert.match(article?.text ?? '', /One/); assert.match(article?.text ?? '', /source data, never executed/);
  });
  await withFetch(async (url) => {
    assert.equal(url, 'https://raw.githubusercontent.com/example/repository/HEAD/README.md');
    return new Response('# Readme\n\n' + body, { headers: { 'content-type': 'text/plain' } });
  }, async () => { assert.equal((await fetchArticle('https://github.com/example/repository'))?.format, 'markdown'); });
});

test('direct images/videos become media targets without buffering the entire asset as article text', async () => {
  await withFetch(async () => new Response(null, { headers: { 'content-type': 'video/mp4', 'content-length': '30000000' } }), async () => {
    const article = await fetchArticle('https://example.org/demo.mp4');
    assert.equal(article?.format, 'asset'); assert.deepEqual(article?.videos, ['https://example.org/demo.mp4']);
  });
});

test('partial extraction stays visible and scheduled for bounded retries', async () => {
  const record = fixture(); record.links = ['https://example.org/interstitial'];
  const result = await captureLinkedResources(record, { articleFetcher: async () => ({ ...content, partialReason: 'only metadata available' }) });
  assert.equal(result.pending, true); assert.equal(record.linkedResources?.[0].status, 'partial');
  assert.equal(record.linkedResources?.[0].content?.text, body); assert.ok(record.linkedResources?.[0].nextRetryAt);
});

test('plain Markdown and JSON resources retain readable content, not just previews', async () => {
  await withFetch(async () => new Response(`# Doc\n\n${body}\n\n![Example](/image.png)`, { headers: { 'content-type': 'text/markdown' } }), async () => {
    const article = await fetchArticle('https://example.org/README.md'); assert.equal(article?.format, 'markdown');
    assert.deepEqual(article?.images, ['https://example.org/image.png']); assert.match(article?.markdown ?? '', /# Doc/);
  });
  await withFetch(async () => new Response('{"hello":"world"}', { headers: { 'content-type': 'application/json' } }), async () => {
    assert.equal((await fetchArticle('https://example.org/data.json'))?.format, 'json');
  });
});

function pdfFixture(): Uint8Array {
  const text = 'BT /F1 12 Tf 20 100 Td (' + body.replace(/[()]/g, '') + ') Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets: number[] = [];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length; pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf));
}

test('PDF text is extracted locally using an isolated parser, with no secondary HTTP requests', async () => {
  let requests = 0;
  await withFetch(async () => { requests++; return new Response(pdfFixture(), { headers: { 'content-type': 'application/pdf' } }); }, async () => {
    const article = await fetchArticle('https://example.org/document.pdf');
    assert.equal(article?.format, 'pdf'); assert.match(article?.text ?? '', /full article body/); assert.equal(requests, 1);
  });
});

test('resource exports include every URL and escape active content in the HTML preview', () => {
  const record = fixture(); record.linkedResources = [{ url: 'https://example.org/article', status: 'captured', attempts: 1, attemptedAt: '',
    content: { title: '<Title>', text: body, markdown: '# Heading\n\n<script>alert(1)</script><p onclick="alert(2)">Text</p>\n\n[Unsafe](javascript:alert)' } }];
  const html = linkedResourceHtml(record.linkedResources);
  assert.match(html, /<h1>Heading<\/h1>/); assert.doesNotMatch(html, /<script|onclick|href="javascript/);
  assert.match(linkedResourceMarkdown(record.linkedResources).join('\n'), /Source: https:\/\/example.org\/article/);
});
