# Agent

> **The conversation runtime for the `@orkestrel` line.** An agent is a conversation with a model and the loop that carries it forward. `ProviderInterface` is the single pluggable inference boundary: hand it a conversation and get back one assembled `ProviderResult` (`generate`), or a live stream of channel-tagged `ProviderDelta`s that returns that same assembled result when it ends (`stream`). Around that boundary this package owns everything a conversation is made of — messages, conversations and their compaction, instructions, scopes, prompt assembly, reasoning separation, the authority gate, durable jobs, and the bounded context → provider → tools → repeat loop. Source: [`src/core`](../src/core). Published through `@orkestrel/agent`.
>
> **The model is the one thing this package does not supply.** `ProviderInterface` is a contract, not an implementation: any backend that satisfies it drops in unchanged, and the host application decides which one. Nor is there hidden global state, a plugin lifecycle, a prompt-template DSL, or an implicit memory store. This is a kit of composable primitives: the loop is the convenient way to use them, not the only one, and a caller that would rather bound and drive a provider by hand can skip it entirely.
>
> **Tools and files are borrowed, not owned.** Callable tools come from [`@orkestrel/tool`](tool.md): the loop advertises their definitions to the model, dispatches the calls that come back, and feeds each `ToolResult` in as a tool message. A tool is loop machinery — it is never rendered into the prompt. Documents come from [`@orkestrel/workspace`](workspace.md): the context renders the active workspace into every turn, split by carrier — text as fenced reference blocks in the system message, images attached to the last user turn. That split is this package's own product policy, decided here because only the prompt-assembly layer knows what a turn looks like.
>
> **A turn is bounded and always terminates.** One `AbortSignal` — a cancel, a [timeout](timeout.md), and a [budget](budget.md) folded together through `AbortSignal.any` — bounds the whole run, and tool iteration is capped at `limit`. A cancel is not an error: it commits a partial `AgentResult` that resolves, so only a genuine provider or tool failure rejects. `generate` and `stream` share one private run, so the one-shot result can never diverge from the live stream, and a buggy observer cannot corrupt either, because the emitter isolates a listener's throw.

Three nouns carry a run. A `Conversation` holds the history — a live tail of immutable messages plus the sections older turns were compacted into. An `AgentContext` assembles that history into the next prompt, folding in the instructions and the active workspace and applying the active scope. An `Agent` drives that prompt through a provider, dispatches whatever tools the model asks for, feeds the results back, and repeats until the model stops. Everything else in this module either configures those three or observes them.

## Surface

The agent-owned surface: the inference boundary, the conversation layer, the context and its managers, the loop, the authority gate, and the durable-job bridge. Tool and workspace entities belong to their originating packages and are consumed directly — never re-exported here — and the concrete `ProviderInterface` implementation belongs to the host application.

A provider turns a conversation (plus optional tools) into a turn: `generate` resolves the assembled `ProviderResult` (content + any tool calls + any usage); `stream` yields channel-tagged `ProviderDelta`s as they arrive (`content` for answer text, `thinking` for live reasoning) and RETURNS the same assembled result when the stream completes, so a caller can render tokens / reasoning live and still get the full outcome. Both bound the call with an `AbortSignal`:

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

A tool is a JSON-Schema-described callable from [`@orkestrel/tool`](tool.md), and the loop needs exactly two things from its registry: `definitions()` advertises the tools to the model, and `execute` dispatches the `ToolCall`s that come back. What returns is a `ToolResult` discriminated on `success` — an unknown name and a throwing handler both arrive as the failure arm rather than as an exception, and a batch isolates each call from its siblings, which is what lets the loop hand every outcome back to the model and let it react:

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

Collect a turn's conversation in an `AgentContext`. Add turns through `context.messages` — the active conversation's live tail, always present, satisfying `MessageManagerInterface` by minting each `id` on `add` and keeping stored messages immutable and in insertion order — then `build()` the provider input: `[systemMessage?, ...messages]`. `context.tools` sits beside them, but it is a different kind of thing: the two other managers assemble prompt text, while the tool registry exists so the loop can advertise definitions and dispatch calls. Its contents reach the model as the `tools` argument, never as a message:

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

Drive the whole turn with an `Agent` (`createAgent`) — it composes the provider, its `AgentContext`, and the tool registry into the bounded context → provider → tools → repeat loop. Seed the conversation through `agent.context.messages`, then either `generate()` for a one-shot `AgentResult` or `stream()` for a live `AgentChunk` stream (`token` answer deltas, `think` reasoning deltas, `tool` dispatches, `usage`) whose `result` resolves the same `AgentResult`. `generate` DRAINS that same stream, so the two can't diverge:

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

Both `generate` and `stream` accept optional per-run `AgentRunOptions` — `think` and `schema` (forwarded to the provider as `ProviderStreamOptions`) plus `limit` / `timeout` / `budget` / `signal`, each overriding its `AgentOptions` construction default for THIS run only. Omitting one keeps the constructed default, so a caller that passes no options gets the agent it configured. A per-run `signal` COMPOSES with (never replaces) a constructed `signal` — either aborting cancels the run; a per-run `budget` is `start()`ed for that run and is the one the loop charges, leaving a constructed `budget` untouched:

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

`schema`, like `think`, rides into `provider.stream` as a `ProviderStreamOptions`: the loop composes both into ONE options object, omitting whichever key is unset, and passes no options object at all when neither is present — a provider that never received one still never does.

The turn is bounded by ONE cancel folded from the external `signal` + the `timeout` deadline + the `budget` signal through `AbortSignal.any`; `agent.abort(reason)` (or `stream.abort(reason)`) fires it. A cancel — external, deadline, budget, or `abort()` — commits a PARTIAL result: the `result` promise RESOLVES with `{ partial: true, content: <what accumulated> }`, never rejects (a cancel is not an error); only a genuine provider / tool error rejects. An optional `scheduler.yield`s between turns; tool iteration is capped at `limit` (default `DEFAULT_AGENT_LIMIT`). Exhausting `limit` while the model still holds unresolved tool intent (it requested tools on the very last allowed turn) is a DISTINCT, non-cancel cause of `partial: true` — it fires an `exhaust` event (the turns reached) instead of `abort`. A natural finish on the last allowed turn, or `limit: 0` (which never enters the loop), stays `partial: false`. `agent.status` transitions `idle` → `running` → `done` / `error`.

Gate the model's tool calls with an optional `Authority` (`createAuthority`) — a synchronous policy gate the loop consults BEFORE each call runs, passed through `AgentOptions.authority`. It walks ordered `rules` first-match-wins (a matched rule allows unless its `allowed` is `false`), falling back to a configurable default when none match — allow-unmatched by default (a denylist), or deny-by-default when its `fallback` denies (an allowlist). A DENIED call is never executed: the loop synthesizes the failure arm of `ToolResult` (`error: 'denied: <reason>'`) and feeds it back as a `tool` chunk and a tool message, so no handler runs, no budget is spent, and the model still sees what happened and can choose something else. An ALLOWED call dispatches normally, and with no `authority` set every call dispatches:

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

