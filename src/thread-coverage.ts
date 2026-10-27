import type { BookmarkRecord } from './types.js';

export function threadCoverageStatus(record: BookmarkRecord): 'complete' | 'partial' | 'unavailable' | 'legacyUnverified' | 'unchecked' {
  return record.threadCapture?.status ?? (record.threadExpansionFailedAt ? 'unavailable' : record.threadExpandedAt ? 'legacyUnverified' : 'unchecked');
}

export function threadCoverageLabel(record: BookmarkRecord): string {
  const status = threadCoverageStatus(record);
  if (status === 'complete') return 'API-visible timeline and parent pagination exhausted; hidden or unreturned posts may be absent';
  if (status === 'legacyUnverified') return 'Legacy check; pagination completeness not verified';
  if (status === 'unchecked') return 'Not yet checked for thread continuations';
  return `${status === 'unavailable' ? 'Unavailable' : 'Incomplete'}: ${record.threadCapture?.reason ?? 'capture could not be completed'}${record.threadCapture?.retryable ? ' (queued to resume)' : ''}`;
}

export function threadCoverageReport(records: BookmarkRecord[]) {
  const count = (items: BookmarkRecord[]) => {
    const counts = { total: items.length, complete: 0, partial: 0, unavailable: 0, legacyUnverified: 0, unchecked: 0,
      resumable: 0, withContinuations: 0, continuationSnapshots: 0 };
    for (const record of items) {
      counts[threadCoverageStatus(record)]++;
      if (record.threadCapture?.retryable) counts.resumable++;
      if (record.threadBelow?.length) counts.withContinuations++;
      counts.continuationSnapshots += record.threadBelow?.length ?? 0;
    }
    return counts;
  };
  const folders = [...new Set(records.flatMap((record) => record.folderNames ?? []))];
  return { ...count(records), folders: folders.map((folder) => ({ folder,
    ...count(records.filter((record) => record.folderNames?.includes(folder))) })) };
}

export function selectThreadBackfill(records: BookmarkRecord[], excludedIds: Set<string>, limit: number): string[] {
  const priority = (record: BookmarkRecord) => record.folderNames?.some((name) =>
    ['ads', 'paywalls', 'consumer apps', 'apple search ads', 'tiktok ads'].includes(name.toLowerCase())) ? 0 : 1;
  return records.filter((record) => !excludedIds.has(record.id) &&
    ['unchecked', 'legacyUnverified'].includes(threadCoverageStatus(record)))
    .sort((a, b) => priority(a) - priority(b))
    .slice(0, limit).map((record) => record.id);
}
