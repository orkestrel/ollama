// The src/server integration scope: the published provider driven from outside by the
// real `@orkestrel/agent` consumer. Every runtime proof here is hermetic — a recording
// proxy captures the exact `/api/chat` request body before a deliberately unreachable
// forward fails — so the whole file passes with the daemon down. The module tests for the
// provider and its factory stay in `OllamaProvider.test.ts` and `factories.test.ts`, and
// the compile-time contract this package shares with the official `ollama` client is the
// `conformance` project in `tests/conformance.test.ts`; this file proves what a real
// consumer's context assembly puts on the wire.

import type { ContextFormat, Message } from '@orkestrel/agent'
import {
	CONVERSATION_RECAP_PREFIX,
	createAgent,
	createConversation,
	createConversationManager,
	createInstructionManager,
	createScope,
	isConversationError,
} from '@orkestrel/agent'
import { createRecorder } from '@orkestrel/test'
import { createToolManager } from '@orkestrel/tool'
import { createBinaryContent, createFile } from '@orkestrel/workspace'
import { createOllama } from '@src/server'
import { describe, expect, it } from 'vitest'
import {
	createRecordingSummarizer,
	createThrowingSummarizer,
	createUserMessage,
	fillWorkspace,
	THROWING_SUMMARIZER_MESSAGE,
} from '../../setup.js'
import {
	createInsatiableTool,
	createLookupTool,
	createRecordingProxy,
	systemText,
	waitForRequest,
	wireMessages,
	wireText,
	wireTools,
} from '../../setupServer.js'

const TIMEOUT = 60_000

// A tiny 1x1 transparent PNG, base64-encoded — a hardcoded binary fixture: a small
// deterministic binary payload inline rather than a generated one.
const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

// --- Context framing on the wire ---------------------------------------------

