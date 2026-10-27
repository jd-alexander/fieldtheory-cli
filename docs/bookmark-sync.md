# Bookmark Archive Sync

`x-bookmark-sync` is a deterministic command any code agent or a terminal can run. It uses the extraction engine in this repository; no LLM is needed to process each post.

```bash
x-bookmark-sync
```

It fetches the latest bookmarks, then enriches groups of ten: same-author threads, quoted text and article gaps, followed by images and capped videos. It then reconciles recent X folders, rebuilds search and Markdown, writes an HTML preview, and commits/pushes the archive's current branch to `origin`. Focused/new bookmarks and resumable threads take priority, followed by earlier unfinished captures and bounded historical backfill. Folder reconciliation stops when the selected bookmarks have folder tags; a routine sync is not a full historical crawl. With no pending folder targets it refreshes the folder inventory only.

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
x-bookmark-sync --focus-folder Ads --comments 3  # Prioritize Ads and archive public conversations
x-bookmark-sync --help
```

`--data-dir` or `FT_DATA_DIR` selects another archive, which must be the root of its own Git checkout. Browser/profile selectors are available in `--help`. Default budgets cover the whole process: 240 controlled requests, at most 300 including requests in the last hour's saved audit logs, minimum 3-second spacing plus jitter, and a remaining-rate floor of 120. Thread expansion also spaces requests by 5 seconds. Audited requests made by this CLI contribute to the hourly check; browser traffic and other tools are not measurable through these logs.

The command locks concurrent invocations for the same archive, requires a clean initial working tree, fetches and fast-forwards the archive, and preserves pending stage IDs and any unfinished timeline cursor. A later sync resumes that cursor before returning to ordinary head checks. An extraction pause still exports and publishes saved progress. It does not loop around the guardrails or force-push. A failed push leaves the commit locally for inspection/retry. No cookie/token values are passed on the command line or stored in the skill.

Exit codes: **0** completed planned stages, **1** error, **2** partial progress with queued work. Check `previews/latest-fetch-summary.json` for individual extraction failures even on exit 0. Oversized media remains linked with a recorded skip reason. Deleted/inaccessible posts and unavailable external pages cannot be guaranteed complete. The HTML preview includes captured batch data and local assets; the foldered Markdown excludes bookmarks whose folder membership is still unknown, while raw JSONL preserves them.

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
