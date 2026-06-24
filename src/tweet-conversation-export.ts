import path from 'node:path';
import { loadChromeSessionConfig } from './config.js';
import { extractChromeXCookies } from './chrome-cookies.js';
import { extractFirefoxXCookies } from './firefox-cookies.js';
import { parseTimestampMs } from './date-utils.js';
import { ensureDir, readJsonLines, writeMd } from './fs.js';
import { dataDir, twitterBookmarksCachePath } from './paths.js';
import { fetchTweetDetailViaGraphQL } from './graphql-bookmarks.js';
import { compareThreadTweetsChronologically } from './tweet-snapshots.js';
import type { BookmarkMediaObject, BookmarkRecord, ThreadTweetSnapshot } from './types.js';

export interface TweetConversationExportOptions {
  tweetId: string;
  outPath?: string;
  maxPages?: number;
  delayMs?: number;
  expandBranches?: boolean;
  branchLimit?: number;
  branchMaxPages?: number;
  browser?: string;
  chromeUserDataDir?: string;
  chromeProfileDirectory?: string;
  firefoxProfileDir?: string;
  csrfToken?: string;
  cookieHeader?: string;
}

export interface TweetConversationExportResult {
  path: string;
  status: string;
  tweetCount: number;
  rootAuthorHandle?: string;
  authorReplyCount: number;
  participantCount: number;
  topLevelReplyCount: number;
  pagesFetched?: number;
  branchFetches: number;
  branchTweetsAdded: number;
}

function resolveConversationCookies(options: TweetConversationExportOptions): { csrfToken: string; cookieHeader?: string } {
  if (options.csrfToken) {
    return { csrfToken: options.csrfToken, cookieHeader: options.cookieHeader };
  }

  const config = loadChromeSessionConfig({ browserId: options.browser });
  if (config.browser.cookieBackend === 'firefox') {
    const cookies = extractFirefoxXCookies(options.firefoxProfileDir);
    return { csrfToken: cookies.csrfToken, cookieHeader: cookies.cookieHeader };
  }

  const chromeDir = options.chromeUserDataDir ?? config.chromeUserDataDir;
  const chromeProfile = options.chromeProfileDirectory ?? config.chromeProfileDirectory;
  const cookies = extractChromeXCookies(chromeDir, chromeProfile, config.browser);
  return { csrfToken: cookies.csrfToken, cookieHeader: cookies.cookieHeader };
}

function sameHandle(a?: string, b?: string): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function formatDate(value?: string | null): string {
  const ms = parseTimestampMs(value);
  if (ms == null) return value ?? 'unknown date';
  return new Date(ms).toISOString();
}

function dateSlug(value?: string | null): string {
  const ms = parseTimestampMs(value);
  if (ms == null) return new Date().toISOString().slice(0, 10);
  return new Date(ms).toISOString().slice(0, 10);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || 'tweet-conversation';
}

function excerpt(value: string, max = 160): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function quoteText(value: string): string[] {
  const lines = value.split('\n');
  return lines.map((line) => `> ${line || ' '}`);
}

function tweetUrl(tweet: ThreadTweetSnapshot | BookmarkRecord): string {
  return tweet.url || `https://x.com/i/status/${tweet.id}`;
}

function tweetAuthor(tweet: ThreadTweetSnapshot | BookmarkRecord): string {
  const handle = tweet.authorHandle;
  const name = tweet.authorName;
  if (handle && name) return `${name} (@${handle})`;
  if (handle) return `@${handle}`;
  return name ?? 'Unknown author';
}

function tweetHandle(tweet: ThreadTweetSnapshot | BookmarkRecord): string | undefined {
  return tweet.authorHandle;
}

function tweetPostedAt(tweet: ThreadTweetSnapshot | BookmarkRecord): string | null | undefined {
  return tweet.postedAt;
}

function tweetMedia(tweet: ThreadTweetSnapshot | BookmarkRecord): BookmarkMediaObject[] {
  return tweet.mediaObjects ?? [];
}

