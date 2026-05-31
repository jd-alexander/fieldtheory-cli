import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { ensureDir, pathExists, readJson, readJsonLines, writeJson } from './fs.js';
import { bookmarkMediaDir, bookmarkMediaManifestPath, twitterBookmarksCachePath } from './paths.js';
import type { BookmarkMediaObject, BookmarkRecord, ThreadTweetSnapshot } from './types.js';
import { controlledFetch, isHttpSafetyStop } from './http-safety.js';

export const DEFAULT_MEDIA_MAX_BYTES = 200 * 1024 * 1024;
export const MEDIA_QUALITY_VALUES = ['medium', 'large', '4096x4096', 'orig'] as const;
export type MediaQuality = typeof MEDIA_QUALITY_VALUES[number];
export const DEFAULT_MEDIA_QUALITY: MediaQuality = 'medium';

export interface MediaFetchEntry {
  bookmarkId: string;
  tweetId: string;
  tweetUrl: string;
  authorHandle?: string;
  authorName?: string;
  sourceUrl: string;
  localPath?: string;
  contentType?: string;
  bytes?: number;
  status: 'downloaded' | 'skipped_too_large' | 'failed';
  reason?: string;
  fetchedAt: string;
}

export interface MediaFetchManifest {
  schemaVersion: 1;
  generatedAt: string;
  limit: number;
  maxBytes: number;
  mediaQuality?: MediaQuality;
  stopReason?: string;
  processed: number;
  downloaded: number;
  skippedTooLarge: number;
  failed: number;
  entries: MediaFetchEntry[];
}

export interface MediaFetchProgress {
  candidateBookmarks: number;
  processed: number;
  downloaded: number;
  skippedTooLarge: number;
  failed: number;
  currentSourceUrl?: string;
}

interface MediaFetchTarget {
  bookmarkId: string;
  tweetId: string;
  tweetUrl: string;
  authorHandle?: string;
  authorName?: string;
  sourceUrl: string;
  isProfileImage: boolean;
}

interface MediaTargetSource {
  tweetId: string;
  tweetUrl: string;
  authorHandle?: string;
  authorName?: string;
  authorProfileImageUrl?: string;
  media?: string[];
  mediaObjects?: BookmarkMediaObject[];
  articleCoverMedia?: unknown;
  articleMediaEntities?: unknown[];
}

interface CachedMediaResult {
  localPath?: string;
  contentType?: string;
  bytes?: number;
  status: MediaFetchEntry['status'];
  reason?: string;
  fetchedAt: string;
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function mediaEntryKey(tweetId: string, sourceUrl: string, isProfileImage: boolean): string {
  return isProfileImage ? `profile::${sourceUrl}` : `${tweetId}::${sourceUrl}`;
}

function mediaEntryKeyFromEntry(entry: MediaFetchEntry): string {
  return mediaEntryKey(entry.tweetId, entry.sourceUrl, entry.sourceUrl.includes('/profile_images/'));
}

function sanitizeExtFromContentType(contentType?: string, sourceUrl?: string): string {
  if (contentType?.includes('jpeg')) return '.jpg';
  if (contentType?.includes('png')) return '.png';
  if (contentType?.includes('gif')) return '.gif';
  if (contentType?.includes('webp')) return '.webp';
  if (contentType?.includes('mp4')) return '.mp4';
  try {
    const ext = path.extname(new URL(sourceUrl ?? '').pathname);
    if (ext) return ext;
  } catch {}
  return '.bin';
}

export function parseMediaQuality(value: unknown): MediaQuality {
  const quality = String(value ?? DEFAULT_MEDIA_QUALITY);
  if ((MEDIA_QUALITY_VALUES as readonly string[]).includes(quality)) return quality as MediaQuality;
  throw new Error(`Invalid media quality "${quality}". Use one of: ${MEDIA_QUALITY_VALUES.join(', ')}`);
}

function applyPhotoMediaQuality(sourceUrl: string, quality: MediaQuality): string {
  if (quality === 'medium') return sourceUrl;
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.hostname !== 'pbs.twimg.com' || !parsed.pathname.startsWith('/media/')) {
      return sourceUrl;
    }
    parsed.searchParams.set('name', quality);
    return parsed.toString();
  } catch {
    return sourceUrl;
  }
}

