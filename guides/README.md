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

## Toolchain reference

[`guide.md`](guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

[`scaffold.md`](scaffold.md) is a byte-identical mirror of the guide for
`@orkestrel/scaffold` — the devDependency supplying this repo's shared file set,
configuration, and audit verbs. It documents **that package's own** surface, not
anything sourced in this repo; it is kept here so a reader can see the toolchain
this repository is generated and checked against.

The runtime dependencies — `@orkestrel/agent`, `@orkestrel/budget`,
`@orkestrel/contract`, `@orkestrel/ndjson`, `@orkestrel/timeout`, and
`@orkestrel/tool` — carry their own guides in their own repositories. This guide
set mirrors only the toolchain above, so a dependency's surface is read where it
is published rather than from a copy that drifts.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
