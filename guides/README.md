# Guides

A dual-axis index into this repository's guides — by concept, and by
directory.

## By concept

| Concept | Spec                     | Source                    | Tests                                                                                              |
| ------- | ------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------- |
| Ollama  | [`ollama.md`](ollama.md) | [`src/core`](../src/core) | Hermetic: [`tests/src/core`](../tests/src/core); live service: [`tests/service`](../tests/service) |

## By directory

| Directory  | Guide                    |
| ---------- | ------------------------ |
| `src/core` | [`ollama.md`](ollama.md) |

## Mirrored dependency guides

[`ollama.md`](ollama.md) is the only guide sourced here. Every other file in this
directory is a byte-identical mirror of a dependency's own guide, documenting
**that package's** surface rather than anything sourced in this repo, and kept
here so a reader can follow a boundary this package crosses without leaving the
guide set.

The runtime dependencies this package builds on are `@orkestrel/agent`
([`agent.md`](agent.md)), whose `AgentProvider` engine `OllamaProvider` extends
and whose `ProviderInterface` a consumer codes against; `@orkestrel/ndjson`
([`ndjson.md`](ndjson.md)), whose parser frames each call's response;
`@orkestrel/contract` ([`contract.md`](contract.md)), whose guards narrow every
wire `unknown`; `@orkestrel/tool` ([`tool.md`](tool.md)), which owns the tool-call
shapes; `@orkestrel/budget` ([`budget.md`](budget.md)), which owns the usage
shape. No module under `src/` imports `@orkestrel/timeout` after the rebuild — the
base arms every deadline — so the manifest declares it as a development dependency
([`timeout.md`](timeout.md)) for the guide's bounding pattern, which imports it as a
consumer would.

The development dependencies carry mirrors for the same reason:
[`guide.md`](guide.md) for `@orkestrel/guide`, which powers this repo's
guides-parity suite (`tests/guides.test.ts`); [`scaffold.md`](scaffold.md) for
`@orkestrel/scaffold`, which supplies the shared file set, configuration, and
audit verbs; and [`abort.md`](abort.md), [`probe.md`](probe.md),
[`router.md`](router.md), [`server.md`](server.md), [`test.md`](test.md), and
[`workspace.md`](workspace.md) for the packages this repository's examples and
test infrastructure drive.

Refresh a mirror from its own repository rather than editing it here: a rewritten
copy is a translation, and no comparison against the fetched bytes can check it.