function mediaSummary(media: BookmarkMediaObject[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < media.length; index++) {
    const item = media[index];
    const label = item.type ? `${index + 1}. ${item.type}` : `${index + 1}. media`;
    const primary = item.url ?? item.mediaUrl ?? item.previewUrl;
    if (primary) lines.push(`  - ${label}: ${primary}`);
    if (item.expandedUrl) lines.push(`    - Expanded: ${item.expandedUrl}`);
    if (item.altText || item.extAltText) lines.push(`    - Alt text: ${item.altText ?? item.extAltText}`);
    const variants = item.videoVariants ?? item.variants ?? [];
    const videoUrls = variants
      .filter((variant) => variant.url)
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
      .slice(0, 3);
    for (const variant of videoUrls) {
      const bitrate = variant.bitrate ? ` (${variant.bitrate}bps)` : '';
      lines.push(`    - Video${bitrate}: ${variant.url}`);
    }
  }
  return lines;
}

function replyCount(tweet: ThreadTweetSnapshot): number {
  const count = tweet.engagement?.replyCount;
  return Number.isFinite(count) && count != null ? Math.max(0, Math.floor(count)) : 0;
}

function recordToThreadSnapshot(record: BookmarkRecord): ThreadTweetSnapshot {
  return {
    id: record.tweetId,
    text: record.text,
    authorHandle: record.authorHandle,
    authorName: record.authorName,
    authorProfileImageUrl: record.authorProfileImageUrl,
    postedAt: record.postedAt,
    media: record.media,
    mediaObjects: record.mediaObjects,
    links: record.links,
    engagement: record.engagement,
    conversationId: record.conversationId,
    inReplyToStatusId: record.inReplyToStatusId,
    url: record.url,
  };
}

async function loadBookmarkRecord(tweetId: string): Promise<BookmarkRecord | undefined> {
  const records = await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath());
  return records.find((record) => record.tweetId === tweetId || record.id === tweetId);
}

function defaultOutputPath(root: ThreadTweetSnapshot | BookmarkRecord, tweetId: string): string {
  const author = tweetHandle(root) ?? 'unknown';
  const title = slugify(root.text);
  const filename = `${dateSlug(tweetPostedAt(root))}-${author}-${title}-${tweetId}.md`;
  return path.join(dataDir(), 'conversations', filename);
}

function buildParentMap(tweets: ThreadTweetSnapshot[]): Map<string, ThreadTweetSnapshot[]> {
  const children = new Map<string, ThreadTweetSnapshot[]>();
  for (const tweet of tweets) {
    if (!tweet.inReplyToStatusId) continue;
    const bucket = children.get(tweet.inReplyToStatusId) ?? [];
    bucket.push(tweet);
    children.set(tweet.inReplyToStatusId, bucket);
  }
  for (const bucket of children.values()) {
    bucket.sort(compareThreadTweetsChronologically);
  }
  return children;
}

function selectBranchExpansionCandidates(
  root: ThreadTweetSnapshot,
  tweets: ThreadTweetSnapshot[],
  childrenByParent: Map<string, ThreadTweetSnapshot[]>,
  alreadyFetched: Set<string>,
): ThreadTweetSnapshot[] {
  const rootHandle = root.authorHandle;
  return tweets
    .filter((tweet) => {
      if (tweet.id === root.id || alreadyFetched.has(tweet.id)) return false;
      const capturedChildren = childrenByParent.get(tweet.id)?.length ?? 0;
      if (replyCount(tweet) <= capturedChildren) return false;
      // Julia's replies are the high-value branches. Top-level app pitches are
      // second priority because they may have Julia's reply hidden behind a
      // branch expansion. Avoid recursively chasing every unrelated side-chat.
      return sameHandle(tweet.authorHandle, rootHandle) || tweet.inReplyToStatusId === root.id;
    })
    .sort((a, b) => {
      const aRootAuthor = sameHandle(a.authorHandle, rootHandle) ? 0 : 1;
      const bRootAuthor = sameHandle(b.authorHandle, rootHandle) ? 0 : 1;
      if (aRootAuthor !== bRootAuthor) return aRootAuthor - bRootAuthor;
      const aMissing = replyCount(a) - (childrenByParent.get(a.id)?.length ?? 0);
      const bMissing = replyCount(b) - (childrenByParent.get(b.id)?.length ?? 0);
      if (aMissing !== bMissing) return bMissing - aMissing;
      return compareThreadTweetsChronologically(a, b);
    });
}

