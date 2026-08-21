import type { AgentResult, ConversationInterface } from '@orkestrel/agent'
import type { DrivenTool } from '../setupServer.js'
import { describe, expect, it } from 'vitest'
import {
	CONVERSATION_RECAP_PREFIX,
	createAgent,
	createConversation,
	createConversationManager,
	estimateMessages,
} from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'
import { collect, retryUntil } from '@orkestrel/test'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createOllama } from '@src/server'
import { buildTurns, createUserMessage } from '../setup.js'
import { createRecordingProxy, driveAgent, wireMessages } from '../setupServer.js'
import {
	createLiveOllama,
	createLiveSummarizer,
	OLLAMA_CONFIG,
	RETRY_BUDGET,
} from '../setupService.js'

const TIMEOUT = 60_000

describe('Agent (live) — auto-compaction folds a recap while retaining the kept tail', () => {
	const summarize = createLiveSummarizer(TIMEOUT)

	it('a recorded wire request carries a recap-prefixed message followed by the kept tail verbatim', async () => {
		const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
		try {
			const conversations = createConversationManager({ summarize, keep: 2 })
			const conversation = conversations.add()
			const turns = buildTurns(12)
			conversation.add(turns)
			const provider = createOllama({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				options: { num_predict: 32, temperature: 0 },
			})
			const agent = createAgent(provider, {
				conversations,
				window: createBudget({
					max: 20,
					consume: (messages: ReadonlyArray<{ readonly content: string }>) =>
						messages.reduce((total, message) => total + message.content.length, 0),
				}),
				timeout: TIMEOUT,
			})
			const finalMessage = createUserMessage('Please continue.')
			agent.context.messages.add(finalMessage)
			// Once generation completes, the first proxy request is guaranteed to have been captured.
			const result = await agent.generate()
			expect(result.partial).toBe(false)
			const request = proxy.requests[0]
			const messages = request === undefined ? [] : wireMessages(request)
			const recapIndex = messages.findIndex((message) =>
				message.content.startsWith(CONVERSATION_RECAP_PREFIX),
			)
			const recapRole = recapIndex >= 0 ? messages[recapIndex]?.role : undefined
			const keptTail = [turns[turns.length - 1], finalMessage]
			const tailIndices = keptTail.map((turn) =>
				messages.findIndex((message) => turn !== undefined && message.content === turn.content),
			)
			const followingCount = messages.filter(
				(message, index) => index > recapIndex && message.role !== 'system',
			).length

			expect(recapIndex).toBeGreaterThanOrEqual(0)
			expect(recapRole).toBe('assistant')
			for (const index of tailIndices) {
				expect(index).toBeGreaterThan(recapIndex)
			}
			expect(followingCount).toBe(2)
		} finally {
			await proxy.stop()
		}
	})
})

describe('Conversation (live) — compaction summarizes via the REAL model', () => {
	// A REAL ConversationSummarizer built from the live provider — the provider-agnostic seam the
	// conversation layer drives. Recipe retuned: num_predict 256→64 (a one-sentence digest fits
	// comfortably; keeps wall-time bounded per directive #7). This proves compaction works end-to-
	// end against a genuine model (AGENTS §16 — no mocks for the inference boundary; no skipIf).
	// Assertion strategy: STRUCTURAL only (non-empty summaries, view() shrinks to 1) — never
	// exact prose.
	// The instruction rides as the FINAL user turn AFTER the folded messages — a reasoning chat
	// model emits nothing when the prompt ends on an assistant turn (a leading-system instruction
	// leaves the template thinking the turn is already answered), so the trailing user turn is
	// what reliably elicits the digest. (Documented as the recommended summarizer shape.)
	const summarize = createLiveSummarizer(TIMEOUT)

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
			const { conversation, before } = await retryUntil(
				'produce a non-empty compaction section summary',
				async () => {
					const attempt = createConversation({ summarize })
					seed(attempt)
					const attemptBefore = attempt.view().length
					const section = await attempt.compact()
					return { conversation: attempt, before: attemptBefore, section }
				},
				(value) => value.section !== undefined && value.section.summary.trim().length > 0,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

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

	const summarize = createLiveSummarizer(TIMEOUT)

	// A no-args lookup tool returning a sentinel the model cannot derive on its own — so a final
	// answer carrying it proves the multi-turn round-trip survived compaction (the model called the
	// tool, the loop compacted the tail BETWEEN turns, then the model produced a final turn USING
	// the fed-back result THROUGH the compacted view).
	const SENTINEL = '8254'

	const attemptRun = async (): Promise<{
		readonly conversation: ConversationInterface
		readonly result: AgentResult
		readonly tools: readonly DrivenTool[]
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
		const agent = createAgent(createLiveOllama(), {
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
		const { tools: driven, result } = await driveAgent(stream)
		return { conversation, result, tools: driven }
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
			const best = await retryUntil(
				'auto-compact mid-run and produce a valid final answer through the compacted view',
				attemptRun,
				(tried) => compacted(tried) && tried.result.content.trim().length > 0,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			// (a) AUTOMATIC compaction fired mid-run — at least one section, authored by the live
			// model (a non-empty summary), now exists on the injected conversation.
			expect(best.conversation.sections.length).toBeGreaterThan(0)
			expect((best.conversation.sections[0]?.summary ?? '').trim().length).toBeGreaterThan(0)
			// (b) The run produced a VALID final answer THROUGH the compacted view — non-empty and
			// not partial — proving the loop continued correctly on the compacted context.
			expect(best.result.content.trim().length).toBeGreaterThan(0)
			expect(best.result.partial).toBe(false)
			// (c) The emitted `tool` chunk(s) from the SAME run carry [call, result] shape — the
			// call names the registered tool, and its result is defined (never dropped) — proving
			// the tool-chunk payload the agent stream emits, not just the eventual final answer.
			expect(best.tools.length).toBeGreaterThan(0)
			for (const driven of best.tools) {
				expect(driven.call.name).toBe('lookup_code')
				expect(driven.result).toBeDefined()
			}
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
	const summarize = createLiveSummarizer(TIMEOUT)

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
		const agent = createAgent(createLiveOllama(), {
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
			const best = await retryUntil(
				'fold >= 2 sections and produce a valid, non-partial final answer through the repeatedly-compacted view',
				attemptMulti,
				(tried) =>
					multiCompacted(tried) && tried.result.content.trim().length > 0 && !tried.result.partial,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

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