function extractArticleMediaUrl(media: unknown): string | undefined {
  if (!media || typeof media !== 'object') return undefined;
  const value = media as any;
  return value.media_info?.original_img_url ??
    value.mediaInfo?.originalImgUrl ??
    value.original_img_url ??
    value.originalImageUrl ??
    value.url;
}

async function loadManifest(): Promise<MediaFetchManifest | null> {
  const manifestPath = bookmarkMediaManifestPath();
  if (!(await pathExists(manifestPath))) return null;
  return readJson<MediaFetchManifest>(manifestPath);
}

function hasArticleMediaTargets(source: { articleCoverMedia?: unknown; articleMediaEntities?: unknown[] } | undefined): boolean {
  if (!source) return false;
  return Boolean(extractArticleMediaUrl(source.articleCoverMedia)) || (source.articleMediaEntities ?? []).some((entity) => Boolean(extractArticleMediaUrl(entity)));
}

function hasTargets(source: { media?: unknown[]; mediaObjects?: unknown[]; authorProfileImageUrl?: string; articleCoverMedia?: unknown; articleMediaEntities?: unknown[] } | undefined): boolean {
  if (!source) return false;
  return (source.media?.length ?? 0) > 0 ||
    (source.mediaObjects?.length ?? 0) > 0 ||
    Boolean(source.authorProfileImageUrl) ||
    hasArticleMediaTargets(source);
}

function hasMediaCandidate(bookmark: BookmarkRecord): boolean {
  return hasTargets(bookmark)
    || hasTargets(bookmark.quotedTweet)
    || (bookmark.threadContext ?? []).some(hasTargets)
    || (bookmark.threadBelow ?? []).some(hasTargets);
}

function pushTarget(
  targets: MediaFetchTarget[],
  seenKeys: Set<string>,
  base: Omit<MediaFetchTarget, 'sourceUrl' | 'isProfileImage'>,
  sourceUrl: string | undefined,
  isProfileImage: boolean,
): void {
  if (!sourceUrl) return;
  const key = mediaEntryKey(base.tweetId, sourceUrl, isProfileImage);
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  targets.push({
    ...base,
    sourceUrl,
    isProfileImage,
  });
}

function appendMediaTargets(
  targets: MediaFetchTarget[],
  seenKeys: Set<string>,
  bookmarkId: string,
  source: MediaTargetSource,
  downloadedProfileImageUrls: Set<string>,
  skipProfileImages: boolean,
  mediaQuality: MediaQuality,
): void {
  const base = {
    bookmarkId,
    tweetId: source.tweetId,
    tweetUrl: source.tweetUrl,
    authorHandle: source.authorHandle,
    authorName: source.authorName,
  };

  if (source.mediaObjects?.length) {
    for (const mo of source.mediaObjects) {
      const previewUrl = mo.previewUrl ?? mo.url ?? mo.mediaUrl;
      if (mo.type === 'video' || mo.type === 'animated_gif') {
        pushTarget(targets, seenKeys, base, previewUrl, false);
        const mp4s = (mo.videoVariants ?? mo.variants ?? [])
          .filter((v) => v.url && (!v.contentType || v.contentType === 'video/mp4'))
          .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
        pushTarget(targets, seenKeys, base, mp4s[0]?.url, false);
        continue;
      }
      pushTarget(targets, seenKeys, base, previewUrl ? applyPhotoMediaQuality(previewUrl, mediaQuality) : undefined, false);
    }
  } else {
    for (const mediaUrl of source.media ?? []) {
      pushTarget(targets, seenKeys, base, applyPhotoMediaQuality(mediaUrl, mediaQuality), false);
    }
  }

  const articleMediaUrls = [
    extractArticleMediaUrl(source.articleCoverMedia),
    ...(source.articleMediaEntities ?? []).map(extractArticleMediaUrl),
  ];
  for (const mediaUrl of articleMediaUrls) {
    pushTarget(targets, seenKeys, base, mediaUrl ? applyPhotoMediaQuality(mediaUrl, mediaQuality) : undefined, false);
  }

  if (source.authorProfileImageUrl && !skipProfileImages) {
    const fullUrl = source.authorProfileImageUrl.replace('_normal.', '_400x400.');
    if (!downloadedProfileImageUrls.has(fullUrl)) {
      pushTarget(targets, seenKeys, base, fullUrl, true);
    }
  }
}

