import type { Message, Section } from '@orkestrel/agent'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
	CONVERSATION_RECAP_PREFIX,
	createAgent,
	createConversation,
	createConversationManager,
} from '@orkestrel/agent'
import { createBudget } from '@orkestrel/budget'
import { createRecorder, retryUntil } from '@orkestrel/test'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createOllama } from '@src/core'
import {
	buildTurns,
	countRequestCharacters,
	createChallengeTools,
	createUserMessage,
	estimateRequestMessages,
} from '../setup.js'
import { createRecordingProxy, driveAgent, wireMessages } from '../setupServer.js'
import {
	createLiveSummarizer,
	OLLAMA_CONFIG,
	RETRY_BUDGET,
	seedConversation,
} from '../setupService.js'

const TIMEOUT = 60_000

describe('Agent (live) — compaction retains complete exchanges on the wire', () => {
	const summarize = createLiveSummarizer(TIMEOUT)

	it('sends a recap followed by the final seeded pair and the active request verbatim', async () => {
		const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
		try {
			const conversations = createConversationManager({ summarize, keep: 2 })
			const conversation = conversations.add()
			const turns = conversation.add(buildTurns(12))
			const provider = createOllama({
				model: OLLAMA_CONFIG.model,
				url: proxy.url,
				options: { num_predict: 32, temperature: 0 },
			})
			const agent = createAgent(provider, {
				conversations,
				window: createBudget({ max: 20, consumer: countRequestCharacters }),
				timeout: TIMEOUT,
			})
			const finalMessage = createUserMessage('Please continue.')
			agent.context.messages.add(finalMessage)
			const result = await agent.generate()
			expect(result.partial).toBe(false)
			const section = conversation.sections[0]
			expect(conversation.sections).toHaveLength(1)
			expect(section?.messages).toEqual(turns.slice(0, -2))
			expect(section?.summary.trim().length).toBeGreaterThan(0)
			const request = proxy.requests[0]
			const messages = request === undefined ? [] : wireMessages(request)
			expect(messages.filter((message) => message.role !== 'system')).toEqual([
				{ role: 'assistant', content: `${CONVERSATION_RECAP_PREFIX}${section?.summary}` },
				...turns.slice(-2).map(({ role, content }) => ({ role, content })),
				{ role: finalMessage.role, content: finalMessage.content },
			])
		} finally {
			await proxy.stop()
		}
	})
})

describe('Conversation (live) — manual compaction preserves the newest exchange', () => {
	const summarize = createLiveSummarizer(TIMEOUT)

	it(
		'folds the older pair into a live summary and retains the newest pair',
		async () => {
			const best = await retryUntil(
				'produce a nonempty recap while preserving the newest exchange',
				async () => {
					const conversation = createConversation({ summarize })
					seedConversation(conversation)
					const seeded = conversation.messages()
					const before = conversation.view().length
					const section = await conversation.compact()
					return {
						seeded,
						before,
						section,
						live: conversation.messages(),
						view: conversation.view(),
					}
				},
				(tried) => {
					try {
						expect(tried.section?.summary.trim().length).toBeGreaterThan(0)
						expect(tried.section?.messages).toEqual(tried.seeded.slice(0, 2))
						expect(tried.live).toEqual(tried.seeded.slice(2))
						expect(tried.view.map(({ role, content }) => ({ role, content }))).toEqual([
							{
								role: 'assistant',
								content: `${CONVERSATION_RECAP_PREFIX}${tried.section?.summary}`,
							},
							...tried.seeded.slice(2).map(({ role, content }) => ({ role, content })),
						])
						expect(tried.view.length).toBeLessThan(tried.before)
						return true
					} catch {
						return false
					}
				},
				{ attempts: 3, budget: RETRY_BUDGET },
			)
			expect(best.view).toHaveLength(3)
		},
		TIMEOUT,
	)
})

