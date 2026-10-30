import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { acquireSyncLock, archiveSyncMain, availableRequestBudget, backlogCounts, overnightPolicy, recentFolderBookmarks, renderBatchPreview } from '../src/archive-sync.js';
import { HttpSafetyStopError } from '../src/http-safety.js';
import { selectThreadBackfill, threadCoverageReport, threadCoverageLabel } from '../src/thread-coverage.js';
import type { BookmarkRecord } from '../src/types.js';

const now = Date.parse('2026-10-18T20:00:00Z');

test('hourly allowance includes prior processes, excludes expired requests and honors 429 reset', () => {
  const entries = [
    { ts: '2026-10-18T19:59:00Z', status: 200 },
    { ts: '2026-10-18T19:58:00Z', errorName: 'TypeError' },
    { ts: '2026-10-18T18:59:00Z', status: 200 },
  ];
  assert.equal(availableRequestBudget(entries, now, 20, 3), 1);
  assert.equal(availableRequestBudget(entries, now, 20, 2), 0);
  assert.throws(() => availableRequestBudget([
    { ts: '2026-10-18T19:59:00Z', status: 429, responseHeaders: { 'x-rate-limit-reset': String((now + 60_000) / 1000) } },
  ], now, 20, 30), /cooldown/);
  assert.equal(availableRequestBudget([
    { ts: '2026-10-18T19:30:00Z', status: 429 },
  ], now, 20, 30), 20);
});

test('server cooldowns survive more than one hour and honor the later reset/retry header', () => {
  assert.throws(() => availableRequestBudget([
    { ts: '2026-10-18T18:00:00Z', status: 429, responseHeaders: { 'retry-after': '10800' } },
  ], now, 80, 120), /cooldown/);
  assert.throws(() => availableRequestBudget([
    { ts: '2026-10-18T19:00:00Z', status: 429, responseHeaders: {
      'x-rate-limit-reset': String((now - 60_000) / 1000), 'retry-after': 'Sun, 18 Oct 2026 21:00:00 GMT',
    } },
  ], now, 80, 120), /cooldown/);
  assert.equal(availableRequestBudget([
    { ts: '2026-10-18T18:00:00Z', status: 429, responseHeaders: { 'retry-after': '3600' } },
  ], now, 80, 120), 80);
});

test('overnight policy enforces Jamaica hours, small budgets and a six-AM deadline', () => {
  const oneAM = Date.parse('2026-10-30T06:00:00Z');
  const policy = overnightPolicy([], oneAM);
  assert.equal(policy.reason, undefined);
  assert.equal(policy.availableRequests, 80);
  assert.equal(policy.hourlyBudget, 120);
  assert.equal(policy.dailyBudget, 240);
  assert.equal(policy.minDelayMs, 10_000);
  assert.equal(policy.rateLimitFloor, 200);
  assert.equal(policy.stopAt, Date.parse('2026-10-30T11:00:00Z'));
  assert.equal(overnightPolicy([], oneAM - 1).availableRequests, 0);
  assert.equal(overnightPolicy([], Date.parse('2026-10-30T11:00:00Z')).availableRequests, 0);
});

test('overnight daily count includes other CLI requests but not the preceding Jamaican date', () => {
  const at = Date.parse('2026-10-30T08:00:00Z');
  const entries = Array.from({ length: 239 }, () => ({ ts: '2026-10-30T06:00:00Z', status: 200 }));
  entries.push({ ts: '2026-10-30T04:59:59Z', status: 200 });
  assert.equal(overnightPolicy(entries, at).availableRequests, 1);
  entries.push({ ts: '2026-10-30T07:00:00Z', status: 200 });
  assert.equal(overnightPolicy(entries, at).availableRequests, 0);
});

