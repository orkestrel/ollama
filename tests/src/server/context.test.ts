import { describe, expect, it } from 'vitest'
import type {
	AgentResult,
	ContextFormatInterface,
	ConversationInterface,
	MessageInterface,
} from '@orkestrel/agent'
import {
	CONVERSATION_RECAP_PREFIX,
	createAgent,
	createConversation,
	createConversationManager,
	createTool,
	createToolManager,
	estimateMessages,
} from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'
import { createOllama } from '@src/server'
import { collect } from '../../setup.js'
import {
	createLiveProvider,
	createRecordingProxy,
	FAST_OPTIONS,
	OLLAMA_CONFIG,
} from '../../setupServer.js'

// LIVE context tests — the src:ollama project hits a REAL warmed Ollama (AGENTS §16: no mocks
// for the inference boundary; setupServer.ts hard-requires + warms the model, never skips). The
// DETERMINISTIC ordering / default-format / four-level cascade assertions live in
// tests/src/core/agents/AgentContext.test.ts (pinned byte-for-byte against build()); here we
// prove the COMPLEMENT: WHAT THE PROVIDER ACTUALLY SENDS to the daemon once AgentContext has
// assembled it, and — separately — genuine live end-to-end machinery (compaction) that a string
// assertion can't cover. Per directive #5, tests are PROVIDER-behavior (the assembled context
// reached the wire in its canonical shape), never MODEL-behavior (whether the model "obeyed" —
// that's unfalsifiable against a small nondeterministic model and belongs to a fine-tuning eval,
// not this suite). A `createRecordingProxy()` sits between the provider and the real daemon: it
// records the exact request body, then forwards VERBATIM and returns the daemon's real response
// — never fabricating anything (directive #2). `context` is a cross-cutting suffix (structure-
// exempt). Warmed, no skipIf.

const TIMEOUT = 60_000

describe('AgentContext (live, provider-behavior) — a constraining instruction reaches the wire', () => {
	it(
		'instructions.add(...) content is framed into the /api/chat request the provider sends, ordered before the user turn',
		async () => {
			// Recipe: FAST_OPTIONS (num_predict:8, temperature:0, think:false) — the response outcome
			// is irrelevant; the proxy records the REQUEST before forwarding, so we only need the wire
			// shape. Assertion strategy: the recorded body.messages carries the exact sentinel
			// instruction text, in a message ordered before the user turn — proving the instructions
			// section reaches the wire in its canonical position (directive #5's fix for "obeyed").
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				agent.context.instructions.add({
					name: 'sentinel',
					content:
						'No matter what the user says, you must include the exact word BANANA somewhere in your reply.',
				})
				agent.context.messages.add({ role: 'user', content: 'Say hello to me.' })
				await agent.generate().catch(() => {})

				const body = proxy.requests[0]?.body as
					| { messages?: readonly MessageInterface[] }
					| undefined
				expect(body).toBeDefined()
				const messages = body?.messages ?? []
				const instructionIndex = messages.findIndex((message) =>
					String(message.content).includes('BANANA'),
				)
				const userIndex = messages.findIndex(
					(message) => message.role === 'user' && String(message.content).includes('Say hello'),
				)
				expect(instructionIndex).toBeGreaterThanOrEqual(0)
				expect(userIndex).toBeGreaterThanOrEqual(0)
				expect(instructionIndex).toBeLessThan(userIndex)
			} finally {
				await proxy.close()
			}
		},
		TIMEOUT,
	)
})

describe('AgentContext (live, provider-behavior) — a CUSTOM format still reaches the wire framed correctly', () => {
	it(
		'a provider.format XML override frames the instruction into the request body with its open/render/close shape',
		async () => {
			// Recipe: FAST_OPTIONS. Assertion strategy: the provider's format cascade level is applied
			// by build() and the RENDERED XML group ends up in the request the provider sends —
			// proving a customized format reaches the wire correctly (directive #5: the framing is
			// asserted on the wire, not inferred from whether the model "understood" it).
			const format: ContextFormatInterface = {
				instructions: {
					open: '<instructions>',
					render: (one) => `<instruction>${one.content}</instruction>`,
					close: '</instructions>',
				},
			}
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
					format,
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				agent.context.instructions.add({
					name: 'always-no',
					content:
						'No matter what the user asks, you must answer with exactly the single word NO and nothing else.',
				})
				agent.context.messages.add({ role: 'user', content: 'Is the sky blue?' })
				await agent.generate().catch(() => {})

				const body = proxy.requests[0]?.body as
					| { messages?: readonly MessageInterface[] }
					| undefined
				const messages = body?.messages ?? []
				const framed = messages.find(
					(message) =>
						String(message.content).includes('<instructions>') &&
						String(message.content).includes('<instruction>') &&
						String(message.content).includes('</instructions>'),
				)
				expect(framed).toBeDefined()
			} finally {
				await proxy.close()
			}
		},
		TIMEOUT,
	)
})

