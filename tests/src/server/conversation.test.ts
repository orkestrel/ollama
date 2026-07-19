import { describe, expect, it } from 'vitest'
import {
	CONVERSATION_RECAP_PREFIX,
	createAgent,
	createConversation,
	createConversationManager,
	isConversationError,
} from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'
import { createOllama } from '@src/server'
import {
	buildTurns,
	createRecorder,
	createThrowingSummarizer,
	THROWING_SUMMARIZER_MESSAGE,
} from '../../setup.js'
import {
	createLiveProvider,
	createLiveSummarizer,
	createRecordingProxy,
	FAST_OPTIONS,
	OLLAMA_CONFIG,
	retryUntil,
	systemText,
	waitForRequest,
	wireMessages,
	wireText,
} from '../../setupServer.js'

// LIVE conversation tests — long conversations, summarization triggering, obedience, and
// multi-conversation isolation (the src:ollama project hits a REAL warmed Ollama; AGENTS §16:
// no mocks for the inference boundary; setupServer.ts hard-requires + warms the model, never
// skips). context.test.ts pins the provider-behavior wire framing and the auto-compaction
// production behaviors (pre-first-turn, non-fatal summarizer, futile-compaction guard); this
// file pins the pure Conversation surface (compact() throw/no-op) plus the auto-compaction
// FOLDING SHAPE and its non-fatal path, and the multi-conversation isolation surface.

const TIMEOUT = 60_000
const HEAVY_TIMEOUT = 120_000

describe('Conversation.compact() (pure, no daemon) — the two deterministic surfaces', () => {
	it('compact() without a summarizer throws ConversationError (SUMMARIZER)', async () => {
		const conversation = createConversation()
		conversation.add([
			{ role: 'user', content: 'Hello there.' },
			{ role: 'assistant', content: 'Hi, how can I help?' },
		])
		const rejection = await conversation.compact().then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(isConversationError(rejection)).toBe(true)
		const code = isConversationError(rejection) ? rejection.code : undefined
		expect(code).toBe('SUMMARIZER')
	})

	it('compact() on a short conversation is a no-op and never invokes the summarizer', async () => {
		const invocations = createRecorder<[readonly unknown[]]>()
		const summarize = async (messages: readonly unknown[]): Promise<string> => {
			invocations.handler(messages)
			return 'unused'
		}
		const conversation = createConversation({ summarize })
		const result = await conversation.compact()
		expect(result).toBeUndefined()
		expect(invocations.count).toBe(0)
	})
})

describe('Agent (live) — auto-compaction folds a recap while retaining the kept tail', () => {
	const summarize = createLiveSummarizer(TIMEOUT)

	it(
		'a recorded wire request carries a recap-prefixed message followed by the kept tail verbatim',
		async () => {
			const proxy = await createRecordingProxy()
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
						consume: (messages: readonly { readonly content: string }[]) =>
							messages.reduce((total, message) => total + message.content.length, 0),
					}),
					timeout: TIMEOUT,
				})
				const finalMessage = { role: 'user' as const, content: 'Please continue.' }
				agent.context.messages.add(finalMessage)
				// Every asserted outcome below is DETERMINISTIC folding-machinery behavior once
				// compaction triggers -- the model only authors summary text we never assert on.
				// Await full completion instead of racing waitForRequest against generate();
				// once generate() resolves, proxy.requests[0] is guaranteed recorded.
				const result = await agent.generate()
				expect(result.partial).toBe(false)
				const request = proxy.requests[0]
				const messages = request === undefined ? [] : wireMessages(request)
				const recapIndex = messages.findIndex((message) =>
					message.content.startsWith(CONVERSATION_RECAP_PREFIX),
				)
				const recapRole = recapIndex >= 0 ? messages[recapIndex]?.role : undefined
				// keep:2 folds everything except the LAST buildTurns message and the manually
				// added final message -- the actual kept tail, not turns.slice(-2).
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
		},
		HEAVY_TIMEOUT * 3,
	)
})