test('overnight policy retains run spacing, auth holds and saved rate-floor resets', () => {
  const at = Date.parse('2026-10-30T08:00:00Z');
  assert.match(overnightPolicy([], at, { mode: 'overnight', startedAt: '2026-10-30T07:00:00Z' }).reason!, /90 minutes/);
  assert.equal(overnightPolicy([], at, { mode: 'overnight', startedAt: '2026-10-30T06:00:00Z' }).reason, undefined);
  assert.match(overnightPolicy([], at, { paused: 'Authentication or access failure' }).reason!, /manual recovery/);
  assert.match(overnightPolicy([{ ts: '2026-10-30T07:50:00Z', operation: 'Bookmarks', responseHeaders: {
    'x-rate-limit-remaining': '199', 'x-rate-limit-reset': String((at + 60_000) / 1000),
  } }], at).reason!, /saved rate-limit reset/);
  assert.equal(overnightPolicy([{ ts: '2026-10-30T07:00:00Z', responseHeaders: { 'x-rate-limit-remaining': '199' } }], at).reason, undefined);
});

test('a second sync cannot acquire the same archive lock', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ft-sync-lock-'));
  const release = acquireSyncLock(directory);
  try { assert.throws(() => acquireSyncLock(directory), /Another bookmark sync/); }
  finally { release(); rmSync(directory, { recursive: true }); }
});

function record(id: string): BookmarkRecord {
  return { id, tweetId: id, url: `https://x.com/alice/status/${id}`, text: `Post ${id}`,
    authorHandle: 'alice', authorName: 'Alice', syncedAt: '2026-10-18T20:00:00Z',
    postedAt: '2020-01-01T00:00:00Z', links: [], tags: [], ingestedVia: 'graphql' };
}

test('preview preserves quotes and article text, escapes source HTML, and rejects script links', () => {
  const bookmark = record('1');
  bookmark.text = '<script>alert(1)</script>';
  bookmark.links = ['javascript:alert(1)', 'https://example.org/?q="test"'];
  bookmark.quotedTweet = { id: '2', url: 'https://x.com/bob/status/2', text: 'quoted', authorHandle: 'bob',
    articleTitle: 'A title', articleText: 'Full quoted article\nSecond paragraph' };
  const html = renderBatchPreview([bookmark], [], os.tmpdir());
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Full quoted article\nSecond paragraph'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('Content-Security-Policy'));
  assert.throws(() => renderBatchPreview([bookmark], [{ bookmarkId: '1', tweetId: '1', tweetUrl: bookmark.url,
    sourceUrl: 'https://example.org/a.jpg', localPath: '/nonexistent/ft-missing-image.jpg', status: 'downloaded', fetchedAt: '' }], os.tmpdir()), /media is missing/);
});

async function withArchive(task: (directory: string, write: (records: BookmarkRecord[]) => void) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ft-archive-sync-'));
  const previousDir = process.env.FT_DATA_DIR;
  const previousCode = process.exitCode;
  process.env.FT_DATA_DIR = directory;
  process.exitCode = 0;
  const write = (records: BookmarkRecord[]): void => writeFileSync(path.join(directory, 'bookmarks.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const git = (...args: string[]): void => { execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' }); };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Archive Test');
  git('config', 'user.email', 'archive-test@example.invalid');
  write([record('old')]);
  git('add', '.');
  git('commit', '-m', 'Fixture');
  try { await task(directory, write); } finally {
    if (previousDir === undefined) delete process.env.FT_DATA_DIR;
    else process.env.FT_DATA_DIR = previousDir;
    process.exitCode = previousCode;
    rmSync(directory, { recursive: true, force: true });
  }
}

