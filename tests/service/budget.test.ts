import { describe, expect, it } from 'vitest'
import { createAgent } from '@orkestrel/agent'
import { createTokenBudget, isBudgetError } from '@orkestrel/budget'
import { createNDJSONParser } from '@orkestrel/ndjson'
import { createRecorder, retryUntil } from '@orkestrel/test'
import { createToolManager } from '@orkestrel/tool'
import { OLLAMA_CHAT_PATH, OllamaProvider } from '@src/core'
import {
	CASE_TIMEOUT,
	createUserMessage,
	LONG_ANSWER_PROMPT,
	SHORT_ANSWER_PROMPT,
} from '../setup.js'
import { createLookupTool, driveAgent } from '../setupServer.js'
import {
	createLiveOllama,
	FAST_OPTIONS,
	OLLAMA_CONFIG,
	RETRY_BUDGET,
	TOOL_LOOP_OPTIONS,
} from '../setupService.js'

// budget.test.ts — LIVE agent-layer usage accounting + budget enforcement +
// sequential-reuse, with no mocks for the inference boundary. OllamaProvider.test.ts
// already pins the PROVIDER-level usage invariants (prompt + completion === total on a single
// provider.generate() call); this file probes the AGENT layer: how createAgent's loop
// aggregates provider-level usage into AgentResult.usage / usage chunks, how an exhausted
// token budget (@orkestrel/budget's createTokenBudget) trips the loop, and whether one agent
// instance survives repeated sequential generate() calls against the resident (keep-alive)
// model. Assertions are invariants only (sums, monotonicity, resolution semantics, partial
// flags) — never exact token counts or prose.

describe('Agent usage (live) — single-turn usage coherence at the agent layer', () => {
	it(
		'the single usage chunk reconciles with result.usage, and prompt + completion === total',
		async () => {
			// Recipe: FAST_OPTIONS (num_predict:8) — one provider turn, one usage chunk.
			const agent = createAgent(createLiveOllama({ predict: FAST_OPTIONS.num_predict }), {
				timeout: CASE_TIMEOUT,
			})
			agent.context.messages.add({ role: 'user', content: 'Say hello.' })

			const { usages, result } = await driveAgent(agent.stream())

			// Exactly one provider call happened (no tools ⇒ no loop), so exactly one usage chunk.
			expect(usages.length).toBe(1)
			const chunkUsage = usages[0]
			expect(chunkUsage).toBeDefined()
			expect(result.usage).toBeDefined()
			if (chunkUsage === undefined || result.usage === undefined) throw new Error('usage missing')
			// AgentResult.usage is the SUMMED usage across the turn's provider calls — with exactly
			// one call, that sum equals the single chunk's usage.
			expect(result.usage.total).toBe(chunkUsage.total)
			expect(result.usage.prompt).toBe(chunkUsage.prompt)
			expect(result.usage.completion).toBe(chunkUsage.completion)
			// Provider-level invariant re-verified at the agent layer.
			expect(result.usage.prompt).toBeGreaterThan(0)
			expect(result.usage.completion).toBeGreaterThan(0)
			expect(result.usage.prompt + result.usage.completion).toBe(result.usage.total)
		},
		CASE_TIMEOUT,
	)
})