async function expandIncompleteBranches(input: {
  root: ThreadTweetSnapshot;
  tweets: ThreadTweetSnapshot[];
  csrfToken: string;
  cookieHeader?: string;
  delayMs?: number;
  branchLimit: number;
  branchMaxPages: number;
}): Promise<{ tweets: ThreadTweetSnapshot[]; branchFetches: number; branchTweetsAdded: number }> {
  const byId = new Map(input.tweets.map((tweet) => [tweet.id, tweet]));
  const fetchedBranches = new Set<string>();
  let branchFetches = 0;
  let branchTweetsAdded = 0;

  while (branchFetches < input.branchLimit) {
    const tweets = Array.from(byId.values()).sort(compareThreadTweetsChronologically);
    const candidates = selectBranchExpansionCandidates(input.root, tweets, buildParentMap(tweets), fetchedBranches);
    const candidate = candidates[0];
    if (!candidate) break;

    fetchedBranches.add(candidate.id);
    branchFetches += 1;
    const detail = await fetchTweetDetailViaGraphQL(candidate.id, input.csrfToken, input.cookieHeader, {
      maxPages: input.branchMaxPages,
      delayMs: input.delayMs,
    });
    if (detail.status !== 'ok' && detail.status !== 'empty') continue;
    for (const tweet of detail.tweets) {
      if (byId.has(tweet.id)) continue;
      byId.set(tweet.id, tweet);
      branchTweetsAdded += 1;
    }
  }

  return {
    tweets: Array.from(byId.values()).sort(compareThreadTweetsChronologically),
    branchFetches,
    branchTweetsAdded,
  };
}

function renderTweetBlock(
  tweet: ThreadTweetSnapshot,
  level: number,
  indexLabel: string,
  byId: Map<string, ThreadTweetSnapshot>,
): string[] {
  const headingLevel = Math.min(6, Math.max(3, level));
  const heading = `${'#'.repeat(headingLevel)} ${indexLabel} ${tweetAuthor(tweet)} · ${formatDate(tweet.postedAt)}`;
  const lines = [
    heading,
    '',
    `- Tweet ID: \`${tweet.id}\``,
    `- URL: [Open on X](${tweetUrl(tweet)})`,
  ];
  if (tweet.inReplyToStatusId) {
    const parent = byId.get(tweet.inReplyToStatusId);
    const parentLabel = parent ? `${tweetAuthor(parent)}: ${excerpt(parent.text, 120)}` : tweet.inReplyToStatusId;
    lines.push(`- In reply to: ${parentLabel}`);
  }
  if (tweet.conversationRootId && tweet.conversationRootId !== tweet.id) {
    lines.push(`- Conversation branch root: \`${tweet.conversationRootId}\``);
  }
  if (tweet.links?.length) {
    lines.push(`- Links: ${tweet.links.map((link) => `[${link}](${link})`).join(', ')}`);
  }
  const media = mediaSummary(tweetMedia(tweet));
  if (media.length) {
    lines.push('- Media:');
    lines.push(...media);
  }
  lines.push('', ...quoteText(tweet.text), '');
  return lines;
}

function collectReachable(
  parentId: string,
  childrenByParent: Map<string, ThreadTweetSnapshot[]>,
  out: Set<string>,
): void {
  for (const child of childrenByParent.get(parentId) ?? []) {
    if (out.has(child.id)) continue;
    out.add(child.id);
    collectReachable(child.id, childrenByParent, out);
  }
}

function renderConversationTree(
  root: ThreadTweetSnapshot,
  tweets: ThreadTweetSnapshot[],
  childrenByParent: Map<string, ThreadTweetSnapshot[]>,
  byId: Map<string, ThreadTweetSnapshot>,
): string[] {
  const lines: string[] = ['## Full Conversation Tree', ''];
  const visited = new Set<string>();

  function renderChildren(parentId: string, level: number, prefix: string): void {
    const children = childrenByParent.get(parentId) ?? [];
    children.forEach((child, index) => {
      if (visited.has(child.id)) return;
      visited.add(child.id);
      const label = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      lines.push(...renderTweetBlock(child, level, label, byId));
      renderChildren(child.id, level + 1, label);
    });
  }

  renderChildren(root.id, 3, '');

  const reachable = new Set<string>();
  collectReachable(root.id, childrenByParent, reachable);
  const detached = tweets
    .filter((tweet) => tweet.id !== root.id && !reachable.has(tweet.id))
    .sort(compareThreadTweetsChronologically);

  if (detached.length) {
    lines.push('## Detached Or Ranked Replies', '');
    lines.push('These tweets were returned in the X conversation response, but their parent tweet was not present in this export.', '');
    detached.forEach((tweet, index) => {
      if (visited.has(tweet.id)) return;
      visited.add(tweet.id);
      lines.push(...renderTweetBlock(tweet, 3, `D${index + 1}`, byId));
    });
  }

  return lines;
}

