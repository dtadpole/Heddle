---
title: DSH Workspaces And Sessions
level: L2
version: 1.0.0
description: How DSH models workspaces as folders with records, and sessions under them.
status: unverified
grounded_in:
  - source: the installed DSH packages under ~/.volta, read on 2026-10-11
  - source: the live store at ~/.dsh for the workspace and session shapes
---

# DSH Workspaces & Sessions — Implementation Report

Scope studied: installed packages under
`$PKG = /Users/zhenc/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
plus the live store at `~/.dsh/`. Read `lib/types/*.d.ts` for interfaces and `lib/**/*.js` for behaviour.

## 1. What a workspace is

**Both** — a durable *registry record* that owns an existing *canonical directory on disk*. Neither alone is a workspace.

- A record is `{ id: WorkspaceId, path, title, sessionIds, createdAt, updatedAt }`.
- `WorkspaceId` is a generated uuid, **never the path** (path normalization rewrites paths; the anchor must stay stable).
- The record is only a *candidate account*; actual membership requires **both** the id in `sessionIds` **and** a stored session header whose canonical `cwd` equals `path` (`$PKG/dsh-workspace/lib/types/types.d.ts:22-51, 43-51`).
- `path` = `fs.realpath` of the create-time path (symlinks/`..`/trailing slash resolved), never rewritten afterwards. Uniqueness is string equality of canonical paths. Relative or nonexistent paths reject (`dsh-workspace/lib/types/paths.d.ts`).
- `title` defaults to the final path segment (`defaultWorkspaceTitle`); duplicates across workspaces are allowed at create; only `rename` checks uniqueness (`workspace/name-conflict`).
- `status()` is a live uncached `'ok' | 'missing-dir'`; a missing directory never mutates the record.

**Ordering is two arrays, not an integer field:**
- Workspace order → `global.workspaceIds` (authoritative display order; new workspace is **prepended**).
- Session order within a workspace → the `sessionIds` array itself (array order = display order; a newly attached session is **prepended**; explicit reorder via `insertSessionBefore`; activity never reorders).

**Record schema (zod `workspaceRecord`)** — `$PKG/dsh-workspace/lib/types/spec.d.ts`:
`path: string`, `title: string`, `sessionIds: string[]`, `createdAt: ISO-8601`, `updatedAt: ISO-8601`.
Domain state `workspaceDomainState`: `{ initialized: boolean, workspaceIds: WorkspaceId[], archivedSessionIds: SessionId[], pendingMutation? }`.
Domain = `name: "workspace", version: 2`, one table `workspaces`.

**Which file holds it:** `~/.dsh/storages/workspace.json` (JSON backend, `single` layout: one document `{ unit: {name,version}, global, tables: { workspaces: { <uuid>: record } } }`). Observed live. Related: `~/.dsh/storages/workspace.json.bak-*`.

## 2. Session storage layout, compression, locking, bucket naming

Root: required config `root` of the JSONL backend (`$PKG/dsh-session-persistence-jsonl/lib/types/index.d.ts:19-30`); on this machine `~/.dsh/sessions`.

```
<root>/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.v<N>.jsonl.zstd
                                                  /session.lock
```

**Bucket-naming rule**, quoted verbatim from `$PKG/dsh-session-persistence-jsonl/lib/types/format.d.ts` (impl at `lib/index.js:874-893`):

> Build the readable directory key for a project path. Filesystem separators and drive separators become `-`; unsafe code units use the same `~XXXX` escape as session ids. The key is bounded for filesystem component limits. Separator replacement and truncation are intentionally lossy, following the common human-navigable project-directory convention.

```js
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = ""; let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i); const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") { if (!separatorRun) readable += "-"; separatorRun = true; }
    else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separatorRun = false; }
    else { readable += "~" + code.toString(16).toUpperCase().padStart(4, "0"); separatorRun = false; }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
