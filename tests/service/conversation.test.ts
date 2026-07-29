import { describe, expect, it } from 'vitest'
import { CONVERSATION_RECAP_PREFIX, createAgent, createConversationManager } from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'
import { createOllama } from '@src/server'
import { buildTurns, createRecorder, createThrowingSummarizer } from '../setup.js'
import { systemText, wireMessages } from '../setupServer.js'
import {
	createLiveProvider,
	createLiveSummarizer,
	createRecordingProxy,
	OLLAMA_CONFIG,
	retryUntil,
} from '../setupService.js'

const TIMEOUT = 60_000
const HEAVY_TIMEOUT = 120_000

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
