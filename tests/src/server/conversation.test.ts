import { describe, expect, it } from 'vitest'
import {
	createAgent,
	createConversation,
	createConversationManager,
	isConversationError,
} from '@orkestrel/agent'
import { createOllama } from '@src/server'
import {
	createRecorder,
	createThrowingSummarizer,
	THROWING_SUMMARIZER_MESSAGE,
} from '../../setup.js'
import { createRecordingProxy, waitForRequest, wireText } from '../../setupServer.js'

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

describe('createThrowingSummarizer', () => {
	it('the throwing summarizer fixture itself rejects with THROWING_SUMMARIZER_MESSAGE', async () => {
		const summarize = createThrowingSummarizer()
		await expect(summarize([])).rejects.toThrow(THROWING_SUMMARIZER_MESSAGE)
	})
})

describe('Agent (wire) — only the active conversation reaches the wire', () => {
	it("switching to conversation B sends only B's sentinel content, and removing the active conversation clears active", async () => {
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
				model: 'test-model',
				url: proxy.url,
				options: { num_predict: 8, temperature: 0 },
			})
			const agent = createAgent(provider, { conversations, timeout: 60_000 })
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
	}, 60_000)
})
