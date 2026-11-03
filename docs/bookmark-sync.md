# Bookmark Archive Sync

`x-bookmark-sync` is a deterministic command any code agent or a terminal can run. It uses the extraction engine in this repository; no LLM is needed to process each post.

```bash
x-bookmark-sync
```

It fetches the latest bookmarks, then enriches groups of ten: same-author threads, quoted text and article gaps, followed by images and capped videos. It then reconciles recent X folders, rebuilds search and Markdown, writes an HTML preview, and commits/pushes the archive's current branch to `origin`. Focused/new bookmarks and resumable threads take priority, followed by earlier unfinished captures and bounded historical backfill. Folder reconciliation stops when the selected bookmarks have folder tags; a routine sync is not a full historical crawl. With no pending folder targets it refreshes the folder inventory only.

When saved work exists, ordinary syncs give one older stage a turn before fresh thread enrichment. That turn rotates durably through gaps, media, folders and threads, including across guardrail pauses. Historical thread checks are not added while saved queues remain. Folder reconciliation checkpoints the last successfully saved folder and continues after it next time, wrapping through live X order instead of repeatedly checking only the first twenty folders.

## Installation

Requires Node.js 20+, installed repository dependencies, Git/Git LFS, an existing clean archive repository and a configured X browser session. Install dependencies with `npm ci` on a fresh checkout, then:

```bash
npm run build
mkdir -p ~/.local/bin ~/.codex/skills ~/.claude/skills
ln -s "$PWD/bin/x-bookmark-sync.mjs" ~/.local/bin/x-bookmark-sync
ln -s "$PWD/skills/x-bookmark-sync" ~/.codex/skills/x-bookmark-sync
ln -s "$PWD/skills/x-bookmark-sync" ~/.claude/skills/x-bookmark-sync
```

Do not overwrite an existing command or skill without inspecting it. Keep `~/.local/bin` on PATH, or call `~/.local/bin/x-bookmark-sync` directly. Rebuild after updating the command source. The shared skill is available as `/x-bookmark-sync` in Claude and `$x-bookmark-sync` in Codex when their skill discovery loads it. Other agents can run the command directly.

## Options And Results

```bash
x-bookmark-sync --check       # Local prerequisites and remaining request allowance
x-bookmark-sync --no-push     # Fetch and export, leaving changes uncommitted
x-bookmark-sync --backlog-only # Work through saved queues, without fetching the bookmark head
x-bookmark-sync --overnight --check # Inspect unattended limits without network requests
x-bookmark-sync --overnight   # Slow saved-queue catch-up, only 01:00-06:00 Jamaica time
x-bookmark-sync --focus-folder Ads --comments 3  # Prioritize Ads and archive public conversations
x-bookmark-sync --focus-folder SEO --folder-only # Fresh SEO folder fetch, without global feed/backlog work
x-bookmark-sync --enrich-only 2110162988657180990 # URLs/media for one saved bookmark, without a feed/thread/folder walk
x-bookmark-sync --help
```

`--data-dir` or `FT_DATA_DIR` selects another archive, which must be the root of its own Git checkout. Browser/profile selectors are available in `--help`. Default budgets cover the whole process: 240 controlled requests, at most 300 including requests in the last hour's saved audit logs, minimum 3-second spacing plus jitter, and a remaining-rate floor of 120. Thread expansion also spaces requests by 5 seconds. Audited requests made by this CLI contribute to the hourly check; browser traffic and other tools are not measurable through these logs.

The command locks concurrent invocations for the same archive, requires a clean initial working tree, fetches and fast-forwards the archive, and preserves pending stage IDs and any unfinished timeline cursor. A later sync resumes that cursor before returning to ordinary head checks. An extraction pause still exports and publishes saved progress. It does not loop around the guardrails or force-push. A failed push leaves the commit locally for inspection/retry. No cookie/token values are passed on the command line or stored in the skill.

Exit codes: **0** completed planned stages, **1** error, **2** partial progress with queued work. Check `previews/latest-fetch-summary.json` for individual extraction failures even on exit 0. Oversized media remains linked with a recorded skip reason. Deleted/inaccessible posts and unavailable external pages cannot be guaranteed complete. The HTML preview includes captured batch data and local assets; the foldered Markdown excludes bookmarks whose folder membership is still unknown, while raw JSONL preserves them.