describe('Agent (live) — automatic compaction folds an older exchange mid-run', () => {
	const summarize = createLiveSummarizer(TIMEOUT)
	const SENTINEL = '8254'

	it(
		'folds after the lookup response and continues with the active exchange intact',
		async () => {
			const best = await retryUntil(
				'fold the older pair after lookup_code and finish with its code',
				async () => {
					const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
					try {
						const conversations = createConversationManager({ summarize, keep: 3 })
						const conversation = conversations.add()
						const seeded = conversation.add(buildTurns(2))
						const folds = createRecorder<[Section, number, readonly Message[]]>()
						conversation.emitter.on('compact', (section) => {
							folds.handler(section, proxy.requests.length, conversation.messages())
						})
						const tools = createToolManager()
						tools.add(
							createTool({
								name: 'lookup_code',
								description: 'Look up the secret access code. Takes no arguments.',
								parameters: { type: 'object', properties: {} },
								execute: () => ({ code: SENTINEL }),
							}),
						)
						const agent = createAgent(
							createOllama({
								model: OLLAMA_CONFIG.model,
								url: proxy.url,
								options: { num_predict: 32, temperature: 0 },
							}),
							{
								system:
									'You MUST call the lookup_code tool to obtain the secret access code, then state the code in your final reply. Never invent a code.',
								tools,
								conversations,
								window: createBudget({ max: 48, consumer: estimateRequestMessages }),
								timeout: TIMEOUT,
								limit: 4,
							},
						)
						const user = agent.context.messages.add({
							role: 'user',
							content:
								'What is the secret access code? You MUST call the lookup_code tool, then tell me the code.',
						})
						const driven = await driveAgent(agent.stream())
						return {
							seeded,
							user,
							folds: folds.calls.map(([section, requests, live]) => ({ section, requests, live })),
							sections: conversation.sections,
							requests: proxy.requests.map((request) =>
								wireMessages(request).filter((message) => message.role !== 'system'),
							),
							tools: driven.tools,
							result: driven.result,
						}
					} finally {
						await proxy.stop()
					}
				},
				(tried) => {
					try {
						expect(tried.sections).toHaveLength(1)
						expect(tried.sections[0]?.messages).toEqual(tried.seeded)
						expect(tried.sections[0]?.summary.trim().length).toBeGreaterThan(0)
						expect(tried.folds.map((fold) => fold.requests)).toEqual([1])
						expect(tried.folds[0]?.section).toEqual(tried.sections[0])
						expect(tried.tools).toHaveLength(1)
						const tool = tried.tools[0]
						if (tool === undefined) return false
						expect(tool.call.name).toBe('lookup_code')
						expect(tool.call.arguments).toEqual({})
						expect(tool.result).toEqual({
							success: true,
							id: tool.call.id,
							name: 'lookup_code',
							value: { code: SENTINEL },
						})
						const live = tried.folds[0]?.live ?? []
						expect(live).toEqual([
							tried.user,
							{
								id: expect.any(String),
								role: 'assistant',
								content: expect.any(String),
								calls: [tool.call],
							},
							{
								id: expect.any(String),
								role: 'tool',
								content: JSON.stringify({ code: SENTINEL }),
								call: tool.call.id,
							},
						])
						expect(tried.requests).toEqual([
							[
								...tried.seeded.map(({ role, content }) => ({ role, content })),
								{ role: 'user', content: tried.user.content },
							],
							[
								{
									role: 'assistant',
									content: `${CONVERSATION_RECAP_PREFIX}${tried.sections[0]?.summary}`,
								},
								{ role: 'user', content: tried.user.content },
								{
									role: 'assistant',
									content: live[1]?.content,
									tool_calls: [{ function: { name: 'lookup_code', arguments: {} } }],
								},
								{ role: 'tool', content: JSON.stringify({ code: SENTINEL }) },
							],
						])
						expect(tried.result.partial).toBe(false)
						expect(tried.result.content).toContain(SENTINEL)
						return true
					} catch {
						return false
					}
				},
				{ attempts: 3, budget: RETRY_BUDGET },
			)
			expect(best.result.partial).toBe(false)
			expect(best.result.content).toContain(SENTINEL)
		},
		TIMEOUT,
	)
})