test('archive command saves a budget pause and resumes enrichment for the original batch on the next sync', async () => {
  await withArchive(async (directory, write) => {
    const read = (): BookmarkRecord[] => readFileSync(path.join(directory, 'bookmarks.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const phases: string[] = [];
    const records = [record('new'), record('old')];
    const result = (added: number) => ({ added, addedIds: added ? ['new'] : [], totalBookmarks: 2, pages: 1,
      bookmarkedAtRepaired: 0, bookmarkedAtMissing: 2, stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' });
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--thread-backfill', '0'], {
      timeline: async () => { write(records); return result(1); },
      threads: async () => { throw new HttpSafetyStopError('fixture stop', 'request budget reached'); },
      gaps: async () => { throw new Error('Must not run gaps after a pause'); },
      media: async () => { throw new Error('Must not run media after a pause'); },
      folders: async () => { throw new Error('Must not run folders after a pause'); },
    });
    assert.equal(process.exitCode, 2);
    const firstSummary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.equal(firstSummary.newCount, 1);
    assert.deepEqual(firstSummary.pending.media, ['new']);
    assert.ok(readFileSync(path.join(directory, 'previews/latest-batch.html'), 'utf8').includes('Post new'));
    execFileSync('git', ['-C', directory, 'add', '-A']);
    execFileSync('git', ['-C', directory, 'commit', '-m', 'Save paused fixture']);
    process.exitCode = 0;
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--thread-backfill', '0'], {
      timeline: async () => result(0),
      threads: async (options) => {
        assert.deepEqual(options?.onlyTweetIds, ['new']); phases.push('threads');
        return { total: 1, contextFilled: 0, belowFilled: 0, emptyChecked: 1, failed: 0, failures: [] };
      },
      gaps: async (options) => {
        assert.deepEqual(options?.onlyTweetIds, ['new']); phases.push('gaps');
        const current = read(); current[0].articleText = 'Saved article'; write(current);
        return { total: 1, quotedTweetsFilled: 0, textExpanded: 0, articlesEnriched: 1, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 1, failed: 0, failures: [] };
      },
      media: async (options) => {
        assert.deepEqual(options?.onlyTweetIds, ['new']); phases.push('media');
        mkdirSync(path.join(directory, 'media'), { recursive: true });
        const image = path.join(directory, 'media', 'image.jpg'); writeFileSync(image, 'fixture');
        const manifest = { schemaVersion: 1 as const, generatedAt: '', limit: 1, maxBytes: 10, processed: 1, downloaded: 1, failed: 0, skippedTooLarge: 0,
          entries: [{ bookmarkId: 'new', tweetId: 'new', tweetUrl: records[0].url, sourceUrl: 'https://example.org/a.jpg', localPath: image, contentType: 'image/jpeg', status: 'downloaded' as const, fetchedAt: '' }] };
        writeFileSync(path.join(directory, 'media-manifest.json'), JSON.stringify(manifest));
        return manifest;
      },
      folders: async () => {
        phases.push('folders');
        const current = read(); current[0].folderIds = ['folder']; current[0].folderNames = ['Research']; write(current);
        return { folders: [], perFolder: [], targetFolderCount: 1, totalAdded: 0, totalTagged: 1, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [],
          coverage: { targetRecordIds: 1, taggedRecordIds: 1, remainingRecordIds: [], stoppedAfterCoverage: true } };
      },
    });
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.deepEqual(phases, ['gaps', 'threads', 'gaps', 'media', 'folders']);
    assert.equal(summary.newCount, 0);
    assert.equal(summary.batchCount, 1);
    assert.equal(summary.media.downloaded, 1);
    assert.ok(Object.values(summary.pending).every((ids: any) => ids.length === 0));
    const preview = readFileSync(summary.previewPath, 'utf8');
    assert.ok(preview.includes('Saved article'));
    assert.ok(preview.includes('../media/image.jpg'));
    assert.ok(preview.includes('Research'));
    assert.equal(process.exitCode, 0);
  });
});

test('a no-change sync does not accidentally enrich or download the full archive', async () => {
  await withArchive(async (directory) => {
    const unexpected = async (): Promise<never> => { throw new Error('Empty scopes must not mean the entire archive'); };
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--thread-backfill', '0'], {
      timeline: async () => ({ added: 0, addedIds: [], totalBookmarks: 1, pages: 1, bookmarkedAtRepaired: 0,
        bookmarkedAtMissing: 1, stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' }),
      threads: unexpected, gaps: unexpected, media: unexpected,
      folders: async (options) => {
        assert.equal(options?.folderLimit, 0);
        return { folders: [], perFolder: [], targetFolderCount: 0, totalAdded: 0, totalTagged: 0, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [] };
      },
    });
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.equal(summary.newCount, 0);
    assert.equal(summary.batchCount, 0);
  });
});