Alongside the conversation store sits the STANDALONE `InstructionManager` a richer context assembles a prompt from — named directives, keyed by `name`, listed by descending `priority`. It mirrors the registry shape — `add` (one or a batch) MINTS each `id` and OVERWRITES a same-key entry (last write wins), an `instruction(name)` / `instructions()` accessor pair, `remove` (one or a batch) / `clear` / `count` — holds IMMUTABLE entries, and is observable (`emitter` with an `add` / `remove` / `clear` event map, wired through the reserved `on` option; an `error` option receives a listener's throw). It carries the two **build-contract** members a context's assembly step calls: `open` (the section header text, `'## Instructions'`) and `render(instruction)` (per-item rendering — the instruction's `content`):

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

`AgentContext` wires the instruction manager and the workspace registry in. Beyond `system`, `messages`, and `tools`, a context exposes its own `instructions` manager and `workspaces` registry — pass pre-built ones through `AgentContextOptions`, or fresh empty ones are created — and `build()` folds them into the turn. The assembly order is one leading `system` message holding the system prompt, then the non-empty instructions block (its `description` header followed by every item's `format`), then the active workspace's text files under a `## Workspace` header, the three joined by blank lines; then the conversation. With no instructions, no active workspace, and no scope, that reduces to exactly the lean `[systemMessage?, ...messages]`. The carrier split shows here: text rides the system block, image data rides the last user message.

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

#### Conversations & compaction

Above the flat `MessageManagerInterface` sits the `Conversation` (`createConversation` / a `ConversationManager`) — it owns its messages directly and compacts older ones into summarized `sections` so a long history fits a turn's context window without discarding the originals. Append turns through the conversation's own `add` (the live uncompacted tail; `message` / `messages` / `remove` / `clear` / `count` round it out); `compact()` folds the older live messages into a summarized `Section` (retaining their originals), regenerates the conversation rollup `summary`, and shrinks `view()` — the model input, where each section becomes one summary message followed by the live tail. Compaction is driven by a provider-agnostic `ConversationSummaryHandler` seam (`(messages) => Promise<string>`) the agent runtime supplies, so a `compact()` without one throws a `ConversationError`. `keep` retains a recent tail (default `DEFAULT_CONVERSATION_KEEP` = `0`, fold all); `rehydrate(id)` / `search(query)` read the retained originals:

```ts
import { createConversation } from '@orkestrel/agent'
import type { ProviderInterface } from '@orkestrel/agent'

declare const provider: ProviderInterface
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

`agent.context.conversations` is the structural message-source registry — supplied at construction and never reassigned; switch its ACTIVE conversation with `conversations.switch(id)` to switch the agent's message source. `context.messages` is DYNAMIC: it always points at the CURRENT active conversation's live tail (the SAME reference, no duplication) and follows a switch. The registry ALWAYS has an active conversation (a default is added when it has none). This is the real app pattern: ONE `Agent` over a `ConversationManager` of threads, switching the active conversation PER REQUEST — not an agent per thread. Each conversation accumulates its OWN history and compacts INDEPENDENTLY (one thread's sections never leak into another). The agent reads `context.conversations` / `context.messages` fresh on each run, so switching BETWEEN runs works:

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

> **Concurrency caveat.** Switch the active conversation BETWEEN runs, never DURING one (the loop reads the active conversation at run entry and drives it through to the end). The framework ships the SWITCH mechanism; the app owns concurrency policy — for threads that must run CONCURRENTLY, use a SEPARATE `Agent` per concurrent thread (each agent is cheap; they can share the provider and tool registry). Switching mid-flight would repoint the live run's message source under it.

##### Production behaviors of automatic compaction

Auto-compaction (the `window` budget, above) is hardened for a long-running app:

- **Pre-first-turn + run-entry reset.** The budget check runs BEFORE the first provider request AND between turns — so a RESUMED or already-long conversation whose INITIAL prompt already exceeds the window compacts immediately (not only after a tool turn). The `window` budget is reset at run entry, so no stale measurement carries across runs or a conversation switch.
- **Non-fatal, observable summarizer failure.** If the AUTOMATIC `compact()`'s summarizer THROWS, the agent run does NOT crash: the loop skips compaction that turn, surfaces the error as a `fault` event (so the failure is observable, never silently lost), and continues (the over-window prompt proceeds to the provider). Only the agent's AUTO path is resilient — a MANUAL `conversation.compact()` you call yourself still propagates its error.
- **Futile-compaction guard (the single-level limit).** If `compact()` folds NOTHING (returns `undefined`) while the prompt is still over the window — that is, the section summaries ALONE already exceed it — the loop STOPS auto-compacting for the rest of that run (a per-run latch), avoiding per-turn churn. The over-window prompt then proceeds to the provider, which surfaces a genuine context-length error if it truly cannot fit — the real limit. Compaction is single-level: it folds the live tail, never the existing sections.

```ts
agent.emitter.on('fault', (error) =>
	log('auto-compaction summarizer failed (run continues)', error),
)
```

#### Scoping a turn

A `Scope` (`createScope` / a `ScopeManager`) is a NAMED allow-list filter the context applies at `build()` time AND at the loop's tool-advertise step. It carries an optional `instructions` / `tools` / `files` list keyed by each category's identity — `instructions` (by `name`), `tools` (by `name`), `files` (the active workspace's files, by `path`) — each THREE-WAY: `undefined` ⇒ NO constraint (all pass), `[]` ⇒ NONE pass, a non-empty list ⇒ only the listed keys. Conversation messages are NOT scoped — the active conversation owns message inclusion through compaction (`view()`), so there is no `messages` allow-list. Apply the active filter through `context.apply(scope)`; call `context.apply(undefined)` to remove filtering. The readonly `context.scope` getter reports the current filter, and `build()` reflects whatever scope is active when it runs (recomputed fresh each call). `narrow(config)` composes a tighter child scope by set-INTERSECTION (an `undefined` side imposes no constraint), so narrowing can only tighten — a parent-excluded key never returns:

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

#### Customizing the format (the cascade)

Each context section frames as `[open, ...items.map(render), close]` — a top line rendered once before the items, each item's text, and a bottom line rendered once after — with empty / absent slots dropped and the survivors blank-line (`\n\n`) joined. The three slots resolve INDEPENDENTLY through a cascade, MOST-SPECIFIC-FIRST; each level is OPTIONAL, what you omit falls through to the next, and omitting EVERYTHING leaves each section on its manager's built-in framing — only the header and the items, with no closing line. From most to least specific:

1. **Item override** — `override?: string` on a single `InstructionInput`: a fully-rendered string for THAT item, round-tripped onto the stored entity. Beats everything for that item's `render`.
2. **Manager-options override** — `format?: ContextSectionFormat<…>` on a manager's `Options` (an `{ open?; render?; close? }` trio): a per-section open / item-render / close override for that whole manager. Beats the provider default + the built-in. A manager exposes it as the `readonly format` accessor, and its own `open` / `render(item)` already consult that override's `open` / `render` (so a manager used standalone renders with it).
3. **Provider default** — `format?: ContextFormat` on a `ProviderInterface` (keyed by section kind — the `instructions` section): the model's preferred framing. OPTIONAL — an agnostic provider supplies none, and the agent loop passes `provider.format` (often `undefined`) into `build()`.
4. **Built-in** — the manager's hardcoded `open` getter + `render(item)` method (`## Instructions` + the content) — the floor for `open` and `render`. There is NO built-in `close`: an unset `close` yields no closing line.

So for a section kind `K`, manager `M`, and a provider format `F`: **open** = `M.format?.open ?? F?.[K]?.open ?? M.open` (manager-options > provider > built-in — the leading text has no per-item level); **per item** `I` = `I.override ?? M.format?.render?.(I) ?? F?.[K]?.render?.(I) ?? M.render(I)` (item > manager-options > provider > built-in); **close** = `M.format?.close ?? F?.[K]?.close` (manager-options > provider, NO built-in ⇒ no closing line when unset). `open`, the rendering, and `close` resolve INDEPENDENTLY, so an override may set only the open, only the rendering, only the close, or any mix — and `open` + `close` together WRAP the whole group. (The `## Workspace` text section has no cascade level of its own — it renders with the fixed `renderFencedFile` framing.)

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

A provider declares its framing default by exposing `format` on its `ProviderInterface`; the `Agent` passes it into `build()` automatically. Because it is OPTIONAL, no provider is forced to supply one — omitting it leaves every section on the managers' built-in framing.

### Factories

| API                               | Kind     | Summary                                                                                                                                                                                                                     |
| --------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createConversation`              | function | A `ConversationInterface` — messages above the flat store with compaction into summarized sections + a rollup, driven by a `ConversationSummaryHandler`.                                                                    |
| `createConversationManager`       | function | A `ConversationManagerInterface` — the id-keyed registry of conversations WITH an active pointer (`add` auto-activates the first; `switch` re-points it); its default `summarize` / `keep` flow into created conversations. |
| `createMemoryConversationStore`   | function | The in-memory `ConversationStoreInterface` — a process-lifetime `Map` of `ConversationSnapshot`s (the default `open` / `save` backing).                                                                                     |
| `createDatabaseConversationStore` | function | A `ConversationStoreInterface` over a `DriverInterface` (default `createMemoryDriver()`) — the snapshot as one opaque JSON column (durable twin).                                                                           |
| `createInstruction`               | function | An immutable `InstructionInterface` — a named directive (`name` / `content` / optional `priority`).                                                                                                                         |
| `createInstructionManager`        | function | An empty `InstructionManagerInterface` — the name-keyed instruction registry (listed by descending `priority`).                                                                                                             |
| `createScope`                     | function | An immutable `ScopeInterface` — a named allow-list filter (`narrow` composes by intersection).                                                                                                                              |
| `createScopeManager`              | function | An empty `ScopeManagerInterface` — the id-keyed registry of reusable named scopes.                                                                                                                                          |
| `createAgentContext`              | function | An `AgentContextInterface` — the richer `system` + managers + `messages` + `tools` + `scope` context; `build()` the input.                                                                                                  |
| `createAgent`                     | function | An `AgentInterface` — the bounded loop over a `ProviderInterface`; `generate` (one-shot) / `stream` (live).                                                                                                                 |
| `createAuthority`                 | function | An `AuthorityInterface` — the synchronous policy gate (ordered first-match-wins rules + a configurable fallback).                                                                                                           |
| `createThinkSplitter`             | function | A fresh `ThinkSplitterInterface` — the stream-stateful `<think>…</think>` separator a provider routes content deltas through (one splitter per stream).                                                                     |
| `createChannel`                   | function | An empty `ChannelInterface` — the unbounded async channel a producer `push`es into and `close` / `fail`s while a consumer `drain`s it live.                                                                                 |
| `createAgentRegistry`             | function | An `AgentRegistryInterface` — the named pools that resolve a job's names + `build` a seeded, signal-wired agent.                                                                                                            |
| `createAgentQueue`                | function | A durable, bounded-concurrency `QueueInterface` of `AgentJobInput` → `AgentResult` (composes `createQueue`).                                                                                                                |
| `createAgentRunner`               | function | A one-shot, fail-fast `RunnerInterface` of `AgentJobInput` → `AgentResult` with sub-agent fan-out (`createRunner`).                                                                                                         |

### Entities

| API                         | Kind  | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Conversation`              | class | A conversation that OWNS its live message tail DIRECTLY (the flat store verbs `add` / `message` / `messages` / `remove` / `clear` / `count` folded in, like a `Workspace` owns its files) — the live tail + compacted summarized `sections` + a regenerated rollup `summary` + the `summarizable` flag; `compact` folds older live → a section through the `ConversationSummaryHandler` seam, `rehydrate` / `search` read the retained originals; observable `emitter` (`ConversationEventMap`).                                                        |
| `ConversationManager`       | class | The id-keyed registry of `Conversation`s WITH an active pointer — `add` (auto-activates the first, flows the manager's default `summarize` / `keep` in, a per-`add` override wins), `switch` re-points `active`, `open` / `save` (the durable `store` seam), `conversation` / `conversations` / `remove` (clears `active` if removed) / `clear` / `count`; event-free (each conversation owns its `emitter`).                                                                                                                                           |
| `MemoryConversationStore`   | class | The in-memory `ConversationStoreInterface` — a process-lifetime `Map` of `ConversationSnapshot`s keyed by id (`get` / `set` / `delete`, async; no TTL); the default `open` / `save` backing.                                                                                                                                                                                                                                                                                                                                                            |
| `DatabaseConversationStore` | class | A `ConversationStoreInterface` over one `databases` table — the snapshot as ONE opaque JSON column, narrowed back on `get` by `isConversationSnapshot` (the total boundary guard); the driver-pluggable twin of `MemoryConversationStore`.                                                                                                                                                                                                                                                                                                              |
| `Instruction`               | class | An immutable named directive — `name` / `content` / `priority` (default `0`), the `id` minted at construction.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `InstructionManager`        | class | The instruction registry — immutable instructions keyed by `name` (last write wins), listed by descending `priority`; `open` / `render` build contract; observable `emitter` (`InstructionManagerEventMap`).                                                                                                                                                                                                                                                                                                                                            |
| `Scope`                     | class | A named, immutable allow-list filter — one list per category (`undefined` ⇒ all, `[]` ⇒ none, else only-listed); `narrow` composes a tighter child by set-intersection.                                                                                                                                                                                                                                                                                                                                                                                 |
| `ScopeManager`              | class | The id-keyed registry of reusable named scopes — `create` mints + stores (always adds), `scope` / `scopes` / `remove` / `clear`; observable `emitter` (`ScopeManagerEventMap`).                                                                                                                                                                                                                                                                                                                                                                         |
| `AgentContext`              | class | The turn context — `system` + the instruction manager + the workspace registry (the only document channel) + `messages` + the loop's `tools` registry + a readonly `scope` changed through `apply`; `build()` folds the scoped managers and the active workspace into one system block, then the conversation, and never reads `tools`.                                                                                                                                                                                                                 |
| `Agent`                     | class | The agent loop — one `#run` shared by `generate` / `stream`, bounded by `AbortSignal.any([signal, timeout, budget])`, paced by `scheduler`, tool iteration capped at `limit`.                                                                                                                                                                                                                                                                                                                                                                           |
| `Authority`                 | class | The synchronous policy gate — `evaluate` walks ordered rules first-match-wins, falling back to a configurable default (allow-unmatched by default; deny-by-default when its `fallback` denies).                                                                                                                                                                                                                                                                                                                                                         |
| `AgentRegistry`             | class | The job-rehydration bridge — resolves a serializable `AgentJobInput`'s names (`provider` / `tool` / `authority` / `scheduler`, throwing on a miss) and `build`s a seeded, signal-wired `Agent` from it.                                                                                                                                                                                                                                                                                                                                                 |
| `Channel`                   | class | The `ChannelInterface` implementation — an unbounded async channel a producer `push`es chunks into and `close` / `fail`s, a consumer `drain`s live through the resolver-swap park. The `Agent`'s eager pump writes to one so `result` settles regardless of whether `events` is drained.                                                                                                                                                                                                                                                                |
| `ThinkSplitter`             | class | The stream-stateful `<think>` separator — `split(delta)` returns the CLEAN content of each raw wire delta (reasoning spans accumulate on `thinking`), holding a tag split ACROSS deltas until disambiguated; a bare leading `</think>` (the qwen3-template IMPLICIT open) RECLASSIFIES the surfaced prefix into `thinking` (the `content` accumulation is authoritative); `flush()` settles the stream end (an unclosed span lands on `thinking`, a never-completed partial tag returns as content). One per stream — a provider's think-tag guarantee. |

### Constants

| API                         | Kind  | Summary                                                                                                                                                                                    |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CONVERSATION_RECAP_PREFIX` | const | The lean framing label `Conversation.view()` prefixes onto each compacted section summary so a small model reads it as a RECAP, not a literal turn — a fixed handful of tokens (no-bloat). |
| `DEFAULT_AGENT_LIMIT`       | const | The default cap on an agent turn's tool iterations — `10`; overridable through `AgentOptions.limit`.                                                                                       |
| `DEFAULT_AUTHORITY_ZONE`    | const | The zone an `Authority`'s default allow fallback carries — `'default'` (an unmatched call is allowed under this zone).                                                                     |
| `DEFAULT_CONVERSATION_KEEP` | const | The default recent live messages a `Conversation.compact()` retains — `0` (fold ALL); a `keep` retains a tail.                                                                             |
| `THINK_OPEN`                | const | The opening tag a `ThinkSplitter` recognizes as the start of an in-content reasoning span — `'<think>'` (the de-facto thinking-model wire convention).                                     |
| `THINK_CLOSE`               | const | The closing tag that ends a `THINK_OPEN` reasoning span — `'</think>'`; an unclosed span is treated as thinking to the stream's end (`flush`).                                             |
| `WORKSPACE_SECTION_HEADER`  | const | The `## Workspace` system-block header `AgentContext.build()` renders the ACTIVE workspace's text files under — the header is agent's, like the rest of the prompt projection.             |
| `MESSAGE_TOKEN_OVERHEAD`    | const | The estimated per-message role/framing overhead `estimateMessages` adds on top of a message's content estimate — `4`.                                                                      |
| `IMAGE_TOKEN_ESTIMATE`      | const | The coarse, deliberately-approximate per-image token cost `estimateMessages` charges for each attached image — `512` (a base64 length is NOT a reliable token proxy).                      |

### Helpers

| API                    | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentResultToJSON`    | function | The projection of an `unknown` onto a fresh exact `JSONValue` imported from Contract. Captures each structural field once through a total boundary, accepts conforming accessors/inherited properties, preserves finite negative/fractional usage counts, rejects malformed fields, non-finite usage, throwing getters, and hostile/revoked proxies by returning `undefined`; drops extras and deep-gates the rebuilt object through Contract's `parseJSONValue`.                                                                                                                                                                                                                                                               |
| `filterAllowList`      | function | The scope allow-list filter over items — `undefined` ⇒ all, `[]` ⇒ none, else only-listed (order-preserving, total).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `estimateTokens`       | function | A string's estimated context-token footprint — the deterministic `ceil(length / 4)` char heuristic `estimateMessages` sums over.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `estimateMessages`     | function | A message batch's estimated footprint — content + `MESSAGE_TOKEN_OVERHEAD` per message + a tool-call JSON estimate + `IMAGE_TOKEN_ESTIMATE` per image; the default `consumer` for an agent's context `window` budget. Total — never throws, including on a circular `ToolCall.arguments` (falls back to a fixed contribution instead of the unreachable JSON length). The constants (`MESSAGE_TOKEN_OVERHEAD`, `IMAGE_TOKEN_ESTIMATE`, the `ceil(length / 4)` char heuristic) are deliberate, provider-agnostic APPROXIMATIONS, not an exact tokenizer count — actual window-sizing accuracy depends on the target model's own tokenization, so a caller wanting a sharper count supplies its own `consumer` to `createBudget`. |
| `sanitizeToken`        | function | One reported token count, normalized — non-finite / non-positive values become `0`; positive fractional values floor down.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `sanitizeUsage`        | function | A provider-reported `TokenUsage`, normalized — non-finite / negative fields floor to `0`, fractional fields floor down; applied automatically to BOTH a normal turn's `result.usage` and an abort's partial usage before either is charged/folded, so a buggy provider's dirty usage can never poison budget accounting.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `settleAgentJob`       | function | The settled result of a rehydrated agent under the partial policy (shared by `createAgentQueue` / `createAgentRunner`): a partial throws `AgentJobError` unless the `partial` policy is on; a natural finish resolves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `handleAgentQueueJob`  | function | The queue handler — one queued job rehydrated with its attempt signal and settled through the shared partial policy; the named handler composed by `createAgentQueue`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `handleAgentRunnerJob` | function | The runner handler — a job's declared children fanned out without inline-awaiting them, then its parent rehydrated and settled through the shared partial policy; the named handler composed by `createAgentRunner`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `renderFencedFile`     | function | A path-addressed text body as a fenced reference block (`File: <path>\n` ` ``` ` `<language> … `) — the framing `AgentContext`'s active-workspace text render emits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `joinThinking`         | function | The joined reasoning a run's provider calls separated from the answer — the first seeds the accumulation, a later one appends blank-line separated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sumUsage`             | function | Two `TokenUsage` values added field by field — the running total across a turn's provider calls (the first seeds it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `assembleResult`       | function | The settled `AgentResult` assembled from a run's `RunOutcome` — `thinking` / `usage` carried only when present, the loop-internal `exhausted` flag left out.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `denyCall`             | function | The denial `ToolResult` an authority-blocked call is fed back with — `denied: <reason>`, or the generic denial when no reason was given.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `renderSection`        | function | One context section rendered — the resolved `open`, each item's rendering, then the resolved `close`, blank-line joined; `undefined` when the section has no items.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `resolveOpen`          | function | One section's leading text, resolved through the format cascade — manager-options override > provider default > built-in header.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `resolveClose`         | function | One section's trailing text, resolved — manager-options override > provider default; `undefined` when neither sets one (there is no built-in close).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `resolveItem`          | function | One item's rendering, resolved — item override > manager-options override > provider default > the manager's built-in rendering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `attachImages`         | function | A copy of a message with image data merged onto `images` (its own first, then the attached), carrying `calls` only when present and never mutating the original.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `attachUserImages`     | function | A conversation with image data attached to its LAST user message — a new array with that one message replaced by its carrying copy; unchanged for no data or no user turn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `collectImageData`     | function | The `base64` payload of the IMAGE files in a workspace file list — the payload `AgentContext.build()` attaches to the last user message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `buildSummaryMessage`  | function | The RAW synthetic summary message for one compacted section — its `summary` verbatim, keyed by the section `id` (what the rollup digests).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `buildRecapMessage`    | function | The FRAMED recap message for one compacted section — the same message prefixed with `CONVERSATION_RECAP_PREFIX`, so a small model reads it as a recap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `intersectKeys`        | function | The intersection of two scope allow-lists under the "`undefined` is the universal set" rule — a fresh copy, and narrowing can only tighten.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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

The total shape guards an untrusted read narrows through — each `(value: unknown) => value is T`, never throwing, returning `false` off-shape. An error guard stays in the Errors table beside the error it narrows.

| API                      | Kind     | Summary                                                                                                                                                                                                                                 |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isMessage`              | function | Narrowing guard: whether an `unknown` is structurally a `Message` record (the per-message step of `isConversationSnapshot` / `isSection`); a present `calls` must be an array of valid `ToolCall`s (`isToolCall`); total, never throws. |
| `isSection`              | function | Narrowing guard: whether an `unknown` is structurally a `Section` record (`string` `id` / `summary` + a `messages` array of valid `Message`s); the per-section step of `isConversationSnapshot`.                                        |
| `isConversationSnapshot` | function | The total read-boundary guard: whether an `unknown` is a `ConversationSnapshot` (`string` `id` + optional `string` `summary` + valid `sections` / `messages` arrays); total, never throws.                                              |

A `DatabaseConversationStore` reads its snapshot column back as `unknown` and narrows it through the last of them, so a malformed blob resolves `undefined` rather than a broken conversation:

```ts
import { isConversationSnapshot } from '@orkestrel/agent'

declare const row: unknown
const snapshot = isConversationSnapshot(row) ? row : undefined
```

### Errors

| API                    | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProviderAbortError`   | class    | Thrown by `stream` when its bound signal aborts mid-flight — carries the `partial` result streamed so far and a machine `code` (`'ABORT'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `isProviderAbortError` | function | The narrowing guard for a caught `ProviderAbortError` (`instanceof`), to recover its `partial`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `AgentJobError`        | class    | Thrown by an agent-job handler when a job ended partial and the `partial` policy is `false` — carries the partial `AgentResult` and a machine `code` (`'PARTIAL'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `isAgentJobError`      | function | The narrowing guard for a caught `AgentJobError` (`instanceof`), to recover its `partial`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ConversationError`    | class    | Thrown by `Conversation.compact()` / construction when no `ConversationSummaryHandler` was supplied, or a `sections` cap is sub-1 — carries a machine `code` (`'SUMMARIZER' \| 'SECTIONS'`).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `isConversationError`  | function | The narrowing guard for a caught `ConversationError` (`instanceof`), to branch on its `code`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `AgentError`           | class    | Thrown SYNCHRONOUSLY by `Agent.stream()` (and, because `generate()` calls `stream()` directly with zero loop logic of its own, `Agent.generate()` too) when a concurrent run would corrupt SHARED per-agent accounting, and by an `AgentRegistry` accessor when a rehydration name is absent from its pool — carries a machine `code` (`'CONCURRENCY' \| 'REGISTRY'`). Synchronous means a fire-and-forget `agent.generate().catch(...)` will NOT catch it (the throw happens on the call itself, before any `Promise` exists to attach `.catch` to) — `await` the call inside `try`/`catch`, or wrap the call expression in `try`/`catch`. |
| `isAgentError`         | function | The narrowing guard for a caught `AgentError` (`instanceof`), to branch on its `code`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Types

| Type                            | Kind      | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MessageRole`                   | type      | `'system' \| 'user' \| 'assistant' \| 'tool'` — the role a message plays in a turn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Message`                       | interface | `{ id; role: MessageRole; content; calls?: readonly ToolCall[]; images?: readonly string[] }` — one stored conversation turn (`calls` only on a replayed assistant turn; `images` base64 on a multimodal turn).                                                                                                                                                                                                                                                                                                                                                                   |
| `MessageInput`                  | interface | `{ role: MessageRole; content; calls?; images?: readonly string[] }` — the minimal data to author a message (the `id` is assigned by the storage layer; `images` base64 for a multimodal turn).                                                                                                                                                                                                                                                                                                                                                                                   |
| `ProviderResult`                | interface | `{ content; thinking?: string; tools?: readonly ToolCall[]; usage?: TokenUsage }` — one turn's assembled outcome (`thinking` is reasoning the provider SEPARATED from the answer — it never re-enters the conversation; `tools` / `usage` present only when applicable).                                                                                                                                                                                                                                                                                                          |
| `ProviderDelta`                 | type      | `{ channel: 'content'; text } \| { channel: 'thinking'; text }` — one live provider stream delta, keeping answer text and reasoning on separate channels.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ProviderStreamOptions`         | interface | `{ think?: boolean }` — per-call provider options; `think` overrides the provider default for one `generate` / `stream` call.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ProviderInterface`             | interface | `id` / `name` data members (+ an OPTIONAL `format?: ContextFormat` context-framing default) + the `generate` / `stream` methods — the pluggable LLM inference boundary.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ThinkSplitterInterface`        | interface | The `content` / `thinking` data members (the AUTHORITATIVE clean-content + reasoning accumulations) + the `split` / `flush` methods — the stream-stateful `<think>…</think>` separator a provider routes content deltas through (one per stream; tags split across deltas are held until disambiguated; a bare leading `</think>` — the implicit pre-seeded open — reclassifies the surfaced prefix into `thinking`).                                                                                                                                                             |
| `ContextSectionFormat`          | interface | `{ open?: string; render?: (item: T) => string; close?: string }` — one context section's optional open / item-render / close override trio (a cascade level's unit; `open` + `close` wrap the group).                                                                                                                                                                                                                                                                                                                                                                            |
| `ContextFormat`                 | interface | `{ instructions?: ContextSectionFormat<InstructionInterface> }` — a provider's optional context-framing default, keyed by section kind (the PROVIDER level of the build cascade).                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ContextSectionSourceInterface` | interface | `open` / `format` data members + the `render` method — the manager surface one section's format cascade reads (`InstructionManagerInterface` satisfies it structurally).                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MessageManagerInterface`       | interface | `count` data member + `add` / `message` / `messages` / `remove` / `clear` — the immutable message-store contract `AgentContextInterface.messages` is typed to (the active `ConversationInterface` satisfies it structurally; the `id` minted on `add`).                                                                                                                                                                                                                                                                                                                           |
| `InstructionInterface`          | interface | `{ id; name; content; priority; override? }` — an immutable named directive (`priority` defaults to `0`; `override` is the per-item render override, present-when-given).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `InstructionInput`              | interface | `{ name; content; priority?; override? }` — the minimal data to author an instruction (the `id` is minted; `override` is the per-item render override, round-tripped onto the entity).                                                                                                                                                                                                                                                                                                                                                                                            |
| `InstructionManagerEventMap`    | type      | `{ add; remove; clear }` — the instruction manager's push event map (the `on` / `emitter` surface).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `InstructionManagerOptions`     | interface | `{ on?: EmitterHooks<InstructionManagerEventMap>; format?: ContextSectionFormat<InstructionInterface> }` — `createInstructionManager` configuration (the reserved `on` hooks + the manager-options format override).                                                                                                                                                                                                                                                                                                                                                              |
| `InstructionManagerInterface`   | interface | `emitter` / `count` / `open` / `format` data members + `add` / `instruction` / `instructions` / `render` / `remove` / `clear` — the name-keyed instruction registry (sorted by descending `priority`).                                                                                                                                                                                                                                                                                                                                                                            |
| `ScopeFilter`                   | interface | `{ instructions?; tools?; files?: readonly string[] }` — the per-category allow-lists (`undefined` ⇒ all, `[]` ⇒ none, else only-listed); `files` filters the ACTIVE workspace's rendered files by `path`.                                                                                                                                                                                                                                                                                                                                                                        |
| `ScopeInput`                    | interface | `ScopeFilter` + `{ name }` — the data to author a scope (the `id` is minted by the layer that stores it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ScopeInterface`                | interface | `id` / `name` data members + the per-category allow-lists + the `narrow` method — a named, immutable filter; `narrow` composes a tighter child by set-intersection.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ScopeManagerEventMap`          | type      | `{ create; remove; clear }` — the scope manager's push event map (keyed by the minted `id`; `create`, not `add`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ScopeManagerOptions`           | interface | `{ on?: EmitterHooks<ScopeManagerEventMap> }` — `createScopeManager` configuration (the reserved `on` hooks).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ScopeManagerInterface`         | interface | `emitter` / `count` data members + `create` / `scope` / `scopes` / `remove` / `clear` — the id-keyed registry of reusable named scopes.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `AgentContextOptions`           | interface | `{ system?; tools?; instructions?; workspaces?: WorkspaceManagerInterface; scope?: ScopeInterface; conversations?: ConversationManagerInterface }` — `createAgentContext` configuration: the optional system prompt plus pre-built managers to reuse — a `workspaces` registry (the only document channel), a `conversations` registry (the message source), a `tools` registry (the loop's advertise/dispatch surface) — and an initial scope.                                                                                                                                   |
| `AgentContextInterface`         | interface | `system` / `instructions` / `messages` / `tools` / `scope` / `workspaces` / `conversations` readonly data members + the `apply` / `build` methods — the richer context; `apply(scope)` changes the active per-turn filter, while the structural workspace and conversation registries change their active members through their own `switch`; `build()` folds the scoped instructions + the active workspace's text files into one system block then the active conversation's view.                                                                                              |
| `AgentStatus`                   | type      | `'idle' \| 'running' \| 'done' \| 'error'` — an `AgentInterface` turn's lifecycle state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AgentChunk`                    | type      | `{ category: 'token'; content } \| { category: 'think'; content } \| { category: 'tool'; call; result } \| { category: 'usage'; usage }` — one streamed step of an agent turn (the PULL surface).                                                                                                                                                                                                                                                                                                                                                                                 |
| `AgentEventMap`                 | type      | `{ start; turn; tool; usage; deny; finish; error; abort; exhaust; fault }` — the agent's PUSH event map (lifecycle + usage/tool/deny + a non-fatal auto-compaction `fault`, no per-token); the `on` / `emitter` surface.                                                                                                                                                                                                                                                                                                                                                          |
| `AgentResult`                   | interface | `{ content; thinking?: string; usage?: TokenUsage; partial }` — an agent turn's settled outcome (`partial: true` when committed from a cancel; `usage` summed; `thinking` the reasoning the run's provider calls separated from the answer, joined — never re-enters the conversation).                                                                                                                                                                                                                                                                                           |
| `RunOutcome`                    | interface | `{ content; thinking: string \| undefined; usage: TokenUsage \| undefined; partial; exhausted }` — the INTERNAL per-run outcome the loop returns when it settles, assembled from there into the public `AgentResult`.                                                                                                                                                                                                                                                                                                                                                             |
| `ChannelInterface`              | interface | The `push` / `close` / `fail` / `drain` methods — the unbounded async channel a producer writes into and a consumer drains live (an agent's eager pump writes one, which is why `result` settles undrained).                                                                                                                                                                                                                                                                                                                                                                      |
| `StreamInterface`               | interface | `{ events: AsyncIterable<T>; result: Promise<R> }` data members + the `abort` method — the generic live-events + settled-result + cancel handle.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `AgentStreamInterface`          | type      | `StreamInterface<AgentChunk, AgentResult>` — the agent turn's live handle (events of chunks resolving a result).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `AgentOptions`                  | interface | `{ on?; system?; tools?; instructions?; workspaces?; scope?; limit?; timeout?; budget?; scheduler?; signal?; authority?; conversations?; window?; strict? }` — `createAgent` configuration (the loop's bounds + pacing + the reserved `on` hooks; `instructions` / `workspaces` / `scope` forward construction-time context wiring; a `conversations` registry is the message source; a context `window` Budget opts into automatic compaction of the active conversation; `strict` aborts the run on an automatic-compaction summarizer failure instead of the lenient default). |
| `AgentRunOptions`               | interface | `{ think?; schema?; limit?; timeout?; budget?; signal? }` — the per-run override bag for `AgentInterface.generate` / `.stream`; each member overrides its `AgentOptions` default for ONE run (`think` / `schema` forward to the provider call, `signal` COMPOSES with the constructed one).                                                                                                                                                                                                                                                                                       |
| `AgentInterface`                | interface | `emitter` / `id` / `status` / `context` data members + the `generate` / `stream` / `abort` methods — the bounded agent loop.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `AuthorityContext`              | interface | `{ call: ToolCall }` — what an `AuthorityInterface` evaluates for one tool call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `AuthorityDecision`             | interface | `{ zone; allowed; reason? }` — an authority's verdict on one tool call (`zone` a project classification, `allowed` the gate decision).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `AuthorityRule`                 | interface | `{ match; zone; allowed?; reason? }` — one ordered policy rule (first match wins; allows unless `allowed: false`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `AuthorityOptions`              | interface | `{ rules?: readonly AuthorityRule[]; fallback?: AuthorityDecision }` — `createAuthority` configuration (ordered rules + no-match fallback).                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `AuthorityInterface`            | interface | The `evaluate` method — the synchronous policy gate consulted before each tool call (ordered first-match-wins, configurable fallback).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `AgentJobInput`                 | interface | `{ provider; messages; system?; tools?; authority?; scheduler?; limit?; timeout?; budget?; children? }` — a JSON-serializable agent job (names resolve through a registry; data carries directly).                                                                                                                                                                                                                                                                                                                                                                                |
| `AgentRegistryInterface`        | interface | The `provider` / `tool` / `authority` / `scheduler` / `build` methods — resolves a job's names to live pieces and rehydrates a seeded, signal-wired agent.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AgentRegistryOptions`          | interface | `{ providers; tools?; authorities?; schedulers?; store? }` — `createAgentRegistry` configuration (the named pools a job's names resolve against + the optional durable `store` every built agent's conversation manager shares).                                                                                                                                                                                                                                                                                                                                                  |
| `AgentQueueOptions`             | interface | `{ registry; partial?; concurrency?; retries?; timeout?; store? }` — `createAgentQueue` configuration (the partial policy + the backing-queue knobs).                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `AgentRunnerOptions`            | interface | `{ registry; partial?; concurrency?; retries?; timeout? }` — `createAgentRunner` configuration (the partial policy + the backing-runner knobs).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ConversationSummaryHandler`    | type      | `(messages: readonly Message[]) => Promise<string>` — the provider-agnostic summarizer seam the agent runtime supplies (core never imports a provider).                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Section`                       | interface | `{ id; summary; messages: readonly Message[] }` — a slice of folded messages digested into a summary (the unit of compaction; `messages` RETAINED for `rehydrate` / `search`).                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ConversationEventMap`          | type      | `{ compact; summary; rehydrate; collapse }` — a conversation's push event map (the `on` / `emitter` surface; `collapse` fires when the `sections` cap folds the oldest overflow into one merged section).                                                                                                                                                                                                                                                                                                                                                                         |
| `ConversationOptions`           | interface | `{ id?; on?; summarize?; keep?; sections?; snapshot? }` — `createConversation` configuration (the seam + retained-tail size + an optional `>= 1` cap on the compacted `sections` list + a `ConversationSnapshot` to hydrate from, whose `id` wins over `id`; absent `summarize` ⇒ `compact()` throws; a sub-1 `sections` throws `ConversationError('SECTIONS')`).                                                                                                                                                                                                                 |
| `CompactOptions`                | interface | `{ keep?; sections? }` — per-compaction overrides for `Conversation.compact()` (override the retained-tail size, the `sections` cap, or both, for ONE fold).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ConversationReferenceOptions`  | interface | `{ label?; summary?; messages? }` — how `Conversation.reference()` renders this conversation as a cross-conversation provenance block (`label` defaults to the `id`, `summary` defaults true, `messages` are cherry-picked excerpts defaulting to none).                                                                                                                                                                                                                                                                                                                          |
| `ConversationInterface`         | interface | `id` / `emitter` / `summary` / `sections` / `summarizable` / `messages` data members + the `view` / `compact` / `rehydrate` / `search` / `reference` / `snapshot` methods — messages above the flat store with compaction + rehydrate + search + cross-conversation reference + a JSON `snapshot` (`summarizable` is `true` when a summarizer was supplied — the agent loop gates AUTO-compaction on it).                                                                                                                                                                         |
| `ConversationInput`             | interface | `{ id?; summarize?; keep?; sections?; on?; snapshot? }` — the data to author a conversation through a `ConversationManager` (a `summarize` / `keep` / `sections` override + the reserved `on` + a snapshot to hydrate from).                                                                                                                                                                                                                                                                                                                                                      |
| `ConversationManagerOptions`    | interface | `{ summarize?; keep?; sections?; store? }` — `createConversationManager` configuration (the default summarizer + retained-tail size + `sections` cap flowed into created conversations, + the optional durable `store` backing `open` / `save`).                                                                                                                                                                                                                                                                                                                                  |
| `ConversationManagerInterface`  | interface | `count` / `active` data members + `conversation` / `conversations` / `add` / `switch` / `open` / `save` / `remove` / `clear` — the id-keyed registry of conversations with an active pointer + the durable `store` seam (event-free; `add` auto-activates the first, `switch` re-points `active`).                                                                                                                                                                                                                                                                                |
| `ConversationSnapshot`          | interface | `{ id, summary?, sections, messages }` — the JSON-serializable durable payload (`id` + the rollup `summary` + compacted `sections` + the live tail); `Conversation.snapshot()` produces it.                                                                                                                                                                                                                                                                                                                                                                                       |
| `ConversationStoreInterface`    | interface | `get` / `set` / `delete` — the async, non-generic persistence seam for a `ConversationSnapshot` keyed by its own id (no TTL); memory and database implementations are included.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `ConversationSnapshotRow`       | interface | `{ id, snapshot }` — one `DatabaseConversationStore` table row (the snapshot one opaque JSON column, read back as `unknown`, narrowed on `get`).                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Agent-owned readonly data members stay in the Surface tables above; their call-signature methods are documented below. Tool contracts resolve to [`tool.md`](tool.md) and workspace contracts to [`workspace.md`](workspace.md) — neither dependency surface is duplicated or re-exported here. Note where the boundary falls inside the context: `instructions`, `conversations`, and `workspaces` are the managers `build()` renders a prompt from, while `tools` is loop machinery for advertising and dispatch and is never read by `build()` at all.

## Methods

The tables list every public call-signature member of `ProviderInterface`, `ThinkSplitterInterface`, `MessageManagerInterface`, `InstructionManagerInterface`, `ContextSectionSourceInterface`, `ScopeInterface`, `ScopeManagerInterface`, `AgentContextInterface`, `AgentInterface`, `ChannelInterface`, `AuthorityInterface`, `AgentRegistryInterface`, `ConversationInterface`, and `ConversationManagerInterface`. Their readonly data members remain Surface rows. `ThinkSplitter`, `InstructionManager`, `Scope`, `ScopeManager`, `AgentContext`, `Agent`, `Authority`, `AgentRegistry`, `Conversation`, and `ConversationManager` implement their interfaces exactly, so the tables also describe those classes' instance methods. `MessageManagerInterface` has no separate concrete class here: the active `Conversation` satisfies it structurally. A host application supplies the concrete `ProviderInterface`. Tool and workspace methods live in their dependency guides. `StreamInterface<T, R>` is the generic live handle (`events`, `result`, and `abort(reason?)`); `AgentStreamInterface` specializes it for `AgentChunk` and `AgentResult`.

#### `ProviderInterface`

`generate` produces one complete turn; `stream` yields `ProviderDelta`s and RETURNS the assembled result. Both take the conversation, a bounding `AbortSignal`, optional `tools`, and optional per-call `ProviderStreamOptions`.

| Method     | Returns                                         | Behavior                                                                                                                                                  |
| ---------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate` | `Promise<ProviderResult>`                       | Generate one complete turn — resolve the assembled result (content + any tool calls + any usage). An abort rejects the call.                              |
| `stream`   | `AsyncGenerator<ProviderDelta, ProviderResult>` | Stream one turn — yield channel-tagged content / thinking deltas, RETURN the assembled result. A mid-stream abort throws `ProviderAbortError`-w/-partial. |

#### `ThinkSplitterInterface`

The stream-stateful `<think>…</think>` separator a provider routes raw content deltas through, so it yields clean content and surfaces the reasoning as `ProviderResult.thinking`. The `content` / `thinking` data members (the AUTHORITATIVE clean-content + reasoning accumulations) stay Surface rows — `content` matters because some chat templates PRE-SEED `<think>` into the prompt scaffold (the qwen3 shape), so only a bare `</think>` ever appears on the wire: before any tag event, that bare close RECLASSIFIES everything surfaced so far into `thinking` (one-shot — afterwards a bare close is plain text), correcting `content` retroactively where the already-returned deltas cannot be recalled. One splitter serves ONE stream — create a fresh one per call (`createThinkSplitter`).

| Method  | Returns  | Behavior                                                                                                                                                                                       |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `split` | `string` | Feed one raw delta; returns the CLEAN (non-think) content to surface for it (possibly `''`). A tag split ACROSS deltas is HELD until disambiguated — never leaked as content, never mis-eaten. |
| `flush` | `string` | Settle the stream end — a held partial tag that never completed returns as the final content delta (it was real text); an UNCLOSED think span's tail lands on `thinking` (the cut-off model).  |

#### `MessageManagerInterface`

The immutable conversation store. `add` mints each message's `id` and carries batch overloads (one input → one message, a batch → the array); `remove` carries batch overloads (one or a list). The `count` data member stays a Surface row.

| Method     | Returns                          | Behavior                                                                                                                         |
| ---------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `add`      | `Message` / `readonly Message[]` | Store one `MessageInput`, or a batch — MINTS each message's `id`, returns the created message(s); a stored message is immutable. |
| `message`  | `Message \| undefined`           | Look up one stored message by id (`undefined` when absent).                                                                      |
| `messages` | `readonly Message[]`             | List every stored message, in insertion order.                                                                                   |
| `remove`   | `boolean`                        | Remove one message by id, or a batch — `true` only when EVERY supplied id was removed.                                           |
| `clear`    | `void`                           | Remove every stored message.                                                                                                     |

#### `InstructionManagerInterface`

The name-keyed instruction registry a richer context renders a directives block from. `add` mints each `id` and carries batch overloads (a re-`add` of the same name overwrites it, last write wins); `remove` carries batch overloads. The `emitter` / `count` / `open` / `format` data members stay Surface rows.

| Method         | Returns                                                    | Behavior                                                                                                               |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `add`          | `InstructionInterface` / `readonly InstructionInterface[]` | Add one `InstructionInput`, or a batch — MINTS each `id`; a re-`add` of the same name OVERWRITES it (last write wins). |
| `instruction`  | `InstructionInterface \| undefined`                        | Look up one instruction by name (`undefined` when absent).                                                             |
| `instructions` | `readonly InstructionInterface[]`                          | List every instruction, SORTED by descending `priority` (stable for equal priorities).                                 |
| `render`       | `string`                                                   | Render one instruction for the prompt — its `content`.                                                                 |
| `remove`       | `boolean`                                                  | Remove one instruction by name, or a batch — `true` only when EVERY supplied name was removed.                         |
| `clear`        | `void`                                                     | Remove every instruction.                                                                                              |

#### `ContextSectionSourceInterface`

The manager surface one section's format cascade reads. `render` is its only method — the `open` (the built-in header) and `format` (the raw manager-options override) data members stay Surface rows. An `InstructionManagerInterface` satisfies it structurally, which is what lets `resolveOpen` / `resolveClose` / `resolveItem` stay independent of which manager supplies the section.

| Method   | Returns  | Behavior                                                                                                      |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `render` | `string` | Render one section item, already resolved against the manager-options override (else the built-in rendering). |

#### `ScopeInterface`

The named, immutable allow-list filter. `narrow` is the only method — the `id` / `name` data members and the per-category allow-lists stay Surface rows.

| Method   | Returns          | Behavior                                                                                                                                                                                             |
| -------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `narrow` | `ScopeInterface` | Compose a tighter child scope — each category the set-INTERSECTION of this scope's list and `config`'s (an `undefined` side imposes no constraint); returns a NEW scope, leaving this one unchanged. |

#### `ScopeManagerInterface`

The id-keyed registry of reusable named scopes. `create` mints + stores a scope (always adds — never overwrites, since two scopes may share a `name`); `remove` carries batch overloads. The `emitter` / `count` data members stay Surface rows.

| Method   | Returns                       | Behavior                                                                                              |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `create` | `ScopeInterface`              | Mint a scope from a `ScopeInput` (an `id` + the per-category allow-lists) and store it — always adds. |
| `scope`  | `ScopeInterface \| undefined` | Look up one scope by id (`undefined` when absent).                                                    |
| `scopes` | `readonly ScopeInterface[]`   | List every scope, in insertion order.                                                                 |
| `remove` | `boolean`                     | Remove one scope by id, or a batch — `true` only when EVERY supplied id was removed.                  |
| `clear`  | `void`                        | Remove every scope.                                                                                   |

#### `AgentContextInterface`

The richer turn context. `apply` changes the active per-turn filter and `build` assembles the provider input. The `system` / `instructions` / `messages` / `tools` / `scope` / `workspaces` / `conversations` readonly data members stay Surface rows.

| Method  | Returns              | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply` | `void`               | Apply the given scope as the active per-turn filter; pass `undefined` explicitly to remove filtering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `build` | `readonly Message[]` | The next turn's provider input: a leading `system` message folding the prompt + the scope-filtered instructions (each section's header + each item's rendering resolved through the FORMAT CASCADE) PLUS the ACTIVE workspace's scope-filtered (`scope.files`) TEXT files in a `## Workspace` section (fenced), then the active conversation's `view()` — with the active workspace's image files' `base64` payload attached to the last user message. Takes an OPTIONAL `format?: ContextFormat` (the PROVIDER level — typically `provider.format`); omitting it, with no overrides set, renders each section on its manager's built-in framing. The `system` message is prepended only when any part exists; the active-workspace render is ACTIVE-ONLY; tools are NOT in the prompt. Built fresh each call. |

#### `AgentInterface`

The bounded agent loop. `generate` and `stream` share ONE private run (`generate` drains the same stream `stream` exposes, so they can't diverge); `abort` cancels the in-flight turn. The `emitter` / `id` / `status` / `context` data members stay Surface rows (`emitter` is a `readonly` accessor — a property, not a method).

| Method     | Returns                | Behavior                                                                                                                                                            |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate` | `Promise<AgentResult>` | Run the turn to completion, discarding the live chunks — drains the shared stream and resolves the settled `AgentResult` (`partial: true` when cancelled).          |
| `stream`   | `AgentStreamInterface` | Run the turn as a live stream — iterate `events` for `AgentChunk`s, `await result` for the outcome; `result` RESOLVES partial on a cancel, rejects on a real error. |
| `abort`    | `void`                 | Cancel the in-flight turn — fires the turn's signal; the `result` settles `partial: true` with whatever content accumulated.                                        |

#### `ChannelInterface`

The unbounded async channel. A producer writes with `push` and ends it with `close` or `fail`; a consumer reads it back live with `drain`. Write and read are decoupled, so the producer never waits for a consumer — an agent's eager pump writes each chunk into one, which is why the run's `result` settles whether or not `events` is ever drained. It carries no data members.

| Method  | Returns                   | Behavior                                                                                                                               |
| ------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `push`  | `void`                    | Write one value — buffered, then handed to a parked consumer (a value pushed at an already-parked reader is delivered, never dropped). |
| `close` | `void`                    | End the channel normally — a draining consumer returns once the buffer is empty.                                                       |
| `fail`  | `void`                    | End the channel with a failure — a draining consumer throws it once the buffer is empty; the FIRST failure wins.                       |
| `drain` | `AsyncGenerator<T, void>` | Read the values back live, in write order — returning on `close`, throwing on `fail`.                                                  |

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

| Method     | Returns             | Behavior                                                                                                                                                       |
| ---------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluate` | `AuthorityDecision` | Evaluate one tool call against the ordered rules — return the FIRST matching rule's verdict (allows unless `allowed: false`), or the fallback when none match. |

#### `AgentRegistryInterface`

The job-rehydration bridge. `provider` / `tool` / `authority` / `scheduler` resolve a name against their pool (throwing `unknown <category>: <name>` on a miss); `build` rehydrates a seeded, signal-wired agent from a serializable job. It has no data members.

| Method      | Returns              | Behavior                                                                                                                                                                |
| ----------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`  | `ProviderInterface`  | Resolve a registered provider by name — THROWS `unknown provider: <name>` when absent.                                                                                  |
| `tool`      | `ToolInterface`      | Resolve a registered tool by name — THROWS `unknown tool: <name>` when absent.                                                                                          |
| `authority` | `AuthorityInterface` | Resolve a registered authority by name — THROWS `unknown authority: <name>` when absent.                                                                                |
| `scheduler` | `SchedulerInterface` | Resolve a registered scheduler by name — THROWS `unknown scheduler: <name>` when absent.                                                                                |
| `build`     | `AgentInterface`     | Rehydrate a seeded, signal-wired agent from an `AgentJobInput` — resolve its names, rebuild its token budget, seed its conversation, thread `signal`; throws on a miss. |

#### `ConversationInterface`

A conversation that OWNS its live message tail DIRECTLY (the flat store verbs folded in, like a `Workspace` owns its files). `add` mints each message's `id` and stores it (batch overloads); `message` / `messages` look up the live tail; `remove` / `clear` drop from it. `view` is the model input; `compact` folds the older live messages into a summarized `Section` (regenerating the rollup, emitting `summary` then `compact`); `rehydrate` / `search` read the retained originals; `reference` renders this conversation as a provenance-labeled block to pull INTO another (a pure string, no model call). The `id` / `emitter` / `summary` / `sections` / `count` data members stay Surface rows (`emitter` is a `readonly` accessor — a property, not a method).

| Method      | Returns                          | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`       | `Message` / `readonly Message[]` | Append one `MessageInput` to the live tail, or a batch — MINTS each message's `id`, returns the created message(s); a stored message is immutable.                                                                                                                                                                                                                                                                                                      |
| `message`   | `Message \| undefined`           | Look up one LIVE message by id (`undefined` when absent).                                                                                                                                                                                                                                                                                                                                                                                               |
| `messages`  | `readonly Message[]`             | List the LIVE (uncompacted) tail, in insertion order.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `remove`    | `boolean`                        | Remove one LIVE message by id, or a batch — `true` only when EVERY supplied id was removed.                                                                                                                                                                                                                                                                                                                                                             |
| `clear`     | `void`                           | Empty the live tail (the compacted `sections` are untouched).                                                                                                                                                                                                                                                                                                                                                                                           |
| `view`      | `readonly Message[]`             | The model input — each section as ONE synthetic RECAP message (its summary prefixed with `CONVERSATION_RECAP_PREFIX`, so a small model reads it as a recap not a literal turn), then the live tail verbatim (the rollup `summary` is NOT injected).                                                                                                                                                                                                     |
| `compact`   | `Promise<Section \| undefined>`  | Fold the oldest `count - keep` live messages into a summarized section (through the `ConversationSummaryHandler`), remove them from the live tail, REGENERATE the rollup, emit `summary` then `compact`; `undefined` when nothing folds (`count <= keep`). THROWS a `ConversationError` when no summarizer was supplied.                                                                                                                                |
| `rehydrate` | `readonly Message[]`             | A section's full original messages — a pure READ that emits `rehydrate` (empty for an unknown id; `rehydrate` never reinserts).                                                                                                                                                                                                                                                                                                                         |
| `search`    | `readonly Message[]`             | Case-insensitive substring over `content` across ALL messages — every section's retained originals, then the live tail.                                                                                                                                                                                                                                                                                                                                 |
| `reference` | `string`                         | Render THIS conversation as a self-labeled, fenced PROVENANCE block to pull INTO another (by writing it to the active context's active workspace) — a PURE string, no model call: a leading `[Reference — conversation "<label>" — NOT part of this conversation]` marker, the rollup `Summary:` (when `summary !== false` + one exists), and the cherry-picked excerpts (`- role: content`) when `messages` is supplied. `label` defaults to the `id`. |
| `snapshot`  | `ConversationSnapshot`           | Serialize the conversation to a plain `{ id, summary?, sections, messages }` payload (the `ConversationStoreInterface` payload; the durable analogue of the `snapshot` option — the live `summarize` / `keep` are NOT serialized, they are config re-supplied on hydrate).                                                                                                                                                                              |

#### `ConversationManagerInterface`

The id-keyed registry of `Conversation`s WITH an active pointer. `add(input?)` mints a conversation (flowing the manager's default `summarize` / `keep` in unless the input overrides them) and AUTO-ACTIVATES the FIRST one; a later `add` leaves `active` unchanged. `switch(id)` re-points `active` (an unknown `id` returns `undefined`, leaving `active` unchanged — lenient, never throws); `remove` carries batch overloads (the array overload first) and clears `active` when the removed conversation was active. The `count` AND `active` data members stay Surface rows (`active` is a `readonly` accessor — a property, not a method); the manager is event-free (each conversation owns its `emitter`).

| Method          | Returns                                       | Behavior                                                                                                                                                                                                           |
| --------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `conversation`  | `ConversationInterface \| undefined`          | Look up one conversation by id (`undefined` when absent).                                                                                                                                                          |
| `conversations` | `readonly ConversationInterface[]`            | List every conversation, in insertion order.                                                                                                                                                                       |
| `add`           | `ConversationInterface`                       | Mint a conversation (its `id` from the input or a UUID), flowing the manager's default `summarize` / `keep` in unless overridden; auto-activates the first (an already-present `id` overwrites — last write wins). |
| `switch`        | `ConversationInterface \| undefined`          | Re-point `active` to the conversation with `id`, returning it; an unknown `id` returns `undefined` and leaves `active` unchanged (never throws).                                                                   |
| `open`          | `Promise<ConversationInterface \| undefined>` | Resolve + ACTIVATE a conversation by id — from the registry (no store hit), else HYDRATED from the `store` through the `snapshot` seam; `undefined` when neither registered nor stored (lenient).                  |
| `save`          | `Promise<boolean>`                            | Persist a REGISTERED conversation's `snapshot()` to the `store` — `true` when persisted, `false` when no store / unknown id (a no-op, never throws).                                                               |
| `remove`        | `boolean`                                     | Remove one conversation by id, or a batch — `true` only when EVERY supplied id was removed; clears `active` when a removed conversation was active.                                                                |
| `clear`         | `void`                                        | Remove every conversation and clear `active`.                                                                                                                                                                      |

## Contract

These invariants hold across `src/core` ↔ `agent.md`:

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `const` / `interface` / `type` row in the `## Surface` tables is a real export of `src/core`, and every export appears as a Surface row — exhaustive, both directions.
2. **`ProviderInterface` is the abstract inference boundary.** A provider turns a conversation (plus optional `tools`, a non-empty `ToolDefinition[]`) into a turn: `generate` resolves the assembled `ProviderResult`, `stream` yields channel-tagged `ProviderDelta`s and RETURNS the assembled result. Both methods accept optional `ProviderStreamOptions`; `think` is the per-call reasoning override. It carries an `id` (a per-instance trace label) and `name` (the backend identifier). This module defines ONLY the contract — a concrete implementation is a host application's responsibility.
3. **`stream` yields deltas + RETURNS the assembled result.** A `ProviderInterface.stream` yields each non-empty answer delta as `{ channel: 'content', text }` and each native live reasoning delta as `{ channel: 'thinking', text }`; its RETURN value is the assembled `ProviderResult` whose `content` is the provider's authoritative clean answer, plus any tool calls and usage the turn reported. So a caller can render tokens and reasoning live while still recovering the complete outcome from the generator's return value. A thinking model's reasoning is SEPARATED at the provider, never assembled as content: a concrete provider routes its raw wire content through a `ThinkSplitter` (`createThinkSplitter` — one per stream), yields the CLEAN content, assembles `content` from the splitter's AUTHORITATIVE accumulation (an IMPLICIT pre-seeded open — the qwen3-template bare `</think>` — reclassifies the already-yielded prefix into thinking, the one shape where live content deltas can transiently over-report), and surfaces the accumulated reasoning as `ProviderResult.thinking` — which never re-enters the conversation (the `Agent` joins it across a run's calls onto `AgentResult.thinking` as display/audit metadata).
4. **Usage reuses `TokenUsage`.** `ProviderResult.usage` is the [budgets](budget.md) `TokenUsage` shape (`{ prompt, completion, total }`), imported not redefined, present only when the turn reported it — so a caller folds it straight into a token budget. A provider surfaces it when the wire carries it (for example a stream's `done` line / a non-stream body) and omits it otherwise.
5. **Bounded by an `AbortSignal`.** Both `generate` and `stream` take an `AbortSignal`, so a caller bounds the request — a cancel, a [timeout](timeout.md), and a token [budget](budget.md) folded into one signal through `AbortSignal.any`. An already-aborted signal rejects the call before any content streams. (How a concrete provider also arms its own deadline is that implementation's own contract.)
6. **Abort → `ProviderAbortError` with the partial.** A `stream` cancelled mid-flight throws a `ProviderAbortError` whose `partial` is the `ProviderResult` assembled from whatever streamed so far (content + any tool calls + any usage); `isProviderAbortError` narrows a caught value so the loop can recover the partial content. A non-abort error propagates unchanged. `ProviderAbortError` is the abstract boundary's error — it stays in this module so the agent loop catches it regardless of which backend is in use.
7. **The message-store contract (`MessageManagerInterface`).** `MessageManagerInterface` is the immutable message-store contract `AgentContextInterface.messages` is typed to — `count` + `add` / `message` / `messages` / `remove` / `clear`. It has NO concrete class in this module: the active `Conversation` (which OWNS its live tail directly) satisfies it STRUCTURALLY, so `context.messages` IS the active conversation (the conversation-layer clause). `add` takes one `MessageInput` or a batch and MINTS each message's `id` (`crypto.randomUUID()`), carrying the input's `role` / `content` and `calls` ONLY when supplied (an absent `calls` is omitted, never present-but-undefined) — returning the created message(s). A stored message is IMMUTABLE: assembled once from its input and never mutated, and the object `add` returns is the same one `message(id)` later resolves. `count` is the live tail size, `message(id)` looks one up (`undefined` when absent), `messages()` lists them in insertion order, `remove` (one or a batch) returns `true` only when EVERY supplied id was removed, and `clear` empties it.
8. **The richer turn context (`AgentContext`).** `AgentContext` composes the optional `system` prompt; the agent-owned `instructions` / `conversations` managers; a `WorkspaceManagerInterface` consumed from `@orkestrel/workspace`; `messages` (the active conversation's live tail); a `ToolManagerInterface` consumed from `@orkestrel/tool` solely for provider advertising and call dispatch; and a readonly active `scope`. Each omitted manager is created fresh, and the context ensures the conversation registry has an active default, so `messages` is always defined. `build()` folds the system prompt, scope-filtered instructions, and the active workspace's scope-filtered text files (the active-workspace clause) into one leading `system` message, then appends the active conversation's `view()`. The tool registry is the one member `build()` never reads: it is loop machinery for advertising and dispatch, not a prompt-context manager, so no tool renders into the prompt. The result is computed fresh on every call and never mutates a manager or stored message.
9. **Scope filtering + image attachment.** A `Scope` is a named allow-list filter with one list per category (`instructions` by `name`, `tools` by `name`, `files` by the ACTIVE workspace file's `path`), each three-way through `filterAllowList`: `undefined` ⇒ all pass, `[]` ⇒ none, a non-empty list ⇒ only-listed. `build()` applies the active `scope` to the instruction + workspace-file categories before rendering them (`scope.files` filters the active workspace's `files()` before the carrier split — the active-workspace clause). Conversation messages are deliberately NOT a scope category: the ACTIVE conversation owns message inclusion through compaction (the active-conversation clause), so its `view()` is authoritative and a second, competing message filter would only let the two disagree. `narrow(config)` composes a tighter child by set-INTERSECTION over every category's list (an `undefined` side imposes no constraint — `undefined ∩ list = list`, `undefined ∩ undefined = undefined`), so narrowing only tightens. The active workspace's scoped-in IMAGE files' `base64` payload is attached to the LAST user message (rebuilt as a copy carrying the merged `images`, never mutating the stored message; skipped when no user message exists — the active workspace is the SOLE image source); `build()` still returns `readonly Message[]`. **Tools stay structural, never in the prompt.** The loop hands the model its tools through `tools.definitions()` (the `tools` argument to `provider.generate` / `.stream`), NOT by serializing them — and it FILTERS those definitions by the active `scope.tools` FIRST (through `filterAllowList`), so a scoped-out tool is neither advertised nor callable (the model never sees it). `AgentContext.build()`'s output therefore never contains a tool's `name`, `description`, `parameters`, or definition, scoped or not. A `ScopeManager` (`createScopeManager`) is the optional reuse registry of named scopes, keyed by a minted `id` (two scopes may share a `name`), observable like the other managers.
10. **The agent loop (`Agent` / `createAgent`).** `Agent` composes a `ProviderInterface`, an `AgentContext`, and its `@orkestrel/tool` registry into the bounded context → provider → tools → repeat turn. It builds the provider input, then iterates up to `limit`: stream a provider turn, accumulate content/thinking/usage, append any assistant tool calls, and execute them. Each discriminated `ToolResult` becomes a tool message whose content is `JSON.stringify(result.value)` when `result.success` is true and `result.error` when false, so failure text is never JSON-quoted. A final assistant turn stops the loop.
11. **One `#run` shared by `generate` + `stream`.** A single private async generator drives the whole turn. `stream()` exposes it as an `AgentStreamInterface` (`events` + `result` + `abort`); `generate()` DRAINS that same stream (iterating `events`, discarding chunks) and returns its `result` — it has ZERO loop logic of its own, so `generate` and `stream` can never diverge (a `generate()` result deep-equals draining `stream()` on the same input).
12. **The `AgentChunk` stream.** `stream().events` yields, per turn, each content delta as `{ category: 'token', content }`, each live reasoning delta as `{ category: 'think', content }`, then optional usage, then one `{ category: 'tool', call, result }` per dispatched call. The call and discriminated result use the contracts imported from `@orkestrel/tool`. `result` resolves the settled `AgentResult`: final or partial content, joined thinking, summed optional usage, and `partial`.
13. **Bounded, paced, capped.** Each run arms ONE cancel through `createAbort({ signal: AbortSignal.any([…]) })` folding whichever of the external `signal`, the `timeout` deadline (a started `Timeout`), and the `budget` signal (a started `Budget`) are present; `agent.abort(reason)` / `stream.abort(reason)` fires it, and the timeout is always cleared in a `finally`. A cancel — external, deadline, budget, or `abort()` — stops the loop and the `result` promise RESOLVES `{ partial: true, content: <accumulated> }`; it is NOT an error. The accumulated `content` already holds whatever streamed before the cancel — the loop accumulates each delta as it yields the `token` chunk, and a `ProviderAbortError.partial.content` is exactly those same yielded deltas (the `stream` contract), so the loop never re-adds it. A genuine provider / tool error (the signal is NOT aborted) REJECTS the `result` (and `status` → `error`). The optional `scheduler.yield({ signal })`s between turns (before turns 2…N, never after the last); tool iteration is capped at `limit` so the loop always terminates. `status` transitions `idle` → `running` → `done` / `error`.
14. **Two observation surfaces on the `Agent`; the rest event-free.** The provider contract, the tool registry, the conversation store, and the `AgentContext` ITSELF carry NO Emitter, no `EventMap`, no `on` hook — they stay purely functional (of the managers the context composes, the `InstructionManager` and `ScopeManager` carry their OWN `emitter`s and each `Conversation` owns one, while the `ToolManager`, `WorkspaceManager`, and `ConversationManager` are event-free — as is the context that composes them). The `Agent` itself carries BOTH a PULL and a PUSH surface. PULL: the `AgentChunk` stream (`stream().events`) yields per-token answer deltas, per-think reasoning deltas, usage chunks, and tool chunks for a live consumer. PUSH: the `emitter` (`AgentEventMap`) — `start` (run begins), `turn` (each iteration), `tool` (a dispatched call + result), `usage` (a turn's usage), `deny` (an authority denial — NOT in the chunk stream), `finish` (the settled result), `error` (a genuine failure), `abort` (a cancel), `exhaust` (a limit exhausted with unresolved tool intent — fires INSTEAD of `abort`), and `fault` (a NON-FATAL automatic-compaction summarizer throw — the run continues; the automatic-compaction clause) — wired through the emitter pattern (`AgentOptions.on` hooks, the `AgentOptions.error` listener-error handler, a `readonly emitter`, `new Emitter({ on: options?.on, error: options?.error })`). Per-token / per-thinking deltas are the stream's job EXCLUSIVELY — there is deliberately no `token` or `think` event. The emitter isolates a listener throw (it can never escape into the settle-once / wake-park loop) and routes it to its OWN `error` handler (the `error` option, surfaced as `(error, event)`, NOT a domain event; itself guarded against re-entrancy), so observation is provably side-effect-free on the 3×-hardened loop — and every emit sits AFTER the relevant state transition / settle, so it cannot reorder control flow. A cancelled run emits `abort` (the cancel reason) THEN `finish` (the settled partial); a genuine error emits `error` instead of `finish`. The loop's deterministic logic is pinned in the `src:core` mirror with a scripted `ProviderInterface`.
15. **DOC ↔ SOURCE method bijection.** The `## Methods` tables list exactly the public methods of every agent-owned interface named there, exhaustive in both directions, and each agent-owned concrete class exposes the same public methods as its interface. `MessageManagerInterface` is implemented structurally by the active `Conversation`; `ProviderInterface` is implemented by the host. Dependency method surfaces belong to [`tool.md`](tool.md) and [`workspace.md`](workspace.md).
16. **The authority gate (`Authority` / `createAuthority`).** An optional `Authority` is the synchronous policy gate consulted before each tool call runs — passed through `AgentOptions.authority`. `evaluate({ call })` walks its ordered `rules` first-match-wins: the FIRST rule whose `match(context)` is true decides as `{ zone: rule.zone, allowed: rule.allowed ?? true, reason: rule.reason }` (a matched rule ALLOWS unless its `allowed` is explicitly `false`); when none match it returns the `fallback`, which defaults to `{ zone: DEFAULT_AUTHORITY_ZONE, allowed: true }` (allow-unmatched — a rules list of denials acts as a DENYLIST; pass an `allowed: false` `fallback` to flip the gate to deny-by-default, an ALLOWLIST). The matcher receives the `AuthorityContext` (`{ call }`), so a rule can branch on the call's `name` AND its `arguments`. Synchronous — `evaluate` returns the verdict directly. Event-free.
17. **A denied call is fed back, never executed (the gate's effect on the loop).** With no `authority` set, the loop sends calls straight through the tool registry. With one set, allowed calls run as a batch and each denied call becomes the `@orkestrel/tool` failure union arm `{ success: false, id, name, error }` without executing the tool. Executed results and denials merge back into original call order, so every denial still produces a tool chunk and unquoted failure-text tool message the model can react to. The gate lives in the `Agent`, not the dependency registry.
18. **Durable, serializable agent JOBS (`AgentJobInput` + `AgentRegistry`).** An `AgentJobInput` is a JSON-serializable descriptor — NOT a live agent: its non-serializable pieces (the `provider`, `tools`, `authority`, `scheduler`) are referenced by NAME and its data (`messages`, `system`, `limit`, `timeout`, a token `budget` ceiling, nested `children`) carries directly. An `AgentRegistry` (`createAgentRegistry`) holds the named pools (`providers` required; `tools` / `authorities` / `schedulers` optional) and `build(input, signal?)` rehydrates a live, seeded `Agent`: it resolves the `provider`, assembles a fresh `ToolManager` from the `tools` names, rebuilds the token `budget` from its ceiling (`createTokenBudget({ max })`), resolves the `authority` / `scheduler` names, constructs the agent with `system` / `limit` / `timeout` and the threaded `signal`, and seeds its context with the `messages`. Because the descriptor is serializable, a job survives a crash through a Queue's `store` + `restore()` — the registry rehydrates the live pieces from the names on the way back in. An unknown name throws an `AgentError` carrying `code: 'REGISTRY'` and the message `unknown <category>: <name>`, never a silent `undefined`.
19. **Partial = configurable failure (`partial`).** An `Agent.generate()` RESOLVES `partial: true` on a cancel (abort / budget / timeout) — a cancel is not an error. For a durable JOB that is, by DEFAULT, a FAILURE: the `createAgentQueue` / `createAgentRunner` handler THROWS an `AgentJobError` (carrying the partial `AgentResult`), so the Queue's retries re-run the job and a Runner's fail-fast aborts its siblings. Pass `partial: true` to treat a partial as SUCCESS instead — the handler resolves the partial result rather than throwing. `isAgentJobError` narrows a caught value to recover its `partial`.
20. **Bounded concurrency + retries + persistence by COMPOSING the substrate (no new engine).** `createAgentQueue` returns a `QueueInterface<AgentJobInput, AgentResult>` built by `createQueue`: its handler `(input, context) => registry.build(input, context.signal).generate()` + the partial policy is the ONLY new logic — bounded `concurrency`, `retries`, the per-attempt `timeout`, and the durable `store` (+ `restore()`) all belong to the `@orkestrel/queue` `Queue`. `createAgentRunner` returns a `RunnerInterface<AgentJobInput, AgentResult>` built by `@orkestrel/workflow`'s `createRunner` (one-shot, ordered, fail-fast). No second concurrency / orchestration engine is written; the verified `Agent` loop + `Authority` gate are untouched. Layering is `agent → (queue, workflow)` with no cycle.
21. **Sub-agent fan-out through `controller.spawn`; cancellation threaded.** On a `createAgentRunner`, each unit's handler receives a `ControllerInterface`; before running the (parent) job it `controller.spawn`s each of the job's declared `children` (fire-and-track, never inline-awaited — a slot-holding bounded handler awaiting its own spawn can deadlock), so each child is a real sub-agent run through the same bounded queue whose result joins the run after the declared jobs (in spawn order). `createAgentQueue` ignores `children` (a queue has no fan-out). Cancellation threads through in both: the handler passes `context.signal` (queue) / `controller.signal` (runner) into `registry.build`, so a queue / runner `abort()` or a per-attempt timeout fires the rehydrated agent's signal (which commits a partial — the `partial` policy then decides). All event-free.
22. **The conversation layer (`Conversation` + `ConversationManager`).** A `Conversation` groups messages ABOVE the flat `MessageManager`: `messages` is the LIVE uncompacted tail (a real `MessageManagerInterface` a caller appends turns to), `sections` are the compacted history (oldest → newest), and `summary` is the rollup (`undefined` until the first compaction). Compaction folds older messages into summarized `Section`s through a provider-agnostic `ConversationSummaryHandler` seam — `compact(options?)` determines `keep` (`options.keep ?? the conversation's keep ?? DEFAULT_CONVERSATION_KEEP` = `0`), folds the oldest `count - keep` live messages (a no-op resolving `undefined` when `count <= keep`), summarizes that slice into a section (`id` minted, `summary` the seam's output, `messages` the RETAINED originals), removes those messages from the live tail by id, REGENERATES the rollup (a SECOND seam call over all section summaries), and emits `summary` then `compact` — TWO summarizer calls per compaction. `compact()` THROWS a `ConversationError` (`code: 'SUMMARIZER'`) when no summarizer was supplied (a conversation can still store + `view()` without one). `summarizable` is `true` exactly when a summarizer was supplied — the clean signal the agent loop's AUTOMATIC compaction gates on (the automatic-compaction clause), so a non-summarizable conversation is never auto-compacted and the auto path never throws this error; a MANUAL `compact()` still throws. `view()` is the model input — each section as ONE synthetic RECAP message (role `'assistant'`, keyed by the section's stable `id`), then the live messages verbatim (the rollup `summary` is NOT injected). Each recap's content is the section summary PREFIXED with `CONVERSATION_RECAP_PREFIX` (`'[Summary of earlier messages] '`) so a small model reads it as a CONDENSED RECAP of earlier turns, NOT a literal assistant turn it must echo or treat as the live answer — a deliberately LEAN label (a fixed handful of tokens; the rollup regeneration in `compact()` re-reads the UNframed section summaries, the label being a `view()`-only presentation concern). `rehydrate(id)` returns a section's full original messages (`[]` for an unknown id) and emits `rehydrate` — a pure READ (the caller decides whether to re-add them; `rehydrate` never reinserts). `search(query)` is a case-insensitive substring scan of `content` across ALL messages (every section's originals, then the live tail). `reference(options?)` renders THIS conversation as a self-labeled, fenced cross-conversation PROVENANCE block — a PURE string (NO model call) to pull INTO another conversation by writing it to the active context's active workspace: a leading `[Reference — conversation "<label>" — NOT part of this conversation]` marker (`label` defaults to the `id`), the rollup `Summary:` line when `options.summary !== false` AND a rollup exists, and the cherry-picked `Relevant messages:` excerpts (each `- role: content`) when `options.messages` is supplied (default none). It frames foreign content so a small model attributes it to its source rather than reading it as part of the live thread; the cherry-pick comes from this conversation's own `search` / `rehydrate`, never its whole history. Observable: the owned `emitter` (`ConversationEventMap` — `compact` / `summary` / `rehydrate`) isolates a listener throw, routing it to its `error` handler (the `error` option), never corrupting a compaction. `ConversationManager` (`createConversationManager`) is the id-keyed registry WITH an active pointer (the `active` / `switch` seam the `AgentContext` renders): `add(input?)` mints a conversation flowing the manager's default `summarize` / `keep` in unless the input overrides them (an already-present `id` overwrites) and AUTO-ACTIVATES the FIRST one (a later `add` leaves `active`); `switch(id)` re-points `active` (an unknown `id` is a lenient `undefined`, leaving `active` unchanged); `conversation(id)` / `conversations()` look up; `remove` (one or a batch) reports `true` only when EVERY supplied id was removed AND clears `active` when the removed one was active; `clear` empties it and clears `active`; `count`. It carries the durable `open(id)` / `save(id)` seam over an optional `ConversationManagerOptions.store` (the durable-store clause) and `Conversation.snapshot()` serializes a conversation to a JSON `ConversationSnapshot`. It is EVENT-FREE (each conversation owns its `emitter`). `estimateTokens(text)` is the deterministic `ceil(length / 4)` char heuristic (it never calls a provider) that `estimateMessages(messages)` sums over a message batch — the default `consumer` estimator for an agent's context `window` budget (the automatic-compaction clause), not a conversation member. The layer's deterministic logic is pinned in the `src:core` mirror with a data-stub summarizer.
23. **`AgentContext` folds the ACTIVE conversation's view; the message source is the readonly `conversations` registry.** `messages` is the `conversations` registry's ACTIVE conversation — ALWAYS defined: at construction the context ENSURES the registry has an active conversation, `add`ing a DEFAULT one when it has none. The DYNAMIC `context.messages` getter returns that active conversation ITSELF (the SAME reference it exposes — NO duplication; computed on every read, so it follows `conversations.switch(id)`, with no captured copy), and `build()` folds that conversation's `view()` (the per-section summaries + the live tail) as the AUTHORITATIVE message inclusion — the conversation owns inclusion through compaction, so there is no competing scope category for messages; scope still filters instructions / tools / workspace files, and the active workspace's scoped-in image-data attachment to the last user message still applies to the view output. With the DEFAULT (uncompacted) conversation, the message path is exactly the lean `[systemMessage?, ...messages]`. The registry is structural: supply it through `AgentContextOptions.conversations` and change its active conversation through `manager.switch(id)`. **Multi-conversation.** Because `context.messages` / `context.conversations` are read DYNAMICALLY and the `Agent` reads them FRESH on each run, ONE agent SWITCHES its active conversation BETWEEN runs to serve MANY conversations from its `conversations` registry (the real app pattern — `manager.switch(id)` per request, creating through `manager.add({ id })` when absent, not an agent per thread): each conversation accumulates its OWN history and (with `window`, the automatic-compaction clause) compacts INDEPENDENTLY, one thread's sections never leaking into another. Switch BETWEEN runs, never DURING one (the loop drives the run-entry active conversation to completion); for CONCURRENT threads use a SEPARATE `Agent` per thread — the framework ships the switch mechanism, the app owns concurrency policy. The `Agent` forwards its `AgentOptions.conversations` straight into this context as the message source; the auto-compaction TRIGGER over the active conversation lives in the loop (the automatic-compaction clause).
24. **Automatic compaction — the context `window` budget (opt-in, additive, production-hardened).** `AgentOptions.window` is a CONTEXT [`Budget`](budget.md) (`BudgetInterface<readonly Message[]>`) for AUTOMATIC conversation compaction, enabled only when BOTH a `window` budget is set AND the ACTIVE conversation is `summarizable` (it has a summarizer — the conversation-layer clause). There is ALWAYS an active conversation (the active-conversation clause), but the DEFAULT one has no summarizer, so this `summarizable` gate PRESERVES the shipped behavior: a non-summarizable conversation is NEVER auto-compacted, and the auto path never throws the `compact()` `SUMMARIZER` error. Its `consumer` is a pluggable token estimator (for example the exported `estimateMessages`) and its `max` is the context window — the SAME consume-to-a-ceiling primitive as the cost `budget` (the bounded-paced-capped clause), but its ceiling action is COMPACT instead of abort. The loop's private `#trim` runs the check at TWO points: (1) BEFORE the first provider request (so a RESUMED / already-long conversation whose INITIAL prompt already exceeds the window compacts at once, not only after a tool turn), and (2) BETWEEN turns on the tool-iteration `continue` path (after the prior turn's `usage` was folded and its assistant + tool messages were appended, before the next provider request; NEVER after the final assistant turn that ends the loop). The `window` budget is RESET (`clear()`) at run entry, so no stale `consumed` carries across runs or a conversation switch. Each check measures the ABSOLUTE current prompt: it `clear()`s the budget then `consume`s the WORKING message array — the EXACT next prompt (the system block + the active conversation's `view()` + this turn's appended messages, that is, what the next `provider.stream` will receive) — so `window.consumed` is the current FULL prompt's estimated footprint and `window.exhausted` means that prompt has REACHED the context window `max`. When the prompt `exhausted`s the window, `#trim` `await`s `conversation.compact()` (folding the older live tail into a summarized `Section` through the conversation's own `ConversationSummaryHandler`), then REBUILDS the working message array from `context.build(provider.format)` — the SAME projection the loop opened with — so the run CONTINUES on the (now smaller) compacted context. No post-compact `clear()` is needed: the NEXT check's `clear()` + `consume` re-measures the now-shrunken prompt. This is distinct from the HARD `budget` ceiling (the bounded-paced-capped clause), which ABORTS the run with a partial. **Production hardening:** (a) NON-FATAL summarizer failure — the AUTOMATIC `compact()` is wrapped in try/catch: a thrown summarizer error does NOT crash the run; the loop skips compaction that turn, surfaces the error as a `fault` event (so it is observable, never silently lost), and CONTINUES (the over-window prompt proceeds to the provider). Only the AUTO path is resilient — a MANUAL `conversation.compact()` still propagates its error. (b) FUTILE-COMPACTION guard (the single-level limit) — when `compact()` resolves `undefined` (nothing left to fold) while the prompt is still over the window (the section summaries ALONE exceed it), a per-run flag latches so auto-compaction STOPS for the rest of that run (no per-turn churn); the over-window prompt then proceeds to the provider, which surfaces a genuine context-length error if it truly cannot fit (the real limit) — the loop does NOT loop futilely. The whole path is OPT-IN: with no `window` budget, or a NON-SUMMARIZABLE active conversation, `#trim` (the run-entry reset, the pre-first-turn check, the between-turns check) is skipped entirely, adding NO `await` before the first provider request, so a cost-budget-only agent's eager-pump and abort timing are untouched. Observability is the conversation's own `compact` / `summary` events (the conversation-layer clause) plus the agent's `fault` (the `strict` clause). Two limits are deliberate: the automatic summarizer call is the conversation's configured one and is not separately bound to the run's abort signal; and compaction is SINGLE-LEVEL, so a conversation whose section summaries alone exceed `window` cannot shrink further — the futile guard stops the churn rather than pretending otherwise. The deterministic behavior (the absolute prompt crossing `max`, the fold, the rebuilt-smaller prompt, the pre-first-turn fold, the non-fatal `fault` path, the futile guard, no-fire below the ceiling) is pinned in the `src:core` mirror with a scripted provider, a data-stub (and a throwing) summarizer, and the real `estimateMessages` estimator, including a run forced through two or more folds that stays coherent.

25. **`context.workspaces` — active workspace rendering by carrier.** `AgentContextInterface.workspaces` is the readonly `WorkspaceManagerInterface` supplied from `@orkestrel/workspace`, or a fresh dependency manager when omitted. `build()` reads only its active workspace, fresh each call, and filters that workspace's files through `scope.files`. The dependency's `isText` narrows text files, which render under `WORKSPACE_SECTION_HEADER` through the agent-owned `renderFencedFile` helper; the image carrier is `isBinary(file.content) && file.content.mime.startsWith('image/')`, and matching base64 data attaches to the last user message. With no active workspace, nothing renders. Both halves of that split are this package's own decision and belong here: `@orkestrel/workspace` holds files without knowing what a prompt is, and only the assembly layer knows that a model reads text as quoted material and images off a user turn. What agent does NOT own is the workspace domain itself — creation, editing, events, snapshots, and stores all stay in the originating package.

26. **The durable `ConversationStore` + the manager's `open` / `save` seam.** A `ConversationSnapshot` is the plain JSON payload `{ id, summary?, sections, messages }`; live summarizer/configuration functions are re-supplied when hydrating. `Conversation.snapshot()` creates it, and `ConversationInput.snapshot` restores identity, summary, sections, and live tail without emitting edit events. `isConversationSnapshot` is the total read-boundary guard for unknown storage values. `ConversationStoreInterface` persists that one payload through `get(id)`, `set(snapshot)`, and `delete(id)`, with no TTL. `MemoryConversationStore` keeps snapshots in a process-lifetime map; `DatabaseConversationStore` stores each snapshot in one opaque JSON column and narrows it on read. `ConversationManager.open(id)` activates a registry hit or hydrates a store hit; `save(id)` persists a registered snapshot and returns `false` when no store or conversation exists. The real stores, driver, guard, snapshot hydration, and manager semantics are pinned in the core tests.

27. **Limit exhaustion, mid-stream budget metering, per-run bounds, and per-run `schema`.** `RunOutcome.exhausted` (and the settled outcome's `partial`) flips `true` when the turn loop exhausts the EFFECTIVE `limit` while the most recently completed turn still held UNRESOLVED tool intent (the model requested tools on the very last allowed turn) — a cause distinct from a cancel: it fires the `exhaust` event (carrying the effective `limit`) INSTEAD of `abort`, still followed by `finish` carrying the partial result. A natural final answer on the last allowed turn, or `limit: 0` (which never enters the loop), stays `partial: false` with no `exhaust`. **Mid-stream budget charging.** During each provider turn, `#provide`'s `onDelta` re-estimates the turn's accumulated content through `estimateTokens` (`ceil(length / 4)`) and `budget.consume`s only the INCREMENT over what was already charged this turn (`{ prompt: 0, completion: increment, total: increment }`) — so the budget trip can land mid-stream, before the turn's final `usage` is known; the tripped signal folds into the run's bound abort exactly like any other cancel (the run resolves `partial: true` with an `abort` event, the provider genuinely cancelled). Once the turn's `usage` IS known, a RESIDUAL reconcile charges the remainder (`{ prompt: usage.prompt, completion: max(0, usage.completion - charged), total: max(0, usage.total - charged) }`), so the turn's total budget draw nets to exactly the authoritative usage — never double-charged, never lost. The REPORTED `AgentResult.usage` / `usage` chunks are always the full authoritative usage, unaffected by how the budget was charged. **Per-run overrides (`AgentRunOptions`).** `limit` / `timeout` / `budget` / `signal` each override their `AgentOptions` construction default for THIS run only (`??` semantics — an omitted key keeps the constructed default); a per-run `signal` COMPOSES with (never replaces) a constructed `signal` through `AbortSignal.any` — either aborting cancels the run; a per-run `budget` is `start()`ed for that run and is the ONE the loop charges, leaving a constructed `budget` untouched for that run. **Per-run `schema`.** `AgentRunOptions.schema` (and `ProviderStreamOptions.schema`) mirrors `think` — a per-run structured-output constraint forwarded to `provider.stream`. `#provide` composes `think` and `schema` into ONE options object, OMITTING whichever key is `undefined`, and passes no options object at all when both are absent.

28. **`AgentOptions.instructions` / `.workspaces` / `.scope` — construction-time context wiring.** These three mirror the identically-named `AgentContextOptions` fields (the richer-turn-context clause) and forward straight into the `AgentContext` the constructor builds: `instructions` a pre-built `InstructionManagerInterface` (an empty one created when omitted), `workspaces` a pre-built `WorkspaceManagerInterface` (a fresh empty one when omitted), and `scope` the initial active `ScopeInterface` (`undefined` ⇒ no filtering). They are construction sugar: the same result is reachable by building an `AgentContext` first and passing it in, and these fields spare that indirection when a caller only needs `createAgent`.
29. **`strict` — automatic-compaction failure escalation.** `AgentOptions.strict` (default `false`) governs what happens when the AUTOMATIC compaction path's `conversation.compact()` throws (the automatic-compaction clause): lenient (the default) surfaces the caught error as the `fault` event and CONTINUES over-window; `strict: true` still fires `fault` first (the failure stays observable either way), then RETHROWS the caught error so it propagates out of `#trim` through `#run`, rejecting the run's `result` with a genuine `error` settle (`status` → `error`) instead of a `partial: true` resolve. A MANUAL `conversation.compact()` is unaffected by `strict` — it always propagates its own error regardless.
30. **Bounded `sections` — cap the compacted history, `collapse` on overflow.** `ConversationOptions.sections` / `ConversationManagerOptions.sections` (a manager default, overridden per-`add` by `ConversationInput.sections`) / `CompactOptions.sections` (a per-compaction override) each set a cap (`>= 1`) on `Conversation.sections`'s length; omitted at every level ⇒ unlimited. A sub-1 cap — at construction (`ConversationOptions.sections`) or at a `compact()` call (the effective `options.sections ?? the conversation's own cap`) — throws a `ConversationError` with `code: 'SECTIONS'`. When a `compact()` fold pushes a NEW section past the effective cap, the OLDEST overflow sections are immediately folded into ONE merged section (a THIRD summarizer call over the folded sections' summaries) so `sections.length` never exceeds the cap afterward, and a `collapse` event fires carrying the merged `Section`. This is orthogonal to `keep` (which bounds the LIVE tail folded per compaction) — `sections` bounds the COMPACTED HISTORY's length instead.
31. **`sanitizeUsage` — normalizing a provider's abort-time partial usage.** A `ProviderAbortError.partial.usage` a provider surfaces mid-abort can be malformed (non-finite, negative, or fractional fields) since it was assembled from a cut-off stream rather than a clean settle. `sanitizeToken(value)` is the shared per-field primitive: it floors non-finite or non-positive values to `0` and positive fractional values to their integer part. `sanitizeUsage(usage)` applies it to `prompt` / `completion` / `total`, so a caller charging a token `Budget` never consumes a negative or fractional amount. The `Agent` loop applies it automatically to an abort's partial usage before folding it into the run's accounted usage / budget charge; both helpers are also exported standalone.
32. **`AgentError` — the synchronous shared-accounting concurrency guard.** `Agent.stream()` throws `AgentError('CONCURRENCY', …)` SYNCHRONOUSLY — before any state mutation or emit — when a run is already in flight on the SAME agent (`this.#runs.size > 0`) AND the agent carries SHARED per-agent accounting for the new run: either a construction-level `window` (a shared context budget, ALWAYS shared since it has no per-run override) or a construction-level `budget` with no per-run `AgentRunOptions.budget` override (a shared cost budget). A concurrent run that supplies its OWN per-run `budget` override (with no `window` set) is still allowed — it charges a separate instance. `isAgentError` narrows a caught value; branch on `error.code` — `'CONCURRENCY'` here, `'REGISTRY'` for an `AgentRegistry` accessor whose name is absent from its pool. A sequential/awaited caller is never affected — this guards only genuinely concurrent `stream()` calls on one agent.

33. **`agentResultToJSON` — the canonical portable AgentResult projection.** The helper accepts `unknown` and never throws, including for throwing getters, hostile nested usage, and revoked proxies. It captures `content`, `thinking`, `usage`, and `partial` exactly once through Contract's sanctioned `attempt` boundary, so conforming accessors and inherited structural properties are supported without a second read. `content` must be a string and `partial` a boolean; absent/`undefined` `thinking` and `usage` are omitted, while present `thinking` must be a string and present `usage` an object whose `prompt` / `completion` / `total` fields are finite numbers. Finite negative and fractional counts are preserved rather than normalized through `sanitizeUsage`, because the authoritative `TokenUsage` contract is numeric. Extra input fields are dropped. The helper rebuilds a fresh exact plain `{ content, thinking?, usage?: { prompt, completion, total }, partial }` object, deep-gates it through Contract's `parseJSONValue`, and returns Contract's imported `JSONValue`; invalid input returns `undefined`.

## Patterns

### Bounding any provider call

`ProviderInterface.generate` / `.stream` take a plain `AbortSignal`, so fold an [abort](abort.md), a [timeout](timeout.md), and a token [budget](budget.md) into one bound through `AbortSignal.any` — whichever trips first cancels the call. This works for ANY provider; constructing the concrete one is a host application's job.

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

Advertising and dispatch are the two halves of one exchange: hand `definitions()` to the provider, and feed the `ToolCall`s that come back through `execute`. Results are correlated by `id` and discriminated on `success`, so a handler throw arrives as a `ToolResult` the model can read rather than an exception the caller must catch.

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

The two patterns above are what an `Agent` does for you turn after turn — bounding the call, dispatching the model's tools, feeding the results back, and repeating until the model stops (or `limit` is hit). Reach for `createAgent` rather than hand-rolling the loop; bound and pace it through `AgentOptions`, and recover a cancel's partial from `result` (which resolves, never rejects, on a cancel).

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

An `AgentOptions.budget` (or a per-run override) is not only charged from each turn's FINAL reported `usage` — the loop also charges it INCREMENTALLY, mid-stream, from an ESTIMATED token count as content deltas arrive (the `estimateTokens` `ceil(length / 4)` heuristic), so a runaway completion trips the ceiling WITHOUT waiting for the turn to finish. When the mid-stream estimate crosses the budget, the budget's `signal` fires, folding into the run's bound abort exactly like an external cancel or a `timeout` — the provider is cancelled, and the run resolves `partial: true` with an `abort` event (the same funnel as any other cancel).

Once a turn DOES complete, the loop RECONCILES: it charges the budget the REMAINDER of the turn's authoritative `usage` (`completion - alreadyCharged`, `total - alreadyCharged`, plus the full `prompt` — which is never estimated mid-stream, having no live delta channel) — so the turn's TOTAL budget draw always nets to exactly the reported usage, never double-charged and never under-charged. The `AgentResult.usage` / the `usage` chunks you observe stay the FULL authoritative usage regardless — this reconcile affects only what the `budget` itself was charged, never what you're told the turn cost. This mid-stream enforcement is BOUNDED, not exact — the estimate can under- or over-shoot the eventual real usage by a turn's tail, so treat the `budget.max` as a firm ceiling with some slack, not a byte-exact cutoff.

```ts
import { createAgent } from '@orkestrel/agent'
import { createTokenBudget } from '@orkestrel/budget'

const budget = createTokenBudget({ max: 2_000, scope: 'completion' })
const agent = createAgent(provider, { budget })
agent.emitter.on('abort', (reason) => log('budget tripped mid-stream', reason))
agent.context.messages.add({ role: 'user', content: 'Write a very long story.' })
const result = await agent.generate() // partial: true if the story ran the budget out mid-stream
```

**A `think: true` run needs headroom for reasoning.** Live reasoning deltas (`ProviderDelta` `'thinking'`) are NOT metered mid-stream (only `'content'` deltas are — thinking is charged, like content, solely through the post-turn reconcile), so a thinking model can spend a large share of a tight budget's ceiling on its reasoning before any answer content streams — the mid-stream trip can land WHILE the model is still reasoning, committing an empty (or near-empty) `content` alongside `partial: true`. Give a `think: true` run enough budget headroom to cover its reasoning, not only its expected answer length.

### Observing an agent (push vs. pull)

An `Agent` exposes TWO observation surfaces. PULL — the `AgentChunk` stream (`stream().events`) — is for a LIVE consumer rendering per-token answer deltas and per-think reasoning deltas as they arrive. PUSH — the `emitter` (`AgentEventMap`) — is for FIRE-AND-FORGET observers (logging, metrics, tracing) that want the loop's lifecycle moments WITHOUT draining the stream: `start` (a run begins), `turn` (each iteration), `tool` (a dispatched call + its result), `usage` (a turn's token usage), `deny` (an authority denial — which never reaches the chunk stream), `finish` (the settled result), `error` (a genuine failure), `abort` (a cancel), and `exhaust` (the limit was reached while the model still held unresolved tool intent — fires INSTEAD of `abort`, still followed by `finish`). Per-token / per-thinking deltas stay the STREAM's job exclusively — there is deliberately no `token` or `think` event on the emitter; reach for the stream when you need live output, the emitter when you need lifecycle.

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

**Observation can never corrupt the loop.** The emitter isolates a listener that THROWS (the throw can never escape into the settle-once / wake-park engine — `generate()` / `stream()` still settle the exact same result), routing the caught error to its OWN `error` handler (the `error` option, surfaced as `(error, event)`, NOT a domain event) so the observer bug is not silently lost. EVERY throwing listener surfaces (not only the first); a throwing `error` handler is swallowed too (it can neither recurse nor escape); with no handler the throw is dropped silently. So a buggy observer degrades to a routed error — it never reorders, throws into, or corrupts the run.

**A cancelled run emits `abort` THEN `finish`.** A cancel (an external `signal`, the `timeout` deadline, an exhausted `budget`, or `abort()`) still RESOLVES a partial result — so the emitter fires `abort` (carrying the cancel reason) and then `finish` (carrying the settled partial), letting an observer see both that the run was cancelled AND the partial outcome it committed. A natural / cap-bounded finish fires `finish` only; a genuine provider / tool error fires `error` instead of `finish`. `generate()` and `stream()` drive the SAME events (they share one `#run`).

### Pulling context from ANOTHER conversation (with provenance)

One agent serves MANY conversations by switching the active conversation between runs (`conversations.switch(id)` — the active-conversation clause); each thread keeps its OWN history. When the active conversation A needs something decided in another conversation B, DON'T merge B's turns into A's live tail — that pollutes A's thread and (for a small model) blurs which conversation said what. Instead pull a PROVENANCE-LABELED reference of B into A's ACTIVE WORKSPACE (the fenced reference channel `build()` folds into the system block), so the model reads it as clearly-foreign material and attributes it to B.

The flow is **summary → search / rehydrate → reference → write-to-workspace** — and CHERRY-PICK, never dump:

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

Why this shape: `reference()` leads with `[Reference — conversation "<label>" — NOT part of this conversation]`, so the model treats the rollup + excerpts as a quoted FOREIGN source (it answers "decided in the planning conversation", not "we decided here"). Keep the excerpts CHERRY-PICKED — this content enters another context window a small model must read, and a full dump re-bloats it. `reference()` is event-free and never calls a model; provenance lives in the `label` (default the conversation's `id`).

**Within a conversation, the same provenance instinct applies to recaps.** `view()` folds each compacted section into a synthetic `assistant` recap — and prefixes it with `CONVERSATION_RECAP_PREFIX` (`[Summary of earlier messages] …`) so a small model reads it as a CONDENSED RECAP of earlier turns rather than a literal turn to echo or treat as the live answer. The label is deliberately LEAN (a fixed handful of tokens — no per-section blow-up) and is a `view()`-only presentation concern (the rollup regeneration re-reads the unframed summaries). Empirically, on a 2B model this tightening is the difference between the model correctly attributing a recapped fact and mis-attributing it — at temperature 0 the recap label reliably steers correct attribution where the bare assistant turn does not.

### Running many durable agents as jobs

When you need MANY agents — bounded, retried, surviving a crash — describe each as a serializable `AgentJobInput` (names for the live pieces, data for the rest), register the live pieces once, and run them through a `createAgentQueue` (durable, bounded) or a `createAgentRunner` (one-shot, ordered, fail-fast, with sub-agent fan-out). The layer COMPOSES the `@orkestrel/queue` `Queue` and the `@orkestrel/workflow` `Runner` — it adds only rehydration and the partial policy, no new engine.

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

A workspace reaches the model through `context.workspaces`, and this is the only channel documents have. `build()` renders the ACTIVE workspace by carrier on every turn — active-only and scope-filtered — so the workspace the agent is working in is always what the prompt reflects, with nothing to re-mount after an edit. Register one (the first `add` auto-activates it) and its text files fold into the `## Workspace` system section as fenced reference blocks, while its image files' base64 rides the last user message.

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

Reading is one half. To let the model EDIT what it reads, register the `createWorkspaceTool` published by `@orkestrel/toolbox` on `agent.context.tools` over this SAME `context.workspaces` registry: an `operation`-keyed `ToolInterface` whose dispatch and error semantics are that package's to document. The two surfaces then close a loop — the model reads the workspace from the prompt, edits it through a tool call, and reads the edited version on the next turn.

### Switching which workspace the model sees

Only the ACTIVE workspace renders; the other registered workspaces never reach the model at all. `switch` changes which one the model sees between runs:

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
- **Run the loop with `createAgent`** — don't hand-roll the context → provider → tools cycle; `createAgent` does it, bounded by `AbortSignal.any([signal, timeout, budget])`, paced by `scheduler`, capped at `limit`. Drain `stream().events` to render `token` / `think` / `tool` / `usage` chunks live, or `generate()` for the settled result; either way `result` RESOLVES partial on a cancel (read `result.partial`), rejecting only on a real error.
- **Run many durable agents with `createAgentQueue`** — describe each agent as a serializable `AgentJobInput` (names for the provider / tools / authority / scheduler, data for the rest), register the live pieces once in a `createAgentRegistry`, and enqueue the jobs. Persist them with a `store` so `restore()` re-runs outstanding work after a crash. Decide the partial policy up front — `partial: false` (default) RETRIES a cancelled job, `true` accepts the partial.
- **Fan out sub-agents with `createAgentRunner`** — declare a parent job's sub-agents in its `children`; the runner `controller.spawn`s each through the same bounded queue. Don't reach for the controller yourself — express fan-out as data on the job (it stays serializable) and let the runner spawn it.
- **Two surfaces on the `Agent`, none elsewhere** — observe the `Agent` two ways: PULL the `AgentChunk` stream for per-token / per-thinking deltas + usage/tool chunks, or PUSH `agent.emitter.on(...)` (`AgentEventMap`) for lifecycle + usage/tool/deny moments a fire-and-forget observer wants. A listener throw can never corrupt the loop (the emitter isolates it, routing it to the `error` option). Do NOT reach for an Emitter on the provider contract, the tool registry, the conversation store, the context, or the job layer — those stay event-free; and do NOT expect per-token `token` or `think` events (those stay the stream's job).
- **Create and edit files through `@orkestrel/workspace`** — the file domain is that package's, and `AgentContext` borrows only its `isText` / `isBinary` guards to decide a file's carrier. The rendering is agent's: the `## Workspace` fencing and the binary-plus-`image/` attachment are prompt policy that belongs here, not workspace helpers that belong there.
- **Give the model both halves of a workspace** — `context.workspaces` is what it reads, rendered by carrier every turn, active-only and filtered by `scope.files`; the `createWorkspaceTool` published by `@orkestrel/toolbox` over that same registry is what it writes. Workspace editing, errors, and persistence live in [`workspace.md`](workspace.md); tool dispatch semantics live in [`tool.md`](tool.md).

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` bijection for agent-owned values and types, plus exhaustive method parity for every agent-owned interface/class pair documented above.
- [`tests/src/core/conversations/Conversation.test.ts`](../tests/src/core/conversations/Conversation.test.ts) — `add` single mints a fresh `id` + carries `role` / `content` (and `calls` only when given, the field omitted otherwise); `add` batch returns the created messages in order with unique ids; the returned message reflects its input and is the same object `message(id)` resolves (immutable); `message` lookup / miss; `messages()` insertion order; `remove` single + batch (`true` only when every supplied id was removed) + `clear` + `count`; and hydration through the `ConversationOptions.snapshot` seam — the ONE way to restore (a `createConversation` restore of the stored id, rollup, sections, and live tail that re-snapshots identically, the snapshot id winning over an options id, a restored conversation's `view` / `search` / `count` and continued compaction, and no event emitted while restoring).
- [`tests/src/core/AgentContext.test.ts`](../tests/src/core/AgentContext.test.ts) — `build()` WITH a system prompt prepends `{ role: 'system', content }` then the conversation in order; WITHOUT one (and empty managers) returns only the conversation (no system turn, `system === undefined`, empty → `[]`, and an explicit `''` / whitespace system still prepended); `context.tools` is the passed registry (or a fresh empty `ToolManager`) and `build()` NEVER includes a tool's name / description; `build()` is fresh each call (reflects messages added between builds, mints a new system `id`, snapshot-independent). AND the richer assembly: the `instructions` manager is fresh empty (or reused by identity); an empty manager contributes nothing (lean behavior preserved); it folds into the system block under its `description` + per-item `override`; the readonly `scope` getter (default `undefined`, initial through options) + `apply(scope)` / `apply(undefined)` through an `AgentContextInterface` binding; and scope filtering per category — `undefined` ⇒ all, a named allow-list ⇒ only-listed, `[]` ⇒ none over the instructions, with the conversation passing through unfiltered, recomputed fresh when the scope is changed between builds. AND the ACTIVE-workspace render by carrier (the only document/image channel): `context.workspaces` is always present (fresh empty `WorkspaceManager`) or supplied structurally through options; the active workspace's TEXT files fold into a `## Workspace` system section (fenced through `renderFencedFile`, placed after instructions) and its IMAGE files' base64 attaches to the LAST user message (own-images-first merge; multiple in insertion order; skipped when no user message; the stored message is never mutated); `scope.files` filters BOTH carriers; the render is ACTIVE-ONLY (a non-active workspace's files never render, reflected through a `switch`); no active workspace ⇒ nothing rendered. AND the injected-conversation message source (a data-stub summarizer): with one, `context.messages` IS its live tail and `build()` folds its `view()` (the compacted view after a `compact()`), no scope filtering over messages (the conversation is authoritative) while scope still filters instructions; without one, the plain message-store path. AND the structural conversation registry (the multi-conversation switch): supplied through options, its active conversation changes through `conversations.switch(id)`, re-pointing `messages` to the new live tail by IDENTITY (no duplication), and `build()` follows the switch; constructing with an empty supplied registry adds a default active conversation; a `compact()` on the active conversation is reflected through the switch.
- [`tests/src/core/scopes/Scope.test.ts`](../tests/src/core/scopes/Scope.test.ts) — `Scope` construction (a minted `id` + the per-category lists including `files`, copied in so a later mutation of the caller array can't leak in; `[]` distinct from `undefined`); and `narrow`'s set-INTERSECTION semantics — `list ∩ list` = the keys in both, `undefined ∩ list` = the list (no parent constraint), `list ∩ undefined` = the list, `undefined ∩ undefined` = `undefined`, `[]` ⇒ none either side, narrowing only TIGHTENS (a parent-excluded key never returns), per-category independence (incl. `files`), name preserved, immutable (a NEW scope, parent untouched), and chained narrows compose.
- [`tests/src/core/scopes/ScopeManager.test.ts`](../tests/src/core/scopes/ScopeManager.test.ts) — the id-keyed registry: `create` mints an `id` + stores (always ADDS — two scopes sharing a `name` coexist), `scope` / `scopes` insertion-order lookup, `remove` single + batch (`true` only when every supplied id was removed) + `clear` + `count`; the `create` / `remove` / `clear` event emissions (one `remove` per actually-removed id, the reserved `on` option); and emit-safety (a throwing `create` listener can't corrupt the registry + routes to the emitter's `error` handler; a throwing `error` handler neither escapes nor recurses) mirroring the Table / InstructionManager emitter convention.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — agent-owned pure helpers: `agentResultToJSON` full/minimal fresh exact projections + extras dropped + compile-time exhaustive `AgentResult` field-map review, conforming accessor/inherited structural values, and total rejection of wrong/missing fields, malformed present optionals, non-finite/missing usage counts, throwing getters, non-object inputs, and revoked root/nested proxies; `filterAllowList`'s three-way semantics (`undefined` ⇒ all, `[]` ⇒ none, a list ⇒ only-listed) preserving item order (not allow-list order), ignoring unknown keys, matching through the key extractor (not identity), and returning `[]` (not throwing) for an empty item list; `estimateTokens` / `estimateMessages` (the per-message `MESSAGE_TOKEN_OVERHEAD`, an empty batch ⇒ 0, empty content ⇒ overhead only, the JSON-stringified `calls` contribution with its documented fixed fallback on a circular argument and NO contribution for an empty `calls` array, and `images.length * IMAGE_TOKEN_ESTIMATE` per image); `renderFencedFile` (the `File:` label + language-tagged fence, the body verbatim across lines, and a workspace text file framed from its OWN text arm); `sanitizeToken` / `sanitizeUsage` (identity on a well-formed non-negative integer usage; `NaN` / negative / `±Infinity` floored to 0 and a fractional field to its integer part, each field independently); and `settleAgentJob`'s partial policy (a natural finish resolves `partial: false`, a disallowed partial throws an `AgentJobError` carrying the partial, an allowed partial resolves as success). AND the extracted loop / cascade / conversation / scope leaves on their own contracts: `joinThinking` / `sumUsage` seeding then accumulating, `assembleResult` omitting an absent `thinking` / `usage` and keeping the loop-internal `exhausted` out of the public result, `denyCall`'s two denial texts, `renderSection` rendering nothing for an empty item list, `resolveOpen` / `resolveClose` / `resolveItem` at each cascade level (item override beating every other), `attachImages` merging own-images-first without mutating the source, `attachUserImages` replacing only the last user turn (and returning the conversation unchanged for no data or no user turn), `collectImageData` skipping a text file, `buildSummaryMessage` / `buildRecapMessage` (raw vs. `CONVERSATION_RECAP_PREFIX`-framed), and `intersectKeys` treating `undefined` as the universal set and returning a copy.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — agent-owned factories over REAL declared tool/workspace dependencies: `createAgentContext` (the `[system?, ...messages]` assembly; a pre-built tool registry surfacing through `context.tools`); `createAgent` (one turn to its result; passed instructions / workspaces managers surface through `agent.context` — an added text file appears in `build()`; a no-tools scope empties the advertised definitions AND filters instructions; omitted managers still yield working empty managers); `createChannel` (pushed values drain in write order then `close` ends it; a buffered value is delivered before a `fail` surfaces); `createAgentRegistry` (a serializable job round-trips build→run; a job naming a provider or tool MISSING from the registry rejects loudly on enqueue); `createAgentQueue` (each enqueue resolving its OWN result; the `concurrency` bound incl. a 12-job batch at 3; the partial policy — throws by default carrying the partial, re-runs for the full retry budget then rejects, `partial: true` resolves, a `budget: 0` partial settles the same way, a non-partial sibling resolves beside a throwing partial, a per-attempt timeout rejects as the substrate fault (NOT an `AgentJobError`) and retries, a pre-aborted entry signal hard-cancels without running; pause parks a job until resume, stop rejects a pending job, and `abort()` threads into the agent's signal); durability (an `AgentJobInput` JSON round-trips unchanged; a queue store round-trips the row; `restore()` re-runs an outstanding job to its REAL result then removes the row); `createAgentRunner` (an ordered batch, fail-fast on a partial, a parent spawning a CHILD sub-agent through `controller.spawn`, cancel threading); and `AgentJobError` / `isAgentJobError` (carries the partial `AgentResult`; the guard narrows the real error and rejects everything else).
- [`tests/src/core/conversations/stores/MemoryConversationStore.test.ts`](../tests/src/core/conversations/stores/MemoryConversationStore.test.ts) — the in-memory `ConversationStoreInterface` (`get` / `set` / `delete`, async, keyed by a snapshot's own id) over REAL `ConversationSnapshot`s carrying compacted sections (from a genuine `compact()`) + a live tail + a rollup `summary`: set→get round-trip + JSON-portability parity, upsert under the same id, delete + absent, two distinct ids coexist; AND the `isToolCall` per-call guard (the fail-closed element check) — accepts the real `ToolCall` shape (string `id` / `name` + a record `arguments`), rejects every hostile shape (non-record, missing / wrong-typed `id` / `name` / `arguments`) without throwing.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — `isMessage`, `isSection`, and `isConversationSnapshot` (the per-message, per-section, and total read-boundary guards): each accepts the real shape with and without its optionals, rejects a non-record / nullish / primitive without throwing, rejects a missing or wrong-typed required field, and rejects a malformed nested element (`calls`, `messages`, `sections`); `isConversationSnapshot` also accepts a JSON-revived snapshot (the storage-read shape the database store narrows) and rejects a snapshot whose assistant `calls[]` carries a tampered element.
- [`tests/src/core/conversations/stores/DatabaseConversationStore.test.ts`](../tests/src/core/conversations/stores/DatabaseConversationStore.test.ts) — the driver-pluggable twin over a REAL `createMemoryDriver` (NO mocks): the same set→get round-trip through the ONE opaque JSON column (sections + tail + rollup summary survive), the default-driver factory overload (no arg) works the same, CROSS-INSTANCE durability (a second store over the SAME driver reads the snapshot back), upsert under the same id, delete + absent, two distinct ids coexisting, and a conversation store + a workspace store over separate drivers not colliding.
- [`tests/src/core/AgentRegistry.test.ts`](../tests/src/core/AgentRegistry.test.ts) — the registry in ISOLATION (a scripted provider): the accessors resolve a registered `provider` / `tool` / `authority` / `scheduler` and THROW a category-specific `unknown <category>: <name>` on a miss; `build` rehydrates a seeded, signal-wired agent — the seed `messages` + `system` reach the agent and its `build()`, the `tools` names resolve into a fresh per-build manager (an unknown name throws), a threaded pre-aborted `signal` commits a partial, a `budget` ceiling becomes a token budget that bounds the loop, and a resolved `limit` / `scheduler` / `authority` reach the rehydrated loop (the cap bounds it, the scheduler paces between turns, the authority denies a call without executing it).
- [`tests/src/core/Agent.test.ts`](../tests/src/core/Agent.test.ts) — the loop's DETERMINISTIC logic over a local scripted `ProviderInterface`: a single no-tools turn → `generate` returns the content; the system prompt prepended + tools advertised structurally; tool iteration (turn 1's `ToolCall` → `execute` → the result fed back → turn 2's final content); a tool throw fed back as the tool message (the loop never throws); `generate` ↔ `stream` parity (same script → deep-equal); the `AgentChunk` sequence (`token` / `think` / `usage` / `tool` chunks, with the tool chunk carrying the executed call + result and usage summed); per-run `think` forwarding into the provider; the iteration cap (an always-tool script stops at `limit`); abort (a pre-aborted `signal` commits a partial without calling the provider; `abort()` mid-stream resolves `partial: true` with the accumulated content; a genuine provider error rejects); the token `budget` bound (exhausted usage stops the turn, `partial`); the `scheduler` yielding BETWEEN turns (not after the last); `status` transitions; the authority gate wired into the loop (no authority → unchanged; an allowed call executes; a denied call is NOT executed [a counter tool proves it] yet a `tool` chunk + tool message carry the denial and the next provider call sees it; a mixed batch merges allowed + denied in original call order; an all-denied turn feeds back denials and the cap still bounds it); AND the scope-filtered tool advertisement (no scope → all tools advertised; a `tools` allow-list → only the listed definitions reach the provider, a scoped-out tool absent on EVERY turn so its handler never runs — neither described nor callable; an empty `tools` list → the provider is handed `undefined`); AND AUTOMATIC compaction (the context `window` budget): the between-turns trigger (the absolute prompt crossing `max` fires `compact()` + rebuilds smaller, EXACTLY twice over the script, the run answering through the compacted view), the no-fire-below-the-window guard, and the two additive regressions (no `window` ⇒ never folds; no conversation ⇒ the trigger is skipped + the budget untouched); AND the PRODUCTION HARDENING (a long-conversation INITIAL prompt compacted PRE-FIRST-TURN so the first provider call sees the compacted view; a THROWING auto-summarizer caught + surfaced as `fault` with the run continuing to a valid answer while a MANUAL `compact()` still throws; the FUTILE guard — a `compact()` that folds nothing while over the window latches per-run so auto-compaction stops, no churn); AND the MULTI-CONVERSATION pattern (ONE agent + a `ConversationManager`, switching the active conversation with `agent.context.conversations.switch(id)` per request: independent accumulated histories with no cross-talk, and independent per-thread compaction whose sections retain only their own thread's originals).
- [`tests/src/core/Authority.test.ts`](../tests/src/core/Authority.test.ts) — the `Authority` gate in ISOLATION: ordered first-match-wins; a matched rule allows by default and denies on `allowed: false` (carrying `zone` / `reason`); no-match → the fallback; the default fallback is allow-`'default'`; an empty rules list always returns the fallback; a deny-by-default `fallback` makes unmatched calls denied (an allowlist); the matcher receives the `{ call }` context (branching on `call.name` AND `call.arguments`).

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
