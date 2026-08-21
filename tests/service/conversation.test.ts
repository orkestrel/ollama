import { describe, expect, it } from 'vitest'
import { createAgent, createConversationManager } from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'
import { createRecorder, retryUntil } from '@orkestrel/test'
import { createOllama } from '@src/server'
import { buildTurns, createThrowingSummarizer } from '../setup.js'
import { createRecordingProxy, systemText } from '../setupServer.js'
import { createLiveOllama, OLLAMA_CONFIG, RETRY_BUDGET } from '../setupService.js'

const TIMEOUT = 60_000
const HEAVY_TIMEOUT = 120_000

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
				const agent = createAgent(createLiveOllama(), {
					conversations,
					window: createBudget({
						max: 20,
						consume: (messages: ReadonlyArray<{ readonly content: string }>) =>
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
				'surface a compactError from a throwing summarizer',
				attempt,
				(value) => value.fired >= 1,
				{ attempts: 3, budget: RETRY_BUDGET },
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
				const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
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
				'include the word ZEPHYR in the final reply',
				attempt,
				(value) => value.content.includes('ZEPHYR'),
				{ attempts: 3, budget: RETRY_BUDGET },
			)
			expect(best.content).toContain('ZEPHYR')
			// Unconditional: the instruction sentinel leads the wire regardless of retry outcome.
			expect(best.systemLeads).toBe(true)
		},
		HEAVY_TIMEOUT,
	)
})
