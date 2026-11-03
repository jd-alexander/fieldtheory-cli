import type { BookmarkRecord, QuotedTweetSnapshot, ThreadTweetSnapshot } from './types.js';
import { fetchArticle, isSafeUrl, isTwitterUrl, resolveTcoLink, type ArticleContent, type LinkedResource } from './bookmark-enrich.js';
import { isHttpSafetyStop } from './http-safety.js';

type Source = BookmarkRecord | QuotedTweetSnapshot | ThreadTweetSnapshot;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [6 * 60 * 60_000, 24 * 60 * 60_000];

export function linkedSources(record: BookmarkRecord): Source[] {
  return [record, ...(record.quotedTweet ? [record.quotedTweet] : []), ...(record.threadContext ?? []), ...(record.threadBelow ?? [])];
}

export function resourceUrls(source: Pick<Source, 'text' | 'links'>): string[] {
  const urls = [...(source.links ?? []).map((value) => ({ value, text: false })),
    ...(source.text.match(/(?:https?:\/\/|www\.|(?:gist\.)?github\.com\/)[^\s<>"\]`]+/gi) ?? []).map((value) => ({ value, text: !(source.links ?? []).includes(value) }))];
  return [...new Set(urls.flatMap(({ value, text }) => {
    try {
      let cleaned = text ? value.replace(/[.,;!?]+$/, '') : value;
      while (text && cleaned.endsWith(')') && (cleaned.match(/\)/g)?.length ?? 0) > (cleaned.match(/\(/g)?.length ?? 0)) cleaned = cleaned.slice(0, -1);
      const url = new URL(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`);
      url.hash = '';
      return ['http:', 'https:'].includes(url.protocol) && !isTwitterUrl(url.href) ? [url.href] : [];
    } catch { return []; }
  }))];
}

export function hasPendingResources(record: BookmarkRecord): boolean {
  return linkedSources(record).some((source) => resourceUrls(source).some((url) => {
    const capture = source.linkedResources?.find((entry) => entry.url === url || entry.resolvedUrl === url);
    return !capture || ((capture.status === 'failed' || capture.status === 'partial') && capture.attempts < MAX_ATTEMPTS);
  }));
}

export async function captureLinkedResources(record: BookmarkRecord, options: {
  articleFetcher?: (url: string) => Promise<ArticleContent | null>;
  tcoResolver?: (url: string) => Promise<string | null>;
  cache?: Map<string, Promise<ArticleContent | null>>;
  now?: number;
  maxUrls?: number;
  checkpoint?: () => Promise<void>;
} = {}): Promise<{ enriched: number; pending: boolean; failures: Array<{ tweetId: string; sourceTweetId: string; reason: string; url: string }> }> {
  const fetcher = options.articleFetcher ?? fetchArticle, resolver = options.tcoResolver ?? resolveTcoLink;
  const cache = options.cache ?? new Map<string, Promise<ArticleContent | null>>();
  const now = options.now ?? Date.now(), attemptedAt = new Date(now).toISOString();
  let attempted = 0, enriched = 0;
  const failures: Array<{ tweetId: string; sourceTweetId: string; reason: string; url: string }> = [];
  // Prefer already-expanded article URLs before opaque shortlinks/quote permalinks.
  const candidates = linkedSources(record).flatMap((source) => resourceUrls(source).map((url) => ({ source, url })))
    .sort((a, b) => Number(new URL(a.url).hostname === 't.co') - Number(new URL(b.url).hostname === 't.co'));
  for (const { source, url } of candidates) {
    const previous = source.linkedResources?.find((entry) => entry.url === url || entry.resolvedUrl === url);
    if (previous?.status === 'captured' || previous?.status === 'skipped') continue;
    if (previous && (previous.attempts >= MAX_ATTEMPTS || Date.parse(previous.nextRetryAt ?? '') > now)) continue;
    if (attempted >= (options.maxUrls ?? 6)) break;
    attempted++;
    const capture: LinkedResource = { url, resolvedUrl: previous?.resolvedUrl, attempts: (previous?.attempts ?? 0) + 1, attemptedAt, status: 'failed' };
    try {
      if (!isSafeUrl(url)) { capture.status = 'skipped'; capture.reason = 'unsafe URL'; }
      else {
        const resolved = capture.resolvedUrl ?? (new URL(url).hostname === 't.co' ? await resolver(url) : url);
        if (!resolved) throw new Error('link target could not be resolved');
        capture.resolvedUrl = resolved;
        if (!isSafeUrl(resolved) || isTwitterUrl(resolved)) {
          capture.status = 'skipped'; capture.reason = isTwitterUrl(resolved) ? 'X post link; handled as tweet context' : 'unsafe redirect';
        } else {
          if (!cache.has(resolved)) cache.set(resolved, fetcher(resolved));
          const content = await cache.get(resolved)!;
          if (!content?.text.trim()) throw new Error('no article text extracted');
          capture.content = content;
          capture.status = content.partialReason ? 'partial' : 'captured';
          capture.reason = content.partialReason;
          enriched++;
          // Preserve the existing article fields for search/older consumers. Every URL has its own capture below.
          if (!source.articleText) {
            source.articleTitle = content.title; source.articleText = content.text; source.articleSite = content.siteName;
            source.enrichedAt = attemptedAt;
          }
        }
      }
    } catch (error) {
      if (isHttpSafetyStop(error)) { await options.checkpoint?.(); throw error; }
      capture.reason = (error as Error).message || 'URL extraction failed';
    }
    if (capture.status === 'failed' || capture.status === 'partial') {
      if (capture.attempts < MAX_ATTEMPTS) capture.nextRetryAt = new Date(now + RETRY_DELAYS[capture.attempts - 1]).toISOString();
      failures.push({ tweetId: record.id, sourceTweetId: 'tweetId' in source ? source.tweetId : source.id,
        reason: capture.reason ?? 'incomplete extraction', url: capture.resolvedUrl ?? url });
      // A failed refresh must not discard a previously saved partial body.
      capture.content ??= previous?.content;
    }
    source.linkedResources = [...(source.linkedResources ?? []).filter((entry) => entry.url !== url), capture];
    if (capture.resolvedUrl && capture.resolvedUrl !== url && !isTwitterUrl(capture.resolvedUrl)) {
      source.links = [...new Set([...(source.links ?? []), capture.resolvedUrl])];
    }
    await options.checkpoint?.();
  }
  return { enriched, failures, pending: hasPendingResources(record) };
}