describe('Agent (live) — dependent lookups cause repeated mid-run compaction', () => {
	const summarize = createLiveSummarizer(TIMEOUT)
	const SENTINEL = '7193'

	it(
		'folds each older pair after sequential tool responses and finishes with the secret',
		async () => {
			const best = await retryUntil(
				'fold both older pairs between dependent calls and finish with the secret code',
				async () => {
					const proxy = await createRecordingProxy(OLLAMA_CONFIG.host)
					try {
						const conversations = createConversationManager({ summarize, keep: 5 })
						const conversation = conversations.add()
						const seeded = conversation.add(buildTurns(4))
						const challenge = 'r7k2'
						const folds = createRecorder<[Section, number, readonly Message[]]>()
						conversation.emitter.on('compact', (section) => {
							folds.handler(section, proxy.requests.length, conversation.messages())
						})
						const tools = createToolManager()
						tools.add(createChallengeTools(challenge, SENTINEL))
						const agent = createAgent(
							createOllama({
								model: OLLAMA_CONFIG.model,
								url: proxy.url,
								options: { num_predict: 32, temperature: 0 },
							}),
							{
								system:
									'You MUST first call lookup_challenge. Wait for its result, then call lookup_secret with the returned challenge. State the secret code in your final reply. Never invent a challenge or code.',
								tools,
								conversations,
								window: createBudget({ max: 40, consumer: estimateRequestMessages }),
								timeout: TIMEOUT,
								limit: 8,
							},
						)
						const user = agent.context.messages.add({
							role: 'user',
							content:
								'What is the secret access code? Call lookup_challenge first, then use its returned challenge with lookup_secret, then tell me the code.',
						})
						const driven = await driveAgent(agent.stream())
						return {
							seeded,
							user,
							challenge,
							usages: driven.usages,
							folds: folds.calls.map(([section, requests, live]) => ({ section, requests, live })),
							sections: conversation.sections,
							requests: proxy.requests.map((request) =>
								wireMessages(request).filter((message) => message.role !== 'system'),
							),
							tools: driven.tools,
							result: driven.result,
						}
					} finally {
						await proxy.stop()
					}
				},
				(tried) => {
					try {
						expect(tried.sections).toHaveLength(2)
						expect(tried.sections.map((section) => section.messages)).toEqual([
							tried.seeded.slice(0, 2),
							tried.seeded.slice(2),
						])
						for (const section of tried.sections)
							expect(section.summary.trim().length).toBeGreaterThan(0)
						expect(tried.folds.map((fold) => fold.requests)).toEqual([1, 2])
						expect(tried.folds.map((fold) => fold.section)).toEqual(tried.sections)
						expect(tried.tools).toHaveLength(2)
						const [lookup, secret] = tried.tools
						if (lookup === undefined || secret === undefined) return false
						expect(lookup.call.name).toBe('lookup_challenge')
						expect(lookup.call.arguments).toEqual({})
						expect(lookup.result).toEqual({
							success: true,
							id: lookup.call.id,
							name: 'lookup_challenge',
							value: { challenge: tried.challenge },
						})
						expect(secret.call.name).toBe('lookup_secret')
						expect(secret.call.arguments).toEqual({ challenge: tried.challenge })
						expect(secret.result).toEqual({
							success: true,
							id: secret.call.id,
							name: 'lookup_secret',
							value: { code: SENTINEL },
						})
						const first = tried.folds[0]?.live ?? []
						const second = tried.folds[1]?.live ?? []
						expect(first).toEqual([
							...tried.seeded.slice(2),
							tried.user,
							{
								id: expect.any(String),
								role: 'assistant',
								content: expect.any(String),
								calls: [lookup.call],
							},
							{
								id: expect.any(String),
								role: 'tool',
								content: JSON.stringify({ challenge: tried.challenge }),
								call: lookup.call.id,
							},
						])
						expect(second).toEqual([
							...first.slice(2),
							{
								id: expect.any(String),
								role: 'assistant',
								content: expect.any(String),
								calls: [secret.call],
							},
							{
								id: expect.any(String),
								role: 'tool',
								content: JSON.stringify({ code: SENTINEL }),
								call: secret.call.id,
							},
						])
						const active = [
							{ role: 'user', content: tried.user.content },
							{
								role: 'assistant',
								content: first[3]?.content,
								tool_calls: [{ function: { name: 'lookup_challenge', arguments: {} } }],
							},
							{ role: 'tool', content: JSON.stringify({ challenge: tried.challenge }) },
						]
						const recaps = tried.sections.map((section) => ({
							role: 'assistant',
							content: `${CONVERSATION_RECAP_PREFIX}${section.summary}`,
						}))
						expect(tried.requests).toEqual([
							[
								...tried.seeded.map(({ role, content }) => ({ role, content })),
								{ role: 'user', content: tried.user.content },
							],
							[
								...recaps.slice(0, 1),
								...tried.seeded.slice(2).map(({ role, content }) => ({ role, content })),
								...active,
							],
							[
								...recaps,
								...active,
								{
									role: 'assistant',
									content: second[3]?.content,
									tool_calls: [
										{
											function: {
												name: 'lookup_secret',
												arguments: { challenge: tried.challenge },
											},
										},
									],
								},
								{ role: 'tool', content: JSON.stringify({ code: SENTINEL }) },
							],
						])
						expect(tried.result.partial).toBe(false)
						expect(tried.result.content).toContain(SENTINEL)
						return true
					} catch (error) {
						console.error(
							inspect(
								{ error, tried },
								{ depth: null, maxArrayLength: null, maxStringLength: null },
							),
						)
						return false
					}
				},
				{ attempts: 3, budget: RETRY_BUDGET },
			)
			expect(best.sections).toHaveLength(2)
			expect(best.result.partial).toBe(false)
			expect(best.result.content).toContain(SENTINEL)
		},
		TIMEOUT,
	)
})
