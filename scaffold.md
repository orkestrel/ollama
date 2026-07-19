# Scaffold

> A synchronous, deterministic **package-blueprint compiler** for the `@orkestrel` line:
> a closed, JSON-serializable **`Blueprint`** (name, surfaces, dependencies, overrides…)
> is compiled into a **`Plan`** — an ordered list of **`Artifact`**s, each carrying an
> `origin` that says whether its content was host-copied, template-rendered, or computed —
> and every downstream product (the files on disk, a review document, an audit of an
> existing package, a dry-run summary) is **projected** from that one `Plan`, never
> authored separately.
> FORWARD: a `Blueprint` is **drafted** into artifacts — the §1.2 variant matrix as data
> (`SURFACE_MATRIX`) selects the `exports` map, the per-surface configs, and the test
> projects; caller **`overrides`** layer over the shipped defaults — the fail-closed
> **gate** validates the name, surfaces, and dependencies, and a passing plan is **pinned**
> (`trace` + `hash` derived from content, never authored).
> REVERSE: `planToReview` / `planToSummary` render the plan for humans; `diffPlan` audits
> it against a target's current content and returns **drift findings as data**; the server
> surface's `Materializer` is the only impure step — it writes.
> Nothing here runs `git`, `npm`, a network call, or an LLM: the core is pure (no `node:*`,
> no clocks, no randomness — `trace` and `hash` derive from content alone), and writing
> lives behind an explicit apply on the server surface. A blueprint that fails the gate
> yields a visible INCOMPLETE `Scaffolding` carrying the questions — a half-formed package
> is worse than a question, so the gate fails closed rather than emitting.
> Every discriminant names its axis, never `kind` / `type` (AGENTS §4.4): `origin` splits
> how an artifact's content is produced, `group` splits the artifact groups, `surface`
> splits the environment faces, `category` splits declared members, `drift` splits audit
> verdicts, `stage` splits the pipeline phases, `code` splits coded errors. Source:
> [`src/core`](../../src/core) + [`src/server`](../../src/server). Surfaced through the `@src/core` /
> `@src/server` barrels.

The problem this module solves: standing up (or auditing) an `@orkestrel` package is a
mechanical projection of the line's conventions onto a name — the exports map for the
variant, the per-surface build configs, the barrels, the guide stubs, the parity harness —
yet the only tool the line had was [`scripts/scaffold.sh`](../../scripts/scaffold.sh): a
core-only bash script whose every template is a **frozen heredoc**, so when a convention
moves, each repo's copy silently rots and the char-width table padding is hand-rolled with
`printf` byte math a UTF-8 cell defeats. This package **fully replaces** that script.
Templates ship as **versioned package data** — bump `@orkestrel/scaffold`, republish, and
every consumer inherits the new conventions instead of hand-editing a stale heredoc. The
module is deliberately **mechanism, never policy** (AGENTS §21): the judgment calls (the
name, the description, the keywords, which surfaces, which dependencies, any template
override) belong to the caller — a human, or an agent following a `/scaffold` command —
while this module supplies the closed vocabularies, the variant matrix as data, the
exact-record validation, the fail-closed gate, the deterministic pin, and the lossless
projections. Separating the WHAT (the `Blueprint`) from the HOW (the `Plan` and its writes)
is the whole design: because the plan and the audit are pure data, the same engine that
_creates_ a package can **audit** an existing one (`diffPlan` against its current content —
the SCAFFOLD.md §13.3 consistency checklist, now returned as findings) and **repair** only
what drifted. Scaffold is the line's conformance engine, not merely its generator.

## Surface

Compile a `Blueprint` into a `Scaffolding`, then project the `Plan` it carries — the whole
core path is pure and synchronous; writing lives on the server surface:

```ts
import { blueprint, createCompiler, dependency, planToReview } from '@orkestrel/scaffold'

const compiler = createCompiler()

const scaffolding = compiler.compile(
	blueprint('router', {
		description: 'A tiny hash-router. Part of the @orkestrel line.',
		keywords: ['router', 'hash', 'spa'],
		surfaces: ['core', 'browser', 'server'],
		dependencies: [dependency('@orkestrel/contract', '^0.0.5')],
	}),
)

scaffolding.complete // true — the gate passed
if (scaffolding.plan) {
	scaffolding.plan.artifacts.length // every file the package needs, ordered
	planToReview(scaffolding.plan) // the copy-ready dry-run review document
}

compiler.emitter.on('block', (questions) => questions.length)
compiler.destroy()
```

`compile()` is genuinely SYNCHRONOUS and runs the fixed three-stage pipeline
`[draft, gate, pin]`; a failing gate yields a visible INCOMPLETE `Scaffolding` (`plan`
absent, `questions` populated) rather than throwing. Compilation, review, summary, and
audit are ALL pure — no clocks, no randomness, no `node:*`, no I/O. Materialization is the
one impure act, and it lives on the server surface (`@orkestrel/scaffold/server`), behind
an explicit call; the core never writes. The Surface below documents BOTH faces — the pure
core (`@orkestrel/scaffold`) and the materialization face marked **(server)** — since one
guide documents the union of a package's surfaces (SCAFFOLD.md §13.2).

### Types