function resolveMediaTargets(
  bookmark: BookmarkRecord,
  downloadedProfileImageUrls: Set<string>,
  skipProfileImages: boolean,
  mediaQuality: MediaQuality,
): MediaFetchTarget[] {
  const targets: MediaFetchTarget[] = [];
  const seenKeys = new Set<string>();

  appendMediaTargets(targets, seenKeys, bookmark.id, {
    tweetId: bookmark.tweetId,
    tweetUrl: bookmark.url,
    authorHandle: bookmark.authorHandle,
    authorName: bookmark.authorName,
    authorProfileImageUrl: bookmark.authorProfileImageUrl,
    media: bookmark.media,
    mediaObjects: bookmark.mediaObjects,
    articleCoverMedia: bookmark.articleCoverMedia,
    articleMediaEntities: bookmark.articleMediaEntities,
  }, downloadedProfileImageUrls, skipProfileImages, mediaQuality);

  if (bookmark.quotedTweet) {
    appendMediaTargets(targets, seenKeys, bookmark.id, {
      tweetId: bookmark.quotedTweet.id,
      tweetUrl: bookmark.quotedTweet.url,
      authorHandle: bookmark.quotedTweet.authorHandle,
      authorName: bookmark.quotedTweet.authorName,
      authorProfileImageUrl: bookmark.quotedTweet.authorProfileImageUrl,
      media: bookmark.quotedTweet.media,
      mediaObjects: bookmark.quotedTweet.mediaObjects,
      articleCoverMedia: bookmark.quotedTweet.articleCoverMedia,
      articleMediaEntities: bookmark.quotedTweet.articleMediaEntities,
    }, downloadedProfileImageUrls, skipProfileImages, mediaQuality);
  }

  const appendThreadTweet = (tweet: ThreadTweetSnapshot): void => {
    appendMediaTargets(targets, seenKeys, bookmark.id, {
      tweetId: tweet.id,
      tweetUrl: tweet.url,
      authorHandle: tweet.authorHandle,
      authorName: tweet.authorName,
      authorProfileImageUrl: tweet.authorProfileImageUrl,
      media: tweet.media,
      mediaObjects: tweet.mediaObjects,
      articleCoverMedia: tweet.articleCoverMedia,
      articleMediaEntities: tweet.articleMediaEntities,
    }, downloadedProfileImageUrls, skipProfileImages, mediaQuality);
  };

  for (const tweet of bookmark.threadContext ?? []) appendThreadTweet(tweet);
  for (const tweet of bookmark.threadBelow ?? []) appendThreadTweet(tweet);

  return targets;
}

function failedEntryBackoffMs(entry: MediaFetchEntry): number {
  if (entry.reason === 'HTTP 404' && entry.sourceUrl.includes('/profile_images/')) {
    return 365 * DAY_MS;
  }
  if (entry.reason === 'HTTP 403' && (entry.sourceUrl.includes('video.twimg.com') || entry.sourceUrl.includes('/amplify_video/'))) {
    return 30 * DAY_MS;
  }
  if (entry.reason === 'HTTP 404' && entry.sourceUrl.includes('pbs.twimg.com/media/')) {
    return DAY_MS;
  }
  return HOUR_MS;
}