Use `--backlog-only` for an explicitly requested catch-up pass. It rotates batches of up to ten queued IDs per enrichment stage, attempts at most one bounded folder pass, and does not add historical thread checks or fetch the bookmark head. Any unfinished head cursor is preserved for a later ordinary sync. Folder walks can incidentally discover additional bookmarks; those are saved and queued, not discarded. Articles/media discovered after a thread pass stay queued even if those downstream stages already ran. This mode has the same request allowance, spacing, cooldowns, exports and Git publication as ordinary sync; stop at a guardrail rather than repeatedly relaunching it. It cannot be combined with `--focus-folder` or `--comments`.

The summary's `backlog.before` and `backlog.after` report both per-stage counts and **distinct bookmark counts**. One bookmark can need several stages, so adding the stage counts overstates the number of affected bookmarks. This pending inventory is separate from unchecked historical thread coverage.

For a fresh fetch of one folder, use `--focus-folder SEO --folder-only`. This walks the named folder now, prioritizes its ten latest saved bookmarks for enrichment and resumes only saved enrichment belonging to that folder. It does not read the global bookmark feed, seed historical checks, process unrelated conversations or reconcile other folders. Unrelated queues, the global feed cursor and overnight scheduling checkpoints are preserved. The HTML preview contains that folder's archived records; `scopePending` separates its unfinished work from global pending queues. Existing safety limits, cooldowns, exports and Git publication still apply. Markdown and HTML put each tweet's text and article body before its media.

## Linked URL Extraction

Every queued gap pass examines URLs in the bookmark, quoted tweet, parents and saved same-author continuations, including links in long posts. Each source keeps a `linkedResources` array in canonical JSONL: original/resolved URL, title, body/Markdown, outbound links, image/video URLs, status, attempts, failure reason and next retry time. Several URLs can be saved per tweet without replacing the first article with the last. Captured content is reused across records; page links are recorded but not recursively crawled.