describe('Conversation (live) — compaction summarizes via the REAL model', () => {
	// A REAL ConversationSummarizer built from the live provider — the provider-agnostic seam the
	// conversation layer drives. Recipe retuned: num_predict 256→64 (a one-sentence digest fits
	// comfortably; keeps wall-time bounded per directive #7). This proves compaction works end-to-
	// end against a genuine model (AGENTS §16 — no mocks for the inference boundary; no skipIf).
	// Assertion strategy: STRUCTURAL only (non-empty summaries, view() shrinks to 1) — never
	// exact prose.
	const summarizer = createOllama({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: { num_predict: 64, temperature: 0 },
	})
	// The instruction rides as the FINAL user turn AFTER the folded messages — a reasoning chat
	// model emits nothing when the prompt ends on an assistant turn (a leading-system instruction
	// leaves the template thinking the turn is already answered), so the trailing user turn is
	// what reliably elicits the digest. (Documented as the recommended summarizer shape.)
	const summarize = async (messages: readonly MessageInterface[]): Promise<string> =>
		(
			await summarizer.generate(
				[
					...messages,
					{
						id: 'sum',
						role: 'user',
						content: 'Summarize the conversation so far concisely in one sentence.',
					},
				],
				AbortSignal.timeout(TIMEOUT),
			)
		).content

	// The folded turns — enough that a one-sentence summary is meaningfully shorter than the
	// originals (so the post-compaction view() is provably smaller).
	const seed = (conversation: ReturnType<typeof createConversation>): void => {
		conversation.add([
			{ role: 'user', content: 'My name is Ada and I am planning a trip to Kyoto in spring.' },
			{
				role: 'assistant',
				content: 'Kyoto in spring is lovely — the cherry blossoms peak in early April.',
			},
			{ role: 'user', content: 'I want to visit temples and try traditional food.' },
			{
				role: 'assistant',
				content: 'Fushimi Inari and Kinkaku-ji are must-sees; try kaiseki and yudofu.',
			},
		])
	}

	it(
		'compact() folds the live tail into a section + rollup, both authored by the live model, and view() shrinks',
		async () => {
			// Bounded retry (explicit attempts=3, per directive #7) over the small model's
			// nondeterminism: each attempt is a FRESH conversation seeded + compacted, retried until
			// the model genuinely produced a non-empty section summary (never a vacuous pass), failing
			// loudly if NO attempt across the loop did.
			const attempts = 3
			let conversation = createConversation({ summarize })
			let before = 0
			for (let attempt = 0; attempt < attempts; attempt += 1) {
				conversation = createConversation({ summarize })
				seed(conversation)
				before = conversation.view().length
				const section = await conversation.compact()
				if (section !== undefined && section.summary.trim().length > 0) break
			}

			// The model authored a NON-EMPTY section summary (a real digest of the folded turns) and a
			// NON-EMPTY rollup (a second real summarizer call over the section summaries).
			const section = conversation.sections[0]
			expect(section).toBeDefined()
			expect((section?.summary ?? '').trim().length).toBeGreaterThan(0)
			expect((conversation.summary ?? '').trim().length).toBeGreaterThan(0)
			// view() SHRANK: four live turns folded into ONE section summary message.
			const after = conversation.view().length
			expect(after).toBeLessThan(before)
			expect(after).toBe(1)
		},
		TIMEOUT,
	)
})

