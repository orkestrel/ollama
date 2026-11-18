import { describe, expect, it } from 'vitest'
import { createAgent, createConversationManager } from '@orkestrel/agent'
import { retryUntil } from '@orkestrel/test'
import { createOllama } from '@src/core'
import { buildTurns, CASE_TIMEOUT, HEAVY_TIMEOUT, toMessageInputs } from '../setup.js'
import { createRecordingProxy, systemText } from '../setupServer.js'
import { OLLAMA_CONFIG, RETRY_BUDGET } from '../setupService.js'

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
						conversation.add(toMessageInputs(buildTurns(30)))
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
