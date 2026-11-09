# Second Brain — local-first knowledge with provenance

## 1. Position

The Jarvis "galaxy" (`reference_research.md`) links notes when one mentions another's title, and builds the graph as a static JS file. That is a visualization of word overlap. Pandesh's Second Brain must be a **retrieval and accountability system first**; the graph is one optional lens.

**Storage decision: extend the existing Core SQLite memory model (migration 13, M39). No second database, no external graph engine.** Derived indexes (full-text, optional embeddings) are *rebuildable caches*, not authorities.

## 2. What already exists (and is kept)

| Need | Existing |
|---|---|
| Facts with scope, sensitivity, validity window, forget tombstone, revision, idempotent write identity, consent approval | `memory_facts` |
| Provenance (source conversation/message/attempt/invocation + content sha256) | `memory_evidence` |
| Entities and typed relationships, each tied to a memory and its evidence | `knowledge_entities`, `knowledge_relationships` |
| Conflicts with resolution policy and approval | `memory_contradictions`, `memory_resolve_contradiction` |
| Forget, impact analysis, export | `memory_forget`, `memory_impact`, `memory_export` |
| Notes, artifacts, conversations, commitments, projects, tasks, wishes, obligations | `everyday_notes`, `artifacts`, `conversations`, `commitments`, `projects`, `task_outcomes`, `wish_*`, `household_obligations` |
| Document access control | `document_read_grants` |

## 3. Additions

### 3.1 Source registry (additive)

```sql
CREATE TABLE knowledge_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'markdown_vault' | 'folder' | 'note' | 'conversation' | 'artifact' | 'email_thread' | ...
  locator TEXT NOT NULL,       -- path / record id
  scopeType TEXT NOT NULL, scopeId TEXT NOT NULL,
  sensitivity TEXT NOT NULL,   -- 'normal' | 'private' | 'secret' (secret = never indexed for retrieval)
  grantId TEXT,                -- document_read_grants row for folders
  contentSha256 TEXT,          -- change detection
  lastIndexedAt TEXT, state TEXT NOT NULL,
  UNIQUE(kind, locator)
);
CREATE TABLE knowledge_chunks (   -- derived; rebuildable from sources
  id TEXT PRIMARY KEY, sourceId TEXT NOT NULL REFERENCES knowledge_sources(id),
  ordinal INTEGER NOT NULL, heading TEXT, text TEXT NOT NULL,
  charStart INTEGER, charEnd INTEGER, contentSha256 TEXT NOT NULL
);
CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(text, heading, content='knowledge_chunks', content_rowid='rowid');
```

- `knowledge_sources` points at the user's own files and Pandesh records. Content stays where it is; chunks are a cache that can be deleted and rebuilt.
- Memory facts get an FTS5 shadow index too (`memory_facts_fts`), replacing the `LIKE` scan for recall at scale.
- `knowledge_entities` gains entity types `note`, `document`, `project`, `goal`, `decision`, `task`, `commitment`, `person`, `organization`, `conversation`, `artifact` (string values; no schema change).

### 3.2 Edges must earn their place

An edge is created only from one of these, and always carries `evidenceId` (existing column) or a source record id:

| Edge type | Origin | Confidence |
|---|---|---|
| `links_to` | Explicit `[[wikilink]]` or markdown link in a source | 1.0 (structural) |
| `part_of` / `belongs_to_project` | Record foreign key (task→project, artifact→conversation) | 1.0 |
| `decided_in`, `committed_in`, `produced_by` | Pandesh record (commitment from conversation, artifact from attempt) | 1.0 |
| `mentions_person/org` | Extracted entity **with user permission for that entity type** | model-scored; shown as "suggested" until confirmed |
| `about` (topic) | Extraction | suggested |
| `contradicts` / `supersedes` | `memory_contradictions` | from resolution |

Title co-mention and embedding similarity **never create edges**; similarity is a *query-time* "related" list, visually distinct and labelled "similar, not linked".

### 3.3 Optional semantic retrieval (gated)

`docs/m39` deliberately excluded embeddings. Re-open only with evidence:

- **Gate**: build a 100-question local evaluation set over the user's real sources; ship embeddings only if hybrid (FTS5 + embeddings) beats FTS5 alone by ≥15 points recall@5 with no privacy regression.
- If shipped: `knowledge_embeddings(chunkId, model, dim, vector BLOB)` — derived, deletable; computed by a local Ollama embedding model under the `gpu.llm.background` lease; brute-force cosine in-process (fine to ~100K chunks), `sqlite-vec` only if measured necessary.
- `secret` sources are never embedded or sent to any model.

## 4. Retrieval pipeline

1. Scope filter (agent memory scopes + sensitivity + user-selected spaces).
2. Candidate generation: FTS5 over chunks + memory facts (+ embeddings if enabled); structural neighbours of pinned entities.
3. **Vault check** (adapted from Jev "vault" idea, run locally via `systemOne` or rules): does any candidate *directly* contain the answer? → `found / absent / unsure`.
4. Answer prompt receives only the kept chunks with ids; `absent` → the model is told the notes contain nothing and must say so.
5. Reply carries `citations` (existing `/v1/messages/:id/citations`) → UI highlights exactly the cited nodes (one → focus; ≥4 → highlight cluster, no fly-to).

## 5. Ingestion and incremental updates

- Sources registered explicitly by the user (folder picker → `document_read_grants`). No crawling of the disk.
- Watcher (Windows `fs.watch` + periodic sha check) enqueues changed sources as low-priority background tasks; re-chunk only changed sources; deletes cascade to chunks/edges; facts derived from a deleted source are marked `source_missing`, not deleted silently.
- Conversation knowledge: extraction runs only on explicit "remember" or on completed tasks' structured results (decisions, commitments, artifacts) — not on every chat message.

## 6. Correction, deletion, conflicts, sensitivity

| Action | Behaviour |
|---|---|
| Edit a fact | New revision row; old one `superseded` with link; provenance keeps both |
| Delete / forget | Existing tombstone scrub; UI shows `memory_impact` first (what depends on it) |
| Conflict | Both facts shown side by side with sources and dates; user picks, or "both true at different times" (validity windows) |
| Sensitivity | `secret` never retrievable by any agent; `private` only by `personal` scope agents; customer data lives under `business:<id>` scope and never appears in personal views unless the user opens that space |
| Confidence | Structural = solid edge; suggested = dashed + "confirm/reject" |

## 7. Views

| View | Purpose | Default? |
|---|---|---|
| **Search** (one box, results grouped by type, each with source + date + scope) | Primary | ✔ |
| **Item inspector** (fact/note/doc: content, sources, related, history, conflicts, edit/forget) | Detail | on click |
| **Timeline** (decisions, commitments, notes by date; filter by project/person) | "What happened when" | tab |
| **Graph 2D** (neighbourhood of the selected item, ≤ 150 nodes, expand on demand, group by type/project) | Navigation | tab |
| **Graph 3D "galaxy"** | Overview/delight; same data, lazy-loaded library | opt-in toggle |

Performance rules: never render the whole graph; start from a query or an item and expand ≤ 2 hops; aggregate beyond 150 nodes into cluster nodes ("47 notes in Wish to Reality"); layout runs in a Web Worker; 3D library loaded only when the toggle is used. Candidate libraries (MIT, mature): `graphology` + `sigma.js` (2D, WebGL), `3d-force-graph` (3D, what the Jarvis packs use). Bundled locally, pinned — no CDN at runtime.

## 8. Interfaces (Core REST, additive)

```
GET  /v1/knowledge/search?q=&scopes=&types=&limit=      -> {items:[{id,type,title,snippet,sourceId,scope,date,score}]}
GET  /v1/knowledge/items/:id                            -> item + evidence + relationships + contradictions + revisions
GET  /v1/knowledge/graph?focus=:id&hops=1|2&limit=150   -> {nodes, edges(with evidenceId, confidence, origin), clusters}
GET  /v1/knowledge/timeline?from=&to=&types=&project=
POST /v1/knowledge/sources        (governed: creates read grant; approval)
POST /v1/knowledge/items/:id/correct | /forget | /confirm-edge | /reject-edge   (governed)
```

Mutations go through governed capability dispatch (approval + tool_invocation evidence) — the same path `memory_*` tools use.