describe('Agent (live) — AUTOMATIC compaction fires mid-run, the run continues on the compacted view', () => {
	// The headline live proof of Chunk B: an agent with an injected conversation + a LOW `window`
	// auto-compacts BETWEEN turns (compact-and-continue) during a REAL multi-turn run, then
	// produces a valid final answer THROUGH the compacted context. The deterministic loop trigger
	// is pinned in tests/src/core/agents/Agent.test.ts; here a genuine model drives the tool-call
	// turn that crosses the threshold, the conversation's REAL-model summarizer folds the tail, and
	// the model answers from the compacted view. Warmed, no skipIf (AGENTS §16). Recipe retuned:
	// summarizer num_predict 256→64, bounded retry attempts=3 (directive #7). Assertion strategy:
	// STRUCTURAL only (section count + non-empty summary, non-empty non-partial final answer).

	const summarizer = createOllama({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: { num_predict: 64, temperature: 0 },
	})
	const summarize = async (messages: readonly MessageInterface[]): Promise<string> =>
		(
			await summarizer.generate(
				[
					...messages,
					{
						id: 'sum',
						role: 'user',
						content: 'Summarize the conversation so far concisely in one sentence.',
					},
				],
				AbortSignal.timeout(TIMEOUT),
			)
		).content

	// A no-args lookup tool returning a sentinel the model cannot derive on its own — so a final
	// answer carrying it proves the multi-turn round-trip survived compaction (the model called the
	// tool, the loop compacted the tail BETWEEN turns, then the model produced a final turn USING
	// the fed-back result THROUGH the compacted view).
	const SENTINEL = '8254'

	const attemptRun = async (): Promise<{
		readonly conversation: ConversationInterface
		readonly result: AgentResult
	}> => {
		const conversations = createConversationManager({ summarize, keep: 1 })
		const conversation = conversations.add() // auto-activates — the agent's message source
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'lookup_code',
				description: 'Look up the secret access code. Takes no arguments.',
				parameters: { type: 'object', properties: {} },
				execute: () => ({ code: SENTINEL }),
			}),
		)
		const agent = createAgent(createLiveProvider(), {
			system:
				'You MUST call the lookup_code tool to obtain the secret access code, then state the code in your final reply. Never invent a code.',
			tools,
			conversations,
			window: createBudget({ max: 48, consume: estimateMessages }),
			timeout: TIMEOUT,
			limit: 4,
		})
		agent.context.messages.add({
			role: 'user',
			content:
				'What is the secret access code? You MUST call the lookup_code tool, then tell me the code.',
		})
		const stream = agent.stream()
		await collect(stream.events)
		const result = await stream.result
		return { conversation, result }
	}

	// Whether an attempt genuinely auto-compacted mid-run: at least one section folded, authored by
	// the live model (a non-empty summary). This is the load-bearing trigger proof.
	const compacted = (tried: { readonly conversation: ConversationInterface }): boolean => {
		const section = tried.conversation.sections[0]
		return section !== undefined && section.summary.trim().length > 0
	}

	it(
		'a real multi-turn run with window set folds the tail mid-run + answers from the compacted view',
		async () => {
			// Bounded retry, explicit attempts=3 (directive #7) over the 2B model's tool-use
			// nondeterminism — each attempt is a FRESH conversation + agent. Retry until an attempt
			// genuinely (a) auto-compacted mid-run AND (b) produced a valid (non-empty, non-partial)
			// final answer THROUGH the compacted view. FAIL loudly if NO attempt across the loop
			// achieved it.
			const attempts = 3
			let tried = await attemptRun()
			let best = tried
			for (let n = 0; n < attempts; n += 1) {
				const valid = compacted(tried) && tried.result.content.trim().length > 0
				if (valid) {
					best = tried
					if (tried.result.content.includes(SENTINEL)) break
				}
				if (n < attempts - 1) tried = await attemptRun()
			}

			// (a) AUTOMATIC compaction fired mid-run — at least one section, authored by the live
			// model (a non-empty summary), now exists on the injected conversation.
			expect(best.conversation.sections.length).toBeGreaterThan(0)
			expect((best.conversation.sections[0]?.summary ?? '').trim().length).toBeGreaterThan(0)
			// (b) The run produced a VALID final answer THROUGH the compacted view — non-empty and
			// not partial — proving the loop continued correctly on the compacted context.
			expect(best.result.content.trim().length).toBeGreaterThan(0)
			expect(best.result.partial).toBe(false)
		},
		TIMEOUT,
	)
})

