import type { RecordedRequest } from '../setupServer.js'
import {
	createAgent,
	createConversationManager,
	createInstructionManager,
	createScope,
} from '@orkestrel/agent'
import { createOllama } from '@src/server'
import { describe, expect, it } from 'vitest'
import { createRecordingProxy, systemText } from '../setupServer.js'
import { OLLAMA_CONFIG, retryUntil, TOOL_OPTIONS } from '../setupService.js'

const TIMEOUT = 60_000

describe('AgentContext scope (live, behavioral) — switching scopes changes the answer', () => {
	// The user's core proof: two mutually-exclusive instructions, each mandating a distinct
	// sentinel word in the reply. Scope A allows only the apricot instruction, scope B only
	// the cobalt one — a full round-trip through the proxy, retried (bounded, 3 attempts)
	// over the small model's nondeterminism, since whether the model OBEYS an instruction is
	// genuinely model-behavior-dependent.
	const APRICOT = {
		name: 'apricot-rule',
		content: 'Begin every reply with the single word APRICOT, no matter what the user asks.',
	}
	const COBALT = {
		name: 'cobalt-rule',
		content: 'Begin every reply with the single word COBALT, no matter what the user asks.',
	}

	interface Attempt {
		readonly contentA: string
		readonly requestA: RecordedRequest | undefined
		readonly contentB: string
		readonly requestB: RecordedRequest | undefined
	}

	const attempt = async (): Promise<Attempt> => {
		const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
		try {
			const provider = createOllama({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				options: TOOL_OPTIONS,
			})
			const conversations = createConversationManager()
			conversations.add({ id: 'run-a' }) // auto-activates
			const instructions = createInstructionManager()
			instructions.add(APRICOT)
			instructions.add(COBALT)
			const scope = createScope({ name: 'apricot-scope', instructions: ['apricot-rule'] })
			const agent = createAgent(provider, { conversations, instructions, scope, timeout: TIMEOUT })
			agent.context.messages.add({ role: 'user', content: 'Reply with one short sentence.' })

			const resultA = await agent.generate()
			const requestA = proxy.requests[proxy.requests.length - 1]

			// A fresh conversation on the SAME agent prevents run A's (possibly truncated)
			// assistant reply from staying in context and being continued mid-sentence by
			// run B — the two runs must be independent turns, not a continued dialogue.
			conversations.add({ id: 'run-b' })
			conversations.switch('run-b')
			agent.context.apply(createScope({ name: 'cobalt-scope', instructions: ['cobalt-rule'] }))
			agent.context.messages.add({ role: 'user', content: 'Reply with one short sentence.' })
			const resultB = await agent.generate()
			const requestB = proxy.requests[proxy.requests.length - 1]

			return { contentA: resultA.content, requestA, contentB: resultB.content, requestB }
		} finally {
			await proxy.stop()
		}
	}

	it(
		'switching scopes changes the answer',
		async () => {
			const best = await retryUntil(
				attempt,
				(value) =>
					value.contentA.toLowerCase().includes('apricot') &&
					value.contentB.toLowerCase().includes('cobalt'),
				'answer APRICOT under the apricot scope and COBALT under the cobalt scope',
				3,
			)

			expect(best.contentA.toLowerCase()).toContain('apricot')
			expect(best.requestA).toBeDefined()
			const textA = best.requestA === undefined ? '' : systemText(best.requestA)
			expect(textA).not.toContain(COBALT.content)

			expect(best.contentB.toLowerCase()).toContain('cobalt')
			expect(best.requestB).toBeDefined()
			const textB = best.requestB === undefined ? '' : systemText(best.requestB)
			expect(textB).not.toContain(APRICOT.content)
		},
		TIMEOUT,
	)
})
