import { describe, expect, it } from 'vitest'
import { createAgent, createConversationManager } from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'
import { isError } from '@orkestrel/contract'
import { createRecorder, retryUntil } from '@orkestrel/test'
import { createOllama } from '@src/core'
import {
	buildTurns,
	CASE_TIMEOUT,
	countRequestCharacters,
	createThrowingSummarizer,
	HEAVY_TIMEOUT,
	THROWING_SUMMARIZER_MESSAGE,
} from '../setup.js'
import { createRecordingProxy, systemText } from '../setupServer.js'
import { createLiveOllama, OLLAMA_CONFIG, RETRY_BUDGET } from '../setupService.js'

describe('Agent (live) — a throwing summarizer under auto-compaction is non-fatal', () => {
	it(
		'fault fires and the run still completes non-partial',
		async () => {
			const best = await retryUntil(
				'surface a fault from a throwing summarizer',
				async () => {
					const summarize = createThrowingSummarizer()
					const conversations = createConversationManager({ summarize, keep: 2 })
					const conversation = conversations.add()
					conversation.add(buildTurns(12))
					const agent = createAgent(createLiveOllama(), {
						conversations,
						window: createBudget({ max: 20, consumer: countRequestCharacters }),
						timeout: CASE_TIMEOUT,
					})
					const faults = createRecorder<[unknown]>()
					agent.emitter.on('fault', (error) => faults.handler(error))
					agent.context.messages.add({ role: 'user', content: 'Please continue.' })
					const result = await agent.generate()
					return { faults: faults.calls, partial: result.partial }
				},
				// The predicate is the assertion below: an attempt that emits a second fault, or one that
				// is not the summarizer's own, is retried rather than accepted and then failed.
				(value) =>
					value.partial === false &&
					value.faults.length === 1 &&
					value.faults.every(
						([fault]) => isError(fault) && fault.message === THROWING_SUMMARIZER_MESSAGE,
					),
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			// The summarizer's own failure is what the agent reported.
			expect(best.faults).toEqual([[new Error(THROWING_SUMMARIZER_MESSAGE)]])
			expect(best.partial).toBe(false)
		},
		CASE_TIMEOUT,
	)
})

describe('Agent (live) — a sentinel instruction survives a long conversation', () => {
	it(
		'a ZEPHYR-mandating instruction still steers the final answer after 30 seeded turns, and stays ahead of the tail on the wire',
		async () => {
			const best = await retryUntil(
				'include the word ZEPHYR in the final reply',
				async () => {
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
							timeout: CASE_TIMEOUT,
						})
						agent.context.messages.add({ role: 'user', content: 'Please give me a short reply.' })
						const result = await agent.generate()
						const request = proxy.requests[0]
						const systemLeads = request !== undefined && systemText(request).includes('ZEPHYR')
						return { content: result.content, systemLeads }
					} finally {
						await proxy.stop()
					}
				},
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