function isFailedEntryCovered(entry: MediaFetchEntry, nowMs: number): boolean {
  const fetchedAtMs = new Date(entry.fetchedAt).getTime();
  if (Number.isNaN(fetchedAtMs)) return false;
  return nowMs - fetchedAtMs < failedEntryBackoffMs(entry);
}

function isCoveredEntry(entry: MediaFetchEntry, maxBytes: number, retryFailed: boolean, nowMs: number): boolean {
  if (entry.status === 'downloaded') return true;
  if (entry.status === 'failed') return !retryFailed && isFailedEntryCovered(entry, nowMs);
  if (entry.status !== 'skipped_too_large') return false;
  return typeof entry.bytes === 'number' && !Number.isNaN(entry.bytes) && entry.bytes > maxBytes;
}

function buildCoveredAssetKeys(previous: MediaFetchManifest | null, maxBytes: number, retryFailed: boolean, nowMs: number): Set<string> {
  return new Set(
    (previous?.entries ?? [])
      .filter((entry) => !entry.sourceUrl.includes('/profile_images/'))
      .filter((entry) => isCoveredEntry(entry, maxBytes, retryFailed, nowMs))
      .map((entry) => `${entry.tweetId}::${entry.sourceUrl}`),
  );
}

function buildCoveredProfileImageUrls(previous: MediaFetchManifest | null, maxBytes: number, retryFailed: boolean, nowMs: number): Set<string> {
  return new Set(
    (previous?.entries ?? [])
      .filter((entry) => entry.sourceUrl.includes('/profile_images/'))
      .filter((entry) => isCoveredEntry(entry, maxBytes, retryFailed, nowMs))
      .map((entry) => entry.sourceUrl),
  );
}

function hasPendingMediaTarget(
  bookmark: BookmarkRecord,
  coveredAssetKeys: Set<string>,
  coveredProfileImageUrls: Set<string>,
  skipProfileImages: boolean,
  mediaQuality: MediaQuality,
): boolean {
  return resolveMediaTargets(bookmark, coveredProfileImageUrls, skipProfileImages, mediaQuality).some(({ tweetId, sourceUrl, isProfileImage }) => {
    if (isProfileImage) return true;
    return !coveredAssetKeys.has(`${tweetId}::${sourceUrl}`);
  });
}