describe('Agent (live) — repeated auto-compaction stays COHERENT across MULTIPLE folds', () => {
	// THE production proof of Chunk B's hardening: a REAL multi-turn run that forces MULTIPLE
	// compactions (≥ 2 sections) and shows the agent stays coherent THROUGH the repeatedly-compacted
	// context — a valid, non-partial final answer with NON-EMPTY model-written section summaries.
	// The deterministic pre-first-turn / non-fatal / futile paths are pinned in Agent.test.ts; here
	// a genuine model drives several tool-call turns, the real-model summarizer folds the tail on
	// EACH between-turns check (a tiny window crossed every turn), and the model answers from the
	// multiply-compacted view. Warmed, no skipIf, bounded-retry (attempts=3, directive #7).
	// Assertion strategy: STRUCTURAL only.
	const summarizer = createOllama({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: { num_predict: 64, temperature: 0 },
	})
	const summarize = async (messages: readonly MessageInterface[]): Promise<string> =>
		(
			await summarizer.generate(
				[
					...messages,
					{
						id: 'sum',
						role: 'user',
						content: 'Summarize the conversation so far concisely in one sentence.',
					},
				],
				AbortSignal.timeout(TIMEOUT),
			)
		).content

	// The forced tool call (the proven reliable pattern from the block above): a no-arg lookup the
	// system prompt MANDATES, returning a sentinel the model cannot derive — so a final answer that
	// states it could only come THROUGH the compacted context. keep: 1 retains the most recent message
	// verbatim across each fold so the run never loses its immediate footing.
	const SENTINEL = '7193'

	const attemptMulti = async (): Promise<{
		readonly conversation: ConversationInterface
		readonly result: AgentResult
	}> => {
		const conversations = createConversationManager({ summarize, keep: 1 })
		const conversation = conversations.add() // auto-activates — the agent's message source
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'lookup_secret',
				description: 'Look up the secret access code. Takes no arguments.',
				parameters: { type: 'object', properties: {} },
				execute: () => ({ code: SENTINEL }),
			}),
		)
		const agent = createAgent(createLiveProvider(), {
			system:
				'You MUST call the lookup_secret tool to obtain the secret access code, then state the ' +
				'code in your final reply. Never invent a code.',
			tools,
			conversations,
			window: createBudget({ max: 40, consume: estimateMessages }),
			timeout: TIMEOUT,
			limit: 8,
		})
		// SEED a prior multi-turn history (a resumed / long conversation) — six turns whose absolute
		// footprint already exceeds the tiny window, so the PRE-FIRST-TURN check folds them into the
		// first section before the model is ever called.
		conversation.add([
			{ role: 'user', content: 'Hi, I am planning a trip and need help organizing the details.' },
			{ role: 'assistant', content: 'Happy to help — tell me your destination and dates.' },
			{ role: 'user', content: 'Kyoto, in early April, for about a week with my family.' },
			{ role: 'assistant', content: 'Great — early April is cherry-blossom season in Kyoto.' },
			{ role: 'user', content: 'We are interested in temples, gardens, and traditional food.' },
			{ role: 'assistant', content: 'Fushimi Inari, Kinkaku-ji, and a kaiseki dinner are musts.' },
		])
		agent.context.messages.add({
			role: 'user',
			content:
				'Before we continue planning, what is the secret access code? You MUST call the ' +
				'lookup_secret tool, then tell me the code.',
		})
		const stream = agent.stream()
		await collect(stream.events)
		const result = await stream.result
		return { conversation, result }
	}

	// Whether an attempt forced MULTIPLE folds: at least TWO sections, each authored by the live model
	// (a non-empty summary). This is the load-bearing multi-compaction proof.
	const multiCompacted = (tried: { readonly conversation: ConversationInterface }): boolean => {
		const sections = tried.conversation.sections
		return sections.length >= 2 && sections.every((section) => section.summary.trim().length > 0)
	}

	it(
		'forces ≥ 2 mid-run folds and produces a valid final answer through the repeatedly-compacted context',
		async () => {
			// Bounded retry, explicit attempts=3 (directive #7) over the 2B model's tool-use
			// nondeterminism — each attempt is a FRESH conversation + agent. Retry until an attempt
			// genuinely (a) folded ≥ 2 sections (each a non-empty model-written summary) AND (b)
			// produced a valid (non-empty, non-partial) final answer THROUGH the repeatedly-compacted
			// view. FAIL loudly if NO attempt across the loop achieved it.
			const attempts = 3
			let best = await attemptMulti()
			for (let n = 0; n < attempts; n += 1) {
				if (multiCompacted(best) && best.result.content.trim().length > 0 && !best.result.partial) {
					break
				}
				if (n < attempts - 1) best = await attemptMulti()
			}

			// (a) MULTIPLE compactions fired mid-run — at least TWO sections now exist on the injected
			// conversation, EACH authored by the live model (a non-empty, real one-sentence digest).
			expect(best.conversation.sections.length).toBeGreaterThanOrEqual(2)
			for (const section of best.conversation.sections) {
				expect(section.summary.trim().length).toBeGreaterThan(0)
			}
			// (b) The run stayed COHERENT through the repeatedly-compacted context — a valid, non-partial
			// final answer produced AFTER multiple folds (proving each rebuilt working array stayed a
			// usable prompt the model could keep reasoning from).
			expect(best.result.content.trim().length).toBeGreaterThan(0)
			expect(best.result.partial).toBe(false)
		},
		TIMEOUT,
	)
})

