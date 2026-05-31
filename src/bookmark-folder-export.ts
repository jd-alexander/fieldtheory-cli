/**
 * Foldered readable archive export.
 *
 * This is intentionally separate from `ft md`: it writes a browseable snapshot
 * beside the raw JSONL archive, preserving X bookmark folders and local media
 * links instead of producing one flat markdown library directory.
 */

import path from 'node:path';
import { rm } from 'node:fs/promises';
import { ensureDir, pathExists, readJson, readJsonLines, writeMd } from './fs.js';
import {
  bookmarkMediaManifestPath,
  readableArchiveDir,
  twitterBookmarkFoldersStatePath,
  twitterBookmarksCachePath,
} from './paths.js';
import { parseTimestampMs, toIsoDate } from './date-utils.js';
import { slug } from './md.js';
import type { BookmarkMediaObject, BookmarkRecord, QuotedTweetSnapshot, ThreadTweetSnapshot } from './types.js';
import type { MediaFetchEntry, MediaFetchManifest } from './bookmark-media.js';

interface FolderStateEntry {
  id: string;
  name: string;
  order?: number;
  active?: boolean;
  lastListedAt?: string;
  lastSyncedAt?: string;
  recordCount?: number;
  recordIdsHash?: string;
}

interface FolderState {
  folders?: FolderStateEntry[];
}

export interface ExportReadableArchiveOptions {
  outputDir?: string;
  clean?: boolean;
  includeUnfiled?: boolean;
  onProgress?: (status: string) => void;
}

export interface ExportReadableArchiveResult {
  outputDir: string;
  folders: number;
  records: number;
  filesWritten: number;
}

interface ArchiveFolder {
  id: string;
  name: string;
  order: number;
  active: boolean;
  lastListedAt?: string;
  lastSyncedAt?: string;
  recordCount?: number;
  recordIdsHash?: string;
  records: BookmarkRecord[];
}

function archiveRoot(options: ExportReadableArchiveOptions): string {
  return options.outputDir ?? readableArchiveDir();
}

function sanitizePathSegment(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Untitled';
}

function folderDirName(folder: ArchiveFolder): string {
  const prefix = String(folder.order).padStart(3, '0');
  return `${prefix} - ${sanitizePathSegment(folder.name)}`;
}

function compareSortIndexDesc(a?: string | null, b?: string | null): number {
  if (a && b) {
    if (a.length !== b.length) return b.length - a.length;
    return b.localeCompare(a);
  }
  if (a) return -1;
  if (b) return 1;
  return 0;
}

function compareRecordsForArchive(a: BookmarkRecord, b: BookmarkRecord): number {
  const sortIndex = compareSortIndexDesc(a.sortIndex, b.sortIndex);
  if (sortIndex !== 0) return sortIndex;

  const aTime = parseTimestampMs(a.bookmarkedAt) ?? parseTimestampMs(a.postedAt) ?? 0;
  const bTime = parseTimestampMs(b.bookmarkedAt) ?? parseTimestampMs(b.postedAt) ?? 0;
  if (aTime !== bTime) return bTime - aTime;

  return b.tweetId.localeCompare(a.tweetId);
}

function fileDate(record: BookmarkRecord): string {
  return toIsoDate(record.postedAt ?? record.bookmarkedAt) ?? 'undated';
}

