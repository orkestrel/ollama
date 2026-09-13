# Agent

> The conversation runtime for the `@orkestrel` line: a pluggable `ProviderInterface`
> inference boundary, the conversation layer that feeds it — messages, compaction,
> instructions, scopes, and prompt assembly — and the bounded context → provider → tools →
> repeat loop that carries a turn to its end.

An agent is a conversation with a model and the loop that carries it forward. A `Conversation` holds the history — a live tail of immutable messages plus the sections older turns were compacted into. An `AgentContext` assembles that history into the next prompt, folding in the instructions and the active workspace and applying the active scope. An `Agent` drives that prompt through a provider, dispatches whatever tools the model asks for, feeds the results back, and repeats until the model stops. Everything else in this module either configures those nouns or observes them. Source: [`src/core`](../src/core). Published through `@orkestrel/agent`.

Hand a provider a conversation and get back one assembled `ProviderResult` (`generate`), or a live stream of channel-tagged `ProviderDelta`s that returns that same assembled result when it ends (`stream`). Reasoning separation, the authority gate, and durable jobs sit around that boundary. The model itself is the one thing this package does not supply: `ProviderInterface` is a contract, not an implementation, so any backend that satisfies it drops in unchanged and the host application decides which one. Nor is there hidden global state, a plugin lifecycle, a prompt-template DSL, or an implicit memory store. This is a kit of composable primitives: the loop is the convenient way to use them, not the only one, and a caller that would rather bound and drive a provider by hand can skip it entirely.

Tools and files are borrowed, not owned. Callable tools come from [`@orkestrel/tool`](tool.md): the loop advertises their definitions to the model, dispatches the calls that come back, and feeds each `ToolResult` in as a tool message. A tool is loop machinery — it is never rendered into the prompt. Documents come from [`@orkestrel/workspace`](workspace.md): the context renders the active workspace into every turn, split by carrier — text as fenced reference blocks in the system message, images attached to the last user turn. That split is this package's own product policy, decided here because only the prompt-assembly layer knows what a turn looks like.

A turn is bounded and always terminates. One `AbortSignal` — a cancel, a [timeout](timeout.md), and a [budget](budget.md) folded together through `AbortSignal.any` — bounds the whole run, and tool iteration is capped at `limit`. A cancel is not an error: it commits a partial `AgentResult` that resolves, so only a genuine provider or tool failure rejects. `generate` and `stream` share one private run, so the one-shot result can never diverge from the live stream, and a buggy observer cannot corrupt either, because the emitter isolates a listener's throw.

## Surface

The agent-owned surface: the inference boundary, the conversation layer, the context and its managers, the loop, the authority gate, and the durable-job bridge. Tool and workspace entities belong to their originating packages and are consumed directly — never re-exported here — and the concrete `ProviderInterface` implementation belongs to the host application.

A provider turns a conversation (plus optional tools) into a turn: `generate` resolves the assembled `ProviderResult` (content + any tool calls + any usage); `stream` yields channel-tagged `ProviderDelta`s as they arrive (`content` for answer text, `thinking` for live reasoning) and returns the same assembled result when the stream completes, so a caller can render tokens / reasoning live and still get the full outcome. Both bound the call with an `AbortSignal`:

```ts
import { createAbort } from '@orkestrel/abort'
import type { ProviderInterface } from '@orkestrel/agent'

declare const provider: ProviderInterface // any concrete implementation supplied by the host app
const abort = createAbort()
const messages = [{ id: '1', role: 'user', content: 'Say hello.' }] as const

const result = await provider.generate(messages, abort.signal)
result.content // the assembled content
result.usage // { prompt, completion, total } — folds into a token budget

const generator = provider.stream(messages, abort.signal)
let step = await generator.next()
while (!step.done) {
	if (step.value.channel === 'content') process.stdout.write(step.value.text)
	if (step.value.channel === 'thinking') process.stderr.write(step.value.text)
	step = await generator.next()
}
const streamed = step.value // the assembled ProviderResult (content === the joined content deltas)
```

Pass `tools` (a non-empty `ToolDefinition[]`) to advertise callable tools for the turn; when the model calls one, `result.tools` is a `ToolCall[]` (each with a guaranteed `id`, the tool `name`, and parsed `arguments`). Aborting a `stream` mid-flight throws a `ProviderAbortError` whose `partial` holds whatever streamed before the cancel.

A tool is a JSON-Schema-described callable from [`@orkestrel/tool`](tool.md), and the loop needs exactly this from its registry: `definitions()` advertises the tools to the model, and `execute` dispatches the `ToolCall`s that come back. What returns is a `ToolResult` discriminated on `success` — an unknown name and a throwing handler both arrive as the failure arm rather than as an exception, and a batch isolates each call from its siblings, which is what lets the loop hand every outcome back to the model and let it react:

```ts
import { createTool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add([
	createTool({
		name: 'add',
		description: 'Add two numbers',
		parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
		execute: (args) => Number(args.a) + Number(args.b), // narrow the model-supplied unknown
	}),
	createTool({ name: 'now', execute: () => Date.now() }),
])

const definitions = tools.definitions() // hand these to provider.generate / .stream as `tools`
const results = await tools.execute([
	{ id: '1', name: 'add', arguments: { a: 2, b: 3 } }, // → { success: true, id: '1', name: 'add', value: 5 }
	{ id: '2', name: 'ghost', arguments: {} }, // → { success: false, id: '2', name: 'ghost', error: 'tool not found: ghost' }
])
```

Contained failure is the registry's contract, not a limitation of it: in-process code that wants a typed error calls the tool itself — `tools.tool(name)` then `tool.execute(args)` inside its own `try`/`catch`. Registration, advertising, dispatch, and error containment are documented in [`tool.md`](tool.md).

Collect a turn's conversation in an `AgentContext`. Add turns through `context.messages` — the active conversation's live tail, always present, satisfying `MessageManagerInterface` by minting each `id` on `add` and keeping stored messages immutable and in insertion order — then `build()` the provider input: `[systemMessage?, ...messages]`. `context.tools` sits beside them, but it is a different kind of thing: the other managers assemble prompt text, while the tool registry exists so the loop can advertise definitions and dispatch calls. Its contents reach the model as the `tools` argument, never as a message:

```ts
import { createAgentContext } from '@orkestrel/agent'
import type { ProviderInterface } from '@orkestrel/agent'
import { createAbort } from '@orkestrel/abort'
import { createToolManager } from '@orkestrel/tool'

declare const provider: ProviderInterface
const abort = createAbort()
const context = createAgentContext({ system: 'You are concise.', tools: createToolManager() })
context.messages.add([
	{ role: 'user', content: 'What is 2 + 3?' }, // the `id` is minted by add, not supplied
	{ role: 'user', content: 'Reply with just the number.' },
])

const input = context.build() // [{ role: 'system', content: 'You are concise.' }, …the two user turns]
const definitions = context.tools.definitions() // tools reach the provider here, NOT in `input`
const result = await provider.generate(input, abort.signal, definitions)
```

`context.messages.add` mints each message's `id` (a random UUID) and returns the created message(s); `build()` is computed fresh on every call, so it always reflects the current conversation. Without a system prompt, `build()` is only the conversation, and no tool's name, description, or parameter schema ever appears in its output.

Drive the whole turn with an `Agent` (`createAgent`) — it composes the provider, its `AgentContext`, and the tool registry into the bounded context → provider → tools → repeat loop. Seed the conversation through `agent.context.messages`, then either `generate()` for a one-shot `AgentResult` or `stream()` for a live `AgentChunk` stream (`token` answer deltas, `think` reasoning deltas, `tool` dispatches, `usage`) whose `result` resolves the same `AgentResult`. `generate` drains that same stream, so they can't diverge:

```ts
import { createAgent } from '@orkestrel/agent'
import type { ProviderInterface } from '@orkestrel/agent'
import { createTokenBudget } from '@orkestrel/budget'
import { createTool, createToolManager } from '@orkestrel/tool'

declare const provider: ProviderInterface
const tools = createToolManager()
tools.add(createTool({ name: 'add', execute: (args) => Number(args.a) + Number(args.b) }))

const agent = createAgent(provider, {
	system: 'You are concise.',
	tools,
	limit: 4, // cap tool iterations
	timeout: 30_000, // wall-clock deadline for the whole turn
	budget: createTokenBudget({ max: 50_000, scope: 'total' }), // cost ceiling
})
agent.context.messages.add({ role: 'user', content: 'Use the add tool to add 2 and 3.' })

const stream = agent.stream()
for await (const chunk of stream.events) {
	if (chunk.category === 'token') process.stdout.write(chunk.content) // live deltas
	if (chunk.category === 'think') process.stderr.write(chunk.content) // live reasoning
	if (chunk.category === 'tool') log(chunk.call, chunk.result) // a dispatched tool + its result
}
const result = await stream.result // { content, usage?, partial } — usage summed across the turn
```

Both `generate` and `stream` accept optional per-run `AgentRunOptions` — `think` and `schema` (forwarded to the provider as `ProviderStreamOptions`) plus `limit` / `timeout` / `budget` / `signal`, each overriding its `AgentOptions` construction default for this run only. Omitting one keeps the constructed default, so a caller that passes no options gets the agent it configured. A per-run `signal` composes with (never replaces) a constructed `signal` — either aborting cancels the run; a per-run `budget` is `start()`ed for that run and is the one the loop charges, leaving a constructed `budget` untouched:

```ts
const agent = createAgent(provider, { tools, limit: 10, timeout: 60_000 }) // construction defaults
agent.context.messages.add({ role: 'user', content: 'Summarize this doc.' })

// A tighter, structured-output run -- overrides limit + timeout, adds a schema, for THIS call only.
const result = await agent.generate({
	limit: 2,
	timeout: 5_000,
	schema: { type: 'object', properties: { summary: { type: 'string' } } },
})
```

`schema`, like `think`, rides into `provider.stream` as a `ProviderStreamOptions`: the loop composes both into one options object, omitting whichever key is unset, and passes no options object at all when neither is present — a provider that never received one still never does.

The turn is bounded by one cancel folded from the external `signal` + the `timeout` deadline + the `budget` signal through `AbortSignal.any`; `agent.abort(reason)` (or `stream.abort(reason)`) fires it. A cancel — external, deadline, budget, or `abort()` — commits a partial result: the `result` promise resolves with `{ partial: true, content: <what accumulated> }`, never rejects (a cancel is not an error); only a genuine provider / tool error rejects. An optional `scheduler.yield`s between turns; tool iteration is capped at `limit` (default `DEFAULT_AGENT_LIMIT`). Exhausting `limit` while the model still holds unresolved tool intent (it requested tools on the very last allowed turn) is a distinct, non-cancel cause of `partial: true` — it fires an `exhaust` event (the turns reached) instead of `abort`. A natural finish on the last allowed turn, or `limit: 0` (which never enters the loop), stays `partial: false`. `agent.status` transitions `idle` → `running` → `done` / `error`.

Gate the model's tool calls with an optional `Authority` (`createAuthority`) — a synchronous policy gate the loop consults before each call runs, passed through `AgentOptions.authority`. It walks ordered `rules` first-match-wins (a matched rule allows unless its `allowed` is `false`), falling back to a configurable default when none match — allow-unmatched by default (a denylist), or deny-by-default when its `fallback` denies (an allowlist). A denied call is never executed: the loop synthesizes the failure arm of `ToolResult` (`error: 'denied: <reason>'`) and feeds it back as a `tool` chunk and a tool message, so no handler runs, no budget is spent, and the model still sees what happened and can choose something else. An allowed call dispatches normally, and with no `authority` set every call dispatches:

```ts
import { createAgent, createAuthority } from '@orkestrel/agent'
import { createTool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add([
	createTool({ name: 'add', execute: (args) => Number(args.a) + Number(args.b) }),
	createTool({ name: 'delete', execute: (args) => drop(args.id) }),
])

// A denylist: deny `delete`, allow everything else (the default allow fallback).
const authority = createAuthority({
	rules: [
		{
			match: (c) => c.call.name === 'delete',
			zone: 'restricted',
			allowed: false,
			reason: 'read-only mode',
		},
	],
})
const agent = createAgent(provider, { tools, authority })
agent.context.messages.add({ role: 'user', content: 'Delete record 42.' })
// When the model calls `delete`, the loop feeds back { error: 'denied: read-only mode' } — never runs it.
```