| Type                    | Kind      | Shape                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Surface`               | type      | `'core' \| 'browser' \| 'server'` — the environment surface an artifact or member belongs to.                                                                                                                                                                                                                               |
| `Origin`                | type      | `'host' \| 'template' \| 'computed'` — how an `Artifact`'s content is produced; the axis that decides whether it carries `source` (host copy) or `content` (rendered / derived).                                                                                                                                            |
| `Group`                 | type      | `'manifest' \| 'configs' \| 'source' \| 'tests' \| 'guides' \| 'docs' \| 'orchestration'` — the closed artifact-group vocabulary a plan selects over.                                                                                                                                                                       |
| `Category`              | type      | `'type' \| 'constant' \| 'factory' \| 'entity'` — what a declared `Member` IS in the scaffolded surface.                                                                                                                                                                                                                    |
| `Drift`                 | type      | `'aligned' \| 'stale' \| 'missing' \| 'foreign'` — one `Finding`'s verdict against the target's current content.                                                                                                                                                                                                            |
| `CompileStage`          | type      | `'draft' \| 'gate' \| 'pin'` — the three fixed pipeline phases, in order.                                                                                                                                                                                                                                                   |
| `ScaffoldErrorCode`     | type      | `'INVALID' \| 'BLOCKED' \| 'DESTROYED' \| 'TARGET' \| 'WRITE'` — coded `ScaffoldError` reasons.                                                                                                                                                                                                                             |
| `Dependency`            | interface | `{ name, range }` — one runtime `@orkestrel/*` dependency; drives its `package.json` entry, the build externals, and its `guides/src/<dep>.md` mirror — byte-correct for a dep this package vendors (contract / emitter / markdown / guide), a `host`-origin POINTER the caller syncs otherwise (R3).                       |
| `Override`              | interface | `{ path, content }` — one caller template override; `content` REPLACES the rendered artifact at `path`, never partially merges. An override whose `path` matches no planned artifact, or targets a `host`-origin path, is a BLOCKING Question — never a silent add (R5).                                                    |
| `Blueprint`             | interface | `{ name, description, keywords, surfaces, dependencies, version, engines, overrides }` — the closed, JSON-serializable package spec.                                                                                                                                                                                        |
| `Member`                | interface | `{ name, category, summary, surface }` — one declared public export of the scaffolded package; derived by `blueprintToMembers`, never authored.                                                                                                                                                                             |
| `Artifact`              | interface | `{ path, group, origin, surface?, content?, source? }` — one file in a `Plan`; `content` present for `template` / `computed`, `source` (a host-relative path) for `host`.                                                                                                                                                   |
| `Plan`                  | interface | `{ blueprint, groups, artifacts, trace?, hash? }` — the compiled, ordered artifact list plus the selection it covers; `trace` / `hash` filled by the pin.                                                                                                                                                                   |
| `Finding`               | interface | `{ path, group, drift }` — one audit drift result.                                                                                                                                                                                                                                                                          |
| `Audit`                 | interface | `{ findings, clean, complete, questions, drifted, missing, foreign }` — the whole diff of a plan against a target's content; a `Compiler.audit` over a gate-failing blueprint sets `complete: false` with the gate's `questions` and zero findings (R4), while `diffPlan` over an existing plan is always `complete: true`. |
| `Question`              | interface | `{ field, text, blocking, candidates? }` — one validation issue; `blocking: true` fails the gate closed, `false` is an advisory that rides a complete result.                                                                                                                                                               |
| `Validation`            | interface | `{ valid, questions, warnings }` — the semantic pass over a blueprint; returns, never throws.                                                                                                                                                                                                                               |
| `PlanSummary`           | interface | `{ name, surfaces, groups, artifacts, host, template, computed }` — the dry-run tally.                                                                                                                                                                                                                                      |
| `CompileRecord`         | interface | `{ stage, input, output, failed, error? }` — a structured input/output snapshot of one pipeline phase.                                                                                                                                                                                                                      |
| `CompileFailure`        | interface | `{ stage, code, message }` — a visible marker for a stage that failed.                                                                                                                                                                                                                                                      |
| `Scaffolding`           | interface | `{ blueprint, plan?, questions, stages, failures, complete, digest }` — the full, replayable outcome of one `compile()` call.                                                                                                                                                                                               |
| `PlanRecord`            | interface | `{ id, plan, version, hash }` — a versioned, content-hashed `Plan` inside a `PlanManager`.                                                                                                                                                                                                                                  |
| `MaterializeResult`     | interface | `{ target, written, copied, skipped }` — the outcome of one materialization **(server)**.                                                                                                                                                                                                                                   |
| `CompilerEventMap`      | type      | `Compiler`'s push observation surface (AGENTS §13) — `compile(scaffolding)` · `audit(audit)` · `block(questions)` · `error(error)` · `destroy()`.                                                                                                                                                                           |
| `CompilerOptions`       | interface | `{ on?, error? }` — input to `createCompiler`.                                                                                                                                                                                                                                                                              |
| `CompilerInterface`     | interface | The compilation orchestrator contract — `emitter` + `compile` / `audit` / `destroy`.                                                                                                                                                                                                                                        |
| `PlanManagerEventMap`   | type      | `PlanManager`'s push observation surface — `add(id)` · `remove(id)` · `destroy()`.                                                                                                                                                                                                                                          |
| `PlanManagerOptions`    | interface | `{ plans?, on?, error? }` — input to `createPlanManager`.                                                                                                                                                                                                                                                                   |
| `PlanManagerInterface`  | interface | The plan registry contract (AGENTS §9) — `emitter` / `size` + `has` / `plan` / `plans` / `add` / `remove` / `destroy`.                                                                                                                                                                                                      |
| `MaterializerEventMap`  | type      | `Materializer`'s push observation surface **(server)** — `copy(path)` · `write(path)` · `done(result)` · `error(error)` · `destroy()`.                                                                                                                                                                                      |
| `MaterializerOptions`   | interface | `{ host?, on?, error? }` — input to `createMaterializer` **(server)**; `host` is the vendored-data root host-origin artifacts are copied FROM (defaults to this package's data).                                                                                                                                            |
| `MaterializerInterface` | interface | The materialization contract **(server)** — `emitter` + `materialize` / `repair` / `destroy`.                                                                                                                                                                                                                               |

The `Blueprint` and the `Plan` are the two closed contracts — every field is a `string`,
`readonly` array, or record, so both round-trip JSON and both cross a tool / RPC boundary
unchanged. `Artifact` is discriminated by `origin`: a `host` artifact names a `source`
(the host-relative path to byte-copy) and carries NO `content` (the pure core never reads
host bytes); a `template` / `computed` artifact carries the rendered `content` and no
`source`. That single axis is what keeps the core pure while still describing files it
cannot itself read.

### Constants

| API               | Kind  | Summary                                                                                                                                                                                                                                                    |
| ----------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SURFACES`        | const | The three `Surface` values, frozen — compose with `literalOf(...)` / `parseEnum(...)`.                                                                                                                                                                     |
| `ORIGINS`         | const | The three `Origin` values, frozen.                                                                                                                                                                                                                         |
| `GROUPS`          | const | The seven `Group` values, frozen — the artifact-group selection vocabulary.                                                                                                                                                                                |
| `CATEGORIES`      | const | The four `Category` values, frozen.                                                                                                                                                                                                                        |
| `COMPILE_STAGES`  | const | `['draft', 'gate', 'pin']`, frozen — the pipeline phases in order.                                                                                                                                                                                         |
| `SURFACE_MATRIX`  | const | The §1.2 variant matrix as data: per `Surface`, its `configs/src` files, Vitest project label, `exports` subpath, and build formats — the per-surface layer `blueprintToPlan` reads BENEATH the SCAFFOLD.md §4.2/§4.3 combination rules it applies on top. |
| `HOST_PATHS`      | const | The byte-copied host artifact paths (AGENTS.md, CLAUDE.md, SCAFFOLD.md, LICENSE, `.claude`, `scripts/*` — the SessionStart hooks + `mirror.sh` + `scaffold.sh` today — dotfiles, `ci.yml`), frozen; `scaffold.sh` leaves this set at retirement (R6).      |
| `NAME_PATTERN`    | const | The `/^[a-z][a-z0-9-]*$/` package-name RegExp (the `scaffold.sh` name law, now data).                                                                                                                                                                      |
| `DEFAULT_VERSION` | const | `'0.0.1'` — the starting version the `blueprint` builder fills.                                                                                                                                                                                            |
| `DEFAULT_ENGINES` | const | `'>=22'` — the `engines.node` range the `blueprint` builder fills.                                                                                                                                                                                         |
| `COMPILER_ID`     | const | `'compiler'` — the default id for a `Compiler` orchestrator.                                                                                                                                                                                               |

```ts
import {
	CATEGORIES,
	GROUPS,
	HOST_PATHS,
	NAME_PATTERN,
	ORIGINS,
	SURFACES,
} from '@orkestrel/scaffold'

SURFACES // ['core', 'browser', 'server']
ORIGINS // ['host', 'template', 'computed']
GROUPS // ['manifest', 'configs', 'source', 'tests', 'guides', 'docs', 'orchestration']
CATEGORIES // ['type', 'constant', 'factory', 'entity']
NAME_PATTERN.test('router') // true
NAME_PATTERN.test('Router') // false — the package-name law rejects a leading capital
HOST_PATHS.includes('scripts/mirror.sh') // true — the mirror stays in the orchestration set
HOST_PATHS.includes('scripts/scaffold.sh') // true today — leaves HOST_PATHS at retirement (R6)
```

A closed-set field that does not fit a listed value is a signal the request is mis-scoped,
not licence to invent a value — the exact-record validators below reject an off-vocabulary
literal, and the shapers compile the same tuples into the JSON Schema `enum`s, so the
vocabulary cannot drift between the guard, the parser, and the schema.

### Errors

| API               | Kind     | Summary                                             |
| ----------------- | -------- | --------------------------------------------------- |
| `ScaffoldError`   | class    | Carries a `ScaffoldErrorCode` + optional `context`. |
| `isScaffoldError` | function | Narrow a caught value to a `ScaffoldError`.         |

```ts
import { ScaffoldError, isScaffoldError } from '@orkestrel/scaffold'

try {
	throw new ScaffoldError('INVALID', 'Blueprint failed the exact-record contract')
} catch (error) {
	if (isScaffoldError(error)) error.code // 'INVALID'
}
```

Throws are reserved for caller misuse (AGENTS §12): `createBlueprint` on off-contract data
throws `INVALID`, any method after `destroy()` throws `DESTROYED`, and on the server surface
a non-vacant target throws `TARGET` while a failed write throws `WRITE`. A failing gate is
NOT an error — it fails closed into an incomplete `Scaffolding` whose `failures` carry a
`BLOCKED` marker, mirroring the brief compiler's visible-incomplete outcome.

### Validators

Total guards (AGENTS §14) COMPILED from the shapers below via the contract package's
`createContract` — one shape declaration is the single source, so `isBlueprint`,
`parseBlueprint`, and the JSON Schema can never drift. Adversarial input (junk, cycles,
hostile prototypes) returns `false`, never throws. Every record guard is EXACT: an extra
key fails, which is why the builders below omit absent optional keys.

| API            | Kind     | Narrows to                                                                                                                                             |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isDependency` | function | `Dependency` — `name` a non-empty string, `range` a non-empty string.                                                                                  |
| `isOverride`   | function | `Override` — `path` / `content` non-empty strings.                                                                                                     |
| `isBlueprint`  | function | `Blueprint` — `surfaces` on-vocabulary and non-empty; `name` a non-empty string (the `NAME_PATTERN` law is the semantic pass's, not the guard's — R1). |
| `isMember`     | function | `Member` — `category` an on-vocabulary `Category`, `surface` an on-vocabulary `Surface`.                                                               |
| `isArtifact`   | function | `Artifact` — `group` / `origin` on-vocabulary; `content` xor `source` per `origin`.                                                                    |
| `isPlan`       | function | `Plan` — the whole exact-record contract, section guards composed.                                                                                     |

```ts
import {
	blueprint,
	isBlueprint,
	isDependency,
	isPlan,
	validateBlueprint,
} from '@orkestrel/scaffold'

isDependency({ name: '@orkestrel/contract', range: '^0.0.5' }) // true
isBlueprint({ name: 'router', surfaces: ['core'] }) // false — sections missing (exact record)

// NAME_PATTERN is the semantic pass's job, not the shape's (R1) — so the guard passes an
// off-pattern name and validateBlueprint is what rejects it:
const offPattern = blueprint('Router', { surfaces: ['core'] }) // a complete spec; name off NAME_PATTERN
isBlueprint(offPattern) // true — the shape polices STRUCTURE only
validateBlueprint(offPattern).valid // false — the semantic pass owns the NAME_PATTERN law

isPlan({ blueprint: {}, groups: [], artifacts: [] }) // false — blueprint off-contract
```

### Parsers

The coercing counterparts of the guards, COMPILED from the same shapes through the contract
package's `createContract` — a guard-valid value round-trips unchanged, an off-contract value
returns `undefined`, and neither ever throws (AGENTS §14). This is the parse-then-trust
boundary for a stored plan, a tool argument, or an agent's emission.

| API              | Kind     | Returns                                                         |
| ---------------- | -------- | --------------------------------------------------------------- |
| `parseBlueprint` | function | a `Blueprint` from `unknown` / a JSON string, else `undefined`. |
| `parsePlan`      | function | a `Plan` from `unknown` / a JSON string, else `undefined`.      |

```ts
import { blueprint, isBlueprint, parseBlueprint } from '@orkestrel/scaffold'

const json = JSON.stringify(blueprint('router', { surfaces: ['core'] })) // a complete, on-contract spec
const parsed = parseBlueprint(json) // Blueprint | undefined
parsed && isBlueprint(parsed) // true — a non-undefined parse always satisfies the guard
parseBlueprint('{"name":"router"}') // undefined — sections missing (exact record), never throws
```

### Shapers

The `Blueprint` and `Plan` contracts declared ONCE as contract `ContractShape` values
(AGENTS §14 heavy machinery, earned here: validation, the JSON Schema a tool boundary needs,
and seeded test blueprints must stay in lockstep). Each shaper is a function returning a
fresh shape value; `blueprintShape()` / `planShape()` compose the section shapes, and the
module's own validators and parsers are compiled from them at the barrel.

| API               | Kind     | Builds…                                                                                                                                                                                                                                      |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependencyShape` | function | the `Dependency` object shape.                                                                                                                                                                                                               |
| `overrideShape`   | function | the `Override` object shape.                                                                                                                                                                                                                 |
| `blueprintShape`  | function | the `Blueprint` object shape — `surfaces` a `literalShape(SURFACES)` array with `min: 1`; `name` a plain `min: 1` string, NOT pattern-constrained, so `generate` stays satisfiable (the `NAME_PATTERN` law lives in the semantic pass — R1). |
| `memberShape`     | function | the `Member` object shape — `category` / `surface` literal shapes.                                                                                                                                                                           |
| `artifactShape`   | function | the `Artifact` object shape — `origin` a `literalShape(ORIGINS)`; `content` / `source` optional.                                                                                                                                             |
| `planShape`       | function | the whole `Plan` object shape, section shapes composed; `trace` / `hash` optional.                                                                                                                                                           |

```ts
import { blueprintShape } from '@orkestrel/scaffold'
import { createContract, schemaToParameters, seededRandom } from '@orkestrel/contract'

const contract = createContract(blueprintShape())
contract.schema // the full JSON Schema — hand to a tool boundary via schemaToParameters
contract.generate(seededRandom(42)) // a reproducible, on-contract seed blueprint for tests
schemaToParameters(contract.schema) // the open tool-parameters record, no `as` anywhere
```

### Builders

Lowercase value builders — every builder returns a fresh object and OMITS absent optional
keys entirely, so its output round-trips the exact-record validators above.

| API          | Kind     | Builds…                                                                                                                                                                                                                |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependency` | function | a `Dependency` from name / range.                                                                                                                                                                                      |
| `override`   | function | an `Override` from path / content.                                                                                                                                                                                     |
| `member`     | function | a `Member` from name / category / summary / surface (`surface` defaults `'core'`).                                                                                                                                     |
| `blueprint`  | function | a `Blueprint` from a name + a partial of the rest — `version` / `engines` default (`DEFAULT_VERSION` / `DEFAULT_ENGINES`), `surfaces` defaults `['core']`, and `keywords` / `dependencies` / `overrides` default `[]`. |

```ts
import { blueprint, dependency, override } from '@orkestrel/scaffold'

const spec = blueprint('router', {
	description: 'A tiny hash-router. Part of the @orkestrel line.',
	keywords: ['router', 'hash'],
	surfaces: ['core', 'browser'],
	dependencies: [dependency('@orkestrel/contract', '^0.0.5')],
	overrides: [override('README.md', '# @orkestrel/router\n\nHand-written readme.\n')],
})
spec.version // '0.0.1' — the builder default
spec.engines // '>=22' — the builder default
```

### Helpers

Pure, exported utility functions (AGENTS §4.3) — the referentially-transparent leaves
behind the `Compiler` and the projection surface. Projections use the `{noun}To{Noun}`
idiom (AGENTS §4.6.1): each consumes a WHOLE and returns a derived view of it.

| API                  | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blueprintToMembers` | function | Derive the declared public `Member[]` from a blueprint (name → Pascal → the canonical inventory per surface) — the SINGLE source both the source stubs and the guide Surface tables read. The skeleton vocabulary is deliberately the four `Category` buckets (`type` / `constant` / `factory` / `entity`); standalone helpers, validators, and shapers are hand-authored in implementation, not scaffolded (A5).                 |
| `blueprintToPlan`    | function | The full pure compilation: draft the artifacts — the SCAFFOLD.md §4.2/§4.3 COMBINATION rules (multi-surface OMITS the top-level `package.json` `types`; a single-variant server-/browser-only retargets its lone surface to the `.` root, `main` / `module` re-pointed) OVER the per-surface `SURFACE_MATRIX` rows, plus `HOST_PATHS` and overrides — then pin; optionally scoped to a `Group[]` selection (default: all groups). |
| `pinPlan`            | function | Return a fresh `Plan` with `trace` (the one-line derivation summary) and `hash` (a canonical structural digest) filled — deterministic, no timestamps, no run-specific data.                                                                                                                                                                                                                                                      |
| `validateBlueprint`  | function | The semantic pass over a blueprint — name against `NAME_PATTERN`, non-empty on-vocabulary `surfaces`, well-formed `dependencies`, no duplicate members. Returns a `Validation`, never throws.                                                                                                                                                                                                                                     |
| `diffPlan`           | function | The AUDIT projection: diff a plan's artifacts against a caller-supplied `Readonly<Record<string, string>>` of the target's current content, returning an `Audit` of drift findings — pure, no I/O.                                                                                                                                                                                                                                |
| `planToReview`       | function | Project a `Plan` into a copy-ready markdown review document — the artifact table by group, the members table, the summary; the diff-first dry run.                                                                                                                                                                                                                                                                                |
| `auditToReview`      | function | Project an `Audit` into a markdown drift report — findings grouped by `drift`, aligned entries elided; what `repair` will touch.                                                                                                                                                                                                                                                                                                  |
| `planToSummary`      | function | Project a `Plan` into a `PlanSummary` — the artifact tally by `origin`, the surfaces, and the covered groups.                                                                                                                                                                                                                                                                                                                     |
| `pascalCase`         | function | Derive the PascalCase entity name from a lowercase-hyphen package name (`'my-router'` → `'MyRouter'`) — hyphens are word breaks.                                                                                                                                                                                                                                                                                                  |
| `alignTable`         | function | Build a formatter-width-aligned GFM table string from header + row cell strings (+ optional `readonly TableAlign[]`) — the guide Surface-table emitter.                                                                                                                                                                                                                                                                           |

```ts
import {
	alignTable,
	blueprintToMembers,
	blueprintToPlan,
	diffPlan,
	pascalCase,
	planToReview,
	planToSummary,
	validateBlueprint,
} from '@orkestrel/scaffold'

const plan = blueprintToPlan(spec)
plan.hash // '7b1c9e04' — canonical FNV-1a digest of the plan's content, stable across runs
plan.trace // 'router · core+browser · groups:7 · artifacts:21' — derived, never authored

pascalCase('my-router') // 'MyRouter' — hyphens are word breaks
blueprintToMembers(spec) // [{ name: 'RouterOptions', category: 'type', surface: 'core' }, …]
planToSummary(plan) // { name: 'router', artifacts: 21, host: 12, template: 6, computed: 3, … }
planToReview(plan) // '# Scaffolding router\n## Artifacts\n| Path | Group | Origin |\n…'
validateBlueprint(spec) // { valid: true, questions: [], warnings: [] }

const current = { 'package.json': '{ "name": "@orkestrel/router" }' }
diffPlan(plan, current) // { findings: [...], clean: false, complete: true, drifted: 1, missing: 20, foreign: 0 }

alignTable(['API', 'Kind'], [['`createRouter`', 'function']]) // '| API           | Kind     |\n| … |'
```

`alignTable` builds a markdown `TableNode` (each cell's string parsed with `parseInline`) and
serializes it through `@orkestrel/markdown`'s `renderMarkdown`, which contributes the STRUCTURE
— `\|`-escaping any literal pipe inside a cell and emitting the alignment delimiter row — at a
flat 1-space cell padding. `alignTable` then re-pads BOTH the cells AND the delimiter row to
per-column codepoint width; that re-pad is the whole capability, matching oxfmt's markdown
re-padding so a generated guide passes `format:check` without a formatter run — the
char-width-padding problem `scaffold.sh` hand-rolled with byte-counting `printf`, now typed and
tested. The `\|`-escape is load-bearing: an unescaped pipe in a cell would split it into two
columns and silently corrupt the table. Its optional `readonly TableAlign[]` is the
`@orkestrel/markdown` alignment type, imported at the call site, never re-exported here (AGENTS §6).

### Factories

| API                  | Kind     | Builds…                                                                                                 |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `createCompiler`     | function | A `CompilerInterface` — the compilation orchestrator, seeded from `CompilerOptions`.                    |
| `createPlanManager`  | function | A working `PlanManagerInterface`.                                                                       |
| `createBlueprint`    | function | Validate and return a `Blueprint` from plain data — throws `ScaffoldError('INVALID', …)` on failure.    |
| `createMaterializer` | function | A `MaterializerInterface` **(server)** — the materialization entity, seeded from `MaterializerOptions`. |

```ts
import { createBlueprint, createCompiler, createPlanManager } from '@orkestrel/scaffold'

const compiler = createCompiler() // owns a typed emitter, no sub-engines
compiler.destroy()

const plans = createPlanManager()
plans.size // 0
plans.destroy()

createBlueprint({ name: 'Router', surfaces: [] }) // throws ScaffoldError('INVALID', …)
```

### Entities

| API            | Kind  | Summary                                                                                                                          |
| -------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Compiler`     | class | The compilation orchestrator — runs the three-stage pipeline and the audit projection, owns a typed emitter.                     |
| `PlanManager`  | class | The self-owning, versioned/hashed plan registry (AGENTS §9) — record ids default to each plan's own content hash.                |
| `Materializer` | class | The materialization entity **(server)** — the only impure surface; writes a plan (green-field) or repairs drift (into-existing). |

The server surface also ships two helpers and its factory:

| API          | Kind     | Summary                                                                                                                                           |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isVacant`   | function | **(server)** Whether a target path is absent, empty, or contains nothing but a `.git` directory — the green-field target law.                     |
| `readTarget` | function | **(server)** Read a target's current content at a set of relative paths into a `Record<string, string>` — the I/O that feeds the pure `diffPlan`. |

```ts
import { createMaterializer, isVacant } from '@orkestrel/scaffold/server'

const target = './packages/router'
isVacant(target) // true — absent, empty, or nothing but a .git dir

const materializer = createMaterializer()
const result = materializer.materialize(plan, target) // writes every artifact; throws TARGET if not vacant
result.written // ['package.json', 'tsconfig.json', 'src/core/index.ts', …] — rendered files
result.copied // ['AGENTS.md', 'LICENSE', '.claude/settings.json', …] — host-origin byte copies
materializer.destroy()
```

## Methods

The public methods of each behavioral interface — one table per type, keyed by its
backticked name, every call-signature member listed (the `readonly` data members —
`emitter` on `Compiler`; `emitter` / `size` on `PlanManager`; `emitter` on `Materializer` —
stay in the Surface rows above). Each implementing class exposes exactly its interface's
methods, so this doubles as the per-instance method surface (AGENTS §22).

#### `CompilerInterface`

`compile` and `audit` are genuinely SYNCHRONOUS and pure — the compiler holds no I/O. After
`destroy()` every method except the getter and `destroy` itself throws
`ScaffoldError('DESTROYED', …)`; `destroy()` is idempotent and tears the emitter down LAST.

| Method    | Returns       | Behavior                                                                                                                                                                                                                                                                                                |
| --------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compile` | `Scaffolding` | Run the three-stage pipeline over a `Blueprint` (optionally scoped to a `Group[]` selection), returning a complete or visible-incomplete result.                                                                                                                                                        |
| `audit`   | `Audit`       | Compile the blueprint (optionally group-scoped), then diff the plan against the caller-supplied current target content — drift findings as data, no I/O. A gate-failing blueprint returns an `Audit` with `complete: false`, the gate's blocking `questions`, and ZERO findings — no plan to diff (R4). |
| `destroy` | `void`        | Idempotent teardown — emits `destroy`, then destroys the emitter LAST.                                                                                                                                                                                                                                  |

```ts
import { blueprint, createCompiler } from '@orkestrel/scaffold'

const compiler = createCompiler()
const spec = blueprint('timeout', {
	description: 'A typed timeout. Part of the @orkestrel line.',
	surfaces: ['core'],
})

const scaffolding = compiler.compile(spec)
scaffolding.stages.map((record) => record.stage) // ['draft', 'gate', 'pin']
scaffolding.complete // true
scaffolding.plan?.hash // pinned

const audit = compiler.audit(spec, { 'package.json': '{ "name": "@orkestrel/timeout" }' })
audit.clean // false — the current target is nearly empty
audit.missing // 19 — everything but package.json is absent
compiler.destroy()
```

#### `PlanManagerInterface`

The self-owning, ordered registry over plans (AGENTS §9). `add` derives each record's `hash`
from the plan's CONTENT and bumps `version` only when that hash changes; an absent id defaults
to the content hash itself — deterministic minting, no randomness. The array overload of
`remove` is declared FIRST (AGENTS §9.2) so an id list resolves to the batch form. A call
after `destroy()` throws `ScaffoldError('DESTROYED', …)`.

| Method    | Returns                   | Behavior                                                                                              |
| --------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `has`     | `boolean`                 | Whether a plan with the given id is registered.                                                       |
| `plan`    | `PlanRecord \| undefined` | Look up ONE registered plan record by id (AGENTS §9.1 singular accessor).                             |
| `plans`   | `readonly PlanRecord[]`   | List ALL registered plan records (AGENTS §9.1 plural accessor).                                       |
| `add`     | `PlanRecord`              | Register (or re-register) one plan; emits `add`.                                                      |
| `remove`  | `boolean` (or `void`)     | Remove LISTED plans by id, ONE plan by id, or ALL plans (AGENTS §9.2); emits `remove` per removed id. |
| `destroy` | `void`                    | Idempotent teardown — clears the collection, emits `destroy`, then destroys the emitter LAST.         |

```ts
import { blueprint, blueprintToPlan, createPlanManager } from '@orkestrel/scaffold'

const plans = createPlanManager()
const record = plans.add(blueprintToPlan(blueprint('budget', { surfaces: ['core'] })))
record.id === record.hash // true — id minted from content, deterministic
record.version // 1
plans.has(record.id) // true
plans.plan(record.id) // the PlanRecord, or undefined
plans.plans() // every registered record
plans.remove(record.id) // true
plans.destroy()
```

#### `MaterializerInterface`

**(server surface.)** The only impure entity in the package — `node:fs` writes behind an
explicit call. `materialize` is green-field: it refuses any target `isVacant` rejects
(throwing `ScaffoldError('TARGET', …)`), then byte-copies each `host` artifact from the
`host` root and writes each `template` / `computed` artifact's rendered `content`, failing
fast on any write error (`WRITE`). `repair` is into-existing: it skips the vacancy check and
writes ONLY the `missing` / `stale` artifacts an `Audit` names. After `destroy()` every
method throws `DESTROYED`; teardown is idempotent, emitter last.

| Method        | Returns             | Behavior                                                                                                                           |
| ------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `materialize` | `MaterializeResult` | Write a whole plan into a VACANT target — host copies + rendered writes; throws `TARGET` if the target is non-empty beyond `.git`. |
| `repair`      | `MaterializeResult` | Write ONLY the artifacts an `Audit` marks `missing` / `stale`, into an EXISTING target — the drift-repair path, no vacancy check.  |
| `destroy`     | `void`              | Idempotent teardown — emits `destroy`, then destroys the emitter LAST.                                                             |

```ts
import { blueprint, blueprintToPlan, diffPlan } from '@orkestrel/scaffold'
import { createMaterializer, readTarget } from '@orkestrel/scaffold/server'

const plan = blueprintToPlan(blueprint('budget', { surfaces: ['core'] }))
const materializer = createMaterializer()

// Green-field: write everything into a fresh, vacant directory.
materializer.materialize(plan, './packages/budget-new')

// Repair: audit an existing package, then write back only what drifted.
const audit = diffPlan(
	plan,
	readTarget(
		'./packages/budget',
		plan.artifacts.map((a) => a.path),
	),
)
materializer.repair(plan, audit, './packages/budget')
materializer.destroy()
```

## Contract

These invariants hold across `src/core` + `src/server` ↔ `scaffold.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `const` / `interface` / `type`
   row in the `## Surface` tables is a real export of the scaffold source tree (core or
   server), and every export appears as a Surface row — exhaustive, both directions (AGENTS
   §22). Adding, renaming, or removing an export breaks the parity gate until the doc is
   reconciled.
2. **Deterministic, synchronous, immutable (§11).** Same `Blueprint` + same `Group`
   selection → the same `Scaffolding`, every time — no clocks, no randomness, no I/O in the
   core, nothing async. `pinPlan`'s `trace` and `hash` derive from the plan's CONTENT alone
   (paths, origins, sources, and rendered content — everything the blueprint fully
   determines), and the `PlanManager` mints record ids from that hash, so re-adding an
   unchanged plan is a version no-op. No input is ever mutated; every builder, projection,
   and pipeline stage returns a fresh value.
3. **Fail closed at the gate.** A non-empty set of BLOCKING questions (a bad name, empty or
   off-vocabulary `surfaces`, a malformed dependency, an override that matches no planned
   artifact or targets a `host`-origin path) yields `complete: false`, an ABSENT `plan`, the
   `questions` on `Scaffolding.questions`, and a `CompileFailure` coded `BLOCKED` — never a
   throw, never a half-formed plan. A NON-blocking question (e.g. a non-vendored dependency's
   mirror pointer, R3) rides a COMPLETE result as an advisory. Emitting a partly-valid package
   skeleton is worse than returning the question that blocks it.
4. **One plan, many projections; projections never add.** `planToReview`, `planToSummary`,
   `diffPlan`, `auditToReview`, and (on the server) `materialize` are pure views over the
   pinned plan — the review renders exactly the plan's artifacts, the summary counts exactly
   them, the audit compares exactly them, and materialization writes exactly them. Nothing
   downstream is authored separately, so the files on disk, the review, the audit, and the
   summary cannot disagree with the plan or one another.
5. **The variant matrix is data (§21).** A blueprint's `surfaces` — any §1.2 combination:
   core-only, core+server, core+browser+server, server-only, browser-only, core+browser —
   drives the `package.json` `exports` shape, the per-surface `configs/src` files, the Vitest
   projects, and the conditional consequences (`@vitest/browser-playwright` as a devDependency
   IFF a browser surface; `tests/setupBrowser.ts` / `tests/setupServer.ts` IFF those surfaces).
   `SURFACE_MATRIX` is the per-surface layer; ABOVE it `blueprintToPlan` applies the SCAFFOLD.md
   §4.2/§4.3 COMBINATION rules — a multi-surface package OMITS the top-level `types` field, a
   single-variant (server-only / browser-only) retargets its lone surface to the `.` root with
   `main` / `module` re-pointed (browser-only using flat ESM conditions). Adding a surface
   changes the PLAN, not the compiler; the core-only single path `scaffold.sh` hard-coded is
   now one row of a table.
6. **Mechanism, never policy (§21).** The module decides NOTHING about a package's identity:
   the caller owns `name` / `description` / `keywords` / `dependencies` and any template
   `overrides`; the compiler owns the rendering, the closed vocabularies, the gate, the pin,
   and the projections. An absent override means the canonical shipped default; a present
   override REPLACES the rendered artifact at its `path`, never partially merges — a
   half-overridden template is a category error, not a feature. Dependency guide mirrors scope
   the same way: this package vendors byte-correct mirrors for the deps it itself ships
   (contract / emitter / markdown / guide) and emits those `guides/src/<dep>.md` real; a
   consumer's ANY-other `@orkestrel` dependency yields NO fabricated mirror — the plan emits a
   `host`-origin POINTER artifact the caller syncs from that dep repo at HEAD, surfaced as a
   NON-blocking Question (R3).
7. **Diff-first, write-last.** `compile`, `audit`, `blueprintToPlan`, `diffPlan`,
   `planToReview`, and `planToSummary` are pure data with no side effects; the ONLY impure
   act in the package is the server surface's `materialize` / `repair`, gated behind an
   explicit call. The dry-run review is the default posture everywhere — you always see the
   plan (or the drift) before a byte is written.
8. **Guard totality and single-source parity (§14).** Every validator is a total `Guard` —
   adversarial input returns `false`, never throws. `isBlueprint` / `isPlan` / the section
   guards are COMPILED from `blueprintShape()` / `planShape()` through the contract package's
   `createContract`, so the guard, the parser, the JSON Schema, and the seeded generator are
   lockstep by construction — an off-vocabulary literal, a missing section, or an extra key
   fails all four identically. `NAME_PATTERN` is deliberately NOT a shape refinement (contract's
   `compileGenerator` throws on a pattern-constrained string it cannot sample, R1), so `generate`
   stays satisfiable; the name law lives in the SEMANTIC pass (`validateBlueprint`, the gate, and
   `createBlueprint`), not the compiled contract — which keeps this four-way lockstep intact.
9. **Coded errors (§12).** Every throw out of this module is a `ScaffoldError` with a
   machine-readable code (`INVALID` / `DESTROYED` from the core, `TARGET` / `WRITE` from the
   server) and a `context` carrying the offending path or field; `BLOCKED` is a contained
   failure marker on a `Scaffolding`, never thrown. `catch` blocks narrow with
   `isScaffoldError`, never `as`.
10. **Observation is a pure side-channel (§13).** The `Compiler` owns a typed emitter
    (`CompilerEventMap` — `compile` / `audit` / `block` / `error` / `destroy`); the
    `PlanManager` and the server `Materializer` own their own. Every event is emitted
    directly and synchronously, AFTER the outcome it reports; only complete `compile()` calls
    emit `compile`, and a gated one emits `block` instead. `audit()` emits `audit` after its
    outcome and NEVER `compile`; a gated `audit()` emits `block` then `audit`. A stage throw
    inside `compile` / `audit` is CONTAINED as a `CompileFailure` on the result AND emitted on
    the domain `error` event for observability (A7). Listener isolation is the emitter's own —
    a throwing listener routes to the `error` OPTION handler, never onto the domain `error`
    event. `destroy()` is idempotent and tears the emitter down LAST.
11. **DOC ↔ SOURCE method bijection.** Every behavioral interface's `## Methods` table lists
    exactly its public methods (call-signature members) — exhaustive, both directions — and
    each implementing class exposes the same public methods, no more (AGENTS §22).

This package **fully replaces** [`scripts/scaffold.sh`](../../scripts/scaffold.sh). The bash
script froze every template as a heredoc and derived only a core-only package from a name;
this module renders the whole §1.2 variant matrix from versioned package data, so a
convention change is a version bump here rather than a hand-edit in every repo's copy. At
retirement `@orkestrel/scaffold` becomes a universal devDependency of every package (joining
`@orkestrel/guide` as line-wide dev tooling), the generated `package.json` renders
`"scaffold": "scaffold"` against the server bin, and `scripts/scaffold.sh` leaves BOTH the
mirrored orchestration set AND `HOST_PATHS` (`mirror.sh` remains) — SCAFFOLD.md §2/§3/§4 move
in lockstep at implementation time (R6).

Deliberately absent: any **git** operation (no `git init` / `git clone` — the caller prepares
the vacant target, and the package stops at the file boundary), any **npm** invocation (no
`npm install`, no lockfile generation — the caller runs the gates), any **network** call, any
**LLM** (the authoring judgment is the caller's, per §6), a foreign template ecosystem (the
module renders only the `@orkestrel` line's own conventions, versioned in this package),
asynchronous compilation, and plan persistence (`JSON.stringify(plan)` out, `parsePlan` back
in). A `RelationManager` or graph layer over artifacts is likewise absent — a plan's artifacts
are one ORDERED list, fully served by the guards, `diffPlan`, and the summary; revisit only if
cross-artifact dependency edges ever need modelling.

## Patterns

### Compiling a package with full variant control

The forward path end to end: blueprint → draft → gate → pin → materialize. The
`SURFACE_MATRIX` selects the `exports` shape, the per-surface configs, and the test projects
from the declared `surfaces`, so one call scaffolds any variant.

```ts
import { blueprint, createCompiler, dependency } from '@orkestrel/scaffold'
import { createMaterializer } from '@orkestrel/scaffold/server'

const compiler = createCompiler()
const scaffolding = compiler.compile(
	blueprint('database', {
		description: 'A minimal-interface data layer. Part of the @orkestrel line.',
		keywords: ['database', 'storage', 'query'],
		surfaces: ['core', 'browser', 'server'], // the full three-surface variant
		dependencies: [dependency('@orkestrel/contract', '^0.0.5')],
	}),
)

scaffolding.complete // true
scaffolding.plan?.groups // ['manifest', 'configs', 'source', 'tests', 'guides', 'docs', 'orchestration']

if (scaffolding.plan) {
	const materializer = createMaterializer()
	materializer.materialize(scaffolding.plan, './packages/database') // green-field, vacant target
	materializer.destroy()
}
compiler.destroy()
```

### Selecting artifact groups — partial generation

`compile`'s optional `Group[]` scopes the plan to a subset — regenerate just the configs and
guides after a convention bump, leaving hand-written source untouched.

```ts
import { blueprint, createCompiler } from '@orkestrel/scaffold'

const compiler = createCompiler()
const spec = blueprint('sqlite', { surfaces: ['server'] })

const scaffolding = compiler.compile(spec, ['configs', 'guides']) // only these two groups
scaffolding.plan?.artifacts.every(
	(artifact) => artifact.group === 'configs' || artifact.group === 'guides',
) // true
compiler.destroy()
```

### Failing closed — the blocking path

An off-`NAME_PATTERN` name (or an override that matches nothing, or one targeting a host path)
is a BLOCKING question: the gate stops, no plan is pinned, and the `Scaffolding` carries the
question — the caller fixes it and re-compiles. No half-formed package ever leaves the pipeline.

```ts
import { blueprint, createCompiler } from '@orkestrel/scaffold'

const compiler = createCompiler()
const scaffolding = compiler.compile(blueprint('My-Router', { surfaces: ['core'] }))

scaffolding.complete // false — the gate failed closed
scaffolding.plan // undefined — nothing to project, deliberately
scaffolding.questions // [{ field: 'name', text: 'Name must match ^[a-z][a-z0-9-]*$', blocking: true }]
scaffolding.failures // [{ stage: 'gate', code: 'BLOCKED', message: '1 blocking question' }]
compiler.emitter.on('block', (questions) => questions.length) // fires instead of `compile`
compiler.destroy()
```

### Auditing an existing package — the conformance engine

The audit is pure core: the server reads the target's current content (`readTarget`), the
core diffs it against the plan (`diffPlan`), and the drift comes back as data — the
SCAFFOLD.md §13.3 consistency checklist, mechanized. No byte is written.

```ts
import { blueprint, blueprintToPlan, diffPlan, auditToReview } from '@orkestrel/scaffold'
import { readTarget } from '@orkestrel/scaffold/server'

const plan = blueprintToPlan(blueprint('abort', { surfaces: ['core'] }))
const current = readTarget(
	'./packages/abort',
	plan.artifacts.map((artifact) => artifact.path),
)

const audit = diffPlan(plan, current)
audit.clean // false — the repo drifted from the line's conventions
audit.findings.filter((finding) => finding.drift === 'stale') // e.g. [{ path: '.oxfmtrc.json', … }]
auditToReview(audit) // '# Drift — abort\n## Stale\n| Path | Group |\n…'
```

`diffPlan` compares by content equality: a `template` / `computed` artifact whose rendered
content the target does not match is `stale`; one the target lacks is `missing`; a target
file the plan does not own is `foreign`. A `host`-origin artifact carries no `content` (the
pure core never read the canonical host bytes), so it is audited by PRESENCE only — `missing`
or `aligned`, never `stale`; deep host-file drift is caught by the server's own mirror pass,
not by the pure diff.

### Repairing drift — write only what changed

Repair chains the audit into the server surface: `materialize` refuses a non-vacant target,
so repairing an EXISTING package goes through `repair`, which writes only the `missing` /
`stale` artifacts the audit named.

```ts
import { blueprint, blueprintToPlan, diffPlan } from '@orkestrel/scaffold'
import { createMaterializer, readTarget } from '@orkestrel/scaffold/server'

const plan = blueprintToPlan(blueprint('abort', { surfaces: ['core'] }))
const audit = diffPlan(
	plan,
	readTarget(
		'./packages/abort',
		plan.artifacts.map((a) => a.path),
	),
)

const materializer = createMaterializer()
const result = materializer.repair(plan, audit, './packages/abort') // only the drifted files
result.written // ['.oxfmtrc.json', 'configs/src/tsconfig.core.json'] — nothing aligned is touched
materializer.destroy()
```

### Layering template overrides

Mechanism-never-policy in practice: the package renders the canonical defaults; a caller who
needs a bespoke file supplies an `override` whose `content` replaces the rendered artifact at
that path. An absent override means the default — the caller opts into exactly the files they
want to own. An override that matches NO planned artifact, or that targets a `host`-origin path
(host bytes are governed by the mirror, not per-package overrides), is a BLOCKING question — a
typo'd path fails the gate closed rather than silently adding a stray file (R5).

```ts
import { blueprint, blueprintToPlan, override } from '@orkestrel/scaffold'

const readme = '# @orkestrel/router\n\nA hash-router with a hand-written readme.\n'
const plan = blueprintToPlan(
	blueprint('router', { surfaces: ['core'], overrides: [override('README.md', readme)] }),
)
plan.artifacts.find((artifact) => artifact.path === 'README.md')?.content === readme // true
```

### Serving blueprints at a tool boundary

The shape DSL payoff: the SAME declaration that compiled the guard serves the tool schema and
the test data — an MCP tool that accepts blueprints cannot drift from the validator that
checks them, and the plan it returns is JSON all the way down.

```ts
import { blueprintShape, blueprintToPlan, parseBlueprint } from '@orkestrel/scaffold'
import { createContract, schemaToParameters, seededRandom } from '@orkestrel/contract'

const contract = createContract(blueprintShape())

const tool = {
	name: 'scaffold_package',
	description: 'Compile an @orkestrel package blueprint into a plan.',
	parameters: schemaToParameters(contract.schema), // the JSON Schema, no `as` anywhere
}

// In the handler: the string boundary is parseBlueprint; the payload is then trusted typed data.
function handle(argument: string): string {
	const incoming = parseBlueprint(argument)
	return incoming ? blueprintToPlan(incoming).hash : 'Rejected: not a valid blueprint.'
}

contract.generate(seededRandom(7)) // a reproducible on-contract blueprint — the test fixture, for free
```

### Retiring `scaffold.sh` — the replacement path

Templates ship as **versioned package data**: the rendered defaults live as centralized,
typed, tested template modules in the core (bumped and republished when the line's
conventions move), and the byte-copied governance files (`HOST_PATHS`) ship as vendored data
under the package root, which the server's `Materializer` copies from its `host` root. So the
staleness that rotted the frozen bash heredocs cannot happen: there is ONE versioned source
of truth, and `npm update @orkestrel/scaffold` propagates a convention change to every
consumer. The server surface exposes a `scaffold` **bin** (declared in `package.json`'s
`bin`, a self-contained entrypoint under §5's runtime-self-contained exception) that wraps
Blueprint → Plan → Materialize with the UX the line already knows from `mirror.sh` /
`scaffold.sh`: it **dry-runs by default** (prints `planToReview`), and writes only under
`--apply`.

```sh
# Dry-run by default — prints the plan's review document, writes nothing:
npx @orkestrel/scaffold router --surfaces core,browser,server

# --apply is the explicit, impure step (the only one):
npx @orkestrel/scaffold router --surfaces core,browser,server --apply --target ./packages/router
```

Once `@orkestrel/scaffold` is published it becomes a universal devDependency of every package
(joining `@orkestrel/guide` as line-wide dev tooling), every repo swaps its
`"scaffold": "bash scripts/scaffold.sh"` script for `"scaffold": "scaffold"` against the server
bin, and `scripts/scaffold.sh` leaves BOTH the mirrored orchestration set and `HOST_PATHS`
(`mirror.sh` remains). SCAFFOLD.md §2/§3/§4 move in lockstep at that point (R6).

### Practices

- **Dry-run first, always** — `compile` / `blueprintToPlan` and `planToReview` are pure;
  read the plan (or `diffPlan`'s audit) before ever calling the server surface. Writing is
  the only impure act, and it is opt-in.
- **One blueprint, one package** — a compound request (two packages) is two `compile` calls,
  not one blueprint with a wider `surfaces` list; `surfaces` selects the variant of ONE
  package, never bundles several.
- **Audit before you edit a fleet repo** — `diffPlan` turns the SCAFFOLD.md §13.3 checklist
  into findings; repair the `missing` / `stale` set with `repair`, and leave `aligned` files
  untouched.
- **Override, don't fork** — need a bespoke file? Add one `override` for that path; the rest
  stay canonical and keep tracking the shipped templates. Never copy the whole plan to change
  one file.
- **Reference deps by their real range** — a `dependency('@orkestrel/contract', '^0.0.5')`
  drives the `package.json` entry, the vendored guide mirror, and the build externals from
  one declaration; declare exactly what `src/` imports (SCAFFOLD.md §4.5).
- **Gate untrusted blueprints twice** — `parseBlueprint` for shape at the boundary,
  `validateBlueprint` for semantics; reserve `createBlueprint`'s throw for programmer-error
  contexts where invalidity is a bug (§12).
- **Store `pinPlan` output, not drafts** — the `hash` is the identity;
  `JSON.stringify(plan)` out, `parsePlan` back in, and the `PlanManager` recognizes the
  unchanged content as the same version.
- **Keep the target vacant for creation** — `materialize` refuses a non-empty target
  (throwing `TARGET`); repair into an existing package with `repair`, never by clearing it
  first.
- **Destroy when done** — `destroy()` releases the emitter; a destroyed `Compiler` /
  `PlanManager` / `Materializer` throws `DESTROYED` on use (narrow with `isScaffoldError`).

## Tests

- [`tests/guides/src/parity.test.ts`](../../tests/guides/src/parity.test.ts) — the `## Surface` ↔
  `src/core` + `src/server` bijection (value + type exports) and the `## Methods` ↔
  interface-method bijection, across both surfaces.
- [`tests/src/core/Compiler.test.ts`](../../tests/src/core/Compiler.test.ts) — the three-stage
  pipeline, stage order and records, group-scoped compilation, the `audit` projection,
  override layering, fail-closed blocking (questions + `BLOCKED` failure + absent plan), event
  sequences (`compile` vs `block`, `audit`), idempotent `destroy`, `DESTROYED` throws.
- [`tests/src/core/PlanManager.test.ts`](../../tests/src/core/PlanManager.test.ts) — content-hash id
  minting, version bump only on content change, batch `remove` all-or-nothing, per-event
  emissions, destroy semantics.
- [`tests/src/core/helpers.test.ts`](../../tests/src/core/helpers.test.ts) — every projection
  (`blueprintToMembers` inventory, `blueprintToPlan` variant coverage + `SURFACE_MATRIX`
  wiring, `planToReview` / `auditToReview` table emission, `planToSummary` counts, `diffPlan`
  drift verdicts incl. host presence-only, `pinPlan` determinism), `validateBlueprint` errors +
  warnings, `pascalCase`, and `alignTable` (oxfmt-width padding, `\|` escaping, alignment
  delimiter row).
- [`tests/src/core/builders.test.ts`](../../tests/src/core/builders.test.ts) — every builder's output
  shape (defaults filled, absent optional keys omitted, exact-guard round-trips).
- [`tests/src/core/validators.test.ts`](../../tests/src/core/validators.test.ts) — each guard accepts
  valid / rejects invalid + adversarial junk, exact-record semantics, off-vocabulary literal
  rejection, `parseBlueprint` / `parsePlan` ↔ guard soundness.
- [`tests/src/core/shapers.test.ts`](../../tests/src/core/shapers.test.ts) — `blueprintShape` /
  `planShape` compilation through `createContract`: guard/parser/schema/generator lockstep,
  generated blueprints satisfy `isBlueprint`.
- [`tests/src/server/Materializer.test.ts`](../../tests/src/server/Materializer.test.ts) — green-field
  `materialize` into a vacant temp dir (host copies + rendered writes), `TARGET` refusal on a
  non-vacant target, `repair` writing only drifted artifacts, `isVacant` / `readTarget` against a
  real `node:fs` fixture, `WRITE` fail-fast, event sequences, destroy semantics.
- [`tests/src/server/integration.test.ts`](../../tests/src/server/integration.test.ts) — compile →
  materialize → audit (clean) → mutate a file → audit (drift) → repair (clean again), end to
  end against a temp directory; a scaffolded package whose deps are all vendored (contract /
  emitter / markdown / guide) runs its own gates green by construction, while a dep outside that
  set leaves its mirror a pointer plus a non-blocking Question (R3).

## See also

- [`SCAFFOLD.md`](../../SCAFFOLD.md) — the manual packaging recipe this module automates: the variant
  matrix (§1.2), the per-file inventory (§3), the exports shapes (§4.3), the config wrappers
  (§7), the audit checklist (§13.3), and the `scaffold.sh` fast-path this package retires.
- [`contract.md`](contract.md) — the guards, shapers, and `createContract` machinery
  the validators compile from, and `schemaToParameters` / `seededRandom` for the tool boundary.
- [`emitter.md`](emitter.md) — the typed emitter behind the compiler's, manager's,
  and materializer's observation surfaces.
- [`markdown.md`](markdown.md) — the AST + `renderMarkdown` writer `alignTable` builds
  the guide Surface tables on (`parseInline`, `TableNode`, `TableAlign`).
- [`AGENTS.md`](../../AGENTS.md) — the rules; §4 naming, §9 managers, §11 determinism, §12 errors, §13
  emitters, §14 totality, §21 mechanism-never-policy, §22 documentation-as-contracts.
- [`README.md`](../README.md) — the package index.