HTML uses [Mozilla Readability](https://github.com/mozilla/readability) and [Turndown](https://github.com/mixmark-io/turndown) for structured Markdown. Article images/native videos enter the existing capped media queue and local previews. Markdown/plain text and JSON are supported directly. GitHub repository links fetch the default-branch `README.md`, blob links fetch the raw file, and public Gists capture up to ten files. PDFs use [unpdf/PDF.js](https://github.com/unjs/unpdf) in a local worker with a 15-second parser timeout, 128-MiB worker heap and 100-page limit. Scanned PDFs need OCR; this path does not claim PDF-image extraction or downloading every embedded video provider.

Shortlinks try HEAD, then bounded GET/HTML-refresh or canonical-URL fallback. Every redirect, adapter and media request shares the controller and redacted audit log. No X cookies are sent to external sites, scripts are not executed and private/local network destinations are rejected, including DNS answers at connection time. Fetches time out after 30 seconds; response bodies are capped at 2 MiB (10 MiB for PDF), extracted text at 250,000 characters, article images at 40 and native videos at ten. Direct image/video URLs become media targets. Truncated/preview-only captures and extraction failures are explicit. JavaScript-only pages, login walls, paywalls and unavailable sites can still require attention; no bypass is attempted.

At most six URLs per bookmark are attempted in one pass; unattempted URLs remain queued. Failed/partial captures retry after six hours, then 24 hours, up to three attempts total. Successful URLs are not fetched again because another URL failed. After the third failure, the result remains visible in JSONL/exports and `urlExtraction.exhaustedRetries`, but automatic retries stop. Guardrail interruptions preserve completed URLs without consuming an extraction retry. The overnight job processes these saved gaps without raising its request/time limits.

Use `--enrich-only <saved-tweet-id>` for targeted recovery: URLs and media for that bookmark only, preserving unrelated queues, folder/head cursors, pending conversations and the unattended-start timestamp. It rebuilds exports and commits/pushes normally. It does not fetch the bookmark head, walk folders, expand threads or seed historical checks. An unfinished thread can remain queued when its article succeeds. `scopePending` and the preview refer to the selected bookmark; global pending counts describe the whole archive.

## Overnight Catch-Up

`--overnight` implies `--backlog-only` and enforces an unattended profile in the CLI, not just in the scheduler prompt: at most **80 requests per run**, **120 including the last hour's audit logs**, and **240 including all logged CLI requests on the current Jamaican calendar date**. User-supplied budgets can lower these limits, not raise them. Requests are spaced at least ten seconds apart plus jitter, and stop at a remaining-rate floor of 200. The minimum interval between overnight starts is 90 minutes, retained across ordinary syncs in `lastOvernightStartedAt`.

No fetching starts outside **01:00-06:00 America/Jamaica**, regardless of the commit-date time zone. The HTTP controller stops before a request that would start at or after 06:00, including after a spacing wait. HTTP 429/401/403 and rate-floor stops latch the controller so catching an error cannot silently continue fetching. Saved server reset and Retry-After values are checked across process restarts, even when a 429 is older than the one-hour accounting window; the later valid cooldown header wins. A saved authentication/access pause requires a successful manual recovery before unattended work resumes.

The installed local heartbeat is scheduled for **01:00, 03:00 and 05:00 Jamaica time** until the active saved queues are empty. It invokes this profile once per scheduled slot, never loops around a pause, and uses the normal archive lock, redacted audit logs, resumable exports and Git publication. It must not seed the entire historical unchecked inventory. Keep the Mac awake and online with the desktop app running. If a slot is missed, do not catch up by firing several runs together. An expected local budget/window/cooldown skip is not an extraction failure; authentication problems, dirty archives and publication failures require inspection.

These are conservative local controls, not X-provided guarantees. They cannot measure browser traffic or unrelated tools, guarantee that X will not throttle or restrict the account, or ensure every remote post is accessible.

## Thread Coverage And Backfill

Each thread page and parent fetch is durably checkpointed in `bookmarks.jsonl` under `threadCapture`. A pass fetches at most three detail pages and 25 parents per bookmark; unfinished cursors and intermediate same-author posts survive both page bounds and request guardrails. Later syncs resume without restarting from the first page. Connected continuation posts are retained across page boundaries and downstream article/media stages are queued again when thread work runs. Repeated cursors and unavailable parents are reported as incomplete rather than silently marked complete or retried forever.

The default adds at most ten historical thread checks per run, prioritizing Ads, Paywalls, Consumer Apps and related ad folders. `--thread-backfill 0` disables this historical selection; it does not disable new captures or pending work. Old `threadExpandedAt` timestamps have no pagination proof and count as `legacyUnverified`, not complete. Historical backfill shares the existing request allowance and never restarts around a safety pause.

The summary's `threadCoverage` and `batchThreadCoverage` separate `complete`, `partial`, `unavailable`, `legacyUnverified`, and `unchecked`, with per-folder counts. Complete means the returned timeline and parent pagination were exhausted, not that X exposed hidden, private, deleted or every conversation-branch post. Markdown and HTML include each bookmark's coverage label. The new `mediaAdded`, `articlesAdded` and `newBookmarkIds` fields distinguish this run's additions from cumulative batch assets.

`--focus-folder Ads --comments 3` syncs that folder before the enrichment backlog and captures three conversations selected by reply activity among its ten latest saved posts. Recency uses the saved order of the complete folder page walk, including newly saved older posts; X's per-page numeric positions are not globally unique. Conversation Markdown includes other participants, author responses and follow-up branches. It uses at most six root pages and six one-page branch expansions per post by default; `--comment-pages` and `--comment-branches` adjust those bounds. API-visible replies may be incomplete because of these caps or X visibility restrictions. Each capture's path and counts appear in the sync summary. Interrupted conversation IDs remain queued, and their requests share the normal run allowance.

## Agent Instructions

Add this to a project's `AGENTS.md` or `CLAUDE.md` to route bookmark requests:

```markdown
## X Bookmark Synchronization

For a request to sync/fetch X or Twitter bookmarks, run `~/.local/bin/x-bookmark-sync` from any directory. The workflow is in `~/Apps/fieldtheory-cli/skills/x-bookmark-sync/SKILL.md`. It saves to `~/.fieldtheory/bookmarks`, enriches threads/articles/media, generates Markdown/HTML, and commits/pushes the archive. Inspect `previews/latest-fetch-summary.json` and report pending work accurately. Respect a guardrail pause; do not increase budgets or repeatedly restart to exhaust X. Use `--no-push` only when the user requests local changes. Bookmark sync does not mean pulling the current project's Git repository.
```