function renderJuliaReplyIndex(
  root: ThreadTweetSnapshot,
  tweets: ThreadTweetSnapshot[],
  byId: Map<string, ThreadTweetSnapshot>,
): string[] {
  const rootHandle = root.authorHandle;
  if (!rootHandle) return [];
  const replies = tweets
    .filter((tweet) => tweet.id !== root.id && sameHandle(tweet.authorHandle, rootHandle))
    .sort(compareThreadTweetsChronologically);
  if (!replies.length) return [];

  const lines = [
    '## Root Author Replies',
    '',
    `These are the replies from @${rootHandle}, paired with the parent tweet when the parent was returned by X.`,
    '',
  ];
  replies.forEach((tweet, index) => {
    const parent = tweet.inReplyToStatusId ? byId.get(tweet.inReplyToStatusId) : undefined;
    lines.push(`### Root Author Reply ${index + 1} · ${formatDate(tweet.postedAt)}`, '');
    lines.push(`- URL: [Open on X](${tweetUrl(tweet)})`);
    if (parent) {
      lines.push(`- Replying to: ${tweetAuthor(parent)} · [parent tweet](${tweetUrl(parent)})`);
      lines.push(`- Parent excerpt: ${excerpt(parent.text, 220)}`);
    } else if (tweet.inReplyToStatusId) {
      lines.push(`- Replying to tweet ID: \`${tweet.inReplyToStatusId}\``);
    }
    if (tweet.links?.length) {
      lines.push(`- Links: ${tweet.links.map((link) => `[${link}](${link})`).join(', ')}`);
    }
    lines.push('', ...quoteText(tweet.text), '');
  });
  return lines;
}

function renderFlatIndex(tweets: ThreadTweetSnapshot[], rootId: string): string[] {
  const lines = [
    '## Flat Tweet Index',
    '',
    '| # | Date | Author | Replying To | Link | Preview |',
    '|---:|---|---|---|---|---|',
  ];
  tweets
    .filter((tweet) => tweet.id !== rootId)
    .sort(compareThreadTweetsChronologically)
    .forEach((tweet, index) => {
      const date = formatDate(tweet.postedAt).slice(0, 10);
      const author = tweet.authorHandle ? `@${tweet.authorHandle}` : tweet.authorName ?? 'Unknown';
      const replyingTo = tweet.inReplyToStatusId ? `\`${tweet.inReplyToStatusId}\`` : '';
      const preview = excerpt(tweet.text, 110).replace(/\|/g, '\\|');
      lines.push(`| ${index + 1} | ${date} | ${author} | ${replyingTo} | [tweet](${tweetUrl(tweet)}) | ${preview} |`);
    });
  lines.push('');
  return lines;
}

function buildMarkdown(input: {
  tweetId: string;
  tweets: ThreadTweetSnapshot[];
  root: ThreadTweetSnapshot;
  localRecord?: BookmarkRecord;
  status: string;
  maxPages: number;
  branchFetches: number;
  branchTweetsAdded: number;
  fetchedAt: string;
}): string {
  const { tweetId, tweets, root, localRecord, status, maxPages, branchFetches, branchTweetsAdded, fetchedAt } = input;
  const byId = new Map(tweets.map((tweet) => [tweet.id, tweet]));
  const childrenByParent = buildParentMap(tweets);
  const participants = new Set(tweets.map((tweet) => tweet.authorHandle ?? tweet.authorName ?? tweet.id));
  const rootAuthorReplies = root.authorHandle
    ? tweets.filter((tweet) => tweet.id !== root.id && sameHandle(tweet.authorHandle, root.authorHandle)).length
    : 0;
  const topLevelReplies = childrenByParent.get(root.id)?.length ?? 0;

  const lines = [
    `# ${root.authorHandle ? `@${root.authorHandle}` : 'X'} UGC Ideas Conversation`,
    '',
    `- Source: [Root tweet](https://x.com/i/status/${tweetId})`,
    `- Root tweet ID: \`${tweetId}\``,
    `- Fetched at: ${fetchedAt}`,
    `- Fetch status: ${status}`,
    `- Captured tweets: ${tweets.length}`,
    `- Participants captured: ${participants.size}`,
    `- Top-level replies captured: ${topLevelReplies}`,
    `- Root-author replies captured: ${rootAuthorReplies}`,
    `- TweetDetail page cap: ${maxPages}`,
    `- Branch expansions fetched: ${branchFetches}`,
    `- Branch-expansion tweets added: ${branchTweetsAdded}`,
  ];

  if (localRecord?.folderNames?.length) {
    lines.push(`- Bookmark folders: ${localRecord.folderNames.join(', ')}`);
  }
  if (localRecord?.engagement) {
    const e = localRecord.engagement;
    lines.push(`- Bookmark-time engagement: ${[
      e.replyCount != null ? `${e.replyCount} replies` : undefined,
      e.likeCount != null ? `${e.likeCount} likes` : undefined,
      e.repostCount != null ? `${e.repostCount} reposts` : undefined,
      e.bookmarkCount != null ? `${e.bookmarkCount} bookmarks` : undefined,
      e.viewCount != null ? `${e.viewCount} views` : undefined,
    ].filter(Boolean).join(', ')}`);
  }

  lines.push(
    '',
    '> Coverage note: this file includes every tweet returned by X TweetDetail pages fetched in this run. Deleted, private, hidden, or unreturned replies may not be visible through this endpoint.',
    '',
    '## Root Tweet',
    '',
    ...renderTweetBlock(root, 3, 'Root', byId),
    ...renderJuliaReplyIndex(root, tweets, byId),
    ...renderConversationTree(root, tweets, childrenByParent, byId),
    ...renderFlatIndex(tweets, root.id),
  );

  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
}

