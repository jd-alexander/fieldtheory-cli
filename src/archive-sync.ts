import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync, openSync, closeSync, renameSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { dataDir, twitterBookmarksCachePath } from './paths.js';
import { readJsonLines } from './fs.js';
import { configureHttpSafety, isHttpSafetyStop } from './http-safety.js';
import { syncBookmarksGraphQL, syncBookmarkFolders, syncThreads, syncGaps } from './graphql-bookmarks.js';
import { fetchBookmarkMediaBatch, type MediaFetchEntry } from './bookmark-media.js';
import { exportReadableBookmarkArchive } from './bookmark-folder-export.js';
import { buildIndex } from './bookmarks-db.js';
import type { BookmarkRecord, ThreadTweetSnapshot } from './types.js';

type Stage = 'threads' | 'gaps' | 'media' | 'folders';
type Pending = Record<Stage, string[]>;
interface AuditEntry {
  ts: string;
  status?: number;
  ok?: boolean;
  errorName?: string;
  responseHeaders?: Record<string, string>;
}
interface SyncState { pending?: Pending; }

interface ArchiveSyncServices {
  timeline: typeof syncBookmarksGraphQL;
  threads: typeof syncThreads;
  gaps: typeof syncGaps;
  media: typeof fetchBookmarkMediaBatch;
  folders: typeof syncBookmarkFolders;
}