```

So `/Users/zhenc/heddle` → `--Users-zhenc-heddle--` (matches the live store), `/` → `--root--`, and a session with no `cwd` goes to the `_no-cwd` bucket (`projectDir`).

**Session-id segment** (`encodeSegment`, same file): safe `[A-Za-z0-9._-]` stay literal; every other UTF-16 unit becomes `~XXXX`; `.` → `~002E`, `..` → `~002E~002E`. This neutralizes `../`, NUL, separators.

**Filename/version:** `generationLogFilename(version, compression)` = `session.v<N>.jsonl.zstd` for N≥1; version 0 keeps the legacy `session.jsonl`. Current logical format is `SESSION_FORMAT_VERSION = 3` (`$PKG/dsh-session/lib/types/types.d.ts:54`), hence `session.v3.jsonl.zstd`. Migration leaves the old generation file in place and publishes the new one exclusively.

**Compression:** `compression: 'zstd' | 'none'`; suffix `.jsonl.zstd` (checksummed Zstandard frames, the default) or `.jsonl` (`logSuffix`).

**Locking** (`$PKG/dsh-session-persistence-jsonl/lib/types/lease.d.ts`): `LEASE_FILENAME = "session.lock"` sits beside the log. POSIX takes a **non-blocking `flock(2)`** via native support; Windows holds a named kernel semaphore. Held for the whole life of the write handle; readers never touch it; contention → `SessionAlreadyOwnedError`; the kernel releases on process death; release never removes the POSIX lock file (stable inode for later lockers). Acquired at write-open of an existing artifact, and for a *created* session only immediately before its first materializing write.

**Materialization:** a created session is visible to this process from `create` (in-process pending tracker) but has no filesystem footprint; it reaches disk on first `append` or `flush`. A session that never materialized before a crash never existed.

**Observed live** (e.g. `~/.dsh/sessions/--Users-zhenc-heddle--/`): one directory per session id, each containing a zero-byte `session.lock` and `session.v3.jsonl.zstd`. Fake/legacy ids appear as bare uuids (no `session-` prefix) — id is escaped, not validated.

**Projection cache (derived, not authority):** `~/.dsh/storages/session_projcache.json` + `session_projcache/sessions/<sessionId>.json` (`per-record` layout), domain `session_projcache` (`$PKG/dsh-session-projection-cache`).

## 3. Session first line / header

`toHeaderLine` (`dsh-session-persistence-jsonl/lib/types/format.d.ts`, `HeaderLine`) writes exactly one `type:"session"` first record. Live sample:

```json
{"type":"session","version":3,"id":"session-63310d7b-…","createdAt":1791711026098,"cwd":"/Users/zhenc/heddle","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

Fields (`SessionHeader`, `$PKG/dsh-session/lib/types/types.d.ts:58-95`):
`version` (always 3), `id` (`SessionId`), `createdAt` (epoch **ms**, non-negative safe integer), optional `cwd` (must be absolute), optional `parentSession` (fork seed lineage), `isSeeded` (fork prefix present), optional `origin: 'subagent'`, optional `delegationDepth` (absent = 0), optional `agentPreset`. Absent optional fields are omitted, never null.

**No title in the header.** The title is a log-only, latest-wins event appended later:
`{"type":"session/title","seq":22,"time":…,"data":{"title":"…","messageSeqs":[16],"source":{"kind":"fallback"}}}` (`$PKG/dsh-session-title`). The exact fork-inherited prefix length is storage metadata: encoded onto the header line only when `isSeeded`, otherwise recovered from the last tagged `session/end-seed` event.

## 4. Session ↔ workspace association

**There is no `workspaceId` field on a session.** Association is a two-part rule, not a stored pointer:

1. The workspace record's `sessionIds` account contains the session id, and
2. the session header's canonical `cwd` **equals** the workspace `path` (`WorkspaceEntityHost.sessionPath` / `readSessionHeader` validate this).

`WorkspaceRegistry` builds a canonical-cwd header index at startup, replacing the persistence dependency with an empty history (`static inject = ["storageDomain", "sessionPersistence"]`; `$PKG/dsh-workspace/lib/types/index.d.ts`).

**At creation** (`$PKG/dsh-api-session-controller/lib/types/commands.js:88-120`): `session.create` accepts `workspaceId` **or** `cwd`, never both (`gateway/bad-request`); `cwd = workspace?.path ?? request.cwd ?? defaultCwd`; then `workspace.attachSession(sessionId)`. `attachSession` re-reads the stored header, requires its cwd to resolve to an existing directory equal to `path`, and **prepends** the id; a mismatch/unknown id rejects without writing (`workspace-attach-failed`). So a session minted through a workspace always has `cwd == workspace.path` exactly.

**Sessions created outside any workspace** (plain `cwd`, CLI/headless) get no account row until the bootstrap pass groups them.

**Subdirectory case:** a session created with `cwd = <workspace>/sub` has a canonical cwd **not equal** to the workspace path, so it is **not** a member of the parent workspace — `attachSession` would reject it. It lands in its own bucket `--…-workspace-sub--`, and that subdirectory must become its own workspace (`create`/`resolveByPath`, or the history bootstrap). There is no inheritance/prefix containment anywhere.

**Forks:** the child inherits the source `cwd`; the target workspace is resolved by `forkWorkspace(source)` (`commands.js:498-510`): find a workspace directly accounting the source; if none and `source.origin === 'subagent'`, walk `ctx.sessionQuery.traceSession(source.id).ancestors` and take the first ancestor that is accounted. If a workspace is found the child is attached the same way.

**History bootstrap** (`$PKG/dsh-workspace/lib/index.js:595`): when `global.initialized` is false, all stored headers are grouped by canonical cwd; each group creates a workspace (`path` = canonical cwd, `title = defaultWorkspaceTitle(path)`, `sessionIds` = group headers sorted `createdAt` desc, `createdAt/updatedAt` = newest session's ISO time). Workspace ids are then ordered by that group's newest activity, falling back to record `createdAt`, then prior rank, then id.

## 5. Session lifecycle operations

| Op | Entry point | Effect / what it writes |
|---|---|---|
| create | remote `session.create` → `SessionController.create` → `AgentManager.ensureSession`/`ctx.agents.create` | mints `session-<uuid>` unless `sessionId` given; publishes session; then `workspace.attachSession` (workspace record write). Log materializes on first append/flush. |
| resume | `SessionController.resolveAgent` → `AgentManager.resume` → `ctx.agents.resume({resumeSessionId})` | loads the stored log, opens a **write** handle, acquires the lease; dedupes concurrent resumes in-process. Implicit — no separate "resume" verb; every prompt/rename/fork-source read resumes first. |
| fork | `SessionController.fork({sessionId, atSeq?})` | requires a completed `turn/end` boundary; slices `source.events[0..cut]` with `cut` advanced to the next `turn/start`; `ctx.agents.create` with `{seed, inheritedEventCount: cut, meta:{cwd, parentSession, isSeeded:true, agentPreset}}`; new `session-<uuid>`; attaches to resolved workspace. |
| list | `SessionController.list` → `ApiSessionList.list` | reads attached + persisted sessions **without activating an agent**; sorts `updatedAt` desc (`$PKG/dsh-api-session-controller/lib/types/list.js:122`). `SessionSummary = {sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, projections?}`. |
| rename | `SessionController.rename({sessionId,title})` → `ctx.sessionTitle.rename(session,title)` | appends a `session/title` log event; returns `{title, seq}`. Log-only — never touches the header or the workspace record. Invalid/empty → `session/title-invalid`. |
| delete | **none for sessions** | No session-delete Remote route or service method exists. Fibers disposing a session only drop it from the live store; the log files remain. Workspace *registration* delete exists: `WorkspaceRegistry.delete(id)` removes the record while keeping the directory and every session log. Sessions are hidden via `archiveSession(id)` → `global.archivedSessionIds` (keeps its `sessionIds` slot so unarchive restores position). |

Persistence primitives underneath: `ctx.sessionPersistence.create(header,{inheritedEventCount})` / `open(id, 'read'|'write')` / `stat` / `list` / `flush`, each returning a `SessionHandle` with `read/append/flush/close` (`$PKG/dsh-session-persistence`). `append` is best-effort; `flush` is the durability barrier and materializes an empty session.

## 6. Session tree (parent/child, subagents)

**Yes.** Expressed purely through header fields, never a directory hierarchy:

- `parentSession?: SessionId` — the direct parent: fork seed lineage *and* subagent parentage share this field.
- `origin?: 'subagent'` — coarse classification for a subagent child.
- `delegationDepth?: number` — absent (0) top-level, parent depth + 1 for a child; persisted so a recursion budget survives restart/resume.

`dsh-subagent`'s `childSessionMeta(parent, childDepth, isSeeded)` produces exactly this meta; subagent control APIs address `{ parentSessionId, childSessionId }` pairs and authorize via `authorizeLineage`. Lineage is read back with `ctx.sessionQuery.traceSession(id)` → `{ancestors, descendants}` (`$PKG/dsh-session-query`). Note the caveat in `$PKG/dsh-agent/lib/types/index.d.ts`: the runtime parent relation is not always the durable one — a resumed fork may still be a root. Children live in the **same** cwd bucket as the parent (same cwd unless changed), so the tree is not visible in the directory layout.

## 7. What CLI / UI shows, and ordering

There is **no workspace list in the CLI** (`dsh-cmdline` has no workspace references). The Web GUI is the surface.

- Host baseline: `WorkspaceFeed.baseline()` = `ctx.workspaceRegistry.list().map(workspaceView)` → `{ items: WorkspaceView[], archivedSessionIds }`, where `WorkspaceView = {workspaceId, path, title, sessionIds, createdAt, updatedAt}` (`$PKG/dsh-api-workspace-controller/lib/types/types.d.ts`, `feed.js`).
- The follow stream is one `{type:'baseline'}` frame then increments `upsert` / `remove` / `order` / `archived`.
- **Workspace ordering:** durable `global.workspaceIds` order — newest-activity-first after bootstrap, newly created prepended; explicit reordering via `workspace.insertBefore(id, beforeId?)`.
- **Session ordering inside a workspace:** the record's `sessionIds` manual order (new attached session prepended, reorder via `workspace.insertSessionBefore`). Activity never reorders here.
- **Flat session list** (search/resume surfaces): `SessionSummary[]` sorted by `updatedAt` desc — independent of workspace grouping.
- Client commands available: `create(path)`, `rename(workspaceId,title)`, `delete(workspaceId)`, `insertBefore`, `archiveSession(sessionId)`, `insertSessionBefore` (`WorkspaceController` / `IWorkspaces`).

---

## The minimum viable workspace/session model

**Files**
- `~/.dsh/storages/workspace.json` — one JSON document: `workspaceIds` order + `workspaces` table of `{path,title,sessionIds,createdAt,updatedAt}`. This is the only new file a workspace needs.
- `~/.dsh/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.v3.jsonl.zstd` — append-only JSONL: header line first, then one event per row; zstd frames.
- `…/session.lock` — the write lock (flock on POSIX, named semaphore on Windows); keep the file forever.
- Optional derived cache (`session_projcache`) — skippable at first.

**Naming**
- Bucket: `projectKey(cwd)` = separators `/ \ :` collapsed to `-`, unsafe units escaped `~XXXX`, trimmed of leading `-`, capped at 251, wrapped `--…--`; `_no-cwd` when absent.
- Session dir: `encodeSegment(id)` (safe chars literal, everything else `~XXXX`, `.`/`..` special-cased).
- Artifact: `session.v<SESSION_FORMAT_VERSION>.jsonl.zstd`.

**Association rule**
- A workspace record holds an ordered `sessionIds` account mapping a uuid → canonical `path`.
- Membership = id present in that account **and** the session header's canonical cwd `== path`. No `workspaceId` on the session.
- Create inside a workspace forces `cwd = workspace.path`; a subdirectory is *not* a member and becomes its own workspace. Forks inherit cwd and attach to the source's (or nearest accounted ancestor's) workspace.

**Reimplement first, in order**
1. Storage layout + bucket naming + session id escaping (everything else sits on it).
2. Header line read/write with `version/id/createdAt/cwd/isSeeded/delegationDepth`; title as a later `session/title` event.
3. The JSONL append path with a single write lock and a `flush` durability barrier.
4. `workspace.json` with `workspaceIds` + `sessionIds` arrays, `create` (canonicalize via realpath, idempotent per path), `attachSession` (validate header cwd equality, prepend), `detachSession`, `insertBefore`/`insertSessionBefore`.
5. `list` sorted by activity for the flat session list, and the workspace baseline projection for the UI.
6. The one-time bootstrap grouping stored headers by canonical cwd — this is what makes the model self-healing for pre-existing logs.
7. Fork (completed-turn boundary, `parentSession` + `isSeeded` + `inheritedEventCount`) and rename. Deletion/archival can wait: no session delete exists to copy, only workspace-record delete and session archive.