describe('AgentContext (provider-behavior) — a constraining instruction reaches the wire', () => {
	it(
		'instructions.add(...) content is framed into the /api/chat request the provider sends, ordered before the user turn',
		async () => {
			// Recipe: { num_predict: 8, temperature: 0 } (num_predict:8, temperature:0, think:false) — the response outcome
			// is irrelevant; the proxy records the REQUEST before forwarding, so we only need the wire
			// shape. Assertion strategy: the recorded body.messages carries the exact sentinel
			// instruction text, in a message ordered before the user turn — proving the instructions
			// section reaches the wire in its canonical position.
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

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const messages = request === undefined ? [] : wireMessages(request)
				const instructionIndex = messages.findIndex((message) => message.content.includes('BANANA'))
				const userIndex = messages.findIndex(
					(message) => message.role === 'user' && message.content.includes('Say hello'),
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
			// proving a customized format reaches the wire correctly (the framing is
			// asserted on the wire, not inferred from whether the model "understood" it).
			const format: ContextFormat = {
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

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const messages = request === undefined ? [] : wireMessages(request)
				const framed = messages.find(
					(message) =>
						message.content.includes('<instructions>') &&
						message.content.includes('<instruction>') &&
						message.content.includes('</instructions>'),
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
				// doesn't need a summarizer call.
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

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const messages = request === undefined ? [] : wireMessages(request)
				const recapMessage = messages.find((message) =>
					message.content.startsWith(CONVERSATION_RECAP_PREFIX),
				)
				expect(recapMessage).toBeDefined()
				expect(recapMessage?.content).toContain(FACT)
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
	// Assertion strategy: the DETERMINISTIC reference-block content is
	// still asserted directly, and the "surfaces + attributes" model-output claim is replaced with a
	// provider-behavior assertion — the recorded request body the provider sends carries the
	// reference document text (Postgres + its "planning" provenance label), proving the B-fact and
	// its attribution reach the wire via the active workspace framing (no dependency on whether the
	// model then repeats it correctly).

	it(
		'writes B’s decision + provenance into A’s active workspace, and the reference text reaches the request the provider sends',
		async () => {
			// Conversation B (the planning thread) — its rollup summary carries the decision. We craft
			// the summary directly (a stub digest) so the probe is about the REFERENCE plumbing +
			// provenance, not about a model-authored summary.
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
				// Conversation A is active — its own A-fact remains a current user turn.
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

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : wireText(request)
				expect(text).toContain('Postgres')
				expect(text).toContain('planning')
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
	// Assertion strategy: (1) DETERMINISTICALLY the rendered reference
	// carries only that one message — NOT B's other four (cherry-pick, never a full dump that
	// re-bloats a small model's context); (2) the "model recalls the endpoint" output claim is
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

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const joined = request === undefined ? '' : wireText(request)
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

// --- Canonical context-assembly order on the wire -----------------------------

// Hermetic context-assembly order tests use a deliberately unreachable upstream.
// `AgentContext.build()` emits one
// leading system message joining [system prompt, '## Instructions' (descending priority,
// stable ties), '## Workspace' (active workspace text files)], then the conversation as
// subsequent messages. The recording proxy captures the exact request body before the
// unreachable forward fails, so the suite passes with the daemon down.

describe('AgentContext (hermetic provider behavior) — canonical assembly order on the wire', () => {
	it(
		'the context assembles system, instructions, workspace, then conversation',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const instructions = createInstructionManager()
				instructions.add({ name: 'one', content: 'Be terse.' })
				instructions.add({ name: 'two', content: 'Be polite.' })
				const agent = createAgent(provider, {
					system: 'SENTINEL-SYSTEM-PROMPT-7182',
					instructions,
					timeout: TIMEOUT,
				})
				agent.context.workspaces.add().write('notes.md', 'workspace filler text')
				agent.context.messages.add({ role: 'user', content: 'What is the weather?' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : systemText(request)
				const systemIndex = text.indexOf('SENTINEL-SYSTEM-PROMPT-7182')
				const instructionsIndex = text.indexOf('## Instructions')
				const workspaceIndex = text.indexOf('## Workspace')
				expect(systemIndex).toBeGreaterThanOrEqual(0)
				expect(instructionsIndex).toBeGreaterThan(systemIndex)
				expect(workspaceIndex).toBeGreaterThan(instructionsIndex)

				const messages = request === undefined ? [] : wireMessages(request)
				const userIndex = messages.findIndex(
					(message) => message.role === 'user' && message.content.includes('What is the weather?'),
				)
				expect(userIndex).toBeGreaterThan(0)
				const [first] = messages
				expect(first?.content.includes('What is the weather?')).toBe(false)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)

	it(
		'instructions render in descending priority with stable ties',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const instructions = createInstructionManager()
				instructions.add({
					name: 'first-p5',
					content: 'SENTINEL-FIRST-P5',
					priority: 5,
				})
				instructions.add({
					name: 'second-p5',
					content: 'SENTINEL-SECOND-P5',
					priority: 5,
				})
				instructions.add({
					name: 'third-p1',
					content: 'SENTINEL-THIRD-P1',
					priority: 1,
				})
				const agent = createAgent(provider, { instructions, timeout: TIMEOUT })
				agent.context.messages.add({ role: 'user', content: 'Hello.' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : systemText(request)
				const firstIndex = text.indexOf('SENTINEL-FIRST-P5')
				const secondIndex = text.indexOf('SENTINEL-SECOND-P5')
				const thirdIndex = text.indexOf('SENTINEL-THIRD-P1')
				expect(firstIndex).toBeGreaterThanOrEqual(0)
				expect(secondIndex).toBeGreaterThan(firstIndex)
				expect(thirdIndex).toBeGreaterThan(secondIndex)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)

	it(
		'empty sections render nothing',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, {
					system: 'SENTINEL-ONLY-SYSTEM-4291',
					timeout: TIMEOUT,
				})
				agent.context.messages.add({ role: 'user', content: 'Hello.' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : systemText(request)
				expect(text).toContain('SENTINEL-ONLY-SYSTEM-4291')
				expect(text).not.toContain('## Instructions')
				expect(text).not.toContain('## Workspace')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

// --- Scope allow-lists filtering the wire -------------------------------------

describe('AgentContext scope (provider-behavior) — a tools allow-list filters the wire', () => {
	it(
		'a tools allow-list omits the unlisted tool from the wire',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const tools = createToolManager()
				tools.add(createLookupTool())
				tools.add(createInsatiableTool())
				const scope = createScope({ name: 'lookup-only', tools: ['lookup'] })
				const agent = createAgent(provider, { tools, scope, timeout: TIMEOUT })
				agent.context.messages.add({ role: 'user', content: 'Hello.' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const names = request === undefined ? [] : wireTools(request)
				expect(names).toContain('lookup')
				expect(names).not.toContain('more')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('AgentContext scope (provider-behavior) — an instructions allow-list filters the system block', () => {
	it(
		'an instructions allow-list omits the unlisted instruction from the system block',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const instructions = createInstructionManager()
				instructions.add({ name: 'allowed', content: 'SENTINEL-ALLOWED-4471' })
				instructions.add({ name: 'blocked', content: 'SENTINEL-BLOCKED-9932' })
				const scope = createScope({ name: 'allowed-only', instructions: ['allowed'] })
				const agent = createAgent(provider, { instructions, scope, timeout: TIMEOUT })
				agent.context.messages.add({ role: 'user', content: 'Hello.' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : systemText(request)
				expect(text).toContain('SENTINEL-ALLOWED-4471')
				expect(text).not.toContain('SENTINEL-BLOCKED-9932')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('AgentContext scope (provider-behavior) — a files allow-list filters the workspace section', () => {
	it(
		'a files allow-list omits unlisted workspace files from the system block',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const scope = createScope({ name: 'sentinel-only', files: ['find-me.md'] })
				const agent = createAgent(provider, { scope, timeout: TIMEOUT })
				const workspace = agent.context.workspaces.add()
				fillWorkspace(workspace, {
					count: 2,
					bytesEach: 60,
					sentinelPath: 'find-me.md',
					sentinelText: 'SENTINEL-FIND-ME-6603',
				})
				agent.context.messages.add({ role: 'user', content: 'Hello.' })
				agent.generate().catch(() => {})
				await waitForRequest(proxy)

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : wireText(request)
				expect(text).toContain('SENTINEL-FIND-ME-6603')
				expect(text).not.toContain('doc-01.md')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

describe('AgentContext scope (provider-behavior) — an empty allow-list drops the category, undefined passes all', () => {
	it(
		'an empty allow-list drops the whole category while undefined passes all',
		async () => {
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const tools = createToolManager()
				tools.add(createLookupTool())
				tools.add(createInsatiableTool())
				const scope = createScope({ name: 'none', tools: [] })
				const agent = createAgent(provider, { tools, scope, timeout: TIMEOUT })
				agent.context.messages.add({ role: 'user', content: 'Hello.' })

				agent.generate().catch(() => {})
				await waitForRequest(proxy, 1)
				const emptyRequest = proxy.requests[0]
				expect(emptyRequest).toBeDefined()
				expect(emptyRequest === undefined ? [] : wireTools(emptyRequest)).toEqual([])

				agent.context.apply(undefined)
				agent.generate().catch(() => {})
				await waitForRequest(proxy, 2)
				const allRequest = proxy.requests[1]
				expect(allRequest).toBeDefined()
				const names = allRequest === undefined ? [] : wireTools(allRequest)
				expect(names).toContain('lookup')
				expect(names).toContain('more')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

// --- Workspace injection on the wire ------------------------------------------

// Hermetic workspace request-shape tests use a deliberately unreachable upstream.
// The recording proxy captures the request before forwarding, so the assertions cover
// only workspace rendering and attachment behavior on the provider wire; the suite
// passes with the daemon down.

describe('AgentContext workspaces (hermetic provider behavior) — large-context injection', () => {
	it(
		'a many-file workspace fences every text file into the system block in insertion order',
		async () => {
			// Recipe: FAST_OPTIONS — the response outcome is irrelevant; the proxy records the
			// request before forwarding. fillWorkspace's defaults (count:12, bytesEach:700) keep the
			// total payload small (~8.4KB of filler + the sentinel).
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				const workspace = agent.context.workspaces.add()
				fillWorkspace(workspace, {
					count: 12,
					sentinelPath: 'notes/sentinel.md',
					sentinelText: 'THE-SENTINEL-VALUE-4471',
				})
				agent.context.messages.add({ role: 'user', content: 'Say hello.' })
				await agent.generate().catch(() => {})

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : systemText(request)
				expect(text).toContain('## Workspace')
				expect(text).toContain('File: doc-01.md')
				expect(text).toContain('THE-SENTINEL-VALUE-4471')
				expect(text.indexOf('doc-01.md')).toBeGreaterThanOrEqual(0)
				expect(text.indexOf('doc-02.md')).toBeGreaterThanOrEqual(0)
				expect(text.indexOf('doc-01.md')).toBeLessThan(text.indexOf('doc-02.md'))
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)

	it(
		'only the active workspace reaches the wire',
		async () => {
			// Recipe: FAST_OPTIONS. Two workspaces are registered — the FIRST auto-activates
			// (WorkspaceManagerInterface.add's documented behavior), the SECOND is added but left
			// inactive. The inactive workspace's sentinel must never reach the wire.
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				const active = agent.context.workspaces.add() // auto-activates
				active.write('active.md', 'ACTIVE-CONTENT-9931')
				const inactive = agent.context.workspaces.add({ id: 'inactive' }) // leaves active unchanged
				inactive.write('inactive.md', 'INACTIVE-SENTINEL-3312')
				agent.context.messages.add({ role: 'user', content: 'Say hello.' })
				await agent.generate().catch(() => {})

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : wireText(request)
				expect(text).toContain('ACTIVE-CONTENT-9931')
				expect(text).not.toContain('INACTIVE-SENTINEL-3312')
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)

	it(
		'image files are not fenced as text',
		async () => {
			// Recipe: FAST_OPTIONS. One text file + one image file (seated via the workspace
			// constructor `seed` — the only way to seat a non-text/binary file per
			// WorkspaceOptions.seed's documented contract) are placed in the active workspace. The text file's content must
			// fence into the system block; the image's base64 payload must never appear as fenced
			// text in any wire message content.
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				const workspace = agent.context.workspaces.add({
					seed: [
						createFile({
							path: 'picture.png',
							content: createBinaryContent(TINY_PNG_BASE64, 'image/png'),
						}),
					],
				})
				workspace.write('report.md', 'REPORT-TEXT-2287')
				agent.context.messages.add({ role: 'user', content: 'Say hello.' })
				await agent.generate().catch(() => {})

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const text = request === undefined ? '' : wireText(request)
				expect(text).toContain('REPORT-TEXT-2287')
				expect(text).not.toContain(TINY_PNG_BASE64)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)

	it(
		'an active-workspace image attaches to the last user message',
		async () => {
			// Recipe: FAST_OPTIONS. A user message is seeded first, then an active workspace holding
			// only the seeded image file. The recorded body's LAST user-role message must carry the
			// image's base64 payload in a non-empty `images` array.
			const proxy = await createRecordingProxy()
			try {
				const provider = createOllama({
					model: 'test-model',
					url: proxy.url,
					options: { num_predict: 8, temperature: 0 },
				})
				const agent = createAgent(provider, { timeout: TIMEOUT })
				agent.context.messages.add(createUserMessage('What is in this image?'))
				agent.context.workspaces.add({
					seed: [
						createFile({
							path: 'attached.png',
							content: createBinaryContent(TINY_PNG_BASE64, 'image/png'),
						}),
					],
				})
				await agent.generate().catch(() => {})

				const request = proxy.requests[0]
				expect(request).toBeDefined()
				const messages = request === undefined ? [] : wireMessages(request)
				const userMessages = messages.filter((message) => message.role === 'user')
				const last = userMessages[userMessages.length - 1]
				expect(last).toBeDefined()
				expect(last?.images).toBeDefined()
				expect(last?.images?.length ?? 0).toBeGreaterThan(0)
				expect(last?.images).toContain(TINY_PNG_BASE64)
			} finally {
				await proxy.stop()
			}
		},
		TIMEOUT,
	)
})

// --- Conversation selection and compaction ------------------------------------

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
		const invocations = createRecorder<[readonly Message[]]>()
		const conversation = createConversation({
			summarize: createRecordingSummarizer(invocations),
		})
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