test('a page-limited timeline resumes its saved cursor rather than skipping to the new head', async () => {
  await withArchive(async (directory, write) => {
    const result = { added: 1, addedIds: ['new'], totalBookmarks: 2, pages: 12,
      bookmarkedAtRepaired: 0, bookmarkedAtMissing: 2, stopReason: 'max pages reached', cachePath: '', statePath: '' };
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--thread-backfill', '0'], {
      timeline: async () => {
        write([record('new'), record('old')]);
        writeFileSync(path.join(directory, 'bookmarks-backfill-state.json'), JSON.stringify({ lastCursor: 'next-page' }));
        return result;
      },
    });
    const statePath = path.join(directory, 'logs/archive-sync-state.json');
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).timelineCursor, 'next-page');
    execFileSync('git', ['-C', directory, 'add', '-A']);
    execFileSync('git', ['-C', directory, 'commit', '-m', 'Save page boundary']);
    process.exitCode = 0;
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--thread-backfill', '0'], {
      timeline: async (options) => {
        assert.equal(options?.resumeCursor, 'next-page');
        return { ...result, added: 0, addedIds: [], pages: 1, stopReason: 'end of bookmarks' };
      },
      threads: async () => { throw new HttpSafetyStopError('fixture stop', 'request budget reached'); },
    });
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).timelineCursor, undefined);
  });
});

test('a large capture finishes media for ten bookmarks before expanding the next group of threads', async () => {
  await withArchive(async (directory, write) => {
    const records = Array.from({ length: 14 }, (_, i) => ({ ...record(String(i)), folderIds: ['f'], folderNames: ['Research'] }));
    const calls: string[] = [];
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--thread-backfill', '0'], {
      timeline: async () => {
        write([...records, record('old')]);
        return { added: 14, addedIds: records.map((r) => r.id), totalBookmarks: 15, pages: 1,
          bookmarkedAtRepaired: 0, bookmarkedAtMissing: 15, stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' };
      },
      threads: async (options) => {
        calls.push(`threads:${options?.onlyTweetIds?.length}`);
        return { total: 0, contextFilled: 0, belowFilled: 0, emptyChecked: 0, failed: 0, failures: [] };
      },
      gaps: async (options) => {
        calls.push(`gaps:${options?.onlyTweetIds?.length}`);
        return { total: 0, quotedTweetsFilled: 0, textExpanded: 0, articlesEnriched: 0, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 0, failed: 0, failures: [] };
      },
      media: async (options) => {
        calls.push(`media:${options?.onlyTweetIds?.length}`);
        return { schemaVersion: 1, generatedAt: '', limit: 0, maxBytes: 10, processed: 0, downloaded: 0, failed: 0, skippedTooLarge: 0, entries: [] };
      },
      folders: async () => ({ folders: [], perFolder: [], targetFolderCount: 0, totalAdded: 0,
        totalTagged: 0, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [] }),
    });
    assert.deepEqual(calls, ['threads:10', 'gaps:10', 'media:10', 'threads:4', 'gaps:4', 'media:4']);
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.equal(summary.newCount, 14);
    assert.ok(Object.values(summary.pending).every((ids: any) => ids.length === 0));
  });
});

test('focused folder ordering uses bookmark positions even for recently saved older tweets', () => {
  const savedOlderTweet = { ...record('older-tweet'), postedAt: '2018-01-01T00:00:00Z', folderNames: ['Other', 'Ads'], folderSortIndices: ['1', '20'] };
  const newerTweet = { ...record('newer-tweet'), postedAt: '2026-10-23T00:00:00Z', folderNames: ['Ads'], folderSortIndices: ['20'] };
  assert.deepEqual(recentFolderBookmarks([newerTweet, record('unrelated'), savedOlderTweet], 'ads', ['older-tweet', 'newer-tweet']).map((r) => r.id), ['older-tweet', 'newer-tweet']);
});