export async function exportTweetConversationMarkdown(
  options: TweetConversationExportOptions,
): Promise<TweetConversationExportResult> {
  const tweetId = options.tweetId.trim();
  const { csrfToken, cookieHeader } = resolveConversationCookies(options);
  const maxPages = options.maxPages ?? 12;
  const detail = await fetchTweetDetailViaGraphQL(tweetId, csrfToken, cookieHeader, {
    maxPages,
    delayMs: options.delayMs,
  });
  const localRecord = await loadBookmarkRecord(tweetId);
  let tweets = detail.tweets;
  if (localRecord && !tweets.some((tweet) => tweet.id === tweetId)) {
    tweets = [recordToThreadSnapshot(localRecord), ...tweets];
  }
  const root = tweets.find((tweet) => tweet.id === tweetId) ?? (localRecord ? recordToThreadSnapshot(localRecord) : undefined);
  if (!root) {
    throw new Error(`TweetDetail returned no root tweet for ${tweetId} (status: ${detail.status})`);
  }

  let branchFetches = 0;
  let branchTweetsAdded = 0;
  if (options.expandBranches) {
    const expanded = await expandIncompleteBranches({
      root,
      tweets: [root, ...tweets],
      csrfToken,
      cookieHeader,
      delayMs: options.delayMs,
      branchLimit: options.branchLimit ?? 40,
      branchMaxPages: options.branchMaxPages ?? 2,
    });
    tweets = expanded.tweets;
    branchFetches = expanded.branchFetches;
    branchTweetsAdded = expanded.branchTweetsAdded;
  }

  const byId = new Map<string, ThreadTweetSnapshot>();
  for (const tweet of [root, ...tweets]) {
    if (!byId.has(tweet.id)) byId.set(tweet.id, tweet);
  }
  tweets = Array.from(byId.values()).sort(compareThreadTweetsChronologically);

  const outPath = options.outPath ?? defaultOutputPath(root, tweetId);
  await ensureDir(path.dirname(outPath));
  await writeMd(outPath, buildMarkdown({
    tweetId,
    tweets,
    root,
    localRecord,
    status: detail.status,
    maxPages,
    branchFetches,
    branchTweetsAdded,
    fetchedAt: new Date().toISOString(),
  }));

  const participants = new Set(tweets.map((tweet) => tweet.authorHandle ?? tweet.authorName ?? tweet.id));
  return {
    path: outPath,
    status: detail.status,
    tweetCount: tweets.length,
    rootAuthorHandle: root.authorHandle,
    authorReplyCount: root.authorHandle
      ? tweets.filter((tweet) => tweet.id !== root.id && sameHandle(tweet.authorHandle, root.authorHandle)).length
      : 0,
    participantCount: participants.size,
    topLevelReplyCount: buildParentMap(tweets).get(root.id)?.length ?? 0,
    branchFetches,
    branchTweetsAdded,
  };
}
