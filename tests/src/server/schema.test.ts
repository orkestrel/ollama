import { createAgent } from '@orkestrel/agent'
import { describe, expect, it } from 'vitest'
import { createLiveProvider, retryUntil } from '../../setupServer.js'

// Agent-level structured output (live) — AgentRunOptions.schema (0.0.6) forwards a
// JSON-Schema shape to the provider's `stream` as ProviderStreamOptions.schema, a
// per-run structured-output constraint (AGENTS §16: no mocks for the inference
// boundary). Daemon-probe-proven: schema { city: string, population: number } at
// num_predict 64, temperature 0 yields exactly-shaped compact JSON. Warmed, no
// skipIf.

const TIMEOUT = 60_000

describe('Agent (live) — run({ schema }) constrains output to the requested JSON shape', () => {
	it(
		'a { city, population } schema yields content that parses to an object with a string city and numeric population, resolving non-partial',
		async () => {
			const attempt = async (): Promise<{
				readonly content: string
				readonly partial: boolean
			}> => {
				const provider = createLiveProvider({ predict: 64, temperature: 0 })
				const agent = createAgent(provider, { timeout: TIMEOUT })
				agent.context.messages.add({ role: 'user', content: 'Give me a city and its population.' })
				const result = await agent.generate({
					schema: {
						type: 'object',
						properties: { city: { type: 'string' }, population: { type: 'number' } },
						required: ['city', 'population'],
					},
				})
				return { content: result.content, partial: result.partial }
			}

			const { content, partial } = await retryUntil(
				attempt,
				(value) => {
					try {
						const parsed: unknown = JSON.parse(value.content)
						return typeof parsed === 'object' && parsed !== null
					} catch {
						return false
					}
				},
				'produce content that parses as JSON under a schema constraint',
				3,
			)

			const parsed: unknown = JSON.parse(content)
			expect(typeof parsed).toBe('object')
			if (typeof parsed !== 'object' || parsed === null)
				throw new Error('parsed value not an object')
			const record = parsed as Record<string, unknown>
			expect(typeof record.city).toBe('string')
			expect(typeof record.population).toBe('number')
			expect(partial).toBe(false)
		},
		TIMEOUT,
	)
})