function jsonFile<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function saveJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function auditEntries(directory: string): AuditEntry[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => /^http-audit-.*\.jsonl$/.test(name)).flatMap((name) =>
    readFileSync(path.join(directory, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  );
}

export function availableRequestBudget(entries: AuditEntry[], now: number, runLimit: number, hourlyLimit: number): number {
  const recent = entries.filter((entry) => {
    const age = now - Date.parse(entry.ts);
    return age >= 0 && age < 3_600_000;
  });
  for (const entry of recent) {
    if (entry.status !== 429) continue;
    const reset = Number(entry.responseHeaders?.['x-rate-limit-reset']);
    const retry = Number(entry.responseHeaders?.['retry-after']);
    const resumeAt = reset > 0 ? reset * 1000 : Date.parse(entry.ts) + (retry > 0 ? retry * 1000 : 900_000);
    if (resumeAt > now) throw new Error(`X requested a cooldown until ${new Date(resumeAt).toISOString()}.`);
  }
  return Math.max(0, Math.min(runLimit, hourlyLimit - recent.length));
}

export function acquireSyncLock(directory: string): () => void {
  const name = createHash('sha256').update(realpathSync(directory)).digest('hex').slice(0, 20);
  const file = path.join(os.tmpdir(), `x-bookmark-sync-${name}.lock`);
  const create = (): void => {
    const descriptor = openSync(file, 'wx', 0o600);
    writeFileSync(descriptor, String(process.pid));
    closeSync(descriptor);
  };
  try { create(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Inspect invalid sync lock: ${file}`);
    try { process.kill(pid, 0); } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
      rmSync(file);
      create();
      return () => rmSync(file, { force: true });
    }
    throw new Error(`Another bookmark sync is running (PID ${pid}).`);
  }
  return () => rmSync(file, { force: true });
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

const escapeHtml = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
function httpUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}

export function renderBatchPreview(records: BookmarkRecord[], entries: MediaFetchEntry[], directory: string): string {
  const render = (tweet: BookmarkRecord | ThreadTweetSnapshot, bookmarkId: string): string => {
    const tweetId = 'tweetId' in tweet ? tweet.tweetId : tweet.id;
    const media = entries.filter((entry) => entry.bookmarkId === bookmarkId && entry.tweetId === tweetId && entry.status === 'downloaded');
    const uniqueMedia = [...new Map(media.map((entry) => [entry.localPath, entry])).values()];
    const assets = uniqueMedia.map((entry) => {
      if (!entry.localPath || !existsSync(entry.localPath)) throw new Error(`Downloaded media is missing: ${entry.localPath}`);
      const relative = path.relative(path.join(directory, 'previews'), entry.localPath).split(path.sep).map(encodeURIComponent).join('/');
      return entry.contentType?.startsWith('video/')
        ? `<video controls preload="metadata" src="${escapeHtml(relative)}"></video>`
        : `<img loading="lazy" src="${escapeHtml(relative)}" alt="Media from @${escapeHtml(tweet.authorHandle)}">`;
    }).join('\n');
    const links = (tweet.links ?? []).flatMap((link) => {
      const url = httpUrl(link);
      return url ? [`<li><a href="${escapeHtml(url)}">${escapeHtml(link)}</a></li>`] : [];
    }).join('');
    const article = tweet.articleText
      ? `<section><h3>${escapeHtml(tweet.articleTitle ?? 'Article')}</h3><div class="body">${escapeHtml(tweet.articleText)}</div></section>` : '';
    return `<section class="tweet"><h2>@${escapeHtml(tweet.authorHandle)}</h2><a href="https://x.com/i/status/${escapeHtml(tweetId)}">${escapeHtml(tweetId)}</a><div class="body">${escapeHtml(tweet.text)}</div>${article}${links ? `<ul>${links}</ul>` : ''}<div class="media">${assets}</div></section>`;
  };
  const body = records.map((record) => `<article><p>${escapeHtml(record.folderNames?.join(' / ') ?? '')}</p>
    ${(record.threadContext ?? []).map((tweet) => render(tweet, record.id)).join('')}
    ${render(record, record.id)}
    ${record.quotedTweet ? `<blockquote>${render(record.quotedTweet, record.id)}</blockquote>` : ''}
    ${(record.threadBelow ?? []).map((tweet) => render(tweet, record.id)).join('')}</article>`).join('\n');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; media-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'"><title>Latest X Bookmarks</title><style>
    *{box-sizing:border-box}body{font:16px/1.65 system-ui,sans-serif;margin:0;background:#fafafa;color:#202020}main{max-width:900px;margin:auto;padding:24px}h1{font-size:26px}h2{font-size:18px;margin-bottom:0}h3{font-size:20px}article{border-top:2px solid #444;padding:20px 0;overflow-wrap:anywhere}.tweet{padding:10px 0}.body{white-space:pre-wrap;margin:16px 0}.media{display:grid;gap:14px}img,video{width:100%;height:auto;max-height:850px;object-fit:contain}a{color:#076993}blockquote{margin:16px 0;padding-left:16px;border-left:3px solid #999}
    </style><main><h1>Latest X Bookmarks</h1><p>${records.length} bookmark(s)</p>${body || '<p>No new bookmarks in this run.</p>'}</main></html>`;
}

export async function archiveSyncMain(argv = process.argv, overrides: Partial<ArchiveSyncServices> = {}): Promise<void> {
  const services: ArchiveSyncServices = { timeline: syncBookmarksGraphQL, threads: syncThreads, gaps: syncGaps,
    media: fetchBookmarkMediaBatch, folders: syncBookmarkFolders, ...overrides };
  const positive = (value: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Expected a positive integer.');
    return parsed;
  };
  const program = new Command().name('x-bookmark-sync').description('Sync, enrich, export and publish the local X bookmark archive.')
    .option('--data-dir <path>', 'Archive directory (default: FT_DATA_DIR or ~/.fieldtheory/bookmarks)')
    .option('--no-push', 'Keep changes local; do not commit or push')
    .option('--check', 'Check local prerequisites and request allowance without syncing')
    .option('--request-budget <n>', 'Total controlled requests across all stages', positive, 240)
    .option('--hourly-budget <n>', 'Maximum requests including recent saved audit logs', positive, 300)
    .option('--recent-folders <n>', 'Maximum folders to reconcile in X order', positive, 20)
    .option('--time-zone <name>', 'Time zone for archive commit dates', process.env.FT_TIME_ZONE ?? 'America/Jamaica')
    .option('--browser <name>', 'Browser session to use')
    .option('--chrome-profile-directory <name>', 'Chrome-family browser profile')
    .option('--firefox-profile-dir <path>', 'Firefox profile');
  program.parse(argv);
  const options = program.opts();
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: options.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  if (options.dataDir) process.env.FT_DATA_DIR = path.resolve(options.dataDir);
  const directory = path.resolve(dataDir());
  if (!existsSync(twitterBookmarksCachePath())) throw new Error(`Archive not found: ${directory}. Run ft sync to set up authentication and the initial archive first.`);
  if (realpathSync(git(directory, 'rev-parse', '--show-toplevel')) !== realpathSync(directory)) throw new Error('The data directory must be the root of its own archive Git repository.');
  const branch = git(directory, 'branch', '--show-current');
  if (!branch) throw new Error('Check out an archive branch before syncing.');
  if (options.push) git(directory, 'remote', 'get-url', 'origin');
  const logs = path.join(directory, 'logs');
  const previousAudit = auditEntries(logs);
  const allowance = availableRequestBudget(previousAudit, Date.now(), options.requestBudget, options.hourlyBudget);
  if (options.check) {
    console.log(JSON.stringify({ directory, branch, availableRequests: allowance, clean: !git(directory, 'status', '--porcelain'), node: process.version }, null, 2));
    return;
  }
  const release = acquireSyncLock(directory);
  try {
    if (git(directory, 'status', '--porcelain')) throw new Error('Archive has uncommitted changes. Inspect them before running a sync so unrelated work is not committed.');
    if (options.push) {
      git(directory, 'fetch', 'origin');
      git(directory, 'merge', '--ff-only', `origin/${branch}`);
    }
    const initial = await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath());
    const beforeIds = new Set(initial.map((record) => record.id));
    const statePath = path.join(logs, 'archive-sync-state.json');
    const saved = jsonFile<SyncState>(statePath, {});
    const pending: Pending = { threads: [], gaps: [], media: [], folders: [], ...saved.pending };
    const startedAt = new Date().toISOString();
    const runId = startedAt.replace(/[:.]/g, '-');
    const previewDir = path.join(directory, 'previews');
    mkdirSync(previewDir, { recursive: true });
    saveJson(path.join(previewDir, 'pre-fetch-latest.json'), { generatedAt: startedAt, count: beforeIds.size, ids: [...beforeIds] });
    configureHttpSafety({ auditHttp: true, auditHttpBody: false, minDelayMs: 3000, jitterMs: 750,
      requestBudget: Math.max(1, allowance), maxRequestsPerHour: options.hourlyBudget, rateLimitFloor: 120 });
    const auth = { browser: options.browser, chromeProfileDirectory: options.chromeProfileDirectory, firefoxProfileDir: options.firefoxProfileDir };
    const stages: Record<string, unknown> = {};
    let paused: string | undefined = allowance === 0 ? 'hourly request budget reached' : undefined;
    const freshAudit = (): AuditEntry[] => auditEntries(logs).filter((entry) => entry.ts >= startedAt);
    const run = async <T>(name: string, task: () => Promise<T>): Promise<T | undefined> => {
      if (paused) { stages[name] = { skipped: paused }; return undefined; }
      console.log(`[${name}] starting`);
      try {
        const result = await task();
        // Media manifests are cumulative; keep their entries in the original manifest only.
        stages[name] = result && typeof result === 'object' && 'entries' in result
          ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'entries')) : result;
        const requests = freshAudit();
        if (requests.some((entry) => entry.status === 429)) paused = 'X returned HTTP 429';
        else if (requests.some((entry) => entry.status === 401 || entry.status === 403)) paused = 'Authentication or access failure; inspect the HTTP audit';
        else if (requests.length >= allowance) paused = 'request budget reached';
        console.log(`[${name}] saved`);
        return result;
      } catch (error) {
        paused = isHttpSafetyStop(error) ? error.stopReason : (error as Error).message;
        stages[name] = { error: paused };
        console.error(`[${name}] paused: ${paused}`);
        return undefined;
      }
    };
    const timeline = await run('timeline', () => services.timeline({ ...auth, incremental: true, maxPages: 12,
      delayMs: 3000, maxMinutes: 15, onProgress: (p) => console.log(`[timeline] page ${p.page}: ${p.newAdded} new`) }));
    if (timeline && !['caught up to newest stored bookmark', 'end of bookmarks', 'no new bookmarks (stale)'].includes(timeline.stopReason)) paused = timeline.stopReason;
    const captured = await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath());
    const newIds = captured.filter((record) => !beforeIds.has(record.id)).map((record) => record.id);
    for (const stage of Object.keys(pending) as Stage[]) pending[stage] = [...new Set([...pending[stage], ...newIds])];
    saveJson(statePath, { startedAt, pending });
    const completeStage = (stage: Stage): void => {
      pending[stage] = [];
      saveJson(statePath, { startedAt, pending });
    };
    const enrich = async (): Promise<void> => {
      if (pending.threads.length) {
        const threads = await run('threads', () => services.threads({ ...auth, onlyTweetIds: pending.threads, delayMs: 5000,
          onProgress: (p) => console.log(`[threads] ${p.done}/${p.total}, ${p.belowFilled} continuation chains`) }));
        if (threads) completeStage('threads');
      }
      if (pending.gaps.length) {
        const gaps = await run('gaps', () => services.gaps({ ...auth, onlyTweetIds: pending.gaps, articleLimit: pending.gaps.length, delayMs: 5000,
          onProgress: (p) => console.log(`[gaps] ${p.done}/${p.total}, ${p.articlesEnriched} articles, ${p.failed} misses`) }));
        if (gaps) { saveJson(path.join(directory, 'gaps-failures.json'), { failures: gaps.failures }); completeStage('gaps'); }
      }
      if (pending.media.length) {
        const media = await run('media', () => services.media({ onlyTweetIds: pending.media, skipProfileImages: true, mediaQuality: 'large',
          onProgress: (p) => console.log(`[media] ${p.processed} processed, ${p.downloaded} downloaded, ${p.failed} failed`) }));
        if (media?.stopReason) paused = media.stopReason;
        else if (media && media.failed === 0) completeStage('media');
      }
    };
    await enrich();
    const folderTargets = pending.folders;
    const folders = await run('folders', () => services.folders({ ...auth, folderLimit: folderTargets.length ? options.recentFolders : 0,
      stopWhenRecordIdsTagged: folderTargets, reconcileUntaggedRecords: false, delayMs: 3000,
      onProgress: (p) => { if (p.folder && p.phase === 'walking') console.log(`[folders] ${p.folder.name}`); } }));
    if (folders) {
      pending.folders = folders.coverage?.remainingRecordIds ?? [];
      saveJson(statePath, { startedAt, pending });
    }
    // Folder walks can discover bookmarks absent from the all-bookmarks timeline.
    const records = await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath());
    const folderOnlyIds = records.filter((record) => !beforeIds.has(record.id) && !newIds.includes(record.id)).map((record) => record.id);
    for (const stage of ['threads', 'gaps', 'media'] as Stage[]) pending[stage] = [...new Set([...pending[stage], ...folderOnlyIds])];
    if (folderOnlyIds.length) {
      saveJson(statePath, { startedAt, pending });
      await enrich();
    }
    const finalRecords = folderOnlyIds.length ? await readJsonLines<BookmarkRecord>(twitterBookmarksCachePath()) : records;
    const batchIds = new Set([...newIds, ...folderOnlyIds, ...Object.values(saved.pending ?? {}).flat()]);
    const batch = finalRecords.filter((record) => batchIds.has(record.id));
    await buildIndex({ force: true });
    const exported = await exportReadableBookmarkArchive({ clean: true, includeUnfiled: false });
    const manifest = jsonFile<{ entries: MediaFetchEntry[] }>(path.join(directory, 'media-manifest.json'), { entries: [] });
    const batchMedia = manifest.entries.filter((entry) => batchIds.has(entry.bookmarkId));
    const previewPath = path.join(previewDir, 'latest-batch.html');
    writeFileSync(previewPath, renderBatchPreview(batch, batchMedia, directory));
    const requests = freshAudit();
    const remaining = requests.flatMap((entry) => {
      const value = entry.responseHeaders?.['x-rate-limit-remaining'];
      return value != null && Number.isFinite(Number(value)) ? [Number(value)] : [];
    });
    const summary = {
      startedAt, generatedAt: new Date().toISOString(), beforeCount: initial.length, afterCount: records.length,
      newCount: records.length - initial.length, batchCount: batch.length, paused: paused ?? null,
      pending, stages, exported, previewPath,
      media: { downloaded: batchMedia.filter((entry) => entry.status === 'downloaded').length,
        videos: batchMedia.filter((entry) => entry.status === 'downloaded' && entry.contentType?.startsWith('video/')).length,
        skippedTooLarge: batchMedia.filter((entry) => entry.status === 'skipped_too_large').length,
        failed: batchMedia.filter((entry) => entry.status === 'failed').length },
      audit: { requests: requests.length, nonOk: requests.filter((entry) => entry.ok === false).length,
        networkErrors: requests.filter((entry) => entry.status == null).length,
        minRemaining: remaining.length ? Math.min(...remaining) : null },
    };
    saveJson(statePath, { startedAt, pending, paused: summary.paused });
    saveJson(path.join(previewDir, 'latest-new-ids-full.json'), { generatedAt: summary.generatedAt, newCount: summary.newCount,
      beforeCount: initial.length, afterCount: records.length, ids: [...batchIds], bookmarks: batch });
    saveJson(path.join(previewDir, 'latest-fetch-summary.json'), summary);
    saveJson(path.join(logs, `archive-sync-${runId}.json`), summary);
    if (options.push) {
      git(directory, 'add', '-A');
      if (git(directory, 'diff', '--cached', '--name-only')) git(directory, 'commit', '-m', `Sync X bookmarks through ${localDate.format(new Date())}`);
      git(directory, 'push', 'origin', branch);
      console.log(`Pushed ${git(directory, 'rev-parse', '--short', 'HEAD')} to origin/${branch}`);
    }
    console.log(JSON.stringify({ newCount: summary.newCount, afterCount: summary.afterCount, media: summary.media,
      audit: summary.audit, paused: summary.paused, pending, previewPath }, null, 2));
    if (paused || Object.values(pending).some((ids) => ids.length)) process.exitCode = 2;
  } finally { release(); }
}