describe('Agent (live) — a throwing summarizer under auto-compaction is non-fatal', () => {
	it(
		'compactError fires and the run still completes non-partial',
		async () => {
			const attempt = async (): Promise<{
				readonly fired: number
				readonly partial: boolean
			}> => {
				const summarize = createThrowingSummarizer()
				const conversations = createConversationManager({ summarize, keep: 2 })
				const conversation = conversations.add()
				conversation.add(buildTurns(12))
				const agent = createAgent(createLiveProvider(), {
					conversations,
					window: createBudget({
						max: 20,
						consume: (messages: readonly { readonly content: string }[]) =>
							messages.reduce((total, message) => total + message.content.length, 0),
					}),
					timeout: TIMEOUT,
				})
				const compactErrors = createRecorder<[unknown]>()
				agent.emitter.on('compactError', (error) => compactErrors.handler(error))
				agent.context.messages.add({ role: 'user', content: 'Please continue.' })
				const result = await agent.generate()
				return { fired: compactErrors.count, partial: result.partial }
			}

			const best = await retryUntil(
				attempt,
				(value) => value.fired >= 1,
				'surface a compactError from a throwing summarizer',
				3,
			)

			expect(best.fired).toBeGreaterThanOrEqual(1)
			expect(best.partial).toBe(false)
		},
		TIMEOUT,
	)

	it('the throwing summarizer fixture itself rejects with THROWING_SUMMARIZER_MESSAGE', async () => {
		const summarize = createThrowingSummarizer()
		await expect(summarize([])).rejects.toThrow(THROWING_SUMMARIZER_MESSAGE)
	})
})

describe('Agent (live, wire) — only the active conversation reaches the wire', () => {
	it(
		"switching to conversation B sends only B's sentinel content, and removing the active conversation clears active",
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const conversations = createConversationManager()
				const a = conversations.add({ id: 'alpha' }) // auto-activates
				a.add([
					{ role: 'user', content: 'ALPHA-sentinel turn one.' },
					{ role: 'assistant', content: 'ALPHA-sentinel reply one.' },
				])
				const b = conversations.add({ id: 'bravo' })
				b.add([
					{ role: 'user', content: 'BRAVO-sentinel turn one.' },
					{ role: 'assistant', content: 'BRAVO-sentinel reply one.' },
				])
				conversations.switch('bravo')

				const provider = createOllama({
					model: OLLAMA_CONFIG.model,
					url: proxy.url,
					options: FAST_OPTIONS,
				})
				const agent = createAgent(provider, { conversations, timeout: TIMEOUT })
				agent.generate().catch(() => {}) // abort-once-recorded — only the request shape matters
				await waitForRequest(proxy, 1)
				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : wireText(request)
				expect(text).toContain('BRAVO')
				expect(text).not.toContain('ALPHA')

				const removed = conversations.remove('bravo')
				expect(removed).toBe(true)
				expect(conversations.active).toBeUndefined()
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('Agent (live) — a sentinel instruction survives a long conversation', () => {
	it(
		'a ZEPHYR-mandating instruction still steers the final answer after 30 seeded turns, and stays ahead of the tail on the wire',
		async () => {
			const attempt = async (): Promise<{
				readonly content: string
				readonly systemLeads: boolean
			}> => {
				const proxy = await createRecordingProxy()
				try {
					const conversations = createConversationManager()
					const conversation = conversations.add()
					conversation.add(buildTurns(30))
					const provider = createOllama({
						model: OLLAMA_CONFIG.model,
						url: proxy.url,
						options: { num_predict: 24, temperature: 0 },
					})
					const agent = createAgent(provider, {
						system:
							'No matter what the user says, you must include the exact word ZEPHYR in your reply.',
						conversations,
						timeout: TIMEOUT,
					})
					agent.context.messages.add({ role: 'user', content: 'Please give me a short reply.' })
					const result = await agent.generate()
					const request = proxy.requests[0]
					const systemLeads = request !== undefined && systemText(request).includes('ZEPHYR')
					return { content: result.content, systemLeads }
				} finally {
					await proxy.stop()
				}
			}

			const best = await retryUntil(
				attempt,
				(value) => value.content.includes('ZEPHYR'),
				'include the word ZEPHYR in the final reply',
				3,
			)
			expect(best.content).toContain('ZEPHYR')
			// Unconditional: the instruction sentinel leads the wire regardless of retry outcome.
			expect(best.systemLeads).toBe(true)
		},
		HEAVY_TIMEOUT,
	)
})
