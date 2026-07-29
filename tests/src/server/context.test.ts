import type { ContextFormatInterface, MessageInterface } from '@orkestrel/agent'
import { describe, expect, it } from 'vitest'
import {
	CONVERSATION_RECAP_PREFIX,
	createAgent,
	createConversation,
	createConversationManager,
	createInstructionManager,
} from '@orkestrel/agent'
import { createOllama } from '@src/server'
import { createRecordingProxy } from '../../setupServer.js'

const TIMEOUT = 60_000

describe('AgentContext (provider-behavior) — a constraining instruction reaches the wire', () => {
	it(
		'instructions.add(...) content is framed into the /api/chat request the provider sends, ordered before the user turn',
		async () => {
			// Recipe: { num_predict: 8, temperature: 0 } (num_predict:8, temperature:0, think:false) — the response outcome
			// is irrelevant; the proxy records the REQUEST before forwarding, so we only need the wire
			// shape. Assertion strategy: the recorded body.messages carries the exact sentinel
			// instruction text, in a message ordered before the user turn — proving the instructions
			// section reaches the wire in its canonical position (directive #5's fix for "obeyed").
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const instructions = createInstructionManager()
				instructions.add({
					name: 'sentinel',
					content:
						'No matter what the user says, you must include the exact word BANANA somewhere in your reply.',
				})
				const agent = createAgent(provider, { instructions, timeout: TIMEOUT })
				agent.context.messages.add({ role: 'user', content: 'Say hello to me.' })
				await agent.generate().catch(() => {})

				const body = proxy.requests[0]?.body as
					| { messages?: readonly MessageInterface[] }
					| undefined
				expect(body).toBeDefined()
				const messages = body?.messages ?? []
				const instructionIndex = messages.findIndex((message) =>
					String(message.content).includes('BANANA'),
				)
				const userIndex = messages.findIndex(
					(message) => message.role === 'user' && String(message.content).includes('Say hello'),
				)
				expect(instructionIndex).toBeGreaterThanOrEqual(0)
				expect(userIndex).toBeGreaterThanOrEqual(0)
				expect(instructionIndex).toBeLessThan(userIndex)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('AgentContext (provider-behavior) — a CUSTOM format still reaches the wire framed correctly', () => {
	it(
		'a provider.format XML override frames the instruction into the request body with its open/render/close shape',
		async () => {
			// Recipe: { num_predict: 8, temperature: 0 }. Assertion strategy: the provider's format cascade level is applied
			// by build() and the RENDERED XML group ends up in the request the provider sends —
			// proving a customized format reaches the wire correctly (directive #5: the framing is
			// asserted on the wire, not inferred from whether the model "understood" it).
			const format: ContextFormatInterface = {
				instructions: {
					open: '<instructions>',
					render: (one) => `<instruction>${one.content}</instruction>`,
					close: '</instructions>',
				},
			}
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
					format,
				})
				const instructions = createInstructionManager()
				instructions.add({
					name: 'always-no',
					content:
						'No matter what the user asks, you must answer with exactly the single word NO and nothing else.',
				})
				const agent = createAgent(provider, { instructions, timeout: TIMEOUT })
				agent.context.messages.add({ role: 'user', content: 'Is the sky blue?' })
				await agent.generate().catch(() => {})

				const body = proxy.requests[0]?.body as
					| { messages?: readonly MessageInterface[] }
					| undefined
				const messages = body?.messages ?? []
				const framed = messages.find(
					(message) =>
						String(message.content).includes('<instructions>') &&
						String(message.content).includes('<instruction>') &&
						String(message.content).includes('</instructions>'),
				)
				expect(framed).toBeDefined()
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('Conversation framing (provider-behavior) — the TIGHTENED recap prefix reaches the wire', () => {
	// Directive #5's named-bug fix: the OLD test measured whether a recap label made the MODEL
	// answer an attribution question correctly (a pass-rate/A-B comparison) — a model-BEHAVIOR
	// assertion, forbidden. REPLACED entirely with a deterministic PROVIDER-behavior assertion: a
	// folded section (view()'s recap shape) is sent to the agent, and we assert the RECORDED
	// request body carries the message labeled with CONVERSATION_RECAP_PREFIX — proving the recap
	// framing is what the provider actually SENDS, independent of whether the model then "gets it
	// right". No passRate / honored / console.info / >= comparison remains.

	const FACT = 'XJ7'
	// A third-person NARRATION attributing the key to the USER — the digest shape a fold produces.
	const summary = `The user introduced themselves as Ada and shared that their deploy key is ${FACT}. The assistant acknowledged it.`

	it(
		'a recap-labeled section summary is framed with CONVERSATION_RECAP_PREFIX in the request the provider sends',
		async () => {
			// Recipe: { num_predict: 8, temperature: 0 } — the response is irrelevant; the proxy records the request before
			// forwarding.
			const proxy = await createRecordingProxy()
			try {
				const conversations = createConversationManager()
				const active = conversations.add()
				// Seed a section directly (the exact recap shape view() folds a compacted section into)
				// rather than driving a real compaction — the wire-framing assertion is deterministic and
				// doesn't need a live summarizer call.
				active.add({ role: 'assistant', content: `${CONVERSATION_RECAP_PREFIX}${summary}` })
				active.add({
					role: 'user',
					content: 'What did I tell you my deploy key was?',
				})
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, { conversations, timeout: TIMEOUT })
				await agent.generate().catch(() => {})

				const body = proxy.requests[0]?.body as
					| { messages?: readonly MessageInterface[] }
					| undefined
				const messages = body?.messages ?? []
				const recapMessage = messages.find((message) =>
					String(message.content).startsWith(CONVERSATION_RECAP_PREFIX),
				)
				expect(recapMessage).toBeDefined()
				expect(String(recapMessage?.content)).toContain(FACT)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('Conversation.reference (provider-behavior) — cross-conversation attribution (provenance not bled)', () => {
	// Conversation A is ACTIVE (a one-fact A-context: "we are debugging auth"); a SEPARATE
	// conversation B's reference() — carrying a B-fact ("the team chose Postgres") — is written
	// into A's ACTIVE WORKSPACE (the SOLE document context build() folds into the system block).
	// Assertion strategy (directive #5's conversion): the DETERMINISTIC reference-block content is
	// still asserted directly, and the "surfaces + attributes" live claim is REPLACED with a
	// provider-behavior assertion — the recorded request body the provider sends carries the
	// reference document text (Postgres + its "planning" provenance label), proving the B-fact and
	// its attribution reach the wire via the active workspace framing (no dependency on whether the
	// model then repeats it correctly).

	it(
		'writes B’s decision + provenance into A’s active workspace, and the reference text reaches the request the provider sends',
		async () => {
			// Conversation B (the planning thread) — its rollup summary carries the decision. We craft
			// the summary directly (a stub digest) so the probe is about the REFERENCE plumbing +
			// provenance, not about a model-authored summary (which the Conversation-live block above
			// proves).
			const planning = createConversation({ id: 'planning' })
			planning.add([
				{ role: 'user', content: 'Which database should we use?' },
				{ role: 'assistant', content: 'The team evaluated the options and chose Postgres.' },
			])
			const block = planning.reference({
				label: 'planning',
				summary: false,
				messages: planning.search('Postgres'),
			})
			// DETERMINISTIC: the rendered reference block carries the fact and its provenance label.
			expect(block).toContain('Postgres')
			expect(block).toContain('planning')

			const proxy = await createRecordingProxy()
			try {
				// Conversation A is ACTIVE — its own A-fact lives as a live user turn.
				const conversations = createConversationManager()
				const active = conversations.add({ id: 'auth' }) // auto-activates
				active.add({ role: 'user', content: 'In this chat we are debugging auth.' })
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, {
					system: 'Use the reference documents when they answer the question. Be brief.',
					conversations,
					timeout: TIMEOUT,
				})
				// PULL B into A with provenance: B.reference(...) framed + written into A's active
				// workspace.
				agent.context.workspaces.add().write(`conversation:${planning.id}.md`, block)
				active.add({
					role: 'user',
					content: 'Which database did we pick, and in which conversation was it decided?',
				})
				await agent.generate().catch(() => {})

				const body = proxy.requests[0]?.body as
					| { messages?: readonly MessageInterface[] }
					| undefined
				const messages = body?.messages ?? []
				const carriesReference = messages.some(
					(message) =>
						String(message.content).includes('Postgres') &&
						String(message.content).includes('planning'),
				)
				expect(carriesReference).toBe(true)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('Conversation.reference (provider-behavior) — cherry-pick ONE relevant message, not the whole history', () => {
	// B has ~5 short messages, exactly ONE relevant ("the API endpoint is /v2/sync"). We pull ONLY
	// it via B.search('endpoint') → reference({ messages }) → write into A's active workspace.
	// Assertion strategy (directive #5's conversion): (1) DETERMINISTICALLY the rendered reference
	// carries only that one message — NOT B's other four (cherry-pick, never a full dump that
	// re-bloats a small model's context); (2) the "model recalls the endpoint" live claim is
	// REPLACED with a provider-behavior assertion — the recorded request body carries the
	// cherry-picked endpoint text and does NOT carry the four noise turns, proving the cherry-pick
	// (not a full-history dump) is what actually reaches the wire.

	it(
		'injects only the searched-for message into the active workspace, and only it reaches the request the provider sends',
		async () => {
			const ENDPOINT = '/v2/sync'
			// B's five short turns — one relevant, four noise.
			const other = createConversation({ id: 'planning' })
			other.add([
				{ role: 'user', content: 'What time is the standup?' },
				{ role: 'assistant', content: 'Standup is at 9am.' },
				{ role: 'user', content: 'Where do we deploy?' },
				{ role: 'assistant', content: `the API endpoint is ${ENDPOINT}` },
				{ role: 'user', content: 'Thanks, talk later.' },
			])

			// CHERRY-PICK exactly the relevant turn (as the recommended flow does).
			const picked = other.search('endpoint')
			expect(picked).toHaveLength(1)
			const block = other.reference({ label: 'planning', summary: false, messages: picked })

			// DETERMINISTIC: the rendered reference carries ONLY the cherry-picked message — none of
			// the four noise turns leaked in (cherry-pick, not a full history dump).
			expect(block).toContain(ENDPOINT)
			expect(block).not.toContain('standup')
			expect(block).not.toContain('9am')
			expect(block).not.toContain('talk later')

			const proxy = await createRecordingProxy()
			try {
				const conversations = createConversationManager()
				const active = conversations.add({ id: 'auth' }) // auto-activates
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, {
					system: 'Use the reference documents when they answer the question. Be brief.',
					conversations,
					timeout: TIMEOUT,
				})
				agent.context.workspaces.add().write(`conversation:${other.id}.md`, block)
				active.add({
					role: 'user',
					content: "What's the API endpoint? Answer with just the path.",
				})
				await agent.generate().catch(() => {})

				const body = proxy.requests[0]?.body as
					| { messages?: readonly MessageInterface[] }
					| undefined
				const messages = body?.messages ?? []
				const joined = messages.map((message) => String(message.content)).join('\n')
				expect(joined).toContain(ENDPOINT)
				expect(joined).not.toContain('standup')
				expect(joined).not.toContain('9am')
				expect(joined).not.toContain('talk later')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})