export async function fetchBookmarkMediaBatch(
  options: {
    limit?: number;
    maxBytes?: number;
    skipProfileImages?: boolean;
    retryFailed?: boolean;
    mediaQuality?: MediaQuality;
    folderNames?: string[];
    signal?: AbortSignal;
    onProgress?: (progress: MediaFetchProgress) => void;
  } = {}
): Promise<MediaFetchManifest> {
  const limit = typeof options.limit === 'number' && !Number.isNaN(options.limit)
    ? Math.max(0, options.limit)
    : Infinity;
  const maxBytes = options.maxBytes ?? DEFAULT_MEDIA_MAX_BYTES;
  const skipProfileImages = options.skipProfileImages ?? false;
  const retryFailed = options.retryFailed ?? false;
  const mediaQuality = options.mediaQuality ?? DEFAULT_MEDIA_QUALITY;
  const folderNames = (options.folderNames ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean);
  const nowMs = Date.now();
  const mediaDir = bookmarkMediaDir();
  const manifestPath = bookmarkMediaManifestPath();
  await ensureDir(mediaDir);

  const previous = await loadManifest();
  const coveredAssetKeys = buildCoveredAssetKeys(previous, maxBytes, retryFailed, nowMs);
  const coveredProfileImageUrls = buildCoveredProfileImageUrls(previous, maxBytes, retryFailed, nowMs);
  const bookmarks = await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath());
  const candidates = bookmarks
    .filter((bookmark) =>
      folderNames.length === 0 ||
      (bookmark.folderNames ?? []).some((name) => folderNames.includes(name.trim().toLowerCase()))
    )
    .filter(hasMediaCandidate)
    .filter((bookmark) => hasPendingMediaTarget(bookmark, coveredAssetKeys, coveredProfileImageUrls, skipProfileImages, mediaQuality))
    .slice(0, limit);
  const entriesByKey = new Map((previous?.entries ?? []).map((entry) => [mediaEntryKeyFromEntry(entry), entry]));
  const cachedResultsBySourceUrl = new Map<string, CachedMediaResult>();

  let downloaded = 0;
  let skippedTooLarge = 0;
  let failed = 0;
  let processed = 0;
  let stopReason: string | undefined;

  const emitProgress = (currentSourceUrl?: string) => {
    options.onProgress?.({
      candidateBookmarks: candidates.length,
      processed,
      downloaded,
      skippedTooLarge,
      failed,
      currentSourceUrl,
    });
  };

  const upsertEntry = (entry: MediaFetchEntry): void => {
    entriesByKey.set(mediaEntryKeyFromEntry(entry), entry);
  };

  const applyCachedResult = (
    target: MediaFetchTarget,
    key: string,
    cached: CachedMediaResult,
  ): void => {
    const { bookmarkId, tweetId, tweetUrl, authorHandle, authorName, sourceUrl, isProfileImage } = target;
    if (isProfileImage) return;
    upsertEntry({
      bookmarkId,
      tweetId,
      tweetUrl,
      authorHandle,
      authorName,
      sourceUrl,
      localPath: cached.localPath,
      contentType: cached.contentType,
      bytes: cached.bytes,
      status: cached.status,
      reason: cached.reason,
      fetchedAt: cached.fetchedAt,
    });
    if (cached.status === 'downloaded') {
      coveredAssetKeys.add(key);
      downloaded += 1;
    } else if (cached.status === 'skipped_too_large') {
      coveredAssetKeys.add(key);
      skippedTooLarge += 1;
    } else {
      failed += 1;
    }
    processed += 1;
    emitProgress(sourceUrl);
  };

  emitProgress();

  outer:
  for (const bookmark of candidates) {
    if (options.signal?.aborted) break;
    const mediaTargets = resolveMediaTargets(bookmark, coveredProfileImageUrls, skipProfileImages, mediaQuality);

    for (const target of mediaTargets) {
      if (options.signal?.aborted) break;
      const { bookmarkId, tweetId, tweetUrl, authorHandle, authorName, sourceUrl, isProfileImage } = target;
      const key = mediaEntryKey(tweetId, sourceUrl, isProfileImage);
      if (!isProfileImage && coveredAssetKeys.has(key)) continue;
      const cachedResult = cachedResultsBySourceUrl.get(sourceUrl);
      if (cachedResult) {
        applyCachedResult(target, key, cachedResult);
        continue;
      }

      const fetchedAt = new Date().toISOString();

      try {
        const head = await controlledFetch(sourceUrl, { method: 'HEAD' }, {
          operation: 'BookmarkMediaHead',
          category: 'media',
          tweetId,
        });
        const contentLengthHeader = head.headers.get('content-length');
        const contentType = head.headers.get('content-type') ?? undefined;
        const declaredBytes = contentLengthHeader ? Number(contentLengthHeader) : undefined;

        if (typeof declaredBytes === 'number' && !Number.isNaN(declaredBytes) && declaredBytes > maxBytes) {
          const entry = {
            bookmarkId,
            tweetId,
            tweetUrl,
            authorHandle,
            authorName,
            sourceUrl,
            contentType,
            bytes: declaredBytes,
            status: 'skipped_too_large',
            reason: `content-length ${declaredBytes} exceeds max ${maxBytes}`,
            fetchedAt,
          } satisfies MediaFetchEntry;
          upsertEntry(entry);
          cachedResultsBySourceUrl.set(sourceUrl, {
            contentType,
            bytes: declaredBytes,
            status: entry.status,
            reason: entry.reason,
            fetchedAt,
          });
          skippedTooLarge += 1;
          if (isProfileImage) coveredProfileImageUrls.add(sourceUrl);
          else coveredAssetKeys.add(key);
          processed += 1;
          emitProgress(sourceUrl);
          continue;
        }

        const response = await controlledFetch(sourceUrl, undefined, {
          operation: 'BookmarkMediaGet',
          category: 'media',
          tweetId,
        });
        if (!response.ok) {
          const entry = {
            bookmarkId,
            tweetId,
            tweetUrl,
            authorHandle,
            authorName,
            sourceUrl,
            status: 'failed',
            reason: `HTTP ${response.status}`,
            fetchedAt,
          } satisfies MediaFetchEntry;
          upsertEntry(entry);
          cachedResultsBySourceUrl.set(sourceUrl, {
            status: entry.status,
            reason: entry.reason,
            fetchedAt,
          });
          failed += 1;
          processed += 1;
          emitProgress(sourceUrl);
          continue;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > maxBytes) {
          const entry = {
            bookmarkId,
            tweetId,
            tweetUrl,
            authorHandle,
            authorName,
            sourceUrl,
            contentType: response.headers.get('content-type') ?? contentType ?? undefined,
            bytes: buffer.byteLength,
            status: 'skipped_too_large',
            reason: `downloaded size ${buffer.byteLength} exceeds max ${maxBytes}`,
            fetchedAt,
          } satisfies MediaFetchEntry;
          upsertEntry(entry);
          cachedResultsBySourceUrl.set(sourceUrl, {
            contentType: entry.contentType,
            bytes: buffer.byteLength,
            status: entry.status,
            reason: entry.reason,
            fetchedAt,
          });
          skippedTooLarge += 1;
          if (isProfileImage) coveredProfileImageUrls.add(sourceUrl);
          else coveredAssetKeys.add(key);
          processed += 1;
          emitProgress(sourceUrl);
          continue;
        }

        const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
        const ext = sanitizeExtFromContentType(response.headers.get('content-type') ?? contentType ?? undefined, sourceUrl);
        const filename = isProfileImage
          ? `${digest}${ext}`
          : `${tweetId}-${digest}${ext}`;
        const localPath = path.join(mediaDir, filename);
        await writeFile(localPath, buffer);
        if (isProfileImage) coveredProfileImageUrls.add(sourceUrl);
        else coveredAssetKeys.add(key);

        const entry = {
          bookmarkId,
          tweetId,
          tweetUrl,
          authorHandle,
          authorName,
          sourceUrl,
          localPath,
          contentType: response.headers.get('content-type') ?? contentType ?? undefined,
          bytes: buffer.byteLength,
          status: 'downloaded',
          fetchedAt,
        } satisfies MediaFetchEntry;
        upsertEntry(entry);
        cachedResultsBySourceUrl.set(sourceUrl, {
          localPath,
          contentType: entry.contentType,
          bytes: buffer.byteLength,
          status: entry.status,
          fetchedAt,
        });
        downloaded += 1;
        processed += 1;
        emitProgress(sourceUrl);
      } catch (error) {
        if (isHttpSafetyStop(error)) {
          stopReason = error.stopReason;
          break outer;
        }
        const entry = {
          bookmarkId,
          tweetId,
          tweetUrl,
          authorHandle,
          authorName,
          sourceUrl,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          fetchedAt,
        } satisfies MediaFetchEntry;
        upsertEntry(entry);
        cachedResultsBySourceUrl.set(sourceUrl, {
          status: entry.status,
          reason: entry.reason,
          fetchedAt,
        });
        failed += 1;
        processed += 1;
        emitProgress(sourceUrl);
      }
    }
  }

  const manifestLimit = Number.isFinite(limit) ? limit : candidates.length;
  const manifest: MediaFetchManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    limit: manifestLimit,
    maxBytes,
    mediaQuality,
    stopReason,
    processed,
    downloaded,
    skippedTooLarge,
    failed,
    entries: Array.from(entriesByKey.values()),
  };

  await writeJson(manifestPath, manifest);
  return manifest;
}
