# Projects — design (draft for review)

> The question: should chats group into **projects** that share a
> per-project contextual memory? Yes — and the parts already exist.
>
> **Shipped (2026-09-15)**: membership is drag-and-drop — a chat drags
> onto a project row to file, onto the conversations list to unfile,
> with drop-target highlights and a live hint; a per-row picker covers
> touch/keyboard; chats carry a project badge. The conversations list
> carries `project_id` from the server (membership stays server-truth)
> and the move rides the server conversation id.
> This is the design; nothing is implemented yet.

## 1. Prior art — what the best got right and wrong

| System | Model | What we take | What we avoid |
|---|---|---|---|
| **Claude Projects** | knowledge files + custom instructions scoped to a bucket of chats | per-project memory *files* (not a single prompt box); chats join/leave freely | no file-version awareness (stale PDFs silently ground answers) |
| **ChatGPT Projects** | pinned docs + project instructions; every chat in the project sees them | explicit membership: a chat is IN a project, visibly | memory edits don't re-trigger anything — old answers keep their old grounding, undiscoverably |
| **Notion/Linear "projects"** | a project is a *container* with its own views and defaults | defaults ride the project (scope, language), not the client | — |
| **GitHub repos** | shared context = files in the tree; issues/PRs reference them | memory files are addressable objects (ids), not ambient goo | — |

The failure modes to design against: **invisible grounding** (an answer
shaped by memory the user forgot was on), **stale memory** (edited file,
cached answers), and **membership confusion** (chat drifts between
projects).

## 2. The design

A **project** is a container that owns: member-scoped memory files,
default database scope, and a set of conversations. Everything else in
the ask path already exists.

### Data model (D1)

```sql
projects (id, sub, name, default_datasets TEXT, created_at)
  -- memory files move from user-level to project-level:
project_files (id, project_id, name, content, updated_at)
  -- conversations gain an optional home:
ALTER TABLE conversations ADD COLUMN project_id TEXT NULL;
```

Per-user today's `memories` table remains the *personal* tier; project
files are the *shared* tier. The ask accepts both; the note builder
labels them: "the user's personal memory" / "the project's shared
memory".

### The three rules that make it honest

1. **Selection is visible and per-question.** The memory chips the
   answer USED are echoed in the response (`context_applied` gains a
   `memory: [...]` block) and rendered on the message — an answer shaped
   by memory says so, on its face. (The context-chip echo already works
   this way.)
2. **Memory salts the cache.** Already shipped for personal memories
   (#185): the file-id set is part of the cache key. Project memory
   joins the same salt — edit a project file, and every keyed answer
   for that selection misses and regenerates.
3. **Membership is a move, not a copy.** A conversation belongs to at
   most one project (a nullable `project_id`); moving it re-scopes its
   NEXT answer, never rewrites history. Old messages keep their
   recorded grounding (the `context_applied` column already persists
   per answer).

### UX

- Sidebar: a **Projects** section above conversations — project rows
  with their conversation counts; selecting one filters the list and
  sets the composer's default scope/memory (visible as chips under the
  composer, toggleable like datasets/memory rows — one grammar users
  already know).
- Project settings drawer: name, default databases, shared memory files
  (the same editor modal as #171), and the member list when sharing
  arrives.
- A conversation outside any project behaves exactly as today.

### What projects unlock next (the payoff)

- **Team tier**: `project_members` — shared memory becomes the lab's
  institutional memory ("our instruments, our classes"), the natural
  members'-side feature.
- **Cross-chat continuity**: a project summary (the existing history
  summarizer, run over the project's conversations) grounds *new*
  chats in what the project already established — continuity without
  leaking between projects.
- **Reproducible scoped sessions**: default scope + shared memory +
  the corpus generation stamp = an answer set a reviewer can re-run.

## 3. Effort

Small: two D1 tables + one column, CRUD that mirrors #171's handlers,
an echo field, and sidebar/composer UI in the shipped grammar. The
expensive-looking parts (injection, salting, toggles, echo) already
exist from the dataset-scope and memory work.
