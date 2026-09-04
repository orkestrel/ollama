import { createAgent } from '@orkestrel/agent'
import { isRecord } from '@orkestrel/contract'
import { retryUntil } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
import { createLiveOllama, RETRY_BUDGET } from '../setupService.js'

// Agent-level structured output (live) — AgentRunOptions.schema (0.0.6) forwards a
// JSON-Schema shape to the provider's `stream` as ProviderStreamOptions.schema, a
// per-run structured-output constraint: no mocks for the inference boundary.
// Daemon-probe-proven: schema { city: string, population: number } at
// num_predict 64, temperature 0 yields exactly-shaped compact JSON. Warmed, no
// skipIf.

const TIMEOUT = 60_000

describe('Agent (live) — run({ schema }) constrains output to the requested JSON shape', () => {
	it(
		'a { city, population } schema yields content that parses to an object with a string city and numeric population, resolving non-partial',
		async () => {
			const { content, partial } = await retryUntil(
				'produce content that parses as JSON under a schema constraint',
				async () => {
					const provider = createLiveOllama({ predict: 64, temperature: 0 })
					const agent = createAgent(provider, { timeout: TIMEOUT })
					agent.context.messages.add({
						role: 'user',
						content: 'Give me a city and its population.',
					})
					const result = await agent.generate({
						schema: {
							type: 'object',
							properties: { city: { type: 'string' }, population: { type: 'number' } },
							required: ['city', 'population'],
						},
					})
					return { content: result.content, partial: result.partial }
				},
				(value) => {
					try {
						const parsed: unknown = JSON.parse(value.content)
						return typeof parsed === 'object' && parsed !== null
					} catch {
						return false
					}
				},
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			const parsed: unknown = JSON.parse(content)
			if (!isRecord(parsed)) throw new Error('parsed value not an object')
			expect(typeof parsed.city).toBe('string')
			expect(typeof parsed.population).toBe('number')
			expect(partial).toBe(false)
		},
		TIMEOUT,
	)
})
