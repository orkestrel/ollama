# Guides

A dual-axis index into this repository's guides — by concept, and by
directory (AGENTS §22).

## By concept

| Concept | Spec                     | Source                        | Tests                                                                                                  |
| ------- | ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| Ollama  | [`ollama.md`](ollama.md) | [`src/server`](../src/server) | Hermetic: [`tests/src/server`](../tests/src/server); live service: [`tests/service`](../tests/service) |

## By directory

| Directory    | Guide                    |
| ------------ | ------------------------ |
| `src/server` | [`ollama.md`](ollama.md) |

## Dependency reference

[`agent.md`](agent.md), [`budget.md`](budget.md),
[`contract.md`](contract.md), [`ndjson.md`](ndjson.md),
[`timeout.md`](timeout.md), and [`tool.md`](tool.md) are
byte-identical mirrors of the guides for
`@orkestrel/agent`, `@orkestrel/budget`, `@orkestrel/contract`,
`@orkestrel/ndjson`, `@orkestrel/timeout`, and `@orkestrel/tool` — this
package's runtime dependencies. Each documents **that package's own** surface,
not anything sourced in this repo; they are kept here so a reader of this
package can see the primitives it is built from without leaving this guide
set.

[`guide.md`](guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

[`workspace.md`](workspace.md) is a byte-identical mirror of the guide
for `@orkestrel/workspace` — the devDependency supplying the workspace file
values and construction helpers exercised by this repo's agent-integration
tests. It documents **that package's own** workspace surface, not anything
sourced in this repo; it is kept here so those fixtures' real dependency edge
is visible without leaving this guide set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