describe('Agent budget (live) — an exhausted token budget trips the loop', () => {
	it(
		'the run resolves (never rejects) with partial: true, a BudgetError abort reason, and a budget-layer stop once the reported usage exhausts the budget',
		async () => {
			// A forced multi-turn run (the lookup tool + a steering system prompt, mirroring
			// context.test.ts's forcing technique) paired with a token budget whose ceiling (5
			// completion tokens) is tiny relative to a single real completion — the first
			// provider call alone exceeds it, so the budget's signal is guaranteed exhausted
			// before the loop can make its second (post-tool) provider call. With no `allowance`
			// the budget is charged the usage the call reports, so the trip is the budget layer's.
			// Bounded retry over the small model's tool-use nondeterminism: an attempt whose single
			// call ended at its own `num_predict` limit is a model-layer stop instead, so we retry
			// until an attempt genuinely observed the budget layer.
			const tripped = await retryUntil(
				'trip the exhausted token budget mid-run',
				async () => {
					const reasons = createRecorder<[reason: unknown]>()
					const budget = createTokenBudget({ id: 'tokens', max: 5, scope: 'completion' })
					const tools = createToolManager()
					tools.add(createLookupTool())
					const agent = createAgent(createLiveOllama({ predict: TOOL_LOOP_OPTIONS.num_predict }), {
						system:
							'You MUST call the lookup tool with query "test" to obtain the reference datum, ' +
							'then state it in your final reply. Never invent a value.',
						tools,
						budget,
						limit: 4,
						timeout: CASE_TIMEOUT,
						on: { abort: reasons.handler },
					})
					agent.context.messages.add({ role: 'user', content: 'Look up the reference datum.' })
					const result = await agent.generate()
					return {
						partial: result.partial,
						budgeted: reasons.calls.filter(([reason]) => isBudgetError(reason)).length,
						stop: result.stop,
					}
				},
				(value) => value.partial === true && value.budgeted > 0 && value.stop?.layer === 'budget',
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			expect(tripped.partial).toBe(true)
			expect(tripped.budgeted).toBeGreaterThan(0)
			expect(tripped.stop).toMatchObject({ layer: 'budget', id: 'tokens', max: 5 })
		},
		CASE_TIMEOUT,
	)
})

describe('Agent budget (live) — an exhausted token budget trips MID-GENERATION', () => {
	it(
		'a separate tighter allowance stops at the meter while the cost budget and model retain headroom',
		async () => {
			const reasons = createRecorder<[reason: unknown]>()
			const budget = createTokenBudget({ id: 'budget', max: 10_000, scope: 'completion' })
			const allowance = createTokenBudget({ id: 'meter', max: 5, scope: 'completion' })
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: OLLAMA_CONFIG.host,
				options: { num_predict: 512, temperature: 0 },
			})
			const agent = createAgent(provider, {
				budget,
				allowance,
				timeout: CASE_TIMEOUT,
				on: { abort: reasons.handler },
			})
			agent.context.messages.add({ role: 'user', content: LONG_ANSWER_PROMPT })

			const { tokens, result } = await driveAgent(agent.stream())
			const stop = result.stop

			expect(result.partial).toBe(true)
			expect(stop?.layer).toBe('meter')
			if (stop?.layer !== 'meter') throw new Error('expected a meter-layer stop')
			expect(stop).toMatchObject({
				id: allowance.id,
				max: allowance.max,
				consumed: allowance.consumed,
				estimate: Math.ceil(tokens.join('').length / 4),
			})
			expect(stop.consumed).toBeGreaterThanOrEqual(stop.max)
			expect(stop.estimate).toBe(allowance.consumed)
			expect(allowance.exhausted).toBe(true)
			expect(allowance.signal.aborted).toBe(true)
			expect(reasons.calls).toEqual([[allowance.signal.reason]])
			const reason: unknown = allowance.signal.reason
			expect(isBudgetError(reason)).toBe(true)
			if (!isBudgetError(reason)) throw new Error('expected the allowance exhaustion reason')
			expect(reason.context).toEqual({
				id: stop.id,
				max: stop.max,
				consumed: stop.consumed,
			})
			expect(stop.usage).toEqual(result.usage)
			expect(budget.consumed).toBe(result.usage?.completion ?? stop.estimate)
			expect(budget.consumed).toBeLessThan(budget.max)
			expect(budget.exhausted).toBe(false)
			expect(budget.signal.aborted).toBe(false)
			// An interrupted Ollama stream has no terminal usage report; it never reached the model cap.
			expect(result.usage).toBeUndefined()
			expect(result.content.length).toBeGreaterThan(0)
			expect(result.content.length).toBeLessThan(1000)
		},
		CASE_TIMEOUT,
	)

	it(
		'a tiny completion-token allowance aborts mid-stream (no tool loop needed) with partial: true, a BudgetError abort reason, a meter-layer stop, and content bounded by the budget arithmetic',
		async () => {
			// Content deltas are charged to the `allowance` incrementally as estimated tokens
			// (ceil(chars/4)) during a turn, and passing the budget itself as the allowance makes
			// that estimate share the budget's ceiling — a budget with no `allowance` is charged the
			// reported usage only and cannot trip mid-stream. Recipe: max: 5 completion tokens (tiny
			// relative to a real completion), NO tools, a prompt inviting a long answer,
			// num_predict: 512 (headroom so the daemon would otherwise keep generating well past
			// the budget), temperature: 0.
			// Content-bound arithmetic: the estimator charges ceil(chars/4) per delta, so the budget
			// (5 tokens) trips once ~20 chars have streamed; one more in-flight delta may land before
			// the abort signal is observed. Even a generous few-hundred-char slack keeps this WELL
			// under the ~2000 chars a full 512-token completion would produce — 1000 is an honest,
			// non-brittle upper bound that still proves the trip happened mid-stream, not at natural
			// completion.
			const tripped = await retryUntil(
				'trip the token budget mid-generation (no tool loop)',
				async () => {
					const reasons = createRecorder<[reason: unknown]>()
					const budget = createTokenBudget({ id: 'tokens', max: 5, scope: 'completion' })
					const agent = createAgent(createLiveOllama({ predict: 512, temperature: 0 }), {
						budget,
						allowance: budget,
						timeout: CASE_TIMEOUT,
						on: { abort: reasons.handler },
					})
					agent.context.messages.add({ role: 'user', content: LONG_ANSWER_PROMPT })
					const { result } = await driveAgent(agent.stream())
					return {
						partial: result.partial,
						budgeted: reasons.calls.filter(([reason]) => isBudgetError(reason)).length,
						stop: result.stop,
						length: result.content.length,
					}
				},
				(value) => value.partial === true && value.budgeted > 0 && value.stop?.layer === 'meter',
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			expect(tripped.partial).toBe(true)
			expect(tripped.budgeted).toBeGreaterThan(0)
			expect(tripped.stop).toMatchObject({ layer: 'meter', id: 'tokens', max: 5 })
			expect(tripped.length).toBeLessThan(1000)
		},
		CASE_TIMEOUT,
	)
})