Alongside the conversation store sits the standalone `InstructionManager` a richer context assembles a prompt from — named directives, keyed by `name`, listed by descending `priority`. It mirrors the registry shape — `add` (one or a batch) mints each `id` and overwrites a same-key entry (last write wins), an `instruction(name)` / `instructions()` accessor pair, `remove` (one or a batch) / `clear` / `count` — holds immutable entries, and is observable (`emitter` with an `add` / `remove` / `clear` event map, wired through the reserved `on` option; an `error` option receives a listener's throw). It carries the **build-contract** members a context's assembly step calls: `open` (the section header text, `'## Instructions'`) and `render(instruction)` (per-item rendering — the instruction's `content`):

```ts
import { createInstructionManager } from '@orkestrel/agent'

const instructions = createInstructionManager()
const safety = instructions.add({
	name: 'safety',
	content: 'Refuse unsafe requests.',
	priority: 10,
})
instructions.open // '## Instructions'
instructions.render(safety) // 'Refuse unsafe requests.'
```

Documents reach a turn one way only: through the active workspace. A [`@orkestrel/workspace`](workspace.md) workspace is a flat map of immutable files, and it takes no position on prompts — deciding how a file becomes part of a turn is this package's job, and the decision is a split by carrier. A text file renders as a fenced reference block in a `## Workspace` system section, where the model can read it as quoted material. An image file cannot be text, so its `base64` payload attaches to the last user message instead, which is where a vision model looks. A message carries that payload on its optional `images` field — `Message` and `MessageInput` both accept `readonly images?: readonly string[]` — and a vision-capable provider forwards it onto the wire (an empty or absent array is never sent). It is input-only; `ProviderResult` is unchanged.

```ts
import type { ProviderInterface } from '@orkestrel/agent'

declare const provider: ProviderInterface // a vision-capable model
const result = await provider.generate(
	[{ id: '1', role: 'user', content: 'Describe this image.', images: ['<payload>'] }],
	abort.signal,
)
```

`AgentContext` wires the instruction manager and the workspace registry in. Beyond `system`, `messages`, and `tools`, a context exposes its own `instructions` manager and `workspaces` registry — pass pre-built ones through `AgentContextOptions`, or fresh empty ones are created — and `build()` folds them into the turn. The assembly order is one leading `system` message holding the system prompt, then the non-empty instructions block (its `description` header followed by every item's `format`), then the active workspace's text files under a `## Workspace` header, joined by blank lines; then the conversation. With no instructions, no active workspace, and no scope, that reduces to exactly the lean `[systemMessage?, ...messages]`. The carrier split shows here: text rides the system block, image data rides the last user message.

````ts
import { createAgentContext } from '@orkestrel/agent'

const context = createAgentContext({ system: 'You are a code reviewer.' })
context.instructions.add({ name: 'tone', content: 'Be terse.', priority: 10 })
context.workspaces.add().write('src/main.ts', 'export const x = 1') // the active workspace
context.messages.add({ role: 'user', content: 'Review this.' })

const input = context.build()
// input[0] = { role: 'system', content:
//   'You are a code reviewer.\n\n## Instructions\n\nBe terse.\n\n## Workspace\n\nFile: src/main.ts\n```typescript\nexport const x = 1\n```' }
// input[1] = { role: 'user', content: 'Review this.' }
````

### Conversations & compaction

Above the flat `MessageManagerInterface` sits the `Conversation` (`createConversation` / a `ConversationManager`) — it owns its messages directly and compacts older ones into summarized `sections` so a long history fits a turn's context window without discarding the originals. Append turns through the conversation's own `add` (the live uncompacted tail; `message` / `messages` / `remove` / `clear` / `count` round it out); `compact()` folds the older live messages into a summarized `Section` (retaining their originals), regenerates the conversation rollup `summary`, and shrinks `view()` — the model input, where each section becomes one summary message followed by the live tail. Compaction is driven by a provider-agnostic `ConversationSummaryHandler` seam (`(messages) => Promise<string>`) the agent runtime supplies, so a `compact()` without one throws a `ConversationError`. `keep` retains a recent tail (default `DEFAULT_CONVERSATION_KEEP` = `0`, fold all); `rehydrate(id)` / `search(query)` read the retained originals:

```ts
import { createConversation } from '@orkestrel/agent'
import type { ProviderInterface } from '@orkestrel/agent'

declare const provider: ProviderInterface // any concrete implementation supplied by the host app
// The summarizer seam — built from the provider by the runtime; core stays provider-agnostic.
// Append the instruction as the FINAL user turn: a chat model emits nothing when the prompt
// ends on an assistant turn, so a leading-system instruction is unreliable.
const conversation = createConversation({
	summarize: async (messages) =>
		(
			await provider.generate(
				[
					...messages,
					{ id: 's', role: 'user', content: 'Summarize the conversation so far concisely.' },
				],
				AbortSignal.timeout(30_000),
			)
		).content,
	keep: 2, // retain the two most recent turns verbatim on each compaction
})
conversation.add([
	{ role: 'user', content: 'My name is Ada.' },
	{ role: 'assistant', content: 'Nice to meet you, Ada.' },
	{ role: 'user', content: 'What did I say my name was?' },
])

const section = await conversation.compact() // folds the older turns → a summarized section
conversation.view() // [<section summary message>, ...the retained recent tail] — the model input
conversation.summary // the regenerated rollup (a summary-of-summaries over all sections)
conversation.search('ada') // case-insensitive across sections' originals + the live tail
section && conversation.rehydrate(section.id) // the section's full original messages (a pure read)
```

Register a conversation in a `ConversationManager` and pass that registry through `AgentContextOptions.conversations` to make it the message source. `context.messages` then is the active conversation's live tail, and `build()` folds its `view()`; the conversation owns message inclusion through compaction, which is why a scope never filters messages. When the registry is omitted, the context creates one with an active default conversation.

Pass that registry through `AgentOptions.conversations` together with an `AgentOptions.window` context [`Budget`](budget.md) to enable automatic compaction. Each turn the loop estimates the current full prompt against the window and, when it reaches the ceiling, compacts the active summarizable conversation before continuing on the rebuilt view. Omit `window` and the loop does not auto-compact. See the [Contract](#contract) (the automatic-compaction clause) for the exact trigger and single-level limitation.

```ts
import { createAgent, createConversationManager, estimateMessages } from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'

const conversations = createConversationManager({ summarize, keep: 2 })
const conversation = conversations.add()
const agent = createAgent(provider, {
	conversations,
	// A context Budget: consumer = a token estimator, max = the context window. The loop measures
	// the CURRENT FULL prompt against it each turn; when the prompt reaches the window it compacts
	// + continues on the rebuilt (smaller) view (compact-and-continue), never aborts.
	window: createBudget({ max: 8_000, consumer: estimateMessages }),
})
agent.context.messages.add({ role: 'user', content: 'Hi' })
await agent.generate() // folds older turns into a section mid-run when the prompt reaches the window, then continues
```

##### One agent, many conversations (switching the active conversation)

`agent.context.conversations` is the structural message-source registry — supplied at construction and never reassigned; switch its active conversation with `conversations.switch(id)` to switch the agent's message source. `context.messages` is dynamic: it always points at the current active conversation's live tail (the same reference, no duplication) and follows a switch. The registry always has an active conversation (a default is added when it has none). This is the real app pattern: one `Agent` over a `ConversationManager` of threads, switching the active conversation per request — not an agent per thread. Each conversation accumulates its own history and compacts independently (one thread's sections never leak into another). The agent reads `context.conversations` / `context.messages` fresh on each run, so switching between runs works:

```ts
import { createAgent, createConversationManager, estimateMessages } from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'

const threads = createConversationManager({ summarize, keep: 2 }) // its defaults flow into each thread
const agent = createAgent(provider, {
	conversations: threads, // the agent's message source
	window: createBudget({ max: 8_000, consumer: estimateMessages }),
})

// Per request: make the request's thread active, append the user turn, run.
async function handle(threadId: string, text: string): Promise<string> {
	if (threads.conversation(threadId) === undefined) threads.add({ id: threadId })
	threads.switch(threadId) // SWITCH — context.messages now IS this thread's tail
	agent.context.messages.add({ role: 'user', content: text })
	return (await agent.generate()).content
}

await handle('user-1', 'Hi, I am Ada.') // thread user-1 accumulates + compacts on its own
await handle('user-2', 'What is 2 + 2?') // thread user-2 is fully independent
await handle('user-1', 'What did I say my name was?') // back to user-1 — its own history is intact
```

> **Concurrency caveat.** Switch the active conversation between runs, never during one (the loop reads the active conversation at run entry and drives it through to the end). The framework ships the switch mechanism; the app owns concurrency policy — for threads that must run concurrently, use a separate `Agent` per concurrent thread (each agent is cheap; they can share the provider and tool registry). Switching mid-flight would repoint the live run's message source under it.

##### Production behaviors of automatic compaction

Auto-compaction (the `window` budget) is hardened for a long-running app:

- **Pre-first-turn + run-entry reset.** The budget check runs before the first provider request and between turns — so a resumed or already-long conversation whose initial prompt already exceeds the window compacts immediately (not only after a tool turn). The `window` budget is reset at run entry, so no stale measurement carries across runs or a conversation switch.
- **Non-fatal, observable summarizer failure.** If the automatic `compact()`'s summarizer throws, the agent run does not crash: the loop skips compaction that turn, surfaces the error as a `fault` event (so the failure is observable, never silently lost), and continues (the over-window prompt proceeds to the provider). Only the agent's auto path is resilient — a manual `conversation.compact()` you call yourself still propagates its error.
- **Futile-compaction guard (the single-level limit).** If `compact()` folds nothing (returns `undefined`) while the prompt is still over the window — that is, the section summaries alone already exceed it — the loop stops auto-compacting for the rest of that run (a per-run latch), avoiding per-turn churn. The over-window prompt then proceeds to the provider, which surfaces a genuine context-length error if it truly cannot fit — the real limit. Compaction is single-level: it folds the live tail, never the existing sections.

```ts
agent.emitter.on('fault', (error) =>
	log('auto-compaction summarizer failed (run continues)', error),
)
```

### Scoping a turn

A `Scope` (`createScope` / a `ScopeManager`) is a named allow-list filter the context applies at `build()` time and at the loop's tool-advertise step. It carries an optional `instructions` / `tools` / `files` list keyed by each category's identity — `instructions` (by `name`), `tools` (by `name`), `files` (the active workspace's files, by `path`) — each three-way: `undefined` ⇒ no constraint (all pass), `[]` ⇒ none pass, a non-empty list ⇒ only the listed keys. Conversation messages are not scoped — the active conversation owns message inclusion through compaction (`view()`), so there is no `messages` allow-list. Apply the active filter through `context.apply(scope)`; call `context.apply(undefined)` to remove filtering. The readonly `context.scope` getter reports the current filter, and `build()` reflects whatever scope is active when it runs (recomputed fresh each call). `narrow(config)` composes a tighter child scope by set-intersection (an `undefined` side imposes no constraint), so narrowing can only tighten — a parent-excluded key never returns:

```ts
import { createAgent, createScope } from '@orkestrel/agent'

const agent = createAgent(provider, { tools }) // tools holds `search` + `delete`
agent.context.instructions.add([
	{ name: 'safety', content: 'Refuse unsafe requests.' },
	{ name: 'verbose', content: 'Explain every step.' },
])
// This turn: only the `safety` instruction, and only the `search` tool.
agent.context.apply(
	createScope({
		name: 'read-only',
		instructions: ['safety'],
		tools: ['search'],
	}),
)
const result = await agent.generate()
```

A scoped-out tool is filtered out of the `definitions()` the loop advertises, which is the only place a tool ever reaches the model — so it is neither described nor callable, not merely hidden. An `undefined` scope, or an `undefined` `tools` list, advertises every registered tool; an empty `tools` list (`[]`) advertises none. A `ScopeManager` is the optional reuse registry for named scopes (keyed by a minted `id`, so two scopes may share a `name`); it is observable like the other managers.

### Customizing the format (the cascade)

Each context section frames as `[open, ...items.map(render), close]` — a top line rendered once before the items, each item's text, and a bottom line rendered once after — with empty / absent slots dropped and the survivors blank-line (`\n\n`) joined. The slots resolve independently through a cascade, most-specific-first; each level is optional, what you omit falls through to the next, and omitting everything leaves each section on its manager's built-in framing — only the header and the items, with no closing line. From most to least specific:

1. **Item override** — `override?: string` on a single `InstructionInput`: a fully-rendered string for that item, round-tripped onto the stored entity. Beats everything for that item's `render`.
2. **Manager-options override** — `format?: ContextSectionFormat<…>` on a manager's `Options` (an `{ open?; render?; close? }` trio): a per-section open / item-render / close override for that whole manager. Beats the provider default + the built-in. A manager exposes it as the `readonly format` accessor, and its own `open` / `render(item)` already consult that override's `open` / `render` (so a manager used standalone renders with it).
3. **Provider default** — `format?: ContextFormat` on a `ProviderInterface` (keyed by section kind — the `instructions` section): the model's preferred framing. Optional — an agnostic provider supplies none, and the agent loop passes `provider.format` (often `undefined`) into `build()`.
4. **Built-in** — the manager's hardcoded `open` getter + `render(item)` method (`## Instructions` + the content) — the floor for `open` and `render`. There is no built-in `close`: an unset `close` yields no closing line.

So for a section kind `K`, manager `M`, and a provider format `F`: **open** = `M.format?.open ?? F?.[K]?.open ?? M.open` (manager-options > provider > built-in — the leading text has no per-item level); **per item** `I` = `I.override ?? M.format?.render?.(I) ?? F?.[K]?.render?.(I) ?? M.render(I)` (item > manager-options > provider > built-in); **close** = `M.format?.close ?? F?.[K]?.close` (manager-options > provider, no built-in ⇒ no closing line when unset). `open`, the rendering, and `close` resolve independently, so an override may set only the open, only the rendering, only the close, or any mix — and `open` + `close` together wrap the whole group. (The `## Workspace` text section has no cascade level of its own — it renders with the fixed `renderFencedFile` framing.)

```ts
import { createAgentContext, createInstructionManager } from '@orkestrel/agent'

// Manager-options override — wrap the instructions as a closed XML group for this manager.
const instructions = createInstructionManager({
	format: {
		open: '<rules>',
		render: (one) => `<rule>${one.content}</rule>`,
		close: '</rules>',
	},
})
const context = createAgentContext({ instructions })
context.instructions.add({ name: 'tone', content: 'Be terse.' })
// An item override beats the manager `render` for THAT item only:
context.instructions.add({
	name: 'raw',
	content: 'ignored',
	format: '<rule priority="high">Escalate.</rule>',
})

context.build()
// system block instructions section (the group wrapped by open + close):
//   '<rules>\n\n<rule>Be terse.</rule>\n\n<rule priority="high">Escalate.</rule>\n\n</rules>'
```

A provider declares its framing default by exposing `format` on its `ProviderInterface`; the `Agent` passes it into `build()` automatically. Because it is optional, no provider is forced to supply one — omitting it leaves every section on the managers' built-in framing.

### Factories

| API                               | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createConversation`              | function | Creates a conversation — a `ConversationInterface` grouping messages above a flat message store it owns directly, with compaction into summarized sections, a regenerated rollup `summary`, on-demand `rehydrate`, and substring `search`, driven by a provider-agnostic `ConversationSummaryHandler` seam.                                                                                                      |
| `createConversationManager`       | function | Creates a conversation registry — a `ConversationManagerInterface` holding `ConversationInterface`s keyed by their `id`, in insertion order, with an active pointer: the id-keyed store over the conversation layer plus the `active` / `switch` seam the context renders. `add` auto-activates the first conversation and flows the registry's default `summarize` / `keep` into every conversation it creates. |
| `createMemoryConversationStore`   | function | Creates the in-memory conversation store — a `ConversationStoreInterface` backed by a process-lifetime `Map` of `ConversationSnapshot`s keyed by conversation id, the default backing for the durable `ConversationManagerInterface.open` / `ConversationManagerInterface.save` seam. The exact twin of `createMemoryWorkspaceStore`.                                                                            |
| `createDatabaseConversationStore` | function | Creates a `DatabaseConversationStore` over any `DriverInterface`, defaulting to `createMemoryDriver()` — the durable, driver-pluggable backing for the conversation persistence seam, holding each snapshot as one opaque JSON column and standing as the opt-in twin of `createMemoryConversationStore`. The exact twin of `createDatabaseWorkspaceStore`.                                                      |
| `createInstruction`               | function | Creates an instruction — an immutable `InstructionInterface` (a named directive) from its `name` / `content` and optional `priority`, the `id` minted at construction.                                                                                                                                                                                                                                           |
| `createInstructionManager`        | function | Creates an instruction registry — an `InstructionManagerInterface` holding immutable instructions keyed by `name`, listed by descending `priority`.                                                                                                                                                                                                                                                              |
| `createScope`                     | function | Creates a named scope — an immutable `ScopeInterface` from its `name` and its per-category allow-lists, the `id` minted at construction.                                                                                                                                                                                                                                                                         |
| `createScopeManager`              | function | Creates a scope registry — a `ScopeManagerInterface` holding immutable scopes keyed by their minted `id`, in insertion order.                                                                                                                                                                                                                                                                                    |
| `createAgentContext`              | function | Creates a richer turn context — an `AgentContextInterface` assembling a provider request from the optional system prompt, the instruction registry, the workspace registry (the only document channel), the conversation registry that is its `messages` source, the tool registry, and the active scope, which `build()` folds into the next turn's input.                                                      |
| `createAgent`                     | function | Creates an agent loop — an `AgentInterface` composing a `ProviderInterface`, its `AgentContextInterface`, and a tool registry into a bounded context → provider → tools → repeat turn, exposed as a one-shot `generate` and a live `stream`.                                                                                                                                                                     |
| `createAuthority`                 | function | Creates a policy gate — an `AuthorityInterface` the agent loop consults before each tool call runs, evaluating the ordered rules first-match-wins and falling back to the configured default when none match.                                                                                                                                                                                                    |
| `createThinkSplitter`             | function | Creates a fresh stream-stateful `<think>` separator — a `ThinkSplitterInterface` that splits a thinking model's in-content `<think>…</think>` reasoning spans away from the answer, delta by delta, so a provider yields clean content alone and surfaces the accumulated reasoning as `ProviderResult.thinking`. One splitter serves one stream.                                                                |
| `createChannel`                   | function | Creates an empty unbounded async channel — a `ChannelInterface` a producer writes values into (`push`) and ends (`close` / `fail`) regardless of consumption, while a consumer reads them back live through `drain`.                                                                                                                                                                                             |
| `createAgentRegistry`             | function | Creates an agent registry — an `AgentRegistryInterface` holding the named pools of live, non-serializable pieces (providers, tools, authorities, schedulers) that a serializable `AgentJobInput`'s names resolve against, and `build`ing a seeded, signal-wired `AgentInterface` from a job.                                                                                                                     |
| `createAgentQueue`                | function | Creates a durable, bounded-concurrency agent-job queue — a `QueueInterface` over serializable `AgentJobInput`s that composes `createQueue`: each job is rehydrated through the `registry` into a live `AgentInterface`, run to its `AgentResult`, and subjected to the partial-as-configurable-failure policy.                                                                                                   |
| `createAgentRunner`               | function | Creates an agent-job runner — a `RunnerInterface` over serializable `AgentJobInput`s that composes `createRunner` (one-shot, ordered, fail-fast), each unit rehydrated through the `registry` and subjected to the partial policy. The runner also carries sub-agent fan-out: a parent job's handler can `controller.spawn(childJob)`.                                                                           |

### Classes

| API                         | Kind  | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Conversation`              | class | Represents a conversation — a live uncompacted tail of messages it owns directly above a flat message store, plus compacted, summarized `Section`s, a regenerated rollup `summary`, and a `summarizable` flag, with on-demand `rehydrate` and substring `search`, driven by a provider-agnostic `ConversationSummaryHandler` seam so `core` never imports a provider. Observable through its own `emitter`.                                                                                            |
| `ConversationManager`       | class | Registers `Conversation`s keyed by `id`, in insertion order, with an active pointer — the id-keyed store over the conversation layer, the `active` / `switch` seam the `AgentContext` renders, and the durable `open` / `save` store seam. Event-free (a registry, like `WorkspaceManager`); the observability lives on each `Conversation`.                                                                                                                                                           |
| `MemoryConversationStore`   | class | Implements the `ConversationStoreInterface` in memory — a process-lifetime `Map` of `ConversationSnapshot`s keyed by conversation id, the default store `createMemoryConversationStore` builds and the default backing for `open` / `save`. The exact twin of `MemoryWorkspaceStore`.                                                                                                                                                                                                                  |
| `DatabaseConversationStore` | class | Backs a `ConversationStoreInterface` with one table of the `databases` layer — a conversation's durable state is a row holding the snapshot as one opaque JSON column, narrowed back on `get` by `isConversationSnapshot`, so persistence reduces to keyed point-access (`get` / `set` / `delete`) over a `TableInterface`. The driver-pluggable twin of the plain-`Map` `MemoryConversationStore`, and the exact twin of `DatabaseWorkspaceStore`.                                                    |
| `Instruction`               | class | Represents an immutable named directive — an `InstructionInterface` assembled once from its input (`name` / `content`, an optional `priority` defaulting to `0`), the `id` minted at construction.                                                                                                                                                                                                                                                                                                     |
| `InstructionManager`        | class | Registers the immutable `Instruction`s a richer context assembles a directives block from — keyed by `name` so a re-`add` overwrites, last write wins, and listed by descending `priority`, carrying the `open` / `render` build contract and an observable `emitter`.                                                                                                                                                                                                                                 |
| `Scope`                     | class | Represents a named, immutable filter over a richer context's items — an optional allow-list per category (`instructions` / `tools` / `files`), each keyed by that category's identity (an instruction's `name`, a tool's `name`, a workspace file's `path`) and read as an allow-list: `undefined` lets everything pass, `[]` lets nothing pass, and a non-empty list passes the listed keys alone. `narrow` composes a tighter child by set intersection.                                             |
| `ScopeManager`              | class | Registers the named filters a richer context reuses — immutable `Scope`s keyed by their minted `id`, in insertion order, where `create` always mints and stores rather than overwriting, and an observable `emitter` reports each change.                                                                                                                                                                                                                                                              |
| `AgentContext`              | class | Assembles a provider request from the richer turn context — the optional system prompt, the observable context managers (instructions / workspaces), the `ConversationManagerInterface` message source whose active conversation is `messages`, the `ToolManagerInterface` registry, and an active `ScopeInterface` changed through `AgentContextInterface.apply`. `build()` folds the scoped managers and the active workspace into one system block, then the conversation, and never reads `tools`. |
| `Agent`                     | class | Composes a `ProviderInterface`, an `AgentContext`, and a `ToolManagerInterface` into a bounded context → provider → tools → repeat turn, exposed as both a one-shot `generate` and a live `stream` that share one private run — bounded by the run `signal`, the `timeout`, and the `budget` folded through `AbortSignal.any`, paced by `scheduler`, with tool iteration capped at `limit`.                                                                                                            |
| `Authority`                 | class | Gates the agent loop's tool calls — the synchronous policy consulted before each call runs, turning one `AuthorityContext` into an `AuthorityDecision` by walking the ordered rules first-match-wins and falling back to a configurable default, which allows an unmatched call unless its `fallback` denies.                                                                                                                                                                                          |
| `AgentRegistry`             | class | Makes a durable, JSON-serializable `AgentJobInput` runnable — holds the named pools of live, non-serializable pieces (providers, tools, authorities, schedulers), throws on a name absent from its pool, and `build`s a seeded, signal-wired `Agent` from a job's names and data.                                                                                                                                                                                                                      |
| `Channel`                   | class | Buffers chunks in a minimal unbounded async channel — the eager pump writes them in (`push`) and ends it (`close` / `fail`) regardless of consumption, while a consumer reads them back live through the `drain` async-iterator. Decoupling write from read is what lets a producer make progress without a consumer pulling, and it is why an agent's `result` settles whether or not its `events` are drained.                                                                                       |
| `ThinkSplitter`             | class | Feeds raw content deltas through a tiny stream-stateful state machine that routes everything inside a `<think>…</think>` span to `thinking` and returns everything outside it as clean content, so a provider yields the answer alone and surfaces the reasoning as `ProviderResult.thinking`. A tag split across deltas is held until disambiguated, `flush()` settles the stream end, and one splitter serves one stream.                                                                            |

### Constants

A `Shape` cell holds the constant's declared type.

| API                         | Kind  | Shape    | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ----- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONVERSATION_RECAP_PREFIX` | const | `string` | Names the framing label a `ConversationInterface`'s `view()` prefixes onto each compacted section's summary so a small model reads it as a condensed recap of earlier turns — the lean `'[Summary of earlier messages] '` marker, never a literal assistant turn to echo or treat as the live answer.                                                                                                                                                                                                                         |
| `DEFAULT_AGENT_LIMIT`       | const | `number` | Caps an `AgentInterface` turn's tool iterations by default — `10` context → provider → tools cycles before the loop stops, so a model that keeps requesting tools can never loop forever. Overridable per agent through `AgentOptions.limit`.                                                                                                                                                                                                                                                                                 |
| `DEFAULT_AUTHORITY_ZONE`    | const | `string` | Names the zone an `AuthorityInterface`'s default fallback `AuthorityDecision` carries — `'default'`, the classification for a tool call that matched no rule. Paired with the default `allowed: true` fallback, an unmatched call is allowed under this zone, so a rules list of denials acts as a denylist; a caller wanting deny-by-default supplies an `allowed: false` `fallback` of their own (see `AuthorityOptions`).                                                                                                  |
| `DEFAULT_CONVERSATION_KEEP` | const | `number` | Sets the default number of recent live messages a `ConversationInterface`'s `compact()` retains verbatim — `0`, so a manual `compact()` folds every current live message into one summarized section and keeps no tail. A caller retains a recent tail by passing `keep` (on `ConversationOptions`, `ConversationManagerOptions`, or per-fold through `CompactOptions`), folding only the older `count - keep` messages and leaving the most recent `keep` live for the next turn. Overridable everywhere `keep` is accepted. |
| `THINK_OPEN`                | const | `string` | Names the opening tag a `ThinkSplitter` recognizes as the start of an in-content reasoning span — `'<think>'`, the de-facto wire convention thinking models (qwen3, DeepSeek-R1 family) emit their chain-of-thought under when a daemon renders it inline instead of on a separate wire field. Paired with `THINK_CLOSE`.                                                                                                                                                                                                     |
| `THINK_CLOSE`               | const | `string` | Names the closing tag that ends a `THINK_OPEN` reasoning span — `'</think>'`. A span the stream never closes (the model was cut off mid-reasoning) is treated as thinking to its end, and `ThinkSplitterInterface.flush` settles it.                                                                                                                                                                                                                                                                                          |
| `WORKSPACE_SECTION_HEADER`  | const | `string` | Names the section header `AgentContext`'s `build()` renders the active workspace's text files under — `'## Workspace'`, the leading line of the dedicated workspace block in the system message and the carrier-split counterpart to the documents and images section headers.                                                                                                                                                                                                                                                |
| `MESSAGE_TOKEN_OVERHEAD`    | const | `number` | Estimates the per-message role and framing overhead `estimateMessages` adds on top of a message's content estimate — `4` tokens for the fixed wire framing every conversation turn carries (its role tag, its delimiters) that `estimateTokens`'s content-only heuristic does not otherwise capture.                                                                                                                                                                                                                          |
| `IMAGE_TOKEN_ESTIMATE`      | const | `number` | Names the coarse, deliberately approximate per-image token cost `estimateMessages` charges for each attached image — `512`, because a base64 payload's length is no reliable token proxy.                                                                                                                                                                                                                                                                                                                                     |

### Helpers

| API                    | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentResultToJSON`    | function | Projects an unknown value onto a fresh, exact `JSONValue` representation of an `AgentResult` — capturing each structural field once through a total boundary, accepting conforming accessors and inherited properties, preserving finite negative and fractional usage counts, dropping extras, and resolving `undefined` for a malformed field, a non-finite usage number, a throwing getter, or a hostile or revoked proxy. |
| `filterAllowList`      | function | Filters a list of items by a `ScopeInterface` allow-list of keys — `undefined` passes everything, `[]` passes nothing, and a non-empty list passes the listed keys alone, order preserved. The pure, total set-membership primitive the context's build step and the agent loop's tool-advertise step apply a scope through.                                                                                                  |
| `estimateTokens`       | function | Estimates the context-token footprint of a string — the deterministic `ceil(length / 4)` character heuristic `estimateMessages` sums over a conversation's messages (the default context-budget estimator).                                                                                                                                                                                                                   |
| `estimateMessages`     | function | Estimates the context-token footprint of a batch of messages — each message's content plus `MESSAGE_TOKEN_OVERHEAD`, a tool-call JSON estimate, and `IMAGE_TOKEN_ESTIMATE` for each attached image. The default `consumer` estimator for an agent's context budget (the `AgentOptions` `window`), total and never throwing, and a deliberate provider-agnostic approximation rather than an exact tokenizer count.            |
| `sanitizeToken`        | function | Sanitizes one reported token count into a safe non-negative integer — a non-finite or non-positive value becomes `0`, and a positive fractional value floors down.                                                                                                                                                                                                                                                            |
| `sanitizeUsage`        | function | Sanitizes a `TokenUsage` into safe, non-negative integers — the guard an agent's abort-usage path applies to a provider's partial usage before it is charged against a budget or folded into the run total.                                                                                                                                                                                                                   |
| `settleAgentJob`       | function | Runs one rehydrated agent and applies the partial-as-configurable-failure policy — a partial run throws an `AgentJobError` unless the `partial` policy allows it, and a natural finish resolves. The shared job-handler step `createAgentQueue` and `createAgentRunner` both settle each job through, so the policy can never diverge between them.                                                                           |
| `handleAgentQueueJob`  | function | Handles one queued agent job by rehydrating it through a registry with the queue attempt's signal, then applying the shared partial-result policy.                                                                                                                                                                                                                                                                            |
| `handleAgentRunnerJob` | function | Handles one runner agent job by fanning out its declared children, rehydrating the parent through a registry with the controller signal, and applying the shared partial-result policy.                                                                                                                                                                                                                                       |
| `renderFencedFile`     | function | Renders a path-addressed text body as a fenced reference block — a `File: <path>` label line over a language-tagged fence, the framing an `AgentContext`'s active-workspace text-file render emits.                                                                                                                                                                                                                           |
| `joinThinking`         | function | Joins the reasoning a run's provider calls separated from the answer — the first call seeds the accumulation, a later call appends blank-line separated so each turn's reasoning stays readable.                                                                                                                                                                                                                              |
| `sumUsage`             | function | Adds two `TokenUsage` values field by field — the running total an agent run keeps across its provider calls.                                                                                                                                                                                                                                                                                                                 |
| `assembleResult`       | function | Assembles the settled `AgentResult` from a run's `RunOutcome` — `thinking` and `usage` are carried only when the run surfaced them, and the loop-internal `exhausted` flag is left out.                                                                                                                                                                                                                                       |
| `denyCall`             | function | Synthesizes the denial `ToolResult` an authority-blocked call is fed back with — the call's `id` / `name` keyed back, carrying a denial `error` instead of a value.                                                                                                                                                                                                                                                           |
| `renderSection`        | function | Renders one context section — the resolved `open`, each item's rendering, and the resolved `close` when one exists, blank-line joined; `undefined` when the section has no items.                                                                                                                                                                                                                                             |
| `resolveOpen`          | function | Resolves one section's open text through the format cascade — manager-options override > provider default > built-in header.                                                                                                                                                                                                                                                                                                  |
| `resolveClose`         | function | Resolves one section's close text through the format cascade — manager-options override > provider default; `undefined` when neither sets one, because there is no built-in close.                                                                                                                                                                                                                                            |
| `resolveItem`          | function | Resolves one item's rendering through the format cascade — item override > manager-options override > provider default > built-in rendering.                                                                                                                                                                                                                                                                                  |
| `attachImages`         | function | Copies a message with image data merged onto its `images` — the message's own images first, then the attached data, carrying `calls` only when present and never mutating the original.                                                                                                                                                                                                                                       |
| `attachUserImages`     | function | Attaches image data to a conversation's last user message — the turn a vision provider reads images off — as a new array with that one message replaced by its carrying copy, and unchanged when there is no data or no user turn.                                                                                                                                                                                            |
| `collectImageData`     | function | Collects the `base64` payload of the image files in a workspace file list — the data an agent context attaches to the last user message.                                                                                                                                                                                                                                                                                      |
| `buildSummaryMessage`  | function | Builds the raw synthetic summary message for one compacted section — role `'assistant'`, the section's stable `id`, and its `summary` verbatim as content.                                                                                                                                                                                                                                                                    |
| `buildRecapMessage`    | function | Builds the framed recap message for one compacted section — the same role and stable `id` as `buildSummaryMessage`, with the content prefixed by `CONVERSATION_RECAP_PREFIX`.                                                                                                                                                                                                                                                 |
| `intersectKeys`        | function | Intersects two scope category lists under the "`undefined` is the universal set" rule — a fresh copy that can only tighten, and the primitive a scope narrows through.                                                                                                                                                                                                                                                        |

Project an agent result at its originating package before carrying it through a JSON boundary:

```ts
import { agentResultToJSON } from '@orkestrel/agent'
import type { AgentResult } from '@orkestrel/agent'

declare const result: AgentResult
const portable = agentResultToJSON(result)
if (portable === undefined) throw new Error('invalid agent result')
JSON.stringify(portable)
```

The queue and runner factories bind their named handlers to a registry and partial policy; callers composing the lower-level substrates can do the same:

```ts
import { handleAgentQueueJob, handleAgentRunnerJob, sanitizeToken } from '@orkestrel/agent'
import type { AgentRegistryInterface } from '@orkestrel/agent'

declare const registry: AgentRegistryInterface

const tokens = sanitizeToken(12.7) // 12
const queueHandler = handleAgentQueueJob.bind(undefined, registry, false)
const runnerHandler = handleAgentRunnerJob.bind(undefined, registry, false)
```

### Validators

In a guard table a `Shape` cell holds the type the guard narrows to. Each guard reads an `unknown`, returns `false` off-shape, and never throws. An error guard stays in the Errors table beside the error it narrows.

| API                      | Kind     | Shape                  | Summary                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | -------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isMessage`              | function | `Message`              | Checks whether an `unknown` is structurally a `Message` record — the per-message step of the `isConversationSnapshot` and `isSection` read-boundary narrows, where a present `calls` must be an array of valid `ToolCall`s. Total, never throwing, and never an assertion; the conversation analogue of `isFile`.                                                                       |
| `isSection`              | function | `Section`              | Checks whether an `unknown` is structurally a `Section` record — a `string` `id` and `summary` beside a `messages` array of valid `Message`s, the per-section step of the `isConversationSnapshot` read-boundary narrow. Total, never throwing, and never an assertion.                                                                                                                 |
| `isConversationSnapshot` | function | `ConversationSnapshot` | Narrows an `unknown` to a `ConversationSnapshot` — a `string` `id`, an optional `string` `summary`, and valid `sections` and `messages` arrays; the total boundary guard for an untrusted snapshot read (a storage row a `DatabaseConversationStore` reads back from its opaque JSON column, a snapshot loaded from disk), never throwing. The exact analogue of `isWorkspaceSnapshot`. |

A `DatabaseConversationStore` reads its snapshot column back as `unknown` and narrows it through the last of them, so a malformed blob resolves `undefined` rather than a broken conversation:

```ts
import { isConversationSnapshot } from '@orkestrel/agent'

declare const row: unknown
const snapshot = isConversationSnapshot(row) ? row : undefined
```

### Errors

| API                    | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProviderAbortError`   | class    | Reports a provider stream cancelled mid-flight by its bound signal — thrown by a `ProviderInterface`'s `stream`, carrying the `ProviderResult` assembled from whatever streamed before the cancel and the machine-readable `code` `'ABORT'`.                                                                                                                                                                                                                                                                      |
| `isProviderAbortError` | function | Narrows an unknown caught value to a `ProviderAbortError` through `instanceof`, so a `catch` can recover its `partial` result.                                                                                                                                                                                                                                                                                                                                                                                    |
| `AgentJobError`        | class    | Reports an `AgentInterface` run that ended `AgentResult.partial` under a `partial` policy of `false` (the default) — thrown by an agent-job handler (a `createAgentQueue` / `createAgentRunner` job), carrying the partial `AgentResult` so the failure stays inspectable, and the machine-readable `code` `'PARTIAL'`.                                                                                                                                                                                           |
| `isAgentJobError`      | function | Narrows an unknown caught value to an `AgentJobError` through `instanceof`, so a `catch` can recover its `partial` result.                                                                                                                                                                                                                                                                                                                                                                                        |
| `ConversationError`    | class    | Reports a conversation with no `ConversationSummaryHandler` to fold its messages with, or with a `sections` cap below `1` — thrown by a `ConversationInterface`'s `compact()` or its construction, carrying the machine-readable `code` `'SUMMARIZER' \| 'SECTIONS'`.                                                                                                                                                                                                                                             |
| `isConversationError`  | function | Narrows an unknown caught value to a `ConversationError` through `instanceof`, so a `catch` can branch on its `code`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `AgentError`           | class    | Reports a concurrent run that would corrupt shared per-agent accounting, or a rehydration name absent from its registry pool — thrown synchronously by an `AgentInterface`'s `stream()` (and so by `generate()`, which calls it) and by an `AgentRegistryInterface`'s accessors, carrying the machine-readable `code` `'CONCURRENCY' \| 'REGISTRY'`. Synchronous means a fire-and-forget `agent.generate().catch(…)` never catches it: `await` the call inside `try`/`catch`, or wrap the call expression itself. |
| `isAgentError`         | function | Narrows an unknown caught value to an `AgentError` through `instanceof`, so a `catch` can branch on its `code`.                                                                                                                                                                                                                                                                                                                                                                                                   |

### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`. An extended interface's name comes before `plus`, with the members it adds after.

| Type                            | Kind      | Shape                                                                                                                                                                | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MessageRole`                   | type      | `'system' \| 'user' \| 'assistant' \| 'tool'`                                                                                                                        | Names the role a `Message` plays in a conversation turn.                                                                                                                                                                                                                                                                                                                                                                                            |
| `Message`                       | interface | `{ id, role, content, calls?, images? }`                                                                                                                             | Represents one conversation turn fed to a `ProviderInterface` — a stored, identified message.                                                                                                                                                                                                                                                                                                                                                       |
| `MessageInput`                  | interface | `{ role, content, calls?, images? }`                                                                                                                                 | Carries the minimal data needed to author a `Message` — the `id` is assigned by the layer that stores it, so a caller supplies only role / content (and, for a replayed assistant turn, its `calls`).                                                                                                                                                                                                                                               |
| `ProviderResult`                | interface | `{ content, thinking?, tools?, usage? }`                                                                                                                             | Holds a single inference turn's structured outcome — the assembled assistant content, any reasoning the provider separated from it, any tool calls the model requested, and the token usage it reported.                                                                                                                                                                                                                                            |
| `ProviderDelta`                 | type      | `{ channel: 'content', text } \| { channel: 'thinking', text }`                                                                                                      | Represents one streamed delta a `ProviderInterface`'s `stream` yields — a unit tagged by the channel it belongs to, so the agent loop can re-surface answer content and live reasoning separately as it pumps.                                                                                                                                                                                                                                      |
| `ProviderStreamOptions`         | interface | `{ think?, schema? }`                                                                                                                                                | Carries the per-call options threaded into a `ProviderInterface`'s `generate` / `stream` — the bag a caller passes to influence one inference call without reconfiguring the provider instance.                                                                                                                                                                                                                                                     |
| `ProviderInterface`             | interface | `{ id, name, format? } plus generate, stream`                                                                                                                        | Defines the pluggable LLM inference boundary — the one contract every agent chunk depends on. A provider turns a conversation (plus optional tools) into either a single assembled `ProviderResult` (`generate`) or a stream of `ProviderDelta`s that returns the assembled result (`stream`).                                                                                                                                                      |
| `ThinkSplitterInterface`        | interface | `{ content, thinking } plus split, flush`                                                                                                                            | Splits a thinking model's in-content `<think>…</think>` reasoning spans away from the answer, delta by delta with per-stream state, so a provider yields clean content alone and surfaces the reasoning as `ProviderResult.thinking`.                                                                                                                                                                                                               |
| `ContextSectionFormat`          | interface | `{ open?, render?, close? }`                                                                                                                                         | Overrides one context section's format — an `open` / `render` / `close` trio that frames a section in the `AgentContext` build cascade: a top line rendered once before the items, a per-item rendering, and a bottom line rendered once after the items.                                                                                                                                                                                           |
| `ContextFormat`                 | interface | `{ instructions? }`                                                                                                                                                  | Holds a provider's optional context-framing default, keyed by section kind — the framing a model prefers (for example XML tags against Markdown headers), declared by a `ProviderInterface` that opts in.                                                                                                                                                                                                                                           |
| `ContextSectionSourceInterface` | interface | `{ open, format } plus render`                                                                                                                                       | Exposes the manager surface one context section's format cascade reads — its built-in `open` / `render`, plus the raw options override the cascade layers a provider default beneath; `InstructionManagerInterface` satisfies it structurally.                                                                                                                                                                                                      |
| `MessageManagerInterface`       | interface | `{ count } plus add, message, messages, remove, clear`                                                                                                               | Stores immutable `Message`s in insertion order and mints each `id` on `add` — the message-store contract `AgentContextInterface.messages` is typed to, which the active `ConversationInterface` satisfies structurally.                                                                                                                                                                                                                             |
| `InstructionInterface`          | interface | `{ id, name, content, priority, override? }`                                                                                                                         | Represents an immutable instruction — a named directive a richer context places between the system prompt and the conversation, ordered by descending `priority`.                                                                                                                                                                                                                                                                                   |
| `InstructionInput`              | interface | `{ name, content, priority?, override? }`                                                                                                                            | Carries the minimal data to author an `InstructionInterface` — the `id` is minted by the `InstructionManagerInterface` that stores it, so a caller supplies only `name` / `content` (and an optional `priority`, defaulting to `0`).                                                                                                                                                                                                                |
| `InstructionManagerEventMap`    | type      | `{ add, remove, clear }`                                                                                                                                             | Maps the push observation surface of an `InstructionManagerInterface` — the mutation moments a fire-and-forget observer subscribes to through `manager.emitter.on`.                                                                                                                                                                                                                                                                                 |
| `InstructionManagerOptions`     | interface | `{ on?, error?, format? }`                                                                                                                                           | Configures `createInstructionManager` — the reserved `on` hooks plus an optional per-section format override.                                                                                                                                                                                                                                                                                                                                       |
| `InstructionManagerInterface`   | interface | `{ emitter, count, open, format } plus add, instruction, instructions, render, remove, clear`                                                                        | Registers `InstructionInterface`s keyed by `name` — `add` (one or a batch) mints each `id` and overwrites a same-name instruction, last write wins, while `instructions()` lists them sorted by descending `priority` and stable for ties.                                                                                                                                                                                                          |
| `ScopeFilter`                   | interface | `{ instructions?, tools?, files? }`                                                                                                                                  | Lists the per-category allow-lists a `ScopeInterface` carries — an optional `readonly string[]` for `instructions`, for `tools`, and for `files`, each keyed by that category's identity (an instruction's `name`, a tool's `name`, a workspace file's `path`) and read as an allow-list: `undefined` lets everything pass, `[]` lets nothing pass, and a non-empty list passes the listed keys alone.                                              |
| `ScopeInput`                    | interface | `ScopeFilter plus { name }`                                                                                                                                          | Carries the data to author a `ScopeInterface` — a `ScopeFilter` plus the required `name` (a human label; the `id` is minted by the layer that stores it).                                                                                                                                                                                                                                                                                           |
| `ScopeInterface`                | interface | `ScopeFilter plus { id, name } plus narrow`                                                                                                                          | Represents a named, immutable filter over a richer context's items — the per-category allow-lists (`ScopeFilter`) plus an `id` / `name`, and a `narrow` that composes a tighter child by set intersection.                                                                                                                                                                                                                                          |
| `ScopeManagerEventMap`          | type      | `{ create, remove, clear }`                                                                                                                                          | Maps the push observation surface of a `ScopeManagerInterface` — analogous to `InstructionManagerEventMap`, but keyed by the minted `id` and carrying `create` (a scope always mints, never overwrites) rather than `add`.                                                                                                                                                                                                                          |
| `ScopeManagerOptions`           | interface | `{ on?, error? }`                                                                                                                                                    | Configures `createScopeManager` — the reserved `on` hooks: initial listeners for the manager's `ScopeManagerEventMap`, wired at construction.                                                                                                                                                                                                                                                                                                       |
| `ScopeManagerInterface`         | interface | `{ emitter, count } plus create, scope, scopes, remove, clear`                                                                                                       | Registers reusable `ScopeInterface`s keyed by their minted `id` — `create` mints + stores one (never overwrites), `scopes()` lists them in insertion order.                                                                                                                                                                                                                                                                                         |
| `AgentContextOptions`           | interface | `{ system?, tools?, instructions?, workspaces?, scope?, conversations? }`                                                                                            | Configures `createAgentContext` — the optional system prompt plus the pre-built managers to reuse: an `instructions` registry, a `workspaces` registry (the only document channel), a `conversations` registry (the message source), a `tools` registry (the loop's advertise and dispatch surface), and an initial `scope`.                                                                                                                        |
| `AgentContextInterface`         | interface | `{ system, instructions, workspaces, messages, conversations, tools, scope } plus apply, build`                                                                      | Assembles a turn's provider input from the system prompt + the context managers + the conversation, applying the active scope per category.                                                                                                                                                                                                                                                                                                         |
| `AgentStatus`                   | type      | `'idle' \| 'running' \| 'done' \| 'error'`                                                                                                                           | Names the lifecycle state of an `AgentInterface` turn — `idle` before a run, `running` while the loop is in flight, then the settled `done` (a normal finish or a cancel) or `error` (a genuine provider / tool failure).                                                                                                                                                                                                                           |
| `AgentChunk`                    | type      | `{ category: 'token', content } \| { category: 'think', content } \| { category: 'tool', call, result } \| { category: 'usage', usage }`                             | Represents a streamed step of an agent turn — the union the loop yields as it runs, discriminated by the `category` of step it carries, and the pull surface beside the push `AgentEventMap`.                                                                                                                                                                                                                                                       |
| `AgentEventMap`                 | type      | `{ start, turn, tool, usage, deny, finish, error, abort, exhaust, fault }`                                                                                           | Maps the push observation surface of an `AgentInterface` — the lifecycle, usage, and tool moments a fire-and-forget observer (logging, metrics, tracing) subscribes to, beside the pull `AgentChunk` stream.                                                                                                                                                                                                                                        |
| `AgentResult`                   | interface | `{ content, thinking?, usage?, partial }`                                                                                                                            | Holds the settled outcome of an agent turn — the assembled assistant `content`, the `usage` summed across the turn's provider calls, and whether it was committed `partial`.                                                                                                                                                                                                                                                                        |
| `RunOutcome`                    | interface | `{ content, thinking, usage, partial, exhausted }`                                                                                                                   | Holds the immutable per-run outcome an `AgentInterface`'s loop settles on — the value its run returns, assembled from there into the `AgentResult` its `stream`'s `result` promise resolves.                                                                                                                                                                                                                                                        |
| `ChannelInterface`              | interface | `{} plus push, close, fail, drain`                                                                                                                                   | Buffers values in an unbounded async channel — a producer writes them in (`push`) and ends it (`close` / `fail`) regardless of consumption, while a consumer reads them back live through `drain`.                                                                                                                                                                                                                                                  |
| `StreamInterface`               | interface | `{ events, result } plus abort`                                                                                                                                      | Pairs a live event stream with the eventual settled result and a cancel — the generic pull/streaming handle a long-running operation hands back.                                                                                                                                                                                                                                                                                                    |
| `AgentStreamInterface`          | type      | `StreamInterface<AgentChunk, AgentResult>`                                                                                                                           | Names the agent turn's live handle — a `StreamInterface` of `AgentChunk`s resolving an `AgentResult`.                                                                                                                                                                                                                                                                                                                                               |
| `AgentOptions`                  | interface | `{ on?, error?, system?, tools?, instructions?, workspaces?, scope?, limit?, timeout?, budget?, scheduler?, signal?, authority?, conversations?, window?, strict? }` | Configures `createAgent` — the loop's bounds and pacing, the reserved `on` hooks, the construction-time context wiring (`instructions` / `workspaces` / `scope`), the `conversations` registry that is the message source, the context `window` budget that opts into automatic compaction of the active conversation, and the `strict` switch that aborts the run on an automatic-compaction summarizer failure instead of the lenient default.    |
| `AgentRunOptions`               | interface | `{ think?, schema?, limit?, timeout?, budget?, signal? }`                                                                                                            | Carries the per-run override bag an `AgentInterface`'s `generate` / `stream` accepts — each member overrides the matching `AgentOptions` value for one run, where `think` and `schema` forward to the provider call and `signal` composes with the constructed one.                                                                                                                                                                                 |
| `AgentInterface`                | interface | `{ emitter, id, status, context } plus generate, stream, abort`                                                                                                      | Composes a `ProviderInterface`, an `AgentContextInterface`, and a `ToolManagerInterface` into a bounded context → provider → tools → repeat turn.                                                                                                                                                                                                                                                                                                   |
| `AuthorityContext`              | interface | `{ call }`                                                                                                                                                           | Carries what an `AuthorityInterface` evaluates for one tool call — the call under consideration.                                                                                                                                                                                                                                                                                                                                                    |
| `AuthorityDecision`             | interface | `{ zone, allowed, reason? }`                                                                                                                                         | Holds an `AuthorityInterface`'s verdict on one tool call.                                                                                                                                                                                                                                                                                                                                                                                           |
| `AuthorityRule`                 | interface | `{ match, zone, allowed?, reason? }`                                                                                                                                 | Represents one ordered policy rule an `AuthorityInterface` evaluates.                                                                                                                                                                                                                                                                                                                                                                               |
| `AuthorityOptions`              | interface | `{ rules?, fallback? }`                                                                                                                                              | Configures `createAuthority` — the ordered rules and the no-match fallback.                                                                                                                                                                                                                                                                                                                                                                         |
| `AuthorityInterface`            | interface | `{} plus evaluate`                                                                                                                                                   | Gates each tool call before it runs — the synchronous policy that turns one `AuthorityContext` into an `AuthorityDecision`.                                                                                                                                                                                                                                                                                                                         |
| `AgentJobInput`                 | interface | `{ provider, messages, system?, tools?, authority?, scheduler?, limit?, timeout?, budget?, children? }`                                                              | Represents a JSON-serializable agent job — the descriptor a durable queue or runner runs. Its non-serializable pieces (the provider, tools, authority, scheduler) are referenced by name and resolved to live objects through an `AgentRegistryInterface` at handler time, while its data fields (the seed `messages`, `system`, `limit`, `timeout`, and a token `budget` ceiling) carry directly.                                                  |
| `AgentRegistryInterface`        | interface | `{} plus provider, tool, authority, scheduler, build`                                                                                                                | Resolves an `AgentJobInput`'s names to the live, non-serializable pieces and rehydrates a seeded, signal-wired `AgentInterface` — the bridge that makes a durable, serializable job runnable.                                                                                                                                                                                                                                                       |
| `AgentRegistryOptions`          | interface | `{ providers, tools?, authorities?, schedulers?, store? }`                                                                                                           | Configures `createAgentRegistry` — the named pools of live, non-serializable pieces an `AgentJobInput`'s names resolve against, plus the optional durable `store` every built agent's conversation manager shares.                                                                                                                                                                                                                                  |
| `AgentQueueOptions`             | interface | `{ registry, partial?, concurrency?, retries?, timeout?, store? }`                                                                                                   | Configures `createAgentQueue` — the registry that rehydrates jobs, the partial-result policy, and the substrate knobs threaded into the backing `createQueue`.                                                                                                                                                                                                                                                                                      |
| `AgentRunnerOptions`            | interface | `{ registry, partial?, concurrency?, retries?, timeout? }`                                                                                                           | Configures `createAgentRunner` — the registry that rehydrates jobs, the partial-result policy, and the substrate knobs threaded into the backing `createRunner`.                                                                                                                                                                                                                                                                                    |
| `ConversationSummaryHandler`    | type      | `(messages: readonly Message[]) => Promise<string>`                                                                                                                  | Summarizes a conversation, provider-agnostically — the seam the agent runtime supplies so core never imports a provider. Given the folded messages, it resolves their digest, the model-written summary used to summarize a compacted `Section` and to regenerate a `ConversationInterface`'s rollup `summary`.                                                                                                                                     |
| `Section`                       | interface | `{ id, summary, messages }`                                                                                                                                          | Holds a slice of folded messages digested into a summary — the unit of compaction a `ConversationInterface` produces when it `compact`s its live tail.                                                                                                                                                                                                                                                                                              |
| `ConversationEventMap`          | type      | `{ compact, summary, rehydrate, collapse }`                                                                                                                          | Maps the push observation surface of a `ConversationInterface` — the compaction moments a fire-and-forget observer subscribes to through `conversation.emitter.on`.                                                                                                                                                                                                                                                                                 |
| `ConversationOptions`           | interface | `{ id?, on?, error?, summarize?, keep?, sections?, snapshot? }`                                                                                                      | Configures `createConversation` — the optional `id`, the reserved `on` hooks, the provider-agnostic `summarize` seam, the retained-tail size, an optional cap on the compacted `sections` list, and a `ConversationSnapshot` to hydrate from.                                                                                                                                                                                                       |
| `CompactOptions`                | interface | `{ keep?, sections? }`                                                                                                                                               | Configures one `ConversationInterface.compact` call — the retained-tail size, the `sections` cap, or both, overridden for one fold.                                                                                                                                                                                                                                                                                                                 |
| `ConversationReferenceOptions`  | interface | `{ label?, summary?, messages? }`                                                                                                                                    | Configures `ConversationInterface.reference` — how to render one conversation as a self-labeled, fenced provenance block to pull into another conversation by writing it to the active context's active workspace: `label` defaults to the `id`, `summary` defaults to `true`, and `messages` are cherry-picked excerpts defaulting to none.                                                                                                        |
| `ConversationInterface`         | interface | `{ id, emitter, summary, sections, summarizable, count } plus add, message, messages, remove, clear, view, compact, rehydrate, search, reference, snapshot`          | Groups messages above the flat `MessageManagerInterface` — a live uncompacted tail plus compacted, summarized `Section`s and a conversation rollup `summary`, with on-demand `rehydrate`, substring `search`, a cross-conversation `reference`, and a JSON `snapshot`, driven by a provider-agnostic `ConversationSummaryHandler` seam; `summarizable` reports whether that seam was supplied, and the agent loop gates automatic compaction on it. |
| `ConversationInput`             | interface | `{ id?, summarize?, keep?, sections?, on?, snapshot? }`                                                                                                              | Carries the data to author a `ConversationInterface` through a `ConversationManagerInterface` — the optional `id`, a `summarize` override, a `keep` override, a `sections` cap override, the reserved `on` hooks, and a `ConversationSnapshot` to hydrate from.                                                                                                                                                                                     |
| `ConversationManagerOptions`    | interface | `{ summarize?, keep?, sections?, store? }`                                                                                                                           | Configures `createConversationManager` — the default `ConversationSummaryHandler`, retained-tail size, and `sections` cap the conversations it creates inherit, plus the optional durable `store` backing `open` / `save`.                                                                                                                                                                                                                          |
| `ConversationManagerInterface`  | interface | `{ count, active } plus conversation, conversations, add, switch, open, save, remove, clear`                                                                         | Registers `ConversationInterface`s keyed by their `id`, in insertion order, with an active pointer — the id-keyed store over the conversation layer, the `active` / `switch` seam the `AgentContextInterface` renders, and the durable `open` / `save` store seam. Event-free (a registry, like `WorkspaceManagerInterface`); the observability lives on each `ConversationInterface`.                                                              |
| `ConversationSnapshot`          | interface | `{ id, summary?, sections, messages }`                                                                                                                               | Holds a JSON-serializable snapshot of a conversation's state — its `id`, the rollup `summary`, the compacted `sections`, and the live tail `messages` — the durable payload the `ConversationStoreInterface` persists. The exact analogue of `WorkspaceSnapshot`.                                                                                                                                                                                   |
| `ConversationStoreInterface`    | interface | `{} plus get, set, delete`                                                                                                                                           | Persists a `ConversationSnapshot` durably — the async `get` / `set` / `delete` primitives, keyed by a conversation id and holding no expiry, the exact analogue of `WorkspaceStoreInterface`.                                                                                                                                                                                                                                                       |
| `ConversationSnapshotRow`       | interface | `{ id, snapshot }`                                                                                                                                                   | Represents one row of the table a `DatabaseConversationStore` persists — a conversation `id` plus its `ConversationSnapshot` held as one opaque JSON column, read back as `unknown` and narrowed on `get`. The exact analogue of `WorkspaceSnapshotRow`.                                                                                                                                                                                            |

Agent-owned readonly data members stay in the preceding Surface tables; their call-signature methods are documented under [`## Methods`](#methods). Tool contracts resolve to [`tool.md`](tool.md) and workspace contracts to [`workspace.md`](workspace.md) — neither dependency surface is duplicated or re-exported here. Note where the boundary falls inside the context: `instructions`, `conversations`, and `workspaces` are the managers `build()` renders a prompt from, while `tools` is loop machinery for advertising and dispatch and is never read by `build()` at all.

## Methods

The tables list every public call-signature member of `ProviderInterface`, `ThinkSplitterInterface`, `MessageManagerInterface`, `InstructionManagerInterface`, `ContextSectionSourceInterface`, `ScopeInterface`, `ScopeManagerInterface`, `AgentContextInterface`, `AgentInterface`, `StreamInterface`, `ChannelInterface`, `AuthorityInterface`, `AgentRegistryInterface`, `ConversationInterface`, `ConversationManagerInterface`, `ConversationStoreInterface`, `MemoryConversationStore`, and `DatabaseConversationStore`. Their readonly data members remain Surface rows. `ThinkSplitter`, `InstructionManager`, `Scope`, `ScopeManager`, `AgentContext`, `Agent`, `Authority`, `AgentRegistry`, `Conversation`, and `ConversationManager` implement their interfaces exactly, so the tables also describe those classes' instance methods. The store classes implement `ConversationStoreInterface` and keep explicit tables because their class names have no same-name interface contracts. `MessageManagerInterface` has no separate concrete class here: the active `Conversation` satisfies it structurally. A host application supplies the concrete `ProviderInterface`. Tool and workspace methods live in their dependency guides.

#### `ProviderInterface`

`generate` produces one complete turn; `stream` yields `ProviderDelta`s and returns the assembled result. Both take the conversation, a bounding `AbortSignal`, optional `tools`, and optional per-call `ProviderStreamOptions`.

| Method     | Returns                                         | Summary                                                                                                                                                                                                                                                                                                                                |
| ---------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate` | `Promise<ProviderResult>`                       | Generates one complete turn — resolves the assembled `ProviderResult`.                                                                                                                                                                                                                                                                 |
| `stream`   | `AsyncGenerator<ProviderDelta, ProviderResult>` | Streams one turn — yields channel-tagged `content` / `thinking` `ProviderDelta`s as they arrive and returns the assembled `ProviderResult` (the concatenated content, any separated reasoning, any tool calls, and any usage) when the stream completes. A mid-stream abort throws a `ProviderAbortError` carrying the partial result. |

#### `ThinkSplitterInterface`

The stream-stateful `<think>…</think>` separator a provider routes raw content deltas through, so it yields clean content and surfaces the reasoning as `ProviderResult.thinking`. The `content` / `thinking` data members (the authoritative clean-content + reasoning accumulations) stay Surface rows — `content` matters because some chat templates pre-seed `<think>` into the prompt scaffold (the qwen3 shape), so only a bare `</think>` ever appears on the wire: before any tag event, that bare close reclassifies everything surfaced so far into `thinking` (one-shot — afterwards a bare close is plain text), correcting `content` retroactively where the already-returned deltas cannot be recalled. One splitter serves one stream — create a fresh one per call (`createThinkSplitter`).

| Method  | Returns  | Summary                                                                                                                                                                                                          |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `split` | `string` | Feeds one raw delta and returns the clean, non-think content to surface for it (possibly `''`) — a tag split across deltas is held until disambiguated, never leaked as content and never mis-eaten as thinking. |
| `flush` | `string` | Settles the stream end — a held partial tag that never completed returns as the final content delta, and an unclosed think span's tail lands on `thinking`.                                                      |

#### `MessageManagerInterface`

The immutable conversation store. `add` mints each message's `id` and carries batch overloads (one input → one message, a batch → the array); `remove` carries batch overloads (one or a list). The `count` data member stays a Surface row.

| Method     | Returns                          | Summary                                                                                                                                       |
| ---------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`      | `Message` / `readonly Message[]` | Stores one `MessageInput`, or a batch — mints each message's `id` and returns the created message or messages; a stored message is immutable. |
| `message`  | `Message \| undefined`           | Looks up one stored message by id (`undefined` when absent).                                                                                  |
| `messages` | `readonly Message[]`             | Lists every stored message, in insertion order.                                                                                               |
| `remove`   | `boolean`                        | Removes one message by id, or a batch — `true` only when every supplied id was removed.                                                       |
| `clear`    | `void`                           | Removes every stored message.                                                                                                                 |

#### `InstructionManagerInterface`

The name-keyed instruction registry a richer context renders a directives block from. `add` mints each `id` and carries batch overloads (a re-`add` of the same name overwrites it, last write wins); `remove` carries batch overloads. The `emitter` / `count` / `open` / `format` data members stay Surface rows.

| Method         | Returns                                                    | Summary                                                                                                                |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `add`          | `InstructionInterface` / `readonly InstructionInterface[]` | Adds one `InstructionInput`, or a batch — mints each `id`; a re-`add` of the same name overwrites it, last write wins. |
| `instruction`  | `InstructionInterface \| undefined`                        | Looks up one instruction by name (`undefined` when absent).                                                            |
| `instructions` | `readonly InstructionInterface[]`                          | Lists every instruction, sorted by descending `priority` (stable for equal priorities).                                |
| `render`       | `string`                                                   | Renders one instruction for the prompt — its `content`.                                                                |
| `remove`       | `boolean`                                                  | Removes one instruction by name, or a batch — `true` only when every supplied name was removed.                        |
| `clear`        | `void`                                                     | Removes every instruction.                                                                                             |

#### `ContextSectionSourceInterface`

The manager surface one section's format cascade reads. `render` is its only method — the `open` (the built-in header) and `format` (the raw manager-options override) data members stay Surface rows. An `InstructionManagerInterface` satisfies it structurally, which is what lets `resolveOpen` / `resolveClose` / `resolveItem` stay independent of which manager supplies the section.

| Method   | Returns  | Summary                                                                                                                  |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `render` | `string` | Renders one section item, already resolved against the manager-options override and otherwise on the built-in rendering. |

#### `ScopeInterface`

The named, immutable allow-list filter. `narrow` is the only method — the `id` / `name` data members and the per-category allow-lists stay Surface rows.

| Method   | Returns          | Summary                                                                                                                                                                                                          |
| -------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `narrow` | `ScopeInterface` | Composes a tighter child scope — each category is the set intersection of this scope's list and `config`'s (an `undefined` side imposing no constraint), returned as a new scope that leaves this one unchanged. |

#### `ScopeManagerInterface`

The id-keyed registry of reusable named scopes. `create` mints + stores a scope (always adds — never overwrites, since two scopes may share a `name`); `remove` carries batch overloads. The `emitter` / `count` data members stay Surface rows.

| Method   | Returns                       | Summary                                                                                                                      |
| -------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `create` | `ScopeInterface`              | Mints a scope from a `ScopeInput` (an `id` plus the per-category allow-lists) and stores it — always adds, never overwrites. |
| `scope`  | `ScopeInterface \| undefined` | Looks up one scope by id (`undefined` when absent).                                                                          |
| `scopes` | `readonly ScopeInterface[]`   | Lists every scope, in insertion order.                                                                                       |
| `remove` | `boolean`                     | Removes one scope by id, or a batch — `true` only when every supplied id was removed.                                        |
| `clear`  | `void`                        | Removes every scope.                                                                                                         |

#### `AgentContextInterface`

The richer turn context. `apply` changes the active per-turn filter and `build` assembles the provider input. The `system` / `instructions` / `messages` / `tools` / `scope` / `workspaces` / `conversations` readonly data members stay Surface rows.

| Method  | Returns              | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply` | `void`               | Applies the given scope as the active per-turn filter; passing `undefined` explicitly removes filtering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `build` | `readonly Message[]` | Builds the provider input for the next turn: a leading `system` message folding the prompt, the scope-filtered instructions (each section's header and each item's rendering resolved through the format cascade), and the active workspace's scope-filtered (`scope.files`) text files as fenced reference blocks in a `## Workspace` section, then the active conversation's `view()`, with the active workspace's image files' `base64` payload attached to the last user message. Takes an optional `format` — typically `provider.format`, the provider level of the cascade — and omitting it with no overrides set renders each section on its manager's built-in framing. The `system` message is prepended only when some part of it exists, the workspace render covers the active workspace alone, tools are advertised structurally rather than in the prompt, and the input is built fresh on each call. |

#### `AgentInterface`

The bounded agent loop. `generate` and `stream` share one private run (`generate` drains the same stream `stream` exposes, so they can't diverge); `abort` cancels the in-flight turn. The `emitter` / `id` / `status` / `context` data members stay Surface rows (`emitter` is a `readonly` accessor — a property, not a method).

| Method     | Returns                | Summary                                                                                                                                                                               |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate` | `Promise<AgentResult>` | Runs the turn to completion, discarding the live chunks — drains the shared stream and resolves the settled `AgentResult` (`partial: true` when cancelled).                           |
| `stream`   | `AgentStreamInterface` | Runs the turn as a live stream — iterate `events` for `AgentChunk`s and `await result` for the settled outcome; `result` resolves partial on a cancel and rejects on a genuine error. |
| `abort`    | `void`                 | Cancels the in-flight turn — fires the turn's signal; the `result` settles `partial: true` with whatever content accumulated.                                                         |

#### `StreamInterface`

The generic live handle pairs its `events` and `result` data members with a cancellation method. `AgentStreamInterface` specializes it for `AgentChunk` and `AgentResult`.

| Method  | Returns | Summary                                                   |
| ------- | ------- | --------------------------------------------------------- |
| `abort` | `void`  | Cancels the in-flight operation — fires its bound signal. |

#### `ChannelInterface`

The unbounded async channel. A producer writes with `push` and ends it with `close` or `fail`; a consumer reads it back live with `drain`. Write and read are decoupled, so the producer never waits for a consumer — an agent's eager pump writes each chunk into one, which is why the run's `result` settles whether or not `events` is ever drained. It carries no data members.

| Method  | Returns                   | Summary                                                                                                                                |
| ------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `push`  | `void`                    | Writes one value — buffered, then handed to a parked consumer; a value pushed at an already-parked reader is delivered, never dropped. |
| `close` | `void`                    | Ends the channel normally — a draining consumer returns once the buffer is empty.                                                      |
| `fail`  | `void`                    | Ends the channel with a failure — a draining consumer throws it once the buffer is empty; the first failure wins.                      |
| `drain` | `AsyncGenerator<T, void>` | Reads the values back live, in write order — returning on `close` and throwing on `fail`.                                              |

Buffered values are always delivered before the end is reported, so a `close` or `fail` arriving alongside the last values still hands them over first:

```ts
import { createChannel } from '@orkestrel/agent'

const channel = createChannel<number>()
channel.push(1)
channel.close()
for await (const value of channel.drain()) {
	value // 1
}

const failing = createChannel<number>()
failing.push(2)
failing.fail(new Error('upstream died')) // the 2 is delivered, then the drain throws
```

#### `AuthorityInterface`

The synchronous policy gate the agent loop consults before each tool call. `evaluate` is the only method — it has no data members.

| Method     | Returns             | Summary                                                                                                                                                               |
| ---------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluate` | `AuthorityDecision` | Evaluates one tool call against the ordered rules — returns the first matching rule's verdict, which allows unless `allowed: false`, or the fallback when none match. |

#### `AgentRegistryInterface`

The job-rehydration bridge. `provider` / `tool` / `authority` / `scheduler` resolve a name against their pool (throwing `unknown <category>: <name>` on a miss); `build` rehydrates a seeded, signal-wired agent from a serializable job. It has no data members.

| Method      | Returns              | Summary                                                                                                                                                                                                               |
| ----------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`  | `ProviderInterface`  | Resolves a registered `ProviderInterface` by name — throws `unknown provider: <name>` when absent.                                                                                                                    |
| `tool`      | `ToolInterface`      | Resolves a registered `ToolInterface` by name — throws `unknown tool: <name>` when absent.                                                                                                                            |
| `authority` | `AuthorityInterface` | Resolves a registered `AuthorityInterface` by name — throws `unknown authority: <name>` when absent.                                                                                                                  |
| `scheduler` | `SchedulerInterface` | Resolves a registered `SchedulerInterface` by name — throws `unknown scheduler: <name>` when absent.                                                                                                                  |
| `build`     | `AgentInterface`     | Rehydrates a live, seeded `AgentInterface` from a serializable `AgentJobInput` — resolving its names, rebuilding its token budget, seeding its conversation, and wiring `signal`; a name absent from its pool throws. |

#### `ConversationInterface`

A conversation that owns its live message tail directly (the flat store verbs folded in, like a `Workspace` owns its files). `add` mints each message's `id` and stores it (batch overloads); `message` / `messages` look up the live tail; `remove` / `clear` drop from it. `view` is the model input; `compact` folds the older live messages into a summarized `Section` (regenerating the rollup, emitting `summary` then `compact`); `rehydrate` / `search` read the retained originals; `reference` renders this conversation as a provenance-labeled block to pull into another (a pure string, no model call). The `id` / `emitter` / `summary` / `sections` / `count` data members stay Surface rows (`emitter` is a `readonly` accessor — a property, not a method).

| Method      | Returns                          | Summary                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`       | `Message` / `readonly Message[]` | Appends one `MessageInput` to the live tail, or a batch — mints each message's `id` (a random UUID) and returns the created message or messages; a stored message is immutable.                                                                                                                                                                                                                                            |
| `message`   | `Message \| undefined`           | Looks up one live message by id (`undefined` when absent).                                                                                                                                                                                                                                                                                                                                                                 |
| `messages`  | `readonly Message[]`             | Lists every live, uncompacted message in the tail, in insertion order.                                                                                                                                                                                                                                                                                                                                                     |
| `remove`    | `boolean`                        | Removes one live message by id, or a batch, from the tail — `true` only when every supplied id was removed.                                                                                                                                                                                                                                                                                                                |
| `clear`     | `void`                           | Empties the live tail, leaving the compacted `sections` untouched.                                                                                                                                                                                                                                                                                                                                                         |
| `view`      | `readonly Message[]`             | Builds the model input for the next turn — each section as one synthetic recap message, its summary prefixed with `CONVERSATION_RECAP_PREFIX` so a small model reads it as a recap rather than a literal turn, then the live tail verbatim; the rollup `summary` is not injected.                                                                                                                                          |
| `compact`   | `Promise<Section \| undefined>`  | Folds the oldest `count - keep` live messages into a summarized `Section` through the `ConversationSummaryHandler`, removes them from the live tail, regenerates the rollup, and emits `summary` then `compact` — resolving `undefined` when nothing folds (`count <= keep`). Throws a `ConversationError` when no summarizer was supplied.                                                                                |
| `rehydrate` | `readonly Message[]`             | Returns a section's full original messages — a pure read that emits `rehydrate`, empty for an unknown id and never reinserting.                                                                                                                                                                                                                                                                                            |
| `search`    | `readonly Message[]`             | Searches `content` for a case-insensitive substring across every message — each section's retained originals, then the live tail.                                                                                                                                                                                                                                                                                          |
| `reference` | `string`                         | Renders this conversation as a self-labeled, fenced provenance block to pull into another conversation — a pure string with no model call: a leading `[Reference — conversation "<label>" — NOT part of this conversation]` marker, the rollup `Summary:` when `summary` is not `false` and a rollup exists, and the cherry-picked excerpts (`- role: content`) when `messages` is supplied. `label` defaults to the `id`. |
| `snapshot`  | `ConversationSnapshot`           | Serializes this conversation to a plain, JSON-serializable `ConversationSnapshot` — its `id`, the rollup `summary`, the compacted `sections`, and the live tail; the live `summarize` / `keep` are configuration re-supplied on hydrate rather than serialized.                                                                                                                                                            |

#### `ConversationManagerInterface`

The id-keyed registry of `Conversation`s with an active pointer. `add(input?)` mints a conversation (flowing the manager's default `summarize` / `keep` in unless the input overrides them) and auto-activates the first one; a later `add` leaves `active` unchanged. `switch(id)` re-points `active` (an unknown `id` returns `undefined`, leaving `active` unchanged — lenient, never throws); `remove` carries batch overloads (the array overload first) and clears `active` when the removed conversation was active. The `count` and `active` data members stay Surface rows (`active` is a `readonly` accessor — a property, not a method); the manager is event-free (each conversation owns its `emitter`).

| Method          | Returns                                       | Summary                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation`  | `ConversationInterface \| undefined`          | Looks up one conversation by id (`undefined` when absent).                                                                                                                                                                                          |
| `conversations` | `readonly ConversationInterface[]`            | Lists every conversation, in insertion order.                                                                                                                                                                                                       |
| `add`           | `ConversationInterface`                       | Mints a conversation, taking its `id` from the input or a fresh UUID and flowing the manager's default `summarize` / `keep` in unless the input overrides them — auto-activates the first, and an already-present `id` overwrites, last write wins. |
| `switch`        | `ConversationInterface \| undefined`          | Re-points `active` at the conversation with `id` and returns it; an unknown `id` returns `undefined` and leaves `active` unchanged, never throwing.                                                                                                 |
| `open`          | `Promise<ConversationInterface \| undefined>` | Resolves a conversation by id and activates it — from the registry when present, else hydrated from the optional `ConversationStoreInterface` (`store`); `undefined` when it is neither registered nor stored.                                      |
| `save`          | `Promise<boolean>`                            | Persists a registered conversation's `ConversationInterface.snapshot` to the optional `ConversationStoreInterface` (`store`) — `true` when persisted, `false` when there is no store or the id is unknown, and never throwing.                      |
| `remove`        | `boolean`                                     | Removes one conversation by id, or a batch — `true` only when every supplied id was removed; clears `active` when a removed conversation was the active one.                                                                                        |
| `clear`         | `void`                                        | Removes every conversation and clears `active`.                                                                                                                                                                                                     |

#### `ConversationStoreInterface`

The persistence contract stores a `ConversationSnapshot` under its own identity.

| Method   | Returns                                      | Summary                                                                                                                          |
| -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `get`    | `Promise<ConversationSnapshot \| undefined>` | Resolves the persisted snapshot for `id`, or `undefined` if none is stored.                                                      |
| `set`    | `Promise<void>`                              | Inserts or replaces a snapshot under its own `snapshot.id` (no separate id param — mirroring `WorkspaceStoreInterface`'s `set`). |
| `delete` | `Promise<void>`                              | Drops a snapshot by id; an absent id is a no-op (no throw).                                                                      |

#### `MemoryConversationStore`

The in-memory implementation keeps an explicit table because its class name has no same-name interface contract.

| Method   | Returns                                      | Summary                                                                                                                          |
| -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `get`    | `Promise<ConversationSnapshot \| undefined>` | Resolves the persisted snapshot for `id`, or `undefined` if none is stored.                                                      |
| `set`    | `Promise<void>`                              | Inserts or replaces a snapshot under its own `snapshot.id` (no separate id param — mirroring `WorkspaceStoreInterface`'s `set`). |
| `delete` | `Promise<void>`                              | Drops a snapshot by id; an absent id is a no-op (no throw).                                                                      |

#### `DatabaseConversationStore`

The driver-backed implementation keeps an explicit table because its class name has no same-name interface contract.

| Method   | Returns                                      | Summary                                                                                                      |
| -------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `get`    | `Promise<ConversationSnapshot \| undefined>` | Resolves the persisted snapshot for `id`, narrowing the opaque JSON column back to a `ConversationSnapshot`. |
| `set`    | `Promise<void>`                              | Inserts or replaces under the snapshot's own `id` (no separate id param) — the row is `{ id, snapshot }`.    |
| `delete` | `Promise<void>`                              | Drops a snapshot by id; an absent id is a no-op (no throw).                                                  |

## Contract

These invariants hold across `src/core` ↔ `agent.md`:

1. **Doc ↔ source bijection.** Every `function` / `class` / `const` / `interface` / `type` row in the `## Surface` tables is a real export of `src/core`, and every export appears as a Surface row — exhaustive, both directions.
2. **`ProviderInterface` is the abstract inference boundary.** A provider turns a conversation (plus optional `tools`, a non-empty `ToolDefinition[]`) into a turn: `generate` resolves the assembled `ProviderResult`, `stream` yields channel-tagged `ProviderDelta`s and returns the assembled result. Both methods accept optional `ProviderStreamOptions`; `think` is the per-call reasoning override. It carries an `id` (a per-instance trace label) and `name` (the backend identifier). This module defines only the contract — a concrete implementation is a host application's responsibility.
3. **`stream` yields deltas + returns the assembled result.** A `ProviderInterface.stream` yields each non-empty answer delta as `{ channel: 'content', text }` and each native live reasoning delta as `{ channel: 'thinking', text }`; its return value is the assembled `ProviderResult` whose `content` is the provider's authoritative clean answer, plus any tool calls and usage the turn reported. So a caller can render tokens and reasoning live while still recovering the complete outcome from the generator's return value. A thinking model's reasoning is separated at the provider, never assembled as content: a concrete provider routes its raw wire content through a `ThinkSplitter` (`createThinkSplitter` — one per stream), yields the clean content, assembles `content` from the splitter's authoritative accumulation (an implicit pre-seeded open — the qwen3-template bare `</think>` — reclassifies the already-yielded prefix into thinking, the one shape where live content deltas can transiently over-report), and surfaces the accumulated reasoning as `ProviderResult.thinking` — which never re-enters the conversation (the `Agent` joins it across a run's calls onto `AgentResult.thinking` as display/audit metadata).
4. **Usage reuses `TokenUsage`.** `ProviderResult.usage` is the [budgets](budget.md) `TokenUsage` shape (`{ prompt, completion, total }`), imported not redefined, present only when the turn reported it — so a caller folds it straight into a token budget. A provider surfaces it when the wire carries it (for example a stream's `done` line / a non-stream body) and omits it otherwise.
5. **Bounded by an `AbortSignal`.** Both `generate` and `stream` take an `AbortSignal`, so a caller bounds the request — a cancel, a [timeout](timeout.md), and a token [budget](budget.md) folded into one signal through `AbortSignal.any`. An already-aborted signal rejects the call before any content streams. (How a concrete provider also arms its own deadline is that implementation's own contract.)
6. **Abort → `ProviderAbortError` with the partial.** A `stream` cancelled mid-flight throws a `ProviderAbortError` whose `partial` is the `ProviderResult` assembled from whatever streamed so far (content + any tool calls + any usage); `isProviderAbortError` narrows a caught value so the loop can recover the partial content. A non-abort error propagates unchanged. `ProviderAbortError` is the abstract boundary's error — it stays in this module so the agent loop catches it regardless of which backend is in use.
7. **The message-store contract (`MessageManagerInterface`).** `MessageManagerInterface` is the immutable message-store contract `AgentContextInterface.messages` is typed to — `count` + `add` / `message` / `messages` / `remove` / `clear`. It has no concrete class in this module: the active `Conversation` (which owns its live tail directly) satisfies it structurally, so `context.messages` is the active conversation (the conversation-layer clause). `add` takes one `MessageInput` or a batch and mints each message's `id` (`crypto.randomUUID()`), carrying the input's `role` / `content` and `calls` only when supplied (an absent `calls` is omitted, never present-but-undefined) — returning the created message(s). A stored message is immutable: assembled once from its input and never mutated, and the object `add` returns is the same one `message(id)` later resolves. `count` is the live tail size, `message(id)` looks one up (`undefined` when absent), `messages()` lists them in insertion order, `remove` (one or a batch) returns `true` only when every supplied id was removed, and `clear` empties it.
8. **The richer turn context (`AgentContext`).** `AgentContext` composes the optional `system` prompt; the agent-owned `instructions` / `conversations` managers; a `WorkspaceManagerInterface` consumed from `@orkestrel/workspace`; `messages` (the active conversation's live tail); a `ToolManagerInterface` consumed from `@orkestrel/tool` solely for provider advertising and call dispatch; and a readonly active `scope`. Each omitted manager is created fresh, and the context ensures the conversation registry has an active default, so `messages` is always defined. `build()` folds the system prompt, scope-filtered instructions, and the active workspace's scope-filtered text files (the active-workspace clause) into one leading `system` message, then appends the active conversation's `view()`. The tool registry is the one member `build()` never reads: it is loop machinery for advertising and dispatch, not a prompt-context manager, so no tool renders into the prompt. The result is computed fresh on every call and never mutates a manager or stored message.
9. **Scope filtering + image attachment.** A `Scope` is a named allow-list filter with one list per category (`instructions` by `name`, `tools` by `name`, `files` by the active workspace file's `path`), each three-way through `filterAllowList`: `undefined` ⇒ all pass, `[]` ⇒ none, a non-empty list ⇒ only-listed. `build()` applies the active `scope` to the instruction + workspace-file categories before rendering them (`scope.files` filters the active workspace's `files()` before the carrier split — the active-workspace clause). Conversation messages are deliberately not a scope category: the active conversation owns message inclusion through compaction (the active-conversation clause), so its `view()` is authoritative and a second, competing message filter would only let them disagree. `narrow(config)` composes a tighter child by set-intersection over every category's list (an `undefined` side imposes no constraint — `undefined ∩ list = list`, `undefined ∩ undefined = undefined`), so narrowing only tightens. The active workspace's scoped-in image files' `base64` payload is attached to the last user message (rebuilt as a copy carrying the merged `images`, never mutating the stored message; skipped when no user message exists — the active workspace is the sole image source); `build()` still returns `readonly Message[]`. **Tools stay structural, never in the prompt.** The loop hands the model its tools through `tools.definitions()` (the `tools` argument to `provider.generate` / `.stream`), not by serializing them — and it filters those definitions by the active `scope.tools` first (through `filterAllowList`), so a scoped-out tool is neither advertised nor callable (the model never sees it). `AgentContext.build()`'s output therefore never contains a tool's `name`, `description`, `parameters`, or definition, scoped or not. A `ScopeManager` (`createScopeManager`) is the optional reuse registry of named scopes, keyed by a minted `id` (two scopes may share a `name`), observable like the other managers.
10. **The agent loop (`Agent` / `createAgent`).** `Agent` composes a `ProviderInterface`, an `AgentContext`, and its `@orkestrel/tool` registry into the bounded context → provider → tools → repeat turn. It builds the provider input, then iterates up to `limit`: stream a provider turn, accumulate content/thinking/usage, append any assistant tool calls, and execute them. Each discriminated `ToolResult` becomes a tool message whose content is `JSON.stringify(result.value)` when `result.success` is true and `result.error` when false, so failure text is never JSON-quoted. A final assistant turn stops the loop.
11. **One `#run` shared by `generate` + `stream`.** A single private async generator drives the whole turn. `stream()` exposes it as an `AgentStreamInterface` (`events` + `result` + `abort`); `generate()` drains that same stream (iterating `events`, discarding chunks) and returns its `result` — it has zero loop logic of its own, so `generate` and `stream` can never diverge (a `generate()` result deep-equals draining `stream()` on the same input).
12. **The `AgentChunk` stream.** `stream().events` yields, per turn, each content delta as `{ category: 'token', content }`, each live reasoning delta as `{ category: 'think', content }`, then optional usage, then one `{ category: 'tool', call, result }` per dispatched call. The call and discriminated result use the contracts imported from `@orkestrel/tool`. `result` resolves the settled `AgentResult`: final or partial content, joined thinking, summed optional usage, and `partial`.
13. **Bounded, paced, capped.** Each run arms one cancel through `createAbort({ signal: AbortSignal.any([…]) })` folding whichever of the external `signal`, the `timeout` deadline (a started `Timeout`), and the `budget` signal (a started `Budget`) are present; `agent.abort(reason)` / `stream.abort(reason)` fires it, and the timeout is always cleared in a `finally`. A cancel — external, deadline, budget, or `abort()` — stops the loop and the `result` promise resolves `{ partial: true, content: <accumulated> }`; it is not an error. The accumulated `content` already holds whatever streamed before the cancel — the loop accumulates each delta as it yields the `token` chunk, and a `ProviderAbortError.partial.content` is exactly those same yielded deltas (the `stream` contract), so the loop never re-adds it. A genuine provider / tool error (the signal is not aborted) rejects the `result` (and `status` → `error`). The optional `scheduler.yield({ signal })`s between turns (before turns 2…N, never after the last); tool iteration is capped at `limit` so the loop always terminates. `status` transitions `idle` → `running` → `done` / `error`.
14. **Pull and push observation surfaces on the `Agent`; the rest event-free.** The provider contract, the tool registry, the conversation store, and the `AgentContext` itself carry no Emitter, no `EventMap`, no `on` hook — they stay purely functional (of the managers the context composes, the `InstructionManager` and `ScopeManager` carry their own `emitter`s and each `Conversation` owns one, while the `ToolManager`, `WorkspaceManager`, and `ConversationManager` are event-free — as is the context that composes them). The `Agent` itself carries both a pull and a push surface. Pull: the `AgentChunk` stream (`stream().events`) yields per-token answer deltas, per-think reasoning deltas, usage chunks, and tool chunks for a live consumer. Push: the `emitter` (`AgentEventMap`) — `start` (run begins), `turn` (each iteration), `tool` (a dispatched call + result), `usage` (a turn's usage), `deny` (an authority denial — not in the chunk stream), `finish` (the settled result), `error` (a genuine failure), `abort` (a cancel), `exhaust` (a limit exhausted with unresolved tool intent — fires instead of `abort`), and `fault` (a non-fatal automatic-compaction summarizer throw — the run continues; the automatic-compaction clause) — wired through the emitter pattern (`AgentOptions.on` hooks, the `AgentOptions.error` listener-error handler, a `readonly emitter`, `new Emitter({ on: options?.on, error: options?.error })`). Per-token / per-thinking deltas are the stream's job exclusively — there is deliberately no `token` or `think` event. The emitter isolates a listener throw (it can never escape into the settle-once / wake-park loop) and routes it to its own `error` handler (the `error` option, surfaced as `(error, event)`, not a domain event; itself guarded against re-entrancy), so observation is provably side-effect-free on the 3×-hardened loop — and every emit sits after the relevant state transition / settle, so it cannot reorder control flow. A cancelled run emits `abort` (the cancel reason) then `finish` (the settled partial); a genuine error emits `error` instead of `finish`. The loop's deterministic logic is pinned in the `src:core` mirror with a scripted `ProviderInterface`.
15. **Doc ↔ source method bijection.** The `## Methods` tables list exactly the public methods of every agent-owned interface named there, exhaustive in both directions, and each agent-owned concrete class exposes the same public methods as its interface. `MessageManagerInterface` is implemented structurally by the active `Conversation`; `ProviderInterface` is implemented by the host. Dependency method surfaces belong to [`tool.md`](tool.md) and [`workspace.md`](workspace.md).
16. **The authority gate (`Authority` / `createAuthority`).** An optional `Authority` is the synchronous policy gate consulted before each tool call runs — passed through `AgentOptions.authority`. `evaluate({ call })` walks its ordered `rules` first-match-wins: the first rule whose `match(context)` is true decides as `{ zone: rule.zone, allowed: rule.allowed ?? true, reason: rule.reason }` (a matched rule allows unless its `allowed` is explicitly `false`); when none match it returns the `fallback`, which defaults to `{ zone: DEFAULT_AUTHORITY_ZONE, allowed: true }` (allow-unmatched — a rules list of denials acts as a denylist; pass an `allowed: false` `fallback` to flip the gate to deny-by-default, an allowlist). The matcher receives the `AuthorityContext` (`{ call }`), so a rule can branch on the call's `name` and its `arguments`. Synchronous — `evaluate` returns the verdict directly. Event-free.
17. **A denied call is fed back, never executed (the gate's effect on the loop).** With no `authority` set, the loop sends calls straight through the tool registry. With one set, allowed calls run as a batch and each denied call becomes the `@orkestrel/tool` failure union arm `{ success: false, id, name, error }` without executing the tool. Executed results and denials merge back into original call order, so every denial still produces a tool chunk and unquoted failure-text tool message the model can react to. The gate lives in the `Agent`, not the dependency registry.
18. **Durable, serializable agent jobs (`AgentJobInput` + `AgentRegistry`).** An `AgentJobInput` is a JSON-serializable descriptor — not a live agent: its non-serializable pieces (the `provider`, `tools`, `authority`, `scheduler`) are referenced by name and its data (`messages`, `system`, `limit`, `timeout`, a token `budget` ceiling, nested `children`) carries directly. An `AgentRegistry` (`createAgentRegistry`) holds the named pools (`providers` required; `tools` / `authorities` / `schedulers` optional) and `build(input, signal?)` rehydrates a live, seeded `Agent`: it resolves the `provider`, assembles a fresh `ToolManager` from the `tools` names, rebuilds the token `budget` from its ceiling (`createTokenBudget({ max })`), resolves the `authority` / `scheduler` names, constructs the agent with `system` / `limit` / `timeout` and the threaded `signal`, and seeds its context with the `messages`. Because the descriptor is serializable, a job survives a crash through a Queue's `store` + `restore()` — the registry rehydrates the live pieces from the names on the way back in. An unknown name throws an `AgentError` carrying `code: 'REGISTRY'` and the message `unknown <category>: <name>`, never a silent `undefined`.
19. **Partial = configurable failure (`partial`).** An `Agent.generate()` resolves `partial: true` on a cancel (abort / budget / timeout) — a cancel is not an error. For a durable job that is, by default, a failure: the `createAgentQueue` / `createAgentRunner` handler throws an `AgentJobError` (carrying the partial `AgentResult`), so the Queue's retries re-run the job and a Runner's fail-fast aborts its siblings. Pass `partial: true` to treat a partial as success instead — the handler resolves the partial result rather than throwing. `isAgentJobError` narrows a caught value to recover its `partial`.
20. **Bounded concurrency + retries + persistence by composing the substrate (no new engine).** `createAgentQueue` returns a `QueueInterface<AgentJobInput, AgentResult>` built by `createQueue`: its handler `(input, context) => registry.build(input, context.signal).generate()` + the partial policy is the only new logic — bounded `concurrency`, `retries`, the per-attempt `timeout`, and the durable `store` (+ `restore()`) all belong to the `@orkestrel/queue` `Queue`. `createAgentRunner` returns a `RunnerInterface<AgentJobInput, AgentResult>` built by `@orkestrel/workflow`'s `createRunner` (one-shot, ordered, fail-fast). No second concurrency / orchestration engine is written; the verified `Agent` loop + `Authority` gate are untouched. Layering is `agent → (queue, workflow)` with no cycle.
21. **Sub-agent fan-out through `controller.spawn`; cancellation threaded.** On a `createAgentRunner`, each unit's handler receives a `ControllerInterface`; before running the (parent) job it `controller.spawn`s each of the job's declared `children` (fire-and-track, never inline-awaited — a slot-holding bounded handler awaiting its own spawn can deadlock), so each child is a real sub-agent run through the same bounded queue whose result joins the run after the declared jobs (in spawn order). `createAgentQueue` ignores `children` (a queue has no fan-out). Cancellation threads through in both: the handler passes `context.signal` (queue) / `controller.signal` (runner) into `registry.build`, so a queue / runner `abort()` or a per-attempt timeout fires the rehydrated agent's signal (which commits a partial — the `partial` policy then decides). All event-free.
22. **The conversation layer (`Conversation` + `ConversationManager`).** A `Conversation` groups messages above the flat `MessageManager`: `messages` is the live uncompacted tail (a real `MessageManagerInterface` a caller appends turns to), `sections` are the compacted history (oldest → newest), and `summary` is the rollup (`undefined` until the first compaction). Compaction folds older messages into summarized `Section`s through a provider-agnostic `ConversationSummaryHandler` seam — `compact(options?)` determines `keep` (`options.keep ?? the conversation's keep ?? DEFAULT_CONVERSATION_KEEP` = `0`), folds the oldest `count - keep` live messages (a no-op resolving `undefined` when `count <= keep`), summarizes that slice into a section (`id` minted, `summary` the seam's output, `messages` the retained originals), removes those messages from the live tail by id, regenerates the rollup (a second seam call over all section summaries), and emits `summary` then `compact` — a summarizer call for the folded slice and another for the rollup. `compact()` throws a `ConversationError` (`code: 'SUMMARIZER'`) when no summarizer was supplied (a conversation can still store + `view()` without one). `summarizable` is `true` exactly when a summarizer was supplied — the clean signal the agent loop's automatic compaction gates on (the automatic-compaction clause), so a non-summarizable conversation is never auto-compacted and the auto path never throws this error; a manual `compact()` still throws. `view()` is the model input — each section as one synthetic recap message (role `'assistant'`, keyed by the section's stable `id`), then the live messages verbatim (the rollup `summary` is not injected). Each recap's content is the section summary prefixed with `CONVERSATION_RECAP_PREFIX` (`'[Summary of earlier messages] '`) so a small model reads it as a condensed recap of earlier turns, not a literal assistant turn it must echo or treat as the live answer — a deliberately lean label (a fixed handful of tokens; the rollup regeneration in `compact()` re-reads the UNframed section summaries, the label being a `view()`-only presentation concern). `rehydrate(id)` returns a section's full original messages (`[]` for an unknown id) and emits `rehydrate` — a pure read (the caller decides whether to re-add them; `rehydrate` never reinserts). `search(query)` is a case-insensitive substring scan of `content` across all messages (every section's originals, then the live tail). `reference(options?)` renders this conversation as a self-labeled, fenced cross-conversation provenance block — a pure string (no model call) to pull into another conversation by writing it to the active context's active workspace: a leading `[Reference — conversation "<label>" — NOT part of this conversation]` marker (`label` defaults to the `id`), the rollup `Summary:` line when `options.summary !== false` and a rollup exists, and the cherry-picked `Relevant messages:` excerpts (each `- role: content`) when `options.messages` is supplied (default none). It frames foreign content so a small model attributes it to its source rather than reading it as part of the live thread; the cherry-pick comes from this conversation's own `search` / `rehydrate`, never its whole history. Observable: the owned `emitter` (`ConversationEventMap` — `compact` / `summary` / `rehydrate`) isolates a listener throw, routing it to its `error` handler (the `error` option), never corrupting a compaction. `ConversationManager` (`createConversationManager`) is the id-keyed registry with an active pointer (the `active` / `switch` seam the `AgentContext` renders): `add(input?)` mints a conversation flowing the manager's default `summarize` / `keep` in unless the input overrides them (an already-present `id` overwrites) and auto-activates the first one (a later `add` leaves `active`); `switch(id)` re-points `active` (an unknown `id` is a lenient `undefined`, leaving `active` unchanged); `conversation(id)` / `conversations()` look up; `remove` (one or a batch) reports `true` only when every supplied id was removed and clears `active` when the removed one was active; `clear` empties it and clears `active`; `count`. It carries the durable `open(id)` / `save(id)` seam over an optional `ConversationManagerOptions.store` (the durable-store clause) and `Conversation.snapshot()` serializes a conversation to a JSON `ConversationSnapshot`. It is event-free (each conversation owns its `emitter`). `estimateTokens(text)` is the deterministic `ceil(length / 4)` char heuristic (it never calls a provider) that `estimateMessages(messages)` sums over a message batch — the default `consumer` estimator for an agent's context `window` budget (the automatic-compaction clause), not a conversation member. The layer's deterministic logic is pinned in the `src:core` mirror with a data-stub summarizer.
23. **`AgentContext` folds the active conversation's view; the message source is the readonly `conversations` registry.** `messages` is the `conversations` registry's active conversation — always defined: at construction the context ensures the registry has an active conversation, `add`ing a default one when it has none. The dynamic `context.messages` getter returns that active conversation itself (the same reference it exposes — no duplication; computed on every read, so it follows `conversations.switch(id)`, with no captured copy), and `build()` folds that conversation's `view()` (the per-section summaries + the live tail) as the authoritative message inclusion — the conversation owns inclusion through compaction, so there is no competing scope category for messages; scope still filters instructions / tools / workspace files, and the active workspace's scoped-in image-data attachment to the last user message still applies to the view output. With the default (uncompacted) conversation, the message path is exactly the lean `[systemMessage?, ...messages]`. The registry is structural: supply it through `AgentContextOptions.conversations` and change its active conversation through `manager.switch(id)`. **Multi-conversation.** Because `context.messages` / `context.conversations` are read dynamically and the `Agent` reads them fresh on each run, one agent switches its active conversation between runs to serve many conversations from its `conversations` registry (the real app pattern — `manager.switch(id)` per request, creating through `manager.add({ id })` when absent, not an agent per thread): each conversation accumulates its own history and (with `window`, the automatic-compaction clause) compacts independently, one thread's sections never leaking into another. Switch between runs, never during one (the loop drives the run-entry active conversation to completion); for concurrent threads use a separate `Agent` per thread — the framework ships the switch mechanism, the app owns concurrency policy. The `Agent` forwards its `AgentOptions.conversations` straight into this context as the message source; the auto-compaction trigger over the active conversation lives in the loop (the automatic-compaction clause).
24. **Automatic compaction — the context `window` budget (opt-in, additive, production-hardened).** `AgentOptions.window` is a context [`Budget`](budget.md) (`BudgetInterface<readonly Message[]>`) for automatic conversation compaction, enabled only when both a `window` budget is set and the active conversation is `summarizable` (it has a summarizer — the conversation-layer clause). There is always an active conversation (the active-conversation clause), but the default one has no summarizer, so this `summarizable` gate preserves the shipped behavior: a non-summarizable conversation is never auto-compacted, and the auto path never throws the `compact()` `SUMMARIZER` error. Its `consumer` is a pluggable token estimator (for example the exported `estimateMessages`) and its `max` is the context window — the same consume-to-a-ceiling primitive as the cost `budget` (the bounded-paced-capped clause), but its ceiling action is compact instead of abort. The loop's private `#trim` runs the check at these points: (1) before the first provider request (so a resumed / already-long conversation whose initial prompt already exceeds the window compacts at once, not only after a tool turn), and (2) between turns on the tool-iteration `continue` path (after the prior turn's `usage` was folded and its assistant + tool messages were appended, before the next provider request; never after the final assistant turn that ends the loop). The `window` budget is reset (`clear()`) at run entry, so no stale `consumed` carries across runs or a conversation switch. Each check measures the absolute current prompt: it `clear()`s the budget then `consume`s the working message array — the exact next prompt (the system block + the active conversation's `view()` + this turn's appended messages, that is, what the next `provider.stream` will receive) — so `window.consumed` is the current full prompt's estimated footprint and `window.exhausted` means that prompt has reached the context window `max`. When the prompt `exhausted`s the window, `#trim` `await`s `conversation.compact()` (folding the older live tail into a summarized `Section` through the conversation's own `ConversationSummaryHandler`), then rebuilds the working message array from `context.build(provider.format)` — the same projection the loop opened with — so the run continues on the (now smaller) compacted context. No post-compact `clear()` is needed: the next check's `clear()` + `consume` re-measures the now-shrunken prompt. This is distinct from the hard `budget` ceiling (the bounded-paced-capped clause), which aborts the run with a partial. **Production hardening:** (a) non-fatal summarizer failure — the automatic `compact()` is wrapped in try/catch: a thrown summarizer error does not crash the run; the loop skips compaction that turn, surfaces the error as a `fault` event (so it is observable, never silently lost), and continues (the over-window prompt proceeds to the provider). Only the auto path is resilient — a manual `conversation.compact()` still propagates its error. (b) futile-compaction guard (the single-level limit) — when `compact()` resolves `undefined` (nothing left to fold) while the prompt is still over the window (the section summaries alone exceed it), a per-run flag latches so auto-compaction stops for the rest of that run (no per-turn churn); the over-window prompt then proceeds to the provider, which surfaces a genuine context-length error if it truly cannot fit (the real limit) — the loop does not loop futilely. The whole path is opt-in: with no `window` budget, or a non-summarizable active conversation, `#trim` (the run-entry reset, the pre-first-turn check, the between-turns check) is skipped entirely, adding no `await` before the first provider request, so a cost-budget-only agent's eager-pump and abort timing are untouched. Observability is the conversation's own `compact` / `summary` events (the conversation-layer clause) plus the agent's `fault` (the `strict` clause). These limits are deliberate: the automatic summarizer call is the conversation's configured one and is not separately bound to the run's abort signal; and compaction is single-level, so a conversation whose section summaries alone exceed `window` cannot shrink further — the futile guard stops the churn rather than pretending otherwise. The deterministic behavior (the absolute prompt crossing `max`, the fold, the rebuilt-smaller prompt, the pre-first-turn fold, the non-fatal `fault` path, the futile guard, no-fire below the ceiling) is pinned in the `src:core` mirror with a scripted provider, a data-stub (and a throwing) summarizer, and the real `estimateMessages` estimator, including a run forced through two or more folds that stays coherent.

25. **`context.workspaces` — active workspace rendering by carrier.** `AgentContextInterface.workspaces` is the readonly `WorkspaceManagerInterface` supplied from `@orkestrel/workspace`, or a fresh dependency manager when omitted. `build()` reads only its active workspace, fresh each call, and filters that workspace's files through `scope.files`. The dependency's `isText` narrows text files, which render under `WORKSPACE_SECTION_HEADER` through the agent-owned `renderFencedFile` helper; the image carrier is `isBinary(file.content) && file.content.mime.startsWith('image/')`, and matching base64 data attaches to the last user message. With no active workspace, nothing renders. Both halves of that split are this package's own decision and belong here: `@orkestrel/workspace` holds files without knowing what a prompt is, and only the assembly layer knows that a model reads text as quoted material and images off a user turn. What agent does not own is the workspace domain itself — creation, editing, events, snapshots, and stores all stay in the originating package.

26. **The durable `ConversationStore` + the manager's `open` / `save` seam.** A `ConversationSnapshot` is the plain JSON payload `{ id, summary?, sections, messages }`; live summarizer/configuration functions are re-supplied when hydrating. `Conversation.snapshot()` creates it, and `ConversationInput.snapshot` restores identity, summary, sections, and live tail without emitting edit events. `isConversationSnapshot` is the total read-boundary guard for unknown storage values. `ConversationStoreInterface` persists that one payload through `get(id)`, `set(snapshot)`, and `delete(id)`, with no TTL. `MemoryConversationStore` keeps snapshots in a process-lifetime map; `DatabaseConversationStore` stores each snapshot in one opaque JSON column and narrows it on read. `ConversationManager.open(id)` activates a registry hit or hydrates a store hit; `save(id)` persists a registered snapshot and returns `false` when no store or conversation exists. The real stores, driver, guard, snapshot hydration, and manager semantics are pinned in the core tests.

27. **Limit exhaustion, mid-stream budget metering, per-run bounds, and per-run `schema`.** `RunOutcome.exhausted` (and the settled outcome's `partial`) flips `true` when the turn loop exhausts the effective `limit` while the most recently completed turn still held unresolved tool intent (the model requested tools on the very last allowed turn) — a cause distinct from a cancel: it fires the `exhaust` event (carrying the effective `limit`) instead of `abort`, still followed by `finish` carrying the partial result. A natural final answer on the last allowed turn, or `limit: 0` (which never enters the loop), stays `partial: false` with no `exhaust`. **Mid-stream budget charging.** During each provider turn, `#provide`'s `onDelta` re-estimates the turn's accumulated content through `estimateTokens` (`ceil(length / 4)`) and `budget.consume`s only the increment over what was already charged this turn (`{ prompt: 0, completion: increment, total: increment }`) — so the budget trip can land mid-stream, before the turn's final `usage` is known; the tripped signal folds into the run's bound abort exactly like any other cancel (the run resolves `partial: true` with an `abort` event, the provider genuinely cancelled). Once the turn's `usage` is known, a residual reconcile charges the remainder (`{ prompt: usage.prompt, completion: max(0, usage.completion - charged), total: max(0, usage.total - charged) }`), so the turn's total budget draw nets to exactly the authoritative usage — never double-charged, never lost. The reported `AgentResult.usage` / `usage` chunks are always the full authoritative usage, unaffected by how the budget was charged. **Per-run overrides (`AgentRunOptions`).** `limit` / `timeout` / `budget` / `signal` each override their `AgentOptions` construction default for this run only (`??` semantics — an omitted key keeps the constructed default); a per-run `signal` composes with (never replaces) a constructed `signal` through `AbortSignal.any` — either aborting cancels the run; a per-run `budget` is `start()`ed for that run and is the one the loop charges, leaving a constructed `budget` untouched for that run. **Per-run `schema`.** `AgentRunOptions.schema` (and `ProviderStreamOptions.schema`) mirrors `think` — a per-run structured-output constraint forwarded to `provider.stream`. `#provide` composes `think` and `schema` into one options object, omitting whichever key is `undefined`, and passes no options object at all when both are absent.

28. **`AgentOptions.instructions` / `.workspaces` / `.scope` — construction-time context wiring.** These mirror the identically-named `AgentContextOptions` fields (the richer-turn-context clause) and forward straight into the `AgentContext` the constructor builds: `instructions` a pre-built `InstructionManagerInterface` (an empty one created when omitted), `workspaces` a pre-built `WorkspaceManagerInterface` (a fresh empty one when omitted), and `scope` the initial active `ScopeInterface` (`undefined` ⇒ no filtering). They are construction sugar: the same result is reachable by building an `AgentContext` first and passing it in, and these fields spare that indirection when a caller only needs `createAgent`.
29. **`strict` — automatic-compaction failure escalation.** `AgentOptions.strict` (default `false`) governs what happens when the automatic compaction path's `conversation.compact()` throws (the automatic-compaction clause): lenient (the default) surfaces the caught error as the `fault` event and continues over-window; `strict: true` still fires `fault` first (the failure stays observable either way), then rethrows the caught error so it propagates out of `#trim` through `#run`, rejecting the run's `result` with a genuine `error` settle (`status` → `error`) instead of a `partial: true` resolve. A manual `conversation.compact()` is unaffected by `strict` — it always propagates its own error regardless.
30. **Bounded `sections` — cap the compacted history, `collapse` on overflow.** `ConversationOptions.sections` / `ConversationManagerOptions.sections` (a manager default, overridden per-`add` by `ConversationInput.sections`) / `CompactOptions.sections` (a per-compaction override) each set a cap (`>= 1`) on `Conversation.sections`'s length; omitted at every level ⇒ unlimited. A sub-1 cap — at construction (`ConversationOptions.sections`) or at a `compact()` call (the effective `options.sections ?? the conversation's own cap`) — throws a `ConversationError` with `code: 'SECTIONS'`. When a `compact()` fold pushes a new section past the effective cap, the oldest overflow sections are immediately folded into one merged section (a third summarizer call over the folded sections' summaries) so `sections.length` never exceeds the cap afterward, and a `collapse` event fires carrying the merged `Section`. This is orthogonal to `keep` (which bounds the live tail folded per compaction) — `sections` bounds the compacted history's length instead.
31. **`sanitizeUsage` — normalizing a provider's abort-time partial usage.** A `ProviderAbortError.partial.usage` a provider surfaces mid-abort can be malformed (non-finite, negative, or fractional fields) since it was assembled from a cut-off stream rather than a clean settle. `sanitizeToken(value)` is the shared per-field primitive: it floors non-finite or non-positive values to `0` and positive fractional values to their integer part. `sanitizeUsage(usage)` applies it to `prompt` / `completion` / `total`, so a caller charging a token `Budget` never consumes a negative or fractional amount. The `Agent` loop applies it automatically to an abort's partial usage before folding it into the run's accounted usage / budget charge; both helpers are also exported standalone.
32. **`AgentError` — the synchronous shared-accounting concurrency guard.** `Agent.stream()` throws `AgentError('CONCURRENCY', …)` synchronously — before any state mutation or emit — when a run is already in flight on the same agent (`this.#runs.size > 0`) and the agent carries shared per-agent accounting for the new run: either a construction-level `window` (a shared context budget, always shared since it has no per-run override) or a construction-level `budget` with no per-run `AgentRunOptions.budget` override (a shared cost budget). A concurrent run that supplies its own per-run `budget` override (with no `window` set) is still allowed — it charges a separate instance. `isAgentError` narrows a caught value; branch on `error.code` — `'CONCURRENCY'` here, `'REGISTRY'` for an `AgentRegistry` accessor whose name is absent from its pool. A sequential/awaited caller is never affected — this guards only genuinely concurrent `stream()` calls on one agent.

33. **`agentResultToJSON` — the canonical portable AgentResult projection.** The helper accepts `unknown` and never throws, including for throwing getters, hostile nested usage, and revoked proxies. It captures `content`, `thinking`, `usage`, and `partial` exactly once through Contract's sanctioned `attempt` boundary, so conforming accessors and inherited structural properties are supported without a second read. `content` must be a string and `partial` a boolean; absent/`undefined` `thinking` and `usage` are omitted, while present `thinking` must be a string and present `usage` an object whose `prompt` / `completion` / `total` fields are finite numbers. Finite negative and fractional counts are preserved rather than normalized through `sanitizeUsage`, because the authoritative `TokenUsage` contract is numeric. Extra input fields are dropped. The helper rebuilds a fresh exact plain `{ content, thinking?, usage?: { prompt, completion, total }, partial }` object, deep-gates it through Contract's `parseJSONValue`, and returns Contract's imported `JSONValue`; invalid input returns `undefined`.

## Patterns

### Bounding any provider call

`ProviderInterface.generate` / `.stream` take a plain `AbortSignal`, so fold an [abort](abort.md), a [timeout](timeout.md), and a token [budget](budget.md) into one bound through `AbortSignal.any` — whichever trips first cancels the call. This works for any provider; constructing the concrete one is a host application's job.

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createAbort } from '@orkestrel/abort'
import { createTimeout } from '@orkestrel/timeout'
import { createTokenBudget } from '@orkestrel/budget'

declare const provider: ProviderInterface // any concrete implementation supplied by the host app
const abort = createAbort() // external cancel
const timeout = createTimeout({ ms: 30_000 }) // wall-clock deadline
const budget = createTokenBudget({ max: 50_000, scope: 'total' }) // cost ceiling
timeout.start()
budget.start()

const bound = AbortSignal.any([abort.signal, timeout.signal, budget.signal])
const result = await provider.generate(messages, bound)
budget.consume(result.usage ?? { prompt: 0, completion: 0, total: 0 })
```

### Dispatching the model's tool calls

Advertising and dispatch are the halves of one exchange: hand `definitions()` to the provider, and feed the `ToolCall`s that come back through `execute`. Results are correlated by `id` and discriminated on `success`, so a handler throw arrives as a `ToolResult` the model can read rather than an exception the caller must catch.

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createToolManager, createTool } from '@orkestrel/tool'

declare const provider: ProviderInterface
const tools = createToolManager()
tools.add(createTool({ name: 'add', execute: (args) => Number(args.a) + Number(args.b) }))

const turn = await provider.generate(messages, signal, tools.definitions())
if (turn.tools) {
	const results = await tools.execute(turn.tools) // each correlated by id; one bad call never fails the batch
	// feed `results` back as the next turn's tool messages
}
```

### Running the loop (instead of driving the provider by hand)

The preceding patterns are what an `Agent` does for you turn after turn — bounding the call, dispatching the model's tools, feeding the results back, and repeating until the model stops (or `limit` is hit). Reach for `createAgent` rather than hand-rolling the loop; bound and pace it through `AgentOptions`, and recover a cancel's partial from `result` (which resolves, never rejects, on a cancel).

```ts
import { createAgent } from '@orkestrel/agent'
import type { ProviderInterface } from '@orkestrel/agent'

declare const provider: ProviderInterface
const agent = createAgent(provider, { timeout: 30_000, limit: 6 })
agent.context.messages.add({ role: 'user', content: 'Summarize the news.' })

// Cancel from elsewhere — the turn commits whatever streamed so far.
setTimeout(() => agent.abort('user navigated away'), 5_000)

const result = await agent.generate()
if (result.partial) keep(result.content) // a cancel RESOLVED partial, not an error
```

### Bounding cost mid-stream (the token `budget`)

An `AgentOptions.budget` (or a per-run override) is not only charged from each turn's final reported `usage` — the loop also charges it incrementally, mid-stream, from an estimated token count as content deltas arrive (the `estimateTokens` `ceil(length / 4)` heuristic), so a runaway completion trips the ceiling without waiting for the turn to finish. When the mid-stream estimate crosses the budget, the budget's `signal` fires, folding into the run's bound abort exactly like an external cancel or a `timeout` — the provider is cancelled, and the run resolves `partial: true` with an `abort` event (the same funnel as any other cancel).

Once a turn does complete, the loop reconciles: it charges the budget the remainder of the turn's authoritative `usage` (`completion - alreadyCharged`, `total - alreadyCharged`, plus the full `prompt` — which is never estimated mid-stream, having no live delta channel) — so the turn's total budget draw always nets to exactly the reported usage, never double-charged and never under-charged. The `AgentResult.usage` / the `usage` chunks you observe stay the full authoritative usage regardless — this reconcile affects only what the `budget` itself was charged, never what you're told the turn cost. This mid-stream enforcement is bounded, not exact — the estimate can under- or over-shoot the eventual real usage by a turn's tail, so treat the `budget.max` as a firm ceiling with some slack, not a byte-exact cutoff.

```ts
import { createAgent } from '@orkestrel/agent'
import { createTokenBudget } from '@orkestrel/budget'

const budget = createTokenBudget({ max: 2_000, scope: 'completion' })
const agent = createAgent(provider, { budget })
agent.emitter.on('abort', (reason) => log('budget tripped mid-stream', reason))
agent.context.messages.add({ role: 'user', content: 'Write a very long story.' })
const result = await agent.generate() // partial: true if the story ran the budget out mid-stream
```

**A `think: true` run needs headroom for reasoning.** Live reasoning deltas (`ProviderDelta` `'thinking'`) are not metered mid-stream (only `'content'` deltas are — thinking is charged, like content, solely through the post-turn reconcile), so a thinking model can spend a large share of a tight budget's ceiling on its reasoning before any answer content streams — the mid-stream trip can land while the model is still reasoning, committing an empty (or near-empty) `content` alongside `partial: true`. Give a `think: true` run enough budget headroom to cover its reasoning, not only its expected answer length.

### Observing an agent (push vs. pull)

An `Agent` exposes a pull and a push observation surface. Pull — the `AgentChunk` stream (`stream().events`) — is for a live consumer rendering per-token answer deltas and per-think reasoning deltas as they arrive. Push — the `emitter` (`AgentEventMap`) — is for fire-and-forget observers (logging, metrics, tracing) that want the loop's lifecycle moments without draining the stream: `start` (a run begins), `turn` (each iteration), `tool` (a dispatched call + its result), `usage` (a turn's token usage), `deny` (an authority denial — which never reaches the chunk stream), `finish` (the settled result), `error` (a genuine failure), `abort` (a cancel), and `exhaust` (the limit was reached while the model still held unresolved tool intent — fires instead of `abort`, still followed by `finish`). Per-token / per-thinking deltas stay the stream's job exclusively — there is deliberately no `token` or `think` event on the emitter; reach for the stream when you need live output, the emitter when you need lifecycle.

```ts
import { createAgent } from '@orkestrel/agent'
import type { ProviderInterface } from '@orkestrel/agent'

declare const provider: ProviderInterface
// Wire fire-and-forget observers at construction through the reserved `on` option …
const agent = createAgent(provider, {
	on: {
		start: (id) => trace.begin(id),
		usage: (usage) => meter.add(usage.total),
		deny: (call, reason) => audit(call.name, reason), // not visible on the chunk stream
		finish: (result) => trace.end(result),
	},
})
// … or subscribe later through `agent.emitter`.
agent.emitter.on('abort', (reason) => log('cancelled', reason))
```

**Observation can never corrupt the loop.** The emitter isolates a listener that throws (the throw can never escape into the settle-once / wake-park engine — `generate()` / `stream()` still settle the exact same result), routing the caught error to its own `error` handler (the `error` option, surfaced as `(error, event)`, not a domain event) so the observer bug is not silently lost. Every throwing listener surfaces (not only the first); a throwing `error` handler is swallowed too (it can neither recurse nor escape); with no handler the throw is dropped silently. So a buggy observer degrades to a routed error — it never reorders, throws into, or corrupts the run.

**A cancelled run emits `abort` then `finish`.** A cancel (an external `signal`, the `timeout` deadline, an exhausted `budget`, or `abort()`) still resolves a partial result — so the emitter fires `abort` (carrying the cancel reason) and then `finish` (carrying the settled partial), letting an observer see both that the run was cancelled and the partial outcome it committed. A natural / cap-bounded finish fires `finish` only; a genuine provider / tool error fires `error` instead of `finish`. `generate()` and `stream()` drive the same events (they share one `#run`).

### Pulling context from another conversation (with provenance)

One agent serves many conversations by switching the active conversation between runs (`conversations.switch(id)` — the active-conversation clause); each thread keeps its own history. When the active conversation A needs something decided in another conversation B, don'T merge B's turns into A's live tail — that pollutes A's thread and (for a small model) blurs which conversation said what. Instead pull a provenance-labeled reference of B into A's active workspace (the fenced reference channel `build()` folds into the system block), so the model reads it as clearly-foreign material and attributes it to B.

The flow is **summary → search / rehydrate → reference → write-to-workspace** — and cherry-pick, never dump:

```ts
import { createAgent, createConversationManager } from '@orkestrel/agent'
import type { ProviderInterface } from '@orkestrel/agent'

declare const provider: ProviderInterface
const conversations = createConversationManager({
	summarize: /* a ConversationSummaryHandler */ undefined,
})
const a = conversations.add({ id: 'auth' }) // the ACTIVE thread (the first add auto-activates it)
const b = conversations.add({ id: 'planning' }) // the OTHER thread to pull from

const agent = createAgent(provider, { conversations }) // its active conversation (a) is the message source

// 1. summary → decide B is relevant (its rollup is a cheap digest of the whole thread)
b.summary // for example "the team evaluated databases and chose Postgres"
// 2. search / rehydrate → SELECT the few right turns (never B's whole history)
const picked = b.search('database') // or b.rehydrate(sectionId) for a compacted slice
// 3. reference → FRAME them as a self-labeled provenance block (a pure string, no model call)
const block = b.reference({ label: 'planning', messages: picked })
// 4. write-to-workspace → into the ACTIVE conversation's context active workspace, keyed by the source id
agent.context.workspaces.add().write(`conversation:${b.id}.md`, block)

// Now the model can use B's decision AND attribute it: "Postgres, decided in the planning conversation."
```

Why this shape: `reference()` leads with `[Reference — conversation "<label>" — NOT part of this conversation]`, so the model treats the rollup + excerpts as a quoted foreign source (it answers "decided in the planning conversation", not "we decided here"). Keep the excerpts cherry-picked — this content enters another context window a small model must read, and a full dump re-bloats it. `reference()` is event-free and never calls a model; provenance lives in the `label` (default the conversation's `id`).

**Within a conversation, the same provenance instinct applies to recaps.** `view()` folds each compacted section into a synthetic `assistant` recap — and prefixes it with `CONVERSATION_RECAP_PREFIX` (`[Summary of earlier messages] …`) so a small model reads it as a condensed recap of earlier turns rather than a literal turn to echo or treat as the live answer. The label is deliberately lean (a fixed handful of tokens — no per-section blow-up) and is a `view()`-only presentation concern (the rollup regeneration re-reads the unframed summaries). Empirically, on a 2B model this tightening is the difference between the model correctly attributing a recapped fact and mis-attributing it — at temperature 0 the recap label reliably steers correct attribution where the bare assistant turn does not.

### Persisting a conversation through either store

A conversation snapshot carries its generated identity, so the same `set` / `get` / `delete` workflow works through the in-memory store and the driver-backed store without hard-coding an id:

```ts
import {
	createConversation,
	createDatabaseConversationStore,
	createMemoryConversationStore,
} from '@orkestrel/agent'
import { createMemoryDriver } from '@orkestrel/database'

const conversation = createConversation()
conversation.add({ role: 'user', content: 'hello' })
const snapshot = conversation.snapshot()
const stores = [
	createMemoryConversationStore(),
	createDatabaseConversationStore(createMemoryDriver()),
]

for (const store of stores) {
	await store.set(snapshot)
	const stored = await store.get(conversation.id)
	JSON.stringify(stored) === JSON.stringify(snapshot) // true
	await store.delete(conversation.id)
	await store.get(conversation.id) // undefined
}
```

### Running many durable agents as jobs

When you need many agents — bounded, retried, surviving a crash — describe each as a serializable `AgentJobInput` (names for the live pieces, data for the rest), register the live pieces once, and run them through a `createAgentQueue` (durable, bounded) or a `createAgentRunner` (one-shot, ordered, fail-fast, with sub-agent fan-out). The layer composes the `@orkestrel/queue` `Queue` and the `@orkestrel/workflow` `Runner` — it adds only rehydration and the partial policy, no new engine.

```ts
import { createAgentQueue, createAgentRegistry } from '@orkestrel/agent'
import type { AgentJobInput } from '@orkestrel/agent'
import { createMemoryQueueStore } from '@orkestrel/queue'

declare const store: ReturnType<typeof createMemoryQueueStore> // or a server JSON / SQLite store

// Register the live, non-serializable pieces ONCE; jobs reference them by name.
const registry = createAgentRegistry({ providers: { main: provider } })
const queue = createAgentQueue({ registry, concurrency: 4, retries: 1, store })

const jobs: readonly AgentJobInput[] = [
	{ provider: 'main', messages: [{ role: 'user', content: 'Summarize doc A.' }] },
	{ provider: 'main', messages: [{ role: 'user', content: 'Summarize doc B.' }], budget: 50_000 },
]
const results = await Promise.all(jobs.map((job) => queue.enqueue(job)))

// After a crash, re-run whatever was still outstanding — the registry rehydrates them.
await queue.restore()
```

Fan out sub-agents by declaring `children` on a parent job; `createAgentRunner` `controller.spawn`s each through the same bounded queue, so the children run as sibling sub-agents:

```ts
import { createAgentRunner } from '@orkestrel/agent'

const runner = createAgentRunner({ registry, concurrency: 4 })
const parent: AgentJobInput = {
	provider: 'main',
	messages: [{ role: 'user', content: 'Plan the trip.' }],
	children: [{ provider: 'main', messages: [{ role: 'user', content: 'Find flights.' }] }],
}
const results = await runner.execute([parent]) // [parent result, …then spawned child results]
```

### Giving the model documents to read

A workspace reaches the model through `context.workspaces`, and this is the only channel documents have. `build()` renders the active workspace by carrier on every turn — active-only and scope-filtered — so the workspace the agent is working in is always what the prompt reflects, with nothing to re-mount after an edit. Register one (the first `add` auto-activates it) and its text files fold into the `## Workspace` system section as fenced reference blocks, while its image files' base64 rides the last user message.

```ts
import { createAgent } from '@orkestrel/agent'
import type { ProviderInterface } from '@orkestrel/agent'
import { createToolManager } from '@orkestrel/tool'

declare const provider: ProviderInterface
const agent = createAgent(provider, { tools: createToolManager() })

// The first add auto-activates — agent.context.workspaces.active is this workspace, so build()
// renders its text files into the `## Workspace` section on every turn.
const workspace = agent.context.workspaces.add()
workspace.write('briefing.txt', 'The vault code is 7731.')
```

Reading is one half. To let the model edit what it reads, register the `createWorkspaceTool` published by `@orkestrel/toolbox` on `agent.context.tools` over this same `context.workspaces` registry: an `operation`-keyed `ToolInterface` whose dispatch and error semantics are that package's to document. The surfaces then close a loop — the model reads the workspace from the prompt, edits it through a tool call, and reads the edited version on the next turn.

### Switching which workspace the model sees

Only the active workspace renders; the other registered workspaces never reach the model at all. `switch` changes which one the model sees between runs:

```ts
import { createAgent, createScope } from '@orkestrel/agent'
import type { ProviderInterface } from '@orkestrel/agent'

declare const provider: ProviderInterface
const agent = createAgent(provider)

const project = agent.context.workspaces.add() // auto-activates
project.write('src/config.ts', 'export const PORT = 8123')

agent.context.messages.add({ role: 'user', content: 'What port is configured?' })
await agent.generate() // the model reads the active workspace's file from the prompt

// Serve a different workspace next run — switch the active pointer:
const other = agent.context.workspaces.add() // NOT active (a later add leaves active unchanged)
other.write('notes.txt', 'different context')
agent.context.workspaces.switch(other.id) // now build() renders other's files instead
// Narrow which files render with scope.files (by path):
agent.context.apply(createScope({ name: 'cfg', files: ['src/config.ts'] }))
```

Because the editing tool drives the same registry, a switch moves both surfaces together: the model's next prompt and its next edit land in the same workspace whether the host called `context.workspaces.switch` or the model asked the tool to.

### Removing / clearing entries, and the less-common accessors

Agent-owned registries expose their less-common removal, clearing, persistence, and lookup methods here. Tool and workspace registry operations are documented in their dependency guides.

```ts
import {
	createAgent,
	createAgentContext,
	createAgentRegistry,
	createAuthority,
	createConversationManager,
	createInstructionManager,
	createScopeManager,
	createThinkSplitter,
} from '@orkestrel/agent'
import type { ProviderInterface } from '@orkestrel/agent'

declare const provider: ProviderInterface

// ThinkSplitter — one per stream; `split` yields clean content, `flush` settles the end.
const splitter = createThinkSplitter()
splitter.split('hello') // clean content for this raw wire delta
splitter.flush() // any held partial tag / unclosed span resolved at stream end

// The message store (context.messages, a MessageManagerInterface) — same remove / clear.
const context = createAgentContext()
const added = context.messages.add({ role: 'user', content: 'hi' })
context.messages.remove(added.id)
context.messages.clear()

// InstructionManager — same remove / clear.
context.instructions.remove('tone')
context.instructions.clear()

// ScopeManager — `create` mints + stores, `scopes` lists, `remove` / `clear` drop.
const scopes = createScopeManager()
const scope = scopes.create({ name: 'read-only' })
scopes.scopes() // every stored scope, in insertion order
scopes.remove(scope.id)
scopes.clear()

// Authority — `evaluate` is its one method (also reached through the agent loop internally).
const authority = createAuthority()
authority.evaluate({ call: { id: '1', name: 'add', arguments: {} } })

// AgentRegistry — `scheduler(name)` resolves a registered scheduler by name (throws when absent).
const registry = createAgentRegistry({ providers: { main: provider } })
try {
	registry.scheduler('paced') // throws 'unknown scheduler: paced' — none registered here
} catch {
	// expected — this registry has no `schedulers` pool
}

// ConversationManager — `save` persists a registered conversation, `remove` / `clear` drop it.
const conversations = createConversationManager({ summarize: undefined })
const thread = conversations.add({ id: 'thread-1' })
await conversations.save(thread.id)
conversations.remove(thread.id)
conversations.clear()

// Conversation — `remove` one live message, `clear` the live tail, `snapshot` for durability.
const message = thread.add({ role: 'user', content: 'hi' })
thread.remove(message.id)
thread.clear()
thread.snapshot() // { id, summary?, sections, messages } — the durable payload

const agent = createAgent(provider)
void agent
```

### Practices

- **Bound every call** — pass an `AbortSignal` (an [abort](abort.md), or an `AbortSignal.any` over abort + [timeout](timeout.md) + [budget](budget.md)) so a request can be cancelled, deadlined, or capped.
- **Recover the stream's partial** — wrap a driven `stream` in `try`/`catch` and narrow with `isProviderAbortError` to keep the content that arrived before a cancel.
- **Fold usage into a budget** — `result.usage` is the [budgets](budget.md) `TokenUsage`; `consume` it per turn to enforce a token ceiling.
- **Register tools in a `ToolManager`** — `add` your `Tool`s, hand `definitions()` to the provider, and dispatch the model's `ToolCall`s through `execute`; read the outcome by narrowing on `success` rather than catching, since a handler's throw already arrives as the failure arm. When in-process code wants a typed error instead, call `tools.tool(name)` and `execute` it directly.
- **Narrow tool `args`** — a `ToolCall.arguments` is model-supplied `unknown`; narrow it inside `execute` with a guard.
- **Collect turns in an `AgentContext`** — `add` to `context.messages` (the `id` is minted for you), then `build()` the provider input each turn; tools travel as the provider's `tools` argument, so never fold a tool's schema into a message yourself.
- **Pull cross-conversation context with provenance, never by merging turns** — to use something from another conversation B in the active one, follow `B.summary` (decide relevance) → `B.search` / `B.rehydrate` (cherry-pick the few right turns) → `B.reference({ label, messages })` (frame it) → `context.workspaces.active?.write(...)` (write it into the active workspace). The provenance label keeps a small model from reading B's content (or a recap) as part of the live thread; cherry-pick — don't dump B's whole history into another context window.
- **Run the loop with `createAgent`** — don't hand-roll the context → provider → tools cycle; `createAgent` does it, bounded by `AbortSignal.any([signal, timeout, budget])`, paced by `scheduler`, capped at `limit`. Drain `stream().events` to render `token` / `think` / `tool` / `usage` chunks live, or `generate()` for the settled result; either way `result` resolves partial on a cancel (read `result.partial`), rejecting only on a real error.
- **Run many durable agents with `createAgentQueue`** — describe each agent as a serializable `AgentJobInput` (names for the provider / tools / authority / scheduler, data for the rest), register the live pieces once in a `createAgentRegistry`, and enqueue the jobs. Persist them with a `store` so `restore()` re-runs outstanding work after a crash. Decide the partial policy up front — `partial: false` (default) retries a cancelled job, `true` accepts the partial.
- **Fan out sub-agents with `createAgentRunner`** — declare a parent job's sub-agents in its `children`; the runner `controller.spawn`s each through the same bounded queue. Don't reach for the controller yourself — express fan-out as data on the job (it stays serializable) and let the runner spawn it.
- **Pull and push surfaces on the `Agent`, none elsewhere** — observe the `Agent` each way: pull the `AgentChunk` stream for per-token / per-thinking deltas + usage/tool chunks, or push `agent.emitter.on(...)` (`AgentEventMap`) for lifecycle + usage/tool/deny moments a fire-and-forget observer wants. A listener throw can never corrupt the loop (the emitter isolates it, routing it to the `error` option). Do not reach for an Emitter on the provider contract, the tool registry, the conversation store, the context, or the job layer — those stay event-free; and do not expect per-token `token` or `think` events (those stay the stream's job).
- **Create and edit files through `@orkestrel/workspace`** — the file domain is that package's, and `AgentContext` borrows only its `isText` / `isBinary` guards to decide a file's carrier. The rendering is agent's: the `## Workspace` fencing and the binary-plus-`image/` attachment are prompt policy that belongs here, not workspace helpers that belong there.
- **Give the model both halves of a workspace** — `context.workspaces` is what it reads, rendered by carrier every turn, active-only and filtered by `scope.files`; the `createWorkspaceTool` published by `@orkestrel/toolbox` over that same registry is what it writes. Workspace editing, errors, and persistence live in [`workspace.md`](workspace.md); tool dispatch semantics live in [`tool.md`](tool.md).

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection for agent-owned values and types, exhaustive method parity for every agent-owned interface and class pair documented here, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Conversations & compaction` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline. It also runs the flagship fences and asserts the values their comments claim.
- [`tests/src/core/conversations/Conversation.test.ts`](../tests/src/core/conversations/Conversation.test.ts) — `add` single mints a fresh `id` + carries `role` / `content` (and `calls` only when given, the field omitted otherwise); `add` batch returns the created messages in order with unique ids; the returned message reflects its input and is the same object `message(id)` resolves (immutable); `message` lookup / miss; `messages()` insertion order; `remove` single + batch (`true` only when every supplied id was removed) + `clear` + `count`; and hydration through the `ConversationOptions.snapshot` seam — the one way to restore (a `createConversation` restore of the stored id, rollup, sections, and live tail that re-snapshots identically, the snapshot id winning over an options id, a restored conversation's `view` / `search` / `count` and continued compaction, and no event emitted while restoring).
- [`tests/src/core/AgentContext.test.ts`](../tests/src/core/AgentContext.test.ts) — `build()` with a system prompt prepends `{ role: 'system', content }` then the conversation in order; without one (and empty managers) returns only the conversation (no system turn, `system === undefined`, empty → `[]`, and an explicit `''` / whitespace system still prepended); `context.tools` is the passed registry (or a fresh empty `ToolManager`) and `build()` never includes a tool's name / description; `build()` is fresh each call (reflects messages added between builds, mints a new system `id`, snapshot-independent). And the richer assembly: the `instructions` manager is fresh empty (or reused by identity); an empty manager contributes nothing (lean behavior preserved); it folds into the system block under its `description` + per-item `override`; the readonly `scope` getter (default `undefined`, initial through options) + `apply(scope)` / `apply(undefined)` through an `AgentContextInterface` binding; and scope filtering per category — `undefined` ⇒ all, a named allow-list ⇒ only-listed, `[]` ⇒ none over the instructions, with the conversation passing through unfiltered, recomputed fresh when the scope is changed between builds. And the active-workspace render by carrier (the only document/image channel): `context.workspaces` is always present (fresh empty `WorkspaceManager`) or supplied structurally through options; the active workspace's text files fold into a `## Workspace` system section (fenced through `renderFencedFile`, placed after instructions) and its image files' base64 attaches to the last user message (own-images-first merge; multiple in insertion order; skipped when no user message; the stored message is never mutated); `scope.files` filters both carriers; the render is active-only (a non-active workspace's files never render, reflected through a `switch`); no active workspace ⇒ nothing rendered. And the injected-conversation message source (a data-stub summarizer): with one, `context.messages` is its live tail and `build()` folds its `view()` (the compacted view after a `compact()`), no scope filtering over messages (the conversation is authoritative) while scope still filters instructions; without one, the plain message-store path. And the structural conversation registry (the multi-conversation switch): supplied through options, its active conversation changes through `conversations.switch(id)`, re-pointing `messages` to the new live tail by identity (no duplication), and `build()` follows the switch; constructing with an empty supplied registry adds a default active conversation; a `compact()` on the active conversation is reflected through the switch.
- [`tests/src/core/scopes/Scope.test.ts`](../tests/src/core/scopes/Scope.test.ts) — `Scope` construction (a minted `id` + the per-category lists including `files`, copied in so a later mutation of the caller array can't leak in; `[]` distinct from `undefined`); and `narrow`'s set-intersection semantics — `list ∩ list` = the keys in both, `undefined ∩ list` = the list (no parent constraint), `list ∩ undefined` = the list, `undefined ∩ undefined` = `undefined`, `[]` ⇒ none either side, narrowing only tightens (a parent-excluded key never returns), per-category independence (incl. `files`), name preserved, immutable (a new scope, parent untouched), and chained narrows compose.
- [`tests/src/core/scopes/ScopeManager.test.ts`](../tests/src/core/scopes/ScopeManager.test.ts) — the id-keyed registry: `create` mints an `id` + stores (always adds — two scopes sharing a `name` coexist), `scope` / `scopes` insertion-order lookup, `remove` single + batch (`true` only when every supplied id was removed) + `clear` + `count`; the `create` / `remove` / `clear` event emissions (one `remove` per actually-removed id, the reserved `on` option); and emit-safety (a throwing `create` listener can't corrupt the registry + routes to the emitter's `error` handler; a throwing `error` handler neither escapes nor recurses) mirroring the Table / InstructionManager emitter convention.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — agent-owned pure helpers: `agentResultToJSON` full/minimal fresh exact projections + extras dropped + compile-time exhaustive `AgentResult` field-map review, conforming accessor/inherited structural values, and total rejection of wrong/missing fields, malformed present optionals, non-finite/missing usage counts, throwing getters, non-object inputs, and revoked root/nested proxies; `filterAllowList`'s semantics (`undefined` ⇒ all, `[]` ⇒ none, a list ⇒ only-listed) preserving item order (not allow-list order), ignoring unknown keys, matching through the key extractor (not identity), and returning `[]` (not throwing) for an empty item list; `estimateTokens` / `estimateMessages` (the per-message `MESSAGE_TOKEN_OVERHEAD`, an empty batch ⇒ 0, empty content ⇒ overhead only, the JSON-stringified `calls` contribution with its documented fixed fallback on a circular argument and no contribution for an empty `calls` array, and `images.length * IMAGE_TOKEN_ESTIMATE` per image); `renderFencedFile` (the `File:` label + language-tagged fence, the body verbatim across lines, and a workspace text file framed from its own text arm); `sanitizeToken` / `sanitizeUsage` (identity on a well-formed non-negative integer usage; `NaN` / negative / `±Infinity` floored to 0 and a fractional field to its integer part, each field independently); and `settleAgentJob`'s partial policy (a natural finish resolves `partial: false`, a disallowed partial throws an `AgentJobError` carrying the partial, an allowed partial resolves as success). And the extracted loop / cascade / conversation / scope leaves on their own contracts: `joinThinking` / `sumUsage` seeding then accumulating, `assembleResult` omitting an absent `thinking` / `usage` and keeping the loop-internal `exhausted` out of the public result, `denyCall`'s denial texts, `renderSection` rendering nothing for an empty item list, `resolveOpen` / `resolveClose` / `resolveItem` at each cascade level (item override beating every other), `attachImages` merging own-images-first without mutating the source, `attachUserImages` replacing only the last user turn (and returning the conversation unchanged for no data or no user turn), `collectImageData` skipping a text file, `buildSummaryMessage` / `buildRecapMessage` (raw vs. `CONVERSATION_RECAP_PREFIX`-framed), and `intersectKeys` treating `undefined` as the universal set and returning a copy.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — agent-owned factories over real declared tool/workspace dependencies: `createAgentContext` (the `[system?, ...messages]` assembly; a pre-built tool registry surfacing through `context.tools`); `createAgent` (one turn to its result; passed instructions / workspaces managers surface through `agent.context` — an added text file appears in `build()`; a no-tools scope empties the advertised definitions and filters instructions; omitted managers still yield working empty managers); `createChannel` (pushed values drain in write order then `close` ends it; a buffered value is delivered before a `fail` surfaces); `createAgentRegistry` (a serializable job round-trips build→run; a job naming a provider or tool missing from the registry rejects loudly on enqueue); `createAgentQueue` (each enqueue resolving its own result; the `concurrency` bound incl. a 12-job batch at 3; the partial policy — throws by default carrying the partial, re-runs for the full retry budget then rejects, `partial: true` resolves, a `budget: 0` partial settles the same way, a non-partial sibling resolves beside a throwing partial, a per-attempt timeout rejects as the substrate fault (not an `AgentJobError`) and retries, a pre-aborted entry signal hard-cancels without running; pause parks a job until resume, stop rejects a pending job, and `abort()` threads into the agent's signal); durability (an `AgentJobInput` JSON round-trips unchanged; a queue store round-trips the row; `restore()` re-runs an outstanding job to its real result then removes the row); `createAgentRunner` (an ordered batch, fail-fast on a partial, a parent spawning a child sub-agent through `controller.spawn`, cancel threading); and `AgentJobError` / `isAgentJobError` (carries the partial `AgentResult`; the guard narrows the real error and rejects everything else).
- [`tests/src/core/conversations/stores/MemoryConversationStore.test.ts`](../tests/src/core/conversations/stores/MemoryConversationStore.test.ts) — the in-memory `ConversationStoreInterface` (`get` / `set` / `delete`, async, keyed by a snapshot's own id) over real `ConversationSnapshot`s carrying compacted sections (from a genuine `compact()`) + a live tail + a rollup `summary`: set→get round-trip + JSON-portability parity, upsert under the same id, delete + absent, two distinct ids coexist; and the `isToolCall` per-call guard (the fail-closed element check) — accepts the real `ToolCall` shape (string `id` / `name` + a record `arguments`), rejects every hostile shape (non-record, missing / wrong-typed `id` / `name` / `arguments`) without throwing.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — `isMessage`, `isSection`, and `isConversationSnapshot` (the per-message, per-section, and total read-boundary guards): each accepts the real shape with and without its optionals, rejects a non-record / nullish / primitive without throwing, rejects a missing or wrong-typed required field, and rejects a malformed nested element (`calls`, `messages`, `sections`); `isConversationSnapshot` also accepts a JSON-revived snapshot (the storage-read shape the database store narrows) and rejects a snapshot whose assistant `calls[]` carries a tampered element.
- [`tests/src/core/conversations/stores/DatabaseConversationStore.test.ts`](../tests/src/core/conversations/stores/DatabaseConversationStore.test.ts) — the driver-pluggable twin over a real `createMemoryDriver` (no mocks): the same set→get round-trip through the one opaque JSON column (sections + tail + rollup summary survive), the default-driver factory overload (no arg) works the same, cross-instance durability (a second store over the same driver reads the snapshot back), upsert under the same id, delete + absent, two distinct ids coexisting, and a conversation store + a workspace store over separate drivers not colliding.
- [`tests/src/core/AgentRegistry.test.ts`](../tests/src/core/AgentRegistry.test.ts) — the registry in isolation (a scripted provider): the accessors resolve a registered `provider` / `tool` / `authority` / `scheduler` and throw a category-specific `unknown <category>: <name>` on a miss; `build` rehydrates a seeded, signal-wired agent — the seed `messages` + `system` reach the agent and its `build()`, the `tools` names resolve into a fresh per-build manager (an unknown name throws), a threaded pre-aborted `signal` commits a partial, a `budget` ceiling becomes a token budget that bounds the loop, and a resolved `limit` / `scheduler` / `authority` reach the rehydrated loop (the cap bounds it, the scheduler paces between turns, the authority denies a call without executing it).
- [`tests/src/core/Agent.test.ts`](../tests/src/core/Agent.test.ts) — the loop's deterministic logic over a local scripted `ProviderInterface`: a single no-tools turn → `generate` returns the content; the system prompt prepended + tools advertised structurally; tool iteration (turn 1's `ToolCall` → `execute` → the result fed back → turn 2's final content); a tool throw fed back as the tool message (the loop never throws); `generate` ↔ `stream` parity (same script → deep-equal); the `AgentChunk` sequence (`token` / `think` / `usage` / `tool` chunks, with the tool chunk carrying the executed call + result and usage summed); per-run `think` forwarding into the provider; the iteration cap (an always-tool script stops at `limit`); abort (a pre-aborted `signal` commits a partial without calling the provider; `abort()` mid-stream resolves `partial: true` with the accumulated content; a genuine provider error rejects); the token `budget` bound (exhausted usage stops the turn, `partial`); the `scheduler` yielding between turns (not after the last); `status` transitions; the authority gate wired into the loop (no authority → unchanged; an allowed call executes; a denied call is not executed [a counter tool proves it] yet a `tool` chunk + tool message carry the denial and the next provider call sees it; a mixed batch merges allowed + denied in original call order; an all-denied turn feeds back denials and the cap still bounds it); and the scope-filtered tool advertisement (no scope → all tools advertised; a `tools` allow-list → only the listed definitions reach the provider, a scoped-out tool absent on every turn so its handler never runs — neither described nor callable; an empty `tools` list → the provider is handed `undefined`); and automatic compaction (the context `window` budget): the between-turns trigger (the absolute prompt crossing `max` fires `compact()` + rebuilds smaller, exactly twice over the script, the run answering through the compacted view), the no-fire-below-the-window guard, and the additive regressions (no `window` ⇒ never folds; no conversation ⇒ the trigger is skipped + the budget untouched); and the production hardening (a long-conversation initial prompt compacted pre-first-turn so the first provider call sees the compacted view; a throwing auto-summarizer caught + surfaced as `fault` with the run continuing to a valid answer while a manual `compact()` still throws; the futile guard — a `compact()` that folds nothing while over the window latches per-run so auto-compaction stops, no churn); and the multi-conversation pattern (one agent + a `ConversationManager`, switching the active conversation with `agent.context.conversations.switch(id)` per request: independent accumulated histories with no cross-talk, and independent per-thread compaction whose sections retain only their own thread's originals).
- [`tests/src/core/Authority.test.ts`](../tests/src/core/Authority.test.ts) — the `Authority` gate in isolation: ordered first-match-wins; a matched rule allows by default and denies on `allowed: false` (carrying `zone` / `reason`); no-match → the fallback; the default fallback is allow-`'default'`; an empty rules list always returns the fallback; a deny-by-default `fallback` makes unmatched calls denied (an allowlist); the matcher receives the `{ call }` context (branching on `call.name` and `call.arguments`).

## See also

- [`budget.md`](budget.md) — the cost primitive; `ProviderResult.usage` and `AgentResult.usage` reuse its `TokenUsage`, and a token budget bounds a provider call / an agent turn.
- [`abort.md`](abort.md) / [`timeout.md`](timeout.md) — the bounding signals folded into a call's `AbortSignal` through `AbortSignal.any`.
- [`queue.md`](queue.md) — the bounded-concurrency, retrying, durable `Queue` `createAgentQueue` composes for many agent jobs.
- [`workflow.md`](workflow.md) — the `SchedulerInterface` the loop yields to between turns, and the fail-fast `Runner` `createAgentRunner` composes for sub-agent fan-out.
- [`emitter.md`](emitter.md) — the foundational observable primitive the `Agent` owns as its push `emitter`; `AgentEventMap` is its event map, wired through the reserved `on` option.
- [`tool.md`](tool.md) — the tool runtime this loop advertises from and dispatches through: definitions, calls, and the success-discriminated `ToolResult`.
- [`workspace.md`](workspace.md) — the file domain whose active workspace `AgentContext` renders into a turn: files, editing, events, and persistence.
- [`contract.md`](contract.md) — the shape DSL other tools (for example `@orkestrel/toolbox`'s `createWorkspaceTool`) compile against; the shared `describedLiteral` (a discriminant's description-carrier) and `schemaToParameters` (the tool-parameters narrowing) live there.
- [`database.md`](database.md) — the `DriverInterface` / `TableInterface` seam `createDatabaseConversationStore` persists conversation snapshots through.
- [`AGENTS.md`](../AGENTS.md) — the repository's authority pointer; the coding rules it resolves to live in `@orkestrel/scaffold`.
- [`README.md`](README.md) — the guides index.