describe('Conversation framing (live, provider-behavior) — the TIGHTENED recap prefix reaches the wire', () => {
	// Directive #5's named-bug fix: the OLD test measured whether a recap label made the MODEL
	// answer an attribution question correctly (a pass-rate/A-B comparison) — a model-BEHAVIOR
	// assertion, forbidden. REPLACED entirely with a deterministic PROVIDER-behavior assertion: a
	// folded section (view()'s recap shape) is sent to the agent, and we assert the RECORDED
	// request body carries the message labeled with CONVERSATION_RECAP_PREFIX — proving the recap
	// framing is what the provider actually SENDS, independent of whether the model then "gets it
	// right". No passRate / honored / console.info / >= comparison remains.

	const FACT = 'XJ7'
	// A third-person NARRATION attributing the key to the USER — the digest shape a fold produces.
	const summary = `The user introduced themselves as Ada and shared that their deploy key is ${FACT}. The assistant acknowledged it.`

	it(
		'a recap-labeled section summary is framed with CONVERSATION_RECAP_PREFIX in the request the provider sends',
		async () => {
			// Recipe: FAST_OPTIONS — the response is irrelevant; the proxy records the request before
			// forwarding.
			const proxy = await createRecordingProxy()
			try {
				const conversations = createConversationManager()
				const active = conversations.add()
				// Seed a section directly (the exact recap shape view() folds a compacted section into)
				// rather than driving a real compaction — the wire-framing assertion is deterministic and
				// doesn't need a live summarizer call.
				active.add({ role: 'assistant', content: `${CONVERSATION_RECAP_PREFIX}${summary}` })
				active.add({
					role: 'user',
					content: 'What did I tell you my deploy key was?',
				})
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const agent = createAgent(provider, { conversations, timeout: TIMEOUT })
				await agent.generate().catch(() => {})

				const body = proxy.requests[0]?.body as
					| { messages?: readonly MessageInterface[] }
					| undefined
				const messages = body?.messages ?? []
				const recapMessage = messages.find((message) =>
					String(message.content).startsWith(CONVERSATION_RECAP_PREFIX),
				)
				expect(recapMessage).toBeDefined()
				expect(String(recapMessage?.content)).toContain(FACT)
			} finally {
				await proxy.close()
			}
		},
		TIMEOUT,
	)
})

describe('Conversation.reference (live) — cross-conversation attribution (provenance not bled)', () => {
	// Conversation A is ACTIVE (a one-fact A-context: "we are debugging auth"); a SEPARATE
	// conversation B's reference() — carrying a B-fact ("the team chose Postgres") — is written
	// into A's ACTIVE WORKSPACE (the SOLE document context build() folds into the system block).
	// Assertion strategy (directive #5's conversion): the DETERMINISTIC reference-block content is
	// still asserted directly, and the "surfaces + attributes" live claim is REPLACED with a
	// provider-behavior assertion — the recorded request body the provider sends carries the
	// reference document text (Postgres + its "planning" provenance label), proving the B-fact and
	// its attribution reach the wire via the active workspace framing (no dependency on whether the
	// model then repeats it correctly).

	it(
		'writes B’s decision + provenance into A’s active workspace, and the reference text reaches the request the provider sends',
		async () => {
			// Conversation B (the planning thread) — its rollup summary carries the decision. We craft
			// the summary directly (a stub digest) so the probe is about the REFERENCE plumbing +
			// provenance, not about a model-authored summary (which the Conversation-live block above
			// proves).
			const planning = createConversation({ id: 'planning' })
			planning.add([
				{ role: 'user', content: 'Which database should we use?' },
				{ role: 'assistant', content: 'The team evaluated the options and chose Postgres.' },
			])
			const block = planning.reference({
				label: 'planning',
				summary: false,
				messages: planning.search('Postgres'),
			})
			// DETERMINISTIC: the rendered reference block carries the fact and its provenance label.
			expect(block).toContain('Postgres')
			expect(block).toContain('planning')

			const proxy = await createRecordingProxy()
			try {
				// Conversation A is ACTIVE — its own A-fact lives as a live user turn.
				const conversations = createConversationManager()
				const active = conversations.add({ id: 'auth' }) // auto-activates
				active.add({ role: 'user', content: 'In this chat we are debugging auth.' })
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const agent = createAgent(provider, {
					system: 'Use the reference documents when they answer the question. Be brief.',
					conversations,
					timeout: TIMEOUT,
				})
				// PULL B into A with provenance: B.reference(...) framed + written into A's active
				// workspace.
				agent.context.workspaces.add().write(`conversation:${planning.id}.md`, block)
				active.add({
					role: 'user',
					content: 'Which database did we pick, and in which conversation was it decided?',
				})
				await agent.generate().catch(() => {})

				const body = proxy.requests[0]?.body as
					| { messages?: readonly MessageInterface[] }
					| undefined
				const messages = body?.messages ?? []
				const carriesReference = messages.some(
					(message) =>
						String(message.content).includes('Postgres') &&
						String(message.content).includes('planning'),
				)
				expect(carriesReference).toBe(true)
			} finally {
				await proxy.close()
			}
		},
		TIMEOUT,
	)
})