function bookmarkFileName(record: BookmarkRecord): string {
  const author = record.authorHandle ? slug(record.authorHandle) : 'unknown';
  const textPart = slug(record.text.slice(0, 48)) || 'bookmark';
  return `${fileDate(record)}-${author}-${textPart}-${record.tweetId}.md`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlArray(values: string[]): string {
  return `[${values.map(yamlString).join(', ')}]`;
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function oneLine(value?: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function relativeMarkdownLink(fromFile: string, toFile: string): string {
  return path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
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

function mediaUrlsFromObjects(mediaObjects?: BookmarkMediaObject[]): string[] {
  const urls: string[] = [];
  for (const media of mediaObjects ?? []) {
    const preview = media.previewUrl ?? media.url ?? media.mediaUrl;
    if (preview) urls.push(preview);
    const mp4 = (media.videoVariants ?? media.variants ?? [])
      .filter((variant) => variant.url && (!variant.contentType || variant.contentType === 'video/mp4'))
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]?.url;
    if (mp4) urls.push(mp4);
  }
  return urls;
}

function remoteMediaUrls(source: {
  media?: string[];
  mediaObjects?: BookmarkMediaObject[];
  articleCoverMedia?: unknown;
  articleMediaEntities?: unknown[];
}): string[] {
  return [
    ...(source.media ?? []),
    ...mediaUrlsFromObjects(source.mediaObjects),
    extractArticleMediaUrl(source.articleCoverMedia),
    ...(source.articleMediaEntities ?? []).map(extractArticleMediaUrl),
  ].filter((value): value is string => Boolean(value));
}

function mediaEntriesForTweet(mediaByTweetId: Map<string, MediaFetchEntry[]>, tweetId: string): MediaFetchEntry[] {
  return (mediaByTweetId.get(tweetId) ?? [])
    .filter((entry) => entry.status === 'downloaded' && entry.localPath && !entry.sourceUrl.includes('/profile_images/'));
}

function renderMediaMarkdown(
  fromFile: string,
  localEntries: MediaFetchEntry[],
  remoteUrls: string[],
): string[] {
  const lines: string[] = [];
  const localSourceUrls = new Set(localEntries.map((entry) => entry.sourceUrl));
  const seenLocal = new Set<string>();
  for (const entry of localEntries) {
    if (!entry.localPath || seenLocal.has(entry.localPath)) continue;
    seenLocal.add(entry.localPath);
    const rel = relativeMarkdownLink(fromFile, entry.localPath);
    const label = path.basename(entry.localPath);
    if ((entry.contentType ?? '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(entry.localPath)) {
      lines.push(`![${label}](${rel})`);
    } else {
      lines.push(`- [${label}](${rel})`);
    }
  }

  const missingRemote = [...new Set(remoteUrls)].filter((url) => !localSourceUrls.has(url));
  if (missingRemote.length > 0) {
    lines.push('');
    lines.push('Remote media not downloaded yet:');
    for (const url of missingRemote) lines.push(`- ${url}`);
  }

  return lines.filter((line, index, arr) => !(line === '' && arr[index - 1] === ''));
}

function renderTweetSnapshot(
  heading: string,
  tweet: QuotedTweetSnapshot | ThreadTweetSnapshot,
  filePath: string,
  mediaByTweetId: Map<string, MediaFetchEntry[]>,
): string[] {
  const lines: string[] = [];
  lines.push(`## ${heading}`);
  const author = tweet.authorHandle ? `@${tweet.authorHandle}` : 'Unknown';
  const posted = toIsoDate(tweet.postedAt) ?? tweet.postedAt ?? 'undated';
  lines.push(`**${author}** · ${posted}`);
  lines.push('');
  lines.push(tweet.text ?? '');
  lines.push('');

  const mediaLines = renderMediaMarkdown(
    filePath,
    mediaEntriesForTweet(mediaByTweetId, tweet.id),
    remoteMediaUrls(tweet),
  );
  if (mediaLines.length > 0) {
    lines.push(...mediaLines);
    lines.push('');
  }
  lines.push(`[Original tweet](${tweet.url})`);
  lines.push('');
  return lines;
}

function renderBookmarkMarkdown(
  record: BookmarkRecord,
  folder: ArchiveFolder,
  filePath: string,
  mediaByTweetId: Map<string, MediaFetchEntry[]>,
): string {
  const lines: string[] = [];
  const folderNames = record.folderNames ?? [];

  lines.push('---');
  lines.push(`tweet_id: ${yamlString(record.tweetId)}`);
  lines.push(`source_url: ${yamlString(record.url)}`);
  if (record.authorHandle) lines.push(`author: ${yamlString(`@${record.authorHandle}`)}`);
  if (record.authorName) lines.push(`author_name: ${yamlString(record.authorName)}`);
  if (record.postedAt) lines.push(`posted_at: ${yamlString(record.postedAt)}`);
  if (record.bookmarkedAt) lines.push(`bookmarked_at: ${yamlString(record.bookmarkedAt)}`);
  lines.push(`synced_at: ${yamlString(record.syncedAt)}`);
  lines.push(`folder: ${yamlString(folder.name)}`);
  if (folderNames.length > 0) lines.push(`folders: ${yamlArray(folderNames)}`);
  if (record.articleTitle) lines.push(`article_title: ${yamlString(record.articleTitle)}`);
  lines.push('---');
  lines.push('');

  const author = record.authorHandle ? `@${record.authorHandle}` : 'Unknown';
  lines.push(`# ${author} - ${record.tweetId}`);
  lines.push('');

  lines.push('## Tweet');
  lines.push(record.text);
  lines.push('');

  const details: Array<[string, string | undefined]> = [
    ['Posted', record.postedAt ?? undefined],
    ['Bookmarked', record.bookmarkedAt ?? undefined],
    ['Synced', record.syncedAt],
    ['Sort index', record.sortIndex ?? undefined],
    ['Language', record.language],
    ['Likes', record.engagement?.likeCount != null ? String(record.engagement.likeCount) : undefined],
    ['Reposts', record.engagement?.repostCount != null ? String(record.engagement.repostCount) : undefined],
    ['Replies', record.engagement?.replyCount != null ? String(record.engagement.replyCount) : undefined],
    ['Views', record.engagement?.viewCount != null ? String(record.engagement.viewCount) : undefined],
  ];
  const presentDetails = details.filter(([, value]) => value);
  if (presentDetails.length > 0) {
    lines.push('## Details');
    for (const [label, value] of presentDetails) lines.push(`- ${label}: ${value}`);
    lines.push('');
  }

  const mediaLines = renderMediaMarkdown(
    filePath,
    mediaEntriesForTweet(mediaByTweetId, record.tweetId),
    remoteMediaUrls(record),
  );
  if (mediaLines.length > 0) {
    lines.push('## Media');
    lines.push(...mediaLines);
    lines.push('');
  }

  if (record.articleText || record.articleTitle || record.articlePreviewText || record.articleSummaryText) {
    lines.push('## Article');
    if (record.articleTitle) {
      lines.push(`### ${oneLine(record.articleTitle)}`);
      lines.push('');
    }
    if (record.articleSite) lines.push(`Source: ${oneLine(record.articleSite)}`);
    if (record.articleFirstPublishedAt) lines.push(`Published: ${record.articleFirstPublishedAt}`);
    if (record.articleModifiedAt) lines.push(`Modified: ${record.articleModifiedAt}`);
    if (record.articleSite || record.articleFirstPublishedAt || record.articleModifiedAt) lines.push('');
    if (record.articleText) lines.push(record.articleText.trim());
    else if (record.articleSummaryText) lines.push(record.articleSummaryText.trim());
    else if (record.articlePreviewText) lines.push(record.articlePreviewText.trim());
    lines.push('');
  }

  if (record.links?.length) {
    lines.push('## Links');
    for (const link of record.links) lines.push(`- ${link}`);
    lines.push('');
  }

  if (record.quotedTweet) {
    lines.push(...renderTweetSnapshot('Quoted Tweet', record.quotedTweet, filePath, mediaByTweetId));
  }

  if (record.threadContext?.length) {
    lines.push('## Thread Context');
    lines.push('');
    for (const tweet of record.threadContext) {
      lines.push(...renderTweetSnapshot('Parent Tweet', tweet, filePath, mediaByTweetId));
    }
  }

  if (record.threadBelow?.length) {
    lines.push('## Thread Continuation');
    lines.push('');
    for (const tweet of record.threadBelow) {
      lines.push(...renderTweetSnapshot('Continuation Tweet', tweet, filePath, mediaByTweetId));
    }
  }

  lines.push('## Source');
  lines.push(`[Original tweet](${record.url})`);
  lines.push('');

  return lines.join('\n');
}

async function loadFolderState(): Promise<FolderState> {
  const statePath = twitterBookmarkFoldersStatePath();
  if (!(await pathExists(statePath))) return {};
  return readJson<FolderState>(statePath);
}

async function loadMediaEntries(): Promise<MediaFetchEntry[]> {
  const manifestPath = bookmarkMediaManifestPath();
  if (!(await pathExists(manifestPath))) return [];
  const manifest = await readJson<MediaFetchManifest>(manifestPath);
  return manifest.entries ?? [];
}

function buildMediaMap(entries: MediaFetchEntry[]): Map<string, MediaFetchEntry[]> {
  const byTweetId = new Map<string, MediaFetchEntry[]>();
  for (const entry of entries) {
    const current = byTweetId.get(entry.tweetId) ?? [];
    current.push(entry);
    byTweetId.set(entry.tweetId, current);
  }
  return byTweetId;
}

function buildArchiveFolders(
  records: BookmarkRecord[],
  state: FolderState,
  includeUnfiled: boolean,
): ArchiveFolder[] {
  const recordsByFolderId = new Map<string, BookmarkRecord[]>();
  const knownNamesById = new Map<string, string>();

  for (const record of records) {
    const ids = record.folderIds ?? [];
    const names = record.folderNames ?? [];
    ids.forEach((id, index) => {
      const name = names[index] ?? id;
      knownNamesById.set(id, name);
      const current = recordsByFolderId.get(id) ?? [];
      current.push(record);
      recordsByFolderId.set(id, current);
    });
  }

  const stateFolders = [...(state.folders ?? [])].sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
  const usedIds = new Set<string>();
  const folders: ArchiveFolder[] = [];

  for (const folder of stateFolders) {
    const folderRecords = recordsByFolderId.get(folder.id) ?? [];
    if (folderRecords.length === 0 && !folder.active) continue;
    folders.push({
      id: folder.id,
      name: folder.name,
      order: folder.order ?? folders.length + 1,
      active: folder.active ?? true,
      lastListedAt: folder.lastListedAt,
      lastSyncedAt: folder.lastSyncedAt,
      recordCount: folder.recordCount,
      recordIdsHash: folder.recordIdsHash,
      records: [...folderRecords].sort(compareRecordsForArchive),
    });
    usedIds.add(folder.id);
  }

  const unknownIds = [...recordsByFolderId.keys()].filter((id) => !usedIds.has(id)).sort();
  for (const id of unknownIds) {
    folders.push({
      id,
      name: knownNamesById.get(id) ?? id,
      order: folders.length + 1,
      active: true,
      records: [...(recordsByFolderId.get(id) ?? [])].sort(compareRecordsForArchive),
    });
  }

  if (includeUnfiled) {
    const unfiledRecords = records.filter((record) => (record.folderIds?.length ?? 0) === 0);
    if (unfiledRecords.length > 0) {
      folders.push({
        id: 'unfiled',
        name: 'Unfiled',
        order: 999,
        active: true,
        records: unfiledRecords.sort(compareRecordsForArchive),
      });
    }
  }

  return folders;
}

function folderIndexMarkdown(folder: ArchiveFolder, folderReadmePath: string, fileByRecordId: Map<string, string>): string {
  const lines: string[] = [];
  lines.push(`# ${folder.name}`);
  lines.push('');
  lines.push(`- Folder ID: \`${folder.id}\``);
  lines.push(`- Records: ${folder.records.length}`);
  if (folder.lastSyncedAt) lines.push(`- Last synced: ${folder.lastSyncedAt}`);
  if (folder.recordIdsHash) lines.push(`- Record hash: \`${folder.recordIdsHash}\``);
  lines.push('');

  lines.push('| Date | Author | Bookmark | Media | Article |');
  lines.push('| --- | --- | --- | ---: | --- |');
  for (const record of folder.records) {
    const filePath = fileByRecordId.get(record.id);
    const rel = filePath ? relativeMarkdownLink(folderReadmePath, filePath) : '';
    const label = tableCell(oneLine(record.text).slice(0, 90) || record.tweetId);
    const title = rel ? `[${label}](${rel})` : label;
    const mediaCount = (record.mediaObjects?.length ?? record.media?.length ?? 0);
    const article = record.articleText || record.articleTitle ? 'yes' : '';
    lines.push(`| ${fileDate(record)} | ${tableCell(record.authorHandle ? `@${record.authorHandle}` : 'Unknown')} | ${title} | ${mediaCount} | ${article} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function rootIndexMarkdown(outputDir: string, folders: ArchiveFolder[]): string {
  const rootReadme = path.join(outputDir, 'README.md');
  const lines: string[] = [];
  lines.push('# X Bookmark Archive');
  lines.push('');
  lines.push('Readable markdown export generated from `bookmarks.jsonl`.');
  lines.push('');
  lines.push('| Order | Folder | Records | Last synced |');
  lines.push('| ---: | --- | ---: | --- |');
  for (const folder of folders) {
    const folderReadme = path.join(outputDir, 'folders', folderDirName(folder), 'README.md');
    const rel = relativeMarkdownLink(rootReadme, folderReadme);
    lines.push(`| ${folder.order} | [${tableCell(folder.name)}](${rel}) | ${folder.records.length} | ${folder.lastSyncedAt ?? ''} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function exportReadableBookmarkArchive(
  options: ExportReadableArchiveOptions = {},
): Promise<ExportReadableArchiveResult> {
  const outputDir = archiveRoot(options);
  const includeUnfiled = options.includeUnfiled ?? true;
  const progress = options.onProgress ?? (() => {});

  if (options.clean) {
    await rm(outputDir, { recursive: true, force: true });
  }
  await ensureDir(outputDir);

  const records = await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath());
  const state = await loadFolderState();
  const mediaByTweetId = buildMediaMap(await loadMediaEntries());
  const folders = buildArchiveFolders(records, state, includeUnfiled);

  let filesWritten = 0;
  for (const folder of folders) {
    const dir = path.join(outputDir, 'folders', folderDirName(folder));
    await ensureDir(dir);
    const fileByRecordId = new Map<string, string>();

    progress(`Exporting ${folder.name} (${folder.records.length})...`);
    for (const record of folder.records) {
      const filePath = path.join(dir, bookmarkFileName(record));
      fileByRecordId.set(record.id, filePath);
      await writeMd(filePath, renderBookmarkMarkdown(record, folder, filePath, mediaByTweetId));
      filesWritten++;
    }

    await writeMd(path.join(dir, 'README.md'), folderIndexMarkdown(folder, path.join(dir, 'README.md'), fileByRecordId));
    filesWritten++;
  }

  await writeMd(path.join(outputDir, 'README.md'), rootIndexMarkdown(outputDir, folders));
  filesWritten++;

  return {
    outputDir,
    folders: folders.length,
    records: folders.reduce((sum, folder) => sum + folder.records.length, 0),
    filesWritten,
  };
}