test('focused conversations run before old backlog and include newly discovered folder bookmarks', async () => {
  await withArchive(async (directory, write) => {
    mkdirSync(path.join(directory, 'logs'));
    writeFileSync(path.join(directory, 'logs/archive-sync-state.json'), JSON.stringify({ pending: { media: ['old'] } }));
    execFileSync('git', ['-C', directory, 'add', '-A']);
    execFileSync('git', ['-C', directory, 'commit', '-m', 'Save backlog']);
    const focused = ['a', 'b', 'c'].map((id, i) => ({ ...record(id), folderIds: ['f'], folderNames: ['Ads'], folderSortIndices: [String(1000 - i)], engagement: { replyCount: [10, 90, 20][i] } }));
    const phases: string[] = [];
    const emptyFolders = { folders: [], perFolder: [], targetFolderCount: 0, totalAdded: 0, totalTagged: 0, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [] };
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--thread-backfill', '0', '--focus-folder', 'Ads', '--comments', '2'], {
      timeline: async () => ({ added: 0, totalBookmarks: 1, pages: 1, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 1,
        stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' }),
      folders: async (options) => {
        if (options?.onlyFolderName) {
          phases.push('focus'); write([...focused, record('old')]);
          writeFileSync(path.join(directory, 'bookmark-folders-state.json'), JSON.stringify({ folders: [{ name: 'Ads', orderedRecordIds: ['a', 'b', 'c'] }] }));
        }
        return emptyFolders;
      },
      conversation: async (options) => {
        phases.push(`comments:${options.tweetId}`);
        assert.equal(options.expandBranches, true);
        const out = path.join(directory, `conversation-${options.tweetId}.md`);
        writeFileSync(out, 'Captured public replies');
        return { path: out, status: 'ok', tweetCount: 12, authorReplyCount: 3, participantCount: 7,
          topLevelReplyCount: 4, branchFetches: 2, branchTweetsAdded: 3 };
      },
      threads: async (options) => {
        phases.push('threads');
        assert.deepEqual(options?.onlyTweetIds, ['a', 'b', 'c']);
        return { total: 0, contextFilled: 0, belowFilled: 0, emptyChecked: 0, failed: 0, failures: [] };
      },
      gaps: async () => ({ total: 0, quotedTweetsFilled: 0, textExpanded: 0, articlesEnriched: 0, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 0, failed: 0, failures: [] }),
      media: async (options) => {
        phases.push('media');
        assert.deepEqual(options?.onlyTweetIds, phases.includes('threads') ? ['a', 'b', 'c'] : ['old']);
        return { schemaVersion: 1, generatedAt: '', limit: 0, maxBytes: 10, processed: 0, downloaded: 0, failed: 0, skippedTooLarge: 0, entries: [] };
      },
    });
    assert.deepEqual(phases, ['focus', 'comments:b', 'comments:c', 'media', 'threads', 'media']);
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.equal(summary.newCount, 3);
    assert.equal(summary.conversations.length, 2);
    assert.deepEqual(summary.pendingConversations, []);
    assert.deepEqual(summary.pending.folders, []);
  });
});

test('a conversation guardrail saves its pending ID and skips older enrichment', async () => {
  await withArchive(async (directory, write) => {
    const focused = { ...record('ad'), folderIds: ['f'], folderNames: ['Ads'], folderSortIndices: ['999'] };
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--thread-backfill', '0', '--focus-folder', 'Ads', '--comments', '1'], {
      timeline: async () => ({ added: 0, totalBookmarks: 1, pages: 1, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 1,
        stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' }),
      folders: async () => {
        write([focused, record('old')]);
        writeFileSync(path.join(directory, 'bookmark-folders-state.json'), JSON.stringify({ folders: [{ name: 'Ads', orderedRecordIds: ['ad'] }] }));
        return { folders: [], perFolder: [], targetFolderCount: 0, totalAdded: 1, totalTagged: 0, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [] };
      },
      conversation: async () => { throw new HttpSafetyStopError('fixture stop', 'request budget reached'); },
      threads: async () => { throw new Error('must not run older threads after a conversation stop'); },
    });
    const state = JSON.parse(readFileSync(path.join(directory, 'logs/archive-sync-state.json'), 'utf8'));
    assert.deepEqual(state.pendingConversations, ['ad']);
    assert.equal(process.exitCode, 2);
  });
});

