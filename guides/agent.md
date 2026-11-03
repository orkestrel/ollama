# Agent

> The conversation runtime for the `@orkestrel` line: the `ProviderInterface` inference
> boundary with the host-independent HTTP engine and browser relay that implement it, the
> conversation layer that feeds it — messages, compaction, instructions, scopes, and prompt
> assembly — and the bounded context → provider → tools → repeat loop that carries a turn to
> its end.

An agent is a conversation with a model and the loop that carries it forward. A `Conversation` holds the history — a live tail of immutable messages plus the sections older turns were compacted into. An `AgentContext` assembles that history into the next prompt, folding in the instructions, the skills and memos indexes, and the active workspace and applying the active scope. An `Agent` drives that prompt through a provider, dispatches requested tools admitted by scope and authority, feeds the results back, and repeats until the model stops. A `Ledger` composes all three to serve one conversation through records projected from what a judge filed, written into a copy of each request turn. Everything else in this module either configures those nouns or observes them. Source: [`src/core`](../src/core). Published through `@orkestrel/agent`.

Hand a provider a conversation and get back one assembled `ProviderResult` (`generate`), or a live stream of channel-tagged `ProviderDelta` values that returns that same assembled result when it ends (`stream`). Reasoning separation, the authority gate, and durable jobs sit around that boundary. The model itself is the one thing this package doesn't supply. `ProviderInterface` stays the boundary any backend can satisfy, and `AgentProvider` is the host-independent HTTP engine a concrete provider extends rather than rewrites: it owns the deadline, the transport, the bounded error read, the framing loop, reasoning separation, and result assembly, and the subclass fills in one vendor's wire. `RelayProvider` and `createRelay` carry that same boundary across your own server, so a browser drives a model it holds no credential for. There is no hidden global state, a plugin lifecycle, a prompt-template DSL, or an implicit memory store. This is a kit of composable primitives: the loop is the convenient way to use them, not the only one, and a caller that would rather bound and drive a provider by hand can skip it entirely.

Tools and files are borrowed, not owned. Callable tools come from the `@orkestrel/tool` package (see [Tool](tool.md)): the loop advertises their definitions to the model, dispatches the calls that come back, and feeds each `ToolResult` in as a tool message. A tool is loop machinery — it is never rendered into the prompt. Documents come from the `@orkestrel/workspace` package (see [Workspace](workspace.md)): the context renders the active workspace into every turn, split by carrier — text as fenced reference blocks in one user context message after the system message, images attached to the last user turn. That split is this package's own product policy, decided here because only the prompt-assembly layer defines what a turn contains.

A turn has cancellation and iteration bounds. The run's `AbortSignal` folds an agent abort, a stream abort, an external signal, a [timeout](timeout.md), and the [budget](budget.md) and `allowance` signals through `AbortSignal.any` and bounds the provider. A handler's `context.signal` is that same signal. The allowance is charged during provider streaming and the budget after each provider call and between turns, before tool dispatch; exhaustion ends the run without dispatching, never inside a handler. Tool iteration is capped at `limit`. A running tool must cooperate with cancellation: the loop awaits its result even when it ignores the signal. A cancel commits a partial `AgentResult` that resolves after the running work settles. `generate` and `stream` share one private run, so their results agree, and the emitter isolates a listener's throw.

The loop and its tool handlers execute in the host that constructs them. See [Placement proofs](#placement-proofs) for the receipts distinguishing a Node process, a browser page, and a page that relays inference to Node.

## Surface

The agent-owned surface: the inference boundary and the HTTP engine behind it, the relay that carries that boundary to a browser, the judge boundary with its HTTP engine and the System One wire, the conversation layer, the context and its managers, the loop, the authority gate, the durable-job bridge, and the ledger that serves a conversation through a judge's filing. Tool and workspace entities belong to their originating packages and are consumed directly — never re-exported here — and one vendor's wire belongs to the concrete provider that extends `AgentProvider`.

A provider turns a conversation (plus optional tools) into a turn: `generate` resolves the assembled `ProviderResult` (content + any tool calls + any usage); `stream` yields channel-tagged `ProviderDelta` values as they arrive (`content` for answer text, `thinking` for live reasoning) and returns the same assembled result when the stream completes, so a caller can render tokens / reasoning live and still get the full outcome. Both bound the call with an `AbortSignal`:

```ts
import type { ProviderDelta, ProviderInterface, ProviderResult } from '@orkestrel/agent'
import { createAbort } from '@orkestrel/abort'

declare const provider: ProviderInterface // any concrete implementation supplied by the host app
const abort = createAbort()
const messages = [{ id: '1', role: 'user', content: 'Say hello.' }] as const

const result = await provider.generate(messages, abort.signal)
result.content // the assembled content
result.usage // { prompt, completion, total } — folds into a token budget

// Renders each delta live and returns the assembled result the stream settles on.
async function print(
	stream: AsyncGenerator<ProviderDelta, ProviderResult>,
): Promise<ProviderResult> {
	for (;;) {
		const step = await stream.next()
		if (step.done) return step.value
		if (step.value.channel === 'content') process.stdout.write(step.value.text)
		if (step.value.channel === 'thinking') process.stderr.write(step.value.text)
	}
}

const streamed = await print(provider.stream(messages, abort.signal)) // the assembled ProviderResult (content === the joined content deltas)
```

Pass `tools` (a non-empty `ToolDefinition[]`) to advertise callable tools for the turn; when the model calls one, `result.tools` is a `ToolCall[]` (each with an `id`, the tool `name`, and parsed `arguments`). Aborting a `stream` mid-flight throws a `ProviderAbortError` whose `partial` holds whatever streamed before the cancel.

A tool is a JSON-Schema-described callable from the `@orkestrel/tool` package (see [Tool](tool.md)). The registry's `definitions()` method advertises tools, and its `execute` method dispatches calls. When a turn advertises tools, the loop refuses a name excluded by the scope's tool allow-list or carried by no advertised definition before reaching the registry, with the scope denial. Such a name, unadvertised or unregistered, is refused before the authority or the registry sees it, whatever the authority would decide. The returned `ToolResult` value uses the `success` discriminant: an unknown name and a throwing handler produce the failure arm, and batch execution isolates each call from its siblings. Direct registry calls behave as follows:

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

Contained failure is the registry's contract, not a limitation of it: in-process code that wants a typed error calls the tool itself — `tools.tool(name)` then `tool.execute(args, context)` inside its own `try`/`catch`. For registration, advertising, dispatch, and error containment, see [Tool](tool.md).

Collect a turn's conversation in an `AgentContext`. Add turns through `context.messages` — the active conversation's live tail, always present, satisfying `MessageManagerInterface` by minting each `id` on `add` and keeping stored messages immutable and in insertion order — then call `build()` to produce the provider input: `[systemMessage?, ...messages]`. `context.tools` sits beside them, but it is a different kind of thing: the other managers assemble prompt text, while the tool registry exists so the loop can advertise definitions and dispatch calls. Its contents reach the model as the `tools` argument, never as a message:

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createAgentContext } from '@orkestrel/agent'
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

Drive the whole turn with an `Agent` (`createAgent`) — it composes the provider, its `AgentContext`, and the tool registry into the bounded context → provider → tools → repeat loop. Seed the conversation through `agent.context.messages`, then either `generate()` for a one-shot `AgentResult` or `stream()` for a live `AgentChunk` stream (`token` answer deltas, `think` reasoning deltas, `usage`, `ask` handoffs to the approver, `tool` dispatches) whose `result` resolves the same `AgentResult`. `generate` drains that same stream, so they can't diverge:

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createAgent } from '@orkestrel/agent'
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

Both `generate` and `stream` accept optional per-run `AgentRunOptions` — `think` and `schema` (forwarded to the provider as `ProviderStreamOptions`) plus `limit` / `timeout` / `budget` / `allowance` / `signal`, each overriding its `AgentOptions` construction default for this run only. Omitting one keeps the constructed default, so a caller that passes no options gets the agent it configured. The same options carry `conversation`, which binds the run, and `prompt`, which the run appends as a `user` turn after its guards; a run with no `prompt` reads its request from the conversation's tail. A per-run `signal` composes with (never replaces) a constructed `signal` — either aborting cancels the run; the loop calls `start()` on a per-run `budget` or `allowance` for that run and charges it, leaving a constructed one untouched:

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

The turn is bounded by one cancel folded from the external `signal` + the `timeout` deadline + the `budget` and `allowance` signals through `AbortSignal.any`; `agent.abort(reason)` (or `stream.abort(reason)`) fires it. A cancel — external, deadline, budget, allowance, or `abort()` — commits a partial result: the `result` promise resolves with `{ partial: true, content: <what accumulated> }`, never rejects (a cancel isn't an error); only a genuine provider / tool error rejects. A genuine provider error after streaming still charges the `budget` the failed call's streamed-answer estimate, once, before the run rejects. The loop yields to an optional `scheduler` between turns; tool iteration is capped at `limit` (default `DEFAULT_AGENT_LIMIT`). Exhausting `limit` while the model still holds unresolved tool intent (it requested tools on the very last allowed turn) is a distinct, non-cancel cause of `partial: true` — it fires an `exhaust` event (the turns reached) instead of `abort`. A natural finish on the last allowed turn, or `limit: 0` (which never enters the loop), stays `partial: false`. `agent.status` transitions `idle` → `running` → `done` / `error`.

Gate the model's tool calls with an optional `Authority` (`createAuthority`) — a synchronous policy gate the loop consults after scope admits a call, passed through `AgentOptions.authority`. It walks ordered `rules` first-match-wins (a matched rule allows unless its `verdict` is `ask` or `deny`), falling back to a configurable default when none match — allow-unmatched by default (a denylist), or deny-by-default when its `fallback` denies (an allowlist). A denied call is never executed: the loop synthesizes the failure arm of `ToolResult` (`error: '"<name>" did not run: <reason>'`) and feeds it back as a `tool` chunk and a tool message, so no handler runs, no budget is spent, and the model still receives the denial and can request another call. An allowed call dispatches normally. An asked call dispatches only when the authority's `ask` approver resolves `true`; a refusal, a rejection, or no approver denies it. The loop raises an `allow` to an `ask` for a tool whose advertised definition is annotated `consequential`, and with no `authority` set it uses a default `Authority`, so every other scope-admitted call dispatches:

```ts
import { createAgent, createAuthority } from '@orkestrel/agent'
import { createTool, createToolManager } from '@orkestrel/tool'

// `provider`, `drop`, and `confirm` come from the host application.
const tools = createToolManager()
tools.add([
	createTool({ name: 'add', execute: (args) => Number(args.a) + Number(args.b) }),
	createTool({ name: 'delete', execute: (args) => drop(args.id) }),
])

// A denylist: deny `delete`, allow everything else (the default allow fallback), and answer an
// asked call through the host's `confirm`.
const authority = createAuthority({
	rules: [
		{
			match: (c) => c.call.name === 'delete',
			zone: 'restricted',
			verdict: 'deny',
			reason: 'read-only mode',
		},
	],
	ask: (context) => confirm(`Run ${context.call.name}?`),
})
const agent = createAgent(provider, { tools, authority })
agent.context.messages.add({ role: 'user', content: 'Delete record 42.' })
// When the model calls `delete`, the loop feeds back { error: '"delete" did not run: read-only mode' } — never runs it.
```

Every call passes the gate in one order: scope, then `evaluate`, then the `consequential` floor, then the approver, and a call that `allow` cleared is checked once more against the tool instance the turn advertised before it dispatches. The floor reads the advertised definition, so a tool annotated `consequential` asks with or without rules, and with no approver that ask is denied as unanswered. `ask: () => true` is the visible relaxation of the floor: it answers yes to every asked call.

Keep the two guard seams apart. An `ask` handler is a call guard: it reads the full `call`, so an approver must see that call before it answers, and it runs in the loop's own process, where a run `timeout` cancels it. An `execute` wrapper is a content guard: it reads what the handler returns and can refuse or rewrite it before the model reads it. The gate reads no model text, so rewording an injected instruction leaves its outcome unchanged, and it doesn't stop the model from choosing a tool that carries no annotation and no rule.

An allowlist is a `fallback` that denies, with one rule per listed tool. To stop a run at its first denial, call `agent.abort` from a `deny` listener, so the denied call stores nothing and no further turn runs. The following fence does both:

```ts
import type { ToolManagerInterface } from '@orkestrel/tool'
import { createAgent, createAuthority } from '@orkestrel/agent'

// `provider` comes from the host application.
declare const tools: ToolManagerInterface // holds `search` and `delete_order`
const authority = createAuthority({
	rules: [{ match: (context) => context.call.name === 'search', zone: 'read' }],
	fallback: { zone: 'blocked', verdict: 'deny', reason: 'that tool is not on the list' },
})
const agent = createAgent(provider, { tools, authority })
agent.emitter.on('deny', (call, reason) => agent.abort(`${call.name}: ${reason}`))
```

A rule's `reason` reaches the model verbatim in its denial, so the host authors every rule reason. A ledger lookup's finding is a records source: what a lookup returned enters the records of a later request, and the `read` handler names the ids and owners it files under.

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

The standalone `MemoManager` and `SkillManager` carry the same build contract for an index of named entries. A memo is a durable fact kept across conversations, and a skill is an instruction bundle a host supplies. Each manager renders one `- name: description` line per entry through `renderIndexEntry`, under `'## Memos'` or `'## Skills'` unless a `format` option overrides it, and `build` joins those lines with a single newline into one block. An index line is one line: a run of line-break code points in a memo or skill name or description renders as one space. A same-name memo `add` with changed text appends a revision: `memo(name)` returns the last revision, and `history(name)` lists every revision, oldest first. Re-adding unchanged text returns the current revision and emits nothing, `remove` forgets a memo with its whole history, and `snapshot()` returns owned plain data that the `snapshot` option restores without an event. The constructor copies a supplied `snapshot` through JSON and checks the copy with `isMemoSnapshot`: a malformed one throws `ContextError` with code `SNAPSHOT` before any state is seated or event emitted, and the caller's objects never alias the manager's revisions. A same-name skill `add` replaces the skill in its position, and each bundled file is minted through the `createFile` function of `@orkestrel/workspace`. `AgentContext` renders the skills index in the `system` message, after the instructions, and the memos index in the context message, before the workspace text, so the following example reads each index through `build`:

```ts
import { createAgentContext, createMemoManager, createSkillManager } from '@orkestrel/agent'

const memos = createMemoManager({ id: 'ada' })
const tone = { name: 'tone', description: 'Prefers short replies.', content: 'Answer briefly.' }
memos.add(tone)
memos.add(tone) // unchanged text: the same revision, no event
memos.add({ name: 'tone', description: 'Prefers bullet lists.', content: 'Answer in bullets.' })
memos.count // 1
memos.history('tone').length // 2
memos.memo('tone')?.description // 'Prefers bullet lists.'
memos.add({ name: 'reach', description: 'Answers by email.', content: 'Reply by email.' })
createAgentContext({ memos }).build()[0]?.content
// '## Memos\n\n- tone: Prefers bullet lists.\n- reach: Answers by email.'

const restored = createMemoManager({ snapshot: memos.snapshot() })
restored.id // 'ada'
memos.remove('tone') // true
memos.history('tone') // []
restored.history('tone').length // 2

const skills = createSkillManager()
const review = skills.add({
	name: 'review',
	description: 'Reviews a change for defects.',
	content: 'Read the diff, then list each defect with its line.',
	files: [{ path: 'checklist.md', content: { text: '- Tests pass', language: 'markdown' } }],
})
skills.skill('review')?.files[0]?.path // 'checklist.md'
skills.skills() // [review]
skills.render(review) // '- review: Reviews a change for defects.'
skills.open // '## Skills'
createAgentContext({ skills }).build()[0]?.content // '## Skills\n\n- review: Reviews a change for defects.'
skills.remove('review') // true
skills.clear()
```

To persist one memo set, store its snapshot as JSON and narrow what you read back, because a stored row is untrusted until `isMemoSnapshot` accepts it:

```ts
import { createMemoManager, isMemoSnapshot } from '@orkestrel/agent'

const memos = createMemoManager({ id: 'ada' })
memos.add({ name: 'tone', description: 'Prefers short replies.', content: 'Answer briefly.' })

const stored = JSON.stringify(memos.snapshot())
const parsed: unknown = JSON.parse(stored)
if (!isMemoSnapshot(parsed)) throw new Error('Not a memo snapshot')
const restored = createMemoManager({ snapshot: parsed })
restored.memo('tone')?.description // 'Prefers short replies.'
```

A memo's `origin` is asserted by whoever wrote it and not verified, so read it as a claim. [Persisting a conversation through either store](#persisting-a-conversation-through-either-store) shows the store seam the memo stores share.

A skills index with no tool that loads a skill is inert for the model. Agent ships no skill-loading tool, so a host that adds skills registers its own tool, which takes a skill name, loads the body through `context.instructions.add({ name: 'skill:<name>', content })`, and unloads it through `context.instructions.remove('skill:<name>')`. A loaded body applies as any instruction added during a run does, at the next build site named under scope changes. A run whose next turn does not fold keeps the head it built, so the model holds the tool's acknowledgement and not the body until the next run; a turn that folds rebuilds the head and carries the body. A load then serves that agent's later runs in every conversation, until the host removes the instruction. A host that adds no skills sees no `## Skills` section. The skills index and a loaded body render in the `system` message, so build each `SkillInput` from text the host authored, never from a user message, a tool result, a stored memo, or a page's request body, and read a loaded body from `skills.skill(name)`, never from the tool's arguments. A memo can be model-written, so the memos index renders in the context message and never in the `system` message. A relay refuses a page's `system` message, its skills index included, until `RelaySystemOptions.accept` admits it.

`build(selection)` adds at most one `system` message of its own and reads the selection's messages as conversation parts without a role check; the select path refuses a selected `system` role as a `'ROLE'` fault over `view()`; a host's direct `build(selection)` is host-trusted, and a conversation a host implements itself whose `view()` holds a `system` message is read as host-trusted too.

Documents reach a turn one way only: through the active workspace. A workspace from the `@orkestrel/workspace` package (see [Workspace](workspace.md)) is a flat map of immutable files, and it takes no position on prompts — deciding how a file becomes part of a turn is this package's job, and the decision is a split by carrier. A text file renders as a fenced reference block in a `## Workspace` section of the user context message that follows the system message, where the model can read it as quoted material. An image file can't be text, so its `base64` payload attaches to the last user message instead, the turn a vision provider reads images from. A message carries that payload on its optional `images` field — `Message` and `MessageInput` both accept `readonly images?: readonly string[]` — and a vision-capable provider forwards it onto the wire (an empty or absent array is never sent). It is input-only; `ProviderResult` is unchanged. In the following example, the `IMAGE_BASE64` placeholder stands for the base64 text of one image.

```ts
import type { ProviderInterface } from '@orkestrel/agent'

// IMAGE_BASE64 stands for the base64 text of one image.
// `abort` is an AbortController supplied by the host application.
declare const provider: ProviderInterface // a vision-capable model
const result = await provider.generate(
	[{ id: '1', role: 'user', content: 'Describe this image.', images: ['IMAGE_BASE64'] }],
	abort.signal,
)
```

`AgentContext` wires the instruction, skill, and memo managers and the workspace registry in. Beyond `system`, `messages`, and `tools`, a context exposes its own `instructions`, `skills`, and `memos` managers and `workspaces` registry — pass pre-built ones through `AgentContextOptions`, or fresh empty ones are created — and `build()` folds them into the turn. The assembly order is one leading `system` message holding the system prompt, then the non-empty instructions block (its `open` header, each item's `render` output, and its `close` line when set), then the non-empty skills index, joined by blank lines; then one `user` context message holding the memos index, then the active workspace's text files under a `## Workspace` header; then the conversation, or the `messages` of a selection passed to `build`. With no instructions, no skills, no memos, no active workspace, and no scope, that reduces to exactly the lean `[systemMessage?, ...messages]`. The carrier split shows here: the system message holds host-authored text alone, memo and workspace text ride the context message, and image data rides the last user message.

````ts
import { createAgentContext } from '@orkestrel/agent'

const context = createAgentContext({ system: 'You are a code reviewer.' })
context.instructions.add({ name: 'tone', content: 'Be terse.', priority: 10 })
context.workspaces.add().write('src/main.ts', 'export const x = 1') // the active workspace
context.messages.add({ role: 'user', content: 'Review this.' })

const input = context.build()
// input[0] = { role: 'system', content: 'You are a code reviewer.\n\n## Instructions\n\nBe terse.' }
// input[1] = { role: 'user', content: '## Workspace\n\nFile: src/main.ts\n```typescript\nexport const x = 1\n```' }
// input[2] = { role: 'user', content: 'Review this.' }
````

### Conversations & compaction

Above the flat `MessageManagerInterface` sits the `Conversation` (`createConversation` / a `ConversationManager`) — it owns its messages directly and compacts older ones into summarized `sections` so a long history fits a turn's context window without discarding the originals. Append turns through the conversation's own `add` (the live uncompacted tail; `message` / `messages` / `remove` / `clear` / `count` round it out); `compact()` folds the older live messages into a summarized `Section` (retaining their originals) and shrinks `view()` — the model input, where each section becomes one summary message followed by the live tail. Compaction is driven by a provider-agnostic `ConversationSummaryHandler` seam (`(messages, signal?) => Promise<string>`) the agent runtime supplies, so a `compact()` without one throws a `ConversationError`. `keep` retains a recent tail (default `DEFAULT_CONVERSATION_KEEP` = `0`, no retained tail); `rehydrate(id)` / `search(query)` read the retained originals. A fold never takes the newest user message or any message after it, because that message is the request a run serves. An exchange is a user message and every message after it up to the next user message. The messages before the first user message form their own exchange, which folds only together with the first user exchange. A fold removes whole exchanges: a cut inside an exchange moves back to its start. A fold never splits an assistant message with calls from the tool messages that answer it, matched by each tool message's `call` member with a positional fallback: a cut inside that group moves before the assistant message. When those rules leave nothing to fold, `compact()` returns `undefined`:

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createConversation } from '@orkestrel/agent'

declare const provider: ProviderInterface // any concrete implementation supplied by the host app
// The summarizer seam — built from the provider by the runtime; core stays provider-agnostic.
// Append the instruction as the FINAL user turn: a chat model emits nothing when the prompt
// ends on an assistant turn, so a leading-system instruction is unreliable.
const conversation = createConversation({
	summarize: async (messages, signal) =>
		(
			await provider.generate(
				[
					...messages,
					{ id: 's', role: 'user', content: 'Summarize the conversation so far concisely.' },
				],
				signal ?? AbortSignal.timeout(30_000), // the compact() call's signal, when it passed one
			)
		).content,
	keep: 2, // retain at least the 2 most recent messages verbatim on each compaction
})
conversation.add([
	{ role: 'user', content: 'My name is Ada.' },
	{ role: 'assistant', content: 'Nice to meet you, Ada.' },
	{ role: 'user', content: 'Book a table for two at 19:00.' },
	{ role: 'assistant', content: 'Booked for two at 19:00.' },
	{ role: 'user', content: 'What did I say my name was?' },
])

const section = await conversation.compact() // folds the first exchange → a summarized section
conversation.view() // [<section summary message>, ...the retained recent exchanges] — the model input
conversation.search('ada') // case-insensitive across sections' originals + the live tail
section && conversation.rehydrate(section.id) // the section's full original messages (a pure read)
```

Calls to `compact()` run one at a time: a call made while another is in flight waits for it, then folds from the live tail it finds. A fold commits only when every folded message is still the same live entry after the summarizer settles, so a `remove` or `clear` during the initial summarizer makes `compact()` resolve `undefined` and leaves no section. A summarizer must not call `compact()` on the conversation it serves. When no other fold is in flight, a fold counts as in flight only after its summarizer returns, so the summarizer's own call waits for nothing and summarizes the same slice again; the commit check keeps one section, because the later fold finds its slice already folded and resolves `undefined`. Pass `CompactOptions.signal` to cancel a fold: the summarizer receives the signal as its second argument, and an abort rejects `compact()` with the signal's reason at once, even when the summarizer ignores the signal, and commits nothing after the abort; a fold committed before an aborted overflow merge stays. `keep` must be a nonnegative safe integer: `NaN`, a fraction, a negative, or `Infinity` throws `ConversationError` with code `KEEP` before any summarizer call.

Register a conversation in a `ConversationManager` and pass that registry through `AgentContextOptions.conversations` to make it the message source. `context.messages` then is the active conversation's live tail, and `build()` folds its `view()`. The scope's filters never touch messages; message inclusion is the conversation's through compaction and, when a handler is set, the selection's. When the registry is omitted, the context creates one with an active default conversation.

Pass that registry through `AgentOptions.conversations` together with an `AgentOptions.window` context [`Budget`](budget.md) to enable automatic compaction. Before the first provider request and between turns, the loop measures each request it will send, with its messages after the `replay` policy, its advertised tools, and its per-call `options`, against the window and, when that request reaches the ceiling, compacts the run's conversation, when it is summarizable, before continuing on the rebuilt view. Omit `window` and the loop doesn't auto-compact. See the [Contract](#contract) (the automatic-compaction clause) for the exact trigger and the compaction floor.

```ts
import { createAgent, createConversationManager, estimateRequest } from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'

// `provider` and `summarize` come from the host application.
const conversations = createConversationManager({ summarize, keep: 2 })
const conversation = conversations.add()
const agent = createAgent(provider, {
	conversations,
	// A context Budget: consumer = a token estimator, max = the context window. The loop measures
	// each request against it. A request that reaches the window folds once and continues on the
	// rebuilt (smaller) view; only `strict` refuses a request still over the window.
	window: createBudget({ max: 8_000, consumer: estimateRequest }),
})
agent.context.messages.add({ role: 'user', content: 'Hi' })
await agent.generate() // folds older turns into a section mid-run when the prompt reaches the window, then continues
```

Set `max` under a hard ceiling: on 11 agent requests with no tool call, recorded on 2026-11-02 on Qwen 3.5 2B on Ollama 0.40.13, over a scripted support-desk conversation of up to 38 messages and 46713 characters (median 640, 95th percentile 3367, maximum 3506), `estimateRequest` read 147 to 204 tokens under the daemon's prompt count of 1850 to 12283, so leave at least that headroom. No other model and no request holding a tool call has a reading here.

##### One agent per principal, one conversation per run (binding a run to its thread)

`agent.context.conversations` is the structural registry, supplied at construction and never reassigned, and its active conversation is the default a run binds. `context.messages` is dynamic: it always points at the current active conversation's live tail (the same reference, no duplication) and follows `conversations.switch(id)`. The registry always has an active conversation (a default is added when it has none). A run binds its conversation once, at its `generate` or `stream` call: the `AgentRunOptions.conversation` it names, else the active one. The run reads its request from that conversation, appends every reply to it, and folds it, so a later `switch`, `open`, `remove`, `clear`, or same-id `add` never moves a live run, and a switch sets only the next run's default. Each conversation accumulates its own history and compacts independently (one thread's sections never leak into another). On a server, the application's session table holds one entry per authenticated principal, `{ agent, threads }`: `threads` is a `createConversationManager()` value that principal owns, and `agent` is one `Agent` built once for that principal from shared providers, tools, rules, and immutable host text. Each request names its thread, looked up in the principal's own `threads` and never in a process-global registry, and passes the request's text as the run's `AgentRunOptions.prompt`. The run appends the prompt to the thread as a `user` turn after its guards, so a refused run appends nothing; a run with no `prompt` reads its request from the conversation's tail:

```ts
import type { AgentInterface, ConversationManagerInterface } from '@orkestrel/agent'
import { createAgent, createConversationManager, estimateRequest } from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'

interface Session {
	readonly agent: AgentInterface
	readonly threads: ConversationManagerInterface
}

// Per request: find or add the thread in the principal's own registry, then run on it with the
// request's text as the prompt, which the run appends after its guards.
async function handle(session: Session, threadId: string, text: string): Promise<string> {
	const thread = session.threads.conversation(threadId) ?? session.threads.add({ id: threadId })
	return (await session.agent.generate({ conversation: thread, prompt: { content: text } })).content
}

// `provider` and `summarize` come from the host application.
// The session table: one entry per authenticated principal, held by the application.
const sessions = new Map<string, Session>()
for (const principal of ['ada', 'grace']) {
	// Each entry owns its threads and its window; neither is shared across principals.
	const threads = createConversationManager({ summarize, keep: 2 })
	const agent = createAgent(provider, {
		conversations: threads,
		window: createBudget({ max: 8_000, consumer: estimateRequest }),
	})
	sessions.set(principal, { agent, threads })
}

const ada = sessions.get('ada')
const grace = sessions.get('grace')
if (ada === undefined || grace === undefined) throw new Error('unknown principal')
// Ada's trip thread accumulates and compacts on its own.
await handle(ada, 'trip', 'Hi, I am Ada.')
// Ada's math thread is independent of her trip thread.
await handle(ada, 'math', 'What is 2 + 2?')
// The same thread id under Grace is her own thread: it carries none of Ada's turns.
await handle(grace, 'trip', 'What did I say my name was?')
```

> **Concurrency caveat.** [Serving one agent per principal](#serving-one-agent-per-principal) holds what this session table shares and refuses. Here a refused overlap rejects the promise `handle` returns, so the caller rethrows or maps `AgentError` `'CONCURRENCY'`.

##### Production behaviors of automatic compaction

Auto-compaction (the `window` budget) is hardened for a long-running app:

- **Pre-first-turn + run-entry reset.** The budget check runs before the first provider request and between turns — so a resumed or already-long conversation whose initial prompt already exceeds the window compacts immediately (not only after a tool turn). The `window` budget is reset at run entry, so no stale measurement carries across runs or a conversation switch.
- **No fold after a cancel.** When the run's signal has aborted by the time tool dispatch ends, the loop records the tool messages and folds nothing, so a cancel never waits on the summarizer. The next run's pre-first-turn check folds the earlier exchanges, call groups whole.
- **What a cancel waits for.** The loop races a scheduler's yield, the approver's answer, and the summarizer against the run signal, so one that ignores its signal still ends on a cancel; a provider stream, a judge, a tool handler, and a selection handler are awaited until they settle, because each can carry usage or finished work, so one that ignores its signal holds the run past a cancel or a timeout, and on a ledger its held scan, until it returns.
- **Observable summarizer failure, non-fatal unless strict.** If the summarizer throws during automatic compaction, the loop emits the error as a `fault` event, so the failure is never silently lost. Without `AgentOptions.strict`, the run doesn't crash: the loop skips compaction that turn and continues, and the over-window prompt proceeds to the provider. With `strict` set, the run settles `error` after the `fault` event (see the `strict` clause under [Contract](#contract)). A manual `conversation.compact()` call you make yourself always propagates its error.
- **Futile-compaction guard.** If `compact()` folds nothing (returns `undefined`) between turns while the prompt is still over the window — that is, the section summaries, the run's request, and the run's own turns, which that fold never takes, already exceed it — the loop stops auto-compacting for the rest of that run (a per-run latch), avoiding per-turn churn. The over-window prompt then proceeds to the provider, and the provider decides what happens past its window. A plain fold takes the live tail and leaves the existing sections; a `sections` cap and `cumulative` fold existing sections too, each on a fold that has an eligible slice, as the `cumulative` folds and compaction floor clauses under [Contract](#contract) state.

The following listener observes an automatic-compaction summarizer failure:

```ts
// `agent` comes from the preceding example; `log` comes from the host application.
agent.emitter.on('fault', (error) =>
	log('auto-compaction summarizer failed (run continues)', error),
)
```

### Scoping a turn

A `Scope` (`createScope` / a `ScopeManager`) is a named allow-list filter the context applies at `build()` time and at the loop's tool-advertise step. It carries an optional `instructions` / `skills` / `memos` / `tools` / `files` list keyed by each category's identity — `instructions` (by `name`), `skills` (by `name`), `memos` (by `name`), `tools` (by `name`), `files` (the active workspace's files, by `path`) — each three-way: `undefined` ⇒ no constraint (all pass), `[]` ⇒ none pass, a non-empty list ⇒ only the listed keys. The scope's filters never touch messages; message inclusion is the conversation's through compaction and, when a handler is set, the selection's, so a scope has no `messages` allow-list. A scope also carries an optional `select` handler, covered in [Selecting the messages a turn carries](#selecting-the-messages-a-turn-carries). Apply the active filter through `context.apply(scope)`; call `context.apply(undefined)` to remove filtering. The readonly `context.scope` getter reports the current filter, and `build()` reflects whatever scope is active when it runs (recomputed fresh each call). `narrow(config)` composes a tighter child scope by set-intersection (an `undefined` side imposes no constraint), so narrowing can only tighten — a parent-excluded key never returns:

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

A scoped-out tool is neither described nor callable. The loop snapshots the scope's tool allow-list before advertising and checks each returned call against that list before consulting the `AgentOptions.authority` option. An `undefined` scope value, or an absent `tools` list, admits every advertised name and refuses a name no advertised definition carries with the scope denial. An empty `tools` list admits none.

A scope change through the `context.apply` method applies at each later site that reads the scope. The tool half applies at the next turn's snapshot: a `tool` or `usage` listener changes the next turn's advertising, and a `turn` listener reaches the same turn, because `turn` fires before the snapshot. The prompt half (instructions, skills, memos, files, and `select`) applies at the next build or select site: run entry, the pre-first-turn compaction fold, or a compaction rebuild.

When no tool is advertised, including an empty registry, the provider's `content` field ends the run as the answer with a `partial: false` result. The assistant message is recorded without calls. Each dropped call emits a `deny` event with the `no tool is advertised in the active scope` reason, without a tool result or tool message.

When at least one tool is advertised, a call excluded by the tool allow-list or naming no advertised tool emits a `deny` event with the `TOOL is not in the active scope` reason, where the `TOOL` placeholder is the requested name. Its denial `ToolResult` value carries the `"TOOL" did not run: it is not one of the listed tools. Use a listed tool or answer with what you have.` error and is fed back as a tool message. Admitted calls pass through authority and dispatch normally. The loop continues with results in the reply's call order, including when calls share an ID.

A `ScopeManager` registry stores reusable named scopes, keyed by a minted `id` field; scopes can share a `name` field. It is observable like the other managers.

### Selecting the messages a turn carries

A selection handler chooses the conversation messages the next prompt carries for one user request. It has two homes: `AgentOptions.select` is the agent default, forwarded as `AgentContextOptions.select`, and the active scope's `select` overrides it while that scope is active. The `context.select` method resolves `scope?.select ?? default` once per call and returns `undefined` when neither home holds a handler, so the default path awaits nothing before the first provider request.

The loop calls the handler at each select site (run entry, the pre-first-turn compaction fold, and a compaction rebuild) with the run's conversation, the user message that ends that conversation's view at run entry, and the run's signal; when the view ends on another role, it calls no handler. It folds the result through `build(selection)`, which carries `selection.messages` in place of `view()` after the unchanged system and context messages, and then emits `select` with the `Selection`. That event fires at each select site, so twice before turn 0 when the pre-first-turn fold runs, and never for a run cancelled during selection.

A `Selection` carries the `messages`, the `judgments` keys they rest on, the judge `usage` spent, and an optional `fault`. Its `messages` are conversation parts only: a handler that adds text for the model writes it into one of them, as a ledger writes its records into a copy of the request turn, because the system message holds host-authored text alone. It has no tool member: what a turn advertises and dispatches stays the scope's `tools` allow-list.

The following agent selects through its default handler, then through a mode's override:

```ts
import type { ProviderInterface, Selection, SelectionHandler } from '@orkestrel/agent'
import { createAgent, createScope } from '@orkestrel/agent'

declare const provider: ProviderInterface

// The agent default keeps the user turns; the focus mode keeps the request alone.
const userTurns: SelectionHandler = async (conversation) => ({
	messages: conversation.view().filter((message) => message.role === 'user'),
	judgments: [],
})
const requestOnly: SelectionHandler = async (_conversation, request) => ({
	messages: [request],
	judgments: [],
})

const agent = createAgent(provider, { system: 'You triage billing tickets.', select: userTurns })
const receipts: Selection[] = []
agent.emitter.on('select', (selection) => receipts.push(selection))
agent.context.messages.add([
	{ role: 'user', content: 'The invoice total is wrong.' },
	{ role: 'assistant', content: 'Which invoice?' },
	{ role: 'user', content: 'Invoice 42.' },
])
await agent.generate() // the provider reads the system block and the two user turns

agent.context.apply(createScope({ name: 'focus', select: requestOnly }))
agent.context.messages.add({ role: 'user', content: 'Refund it.' })
await agent.generate() // the provider reads the system block and 'Refund it.'
receipts.map((selection) => selection.messages.length) // [2, 1]

const plain = createAgent(provider)
const request = plain.context.messages.add({ role: 'user', content: 'Invoice 42.' })
plain.context.select(plain.context.messages, request, new AbortController().signal) // undefined — no handler in either home
```

A selection fails four ways. A handler throw emits `fault`, and the loop builds from `view()` with no `select` event. A returned `fault` charges its usage first, then emits `fault`, and the loop builds from the returned `messages` and emits `select`. A conversation changed under the handler is a fault as well: `context.select` returns the current `view()` with a `fault` that names the change. A `system` message in a handler's selection is a fault over `view()` carrying `ConversationError` `'ROLE'`. With `AgentOptions.strict` set, all four settle the run `error`. A cancel at a select site wins over all of them, and the run commits partial with no provider call.

Selection usage is charged in full to the cost `budget` and folded into `AgentResult.usage`. No `usage` chunk or `usage` event carries it, so that chunk keeps its one-provider-call meaning.

### Judgments on the conversation

A conversation's `judgments` store records what a judge answered about its messages. Each record is keyed by the caller's question id, and adding an existing key replaces the record in place, last write wins, at its original insertion position, and the `add` method stamps the `time` member. A record carries the question, the answer or the refusal, the judge's configured `model`, the ordered `sources` ids, and the rendered `state`, and it carries `usage` only when its request asked that one question.

The `resolve(judge, request, sources, signal)` method reuses every recorded judgment that matches and asks the judge once for the rest, recording what returns. A match compares the question as a JSON value, the sources in order, the rendered state, and the judge's configured `model` rather than the name a server reports, so a question whose keys arrive in another order, from a store that returns keys sorted or a host that builds it in another order, matches, and a changed criterion, a changed state, or a changed source order asks again. Criteria order reaches the prompt and a small model reads options by position, so a reused answer keeps the reading its first order earned; call `remove(id)` to ask again after reordering. A cancel keeps the records of the questions that completed and rethrows the abort.

A question id is a caller key that the prompt never carries, so the whole question lives in `instructions`, and a judgment that needs an earlier answer is a second request. A snapshot carries `judgments` only while the store holds one, so a conversation without judgments serializes as `{ id, sections, messages }`, and a snapshot written without the member still validates and restores.

The `judgment`, `add`, and `resolve` methods return the stored deep-frozen record, and the `judgments` method returns a fresh array of them. `ConversationInterface.snapshot()` and `LedgerInterface.snapshot().conversation` carry those records. `MemoryConversationStore.get` hands back the stored snapshot object itself: its messages and sections are shared with the store, so an edit to them changes what the next `get` returns, and its judgments are frozen records, so a write to one throws `TypeError` in strict-mode code; copy a judgment through `copyJSON` to migrate or redact it. Hydrating takes an owned frozen copy and never touches its input.

The following conversation records one answer and then reuses it:

```ts
import type { JudgeRequest } from '@orkestrel/agent'
import { createConversation, createSystemOneJudge } from '@orkestrel/agent'

declare const signal: AbortSignal

const judge = createSystemOneJudge({ url: 'http://localhost:11434', model: 'tev1:0.8b' })
const conversation = createConversation()
const ticket = conversation.add({
	role: 'user',
	content: 'Our checkout has returned 500 errors since 9am. I want a refund for today.',
})
const request: JudgeRequest = {
	state: ticket.content,
	questions: {
		refund: {
			form: 'noul',
			instructions: 'Does the customer ask for money back?',
			criteria: {
				true: 'The customer asks for a refund or for money back.',
				false: 'The customer does not ask for money back.',
			},
		},
	},
}

const [asked] = await conversation.judgments.resolve(judge, request, [ticket.id], signal)
asked?.model // 'tev1:0.8b' — the configured judge
asked?.usage // { prompt: 975, completion: 4, total: 979 } — the request asked this one question
const [reused] = await conversation.judgments.resolve(judge, request, [ticket.id], signal)
reused?.time === asked?.time // true — the matching record answers without a call
conversation.snapshot().judgments?.length // 1
```

The usage in the comment is the one the recorded Ollama response of 2026-10-07 reports; the executed transcription serves that response from a loopback listener (see [the `tests/guides.test.ts` parity test](../tests/guides.test.ts)).

Treat a judge as frozen at inference: change thresholds and criteria in code, record corrections as judgments, and train another model only offline, as a batch on rows collected for that purpose, refitting temperature on rows the training run didn't use.

Write criteria for a judge that reads literally (see [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)). Scoping words and negations count, so keep a `noul` whose true side means yes, and keep indirection such as a double negative out of the text. Keep arithmetic and date comparison in code, filter irrelevant state before asking, and treat a note inside the state as data that can move the answer. Reorder options to check for a lean toward the first one, under a new question id or after `remove(id)`, because a matching judgment keeps its first reading.

### Serving a conversation through a ledger

A ledger serves one conversation as event-sourced records with one record per owner. The `createLedger(provider, options)` factory returns a `LedgerInterface` value that owns the conversation, the agent that answers it, and that agent's tools, and its `respond` method appends a request as a user message and serves it through to the reply. The conversation is the event log. Each request reads the system message, which holds the `system` option and whatever instructions and skills the `agent` option supplies, then the context message when the `agent` option supplies memos or an active workspace, then a tail of the seed history (the messages added before the first request), then a copy of the request turn: the records the ledger projects from what a judge filed about every message, a `## Request` heading, and the request. The stored request keeps its own content. An earlier request and its reply don't re-enter a planned prompt; what its lookups returned reaches a later request through the records and the `recall` tool. When the selection faults, the agent builds the prompt from the whole conversation view instead, earlier requests and replies included, with no records.

Run the ledger's agent only through the `respond` method: the ledger's agent serves only the ledger's `conversation`. An active `respond` call owns a run on that conversation whose request, the newest message, is that call's request or one of the ledger's notes. A run that no active `respond` call owns, such as a direct call to the agent's `generate` method or a run on another conversation, gets a faulted selection when its newest message is a user message: the selection's `fault` is a `LedgerError` with code `'REQUEST'`, so the agent emits `fault` and builds the prompt from the whole view of the run's conversation with no records, and the ledger asks its judge nothing for that run. When its newest message isn't a user message, the run gets no selection and builds from the whole view. Calibration admits no run, so a run during the `calibrate` method, or during the calibration that opens a `respond` call, is one that no active `respond` call owns.

The method has the following pieces, each named by its export:

- **The filing.** The `Classifier` class files each message through the judge the `judge` option injects. The ledger files a tool result, its own notes, an assistant call, and an assistant reply after the first request by their shape, and asks the judge about the rest: the `LEDGER_QUESTIONS` category question about each remaining non-request message, and the topic question, for each desk topic, about each non-quiet statement and each request unless that topic has `requested: false`; and the `amends` question about a later user message whose `correction` probability reaches the `correction` cutoff and an earlier message that isn't quiet and shares an id, an owner, or a desk topic with it, followed by the `supersedes` question about the same pair when the `amends` answer reaches its cutoff. The `narrow` member of the `correction` option keeps only the eligible earlier messages that also share a registry entity with the correction or an id or a number in their content, so a desk topic alone admits no pair, and a correction with no id, owner, or desk topic still asks no pair. On a scripted support-desk conversation recorded on 2026-11-03 with the Mica v0.1 4B judge on Ollama 0.40.14, `narrow` took 24 judge calls and 45 s against 68 and 136 s at a correction in 199 messages of 285889 characters (median 577, 95th percentile 5111, maximum 10059), and 26 judge calls and 45 s against 109 and 196 s at a correction in 290 messages of 539538 characters (median 583, 95th percentile 5906, maximum 32883). Those calls include the category and topic questions `narrow` leaves in place. Filings were equal at those two corrections, on 5 pairs and 1 supersession. A third correction, forecast from recorded answers and not run, lost 0 of 8 pairs. The 173 pairs `narrow` drops across the three, 196 questions, filed 0 on recorded answers, on text whose corrections repeat a literal by construction, and the registry-entity path admitted no pair on this recording. A true supersession outside that set is never asked, and no run on any model measures how often one occurs. Set `narrow` when a correction's wait costs more than a missed supersession and your corrections repeat the id, number, or looked-up entity they correct. Leave it off for a host with no lookups or with free-text values. Every answer lands in the conversation's `judgments` store, so a later request asks only what no earlier one asked. A judge failure leaves its question unanswered, and the next request asks it again, except for two failures that hold the question so that no later request asks it: a refused question, which the judge reports as a `JudgeError` with code `'QUESTION'`, and the deterministic logprob failure the `DETERMINISTIC_JUDGE_ERROR` constant matches. The `LedgerClassification` value reads the filing back at the cutoffs: an `amends` answer at its cutoff marks a pair amended only when the two messages share an id or a number, and a `supersedes` answer at its cutoff marks the pair superseded and amended whatever they share. Each `classify` call also returns one `ClassifierAttempt` value per logical filing question it attempted, in asking order, and observes the filing without changing it. An attempt names the question's key and its `ClassifierPhase` value, and its `ClassifierOutcome` value says whether the conversation already held the judgment (`cached`), the classifier held the question after a deterministic failure or because a message it names left the conversation (`skipped`), or the judgment manager's `resolve` call fulfilled (`resolved`), rejected under a live signal (`failed`), or was cut short by an abort (`aborted`). A `resolved`, `failed`, or `aborted` attempt carries the monotonic milliseconds the classifier waited on that call as `duration`, and a `cached` or `skipped` attempt carries none. A question that a caller abort preceded has no attempt, because it never began. The attempts count logical questions and resolve requests, never the physical wire calls a judge makes for them, and they record no join of pending requests. The `attempts` member of the `LedgerResult` value holds the attempts of the filing selections of that `respond` call alone; the `Selection` values the ledger emits carry none. A page passes `agent: { scheduler: createBrowserScheduler() }` from `@orkestrel/workflow/browser`, so the classifier hands the host a turn each time the `LEDGER_SLICE` constant's milliseconds have run while it files, and the plan after the filing still runs as one task; a page that omits the option also runs each stretch of cached filing as one task, and the host gets a turn only while the classifier waits on the judge. A direct `agent.context.select` for the same request during a paced filing's yield rejects with `AgentError` `'CONCURRENCY'`, and one for a message the call does not own returns a selection whose `fault` is `LedgerError` `'REQUEST'`. A `classify` call reads each message's quiet flag and near set at most once while it pairs corrections, so a judgment or message written during a pair-phase await reads at the next `classify` call, and `LedgerLookup.read` runs one time per tool message for each plan, each `recall` call, and each filing pass. The **What a cancel waits for.** bullet under [Production behaviors of automatic compaction](#production-behaviors-of-automatic-compaction) applies to this filing: what it names holds the run, and on a ledger its held scan, until it returns.
- **The records.** The `buildRecords` helper projects the filing into one `LedgerRecord` value per owner a lookup result names, plus one rules record for the rules and corrections no owner claims. Each line is a sentence of a live message, verbatim except that a sentence that opens with a pronoun opens with its party and a colon. A message filed quiet or superseded isn't live. Accepted message-level amendments preserve every original indexed sentence of live earlier sources; the projection lists distinct direct edges in its `amendments` member. Sentence scope remains unresolved. The `recall` tool and the answer note keep the stored content of each message they carry. The seed tail keeps stored content except for lookup results, which the plan replaces with stubs.
- **Amendment scope.** The first retained occurrence of an amended source opens with its `[N]` reference and a note on its later changes. Distinct retained sources receive decimal references starting at 1 in first-occurrence emission order, after deduplication. References are local to one rendering of the records and are recomputed after each trim; omitted sources do not shift them. Repeated occurrences share one reference. Recall and storage retain original source IDs. Authored content is unchanged. A fully included later source opens with its own [M] reference, and the earlier source's note reads “Changed later by [M].” If any effective correction is absent, partial, or superseded, the note reads “A later change is not shown.” The omission note exposes no omitted identity, text, owner, or count. Completeness uses every original sentence identity after source deduplication and each trim; annotations count against the existing room. Effective superseded amenders retain provenance without restoring their text. No transitive amendment edge is inferred. Earlier text can conflict with its correction; downstream correction application and semantic sentence withdrawal remain unproved.
- **The plan.** For each request, the ledger selects the records the request names through the `selectRecords` helper and fits the built head (the system message and the context message), the tail, and the copy of the request turn that carries the records inside a token budget: the `capacity` option less the `predict` option, times the `prompt` share, less the overhead cost of the gauge and held back by the `LEDGER_SCALE_DRIFT` constant, of which the tail takes at most the `tail` share. Owner records with the same member ids in the same order render once, under their titles joined with `; `; before trimming, the view keeps the first requested record's key, members, and lines. The projection, held sources, and recall stay unchanged. The budget bounds only the records and the tail of a request's first call: the plan prices the built head, the tail, and the copy of the request turn with the records and images it carries. The request, each lookup result, the pass's own assistant turns with their calls and replayed thinking, the answer note and the `cue` note, and the whole view a faulted selection builds from enter the prompt unbounded, so any of them can carry a prompt past the budget. The plan prices each lookup stub in the tail at the longer of its `shown` and `hidden` forms, so a tail that fits the plan still fits after the records decide which results they show. The `share` option sets both shares, and the `DEFAULT_LEDGER_SHARE` constant holds the defaults. Until the records fit, the ledger drops the rules off the request's topics, then the sources outside the selected records, then the rules on its topics, then the owner lines. Inside an owner record, it drops the lines whose source isn't a rule or a correction first, oldest first, then the lines of rules and corrections, oldest first. The `Gauge` class prices the prompt; without the `gauge` option, the ledger calibrates before its first pass, and the `calibrate` method measures the price on demand. A lookup in the tail reaches the model as the stub the `renderStub` helper writes, which says whether the records show its result. The plan reaches the agent as a `Selection` value whose `messages` member is the tail, then the copy of the request turn that the `buildRequestMessage` helper writes: the records, a blank line, a `## Request` heading, and the request. When no records render, the copy is the request itself. The answer pass carries the same copy, and the stored request keeps its own content.
- **The `recall` tool.** The ledger registers a `recall` tool beside the application's lookups. It lists the earlier messages and lookup findings that match a topic (an owner name, an id, or a topic) with their stored content, newest first, each source followed by the amenders the topic doesn't match itself; an amender the topic matches lists as its own newer item. The tool cuts the list by whole items to the room the gauge leaves for the reply, naming how many older items it left out. A request can call it as many times as the `limit` member of the `recall` option allows, the `DEFAULT_RECALL_LIMIT` constant by default; after that, or when the capacity left less the `predict` option falls under twice the reply's reserve, it returns the `closure` note.
- **The repeat stop.** A lookup or `recall` call that repeats an earlier call of the same request, compared by tool name and canonical arguments, returns the `repeat` note as its failure, and the ledger aborts the pass. For a lookup, the repeat stop's identity compares string arguments as written. The projection's lookup identity, which the `identifyLookup` helper writes, trims and uppercases each top-level string argument and decides which finding replaces an earlier one. So `lookup_order` calls for `bw-5512` and `BW-5512` both run in one request, and the second finding replaces the first in the records.
- **The answer pass.** When the first pass ends partial or without final text and the caller didn't abort, the ledger adds an answer note when the pass's lookups or recalls returned anything, carrying what they returned without their call text, then the `cue` note, and runs one answer pass that advertises no tools and always turns thinking off. The `passes` member of the `LedgerResult` value holds both passes, and its `content` member is the last pass's. A rejected first pass counts as unfinished. When the answer pass rejects as well, the `respond` method rejects with that pass's error, and the ledger stays free for a later request.
- **The thinking budget.** The `predict` option reserves the generation room that thinking and the reply share, taking it out of the plan budget, the recall room, and the close rule. The gauge counts only the thinking the next request carries: under the provider's default `replay` of `'none'`, it leaves a call's thinking out of the capacity that call used, and the `computeThinking` helper apportions that thinking from the completion by character share. Under every policy, the reply reserve reads the reply without its thinking. The `think` option requests or suppresses thinking for the first pass, and omission leaves the provider's default; the answer pass always runs with thinking off. With replay `'none'`, a ledger at a `capacity` of `W + P` with a `predict` of `P`, where `W` is a context window and `P` a generation cap, budgets like a ledger at `W` without thinking.

Display references identify sources within the rendered records while the line keeps the stored identity:

```ts
import type { LedgerLine } from '@orkestrel/agent'
import { buildLedgerRenderContext } from '@orkestrel/agent'

const first: LedgerLine = {
	text: 'Keep the receipt.',
	source: 'stored-source-id',
	sentence: 0,
	topics: [],
	role: 'user',
}
const display = buildLedgerRenderContext([], [first], [])
display.references.get('stored-source-id') // '1'
first.source // 'stored-source-id'
```

The application supplies the following through `LedgerOptions`:

- the judge, through the `judge` option;
- the question wording, through the `questions` option, where the `LEDGER_QUESTIONS` constant is the wording, and its own cutoffs through the `thresholds` option, which has no default because a cutoff holds only for the wording and the judge it was fitted on;
- the desk topics, through the `topics` option;
- the lookups, through the `lookups` option, each a tool the model calls and a reading handler that names the ids and the owners in its result;
- the capacity, through the `capacity` option, the model's context window in tokens;
- the generation cap, through the `predict` option, in tokens with thinking included, 0 by default and less than `capacity`;
- the thinking of the first pass, through the boolean `think` option; the answer pass always runs with thinking off;
- the state to hydrate from, through the `snapshot` option, which takes what a ledger's `snapshot` method returned: the conversation with its judgments, the marked request, note, and failed tool result ids, and the gauge, which a `gauge` option overrides.

The method has the following documented limits:

- **The person prefix trusts capital letters.** A sentence that opens with a pronoun takes the last capitalized name of the sentence before it as its party, so a capitalized word that names no person, such as a carrier named mid-sentence, is read as the party.
- **A desk-wide correction stays in one owner's record.** A message that names an owner joins that owner's record and not the rules record, so a correction to a desk-wide rule stated inside one owner's message isn't among the rules a request about another owner reads.
- **Recall identity is the topic alone.** The repeat stop compares two `recall` calls by their trimmed `topic` argument, so a second call with the same topic is a repeat whatever other arguments it carries.
- **A direct run beside a request is refused or unowned.** A direct run on the ledger's conversation while a `respond` call's pass runs is refused with `AgentError` `'CONCURRENCY'`; during the calibration that opens the call it is a run no active `respond` call owns. A run on another conversation started during a `respond` call gets no ledger selection, yet adds its turns and usage to that call's gauge readings and shares its repeat stop. A run on another conversation can still reach the `recall` and lookup tools, which the ledger's agent advertises to every run and which read the ledger's `conversation`.
- **A run no call owns keeps no request state.** The ledger holds a request's state in a `LedgerRequest` value from the start of its `respond` call until the call settles. A run that no `respond` call owns, including a run during calibration, reads no request's state: its lookup and `recall` calls run with no repeat stop, recall limit, or close rule, and none of its turns reach a gauge reading.
- **A seed tool message counts as successful.** A tool message the application adds to the conversation has no recorded result, so the ledger reads it as a successful lookup and files it as a fact, and its reading handler decides what the result names.
- **An abort during calibration rejects.** When the caller's signal aborts while the ledger calibrates, the `respond` method rejects with the abort reason instead of resolving a partial result; after calibration, an abort ends the request partial and skips the answer pass.
- **A foreign signal rejects before anything is appended.** A `signal` that isn't a native `AbortSignal` rejects the `respond` method with a `ContractError` before the request is appended, and the ledger stays free for a later request.
- **Only the seed forms the tail.** Only the messages added before the first request form the seed tail, so an application message added after the first request reaches a planned prompt only through the records or the `recall` tool.
- **Records don't retire.** No age or request count retires a message: it leaves the records only when a later message supersedes it, a later finding of the same lookup replaces it, or a later answer files it quiet. Only the plan decides which of its lines a request copy shows.
- **The ledger refuses no over-window prompt.** A request, a lookup result, the pass's own turns, the answer note, or the whole view a faulted selection builds from reaches the provider whole when it's larger than the room the `capacity` option leaves, and the provider's own context limit decides what happens to it.
- **A memo written between passes enters unpriced.** A memo written during a request's first pass, by a lookup or a host tool, enters the answer pass's context message unpriced: the plan prices the head the first pass sends, and the answer pass rebuilds the context message from the managers as they read then, so the system, tail, and request positions stay byte-identical and the context message can change.
- **A heading inside a record line reads as one.** A record line and the request copy render a message's or a lookup's text verbatim, so text holding a `## Rules` or `## Request` heading reads as one inside the user turn's copy; it changes no filing and never reaches `system`, and no delimiter marks such text.
- **A lookup is a read.** A ledger lookup is a read; a tool whose call has a consequence is not a lookup, and a ledger refuses a `consequential` lookup at every call. `LedgerAgentOptions` carries no `authority`, so such a lookup meets the default `Authority` floor with no approver and is denied as unanswered.
- **A snapshot's judgments are frozen records.** `LedgerInterface.snapshot().conversation` carries the stored deep-frozen judgments, so a write to one throws `TypeError` in strict-mode code, and a host copies a record through `copyJSON` before it migrates or redacts it.
- **A snapshot carries no gauge observations.** The `gauge` member of a snapshot holds the scale and the overhead cost alone. A hydrated ledger has observed no reply and no earlier request, so until it completes a request of its own, the `recall` tool sizes its room and applies its close rule as a ledger that has served nothing does, and a `recall` call can list a different number of items than the same call on the ledger that took the snapshot.
- **A hydrated ledger asks a held question again.** A snapshot doesn't carry the questions the classifier held after a refused question or a deterministic judge failure, so a ledger hydrated from it asks each of them again in its next request.
- **A snapshot survives a store that sorts keys.** A judgment matches by JSON value, so a `DatabaseConversationStore` column that returns keys in another order, a binary JSON column included, keeps every memoized judgment. A structured `state` compares by its JSON text, key order included, so pass the same key order on each resolve or render it to a string first. A restored answer keeps the probability order its store returned, so `measureAnswer` can name another winner on an exact tie; the `category` method of the `Classifier` class walks `LEDGER_CATEGORIES`, so a ledger's filing doesn't depend on that order. A restored lookup call's arguments render in the order the column returns them, so a records line, an item the `recall` tool lists, a lookup stub in the tail, and the provider request can differ in bytes from the ones the original run sent, and a stub's `hidden` form can tell the model to recall with another string argument, because it names the first string in that order. A restored message object keeps the member order its column returned, so a provider whose encode passes `request.messages` through by spread sends those members in that order; the relay projection and the judge requests fix their member order. `matchesJSON` is bounded to JSON data and promises nothing for a cycle, a `toJSON` object, `NaN`, an infinity, or an `undefined`, function, symbol, or hole inside a list.
- **The `narrow` member can hide a supersession.** The ledger never compares an earlier message that shares only a desk topic with the correction, so a supersession on a pair sharing no registry entity and no id or number is never filed. For example, "the refund limit is 500" then "no, the refund limit is 600" shares no literal, so with no shared registry entity `narrow` never asks about that pair, where the unset rule does.
- **Nothing caps a correction's pair questions.** A correction's pair questions grow with its eligible earlier messages. At the 290-message correction of the recording under **The filing.**, one correction asked 98 pair questions over 93 earlier messages, inside 109 judge calls and 196 s on the Mica v0.1 4B judge. The `narrow` member lowers them, and the caller's abort signal ends them.

### Customizing the format (the cascade)

Each context section frames as `[open, ...items.map(render), close]` — a top line rendered once before the items, each item's text, and a bottom line rendered once after — with empty / absent slots dropped and the survivors blank-line (`\n\n`) joined. The instruction manager resolves each slot independently through a cascade, most-specific-first; each level is optional, what you omit falls through to the next, and omitting everything leaves each section on its manager's built-in framing — only the header and the items, with no closing line. From most to least specific:

1. **Item override** — `override?: string` on a single `InstructionInput`: a fully-rendered string for that item, round-tripped onto the stored entity. Beats every other level for that item's `render`.
2. **Manager-options override** — `format?: ContextSectionFormat<…>` on `InstructionManagerOptions` (an `{ open?; render?; close? }` trio): a per-section open / item-render / close override for that whole manager. Beats the built-in.
3. **Built-in** — the manager's `## Instructions` header and each item's content — the floor for `open` and `render`. There is no built-in `close`: an unset `close` yields no closing line.

The manager applies all three levels itself, so `context.build()` reads its `open`, `render(item)`, and `close` as given. For a manager whose options carry the format `O`: **open** = `O.open ?? '## Instructions'` (manager-options > built-in — the leading text has no per-item level); **per item** `I` = `I.override ?? O.render?.(I) ?? I.content` (item > manager-options > built-in); **close** = `O.close` (manager-options only, no built-in ⇒ no closing line when unset). `open`, the rendering, and `close` resolve independently, so an override can set only the open, only the rendering, only the close, or any mix — and `open` + `close` together wrap the whole group. (The `## Workspace` text section has no cascade level of its own — it renders with the fixed `renderFencedFile` framing.)

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
	override: '<rule priority="high">Escalate.</rule>',
})

context.build()
// system block instructions section (the group wrapped by open + close):
//   '<rules>\n\n<rule>Be terse.</rule>\n\n<rule priority="high">Escalate.</rule>\n\n</rules>'
```

When a provider's model has a framing preference, such as XML tags, install that framing as the manager-options `format` on the agent's instruction manager (`createAgent(provider, { instructions: createInstructionManager({ format }) })`). A provider carries no framing of its own, so the request it receives depends only on the agent's context.

### The HTTP provider engine

A provider decides how message text reaches its model. Agent neutralizes no model control token in any message, so a provider that renders messages into one prompt owes that escape, and a host that loads text into `system` must author that text. The `@orkestrel/ollama` provider through 0.0.28 escapes none, so a listed token inside any message reaches Ollama's renderer as the real token.

`ProviderInterface` is the boundary; `AgentProvider` is the engine behind it. Every HTTP-backed provider needs the same machinery — a deadline, a transport, an authorization hook, a bounded error read, a chunk decoder, reasoning separation, and result assembly — and rewriting that per vendor is how a fleet of providers drifts apart. `AgentProvider` owns all of it and leaves exactly one thing open: the wire. A subclass supplies `name` and the wire seams — `frame()` returns fresh framing state for the call, `encode(request)` projects a `ProviderRequest` onto the vendor's request shape, `read(record)` decodes one framed record into a `ProviderIncrement`, and `finish(parser)` returns whatever the parser still held at end of input. The engine is generic over `TRecord`: the record type a call's `frame()` parser emits and `read` consumes, defaulting to `Readonly<Record<string, unknown>>` for a wire whose records are JSON objects. The constructor switches decide the rest: `split` separates in-content `<think>` reasoning from the answer (default `true`), and `strict` requires the wire to carry a settled `result` record rather than assembling one at end of input (default `false`).

```ts
import type { AgentProviderInput, ProviderInterface } from '@orkestrel/agent'
import { createAbort } from '@orkestrel/abort'

declare function createTextProvider(options: AgentProviderInput): ProviderInterface
declare function token(signal: AbortSignal): Promise<string>
const abort = createAbort()
const messages = [{ id: '1', role: 'user', content: 'Say hello.' }] as const

const provider = createTextProvider({
	url: 'https://api.example',
	path: '/generate', // appended to `url` on every call
	timeout: 30_000, // the base's own deadline; DEFAULT_PROVIDER_TIMEOUT when omitted
	headers: async (signal) => ({ authorization: await token(signal) }), // awaited inside that deadline
	split: true, // route <think> spans to `thinking`, yield the clean answer
	strict: false, // assemble at end of input instead of requiring a settled record
})
const result = await provider.generate(messages, abort.signal)
result.content // the assembled answer, with any <think> span routed to result.thinking
```

`AgentProvider` is `abstract`; the members a subclass fills are listed under [`## Methods`](#methods).

The engine's failures arrive as one error class. A `ProviderError` carries a machine-readable `code` and, for an HTTP failure alone, the response `status`; `isProviderError` narrows a caught value so a caller can branch on the code:

- `'HTTP'` — a non-OK response. The message is `provider error: <status>`, with ` - <excerpt>` appended only when the response body carried text. The excerpt is read to at most `MAX_ERROR_BODY_LENGTH` bytes and the remainder of the body is cancelled, so a stalled error body can't hold the call open past its deadline.
- `'PROTOCOL'` — a successful response with no body, a line the provider's framing refuses, a wire record the concrete provider refuses, or a `strict` stream that ended without a settled result. A throw from a provider's framing seam (its parser's `parse` or the provider's `finish`) that races no cancel and is not already a `ProviderError` or `ProviderAbortError` rejects with this code and carries that throw as its `cause`.
- `'PROVIDER'` — an upstream failure a relay reported in an `error` frame.

A cancel isn't in that taxonomy: the call's own deadline and the caller's signal are folded into one bound, and a cancel throws `ProviderAbortError` carrying the partial assembled so far.

### Recording and replaying thinking

A thinking model's reasoning arrives as `ProviderResult.thinking`, apart from the answer in `content`. The agent loop records each call's non-empty thinking as the `thinking` member of the assistant message that call appends, on a tool-call turn and on the final answer alike. The joined `AgentResult.thinking` also includes thinking from calls that appended no message, such as an aborted call. Only recorded thinking can return to a provider. Thinking stays out of `content`, the selection state a judge reads, a ledger's records, and a section summary. Compaction removes thinking before calling the summarizer and retains it on the section's original messages.

The provider's `replay` member decides which recorded thinking goes back to the model. Set it through the `replay` option of `ProviderOptions`, which `AgentProviderInput` and `RelayProviderOptions` extend, or declare it on a `ProviderInterface` you write. A `ThinkingReplay` value is one of the following:

- `'none'` sends no thinking. It is the default. Under it, the agent loop and a relay send the same messages they would send if no thinking were recorded; a ledger still reads recorded thinking to measure what a call left.
- `'turn'` sends the thinking of the assistant messages after the last `user` message, the turn in progress, and drops the rest.
- `'all'` sends the thinking of every assistant message.

Choose `'turn'` for a backend that reads thinking inside a tool loop. Some chat formats keep the thinking of the turn in progress and drop older thinking, such as the Qwen3 template (see [the Qwen3 model card](https://huggingface.co/Qwen/Qwen3-235B-A22B)), and some APIs refuse a tool turn that leaves out its thinking, such as DeepSeek's (see [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)). The `thinking` member is a plain string, so it can't carry a signature that an API requires beside the text, such as Anthropic's (see [Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)).

The agent loop, a relay server, and a ledger apply the policy before calling the provider. A direct `generate` or `stream` call sends messages as given. The agent applies the policy through `stripThinking` before every provider call and before every compaction estimate, and a provider without a `replay` member counts as `'none'`. `estimateRequest` counts a message's `thinking`, so the `window` budget counts the thinking the request carries and no other. A ledger applies the same policy to the tail it plans and each call it measures, and calibration applies the policy at the next user boundary, as if a user message followed the conversation view. Calibration prices the whole view; a planned request carries only the selected tail, so the retained messages can differ.

A relay applies both policies. The agent in the browser strips the request by the policy of its `RelayProvider`, the request carries each remaining `thinking` member, and `RelayStream` strips it again by the upstream provider's policy, so the upstream call carries only the thinking that both policies keep.

The following fence applies two policies to a conversation whose second request is in a tool turn:

```ts
import type { Message } from '@orkestrel/agent'
import { stripThinking } from '@orkestrel/agent'

const messages: readonly Message[] = [
	{ id: '1', role: 'user', content: 'Is order BW-5512 refundable?' },
	{
		id: '2',
		role: 'assistant',
		content: 'Yes, within 30 days.',
		thinking: 'The window is 30 days.',
	},
	{ id: '3', role: 'user', content: 'Refund it.' },
	{
		id: '4',
		role: 'assistant',
		content: '',
		calls: [{ id: 'call-1', name: 'refund_order', arguments: { id: 'BW-5512' } }],
		thinking: 'Refund through the order tool.',
	},
	{ id: '5', role: 'tool', call: 'call-1', content: 'Refunded $148.50.' },
]

const none = stripThinking(messages, 'none')
const turn = stripThinking(messages, 'turn')
none.filter((message) => 'thinking' in message).length // 0 — no thinking goes back
turn.filter((message) => 'thinking' in message).map(({ id }) => id) // ['4'] — the turn in progress
```

### The judge engine

The `JudgeInterface` contract is the decision boundary beside `ProviderInterface`, and it is never a provider. Its `ask(request, signal)` method answers typed questions about one state with a probability distribution per question. A `JudgeRequest` carries the `state` and the `questions` keyed by your own ids, which the prompt never carries; each question is a `ChoiceQuestion`, a `ScoreQuestion`, or a `NoulQuestion`, named by its `form` member. A `JudgeResult` carries the answering model in its `model` member, the `answers` map keyed by the same ids, the `refusals` map of the questions a wire refused, and the `usage` member with the tokens the calls spent. An answer stores only the distribution the server returned: `probabilities` for a choice or a score, and `noul`, the probability of yes, for a noul question. The `measureAnswer` function derives every measure from that distribution, so every server reads on one scale and no stored measure can drift from its distribution (the derived-measure clause).

The `AgentJudge` class is the engine behind that boundary, as the `AgentProvider` class is the engine behind `ProviderInterface`. It owns each call's deadline, the transport, the `headers` hook, the validation before inference, the bounded error read, and the merge of every call's result, and it leaves the wire open: a subclass supplies `name`, `encode(request)`, which projects one call's `JudgeRequest` onto the protocol's request shape, and `read(value, request)`, which decodes one call's parsed response into a `JudgeResult`. A one-shot JSON response has no framing state and no buffered tail, so the engine has no `frame` or `finish` seam. In place of the `split` and `strict` switches it takes one `batch` switch: `true`, the default, sends every question in one call, and `false` sends one call per question in key order.

The `SystemOneJudge` class is the wire this package ships on that engine, and the `createSystemOneJudge` factory returns it behind `JudgeInterface`. It speaks the System One decision protocol at `SYSTEM_ONE_PATH` and sends every question in one call. See [Asking a System One server a choice, a noul, and a score](#asking-a-system-one-server-a-choice-a-noul-and-a-score) for the servers it serves and a whole request; see [Writing a judge wire](#writing-a-judge-wire) for a wire of your own.

The engine's failures arrive as one error class. A `JudgeError` carries a machine-readable `code` and, for an HTTP failure alone, the response `status`; the `isJudgeError` function narrows a caught value so a caller can branch on the code:

- `'QUESTION'` — a request refused before inference: an empty question map, a malformed question named by its id, a state that isn't a `JudgeEntry`, or a request a wire's `encode` method refuses. No call is made.
- `'HTTP'` — a non-OK response. The message is `judge error: <status>`, with ` - <excerpt>` appended only when the response body carried text, read to at most `MAX_ERROR_BODY_LENGTH` bytes.
- `'PROTOCOL'` — a successful response with no body or with a body that isn't JSON, or a response the wire can't read.

A cancel isn't in that taxonomy: it throws `JudgeAbortError`, whose `partial` merges the calls that completed before the cancel, and the `isJudgeAbortError` function narrows a caught value to it (the abort-partial clause).

### The relay

In the page-to-Node placement, the page owns `Agent`, `RelayProvider`, and the handlers of its tool registry; the relay forwards a page tool definition only when the server declares it or `tools.accept` admits it. Node owns the `createRelay` handler and upstream provider. The hop carries inference requests and replies; a tool handler executes where its registry lives. The Chromium receipt is planned in the `@orkestrel/mcp` distribution proof named under [Placement proofs](#placement-proofs) and isn't recorded here as passed.

A browser must not hold a model credential, so this package ships the hop rather than the credential. `createRelay` returns a `RelayHandler` — a plain `(request: Request) => Promise<Response>` you mount on any fetch-standard router — that authorizes the request, validates its JSON body against `providerRequestContract`, refuses a page `system` message and an undeclared tool definition unless `RelayOptions` admits them, and streams one upstream `provider.stream` call back as newline-delimited `RelayFrame` records under `RELAY_CONTENT_TYPE`. `createRelayProvider` is the other end: a `ProviderInterface` the browser drives exactly like a local one, which posts the request and decodes those frames back into deltas and the settled result. `RelayStream` is the response half `createRelay` composes, exported for a host that mounts its own route.

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createRelay, createRelayProvider } from '@orkestrel/agent'

declare const upstream: ProviderInterface // the server-side provider holding the credential

// On the server: the route, the authorization decision, and the byte budget.
const handler = createRelay({
	provider: upstream,
	authorize: (request) => request.headers.get('authorization') === 'Bearer session-token',
	limit: 65_536, // a body at or above this answers 413
})

// In the browser: a provider like any other, reached over that route.
const browser = createRelayProvider({
	url: 'https://app.example/relay',
	headers: () => ({ authorization: 'Bearer session-token' }),
})
```

The frame vocabulary is `RelayFrame`: a `ProviderDelta` (`content` or `thinking`) per streamed delta, one `{ channel: 'result', result }` when the turn settles, `{ channel: 'abort', partial }` when the upstream call was cancelled, and `{ channel: 'error', message }` for anything else — always the fixed `RELAY_PROVIDER_MESSAGE` text, so an upstream failure's own message never reaches the browser. A refusal never becomes a frame: the handler answers `401` when `authorize` refuses or throws, `400` when the body is missing, unreadable, or rejected by the contract, `413` when the body reaches the byte limit, `422` when the relay's policy refuses a page `system` message or tool definition, and `502` when the upstream call can't be constructed. The `422` alone carries a body, one `text/plain` line per refused member; every other refusal carries no body. Each refusal reaches the browser as a `ProviderError` with the `HTTP` code and that status.

The wire is strictly narrower than the domain on purpose. `providerRequestContract` and `relayFrameContract` are compiled from the shapes listed under [Providers module](#providers-module), and `RelayProvider.encode` refuses a request the JSON wire can't carry — a function-valued tool argument, a parameter schema holding one — before it fetches. The body it sends is an owned snapshot of that projection read through property descriptors, so a serializer reachable only through a `get` trap or a prototype is never consulted; an own function-valued property such as a `toJSON` method is a value outside JSON and is refused before fetching, with the clone's failure as the refusal's `cause`. A `ToolContext` stays with local execution; the call envelope carries only `id`, `name`, and `arguments`.

### Root module

The root holds the package's shared vocabulary: the message and judge value types, the role list, the judge abort error, the message and tool-call wire shapes with the message contract, and the cloner, helpers, and guards that more than one module reads.

Each module section lists its exports by kind file. Each guard reads an `unknown`, returns `false` off-shape, and never throws, and an error guard stays in its module's Errors table beside the error it narrows.

#### Types

The following table lists the types the root declares:

| Name                | Kind      | Signature                                                                           | Summary                                                                                                                                                                                                                                                                             |
| ------------------- | --------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MessageRole`       | type      | `(typeof MESSAGE_ROLES)[number]`                                                    | Names the role a `Message` plays in a conversation turn.                                                                                                                                                                                                                            |
| `ConversationRole`  | type      | `(typeof CONVERSATION_ROLES)[number]`                                               | Names the role a stored conversation message plays: any `MessageRole` except `system`.                                                                                                                                                                                              |
| `ThinkingReplay`    | type      | `'none' \| 'turn' \| 'all'`                                                         | Names which thinking the agent loop, a relay server, and a ledger retain before calling a provider: `'none'` retains none, `'turn'` retains thinking after the last `user` message, and `'all'` retains all thinking. A direct `generate` or `stream` call sends messages as given. |
| `Message`           | interface | `{ id, role, content, calls?, call?, images?, thinking? }`                          | Represents one conversation turn fed to a `ProviderInterface` — a stored, identified message.                                                                                                                                                                                       |
| `MessageInput`      | interface | `{ role, content, calls?, call?, images?, thinking? }`                              | Carries the minimal data needed to author a `Message` — the `id` is assigned by the layer that stores it, so a caller supplies only role / content (and, for a replayed assistant turn, its `calls`; for a tool turn, the `call` it answers).                                       |
| `JudgeEntry`        | type      | `string \| JSONRecord \| readonly JSONValue[]`                                      | Carries text or structured JSON the model reads; mirrors the TypeSafe `EntryType` without its null arm.                                                                                                                                                                             |
| `ChoiceCriteria`    | type      | `Readonly<Record<string, JudgeEntry \| null>>`                                      | Maps each option name the model receives to its description; null keeps an undescribed option in the map.                                                                                                                                                                           |
| `ScoreCriteria`     | type      | `readonly [ JudgeEntry \| null, JudgeEntry \| null, ...Array<JudgeEntry \| null> ]` | Lists at least 2 score levels from level 0 upward; null leaves a level undescribed.                                                                                                                                                                                                 |
| `NoulCriteria`      | interface | `{ true?, false? }`                                                                 | Carries what makes a noul answer true and what makes it false; an omitted side is undescribed.                                                                                                                                                                                      |
| `ChoiceQuestion`    | interface | `{ form, instructions?, criteria }`                                                 | Asks the model to pick one named option from its criteria.                                                                                                                                                                                                                          |
| `ScoreQuestion`     | interface | `{ form, instructions?, criteria }`                                                 | Asks the model to place the state on an ordered scale of levels.                                                                                                                                                                                                                    |
| `NoulQuestion`      | interface | `{ form, instructions?, criteria? }`                                                | Asks the model whether a statement about the state holds.                                                                                                                                                                                                                           |
| `JudgeQuestion`     | type      | `ChoiceQuestion \| ScoreQuestion \| NoulQuestion`                                   | Names one question by its form, the protocol's type field under the fleet's named discriminant.                                                                                                                                                                                     |
| `JudgeRequest`      | interface | `{ state, questions }`                                                              | Carries one state and the questions asked about it, keyed by caller ids the prompt never carries; each question is evaluated on its own.                                                                                                                                            |
| `ChoiceAnswer`      | interface | `{ form, probabilities }`                                                           | Carries a choice distribution keyed by option name, in criteria order for a fresh answer; a restored record keeps the order its store returned.                                                                                                                                     |
| `ScoreAnswer`       | interface | `{ form, probabilities }`                                                           | Carries a score distribution indexed by level.                                                                                                                                                                                                                                      |
| `NoulAnswer`        | interface | `{ form, noul }`                                                                    | Carries the probability that the answer is yes; the protocol's noul field.                                                                                                                                                                                                          |
| `JudgeAnswer`       | type      | `ChoiceAnswer \| ScoreAnswer \| NoulAnswer`                                         | Names one answer by its form; it stores only the distribution a server returned.                                                                                                                                                                                                    |
| `Refusal`           | interface | `{ missing }`                                                                       | Reports a question a wire could not read a candidate for; it lists the caller's keys and invents no probability.                                                                                                                                                                    |
| `JudgeResult`       | interface | `{ model, answers, refusals?, usage? }`                                             | Carries the answering model, the answers keyed by question id, the refusals, and the usage the request's calls spent.                                                                                                                                                               |
| `JudgeInterface`    | interface | `{ id, name, model, ask() }`                                                        | Answers typed questions about one state with probabilities; the sibling of `ProviderInterface`, never a provider.                                                                                                                                                                   |
| `Judgment`          | interface | `{ id, question, answer?, refusal?, model, sources, state, time, usage? }`          | Records an answered or refused question with its sources, state, model, and storage time.                                                                                                                                                                                           |
| `JudgmentInput`     | interface | `{ id, question, answer?, refusal?, model, sources, state, usage? }`                | Supplies an answered or refused question for storage before its time is stamped.                                                                                                                                                                                                    |
| `CodedErrorOptions` | interface | `{ cause?, context? }`                                                              | Carries the optional cause and context an error class with a machine-readable `code` takes at construction.                                                                                                                                                                         |
| `LiteralSet`        | interface | `{ ids, numbers }`                                                                  | Holds the ids and numbers one text carries.                                                                                                                                                                                                                                         |

#### Constants

The following table lists the constants the root declares:

| Name                 | Kind  | Signature                                          | Summary                                                                                                                                                                                                                                                                  |
| -------------------- | ----- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MESSAGE_ROLES`      | const | `readonly ["system", "user", "assistant", "tool"]` | Lists the roles any message can play, the built `system` head included, in the order the wire contract names them — the one list the `MessageRole` union derives from, the message guard tests membership against, and the message shape passes to its literal contract. |
| `CONVERSATION_ROLES` | const | `readonly ["user", "assistant", "tool"]`           | Lists the roles a stored conversation message can play: every `MESSAGE_ROLES` member except `system`, in wire order — the one list the `ConversationRole` union derives from and a conversation checks each stored or selected role against.                             |

#### Errors

The following table lists the errors the root declares and the guards that narrow them:

| Name                | Kind     | Signature                                                               | Summary                                                                                                                                                                                             |
| ------------------- | -------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JudgeAbortError`   | class    | `new (partial: JudgeResult, options?: ErrorOptions) => JudgeAbortError` | Reports a judge call cancelled by the caller's signal or its deadline, carrying the `JudgeResult` merged from the calls that completed before the cancel and the machine-readable `code` `'ABORT'`. |
| `isJudgeAbortError` | function | `(value: unknown) => value is JudgeAbortError`                          | Narrows a caught value to a `JudgeAbortError` through its identity brand and declared members, so a `catch` can recover its `partial` result.                                                       |

#### Shapes and contracts

The following table lists the root wire shapes and the contract compiled from them:

| Name              | Kind  | Signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Summary                                                                                                                                                          |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolCallShape`   | const | `import("@orkestrel/contract").ObjectShape<{ id: import("@orkestrel/contract").StringShape; name: import("@orkestrel/contract").StringShape; arguments: import("@orkestrel/contract").ObjectShape<Record<never, never>, import("@orkestrel/contract").JSONShape>; }, boolean \| ContractShape>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Describes a tool call's JSON wire projection.                                                                                                                    |
| `messageShape`    | const | `import("@orkestrel/contract").ObjectShape<{ id: import("@orkestrel/contract").StringShape; role: import("@orkestrel/contract").LiteralShape<readonly ["system", "user", "assistant", "tool"]>; content: import("@orkestrel/contract").StringShape; calls: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ArrayShape<import("@orkestrel/contract").ObjectShape<{ id: import("@orkestrel/contract").StringShape; name: import("@orkestrel/contract").StringShape; arguments: import("@orkestrel/contract").ObjectShape<Record<never, never>, import("@orkestrel/contract").JSONShape>; }, boolean \| ContractShape>>>; call: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; images: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ArrayShape<import("@orkestrel/contract").StringShape>>; thinking: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; }, boolean \| ContractShape>` | Describes a conversation message's JSON wire projection.                                                                                                         |
| `tokenUsageShape` | const | `import("@orkestrel/contract").ObjectShape<{ prompt: import("@orkestrel/contract").NumberShape; completion: import("@orkestrel/contract").NumberShape; total: import("@orkestrel/contract").NumberShape; }, boolean \| ContractShape>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Describes a token usage record's JSON wire projection — its `prompt`, `completion`, and `total` counts, shared by the provider result and the agent frame wires. |
| `messageContract` | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ id: string; role: "assistant" \| "system" \| "tool" \| "user"; content: string; } & { calls?: readonly Readonly<{ id: string; name: string; arguments: { readonly [k: string]: import("@orkestrel/contract").JSONValue; }; } & {}>[]; call?: string; images?: readonly string[]; thinking?: string; }>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Validates and projects conversation messages at a JSON wire boundary.                                                                                            |

#### Cloners

The following table lists the cloners the root declares:

| Name         | Kind     | Signature                     | Summary                                                                                                  |
| ------------ | -------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `copyJSON`   | function | `(value: unknown) => unknown` | Owns a value by serializing it to JSON and parsing the text, so the copy shares nothing with its source. |
| `freezeJSON` | function | `(value: unknown) => unknown` | Owns a value through JSON and freezes every record and list of the copy, leaving the value unchanged.    |

#### Helpers

The following table lists the helpers the root declares:

| Name                | Kind     | Signature                                                                                                            | Summary                                                                                                                                                                                                                                                                                                                        |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `filterAllowList`   | function | `<T>(allow: readonly string[] \| undefined, members: readonly T[], key: (member: T) => string) => readonly T[]`      | Filters a list of members by a `ScopeInterface` allow-list of keys — `undefined` passes everything, `[]` passes nothing, and a non-empty list passes the listed keys alone, order preserved. The pure, total set-membership primitive the context's build step and the agent loop's tool-advertise step apply a scope through. |
| `sanitizeToken`     | function | `(value: number) => number`                                                                                          | Sanitizes one reported token count into a non-negative integer — a non-finite or non-positive value becomes `0`, and a positive fractional value floors down.                                                                                                                                                                  |
| `sanitizeUsage`     | function | `(usage: TokenUsage) => TokenUsage`                                                                                  | Sanitizes a `TokenUsage` into non-negative integers — the guard an agent's abort-usage path applies to a provider's partial usage before it is charged against a budget or folded into the run total.                                                                                                                          |
| `joinThinking`      | function | `(prior: string \| undefined, next: string) => string`                                                               | Joins the reasoning a run's provider calls separated from the answer — the first call seeds the accumulation, a later call appends blank-line separated so each turn's reasoning stays readable.                                                                                                                               |
| `stripThinking`     | function | `(messages: readonly Message[], replay: ThinkingReplay) => readonly Message[]`                                       | Applies a `ThinkingReplay` policy to a conversation, returning the messages a provider sends with only the assistant thinking the policy allows.                                                                                                                                                                               |
| `sumUsage`          | function | `(prior: TokenUsage \| undefined, next: TokenUsage) => TokenUsage`                                                   | Adds two `TokenUsage` values field by field — the running total an agent run keeps across its provider calls.                                                                                                                                                                                                                  |
| `removeEntries`     | function | `<K>(keys: readonly K[], remove: (key: K) => boolean) => boolean`                                                    | Removes each key through a single-key remover and folds the outcomes, so a batch `remove` reports whether the whole batch applied.                                                                                                                                                                                             |
| `collectExchanges`  | function | `(messages: readonly Message[]) => ReadonlyArray<readonly Message[]>`                                                | Collects whole exchanges, joining every exchange spanned by a tool group.                                                                                                                                                                                                                                                      |
| `collectToolGroups` | function | `(messages: readonly Message[]) => ReadonlyArray<readonly Message[]>`                                                | Collects each assistant message that carries calls together with the tool messages that answer it, then each run of tool messages that no assistant message owns.                                                                                                                                                              |
| `hasCalls`          | function | `(message: Pick<Message, 'calls'>) => boolean`                                                                       | Checks whether a message carries at least one tool call.                                                                                                                                                                                                                                                                       |
| `renderJSON`        | function | `(value: unknown) => string \| undefined`                                                                            | Renders a value as the JSON text `JSON.stringify` produces, or `undefined` when JSON cannot carry the value.                                                                                                                                                                                                                   |
| `matchesJSON`       | function | `(left: unknown, right: unknown) => boolean`                                                                         | Matches two values of JSON data by JSON value, whatever their key order, and reads a value with no JSON text as no match.                                                                                                                                                                                                      |
| `matchesJudgment`   | function | `(judgment: Judgment, question: JudgeQuestion, sources: readonly string[], state: string, model: string) => boolean` | Matches a recorded question by JSON value, the ordered sources, the rendered state, and the judge identity.                                                                                                                                                                                                                    |
| `extractLiterals`   | function | `(text: string) => LiteralSet`                                                                                       | Reads the ids and the numbers of a text.                                                                                                                                                                                                                                                                                       |

#### Validators

The following table lists the guards the root declares:

| Name                       | Kind     | Signature                                    | Summary                                                                                    |
| -------------------------- | -------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `isJudgeEntry`             | function | `(value: unknown) => value is JudgeEntry`    | Checks whether a value is a judge entry: a string, a JSON record, or a JSON array.         |
| `isJudgeQuestion`          | function | `(value: unknown) => value is JudgeQuestion` | Checks whether a value is a well-formed judge question of the choice, score, or noul form. |
| `isNonNegativeSafeInteger` | function | `(value: unknown) => value is number`        | Checks whether a value is a non-negative safe integer, `-0` included.                      |

### Providers module

The `providers` module holds the inference boundary and its HTTP engine, the relay, the reasoning splitter, and the judge engine with the System One wire.

#### Types

The following table lists the types the providers module declares:

| Name                      | Kind      | Signature                                                                                                                                                                                                           | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ProviderResult`          | interface | `{ content, thinking?, tools?, usage?, truncated? }`                                                                                                                                                                | Holds a single inference turn's structured outcome — the assembled assistant content, any reasoning the provider separated from it, any tool calls the model requested, and the token usage it reported.                                                                                                                                                                                                                                                     |
| `ProviderDelta`           | type      | `{ readonly channel: 'content'; readonly text: string; } \| { readonly channel: 'thinking'; readonly text: string; }`                                                                                               | Represents one streamed delta the `stream` method of a `ProviderInterface` yields — a unit tagged by the channel it belongs to, so the agent loop can forward answer content and live reasoning separately as each delta arrives.                                                                                                                                                                                                                            |
| `ProviderStreamOptions`   | interface | `{ think?, schema? }`                                                                                                                                                                                               | Carries the per-call options threaded into the `generate` and `stream` methods of a `ProviderInterface` — the bag a caller passes to influence one inference call without reconfiguring the provider instance.                                                                                                                                                                                                                                               |
| `ProviderInterface`       | interface | `{ id, name, replay?, generate(), stream() }`                                                                                                                                                                       | Defines the pluggable LLM inference boundary — the one contract every agent chunk depends on. A provider turns a conversation (plus optional tools) into either a single assembled `ProviderResult` (`generate`) or a stream of `ProviderDelta` values that returns the assembled result (`stream`). The agent loop, a relay server, and a ledger apply its `replay` policy before calling it. A direct `generate` or `stream` call sends messages as given. |
| `ProviderParserInterface` | interface | `{ parse(), clear() }`                                                                                                                                                                                              | Defines the structural framing seam supplied by a concrete provider.                                                                                                                                                                                                                                                                                                                                                                                         |
| `ProviderRequest`         | interface | `{ messages, tools?, options? }`                                                                                                                                                                                    | Carries the conversation and per-call configuration sent to a provider.                                                                                                                                                                                                                                                                                                                                                                                      |
| `ProviderIncrement`       | interface | `{ content, thinking, tools, usage?, truncated?, result? }`                                                                                                                                                         | Holds the decoded contribution of a wire record to a provider turn.                                                                                                                                                                                                                                                                                                                                                                                          |
| `ProviderOptions`         | interface | `{ timeout?, replay?, fetch?, headers? }`                                                                                                                                                                           | Configures a provider's deadline, transport, and headers.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AgentProviderInput`      | interface | `{ url, path?, split?, strict? }`                                                                                                                                                                                   | Configures the HTTP destination and stream assembly of a provider base.                                                                                                                                                                                                                                                                                                                                                                                      |
| `AgentProviderInterface`  | interface | `{ frame(), encode(), read(), finish() }`                                                                                                                                                                           | Defines the wire-specific seams of the shared HTTP provider engine.                                                                                                                                                                                                                                                                                                                                                                                          |
| `ProviderErrorCode`       | type      | `'HTTP' \| 'PROTOCOL' \| 'PROVIDER'`                                                                                                                                                                                | Names the machine-readable provider failure conditions.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ProviderErrorOptions`    | interface | `{ status?, cause? }`                                                                                                                                                                                               | Carries a provider failure's HTTP status and underlying cause.                                                                                                                                                                                                                                                                                                                                                                                               |
| `FailureRead`             | interface | `{ message, status, cause? }`                                                                                                                                                                                       | Carries an HTTP failure message, the response status, and the underlying body-read cause when available.                                                                                                                                                                                                                                                                                                                                                     |
| `TextRead`                | interface | `{ text, complete }`                                                                                                                                                                                                | Carries a decoded stream prefix and whether the stream ended within its byte budget.                                                                                                                                                                                                                                                                                                                                                                         |
| `RelayFrame`              | type      | `ProviderDelta \| { readonly channel: 'result'; readonly result: ProviderResult; } \| { readonly channel: 'abort'; readonly partial: ProviderResult; } \| { readonly channel: 'error'; readonly message: string; }` | Carries a relay delta, settled result, remote abort, or remote failure.                                                                                                                                                                                                                                                                                                                                                                                      |
| `RelayHandler`            | type      | `(request: Request) => Promise<Response>`                                                                                                                                                                           | Defines a host-independent relay request handler.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `RelaySystemOptions`      | interface | `{ text?, accept? }`                                                                                                                                                                                                | Configures who writes the system turn a relay forwards.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `RelayToolOptions`        | interface | `{ definitions?, accept? }`                                                                                                                                                                                         | Configures which tool definitions a relay forwards.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RelayOptions`            | interface | `{ provider, authorize, limit?, system?, tools? }`                                                                                                                                                                  | Configures the upstream provider, mandatory authorization, request byte limit, and request head policy.                                                                                                                                                                                                                                                                                                                                                      |
| `RelayRefusalReason`      | type      | `'system' \| 'head' \| 'tool' \| 'mismatch'`                                                                                                                                                                        | Names why a relay refuses a request member.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `RelayRefusal`            | interface | `{ reason, index, name? }`                                                                                                                                                                                          | Carries one refused request member and where it sits.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RelayProviderOptions`    | interface | `{ url, parser? }`                                                                                                                                                                                                  | Configures a relay destination and an optional fresh parser factory.                                                                                                                                                                                                                                                                                                                                                                                         |
| `RelayStreamOptions`      | interface | `{ provider, request, signal }`                                                                                                                                                                                     | Carries the upstream call and cancellation bound of a relay response stream.                                                                                                                                                                                                                                                                                                                                                                                 |
| `ThinkSplitterInterface`  | interface | `{ content, thinking, split(), flush() }`                                                                                                                                                                           | Splits a thinking model's in-content `<think>…</think>` reasoning spans away from the answer, delta by delta with per-stream state, so a provider yields clean content alone and surfaces the reasoning as `ProviderResult.thinking`.                                                                                                                                                                                                                        |
| `AgentJudgeInput`         | interface | `{ url, path?, model, batch? }`                                                                                                                                                                                     | Configures the judge engine's destination, identity, and call split.                                                                                                                                                                                                                                                                                                                                                                                         |
| `AgentJudgeInterface`     | interface | `{ encode(), read() }`                                                                                                                                                                                              | Defines the wire seams of the shared judge engine.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `JudgeErrorCode`          | type      | `'HTTP' \| 'PROTOCOL' \| 'QUESTION'`                                                                                                                                                                                | Names the machine-readable judge failure conditions.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `AnswerMeasure`           | interface | `{ winner, probability, confidence, score? }`                                                                                                                                                                       | Carries the measures `measureAnswer` derives from an answer; nothing stores them.                                                                                                                                                                                                                                                                                                                                                                            |
| `SystemOneJudgeOptions`   | interface | `{ url, model }`                                                                                                                                                                                                    | Configures the System One server, model, transport, authentication, and deadline.                                                                                                                                                                                                                                                                                                                                                                            |
| `SystemOneEntry`          | type      | `JudgeEntry \| null`                                                                                                                                                                                                | Carries a TypeSafe System One entry, including the wire's explicit null.                                                                                                                                                                                                                                                                                                                                                                                     |
| `SystemOneQuestion`       | interface | `{ type, instructions?, criteria? }`                                                                                                                                                                                | Transliterates a TypeSafe System One question with its protocol discriminant and criteria.                                                                                                                                                                                                                                                                                                                                                                   |
| `SystemOneRequest`        | interface | `{ state, model, questions }`                                                                                                                                                                                       | Transliterates the TypeSafe System One request body.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SystemOneUsage`          | interface | `{ input_tokens?, output_tokens? }`                                                                                                                                                                                 | Transliterates TypeSafe System One token counts with missing or null counts permitted.                                                                                                                                                                                                                                                                                                                                                                       |
| `SystemOneChoiceAnswer`   | interface | `{ type, probabilities, choice?, confidence? }`                                                                                                                                                                     | Transliterates a TypeSafe System One choice distribution and optional server measures.                                                                                                                                                                                                                                                                                                                                                                       |
| `SystemOneScoreAnswer`    | interface | `{ type, probabilities, score?, legend?, confidence? }`                                                                                                                                                             | Accepts System One score probabilities and legends as maps or llama.cpp arrays.                                                                                                                                                                                                                                                                                                                                                                              |
| `SystemOneNoulAnswer`     | interface | `{ type, noul, confidence? }`                                                                                                                                                                                       | Transliterates a TypeSafe System One yes probability and optional server confidence.                                                                                                                                                                                                                                                                                                                                                                         |
| `SystemOneAnswer`         | type      | `SystemOneChoiceAnswer \| SystemOneScoreAnswer \| SystemOneNoulAnswer`                                                                                                                                              | Unites the TypeSafe System One answer forms.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SystemOneResponse`       | interface | `{ model?, answers, usage? }`                                                                                                                                                                                       | Transliterates the System One response envelope before question-specific answer validation.                                                                                                                                                                                                                                                                                                                                                                  |

#### Constants

The following table lists the constants the providers module declares:

| Name                         | Kind  | Signature                               | Summary                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ----- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `THINK_OPEN`                 | const | `"<think>"`                             | Names the opening tag a `ThinkSplitter` recognizes as the start of an in-content reasoning span — `'<think>'`, the de-facto wire convention thinking models (qwen3, DeepSeek-R1 family) emit their chain-of-thought under when a daemon renders it inline instead of on a separate wire field. Paired with `THINK_CLOSE`. |
| `THINK_CLOSE`                | const | `"</think>"`                            | Names the closing tag that ends a `THINK_OPEN` reasoning span — `'</think>'`. A span the stream never closes (the model was cut off mid-reasoning) is treated as thinking to its end, and `ThinkSplitterInterface.flush` settles it.                                                                                      |
| `DEFAULT_PROVIDER_TIMEOUT`   | const | `120000`                                | Holds the default provider deadline in milliseconds — `120_000`, the wall-clock bound a call runs under when `AgentProviderInput.timeout` is omitted, folded with the caller's signal so whichever trips first cancels the call.                                                                                          |
| `MAX_ERROR_BODY_LENGTH`      | const | `2048`                                  | Bounds the decoded error excerpt's input in bytes — `2048`, the leading bytes of a non-OK response body handed to the decoder before the read cancels the remainder, so a `ProviderError` message never carries a longer excerpt.                                                                                         |
| `DEFAULT_RELAY_LIMIT`        | const | `1048576`                               | Holds the default relay request limit in bytes — `1_048_576`, the byte budget a relay applies to an inbound body when `RelayOptions.limit` is omitted, refusing a body that reaches it.                                                                                                                                   |
| `RELAY_CONTENT_TYPE`         | const | `"application/x-ndjson; charset=utf-8"` | Names the relay's newline-delimited JSON content type — `'application/x-ndjson; charset=utf-8'`, the header a relay response carries beside `cache-control: no-store`.                                                                                                                                                    |
| `RELAY_PROVIDER_MESSAGE`     | const | `"relay provider failed"`               | Names the public message for an unexpected upstream relay failure — `'relay provider failed'`, the fixed text every `error` frame carries, so an upstream failure's own message never reaches the browser.                                                                                                                |
| `UNAUTHORIZED_RELAY_STATUS`  | const | `401`                                   | Names the status a relay answers when the `authorize` callback returns anything but `true` or throws — `401`, carried with no body and reaching the browser as a `ProviderError` with the `HTTP` code.                                                                                                                    |
| `INVALID_RELAY_STATUS`       | const | `400`                                   | Names the status a relay answers for a body that is missing, unreadable, or rejected by `providerRequestContract` — `400`, carried with no body and reaching the browser as a `ProviderError` with the `HTTP` code.                                                                                                       |
| `OVERSIZED_RELAY_STATUS`     | const | `413`                                   | Names the status a relay answers for a request body at or above its byte budget — `413`, carried with no body and answered for an aborted inbound read as well.                                                                                                                                                           |
| `REFUSED_RELAY_STATUS`       | const | `422`                                   | Names the status a relay answers for a page system message or tool definition its policy refuses — `422`, carrying one `REFUSED_RELAY_CONTENT_TYPE` line per refused member and reaching the browser as a `ProviderError` with the `HTTP` code.                                                                           |
| `REFUSED_RELAY_CONTENT_TYPE` | const | `"text/plain; charset=utf-8"`           | Names the content type of a relay's `422` refusal body — `'text/plain; charset=utf-8'`, the header a refusal carries beside `cache-control: no-store`.                                                                                                                                                                    |
| `UPSTREAM_RELAY_STATUS`      | const | `502`                                   | Names the status a relay answers when the upstream provider call cannot be constructed — `502`, carried with no body after `provider.stream` was entered and threw before returning its iterator.                                                                                                                         |
| `SYSTEM_ONE_PATH`            | const | `"/v1/systemone"`                       | Names the System One decision endpoint shared by compatible servers.                                                                                                                                                                                                                                                      |

#### Errors

The following table lists the errors the providers module declares and the guards that narrow them:

| Name                   | Kind     | Signature                                                                                         | Summary                                                                                                                                                                                                                                                  |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProviderAbortError`   | class    | `new (partial: ProviderResult, options?: ErrorOptions) => ProviderAbortError`                     | Reports a provider stream cancelled mid-flight by its bound signal — thrown by the `stream` method of a `ProviderInterface`, carrying the `ProviderResult` assembled from whatever streamed before the cancel and the machine-readable `code` `'ABORT'`. |
| `isProviderAbortError` | function | `(value: unknown) => value is ProviderAbortError`                                                 | Narrows an unknown caught value to a `ProviderAbortError` through its identity brand and declared members, so a `catch` can recover its `partial` result.                                                                                                |
| `ProviderError`        | class    | `new (code: ProviderErrorCode, message: string, options?: ProviderErrorOptions) => ProviderError` | Reports a coded provider failure with its HTTP status and underlying cause when available.                                                                                                                                                               |
| `isProviderError`      | function | `(value: unknown) => value is ProviderError`                                                      | Narrows a caught value to the provider failure class through its identity brand and declared members.                                                                                                                                                    |
| `JudgeError`           | class    | `new (code: JudgeErrorCode, message: string, options?: ProviderErrorOptions) => JudgeError`       | Reports a coded judge failure with its HTTP status and underlying cause when available.                                                                                                                                                                  |
| `isJudgeError`         | function | `(value: unknown) => value is JudgeError`                                                         | Narrows a caught value to the judge failure class through its identity brand and declared members.                                                                                                                                                       |

#### Shapes and contracts

The JSON wire projections the relay validates against, and the contracts compiled from them, sit here. Each projection is strictly narrower than the domain type it mirrors: a value JSON can't carry is refused rather than silently dropped, and the `caller` member of a `ToolCall` is local context that never appears here.

| Name                      | Kind  | Signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Summary                                                                            |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `providerRequestShape`    | const | `import("@orkestrel/contract").ObjectShape<{ messages: import("@orkestrel/contract").ArrayShape<import("@orkestrel/contract").ObjectShape<{ id: import("@orkestrel/contract").StringShape; role: import("@orkestrel/contract").LiteralShape<readonly ["system", "user", "assistant", "tool"]>; content: import("@orkestrel/contract").StringShape; calls: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ArrayShape<import("@orkestrel/contract").ObjectShape<{ id: import("@orkestrel/contract").StringShape; name: import("@orkestrel/contract").StringShape; arguments: import("@orkestrel/contract").ObjectShape<Record<never, never>, import("@orkestrel/contract").JSONShape>; }, boolean \| ContractShape>>>; call: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; images: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ArrayShape<import("@orkestrel/contract").StringShape>>; thinking: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; }, boolean \| ContractShape>>; tools: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ArrayShape<import("@orkestrel/contract").ObjectShape<{ name: import("@orkestrel/contract").StringShape; description: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; parameters: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ObjectShape<Record<never, never>, import("@orkestrel/contract").JSONShape>>; }, boolean \| ContractShape>>>; options: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ObjectShape<{ think: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").BooleanShape>; schema: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ObjectShape<Record<never, never>, import("@orkestrel/contract").JSONShape>>; }, boolean \| ContractShape>>; }, boolean \| ContractShape>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Describes a provider request's JSON wire projection.                               |
| `providerResultShape`     | const | `import("@orkestrel/contract").ObjectShape<{ content: import("@orkestrel/contract").StringShape; thinking: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; tools: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ArrayShape<import("@orkestrel/contract").ObjectShape<{ id: import("@orkestrel/contract").StringShape; name: import("@orkestrel/contract").StringShape; arguments: import("@orkestrel/contract").ObjectShape<Record<never, never>, import("@orkestrel/contract").JSONShape>; }, boolean \| ContractShape>>>; usage: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ObjectShape<{ prompt: import("@orkestrel/contract").NumberShape; completion: import("@orkestrel/contract").NumberShape; total: import("@orkestrel/contract").NumberShape; }, boolean \| ContractShape>>; truncated: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").BooleanShape>; }, boolean \| ContractShape>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Describes a provider result's JSON wire projection.                                |
| `relayFrameShape`         | const | `import("@orkestrel/contract").UnionShape<readonly [import("@orkestrel/contract").ObjectShape<{ channel: import("@orkestrel/contract").LiteralShape<readonly ["content", "thinking"]>; text: import("@orkestrel/contract").StringShape; }, boolean \| ContractShape>, import("@orkestrel/contract").ObjectShape<{ channel: import("@orkestrel/contract").LiteralShape<readonly ["result"]>; result: import("@orkestrel/contract").ObjectShape<{ content: import("@orkestrel/contract").StringShape; thinking: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; tools: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ArrayShape<import("@orkestrel/contract").ObjectShape<{ id: import("@orkestrel/contract").StringShape; name: import("@orkestrel/contract").StringShape; arguments: import("@orkestrel/contract").ObjectShape<Record<never, never>, import("@orkestrel/contract").JSONShape>; }, boolean \| ContractShape>>>; usage: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ObjectShape<{ prompt: import("@orkestrel/contract").NumberShape; completion: import("@orkestrel/contract").NumberShape; total: import("@orkestrel/contract").NumberShape; }, boolean \| ContractShape>>; truncated: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").BooleanShape>; }, boolean \| ContractShape>; }, boolean \| ContractShape>, import("@orkestrel/contract").ObjectShape<{ channel: import("@orkestrel/contract").LiteralShape<readonly ["abort"]>; partial: import("@orkestrel/contract").ObjectShape<{ content: import("@orkestrel/contract").StringShape; thinking: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").StringShape>; tools: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ArrayShape<import("@orkestrel/contract").ObjectShape<{ id: import("@orkestrel/contract").StringShape; name: import("@orkestrel/contract").StringShape; arguments: import("@orkestrel/contract").ObjectShape<Record<never, never>, import("@orkestrel/contract").JSONShape>; }, boolean \| ContractShape>>>; usage: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ObjectShape<{ prompt: import("@orkestrel/contract").NumberShape; completion: import("@orkestrel/contract").NumberShape; total: import("@orkestrel/contract").NumberShape; }, boolean \| ContractShape>>; truncated: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").BooleanShape>; }, boolean \| ContractShape>; }, boolean \| ContractShape>, import("@orkestrel/contract").ObjectShape<{ channel: import("@orkestrel/contract").LiteralShape<readonly ["error"]>; message: import("@orkestrel/contract").StringShape; }, boolean \| ContractShape>]>` | Describes the channel-discriminated JSON relay wire projection.                    |
| `providerRequestContract` | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ messages: readonly Readonly<{ id: string; role: "assistant" \| "system" \| "tool" \| "user"; content: string; } & { calls?: readonly Readonly<{ id: string; name: string; arguments: { readonly [k: string]: import("@orkestrel/contract").JSONValue; }; } & {}>[]; call?: string; images?: readonly string[]; thinking?: string; }>[]; } & { tools?: readonly Readonly<{ name: string; } & { description?: string; parameters?: { readonly [k: string]: import("@orkestrel/contract").JSONValue; }; }>[]; options?: Readonly<{} & { think?: boolean; schema?: { readonly [k: string]: import("@orkestrel/contract").JSONValue; }; }>; }>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Validates and projects provider requests at a JSON wire boundary.                  |
| `providerResultContract`  | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ content: string; } & { thinking?: string; tools?: readonly Readonly<{ id: string; name: string; arguments: { readonly [k: string]: import("@orkestrel/contract").JSONValue; }; } & {}>[]; usage?: Readonly<{ prompt: number; completion: number; total: number; } & {}>; truncated?: boolean; }>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Validates and projects provider results at a JSON wire boundary.                   |
| `relayFrameContract`      | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ channel: "content" \| "thinking"; text: string; } & {}> \| Readonly<{ channel: "result"; result: Readonly<{ content: string; } & { thinking?: string; tools?: readonly Readonly<{ id: string; name: string; arguments: { readonly [k: string]: import("@orkestrel/contract").JSONValue; }; } & {}>[]; usage?: Readonly<{ prompt: number; completion: number; total: number; } & {}>; truncated?: boolean; }>; } & {}> \| Readonly<{ channel: "abort"; partial: Readonly<{ content: string; } & { thinking?: string; tools?: readonly Readonly<{ id: string; name: string; arguments: { readonly [k: string]: import("@orkestrel/contract").JSONValue; }; } & {}>[]; usage?: Readonly<{ prompt: number; completion: number; total: number; } & {}>; truncated?: boolean; }>; } & {}> \| Readonly<{ channel: "error"; message: string; } & {}>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Validates and projects channel-discriminated relay frames at a JSON wire boundary. |

A contract's `is` narrows an unknown record to its wire shape, and its `parse` projects one — returning the value stripped to that shape, or `undefined` when the value is invalid — so the same declaration guards an inbound body and shapes a frame written back out:

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { providerRequestContract, relayFrameContract } from '@orkestrel/agent'

declare const upstream: ProviderInterface
declare const body: unknown
declare const signal: AbortSignal
declare function write(line: string): void

if (providerRequestContract.is(body)) {
	const result = await upstream.generate(body.messages, signal, body.tools, body.options)
	const frame = relayFrameContract.parse({ channel: 'result', result })
	write(`${JSON.stringify(frame)}\n`) // the newline-delimited record a relay writes back
}
relayFrameContract.is({ channel: 'error', message: 'relay provider failed' }) // true
relayFrameContract.is({ channel: 'error', message: 'oops', code: 'X' }) // false — an extra member is refused
relayFrameContract.parse({ channel: 'error', message: 'oops', code: 'X' }) // { channel: 'error', message: 'oops' } — parse projects the extra member away
```

#### Factories

The following table lists the factories the providers module declares:

| Name                   | Kind     | Signature                                              | Summary                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRelay`          | function | `(options: RelayOptions) => RelayHandler`              | Creates an authorized relay handler that validates a bounded JSON request before streaming.                                                                                                                                                                                                                                                       |
| `createRelayProvider`  | function | `(options: RelayProviderOptions) => ProviderInterface` | Creates a provider that carries calls through a relay endpoint.                                                                                                                                                                                                                                                                                   |
| `createSystemOneJudge` | function | `(options: SystemOneJudgeOptions) => JudgeInterface`   | Creates a judge that sends every question through the configured System One server.                                                                                                                                                                                                                                                               |
| `createThinkSplitter`  | function | `() => ThinkSplitterInterface`                         | Creates a fresh stream-stateful `<think>` separator — a `ThinkSplitterInterface` that splits a thinking model's in-content `<think>…</think>` reasoning spans away from the answer, delta by delta, so a provider yields clean content alone and surfaces the accumulated reasoning as `ProviderResult.thinking`. One splitter serves one stream. |

#### Classes

The following table lists the classes the providers module declares:

| Name             | Kind  | Signature                                                                                                         | Summary                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ----- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentProvider`  | class | `new <TRecord = Readonly<Record<string, unknown>>>(input: AgentProviderInput) => AgentProviderInterface<TRecord>` | Implements bounded HTTP streaming and result assembly behind concrete wire seams.                                                                                                                                                                                                                                                                                                                         |
| `RelayProvider`  | class | `new (options: RelayProviderOptions) => RelayProvider`                                                            | Carries provider calls over an authenticated NDJSON relay endpoint.                                                                                                                                                                                                                                                                                                                                       |
| `RelayStream`    | class | `new (options: RelayStreamOptions) => RelayStream`                                                                | Streams a provider call as validated NDJSON frames under response backpressure.                                                                                                                                                                                                                                                                                                                           |
| `AgentJudge`     | class | `new (input: AgentJudgeInput) => AgentJudgeInterface`                                                             | Implements the bounded HTTP calls, validation, and result merging of a judge behind concrete wire seams.                                                                                                                                                                                                                                                                                                  |
| `SystemOneJudge` | class | `new (options: SystemOneJudgeOptions) => SystemOneJudge`                                                          | Carries judge questions over the System One protocol and derives answers from server distributions.                                                                                                                                                                                                                                                                                                       |
| `ThinkSplitter`  | class | `new () => ThinkSplitterInterface`                                                                                | Separates `<think>…</think>` spans from raw content deltas with per-stream state: text inside a span accumulates on `thinking`, and text outside it returns as clean content, so a provider yields the answer alone and surfaces the reasoning as `ProviderResult.thinking`. A tag split across deltas is held until disambiguated, `flush()` settles the stream end, and one splitter serves one stream. |

#### Helpers

The following table lists the helpers the providers module declares:

| Name                     | Kind     | Signature                                                                                                                                            | Summary                                                                                                                                |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `buildProviderResult`    | function | `(content: string, thinking: string, tools: readonly ToolCall[], usage: TokenUsage \| undefined, truncated: boolean \| undefined) => ProviderResult` | Assembles a provider result with only populated optional fields.                                                                       |
| `armReaderAbort`         | function | `(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal \| undefined) => Promise<AbortController>`                                    | Arms signal propagation to a byte reader and returns the controller that removes the listener.                                         |
| `readFailure`            | function | `(response: Response, prefix: string, signal: AbortSignal) => Promise<FailureRead>`                                                                  | Reads a bounded HTTP failure excerpt and preserves an unreadable body's cause.                                                         |
| `readBodyText`           | function | `(body: ReadableStream<Uint8Array>, limit?: number, signal?: AbortSignal) => Promise<TextRead>`                                                      | Reads a UTF-8 prefix of a byte stream and cancels its remainder.                                                                       |
| `readChunks`             | function | `(body: ReadableStream<Uint8Array>, signal?: AbortSignal) => AsyncGenerator<string>`                                                                 | Decodes UTF-8 chunks with a final flush and releases the stream on every exit.                                                         |
| `releaseReader`          | function | `(reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<void>`                                                                                 | Cancels a stream reader and releases its lock, swallowing a cancellation failure so the caller's own outcome stands.                   |
| `measureAnswer`          | function | `(answer: JudgeAnswer) => AnswerMeasure`                                                                                                             | Derives the winner, its probability, the published confidence, and a score answer's expected level from a judge answer's distribution. |
| `buildJudgeResult`       | function | `(model: string, results: readonly JudgeResult[]) => JudgeResult`                                                                                    | Merges the results of a judge request's calls into one result.                                                                         |
| `buildProviderHeaders`   | function | `(hook: ProviderOptions['headers'], signal: AbortSignal) => Promise<Headers>`                                                                        | Builds a request's JSON headers, awaiting the caller's header hook inside the call's cancellation bound.                               |
| `requestToRelay`         | function | `(request: ProviderRequest) => ProviderRequest`                                                                                                      | Projects a provider request onto the declared members the relay wire carries.                                                          |
| `buildRelayRequest`      | function | `(request: ProviderRequest, policy: Pick<RelayOptions, 'system' \| 'tools'>) => Result<ProviderRequest, readonly RelayRefusal[]>`                    | Builds the request a relay forwards under its system turn and tool definition policy, or every refusal that policy finds.              |
| `describeRelayRefusal`   | function | `(refusal: RelayRefusal) => string`                                                                                                                  | Describes one relay refusal as the line its `422` response body carries.                                                               |
| `questionToSystemOne`    | function | `(question: JudgeQuestion) => SystemOneQuestion`                                                                                                     | Projects a judge question onto the System One wire while preserving omitted members.                                                   |
| `extractSystemOneAnswer` | function | `(answer: SystemOneAnswer, question: JudgeQuestion) => JudgeAnswer \| undefined`                                                                     | Extracts a System One distribution in question criteria order and drops server measures.                                               |
| `extractSystemOneUsage`  | function | `(usage: SystemOneUsage \| undefined) => TokenUsage \| undefined`                                                                                    | Maps complete System One token counts onto validated token usage.                                                                      |

#### Validators

The following table lists the guards the providers module declares:

| Name                  | Kind     | Signature                                        | Summary                                                                                      |
| --------------------- | -------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `isSystemOneResponse` | function | `(value: unknown) => value is SystemOneResponse` | Checks whether a value is a System One response envelope with optional model and usage.      |
| `isSystemOneAnswer`   | function | `(value: unknown) => value is SystemOneAnswer`   | Checks whether a value is a System One answer whose type and distribution the wire can read. |

### Conversations module

The `conversations` module holds the conversation, its judgment store, the conversation registry, and the two stores.

#### Types

The following table lists the types the conversations module declares:

| Name                           | Kind      | Signature                                                                                                                                                                       | Summary                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MessageManagerInterface`      | interface | `{ count, add(), message(), messages(), remove(), clear() }`                                                                                                                    | Stores immutable `Message` records in insertion order and mints each `id` on `add` — the message-store contract every `ConversationInterface` satisfies structurally, the `AgentContextInterface.messages` conversation included.                                                                                                                                                                                      |
| `ConversationSummaryHandler`   | type      | `(messages: readonly Message[], signal?: AbortSignal) => Promise<string>`                                                                                                       | Summarizes a conversation, provider-agnostically — the seam the agent runtime supplies so core never imports a provider. Given the folded messages, it resolves their digest, the model-written summary of a compacted `Section` or of the oldest sections a `sections` cap merges.                                                                                                                                    |
| `Section`                      | interface | `{ id, summary, messages }`                                                                                                                                                     | Holds a slice of folded messages digested into a summary — the unit of compaction a `ConversationInterface` produces when its `compact()` call folds the live tail.                                                                                                                                                                                                                                                    |
| `ConversationEventMap`         | type      | `{ readonly compact: readonly [section: Section]; readonly rehydrate: readonly [id: string]; readonly collapse: readonly [section: Section]; }`                                 | Maps the push observation surface of a `ConversationInterface` — the compaction moments a fire-and-forget observer subscribes to through `conversation.emitter.on`.                                                                                                                                                                                                                                                    |
| `ConversationOptions`          | interface | `{ id?, on?, error?, summarize?, keep?, sections?, cumulative?, snapshot? }`                                                                                                    | Configures `createConversation` — the optional `id`, the reserved `on` hooks, the provider-agnostic `summarize` seam, the retained-tail size, an optional cap on the compacted `sections` list, and a `ConversationSnapshot` to hydrate from.                                                                                                                                                                          |
| `CompactOptions`               | interface | `{ keep?, sections?, signal? }`                                                                                                                                                 | Configures one `ConversationInterface.compact` call — the retained-tail size, the `sections` cap, or both, overridden for one fold.                                                                                                                                                                                                                                                                                    |
| `ConversationReferenceOptions` | interface | `{ label?, messages? }`                                                                                                                                                         | Configures `ConversationInterface.reference` — how to render one conversation as a self-labeled, fenced provenance block to pull into another conversation by writing it to the active workspace of the active context: `label` names the source and `messages` lists the cherry-picked excerpts.                                                                                                                      |
| `ConversationInterface`        | interface | `{ id, judgments, emitter, sections, summarizable, count, add(), message(), messages(), remove(), clear(), view(), compact(), rehydrate(), search(), reference(), snapshot() }` | Groups messages above the flat `MessageManagerInterface` — a live uncompacted tail plus compacted, summarized `Section` records, with on-demand `rehydrate`, substring `search`, a cross-conversation `reference`, and a JSON `snapshot`, driven by a provider-agnostic `ConversationSummaryHandler` seam; `summarizable` reports whether that seam was supplied, and the agent loop gates automatic compaction on it. |
| `ConversationInput`            | interface | `{ id?, summarize?, keep?, sections?, cumulative?, on?, error?, snapshot? }`                                                                                                    | Carries the data to author a `ConversationInterface` through a `ConversationManagerInterface` — the optional `id`, a `summarize` override, a `keep` override, a `sections` cap override, the `cumulative` switch, the reserved `on` hooks, and a `ConversationSnapshot` to hydrate from.                                                                                                                               |
| `ConversationManagerOptions`   | interface | `{ summarize?, keep?, sections?, store? }`                                                                                                                                      | Configures `createConversationManager` — the default `ConversationSummaryHandler`, retained-tail size, and `sections` cap the conversations it creates inherit, plus the optional durable `store` backing `open` / `save`.                                                                                                                                                                                             |
| `ConversationManagerInterface` | interface | `{ count, active, conversation(), conversations(), add(), switch(), open(), save(), remove(), clear() }`                                                                        | Registers `ConversationInterface` instances keyed by their `id`, in insertion order, with an active pointer — the id-keyed store over the conversation layer, the `active` / `switch` seam the `AgentContextInterface` renders, and the durable `open` / `save` store seam. Event-free (a registry, like `WorkspaceManagerInterface`); the observability lives on each `ConversationInterface`.                        |
| `ConversationSnapshot`         | interface | `{ id, judgments?, sections, messages }`                                                                                                                                        | Holds a JSON-serializable snapshot of the state of a conversation — its `id`, the compacted `sections`, and the live tail `messages` — the durable payload the `ConversationStoreInterface` persists. The exact analogue of `WorkspaceSnapshot`.                                                                                                                                                                       |
| `ConversationStoreInterface`   | interface | `{ get(), set(), delete() }`                                                                                                                                                    | Persists a `ConversationSnapshot` durably — the async `get` / `set` / `delete` primitives, keyed by a conversation id and holding no expiry, the exact analogue of `WorkspaceStoreInterface`.                                                                                                                                                                                                                          |
| `ConversationSnapshotRow`      | interface | `{ id, snapshot }`                                                                                                                                                              | Represents one row of the table a `DatabaseConversationStore` persists — a conversation `id` plus its `ConversationSnapshot` held as one opaque JSON column, read back as `unknown` and narrowed on `get`. The exact analogue of `WorkspaceSnapshotRow`.                                                                                                                                                               |
| `ConversationErrorCode`        | type      | `'SUMMARIZER' \| 'SECTIONS' \| 'JUDGMENT' \| 'KEEP' \| 'SUMMARY' \| 'ROLE' \| 'SNAPSHOT'`                                                                                       | Names the machine-readable condition a `ConversationError` reports.                                                                                                                                                                                                                                                                                                                                                    |
| `JudgmentManagerInterface`     | interface | `{ count, add(), judgment(), judgments(), remove(), clear(), resolve() }`                                                                                                       | Stores judgments by caller key and resolves requests by reusing matching records.                                                                                                                                                                                                                                                                                                                                      |

#### Constants

The following table lists the constants the conversations module declares:

| Name                        | Kind  | Signature                          | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ----- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONVERSATION_RECAP_PREFIX` | const | `"[Summary of earlier messages] "` | Names the framing label the `view()` method of a `ConversationInterface` prefixes onto the summary of each compacted section so a small model reads it as a condensed recap of earlier turns — the lean `'[Summary of earlier messages] '` marker, never a literal assistant turn to echo or treat as the live answer.                                                                                                                                                                                                                                                                                        |
| `DEFAULT_CONVERSATION_KEEP` | const | `0`                                | Sets the default number of recent live messages the `compact()` method of a `ConversationInterface` retains verbatim — `0`, so a manual `compact()` keeps no recent tail and folds every exchange before the newest user message into one summarized section. A caller retains a recent tail by passing `keep` (on `ConversationOptions`, `ConversationManagerOptions`, or per-fold through `CompactOptions`), folding at most the older `count - keep` messages, cut back to whole exchanges, and leaving at least the most recent `keep` live for the next turn. Overridable everywhere `keep` is accepted. |

#### Errors

The following table lists the errors the conversations module declares and the guards that narrow them:

| Name                  | Kind     | Signature                                                                                              | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConversationError`   | class    | `new (code: ConversationErrorCode, message: string, options?: CodedErrorOptions) => ConversationError` | Reports a conversation with no `ConversationSummaryHandler` to fold its messages with, a `sections` cap below `1`, a `keep` that is not a nonnegative safe integer, a summarizer digest whose trimmed text is empty, a judgment or judge request that JSON cannot carry, a stored or selected message whose role is not a conversation role, or a malformed snapshot — thrown by the `compact()` and `add` methods of a `ConversationInterface`, its construction, or its judgment store, or returned as the `fault` of an agent selection, carrying the machine-readable `code` `'SUMMARIZER' \| 'SECTIONS' \| 'JUDGMENT' \| 'KEEP' \| 'SUMMARY' \| 'ROLE' \| 'SNAPSHOT'`. |
| `isConversationError` | function | `(value: unknown) => value is ConversationError`                                                       | Narrows an unknown caught value to a `ConversationError` through its identity brand and declared members, so a `catch` can branch on its `code`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

#### Factories

The following table lists the factories the conversations module declares:

| Name                              | Kind     | Signature                                                                | Summary                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createConversation`              | function | `(options?: ConversationOptions) => ConversationInterface`               | Creates a conversation — a `ConversationInterface` grouping messages above a flat message store it owns directly, with compaction into summarized sections, on-demand `rehydrate`, and substring `search`, driven by a provider-agnostic `ConversationSummaryHandler` seam.                                                                                                                                               |
| `createConversationManager`       | function | `(options?: ConversationManagerOptions) => ConversationManagerInterface` | Creates a conversation registry — a `ConversationManagerInterface` holding `ConversationInterface` instances keyed by their `id`, in insertion order, with an active pointer: the id-keyed store over the conversation layer plus the `active` / `switch` seam the context renders. `add` auto-activates the first conversation and flows the registry's default `summarize` / `keep` into every conversation it creates. |
| `createMemoryConversationStore`   | function | `() => ConversationStoreInterface`                                       | Creates the in-memory conversation store — a `ConversationStoreInterface` backed by a process-lifetime `Map` of `ConversationSnapshot` records keyed by conversation id, the default backing for the durable `ConversationManagerInterface.open` / `ConversationManagerInterface.save` seam. The exact twin of `createMemoryWorkspaceStore`.                                                                              |
| `createDatabaseConversationStore` | function | `(driver?: DriverInterface) => ConversationStoreInterface`               | Creates a `DatabaseConversationStore` over any `DriverInterface` — the durable, driver-pluggable backing for the conversation persistence seam, holding each snapshot as one opaque JSON column and standing as the opt-in twin of `createMemoryConversationStore`. The exact twin of `createDatabaseWorkspaceStore`.                                                                                                     |

#### Classes

The following table lists the classes the conversations module declares:

| Name                        | Kind  | Signature                                                                            | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ----- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Conversation`              | class | `new (options?: ConversationOptions) => ConversationInterface`                       | Represents a conversation — a live uncompacted tail of messages it owns directly above a flat message store, plus compacted, summarized `Section` records and a `summarizable` flag, with on-demand `rehydrate` and substring `search`, driven by a provider-agnostic `ConversationSummaryHandler` seam so `core` never imports a provider. Observable through its own `emitter`.                                                                   |
| `ConversationManager`       | class | `new (options?: ConversationManagerOptions) => ConversationManagerInterface`         | Registers `Conversation` instances keyed by `id`, in insertion order, with an active pointer — the id-keyed store over the conversation layer, the `active` / `switch` seam the `AgentContext` renders, and the durable `open` / `save` store seam. Event-free (a registry, like `WorkspaceManager`); the observability lives on each `Conversation`.                                                                                               |
| `MemoryConversationStore`   | class | `new () => ConversationStoreInterface`                                               | Implements the `ConversationStoreInterface` in memory — a process-lifetime `Map` of `ConversationSnapshot` records keyed by conversation id, the default store `createMemoryConversationStore` builds and the default backing for `open` / `save`. The exact twin of `MemoryWorkspaceStore`.                                                                                                                                                        |
| `DatabaseConversationStore` | class | `new (table: TableInterface<ConversationSnapshotRow>) => ConversationStoreInterface` | Backs a `ConversationStoreInterface` with one table of the `databases` layer — a conversation's durable state is a row holding the snapshot as one opaque JSON column, narrowed back on `get` by `isConversationSnapshot`, so persistence reduces to keyed point-access (`get` / `set` / `delete`) over a `TableInterface`. The driver-pluggable twin of the plain-`Map` `MemoryConversationStore`, and the exact twin of `DatabaseWorkspaceStore`. |
| `JudgmentManager`           | class | `new (judgments?: readonly Judgment[]) => JudgmentManagerInterface`                  | Stores judgments in insertion order and asks a judge only for unmatched question identities.                                                                                                                                                                                                                                                                                                                                                        |

#### Helpers

The following table lists the helpers the conversations module declares:

| Name                          | Kind     | Signature                                                                                                                            | Summary                                                                                                                                                                       |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buildSummaryMessage`         | function | `(section: Section) => Message`                                                                                                      | Builds the raw synthetic summary message for one compacted section — role `'assistant'`, the section's stable `id`, and its `summary` verbatim as content.                    |
| `buildRecapMessage`           | function | `(section: Section) => Message`                                                                                                      | Builds the framed recap message for one compacted section — the same role and stable `id` as `buildSummaryMessage`, with the content prefixed by `CONVERSATION_RECAP_PREFIX`. |
| `requireJudgment`             | function | `(value: unknown) => Judgment`                                                                                                       | Returns a stored judgment record after checking it, or throws a coded error.                                                                                                  |
| `requireRole`                 | function | `(role: unknown) => ConversationRole`                                                                                                | Returns a stored message role after checking it is a conversation role, or throws a coded error.                                                                              |
| `requireConversationSnapshot` | function | `(value: unknown) => ConversationSnapshot`                                                                                           | Returns a conversation snapshot after checking its shape, its stored roles, and its ids, or throws a coded error.                                                             |
| `requireSectionsCap`          | function | `(cap: number \| undefined) => number \| undefined`                                                                                  | Returns a `sections` cap after checking its lower bound, or throws a coded error.                                                                                             |
| `requireCumulative`           | function | `(cumulative: boolean, cap: number \| undefined) => boolean`                                                                         | Returns the cumulative switch after checking it does not combine with a `sections` cap, or throws a coded error.                                                              |
| `requireKeep`                 | function | `(keep: number) => number`                                                                                                           | Returns a retained-tail size after checking it is a nonnegative safe integer, or throws a coded error.                                                                        |
| `requireSummary`              | function | `(summary: string) => string`                                                                                                        | Returns a summarizer digest after checking it carries non-whitespace text, or throws a coded error.                                                                           |
| `raceSignal`                  | function | `<T>(promise: Promise<T>, signal: AbortSignal \| undefined) => Promise<T>`                                                           | Settles with a promise, or rejects with the reason of a signal that aborts first, so a caller is released at once even when the work behind the promise ignores the signal.   |
| `buildJudgments`              | function | `(request: JudgeRequest, result: JudgeResult, sources: readonly string[], state: string, model: string) => readonly JudgmentInput[]` | Builds records for answered or refused request keys, attaching usage only for a single question.                                                                              |

#### Validators

The following table lists the guards the conversations module declares:

| Name                     | Kind     | Signature                                            | Summary                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isMessage`              | function | `(value: unknown) => value is Message`               | Checks whether a value satisfies the domain conversation-message contract.                                                                                                                                                                                                                                                                             |
| `isSection`              | function | `(value: unknown) => value is Section`               | Checks whether an `unknown` is structurally a `Section` record — a `string` `id` and `summary` beside a `messages` array of valid `Message` records, the per-section step of the `isConversationSnapshot` read-boundary narrow. Total, never throwing, and never an assertion.                                                                         |
| `isConversationSnapshot` | function | `(value: unknown) => value is ConversationSnapshot`  | Narrows an `unknown` to a `ConversationSnapshot` — a `string` `id` and valid `sections` and `messages` arrays; the total boundary guard for an untrusted snapshot read (a storage row a `DatabaseConversationStore` reads back from its opaque JSON column, a snapshot loaded from disk), never throwing. The exact analogue of `isWorkspaceSnapshot`. |
| `isConversation`         | function | `(value: unknown) => value is ConversationInterface` | Checks whether a value carries the `ConversationInterface` members a run reads: a string `id`, a boolean `summarizable`, and `view`, `add`, `compact`, and `messages` methods.                                                                                                                                                                         |
| `isJudgment`             | const    | `Guard<Judgment>`                                    | Checks whether a stored judgment carries a valid question and exactly one answer or refusal.                                                                                                                                                                                                                                                           |

A `DatabaseConversationStore` reads its snapshot column back as `unknown` and narrows it through `isConversationSnapshot`, so a malformed blob resolves `undefined` rather than a broken conversation:

```ts
import { isConversationSnapshot } from '@orkestrel/agent'

declare const row: unknown
const snapshot = isConversationSnapshot(row) ? row : undefined
```

### Contexts module

The `contexts` module holds the turn context, its instruction and scope managers, the memo and skill managers with the memo guards and stores, and the selection seam.

#### Types

The following table lists the types the contexts module declares:

| Name                          | Kind      | Signature                                                                                                                                | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ContextErrorCode`            | type      | `'SNAPSHOT'`                                                                                                                             | Names the machine-readable condition a `ContextError` reports.                                                                                                                                                                                                                                                                                                                                                                                     |
| `ContextSectionFormat`        | interface | `{ open?, render?, close? }`                                                                                                             | Overrides one context section's format — an `open` / `render` / `close` trio that frames a section in the `AgentContext` build cascade: a top line rendered once before the items, a per-item rendering, and a bottom line rendered once after the items.                                                                                                                                                                                          |
| `InstructionInterface`        | interface | `{ id, name, content, priority, override? }`                                                                                             | Represents an immutable instruction — a named directive a richer context places between the system prompt and the conversation, ordered by descending `priority`.                                                                                                                                                                                                                                                                                  |
| `InstructionInput`            | interface | `{ name, content, priority?, override? }`                                                                                                | Carries the minimal data to author an `InstructionInterface` — the `id` is minted by the `InstructionManagerInterface` that stores it, so a caller supplies only `name` / `content` and an optional `priority`. Default: `0`.                                                                                                                                                                                                                      |
| `InstructionManagerEventMap`  | type      | `{ readonly add: readonly [instruction: InstructionInterface]; readonly remove: readonly [name: string]; readonly clear: readonly []; }` | Maps the push observation surface of an `InstructionManagerInterface` — the mutation moments a fire-and-forget observer subscribes to through `manager.emitter.on`.                                                                                                                                                                                                                                                                                |
| `InstructionManagerOptions`   | interface | `{ on?, error?, format? }`                                                                                                               | Configures `createInstructionManager` — the reserved `on` hooks plus an optional per-section format override.                                                                                                                                                                                                                                                                                                                                      |
| `InstructionManagerInterface` | interface | `{ emitter, count, open, close, add(), instruction(), instructions(), render(), remove(), clear() }`                                     | Registers `InstructionInterface` values keyed by `name` — `add` (one or a batch) mints each `id` and overwrites a same-name instruction, last write wins, while `instructions()` lists them sorted by descending `priority` and stable for ties.                                                                                                                                                                                                   |
| `ScopeFilter`                 | interface | `{ instructions?, skills?, memos?, tools?, files? }`                                                                                     | Lists the per-category allow-lists a `ScopeInterface` carries — an optional `readonly string[]` for `instructions`, for `skills`, for `memos`, for `tools`, and for `files`, each keyed by that category's identity (an instruction's, a skill's, a memo's, or a tool's `name`, a workspace file's `path`) and read as an allow-list: `undefined` lets everything pass, `[]` lets nothing pass, and a non-empty list passes the listed keys alone. |
| `Selection`                   | interface | `{ messages, judgments, usage?, fault? }`                                                                                                | Carries the conversation part of the next prompt and the receipt for it.                                                                                                                                                                                                                                                                                                                                                                           |
| `SelectionHandler`            | type      | `(conversation: ConversationInterface, request: Message, signal: AbortSignal) => Promise<Selection>`                                     | Chooses the conversation messages the next prompt carries for one user request.                                                                                                                                                                                                                                                                                                                                                                    |
| `ScopeInput`                  | interface | `{ name, select? }`                                                                                                                      | Carries the data to author a `ScopeInterface` — a `ScopeFilter` plus the required `name` (a human label; the `id` is minted by the layer that stores it).                                                                                                                                                                                                                                                                                          |
| `ScopeInterface`              | interface | `{ id, name, select?, narrow() }`                                                                                                        | Represents a named, immutable filter over a richer context's items — the per-category allow-lists (`ScopeFilter`) plus an `id` / `name`, and a `narrow` that composes a tighter child by set intersection.                                                                                                                                                                                                                                         |
| `ScopeManagerEventMap`        | type      | `{ readonly add: readonly [scope: ScopeInterface]; readonly remove: readonly [id: string]; readonly clear: readonly []; }`               | Maps the push observation surface of a `ScopeManagerInterface` — analogous to `InstructionManagerEventMap`, but keyed by the minted `id`, so `add` never reports a replaced scope.                                                                                                                                                                                                                                                                 |
| `ScopeManagerOptions`         | interface | `{ on?, error? }`                                                                                                                        | Configures `createScopeManager` — the reserved `on` hooks: initial listeners for the manager's `ScopeManagerEventMap`, wired at construction.                                                                                                                                                                                                                                                                                                      |
| `ScopeManagerInterface`       | interface | `{ emitter, count, add(), scope(), scopes(), remove(), clear() }`                                                                        | Registers reusable `ScopeInterface` instances keyed by their minted `id` — `add` mints + stores one (never overwrites), `scopes()` lists them in insertion order.                                                                                                                                                                                                                                                                                  |
| `Memo`                        | interface | `{ id, name, description, content, time, origin? }`                                                                                      | Holds one memo revision: a durable fact kept across conversations.                                                                                                                                                                                                                                                                                                                                                                                 |
| `MemoOrigin`                  | interface | `{ conversation, message? }`                                                                                                             | Names where a memo revision came from: a conversation and, optionally, one of its messages.                                                                                                                                                                                                                                                                                                                                                        |
| `MemoInput`                   | interface | `{ name, description, content, origin? }`                                                                                                | Carries the data to author a `Memo` revision; the `MemoManagerInterface` that stores it mints the `id` and records the `time`.                                                                                                                                                                                                                                                                                                                     |
| `MemoSnapshot`                | interface | `{ id, memos }`                                                                                                                          | Holds every revision of a memo set, oldest first; the current memo of a name is its last revision.                                                                                                                                                                                                                                                                                                                                                 |
| `MemoManagerEventMap`         | type      | `{ readonly add: readonly [memo: Memo]; readonly remove: readonly [name: string]; readonly clear: readonly []; }`                        | Maps the push observation surface of a `MemoManagerInterface`: the mutation moments a fire-and-forget observer subscribes to through `manager.emitter.on`.                                                                                                                                                                                                                                                                                         |
| `MemoManagerOptions`          | interface | `{ id?, on?, error?, format?, snapshot? }`                                                                                               | Configures `createMemoManager`: the memo set's identity, the reserved `on` hooks, a section format override, and a snapshot to restore.                                                                                                                                                                                                                                                                                                            |
| `MemoManagerInterface`        | interface | `{ id, emitter, count, open, close, add(), memo(), memos(), history(), render(), remove(), clear(), snapshot() }`                        | Registers `Memo` revisions keyed by `name`: `add` appends a revision when the text changed, `memo(name)` returns the current revision, and `history(name)` lists every revision.                                                                                                                                                                                                                                                                   |
| `MemoStoreInterface`          | interface | `{ get(), set(), delete() }`                                                                                                             | Persists a `MemoSnapshot` by its memo set id — the async `get` / `set` / `delete` primitives, holding no expiry, the memo twin of `ConversationStoreInterface`.                                                                                                                                                                                                                                                                                    |
| `MemoSnapshotRow`             | interface | `{ id, snapshot }`                                                                                                                       | Represents one row of the table a `DatabaseMemoStore` persists — a memo set `id` plus its `MemoSnapshot` held as one opaque JSON column, read back as `unknown` and narrowed on `get`.                                                                                                                                                                                                                                                             |
| `Skill`                       | interface | `{ id, name, description, content, files }`                                                                                              | Holds one skill: a name and a description the index shows, the instructions loading adds, and bundled files.                                                                                                                                                                                                                                                                                                                                       |
| `SkillInput`                  | interface | `{ name, description, content, files? }`                                                                                                 | Carries the data to author a `Skill`; the `SkillManagerInterface` that stores it mints the `id` and each file.                                                                                                                                                                                                                                                                                                                                     |
| `SkillManagerEventMap`        | type      | `{ readonly add: readonly [skill: Skill]; readonly remove: readonly [name: string]; readonly clear: readonly []; }`                      | Maps the push observation surface of a `SkillManagerInterface`, as `InstructionManagerEventMap` does for instructions.                                                                                                                                                                                                                                                                                                                             |
| `SkillManagerOptions`         | interface | `{ on?, error?, format? }`                                                                                                               | Configures `createSkillManager`: the reserved `on` hooks and a section format override.                                                                                                                                                                                                                                                                                                                                                            |
| `SkillManagerInterface`       | interface | `{ emitter, count, open, close, add(), skill(), skills(), render(), remove(), clear() }`                                                 | Registers `Skill` values keyed by `name`: `add` mints each skill and overwrites a same-name skill, last write wins, while `skills()` lists them in insertion order.                                                                                                                                                                                                                                                                                |
| `AgentContextOptions`         | interface | `{ system?, tools?, instructions?, skills?, memos?, workspaces?, scope?, conversations?, select? }`                                      | Configures `createAgentContext` — the optional system prompt plus the pre-built managers to reuse: an `instructions` registry, a `skills` registry, a `memos` set, a `workspaces` registry (the only document channel), a `conversations` registry (the message source), a `tools` registry (the loop's advertise and dispatch surface), and an initial `scope`.                                                                                   |
| `AgentContextInterface`       | interface | `{ system, instructions, skills, memos, workspaces, messages, conversations, tools, scope, apply(), select(), build() }`                 | Assembles a turn's provider input from the system prompt + the context managers + the conversation, applying the active scope per category.                                                                                                                                                                                                                                                                                                        |

#### Constants

The following table lists the constants the contexts module declares:

| Name                       | Kind  | Signature        | Summary                                                                                                                                                                                                                                    |
| -------------------------- | ----- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WORKSPACE_SECTION_HEADER` | const | `"## Workspace"` | Names the section header the `build()` method of `AgentContext` renders the active workspace's text files under — `'## Workspace'`, the line that opens the workspace section of the user context message that follows the system message. |
| `MEMO_SECTION_HEADER`      | const | `"## Memos"`     | Names the built-in section header a `MemoManagerInterface` renders its index under — `'## Memos'`, the `open` value when no `format.open` overrides it.                                                                                    |
| `SKILL_SECTION_HEADER`     | const | `"## Skills"`    | Names the built-in section header a `SkillManagerInterface` renders its index under — `'## Skills'`, the `open` value when no `format.open` overrides it.                                                                                  |

#### Errors

The following table lists the errors the contexts module declares and the guards that narrow them:

| Name             | Kind     | Signature                                                                                    | Summary                                                                                                                                                                               |
| ---------------- | -------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ContextError`   | class    | `new (code: ContextErrorCode, message: string, options?: CodedErrorOptions) => ContextError` | Reports a context snapshot that `isMemoSnapshot` refuses, thrown by the construction of a `MemoManager` before it seats any state, carrying the machine-readable `code` `'SNAPSHOT'`. |
| `isContextError` | function | `(value: unknown) => value is ContextError`                                                  | Narrows an unknown caught value to a `ContextError` through its identity brand and declared members, so a `catch` can branch on its `code`.                                           |

#### Factories

The following table lists the factories the contexts module declares:

| Name                       | Kind     | Signature                                                              | Summary                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | -------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createInstruction`        | function | `(input: InstructionInput) => InstructionInterface`                    | Creates an instruction — an immutable `InstructionInterface` (a named directive) from its `name` / `content` and optional `priority`, the `id` minted at construction.                                                                                                                                                                                                                        |
| `createInstructionManager` | function | `(options?: InstructionManagerOptions) => InstructionManagerInterface` | Creates an instruction registry — an `InstructionManagerInterface` holding immutable instructions keyed by `name`, listed by descending `priority`.                                                                                                                                                                                                                                           |
| `createScope`              | function | `(input: ScopeInput) => ScopeInterface`                                | Creates a named scope — an immutable `ScopeInterface` from its `name` and its per-category allow-lists, the `id` minted at construction.                                                                                                                                                                                                                                                      |
| `createScopeManager`       | function | `(options?: ScopeManagerOptions) => ScopeManagerInterface`             | Creates a scope registry — a `ScopeManagerInterface` holding immutable scopes keyed by their minted `id`, in insertion order.                                                                                                                                                                                                                                                                 |
| `createMemoManager`        | function | `(options?: MemoManagerOptions) => MemoManagerInterface`               | Creates a memo set — a `MemoManagerInterface` holding durable facts keyed by `name`, where a same-name `add` with changed text appends a revision and the earlier ones stay readable.                                                                                                                                                                                                         |
| `createMemoryMemoStore`    | function | `() => MemoStoreInterface`                                             | Creates the in-memory memo store — a `MemoStoreInterface` backed by a process-lifetime map, the default twin of `createDatabaseMemoStore`.                                                                                                                                                                                                                                                    |
| `createDatabaseMemoStore`  | function | `(driver?: DriverInterface) => MemoStoreInterface`                     | Creates a `DatabaseMemoStore` over any `DriverInterface` — the durable, driver-pluggable backing for a memo set, holding each snapshot as one opaque JSON column in a `memos` table.                                                                                                                                                                                                          |
| `createSkillManager`       | function | `(options?: SkillManagerOptions) => SkillManagerInterface`             | Creates a skill registry — a `SkillManagerInterface` holding the skills a host supplies, keyed by `name` and listed in insertion order.                                                                                                                                                                                                                                                       |
| `createAgentContext`       | function | `(options?: AgentContextOptions) => AgentContextInterface`             | Creates a richer turn context — an `AgentContextInterface` assembling a provider request from the optional system prompt, the instruction registry, the skill registry, the memo set, the workspace registry (the only document channel), the conversation registry that is its `messages` source, the tool registry, and the active scope, which `build()` folds into the next turn's input. |

#### Classes

The following table lists the classes the contexts module declares:

| Name                 | Kind  | Signature                                                                  | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ----- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Instruction`        | class | `new (input: InstructionInput) => InstructionInterface`                    | Represents an immutable named directive — an `InstructionInterface` assembled once from its input (`name` / `content` and an optional `priority`), the `id` minted at construction. Default: `0` for `priority`.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `InstructionManager` | class | `new (options?: InstructionManagerOptions) => InstructionManagerInterface` | Registers the immutable `Instruction` instances a richer context assembles a directives block from — keyed by `name` so adding an instruction whose name is already stored overwrites it, last write wins, and listed by descending `priority`, carrying the `open` / `render` / `close` build contract and an observable `emitter`.                                                                                                                                                                                                                                                                                                    |
| `Scope`              | class | `new (input: ScopeInput) => ScopeInterface`                                | Represents a named, immutable filter over a richer context's items — an optional allow-list per category (`instructions` / `skills` / `memos` / `tools` / `files`), each keyed by that category's identity (an instruction's, a skill's, a memo's, or a tool's `name`, a workspace file's `path`) and read as an allow-list: `undefined` lets everything pass, `[]` lets nothing pass, and a non-empty list passes the listed keys alone. `narrow` composes a tighter child by set intersection.                                                                                                                                        |
| `ScopeManager`       | class | `new (options?: ScopeManagerOptions) => ScopeManagerInterface`             | Registers the named filters a richer context reuses — immutable `Scope` instances keyed by their minted `id`, in insertion order, where `add` always mints and stores rather than overwriting, and an observable `emitter` reports each change.                                                                                                                                                                                                                                                                                                                                                                                         |
| `MemoManager`        | class | `new (options?: MemoManagerOptions) => MemoManagerInterface`               | Registers the revisions of a memo set — durable facts keyed by `name`, where a same-name `add` with changed text appends a revision and the earlier ones stay readable — carrying the `open` / `render` / `close` build contract and an observable `emitter`.                                                                                                                                                                                                                                                                                                                                                                           |
| `MemoryMemoStore`    | class | `new () => MemoStoreInterface`                                             | Implements the `MemoStoreInterface` in memory — a process-lifetime map of `MemoSnapshot` records keyed by memo set id, the store `createMemoryMemoStore` builds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `DatabaseMemoStore`  | class | `new (table: TableInterface<MemoSnapshotRow>) => MemoStoreInterface`       | Backs a `MemoStoreInterface` with one table of the `databases` layer — a memo set's durable state is a row holding the snapshot as one opaque JSON column, narrowed back on `get` by `isMemoSnapshot`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SkillManager`       | class | `new (options?: SkillManagerOptions) => SkillManagerInterface`             | Registers the skills a host supplies — instruction bundles keyed by `name`, listed in insertion order, where adding a skill whose name is already stored overwrites it, last write wins — carrying the `open` / `render` / `close` build contract and an observable `emitter`.                                                                                                                                                                                                                                                                                                                                                          |
| `AgentContext`       | class | `new (options?: AgentContextOptions) => AgentContextInterface`             | Assembles a provider request from the richer turn context — the optional system prompt, the observable context managers (instructions / skills / memos / workspaces), the `ConversationManagerInterface` message source whose active conversation is `messages`, the `ToolManagerInterface` registry, and an active `ScopeInterface` changed through `AgentContextInterface.apply`. `build()` folds the system prompt, the scoped instructions, and the skills index into one system message, the memos index and the active workspace's text into one `user` context message after it, then the conversation, and never reads `tools`. |

#### Helpers

The following table lists the helpers the contexts module declares:

| Name               | Kind     | Signature                                                                                                                    | Summary                                                                                                                                                                                                                            |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderFencedFile` | function | `(path: string, language: string, content: string) => string`                                                                | Renders a path-addressed text body as a fenced reference block — a `File: <path>` label line over a language-tagged fence, the framing the active-workspace text-file render of `AgentContext` emits.                              |
| `renderSection`    | function | `<T>(open: string, members: readonly T[], render: (member: T) => string, close: string \| undefined) => string \| undefined` | Renders one context section — the resolved `open`, each item's rendering, and the resolved `close` when one exists, blank-line joined; `undefined` when the section has no items.                                                  |
| `attachImages`     | function | `(message: Message, payloads: readonly string[]) => Message`                                                                 | Copies a message with image data merged onto its `images` — the message's own images first, then the attached data, keeping every other field and never mutating the original.                                                     |
| `attachUserImages` | function | `(conversation: readonly Message[], payloads: readonly string[]) => readonly Message[]`                                      | Attaches image data to a conversation's last user message — the turn a vision provider reads images off — as a new array with that one message replaced by its carrying copy, and unchanged when there is no data or no user turn. |
| `collectImageData` | function | `(files: readonly FileInterface[]) => readonly string[]`                                                                     | Collects the `base64` payload of the image files in a workspace file list — the data an agent context attaches to the last user message.                                                                                           |
| `intersectKeys`    | function | `(parent: readonly string[] \| undefined, child: readonly string[] \| undefined) => readonly string[] \| undefined`          | Intersects two scope category lists under the "`undefined` is the universal set" rule — a fresh copy that can only tighten, and the primitive a scope narrows through.                                                             |
| `renderIndexEntry` | function | `(entry: Pick<Memo, 'name' \| 'description'>) => string`                                                                     | Renders one index line for a memo or a skill — `- name: description`, the built-in `render` of the memo and skill managers.                                                                                                        |

#### Validators

The following table lists the guards the contexts module declares:

| Name             | Kind     | Signature                                   | Summary                                                                                                                                                         |
| ---------------- | -------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isMemo`         | const    | `Guard<Memo>`                               | Checks whether a value is a stored memo revision: a record with a string `id`, `name`, `description`, and `content`, a finite `time`, and an optional `origin`. |
| `isMemoSnapshot` | function | `(value: unknown) => value is MemoSnapshot` | Checks whether a value is a stored memo set: a record with a string `id` and a dense `memos` array of `isMemo` values.                                          |

### Agents module

The `agents` module holds the loop, the authority gate, the channel, and the durable-job bridge.

#### Types

The following table lists the types the agents module declares:

| Name                     | Kind      | Signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentStatus`            | type      | `'idle' \| 'running' \| 'done' \| 'error'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Names the lifecycle state of an `AgentInterface` turn — `idle` before a run, `running` while the loop is in flight, then the settled `done` (a normal finish or a cancel) or `error` (a genuine provider / tool failure).                                                                                                                                                                                                                                             |
| `AgentChunk`             | type      | `{ readonly category: 'token'; readonly content: string; } \| { readonly category: 'think'; readonly content: string; } \| { readonly category: 'tool'; readonly call: ToolCall; readonly result: ToolResult; } \| { readonly category: 'usage'; readonly usage: TokenUsage; readonly estimate: number; } \| { readonly category: 'ask'; readonly call: ToolCall; readonly decision: AuthorityDecision; }`                                                                                                                                                                                                                                                                                                                                                            | Represents a streamed step of an agent turn — the union the loop yields as it runs, discriminated by the `category` of step it carries, and the pull surface beside the push `AgentEventMap`.                                                                                                                                                                                                                                                                         |
| `AgentEventMap`          | type      | `{ readonly start: readonly [id: string]; readonly turn: readonly [index: number]; readonly tool: readonly [call: ToolCall, result: ToolResult]; readonly usage: readonly [usage: TokenUsage, estimate: number]; readonly allow: readonly [call: ToolCall, decision: AuthorityDecision]; readonly ask: readonly [call: ToolCall, decision: AuthorityDecision]; readonly deny: readonly [ call: ToolCall, reason: string \| undefined, decision: AuthorityDecision \| undefined ]; readonly finish: readonly [result: AgentResult]; readonly error: readonly [error: unknown]; readonly abort: readonly [reason: unknown]; readonly exhaust: readonly [turns: number]; readonly fault: readonly [error: unknown]; readonly select: readonly [selection: Selection]; }` | Maps the push observation surface of an `AgentInterface` — the lifecycle, usage, and tool moments a fire-and-forget observer (logging, metrics, tracing) subscribes to, beside the pull `AgentChunk` stream.                                                                                                                                                                                                                                                          |
| `AgentResult`            | interface | `{ content, thinking?, usage?, partial, stop? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Holds the settled outcome of an agent turn — the assembled assistant `content`, the `usage` summed across the turn's provider calls, and whether it was committed `partial`.                                                                                                                                                                                                                                                                                          |
| `AgentRunResult`         | interface | `{ content, thinking, usage, partial, exhausted, stop }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Holds the immutable outcome of one agent loop, assembled into the `AgentResult` resolved by the stream handle.                                                                                                                                                                                                                                                                                                                                                        |
| `AgentTurn`              | interface | `{ content, thinking, usage, spent, messages, outcome, partial, futile, estimate, interrupted, truncated }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Holds what one agent loop turn contributed to its run and how the turn ended — the readonly record the loop appends for each turn, from which the run derives its `AgentRunResult`.                                                                                                                                                                                                                                                                                   |
| `AgentStop`              | type      | `{ readonly layer: 'meter' \| 'budget'; readonly id: string; readonly max: number; readonly consumed: number; readonly estimate?: number; readonly usage?: TokenUsage; } \| { readonly layer: 'model'; readonly id: string; readonly estimate?: number; readonly usage?: TokenUsage; }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Represents why one of a run's three allowed failure layers stopped it — the meter's estimate allowance, the cost budget, or the model's own token limit — with the readings that layer crossed.                                                                                                                                                                                                                                                                       |
| `AgentErrorCode`         | type      | `'APPROVER' \| 'CONCURRENCY' \| 'LIMIT' \| 'REGISTRY' \| 'WINDOW'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Names the machine-readable agent approver, concurrency, limit, registry, and window failures.                                                                                                                                                                                                                                                                                                                                                                         |
| `MessageMeasure`         | interface | `{ id, role, content, uniform, calls, thinking, images }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Holds the disjoint estimate components of one message, in heuristic estimate units.                                                                                                                                                                                                                                                                                                                                                                                   |
| `RequestMeasure`         | interface | `{ messages, tools, schema }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Holds the disjoint estimate components of one provider request, in heuristic estimate units.                                                                                                                                                                                                                                                                                                                                                                          |
| `ChannelInterface`       | interface | `{ push(), close(), fail(), drain() }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Buffers values in an unbounded async channel — a producer writes them in (`push`) and ends it (`close` / `fail`) regardless of consumption, while a consumer reads them back live through `drain`.                                                                                                                                                                                                                                                                    |
| `StreamInterface`        | interface | `{ events, result, abort() }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Pairs a live event stream with the eventual settled result and a cancel — the generic pull/streaming handle a long-running operation hands back.                                                                                                                                                                                                                                                                                                                      |
| `AgentStreamInterface`   | type      | `StreamInterface<AgentChunk, AgentResult>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Names the agent turn's live handle carrying `AgentChunk` values and resolving an `AgentResult`.                                                                                                                                                                                                                                                                                                                                                                       |
| `AgentFrame`             | type      | `{ readonly category: 'token'; readonly content: string; } \| { readonly category: 'think'; readonly content: string; } \| { readonly category: 'tool'; readonly success: true; readonly name: string; } \| { readonly category: 'tool'; readonly success: false; } \| { readonly category: 'usage'; readonly usage: TokenUsage; readonly estimate: number; } \| { readonly category: 'ask'; readonly id: string; readonly name: string; readonly zone: string; readonly arguments: string; } \| { readonly category: 'finish'; readonly content: string; readonly partial: boolean; readonly usage?: TokenUsage; readonly layer?: AgentStop['layer']; } \| { readonly category: 'error'; }`                                                                          | Represents one step of a server-run agent turn as a page receives it — one frame per projected `AgentChunk`, then exactly one terminal `finish` or `error`.                                                                                                                                                                                                                                                                                                           |
| `AgentPrompt`            | interface | `{ content, images? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Holds the one user turn a run appends to its conversation — passed as `AgentRunOptions.prompt` by a host or sent by a page; the run writes `role: 'user'` itself.                                                                                                                                                                                                                                                                                                     |
| `AgentAnswer`            | interface | `{ id, approved }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Carries a page's answer to one `ask` frame; only `approved: true` approves.                                                                                                                                                                                                                                                                                                                                                                                           |
| `ApproverInterface`      | interface | `{ ask, frame(), answer() }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Holds a server's waiting asks between the run that asked them and the page that answers them — the authority's `ask` handler, the frame each waiting ask crosses as, and the answer that settles it.                                                                                                                                                                                                                                                                  |
| `AgentOptions`           | interface | `{ on?, error?, system?, tools?, instructions?, skills?, memos?, workspaces?, scope?, limit?, timeout?, budget?, allowance?, scheduler?, signal?, authority?, conversations?, window?, strict?, select? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Configures `createAgent` — the loop's bounds and pacing, the reserved `on` hooks, the construction-time context wiring (`instructions` / `skills` / `memos` / `workspaces` / `scope`), the `conversations` registry holding every run's default, the context `window` budget that opts into automatic compaction of the run's conversation, and the `strict` switch that aborts the run on an automatic-compaction summarizer failure instead of the lenient default. |
| `AgentRunOptions`        | interface | `{ think?, schema?, limit?, timeout?, budget?, allowance?, signal?, conversation?, prompt? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Carries overrides for one call to the `generate` or `stream` method of an `AgentInterface`. Each member overrides the matching `AgentOptions` value, while `signal` composes with the construction signal, `conversation` binds the run to one conversation, and `prompt` adds the run's user turn to it.                                                                                                                                                             |
| `AgentInterface`         | interface | `{ emitter, id, status, context, generate(), stream(), abort() }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Composes a `ProviderInterface`, an `AgentContextInterface`, and a `ToolManagerInterface` into a bounded context → provider → tools → repeat turn.                                                                                                                                                                                                                                                                                                                     |
| `AuthorityContext`       | interface | `{ call }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Carries what an `AuthorityInterface` evaluates for one tool call — the call under consideration.                                                                                                                                                                                                                                                                                                                                                                      |
| `AuthorityVerdict`       | type      | `'allow' \| 'ask' \| 'deny'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Names an authority's verdict on one tool call.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AuthorityDecision`      | interface | `{ zone, verdict, reason? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Holds the authority verdict on one tool call.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `AuthorityRule`          | interface | `{ match, zone, verdict?, reason? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Represents one ordered policy rule an `AuthorityInterface` evaluates.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `AuthorityHandler`       | type      | `(context: AuthorityContext, decision: AuthorityDecision, signal: AbortSignal) => boolean \| Promise<boolean>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Answers one `ask`; only a resolved `true` approves.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `AuthorityOptions`       | interface | `{ rules?, fallback?, ask? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Configures `createAuthority` — the ordered rules, the no-match fallback, and the approver.                                                                                                                                                                                                                                                                                                                                                                            |
| `AuthorityInterface`     | interface | `{ evaluate(), ask?() }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Gates each tool call before it runs — the synchronous policy that turns one `AuthorityContext` into an `AuthorityDecision`, and the optional approver that answers an `ask` verdict.                                                                                                                                                                                                                                                                                  |
| `AuthorityNote`          | interface | `{ denied, refused, unanswered }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Holds the model-facing texts the loop writes into a denial result.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AgentJobInput`          | interface | `{ provider, messages, system?, tools?, authority?, scheduler?, limit?, timeout?, budget?, children? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Represents a JSON-serializable agent job — the descriptor a durable queue or runner runs. Its non-serializable pieces (the provider, tools, authority, scheduler) are referenced by name and resolved to live objects through an `AgentRegistryInterface` at handler time, while its data fields (the seed `messages`, `system`, `limit`, `timeout`, and a token `budget` ceiling) carry directly.                                                                    |
| `AgentRegistryInterface` | interface | `{ provider(), tool(), authority(), scheduler(), build() }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Resolves the names in an `AgentJobInput` to live dependencies and rehydrates a seeded, signal-wired `AgentInterface`.                                                                                                                                                                                                                                                                                                                                                 |
| `AgentRegistryOptions`   | interface | `{ providers, tools?, authorities?, schedulers?, store? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Configures the named pools of live dependencies used by `createAgentRegistry` and the optional durable store shared by built agents.                                                                                                                                                                                                                                                                                                                                  |
| `AgentQueueOptions`      | interface | `{ registry, partial?, concurrency?, retries?, timeout?, store? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Configures `createAgentQueue` — the registry that rehydrates jobs, the partial-result policy, and the substrate knobs threaded into the backing `createQueue`.                                                                                                                                                                                                                                                                                                        |
| `AgentRunnerOptions`     | interface | `{ registry, partial?, concurrency?, retries?, timeout? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Configures `createAgentRunner` — the registry that rehydrates jobs, the partial-result policy, and the substrate knobs threaded into the backing `createRunner`.                                                                                                                                                                                                                                                                                                      |

#### Constants

The following table lists the constants the agents module declares:

| Name                     | Kind  | Signature                                                                              | Summary                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_AGENT_LIMIT`    | const | `10`                                                                                   | Caps an `AgentInterface` turn's tool iterations by default — `10` context → provider → tools cycles before the loop stops, so a model that keeps requesting tools can never loop forever. Overridable per agent through `AgentOptions.limit`.                                                                                         |
| `DEFAULT_AUTHORITY_ZONE` | const | `"default"`                                                                            | Names the default zone for an unmatched tool call allowed by an authority.                                                                                                                                                                                                                                                            |
| `AUTHORITY_NOTES`        | const | `AuthorityNote`                                                                        | Holds the model-facing texts the loop writes after a tool name in a denial result — the `denied` note for a deny with no reason, an evaluate throw, an invalid decision, or a tool changed after its decision; the `refused` note for an ask the approver refused; and the `unanswered` note for an ask no approver answered, frozen. |
| `SCOPE_NOTE`             | const | `"it is not one of the listed tools. Use a listed tool or answer with what you have."` | Holds the model-facing text the loop writes after a tool name in the denial result of a call outside the active scope's tool allow-list or whose name no definition advertises this turn.                                                                                                                                             |
| `MESSAGE_TOKEN_OVERHEAD` | const | `4`                                                                                    | Estimates the role and framing overhead added to each message by `estimateMessages`.                                                                                                                                                                                                                                                  |
| `IMAGE_TOKEN_ESTIMATE`   | const | `512`                                                                                  | Names the coarse, deliberately approximate per-image token cost `estimateMessages` charges for each attached image — `512`, because a base64 payload's length is no reliable token proxy.                                                                                                                                             |

#### Errors

The following table lists the errors the agents module declares and the guards that narrow them:

| Name              | Kind     | Signature                                                                                | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------- | -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AgentJobError`   | class    | `new (message: string, partial: AgentResult) => AgentJobError`                           | Reports an `AgentInterface` run that ended `AgentResult.partial` under a `partial` policy of `false` (the default) — thrown by an agent-job handler (a `createAgentQueue` / `createAgentRunner` job), carrying the partial `AgentResult` so the failure stays inspectable, and the machine-readable `code` `'PARTIAL'`.                                                                                                                                                                                                                                                                                                                                                        |
| `isAgentJobError` | function | `(value: unknown) => value is AgentJobError`                                             | Narrows an unknown caught value to an `AgentJobError` through its identity brand and declared members, so a `catch` can recover its `partial` result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AgentError`      | class    | `new (code: AgentErrorCode, message: string, options?: CodedErrorOptions) => AgentError` | Reports an `ask` on an authority that has no approver or that its approver refuses, a run sharing accounting or a conversation with a live run, a `limit` that is not a nonnegative safe integer, a name absent from a registry pool, or a strict run whose request exceeds its window. Agent construction, the `stream` and `generate` methods, and registry accessors throw synchronously, before returning a handle or promise; a `'WINDOW'` refusal rejects the run's `result` instead, and an `'APPROVER'` refusal rejects the promise the `ask` method of an `Authority` or the `ask` handler of an `Approver` returns. Await the call inside `try`/`catch` to catch it. |
| `isAgentError`    | function | `(value: unknown) => value is AgentError`                                                | Narrows an unknown caught value to an `AgentError` through its identity brand and declared members, so a `catch` can branch on its `code`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

#### Shapes and contracts

The following table lists the agent wire shapes and the contracts compiled from them:

| Name                  | Kind  | Signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Summary                                                                                                                                                 |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentFrameShape`     | const | `import("@orkestrel/contract").UnionShape<readonly [import("@orkestrel/contract").ObjectShape<{ category: import("@orkestrel/contract").LiteralShape<readonly ["token"]>; content: import("@orkestrel/contract").StringShape; }, boolean \| ContractShape>, import("@orkestrel/contract").ObjectShape<{ category: import("@orkestrel/contract").LiteralShape<readonly ["think"]>; content: import("@orkestrel/contract").StringShape; }, boolean \| ContractShape>, import("@orkestrel/contract").ObjectShape<{ category: import("@orkestrel/contract").LiteralShape<readonly ["tool"]>; success: import("@orkestrel/contract").LiteralShape<readonly [true]>; name: import("@orkestrel/contract").StringShape; }, boolean \| ContractShape>, import("@orkestrel/contract").ObjectShape<{ category: import("@orkestrel/contract").LiteralShape<readonly ["tool"]>; success: import("@orkestrel/contract").LiteralShape<readonly [false]>; }, boolean \| ContractShape>, import("@orkestrel/contract").ObjectShape<{ category: import("@orkestrel/contract").LiteralShape<readonly ["usage"]>; usage: import("@orkestrel/contract").ObjectShape<{ prompt: import("@orkestrel/contract").NumberShape; completion: import("@orkestrel/contract").NumberShape; total: import("@orkestrel/contract").NumberShape; }, boolean \| ContractShape>; estimate: import("@orkestrel/contract").NumberShape; }, boolean \| ContractShape>, import("@orkestrel/contract").ObjectShape<{ category: import("@orkestrel/contract").LiteralShape<readonly ["ask"]>; id: import("@orkestrel/contract").StringShape; name: import("@orkestrel/contract").StringShape; zone: import("@orkestrel/contract").StringShape; arguments: import("@orkestrel/contract").StringShape; }, boolean \| ContractShape>, import("@orkestrel/contract").ObjectShape<{ category: import("@orkestrel/contract").LiteralShape<readonly ["finish"]>; content: import("@orkestrel/contract").StringShape; partial: import("@orkestrel/contract").BooleanShape; usage: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ObjectShape<{ prompt: import("@orkestrel/contract").NumberShape; completion: import("@orkestrel/contract").NumberShape; total: import("@orkestrel/contract").NumberShape; }, boolean \| ContractShape>>; layer: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").LiteralShape<readonly ["meter", "budget", "model"]>>; }, boolean \| ContractShape>, import("@orkestrel/contract").ObjectShape<{ category: import("@orkestrel/contract").LiteralShape<readonly ["error"]>; }, boolean \| ContractShape>]>` | Describes the agent frame wire — one exact object per `AgentFrame` arm, discriminated by `category`.                                                    |
| `agentPromptShape`    | const | `import("@orkestrel/contract").ObjectShape<{ content: import("@orkestrel/contract").StringShape; images: import("@orkestrel/contract").OptionalShape<import("@orkestrel/contract").ArrayShape<import("@orkestrel/contract").StringShape>>; }, boolean \| ContractShape>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Describes the agent prompt wire — the `content` and optional `images` of one user turn, read by the run's `prompt` option and by a page's request body. |
| `agentAnswerShape`    | const | `import("@orkestrel/contract").ObjectShape<{ id: import("@orkestrel/contract").StringShape; approved: import("@orkestrel/contract").BooleanShape; }, boolean \| ContractShape>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Describes the agent answer wire — the `id` of one `ask` frame and a boolean `approved`.                                                                 |
| `agentFrameContract`  | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ category: "token"; content: string; } & {}> \| Readonly<{ category: "think"; content: string; } & {}> \| Readonly<{ category: "tool"; success: true; name: string; } & {}> \| Readonly<{ category: "tool"; success: false; } & {}> \| Readonly<{ category: "usage"; usage: Readonly<{ prompt: number; completion: number; total: number; } & {}>; estimate: number; } & {}> \| Readonly<{ category: "ask"; id: string; name: string; zone: string; arguments: string; } & {}> \| Readonly<{ category: "finish"; content: string; partial: boolean; } & { usage?: Readonly<{ prompt: number; completion: number; total: number; } & {}>; layer?: "budget" \| "meter" \| "model"; }> \| Readonly<{ category: "error"; } & {}>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Validates and projects agent frames at a JSON wire boundary.                                                                                            |
| `agentPromptContract` | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ content: string; } & { images?: readonly string[]; }>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Validates and projects agent prompts at the run's `prompt` option and a page's request body.                                                            |
| `agentAnswerContract` | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ id: string; approved: boolean; } & {}>>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Validates and projects a page's answers to `ask` frames at a JSON wire boundary.                                                                        |

#### Factories

The following table lists the factories the agents module declares:

| Name                  | Kind     | Signature                                                                      | Summary                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | -------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAgent`         | function | `(provider: ProviderInterface, options?: AgentOptions) => AgentInterface`      | Creates an agent loop — an `AgentInterface` composing a `ProviderInterface`, its `AgentContextInterface`, and a tool registry into a bounded context → provider → tools → repeat turn, exposed as a one-shot `generate` and a live `stream`.                                                                                                                |
| `createAuthority`     | function | `(options?: AuthorityOptions) => AuthorityInterface`                           | Creates a policy gate — an `AuthorityInterface` the agent loop consults before each tool call runs, evaluating the ordered rules first-match-wins and falling back to the configured default when none match.                                                                                                                                               |
| `createApprover`      | function | `() => ApproverInterface`                                                      | Creates an approver — an `ApproverInterface` that holds a server's waiting asks between the run that asked them and the page that answers them.                                                                                                                                                                                                             |
| `createChannel`       | function | `<T>() => ChannelInterface<T>`                                                 | Creates an empty unbounded async channel — a `ChannelInterface` a producer writes values into (`push`) and ends (`close` / `fail`) regardless of consumption, while a consumer reads them back live through `drain`.                                                                                                                                        |
| `createAgentRegistry` | function | `(options: AgentRegistryOptions) => AgentRegistryInterface`                    | Creates a registry of live providers, tools, authorities, and schedulers whose `build` method returns a seeded, signal-wired `AgentInterface` from a serializable job.                                                                                                                                                                                      |
| `createAgentQueue`    | function | `(options: AgentQueueOptions) => QueueInterface<AgentJobInput, AgentResult>`   | Creates a durable, bounded-concurrency agent-job queue — a `QueueInterface` over serializable values of `AgentJobInput` that composes `createQueue`: each job is rehydrated through the `registry` into a live `AgentInterface`, run to its `AgentResult`, and subjected to the partial-as-configurable-failure policy.                                     |
| `createAgentRunner`   | function | `(options: AgentRunnerOptions) => RunnerInterface<AgentJobInput, AgentResult>` | Creates an agent-job runner — a `RunnerInterface` over serializable values of `AgentJobInput` that composes `createRunner` (one-shot, ordered, fail-fast), each unit rehydrated through the `registry` and subjected to the partial policy. The runner also carries sub-agent fan-out: a parent job's handler can call `controller.spawn` with a child job. |

#### Classes

The following table lists the classes the agents module declares:

| Name            | Kind  | Signature                                                                     | Summary                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ----- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agent`         | class | `new (provider: ProviderInterface, options?: AgentOptions) => AgentInterface` | Composes a `ProviderInterface`, an `AgentContext`, and a `ToolManagerInterface` into a bounded context → provider → tools → repeat turn, exposed as both a one-shot `generate` and a live `stream` that share one private run — bounded by the run `signal`, the `timeout`, and the `budget` folded through `AbortSignal.any`, paced by `scheduler`, with tool iteration capped at `limit`.                      |
| `AgentFanout`   | class | `new (registry: AgentRegistryInterface, partial: boolean) => AgentFanout`     | Executes one runner's agent jobs — spawning each unit's declared children on its first attempt only, then rehydrating the unit through a registry with the controller signal and settling it under the shared partial-result policy.                                                                                                                                                                             |
| `Authority`     | class | `new (options?: AuthorityOptions) => AuthorityInterface`                      | Gates the agent loop's tool calls — the synchronous policy consulted before each call runs, turning one `AuthorityContext` into an `AuthorityDecision` by walking the ordered rules first-match-wins and falling back to a configurable default, which allows an unmatched call unless its `fallback` decides otherwise, and the approver that answers an `ask` verdict.                                         |
| `Approver`      | class | `new () => ApproverInterface`                                                 | Holds a server's waiting asks between the run that asked them and the page that answers them — an `ApproverInterface` whose `ask` is the authority's handler, keyed by the asked call object.                                                                                                                                                                                                                    |
| `AgentRegistry` | class | `new (options: AgentRegistryOptions) => AgentRegistryInterface`               | Makes a durable, JSON-serializable `AgentJobInput` runnable — holds the named pools of live, non-serializable pieces (providers, tools, authorities, schedulers), throws on a name absent from its pool, and its `build` method returns a seeded, signal-wired `Agent` from a job's names and data.                                                                                                              |
| `Channel`       | class | `new <T>() => ChannelInterface<T>`                                            | Buffers chunks in a minimal unbounded async channel — the eager pump writes them in (`push`) and ends it (`close` / `fail`) regardless of consumption, while a consumer reads them back live through the `drain` async-iterator. Decoupling write from read is what lets a producer make progress without a consumer pulling, and it is why an agent's `result` settles whether or not its `events` are drained. |

#### Helpers

The following table lists the helpers the agents module declares:

| Name                  | Kind     | Signature                                                                                                                                                                                            | Summary                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentResultToJSON`   | function | `(value: unknown) => JSONValue \| undefined`                                                                                                                                                         | Projects an unknown value onto a fresh, exact `JSONValue` representation of an `AgentResult` — capturing each structural field once through a total boundary, accepting conforming accessors and inherited properties, preserving finite negative and fractional usage counts, dropping extras, and resolving `undefined` for a malformed field, a non-finite usage number, a throwing getter, or a malformed or revoked proxy. |
| `tokenUsageToJSON`    | function | `(value: unknown) => TokenUsage \| undefined`                                                                                                                                                        | Projects an unknown value onto a fresh, exact `TokenUsage` — capturing `prompt`, `completion`, and `total` once each through a total boundary, preserving finite negative and fractional counts, dropping extras, and resolving `undefined` for a non-object, a missing or non-finite count, a throwing getter, or a malformed or revoked proxy.                                                                                |
| `agentChunkToFrame`   | function | `(chunk: AgentChunk) => AgentFrame \| undefined`                                                                                                                                                     | Projects one `AgentChunk` onto the `AgentFrame` a page receives, member by member, or returns `undefined` for an `ask` chunk.                                                                                                                                                                                                                                                                                                   |
| `agentResultToFrame`  | function | `(result: AgentResult) => Extract<AgentFrame, { readonly category: 'finish'; }>`                                                                                                                     | Projects a settled `AgentResult` onto the terminal `finish` frame a page receives.                                                                                                                                                                                                                                                                                                                                              |
| `agentStreamToFrames` | function | `(stream: AgentStreamInterface, approver: ApproverInterface \| undefined) => AsyncGenerator<AgentFrame, void, undefined>`                                                                            | Projects a run's live handle onto the frames a page receives — one frame per projected chunk, in order, then exactly one terminal `finish` or `error`, last.                                                                                                                                                                                                                                                                    |
| `inferStop`           | function | `(reason: unknown, allowance: BudgetInterface<TokenUsage> \| undefined, budget: BudgetInterface<TokenUsage> \| undefined, provider: string, turn: AgentTurn \| undefined) => AgentStop \| undefined` | Infers which of a run's three failure layers stopped it — the meter allowance, a cost budget, or the model's own token limit — and returns the stop record with the final call's readings, or `undefined` when no layer stopped the run.                                                                                                                                                                                        |
| `estimateTokens`      | function | `(text: string) => number`                                                                                                                                                                           | Estimates the context-token footprint of a string — the deterministic `ceil(length / 4)` character heuristic `estimateMessages` sums over a conversation's messages (the default context-budget estimator).                                                                                                                                                                                                                     |
| `estimateMessages`    | function | `(messages: readonly Message[]) => number`                                                                                                                                                           | Estimates the context-token footprint of a batch of messages — each message's content plus `MESSAGE_TOKEN_OVERHEAD`, a tool-call JSON estimate, a thinking estimate, and `IMAGE_TOKEN_ESTIMATE` for each attached image. The `estimateRequest` message term for an agent's context budget (the `AgentOptions` `window`), a provider-independent approximation for conforming messages rather than an exact tokenizer count.     |
| `estimateRequest`     | function | `(request: ProviderRequest) => number`                                                                                                                                                               | Estimates the context-token footprint of a complete provider request — its messages through `estimateMessages`, plus the rendered advertised `tools`, plus the rendered `options.schema`. The `consumer` estimator an agent's `window` budget measures every request through, a provider-independent heuristic rather than an exact tokenizer count.                                                                            |
| `measureMessage`      | function | `(message: Message) => MessageMeasure`                                                                                                                                                               | Measures the disjoint estimate components of one message — its content, framing, rendered calls, thinking, and attached images — as the same heuristic units `estimateMessages` sums.                                                                                                                                                                                                                                           |
| `measureRequest`      | function | `(request: ProviderRequest) => RequestMeasure`                                                                                                                                                       | Measures the disjoint estimate components of a complete provider request — each message through `measureMessage`, plus the rendered advertised `tools` and `options.schema` — as the same heuristic units `estimateRequest` sums.                                                                                                                                                                                               |
| `settleAgentJob`      | function | `(agent: AgentInterface, partial: boolean) => Promise<AgentResult>`                                                                                                                                  | Runs one rehydrated agent and applies the partial-as-configurable-failure policy — a partial run throws an `AgentJobError` unless the `partial` policy allows it, and a natural finish resolves. The shared job-handler step `createAgentQueue` and `createAgentRunner` both settle each job through, so the policy can never diverge between them.                                                                             |
| `handleAgentQueueJob` | function | `(registry: AgentRegistryInterface, partial: boolean, input: AgentJobInput, context: QueueContext) => Promise<AgentResult>`                                                                          | Handles one queued agent job by rehydrating it through a registry with the queue attempt's signal, then applying the shared partial-result policy.                                                                                                                                                                                                                                                                              |
| `assembleResult`      | function | `(outcome: AgentRunResult) => AgentResult`                                                                                                                                                           | Assembles the settled `AgentResult` from a run's `AgentRunResult` — `thinking`, `usage`, and `stop` are carried only when the run surfaced them, and the loop-internal `exhausted` flag is left out.                                                                                                                                                                                                                            |
| `denyCall`            | function | `(call: ToolCall, reason: string \| undefined) => ToolResult`                                                                                                                                        | Synthesizes the denial `ToolResult` a blocked call is fed back with — the call's `id` / `name` keyed back, carrying a denial `error` instead of a value.                                                                                                                                                                                                                                                                        |
| `renderArguments`     | function | `(value: Readonly<Record<string, unknown>>) => string \| undefined`                                                                                                                                  | Renders a tool call's arguments as escaped canonical JSON text — sorted keys, with every control, format, line-separator, and paragraph-separator code point written as `\uXXXX` — or returns `undefined` when they cannot be rendered.                                                                                                                                                                                         |
| `resolveDecision`     | function | `(decision: AuthorityDecision, definition: ToolDefinition \| undefined) => AuthorityDecision`                                                                                                        | Applies the `consequential` floor to one `AuthorityDecision` — an `allow` for a tool whose advertised definition is annotated `consequential` becomes an `ask`.                                                                                                                                                                                                                                                                 |
| `chargeUsage`         | function | `(budget: BudgetInterface<TokenUsage> \| undefined, usage: TokenUsage, charged: number) => void`                                                                                                     | Consumes a reported usage against a budget over what was already charged, so a turn's total draw is never less than the report and nothing is charged twice.                                                                                                                                                                                                                                                                    |
| `requireLimit`        | function | `(limit: number) => number`                                                                                                                                                                          | Returns a tool-iteration cap after checking it is a nonnegative safe integer, or throws a coded error.                                                                                                                                                                                                                                                                                                                          |
| `requireBudget`       | function | `(value: BudgetInterface<TokenUsage> \| undefined, key: 'budget' \| 'allowance') => BudgetInterface<TokenUsage> \| undefined`                                                                        | Returns a run's budget or allowance after checking it implements `BudgetInterface`, or throws a coded error before the run starts it.                                                                                                                                                                                                                                                                                           |
| `requireConversation` | function | `(value: unknown) => ConversationInterface \| undefined`                                                                                                                                             | Returns a run's `conversation` option after checking it implements `ConversationInterface`, or throws a coded error before the run starts.                                                                                                                                                                                                                                                                                      |
| `renderToolValue`     | function | `(value: unknown) => string`                                                                                                                                                                         | Renders a tool's output as the string content of its tool message.                                                                                                                                                                                                                                                                                                                                                              |
| `requireEntry`        | function | `<T>(pool: ReadonlyMap<string, T>, category: string, name: string) => T`                                                                                                                             | Returns a registered value or throws when its name is absent.                                                                                                                                                                                                                                                                                                                                                                   |
| `extractQueueOptions` | function | `(options: Pick<QueueOptions<AgentJobInput, AgentResult>, 'concurrency' \| 'retries' \| 'timeout'>) => Pick<QueueOptions<AgentJobInput, AgentResult>, 'concurrency' \| 'retries' \| 'timeout'>`      | Extracts the present concurrency, retry, and deadline options for an agent job queue.                                                                                                                                                                                                                                                                                                                                           |

The measures are structural estimates, not tokenizer allocations. A message's `id` and `role` join a measure back to its message and are not token components, and a provider's template effects and the estimation error are not individually attributed.

Project an agent result at its originating package before carrying it through a JSON boundary:

```ts
import type { AgentResult } from '@orkestrel/agent'
import { agentResultToJSON } from '@orkestrel/agent'

declare const result: AgentResult
const portable = agentResultToJSON(result)
if (portable === undefined) throw new Error('invalid agent result')
JSON.stringify(portable)
```

The queue factory binds its named handler to a registry and partial policy, and the runner factory binds the `execute` method of one `AgentFanout` per runner; callers composing the lower-level substrates can do the same:

```ts
import type { AgentRegistryInterface } from '@orkestrel/agent'
import {
	AgentFanout,
	handleAgentQueueJob,
	renderToolValue,
	requireLimit,
	sanitizeToken,
} from '@orkestrel/agent'

declare const registry: AgentRegistryInterface

const tokens = sanitizeToken(12.7) // 12
const limit = requireLimit(3) // 3
const content = renderToolValue({ count: 2 }) // '{"count":2}'
const queueHandler = handleAgentQueueJob.bind(undefined, registry, false)
const fanout = new AgentFanout(registry, false) // one per runner: it records the units it fanned out
const runnerHandler = fanout.execute.bind(fanout)
```

#### Validators

The following table lists the guards the agents module declares:

| Name                  | Kind     | Signature                                        | Summary                                                                                                                                                                      |
| --------------------- | -------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isAuthorityDecision` | function | `(value: unknown) => value is AuthorityDecision` | Checks whether a value is an authority decision: an object whose `zone` is a string, whose `verdict` is `allow`, `ask`, or `deny`, and whose `reason` is absent or a string. |

### Ledgers module

The `ledgers` module serves a conversation through event-sourced records: the `Ledger` entity, the `LedgerRequest` class that holds one request's state while it is served, the `Classifier` class that files messages through a judge, the `Gauge` class that prices a prompt, and the pure projection helpers. For the method, see [Serving a conversation through a ledger](#serving-a-conversation-through-a-ledger); for a ledger built end to end, see [Serving requests through a ledger](#serving-requests-through-a-ledger).

#### Types

The following table lists the types the ledger declares, each with its shape:

| Name                      | Kind      | Signature                                                                                                                                                                    | Summary                                                                                                                                                                                                                                      |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LedgerCategory`          | type      | `(typeof LEDGER_CATEGORIES)[number]`                                                                                                                                         | Names the category the ledger files a message under, one of `LEDGER_CATEGORIES`.                                                                                                                                                             |
| `LedgerQuestion`          | interface | `{ category, topic, amends, supersedes }`                                                                                                                                    | Carries the wording of every question the ledger asks its judge.                                                                                                                                                                             |
| `LedgerThreshold`         | interface | `{ category, topic, amends, supersedes, correction }`                                                                                                                        | Carries the probability cutoff of each reading the ledger takes from its judge.                                                                                                                                                              |
| `LedgerTopic`             | interface | `{ name, criterion, requested? }`                                                                                                                                            | Carries one desk topic: the subject the ledger asks its judge about for statements and, when enabled, requests.                                                                                                                              |
| `LedgerShare`             | interface | `{ prompt, tail }`                                                                                                                                                           | Carries the share of the context capacity the prompt can take and the share of that budget the tail can take.                                                                                                                                |
| `LedgerNote`              | interface | `{ cue, results, repeat, closure }`                                                                                                                                          | Carries the text of each note the ledger writes into its conversation or returns to the model.                                                                                                                                               |
| `LedgerRecallOptions`     | interface | `{ limit? }`                                                                                                                                                                 | Configures the ledger's `recall` tool.                                                                                                                                                                                                       |
| `LedgerCorrectionOptions` | interface | `{ narrow? }`                                                                                                                                                                | Narrows the pair questions the ledger asks about each correction.                                                                                                                                                                            |
| `LedgerOwner`             | interface | `{ id, names }`                                                                                                                                                              | Carries one owner a lookup result names: its id and the names it goes by.                                                                                                                                                                    |
| `LedgerLookupResult`      | interface | `{ ids, owners }`                                                                                                                                                            | Carries what a lookup handler read from one lookup result: the ids it names and the owners among them.                                                                                                                                       |
| `LedgerLookupHandler`     | type      | `(args: Readonly<Record<string, unknown>>, text: string) => LedgerLookupResult \| undefined`                                                                                 | Reads one successful lookup result into the ids and owners it names.                                                                                                                                                                         |
| `LedgerLookup`            | interface | `{ tool, read }`                                                                                                                                                             | Carries one application lookup: the tool the model calls and the handler that reads its results.                                                                                                                                             |
| `LedgerLookupFinding`     | interface | `{ id, name, arguments, text, result }`                                                                                                                                      | Carries one successful lookup result as the ledger read it.                                                                                                                                                                                  |
| `LedgerLookupState`       | type      | `'failed' \| 'empty' \| 'shown' \| 'hidden'`                                                                                                                                 | Names what became of a lookup of an earlier request, as the tail stub of its result reports it.                                                                                                                                              |
| `LedgerRegistry`          | interface | `{ ids, owners }`                                                                                                                                                            | Carries the ids the ledger's lookups named and the owners among them.                                                                                                                                                                        |
| `LedgerIndex`             | interface | `{ ids, aliases, carriers, names, words, keys, ranks }`                                                                                                                      | Carries a registry prepared for matching: its ids, each owner name's owners, and the compiled needles.                                                                                                                                       |
| `LedgerGauge`             | interface | `{ scale, overhead }`                                                                                                                                                        | Carries the price of a prompt in tokens, measured against the model the ledger serves.                                                                                                                                                       |
| `LedgerAgentOptions`      | type      | `Pick<AgentOptions, 'limit' \| 'timeout' \| 'on' \| 'scheduler' \| 'instructions' \| 'skills' \| 'memos' \| 'workspaces'>`                                                   | Selects the agent bounds, hooks, scheduler, and context libraries a ledger passes through to the agent it builds.                                                                                                                            |
| `LedgerOptions`           | interface | `{ judge, system, topics, questions, thresholds, capacity, predict?, think?, gauge?, lookups?, share?, recall?, correction?, agent?, snapshot? }`                            | Configures a ledger: its judge and the wording and cutoffs it files with, the desk topics, the context capacity, and the optional first-pass thinking, lookups, gauge, shares, snapshot, recall limit, correction filter, and agent options. |
| `LedgerSnapshot`          | interface | `{ conversation, requests, notes, failures, gauge? }`                                                                                                                        | Holds the JSON-serializable state a ledger hydrates from: its conversation and the message ids it marked.                                                                                                                                    |
| `LedgerResult`            | interface | `{ passes, attempts }`                                                                                                                                                       | Carries the outcome of one request a ledger served: the agent result of its reply and every pass it took.                                                                                                                                    |
| `LedgerInterface`         | interface | `{ agent, conversation, gauge, respond(), calibrate(), snapshot() }`                                                                                                         | Serves the requests of one conversation through an agent whose prompt the ledger projects from what the judge filed.                                                                                                                         |
| `LedgerRequestInterface`  | interface | `{ message, plan, selection, boundary, usage, calls, attempts, enter(), open(), adopt(), observe(), spend(), think(), file(), admit(), recall(), close(), list(), lines() }` | Holds what one `respond` call of a ledger keeps while it serves its request: the request message, the filing attempts and the plan its selections produced, the gauge calls of its passes, and its repeat and recall stops.                  |
| `LedgerWordSet`           | interface | `{ words, names }`                                                                                                                                                           | Carries the lowercase words and non-opening capitalized names of a message.                                                                                                                                                                  |
| `LedgerClassification`    | interface | `{ quiet, categories, topics, amendments, supersessions }`                                                                                                                   | Carries the ledger's filing of its conversation's messages, keyed by message id.                                                                                                                                                             |
| `LedgerLine`              | interface | `{ text, source, sentence, party?, topics, role }`                                                                                                                           | Carries one record line: a sentence of a live message, verbatim except that a sentence that opens with a pronoun opens with its party and a colon.                                                                                           |
| `LedgerRecord`            | interface | `{ key, title, members, lines }`                                                                                                                                             | Carries one record: the live messages placed on one owner or on the rules, as lines.                                                                                                                                                         |
| `LedgerAmendment`         | interface | `{ earlier, later }`                                                                                                                                                         | Identifies an accepted direct message amendment whose sentence scope remains unresolved.                                                                                                                                                     |
| `LedgerRenderContext`     | interface | `{ amendments, complete, first, references }`                                                                                                                                | Supplies accepted amendments and completely included sources for one rendering of the records.                                                                                                                                               |
| `LedgerProjection`        | interface | `{ records, amendments, orphans }`                                                                                                                                           | Carries the records projected from a conversation, accepted amendments, and the live messages no record placed.                                                                                                                              |
| `LedgerProjectionInput`   | interface | `{ system, exclusions, owners, messages, findings, entities, classification }`                                                                                               | Carries what a projection reads.                                                                                                                                                                                                             |
| `LedgerProjectionRequest` | interface | `{ owners, topics }`                                                                                                                                                         | Carries the owners and the desk topics one request names, which select its records.                                                                                                                                                          |
| `LedgerCategoryHandler`   | type      | `(message: Message) => LedgerCategory \| undefined`                                                                                                                          | Reads a message's category from its shape, or returns undefined to leave it to the judge.                                                                                                                                                    |
| `LedgerEntityHandler`     | type      | `(text: string, partial: boolean) => ReadonlySet<string>`                                                                                                                    | Lists the registry ids and owner ids a text names.                                                                                                                                                                                           |
| `ClassifierOptions`       | interface | `{ conversation, judge, questions, topics, thresholds, assign, entities, correction?, scheduler? }`                                                                          | Configures a classifier: the conversation it files, the judge and the wording it asks with, the desk topics, the cutoffs, the ledger's handlers, and the optional correction filter and scheduler.                                           |
| `ClassifierPhase`         | type      | `'category' \| 'topic' \| 'amends' \| 'supersedes'`                                                                                                                          | Names the filing question a classifier asked: a message's category, a message's topic, or an earlier and later message's amendment or supersession.                                                                                          |
| `ClassifierOutcome`       | type      | `'cached' \| 'skipped' \| 'resolved' \| 'failed' \| 'aborted'`                                                                                                               | Names what became of one filing question.                                                                                                                                                                                                    |
| `ClassifierAttempt`       | interface | `{ key, phase, outcome, duration? }`                                                                                                                                         | Carries what became of one filing question: its judgment key, its phase, its outcome, and the time spent resolving it.                                                                                                                       |
| `ClassifierResult`        | interface | `{ judgments, usage?, attempts, fault? }`                                                                                                                                    | Carries the judgment keys one classification rests on and the judge usage it spent.                                                                                                                                                          |
| `ClassifierInterface`     | interface | `{ classify(), category(), quiet(), decisive(), topics(), classification() }`                                                                                                | Files a conversation's messages through a judge and reads the filing.                                                                                                                                                                        |
| `GaugeCall`               | interface | `{ estimate, prompt?, completion?, thinking?, tools }`                                                                                                                       | Carries one agent call as the gauge reads it.                                                                                                                                                                                                |
| `GaugeOptions`            | interface | `{ capacity, predict?, replay? }`                                                                                                                                            | Configures a gauge: its starting price of a prompt and the context capacity it measures against.                                                                                                                                             |
| `GaugeInterface`          | interface | `{ rate(), remainder(), reserve(), room(), observe() }`                                                                                                                      | Prices prompts in tokens and measures the room a request has left.                                                                                                                                                                           |
| `LedgerPlanGroup`         | type      | `1 \| 2 \| 3`                                                                                                                                                                | Names the planning group of a source the records render: a topic match, an off-topic rule or correction, or a name match.                                                                                                                    |
| `LedgerErrorCode`         | type      | `'REQUEST' \| 'THRESHOLD' \| 'SHARE' \| 'CAPACITY' \| 'LIMIT' \| 'TOPIC' \| 'LOOKUP' \| 'GAUGE' \| 'REFERENCE' \| 'SNAPSHOT'`                                                | Names the machine-readable conditions a `LedgerError` error reports.                                                                                                                                                                         |

#### Constants

The following table lists the constants that hold the ledger's categories, record keys, measured wording, shares, and limits:

| Name                        | Kind  | Signature                                                                                | Summary                                                                                                                                                      |
| --------------------------- | ----- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LEDGER_CATEGORIES`         | const | `readonly ["fact", "rule", "correction", "request", "opinion", "chatter", "distractor"]` | Lists the categories the ledger files a message under, in the order the category question names them — the one list the `LedgerCategory` union derives from. |
| `QUIET_CATEGORIES`          | const | `readonly LedgerCategory[]`                                                              | Lists the categories whose messages the projection leaves out as quiet.                                                                                      |
| `DECISIVE_CATEGORIES`       | const | `readonly LedgerCategory[]`                                                              | Lists the categories whose messages state what the desk acts on, which the records render.                                                                   |
| `PLACED_CATEGORIES`         | const | `readonly LedgerCategory[]`                                                              | Lists the categories that place a message no owner claims on the rules record.                                                                               |
| `LEDGER_RULES_KEY`          | const | `"rules"`                                                                                | Names the key of the record that holds the rules no owner claims.                                                                                            |
| `LEDGER_OWNER_PREFIX`       | const | `"owner:"`                                                                               | Prefixes the key of an owner's record, which the owner's id follows.                                                                                         |
| `LEDGER_QUESTIONS`          | const | `LedgerQuestion`                                                                         | Supplies the wording of every question the ledger asks its judge.                                                                                            |
| `LEDGER_NOTES`              | const | `LedgerNote`                                                                             | Supplies the text of each ledger note, worded for a model that answers in its final message.                                                                 |
| `DEFAULT_LEDGER_SHARE`      | const | `LedgerShare`                                                                            | Supplies the default prompt and tail shares.                                                                                                                 |
| `DEFAULT_LEDGER_LIMIT`      | const | `8`                                                                                      | Caps the tool-iteration turns of a ledger's agent at 8 turns.                                                                                                |
| `DEFAULT_RECALL_LIMIT`      | const | `2`                                                                                      | Caps the `recall` calls of one request at 2 calls.                                                                                                           |
| `LEDGER_SLICE`              | const | `5`                                                                                      | Sets the 5 milliseconds a paced classifier files between host turns.                                                                                         |
| `LEDGER_SCALE_DRIFT`        | const | `0.06`                                                                                   | Holds back the share of the prompt budget the scale can rise by between calibration and a request's first call.                                              |
| `LEDGER_WORD`               | const | `RegExp`                                                                                 | Matches a run of letters and digits, which the ledger reads as one word.                                                                                     |
| `DETERMINISTIC_JUDGE_ERROR` | const | `RegExp`                                                                                 | Matches the logprob decoding failure `invalid or duplicate top logprob token`, which the ledger holds for the ledger's life.                                 |

#### Errors

The following table lists the error the ledger raises and the guard that narrows it:

| Name            | Kind     | Signature                                                     | Summary                                                                                                                                    |
| --------------- | -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `LedgerError`   | class    | `new (code: LedgerErrorCode, message: string) => LedgerError` | Reports an invalid ledger configuration, failed calibration, or unowned request selection, carrying the machine-readable `code`.           |
| `isLedgerError` | function | `(value: unknown) => value is LedgerError`                    | Narrows an unknown caught value to a `LedgerError` through its identity brand and declared members, so a `catch` can branch on its `code`. |

#### Factories

The following table lists the factory that builds a ledger:

| Name           | Kind     | Signature                                                                  | Summary                                                                                  |
| -------------- | -------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `createLedger` | function | `(provider: ProviderInterface, options: LedgerOptions) => LedgerInterface` | Creates a conversation ledger after checking its thresholds, allocation, and tool names. |

#### Classes

The following table lists the classes that serve, file, and price a conversation and hold one request:

| Name            | Kind  | Signature                                                                      | Summary                                                                                                                                                            |
| --------------- | ----- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Ledger`        | class | `new (provider: ProviderInterface, options: LedgerOptions) => LedgerInterface` | Serves one conversation through classified records, a bounded copy of each request turn that carries them, and a final answer pass.                                |
| `LedgerRequest` | class | `new (content: string, limit?: number) => LedgerRequestInterface`              | Holds what one ledger request keeps while it is served: its message, its filing attempts and plan, the gauge calls of its passes, and its repeat and recall stops. |
| `Classifier`    | class | `new (options: ClassifierOptions) => ClassifierInterface`                      | Files messages through the conversation's judgment manager and reads their categories and corrections.                                                             |
| `Gauge`         | class | `new (options: GaugeOptions) => GaugeInterface`                                | Prices prompts in tokens from a measured scale and overhead cost, and measures the room a request has left.                                                        |

#### Validators

The following guards validate ledger fractions, capacity, and snapshots:

| Name                    | Kind     | Signature                                     | Summary                                                                                             |
| ----------------------- | -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `isFraction`            | function | `(value: unknown) => value is number`         | Checks whether a value is finite and lies in the interval (0, 1\].                                  |
| `isPositiveSafeInteger` | function | `(value: unknown) => value is number`         | Checks whether a value is a positive safe integer.                                                  |
| `isLedgerSnapshot`      | function | `(value: unknown) => value is LedgerSnapshot` | Checks whether a value is a ledger snapshot whose marked ids name messages of its own conversation. |

#### Helpers

The following table lists the pure helpers that read text, project and select records, render the records, and fit a price:

| Name                       | Kind     | Signature                                                                                                                                                                                                                       | Summary                                                                                                           |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `splitSentences`           | function | `(text: string) => readonly string[]`                                                                                                                                                                                           | Splits a message into its sentences.                                                                              |
| `collectNames`             | function | `(text: string) => readonly string[]`                                                                                                                                                                                           | Collects the capitalized name runs of a text, leaving out the run that opens each sentence.                       |
| `identifyLookup`           | function | `(name: string, args: Readonly<Record<string, unknown>>) => string \| undefined`                                                                                                                                                | Identifies a lookup finding for projection by its tool name and normalized arguments.                             |
| `linkOwners`               | function | `(findings: readonly LedgerLookupFinding[], owners: ReadonlyMap<string, readonly string[]>) => ReadonlyMap<string, string>`                                                                                                     | Links each id-shaped lookup argument to its owner.                                                                |
| `collectRegistry`          | function | `(findings: readonly LedgerLookupFinding[]) => LedgerRegistry`                                                                                                                                                                  | Collects the ids and the owner names the lookup findings named.                                                   |
| `buildLedgerIndex`         | function | `(registry: LedgerRegistry) => LedgerIndex`                                                                                                                                                                                     | Builds a registry's matching index: each name's owners, each word's carriers, the needles, keys, and ranks.       |
| `matchEntities`            | function | `(index: LedgerIndex, text: string, partial: boolean) => ReadonlySet<string>`                                                                                                                                                   | Matches the registry ids and owners a text names.                                                                 |
| `normalizeWord`            | function | `(word: string) => string`                                                                                                                                                                                                      | Normalizes a run of letters and digits to the one form each of its cases folds to.                                |
| `buildRecords`             | function | `(input: LedgerProjectionInput) => LedgerProjection`                                                                                                                                                                            | Projects the owner records and the rules record from a conversation's messages.                                   |
| `selectRecords`            | function | `(projection: LedgerProjection, request: LedgerProjectionRequest) => readonly LedgerRecord[]`                                                                                                                                   | Selects a request's records, collapsing owners with equal ordered member ids under titles joined with `; `.       |
| `findLedgerCall`           | function | `(group: readonly Message[], message: Message) => ToolCall \| undefined`                                                                                                                                                        | Finds the call that owns a tool message within a collected tool group.                                            |
| `collectProjectionIds`     | function | `(projection: LedgerProjection) => ReadonlySet<string>`                                                                                                                                                                         | Collects the live message ids placed in records or left without a record.                                         |
| `scanAmendments`           | function | `(amendments: ReadonlyMap<string, readonly string[]>, start: string, admit: (id: string) => boolean) => readonly string[]`                                                                                                      | Scans admitted amendments in breadth-first order without revisiting a message.                                    |
| `buildRecallMessage`       | function | `(topic: string) => Message`                                                                                                                                                                                                    | Builds the placeholder assistant recall call used to price recall framing.                                        |
| `buildRequestMessage`      | function | `(request: Message, records: string) => Message`                                                                                                                                                                                | Builds the copy of a request turn that carries the rendered records ahead of the request.                         |
| `renderTopicNames`         | function | `(topics: readonly LedgerTopic[]) => string`                                                                                                                                                                                    | Renders topic names as a comma-separated list in their supplied order.                                            |
| `renderCauseChain`         | function | `(error: unknown) => string`                                                                                                                                                                                                    | Renders an error and its causes, stopping after 4 entries.                                                        |
| `extractWords`             | function | `(message: Message) => LedgerWordSet`                                                                                                                                                                                           | Extracts lowercase words and capitalized names that do not open a sentence.                                       |
| `splitWords`               | function | `(part: string) => readonly string[]`                                                                                                                                                                                           | Splits a topic part into lowercase words with surrounding punctuation removed.                                    |
| `rankLedgerCut`            | function | `(group: LedgerPlanGroup, unsettled: boolean, category: LedgerCategory \| undefined) => number`                                                                                                                                 | Ranks a source the records render for removal before the next prompt.                                             |
| `findLedgerCut`            | function | `<T>(low: number, high: number, probe: (cut: number) => T \| undefined, found?: T) => T \| undefined`                                                                                                                           | Finds the first cut in a range whose probe returns a value, by bisection.                                         |
| `buildLedgerCut`           | function | `(steps: ReadonlyArray<LedgerLine \| string>, records: readonly LedgerRecord[], included: ReadonlySet<string>) => { readonly records: readonly LedgerRecord[]; readonly included: ReadonlySet<string>; }`                       | Builds the cut the given steps leave: each step drops the line it is, by identity, or the source it names.        |
| `renderLedgerRecord`       | function | `(record: Pick<LedgerRecord, 'title' \| 'lines'>, context?: LedgerRenderContext) => string`                                                                                                                                     | Renders one record as a heading and one list item per line.                                                       |
| `renderLedgerPinned`       | function | `(record: Pick<LedgerRecord, 'title' \| 'lines'>, context?: LedgerRenderContext) => string`                                                                                                                                     | Renders one owner record under a `###` heading, which the records nest under their one `## Records` heading.      |
| `splitTopic`               | function | `(topic: string) => readonly string[]`                                                                                                                                                                                          | Splits a recall topic at its joints.                                                                              |
| `cutListing`               | function | `(entries: readonly string[], room: number) => string`                                                                                                                                                                          | Cuts entries to a room and names how many it left out.                                                            |
| `matchesCutLine`           | function | `(line: string) => boolean`                                                                                                                                                                                                     | Checks whether a line is the cut line `cutListing` writes.                                                        |
| `normalizeArgument`        | function | `(value: string) => string`                                                                                                                                                                                                     | Normalizes a lookup argument string to the spelling that lookup identity and owner linking compare.               |
| `splitResultLines`         | function | `(text: string) => readonly string[]`                                                                                                                                                                                           | Splits a tool result into its lines at each line feed, with or without a carriage return before it.               |
| `renderLookupCall`         | function | `(name: string, args: Readonly<Record<string, unknown>>) => string`                                                                                                                                                             | Renders a lookup call as its tool name and its JSON arguments.                                                    |
| `renderStub`               | function | `(name: string, args: Readonly<Record<string, unknown>>, state: LedgerLookupState) => string`                                                                                                                                   | Renders the tail stub of a lookup result from an earlier request.                                                 |
| `computeThinking`          | function | `(message: Pick<Message, 'thinking' \| 'content' \| 'calls'>, completion: number) => number`                                                                                                                                    | Computes the completion tokens attributable to a message's thinking.                                              |
| `resolvePredict`           | function | `(predict: number \| undefined, capacity: number) => number`                                                                                                                                                                    | Resolves the generation cap and checks it against the context capacity.                                           |
| `fitSlope`                 | function | `(groups: ReadonlyArray<readonly GaugeCall[]>) => number \| undefined`                                                                                                                                                          | Fits the marginal tokens one estimate unit adds within a request.                                                 |
| `collectLive`              | function | `(input: LedgerProjectionInput) => readonly string[]`                                                                                                                                                                           | Collects the ids of the live messages in conversation order.                                                      |
| `placeMember`              | function | `(input: LedgerProjectionInput, links: ReadonlyMap<string, string>, amended: ReadonlyMap<string, readonly string[]>, id: string, seen: ReadonlySet<string>, settled?: Map<string, ReadonlySet<string>>) => ReadonlySet<string>` | Places a message on the record keys it joins.                                                                     |
| `buildLedgerRenderContext` | function | `(messages: readonly Message[], lines: readonly LedgerLine[], amendments: readonly LedgerAmendment[]) => LedgerRenderContext`                                                                                                   | Derives complete source identities, first occurrences, and local references from the actual lines of the records. |
| `renderLedgerAnnotation`   | function | `(line: LedgerLine, context: LedgerRenderContext) => string`                                                                                                                                                                    | Renders a source's reference and its later changes at the source's first retained line.                           |
| `collectAmendments`        | function | `(input: LedgerProjectionInput, byId: ReadonlyMap<string, Message>, live: readonly string[]) => readonly LedgerAmendment[]`                                                                                                     | Collects accepted direct amendments of live messages.                                                             |
| `buildLines`               | function | `(input: LedgerProjectionInput, byId: ReadonlyMap<string, Message>, id: string, holders: readonly string[], system: readonly string[]) => readonly LedgerLine[]`                                                                | Builds the record lines of one message.                                                                           |

The `Classifier` and `Gauge` classes the ledger composes are public, so a harness can file a conversation or price a prompt without a ledger. The following classifier files one rule, and the following gauge prices the calls of one request:

```ts
import type { JudgeInterface, LedgerThreshold } from '@orkestrel/agent'
import { Classifier, createConversation, Gauge, LEDGER_QUESTIONS } from '@orkestrel/agent'

declare const judge: JudgeInterface // answers 0.9 for the rule category and 0.9 for the topic
declare const thresholds: LedgerThreshold // fitted on LEDGER_QUESTIONS and this judge
declare const signal: AbortSignal

const conversation = createConversation()
const rule = conversation.add({ role: 'user', content: 'Refunds over $100 need a manager.' })
const classifier = new Classifier({
	conversation,
	judge,
	questions: LEDGER_QUESTIONS,
	topics: [{ name: 'refunds', criterion: 'refund amounts and approvals' }],
	thresholds,
	assign: () => undefined, // the judge decides every message
	entities: () => new Set(), // no lookups, so no shared id asks a pair question
})
const filed = await classifier.classify(new Set(), signal)
filed.judgments.length // 2 — the category question and the refunds topic question
filed.attempts.map((attempt) => attempt.outcome) // ['resolved', 'resolved'] — the judge answered both
classifier.category(rule.id) // 'rule'
classifier.decisive(rule.id) // true
classifier.quiet(rule.id) // false
classifier.topics(rule.id) // Set { 'refunds' }
classifier.classification().categories.get(rule.id) // 'rule'

const gauge = new Gauge({ scale: 1.25, overhead: 120, capacity: 32_768 })
const calls = [{ estimate: 400, prompt: 640, completion: 30, tools: 2 }]
gauge.rate(calls) // 1.25 — the scale, because no two calls with one tool count are observed
gauge.remainder(calls) // 32098 — the capacity less the last call's prompt and completion
gauge.reserve(calls, '') // 36.25 — an empty reply and one recall call, priced at the rate
gauge.room(calls, '') // 12824.7 — half of what is left beyond the reserve, in estimate units
gauge.observe(calls)
gauge.scale // 1.3 — the first call's prompt less the overhead cost, over its estimate
```

Agent-owned readonly data members stay in the preceding Surface tables; their call-signature methods are documented under [`## Methods`](#methods). For tool contracts, see [Tool](tool.md), and for workspace contracts, see [Workspace](workspace.md); neither dependency surface is duplicated or re-exported here. Note where the boundary falls inside the context: `instructions`, `skills`, `memos`, `conversations`, and `workspaces` are the managers `build()` renders a prompt from, while `tools` is loop machinery for advertising and dispatch and is never read by `build()` at all.

## Methods

The tables list every public call-signature member of `ProviderInterface`, `AgentProviderInterface`, `ProviderParserInterface`, `RelayProvider`, `JudgeInterface`, `AgentJudgeInterface`, `SystemOneJudge`, `ThinkSplitterInterface`, `JudgmentManagerInterface`, `MessageManagerInterface`, `InstructionManagerInterface`, `ScopeInterface`, `ScopeManagerInterface`, `MemoManagerInterface`, `MemoStoreInterface`, `MemoryMemoStore`, `DatabaseMemoStore`, `SkillManagerInterface`, `AgentContextInterface`, `AgentInterface`, `StreamInterface`, `ChannelInterface`, `AuthorityInterface`, `ApproverInterface`, `AgentRegistryInterface`, `ConversationInterface`, `ConversationManagerInterface`, `ConversationStoreInterface`, `MemoryConversationStore`, `DatabaseConversationStore`, `LedgerInterface`, `LedgerRequestInterface`, `ClassifierInterface`, and `GaugeInterface`. Their readonly data members remain Surface rows. `AgentProvider`, `AgentJudge`, `ThinkSplitter`, `InstructionManager`, `Scope`, `ScopeManager`, `MemoManager`, `SkillManager`, `AgentContext`, `Agent`, `Authority`, `Approver`, `AgentRegistry`, `Conversation`, `ConversationManager`, `JudgmentManager`, `Ledger`, `LedgerRequest`, `Classifier`, and `Gauge` implement their interfaces exactly, so the tables also describe those classes' instance methods. `RelayProvider`, `SystemOneJudge`, and the store classes keep explicit tables because their class names have no same-name interface contract. `MessageManagerInterface` has no separate concrete class here: the active `Conversation` satisfies it structurally. `RelayStream` exposes `response` alone, a data member, so it keeps its Surface row and takes no table. Tool and workspace methods live in their dependency guides.

#### `ProviderInterface`

`generate` produces one complete turn; `stream` yields `ProviderDelta` values and returns the assembled result. Both take the conversation, a bounding `AbortSignal`, optional `tools`, and optional per-call `ProviderStreamOptions`.

| Method     | Returns                                         | Summary                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate` | `Promise<ProviderResult>`                       | Generates one complete turn — resolves the assembled `ProviderResult`.                                                                                                                                                                                                                                                                       |
| `stream`   | `AsyncGenerator<ProviderDelta, ProviderResult>` | Streams one turn — yields channel-tagged `content` / `thinking` `ProviderDelta` values as they arrive and returns the assembled `ProviderResult` (the concatenated content, any separated reasoning, any tool calls, and any usage) when the stream completes. A mid-stream abort throws a `ProviderAbortError` carrying the partial result. |

#### `AgentProviderInterface`

The seams a subclass fills, beneath the boundary members it inherits. `AgentProviderInterface` extends `ProviderInterface`, so `generate` and `stream` are part of it and repeat here with their boundary contracts; `AgentProvider` implements each of them once, for every subclass. A subclass writes `frame` / `encode` / `read` / `finish` and nothing else. The `id`, `name`, and `replay` data members stay Surface rows.

| Method     | Returns                                         | Summary                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate` | `Promise<ProviderResult>`                       | Generates one complete turn — resolves the assembled `ProviderResult`.                                                                                                                                                                                                                                                                       |
| `stream`   | `AsyncGenerator<ProviderDelta, ProviderResult>` | Streams one turn — yields channel-tagged `content` / `thinking` `ProviderDelta` values as they arrive and returns the assembled `ProviderResult` (the concatenated content, any separated reasoning, any tool calls, and any usage) when the stream completes. A mid-stream abort throws a `ProviderAbortError` carrying the partial result. |
| `frame`    | `ProviderParserInterface<TRecord>`              | Creates fresh framing state for a call.                                                                                                                                                                                                                                                                                                      |
| `encode`   | `object`                                        | Projects a request to the concrete protocol's serializable body.                                                                                                                                                                                                                                                                             |
| `read`     | `ProviderIncrement`                             | Decodes a framed record into its contribution to the turn.                                                                                                                                                                                                                                                                                   |
| `finish`   | `readonly TRecord[]`                            | Returns records retained at end of input before the parser is cleared.                                                                                                                                                                                                                                                                       |

#### `ProviderParserInterface`

The framing seam a concrete provider hands the engine, one fresh instance for each call, so no call inherits another's half-read record. The engine feeds each decoded chunk to `parse` and clears the parser on every exit.

| Method  | Returns              | Summary                                       |
| ------- | -------------------- | --------------------------------------------- |
| `parse` | `readonly TRecord[]` | Parses a decoded chunk into complete records. |
| `clear` | `void`               | Clears retained framing state.                |

#### `RelayProvider`

The relay wire over `AgentProvider`: it fills every seam and inherits `generate` / `stream` from the base, so a browser drives it exactly like a local provider. Its `name` reports `'relay'` and stays a data member.

| Method   | Returns                                            | Summary                                                                           |
| -------- | -------------------------------------------------- | --------------------------------------------------------------------------------- |
| `frame`  | `ProviderParserInterface`                          | Creates fresh framing state for each response.                                    |
| `encode` | `object`                                           | Projects declared request fields and refuses values the JSON wire cannot carry.   |
| `read`   | `ProviderIncrement`                                | Validates a relay frame and translates its channel into the shared stream engine. |
| `finish` | `ReadonlyArray<Readonly<Record<string, unknown>>>` | Recovers an unterminated final frame by completing its NDJSON line.               |

#### `JudgeInterface`

The decision boundary. `ask` is its only method; the `id`, `name`, and `model` data members stay Surface rows. It takes the request and a bounding `AbortSignal`.

| Method | Returns                | Summary                                                                            |
| ------ | ---------------------- | ---------------------------------------------------------------------------------- |
| `ask`  | `Promise<JudgeResult>` | Asks every question of the request about its state and returns the merged answers. |

#### `AgentJudgeInterface`

The seams a judge wire fills, beneath the boundary method it inherits. `AgentJudgeInterface` extends `JudgeInterface`, so `ask` is part of it and repeats here with its boundary contract; `AgentJudge` implements `ask` once, for every subclass. A subclass writes `encode` and `read` and nothing else. The `id`, `name`, and `model` data members stay Surface rows.

| Method   | Returns                | Summary                                                                             |
| -------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `ask`    | `Promise<JudgeResult>` | Asks every question of the request about its state and returns the merged answers.  |
| `encode` | `object`               | Projects one call's request onto the concrete protocol's serializable body.         |
| `read`   | `JudgeResult`          | Decodes one call's parsed response body into the answers for that call's questions. |

#### `SystemOneJudge`

The System One wire over `AgentJudge`: it fills both seams and inherits `ask` from the engine, so a caller drives it through `JudgeInterface` like any judge. Its `name` reports `'systemone'` and stays a data member.

| Method   | Returns            | Summary                                                                                 |
| -------- | ------------------ | --------------------------------------------------------------------------------------- |
| `encode` | `SystemOneRequest` | Projects the state and questions onto the System One request with the configured model. |
| `read`   | `JudgeResult`      | Decodes requested System One answers and reports the server model and available usage.  |

#### `ThinkSplitterInterface`

The stream-stateful `<think>…</think>` separator a provider routes raw content deltas through, so it yields clean content and surfaces the reasoning as `ProviderResult.thinking`. The `content` / `thinking` data members (the authoritative clean-content + reasoning accumulations) stay Surface rows — `content` matters because some chat templates pre-seed `<think>` into the prompt scaffold (the qwen3 shape), so only a bare `</think>` ever appears on the wire: before any tag event, that bare close reclassifies everything surfaced so far into `thinking` (one-shot — afterwards a bare close is plain text), correcting `content` retroactively where the already-returned deltas can't be recalled. One splitter serves one stream — create a fresh one for each call (`createThinkSplitter`).

| Method  | Returns  | Summary                                                                                                                                                                                                              |
| ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `split` | `string` | Feeds one raw delta and returns the clean, non-think content to surface for it (possibly `''`) — a tag split across deltas is held until disambiguated, so it is neither returned as content nor routed to thinking. |
| `flush` | `string` | Settles the stream end — a held partial tag that never completed returns as the final content delta, and an unclosed think span's tail lands on `thinking`.                                                          |

#### `JudgmentManagerInterface`

The conversation's judgment store. `add` stamps each record's `time` and carries batch overloads (one input → one record, a batch → the array), replacing an existing key in place; `remove` carries batch overloads (one key or a list). Every record the store returns is the stored record, deep-frozen, so a caller copies a record before changing it. The `count` data member stays a Surface row.

| Method      | Returns                            | Summary                                                                         |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| `add`       | `Judgment` / `readonly Judgment[]` | Stores inputs with the current epoch milliseconds; an existing key is replaced. |
| `judgment`  | `Judgment \| undefined`            | Returns the record for a key, or `undefined` when absent.                       |
| `judgments` | `readonly Judgment[]`              | Returns stored records in insertion order.                                      |
| `remove`    | `boolean`                          | Removes every supplied key; returns `true` only when all were present.          |
| `clear`     | `void`                             | Removes all records.                                                            |
| `resolve`   | `Promise<readonly Judgment[]>`     | Reuses matching records and asks for the unmatched questions in one request.    |

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

The name-keyed instruction registry a richer context renders a directives block from. `add` mints each `id` and carries batch overloads (adding an instruction whose name is already stored overwrites it, last write wins); `remove` carries batch overloads. The `emitter` / `count` / `open` / `close` data members stay Surface rows.

| Method         | Returns                                                    | Summary                                                                                                                                       |
| -------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`          | `InstructionInterface` / `readonly InstructionInterface[]` | Adds one `InstructionInput`, or a batch — mints each `id`; adding an instruction whose name is already stored overwrites it, last write wins. |
| `instruction`  | `InstructionInterface \| undefined`                        | Looks up one instruction by name (`undefined` when absent).                                                                                   |
| `instructions` | `readonly InstructionInterface[]`                          | Lists every instruction, sorted by descending `priority` (stable for equal priorities).                                                       |
| `render`       | `string`                                                   | Renders one instruction for the prompt — its `override`, else the manager-options `render`, else its `content`.                               |
| `remove`       | `boolean`                                                  | Removes one instruction by name, or a batch. True if every supplied name was removed; false otherwise.                                        |
| `clear`        | `void`                                                     | Removes every instruction.                                                                                                                    |

#### `ScopeInterface`

The named, immutable allow-list filter. `narrow` is the only method — the `id` / `name` data members and the per-category allow-lists stay Surface rows.

| Method   | Returns          | Summary                                                                                                                                                                                                                    |
| -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `narrow` | `ScopeInterface` | Composes a tighter child scope — each category is the set intersection of this scope's list and the list in `config` (an `undefined` side imposing no constraint), returned as a new scope that leaves this one unchanged. |

#### `ScopeManagerInterface`

The id-keyed registry of reusable named scopes. `add` mints + stores a scope (never overwrites, because two scopes may share a `name`); `remove` carries batch overloads. The `emitter` / `count` data members stay Surface rows.

| Method   | Returns                       | Summary                                                                                                                       |
| -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `add`    | `ScopeInterface`              | Mints a scope from a `ScopeInput` (a `name` plus the per-category allow-lists) and stores it — always adds, never overwrites. |
| `scope`  | `ScopeInterface \| undefined` | Looks up one scope by id (`undefined` when absent).                                                                           |
| `scopes` | `readonly ScopeInterface[]`   | Lists every scope, in insertion order.                                                                                        |
| `remove` | `boolean`                     | Removes one scope by id, or a batch. True if every supplied id was removed; false otherwise.                                  |
| `clear`  | `void`                        | Removes every scope.                                                                                                          |

#### `MemoManagerInterface`

The name-keyed memo set a host keeps durable facts in. `add` appends a revision only when the text changed and carries batch overloads; `remove` forgets a memo with its whole history and carries batch overloads. The `id` / `emitter` / `count` / `open` / `close` data members stay Surface rows.

| Method     | Returns                    | Summary                                                                                                                                        |
| ---------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`      | `Memo` / `readonly Memo[]` | Adds one `MemoInput`, or a batch, appending a revision only when the name holds no current revision with the same `description` and `content`. |
| `memo`     | `Memo \| undefined`        | Looks up the current revision of one memo (`undefined` when absent).                                                                           |
| `memos`    | `readonly Memo[]`          | Lists the current revision of every memo, ordered by each name's first revision.                                                               |
| `history`  | `readonly Memo[]`          | Lists every revision of one memo, oldest first.                                                                                                |
| `render`   | `string`                   | Renders one memo's index line: the manager-options `render`, else `- name: description`.                                                       |
| `remove`   | `boolean`                  | Removes one memo and its whole history by name, or a batch. True if every supplied name was removed; false otherwise.                          |
| `clear`    | `void`                     | Removes every memo.                                                                                                                            |
| `snapshot` | `MemoSnapshot`             | Returns the memo set as plain data: its `id` and every revision, oldest first.                                                                 |

#### `MemoStoreInterface`

The persistence contract stores a `MemoSnapshot` under its own identity.

| Method   | Returns                              | Summary                                                                  |
| -------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `get`    | `Promise<MemoSnapshot \| undefined>` | Resolves the stored snapshot for `id`, or `undefined` if none is stored. |
| `set`    | `Promise<void>`                      | Inserts or replaces a snapshot under its own `snapshot.id`.              |
| `delete` | `Promise<void>`                      | Drops a snapshot by id; an absent id is a no-op.                         |

#### `MemoryMemoStore`

The in-memory implementation keeps an explicit table because its class name has no same-name interface contract.

| Method   | Returns                              | Summary                                                                  |
| -------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `get`    | `Promise<MemoSnapshot \| undefined>` | Resolves the stored snapshot for `id`, or `undefined` if none is stored. |
| `set`    | `Promise<void>`                      | Inserts or replaces a snapshot under its own `snapshot.id`.              |
| `delete` | `Promise<void>`                      | Drops a snapshot by id; an absent id is a no-op.                         |

#### `DatabaseMemoStore`

The driver-backed implementation keeps an explicit table because its class name has no same-name interface contract.

| Method   | Returns                              | Summary                                                                                                   |
| -------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `get`    | `Promise<MemoSnapshot \| undefined>` | Resolves the stored snapshot for `id`, narrowing the opaque JSON column back to a `MemoSnapshot`.         |
| `set`    | `Promise<void>`                      | Inserts or replaces under the snapshot's own `id` (no separate id param) — the row is `{ id, snapshot }`. |
| `delete` | `Promise<void>`                      | Drops a snapshot by id; an absent id is a no-op (no throw).                                               |

#### `SkillManagerInterface`

The name-keyed skill registry a host supplies skills through. `add` mints each `id` and file, replaces a same-name skill in its position, and carries batch overloads; `remove` carries batch overloads. The `emitter` / `count` / `open` / `close` data members stay Surface rows.

| Method   | Returns                      | Summary                                                                                                         |
| -------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `add`    | `Skill` / `readonly Skill[]` | Adds one `SkillInput`, or a batch: mints each `id` and file, and overwrites a same-name skill, last write wins. |
| `skill`  | `Skill \| undefined`         | Looks up one skill by name (`undefined` when absent).                                                           |
| `skills` | `readonly Skill[]`           | Lists every skill, in insertion order.                                                                          |
| `render` | `string`                     | Renders one skill's index line: the manager-options `render`, else `- name: description`.                       |
| `remove` | `boolean`                    | Removes one skill by name, or a batch. True if every supplied name was removed; false otherwise.                |
| `clear`  | `void`                       | Removes every skill.                                                                                            |

#### `AgentContextInterface`

The richer turn context. `apply` changes the active per-turn filter, `select` runs the selection handler for one request, and `build` assembles the provider input. The `system` / `instructions` / `skills` / `memos` / `messages` / `tools` / `scope` / `workspaces` / `conversations` readonly data members stay Surface rows.

| Method   | Returns                           | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apply`  | `void`                            | Applies the given scope as the active per-turn filter; passing `undefined` explicitly removes filtering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `select` | `Promise<Selection> \| undefined` | Runs the selection handler for one request — the active scope's `select`, else the agent default — and checks that the conversation did not change under it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `build`  | `readonly Message[]`              | Builds the provider input for the next turn: a leading `system` message folding the prompt, the scope-filtered instructions, and the scope-filtered skills index (each section's header and each item's rendering resolved through the format cascade), then one `user` context message holding the scope-filtered memos index before the active workspace's scope-filtered (`scope.files`) text files as fenced reference blocks in a `## Workspace` section, then the active conversation's `view()`, or the selection's `messages` when a selection is passed, with the active workspace's image files' `base64` payload attached to the last user message. With no override set, each section renders on its manager's built-in framing. The `system` message is prepended only when some part of it exists, the context message only when the memos or workspace section renders, the workspace render covers the active workspace alone, tools are advertised structurally rather than in the prompt, and the input is built fresh on each call. |

#### `AgentInterface`

The bounded agent loop. `generate` and `stream` share one private run (`generate` awaits the settled result of the run `stream` exposes and leaves its live chunks undrained, so they can't diverge); `abort` cancels the in-flight turn. The `emitter` / `id` / `status` / `context` data members stay Surface rows (`emitter` is a `readonly` accessor — a property, not a method).

| Method     | Returns                | Summary                                                                                                                                                                                        |
| ---------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate` | `Promise<AgentResult>` | Runs the turn to completion — awaits the settled `AgentResult` (`partial: true` when cancelled) and leaves the live chunks undrained.                                                          |
| `stream`   | `AgentStreamInterface` | Runs the turn as a live stream — iterate `events` for values of `AgentChunk` and `await result` for the settled outcome; `result` resolves partial on a cancel and rejects on a genuine error. |
| `abort`    | `void`                 | Cancels the in-flight turn — fires the turn's signal; the `result` settles `partial: true` with whatever content accumulated.                                                                  |

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
| `close` | `void`                    | Ends the channel normally — a draining consumer returns after the buffer empties.                                                      |
| `fail`  | `void`                    | Ends the channel with a failure — a draining consumer throws it after the buffer empties; the first failure wins.                      |
| `drain` | `AsyncGenerator<T, void>` | Reads the values back live, in write order — returning on `close` and throwing on `fail`.                                              |

Concurrent `drain` readers share one buffer: each value goes to exactly one reader, and `close` or `fail` ends every reader. A `push` after `close` or `fail` is buffered rather than refused, so a later `drain` yields it before reporting the end.

Buffered values are always delivered before the end is reported, so a `close` or `fail` arriving alongside the last values still hands them over first:

```ts
import { createChannel } from '@orkestrel/agent'

const channel = createChannel<number>()
channel.push(1)
channel.close()
for await (const value of channel.drain()) {
	value // 1
}

const failed = createChannel<number>()
failed.push(2)
failed.fail(new Error('upstream died')) // the 2 is delivered, then the drain throws
```

#### `AuthorityInterface`

The policy gate the agent loop consults before each tool call. `evaluate` is synchronous; the optional `ask` answers an `ask` verdict asynchronously. It has no data members.

| Method     | Returns             | Summary                                                                                                                                                                |
| ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluate` | `AuthorityDecision` | Evaluates one tool call against the ordered rules — returns the first matching rule's verdict, which allows when the rule names none, or the fallback when none match. |
| `ask`      | `Promise<boolean>`  | Resolves `true` to approve one asked call; absent, every ask reads as unanswered.                                                                                      |

#### `ApproverInterface`

The server half of a page's approval. Its `ask` is a readonly data member that holds the bound `AuthorityHandler`, so `createAuthority({ rules, ask: approver.ask })` wires it; `frame` reads a waiting ask's `ask` frame for the page, and `answer` settles that ask from the page's `AgentAnswer`.

| Method   | Returns                   | Summary                                                                                                                                           |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frame`  | `AgentFrame \| undefined` | Returns the frame of the call's waiting ask, or `undefined` when none waits; a call framed with no waiting ask is refused when it is asked later. |
| `answer` | `boolean`                 | Settles the waiting ask whose `id` the answer names; only `approved: true` approves.                                                              |

#### `AgentRegistryInterface`

The job-rehydration bridge. `provider` / `tool` / `authority` / `scheduler` resolve a name against their pool (throwing `unknown <category>: <name>` on a miss); `build` rehydrates a seeded, signal-wired agent from a serializable job. It has no data members.

| Method      | Returns              | Summary                                                                                                                                                                                                               |
| ----------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`  | `ProviderInterface`  | Resolves a registered `ProviderInterface` by name — throws `unknown provider: <name>` when absent.                                                                                                                    |
| `tool`      | `ToolInterface`      | Resolves a registered `ToolInterface` by name — throws `unknown tool: <name>` when absent.                                                                                                                            |
| `authority` | `AuthorityInterface` | Resolves a registered `AuthorityInterface` by name — throws `unknown authority: <name>` when absent.                                                                                                                  |
| `scheduler` | `SchedulerInterface` | Resolves a registered `SchedulerInterface` by name — throws `unknown scheduler: <name>` when absent.                                                                                                                  |
| `build`     | `AgentInterface`     | Rehydrates a live, seeded `AgentInterface` from a serializable `AgentJobInput` — resolving its names, rebuilding its token budget, seeding its conversation, and wiring `signal`; a name absent from its pool throws. |

#### `AgentFanout`

The runner handler `createAgentRunner` binds. One instance serves one runner, because it records every unit whose declared children it spawned, so a retried attempt of a unit spawns none again. It has no data members.

| Method    | Returns                | Summary                                                                                                                                                                    |
| --------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute` | `Promise<AgentResult>` | Executes one unit: spawns its declared children unless an earlier attempt of the unit already did, then runs the rehydrated agent and settles it under the partial policy. |

Bind the `execute` method of a fresh instance as the handler of a runner you compose yourself:

```ts
import type { AgentJobInput, ProviderInterface } from '@orkestrel/agent'
import { AgentFanout, createAgentRegistry } from '@orkestrel/agent'
import { createRunner } from '@orkestrel/workflow'

declare const provider: ProviderInterface // any concrete implementation supplied by the host app
const fanout = new AgentFanout(createAgentRegistry({ providers: { main: provider } }), false)
const runner = createRunner({ handler: fanout.execute.bind(fanout), retries: 1 })
const child: AgentJobInput = { provider: 'main', messages: [{ role: 'user', content: 'child' }] }
const parent: AgentJobInput = {
	...child,
	messages: [{ role: 'user', content: 'parent' }],
	children: [child],
}
const results = await runner.execute([parent]) // the parent's result, then the child's
```

#### `ConversationInterface`

A conversation that owns its live message tail directly (the flat store verbs folded in, like a `Workspace` owns its files). `add` mints each message's `id` and stores it (batch overloads); `message` / `messages` look up the live tail; `remove` / `clear` drop from it. `view` is the model input; `compact` folds the older live messages into a summarized `Section` and emits `compact`; `rehydrate` / `search` read the retained originals; `reference` renders this conversation as a provenance-labeled block to pull into another (a pure string, no model call). The `id` / `judgments` / `emitter` / `sections` / `summarizable` / `count` data members stay Surface rows (`emitter` is a `readonly` accessor — a property, not a method).

| Method      | Returns                           | Summary                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`       | `Message` / `readonly Message[]`  | Appends one `MessageInput` to the live tail, or a batch — mints each message's `id` (a random UUID) and returns the created message or messages; a stored message is immutable.                                                                                                                                                                                              |
| `message`   | `Message \| undefined`            | Looks up one live message by id (`undefined` when absent).                                                                                                                                                                                                                                                                                                                   |
| `messages`  | `readonly Message[]`              | Lists every live, uncompacted message in the tail, in insertion order.                                                                                                                                                                                                                                                                                                       |
| `remove`    | `boolean`                         | Removes one live message by id, or a batch, from the tail — `true` only when every supplied id was removed.                                                                                                                                                                                                                                                                  |
| `clear`     | `void`                            | Empties the live tail, leaving the compacted `sections` untouched.                                                                                                                                                                                                                                                                                                           |
| `view`      | `readonly Message[]`              | Builds the model input for the next turn — each section as one synthetic recap message, its summary prefixed with `CONVERSATION_RECAP_PREFIX` so a small model reads it as a recap rather than a literal turn, then the live tail verbatim.                                                                                                                                  |
| `compact`   | `Promise<Section \| undefined>`   | Folds whole exchanges from the oldest `count - keep` live messages, cut short at the newest user message, into a summarized `Section` through the `ConversationSummaryHandler`, removes them from the live tail, and emits `compact` — resolving `undefined` when nothing folds.                                                                                             |
| `rehydrate` | `readonly Message[] \| undefined` | Returns the full original messages of a known section and emits its `id` through `rehydrate`, including an empty list; returns `undefined` without an event for an unknown `id`. Never reinserts messages.                                                                                                                                                                   |
| `search`    | `readonly Message[]`              | Searches `content` for a case-insensitive substring across every message — the retained originals of each section, then the live tail.                                                                                                                                                                                                                                       |
| `reference` | `string`                          | Renders this conversation as a self-labeled, fenced provenance block to pull into another conversation — a pure string with no model call: a leading `[Reference — conversation "<label>" — NOT part of this conversation]` marker, then the cherry-picked excerpts (`- role: content`) when `messages` is supplied. The `label` option names the source. Default: the `id`. |
| `snapshot`  | `ConversationSnapshot`            | Serializes this conversation to a plain, JSON-serializable `ConversationSnapshot` — its `id`, the compacted `sections`, and the live tail; the live `summarize` / `keep` are configuration re-supplied on hydrate rather than serialized.                                                                                                                                    |

A supplied `sections` cap must satisfy `>= 1`; `NaN` throws `ConversationError` with code `SECTIONS` before a fold starts. A successful capped merge retains at most `Math.ceil(sections)` entries. An absent cap, fractional caps `>= 1`, and positive infinity retain their existing behavior. A supplied `keep` must be a nonnegative safe integer; any other value throws `ConversationError` with code `KEEP`, carrying the value as `context.keep`, before a fold starts. `compact()` calls run one at a time. A `remove` or `clear` during the initial summarizer leaves no section. `CompactOptions.signal` rejects a call with its reason at once and commits nothing after the abort; a fold committed before an aborted overflow merge stays. A summarizer digest whose trimmed text is empty rejects with `ConversationError` code `SUMMARY`: a fold commits nothing, and a refused overflow merge leaves the appended section.

#### `ConversationManagerInterface`

The id-keyed registry of `Conversation` instances with an active pointer. `add(input?)` mints a conversation (flowing the manager's default `summarize` / `keep` in unless the input overrides them) and auto-activates the first one; a later `add` leaves `active` unchanged. `add` forwards the input's `on` hooks and `error` handler to the conversation's emitter, so a throwing listener reports to that handler. `open(id)` returns the conversation registered under `id` while its store read was pending rather than overwriting it, and resolves `undefined` for a stored snapshot whose `id` is not `id`. A stored snapshot that holds a `system` role rejects `open` with `ConversationError` `'ROLE'`, and the registry and `active` stay unchanged. `switch(id)` re-points `active` (an unknown `id` returns `undefined`, leaving `active` unchanged — lenient, never throws); `remove` carries batch overloads and clears `active` when the removed conversation was active. The `count` and `active` data members stay Surface rows (`active` is a `readonly` accessor — a property, not a method); the manager is event-free (each conversation owns its `emitter`).

| Method          | Returns                                       | Summary                                                                                                                                                                                                                                                  |
| --------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation`  | `ConversationInterface \| undefined`          | Looks up one conversation by id (`undefined` when absent).                                                                                                                                                                                               |
| `conversations` | `readonly ConversationInterface[]`            | Lists every conversation, in insertion order.                                                                                                                                                                                                            |
| `add`           | `ConversationInterface`                       | Mints a conversation, taking its `id` from the input or a fresh UUID and flowing the default `summarize` / `keep` of the manager in unless the input overrides them — auto-activates the first, and an already-present `id` overwrites, last write wins. |
| `switch`        | `ConversationInterface \| undefined`          | Re-points `active` at the conversation with `id` and returns it; an unknown `id` returns `undefined` and leaves `active` unchanged, never throwing.                                                                                                      |
| `open`          | `Promise<ConversationInterface \| undefined>` | Resolves a conversation by id and activates it — from the registry when present, else hydrated from the optional `ConversationStoreInterface` (`store`); `undefined` when it is neither registered nor stored.                                           |
| `save`          | `Promise<boolean>`                            | Persists a registered conversation's `ConversationInterface.snapshot` to the optional `ConversationStoreInterface` (`store`) — `true` when persisted, `false` when there is no store or the id is unknown; a store failure propagates.                   |
| `remove`        | `boolean`                                     | Removes one conversation by id, or a batch — `true` only when every supplied id was removed; clears `active` when a removed conversation was the active one.                                                                                             |
| `clear`         | `void`                                        | Removes every conversation and clears `active`.                                                                                                                                                                                                          |

#### `ConversationStoreInterface`

The persistence contract stores a `ConversationSnapshot` under its own identity.

| Method   | Returns                                      | Summary                                                                                                                                      |
| -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `get`    | `Promise<ConversationSnapshot \| undefined>` | Resolves the persisted snapshot for `id`, or `undefined` if none is stored.                                                                  |
| `set`    | `Promise<void>`                              | Inserts or replaces a snapshot under its own `snapshot.id` (no separate id param — mirroring the `set` method of `WorkspaceStoreInterface`). |
| `delete` | `Promise<void>`                              | Drops a snapshot by id; an absent id is a no-op (no throw).                                                                                  |

#### `MemoryConversationStore`

The in-memory implementation keeps an explicit table because its class name has no same-name interface contract.

| Method   | Returns                                      | Summary                                                                                                                                      |
| -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `get`    | `Promise<ConversationSnapshot \| undefined>` | Resolves the persisted snapshot for `id`, or `undefined` if none is stored.                                                                  |
| `set`    | `Promise<void>`                              | Inserts or replaces a snapshot under its own `snapshot.id` (no separate id param — mirroring the `set` method of `WorkspaceStoreInterface`). |
| `delete` | `Promise<void>`                              | Drops a snapshot by id; an absent id is a no-op (no throw).                                                                                  |

#### `DatabaseConversationStore`

The driver-backed implementation keeps an explicit table because its class name has no same-name interface contract.

| Method   | Returns                                      | Summary                                                                                                      |
| -------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `get`    | `Promise<ConversationSnapshot \| undefined>` | Resolves the persisted snapshot for `id`, narrowing the opaque JSON column back to a `ConversationSnapshot`. |
| `set`    | `Promise<void>`                              | Inserts or replaces under the snapshot's own `id` (no separate id param) — the row is `{ id, snapshot }`.    |
| `delete` | `Promise<void>`                              | Drops a snapshot by id; an absent id is a no-op (no throw).                                                  |

#### `LedgerInterface`

The conversation ledger. The `respond` method serves one request through to its reply, the `calibrate` method measures the price of a prompt, and the `snapshot` method serializes the ledger for a later ledger to hydrate from. The `agent`, `conversation`, and `gauge` data members stay Surface rows. A `respond` or `calibrate` call while either is in flight rejects with `AgentError` code `CONCURRENCY`, and a `snapshot` call while either is in flight throws that error.

| Method      | Returns                 | Summary                                                                                                  |
| ----------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `respond`   | `Promise<LedgerResult>` | Appends `content` as a user message and serves it through to its reply.                                  |
| `calibrate` | `Promise<LedgerGauge>`  | Measures the gauge, holds it as `gauge`, and returns it.                                                 |
| `snapshot`  | `LedgerSnapshot`        | Serializes the conversation, the marked ids, and the gauge into a snapshot a later ledger hydrates from. |

#### `LedgerRequestInterface`

The state of one `respond` call. The ledger creates one request per call and drops it when the call settles, so no request state reaches a later call or a run no call owns. Each agent run the call makes is a pass: the `open` method starts one, and the `selection`, `boundary`, and `usage` data members read the current pass. The `message`, `plan`, `selection`, `boundary`, `usage`, `calls`, and `attempts` data members stay Surface rows.

| Method    | Returns                                    | Summary                                                                                                            |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `enter`   | `Message`                                  | Appends the request's content to a conversation as a user message, once, and holds it as `message`.                |
| `open`    | `void`                                     | Opens a pass, which becomes the current pass.                                                                      |
| `adopt`   | `void`                                     | Records the selection the current pass's run adopted and adds the usage it spent.                                  |
| `observe` | `void`                                     | Starts a gauge call in the current pass, making that pass's call in flight final.                                  |
| `spend`   | `void`                                     | Adds one call's reported usage to the current pass and records it on the call in flight.                           |
| `think`   | `void`                                     | Records the thinking share of the call in flight, read from the first assistant message after the call's position. |
| `file`    | `void`                                     | Appends the attempts of one planning selection and holds its plan when planning succeeded.                         |
| `admit`   | `void`                                     | Admits one tool call of the request, compared by tool name and canonical arguments.                                |
| `recall`  | `void`                                     | Counts one `recall` call, closing the request's recall tool when its recalls reach the limit.                      |
| `close`   | `void`                                     | Closes the request's recall tool, so every later `recall` call throws the closure note.                            |
| `list`    | `void`                                     | Holds the stored first line of each lookup a recall result listed, keyed by its listed line.                       |
| `lines`   | `ReadonlyMap<string, string> \| undefined` | Returns the stored first lines a recall result listed.                                                             |

The ledger drives each request through these methods, and a harness can drive one directly to check its stops. The following request serves one pass, then refuses a repeated lookup and a recall past its limit:

```ts
import type { Selection } from '@orkestrel/agent'
import { createConversation, LedgerRequest } from '@orkestrel/agent'

const conversation = createConversation()
const request = new LedgerRequest('Does the $148.50 refund need a manager?', 1) // 1 recall call
const message = request.enter(conversation) // the appended user message
request.enter(conversation) === message // true — a later call appends nothing

// One pass: its run adopts a selection, then makes one call.
request.open(conversation.count)
const selection: Selection = {
	messages: [message],
	judgments: [],
	usage: { prompt: 30, completion: 2, total: 32 },
}
request.adopt(selection, conversation.count)
request.observe({ estimate: 40, tools: 2 }, conversation.count)
request.spend({ prompt: 52, completion: 8, total: 60 })
request.usage // { prompt: 82, completion: 10, total: 92 } — the selection's usage and the call's
request.calls // [{ estimate: 40, tools: 2, prompt: 52, completion: 8 }] — the call in flight took its usage

request.admit('lookup_order', { id: 'BW-5512' })
request.admit('lookup_order', { id: 'BW-5512' }) // throws Error(LEDGER_NOTES.repeat)
request.recall()
request.recall() // throws Error(LEDGER_NOTES.closure) — the 1 recall call is spent

const listed = 'lookup_order {"id":"BW-5512"}: Refund due $148.50.'
request.list(listed, new Map([[listed, 'Order BW-5512 for account BW-20931: Brightwater Studio.']]))
request.lines(listed)?.get(listed) // 'Order BW-5512 for account BW-20931: Brightwater Studio.'
request.lines('Refunds over $100 need a manager.') // undefined — no recall returned that text
```

#### `ClassifierInterface`

The ledger's filing engine. The `classify` method asks the judge what the conversation's recorded judgments lack, and the readers derive every answer from those judgments and the cutoffs. It carries no data members.

| Method           | Returns                       | Summary                                                                                          |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `classify`       | `Promise<ClassifierResult>`   | Asks every filing question the conversation's judgments lack an answer for.                      |
| `category`       | `LedgerCategory \| undefined` | Returns the category a message is filed under, or undefined when no category reaches its cutoff. |
| `quiet`          | `boolean`                     | Returns true if the message is filed as quiet; false otherwise.                                  |
| `decisive`       | `boolean`                     | Returns true if the message is filed as decisive; false otherwise.                               |
| `topics`         | `ReadonlySet<string>`         | Returns the desk topics the message is filed under.                                              |
| `classification` | `LedgerClassification`        | Returns the filing of every message in the conversation.                                         |

#### `GaugeInterface`

The prompt price. The `rate`, `remainder`, `reserve`, and `room` methods read the calls of the request in progress, and the `observe` method folds a finished request in. The `scale` and `overhead` data members stay Surface rows. The `scale` member holds the price from the last observation; the `overhead` member holds the construction price.

| Method      | Returns  | Summary                                                                                              |
| ----------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `rate`      | `number` | Returns the tokens one more estimate unit adds within a request, fitted over the observed calls.     |
| `remainder` | `number` | Returns the tokens of the capacity the last call left.                                               |
| `reserve`   | `number` | Returns the tokens a reply turn needs after the calls, given the longest reply text written so far.  |
| `room`      | `number` | Returns the estimate units a recall result can take without taking the reply's room.                 |
| `observe`   | `void`   | Rescales from a completed request's first call and keeps its calls and the final reply's completion. |

## Contract

These invariants hold across `src/core` ↔ `agent.md`:

- **Doc ↔ source bijection.** Every row in the `## Surface` tables is a real export of `src/core`, and every export appears as a Surface row.
- **`ProviderInterface` is the inference boundary; `AgentProvider` is the engine behind it.** A provider turns a conversation, optional `tools`, and optional `ProviderStreamOptions` into a turn: `generate` resolves the assembled `ProviderResult`, and `stream` yields channel-tagged `ProviderDelta` values and returns the same result. `AgentProvider` owns the deadline, the transport, the `headers` hook, the bounded error read, the decode loop, reasoning separation, and result assembly, and a subclass supplies one vendor's wire through `frame`, `encode`, `read`, and `finish`. The loop and its tools run in the host that constructs them; see [Placement proofs](#placement-proofs) for each placement's receipt.
- **`stream` yields deltas and returns the assembled result.** `stream` yields each non-empty answer delta as `{ channel: 'content', text }` and each native reasoning delta as `{ channel: 'thinking', text }`, and returns the `ProviderResult` whose `content` is the authoritative clean answer. A provider reading a raw wire routes content through a per-stream `ThinkSplitter` armed by `split` and surfaces the reasoning as `ProviderResult.thinking`, which the agent records on the assistant message and sends back only as the provider's `replay` policy allows. `RelayProvider` constructs with `split: false`, so it preserves each upstream delta verbatim, a literal `<think>` tag included.
- **Usage reuses `TokenUsage`.** `ProviderResult.usage` is the [budgets](budget.md) `TokenUsage` shape `{ prompt, completion, total }`, present only when the turn reported it.
- **The caller's signal and the engine's deadline both bound the call.** `generate` and `stream` take an `AbortSignal`, and an already-aborted signal rejects before any content streams. `AgentProvider` folds a per-call `Timeout` of `AgentProviderInput.timeout` milliseconds (`DEFAULT_PROVIDER_TIMEOUT` when omitted) with that signal through `AbortSignal.any`, covering the `headers` hook, the error-body read, and the stream. The deadline is cleared on every exit.
- **A local cancel and a remotely reported one are different failures.** A `stream` cancelled by its bound throws `ProviderAbortError` whose `partial` holds what was assembled locally, with a throw that raced the cancel carried as its `cause`. A relay `abort` frame makes `RelayProvider.read` throw a reconstructed `ProviderAbortError` carrying the upstream partial while the local signal stays unaborted, and the engine propagates that instance unchanged.
- **The message-store contract (`MessageManagerInterface`).** Every `ConversationInterface`, the `context.messages` conversation included, satisfies `MessageManagerInterface` structurally. `add` mints each message's `id`, carries `calls` only when supplied, and returns the stored immutable message that `message(id)` later resolves; `remove` reports `true` only when every supplied id was removed.
- **The richer turn context (`AgentContext`).** `AgentContext` composes the optional `system` prompt, the `instructions`, `skills`, `memos`, `workspaces`, and `conversations` managers, `messages`, the `tools` registry, and a readonly active `scope`, creating each omitted manager fresh. `build()` folds the system prompt, the scope-filtered instructions, and the scope-filtered skills index into one leading `system` message, renders the scope-filtered memos index and the active workspace's scope-filtered text files into one `user` context message after it, then appends the active conversation's `view()`, or a passed selection's `messages`. The `system` message holds host-authored text alone. It never reads `tools`, never mutates a manager or a stored message, and builds fresh on each call.
- **Scope filtering.** A scope holds one three-way allow-list per category (`instructions` by `name`, `skills` by `name`, `memos` by `name`, `tools` by `name`, `files` by `path`), applied through `filterAllowList`, and `narrow` intersects each list, so narrowing only tightens. The scope's filters never touch messages; message inclusion is the conversation's through compaction and, when a handler is set, the selection's. The loop filters the advertised definitions by `scope.tools`, so a scoped-out tool is neither described nor callable, and `build()` never contains a tool's name or schema.
- **The agent loop (`Agent` / `createAgent`).** `Agent` builds the provider input, then iterates up to `limit`: stream a turn, fold its usage, append any assistant tool calls, and dispatch them. Each `ToolResult` becomes a tool message whose `call` names the paired call, in the reply's call order, because ids can repeat; a string value is the content unchanged, `undefined` is `''`, another value is its `JSON.stringify` text, or `String(value)` when JSON can't carry it, and a failure's content is its `error`. A reply with no tool calls ends the loop.
- **One run shared by `generate` and `stream`.** `generate` drains the private run `stream` exposes, so a `generate` result deep-equals a drained `stream` on the same input.
- **The `AgentChunk` stream.** `stream().events` yields, per turn, each answer delta as `token`, each reasoning delta as `think`, then optional `usage`, then one `ask` chunk per asked call, then one `tool` chunk per dispatched call. `result` resolves the settled `AgentResult`: the content, the joined thinking, the summed optional usage, `partial`, and the optional `stop`. A `usage` chunk carries the call's streamed-answer `estimate` beside its usage.
- **Bounded, paced, capped.** Each run folds the external `signal`, the `timeout`, and the `budget` and `allowance` signals into one cancel; a cancel resolves `{ partial: true, content }` with what streamed, while a genuine provider or tool error rejects `result` and sets `status` to `error`. `scheduler.yield` runs between turns and never after the last, and `limit` caps tool iteration.
- **Pull and push observation on the `Agent`; the rest event-free.** The provider contract, the conversation registry, and the context carry no emitter, while the instruction and scope managers and each conversation own one. The `Agent` pairs the `AgentChunk` stream with an `emitter` over `AgentEventMap` (`start`, `turn`, `tool`, `usage`, `allow`, `ask`, `deny`, `finish`, `error`, `abort`, `exhaust`, `fault`, `select`) and has no `token` or `think` event. The emitter routes a listener throw to the `error` option, and a cancelled run emits `abort` then `finish`.
- **Doc ↔ source method bijection.** The `## Methods` tables list exactly the call-signature members of every interface named there, and each implementing class exposes exactly its interface's methods.
- **The authority gate (`Authority` / `createAuthority`).** `evaluate({ call })` walks the ordered `rules` first-match-wins, a matched rule allowing unless its `verdict` is `ask` or `deny`, and returns the `fallback` when none match, which defaults to `{ zone: DEFAULT_AUTHORITY_ZONE, verdict: 'allow' }`. `evaluate` is synchronous. `ask(context, decision, signal)` resolves the `ask` option's answer and rejects with an `AgentError` coded `'APPROVER'` when no handler is set. The gate is event-free.
- **A denied call is fed back, never executed.** The loop consults `authority`, or a default `Authority` when none is set, after scope admits a call. A call no definition advertises is denied with the scope note before the authority evaluates it, under every verdict, and its `deny` event carries no decision. A `deny` verdict, and an `ask` the approver refuses or leaves unanswered, become the failure arm `{ success: false, id, name, error }` without running the tool. A call that `allow` cleared whose tool is replaced or removed before dispatch is denied too: the model reads the `denied` note of `AUTHORITY_NOTES`, and its `deny` event carries the reason `<name> changed after its decision` and no decision. Executed results and denials merge in the reply's call order, each producing a `tool` chunk and a tool message.
- **Durable, serializable agent jobs (`AgentJobInput` + `AgentRegistry`).** An `AgentJobInput` names its `provider`, `tools`, `authority`, and `scheduler` and carries its data directly, and `AgentRegistry.build(input, signal?)` rehydrates a seeded, signal-wired `Agent` from the named pools. An unknown name throws `AgentError` with code `REGISTRY` and the message `unknown <category>: <name>`.
- **Partial is a configurable failure (`partial`).** A durable job's handler throws `AgentJobError` carrying the partial `AgentResult` unless `partial: true`, which resolves the partial as success. `isAgentJobError` narrows a caught value.
- **Concurrency, retries, and persistence come from the substrate.** `createAgentQueue` composes `createQueue` and `createAgentRunner` composes `createRunner`, adding only rehydration through the registry and the partial policy.
- **Sub-agent fan-out through `controller.spawn`.** A runner job's handler spawns each declared child through `controller.spawn`, and the child runs as a sub-agent beside the parent. Both pass their signal into `registry.build`, so a queue or runner cancel commits the rehydrated agent's partial. A unit spawns its declared children on its first attempt only, so a retried parent never runs a child twice: the runner's handler is the `execute` method of one `AgentFanout`, which records each unit it fanned out.
- **The conversation layer (`Conversation` + `ConversationManager`).** `compact()` folds the oldest `count - keep` live messages through the `ConversationSummaryHandler` into a `Section`, stopping before the newest user message, moving a cut inside an exchange back to its start so a fold removes whole exchanges, folding the messages before the first user message, which form their own exchange, only together with the first user exchange, and moving a cut that would split an assistant call from its tool results before that call, emits `compact`, and throws `ConversationError` with code `SUMMARIZER` when no summarizer was supplied. Calls run one at a time, and a fold commits only when its messages are still the live entries after the summarizer settles. A `remove` or `clear` during the initial summarizer leaves no section. A summarizer must not compact the conversation it serves: with no other fold in flight, its own call summarizes the same slice again, and one section commits. An abort of `CompactOptions.signal` rejects with the reason at once and commits nothing after the abort; a fold committed before an aborted overflow merge stays. `view()` renders each section as one assistant recap prefixed with `CONVERSATION_RECAP_PREFIX`, then the live tail, while `rehydrate`, `search`, and `reference` are pure reads. `ConversationManager` is the event-free id-keyed registry with an active pointer, `switch`, and the `open` / `save` store seam.
- **The context's default conversation and a run's conversation.** `context.messages` is the `conversations` registry's active conversation, always defined and read on each access, so it follows `conversations.switch(id)`. A run binds its conversation once, at its `stream()` or `generate()` call: `AgentRunOptions.conversation`, else the active one. The run appends `AgentRunOptions.prompt` to that conversation as a `user` turn after its guards, or reads its request from the conversation's tail when it has no `prompt`, then selects and builds over its `view()`, appends every assistant and tool message to it, and folds it under `window`, so a later `switch`, `open`, `remove`, `clear`, or same-id `add` never moves a live run, and the conversation needs no registration.
- **Automatic compaction (the context `window` budget).** With `AgentOptions.window` set and a summarizable run conversation, the loop measures each request it will send, with its messages after the `replay` policy, its advertised tools, and its per-call `options`, against the window before the first provider request and between turns, and compacts and rebuilds when the window is exhausted. A summarizer throw emits `fault` and the run continues over-window unless `strict` is set, and a fold that compacts nothing between turns while over the window stops auto-compaction for the rest of the run. A run whose signal aborted by the end of tool dispatch folds nothing before it settles. When no selection handler runs, and either `window` is absent or the run's conversation has no summarizer, the loop adds no `await` before the first provider request.
- **Active workspace rendering by carrier.** `build()` reads only the active workspace, filters its files through `scope.files`, renders text files under `WORKSPACE_SECTION_HEADER` through `renderFencedFile` into one `user` context message with a minted id, which is never stored, and attaches the base64 data of binary `image/` files to a copy of the last user message of the conversation. With no active workspace, or no text file, the context message holds the memos index alone, and with no memos index either, no context message renders.
- **The durable `ConversationStore` + the manager's `open` / `save` seam.** A `ConversationSnapshot` is the JSON payload `{ id, sections, messages, judgments? }`, created by `snapshot()` and restored through `ConversationInput.snapshot` without emitting events. `MemoryConversationStore` keeps snapshots in a map and `DatabaseConversationStore` in one opaque JSON column narrowed by `isConversationSnapshot`, both through `get`, `set`, and `delete`. `open(id)` activates a registry hit or hydrates a store hit, keeps a conversation registered under `id` during the store read, and refuses a snapshot whose `id` is not `id`; `DatabaseConversationStore.get` refuses such a row too. A stored snapshot that holds a `system` role rejects `open` with `ConversationError` `'ROLE'`, the registry and `active` unchanged. `save(id)` returns `false` when no store or conversation exists. `MemoStoreInterface` is the memo twin: `MemoryMemoStore` and `DatabaseMemoStore` persist a `MemoSnapshot` by its memo set id through `get`, `set`, and `delete`, and the host authors what it stores, because a memo can be model-written and a stored memo set hydrates as written after `isMemoSnapshot` accepts it.
- **Limit exhaustion, the three failure layers, and per-run options.** A run that exhausts `limit` while its last turn still requested tools settles `partial: true` and emits `exhaust` instead of `abort`. The loop charges the `allowance` mid-stream from the `estimateTokens` estimate of each turn's content, and charges the cost `budget` the reported usage after each call, net of the estimate only when the `allowance` is the `budget`, or the estimate when the call reported none, a call that failed with a genuine provider error included; it never charges twice. `AgentResult.stop` names the one layer, `meter`, `budget`, or `model`, that stopped the final provider call first. `AgentRunOptions` members override their construction defaults for one run, `conversation` and `prompt` have no construction default, a per-run `signal` composes with the constructed one, and `think` and `schema` reach the provider in one options object, omitted when both are absent. A construction or per-run `limit` that is not a nonnegative safe integer throws `AgentError` with code `LIMIT`.
- **Construction-time context wiring.** `AgentOptions.instructions`, `skills`, `memos`, `workspaces`, `scope`, `conversations`, and `select` forward into the `AgentContext` the constructor builds.
- **`strict` — fault escalation.** With `AgentOptions.strict` set, an automatic-compaction summarizer failure and each selection fault emit `fault` and then settle the run `error`; without it, the run continues. A strict run also refuses a request still over the window with `AgentError` `'WINDOW'`, whose message reads `the request measures <consumed> against a window of <max> and this run folds no further`. A cancel at a select site wins over `strict`, and a manual `conversation.compact()` always propagates its own error.
- **Bounded `sections`.** A `sections` cap, set per conversation, as a manager default, or per `compact()` call, bounds `Conversation.sections` to at most `Math.ceil(sections)` entries after a successful merge; when a fold exceeds it, the oldest sections merge into one through a summarizer call and `collapse` fires. A cap below 1 throws `ConversationError` with code `SECTIONS`, and a `keep` that is not a nonnegative safe integer throws it with code `KEEP`. A digest that is not a string or whose trimmed text is empty refuses the fold it would commit with `'SUMMARY'`; such a digest for a capped merge refuses the merge and keeps the fold already committed, one section over the cap, which the next sound merge collapses.
- **`cumulative` folds.** `ConversationOptions.cumulative` and `ConversationInput.cumulative` are booleans that default to `false`; the manager holds no default and `CompactOptions` has no member. A cumulative `compact()` makes one summarizer call over the framed recaps of every prior section followed by the eligible live slice with thinking stripped, using the same cut rules and protecting the newest user exchange. After the call settles and the abort check passes, it verifies the slice and the prior sections are unchanged, then replaces all prior sections with one section holding their original messages in order followed by the slice, removes only the slice from the live tail, and emits `compact` once with no `collapse`. A throw, an abort, or a changed input commits nothing, and a fold with no eligible slice makes no call. The originals behind the recaps are never sent to the summarizer, and a hydrated snapshot with several sections folds them all at the next fold that has an eligible slice. Combining `cumulative` with a `sections` cap, whether configured, inherited from a manager, or passed to `compact()`, throws `ConversationError` with code `SECTIONS`.
- **The compaction floor on one recording.** The smallest request a fold can leave holds every recap, the exchange that `keep` retains, and the new request. One recorded run reads it: a scripted support-desk conversation, one desk request per goal, on Qwen 3.5 2B `q4_K_M` on Ollama 0.40.13 on 2026-11-02 and 2026-11-03, under `keep: 2`, `strict`, and a window of 11776 tokens with 8192 tokens reserved for output, measured by a study gauge that adds 354 tokens to the estimate. That is the study's configuration and not Agent's defaults. At goal 35 the conversation held 118 folded messages of 182898 characters (median 580, 95th percentile 4913, maximum 5030), 7 recaps of 33822 characters, and 4 live messages of 17925 characters. After eight folds, with recaps of 567 to 1882 tokens summing to 8993, the rebuilt request at goal 36 measured 11940 against 11776, and the run refused it with `AgentError` `'WINDOW'` before any dispatch.

  With `strict` false, the default, no error and no agent event marks that point: the loop sends the over-window request, and no reading covers the provider's behavior past its window. The `consumed` and `exhausted` members of your `window` `Budget` read the last request the loop measured, so read them after a run, or set `strict`.

  From that stop, `compact({ keep: 0 })` frees one request: with a scripted summarizer and the same text, under a gauge overhead of 352, the next request measured 10358 tokens with 9 recaps, the new recap being the recorded 2385 characters. A conversation at `keep: 0` from goal 35, whose fold at goal 36 takes 4 messages and leaves 8 recaps, measured 9750 under that recap and 11139 under a recap of 7942 characters. The sections stay, so each later fold adds a recap against the same window. Only a `sections` cap or `cumulative` lowers that smallest request, and each needs a fold with an eligible slice. At that stop under `keep: 2` the live tail is a user, an assistant, and a user message, so `compact()` folds nothing and a strict retry refuses again; the sections merge at `compact({ keep: 0 })` or at the admission of a later run whose new prompt leaves an eligible slice. The two can't combine. `cumulative` has no per-call form, so it needs a conversation rebuilt from `snapshot()` with `ConversationInput.cumulative`. A host that reserves less output can set a larger `max` on the same model.

  Beside that stop, `cumulative` has a reading and no recommendation. Seeded from that run's goal 32 on Ollama 0.40.14, it sealed goals 33 to 48 with three folds, each into one section, and the first prompts after those folds read 2958 to 3192 tokens, where the first prompts after the first seven folds of the run without it read 2733 to 11176. Its recaps kept fewer literals by `extractLiterals`: at goal 48, 11 of 170 ids and 14 of 112 numbers of 147 folded messages (254018 characters, median 577, 95th percentile 6716, maximum 6911) in a recap of 3456 characters; at goal 34, 14 of 138 ids and 15 of 96 numbers of 116 folded messages (177397 characters, median 580, 95th percentile 4824, maximum 5030) in a recap of 4844 characters. The run without it kept 57 of 138 ids and 41 of 96 numbers over the same 116 messages at goal 34, in 6 recaps of 31077 characters, and 48 of 122 ids and 41 of 87 numbers over 104 messages of 158238 characters at goal 32, in 5 recaps of 23135 characters. The originals stay on the section, and `search` and `rehydrate` read them back; they reach the model only through a tool the host registers, and Agent ships none. This is one arm, one seed, and one recording on two Ollama versions, so the figures state no cause, and no quality label reads these recaps. No reading on this model compares a `sections` cap with `cumulative`.

- **`sanitizeUsage`.** `sanitizeToken` turns a non-finite or non-positive count into `0` and floors a positive fraction, and `sanitizeUsage` applies it to each field. The loop sanitizes a provider's usage and an abort partial's usage before charging or folding it.
- **`AgentError` — the concurrency guard.** `stream()` throws `AgentError` with code `CONCURRENCY` and `context: { agent }` synchronously when a run is in flight and the agent carries a `window`, or when the run's effective `budget` or `allowance` is an instance a live run holds; after those checks it throws one with `context: { agent, conversation }`, naming the conversation's id, when a live run is bound to the run's conversation. Runs holding distinct instances on distinct conversations with no `window` overlap. The refused run never starts either bound, so the live run stays bound to it. The guard compares conversation instances: two `Conversation` values opened from one stored snapshot are distinct to it and run at once on an agent with no `window` and distinct budgets, so a host opens each thread once and keys its thread registry by principal and thread. A `prompt` that is not an exact `AgentPrompt`, a `budget` or `allowance` that does not implement `BudgetInterface`, or a `conversation` that does not implement `ConversationInterface` throws `ContractError` with code `placement` before either bound starts, and a refused run appends no `prompt`. `isAgentError` narrows a caught value, and a `REGISTRY` error's `context` names the `category` and `name`.
- **`agentResultToJSON` — the portable `AgentResult` projection.** The helper accepts `unknown`, never throws, reads each structural field once, and returns a fresh exact `{ content, thinking?, usage?, partial, stop? }` `JSONValue`, or `undefined` for invalid input; a malformed `stop` refuses the whole value. Finite negative and fractional usage counts are preserved, and extra fields are dropped.
- **The provider engine's request and stream.** The engine posts `JSON.stringify(encode(request))` to `url + (path ?? '')` with a JSON content type the `headers` hook can extend, decodes the body through `readChunks`, and feeds every framed record and the `finish` tail through `read`. A record whose `read` returns a `result` ends the call with that result, and with `strict: true` a stream that ends with no settled result throws `ProviderError` with code `PROTOCOL`. A non-OK body is read through `readBodyText` to at most `MAX_ERROR_BODY_LENGTH` bytes and its remainder cancelled, and each reader releases its lock on every exit.
- **The wire shapes and the compiled contracts.** The shapes declare each JSON projection and the contracts compile them, each strictly narrower than its domain type, so a value JSON can't carry is refused rather than dropped and a `ToolContext` appears in no wire shape. `RelayProvider.encode` projects the request through `requestToRelay`, which reads each declared member as the request presents it: a getter runs, and an inherited declared member crosses. The clone of that projection uses property descriptors and consults no getter, prototype, or `toJSON` serializer; a non-JSON value is refused before fetching.
- **The relay protocol (`createRelay` / `RelayStream` / `RelayProvider`).** The request is a `POST` of one `providerRequestContract` document, and the response is newline-delimited `RelayFrame` records under `RELAY_CONTENT_TYPE`, written under backpressure, with every upstream failure reduced to `RELAY_PROVIDER_MESSAGE`. `authorize` is mandatory and runs before the body is read; the handler answers `401`, `413` at the byte `limit`, `400`, or `502` with no body, or `422` with one `text/plain` line per page `system` message or tool definition its policy refuses, and the browser receives each as a `ProviderError` with code `HTTP`. An inbound abort, a client disconnecting included, cancels the upstream turn.
- **`ProviderError` and its codes.** `ProviderError` carries a `code` and, for `HTTP` alone, a `status`: `HTTP` reports a non-OK response as `provider error: <status>` with ` - <excerpt>` only when the error body had text, `PROTOCOL` a missing body, a refused record, or a `strict` stream with no settled result, and `PROVIDER` a relay `error` frame. A cancel throws `ProviderAbortError`, never `ProviderError`.
- **The judge boundary (`JudgeInterface`).** `JudgeInterface` is the sibling of `ProviderInterface` and never a provider: `ask(request, signal)` answers each question of a `JudgeRequest` about its one `state`, keyed by caller ids the prompt never carries. An id appears in `answers` or in `refusals`, never both, `refusals` is absent when nothing was refused, and a `Refusal` invents no probability.
- **The stored distribution and the derived measure (`measureAnswer`).** An answer stores only its distribution, and `measureAnswer` derives the `AnswerMeasure`: `winner` is the first strictly greatest candidate in enumeration order, so a noul of exactly 0.5 names `'false'`, and `probability` is the winner's. `confidence` is `(max(p) - 1/n) / (1 - 1/n)` for a choice, `|2p - 1|` for a noul, and for a score one minus the probability-weighted distance from the winning level over the mean distance from the middle level, floored at 0, and `score`, the expected level `sum(i * p_i)`, is set for a score answer alone. A choice or score with fewer than 2 candidates throws `JudgeError` with code `PROTOCOL`.
- **The protocol's null and the absence law.** An undescribed choice option or score level stays `null`, because JSON carries no `undefined` member and a level is positional, while `instructions`, `NoulCriteria`, and each noul side are omitted when absent and `isJudgeQuestion` refuses a `null` there. The System One wire sends an omitted member omitted and a `null` criterion as `null`.
- **Validation before inference and the server's limits.** `ask` refuses an invalid `state`, an empty question map, or a question `isJudgeQuestion` rejects with `JudgeError` code `QUESTION` before any call, and a wire can refuse its own limits the same way. A server refusal throws code `HTTP` with the response `status` and the message `judge error: <status>`, plus ` - <excerpt>` read from at most `MAX_ERROR_BODY_LENGTH` bytes when the body has text, and a `null` or non-JSON success body throws code `PROTOCOL`.
- **Each call's own deadline, and the abort partial (`JudgeAbortError`).** Each call runs under a `Timeout` of `AgentJudgeInput.timeout` milliseconds (`DEFAULT_PROVIDER_TIMEOUT` when omitted) folded with the caller's signal, covering the `headers` hook, the transport, both body reads, and `read`. A cancel throws `JudgeAbortError` whose `partial` merges the answers, refusals, and usage of the completed calls, with a throw that raced the cancel as its `cause`. A cancel that lands while `read` decodes the answer is reported with no `cause`, and that call's answer is left out of the `partial`.
- **The batch switch and the merge (`buildJudgeResult`).** `AgentJudgeInput.batch` (default `true`) sends every question in one call, and `false` sends one call per question in key order with the shared `state`, every body built before the first call. `buildJudgeResult` joins answers and refusals by id, sums each call's sanitized usage, and takes `model` from the first call, or the configured `model` when no call completed.
- **The System One wire (`SystemOneJudge` / `createSystemOneJudge`).** `SystemOneJudge` posts every question in one call to `url` plus `SYSTEM_ONE_PATH`, writing `form` as `type` and leaving an omitted member omitted, and decodes each requested id in criteria order, accepting a score's `probabilities` as a map or an array. It ignores unrequested answers and the server's `confidence`, `score`, `choice`, and `legend` members, so `measureAnswer` derives every measure locally. A System One server answers only from the supplied options, so the wire never reports a refusal: a missing, mismatched, or out-of-range answer throws `JudgeError` with code `PROTOCOL` naming the question id.
- **The System One response model and usage.** On the System One wire, `JudgeResult.model` reports the model the response named, verbatim, and a response that names no model reports the configured `model` option. `extractSystemOneUsage` maps `input_tokens` and `output_tokens` onto `{ prompt, completion, total }`, and `usage` is absent when either count is missing, `null`, negative, or not finite.
- **Header-hook authentication.** Both engines read the `headers` hook through `buildProviderHeaders`: the headers start from `Content-Type: application/json`, the hook is awaited with the call's combined signal and raced against it, and each entry it returns is set over the defaults.
- **Two selection homes.** `AgentOptions.select` is the agent default and the active scope's `select` overrides it, and `context.select` resolves the handler once per call and returns `undefined` when neither home holds one, so the default path awaits nothing.
- **Select sites and the receipt.** The loop calls the handler with the request captured at run entry and the run's signal at run entry, the pre-first-turn compaction fold, and each compaction rebuild, folds the result through `build(selection)`, which carries `selection.messages` after the unchanged system and context messages, and then emits `select`. A `Selection` has no tool member, so advertising and admission stay the scope's.
- **Selection faults.** A thrown handler, a returned `fault`, a conversation changed under the handler, and a selected `system` message, carrying `ConversationError` `'ROLE'` over `view()`, each emit `fault`; a throw builds from `view()` with no `select` event, and a returned `fault` charges its usage before `fault` fires. With `strict` set, each settles the run `error`. A cancel at a select site wins over every fault, and the run commits partial without a further provider call.
- **Selection cost.** Selection usage is charged in full to the cost `budget` and folded into `AgentResult.usage`, with no `usage` chunk or `usage` event.
- **Judgments.** A conversation's `judgments` store keys each record by the caller's question id, last write wins in place, stamps `time` on `add`, attaches `usage` only for a one-question request, and returns each record deep-frozen. `resolve` reuses each record whose question JSON value, ordered sources, rendered state, and configured judge `model` match, asks once for the rest, and keeps the completed records when a cancel interrupts it.
- **Judgments in a snapshot.** A snapshot carries `judgments` only while the store holds one, and a snapshot without the member validates and restores. Its judgments are the stored frozen records, so copy one before you edit it, and hydrating takes an owned frozen copy. A judgment whose `usage` member is present with the value `undefined` is refused, so omit the member from an in-memory snapshot. `isJudgment` and `isMemo` are guard constants, so each reads an empty `.name`.

## Patterns

### Bounding any provider call

`ProviderInterface.generate` / `.stream` take a plain `AbortSignal`, so fold an [abort](abort.md), a [timeout](timeout.md), and a token [budget](budget.md) into one bound through `AbortSignal.any` — whichever trips first cancels the call. This works for any provider. A provider built on `AgentProvider` arms its own deadline as well (`AgentProviderInput.timeout`, `DEFAULT_PROVIDER_TIMEOUT` when omitted) and folds it with the signal you pass, so the bound here is the caller's ceiling and the engine's deadline is the backend's — pass a tighter signal to shorten a call, and construct the provider with a tighter `timeout` to shorten every call it makes.

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createAbort } from '@orkestrel/abort'
import { createTimeout } from '@orkestrel/timeout'
import { createTokenBudget } from '@orkestrel/budget'

declare const provider: ProviderInterface // any concrete implementation supplied by the host app
const messages = [{ id: '1', role: 'user', content: 'Say hello.' }] as const
const abort = createAbort() // external cancel
const timeout = createTimeout({ ms: 30_000 }) // wall-clock deadline
const budget = createTokenBudget({ max: 50_000, scope: 'total' }) // cost ceiling
timeout.start()
budget.start()

const bound = AbortSignal.any([abort.signal, timeout.signal, budget.signal])
const result = await provider.generate(messages, bound)
budget.consume(result.usage ?? { prompt: 0, completion: 0, total: 0 })
```

### Writing a provider for a new wire

Reach a backend that this package doesn't ship a provider for by extending `AgentProvider` rather than implementing `ProviderInterface` from nothing. The base already holds the deadline, the transport, the `headers` hook, the request, the bounded error read, the decode loop, reasoning separation, and result assembly (the provider-engine clause), so a subclass is the wire and nothing else: `name` identifies the backend, `frame` returns fresh framing state for the call, `encode` projects a `ProviderRequest` onto the vendor's request shape, `read` turns one framed record into a `ProviderIncrement`, and `finish` hands back whatever the parser still held at end of input. Pass the vendor's endpoint through `super`, and set `split` and `strict` to match what the wire actually delivers. The fence writes `AgentProvider<string>` because this wire frames nothing: each decoded chunk is one raw-text record, so `TRecord` is `string`. A wire that frames JSON objects extends bare `AgentProvider` and takes the default record type, and a wire with its own record type names that type instead.

```ts
import type {
	ProviderIncrement,
	ProviderOptions,
	ProviderParserInterface,
	ProviderRequest,
} from '@orkestrel/agent'
import { AgentProvider } from '@orkestrel/agent'

class TextFrame implements ProviderParserInterface<string> {
	parse(chunk: string): readonly string[] {
		return [chunk]
	}
	clear(): void {} // Raw text retains no framing state.
}

interface TextOptions extends ProviderOptions {
	readonly url: string
}

class TextProvider extends AgentProvider<string> {
	readonly name = 'text'
	constructor(options: TextOptions) {
		super({ ...options, path: '/generate' })
	}
	frame(): ProviderParserInterface<string> {
		return new TextFrame()
	}
	encode(request: ProviderRequest): object {
		return { messages: request.messages }
	}
	read(record: string): ProviderIncrement {
		return { content: record, thinking: '', tools: [] }
	}
	finish(_parser: ProviderParserInterface<string>): readonly string[] {
		return [] // Raw text retains no records at end of input.
	}
}
```

That provider drives the whole runtime unchanged — `createAgent`, the tool loop, the authority gate, and durable jobs all read it through `ProviderInterface`. Take the switches deliberately. Leave `split` at its default when the backend inlines its reasoning as `<think>` spans in the answer, and set `split: false` when the backend already separates reasoning onto its own field, because splitting twice re-classifies text the backend has already ruled on. Set `strict: true` when the protocol always ends with a settled record and a stream that stops short is a protocol failure worth reporting; leave it `false` when the answer is assembled from the deltas themselves.

### Asking a System One server a choice, a noul, and a score

Ask every question about one state in one request, and read each answer with the `measureAnswer` function. The `SystemOneJudge` class speaks the System One decision protocol. Its wire was recorded against Ollama 0.40.0 serving the `tev1:0.8b` model on 2026-10-07. It also accepts a score's `probabilities` and `legend` as an array, and it drops the measures a server adds beside the distribution. Point the `url` option at the server origin; the wire appends the `SYSTEM_ONE_PATH` constant and fills the request's `model` member from the judge's configured model.

```ts
import { measureAnswer, createSystemOneJudge } from '@orkestrel/agent'

const judge = createSystemOneJudge({ url: 'http://localhost:11434', model: 'tev1:0.8b' })
const result = await judge.ask(
	{
		state: 'Our checkout has returned 500 errors since 9am. I want a refund for today.',
		questions: {
			label: {
				form: 'choice',
				instructions: 'Which label fits this ticket?',
				criteria: { billing: 'Payments and refunds', bug: 'Software errors', account: null },
			},
			refund: {
				form: 'noul',
				instructions: 'Does the customer ask for money back?',
				criteria: {
					true: 'The customer asks for a refund or for money back.',
					false: 'The customer does not ask for money back.',
				},
			},
			severity: {
				form: 'score',
				instructions: 'How severe is the reported issue?',
				criteria: ['Cosmetic; no impact', 'Degraded, workaround exists', 'Blocking; no workaround'],
			},
		},
	},
	AbortSignal.timeout(30_000),
)
const measures = Object.fromEntries(
	Object.entries(result.answers).map(([id, answer]) => [id, measureAnswer(answer)]),
)
result.model // 'tev1:0.8b' — the model the server named
result.usage // { prompt: 975, completion: 4, total: 979 }
measures.label // { winner: 'bug', probability: 0.9691, confidence: 0.9536 } to 4 decimals
measures.refund // { winner: 'true', probability: 0.9979, confidence: 0.9958 } to 4 decimals
measures.severity // { winner: '1', probability: 0.9494, confidence: 0.9241, score: 0.9919 } to 4 decimals
```

The values in the comments are the measures of the response Ollama 0.40.0 returned for this request on 2026-10-07. That same response carried the server's own measures, and the wire drops them: a `confidence` of 0.8718 for `label` and 0.7864 for `severity`, where the published formulas read 0.9536 and 0.9241. A server's own measures can follow other formulas, while the stored `probabilities` and `noul` mean the same on every server, so the `measureAnswer` function derives each measure locally and every server reads on one scale. A `choice` member repeats the most likely option and a `legend` member repeats the question's criteria, so the wire drops both as well (the System One wire clause).

A server that takes a key receives it through the `headers` hook, which each call awaits inside its own deadline (the header-hook authentication clause). TypeSafe Jev takes a bearer key:

```ts
import { createSystemOneJudge } from '@orkestrel/agent'

declare const key: string // the TypeSafe API key, read from the host's secret store

const jev = createSystemOneJudge({
	url: 'https://api.typesafe.ai',
	model: 'jev-latest',
	headers: () => ({ authorization: `Bearer ${key}` }), // awaited inside each call's deadline
})
```

The executed transcription serves the recorded Ollama response from a loopback `@orkestrel/server` listener and points the first fence's `url` option at that listener in place of `http://localhost:11434`, and it supplies a recording `fetch` transport to the second fence in place of the network; see [the `tests/guides.test.ts` parity test](../tests/guides.test.ts). It also decodes the same distribution in its array form and with extra server measures, both transliterated from that recording, and reads the same answers from all three.

### Writing a judge wire

Reach a decision server this package doesn't speak by extending `AgentJudge` rather than implementing `JudgeInterface` from nothing. The engine already holds each call's deadline, the transport, the `headers` hook, the validation before inference, the bounded error read, and the merge of the calls (the batch-switch clause), so a subclass is the wire and nothing else: `name` identifies it, `encode` projects one call's `JudgeRequest` onto the server's request shape, and `read` decodes one call's parsed response into a `JudgeResult`. This server reads one question per call, so the fence sets `batch: false`.

```ts
import type { JudgeRequest, JudgeResult } from '@orkestrel/agent'
import { AgentJudge, JudgeError } from '@orkestrel/agent'
import { isFiniteNumber, isRecord } from '@orkestrel/contract'

// A wire whose server answers one yes/no question per call as { "yes": 0.93 }.
class YesJudge extends AgentJudge {
	readonly name = 'yes'
	encode(request: JudgeRequest): object {
		return { model: this.model, state: request.state, questions: request.questions }
	}
	read(value: unknown, request: JudgeRequest): JudgeResult {
		const [id] = Object.keys(request.questions)
		if (id === undefined || !isRecord(value) || !isFiniteNumber(value.yes)) {
			throw new JudgeError('PROTOCOL', 'judge error: unreadable answer')
		}
		return { model: this.model, answers: { [id]: { form: 'noul', noul: value.yes } } }
	}
}

const judge = new YesJudge({
	url: 'http://localhost:8010',
	path: '/v1/yes',
	model: 'yes-1',
	batch: false,
})
```

That judge answers through `ask` like any other. With `batch: false` the engine makes one call per question in key order, each carrying the shared `state` and one question, and merges their answers into one `JudgeResult`. Throw `JudgeError` with code `PROTOCOL` from `read` for a response the wire can't read; the engine passes it to the caller unchanged. Throw `JudgeError` with code `QUESTION` from `encode` for a question the protocol can't carry; the engine builds every body before the first call, so that refusal lands before any inference. A wire that reads candidates out of a model's own output and can't find one returns a `Refusal` under `refusals`, listing the caller's keys it couldn't read, instead of inventing a probability.

### The request layout

Every configuration sends one request layout, position by position. The following table lists what fills each position under each strategy:

| Position               | Plain agent                                                                                             | Automatic compaction                                                                            | Ledger, first pass of a request                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system`               | the `system` option, then `## Instructions`, then `## Skills`; absent when all are empty                | the same                                                                                        | the `system` option, then `## Instructions` and `## Skills` from the `agent` option                                                                         |
| `user` context message | `## Memos`, then `## Workspace`; absent when both are empty; a minted id, never stored and never folded | the same                                                                                        | the same, from the `agent` option                                                                                                                           |
| Tail                   | `view()`                                                                                                | one `assistant` recap per section, opening with `CONVERSATION_RECAP_PREFIX`, then the live tail | the seed tail, with each lookup result as its stub                                                                                                          |
| Request                | the last stored `user` message; images attach here                                                      | the same                                                                                        | a built copy of the `user` turn: `## Records`, `## Rules`, and `## Request` before the prompt, or the prompt alone when nothing renders; images attach here |
| Run turns              | each `assistant` message with its calls, then one `tool` message per call                               | the same                                                                                        | the same                                                                                                                                                    |

A host writes the `system` message through the `system` option, `instructions.add`, a skill load, and the skill index, and nothing else reaches it. A stored message plays `user`, `assistant`, or `tool`: `add`, a snapshot, a job seed, and a selection each refuse a `system` role with `ConversationError` `'ROLE'`. `Conversation.reference()` returns text for a `user` message or a workspace file, and it never belongs in the `system` message. Because an instruction never folds, a rule in an instruction survives every round of compaction, and a host scope with an explicit `instructions` allow-list filters a loaded `skill:<name>` instruction. The skills index stays inert until a host registers a loading tool, as the `SkillManager` paragraph states.

### Serving one agent per principal

Hold one session entry per authenticated principal, built once from shared providers, tools, rules, and immutable host text. Name the entries for what each placement holds: `{ agent, threads }` for the Node fence under [binding a run to its thread](#one-agent-per-principal-one-conversation-per-run-binding-a-run-to-its-thread), and `{ agent, threads, approver }` for the wire fence under [Serving a Node agent to a page](#serving-a-node-agent-to-a-page), whose approver is required. Each is its own type. The following rules hold for both:

- **What one `Agent` shares.** A per-principal `Agent` shares its workspace pointer, scope, instructions, memos, emitter, and `agent.abort()` across that principal's threads. So name the thread per run through `AgentRunOptions.conversation`, because `switch` sets only the default. Forward a run's own `events` and cancel with its own `abort` or `signal`, because the emitter's events carry no run identity and `agent.abort()` cancels every live run of that agent. Agent keeps one workspace pointer per agent, so a `workspaces.switch` during one thread's run reaches the next build site of every thread that agent is running.
- **The `window`, `budget`, and `allowance` rule.** Each session entry builds its own `window`, `budget`, and `allowance`, never shared across principals. While one run is live, an `Agent` built with a `window`, a `budget`, or an `allowance` refuses that principal's next run on any thread with `AgentError` `'CONCURRENCY'` and never queues it.
- **The `409` or rethrow mapping.** The Node fence's `handle` rejects with that error, and the caller rethrows it or maps it. The wire fence's frame route answers `409`.
- **A run the host can't finish.** The host bounds it through a `timeout` or `signal` it passes to that run, or through `agent.abort()`, because under such an `Agent` a run that never settles refuses every later run of that principal.
- **The kept tail.** A run that rejects, aborts, or times out before any assistant append leaves the user turn as the thread's tail; the next request carries it unanswered directly before the new turn, so the model might answer it or call tools for it, and a call the authority allows outright runs without asking. An application that wants a cancelled ask withdrawn removes the thread's tail after the run settles while that tail is still a `user` turn whose `content` equals the prompt it sent.
- **The store keyed by principal.** `open` and `save` key a snapshot by conversation id alone, so key any durable conversation store by principal, and key a memo set's `id` the same way.
- **An orphaned instance.** A run stays bound to the conversation instance it named, so a `remove`, `clear`, or same-id `add` leaves that instance live and appended to while the registry holds another. Open each thread once, because the concurrency guard compares instances and two values opened from one stored snapshot both run on an agent with no `window` and distinct budgets. The application owns the session entry's lifetime and eviction.

### Who writes and who enforces each inlet

A model-facing inlet has one side that writes it and one side that enforces what reaches the model, and the placements under [Placement proofs](#placement-proofs) divide them differently. The following table reads each cell as writer, then enforcer, and [Serving one agent per principal](#serving-one-agent-per-principal) holds the session table each server placement keeps:

| Inlet                                                 | Node alone                                                    | Page alone                                        | Page to Node relay                                                                                                           | Page to Node agent                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| System text, instructions, the skill index and bodies | host code in Node, then the Node loop                         | the page, then nothing beyond the page's own code | the server through `RelaySystemOptions.text`, and the page only where `accept` admits it, then `createRelay` with `422`      | host code in Node, then the Node loop                                                                                  |
| Tool definitions                                      | host code in Node, then the Node loop's scope and `Authority` | the page, then the page's own loop                | the server through `RelayToolOptions.definitions`, and the page only where `accept` admits it, then `createRelay` with `422` | host code in Node, then the Node loop's scope and `Authority`                                                          |
| Deny reasons                                          | the host's rules in Node, then the Node loop                  | the page's rules, then the page's loop            | the page's rules, then the page's loop                                                                                       | the host's rules in Node, then the Node loop                                                                           |
| Memos and workspace                                   | the host or a host tool in Node, then the Node context        | the page, then the page's context                 | the page, then the page's context, and the server forwards them as a `user` message                                          | the host or a host tool in Node, then the Node context                                                                 |
| The conversation                                      | the host in Node, then the stored-role checks                 | the page, then the stored-role checks             | the page, then the page's stored-role checks and the relay's refusal of a page `system` message                              | one `AgentPrompt` from the page and every other turn from Node, then the exact prompt check and the stored-role checks |
| Tool results                                          | the handler in Node, then the Node loop                       | the page's handler, then the page's loop          | the page's handler, then the page's loop, and the server forwards each as history                                            | the handler in Node, then the Node loop                                                                                |

The following rules complete the table:

- The thread id is bound to the principal: look it up only in that principal's registry, and key any durable conversation store by principal as well, because `open` and `save` key snapshots by conversation id alone.
- Host a memo set per principal: key a memo set's `id` by principal, as a conversation store is keyed.
- Page `Authority` protects the user from the model, and it never protects the server from the user. A page tool that calls a server API is gated by the page, so the server authorizes that API call as the user.
- Accept `{ role: 'user', content }` only from a client, through `agentPromptContract`. Read client history and client snapshots as untrusted input.
- Send a page `agentResultToJSON` output or `AgentFrame` values. Forward no `error`, `fault`, or `select` value, because `error` and `fault` carry provider error text and `select` carries the request copy.
- A `deny` `reason` reaches the model verbatim, so the host authors every rule reason.
- Host text is not secret and is no security control: see [LLM07:2025 System Prompt Leakage](https://genai.owasp.org/llmrisk/llm072025-system-prompt-leakage/).
- [Relaying a browser provider through your own server](#relaying-a-browser-provider-through-your-own-server) states what a relay forwards under the operator's credential.
- A page `Ledger` stays responsive only with `agent: { scheduler: createBrowserScheduler() }`, as **The filing.** states.
- Core and its dependencies call `Map.groupBy`, `AbortSignal.any`, `Promise.withResolvers`, and `Iterator.from` and ship no polyfill, so a page needs a browser that provides them, in a secure context for `crypto.randomUUID`. A server needs Node 22.18.0 or later.

### Relaying a browser provider through your own server

When you compose `createAgent(browser, { tools })` in the page, the agent dispatches page tools there after the Node provider returns a tool call, for the definitions the relay forwards: those the server declares in `tools.definitions` or `tools.accept` admits. The Node server runs the relay handler and upstream inference. See [Placement proofs](#placement-proofs) for the planned Chromium receipt; the executed transcription described next proves an HTTP hop in Node.

A browser must never hold a model credential. Mount `createRelay` on your own server, where the credential already lives, and give the browser `createRelayProvider` pointed at that route: the browser drives a `ProviderInterface` like any other, and the credential never leaves the server. The handler is a plain `(request: Request) => Promise<Response>`, so any fetch-standard router mounts it — this composition mounts it on an `@orkestrel/router` dispatcher. Each half that follows runs in its own process: copy the server half into your server and the browser half into your browser bundle.

The `@orkestrel/agent` package frames the relay's newline-delimited JSON through its `@orkestrel/ndjson` dependency and declares no runtime dependency on a router or on a server adapter, which the server application supplies. The `@orkestrel/router` and `@orkestrel/server` development dependencies this package declares serve the executed transcription of these fences (see [the `tests/guides.test.ts` parity test](../tests/guides.test.ts)). That transcription runs the server half and the browser half for real: it mounts the relay handler on the dispatcher route the server half declares, starts `@orkestrel/server` on a loopback listener, and drives the browser half against that listener over an HTTP hop in Node. The hop proves the round trip returning the upstream's settled result, the `405` with its `Allow: POST` header a `GET` to `/relay` answers, the `404` a `POST` to another path answers, the `401` a wrong bearer answers with the upstream provider unentered, and the upstream turn a disconnected reader cancels through the adapter's abort of the inbound request.

The transcription substitutes where a test process differs from a deployment. The fence's `declare` placeholders become a scripted upstream provider and a fictional bearer, and the `messages` binding is typed as `readonly Message[]` rather than narrowed with `as const`. It drives the browser half's default strict parser through the HTTP hop. The parser retains incomplete records across chunks, accepts LF and CRLF record terminators, ignores blank lines, and trims each line before it parses it, so a line inside the stream wrapped in a byte-order mark or a no-break space parses, and the decoder removes a byte-order mark at the start of the stream before the parser reads it. A malformed or non-object line rejects the call with a `ProviderError` with code `PROTOCOL` whose `cause` is the `NDJSONError`. Each provider call receives a fresh parser; `clear()` discards any buffered fragment. It adds `host: '127.0.0.1'` to the `createServer` call, because a test listener binds loopback where a deployed server binds every interface. It points the browser half's `url` option at that address and the port `await server.start()` resolved, in place of the fence's fixed public URL. It closes each case with `await server.stop()` — the fence's own call — rather than the `SIGTERM` listener, which a test process outlives. The byte-limit refusal stays a direct handler call. The `limit` option of the `createRelay` factory caps the body the relay reads, and the `limit` option of the `createServer` factory caps the `body()` read a middleware context makes. This composition registers no middleware, so the `limit` option of the `createServer` factory never applies to these bytes.

#### Mounting the relay on your server

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createRelay } from '@orkestrel/agent'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'

declare const upstream: ProviderInterface // the server-side provider holding the credential
declare const bearer: string

const handler = createRelay({
	provider: upstream,
	authorize: (request) => request.headers.get('authorization') === `Bearer ${bearer}`,
})
const dispatcher = createDispatcher({
	routes: [{ method: 'POST', path: '/relay', handler }],
})

export function serve(request: Request): Promise<Response> {
	return dispatcher.handle(request, undefined)
}

const server = createServer({ dispatcher, state: () => undefined })
await server.start()
process.on('SIGTERM', () => server.stop()) // signal cancellation, drain, then close the listener
```

The `serve` function is the entry a server runtime's adapter calls, and the adapter owns what the relay deliberately doesn't: turning the runtime's inbound request into a `Request`, handing the returned `Response` back to the runtime, and aborting that request's signal when the client disconnects, so a reader that goes away cancels the upstream turn instead of leaving it running. `@orkestrel/server` supplies that adapter — `createServer` binds the same `dispatcher` and starts listening, as the fence shows — and a runtime whose own handler is already `(request: Request) => Promise<Response>` needs none.

#### Reaching the relay from the browser

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createRelayProvider } from '@orkestrel/agent'
import { createAbort } from '@orkestrel/abort'

declare const bearer: string
const abort = createAbort()
const messages = [{ id: '1', role: 'user', content: 'Say hello.' }] as const

const browser: ProviderInterface = createRelayProvider({
	url: 'https://app.example/relay',
	headers: () => ({ authorization: `Bearer ${bearer}` }),
})
const result = await browser.generate(messages, abort.signal) // a ProviderResult like a local provider's
```

`authorize` is mandatory and carries obligations the mechanism deliberately doesn't assume for you: it must not read the request body, and it performs no origin or method check of its own, so an application that authorizes on an ambient credential such as a cookie composes origin and CSRF middleware in front of the handler. A bearer header the browser sets explicitly, as here, isn't reachable cross-site. Every refusal — `401` for a failed authorization, `413` for a body that reaches the byte limit, `400` for a missing, unreadable, or rejected body, `422` for a page `system` message or tool definition the relay's policy refuses, `502` for an upstream call that can't be constructed — arrives at the browser as a `ProviderError` with code `'HTTP'` and that status. The `401`, `400`, and `413` refusals leave the upstream provider unentered; the `502` is answered after `provider.stream` was entered and threw before returning its iterator, so that refusal has already reached the provider. An upstream failure that does happen mid-stream reaches the browser as the fixed `RELAY_PROVIDER_MESSAGE` text, never the upstream's own message (the relay-protocol clause).

The relay forwards the page's options (`think`, `schema`) and its history upstream under the operator's credential; the page chooses them, and Agent 0.0.35 applies no operator policy over them. [Serving one agent per principal](#serving-one-agent-per-principal) holds the session rules when the agent itself runs in Node, and [Who writes and who enforces each inlet](#who-writes-and-who-enforces-each-inlet) names each side of the hop.

#### Declaring page tools and server text

By default `createRelay` answers `422` for a page `system` message and for a tool definition the server did not declare, so declare the page's tools and set the server's text. Keep the definitions in a data-only module that both halves import, so the server never imports a page handler:

```ts
// shared.ts: data only, imported by the page and by the server.
import type { ToolDefinition } from '@orkestrel/tool'

export const PAGE_TOOLS: readonly ToolDefinition[] = [
	{
		name: 'read_selection',
		description: 'Read the text the user selected on the page.',
		parameters: { type: 'object', properties: {} },
	},
]
```

The page binds a handler to each definition and sets no `system` text, because the server writes it:

```ts
import { createAgent, createRelayProvider } from '@orkestrel/agent'
import { createTool, createToolManager } from '@orkestrel/tool'

// PAGE_TOOLS comes from the shared module, and `readSelection` from the page.
declare function readSelection(): string
const tools = createToolManager()
tools.add(
	PAGE_TOOLS.map((definition) => createTool({ ...definition, execute: () => readSelection() })),
)
const browser = createRelayProvider({ url: 'https://app.example/relay' })
const agent = createAgent(browser, { tools })
```

The server mounts the same definitions beside its own text:

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createRelay } from '@orkestrel/agent'

// PAGE_TOOLS comes from the shared module.
declare const upstream: ProviderInterface
declare function authorize(request: Request): boolean
const handler = createRelay({
	provider: upstream,
	authorize,
	system: { text: 'You help on the Larkspur order page.' },
	tools: { definitions: PAGE_TOOLS },
})
```

A page tool that is missing from `definitions` still answers `422`, so a page bundle older than the server fails with a coded status. Set `tools: { accept: true }` only where the page's tools are not fixed: it admits page-authored text into the system turn, because a provider's renderer can write tool definitions there.

For per-user text, build the handler per request: `createRelay({ ...shared, system: { text: textFor(user) } })(request)`, where the `shared` placeholder holds the provider, `authorize`, and `tools`. A page `window` prices only what the page sends, so subtract the server head's `estimateRequest` from `max`. A page `Ledger` over a relay needs `system: { accept: true }`, because `LedgerOptions.system` is required and calibration always sends a head, and it needs its `recall` tool and lookups declared in `tools.definitions` or admitted by `tools: { accept: true }`.

### Serving a Node agent to a page

When the agent, its provider, its tools, and its approver run in Node and a page drives them, the page sends an `AgentPrompt` to a frame route, reads the run back as newline-delimited `AgentFrame` values, and answers each `ask` frame with an `AgentAnswer` to an answer route. The route owns identity, the session table of one `{ agent, threads, approver }` entry per authenticated principal, statuses, and timeouts, and looks a thread id up only in the principal's own `threads`. Both routes compose the origin and CSRF checks before they read the body, because under an ambient credential such as a cookie a cross-site simple `POST` would otherwise append a stored user turn to the principal's thread and run that principal's agent. The frame route passes the narrowed body as the run's `prompt`, which the run appends after its guards, so a refused run appends nothing and nothing removes the user turn after the run starts.

[Serving one agent per principal](#serving-one-agent-per-principal) holds what this session table shares and refuses. Here the frame route answers `AgentError` `'CONCURRENCY'` with `409`, passes `signal: request.signal`, and calls `stream.abort()` from its `cancel` when the page stops reading.

`ask: approver.ask` wires the approver directly. A host handler that wraps it must pass the received `context` unchanged and synchronously to the approver, which keys each waiting ask by the call object. A handler that redacts or copies the call gets no frame and waits until the run `timeout`, when one is set, or until the page disconnects and the route's `cancel` aborts the run, because the frame carries the call's own arguments and no server-written redaction.

The kept tail under [Serving one agent per principal](#serving-one-agent-per-principal) applies to a run this route rejects, aborts, or times out.

The following server fence fills the session table and mounts the frame route and the answer route:

```ts
import type {
	AgentInterface,
	ApproverInterface,
	AuthorityRule,
	ConversationManagerInterface,
	ProviderInterface,
} from '@orkestrel/agent'
import {
	agentAnswerContract,
	agentPromptContract,
	agentStreamToFrames,
	createAgent,
	createApprover,
	createAuthority,
	createConversationManager,
	isAgentError,
} from '@orkestrel/agent'
import { parseJSONAs } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import type { ToolManagerInterface } from '@orkestrel/tool'

declare const provider: ProviderInterface // the server-side provider every principal shares
declare const tools: ToolManagerInterface // the server-side tools every principal shares
declare const rules: readonly AuthorityRule[] // the host's policy, an `ask` verdict included
declare function authenticate(request: Request): string | undefined // the session's principal
declare function verify(request: Request): boolean // the origin and CSRF checks

interface PageSession {
	readonly agent: AgentInterface
	readonly threads: ConversationManagerInterface
	readonly approver: ApproverInterface
}

// The session table: one entry per authenticated principal, filled before any request.
const sessions = new Map<string, PageSession>()
for (const principal of ['ada', 'grace']) {
	// Each entry owns its threads, approver, and agent; none is shared across principals.
	const threads = createConversationManager()
	const approver = createApprover()
	const agent = createAgent(provider, {
		tools,
		conversations: threads,
		authority: createAuthority({ rules, ask: approver.ask }),
	})
	sessions.set(principal, { agent, threads, approver })
}

const dispatcher = createDispatcher({
	routes: [
		{
			method: 'POST',
			path: '/threads/:thread',
			handler: async (request, context) => {
				const principal = authenticate(request)
				const session = principal === undefined ? undefined : sessions.get(principal)
				if (session === undefined) return new Response(null, { status: 401 })
				if (!verify(request)) return new Response(null, { status: 403 })
				const prompt = parseJSONAs(await request.text(), agentPromptContract.is)
				const id = context.params.thread
				if (prompt === undefined || id === undefined) {
					return new Response(null, { status: 400 })
				}
				const thread = session.threads.conversation(id) ?? session.threads.add({ id })
				try {
					// The run appends the prompt after its guards, so a refused run adds no turn.
					const stream = session.agent.stream({
						conversation: thread,
						prompt,
						signal: request.signal,
					})
					const frames = agentStreamToFrames(stream, session.approver)
					const lines = new ReadableStream<string>({
						pull: async (controller) => {
							const step = await frames.next()
							if (step.done) controller.close()
							else controller.enqueue(`${JSON.stringify(step.value)}\n`)
						},
						cancel: () => stream.abort(),
					})
					return new Response(lines.pipeThrough(new TextEncoderStream()), {
						headers: {
							'content-type': 'application/x-ndjson; charset=utf-8',
							'cache-control': 'no-store',
						},
					})
				} catch (error) {
					if (isAgentError(error) && error.code === 'CONCURRENCY') {
						return new Response(null, { status: 409 })
					}
					throw error
				}
			},
		},
		{
			method: 'POST',
			path: '/answers',
			handler: async (request) => {
				const principal = authenticate(request)
				const session = principal === undefined ? undefined : sessions.get(principal)
				if (session === undefined) return new Response(null, { status: 401 })
				if (!verify(request)) return new Response(null, { status: 403 })
				const answer = parseJSONAs(await request.text(), agentAnswerContract.is)
				if (answer === undefined) return new Response(null, { status: 400 })
				// An unknown, settled, or other principal's ask id settles nothing.
				return new Response(null, { status: session.approver.answer(answer) ? 204 : 404 })
			},
		},
	],
})

const server = createServer({ dispatcher, state: () => undefined })
await server.start()
```

The page posts its prompt to its thread's path, frames the body through one strict `@orkestrel/ndjson` parser, checks each record against `agentFrameContract`, renders each `ask` frame's `name`, `zone`, and `arguments` as text before it posts its `AgentAnswer`, and treats a thrown `NDJSONError`, a refused record, or a body that ends without `finish` or `error` as a protocol error:

```ts
import type { AgentAnswer } from '@orkestrel/agent'
import { agentFrameContract } from '@orkestrel/agent'
import { createNDJSONParser } from '@orkestrel/ndjson'

declare const token: string // the CSRF token the page holds for its session
declare function render(text: string): void // writes text into the page, never markup
declare function decide(id: string): Promise<boolean> // the user's answer to the ask

// Frames decoded text through one strict parser, completing a last line that has no newline.
class RecordSplitter implements Transformer<string, unknown> {
	readonly #parser = createNDJSONParser({ strict: true })
	transform(chunk: string, controller: TransformStreamDefaultController<unknown>): void {
		for (const record of this.#parser.parse(chunk)) controller.enqueue(record)
	}
	flush(controller: TransformStreamDefaultController<unknown>): void {
		for (const record of this.#parser.parse('\n')) controller.enqueue(record)
	}
}

const headers = { 'content-type': 'application/json', 'x-csrf-token': token }
const response = await fetch('/threads/trip', {
	method: 'POST',
	headers,
	body: JSON.stringify({ content: 'Archive the notes from last week.' }),
})
if (!response.ok || response.body === null) {
	throw new Error(`the run was refused: ${response.status}`)
}
const records = response.body
	.pipeThrough(new TextDecoderStream())
	.pipeThrough(new TransformStream(new RecordSplitter()))
	.getReader()
for (;;) {
	const record = await records.read()
	if (record.done) throw new Error('the frames ended without finish or error')
	const frame = record.value
	if (!agentFrameContract.is(frame)) throw new Error('a frame line was refused')
	if (frame.category === 'error') throw new Error('the run failed')
	if (frame.category === 'finish') break
	if (frame.category === 'token') render(frame.content)
	if (frame.category === 'tool') {
		render(frame.success ? `${frame.name} ran` : 'a call did not run')
	}
	if (frame.category === 'ask') {
		render(`${frame.name} asks in ${frame.zone} with ${frame.arguments}`)
		const answer: AgentAnswer = { id: frame.id, approved: await decide(frame.id) }
		const answered = await fetch('/answers', {
			method: 'POST',
			headers,
			body: JSON.stringify(answer),
		})
		if (answered.status !== 204) render(`the answer was not taken: ${answered.status}`)
	}
}
```

### Dispatching the model's tool calls

Advertising and dispatch are the halves of one exchange: hand `definitions()` to the provider, and feed the `ToolCall` values that come back through `execute`. Results are correlated by `id` and discriminated on `success`, so a handler throw arrives as a `ToolResult` the model can read rather than an exception the caller must catch.

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createToolManager, createTool } from '@orkestrel/tool'

// `messages` and `signal` come from the host application.
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
import type { ProviderInterface } from '@orkestrel/agent'
import { createAgent } from '@orkestrel/agent'

declare const provider: ProviderInterface
const agent = createAgent(provider, { timeout: 30_000, limit: 6 })
agent.context.messages.add({ role: 'user', content: 'Summarize the news.' })

// Cancel from elsewhere — the turn commits whatever streamed so far.
setTimeout(() => agent.abort('user navigated away'), 5_000)

const result = await agent.generate()
// `keep` comes from the host application.
if (result.partial) keep(result.content) // a cancel RESOLVED partial, not an error
```

### Cancelling work inside a tool

Every handler receives `(args, context)`, with the run's bound signal at `context.signal`; handlers may omit unused parameters. The agent passes this context through every dispatched call, allowed or approved, and supplies no `caller` identity. An agent abort, a stream abort, an external signal, or the deadline can abort a running handler's signal. The allowance is charged during provider streaming and the token budget after each provider call and between turns, before tool dispatch; exhaustion ends the run without dispatching, never inside a handler.

When the signal has aborted before the tool block, the agent leaves the prior conversation intact: it appends neither an assistant turn carrying calls nor tool messages and emits no `tool` chunk. The streamed content remains in the result, which settles with `partial: true`. After dispatch begins, cancellation is cooperative: the handler must stop its own work, and the agent waits for a handler that ignores the signal, records its real result, and then settles the run with `partial: true`. A cancelled run runs no automatic compaction after dispatch; the next run's pre-first-turn check folds instead.

This fence uses a provider that requests the `wait` tool. The handler resolves from its abort listener, and the run commits the partial result:

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createAgent } from '@orkestrel/agent'
import { createTool, createToolManager } from '@orkestrel/tool'

declare const provider: ProviderInterface // requests the wait tool
const entered = Promise.withResolvers<void>()
const cancelled = Promise.withResolvers<boolean>()
const tools = createToolManager()
tools.add(
	createTool({
		name: 'wait',
		execute: (_args, context) => {
			context.signal.addEventListener(
				'abort',
				() => {
					cancelled.resolve(context.signal.aborted)
				},
				{ once: true },
			)
			entered.resolve()
			return cancelled.promise
		},
	}),
)
const agent = createAgent(provider, { tools })
const stream = agent.stream()
await entered.promise
agent.abort('request ended')
await cancelled.promise // true — observed inside the handler
const result = await stream.result
result.partial // true
```

The executed transcription (see [the `tests/guides.test.ts` parity test](../tests/guides.test.ts)), “observes cancellation inside the handler as the tool cancellation fence claims”, supplies the scripted provider and asserts those values.

### Three failure layers: meter, budget, model

A run can be stopped by three token layers, and its result names the one that did. The meter layer charges each content delta's estimated token growth (the `estimateTokens` `ceil(length / 4)` heuristic) against the `AgentOptions.allowance` budget while the provider streams, so a runaway answer stops before the provider reports its usage. The cost `budget` is charged each call's reported `usage` after the call returns. The model layer is the provider's own limit: an answer the model ended at its token cap arrives with `ProviderResult.truncated`. The `allowance` and `budget` signals fold into the run's bound abort like an external cancel or a `timeout`, so a trip cancels the provider, and the run resolves `partial: true` with an `abort` event carrying the tripped budget's `BudgetError`.

The meter charges completion growth as `{ prompt: 0, completion: n, total: n }`, so a `completion`- or `total`-scoped allowance tracks the answer, while a `prompt`-scoped allowance is charged `0` and never trips through the meter.

Pass the `budget` itself as the `allowance` to make the estimate and the reported usage share one ceiling. The loop then reconciles each call against what the meter already charged: the full `prompt`, plus `completion` and `total` less the streamed estimate, floored at 0, so a shared ceiling is never charged less than the reported usage and never charged the estimate twice; an estimate above the report is not refunded. With a separate `allowance`, or none, the `budget` is charged exactly the reported usage, or the streamed-answer estimate when the call reported none. Omit `allowance` to turn the meter layer off; the estimate is still measured. Give a separate `allowance` a smaller `max` than the budget's headroom to let the estimate stop the run first, or a larger one to let the reported usage or the model's own limit stop it. `AgentResult.usage` and the `usage` chunks stay the full reported usage either way.

`AgentResult.stop` names the layer with the readings it crossed: a `meter` or `budget` stop copies the tripped budget's `id`, `max`, and `consumed` from its `BudgetError`, and a `model` stop carries the provider's trace `id`. A run names one layer, the one that stopped the final provider call first. A truncated final answer whose call returned unaborted is a `model` stop and settles `partial: false`; when its reconcile then exhausts a budget, or a cancel lands before the run settles, the stop stays `model`, `partial` is `true`, and the `abort` event carries that later reason. An external `signal`, a `timeout`, and `abort()` name no layer, and neither does a natural finish or an exhausted `limit`. A model error is a rejection, not a stop: a refusal or an oversized prompt rejects the run with a `ProviderError` on the `error` event, and no result carries a `stop`. The `usage` event and chunk carry each call's streamed-answer `estimate` beside its reported usage, so you can tune `allowance.max` from that calibration reading without a failure.

```ts
import { createAgent } from '@orkestrel/agent'
import { createTokenBudget } from '@orkestrel/budget'

// `provider` and `log` come from the host application.
const budget = createTokenBudget({ id: 'budget', max: 50_000, scope: 'total' })
const allowance = createTokenBudget({ id: 'meter', max: 2_000, scope: 'completion' })
const agent = createAgent(provider, { budget, allowance })
agent.emitter.on('usage', (usage, estimate) => log('calibration', estimate, usage.completion))
agent.context.messages.add({ role: 'user', content: 'Write a very long story.' })
const result = await agent.generate()
result.stop?.layer // 'meter' when the estimate ran out first, 'budget' when the reported usage did, 'model' when the model ended its own answer
```

**A `think: true` run needs headroom for reasoning.** Live reasoning deltas (`ProviderDelta` `'thinking'`) aren't metered mid-stream (only `'content'` deltas are), and the reasoning is charged to the `budget` through the reported usage alone, so a thinking model can spend a large share of a tight ceiling on reasoning the meter never saw. Give a `think: true` run enough headroom to cover its reasoning, not only its expected answer length; the `usage` event's `estimate` shows the gap, because reasoning is in `usage.completion` and not in `estimate`.

### Observing an agent (push vs. pull)

An `Agent` exposes a pull and a push observation surface. Pull — the `AgentChunk` stream (`stream().events`) — is for a live consumer rendering per-token answer deltas and per-think reasoning deltas as they arrive. Push — the `emitter` (`AgentEventMap`) — is for fire-and-forget observers (logging, metrics, tracing) that want the loop's lifecycle moments without draining the stream: `start` (a run begins), `turn` (each iteration), `tool` (a dispatched call + its result), `usage` (a turn's token usage and the `estimate` of the answer it streamed, as `(usage, estimate)`), `allow` (a call cleared for dispatch, with its decision), `ask` (a call handed to the approver, with its decision), `deny` (a denied call; the event is never a chunk, and a call that scope or authority denies still yields a `tool` chunk that carries its denial result, while a call made when the active scope advertises no tools yields no chunk), `finish` (the settled result), `error` (a genuine failure), `abort` (a cancel), and `exhaust` (the limit was reached while the model still held unresolved tool intent — fires instead of `abort`, still followed by `finish`). Per-token / per-thinking deltas stay the stream's job exclusively — there is deliberately no `token` or `think` event on the emitter; reach for the stream when you need live output, the emitter when you need lifecycle.

An allow clears a call for the tool instance the registry held when the turn advertised it; if that instance is replaced or removed before dispatch, a `deny` follows with the reason `<name> changed after its decision` and no decision, so `deny` can follow that call's `allow`, and neither instance runs. A tool handler that replaces a later tool in the same batch before its first await is host code and is not re-checked. A cancel that ends the turn before dispatch emits no such `deny`.

The following observers wire at construction and later:

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createAgent } from '@orkestrel/agent'

declare const provider: ProviderInterface
// `trace`, `meter`, `audit`, and `log` come from the host application.
// Wire fire-and-forget observers at construction through the reserved `on` option …
const agent = createAgent(provider, {
	on: {
		start: (id) => trace.begin(id),
		usage: (usage) => meter.add(usage.total),
		deny: (call, reason) => audit(call.name, reason), // an event, not a chunk
		finish: (result) => trace.end(result),
	},
})
// … or subscribe later through `agent.emitter`.
agent.emitter.on('abort', (reason) => log('cancelled', reason))
```

**Observation can never corrupt the loop.** The emitter isolates a listener that throws (the throw can never escape into the settle-once / wake-park engine — `generate()` / `stream()` still settle the exact same result), routing the caught error to its own `error` handler (the `error` option, surfaced as `(error, event)`, not a domain event) so the observer bug isn't silently lost. Every throwing listener surfaces (not only the first); a throwing `error` handler is swallowed too (it can neither recurse nor escape); with no handler the throw is dropped silently. So a buggy observer degrades to a routed error — it never reorders, throws into, or corrupts the run.

**A cancelled run emits `abort` then `finish`.** A cancel (an external `signal`, the `timeout` deadline, an exhausted `budget` or `allowance`, or `abort()`) still resolves a partial result — so the emitter fires `abort` (carrying the cancel reason) and then `finish` (carrying the settled partial), letting an observer see both that the run was cancelled and the partial outcome it committed. A natural / cap-bounded finish fires `finish` only; a genuine provider / tool error fires `error` instead of `finish`. `generate()` and `stream()` drive the same events (they share one `#execute`).

### Pulling context from another conversation (with provenance)

One agent serves many conversations: each run binds the conversation its `AgentRunOptions.conversation` names, or the one active at its call, which `conversations.switch(id)` sets at any moment without moving a live run; each thread keeps its own history. When the active conversation A needs something decided in another conversation B, don't merge B's turns into A's live tail — that pollutes A's thread and (for a small model) blurs which conversation said what. Instead pull a provenance-labeled reference of B into A's active workspace (the fenced reference channel `build()` folds into the user context message), so the model reads it as clearly-foreign material and attributes it to B.

The flow is **search / rehydrate → reference → write-to-workspace** — and cherry-pick, never dump:

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createAgent, createConversationManager } from '@orkestrel/agent'

declare const provider: ProviderInterface
const conversations = createConversationManager({
	summarize: /* a ConversationSummaryHandler */ undefined,
})
const a = conversations.add({ id: 'auth' }) // the ACTIVE thread (the first add auto-activates it)
const b = conversations.add({ id: 'planning' }) // the OTHER thread to pull from

const agent = createAgent(provider, { conversations }) // its active conversation (a) is the message source

// 1. search / rehydrate → SELECT the few right turns (never B's whole history)
const picked = b.search('database') // or b.rehydrate(sectionId) for a compacted slice
// 2. reference → FRAME them as a self-labeled provenance block (a pure string, no model call)
const block = b.reference({ label: 'planning', messages: picked })
// 3. write-to-workspace → into the ACTIVE conversation's context active workspace, keyed by the source id
agent.context.workspaces.add().write(`conversation:${b.id}.md`, block)

// The model can then use B's decision AND attribute it: "Postgres, decided in the planning conversation."
```

Why this shape: `reference()` leads with `[Reference — conversation "<label>" — NOT part of this conversation]`, so the model treats the excerpts as a quoted foreign source (it answers "decided in the planning conversation", not "we decided here"). Keep the excerpts cherry-picked — this content enters another context window a small model must read, and a full dump re-bloats it. `reference()` is event-free and never calls a model; provenance lives in the `label` (default the conversation's `id`).

**Within a conversation, the same provenance instinct applies to recaps.** `view()` folds each compacted section into a synthetic `assistant` recap — and prefixes it with `CONVERSATION_RECAP_PREFIX` (`[Summary of earlier messages] …`) so a small model reads it as a condensed recap of earlier turns rather than a literal turn to echo or treat as the live answer. The label is deliberately lean (a fixed handful of tokens — no per-section blow-up) and is a `view()`-only presentation concern (a `sections` cap merge re-reads the unframed summaries).

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

A `MemoryConversationStore` hands back the object it stored, so its snapshot's judgments are the frozen records `snapshot()` carried. Copy a judgment through `copyJSON` before you edit it. The `createMemoryMemoStore` and `createDatabaseMemoStore` factories apply the same `set`, `get`, and `delete` workflow to a memo set, keyed by its `id`. The host authors what a store holds: a memo can be model-written, so narrow a read through `isMemoSnapshot` and render a stored memo only in the context message, where the context puts it.

### Recording a judgment on a conversation

A conversation carries its own judgment store, so a judge's answer about a message is recorded beside the messages it concerns and survives the snapshot round trip. `add` stamps the record's `time`; `judgment` reads one record by its key and `judgments` lists them in insertion order.

```ts
import { createConversation } from '@orkestrel/agent'

const conversation = createConversation()
const complaint = conversation.add({ role: 'user', content: 'I was charged twice for one order.' })

conversation.judgments.add({
	id: 'refund',
	question: { form: 'noul', instructions: 'Is a refund owed?' },
	answer: { form: 'noul', noul: 0.9 },
	model: 'tev1:0.8b',
	sources: [complaint.id],
	state: complaint.content,
})

const refund = conversation.judgments.judgment('refund')
const recorded = conversation.judgments.judgments()
const snapshot = conversation.snapshot()
```

### Running many durable agents as jobs

When you need many agents — bounded, retried, surviving a crash — describe each as a serializable `AgentJobInput` (names for the live pieces, data for the rest), register the live pieces once, and run them through a `createAgentQueue` (durable, bounded) or a `createAgentRunner` (one-shot, ordered, fail-fast, with sub-agent fan-out). The layer composes the `@orkestrel/queue` `Queue` and the `@orkestrel/workflow` `Runner` — it adds only rehydration and the partial policy, no engine of its own.

```ts
import type { AgentJobInput } from '@orkestrel/agent'
import type { QueueStoreInterface } from '@orkestrel/queue'
import { createAgentQueue, createAgentRegistry } from '@orkestrel/agent'

declare const store: QueueStoreInterface<AgentJobInput> // a durable store the host supplies
// `provider` comes from the host application.

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

Fan out sub-agents by declaring `children` on a parent job; the runner that `createAgentRunner` returns spawns each child through `controller.spawn` on the same bounded queue, so the children run as sibling sub-agents; a retried parent spawns them only on its first attempt:

```ts
import { createAgentRunner } from '@orkestrel/agent'

// `registry` and the `AgentJobInput` type come from the preceding example.
const runner = createAgentRunner({ registry, concurrency: 4 })
const parent: AgentJobInput = {
	provider: 'main',
	messages: [{ role: 'user', content: 'Plan the trip.' }],
	children: [{ provider: 'main', messages: [{ role: 'user', content: 'Find flights.' }] }],
}
const results = await runner.execute([parent]) // [parent result, …then spawned child results]
```

### Giving the model documents to read

A workspace reaches the model through `context.workspaces`, and this is the only channel documents have. `build()` renders the active workspace by carrier on every turn — active-only and scope-filtered — so the workspace the agent is working in is always what the prompt reflects, with nothing to re-mount after an edit. Register one (the first `add` auto-activates it) and its text files fold into the `## Workspace` section of the user context message as fenced reference blocks, while its image files' base64 rides the last user message.

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createAgent } from '@orkestrel/agent'
import { createToolManager } from '@orkestrel/tool'

declare const provider: ProviderInterface
const agent = createAgent(provider, { tools: createToolManager() })

// The first add auto-activates — agent.context.workspaces.active is this workspace, so build()
// renders its text files into the `## Workspace` section on every turn.
const workspace = agent.context.workspaces.add()
workspace.write('notes.txt', 'The vault code is 7731.')
```

Reading is one half. To let the model edit what it reads, register the `createWorkspaceTool` published by `@orkestrel/toolbox` on `agent.context.tools` over this same `context.workspaces` registry: an `operation`-keyed `ToolInterface` whose dispatch and error semantics are that package's to document. The surfaces then close a loop — the model reads the workspace from the prompt, edits it through a tool call, and reads the edited version on the next turn.

### Switching which workspace the prompt carries

Only the active workspace renders; the other registered workspaces never reach the model at all. `switch` changes which one the prompt carries between runs:

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createAgent, createScope } from '@orkestrel/agent'

declare const provider: ProviderInterface
const agent = createAgent(provider)

const project = agent.context.workspaces.add() // auto-activates
project.write('src/config.ts', 'export const PORT = 8123')

agent.context.messages.add({ role: 'user', content: 'What port is configured?' })
await agent.generate() // the model reads the active workspace's file from the prompt

// Serve a different workspace next run — switch the active pointer:
const other = agent.context.workspaces.add() // NOT active (a later add leaves active unchanged)
other.write('notes.txt', 'different context')
agent.context.workspaces.switch(other.id) // build() renders other's files from here
// Narrow which files render with scope.files (by path):
agent.context.apply(createScope({ name: 'cfg', files: ['src/config.ts'] }))
```

A switch between runs changes the files the next run's prompt carries, and `scope.files` then filters the switched workspace's files by path.

### Switching modes with a scope

A mode is a scope an application keeps ready: its allow-lists and an optional `select` handler. Load the data from a plain file, and attach each handler in code through a guarded lookup, because a file carries no function. Switch modes with `context.apply`; each change applies at the sites [Scoping a turn](#scoping-a-turn) names.

`mode.narrow({ tools: [] })` is the answer mode that keeps the mode's handler, because `narrow` keeps the parent's `name` and `select`. `apply(undefined)` and a plain answer scope with no handler fall back to the agent default. A mode that must run with no selection under a default carries a pass-through handler that returns `view()`; the package exports no such handler.

The following modes load from data, attach their handlers in code, and switch between runs:

```ts
import type { ProviderInterface, ScopeInterface, SelectionHandler } from '@orkestrel/agent'
import type { ToolManagerInterface } from '@orkestrel/tool'
import { createAgent, createScope } from '@orkestrel/agent'

declare const provider: ProviderInterface
declare const tools: ToolManagerInterface // holds the `lookup` tool
declare const judged: SelectionHandler // the agent default
declare const recent: SelectionHandler // the triage mode's own policy

// Plain data, as a JSON file holds it; the data names a policy because a file carries no function.
const MODES = [
	{ name: 'triage', tools: ['lookup'], policy: 'recent' },
	{ name: 'verbatim', tools: [], policy: 'none' },
]
const POLICIES: Readonly<Record<string, SelectionHandler>> = {
	recent,
	// No selection under the judging default: a pass-through handler returns view().
	none: async (conversation) => ({ messages: conversation.view(), judgments: [] }),
}
const modes = new Map(
	MODES.map(({ policy, ...data }): [string, ScopeInterface] => {
		const select = POLICIES[policy]
		return [data.name, createScope(select === undefined ? data : { ...data, select })]
	}),
)

const agent = createAgent(provider, { tools, select: judged })
async function ask(content: string): Promise<void> {
	agent.context.messages.add({ role: 'user', content })
	await agent.generate()
}

const triage = modes.get('triage')
agent.context.apply(triage)
await ask('Sort ticket 7.') // `recent` selects; `lookup` is advertised
agent.context.apply(triage?.narrow({ tools: [] }))
await ask('Answer from what you have.') // `recent` selects; no tool is advertised
agent.context.apply(createScope({ name: 'answer', tools: [] }))
await ask('Answer briefly.') // `judged` selects
agent.context.apply(undefined)
await ask('Close ticket 7.') // `judged` selects

// A one-run mode: apply, generate, and restore after the result settles.
const previous = agent.context.scope
agent.context.apply(modes.get('verbatim'))
try {
	await ask('Quote the thread.') // the pass-through selects; `judged` is not called
} finally {
	agent.context.apply(previous)
}
```

Overlapping runs on one agent share its scope and its default handler, so an `apply` made for one run reaches every run in flight at its next site. Runs that need different modes at the same moment need separate agents.

### Answering without tools

When the next turn must answer from what it already holds, apply a scope with an empty `tools` list: `createScope({ name: 'answer', tools: [] })`. The package exports no constant for it. The provider's `content` ends the run as the answer with `partial: false`, and each call the reply still carries emits `deny` with the reason `no tool is advertised in the active scope`, as [Scoping a turn](#scoping-a-turn) states. That reason and `TOOL is not in the active scope` are frozen copy, so a harness can match them verbatim.

The following run ends answer-only:

```ts
import type { ProviderInterface } from '@orkestrel/agent'
import { createAgent, createScope } from '@orkestrel/agent'
import { createTool, createToolManager } from '@orkestrel/tool'

declare const provider: ProviderInterface // replies with text and a stray `refund` call
declare function log(name: string, reason: string | undefined): void

const tools = createToolManager()
tools.add(createTool({ name: 'refund', execute: () => 'refunded' }))
const agent = createAgent(provider, { tools })
agent.emitter.on('deny', (call, reason) => log(call.name, reason)) // 'refund', 'no tool is advertised in the active scope'
agent.context.apply(createScope({ name: 'answer', tools: [] }))
agent.context.messages.add({ role: 'user', content: 'Refund invoice 42.' })
const result = await agent.generate() // { content: 'Refunds need a manager.', partial: false }
```

### Serving requests through a ledger

The ledger is the records strategy: it keeps every message and serves each request through records, where automatic compaction folds older turns into recaps. The following table compares the strategies. It recommends no form and changes no default, and the **compaction floor** clause under [Contract](#contract) holds the one reading behind its compaction rows.

| Strategy                         | Set it through                                                                         | What the next request holds                                                    | What keeps the originals                                         | What stops it                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Plain agent                      | `createAgent(provider)` with no `window`                                               | the whole `view()`                                                             | the conversation's live tail                                     | nothing folds, so the provider's own limit decides                                                |
| Automatic compaction             | `AgentOptions.window` and a summarizable conversation                                  | one recap per section, then the live tail                                      | each section's `messages`, read through `search` and `rehydrate` | every recap stays, so a request can reach the window with nothing left to fold                    |
| Compaction with a `sections` cap | the `sections` option, per conversation, as a manager default, or per `compact()` call | at most the cap's recaps after a merge, then the live tail                     | the same                                                         | a merge needs a fold with an eligible slice, and it can't combine with `cumulative`               |
| Compaction with `cumulative`     | `ConversationOptions.cumulative` or `ConversationInput.cumulative`                     | one recap, then the live tail                                                  | the same                                                         | a fold needs an eligible slice, and its summarizer reads recaps and not the originals behind them |
| Ledger                           | `createLedger(provider, options)`                                                      | the built head, the seed tail, and a copy of the request turn with its records | the conversation, read through the `recall` tool                 | a judge and fitted cutoffs are required, and the ledger refuses no over-window prompt             |

Build a ledger from a provider, a judge, the lookups, and the measured questions, add the seed history to its conversation, and send each request through the `respond` method. Read the last message of each `select` event's selection, the copy of the request turn, to see the records the ledger wrote ahead of the request. The following ledger serves two requests; a scripted provider stands in for the model and a scripted judge for Mica:

```ts
import type {
	JudgeAnswer,
	JudgeInterface,
	LedgerLookup,
	LedgerThreshold,
	ProviderInterface,
	ProviderResult,
} from '@orkestrel/agent'
import { createLedger, LEDGER_QUESTIONS } from '@orkestrel/agent'

declare const thresholds: LedgerThreshold // fitted on LEDGER_QUESTIONS and your judge

// Each provider call takes the next reply: two calibration calls, then one reply per turn.
const script: readonly ProviderResult[] = [
	{ content: '', usage: { prompt: 160, completion: 0, total: 160 } }, // calibration with the tools
	{ content: '', usage: { prompt: 40, completion: 0, total: 40 } }, // calibration without them
	{ content: '', tools: [{ id: 'call-1', name: 'lookup_order', arguments: { id: 'BW-5512' } }] },
	{ content: 'Order BW-5512 qualifies for a $148.50 refund.' },
	{ content: 'Yes. Refunds over $100 need a manager.' },
]
const replies = script.values()
const provider: ProviderInterface = {
	id: 'scripted',
	name: 'scripted',
	generate: async () => replies.next().value ?? { content: '' },
	async *stream() {
		const reply = replies.next().value ?? { content: '' }
		if (reply.content !== '') yield { channel: 'content', text: reply.content }
		return reply
	},
}
// The judge files every message it categorizes as a rule and answers no to every noul question.
const judge: JudgeInterface = {
	id: 'scripted',
	name: 'scripted',
	model: 'scripted',
	ask: async (request) => ({
		model: 'scripted',
		answers: Object.fromEntries(
			Object.entries(request.questions).map(([id, question]): [string, JudgeAnswer] => [
				id,
				question.form === 'choice'
					? { form: 'choice', probabilities: { rule: 0.9, fact: 0.1 } }
					: { form: 'noul', noul: 0.1 },
			]),
		),
	}),
}
// One lookup: the tool the model calls and the handler that reads the owner out of its result.
const lookup: LedgerLookup = {
	tool: {
		name: 'lookup_order',
		description: 'Read an order by its id.',
		parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
		execute: (args) =>
			`Order ${String(args.id)} for account BW-20931: Brightwater Studio. Refund due $148.50.`,
	},
	read: (args, text) =>
		text.startsWith('No order')
			? undefined // the lookup found nothing
			: { ids: [String(args.id)], owners: [{ id: 'BW-20931', names: ['Brightwater Studio'] }] },
}

const ledger = createLedger(provider, {
	judge,
	system: 'You staff the Larkspur support desk. Today is 2026-10-09.',
	topics: [{ name: 'refunds', criterion: 'refund amounts and approvals' }],
	questions: LEDGER_QUESTIONS,
	thresholds,
	capacity: 32_768,
	lookups: [lookup],
})
const copies: Array<string | undefined> = []
ledger.agent.emitter.on('select', (selection) => copies.push(selection.messages.at(-1)?.content))
ledger.conversation.add({ role: 'user', content: 'Refunds over $100 need a manager.' })

const gauge = await ledger.calibrate(AbortSignal.timeout(30_000))
gauge.overhead // 120 — what advertising the tools adds to a prompt
const first = await ledger.respond('Can Brightwater Studio get a refund on order BW-5512?')
first.content // 'Order BW-5512 qualifies for a $148.50 refund.'
const second = await ledger.respond('Does the Brightwater Studio refund need a manager?')
second.content // 'Yes. Refunds over $100 need a manager.'
copies[0]
// '## Rules\n- Refunds over $100 need a manager.\n\n## Request\nCan Brightwater Studio get a refund on order BW-5512?' — no lookup has named an owner yet
copies[1]
// '## Records\n### Brightwater Studio (BW-20931)\n- Order BW-5512 for account BW-20931: Brightwater Studio.\n- Refund due $148.50.\n\n## Rules\n- Refunds over $100 need a manager.\n\n## Request\nDoes the Brightwater Studio refund need a manager?'
```

The second request names Brightwater Studio, so its records carry that owner's record, built from the first request's lookup result, while neither the first request nor its reply reaches the second prompt, and the system message holds the `system` option alone. The executed transcription runs this fence with its own cutoffs and reads the prompts the provider received; see [the `tests/guides.test.ts` parity test](../tests/guides.test.ts).

To carry a ledger across a restart, store what its `snapshot` method returns and pass it back as the `snapshot` option of a later `createLedger` call. The snapshot is plain JSON: the conversation with its judgments, the ids of the requests, notes, and failed tool results the ledger marked, and the gauge. Narrow a parsed snapshot with the `isLedgerSnapshot` guard first, because construction refuses a snapshot the guard refuses with `LedgerError` code `'SNAPSHOT'`. The hydrated ledger makes no calibration call when the snapshot or the options carry a gauge, and it asks its judge no question the stored judgments answer. The following example continues the preceding ledger in a second ledger, and the second ledger writes the records the first would write for the same request:

```ts
import type { LedgerInterface, LedgerOptions, ProviderInterface } from '@orkestrel/agent'
import { createLedger, isLedgerSnapshot } from '@orkestrel/agent'

declare const ledger: LedgerInterface // the ledger above, after its two requests
declare const options: LedgerOptions // the options that built it, which carry no gauge
declare const provider: ProviderInterface // scripted with one reply: 'Not yet. A manager must approve it.'

const stored = JSON.stringify(ledger.snapshot())
const parsed: unknown = JSON.parse(stored)
if (!isLedgerSnapshot(parsed)) throw new Error('Not a ledger snapshot')
parsed.requests.length // 2 — the two requests the ledger served
const restored = createLedger(provider, { ...options, snapshot: parsed })
restored.gauge?.overhead // 120 — read from the snapshot, so the ledger calibrates nothing
const copies: Array<string | undefined> = []
restored.agent.emitter.on('select', (selection) => copies.push(selection.messages.at(-1)?.content))
const third = await restored.respond('Is the Brightwater Studio refund approved yet?')
third.content // 'Not yet. A manager must approve it.'
copies[0]
// '## Records\n### Brightwater Studio (BW-20931)\n- Order BW-5512 for account BW-20931: Brightwater Studio.\n- Refund due $148.50.\n\n## Rules\n- Refunds over $100 need a manager.\n\n## Request\nIs the Brightwater Studio refund approved yet?' — what the first ledger writes for the same request
```

To serve a thinking model, pass its context window as the `capacity` option and its generation cap, thinking included, as the `predict` option, and set the boolean `think` option to request or suppress thinking for the first pass. The answer pass always runs with thinking off. The plan then budgets what the window leaves after the cap, the recall room keeps the cap free, and the gauge counts only the thinking the next request carries; see [Serving a conversation through a ledger](#serving-a-conversation-through-a-ledger) for the budget.

### Upgrade data written before 0.0.35

Stored data written before 0.0.35 meets the checks of 0.0.35 at its next read. A stored snapshot that holds a `system` row rejects with `ConversationError` `'ROLE'` and the message `a conversation snapshot holds a system message; a snapshot written before 0.0.35 can hold a system row; remove it before loading`. A queued `AgentJobInput` seed that holds a `system` message fails at `AgentRegistry.build` through `add`, with `ConversationError` `'ROLE'` and the message `a stored message role must be one of "user", "assistant", "tool"; received "system"; host text goes in the system option or an instruction`, and the job's `system` member carries that text.

The following fence removes the row from a snapshot read from a store. It narrows the read through `isConversationSnapshot`, which stays structural, and it filters `messages` and each section's `messages`, because hydrating checks both and a fold can hold the row in a section:

```ts
import type { ConversationSnapshot, ConversationStoreInterface } from '@orkestrel/agent'
import { createConversation, isConversationSnapshot } from '@orkestrel/agent'

declare const store: ConversationStoreInterface // the host's store

const stored: unknown = await store.get('thread-1')
if (!isConversationSnapshot(stored)) throw new Error('Not a conversation snapshot')
const cleaned: ConversationSnapshot = {
	...stored,
	sections: stored.sections.map((section) => ({
		...section,
		messages: section.messages.filter(({ role }) => role !== 'system'),
	})),
	messages: stored.messages.filter(({ role }) => role !== 'system'),
}
await store.set(cleaned)
const conversation = createConversation({ snapshot: cleaned })
```

A judgment whose `sources` name a removed row hydrates unchanged, and a section the filter empties hydrates with no messages. The `isLedgerSnapshot` guard refuses a mark that names a removed row, so drop that id from a ledger snapshot's `requests`, `notes`, and `failures` lists as well.

A host that edits a stored snapshot's judgment to migrate or redact it copies the record first, because a write to the stored record throws `TypeError` in strict-mode code. A stored 0.0.34 conversation row matches in any key order after upgrade, and a record dead under the text compare becomes live, with no migration.

### Removing / clearing entries, and the less-common accessors

Agent-owned registries expose their less-common removal, clearing, persistence, and lookup methods here. Tool and workspace registry operations are documented in their dependency guides.

```ts
import type { ProviderInterface } from '@orkestrel/agent'
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

// ScopeManager — `add` mints + stores, `scopes` lists, `remove` / `clear` drop.
const scopes = createScopeManager()
const scope = scopes.add({ name: 'read-only' })
scopes.scopes() // every stored scope, in insertion order
scopes.remove(scope.id)
scopes.clear()

// Authority — `evaluate` decides and `ask` approves (both also reached through the agent loop internally).
const authority = createAuthority({ ask: () => true })
const call = { id: '1', name: 'add', arguments: {} }
const decision = authority.evaluate({ call }) // { zone: 'default', verdict: 'allow' }
await authority.ask?.({ call }, decision, new AbortController().signal) // true (`ask` is optional on the interface)

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
thread.snapshot() // { id, sections, messages, judgments? } — the durable payload

const agent = createAgent(provider)
void agent
```

### Practices

The following practices apply when you build on this package:

- **Bound every call** — pass an `AbortSignal` (an [abort](abort.md), or an `AbortSignal.any` over abort + [timeout](timeout.md) + [budget](budget.md)) so a request can be cancelled, deadlined, or capped.
- **Recover the stream's partial** — wrap a driven `stream` in `try`/`catch` and narrow with `isProviderAbortError` to keep the content that arrived before a cancel.
- **Fold usage into a budget** — `result.usage` is the [budgets](budget.md) `TokenUsage`; pass it to the `consume` method of the budget each turn to enforce a token ceiling.
- **Register tools in a `ToolManager`** — add your `Tool` instances through `add`, hand `definitions()` to the provider, and dispatch the `ToolCall` values the model returns through `execute`; read the outcome by narrowing on `success` rather than catching, because a handler's throw already arrives as the failure arm. When in-process code wants a typed error instead, call `tools.tool(name)` and call the `execute` method of that tool directly.
- **Narrow tool `args`** — a `ToolCall.arguments` is model-supplied `unknown`; narrow it inside `execute` with a guard.
- **Collect turns in an `AgentContext`** — append turns through `context.messages.add` (the `id` is minted for you), then call `build()` each turn to produce the provider input; tools travel as the provider's `tools` argument, so never fold a tool's schema into a message yourself.
- **Pull cross-conversation context with provenance, never by merging turns** — to use something from another conversation B in the active one, follow `B.search` / `B.rehydrate` (cherry-pick the few right turns) → `B.reference({ label, messages })` (frame it) → `context.workspaces.active?.write(...)` (write it into the active workspace). The provenance label keeps a small model from reading B's content (or a recap) as part of the live thread; cherry-pick — don't dump B's whole history into another context window.
- **Run the loop with `createAgent`** — don't hand-roll the context → provider → tools cycle; `createAgent` does it, bounded by `AbortSignal.any([signal, timeout, budget])`, paced by `scheduler`, capped at `limit`. Drain `stream().events` to render `token` / `think` / `usage` / `ask` / `tool` chunks live, or `generate()` for the settled result; either way `result` resolves partial on a cancel (read `result.partial`), rejecting only on a real error.
- **Run many durable agents with `createAgentQueue`** — describe each agent as a serializable `AgentJobInput` (names for the provider / tools / authority / scheduler, data for the rest), register the live pieces once in a `createAgentRegistry`, and enqueue the jobs. Persist them with a `store` so `restore()` re-runs outstanding work after a crash. Decide the partial policy up front — `partial: false` (default) retries a cancelled job, `true` accepts the partial.
- **Fan out sub-agents with `createAgentRunner`** — declare a parent job's sub-agents in its `children`; the runner spawns each through `controller.spawn` on the same bounded queue. Don't reach for the controller yourself — express fan-out as data on the job (it stays serializable) and let the runner spawn it.
- **Pull and push surfaces on the `Agent`, none elsewhere** — observe the `Agent` each way: pull the `AgentChunk` stream for per-token / per-thinking deltas + usage/ask/tool chunks, or push `agent.emitter.on(...)` (`AgentEventMap`) for lifecycle + usage/tool/deny moments a fire-and-forget observer wants. A listener throw can never corrupt the loop (the emitter isolates it, routing it to the `error` option). Don't reach for an Emitter on the provider contract, the tool registry, the conversation store, the context, or the job layer — those stay event-free; and don't expect per-token `token` or `think` events (those stay the stream's job).
- **Create and edit files through `@orkestrel/workspace`** — the file domain is that package's, and `AgentContext` borrows only its `isTextContent` / `isBinary` guards to decide a file's carrier. The rendering belongs to this package: the `## Workspace` fencing and the binary-plus-`image/` attachment are prompt policy that belongs here, not workspace helpers that belong there.
- **Judge the argument the model passed** — a tool handler that asks a judge about a model's tool call judges the argument that call carried, or its tool description says it judges a fixed input.
- **Write a refusal as the next step** — a refusal text a tool returns names the one next call and says nothing about who asked, because a reasoning model mid-task reads a refusal that addresses the user as a user turn.
- **Give the model both halves of a workspace** — `context.workspaces` is what it reads, rendered by carrier every turn, active-only and filtered by `scope.files`; the `createWorkspaceTool` published by `@orkestrel/toolbox` over that same registry is what it writes. For workspace editing, errors, and persistence, see [Workspace](workspace.md); for tool dispatch semantics, see [Tool](tool.md).

## Tests

The following test files back this guide:

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the Surface and method parity with `src/core`, the `Summary`, titled example, and pitch equality, and the executed flagship fences with the Contract clauses they back: scope timing, selection, judgments, modes, answer-only runs, recorded thinking and the replay policy, the ledger over a scripted provider and judge with its thinking budget, the classifier and the gauge, the relay over a loopback listener, the page wire to a Node agent over a loopback listener with its approval asks, its refusals, its two principals, and its `409` overlap, the System One judge over a recorded response, the server fence: one session entry per principal, the refused overlap that adds no user turn, and the user turn a rejected run keeps, both server fences tied to their transcriptions byte for byte, and the boundary, limit, and upgrade sentences: the request layout, the refused stored `system` row and its recovery, the selected `system` fault, the page-tool declaration and its `422`, the `consequential` lookup, the frozen judgment copy, the skill load's timing, the over-window paths, the no-slice fold, and a second `select` during a paced filing.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) — the root helpers `filterAllowList`, `joinThinking`, `stripThinking`, `sanitizeToken`, `sanitizeUsage`, `sumUsage`, `removeEntries`, `collectExchanges`, `hasCalls`, `collectToolGroups`, `renderJSON`, `matchesJSON`, and `matchesJudgment`, the `MESSAGE_ROLES` role list, and the `CONVERSATION_ROLES` stored role list with the `ConversationRole` and `MessageInput` role types.
- [`tests/src/core/cloners.test.ts`](../tests/src/core/cloners.test.ts) — `copyJSON` copying a proxied record where a structured clone refuses it and returning `undefined` for a value JSON can't carry, and `freezeJSON` returning a copy whose every nested record and list is frozen while its input stays unchanged, freezing every member of a very wide list, and returning `undefined` wherever `copyJSON` does.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) — the root guards `isJudgeEntry`, `isJudgeQuestion`, and `isNonNegativeSafeInteger`, each total over malformed input.
- [`tests/src/core/contracts.test.ts`](../tests/src/core/contracts.test.ts) — the message contract's round trip and malformed paths, function-valued arguments accepted in the domain and refused on the wire, the `MESSAGE_GUARD_CASES` agreement between `isMessage` and `messageContract`, and seeded wire messages kept in the domain.
- [`tests/src/core/shapers.test.ts`](../tests/src/core/shapers.test.ts) — the message, tool-call, and token usage wire shapes at the type level, with execution context kept off the wire, and the provider result schema unchanged by the shared usage shape.
- [`tests/src/core/integration.test.ts`](../tests/src/core/integration.test.ts) — the in-process relay hop, its `422` refusal and server-written system turn, and provider-agnosticism, where a minimal provider drives the full loop and differently named providers swap in.
- [`tests/src/core/providers/AgentProvider.test.ts`](../tests/src/core/providers/AgentProvider.test.ts) — the HTTP engine's request composition, stream assembly and settled results, bounded error body, header hook inside the cancellation bound, translation of a throw from the framing seam, cancellation partials, cleanup on every exit, and isolation between concurrent calls.
- [`tests/src/core/providers/RelayProvider.test.ts`](../tests/src/core/providers/RelayProvider.test.ts) — the browser end's owned request snapshot, wire refusals, default strict framing, supplied parser factory, frame mapping, remote abort reconstruction, and terminal-result recovery.
- [`tests/src/core/providers/RelayStream.test.ts`](../tests/src/core/providers/RelayStream.test.ts) — the relay response half's upstream replay policy, validated frames, fixed error message, backpressure, and inbound-abort finalization.
- [`tests/src/core/providers/ThinkSplitter.test.ts`](../tests/src/core/providers/ThinkSplitter.test.ts) — the `ThinkSplitter` state machine.
- [`tests/src/core/providers/AgentJudge.test.ts`](../tests/src/core/providers/AgentJudge.test.ts) — the judge engine's identity and request composition, refusals before inference, HTTP and protocol failures, header hook, and cancellation partials.
- [`tests/src/core/providers/SystemOneJudge.test.ts`](../tests/src/core/providers/SystemOneJudge.test.ts) — the System One wire against the bodies recorded on 2026-10-07.
- [`tests/src/core/providers/factories.test.ts`](../tests/src/core/providers/factories.test.ts) — the `createThinkSplitter` factory; the authorization, body-limit, malformed-body, policy, and upstream-construction refusals of `createRelay`; its server-written system turn and tool definitions; and its construction checks.
- [`tests/src/core/providers/helpers.test.ts`](../tests/src/core/providers/helpers.test.ts) — `buildProviderResult`, `armReaderAbort`, `readFailure`, `readBodyText`, `readChunks`, `measureAnswer`, `buildJudgeResult`, `buildProviderHeaders`, `requestToRelay`, `buildRelayRequest`, `describeRelayRefusal`, the System One helpers, and `releaseReader`.
- [`tests/src/core/providers/contracts.test.ts`](../tests/src/core/providers/contracts.test.ts) — the request, result, and relay-frame contracts' round trips, malformed paths, and non-JSON refusals.
- [`tests/src/core/providers/shapers.test.ts`](../tests/src/core/providers/shapers.test.ts) — the request, result, and relay wire shapes assignable to their domain types.
- [`tests/src/core/providers/validators.test.ts`](../tests/src/core/providers/validators.test.ts) — the System One guards `isSystemOneResponse` and `isSystemOneAnswer` over recorded, transliterated, and malformed envelopes.
- [`tests/src/core/conversations/Conversation.test.ts`](../tests/src/core/conversations/Conversation.test.ts) — the conversation's construction, `view`, `compact` with `keep` and its no-op and missing-summarizer cases, `rehydrate`, `search`, `reference`, `snapshot`, the `sections` cap, hydration, and the stored roles and snapshot checks: a `system` add or batch refused with nothing stored, a snapshot refused for a `system` role, a repeated id, or a malformed shape, the single read of its members, and `'JUDGMENT'` kept for a non-JSON judgment.
- [`tests/src/core/conversations/ConversationManager.test.ts`](../tests/src/core/conversations/ConversationManager.test.ts) — the registry's accessors, active pointer and `switch`, removal, the inherited `summarize`, `keep`, and `sections` defaults, independence, the durable `open` / `save` seam, a 0.0.29 snapshot read through `open` without its conversation `summary`, and `open` refusing a stored `system` role with the registry and `active` unchanged.
- [`tests/src/core/conversations/JudgmentManager.test.ts`](../tests/src/core/conversations/JudgmentManager.test.ts) — the keyed storage of `JudgmentManager` and its `resolve` method, which asks only unmatched questions, attaches one-question usage, records partial answers on abort, restores from a snapshot, and reuses a hydrated judgment whose keys were sorted, and the frozen records it returns.
- [`tests/src/core/conversations/factories.test.ts`](../tests/src/core/conversations/factories.test.ts) — `createConversation`, `createConversationManager`, `createMemoryConversationStore`, and `createDatabaseConversationStore`, each driving the instance it returns.
- [`tests/src/core/conversations/helpers.test.ts`](../tests/src/core/conversations/helpers.test.ts) — `buildJudgments`, `buildSummaryMessage`, `buildRecapMessage`, `requireJudgment`, `requireRole`, `requireConversationSnapshot`, `requireSectionsCap`, `requireKeep`, and `raceSignal`.
- [`tests/src/core/conversations/validators.test.ts`](../tests/src/core/conversations/validators.test.ts) — `isMessage`, `isJudgment` with snapshot carriage and its verdicts pinned over edge records, `isSection`, `isConversationSnapshot`, and `isConversation`, each total over malformed input.
- [`tests/src/core/conversations/stores/MemoryConversationStore.test.ts`](../tests/src/core/conversations/stores/MemoryConversationStore.test.ts) — the in-memory store's round trip, upsert, deletion, coexisting ids, JSON parity, and tool messages with and without `call`.
- [`tests/src/core/conversations/stores/DatabaseConversationStore.test.ts`](../tests/src/core/conversations/stores/DatabaseConversationStore.test.ts) — the driver-backed store's round trip, upsert, deletion, coexisting ids, driver overloads, and durability across instances.
- [`tests/src/core/contexts/AgentContext.test.ts`](../tests/src/core/contexts/AgentContext.test.ts) — the system boundary, freshness, and tool exclusion of `build()`, the context managers, the skills and memos indexes, workspace carriers and `scope.files`, scope filtering, format cascade, the default conversation and switch, `select` resolution over the conversation passed with its `'ROLE'` fault over a selected `system` message, and `build(selection)`.
- [`tests/src/core/contexts/factories.test.ts`](../tests/src/core/contexts/factories.test.ts) — `createInstruction`, `createInstructionManager`, `createScope`, `createScopeManager`, `createMemoManager`, `createMemoryMemoStore`, `createDatabaseMemoStore`, `createSkillManager`, and `createAgentContext`, with the memo store contract both stores run.
- [`tests/src/core/contexts/helpers.test.ts`](../tests/src/core/contexts/helpers.test.ts) — `renderFencedFile`, `renderSection`, `renderIndexEntry`, `attachImages`, `attachUserImages`, `collectImageData`, and `intersectKeys`.
- [`tests/src/core/contexts/validators.test.ts`](../tests/src/core/contexts/validators.test.ts) — `isMemo` and `isMemoSnapshot`, each total over malformed input, a sparse `memos` array, a throwing getter, a revoked proxy, and a function carrying a revision's members.
- [`tests/src/core/contexts/instructions/Instruction.test.ts`](../tests/src/core/contexts/instructions/Instruction.test.ts) — the minted id, default priority, carried override, and immutability of `Instruction`.
- [`tests/src/core/contexts/instructions/InstructionManager.test.ts`](../tests/src/core/contexts/instructions/InstructionManager.test.ts) — the instruction registry's lookup, ordering, build contract, manager-options format, removal, and emitter.
- [`tests/src/core/contexts/memos/MemoManager.test.ts`](../tests/src/core/contexts/memos/MemoManager.test.ts) — the memo set's revisions, unchanged-text no-op, history, ordering, removal of a whole history, snapshot round trip and silent hydration, format cascade, and emitter.
- [`tests/src/core/contexts/scopes/Scope.test.ts`](../tests/src/core/contexts/scopes/Scope.test.ts) — `Scope` construction, the `skills` and `memos` lists, the set intersection of `narrow`, and the `select` handler travelling with the scope.
- [`tests/src/core/contexts/scopes/ScopeManager.test.ts`](../tests/src/core/contexts/scopes/ScopeManager.test.ts) — the scope registry's add, lookup, removal, and emitter.
- [`tests/src/core/contexts/skills/SkillManager.test.ts`](../tests/src/core/contexts/skills/SkillManager.test.ts) — the skill registry's add, files minted through `createFile`, same-name replace, lookup, removal, format cascade, and emitter.
- [`tests/src/core/contexts/stores/MemoryMemoStore.test.ts`](../tests/src/core/contexts/stores/MemoryMemoStore.test.ts) — the in-memory memo store's restore into a manager, its JSON parity, and the object its `get` method returns.
- [`tests/src/core/contexts/stores/DatabaseMemoStore.test.ts`](../tests/src/core/contexts/stores/DatabaseMemoStore.test.ts) — the driver-backed memo store's malformed and foreign-id rows read as absent, its copy on read, and its table kept apart from the conversation store's on one driver.
- [`tests/src/core/agents/Agent.test.ts`](../tests/src/core/agents/Agent.test.ts) — the loop over a scripted provider: the recorded-request control, scope dispatch, tool iteration, authority, `generate` and `stream` parity, chunks, bounds, cancellation timing, the emitter, automatic compaction, recorded thinking and the replay policy, multi-conversation runs and the run-bound conversation under a switch, a fold, and a removal, limit exhaustion, budget reconciliation, per-run options, the concurrency guard with its refusal of a second run on one conversation, usage sanitizing, the selection seam, the turn records, the three failure layers, the stored-ingress canary that refuses a `system` message through `add`, a snapshot, a job seed, and a selection and sends none, the scope denial of a name no definition advertises under every verdict, the `ask` chunk and its order, the approver over a real run with its page answers, timeouts, aborts, and injected arguments, the `prompt` option with its exact check and its append after the run's guards, and the forwarded skills and memos.
- [`tests/src/core/agents/AgentRegistry.test.ts`](../tests/src/core/agents/AgentRegistry.test.ts) — the registry's accessors, rehydrating `build` and its field wiring, a job seed holding a `system` role refused, isolation, the conversation store seam, and an empty registry.
- [`tests/src/core/agents/Authority.test.ts`](../tests/src/core/agents/Authority.test.ts) — first-match-wins ordering, a matched rule's default allow, the fallback, the `{ call }` context, and the `ask` approver with its `'APPROVER'` refusal.
- [`tests/src/core/agents/Approver.test.ts`](../tests/src/core/agents/Approver.test.ts) — the bound `ask`, the ask registered before it suspends, the frame's members and minted id, strict approval, identity keying, the missed mark, the second-ask and unrenderable-argument refusals with the call name encoded, and the release of the run signal on an answer and an abort.
- [`tests/src/core/agents/Channel.test.ts`](../tests/src/core/agents/Channel.test.ts) — the channel's lost-wakeup, `undefined` values, buffer-before-close, `fail`, concurrent readers, push after end, FIFO order, end semantics, the unread rest before an end, and a `return()` while a read is parked.
- [`tests/src/core/agents/ChannelCell.test.ts`](../tests/src/core/agents/ChannelCell.test.ts) — the internal `ChannelCell` class: a new cell's value with no next cell, and the `link` method's latch, which keeps the first linked cell.
- [`tests/src/core/agents/factories.test.ts`](../tests/src/core/agents/factories.test.ts) — `createChannel`, `createAgent`, `createApprover`, `createAgentRegistry`, `createAgentQueue` with its durability, partial policy, and lifecycle, `createAgentRunner` with fan-out, and the `AgentJobError` / `isAgentJobError` block.
- [`tests/src/core/agents/helpers.test.ts`](../tests/src/core/agents/helpers.test.ts) — `agentResultToJSON` with its `stop` projection, `tokenUsageToJSON`, `inferStop`, `requireBudget`, `requireConversation`, `estimateMessages`, `estimateRequest`, `measureMessage`, `measureRequest`, `settleAgentJob`, `assembleResult`, `denyCall` with each denial note, `renderArguments` with its escaped code points, `agentChunkToFrame`, `agentResultToFrame`, `agentStreamToFrames` with its one terminal frame and the frame canary, `resolveDecision`, and `chargeUsage`.
- [`tests/src/core/agents/shapers.test.ts`](../tests/src/core/agents/shapers.test.ts) — the frame, prompt, and answer wire shapes inferring their domain types both ways.
- [`tests/src/core/agents/contracts.test.ts`](../tests/src/core/agents/contracts.test.ts) — the frame, prompt, and answer contracts over every frame arm and every refused wire row, a throwing `Proxy`, and seeded values that agree with `parse`.
- [`tests/src/core/agents/validators.test.ts`](../tests/src/core/agents/validators.test.ts) — `isAuthorityDecision` over each verdict with and without `reason`, and its refusal of a `{ zone, allowed }` decision, an unknown verdict, a non-string `zone` or `reason`, a non-object, a throwing getter, a revoked `Proxy`, and a `Proxy` whose `get` trap throws.
- [`tests/src/core/agents/AgentFanout.test.ts`](../tests/src/core/agents/AgentFanout.test.ts) — `AgentFanout` through a real runner: one fan-out per unit across a retried attempt, every distinct unit's children, and the partial policy.
- [`tests/src/core/ledgers/Ledger.test.ts`](../tests/src/core/ledgers/Ledger.test.ts) — the ledger over a scripted provider: owner records, seed stubs paired with their calls by call id and priced at their longer form, and the seed tail, the `'REQUEST'` fault of a run no active `respond` call owns, a run on another conversation, and the refused direct run during a request, the runs that stay on the ledger's conversation under a switch, the repeat stop, the answer pass and the abort that skips it, calibration with its replay at the next user boundary and its refusals, the filing of notes and failed lookups, the `recall` tool's listing, limit, and room, the answer note's lines, the generation cap and thinking per pass, and retained amended sentences with unresolved scope while `recall`, the answer note, and the seed tail keep stored content, and the snapshot and hydrate: selections and judge keys equal to the uninterrupted ledger's with each emptied mark list as a control, the JSON round trip, the `'CONCURRENCY'` refusal, the flush before capture, judgments kept across a judge abort, the `'SNAPSHOT'` refusals, the `'ROLE'` refusal of a hydrated `system` message, the gauge precedence, the fork, a recorded correction fixture replayed through a hydrated ledger, the replay from a sorted snapshot, each lookup result read once per selection, a message removed during a judge await kept out of that selection's plan, the forwarding of the `narrow` member to the classifier, head pricing and the built-head calibration, and the host turns: each entry refused during one, another thread's refused run and its recall, an append and a removal that fault the selection with no question about a gone message, a judgment removed during one asked again, an abort and a scheduler fault that leave the ledger free, the same bytes when paced, and the agent's turn between its own turns.
- [`tests/src/core/ledgers/LedgerRequest.test.ts`](../tests/src/core/ledgers/LedgerRequest.test.ts) — the request's recall-limit refusal, its single `enter`, its passes with their selections, usage, calls, and thinking, its filing attempts and plan, the repeat stop, the recall limit and `close`, and the listings of a recall result.
- [`tests/src/core/ledgers/Classifier.test.ts`](../tests/src/core/ledgers/Classifier.test.ts) — the measured question bytes and asking order, judgment reuse and usage, exact cutoffs, the category tie in `LEDGER_CATEGORIES` order, pair questions, deterministic and transient judge failures, abort faults that keep the completed judgments, the cached, skipped, resolved, failed, and aborted attempts each of those paths records, each message's quiet flag and near set read once per classification, with a change to the conversation or the judge's model read at the next call, the pairs of every eligible earlier message asked in conversation order and the narrower set of the `narrow` member, and the host turns: a yield after a slice elapses on a recording and a real scheduler, none in a live slice or with no scheduler, the same questions when paced, the asks a removed source skips, an abort during a turn, and a scheduler fault.
- [`tests/src/core/ledgers/Gauge.test.ts`](../tests/src/core/ledgers/Gauge.test.ts) — the gauge's construction refusals and its `observe`, `rate`, `remainder`, `reserve`, and `room` methods, under the generation cap and each replay policy.
- [`tests/src/core/ledgers/factories.test.ts`](../tests/src/core/ledgers/factories.test.ts) — `createLedger` and its `LedgerError` refusals for thresholds, shares, capacity, limits, topics, lookups, and a supplied gauge, the keys of the `LedgerAgentOptions` type, and the barrel exports of the ledger module.
- [`tests/src/core/ledgers/helpers.test.ts`](../tests/src/core/ledgers/helpers.test.ts) — the projection helpers from `splitSentences` through `buildRecords` and `selectRecords`, the `normalizeWord` fold, the alias index the `buildLedgerIndex` function builds for the `matchEntities` function, the record renderers, `findLedgerCall`, `rankLedgerCut`, `findLedgerCut`, `buildLedgerCut`, `splitTopic`, `cutListing` and `matchesCutLine`, `renderStub`, `buildRequestMessage`, `normalizeArgument`, `splitResultLines`, `renderLookupCall`, `computeThinking`, `resolvePredict`, and `fitSlope`.
- [`tests/src/core/ledgers/validators.test.ts`](../tests/src/core/ledgers/validators.test.ts) — `isFraction`, `isPositiveSafeInteger`, and `isLedgerSnapshot`, which refuses every malformed snapshot, an unknown or mis-roled id, a throwing getter, and a revoked proxy, and accepts a snapshot a ledger returned.

### Placement proofs

Each placement has a named proof location:

- **Node alone.** The agent, provider, and tools run in Node. The `src:core` project executes “runs the agent tool loop in Node and feeds the result into the next provider turn” in [`tests/src/core/integration.test.ts`](../tests/src/core/integration.test.ts).
- **Page alone.** The agent, an in-page provider, and page tools run in the page. A page `Ledger` stays responsive only with `agent: { scheduler: createBrowserScheduler() }`, as **The filing.** states. The receipt is planned in the `tests/distribution.test.ts` file of the `@orkestrel/mcp` checkout, in the `distribution` project: the planned proof “executes a page tool through an agent without network requests”. That receipt must come from installed artifacts in Chromium; this guide doesn't record it as passed.
- **Page to Node relay.** The agent, relay provider, and page tools run in the page; `createRelay` and the upstream provider run in Node. The receipt is planned in the same `@orkestrel/mcp` distribution proof file: the planned proof “executes a page tool through an agent over a Node relay”. This guide doesn't record that Chromium receipt as passed. The guide transcription's HTTP hop runs in Node and proves that narrower placement.
- **Page to Node agent.** The agent, provider, tools, and approver run in Node; the page sends an `AgentPrompt`, renders `AgentFrame` values, and answers an `ask` frame with an `AgentAnswer`. The `guides` project executes “serves the page wire over an HTTP hop” in [`tests/guides.test.ts`](../tests/guides.test.ts), which runs both fences of the Serving a Node agent to a page section over an HTTP hop in Node.

## See also

The following guides and packages relate to this one:

- [Budget](budget.md) — the cost primitive; `ProviderResult.usage` and `AgentResult.usage` reuse its `TokenUsage`, and a token budget bounds a provider call / an agent turn.
- [Abort](abort.md) / [Timeout](timeout.md) — the bounding signals folded into a call's `AbortSignal` through `AbortSignal.any`; `@orkestrel/timeout` is also the deadline `AgentProvider` arms for every call it makes.
- `@orkestrel/router` — one dispatcher a `RelayHandler` mounts on. The handler is fetch-standard, so any router that routes a `Request` to a `Response` works.
- [Queue](queue.md) — the bounded-concurrency, retrying, durable `Queue` `createAgentQueue` composes for many agent jobs.
- [Workflow](workflow.md) — the `SchedulerInterface` the loop yields to between turns, and the fail-fast `Runner` `createAgentRunner` composes for sub-agent fan-out.
- [Emitter](emitter.md) — the foundational observable primitive the `Agent` owns as its push `emitter`; `AgentEventMap` is its event map, wired through the reserved `on` option.
- [Tool](tool.md) — the tool runtime this loop advertises from and dispatches through: definitions, calls, and the success-discriminated `ToolResult`.
- [Workspace](workspace.md) — the file domain whose active workspace `AgentContext` renders into a turn: files, editing, events, and persistence.
- [Contract](contract.md) — the shape DSL other tools (for example the `createWorkspaceTool` function of the `@orkestrel/toolbox` package) compile against; the shared `describedLiteral` (a discriminant's description-carrier) and `schemaToParameters` (the tool-parameters narrowing) live there.
- [Database](database.md) — the `DriverInterface` / `TableInterface` seam `createDatabaseConversationStore` persists conversation snapshots through and `createDatabaseMemoStore` persists memo sets through.
- [AGENTS.md](../AGENTS.md) — the repository's authority pointer; the coding rules it resolves to live in `@orkestrel/scaffold`.
- [Guides](README.md) — the guides index.
