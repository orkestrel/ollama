# Workspace

> The virtual file workspace for the `@orkestrel` line: a path-keyed map of immutable files with
> an editing surface over it, a registry that holds those maps by id under one active selection,
> and a snapshot store seam that persists them.

Every edit — `write`, `prepend`, `append`, `replace`, `move` — mints a new `FileInterface` value
and puts it back under its path, so a file is a value a caller can hold and compare, never a handle
that changes underneath it. `Workspace` is the class behind the editing surface and
`WorkspaceManager` the class behind the registry, which gains lenient `open` and `save` whenever a
store is supplied. `WorkspaceStoreInterface` is the durability seam: `get`, `set`, and `delete` over
a `WorkspaceSnapshot`. Everything else in this module is the immutable data those nouns exchange,
plus the pure functions that derive it. Source: [`src/core`](../src/core). Published through
`@orkestrel/workspace`.

A workspace is not a filesystem. There is no disk, no `node:fs`, no watcher, no synchronization
lifecycle, and no dirty-state tracking. A path is a key, not a location: `src/main.ts` and
`notes.md` sit in the same flat map with no directories between them, and nothing outside the
process can change what the map holds. Durability is a separate seam — `snapshot()` produces a
plain JSON-serializable value and a store persists it. A store that one day wrote those snapshots
to disk would be one more implementation of that interface, not a change of identity here.

Anyone can drive it. An agent loop, a tool handler, and plain application code are all callers.

## Surface

### Contracts