test('backfill prioritizes requested domains, bounds work, and distinguishes old checks from verified coverage', () => {
  const legacy = { ...record('legacy'), folderNames: ['Paywalls'], threadExpandedAt: '2020-01-01T00:00:00Z' };
  const complete: BookmarkRecord = { ...record('complete'), folderNames: ['Ads'], threadCapture: {
    status: 'complete', checkedAt: '', retryable: false, parentsComplete: true, detailComplete: true, pagesFetched: 1 } };
  const partial: BookmarkRecord = { ...record('partial'), threadCapture: {
    status: 'partial', checkedAt: '', retryable: true, parentsComplete: true, detailComplete: false, pagesFetched: 3, nextCursor: 'next' } };
  const rows = [record('other'), legacy, complete, partial, { ...record('consumer'), folderNames: ['Consumer Apps'] }];
  assert.deepEqual(selectThreadBackfill(rows, new Set(), 2), ['legacy', 'consumer']);
  assert.deepEqual(selectThreadBackfill(rows, new Set(['legacy']), 1), ['consumer']);
  assert.deepEqual(selectThreadBackfill(rows, new Set(), 0), []);
  const coverage = threadCoverageReport(rows);
  assert.equal(coverage.complete, 1);
  assert.equal(coverage.legacyUnverified, 1);
  assert.equal(coverage.partial, 1);
  assert.equal(coverage.unchecked, 2);
  assert.equal(coverage.resumable, 1);
  assert.match(threadCoverageLabel(legacy), /not verified/);
  assert.match(threadCoverageLabel(partial), /Incomplete/);
});

test('default backfill is bounded, new bookmarks go first, and partial threads remain queued', async () => {
  await withArchive(async (directory, write) => {
    const old = Array.from({ length: 12 }, (_, i) => ({ ...record(`old-${i}`), folderNames: ['Ads'] }));
    write(old);
    execFileSync('git', ['-C', directory, 'add', '-A']);
    execFileSync('git', ['-C', directory, 'commit', '-m', 'Historical fixtures']);
    const current = [{ ...record('new'), folderNames: ['Ads'] }, ...old];
    const checked: string[] = [];
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push'], {
      timeline: async () => {
        write(current);
        return { added: 1, totalBookmarks: 13, pages: 1, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 13,
          stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' };
      },
      threads: async (options) => {
        const ids = options!.onlyTweetIds!;
        checked.push(...ids);
        for (const bookmark of current.filter((r) => ids.includes(r.id))) {
          bookmark.threadCapture = { status: bookmark.id === 'new' ? 'partial' : 'complete', checkedAt: '',
            retryable: bookmark.id === 'new', parentsComplete: true, detailComplete: bookmark.id !== 'new', pagesFetched: 3,
            nextCursor: bookmark.id === 'new' ? 'resume' : undefined };
        }
        write(current);
        return { total: ids.length, contextFilled: 0, belowFilled: 0, emptyChecked: 0, failed: 0, failures: [],
          completedIds: ids.filter((id) => id !== 'new'), pendingIds: ids.filter((id) => id === 'new') };
      },
      gaps: async () => ({ total: 0, quotedTweetsFilled: 0, textExpanded: 0, articlesEnriched: 0, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 0, failed: 0, failures: [] }),
      media: async () => ({ schemaVersion: 1, generatedAt: '', limit: 0, maxBytes: 10, processed: 0, downloaded: 0, failed: 0, skippedTooLarge: 0, entries: [] }),
      folders: async () => ({ folders: [], perFolder: [], targetFolderCount: 0, totalAdded: 0, totalTagged: 0, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [] }),
    });
    assert.equal(checked[0], 'new');
    assert.equal(checked.length, 11);
    assert.equal(new Set(checked).size, 11);
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.deepEqual(summary.pending.threads, ['new']);
    assert.equal(summary.threadBackfillIds.length, 10);
    assert.equal(summary.threadCoverage.complete, 10);
    assert.equal(summary.threadCoverage.partial, 1);
    assert.equal(summary.threadCoverage.unchecked, 2);
    assert.equal(process.exitCode, 2);
  });
});

test('backlog counts deduplicate bookmarks shared by multiple stage queues', () => {
  assert.deepEqual(backlogCounts({ threads: ['a', 'b'], media: ['b', 'c'], folders: ['a'] }), {
    uniqueBookmarks: 3, stages: { gaps: 0, media: 2, folders: 1, threads: 2 },
  });
});