describe('Agent model layer (live) — the model ends an answer at its own token limit', () => {
	it(
		'loose token bounds let the model stop first and preserve the estimate beside reported usage',
		async () => {
			const reasons = createRecorder<[reason: unknown]>()
			const budget = createTokenBudget({ id: 'budget', max: 10_000, scope: 'completion' })
			const allowance = createTokenBudget({ id: 'meter', max: 10_000, scope: 'completion' })
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: OLLAMA_CONFIG.host,
				options: FAST_OPTIONS,
			})
			const agent = createAgent(provider, {
				budget,
				allowance,
				timeout: CASE_TIMEOUT,
				on: { abort: reasons.handler },
			})
			agent.context.messages.add({ role: 'user', content: LONG_ANSWER_PROMPT })

			const { tokens, usages, result } = await driveAgent(agent.stream())
			const stop = result.stop
			const usage = result.usage

			expect(result.partial).toBe(false)
			expect(stop?.layer).toBe('model')
			if (stop?.layer !== 'model' || usage === undefined)
				throw new Error('expected a model-layer stop with reported usage')
			expect(stop).toEqual({
				layer: 'model',
				id: provider.id,
				estimate: Math.ceil(tokens.join('').length / 4),
				usage,
			})
			expect(stop.estimate).toBeGreaterThan(0)
			expect(usages).toEqual([usage])
			expect(usage.prompt).toBeGreaterThan(0)
			expect(usage.completion).toBe(FAST_OPTIONS.num_predict)
			expect(usage.total).toBe(usage.prompt + usage.completion)
			expect(budget.consumed).toBe(usage.completion)
			expect(allowance.consumed).toBe(stop.estimate)
			expect(budget.consumed).toBeLessThan(budget.max)
			expect(allowance.consumed).toBeLessThan(allowance.max)
			expect(budget.exhausted).toBe(false)
			expect(allowance.exhausted).toBe(false)
			expect(budget.signal.aborted).toBe(false)
			expect(allowance.signal.aborted).toBe(false)
			expect(reasons.calls).toEqual([])
		},
		CASE_TIMEOUT,
	)

	it(
		'a small num_predict cap ends the daemon answer with done_reason length on the terminal record',
		async () => {
			// The request body is the exact one the provider sends, so the daemon's terminal
			// record is the record `read` projects.
			const provider = createLiveOllama({ predict: FAST_OPTIONS.num_predict, temperature: 0 })
			const body = provider.encode({ messages: [createUserMessage(LONG_ANSWER_PROMPT)] })
			const response = await fetch(`${OLLAMA_CONFIG.host}${OLLAMA_CHAT_PATH}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(CASE_TIMEOUT),
			})
			expect(response.ok).toBe(true)

			const records = createNDJSONParser().parse(await response.text())
			const terminal = records.find((record) => Reflect.get(record, 'done') === true)

			expect(terminal).toMatchObject({ done: true, done_reason: 'length' })
		},
		CASE_TIMEOUT,
	)

	it(
		'provider.generate at a small num_predict cap reports result.truncated',
		async () => {
			const provider = createLiveOllama({ predict: FAST_OPTIONS.num_predict, temperature: 0 })

			const result = await provider.generate(
				[createUserMessage(LONG_ANSWER_PROMPT)],
				AbortSignal.timeout(CASE_TIMEOUT),
			)

			expect(result.truncated).toBe(true)
		},
		CASE_TIMEOUT,
	)

	it(
		'an agent run ending at a small num_predict cap settles non-partial with a model-layer stop naming the provider',
		async () => {
			const provider = createLiveOllama({ predict: FAST_OPTIONS.num_predict, temperature: 0 })
			const agent = createAgent(provider, { timeout: CASE_TIMEOUT })
			agent.context.messages.add({ role: 'user', content: LONG_ANSWER_PROMPT })

			const result = await agent.generate()

			expect(result.partial).toBe(false)
			expect(result.stop).toMatchObject({ layer: 'model', id: provider.id })
		},
		CASE_TIMEOUT,
	)

	it(
		'an unconstrained short answer reports no truncation and no stop',
		async () => {
			const provider = createLiveOllama({ predict: 256, temperature: 0 })

			const generated = await provider.generate(
				[createUserMessage(SHORT_ANSWER_PROMPT)],
				AbortSignal.timeout(CASE_TIMEOUT),
			)
			const agent = createAgent(provider, { timeout: CASE_TIMEOUT })
			agent.context.messages.add({ role: 'user', content: SHORT_ANSWER_PROMPT })
			const result = await agent.generate()

			expect(generated).not.toHaveProperty('truncated')
			expect(result.partial).toBe(false)
			expect(result).not.toHaveProperty('stop')
		},
		CASE_TIMEOUT,
	)

	it(
		'an oversized prompt is silently truncated by default without a provider truncation flag or agent stop',
		async () => {
			const messages = [
				createUserMessage('Background material. '.repeat(1024)),
				{ id: 'acknowledged', role: 'assistant', content: 'Acknowledged.' } as const,
				createUserMessage(SHORT_ANSWER_PROMPT),
			]
			const control = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: OLLAMA_CONFIG.host,
				options: { num_ctx: 8192, num_predict: 256, temperature: 0 },
			})
			const provider = new OllamaProvider({
				model: OLLAMA_CONFIG.model,
				url: OLLAMA_CONFIG.host,
				options: { num_ctx: 512, num_predict: 256, temperature: 0 },
			})
			expect(provider.encode({ messages })).not.toHaveProperty('truncate')
			const full = await control.generate(messages, AbortSignal.timeout(CASE_TIMEOUT))
			const generated = await provider.generate(messages, AbortSignal.timeout(CASE_TIMEOUT))
			const complete = full.usage
			const truncated = generated.usage
			if (complete === undefined || truncated === undefined)
				throw new Error('expected prompt usage for both context windows')
			// The larger window measures the same prompt in daemon tokens, independent of a local estimate.
			expect(complete.prompt).toBeGreaterThan(512)
			expect(complete.prompt).toBeLessThan(8192)
			expect(truncated.prompt).toBeGreaterThan(0)
			expect(truncated.prompt).toBeLessThanOrEqual(512)
			expect(truncated.prompt).toBeLessThan(complete.prompt)
			expect(generated.content.length).toBeGreaterThan(0)
			expect(generated).not.toHaveProperty('truncated')

			const reasons = createRecorder<[reason: unknown]>()
			const agent = createAgent(provider, {
				timeout: CASE_TIMEOUT,
				on: { abort: reasons.handler },
			})
			agent.context.messages.add(messages)
			const result = await agent.generate()

			expect(result.usage?.prompt).toBeGreaterThan(0)
			expect(result.usage?.prompt).toBeLessThanOrEqual(512)
			expect(result.content.length).toBeGreaterThan(0)
			expect(result.partial).toBe(false)
			expect(result).not.toHaveProperty('stop')
			expect(reasons.calls).toEqual([])
		},
		CASE_TIMEOUT,
	)
})

describe('Agent usage (live) — multi-turn usage accumulates across provider calls', () => {
	it(
		'a ≥2-turn tool-loop run reports result.usage.total at least as large as each individual chunk',
		async () => {
			// Forced multi-turn run: the lookup tool + a steering system prompt, TOOL_LOOP_OPTIONS
			// (num_predict:64) — a tool-call turn followed by an answer turn yields ≥2 provider
			// calls, hence ≥2 usage chunks. Bounded retry (attempts=3) over the small model's
			// tool-use nondeterminism wraps the "≥2 turns happened" condition.
			const attempt = await retryUntil(
				'produce a ≥2-turn tool-call loop with ≥2 usage chunks',
				async () => {
					const tools = createToolManager()
					tools.add(createLookupTool())
					const agent = createAgent(createLiveOllama({ predict: TOOL_LOOP_OPTIONS.num_predict }), {
						system:
							'You MUST call the lookup tool with query "test" to obtain the reference datum, ' +
							'then state it in your final reply. Never invent a value.',
						tools,
						limit: 4,
						timeout: CASE_TIMEOUT,
					})
					agent.context.messages.add({ role: 'user', content: 'Look up the reference datum.' })
					const { usages, result } = await driveAgent(agent.stream())
					return { usages, result }
				},
				(value) => value.usages.length >= 2,
				{ attempts: 3, budget: RETRY_BUDGET },
			)

			expect(attempt.usages.length).toBeGreaterThanOrEqual(2)
			expect(attempt.result.usage).toBeDefined()
			const total = attempt.result.usage
			if (total === undefined) throw new Error('usage missing')

			// The documented contract (AgentResult TSDoc): "usage summed across the turn's provider
			// calls" — verify the SUM matches, not a monotonic bound alone, because the source
			// explicitly commits to accumulation (not last-turn-wins).
			for (const usage of attempt.usages) {
				// Monotonic bound: the final summed total is at least each individual chunk's total.
				expect(total.total).toBeGreaterThanOrEqual(usage.total)
			}
			expect(total.prompt).toBe(attempt.usages.reduce((sum, usage) => sum + usage.prompt, 0))
			expect(total.completion).toBe(
				attempt.usages.reduce((sum, usage) => sum + usage.completion, 0),
			)
			expect(total.total).toBe(attempt.usages.reduce((sum, usage) => sum + usage.total, 0))
		},
		CASE_TIMEOUT,
	)
})

describe('Agent reuse (live) — sequential generate() calls on ONE agent stay independent', () => {
	it(
		'three sequential generate() calls on the same agent all resolve non-partial with non-empty content',
		async () => {
			// ONE agent, three sequential generate() calls (resident-model keep-alive + no
			// cross-run state bleed at the agent layer). Distinct tiny prompts, FAST_OPTIONS.
			const agent = createAgent(createLiveOllama({ predict: FAST_OPTIONS.num_predict }), {
				timeout: CASE_TIMEOUT,
			})

			const prompts = ['Say hello.', 'Say goodbye.', 'Say thanks.']
			for (const prompt of prompts) {
				agent.context.messages.add({ role: 'user', content: prompt })
				const result = await agent.generate()
				expect(result.partial).toBe(false)
				expect(result.content.trim().length).toBeGreaterThan(0)
			}
		},
		CASE_TIMEOUT,
	)
})