The data shapes, from [`types.ts`](../src/core/types.ts). Every property is readonly, and an
absent optional field is absent. `WorkspaceInterface`, `WorkspaceManagerInterface`, and
`WorkspaceStoreInterface` are the behavioral contracts: each one's call-signature members are
documented under [`## Methods`](#methods), and its readonly data members stay here — `id`,
`emitter`, and `count` on `WorkspaceInterface`, `count` and `active` on
`WorkspaceManagerInterface`, and none on `WorkspaceStoreInterface`.

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| Name                        | Kind      | Shape                                                                                                                                 | Summary                                                                                                                                                                         |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BinaryMIME`                | type      | `'image/png' \| 'image/jpeg' \| 'image/gif' \| 'image/webp'`                                                                          | Names the MIME labels a binary `FileContent` arm supports.                                                                                                                      |
| `FileContent`               | type      | `TextContent \| BinaryContent`                                                                                                        | Holds a file's immutable content: either text with a language tag or a base64 string with a MIME. The union carries no discriminant field, so a caller narrows it with a guard. |
| `TextContent`               | interface | `{ text, language }`                                                                                                                  | Holds the text arm of a file's immutable content: a body and its language tag.                                                                                                  |
| `BinaryContent`             | interface | `{ base64, mime }`                                                                                                                    | Holds the binary arm of a file's immutable content: a base64 payload and its MIME.                                                                                              |
| `FileState`                 | type      | `'created' \| 'modified'`                                                                                                             | Names the edit state of an immutable file value: `created` for the first write to a path and `modified` for every later edit of that path.                                      |
| `FileInput`                 | interface | `{ path, content, state? }`                                                                                                           | Carries the caller-supplied values used to create an immutable file. The byte size and the line count are derived rather than supplied.                                         |
| `FileInterface`             | interface | `{ path, content, state, size, lines }`                                                                                               | Represents an immutable path-addressed file with derived byte and line counts.                                                                                                  |
| `Position`                  | interface | `{ line, column }`                                                                                                                    | Locates a 1-based caret inside text.                                                                                                                                            |
| `Range`                     | interface | `{ start, end }`                                                                                                                      | Represents a half-open text span whose start is inclusive and end is exclusive.                                                                                                 |
| `ReadResult`                | interface | `{ content, range }`                                                                                                                  | Carries the content and clamped span returned by a ranged read.                                                                                                                 |
| `SearchOptions`             | interface | `{ regex?, sensitive?, limit? }`                                                                                                      | Configures search and replacement behavior.                                                                                                                                     |
| `SearchMatch`               | interface | `{ path, line, column, length, content }`                                                                                             | Reports one 1-based search hit and the full line that contains it.                                                                                                              |
| `ReplaceResult`             | interface | `{ occurrences, files }`                                                                                                              | Carries the tallies a replacement produced: the occurrences replaced and the files changed.                                                                                     |
| `WorkspaceEventMap`         | type      | `{ write, remove, move, clear }`                                                                                                      | Names the events emitted after workspace mutations complete.                                                                                                                    |
| `WorkspaceOptions`          | interface | `{ id?, on?, error?, seed? }`                                                                                                         | Configures a workspace at construction.                                                                                                                                         |
| `WorkspaceSnapshot`         | interface | `{ id, files }`                                                                                                                       | Represents a workspace's stored state in JSON-serializable form.                                                                                                                |
| `WorkspaceStoreInterface`   | interface | `{} plus get, set, delete`                                                                                                            | Persists workspace snapshots through an asynchronous point-access contract.                                                                                                     |
| `WorkspaceSnapshotRow`      | interface | `{ id, snapshot }`                                                                                                                    | Represents the database row used to persist one opaque workspace snapshot.                                                                                                      |
| `WorkspaceErrorCode`        | type      | `'MISSING' \| 'MODALITY' \| 'PATTERN' \| 'RANGE'`                                                                                     | Names the machine-readable failure codes raised by the workspace edit surface.                                                                                                  |
| `WorkspaceInterface`        | interface | `{ id, emitter, count } plus file, files, read, has, search, replace, write, prepend, append, move, remove, clear, snapshot, destroy` | Represents a mutable path-keyed editing surface over immutable file values.                                                                                                     |
| `WorkspaceManagerOptions`   | interface | `{ on?, error?, store? }`                                                                                                             | Configures a workspace registry at construction.                                                                                                                                |
| `WorkspaceManagerInterface` | interface | `{ count, active } plus workspace, workspaces, add, switch, open, save, remove, clear`                                                | Represents an insertion-ordered workspace registry with an active selection and optional durability.                                                                            |

### Constants

A `Shape` cell holds the constant's declared type.

| Name                  | Kind  | Shape                              | Summary                                                                                                                                                 |
| --------------------- | ----- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXTENSION_LANGUAGES` | const | `Readonly<Record<string, string>>` | Maps file extensions to language tags for text content. The table is frozen, and an extension it does not list falls back to `text` in `inferLanguage`. |

### Errors

From [`errors.ts`](../src/core/errors.ts). A refusal is an exception; everything else this
package can answer, it answers with a value.

| Name               | Kind     | Signature                                     | Summary                                                                                                                                           |
| ------------------ | -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceError`   | class    | `new (code, message, context?)`               | Reports an invalid workspace edit or search operation, carrying a `WorkspaceErrorCode` and, when the operation had one, the context it ran under. |
| `isWorkspaceError` | function | `(value: unknown) => value is WorkspaceError` | Narrows a caught value to a `WorkspaceError`.                                                                                                     |

### Helpers

The pure leaves, from [`helpers.ts`](../src/core/helpers.ts). Each one is exported and tested
on its own, and the classes compose them rather than hiding them.

| Name                 | Kind     | Signature                                                     | Summary                                                                                         |
| -------------------- | -------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `inferLanguage`      | function | `(path: string) => string`                                    | Infers a language tag from the final file extension.                                            |
| `isText`             | function | `(content: FileContent) => content is TextContent`            | Determines whether content is the text arm.                                                     |
| `isBinary`           | function | `(content: FileContent) => content is BinaryContent`          | Determines whether content is the binary arm.                                                   |
| `computeSize`        | function | `(content: FileContent) => number`                            | Computes the byte size of file content.                                                         |
| `countLines`         | function | `(content: FileContent) => number`                            | Counts the lines in file content.                                                               |
| `computeDecodedSize` | function | `(base64: string) => number`                                  | Computes the decoded byte length of a base64 string, arithmetically rather than by decoding it. |
| `isValidRange`       | function | `(range: Range) => boolean`                                   | Determines whether a 1-based range is structurally valid.                                       |
| `clampPosition`      | function | `(text: string, position: Position) => Position`              | Clamps a position to text bounds.                                                               |
| `clampRange`         | function | `(text: string, range: Range) => Range`                       | Clamps both positions in a range to text bounds.                                                |
| `offsetAt`           | function | `(text: string, position: Position) => number`                | Converts a 1-based position to a zero-based string offset.                                      |
| `sliceRange`         | function | `(text: string, range: Range) => string`                      | Slices a clamped half-open text range.                                                          |
| `spliceRange`        | function | `(text: string, range: Range, replacement: string) => string` | Replaces a clamped half-open text range.                                                        |
| `rangeOf`            | function | `(fromLine, fromColumn, toLine, toColumn) => Range`           | Assembles a nested range from four 1-based coordinates.                                         |
| `escapeRegExp`       | function | `(value: string) => string`                                   | Escapes regular-expression metacharacters for literal matching.                                 |

### Validators

The total guards, from [`validators.ts`](../src/core/validators.ts). Each narrows an `unknown`
value arriving from outside the process without throwing on a hostile property access.

In a guard table a `Shape` cell holds the type the guard narrows to.

| Name                  | Kind     | Shape               | Summary                                               |
| --------------------- | -------- | ------------------- | ----------------------------------------------------- |
| `isFile`              | function | `FileInterface`     | Narrows an unknown value to an immutable file record. |
| `isWorkspaceSnapshot` | function | `WorkspaceSnapshot` | Narrows an unknown value to a workspace snapshot.     |

### Factories

From [`factories.ts`](../src/core/factories.ts) — the constructor-free way to reach every
class. Each returns the interface, not the class.

| Name                           | Kind     | Signature                                                          | Summary                                                                                                     |
| ------------------------------ | -------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `createFile`                   | function | `(input: FileInput) => FileInterface`                              | Creates an immutable file with derived size and line counts.                                                |
| `createTextContent`            | function | `(text: string, language: string) => TextContent`                  | Creates the text arm of `FileContent`, returned as `TextContent` rather than as the whole union.            |
| `createBinaryContent`          | function | `(base64: string, mime: BinaryMIME) => BinaryContent`              | Creates the binary arm of `FileContent`, returned as `BinaryContent` rather than as the whole union.        |
| `createWorkspace`              | function | `(options?: WorkspaceOptions) => WorkspaceInterface`               | Creates a workspace with the same identity, emitter, and seed options the constructor takes.                |
| `createMemoryWorkspaceStore`   | function | `() => WorkspaceStoreInterface`                                    | Creates an in-memory workspace snapshot store.                                                              |
| `createDatabaseWorkspaceStore` | function | `(driver?: DriverInterface) => WorkspaceStoreInterface`            | Creates a database-backed workspace snapshot store, over an in-memory driver when the caller supplies none. |
| `createWorkspaceManager`       | function | `(options?: WorkspaceManagerOptions) => WorkspaceManagerInterface` | Creates an empty workspace registry.                                                                        |

### Classes

The implementing classes, from [`Workspace.ts`](../src/core/workspaces/Workspace.ts),
[`WorkspaceManager.ts`](../src/core/workspaces/WorkspaceManager.ts),
[`MemoryWorkspaceStore.ts`](../src/core/workspaces/stores/MemoryWorkspaceStore.ts), and
[`DatabaseWorkspaceStore.ts`](../src/core/workspaces/stores/DatabaseWorkspaceStore.ts) — each
documented in full under its own heading following this table.

| Name                     | Kind  | Summary                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Workspace`              | class | Implements `WorkspaceInterface` over one insertion-ordered path map the instance owns, projecting fresh arrays on every read. Whole-file edits create text files, ranged edits operate only on existing text files, and binary files remain available through construction-time hydration. Mutations emit after the file map has changed.                                          |
| `WorkspaceManager`       | class | Implements `WorkspaceManagerInterface` over an insertion-ordered id map and one active id the instance owns, resolving `active` through that map on every read and holding no emitter. A supplied store adds lenient snapshot `open` and `save` operations. Event defaults flow into workspaces created through the registry, while observability remains owned by each workspace. |
| `MemoryWorkspaceStore`   | class | Holds workspace snapshots in the current process.                                                                                                                                                                                                                                                                                                                                  |
| `DatabaseWorkspaceStore` | class | Persists workspace snapshots in a database table. Snapshots occupy one opaque column and are narrowed when read back from the storage boundary.                                                                                                                                                                                                                                    |

### `Workspace`

The implementing class of `WorkspaceInterface`, from
[`Workspace.ts`](../src/core/workspaces/Workspace.ts). One insertion-ordered path map is its
whole state, and `files()` and `snapshot()` project fresh arrays out of it rather than exposing a
view. Its constructor takes one optional `WorkspaceOptions` value. The `seed` iterable seats
pre-built files by each value's `path`, silently and with the last duplicate path winning. That
seed is the only way a binary file enters a workspace, because the edit surface itself mints text
and nothing else. See [`## Methods`](#methods) for its public call surface.

### `WorkspaceManager`

The implementing class of `WorkspaceManagerInterface`, from
[`WorkspaceManager.ts`](../src/core/workspaces/WorkspaceManager.ts). It holds an
insertion-ordered id map plus one active id, and resolves `active` through that map on every read
so the pointer can never go stale. It owns no emitter: observation belongs to each workspace, and
the manager only forwards listener defaults into the workspaces it creates. See
[`## Methods`](#methods) for its public call surface.

### `MemoryWorkspaceStore`

The process-local implementation of `WorkspaceStoreInterface`, from
[`MemoryWorkspaceStore.ts`](../src/core/workspaces/stores/MemoryWorkspaceStore.ts). A plain map
behind the async contract: snapshots live as long as the process does. See
[`## Methods`](#methods) for the contract it satisfies.

### `DatabaseWorkspaceStore`

The durable implementation of `WorkspaceStoreInterface`, from
[`DatabaseWorkspaceStore.ts`](../src/core/workspaces/stores/DatabaseWorkspaceStore.ts). It
writes each snapshot as one opaque column of a `WorkspaceSnapshotRow` through `@orkestrel/database`
and narrows the column back with `isWorkspaceSnapshot` on the way out, so a row holding anything
else reads as absent rather than as a broken workspace. How durable it actually is belongs to the
driver. See [`## Methods`](#methods) for the contract it satisfies.

## Methods

The public call-signature members of each behavioral interface, one table per interface. A
`Summary` cell carries its member's first overload; where a member is overloaded — `read`, `has`,
`write`, `prepend`, `append`, `move`, and `remove` on `WorkspaceInterface`, and `remove` on
`WorkspaceManagerInterface` — the `Returns` cell spans the whole set and the sections that follow
work each form.

#### `WorkspaceInterface`

| Method     | Returns                         | Summary                                                                                  |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `file`     | `FileInterface \| undefined`    | Finds the file value stored at one path.                                                 |
| `files`    | `readonly FileInterface[]`      | Lists every file in insertion order.                                                     |
| `read`     | text, `ReadResult`, or a record | Reads a text file whole.                                                                 |
| `has`      | `boolean`                       | Checks whether one path is present.                                                      |
| `search`   | `readonly SearchMatch[]`        | Scans text files for a query, skipping binary content.                                   |
| `replace`  | `ReplaceResult`                 | Rewrites every match across the text files, skipping binary content.                     |
| `write`    | `void`                          | Writes whole text to a path, creating it when absent and retyping a binary path as text. |
| `prepend`  | `void`                          | Puts text before a path's existing content, treating an absent path as empty text.       |
| `append`   | `void`                          | Puts text after a path's existing content, treating an absent path as empty text.        |
| `move`     | `boolean`                       | Re-keys one file to a new path, keeping the source's insertion slot.                     |
| `remove`   | `boolean`                       | Drops one path, leaving an absent path untouched.                                        |
| `clear`    | `void`                          | Empties the workspace and emits one `clear`, never a burst of per-path removals.         |
| `snapshot` | `WorkspaceSnapshot`             | Projects the identity and a flat file list into a serializable value.                    |
| `destroy`  | `void`                          | Releases the owned emitter, leaving the editing surface functional and unobserved.       |

#### `WorkspaceManagerInterface`

| Method       | Returns                                    | Summary                                                                                      |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `workspace`  | `WorkspaceInterface \| undefined`          | Finds one registered workspace by id.                                                        |
| `workspaces` | `readonly WorkspaceInterface[]`            | Lists registered workspaces in insertion order.                                              |
| `add`        | `WorkspaceInterface`                       | Creates and registers a workspace, activating it when no selection is active yet.            |
| `switch`     | `WorkspaceInterface \| undefined`          | Re-points the active selection at a registered workspace.                                    |
| `open`       | `Promise<WorkspaceInterface \| undefined>` | Activates a registered workspace, or hydrates one from a stored snapshot on a registry miss. |
| `save`       | `Promise<boolean>`                         | Persists a registered workspace's snapshot under its own id.                                 |
| `remove`     | `boolean`                                  | Drops one registered workspace and destroys it.                                              |
| `clear`      | `void`                                     | Empties the registry, destroying each workspace and clearing the selection.                  |

#### `WorkspaceStoreInterface`

| Method   | Returns                                   | Summary                                                  |
| -------- | ----------------------------------------- | -------------------------------------------------------- |
| `get`    | `Promise<WorkspaceSnapshot \| undefined>` | Resolves a snapshot by workspace id.                     |
| `set`    | `Promise<void>`                           | Inserts or replaces a snapshot under its own identifier. |
| `delete` | `Promise<void>`                           | Deletes a snapshot when present.                         |

## Files and content

A file is a frozen value: a `path`, its `content`, a `state`, and the derived `size` and `lines`.
Nothing mutates it. An edit replaces the value stored at a path, so a reference taken before an
edit still describes exactly what was there.

`FileContent` is a tagless union — text carries `{ text, language }`, binary carries
`{ base64, mime }` — and callers narrow it with a guard instead of reading a discriminant that could
disagree with the payload:

```ts
import {
	computeSize,
	countLines,
	createBinaryContent,
	createFile,
	createTextContent,
	inferLanguage,
	isBinary,
	isText,
} from '@orkestrel/workspace'

const note = createFile({
	path: 'notes.md',
	content: createTextContent('# Title\nBody', inferLanguage('notes.md')), // 'markdown'
})

note.size // 12 — UTF-8 bytes, through computeSize
note.lines // 2 — through countLines
note.state // 'created'
isText(note.content) // true

const icon = createFile({ path: 'icon.png', content: createBinaryContent('AAAA', 'image/png') })
isBinary(icon.content) // true
icon.size // 3 — decoded base64 bytes, through computeDecodedSize
```

Language is inferred once, from the final path extension through `EXTENSION_LANGUAGES`, and an
unlisted extension resolves to `text`. Re-writing an existing text file keeps the language it
already had, so a caller that set one deliberately does not lose it to a rename-shaped write.

`FileState` names the first write to a path `created` and every later edit of that path
`modified`. Hydration preserves whichever stored state the file already carries verbatim; it does
not synthesize provenance. There is no dirty tracking, and `isFile` is
the total guard for a value arriving from outside this process.

## Editing

Editing returns its documented value when the request has meaning and throws only when a text
operation cannot be applied. Missing lookups and no-op moves or removals answer with values rather
than exceptions; `MISSING`, `MODALITY`, and `RANGE` identify the edit refusals that follow.

A write takes whole text, a clamped range, or a record batch. Prepend and append are the opposite
ends of the same map.

```ts
import { createWorkspace, rangeOf } from '@orkestrel/workspace'

const workspace = createWorkspace({ id: 'project' })

workspace.write('src/main.ts', 'const answer = 41') // created
workspace.write('src/main.ts', '42', rangeOf(1, 16, 1, 18)) // modified — splices '41' → '42'
workspace.write({ 'README.md': '# Project', 'src/util.ts': 'export {}' }) // one file per entry

workspace.prepend('src/main.ts', '// generated\n')
workspace.append('src/main.ts', '\n')
workspace.prepend({ 'README.md': '<!-- header -->\n' })
```

A whole-file write always succeeds: it creates the path or replaces what is there, and writing a
string over a binary path deliberately retypes it as text. Prepend and append treat an absent path
as empty text and create it. Aimed at binary content, though, they throw `MODALITY` — there is no
sensible text to concatenate onto base64 data.

A ranged write is stricter, because it addresses text that must already exist. It refuses an
absent path with `Cannot splice a range of a missing file: <path>` under `MISSING`, and a binary
path with `Cannot splice a range of a binary file: <path>` under `MODALITY`. A structurally
impossible range — inverted, or with a coordinate below one — throws `RANGE`. A range that is merely too
large is not an error: both endpoints clamp to the text's bounds, so `rangeOf(1, 2, 9, 9)` over
`'abc'` addresses everything from the second column onward. The pure functions behind that
behavior are exported and usable on their own: `isValidRange`, `clampPosition`, `clampRange`,
`offsetAt`, `sliceRange`, and `spliceRange`.

Ranges are half-open and 1-based. `rangeOf(1, 1, 1, 6)` covers the first five columns of line one,
which is the convention every editor position in this package follows.

## Reading and searching

Reads are shaped by what the caller asked for, and binary content is quietly absent from the shapes
that promise text:

```ts
import { createWorkspace, escapeRegExp, rangeOf } from '@orkestrel/workspace'

const workspace = createWorkspace()
workspace.write({ 'a.ts': 'const x = 1\nconst y = 2', 'b.ts': 'const z = 3' })

workspace.file('a.ts') // the frozen FileInterface value, or undefined
workspace.files() // every file, in insertion order
workspace.count // 2

workspace.read('a.ts') // 'const x = 1\nconst y = 2'
workspace.read('a.ts', rangeOf(1, 1, 1, 6)) // { content: 'const', range: … }
workspace.read(['a.ts', 'missing.ts']) // { 'a.ts': … } — absent paths are omitted
workspace.has('a.ts') // true
workspace.has(['a.ts', 'b.ts']) // true — every path present
workspace.has(['missing.ts', 'b.ts']) // false — a batch answers true only when all are present

workspace.search('const') // three matches, a.ts before b.ts, line order within each
workspace.search('[a-z]\\d', { regex: true }) // pattern source instead of literal text
workspace.search('CONST', { sensitive: false, limit: 2 })
workspace.replace('const', 'let') // { occurrences: 3, files: 2 }
escapeRegExp('a.b') // 'a\\.b' — what a literal search does for you
```

A plain read of a binary path returns `undefined`, exactly as an absent path does; a batch read
omits both. A ranged read of binary content is the one that throws `MODALITY`, because the caller
named coordinates that cannot exist. Search and replace skip binary content entirely, so base64
that happens to spell a query is never a hit.

A query is literal by default — `escapeRegExp` neutralizes its metacharacters — and `regex: true`
passes it through as pattern source instead. `limit` caps hits for `search` and replacements for
`replace`, counted across files in insertion order. A pattern that will not compile throws
`PATTERN` rather than silently matching nothing. A zero-width pattern such as `a*` terminates: the
scan advances past an empty match instead of re-matching the same column.

`replace` returns `{ occurrences, files }`: how many occurrences changed and how many files they
were spread across. It rewrites each changed file once, so a file with four replacements emits one
`write` event, and a file with no match is never touched.

## Moving, removing, and snapshots

```ts
import { createWorkspace } from '@orkestrel/workspace'

const workspace = createWorkspace({ id: 'project' })
workspace.write({ 'old.ts': 'body', 'draft.md': 'notes' })

workspace.move('old.ts', 'src/new.ts') // true
workspace.move({ 'draft.md': 'docs/draft.md' }) // true — a mapping batch
workspace.move('ghost.ts', 'x.ts') // false — nothing to re-key

workspace.snapshot() // { id: 'project', files: [ … ] } — plain, serializable

workspace.remove('src/new.ts') // true
workspace.remove(['docs/draft.md', 'ghost.ts']) // false — 'ghost.ts' was never there
workspace.clear() // empties the workspace and emits clear
```

A move re-keys a file to a new path and marks the result `modified`; the moved value carries the
new path, because a file's `path` is part of its value. Rebuilding the map keeps the moved value in
the source's insertion slot. An occupied target is removed while the source content remains in
that source slot, so the file count drops by one. A missing source is not a failure either:
`move` reports `false` and changes nothing. Moving a path to itself is the same exact no-op: it
returns `false`, preserves the value and order, and emits nothing.

`remove` mirrors that leniency, answering with a value rather than throwing over an absent path.
Each batch form — `has(paths)`, `move(mapping)`, and `remove(paths)` — applies to every entry it
can and reports `true` only when all of them succeeded, so one absent path turns the batch's answer
`false` while the present paths still move or drop. An empty batch has no entry that can fail, so
`has([])`, `move({})`, `remove([])`, and the registry's `remove([])` each report `true` and change
nothing. `clear()` owns emptying the workspace and sends one canonical `clear` event, never a burst
of per-path removals.

`snapshot()` is the boundary between the live surface and everything durable: an id and a flat file
list, holding the same frozen values the map holds. Feed those files back through a workspace's
construction seed and the rebuilt workspace snapshots equal.

## Events

Each workspace owns an `EmitterInterface` from `@orkestrel/emitter`, reachable as `emitter` and
configurable at construction through `on` and `error`. Every event fires after the map has already
changed, so a listener always observes the settled state.

| Event    | Payload            | Timing                                                         |
| -------- | ------------------ | -------------------------------------------------------------- |
| `write`  | the resulting file | after a write, splice, prepend, append, or changed replacement |
| `remove` | the removed path   | after a path that was present is dropped                       |
| `move`   | `from, to`         | after the map is re-keyed                                      |
| `clear`  | none               | after `clear()`                                                |

A listener that throws is isolated by the emitter and routed to the workspace's `error` handler:
the edit still lands and the call that triggered it returns normally. Nothing is emitted for a
no-op — removing an absent path, or replacing a query that matched nothing — and construction-time
seeding is silent, because seeding is hydration rather than editing.

## Lifecycle

`clear()` resets file state while leaving observation live. `destroy()` is the teardown boundary:
it releases the owned emitter last, is idempotent, and leaves file operations functional. Writes
after destruction still land, but the destroyed emitter delivers no further events.

```ts
import { createWorkspace } from '@orkestrel/workspace'

const workspace = createWorkspace()
workspace.destroy()
workspace.write('silent.txt', 'still stored') // succeeds without delivering an event
```

## The registry

A `WorkspaceManager` is a working set with one selection, not a global. Build one per caller, add
the workspaces that caller needs to reach, and let `active` say which one is current:

```ts
import { createWorkspaceManager } from '@orkestrel/workspace'

const edited: string[] = []
const manager = createWorkspaceManager({ on: { write: (file) => edited.push(file.path) } })

const scratch = manager.add({ id: 'scratch' }) // the first add becomes active
const review = manager.add({ id: 'review' }) // a later add does not steal the selection

manager.count // 2
manager.active === scratch // true
manager.workspace('review') === review // the exact registered instance, or undefined
manager.workspaces() // a fresh readonly array, in insertion order

manager.switch('review') // returns the workspace and re-points active
manager.switch('ghost') // undefined — active is left alone

manager.remove('review') // true — and active clears, because the active one went
manager.remove(['scratch', 'ghost']) // false — 'ghost' was never registered, but 'scratch' still goes
manager.clear() // empty registry, no selection
```

Only the first `add` auto-activates; after that the selection moves solely by `switch`, `open`, or
the removal of whatever it pointed at. Adding an id that already exists replaces the registered
workspace, and because `active` is resolved through the map on every read, a replaced active id
resolves to the replacement rather than to a detached instance.

Listener defaults given to the manager flow into every workspace it creates, and per-add `on` or
`error` overrides them outright rather than merging. The same `WorkspaceOptions` shape reaches
`add`; its `seed` seats pre-built files into the new workspace silently, which is the hydration
seam `open` uses. `remove` and `clear` destroy each workspace as it leaves the registry. Registered
workspaces share nothing else: each owns its own files, its own emitter, and its own id.

## Durability

A manager without a store is complete and entirely in memory. Supplying one adds `save` and
`open`, and each is lenient:

```ts
import {
	createDatabaseWorkspaceStore,
	createMemoryWorkspaceStore,
	createWorkspaceManager,
	isWorkspaceSnapshot,
} from '@orkestrel/workspace'

const store = createMemoryWorkspaceStore()
const manager = createWorkspaceManager({ store })

const project = manager.add({ id: 'project' })
project.write('src/main.ts', 'const answer = 42')

await manager.save('project') // true — the snapshot is now in the store
await manager.save('ghost') // false — unknown id, nothing written

const reader = createWorkspaceManager({ store })
const opened = await reader.open('project') // hydrated from the snapshot, registered, activated
opened?.read('src/main.ts') // 'const answer = 42'
await reader.open('never-saved') // undefined — a miss stays a miss

const durable = createDatabaseWorkspaceStore()
await durable.set(project.snapshot())
await durable.get('project') // the snapshot, or undefined
await durable.delete('project')
isWorkspaceSnapshot(await durable.get('project')) // false — it is gone
```

`open` consults the registry first: a registered id is activated and returned, without
touching the store at all. Only a miss reaches the store, and a snapshot that comes back is
hydrated into a new workspace through the seed, registered, and made active even when the registry
was not empty. A miss with no store, or a miss the store cannot satisfy, returns `undefined`.
`save` writes the snapshot under its own id, so saving twice upserts rather than accumulating.
Removing a workspace from the registry does not delete its stored snapshot; dropping durable state
is the store's `delete`.

`MemoryWorkspaceStore` keeps snapshots in a map for the lifetime of the process — a real store with
a short memory, useful wherever durability is not the point. `DatabaseWorkspaceStore` writes one
opaque column through `@orkestrel/database` and narrows it back with `isWorkspaceSnapshot` on read,
so a row that is not a snapshot reads as absent instead of propagating. Neither store clones what
it is given, and neither hydrates a live workspace: turning a snapshot back into a `Workspace` is
the manager's job.

Because the seam is `get`, `set`, and `delete` over a plain serializable value, a caller's own
implementation is a peer of `MemoryWorkspaceStore` and `DatabaseWorkspaceStore`. A store that wrote
snapshots to disk, to object storage, or to a remote service would satisfy the same contract and
change nothing about what a workspace is.

## Failures

A code describes every refusal, and `WorkspaceError` carries the code plus the context the
operation had:

| Code       | Raised by                                                            |
| ---------- | -------------------------------------------------------------------- |
| `MISSING`  | a ranged write aimed at a path the workspace does not hold           |
| `MODALITY` | a text-only operation aimed at binary content                        |
| `RANGE`    | a ranged write whose range is inverted or has a coordinate below one |
| `PATTERN`  | a search or replacement whose pattern source will not compile        |

```ts
import { createWorkspace, isWorkspaceError } from '@orkestrel/workspace'

const workspace = createWorkspace()

try {
	workspace.search('(', { regex: true })
} catch (error) {
	if (isWorkspaceError(error)) error.code // 'PATTERN'
}
```

Everything else answers with a value. An absent path reads as `undefined`, a fruitless `remove` or
`move` reports `false`, an unknown `switch` or `open` returns `undefined`, and a `save` without a
store returns `false`. A caller drives this package without a try block until it addresses content
in a way that cannot mean anything.

## Callers

The surface is deliberately narrow enough that no caller is special. `@orkestrel/agent` is one
such caller: an agent loop can keep a manager, treat `active` as the workspace under discussion,
and render its files into a prompt. That projection is the agent's product decision and lives
there, not here. `@orkestrel/toolbox` is another caller: a tool handler can expose the same
operations as callable tools. Plain code can skip both and build a workspace, edit it, and snapshot
it directly.

What a workspace holds is equally open. Files a program generated, documents fetched from
elsewhere, a scratch space that never becomes anything — the map does not care, because nothing
here reaches outside the process to check.

## Tests

- [`guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection over values
  and types, each interface ↔ class method bijection, and the equality gate: every `Summary` cell
  against its declaration's description paragraph, the titled `Files and content` fence against the
  `@example` block of that title (pinned so the titled pair cannot be retired silently), and the
  README pitch against this guide's tagline. It also runs the flagship fences and asserts the
  values their comments claim.
- [`helpers.test.ts`](../tests/src/core/helpers.test.ts) — content narrowing, sizing, line
  counting, range validity and clamping, offsets, splicing, and escaping.
- [`factories.test.ts`](../tests/src/core/factories.test.ts) — derived metadata, frozen values,
  and each factory's working instance.
- [`Workspace.test.ts`](../tests/src/core/workspaces/Workspace.test.ts) — the edit surface end
  to end: state transitions, clamping, the modality matrix over a real binary file, search and
  replace semantics, insertion order, events and listener isolation, and the construction seed.
- [`WorkspaceManager.test.ts`](../tests/src/core/workspaces/WorkspaceManager.test.ts) —
  registration, the active pointer, listener defaults and overrides, and the store round trip
  through `open` and `save`.
- [`MemoryWorkspaceStore.test.ts`](../tests/src/core/workspaces/stores/MemoryWorkspaceStore.test.ts)
  and
  [`DatabaseWorkspaceStore.test.ts`](../tests/src/core/workspaces/stores/DatabaseWorkspaceStore.test.ts)
  — one shared store contract battery run against both implementations, plus each one's specific
  path.

## See also

- [`README.md`](README.md) — the guides index.
- [`emitter.md`](emitter.md) — the dependency mirror for `@orkestrel/emitter`, whose isolation
  guarantees back every workspace event.
- [`database.md`](database.md) — the dependency mirror for `@orkestrel/database`, the table behind
  `DatabaseWorkspaceStore`.
- [`contract.md`](contract.md) — the dependency mirror for `@orkestrel/contract`, whose total
  guards back the overload narrowing and the storage-boundary guards.
- [`AGENTS.md`](../AGENTS.md) — the repository's coding and documentation contract.