test('backlog-only skips head and historical checks, drains stages and preserves downstream work from thread discovery', async () => {
  await withArchive(async (directory, write) => {
    const statePath = path.join(directory, 'logs/archive-sync-state.json');
    mkdirSync(path.dirname(statePath));
    writeFileSync(statePath, JSON.stringify({ timelineCursor: 'unfinished-head', pending: {
      threads: ['old'], gaps: ['old'], media: ['old'], folders: ['old'],
    } }));
    execFileSync('git', ['-C', directory, 'add', '-A']);
    execFileSync('git', ['-C', directory, 'commit', '-m', 'Save backlog']);
    const calls: string[] = [];
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--backlog-only'], {
      timeline: async () => { throw new Error('Backlog-only must not fetch the head'); },
      gaps: async (options) => {
        assert.deepEqual(options?.onlyTweetIds, ['old']); calls.push('gaps');
        return { total: 0, quotedTweetsFilled: 0, textExpanded: 0, articlesEnriched: 0, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 0, failed: 0, failures: [] };
      },
      media: async (options) => {
        assert.deepEqual(options?.onlyTweetIds, ['old']); calls.push('media');
        return { schemaVersion: 1, generatedAt: '', limit: 0, maxBytes: 10, processed: 0, downloaded: 0, failed: 0, skippedTooLarge: 0, entries: [] };
      },
      folders: async () => {
        calls.push('folders');
        write([{ ...record('old'), folderIds: ['f'], folderNames: ['Research'] }]);
        return { folders: [], perFolder: [], targetFolderCount: 1, totalAdded: 0, totalTagged: 1, totalUntagged: 0, skippedFolders: [], orphanFoldersCleared: [],
          coverage: { targetRecordIds: 1, taggedRecordIds: 1, remainingRecordIds: [], stoppedAfterCoverage: true } };
      },
      threads: async (options) => {
        assert.deepEqual(options?.onlyTweetIds, ['old']); calls.push('threads');
        return { total: 1, contextFilled: 0, belowFilled: 1, emptyChecked: 0, failed: 0, failures: [], completedIds: ['old'] };
      },
    });
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.deepEqual(calls, ['gaps', 'media', 'folders', 'threads']);
    assert.equal(state.timelineCursor, 'unfinished-head');
    assert.deepEqual(state.pending, { threads: [], gaps: ['old'], media: ['old'], folders: [] });
    assert.equal(summary.mode, 'backlog-only');
    assert.deepEqual(summary.threadBackfillIds, []);
    assert.equal(summary.newCount, 0);
    assert.equal(process.exitCode, 2);
  });
});

test('backlog rotation survives guardrail pauses and durably resumes the folder cursor', async () => {
  await withArchive(async (directory) => {
    const statePath = path.join(directory, 'logs/archive-sync-state.json');
    mkdirSync(path.dirname(statePath));
    writeFileSync(statePath, JSON.stringify({ pending: { threads: ['old'], gaps: ['old'], media: ['old'], folders: ['old'] } }));
    const commit = (): void => {
      execFileSync('git', ['-C', directory, 'add', '-A']);
      execFileSync('git', ['-C', directory, 'commit', '-m', 'Save paused backlog']);
      process.exitCode = 0;
    };
    commit();
    const calls: string[] = [];
    const stop = (): never => { throw new HttpSafetyStopError('fixture stop', 'request budget reached'); };
    for (const expected of ['media', 'folders', 'threads']) {
      await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--backlog-only'], {
        timeline: async () => { throw new Error('No head fetch'); },
        gaps: async () => { calls.push('gaps'); return stop(); },
        media: async () => { calls.push('media'); return stop(); },
        folders: async (options) => {
          calls.push('folders');
          options?.onCheckpoint?.({ id: 'saved-folder', name: 'Research' });
          assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).folderResumeAfterId, 'saved-folder');
          return stop();
        },
        threads: async () => { throw new Error('Must stop at the first paused stage'); },
      });
      assert.equal(process.exitCode, 2);
      assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).nextBacklogStage, expected);
      commit();
    }
    assert.deepEqual(calls, ['gaps', 'media', 'folders']);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.nextBacklogStage = 'folders';
    writeFileSync(statePath, JSON.stringify(state));
    commit();
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--backlog-only'], {
      folders: async (options) => { assert.equal(options?.resumeAfterFolderId, 'saved-folder'); return stop(); },
    });
    assert.equal(process.exitCode, 2);
  });
});