describe('Conversation.reference (live) — cherry-pick ONE relevant message, not the whole history', () => {
	// B has ~5 short messages, exactly ONE relevant ("the API endpoint is /v2/sync"). We pull ONLY
	// it via B.search('endpoint') → reference({ messages }) → write into A's active workspace.
	// Assertion strategy (directive #5's conversion): (1) DETERMINISTICALLY the rendered reference
	// carries only that one message — NOT B's other four (cherry-pick, never a full dump that
	// re-bloats a small model's context); (2) the "model recalls the endpoint" live claim is
	// REPLACED with a provider-behavior assertion — the recorded request body carries the
	// cherry-picked endpoint text and does NOT carry the four noise turns, proving the cherry-pick
	// (not a full-history dump) is what actually reaches the wire.

	it(
		'injects only the searched-for message into the active workspace, and only it reaches the request the provider sends',
		async () => {
			const ENDPOINT = '/v2/sync'
			// B's five short turns — one relevant, four noise.
			const other = createConversation({ id: 'planning' })
			other.add([
				{ role: 'user', content: 'What time is the standup?' },
				{ role: 'assistant', content: 'Standup is at 9am.' },
				{ role: 'user', content: 'Where do we deploy?' },
				{ role: 'assistant', content: `the API endpoint is ${ENDPOINT}` },
				{ role: 'user', content: 'Thanks, talk later.' },
			])

			// CHERRY-PICK exactly the relevant turn (as the recommended flow does).
			const picked = other.search('endpoint')
			expect(picked).toHaveLength(1)
			const block = other.reference({ label: 'planning', summary: false, messages: picked })

			// DETERMINISTIC: the rendered reference carries ONLY the cherry-picked message — none of
			// the four noise turns leaked in (cherry-pick, not a full history dump).
			expect(block).toContain(ENDPOINT)
			expect(block).not.toContain('standup')
			expect(block).not.toContain('9am')
			expect(block).not.toContain('talk later')

			const proxy = await createRecordingProxy()
			try {
				const conversations = createConversationManager()
				const active = conversations.add({ id: 'auth' }) // auto-activates
				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const agent = createAgent(provider, {
					system: 'Use the reference documents when they answer the question. Be brief.',
					conversations,
					timeout: TIMEOUT,
				})
				agent.context.workspaces.add().write(`conversation:${other.id}.md`, block)
				active.add({
					role: 'user',
					content: "What's the API endpoint? Answer with just the path.",
				})
				await agent.generate().catch(() => {})

				const body = proxy.requests[0]?.body as
					| { messages?: readonly MessageInterface[] }
					| undefined
				const messages = body?.messages ?? []
				const joined = messages.map((message) => String(message.content)).join('\n')
				expect(joined).toContain(ENDPOINT)
				expect(joined).not.toContain('standup')
				expect(joined).not.toContain('9am')
				expect(joined).not.toContain('talk later')
			} finally {
				await proxy.close()
			}
		},
		TIMEOUT,
	)
})