test('ordinary sync services saved work before fresh threads and does not grow historical backfill while queues exist', async () => {
  await withArchive(async (directory, write) => {
    const statePath = path.join(directory, 'logs/archive-sync-state.json');
    mkdirSync(path.dirname(statePath));
    writeFileSync(statePath, JSON.stringify({ pending: { gaps: ['old'] } }));
    execFileSync('git', ['-C', directory, 'add', '-A']);
    execFileSync('git', ['-C', directory, 'commit', '-m', 'Save backlog']);
    const calls: string[] = [];
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push'], {
      timeline: async () => {
        calls.push('head'); write([record('new'), record('old')]);
        return { added: 1, totalBookmarks: 2, pages: 1, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 2,
          stopReason: 'caught up to newest stored bookmark', cachePath: '', statePath: '' };
      },
      gaps: async (options) => {
        assert.deepEqual(options?.onlyTweetIds, ['old']); calls.push('old-gap');
        return { total: 0, quotedTweetsFilled: 0, textExpanded: 0, articlesEnriched: 0, bookmarkedAtRepaired: 0, bookmarkedAtMissing: 0, failed: 0, failures: [] };
      },
      threads: async (options) => {
        assert.deepEqual(options?.onlyTweetIds, ['new']); calls.push('new-thread');
        throw new HttpSafetyStopError('fixture stop', 'request budget reached');
      },
    });
    assert.deepEqual(calls, ['head', 'old-gap', 'new-thread']);
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.deepEqual(summary.threadBackfillIds, []);
    assert.deepEqual(summary.pending.gaps, ['new']);
    assert.deepEqual(summary.pending.media, ['new']);
    assert.equal(process.exitCode, 2);
  });
});

test('empty backlog-only never expands the full archive or fetches a folder inventory', async () => {
  await withArchive(async (directory) => {
    const unexpected = async (): Promise<never> => { throw new Error('No requests for an empty saved backlog'); };
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--backlog-only'], {
      timeline: unexpected, threads: unexpected, gaps: unexpected, media: unexpected, folders: unexpected, conversation: unexpected,
    });
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.equal(summary.batchCount, 0);
    assert.equal(summary.backlog.after.uniqueBookmarks, 0);
    assert.equal(summary.paused, null);
    assert.equal(process.exitCode, 0);
  });
});

test('a folder guardrail removes already checkpointed assignments from the pending report', async () => {
  await withArchive(async (directory, write) => {
    const statePath = path.join(directory, 'logs/archive-sync-state.json');
    mkdirSync(path.dirname(statePath));
    writeFileSync(statePath, JSON.stringify({ nextBacklogStage: 'folders', pending: { folders: ['old', 'missing'] } }));
    execFileSync('git', ['-C', directory, 'add', '-A']);
    execFileSync('git', ['-C', directory, 'commit', '-m', 'Save pending folders']);
    await archiveSyncMain(['node', 'x-bookmark-sync', '--no-push', '--backlog-only'], {
      folders: async (options) => {
        write([{ ...record('old'), folderIds: ['f'], folderNames: ['Research'] }]);
        options?.onCheckpoint?.({ id: 'f', name: 'Research' });
        throw new HttpSafetyStopError('fixture stop', 'request budget reached');
      },
    });
    const summary = JSON.parse(readFileSync(path.join(directory, 'previews/latest-fetch-summary.json'), 'utf8'));
    assert.deepEqual(summary.pending.folders, ['missing']);
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).pending.folders, ['missing']);
    assert.equal(summary.backlog.after.uniqueBookmarks, 1);
    assert.equal(summary.paused, 'request budget reached');
    assert.equal(process.exitCode, 2);
  });
});
