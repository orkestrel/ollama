import {
	createEmptyRecordingServer,
	createOutcomePage,
	createStaticOutcomePage,
} from './setupServer.js'
import type { AbortInterface } from '@orkestrel/abort'
import type { AgentResult, ProviderResult } from '@orkestrel/agent'
import type {
	BrowserCallOptions,
	BrowserConsoleMessage,
	BrowserPageError,
	BrowserRequest,
} from '@orkestrel/browser'
import type { OllamaOptions } from '@src/core'
import type { DistributionEntry, PageAttempt, PageTool, RecordedRequest } from './setupServer.js'
import type { AgentChunk, Message } from '@orkestrel/agent'
import type { ToolCall, ToolResult } from '@orkestrel/tool'
import type {
	StoreCall,
	StoreExposure,
	StoreServerInterface,
	StoreThought,
	StoreTiming,
	StoreTurn,
} from './setupServer.js'
import { createAbort } from '@orkestrel/abort'
import { attempt, isError, isRecord, isString } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import {
	collectStream,
	captureError,
	createRecorder,
	createTeardown,
	requireValue,
	waitForAbort,
	waitForCondition,
	waitForDelay,
} from '@orkestrel/test'
import { createOllama, OllamaProvider } from '@src/core'
import { createNDJSONParser } from '@orkestrel/ndjson'
import { afterAll, describe, expect, it } from 'vitest'
import { createScratch } from '@orkestrel/test/server'
import { chmodSync, realpathSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import { join, parse } from 'node:path'
import workspace from '../vite.config.js'
import {
	buildFenceObservation,
	createUserMessage,
	DONE_RECORD,
	FENCE_CONTROLS,
	FENCE_SCENARIOS,
	HELLO_TURN,
	PAGE_TOOL,
	readStackDepth,
	SHORT_OPTIONS,
	STREAM_FENCE_CASES,
	TIMER_LEAD,
} from './setup.js'
import {
	ABSENT_SUBPATH,
	IMPORT_MAP_PACKAGES,
	PAGE_ALLOWANCES,
	buildReferenceCases,
	buildSpecifierCases,
	CODE_FILE_CASES,
	CODE_FILES,
	COMMONJS_CASES,
	COMMONJS_FILES,
	COMPUTE_DECLARATION_CASES,
	DECLARATION_TARGET_CASES,
	DECODE_SEGMENT_CASES,
	MODULE_TARGET_CASES,
	NOT_ENTRIES,
	PACKAGE_TARGET_CASES,
	PACKAGE_TYPE_CASES,
	POSITIVE_INTEGERS,
	RESOLVE_FILE_CASES,
	RESOLVER_FILES,
	SERVICE_IMPORTER_CASES,
	TARGET_DECLARATION_CASES,
	acceptPageAttempt,
	alignLoopClock,
	boundPageAttempt,
	BROWSER_DRIVER,
	buildImportMap,
	buildDaemonMode,
	buildDaemonOptions,
	createDaemonPeer,
	createRechunkingTransport,
	DAEMON_MODEL,
	DAEMON_VERSION,
	DAEMON_DECLARATION,
	DAEMON_SERVICE_REFUSALS,
	resolveDaemonDeclaration,
	buildModuleFixture,
	buildRecordedRequest,
	buildReferences,
	buildNpmEnvironment,
	buildRelayRoute,
	buildStage,
	buildStubStage,
	buildUncachedResponse,
	CallCounter,
	abortCall,
	CAPTURE_ENTRY_POINTS,
	captureAbortedRequest,
	captureOpenRequest,
	captureSettledRequest,
	COMPUTED_FIXTURES,
	COMPUTED_REFERENCE_CASES,
	createErrorTransport,
	createFenceModules,
	createPageSessionOptions,
	executeFence,
	extractFenceError,
	extractStreamFences,
	observeFence,
	readStreamFences,
	constructProvider,
	checkProject,
	checkResolution,
	checkSurface,
	CJS_DRIVER,
	CLASSIFIER_FILES,
	classifyExport,
	classifyExports,
	collectDiagnostics,
	collectModuleClosure,
	collectTargets,
	computeDeclaration,
	CONTROL_PATH,
	createChatUpstream,
	createPingRegistry,
	declaresCommonJS,
	decodeSegment,
	DECLARATION_CONDITIONS,
	driveRuntime,
	ESM_DRIVER,
	FIXTURE_PACKAGE_FILES,
	FIXTURE_PACKAGE_NAME,
	FORMATS,
	isDeclarationTarget,
	isModuleTarget,
	isPackageTarget,
	NPM_COMMAND,
	NPM_SHELL,
	openStage,
	READER_FILES,
	readDeclaration,
	readJson,
	readManifestName,
	readPackageType,
	readScopeType,
	readSpawnOutput,
	RELEASE_MODE,
	RESOLUTIONS,
	resolveCompiler,
	resolveDeclaration,
	resolvePackageTarget,
	resolveTarget,
	resolvesBrowser,
	resolvesCommonJS,
	runNode,
	runNpm,
	RUNTIME_CONDITIONS,
	ScopeWalk,
	ScriptCursor,
	selectDrivers,
	selectEntries,
	selectUntypable,
	targetToDeclaration,
	writeConsumerProbe,
	writeFixtureFile,
	writeProject,
	createPageFixture,
	createRecordingProxy,
	createRecordingTransport,
	createRelayServer,
	createOpenTransport,
	createScriptedTransport,
	createStreamingTransport,
	describeFailure,
	DIST_PATH,
	DRIVEN_DELTAS,
	DRIVEN_RESULT,
	EMPTY_RESULT,
	expirePageAttempt,
	fetchUpstream,
	findCodeFile,
	findFileText,
	findComputedFiles,
	findModuleReferences,
	scanTreeReferences,
	findServiceImporters,
	findServiceImports,
	findServiceSetupFiles,
	FIXTURE_CONTENT,
	FIXTURE_HOSTED_IMPORTER,
	FIXTURE_MODEL,
	FixtureDaemon,
	HERMETIC_WITNESSES,
	isAgentOutcome,
	IMPORT_ONLY_ENTRY,
	isFilePath,
	isIdentifierNamed,
	isImportMetaMember,
	isPageControl,
	isPageGeneration,
	isPageOutcome,
	isPageReceipts,
	isPositiveInteger,
	isServiceImporter,
	isToolOutcome,
	listChildren,
	listProjects,
	listProjectSources,
	leaveCall,
	listSetupFiles,
	listSources,
	LOADING_FORMS,
	MODULE_FIXTURES,
	MODULES_PATH,
	NON_HERMETIC_PROJECTS,
	NON_POSITIVE_INTEGERS,
	NOT_SETUP_FILES,
	NOT_TREES,
	observePageAttempt,
	OBFUSCATED,
	PAGE_BOUNDS,
	PAGE_BROWSER_ARGS,
	PAGE_CAPITAL,
	PAGE_DOCUMENT,
	PAGE_FAULT,
	PAGE_INFERENCE_PATH,
	PAGE_INTERVALS,
	PAGE_NOTE,
	PAGE_OPERATIONS,
	PAGE_RUN,
	PageObserver,
	racePageAttempt,
	drive,
	driveScript,
	INSATIABLE_TOOL_CHUNKS,
	insatiableResult,
	readChatMessages,
	readFirstRequest,
	readLatestChat,
	readLoopClock,
	readModuleEntry,
	readModuleReferences,
	readOutcome,
	readPathAliases,
	readProject,
	readRequest,
	readSpecifierText,
	READY_CHAT,
	READY_TAGS,
	RecordingServer,
	releasePageAttempt,
	RequestLog,
	requireBuild,
	requirePageBrowser,
	reservePort,
	resolveModuleFiles,
	rootToPath,
	SCENARIO_PROVIDER,
	SCHEDULE_SLACK,
	SERVICE_IMPORT_CASES,
	serveFile,
	runWithFetch,
	settleCall,
	ASSET_QUERIES,
	ASSET_SPECIFIER_CASES,
	buildComputedFixture,
	buildFenceImport,
	buildQueryFixture,
	CODE_EXTENSIONS,
	COMPUTED_URL_FILES,
	FIXTURE_SERVICE_BODY,
	isAssetSpecifier,
	NORMALIZE_SETUP_CASES,
	normalizeSetupFile,
	OTHER_SETUP_SPELLINGS,
	readFirstStatement,
	readRealPath,
	SERVICE_MODULE,
	SERVICE_SETUP_SPELLINGS,
	SERVICE_SPECIFIER,
	SERVICE_SPECIFIER_CASES,
	SETUP_FILES,
	SOURCE_TWINS,
	SPECIFIER_SUFFIX_CASES,
	stripSpecifierSuffix,
	UNRELATED_IMPORT_CASES,
	waitForRequest,
	WEATHER_TOOL,
	WORKSPACE_ROOT,
} from './setupServer.js'
import { createChannel, DEFAULT_PROVIDER_TIMEOUT, ProviderError } from '@orkestrel/agent'
import {
	BROWSER_TOOL_COPY,
	BROWSER_TOOL_LIMIT,
	createBrowserReading,
	createBrowserToolset,
	scanBrowserLines,
	renderBrowserJourney,
} from '@orkestrel/browser'
import { createFileBrowserJourneyStore, createFileBrowserRunStore } from '@orkestrel/browser/server'
import { collect } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'
import { createToolManager } from '@orkestrel/tool'
import { mkdirSync, readdirSync } from 'node:fs'
import { beforeAll } from 'vitest'
import {
	STORE_TIMED_CALLS,
	STORE_STAGGERED_CALLS,
	STORE_STAGGERED_DELAYS,
	STORE_BROKEN_CALL,
	STORE_BROKEN_CALLS,
	STORE_THOUGHT_CASES,
	createStaggeredTools,
	createRejectingTools,
	deriveTurnThinking,
	executeTimedTool,
	StoreTimer,
	STORE_REFERENCE_CALLS,
	STORE_MALFORMED_CALLS,
	STORE_EDIT_DEFINITION,
	STORE_VALID_EDITS,
	STORE_INVALID_EDITS,
	STORE_ACCEPTED_EXPOSURES,
	STORE_SEEDED_ANSWERS,
	STORE_PROMPT_TOOLS,
	STORE_ISOLATION_ATTEMPTS,
	STORE_JOURNEY_ORDERS,
	STORE_THINKING_CHUNKS,
	stemWord,
	findStoreProduct,
	buildMissingResponse,
	collectTurnThinking,
	extractPageHeader,
	readCapturedNumber,
	matchesCartClick,
	resolveTranscriptPath,
	buildRefusedCall,
	createPageBrowser,
	executeStoreCall,
	createRefusalTools,
	STORE_FIRST_SLICE,
	STORE_CONTINUED_SLICE,
	STORE_STALLED_SEARCH,
	STORE_EMPTY_RESULTS_SEARCH,
	STORE_CLICKED_SEARCH,
	STORE_COMPLETED_SEARCH,
	STORE_EDITED_JOURNEY,
	STORE_SAVED_LISTING,
	STORE_EDITS,
	STORE_JOURNEY_CALLS,
	writeJourneyFiles,
	buildJourneyTranscript,
	STORE_FEATURED,
	STORE_UNFEATURED,
	STORE_CART_CALLS,
	STORE_EXPOSURE_SCENARIOS,
	STORE_JOURNEY_ACTIONS,
	buildRefusedTranscripts,
	STORE_ORACLE_CASES,
	STORE_REFUSED_CARTS,
	STORE_REFUSED_ORDERS,
	buildExposureChanges,
	buildJourneyInvocation,
	buildLazyCalls,
	StoreContinuationWalk,
	StoreExposureTrace,
	StoreRefusals,
	StoreThinking,
	STORE_SEARCH_SEED,
	createStoreContext,
	extractWindowText,
	settleStoreRun,
	StoreActivity,
	StoreCallRecord,
	STORE_ANSWER_SCOPE,
	STORE_STALE_CONTINUATIONS,
	STORE_CONTINUATION_INTERRUPTIONS,
	STORE_INVALID_CONTINUATIONS,
	STORE_UNBATCHED_LISTINGS,
	STORE_REFUSED_RECORD,
	STORE_REFUSED_SAVE,
	STORE_FAIL_TURN,
	STORE_LOOKUP_TURN,
	STORE_MIXED_TURN,
	STORE_REFUSAL_TURNS,
	STORE_REFUSAL_TOOLS,
	STORE_THINKING_MESSAGES,
	attachThinking,
	attemptStoreTask,
	buildStoreCall,
	buildStorePrompt,
	buildStoreTranscript,
	computeRefusals,
	converseStore,
	createStoreServer,
	createTimedProvider,
	createTimedTools,
	escapeMarkup,
	parseFooterLine,
	extractJourneyEvidence,
	extractReferences,
	parseWindowLine,
	filterNamedProducts,
	filterProducts,
	filterSubmissionLines,
	findBoundParameter,
	findContinuedRead,
	findJourneyLoops,
	findMalformedCalls,
	findUnlistedReferences,
	filterPageTools,
	resolveJourneyPath,
	matchesDaemonFault,
	matchesJourneyBatch,
	matchesJourneyOracle,
	matchesJourneySequence,
	matchesNameBinding,
	matchesPagingOracle,
	matchesProducts,
	matchesShippingOracle,
	matchesCartOracle,
	matchesCheckoutOracle,
	STORE_POLICY,
	STORE_SEED_ARGUMENTS,
	STORE_PREDICATES,
	matchesRemovedCart,
	matchesSearchOracle,
	matchesStalledSearch,
	matchesStoreOracles,
	normalizeAnswer,
	parseJourneyEdits,
	parseStoreJSON,
	renderJourneyEdit,
	renderToolText,
	splitResultFooter,
	STORE_BOUNDS,
	STORE_BUYER,
	STORE_CODE,
	STORE_CODE_DELAY,
	STORE_FACT,
	STORE_JOURNEY_BOUNDS,
	STORE_JOURNEY_BUYER,
	STORE_JOURNEY_NAME,
	STORE_JOURNEY_PARAMETER,
	STORE_JOURNEY_PROMPT,
	STORE_JOURNEY_SEQUENCE,
	STORE_NAMED_PRODUCT,
	STORE_POLICY_TOKEN,
	STORE_PRODUCTS,
	STORE_QUERY,
	STORE_SYSTEM_PROMPT,
	STORE_TASKS,
	writeTranscript,
} from './setupServer.js'
import {
	buildClosingList,
	buildIteratorlessList,
	buildSparseList,
	buildTracedRecord,
	buildWatched,
	CASE_TIMEOUT,
} from './setup.js'
import {
	LOOKUP_DATUM,
	THROWING_TOOL_MESSAGE,
	createLookupTool,
	createThrowingTool,
	wireTools,
} from './setupServer.js'
// The Node-resource half of `tests/setupServer.ts`: the loopback recording proxy, the
// relay server, the fixture daemon, the capture wait, the provider-stream driver, the
// transport fixtures, the shared wire tables, the loop-clock reader and its aligner, the live
// page proof's browser and build gates, and the guard that keeps every hermetic project from
// importing `tests/setupService.ts`, which contacts the daemon when it loads.
// The narrowing guards, the tool fixtures, and the environment readers that module also
// exports are asserted by `tests/setup.test.ts`, so this proof does not re-assert them.
//
// The proxy and relay-server cases run against real sockets on 127.0.0.1 ephemeral
// ports: a pass-through case forwards to a fixture upstream this file starts, and
// `createRecordingProxy`'s own default upstream is deliberately unreachable. The
// transport fixtures drive in-memory responses instead. The loop-clock cases run real
// host timers measured on `performance.now()`. No Ollama daemon takes part in any of
// these cases.

describe('dedicated daemon protocol infrastructure', () => {
	it('re-chunks response bytes without decoding and records before the real send', async () => {
		const peer = await createDaemonPeer()
		const original = globalThis.fetch.bind(globalThis)
		const sent = createRecorder<readonly [string]>()
		const requests = createRecorder<readonly [Request]>()
		try {
			const transport = createRechunkingTransport(
				(input, init) => {
					sent.handler('send')
					return original(input, init)
				},
				(request) => {
					sent.handler('record')
					requests.handler(request)
				},
			)
			const response = await transport(`${peer.url}/api/generate`, { method: 'POST', body: '雪' })
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toBe('application/json')
			if (response.body === null) throw new Error('Missing re-chunked body')
			const chunks = await collectStream(response.body)
			expect(chunks.every((chunk) => chunk.byteLength === 1)).toBe(true)
			expect(Buffer.concat(chunks).toString()).toBe(
				'{"model":"fixture:雪","done":true,"eval_count":0}',
			)
			expect(sent.calls).toEqual([['record'], ['send']])
			expect(await requests.calls[0]?.[0].text()).toBe('雪')
			const empty = await createRechunkingTransport(() => Promise.resolve(new Response(null)))(
				'http://fixture.invalid',
			)
			expect(empty.body).toBeNull()
		} finally {
			await peer.destroy()
		}
	})

	it('builds independent fixture declarations and scenario arguments without starting a child', async () => {
		const ordinary = await buildDaemonOptions()
		const selected = await buildDaemonMode('silence', { readiness: 3210 })
		expect(ordinary.executable.arguments?.at(-1)).toBe('normal')
		expect(selected.executable.arguments?.at(-1)).toBe('silence')
		expect(selected.readiness).toBe(3210)
		expect(selected.models).toEqual([DAEMON_MODEL])
		expect(selected.executable.version).toBe(DAEMON_VERSION)
		expect(selected.executable.digest).toMatch(/^[a-f0-9]{64}$/)
		expect(selected.url).not.toBe(ordinary.url)
	})

	it('serves metadata and a controlled unload reply while recording exact request bytes', async () => {
		const peer = await createDaemonPeer({ unload: 'selected-control' })
		try {
			await expect((await fetch(`${peer.url}/api/version`)).json()).resolves.toEqual({
				version: DAEMON_VERSION,
			})
			await expect((await fetch(`${peer.url}/api/tags`)).json()).resolves.toEqual({
				models: [DAEMON_MODEL],
			})
			await expect(
				(await fetch(`${peer.url}/api/generate`, { method: 'POST', body: 'exact-request' })).json(),
			).resolves.toEqual({ model: 'selected-control', done: true, eval_count: 0 })
			expect(peer.requests).toEqual([
				{ path: '/api/version', body: '' },
				{ path: '/api/tags', body: '' },
				{ path: '/api/generate', body: 'exact-request' },
			])
		} finally {
			await peer.destroy()
		}
		await peer.destroy()
	})
})

describe('createRelayServer', () => {
	it('records accepted and refused request fields and mounts the authenticated inference route', async () => {
		const daemon = createRecordingTransport(
			createStreamingTransport(['{"message":{"content":"answer"}}\n']),
		)
		const server = await createRelayServer(
			createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
		)
		try {
			const body = { messages: [{ id: 'question', role: 'user', content: 'Hello' }] }
			const accepted = await fetch(`${server.url}/inference`, {
				method: 'POST',
				headers: { authorization: OBFUSCATED, 'x-trace': 'relay-fixture' },
				body: JSON.stringify(body),
			})
			expect(accepted.status).toBe(200)
			expect(createNDJSONParser().parse(await accepted.text())).toEqual([
				{ channel: 'content', text: 'answer' },
				{ channel: 'result', result: { content: 'answer' } },
			])
			const refused = await fetch(`${server.url}/inference`, {
				method: 'POST',
				headers: { authorization: `${OBFUSCATED}-wrong` },
				body: JSON.stringify(body),
			})
			expect(refused.status).toBe(401)
			expect(await refused.text()).toBe('')
			expect(daemon.requests).toHaveLength(1)
			expect(server.requests).toHaveLength(2)
			expect(server.requests[0]).toMatchObject({
				method: 'POST',
				path: '/inference',
				body,
				headers: { authorization: OBFUSCATED, 'x-trace': 'relay-fixture' },
				text: JSON.stringify(body),
			})
			expect(server.requests[1]).toMatchObject({
				method: 'POST',
				path: '/inference',
				body,
				headers: { authorization: `${OBFUSCATED}-wrong` },
			})
		} finally {
			await server.stop()
		}
		await expect(fetch(`${server.url}/inference`, { method: 'POST', body: '{}' })).rejects.toThrow(
			'fetch failed',
		)
	})
})

describe('createRecordingTransport', () => {
	it('records request fields and cancellation while preserving streamed response bytes and headers', async () => {
		const transport = createRecordingTransport(createStreamingTransport(['{"word":"caf', 'é"}\n']))
		const abort = new AbortController()
		const response = await transport.fetch('http://127.0.0.1/api/chat', {
			method: 'POST',
			headers: { authorization: 'Bearer fixture' },
			body: '{"model":"fixture"}',
			signal: abort.signal,
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('application/x-ndjson')
		expect(await response.text()).toBe('{"word":"café"}\n')
		expect(transport.chunks.join('')).toBe('{"word":"café"}\n')
		expect(transport.requests[0]).toMatchObject({
			method: 'POST',
			path: '/api/chat',
			headers: { authorization: 'Bearer fixture' },
			body: { model: 'fixture' },
			text: '{"model":"fixture"}',
		})
		expect(transport.requests[0]?.signal.aborted).toBe(false)
		abort.abort()
		expect(transport.requests[0]?.signal.aborted).toBe(true)
	})

	it('preserves a bodyless refusal response', async () => {
		const transport = createRecordingTransport(() =>
			Promise.resolve(new Response(null, { status: 401 })),
		)
		const response = await transport.fetch('http://127.0.0.1/inference')
		expect(response.status).toBe(401)
		expect(response.body).toBeNull()
		expect(transport.chunks).toEqual([])
	})

	it('defaults to the global fetch, forwarding a real request to a live server', async () => {
		const proxy = await createRecordingProxy()
		try {
			const transport = createRecordingTransport()
			const url = `${proxy.url}/api/chat`
			await transport.fetch(url, { method: 'POST', body: '{}' }).catch(() => {})

			await waitForRequest(proxy)

			expect(transport.requests[0]?.path).toBe('/api/chat')
			expect(proxy.requests[0]?.path).toBe('/api/chat')
		} finally {
			await proxy.stop()
		}
	})
})

describe('createOpenTransport', () => {
	it('delivers the supplied bytes and reports cancellation of its open body', async () => {
		const transport = createOpenTransport('first\n')
		const response = await transport.fetch('http://127.0.0.1/api/chat')
		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('open transport returned no body')
		try {
			expect(await reader.read()).toEqual({
				done: false,
				value: new TextEncoder().encode('first\n'),
			})
			await reader.cancel()
			await transport.cancelled
		} finally {
			await reader.cancel()
			reader.releaseLock()
		}
	})

	it('errors a pending read after its supplied bytes and rejects failure before a call', async () => {
		const transport = createOpenTransport('first\n')
		const error = new Error('fixture failure')
		expect(() => transport.fail(error)).toThrow('daemon transport has not been called')
		const response = await transport.fetch('http://127.0.0.1/api/chat')
		const reader = response.body?.getReader()
		if (reader === undefined) throw new Error('open transport returned no body')
		try {
			expect((await reader.read()).done).toBe(false)
			const pending = reader.read()
			transport.fail(error)
			await expect(pending).rejects.toBe(error)
		} finally {
			await reader.cancel().catch(() => {})
			reader.releaseLock()
		}
	})

	it('runs its drained callback once, when a reader asks for more after it took the chunk', async () => {
		const drained = createRecorder<readonly []>()
		const transport = createOpenTransport('first\n', drained.handler)
		const reader = (await transport.fetch('http://127.0.0.1/api/chat')).body?.getReader()
		if (reader === undefined) throw new Error('open transport returned no body')
		try {
			expect(drained.calls).toEqual([])
			await reader.read()
			await waitForDelay(10)
			expect(drained.calls).toEqual([])

			const pending = reader.read()
			expect(drained.calls).toEqual([[]])
			const second = reader.read()
			await waitForDelay(10)
			expect(drained.calls).toEqual([[]])
			await reader.cancel()
			await Promise.all([pending, second])
		} finally {
			reader.releaseLock()
		}
	})

	it('keeps the first stream it opened as the one a failure errors, because it is single-use', async () => {
		const transport = createOpenTransport('first\n')
		const error = new Error('fixture failure')
		const first = (await transport.fetch('http://127.0.0.1/api/chat')).body?.getReader()
		const second = (await transport.fetch('http://127.0.0.1/api/chat')).body?.getReader()
		if (first === undefined || second === undefined) {
			throw new Error('open transport returned no body')
		}
		await first.read()
		await second.read()
		const outcomes = [first.read(), second.read()].map((pending) =>
			Promise.race([
				pending.then(
					() => 'delivered',
					(failure: unknown) => (failure === error ? 'errored' : 'failed otherwise'),
				),
				waitForDelay(30).then(() => 'open'),
			]),
		)

		transport.fail(error)

		expect(await Promise.all(outcomes)).toEqual(['errored', 'open'])
		await second.cancel()
	})
})

describe('createRecordingProxy', () => {
	it("captures a call's method, path, headers, and parsed body before forwarding it", async () => {
		const proxy = await createRecordingProxy()
		try {
			const sent = { model: 'fixture-model', stream: false }
			await fetch(`${proxy.url}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-trace': 'capture-case' },
				body: JSON.stringify(sent),
			}).catch(() => {})

			await waitForRequest(proxy)

			const request = proxy.requests[0]
			if (request === undefined) throw new Error('the recording proxy captured no request')
			expect(request.method).toBe('POST')
			expect(request.path).toBe('/api/chat')
			expect(request.headers['x-trace']).toBe('capture-case')
			expect(request.body).toEqual(sent)
		} finally {
			await proxy.stop()
		}
	})

	it('forwards the body to a reachable upstream and returns its status and body verbatim', async () => {
		const answer = '{"message":{"content":"pong"}}'
		const upstream = await createChatUpstream(() =>
			Promise.resolve(new Response(answer, { status: 202 })),
		)
		const proxy = await createRecordingProxy(upstream.url)
		try {
			const body = JSON.stringify({ model: 'fixture-model', stream: false })

			const response = await fetch(`${proxy.url}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			})

			expect(response.status).toBe(202)
			expect(await response.text()).toBe(answer)
			expect(upstream.requests.map((request) => request.text)).toEqual([body])
		} finally {
			await proxy.stop()
			await upstream.stop()
		}
	})

	it('answers 499 when stop cancels a call still waiting on the upstream', async () => {
		const park = new AbortController()
		const upstream = await createChatUpstream(async (signal) => {
			await waitForAbort(AbortSignal.any([signal, park.signal]))
			return new Response(undefined, { status: 204 })
		})
		const proxy = await createRecordingProxy(upstream.url)
		try {
			const pending = fetch(`${proxy.url}/api/chat`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{"model":"fixture-model"}',
			})
			await waitForRequest(proxy)

			const stopped = proxy.stop()

			expect((await pending).status).toBe(499)
			await stopped
		} finally {
			park.abort()
			await upstream.stop()
		}
	})

	it('releases its port on stop', async () => {
		const proxy = await createRecordingProxy()
		const url = `${proxy.url}/api/chat`

		await proxy.stop()

		await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow(Error)
	})
})

describe('waitForRequest', () => {
	it('resolves after the proxy has captured the requested count', async () => {
		const proxy = await createRecordingProxy()
		try {
			const first = fetch(`${proxy.url}/api/chat`, { method: 'POST', body: '{"n":1}' }).catch(
				() => {},
			)
			const second = fetch(`${proxy.url}/api/chat`, { method: 'POST', body: '{"n":2}' }).catch(
				() => {},
			)

			await waitForRequest(proxy, 2)

			expect(proxy.requests.length).toBeGreaterThanOrEqual(2)
			await first
			await second
		} finally {
			await proxy.stop()
		}
	})

	it('rejects naming the count it waited for when the budget expires', async () => {
		const proxy = await createRecordingProxy()
		try {
			await expect(waitForRequest(proxy, 2, 40)).rejects.toThrow(
				'the recording proxy to capture 2 request(s)',
			)
		} finally {
			await proxy.stop()
		}
	})
})

describe('captureRequest, captureAbortedRequest, captureSettledRequest, and captureOpenRequest', () => {
	it('returns the request the provider sent, carrying the options the scenario was given', async () => {
		const request = await captureAbortedRequest(
			{ model: 'scenario-model', keepAlive: '9m', think: true },
			(provider, signal) => provider.generate([createUserMessage('hello')], signal),
		)

		expect(request.method).toBe('POST')
		expect(request.path).toBe('/api/chat')
		expect(request.body.model).toBe('scenario-model')
		expect(request.body.keep_alive).toBe('9m')
		expect(request.body.think).toBe(true)
		expect(request.body.messages).toEqual([{ role: 'user', content: 'hello' }])
	})

	it('aborts the signal it hands the call once recorded, and awaits a call that settles on a later turn, when it aborts', async () => {
		const signals = createRecorder<readonly [AbortSignal]>()
		const settled = createRecorder<readonly []>()

		await captureAbortedRequest({ model: 'scenario-model' }, (provider, signal) => {
			signals.handler(signal)
			return provider
				.generate([createUserMessage('hi')], signal)
				.finally(() => waitForDelay(40))
				.finally(() => settled.handler())
		})

		expect(signals.calls.map(([signal]) => signal.aborted)).toEqual([true])
		expect(settled.calls).toEqual([[]])
	})

	it('drives a streaming call through the same scenario', async () => {
		const request = await captureAbortedRequest({ model: 'scenario-model' }, (provider, signal) =>
			drive(provider.stream([createUserMessage('hi')], signal)),
		)

		expect(request.body.stream).toBe(true)
	})

	it('rethrows what the call throws before it sends', async () => {
		await expect(
			captureAbortedRequest({ model: 'scenario-model' }, () => {
				throw new Error('call refused')
			}),
		).rejects.toThrow('call refused')
	})

	it('returns the one request the provider sent once the call has settled, aborting nothing, when it settles', async () => {
		const order = createRecorder<readonly [string]>()
		const signals = createRecorder<readonly [AbortSignal]>()

		const request = await captureSettledRequest(SCENARIO_PROVIDER, async (provider, signal) => {
			signals.handler(signal)
			await provider
				.generate([createUserMessage('hello')], new AbortController().signal)
				.catch(() => {})
			order.handler('settled')
		})

		expect(order.calls).toEqual([['settled']])
		expect(signals.calls.map(([signal]) => signal.aborted)).toEqual([false])
		expect(request.path).toBe('/api/chat')
		expect(request.body.model).toBe('test-model')
		expect(request.body.options).toEqual({ num_predict: 8, temperature: 0 })
		expect(request.body.messages).toEqual([{ role: 'user', content: 'hello' }])
	})

	it('returns as soon as the proxy holds the request and leaves a call that has not settled running, when it leaves the call open', async () => {
		const gate = Promise.withResolvers<void>()
		const signals = createRecorder<readonly [AbortSignal]>()

		const request = await captureOpenRequest(
			{ model: 'test-model', keepAlive: '9m' },
			async (provider, signal) => {
				signals.handler(signal)
				provider.generate([createUserMessage('hi')], new AbortController().signal).catch(() => {})
				await gate.promise
			},
		)
		gate.resolve()

		expect(request.body.keep_alive).toBe('9m')
		expect(signals.calls.map(([signal]) => signal.aborted)).toEqual([false])
	})

	it('throws when a settled call recorded no request, whether the call resolved or rejected', async () => {
		await expect(captureSettledRequest(SCENARIO_PROVIDER, () => Promise.resolve())).rejects.toThrow(
			'no recorded request',
		)
		await expect(
			captureSettledRequest(SCENARIO_PROVIDER, () => Promise.reject(new Error('call refused'))),
		).rejects.toThrow('no recorded request')
	})

	it('builds the provider through the factory it is given, with the proxy address added to the options', async () => {
		const built = createRecorder<readonly [OllamaOptions]>()

		const request = await captureSettledRequest(
			SCENARIO_PROVIDER,
			(provider) => provider.generate([createUserMessage('hi')], new AbortController().signal),
			(options) => {
				built.handler(options)
				return createOllama(options)
			},
		)

		expect(built.calls.map(([options]) => [options.model, options.options])).toEqual([
			['test-model', SHORT_OPTIONS],
		])
		expect(built.calls.map(([options]) => new URL(options.url ?? '').hostname)).toEqual([
			'127.0.0.1',
		])
		expect(request.body.model).toBe('test-model')
	})

	for (const [name, capture] of CAPTURE_ENTRY_POINTS) {
		it(`stops the proxy ${name} started, after a call that returns and after a call that throws`, async () => {
			const urls = createRecorder<readonly [string | undefined]>()

			await capture(
				SCENARIO_PROVIDER,
				(provider, signal) => provider.generate([createUserMessage('hi')], signal),
				(options) => {
					urls.handler(options.url)
					return constructProvider(options)
				},
			)
			await expect(
				capture(
					SCENARIO_PROVIDER,
					() => {
						throw new Error('call refused')
					},
					(options) => {
						urls.handler(options.url)
						return constructProvider(options)
					},
				),
			).rejects.toThrow('call refused')

			expect(urls.calls).toHaveLength(2)
			for (const [url] of urls.calls) {
				await expect(fetch(`${url}/api/tags`)).rejects.toThrow('fetch failed')
			}
		})
	}
})

describe('abortCall, settleCall, and leaveCall', () => {
	it('abort the call once the proxy holds its request, and await it', async () => {
		const proxy = await createRecordingProxy()
		const abort = createAbort()
		const settled = createRecorder<readonly []>()
		try {
			const pending = fetch(`${proxy.url}/api/chat`, {
				method: 'POST',
				body: '{}',
				signal: abort.signal,
			})
				.catch(() => {})
				.finally(() => waitForDelay(40))
				.finally(() => settled.handler())

			await abortCall({ proxy, abort, pending })

			expect(abort.signal.aborted).toBe(true)
			expect(settled.calls).toEqual([[]])
			expect(proxy.requests).toHaveLength(1)
		} finally {
			await proxy.stop()
		}
	})

	it('settle waits for the call and aborts nothing, without waiting for a request', async () => {
		const proxy = await createRecordingProxy()
		const abort = createAbort()
		const settled = createRecorder<readonly []>()
		try {
			const pending = waitForDelay(40).then(() => settled.handler())

			await settleCall({ proxy, abort, pending })

			expect(settled.calls).toEqual([[]])
			expect(abort.signal.aborted).toBe(false)
			expect(proxy.requests).toEqual([])
		} finally {
			await proxy.stop()
		}
	})

	it('leave waits for the proxy to hold a request and leaves the call and the signal alone', async () => {
		const proxy = await createRecordingProxy()
		const abort = createAbort()
		try {
			const pending = fetch(`${proxy.url}/api/chat`, {
				method: 'POST',
				body: '{}',
				signal: abort.signal,
			}).catch(() => {})

			await leaveCall({ proxy, abort, pending })

			expect(abort.signal.aborted).toBe(false)
			expect(proxy.requests).toHaveLength(1)
			abort.abort()
			await pending
		} finally {
			await proxy.stop()
		}
	})
})

describe('constructProvider', () => {
	it('constructs the provider class over the options', () => {
		const provider = constructProvider({ model: 'test-model' })

		expect(provider).toBeInstanceOf(OllamaProvider)
		expect(provider.name).toBe('ollama')
	})
})

describe('readFirstRequest', () => {
	it('returns the first request a server captured and throws when it captured none', () => {
		const first = buildRecordedRequest({ n: 1 })
		const second = buildRecordedRequest({ n: 2 })
		const empty = createEmptyRecordingServer()
		const held = { ...empty, requests: [first, second] }

		expect(readFirstRequest(held)).toBe(first)
		expect(() => readFirstRequest(empty)).toThrow('no recorded request')
	})
})

describe('SCENARIO_PROVIDER', () => {
	it('holds the short deterministic call every single-request wire scenario sends', () => {
		expect(SCENARIO_PROVIDER).toEqual({
			model: 'test-model',
			options: { num_predict: 8, temperature: 0 },
		})
		expect(SCENARIO_PROVIDER.options).toEqual(SHORT_OPTIONS)
		expect(Object.isFrozen(SCENARIO_PROVIDER)).toBe(true)
		expect(Object.isFrozen(SCENARIO_PROVIDER.options)).toBe(true)
	})
})

describe('drive', () => {
	it('separates content deltas from thinking deltas and hands back the settled result', async () => {
		const driven = await drive(driveScript(DRIVEN_DELTAS, DRIVEN_RESULT))

		expect(driven.deltas).toEqual(['a', 'b'])
		expect(driven.thoughts).toEqual(['weighing it up'])
		expect(driven.result).toBe(DRIVEN_RESULT)
	})

	it('returns empty buckets for a stream that yields nothing', async () => {
		const driven = await drive(driveScript([], EMPTY_RESULT))

		expect(driven.deltas).toEqual([])
		expect(driven.thoughts).toEqual([])
		expect(driven.result).toBe(EMPTY_RESULT)
	})
})

describe('WEATHER_TOOL', () => {
	it('is frozen and declares city as its only required parameter', () => {
		expect(Object.isFrozen(WEATHER_TOOL)).toBe(true)
		expect(WEATHER_TOOL.name).toBe('get_weather')
		const parameters: unknown = WEATHER_TOOL.parameters
		if (!isRecord(parameters)) throw new Error('WEATHER_TOOL declares no parameter schema')
		expect(parameters.type).toBe('object')
		expect(parameters.required).toEqual(['city'])
		const properties: unknown = parameters.properties
		if (!isRecord(properties)) throw new Error('WEATHER_TOOL declares no parameter properties')
		expect(Object.keys(properties)).toEqual(['city'])
	})
})

describe('insatiableResult', () => {
	it('names its own chunk, the shared total, and the next chunk on every line', () => {
		for (const chunk of Array.from({ length: INSATIABLE_TOOL_CHUNKS }, (_, index) => index + 1)) {
			const line = insatiableResult(chunk)

			expect(line).toContain(`Chunk ${chunk} of ${INSATIABLE_TOOL_CHUNKS}`)
			expect(line).toContain(`chunk ${chunk + 1}`)
		}
	})
})

// The page fixture's Node half. The live half — a real browser loading the served
// closure and running an agent in it — is proven by the `service` project, which is the
// only project this workspace gives a browser; nothing here launches one.

describe('readRequest', () => {
	it('records the method, path, headers, parsed body, and text without consuming the request', async () => {
		const request = new Request('http://127.0.0.1:1/inference?trace=1', {
			method: 'POST',
			headers: { authorization: OBFUSCATED, 'x-trace': 'record' },
			body: '{"messages":[]}',
		})

		const record = await readRequest(request)

		expect(record).toEqual({
			method: 'POST',
			path: '/inference',
			headers: expect.objectContaining({ authorization: OBFUSCATED, 'x-trace': 'record' }),
			body: { messages: [] },
			text: '{"messages":[]}',
		})
		// The original still carries its body, which is what lets a relay read it afterwards.
		expect(await request.text()).toBe('{"messages":[]}')
	})

	it('records an empty body for a request carrying no JSON record', async () => {
		const record = await readRequest(new Request('http://127.0.0.1:1/control'))

		expect(record).toMatchObject({ method: 'GET', path: '/control', body: {}, text: '' })
	})
})

describe('buildRelayRoute', () => {
	it('registers the authenticated inference route both server fixtures mount', () => {
		const route = buildRelayRoute(createOllama({ model: 'fixture-model' }), new RequestLog())

		expect(route.method).toBe('POST')
		expect(route.path).toBe('/inference')
	})

	it('appends every inbound request, accepted or refused, to the log it was given', async () => {
		const daemon = createRecordingTransport(
			createStreamingTransport(['{"message":{"content":"answer"}}\n']),
		)
		const log = new RequestLog()
		const dispatcher = createDispatcher<Record<string, never>>()
		dispatcher.add(
			buildRelayRoute(createOllama({ model: 'fixture-model', fetch: daemon.fetch }), log),
		)
		const body = { messages: [{ id: 'question', role: 'user', content: 'Hello' }] }
		const text = JSON.stringify(body)

		const accepted = await dispatcher.handle(
			new Request('http://127.0.0.1/inference', {
				method: 'POST',
				headers: { authorization: OBFUSCATED, 'content-type': 'application/json' },
				body: text,
			}),
			{},
		)
		const refused = await dispatcher.handle(
			new Request('http://127.0.0.1/inference', {
				method: 'POST',
				headers: { authorization: `${OBFUSCATED}-wrong`, 'content-type': 'application/json' },
				body: text,
			}),
			{},
		)

		expect(accepted.status).toBe(200)
		expect(refused.status).toBe(401)
		expect(log.entries).toEqual([
			{
				method: 'POST',
				path: '/inference',
				headers: { authorization: OBFUSCATED, 'content-type': 'application/json' },
				body,
				text,
			},
			{
				method: 'POST',
				path: '/inference',
				headers: { authorization: `${OBFUSCATED}-wrong`, 'content-type': 'application/json' },
				body,
				text,
			},
		])
		// The refusal never entered the provider, so only the accepted request reached the daemon.
		expect(daemon.requests).toHaveLength(1)
	})

	it('appends through a log it does not own, so each route reports to the log it was built with', async () => {
		const first = new RequestLog()
		const second = new RequestLog()
		const dispatcher = createDispatcher<Record<string, never>>()
		dispatcher.add(buildRelayRoute(createOllama({ model: 'fixture-model' }), first))

		await dispatcher.handle(
			new Request('http://127.0.0.1/inference', { method: 'POST', body: '{}' }),
			{},
		)

		expect(first.entries.map((entry) => entry.path)).toEqual(['/inference'])
		expect(second.entries).toEqual([])
	})
})

describe('readModuleEntry', () => {
	it('reads a declared ESM root entry and refuses a manifest that declares none', () => {
		const declared = { exports: { '.': { import: { default: './dist/src/core/index.js' } } } }

		expect(readModuleEntry(declared)).toBe('dist/src/core/index.js')
		expect(readModuleEntry(undefined)).toBeUndefined()
		expect(readModuleEntry({})).toBeUndefined()
		expect(readModuleEntry({ exports: './index.js' })).toBeUndefined()
		expect(readModuleEntry({ exports: { '.': './index.js' } })).toBeUndefined()
		expect(
			readModuleEntry({ exports: { '.': { require: { default: './index.cjs' } } } }),
		).toBeUndefined()
		expect(
			readModuleEntry({ exports: { '.': { import: { types: './index.d.ts' } } } }),
		).toBeUndefined()
	})
})

describe('buildImportMap', () => {
	it('maps every installed package that declares an ESM root entry, plus the root package itself', () => {
		const scratch = createScratch({
			files: {
				'package.json': JSON.stringify({
					name: '@orkestrel/subject',
					exports: { '.': { import: { default: './dist/src/core/index.js' } } },
				}),
				'node_modules/@orkestrel/alpha/package.json': JSON.stringify({
					name: '@orkestrel/alpha',
					exports: { '.': { import: { default: './dist/src/core/index.js' } } },
				}),
				// The control: a package with no ESM root entry to serve is left out, so a map
				// that reported every directory it read would fail this case.
				'node_modules/@orkestrel/beta/package.json': JSON.stringify({
					name: '@orkestrel/beta',
					exports: { '.': { require: { default: './index.cjs' } } },
				}),
			},
		})
		try {
			expect(buildImportMap(scratch.path)).toEqual({
				'@orkestrel/alpha': `${MODULES_PATH}/alpha/dist/src/core/index.js`,
				'@orkestrel/subject': `${DIST_PATH}/src/core/index.js`,
			})
		} finally {
			scratch.destroy()
		}
	})

	it('lets the root package replace an installed entry of the same name', () => {
		const scratch = createScratch({
			files: {
				'package.json': JSON.stringify({
					name: '@orkestrel/alpha',
					exports: { '.': { import: { default: './dist/src/core/index.js' } } },
				}),
				'node_modules/@orkestrel/alpha/package.json': JSON.stringify({
					name: '@orkestrel/alpha',
					exports: { '.': { import: { default: './installed/index.js' } } },
				}),
				'node_modules/@orkestrel/omega/package.json': JSON.stringify({
					name: '@orkestrel/omega',
					exports: { '.': { import: { default: './dist/src/core/index.js' } } },
				}),
			},
		})
		try {
			const map = buildImportMap(scratch.path)

			expect(map).toEqual({
				'@orkestrel/alpha': `${DIST_PATH}/src/core/index.js`,
				'@orkestrel/omega': `${MODULES_PATH}/omega/dist/src/core/index.js`,
			})
			expect(Object.isFrozen(map)).toBe(true)
		} finally {
			scratch.destroy()
		}
	})

	it('maps this workspace and the closure its page imports', () => {
		const map = buildImportMap(WORKSPACE_ROOT)

		// Membership, not a total: the installed tree grows, and what this proof needs is that
		// every specifier the served page imports resolves.
		expect(map['@orkestrel/ollama']).toBe(`${DIST_PATH}/src/core/index.js`)
		for (const name of IMPORT_MAP_PACKAGES) {
			expect(map[`@orkestrel/${name}`]).toBe(`${MODULES_PATH}/${name}/dist/src/core/index.js`)
		}
	})
})

describe('PAGE_DOCUMENT', () => {
	it('carries the shared tool definition and the readiness flag in its served text', () => {
		// Presence guards, and nothing more: the served string carries the one tool definition
		// the model is advertised and the test asserts against, and the flag the session waits
		// for. What the page actually parks is a runtime fact this string cannot settle, so
		// `tests/service/page.test.ts` reads the operation table out of the real browser.
		expect(PAGE_DOCUMENT).toContain(JSON.stringify(PAGE_TOOL))
		expect(PAGE_DOCUMENT).toContain('globalThis.ready = true')
	})
})

describe('PAGE_OPERATIONS', () => {
	it('names each operation the served page declares as a method of its parked table', () => {
		// A presence guard: `tests/service/page.test.ts` reads the table out of the real browser and
		// compares it with this list, so the list is what the live page is measured against.
		const declared = PAGE_DOCUMENT.split('\n').flatMap((line) => {
			const method = /^\t\t(?:async )?(\w+)\(/u.exec(line)?.[1]
			return method === undefined ? [] : [method]
		})

		expect(PAGE_OPERATIONS).toEqual(declared)
		expect(Object.isFrozen(PAGE_OPERATIONS)).toBe(true)
	})
})

describe('acceptPageAttempt', () => {
	it('retries only a sampling miss and escapes every failure another launch cannot clear', () => {
		// Inert attempt records, built here rather than observed: the subject is the decision,
		// which is what `retryUntil` asks of its predicate. A predicate that answers `false`
		// spends another browser launch; one that throws ends the retry and fails the case.
		// The traffic an attempt retains is beside the point here, so every record carries the
		// same empty observations and differs only in what the page reported.
		const observed: PageAttempt = {
			receipts: [],
			resources: [],
			page: [],
			relay: [],
			daemon: [],
		}
		const dispatched: PageTool = {
			turn: 0,
			call: { id: 'call-1', name: PAGE_TOOL.name, arguments: { note: 'kyoto' } },
			result: { id: 'call-1', name: PAGE_TOOL.name, success: true, value: 'receipt-1' },
		}
		const answered: AgentResult = { content: 'the note is recorded', partial: false }

		// An attempt whose model completed its answer without dispatching the tool: the one
		// retry-worthy reading, because another launch can sample a different answer.
		expect(
			acceptPageAttempt({ ...observed, outcome: { turns: [0], tools: [], result: answered } }),
		).toBe(false)
		// An attempt whose model dispatched the tool: the reading the retry is waiting for.
		expect(
			acceptPageAttempt({
				...observed,
				outcome: { turns: [0, 1], tools: [dispatched], result: answered },
			}),
		).toBe(true)

		// An attempt the deadline interrupted mid-run reports a partial result and no tool call,
		// which is indistinguishable from a sampling miss by tool selection alone. The deadline
		// is the attempt's own, so another launch cannot clear it: refused before tool selection
		// is read at all, rather than spent as one of the remaining attempts.
		expect(
			captureError(() =>
				acceptPageAttempt({
					...observed,
					outcome: { turns: [0], tools: [], result: { content: 'starting', partial: true } },
				}),
			),
		).toEqual(new Error('the page run was interrupted before it settled: starting'))
		// A partial run that did dispatch the tool is refused on the same reading, because the
		// interruption is what the attempt reports rather than the sample.
		expect(
			captureError(() =>
				acceptPageAttempt({
					...observed,
					outcome: {
						turns: [0, 1],
						tools: [dispatched],
						result: { content: 'starting', partial: true },
					},
				}),
			),
		).toEqual(new Error('the page run was interrupted before it settled: starting'))

		// A relay that answered HTTP 500 reaches the predicate as a serialized run failure. It
		// is not a sampling miss, so retrying it would spend the remaining attempts and report
		// the exhaustion as the model never choosing the tool.
		expect(
			captureError(() =>
				acceptPageAttempt({
					...observed,
					outcome: {
						turns: [0],
						tools: [],
						failure: 'ProviderError: HTTP 500',
						code: 'HTTP',
						status: 500,
					},
				}),
			),
		).toEqual(new Error('the page run failed: ProviderError: HTTP 500'))
		// A fixture fault reaches it the same way, as the failure the page reported.
		expect(
			captureError(() =>
				acceptPageAttempt({
					...observed,
					outcome: { turns: [0], tools: [], failure: 'TypeError: Failed to fetch' },
				}),
			),
		).toEqual(new Error('the page run failed: TypeError: Failed to fetch'))
		// An evaluate that rejected — an acquisition, a read, or a release that threw — leaves
		// the attempt unobserved, so its traffic was never retained and nothing can assert it.
		expect(
			captureError(() =>
				acceptPageAttempt({ ...observed, fault: 'BrowserError: the page is gone' }),
			),
		).toEqual(new Error('the page attempt could not be observed: BrowserError: the page is gone'))
		// A fault the producer failed to record leaves neither reading: refused rather than
		// treated as a miss.
		expect(captureError(() => acceptPageAttempt(observed))).toEqual(
			new Error('the page attempt retained no outcome and no fault'),
		)
		// An outcome carrying neither a settled result nor a failure is refused the same way:
		// only a completed answer can be read for tool selection.
		expect(
			captureError(() => acceptPageAttempt({ ...observed, outcome: { turns: [], tools: [] } })),
		).toEqual(new Error('the page attempt reported neither a result nor a failure'))
	})
})

describe('readOutcome', () => {
	it('narrows a JSON string across the evaluate boundary and refuses every other reading', async () => {
		// The boundary stub implements the one member the reader crosses — `evaluate` — and
		// answers with the strings a real page answers with. The subject is the narrowing.
		const answers: Array<readonly [string, BrowserCallOptions | undefined]> = []
		const page = createOutcomePage(answers)

		const { signal } = new AbortController()
		const call = { timeout: PAGE_BOUNDS.read, signal }
		expect(await readOutcome(page, 'ok', isPageControl, call)).toEqual({
			status: 200,
			text: 'control',
		})
		// The caller's deadline and the attempt's signal reach the boundary, so a read spends the
		// allowance its caller counted and ends when the attempt does.
		expect(answers).toEqual([['ok', { timeout: PAGE_BOUNDS.read, signal }]])
		expect(answers[0]?.[1]?.signal).toBe(signal)

		// A reading that is not a string at all.
		await expect(readOutcome(page, 'absent', isPageControl, call)).rejects.toThrow(
			'the page expression absent returned undefined, not a string',
		)
		// A reading that is a string of JSON the guard refuses.
		const mismatched = createStaticOutcomePage('{"status":"200"}')
		await expect(readOutcome(mismatched, 'wrong', isPageControl, call)).rejects.toThrow(
			'returned an unexpected shape: {"status":"200"}',
		)
		// A reading that is a string but not JSON.
		const unparsed = createStaticOutcomePage('control')
		await expect(readOutcome(unparsed, 'raw', isPageControl, call)).rejects.toThrow(
			'returned an unexpected shape: control',
		)
		// A guard that accepts it narrows to that guard's type rather than to `unknown`.
		const text = createStaticOutcomePage('"receipt-1"')
		expect((await readOutcome(text, 'text', isString, call)).startsWith('receipt-')).toBe(true)
	})
})

describe('readLoopClock', () => {
	it('advances in whole milliseconds by the time performance.now() measures between readings', () => {
		const opened = performance.now()
		const before = readLoopClock()
		const inner = performance.now()
		alignLoopClock(5)
		const outer = performance.now()
		const after = readLoopClock()
		const closed = performance.now()
		expect(Number.isInteger(before)).toBe(true)
		expect(Number.isInteger(after)).toBe(true)
		// Each reading truncates by under 1 ms and a coarse clock trails by under 1 ms more.
		expect(after - before).toBeGreaterThan(outer - inner - 2)
		expect(after - before).toBeLessThan(closed - opened + 2)
	})
})

describe('alignLoopClock', () => {
	it('returns after the loop clock ticks and the offset elapses on performance.now()', () => {
		const before = readLoopClock()
		const opened = performance.now()
		alignLoopClock(0.5)
		const closed = performance.now()
		expect(readLoopClock()).toBeGreaterThan(before)
		expect(closed - opened).toBeGreaterThanOrEqual(0.5)
	})
})

describe('expirePageAttempt', () => {
	it('rejects with the attempt-wide deadline error and parks forever while the allowance holds', async () => {
		// The losing side of the race `boundPageAttempt` runs. Its whole job is the translation:
		// a caller reads the attempt's own allowance being exceeded rather than whichever browser
		// call ended first; `boundPageAttempt` states which calls the signal reaches.
		const expired = expirePageAttempt(AbortSignal.timeout(20), 20)
		await expect(expired).rejects.toThrow('the page attempt exceeded its 20 ms allowance')

		// An allowance already gone rejects on the same reading rather than waiting for a
		// second abort that will never arrive.
		const reason = new Error('the attempt was already over')
		await expect(expirePageAttempt(AbortSignal.abort(reason), 95_000)).rejects.toThrow(
			'the page attempt exceeded its 95000 ms allowance',
		)
		// The abort's own reason is retained as the cause, so the reading that ended the attempt
		// survives the translation.
		const failure = await expirePageAttempt(AbortSignal.abort(reason), 50).catch(
			(thrown: unknown) => thrown,
		)
		expect(failure).toBeInstanceOf(Error)
		expect(failure instanceof Error ? failure.cause : undefined).toBe(reason)

		// While the allowance holds, this side never settles: the work wins the race on its own
		// result. A promise that rejected eagerly would end every attempt at its first await.
		const controller = new AbortController()
		expect(
			await Promise.race([
				expirePageAttempt(controller.signal, 95_000),
				Promise.resolve('the work settled first'),
			]),
		).toBe('the work settled first')
		controller.abort(new Error('the proof is over'))
		await expect(expirePageAttempt(controller.signal, 95_000)).rejects.toThrow(
			'the page attempt exceeded its 95000 ms allowance',
		)
	})
})

describe('racePageAttempt', () => {
	it('returns the step while the allowance holds and passes its own failure unchanged', async () => {
		const { signal } = new AbortController()
		expect(await racePageAttempt(Promise.resolve('the page answered'), signal, 500)).toBe(
			'the page answered',
		)
		const fault = new Error('the page reported a fault')
		await expect(racePageAttempt(Promise.reject(fault), signal, 500)).rejects.toBe(fault)
	})

	it('reports the allowance for a step that parks past it or rejects with the abort reason', async () => {
		const parked = racePageAttempt(new Promise<never>(() => undefined), AbortSignal.timeout(20), 20)
		await expect(parked).rejects.toThrow('the page attempt exceeded its 20 ms allowance')
		const reason = new Error('the attempt was already over')
		const aborted = AbortSignal.abort(reason)
		const failure = await racePageAttempt(Promise.reject(reason), aborted, 20).catch(
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(failure)).toBe('the page attempt exceeded its 20 ms allowance')
		expect(isError(failure) ? failure.cause : undefined).toBe(reason)
		// Only the abort reason itself is the allowance; another failure after the abort is the
		// step's own.
		const fault = new Error('the page reported a fault')
		await expect(racePageAttempt(Promise.reject(fault), aborted, 20)).rejects.toBe(fault)
	})
})

describe('describeFailure', () => {
	it('reads an error message and falls back to the string form of anything else', () => {
		expect(describeFailure(new Error('the release outlasted its share'))).toBe(
			'the release outlasted its share',
		)
		// A thrown value is `unknown` at the boundary `boundPageAttempt` composes two failures
		// at, so a non-error carries its own reading into the composed message rather than
		// collapsing to an empty one.
		expect(describeFailure('the driver rejected with a string')).toBe(
			'the driver rejected with a string',
		)
		expect(describeFailure(undefined)).toBe('undefined')
	})
})

describe('releasePageAttempt', () => {
	it('releases inside its share, reports a stranded browser past it, and reports its own failure', async () => {
		// A settled acquisition is released, which is the ordinary path every attempt takes.
		const destroyed = createRecorder()
		await releasePageAttempt(
			Promise.resolve({ destroy: () => Promise.resolve(destroyed.handler()) }),
			500,
		)
		expect(destroyed.calls).toEqual([[]])

		// An acquisition that rejected released whatever it took on its own way out, so there is
		// nothing here to release and its failure is the caller's to report, not this one's.
		await releasePageAttempt(Promise.reject(new Error('the acquisition failed')), 500)

		// A release that outlasts its share names the browser it stranded rather than waiting on
		// it. This is the reading that separates a residue the host can settle from a hang.
		const stranded = await releasePageAttempt(
			Promise.resolve({ destroy: () => new Promise<void>(() => undefined) }),
			30,
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(stranded)).toBe(
			"the page attempt's release outlasted its 30 ms share, stranding the browser",
		)

		// An acquisition still in flight past the share strands on the same reading, because the
		// browser it is holding is equally out of reach.
		const held = await releasePageAttempt(new Promise(() => undefined), 30).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(held)).toBe(
			"the page attempt's release outlasted its 30 ms share, stranding the browser",
		)

		// A release that fails inside its share reports its own failure, which is a different
		// reading from a browser nobody could reach.
		const refused = await releasePageAttempt(
			Promise.resolve({ destroy: () => Promise.reject(new Error('the browser refused to close')) }),
			500,
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(refused)).toBe('the browser refused to close')
	})
})

describe('boundPageAttempt', () => {
	it('returns what a satisfied attempt observed and releases the session it acquired', async () => {
		const destroyed = createRecorder()
		const signals: AbortSignal[] = []
		expect(
			await boundPageAttempt(
				{ attempt: 500, release: 500 },
				(signal) => {
					signals.push(signal)
					return Promise.resolve({ destroy: () => Promise.resolve(destroyed.handler()) })
				},
				(session, signal) => {
					signals.push(signal)
					return Promise.resolve(session === undefined ? 'no session' : 'the page answered')
				},
			),
		).toBe('the page answered')
		expect(destroyed.calls).toEqual([[]])
		// One deadline reaches the acquisition and the observation, so a wait either of them
		// parks on ends at the attempt's deadline rather than at its own budget.
		expect(signals[0]).toBe(signals[1])

		// An observation that fails reports its own failure, and the session it was given is
		// still released.
		const failed = createRecorder()
		const refused = await boundPageAttempt(
			{ attempt: 500, release: 500 },
			() => Promise.resolve({ destroy: () => Promise.resolve(failed.handler()) }),
			() => Promise.reject(new Error('the page reported a fault')),
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(refused)).toBe('the page reported a fault')
		expect(failed.calls).toEqual([[]])
	})

	it('reports its allowance when a call that took the attempt signal rejects with its reason', async () => {
		// A page command given the attempt's signal rejects with `signal.reason` when it aborts,
		// and that rejection can settle the race before the expiry does. The attempt still reads
		// as its allowance, with the reason as the cause.
		const released = createRecorder()
		const aborted = await boundPageAttempt(
			{ attempt: 30, release: 500 },
			() => Promise.resolve({ destroy: () => Promise.resolve(released.handler()) }),
			async (_session, signal) => {
				await waitForAbort(signal)
				throw signal.reason
			},
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(aborted)).toBe('the page attempt exceeded its 30 ms allowance')
		if (!isError(aborted)) throw new Error('the attempt reported no error')
		const reason = aborted.cause
		if (!isError(reason)) throw new Error('the attempt reported no abort reason')
		expect(reason.name).toBe('TimeoutError')
		expect(released.calls).toEqual([[]])
	})

	it('reports its allowance and the browser it stranded when the acquisition never settles', async () => {
		// An acquisition that never settles. The attempt reports its own allowance and names the
		// browser it could not reach, and it arrives rather than hanging: an attempt that awaited
		// the losing acquisition would still be waiting here, which is what the installed
		// `BrowserContext` produces when a page command it issued outlives the deadline.
		const bounds = { attempt: 50, release: 100 }
		const parked = performance.now()
		const abandoned = await boundPageAttempt(
			bounds,
			() => new Promise<never>(() => undefined),
			() => Promise.resolve('unreached'),
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(abandoned)).toBe(
			"the page attempt exceeded its 50 ms allowance, and the page attempt's release outlasted its 100 ms share, stranding the browser",
		)
		// The inner failure stays reachable: the composed message reads as one sentence, and the
		// attempt's own failure — not the strand composed onto it — is what a caller unwrapping
		// the cause finds.
		if (!isError(abandoned)) throw new Error('the attempt reported no error')
		expect(abandoned.cause).toBeInstanceOf(Error)
		expect(describeFailure(abandoned.cause)).toBe('the page attempt exceeded its 50 ms allowance')
		// The elapsed total is the claim: the attempt waits out both deadlines in turn and ends
		// there, rather than returning early or waiting on what it cannot reach.
		const elapsed = performance.now() - parked
		expect(elapsed).toBeGreaterThanOrEqual(bounds.attempt + bounds.release - TIMER_LEAD)
		expect(elapsed).toBeLessThan(bounds.attempt + bounds.release + SCHEDULE_SLACK)
	})

	it('releases the acquisition its deadline outran when it settles inside the release share', async () => {
		// An acquisition that settles after the deadline but inside the release share. The
		// attempt reports its own allowance alone, and the browser that acquisition was holding
		// is released rather than abandoned.
		const late = createRecorder()
		const delayed = await boundPageAttempt(
			{ attempt: 30, release: 500 },
			async () => {
				await waitForDelay(80)
				return { destroy: () => Promise.resolve(late.handler()) }
			},
			() => Promise.resolve('unreached'),
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(delayed)).toBe('the page attempt exceeded its 30 ms allowance')
		expect(late.calls).toEqual([[]])
	})

	it('reports a release that parks past its share instead of waiting on it', async () => {
		// A release that parks past its share, with the allowance still holding. The attempt
		// reports the release rather than waiting on it, because a browser it cannot reach is a
		// residue reading the host can take and a hang is not.
		const bounds = { attempt: 2_000, release: 50 }
		const held = performance.now()
		const stranded = await boundPageAttempt(
			bounds,
			() => Promise.resolve({ destroy: () => new Promise<void>(() => undefined) }),
			() => Promise.resolve('the page answered'),
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(stranded)).toBe(
			"the page attempt's release outlasted its 50 ms share, stranding the browser",
		)
		// The acquisition and the observation settle at once here, so the release share is the
		// only deadline that elapses: the attempt waits it out and ends there, well inside the
		// allowance it never spends.
		const elapsed = performance.now() - held
		expect(elapsed).toBeGreaterThanOrEqual(bounds.release - TIMER_LEAD)
		expect(elapsed).toBeLessThan(bounds.release + SCHEDULE_SLACK)
	})

	it('refuses an attempt whose release crossed its allowance', async () => {
		// An observation that completed while the allowance held, with the release crossing it.
		// The attempt's elapsed total is what the allowance is about, so this is a failure naming
		// the release rather than the success the observation on its own would report.
		const crossed = await boundPageAttempt(
			{ attempt: 30, release: 500 },
			() => Promise.resolve({ destroy: () => waitForDelay(80) }),
			() => Promise.resolve('the page answered'),
		).then(
			() => undefined,
			(thrown: unknown) => thrown,
		)
		expect(describeFailure(crossed)).toBe(
			'the page attempt released its browser after its 30 ms allowance had expired',
		)
		// What expired stays reachable as the cause: `AbortSignal.timeout` aborts with a
		// `TimeoutError`, so a caller reading the cause finds the deadline rather than a second
		// copy of the message.
		if (!isError(crossed)) throw new Error('the attempt reported no error')
		const reason = crossed.cause
		if (!isError(reason)) throw new Error('the attempt reported no abort reason')
		expect(reason.name).toBe('TimeoutError')
	})
})

describe('PAGE_BOUNDS', () => {
	it('declares the two shares one attempt spends and the shares inside them, never a schedule of operations', () => {
		// The membership, asserted whole: the allowance the acquisition and the observation are
		// raced against, the share the release after it is raced against, the per-call shares
		// spent inside them, and the retry's own bounds. No count over the dependency's
		// operations appears, because `boundPageAttempt` races the lifecycle rather than summing
		// per-call values — a sum the installed `@orkestrel/browser` surface cannot support,
		// because one of its calls issues several separately bounded CDP commands.
		expect(Object.keys(PAGE_BOUNDS)).toEqual([
			'command',
			'ready',
			'read',
			'run',
			'evaluate',
			'attempt',
			'release',
			'case',
			'launches',
			'budget',
			'retry',
		])
		// Every per-call share is spent inside the one allowance, so no share can outlast the
		// attempt that races it.
		expect(PAGE_BOUNDS.command).toBeLessThan(PAGE_BOUNDS.attempt)
		expect(PAGE_BOUNDS.ready).toBeLessThan(PAGE_BOUNDS.attempt)
		expect(PAGE_BOUNDS.read).toBeLessThan(PAGE_BOUNDS.attempt)
		expect(PAGE_BOUNDS.evaluate).toBeLessThan(PAGE_BOUNDS.attempt)
		// The release share holds a browser release, whose own CDP requests take `command`.
		expect(PAGE_BOUNDS.command).toBeLessThanOrEqual(PAGE_BOUNDS.release)
		// What one attempt ends within — its allowance plus its release share — fits the case
		// that holds one attempt.
		expect(PAGE_BOUNDS.attempt + PAGE_BOUNDS.release).toBeLessThanOrEqual(PAGE_BOUNDS.case)
		// The innermost bound fires first: the in-page deadline before the evaluate around it,
		// and an instant read never outlasts the run it follows.
		expect(PAGE_BOUNDS.run).toBeLessThan(PAGE_BOUNDS.evaluate)
		expect(PAGE_BOUNDS.read).toBeLessThan(PAGE_BOUNDS.evaluate)
		// The bounded retry ends on its launch count, never on an expired budget: every launch
		// it allows fits inside the budget whole, and the budget inside the case it runs in.
		expect(PAGE_BOUNDS.launches * (PAGE_BOUNDS.attempt + PAGE_BOUNDS.release)).toBeLessThanOrEqual(
			PAGE_BOUNDS.budget,
		)
		expect(PAGE_BOUNDS.budget).toBeLessThanOrEqual(PAGE_BOUNDS.retry)
		expect(Object.isFrozen(PAGE_BOUNDS)).toBe(true)
	})
})

describe('PAGE_INTERVALS', () => {
	it('orders the allowances the attempt-bound controls spend and contains the delay beside them', () => {
		// The membership, asserted whole: the allowances chosen to expire at a named point of a
		// real attempt, and the delay a control adds to one step to keep it in flight past the
		// allowance beside it.
		expect(Object.keys(PAGE_INTERVALS)).toEqual(['launch', 'observe', 'late', 'hold'])
		// The order each control's reading depends on. `launch` expires before any acquisition
		// completes; `late` outlasts an acquisition and nothing more; `observe` outlasts the
		// acquisition by enough that the deadline lands in the observation instead.
		expect(PAGE_INTERVALS.launch).toBeLessThan(PAGE_INTERVALS.late)
		expect(PAGE_INTERVALS.late).toBeLessThan(PAGE_INTERVALS.observe)
		// The held step crosses the allowance it is added to, which is the whole point of the
		// delayed-acquisition and crossed-release controls: a `hold` inside `late` would let both
		// attempts finish on time and pass their cases vacuously.
		expect(PAGE_INTERVALS.late).toBeLessThan(PAGE_INTERVALS.hold)
		// And it is contained by the share the release is raced against, so the step it delays
		// still finishes inside that share. A `hold` past `release` would report a stranded
		// browser instead of the crossing each control names.
		expect(PAGE_INTERVALS.hold).toBeLessThan(PAGE_BOUNDS.release)
		// Every control asserts its elapsed call against its own allowance plus that share, and
		// runs under the case bound, so each pair fits the case.
		for (const allowance of PAGE_ALLOWANCES) {
			expect(allowance + PAGE_BOUNDS.release).toBeLessThanOrEqual(PAGE_BOUNDS.case)
		}
		expect(Object.isFrozen(PAGE_INTERVALS)).toBe(true)
	})
})

describe('serveFile', () => {
	it('serves a contained file, refuses an escape, and reports a miss', async () => {
		const scratch = createScratch({ files: { 'entry.js': 'export const value = 1\n' } })
		try {
			const served = serveFile(scratch.path, 'entry.js')
			expect(served.status).toBe(200)
			expect(served.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
			expect(await served.text()).toBe('export const value = 1\n')

			expect(serveFile(scratch.path, '../escape.js').status).toBe(404)
			expect(serveFile(scratch.path, 'absent.js').status).toBe(404)
		} finally {
			scratch.destroy()
		}
	})
})

describe('createPageFixture', () => {
	it('serves the page, the module tree, and the control route, and mounts no relay without a provider', async () => {
		const fixture = await createPageFixture({ document: PAGE_DOCUMENT })
		try {
			const page = await fetch(fixture.url)
			expect(page.status).toBe(200)
			expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
			const html = await page.text()
			// The derived map and the shared tool definition both reach the served document.
			expect(html).toContain('<script type="importmap">')
			expect(html).toContain(`${MODULES_PATH}/agent/dist/src/core/index.js`)
			expect(html).toContain(JSON.stringify(PAGE_TOOL))
			// No favicon request: the page declares an inert icon, so the browser asks for none.
			expect(html).toContain('<link rel="icon" href="data:,">')

			const module = await fetch(`${fixture.url}${MODULES_PATH}/contract/dist/src/core/index.js`)
			expect(module.status).toBe(200)
			expect(module.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
			expect((await module.text()).length).toBeGreaterThan(0)

			expect((await fetch(`${fixture.url}${MODULES_PATH}/absent/index.js`)).status).toBe(404)

			const control = await fetch(`${fixture.url}${CONTROL_PATH}`)
			expect(control.status).toBe(200)
			expect(control.headers.get('cache-control')).toBe('no-store')
			expect(await control.text()).toBe('control')

			// No provider, no relay route: the fixture answers the inference path with the
			// dispatcher's own miss rather than relaying.
			expect((await fetch(`${fixture.url}/inference`, { method: 'POST', body: '{}' })).ok).toBe(
				false,
			)

			expect(fixture.requests.map((request) => request.path)).toEqual([
				'/',
				`${MODULES_PATH}/contract/dist/src/core/index.js`,
				`${MODULES_PATH}/absent/index.js`,
				CONTROL_PATH,
			])
		} finally {
			await fixture.stop()
		}
	})

	it('mounts the same authenticated relay route the relay server mounts when given a provider', async () => {
		const daemon = createRecordingTransport(
			createStreamingTransport(['{"message":{"content":"answer"}}\n']),
		)
		const fixture = await createPageFixture({
			document: PAGE_DOCUMENT,
			provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
		})
		try {
			const body = JSON.stringify({ messages: [{ id: 'q', role: 'user', content: 'Hello' }] })
			const accepted = await fetch(`${fixture.url}/inference`, {
				method: 'POST',
				headers: { authorization: OBFUSCATED },
				body,
			})
			expect(accepted.status).toBe(200)
			expect(createNDJSONParser().parse(await accepted.text())).toEqual([
				{ channel: 'content', text: 'answer' },
				{ channel: 'result', result: { content: 'answer' } },
			])

			const refused = await fetch(`${fixture.url}/inference`, {
				method: 'POST',
				headers: { authorization: `${OBFUSCATED}-wrong` },
				body,
			})
			expect(refused.status).toBe(401)
			// The refusal never entered the provider, so the daemon transport saw one call.
			expect(daemon.requests).toHaveLength(1)
			expect(fixture.requests.map((request) => request.path)).toEqual(['/inference', '/inference'])
		} finally {
			await fixture.stop()
		}
	})
})

describe('the page session release order', () => {
	it('stops a real fixture through the teardown registry when the release before it rejects', async () => {
		// The control, drawn from outside the registry: the sequential shape — release the
		// browser, then stop the fixture — leaves a real listener bound when the first release
		// rejects, which is the defect the registry exists to close.
		const stranded = await createPageFixture({ document: PAGE_DOCUMENT })
		const sequential = await Promise.reject(new Error('the browser refused to be released'))
			.then(() => stranded.stop())
			.then(
				() => undefined,
				(failure: unknown) => failure,
			)
		expect(String(sequential)).toContain('the browser refused to be released')
		expect((await fetch(stranded.url)).status).toBe(200)
		await stranded.stop()

		// The registry `createPageSession` uses: every release runs, newest first, and the
		// failure is still reported.
		const released: string[] = []
		const teardown = createTeardown()
		const fixture = await createPageFixture({ document: PAGE_DOCUMENT })
		teardown.add(async () => {
			released.push('fixture')
			await fixture.stop()
		})
		teardown.add(() => {
			released.push('browser')
			throw new Error('the browser refused to be released')
		})

		await expect(teardown.destroy()).rejects.toThrow('the browser refused to be released')

		expect(released).toEqual(['browser', 'fixture'])
		await expect(fetch(fixture.url)).rejects.toThrow('fetch failed')
	})

	it('releases a real fixture when the acquisition registered after it rejects', async () => {
		// Partial acquisition: the fixture is listening and its stop is registered, and the
		// step `createPageSession` takes next — the port reservation — is made to fail. The
		// caller's catch releases what was already taken and reports the acquisition failure.
		const teardown = createTeardown()
		const fixture = await createPageFixture({ document: PAGE_DOCUMENT })
		teardown.add(() => fixture.stop())
		const { url } = fixture
		const acquired = await Promise.reject(new Error('the port reservation failed')).then(
			() => undefined,
			async (failure: unknown) => {
				await Promise.allSettled([teardown.destroy()])
				return failure
			},
		)

		expect(String(acquired)).toContain('the port reservation failed')
		await expect(fetch(url)).rejects.toThrow('fetch failed')
	})
})

describe('reservePort', () => {
	it('returns a free loopback port a listener can then bind', async () => {
		const port = await reservePort()

		expect(Number.isInteger(port)).toBe(true)
		expect(port).toBeGreaterThan(0)
		expect(port).toBeLessThan(65_536)
		// The number is genuinely free at the moment it is returned: a listener takes it.
		const taken = createNetServer()
		try {
			await new Promise<void>((resolve, reject) => {
				taken.on('error', reject)
				taken.listen(port, '127.0.0.1', resolve)
			})
		} finally {
			await new Promise<void>((resolve) => taken.close(() => resolve()))
		}
	})

	it('hands out a port other than one a listener holds, so it is not a fixed number', async () => {
		const held = createNetServer()
		try {
			const first = await reservePort()
			await new Promise<void>((resolve, reject) => {
				held.on('error', reject)
				held.listen(first, '127.0.0.1', resolve)
			})

			const second = await reservePort()

			expect(second).not.toBe(first)
		} finally {
			await new Promise<void>((resolve) => held.close(() => resolve()))
		}
	})
})

describe('the page outcome guards', () => {
	it('narrow a settled run, a failed run, the receipts, the control, and the generation', () => {
		const call = { id: 'call-1', name: PAGE_TOOL.name, arguments: { note: 'kyoto' } }
		const settled = {
			turns: [0, 1],
			tools: [
				{
					turn: 0,
					call,
					result: { id: 'call-1', name: PAGE_TOOL.name, success: true, value: 'r' },
				},
			],
			result: { content: 'done', partial: false },
		}
		const failed = {
			turns: [0],
			tools: [],
			failure: 'ProviderError: HTTP 401',
			code: 'HTTP',
			status: 401,
		}

		expect(isPageOutcome(settled)).toBe(true)
		expect(isPageOutcome(failed)).toBe(true)
		// Each refusal names one malformed field, so a guard that stopped reading after the
		// first would fail one of these.
		expect(isPageOutcome({ turns: ['0'], tools: [] })).toBe(false)
		expect(
			isPageOutcome({ turns: [0], tools: [{ turn: 0, call, result: { id: 'call-1' } }] }),
		).toBe(false)
		// The turn a call was dispatched in is what pins the feedback to the request after it,
		// so a call reporting none is refused rather than narrowed.
		expect(
			isPageOutcome({
				turns: [0],
				tools: [
					{ call, result: { id: 'call-1', name: PAGE_TOOL.name, success: true, value: 'r' } },
				],
			}),
		).toBe(false)
		expect(isPageOutcome({ turns: [0], tools: [], result: { content: 'done' } })).toBe(false)
		expect(isPageOutcome({ turns: [0], tools: [], failure: 7 })).toBe(false)
		// Absence is `undefined`: a failure reporting `null` for either field is off-shape,
		// because the type it narrows to declares neither as nullable.
		expect(isPageOutcome({ turns: [0], tools: [], failure: 'boom', code: null })).toBe(false)
		expect(isPageOutcome({ turns: [0], tools: [], failure: 'boom', status: null })).toBe(false)
		expect(isPageOutcome({ turns: [0], tools: [], failure: 'boom' })).toBe(true)
		expect(isPageOutcome(undefined)).toBe(false)

		expect(isToolOutcome({ id: 'c', name: 'n', success: false, error: 'boom' })).toBe(true)
		expect(isToolOutcome({ id: 'c', name: 'n', success: false })).toBe(false)
		expect(isAgentOutcome({ content: 'done', partial: false })).toBe(true)
		expect(isAgentOutcome({ content: 'done' })).toBe(false)

		expect(isPageReceipts([{ note: 'kyoto', receipt: 'receipt-1' }])).toBe(true)
		expect(isPageReceipts([{ note: 'kyoto' }])).toBe(false)
		expect(isPageControl({ status: 200, text: 'control' })).toBe(true)
		expect(isPageControl({ status: '200', text: 'control' })).toBe(false)
		expect(isPageGeneration({ name: 'ollama', content: 'hi' })).toBe(true)
		expect(isPageGeneration({ name: 'ollama' })).toBe(false)
	})
})

describe('resolveDaemonDeclaration', () => {
	it('uses a validated explicit declaration before any executable or service lookup', async () => {
		expect(
			await resolveDaemonDeclaration({
				host: 'not-an-origin',
				model: 'absent',
				executable: 'absent',
				declaration: JSON.stringify(DAEMON_DECLARATION),
			}),
		).toEqual(DAEMON_DECLARATION)
		await expect(
			resolveDaemonDeclaration({ host: 'not-an-origin', model: 'absent', declaration: '' }),
		).rejects.toThrow('OLLAMA_DAEMON_DECLARATION is invalid')
	})

	it('derives canonical executable bytes, the daemon version, the inventory digest, and a distinct loopback endpoint without generation', async () => {
		const peer = await createDaemonPeer()
		try {
			const declaration = await resolveDaemonDeclaration({
				host: peer.url,
				model: DAEMON_MODEL.name,
				executable: process.execPath,
			})
			expect(declaration.executable).toEqual({
				path: realpathSync(process.execPath),
				digest: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
				version: DAEMON_VERSION,
			})
			expect(declaration.models).toEqual([DAEMON_MODEL])
			expect(declaration.workspace).toBe(realpathSync(process.cwd()))
			const dedicated = new URL(declaration.url)
			expect(dedicated.hostname).toBe('127.0.0.1')
			expect(dedicated.port).not.toBe('11434')
			expect(dedicated.port).not.toBe(new URL(peer.url).port)
			expect(peer.requests).toEqual([
				{ path: '/api/version', body: '' },
				{ path: '/api/tags', body: '' },
			])
		} finally {
			await peer.destroy()
		}
	})

	it('resolves the PATH executable without spawning it', async () => {
		const scratch = createScratch()
		const peer = await createDaemonPeer()
		try {
			const path = scratch.write(
				process.platform === 'win32' ? 'ollama.exe' : 'ollama',
				'MZ inert executable identity fixture',
			)
			chmodSync(path, 0o755)
			const declaration = await resolveDaemonDeclaration({
				host: peer.url,
				model: DAEMON_MODEL.name,
				environment: { PATH: scratch.path, PATHEXT: '.EXE' },
			})
			expect(declaration.executable.path).toBe(realpathSync.native(path))
			expect(declaration.executable.digest).toBe(
				createHash('sha256').update('MZ inert executable identity fixture').digest('hex'),
			)
		} finally {
			await peer.destroy()
			scratch.destroy()
		}
	})

	it('fails before metadata when PATH names no executable', async () => {
		await expect(
			resolveDaemonDeclaration({
				host: 'not-an-origin',
				model: 'absent',
				environment: { PATH: '', PATHEXT: '.EXE' },
			}),
		).rejects.toThrow('Set OLLAMA_DAEMON_EXECUTABLE or install ollama on PATH')
	})

	for (const row of DAEMON_SERVICE_REFUSALS) {
		it(`refuses provisioned metadata: ${JSON.stringify(row.options)}`, async () => {
			const peer = await createDaemonPeer(row.options)
			try {
				await expect(
					resolveDaemonDeclaration({
						host: peer.url,
						model: DAEMON_MODEL.name,
						executable: process.execPath,
					}),
				).rejects.toThrow(row.message)
			} finally {
				await peer.destroy()
			}
		})
	}
})

describe('buildUncachedResponse', () => {
	it('preserves the body and media type with the default or explicit status', async () => {
		const normal = buildUncachedResponse('control', 'text/plain; charset=utf-8')
		expect(normal.status).toBe(200)
		expect(normal.headers.get('cache-control')).toBe('no-store')
		expect(normal.headers.get('content-type')).toBe('text/plain; charset=utf-8')
		expect(await normal.text()).toBe('control')
		const missing = buildUncachedResponse('<h1>Not found</h1>', 'text/html; charset=utf-8', 404)
		expect(missing.status).toBe(404)
		expect(missing.headers.get('cache-control')).toBe('no-store')
		expect(missing.headers.get('content-type')).toBe('text/html; charset=utf-8')
		expect(await missing.text()).toBe('<h1>Not found</h1>')
	})
})

describe('CallCounter', () => {
	it('numbers each call from one and reports how many it numbered', () => {
		const calls = new CallCounter()

		expect(calls.count).toBe(0)
		expect([calls.next(), calls.next(), calls.next()]).toEqual([1, 2, 3])
		expect(calls.count).toBe(3)
		// Each counter owns its own tally.
		expect(new CallCounter().next()).toBe(1)
	})
})

describe('RequestLog', () => {
	it('appends records in order and shows a later append through an earlier read', () => {
		const log = new RequestLog()
		const earlier = log.entries
		const first: RecordedRequest = { method: 'GET', path: '/a', headers: {}, body: {}, text: '' }
		const second: RecordedRequest = {
			method: 'POST',
			path: '/b',
			headers: { 'x-trace': 'log' },
			body: { n: 1 },
			text: '{"n":1}',
		}

		log.add(first)
		log.add(second)

		expect(earlier).toEqual([first, second])
		expect(log.entries).toEqual([first, second])
		expect(new RequestLog().entries).toEqual([])
	})

	it('builds the relay route at the inference path', () => {
		const route = new RequestLog().relay(createOllama({ model: 'fixture-model' }))

		expect(route.method).toBe('POST')
		expect(route.path).toBe('/inference')
	})
})

describe('RecordingServer', () => {
	it('exposes the log it was given, keeps its address after stop, and aborts parked work on stop', async () => {
		const log = new RequestLog()
		const parked = new AbortController()
		const server = createServer({
			dispatcher: createDispatcher<Record<string, never>>(),
			state: () => ({}),
			host: '127.0.0.1',
		})
		const recording = new RecordingServer(log, server, await server.start(), parked)
		const { url } = recording
		const record: RecordedRequest = { method: 'GET', path: '/a', headers: {}, body: {}, text: '' }
		log.add(record)

		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
		expect(recording.requests).toEqual([record])
		expect(parked.signal.aborted).toBe(false)

		await recording.stop()

		expect(parked.signal.aborted).toBe(true)
		expect(recording.url).toBe(url)
		await expect(fetch(url)).rejects.toThrow('fetch failed')
	})
})

describe('PageObserver', () => {
	it('retains each report in hook order and shows a later report through an earlier read', () => {
		const observer = new PageObserver()
		const { requests, errors, messages } = observer
		const request: BrowserRequest = {
			id: 'request-1',
			loader: undefined,
			frame: undefined,
			url: 'http://127.0.0.1/control',
			method: 'GET',
			headers: {},
			post: undefined,
			resource: undefined,
			timestamp: undefined,
			walltime: undefined,
			redirect: undefined,
		}
		const failed: BrowserPageError = { message: 'first fault', stack: [], timestamp: 1 }
		const refused: BrowserPageError = { message: 'second fault', stack: [], timestamp: 2 }
		const logged: BrowserConsoleMessage = {
			level: 'error',
			text: 'logged',
			values: [],
			timestamp: 3,
			stack: [],
		}

		observer.on.error(failed)
		observer.on.request(request)
		observer.on.console(logged)
		observer.on.error(refused)

		expect(requests).toEqual([request])
		expect(errors).toEqual([failed, refused])
		expect(messages).toEqual([logged])
		expect(new PageObserver().errors).toEqual([])
	})
})

describe('findFileText', () => {
	it('reads a file as text and reports every failed read as undefined', () => {
		const scratch = createScratch({
			files: { 'entry.js': 'export const value = 1\n', 'empty.js': '', 'nested/inner.js': 'x' },
		})
		try {
			expect(findFileText(join(scratch.path, 'entry.js'))).toBe('export const value = 1\n')
			expect(findFileText(join(scratch.path, 'empty.js'))).toBe('')
			expect(findFileText(join(scratch.path, 'absent.js'))).toBeUndefined()
			// A directory is a failed read too, which is what `serveFile` answers `404` for.
			expect(findFileText(join(scratch.path, 'nested'))).toBeUndefined()
		} finally {
			scratch.destroy()
		}
	})
})

describe('fetchUpstream', () => {
	it('forwards the body and headers, returns the upstream response, and reports an abort as undefined', async () => {
		const upstream = await createChatUpstream(() =>
			Promise.resolve(new Response('pong', { status: 202 })),
		)
		try {
			const request = new Request('http://127.0.0.1/api/chat', {
				method: 'POST',
				headers: { 'x-trace': 'forward-case' },
				body: '{"n":1}',
			})

			const answered = await fetchUpstream(
				upstream.url,
				request,
				'{"n":1}',
				new AbortController().signal,
			)

			expect(answered?.status).toBe(202)
			expect(await answered?.text()).toBe('pong')
			expect(upstream.requests).toMatchObject([
				{ headers: { 'x-trace': 'forward-case' }, text: '{"n":1}' },
			])
			// The proxy stopping and the inbound request cancelling both end the call as an abort,
			// and neither reaches the upstream.
			const parked = new AbortController()
			parked.abort()
			expect(await fetchUpstream(upstream.url, request, '{"n":1}', parked.signal)).toBeUndefined()
			const cancelled = new Request('http://127.0.0.1/api/chat', {
				method: 'POST',
				body: '{}',
				signal: AbortSignal.abort(),
			})
			expect(
				await fetchUpstream(upstream.url, cancelled, '{}', new AbortController().signal),
			).toBeUndefined()
			expect(upstream.requests).toHaveLength(1)
		} finally {
			await upstream.stop()
		}
	})

	it('rethrows a failure that is not an abort', async () => {
		const request = new Request('http://127.0.0.1/api/chat', { method: 'POST', body: '{}' })

		await expect(
			fetchUpstream('http://127.0.0.1:1', request, '{}', new AbortController().signal),
		).rejects.toThrow('fetch failed')
	})
})

describe('createChatUpstream', () => {
	it('records each chat body, hands the reply the request signal, and releases its port on stop', async () => {
		const signals = createRecorder<readonly [AbortSignal]>()
		const upstream = await createChatUpstream((signal) => {
			signals.handler(signal)
			return Promise.resolve(new Response('pong', { status: 201 }))
		})
		const first = await fetch(`${upstream.url}/api/chat`, { method: 'POST', body: '{"n":1}' })
		const second = await fetch(`${upstream.url}/api/chat`, { method: 'POST', body: '{"n":2}' })

		expect(first.status).toBe(201)
		expect(await first.text()).toBe('pong')
		expect(await second.text()).toBe('pong')
		expect(
			upstream.requests.map((request) => [request.method, request.path, request.text]),
		).toEqual([
			['POST', '/api/chat', '{"n":1}'],
			['POST', '/api/chat', '{"n":2}'],
		])
		expect(signals.calls).toEqual([[expect.any(AbortSignal)], [expect.any(AbortSignal)]])

		const { url } = upstream
		await upstream.stop()

		await expect(fetch(`${url}/api/chat`, { method: 'POST', body: '{}' })).rejects.toThrow(
			'fetch failed',
		)
	})
})

describe('executeFence', () => {
	it('runs the text as an async body and returns the binding it names', async () => {
		expect(await executeFence('const value: number = 1 + 2', {}, {}, 'value')).toBe(3)
		expect(await executeFence('const value = await Promise.resolve(5)', {}, {}, 'value')).toBe(5)
		expect(await executeFence('const seen = marker', {}, { marker: 'x' }, 'seen')).toBe('x')
		expect(await executeFence('const list = [1] as const', {}, {}, 'list')).toEqual([1])
	})

	it('binds each named import to the export the proof supplies and keeps its order of effect', async () => {
		expect(
			await executeFence(
				"import { a as b, c } from 'mod'\nconst total = b + c",
				{ mod: { a: 40, c: 2 } },
				{},
				'total',
			),
		).toBe(42)
	})

	it('removes a type import and keeps the fence valid without a binding for it', async () => {
		expect(
			await executeFence("import type { Shape } from 'types'\nconst value = 1", {}, {}, 'value'),
		).toBe(1)
	})

	it('refuses an import from a module, a name, or a form the proof does not supply', async () => {
		await expect(executeFence("import { a } from 'mod'", {}, {}, 'a')).rejects.toThrow(
			'the fence imports mod, which the proof supplies no bindings for',
		)
		await expect(
			executeFence("import { b } from 'mod'", { mod: { a: 1 } }, {}, 'b'),
		).rejects.toThrow('the fence imports a name mod supplies no binding for')
		await expect(
			executeFence("import * as all from 'mod'", { mod: {} }, {}, 'all'),
		).rejects.toThrow('the fence imports mod in a form the proof cannot bind')
		await expect(executeFence("import value from 'mod'", { mod: {} }, {}, 'value')).rejects.toThrow(
			'the fence imports mod in a form the proof cannot bind',
		)
	})

	it('reports a dropped import where the fence uses the name, and a fence that throws', async () => {
		await expect(executeFence('const value = absent', {}, {}, 'value')).rejects.toThrow(
			ReferenceError,
		)
		await expect(executeFence("throw new RangeError('refused')", {}, {}, 'unused')).rejects.toThrow(
			RangeError,
		)
		await expect(executeFence('const = 1', {}, {}, 'unused')).rejects.toThrow(/./)
	})
})

describe('createFenceModules and runWithFetch', () => {
	it('binds the real factory, the real guard, and the real abort factory, reporting each entity it makes', async () => {
		const made = createRecorder<readonly [AbortInterface]>()
		const modules = createFenceModules(made.handler)

		expect(Object.keys(modules).sort()).toEqual([
			'@orkestrel/abort',
			'@orkestrel/agent',
			'@orkestrel/ollama',
		])
		const abort = await executeFence(
			"import { createAbort } from '@orkestrel/abort'\nconst made = createAbort()",
			modules,
			{},
			'made',
		)

		expect(made.calls).toEqual([[abort]])
		expect(made.calls[0]?.[0]).toBe(abort)
		expect(made.calls[0]?.[0].signal.aborted).toBe(false)
		expect(
			await runWithFetch(createStreamingTransport(HELLO_TURN), () =>
				executeFence(
					"import { createOllama } from '@orkestrel/ollama'\nconst provider = createOllama({ model: 'm' })\nconst result = await provider.generate([{ id: '1', role: 'user', content: 'x' }], new AbortController().signal)\nconst content = result.content",
					modules,
					{},
					'content',
				),
			),
		).toBe('Hello')
	})

	it('lets a transport the fence supplies take the place of the one the proof installs', async () => {
		const modules = createFenceModules(() => {})

		await expect(
			runWithFetch(createStreamingTransport(HELLO_TURN), () =>
				executeFence(
					"import { createOllama } from '@orkestrel/ollama'\nconst provider = createOllama({ model: 'm', fetch: () => Promise.reject(new Error('fence transport refused')) })\nconst result = await provider.generate([{ id: '1', role: 'user', content: 'x' }], new AbortController().signal)",
					modules,
					{},
					'result',
				),
			),
		).rejects.toThrow('fence transport refused')
	})

	it('installs the transport as the global fetch for the run and restores it after, even when the run throws', async () => {
		const original = globalThis.fetch
		const transport = createStreamingTransport([])

		expect(
			await runWithFetch(transport, () => Promise.resolve(globalThis.fetch === transport)),
		).toBe(true)
		expect(globalThis.fetch).toBe(original)
		await expect(
			runWithFetch(transport, () => Promise.reject(new RangeError('run refused'))),
		).rejects.toThrow('run refused')
		expect(globalThis.fetch).toBe(original)
	})
})

describe('createErrorTransport and extractFenceError', () => {
	it('answers every request with the status and the body it was given', async () => {
		const transport = createErrorTransport(404, '{"error":"not found"}')

		const first = await transport('http://127.0.0.1:1/api/chat')
		const second = await transport('http://127.0.0.1:1/api/chat')

		expect([first.status, await first.text()]).toEqual([404, '{"error":"not found"}'])
		expect(second.status).toBe(404)
		expect(first.headers.get('content-type')).toBe('application/json')
	})

	it('reads an error by name, message, code, and status, and any other value as a thrown string', () => {
		const refused = Object.assign(new RangeError('daemon refused'), { code: 'HTTP', status: 404 })

		expect(extractFenceError(refused)).toEqual({
			name: 'RangeError',
			message: 'daemon refused',
			code: 'HTTP',
			status: 404,
		})
		expect(extractFenceError(new Error('plain'))).toEqual({
			name: 'Error',
			message: 'plain',
			code: undefined,
			status: undefined,
		})
		expect(extractFenceError('gone')).toEqual({
			name: 'Thrown',
			message: 'gone',
			code: undefined,
			status: undefined,
		})
	})
})

describe('extractStreamFences and readStreamFences', () => {
	it('extract the guide fence whole and the README usage fence followed by its streaming fence', () => {
		const { guide, readme } = readStreamFences()

		expect(guide.startsWith("import type { ProviderDelta } from '@orkestrel/agent'\n")).toBe(true)
		expect(guide.endsWith('} else throw error\n}')).toBe(true)
		expect(readme.startsWith("import { createOllama } from '@orkestrel/ollama'\n")).toBe(true)
		expect(readme).toContain('const abort = new AbortController()')
		expect(readme).not.toContain('@orkestrel/abort')
		expect(readme).toContain("import type { ProviderDelta } from '@orkestrel/agent'")
		expect(readme.endsWith('\tdeltas.push(step.value)\n}')).toBe(true)
	})

	it('throw when a text holds no block with the line that locates the fence', () => {
		expect(() => extractStreamFences('', '')).toThrow('Missing streaming fence in the guide')
		expect(() => extractStreamFences('```ts\nconst deltas: ProviderDelta[] = []\n```', '')).toThrow(
			'Missing usage fence in the README',
		)
	})
})

describe('FENCE_CONTROLS', () => {
	for (const control of FENCE_CONTROLS) {
		it(`observes an edit that ${control.label}`, async () => {
			const source = readStreamFences()[control.fence]
			const scenario = requireValue(
				STREAM_FENCE_CASES.find((candidate) => candidate.label === control.scenario),
				'Missing scenario',
			)
			const edited = source.replace(control.pattern, control.replacement)

			const original = await observeFence(source, scenario)
			const [outcome] = await Promise.allSettled([observeFence(edited, scenario)])

			expect(edited).not.toBe(source)
			expect(outcome.status === 'fulfilled' ? outcome.value : outcome.reason).not.toEqual(original)
		})
	}

	it('does not observe an edit that only reindents the fences', async () => {
		const fences = readStreamFences()
		const scenario = requireValue(
			STREAM_FENCE_CASES.find((candidate) => candidate.label === FENCE_SCENARIOS.plain),
			'Missing scenario',
		)

		for (const source of Object.values(fences)) {
			const reindented = source.replaceAll('\t', '    ')

			expect(reindented).not.toBe(source)
			expect(await observeFence(reindented, scenario)).toEqual(await observeFence(source, scenario))
		}
	})

	it('observes the real fences exactly as the scenarios state', async () => {
		const fences = readStreamFences()

		for (const scenario of STREAM_FENCE_CASES) {
			expect(await observeFence(fences.guide, scenario)).toEqual(
				buildFenceObservation(scenario, 'guide'),
			)
		}
		for (const scenario of STREAM_FENCE_CASES.filter(
			(candidate) => candidate.settled !== undefined,
		)) {
			expect(await observeFence(fences.readme, scenario)).toEqual(
				buildFenceObservation(scenario, 'readme'),
			)
		}
	})

	it('leaves the global fetch as it found it after a fence ran', async () => {
		const original = globalThis.fetch
		const fences = readStreamFences()

		await observeFence(fences.guide, requireValue(STREAM_FENCE_CASES[0], 'Missing scenario'))

		expect(globalThis.fetch).toBe(original)
	})
})

describe('ScriptCursor', () => {
	it('takes the messages in order and then nothing past the end', () => {
		const cursor = new ScriptCursor([{ content: 'first' }, { content: 'second' }])

		expect(cursor.take()).toEqual({ content: 'first' })
		expect(cursor.take()).toEqual({ content: 'second' })
		expect(cursor.take()).toBeUndefined()
		expect(cursor.take()).toBeUndefined()
	})

	it('moves past a hole as past any other turn', () => {
		const script = new Array<Readonly<Record<string, unknown>>>(2)
		script[1] = { content: 'second' }
		const cursor = new ScriptCursor(script)

		expect(cursor.take()).toBeUndefined()
		expect(cursor.take()).toEqual({ content: 'second' })
	})

	it('stays at an element whose read throws and reads it again', () => {
		const script = [{ content: 'first' }]
		Object.defineProperty(script, 0, {
			get: () => {
				throw new RangeError('element refused')
			},
		})
		const cursor = new ScriptCursor(script)

		expect(() => cursor.take()).toThrow(RangeError)
		expect(() => cursor.take()).toThrow(RangeError)
	})
})

describe('createScriptedTransport', () => {
	it('answers the n-th request with the n-th scripted message and names the script length past its end', async () => {
		const transport = createScriptedTransport([{ content: 'first' }, { content: 'second' }])

		const first = await transport('http://127.0.0.1/api/chat')
		const second = await transport('http://127.0.0.1/api/chat')

		expect(await first.text()).toBe(
			`${JSON.stringify({ message: { content: 'first' } })}\n${DONE_RECORD}`,
		)
		expect(await second.text()).toBe(
			`${JSON.stringify({ message: { content: 'second' } })}\n${DONE_RECORD}`,
		)
		await expect(transport('http://127.0.0.1/api/chat')).rejects.toThrow('the script holds 2 turns')
		await expect(transport('http://127.0.0.1/api/chat')).rejects.toThrow('the script holds 2 turns')
	})

	it('reads the same element again on the call after the read of an element throws', () => {
		const reads = createRecorder<[index: number]>()
		const script = [{ content: 'first' }, { content: 'second' }]
		Object.defineProperty(script, 0, {
			get: () => {
				reads.handler(0)
				throw new RangeError('element refused')
			},
		})
		const transport = createScriptedTransport(script)

		expect(() => transport('http://127.0.0.1/api/chat')).toThrow(RangeError)
		expect(() => transport('http://127.0.0.1/api/chat')).toThrow(RangeError)
		expect(reads.calls).toEqual([[0], [0]])
	})

	it('rejects at a hole in the script and carries on with the turn after it', async () => {
		// A literal cannot express the hole, so the fixture is written one key at a time.
		const script = new Array<Readonly<Record<string, unknown>>>(3)
		script[0] = { content: 'a' }
		script[2] = { content: 'c' }
		const transport = createScriptedTransport(script)

		const first = await transport('http://127.0.0.1/api/chat')
		await expect(transport('http://127.0.0.1/api/chat')).rejects.toThrow('the script holds 3 turns')
		const third = await transport('http://127.0.0.1/api/chat')

		expect(await first.text()).toBe(
			`${JSON.stringify({ message: { content: 'a' } })}\n${DONE_RECORD}`,
		)
		expect(await third.text()).toBe(
			`${JSON.stringify({ message: { content: 'c' } })}\n${DONE_RECORD}`,
		)
	})
})

describe('observePageAttempt', () => {
	it('returns the observation untouched and releases the acquisition before it rethrows a failure', async () => {
		const released = createRecorder()
		const acquisition = Promise.resolve({ destroy: () => Promise.resolve(released.handler()) })
		const bounds = { attempt: 500, release: 500 }

		expect(
			await observePageAttempt(bounds, AbortSignal.timeout(500), acquisition, () =>
				Promise.resolve('the page answered'),
			),
		).toBe('the page answered')
		expect(released.calls).toEqual([])

		const fault = new Error('the page reported a fault')
		await expect(
			observePageAttempt(bounds, AbortSignal.timeout(500), acquisition, () =>
				Promise.reject(fault),
			),
		).rejects.toBe(fault)
		expect(released.calls).toEqual([[]])
	})
})

describe('driveScript', () => {
	it('yields the scripted deltas in order, then returns the result it was given by identity', async () => {
		const result: ProviderResult = { content: 'ab', thinking: 'weighing it up' }
		const stream = driveScript(
			[
				{ channel: 'content', text: 'a' },
				{ channel: 'thinking', text: 'weighing it up' },
			],
			result,
		)

		expect(await stream.next()).toEqual({ done: false, value: { channel: 'content', text: 'a' } })
		expect(await stream.next()).toEqual({
			done: false,
			value: { channel: 'thinking', text: 'weighing it up' },
		})
		const settled = await stream.next()
		expect(settled.done).toBe(true)
		expect(settled.value).toBe(result)
	})

	it('returns the result at once for an empty script', async () => {
		const result: ProviderResult = { content: '' }

		expect(await driveScript([], result).next()).toEqual({ done: true, value: result })
	})
})

describe('SCHEDULE_SLACK', () => {
	it('leaves room above the timer lead and stays far inside the bound a hung attempt would reach', () => {
		expect(Number.isInteger(SCHEDULE_SLACK)).toBe(true)
		expect(SCHEDULE_SLACK).toBeGreaterThan(TIMER_LEAD)
		expect(SCHEDULE_SLACK).toBeLessThan(PAGE_BOUNDS.case)
	})
})

describe('PAGE_NOTE, PAGE_INFERENCE_PATH, and PAGE_RUN', () => {
	it('steer a run to the page tool with the note, on the path the relay route mounts, under the run deadline', () => {
		const route = buildRelayRoute(createOllama({ model: 'fixture-model' }), new RequestLog())
		const steering = `${PAGE_TOOL.name} tool with note "${PAGE_NOTE}"`

		expect(PAGE_INFERENCE_PATH).toBe(route.path)
		expect(Object.isFrozen(PAGE_RUN)).toBe(true)
		expect(Object.keys(PAGE_RUN)).toEqual(['system', 'prompt', 'timeout', 'limit'])
		expect(PAGE_RUN.system).toContain(steering)
		expect(PAGE_RUN.prompt).toContain(steering)
		expect(PAGE_RUN.timeout).toBe(PAGE_BOUNDS.run)
		expect(Number.isInteger(PAGE_RUN.limit) && PAGE_RUN.limit > 0).toBe(true)
	})
})

describe('PAGE_FAULT and PAGE_CAPITAL', () => {
	it('name a fault the page can report and a city whose answer a model gives and a look-alike does not', () => {
		expect(PAGE_FAULT).toBe('deliberate-page-fault')
		expect(Object.isFrozen(PAGE_CAPITAL)).toBe(true)
		expect(PAGE_CAPITAL.prompt).toContain('Japan')
		expect(PAGE_CAPITAL.answer.test('Tokyo')).toBe(true)
		expect(PAGE_CAPITAL.answer.test('tokyo.')).toBe(true)
		expect(PAGE_CAPITAL.answer.test(PAGE_NOTE)).toBe(false)
	})
})

describe('createPageSessionOptions', () => {
	it('freezes the browser executable and the launch flags into the options a session acquires with', () => {
		const options = createPageSessionOptions({
			executable: '/opt/chrome/chrome',
			engine: 'chromium',
		})

		expect(options).toEqual({ executable: '/opt/chrome/chrome', args: PAGE_BROWSER_ARGS })
		expect(options.args).toBe(PAGE_BROWSER_ARGS)
		expect(Object.isFrozen(options)).toBe(true)
	})
})

describe('the fixture daemon constants', () => {
	it('advertise one model and answer with one content, which the ordinary answers carry', () => {
		expect(READY_TAGS).toEqual({ status: 200, models: [{ model: FIXTURE_MODEL }] })
		expect(READY_CHAT).toEqual({ status: 200, content: FIXTURE_CONTENT, park: false })
	})
})

describe('FixtureDaemon', () => {
	it('answers the ordinary listing and chat, and records each route, chat body, and preflight origin in call order', async () => {
		const daemon = new FixtureDaemon()
		await daemon.start()
		try {
			const tags = await fetch(`${daemon.url}/api/tags`)
			expect(tags.status).toBe(200)
			expect(await tags.json()).toEqual({ models: [{ model: 'fixture-model:latest' }] })

			const chat = await fetch(`${daemon.url}/api/chat`, {
				method: 'POST',
				body: JSON.stringify({ model: 'fixture-model:latest', stream: false }),
			})
			expect(chat.status).toBe(200)
			expect(await chat.json()).toEqual({
				model: 'fixture-model:latest',
				message: { role: 'assistant', content: 'The conversation covered two small-talk topics.' },
				done: true,
			})
			// A body that is not a JSON record is served, and its route is recorded, but no body is.
			await fetch(`${daemon.url}/api/chat`, { method: 'POST', body: '[1]' })

			const refused = await fetch(`${daemon.url}/api/chat`, {
				method: 'OPTIONS',
				headers: { origin: 'http://page.example' },
			})
			expect(refused.status).toBe(403)
			daemon.origins(['http://page.example'])
			const allowed = await fetch(`${daemon.url}/api/chat`, {
				method: 'OPTIONS',
				headers: { origin: 'http://page.example' },
			})
			expect(allowed.status).toBe(204)
			expect(allowed.headers.get('access-control-allow-origin')).toBe('http://page.example')
			expect(allowed.headers.get('access-control-allow-methods')).toBe('POST,OPTIONS')
			// A preflight carrying no origin is recorded as the empty origin and refused.
			expect((await fetch(`${daemon.url}/api/chat`, { method: 'OPTIONS' })).status).toBe(403)

			expect(daemon.calls).toEqual(['/api/tags', '/api/chat', '/api/chat'])
			expect(daemon.chats).toEqual([{ model: 'fixture-model:latest', stream: false }])
			expect(daemon.preflights).toEqual(['http://page.example', 'http://page.example', ''])
		} finally {
			await daemon.stop()
		}
	})

	it('serves a replaced listing and chat answer until the ordinary one is restored', async () => {
		const daemon = new FixtureDaemon()
		await daemon.start()
		try {
			daemon.tags({ status: 503, models: [] })
			const unavailable = await fetch(`${daemon.url}/api/tags`)
			expect(unavailable.status).toBe(503)
			expect(await unavailable.json()).toEqual({ models: [] })

			daemon.chat({ status: 502, content: 'replaced', park: false })
			const replaced = await fetch(`${daemon.url}/api/chat`, { method: 'POST', body: '{}' })
			expect(replaced.status).toBe(502)
			expect(await replaced.json()).toMatchObject({ message: { content: 'replaced' } })

			daemon.tags(READY_TAGS)
			daemon.chat(READY_CHAT)
			expect((await fetch(`${daemon.url}/api/tags`)).status).toBe(200)
			expect((await fetch(`${daemon.url}/api/chat`, { method: 'POST', body: '{}' })).status).toBe(
				200,
			)
		} finally {
			await daemon.stop()
		}
	})

	it('parks a chat the answer marks parked and releases it as 499 when stop aborts it', async () => {
		const daemon = new FixtureDaemon()
		await daemon.start()
		const { url } = daemon
		daemon.chat({ status: 200, content: 'unused', park: true })
		const pending = fetch(`${url}/api/chat`, { method: 'POST', body: '{}' })
		await waitForCondition('the parked chat to reach the daemon', () => daemon.chats.length === 1)

		const stopped = daemon.stop()

		expect((await pending).status).toBe(499)
		await stopped
		await expect(fetch(`${url}/api/tags`)).rejects.toThrow('fetch failed')
	})

	it('hands out copies of its histories and refuses a url before it listens', async () => {
		expect(() => new FixtureDaemon().url).toThrow('the fixture daemon is not listening')

		const daemon = new FixtureDaemon()
		await daemon.start()
		try {
			daemon.origins(['http://page.example'])
			const before = { calls: daemon.calls, chats: daemon.chats, preflights: daemon.preflights }
			await fetch(`${daemon.url}/api/tags`)
			await fetch(`${daemon.url}/api/chat`, { method: 'POST', body: '{"n":1}' })
			await fetch(`${daemon.url}/api/chat`, {
				method: 'OPTIONS',
				headers: { origin: 'http://page.example' },
			})

			expect(before).toEqual({ calls: [], chats: [], preflights: [] })
			expect(daemon.calls).toEqual(['/api/tags', '/api/chat'])
			expect(daemon.chats).toEqual([{ n: 1 }])
			expect(daemon.preflights).toEqual(['http://page.example'])
			expect(daemon.calls).not.toBe(daemon.calls)
			expect(daemon.chats).not.toBe(daemon.chats)
			expect(daemon.preflights).not.toBe(daemon.preflights)
		} finally {
			await daemon.stop()
		}
	})

	it('keeps its address readable after stop and stops a second time without error', async () => {
		const daemon = new FixtureDaemon()
		await daemon.start()
		const { url } = daemon
		await daemon.stop()

		expect(daemon.url).toBe(url)
		await expect(daemon.stop()).resolves.toBeUndefined()
		expect(daemon.url).toBe(url)
		await expect(fetch(`${url}/api/tags`)).rejects.toThrow('fetch failed')
	})

	it('returns from a second stop at once, before the first has finished stopping the server', async () => {
		const daemon = new FixtureDaemon()
		await daemon.start()
		const order = createRecorder<[label: string]>()

		await Promise.all([
			daemon.stop().then(() => order.handler('first')),
			daemon.stop().then(() => order.handler('second')),
		])

		expect(order.calls).toEqual([['second'], ['first']])
	})
})

describe('readLatestChat', () => {
	it('returns the newest recorded chat body and throws when the daemon recorded none', async () => {
		const daemon = new FixtureDaemon()
		await daemon.start()
		try {
			expect(() => readLatestChat(daemon)).toThrow('the fixture daemon recorded no chat call')

			await fetch(`${daemon.url}/api/chat`, { method: 'POST', body: '{"n":1}' })
			await fetch(`${daemon.url}/api/chat`, { method: 'POST', body: '{"n":2}' })

			expect(readLatestChat(daemon)).toEqual({ n: 2 })
		} finally {
			await daemon.stop()
		}
	})
})

describe('readChatMessages', () => {
	it('returns the messages as records and throws for a body without a messages array of records', () => {
		expect(readChatMessages({ messages: [{ role: 'user', content: 'hi' }] })).toEqual([
			{ role: 'user', content: 'hi' },
		])
		expect(readChatMessages({ messages: [] })).toEqual([])
		const refusal = 'the recorded chat carries no messages array'
		expect(() => readChatMessages({})).toThrow(refusal)
		expect(() => readChatMessages({ messages: 'nope' })).toThrow(refusal)
		expect(() => readChatMessages({ messages: ['nope'] })).toThrow(refusal)
	})
})

describe('isPositiveInteger', () => {
	it('accepts whole numbers above zero and refuses every other value', () => {
		expect(POSITIVE_INTEGERS.map((value) => isPositiveInteger(value))).toEqual(
			POSITIVE_INTEGERS.map(() => true),
		)
		expect(NON_POSITIVE_INTEGERS.map((value) => isPositiveInteger(value))).toEqual(
			NON_POSITIVE_INTEGERS.map(() => false),
		)
		expect(NON_POSITIVE_INTEGERS.some((value) => Object.is(value, NaN))).toBe(true)
		expect(NON_POSITIVE_INTEGERS.some((value) => Object.is(value, -0))).toBe(true)
	})
})

// The live page proof's gates. Each resolves on call, so the hermetic half asserted here
// is each gate's refusal and the reading it returns against a fixture; the live half — a
// real browser and a real build — is the `service` project's.

describe('PAGE_BROWSER_ARGS', () => {
	it('freezes the container-safe launch flags every page session takes', () => {
		expect(Object.isFrozen(PAGE_BROWSER_ARGS)).toBe(true)
		expect([...PAGE_BROWSER_ARGS]).toEqual([
			'--no-sandbox',
			'--disable-dev-shm-usage',
			'--disable-gpu',
		])
	})
})

describe('requirePageBrowser', () => {
	it('throws naming what to install when no candidate source resolves a browser', () => {
		// Every candidate source is emptied, so this reads the refusal on any host rather
		// than the host's own browser, and `npm test` never needs one.
		expect(() => requirePageBrowser({ env: {}, paths: [], names: [], stores: [] })).toThrow(
			/requires a Chromium-family browser on this host and found none/,
		)
		expect(() => requirePageBrowser({ env: {}, paths: [], names: [], stores: [] })).toThrow(
			/PLAYWRIGHT_EXECUTABLE_PATH or CHROME_PATH/,
		)
	})
})

describe('requireBuild', () => {
	it('resolves the built core entry, and throws naming the build when it is absent', () => {
		const built = createScratch({ files: { 'dist/src/core/index.js': 'export const x = 1\n' } })
		const bare = createScratch()
		try {
			expect(requireBuild(built.path)).toBe(join(built.path, 'dist', 'src', 'core', 'index.js'))
			expect(() => requireBuild(bare.path)).toThrow(/run npm run build/)
		} finally {
			built.destroy()
			bare.destroy()
		}
	})
})

describe('scanTreeReferences', () => {
	it('collects the literal specifier of every import and re-export node, parents before children', () => {
		const tree = {
			type: 'Program',
			body: [
				{ type: 'ImportDeclaration', source: { type: 'Literal', value: './a.js' } },
				{ type: 'ExportNamedDeclaration', source: { type: 'Literal', value: './b.js' } },
				{ type: 'ExportAllDeclaration', source: { type: 'Literal', value: './c.js' } },
				{
					type: 'ExpressionStatement',
					expression: { type: 'ImportExpression', source: { type: 'Literal', value: './d.js' } },
				},
			],
		}

		expect(scanTreeReferences(tree)).toEqual([
			{ form: 'import', specifier: './a.js' },
			{ form: 'export', specifier: './b.js' },
			{ form: 'export', specifier: './c.js' },
			{ form: 'dynamic', specifier: './d.js' },
		])
	})

	it('skips a local export, reports a computed specifier without text, and skips a value that is not a tree', () => {
		const tree = {
			type: 'Program',
			body: [
				{ type: 'ExportNamedDeclaration', source: null },
				{ type: 'ImportExpression', source: { type: 'Identifier', name: 'target' } },
				{ type: 'ImportExpression', source: { type: 'Literal', value: 3 } },
			],
		}

		expect(scanTreeReferences(tree)).toEqual([
			{ form: 'dynamic', specifier: undefined },
			{ form: 'dynamic', specifier: undefined },
		])
		expect(NOT_TREES.map((value) => scanTreeReferences(value))).toEqual(NOT_TREES.map(() => []))
	})

	it('reaches a reference nested ten thousand levels deep without recursing', () => {
		const deepest = {
			type: 'ImportExpression',
			source: { type: 'Literal', value: './deep.js' },
		}
		const tree = Array.from({ length: 10_000 }).reduce<unknown>(
			(child) => ({ type: 'Wrapper', body: [child] }),
			deepest,
		)

		expect(scanTreeReferences(tree)).toEqual([{ form: 'dynamic', specifier: './deep.js' }])
	})

	it('ends on a value that refers to itself and reports a shared node once', () => {
		const shared = { type: 'ImportDeclaration', source: { type: 'Literal', value: './once.js' } }
		const cyclic: Record<string, unknown> = { type: 'Program', body: [shared, shared] }
		cyclic.parent = cyclic

		expect(scanTreeReferences(cyclic)).toEqual([{ form: 'import', specifier: './once.js' }])
	})
})

describe('buildModuleFixture', () => {
	it('builds a setup module that reaches the bridge, the bridge that holds the reference, and the module it names', () => {
		const fixture = buildModuleFixture(
			'a bridge',
			{ form: 'import', specifier: '../tests/setupService.js' },
			"import '../tests/setupService.js'",
		)

		expect(fixture).toEqual({
			label: 'a bridge',
			reference: { form: 'import', specifier: '../tests/setupService.js' },
			files: {
				'tests/setupBridge.ts': "import '../src/bridge.js'\n",
				'src/bridge.ts': "import '../tests/setupService.js'\n",
				'tests/setupService.ts': 'export const live = true\n',
			},
			entries: ['tests/setupBridge.ts'],
			importers: ['src/bridge.ts'],
		})
	})
})

describe('readModuleReferences', () => {
	it('reads the references one node names and none from a node that names no module', () => {
		const cases = buildReferenceCases()

		expect(cases.map(([node]) => readModuleReferences(node))).toEqual(
			cases.map(([, found]) => found),
		)
	})
})

describe('findModuleReferences', () => {
	it('names the syntax of each reference form, with the specifier it spells', async () => {
		const forms = MODULE_FIXTURES.flatMap((fixture) =>
			fixture.reference === undefined ? [] : [{ fixture, reference: fixture.reference }],
		)

		expect(forms.map(({ reference }) => reference.form).sort()).toEqual([
			'assign',
			'dynamic',
			'dynamic',
			'export',
			'glob',
			'import',
			'require',
			'type',
			'url',
		])
		for (const { fixture, reference } of forms) {
			const bridge = fixture.files['src/bridge.ts']
			if (bridge === undefined) throw new Error(`${fixture.label} holds no bridge`)

			expect(await findModuleReferences(bridge)).toEqual([reference])
		}
	})

	it('reads a glob given as a list', async () => {
		expect(
			await findModuleReferences(
				"const a = import.meta.glob(['./a.ts', './b/*.ts'], { eager: true })",
			),
		).toEqual([
			{ form: 'glob', specifier: './a.ts' },
			{ form: 'glob', specifier: './b/*.ts' },
		])
	})

	it('names the form of a reference built at run time and gives it no specifier', async () => {
		expect(
			await Promise.all(COMPUTED_REFERENCE_CASES.map(([text]) => findModuleReferences(text))),
		).toEqual(COMPUTED_REFERENCE_CASES.map(([, found]) => found))
	})

	it('refuses text that is not TypeScript', async () => {
		await expect(findModuleReferences('import { from ./x.js')).rejects.toThrow(/./)
	})
})

describe('readSpecifierText', () => {
	it('spells a string literal and a substitution-free template, and nothing else', () => {
		const cases = buildSpecifierCases()

		expect(cases.map(([node]) => readSpecifierText(node))).toEqual(cases.map(([, text]) => text))
	})
})

describe('isIdentifierNamed and isImportMetaMember', () => {
	it('match a bare identifier and a non-computed member of import.meta, and refuse look-alikes', () => {
		const meta = {
			type: 'MetaProperty',
			meta: { type: 'Identifier', name: 'import' },
			property: { type: 'Identifier', name: 'meta' },
		}
		const url = { type: 'Identifier', name: 'url' }

		expect(isIdentifierNamed({ type: 'Identifier', name: 'require' }, 'require')).toBe(true)
		expect(isIdentifierNamed({ type: 'Identifier', name: 'required' }, 'require')).toBe(false)
		expect(isIdentifierNamed({ type: 'Literal', name: 'require' }, 'require')).toBe(false)
		expect(isIdentifierNamed(undefined, 'require')).toBe(false)
		expect(
			isImportMetaMember(
				{ type: 'MemberExpression', object: meta, property: url, computed: false },
				'url',
			),
		).toBe(true)
		expect(
			isImportMetaMember(
				{ type: 'MemberExpression', object: meta, property: url, computed: true },
				'url',
			),
		).toBe(false)
		expect(
			isImportMetaMember(
				{ type: 'MemberExpression', object: meta, property: url, computed: false },
				'glob',
			),
		).toBe(false)
		expect(
			isImportMetaMember(
				{
					type: 'MemberExpression',
					object: { ...meta, property: { type: 'Identifier', name: 'env' } },
					property: url,
					computed: false,
				},
				'url',
			),
		).toBe(false)
		expect(
			isImportMetaMember(
				{
					type: 'MemberExpression',
					object: { type: 'Identifier', name: 'meta' },
					property: url,
					computed: false,
				},
				'url',
			),
		).toBe(false)
		expect(isImportMetaMember(url, 'url')).toBe(false)
	})
})

describe('buildReferences and listChildren', () => {
	it('builds one reference per present node, in order, with no specifier for a node that spells no text, and lists only nested containers', () => {
		expect(
			buildReferences('glob', [
				{ type: 'Literal', value: './a.ts' },
				{ type: 'Identifier', name: 'held' },
				undefined,
				null,
				{ type: 'Literal', value: './b.ts' },
			]),
		).toEqual([
			{ form: 'glob', specifier: './a.ts' },
			{ form: 'glob', specifier: undefined },
			{ form: 'glob', specifier: './b.ts' },
		])
		expect(buildReferences('import', [])).toEqual([])
		const inner = { value: 1 }
		expect(listChildren({ a: inner, b: 'text', c: [1, 2], d: null })).toEqual([inner, [1, 2]])
		expect(listChildren([inner, 'text', 3])).toEqual([inner])
		expect(listChildren('text')).toEqual([])
	})
})

describe('stripSpecifierSuffix, isAssetSpecifier, and normalizeSetupFile', () => {
	it('drop the query and the hash from a specifier, and keep the path before them', () => {
		expect(SPECIFIER_SUFFIX_CASES.map(([specifier]) => stripSpecifierSuffix(specifier))).toEqual(
			SPECIFIER_SUFFIX_CASES.map(([, path]) => path),
		)
	})

	it('call a specifier an asset only when its query asks for the text or the address', () => {
		expect(ASSET_SPECIFIER_CASES.map(([specifier]) => isAssetSpecifier(specifier))).toEqual(
			ASSET_SPECIFIER_CASES.map(([, asset]) => asset),
		)
		expect(ASSET_QUERIES).toEqual(['raw', 'url'])
		expect(Object.isFrozen(ASSET_QUERIES)).toBe(true)
	})

	it('read a setup path as the root-relative path it names, with every backslash a separator', () => {
		expect(NORMALIZE_SETUP_CASES.map(([value]) => normalizeSetupFile(value))).toEqual(
			NORMALIZE_SETUP_CASES.map(([, path]) => path),
		)
	})

	it('make an absolute path inside the root relative to it', () => {
		const scratch = createScratch()
		try {
			const absolute = join(scratch.path, 'tests', 'setup.ts')

			expect(normalizeSetupFile(absolute, scratch.path)).toBe('tests/setup.ts')
			expect(normalizeSetupFile(`${absolute}?daemon`, scratch.path)).toBe('tests/setup.ts')
		} finally {
			scratch.destroy()
		}
	})
})

describe('readRealPath', () => {
	it('names a file by its path relative to the root, and by the letter case the host stores', () => {
		const scratch = createScratch({ files: SETUP_FILES })
		try {
			const folded = attempt(() => readRealPath(scratch.path, 'tests/SETUPSERVICE.ts'))

			expect(readRealPath(scratch.path, 'tests/setupService.ts')).toBe('tests/setupService.ts')
			expect(readRealPath(scratch.path, 'tests/./setup.ts')).toBe('tests/setup.ts')
			expect(folded.success ? folded.value : 'unresolved').toBe(
				scratch.has('tests/SETUPSERVICE.ts') ? 'tests/setupService.ts' : 'unresolved',
			)
			expect(() => readRealPath(scratch.path, 'tests/missing.ts')).toThrow(/ENOENT/)
		} finally {
			scratch.destroy()
		}
	})
})

describe('SERVICE_SPECIFIER, SERVICE_MODULE, CODE_EXTENSIONS, and SOURCE_TWINS', () => {
	it('match the spelling of a module specifier that names the service module, and no other', () => {
		expect(SERVICE_SPECIFIER_CASES.map(([specifier]) => SERVICE_SPECIFIER.test(specifier))).toEqual(
			SERVICE_SPECIFIER_CASES.map(([, matches]) => matches),
		)
		expect(SERVICE_SPECIFIER.test(SERVICE_MODULE)).toBe(true)
		expect(SERVICE_MODULE).toBe('tests/setupService.ts')
	})

	it('list the extensions a file is read as code by, and the TypeScript twins of the JavaScript ones', () => {
		expect(CODE_EXTENSIONS).toEqual(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
		expect(SOURCE_TWINS).toEqual({
			'.js': ['.ts', '.tsx'],
			'.jsx': ['.tsx'],
			'.mjs': ['.mts'],
			'.cjs': ['.cts'],
		})
		expect(
			Object.keys(SOURCE_TWINS).every((extension) => CODE_EXTENSIONS.includes(extension)),
		).toBe(true)
		expect(
			Object.values(SOURCE_TWINS).every((twins) =>
				twins.every((twin) => CODE_EXTENSIONS.includes(twin)),
			),
		).toBe(true)
		expect(Object.isFrozen(CODE_EXTENSIONS)).toBe(true)
		expect(Object.isFrozen(SOURCE_TWINS)).toBe(true)
	})
})

describe('buildComputedFixture and buildQueryFixture', () => {
	it('build a bridge that holds a reference made at run time, refused when its form loads code', () => {
		const loading = buildComputedFixture(
			'a variable',
			'dynamic',
			'export const live = import(name)',
		)
		const naming = buildComputedFixture(
			'a pattern',
			'glob',
			'export const live = import.meta.glob(p)',
		)

		expect(loading).toEqual({
			label: 'a variable',
			form: 'dynamic',
			files: {
				'tests/setupBridge.ts': "import '../src/bridge.js'\n",
				'src/bridge.ts': 'export const live = import(name)\n',
				'tests/setupService.ts': 'export const live = true\n',
			},
			entries: ['tests/setupBridge.ts'],
			refused: ['src/bridge.ts'],
		})
		expect(naming.refused).toEqual([])
		expect(LOADING_FORMS.map((form) => buildComputedFixture('x', form, '').refused)).toEqual(
			LOADING_FORMS.map(() => ['src/bridge.ts']),
		)
	})

	it('build a bridge that names the service module with a query, and no reference of a form', () => {
		const fixture = buildQueryFixture('a query', "import '../tests/setupService.ts?daemon'", [
			'src/bridge.ts',
		])

		expect(fixture).toEqual({
			label: 'a query',
			reference: undefined,
			files: {
				'tests/setupBridge.ts': "import '../src/bridge.js'\n",
				'src/bridge.ts': "import '../tests/setupService.ts?daemon'\n",
				'tests/setupService.ts': 'export const live = true\n',
			},
			entries: ['tests/setupBridge.ts'],
			importers: ['src/bridge.ts'],
		})
	})
})

describe('readFirstStatement and buildFenceImport', () => {
	it('reads the syntax tree node of the first statement, or none for an empty text', async () => {
		expect(await readFirstStatement("import { a } from 'mod'")).toMatchObject({
			type: 'ImportDeclaration',
		})
		expect(await readFirstStatement('const value = 1')).toMatchObject({
			type: 'VariableDeclaration',
		})
		expect(await readFirstStatement('')).toBeUndefined()
	})

	it('binds each named import to the export the table supplies, under the local name the fence uses', async () => {
		const node = await readFirstStatement("import { a as b, c } from 'mod'")

		expect(buildFenceImport(node, { mod: { a: 1, c: 2 } })).toBe(
			'const { a: b, c: c } = __modules["mod"]',
		)
	})

	it('refuses an import whose module, name, or form the table does not supply', async () => {
		const missing = await readFirstStatement("import { a } from 'mod'")
		const absent = await readFirstStatement("import { b } from 'mod'")
		const namespace = await readFirstStatement("import * as all from 'mod'")
		const bare = await readFirstStatement('const value = 1')

		expect(() => buildFenceImport(missing, {})).toThrow(
			'the fence imports mod, which the proof supplies no bindings for',
		)
		expect(() => buildFenceImport(absent, { mod: { a: 1 } })).toThrow(
			'the fence imports a name mod supplies no binding for',
		)
		expect(() => buildFenceImport(namespace, { mod: {} })).toThrow(
			'the fence imports mod in a form the proof cannot bind',
		)
		expect(() => buildFenceImport(bare, { mod: {} })).toThrow(
			'the fence holds an import the proof cannot read',
		)
		expect(() => buildFenceImport(undefined, {})).toThrow(
			'the fence holds an import the proof cannot read',
		)
	})
})

describe('findServiceImports', () => {
	it('finds a static, type, side-effect, re-export, multi-line, dynamic, template, assigned, required, and URL reference to the module', async () => {
		expect(
			await Promise.all(SERVICE_IMPORT_CASES.map(([text]) => findServiceImports(text))),
		).toEqual(SERVICE_IMPORT_CASES.map(([, found]) => found))
	})

	it('reports every import in source order', async () => {
		expect(
			await findServiceImports(
				"import { a } from './setupService.js'\nconst b = await import('../setupService.js')",
			),
		).toEqual(['./setupService.js', '../setupService.js'])
	})

	it('refuses text that is not TypeScript rather than reporting no import', async () => {
		await expect(findServiceImports('import { from ./setupService.js')).rejects.toThrow(/./)
	})

	it('finds nothing in a name that only resembles the module, a comment, a string, or syntax that names no module', async () => {
		expect(
			await Promise.all(UNRELATED_IMPORT_CASES.map((text) => findServiceImports(text))),
		).toEqual(UNRELATED_IMPORT_CASES.map(() => []))
	})
})

describe('listSources', () => {
	it('collects the included files without the excluded ones, sorted and in / form', () => {
		const scratch = createScratch({
			files: { 'b.ts': '', 'a/inner.ts': '', 'a/inner.test.ts': '', 'c.md': '' },
		})
		try {
			expect(listSources(['**/*.ts'], ['**/*.test.ts'], scratch.path)).toEqual([
				'a/inner.ts',
				'b.ts',
			])
			expect(listSources(['**/*.ts'], [], scratch.path)).toEqual([
				'a/inner.test.ts',
				'a/inner.ts',
				'b.ts',
			])
			expect(listSources(['absent/**'], [], scratch.path)).toEqual([])
		} finally {
			scratch.destroy()
		}
	})
})

describe('listSetupFiles', () => {
	it('reads one path or a list of paths as written, and nothing else', () => {
		expect(listSetupFiles('./tests/setup.ts')).toEqual(['./tests/setup.ts'])
		expect(listSetupFiles(['./tests/a.ts', 'tests/b.ts'])).toEqual(['./tests/a.ts', 'tests/b.ts'])
		expect(NOT_SETUP_FILES.map((value) => listSetupFiles(value))).toEqual(
			NOT_SETUP_FILES.map(() => []),
		)
	})
})

describe('listProjectSources', () => {
	it('lists what a project collects without its exclusions, then the setup files it loads', () => {
		const scratch = createScratch({
			files: { 'tests/one.test.ts': '', 'tests/two.test.ts': '', 'tests/setup.ts': '' },
		})
		try {
			expect(
				listProjectSources(
					{
						include: ['tests/*.test.ts'],
						exclude: ['tests/two.test.ts'],
						setupFiles: ['./tests/setup.ts'],
					},
					scratch.path,
				),
			).toEqual(['tests/one.test.ts', 'tests/setup.ts'])
			expect(listProjectSources({ include: ['tests/*.test.ts'] }, scratch.path)).toEqual([
				'tests/one.test.ts',
				'tests/two.test.ts',
			])
		} finally {
			scratch.destroy()
		}
	})

	it('lists a setup file and a global setup file given as one path as it lists a list', () => {
		const scratch = createScratch({ files: { 'tests/one.test.ts': '' } })
		try {
			expect(
				listProjectSources(
					{
						include: ['tests/*.test.ts'],
						setupFiles: './tests/setup.ts',
						globalSetup: 'tests/global.ts',
					},
					scratch.path,
				),
			).toEqual(['tests/one.test.ts', 'tests/setup.ts', 'tests/global.ts'])
			expect(
				listProjectSources(
					{ include: ['tests/*.test.ts'], globalSetup: ['./tests/a.ts', './tests/b.ts'] },
					scratch.path,
				),
			).toEqual(['tests/one.test.ts', 'tests/a.ts', 'tests/b.ts'])
		} finally {
			scratch.destroy()
		}
	})

	it('lists a setup file written with backslashes, a dot segment, or a query as the root-relative path it names', () => {
		const scratch = createScratch({ files: { 'tests/one.test.ts': '' } })
		try {
			expect(
				listProjectSources(
					{
						include: ['tests/*.test.ts'],
						setupFiles: ['.\\tests\\setup.ts', 'tests\\.\\other.ts?daemon'],
						globalSetup: '.\\tests\\global.ts',
					},
					scratch.path,
				),
			).toEqual(['tests/one.test.ts', 'tests/setup.ts', 'tests/other.ts', 'tests/global.ts'])
		} finally {
			scratch.destroy()
		}
	})

	it('throws naming what is missing when the declaration is not a project with an include list', () => {
		expect(() => listProjectSources(undefined)).toThrow(
			'the project declares no test configuration',
		)
		expect(() => listProjectSources({ include: 'tests/*.test.ts' })).toThrow(
			'the project declares no include list',
		)
		expect(() => listProjectSources({})).toThrow('the project declares no include list')
	})
})

describe('findServiceImporters', () => {
	it('names the files that import the module, in the order given, and follows no import that names a package', async () => {
		const scratch = createScratch({
			files: {
				'tests/a.ts': "import { x } from './setupService.js'\n",
				'tests/b.ts': "import { y } from './setupServer.js'\n",
				'tests/c.ts': "export const live = import('./setupService.js')\n",
				'tests/setupServer.ts': '',
				'tests/setupService.ts': FIXTURE_SERVICE_BODY,
			},
		})
		try {
			expect(
				await findServiceImporters(['tests/c.ts', 'tests/b.ts', 'tests/a.ts'], scratch.path),
			).toEqual(['tests/c.ts', 'tests/a.ts'])
			expect(await findServiceImporters(['tests/b.ts'], scratch.path)).toEqual([])
			await expect(findServiceImporters(['absent.ts'], scratch.path)).rejects.toThrow(/ENOENT/)
		} finally {
			scratch.destroy()
		}
	})

	it('names an import that resolves to no file as no importer, whatever it spells', async () => {
		const scratch = createScratch({
			files: { 'tests/a.ts': "import { x } from './setupService.js'\n" },
		})
		try {
			expect(await findServiceImporters(['tests/a.ts'], scratch.path)).toEqual([])
		} finally {
			scratch.destroy()
		}
	})

	it('names an import by the file the host resolves its letter case to, and by none on a host that keeps case', async () => {
		const scratch = createScratch({
			files: {
				'tests/setupBridge.ts': "import '../src/bridge.js'\n",
				'src/bridge.ts': "import '../tests/SETUPSERVICE.js'\n",
				'tests/setupService.ts': FIXTURE_SERVICE_BODY,
			},
		})
		try {
			const folds = scratch.has('tests/SETUPSERVICE.ts')
			const closure = await collectModuleClosure(['tests/setupBridge.ts'], scratch.path)

			expect(await findServiceImporters(['tests/setupBridge.ts'], scratch.path)).toEqual(
				folds ? ['src/bridge.ts'] : [],
			)
			expect(closure.get('src/bridge.ts')?.files).toEqual(folds ? ['tests/setupService.ts'] : [])
			expect([...closure.keys()].includes('tests/SETUPSERVICE.ts')).toBe(false)
		} finally {
			scratch.destroy()
		}
	})

	for (const fixture of MODULE_FIXTURES) {
		it(`reaches the module through ${fixture.label} and names the file that holds the reference`, async () => {
			const scratch = createScratch({ files: fixture.files })
			try {
				expect(await findServiceImporters(fixture.entries, scratch.path)).toEqual(fixture.importers)
			} finally {
				scratch.destroy()
			}
		})
	}
})

describe('collectModuleClosure', () => {
	it('reaches every module to a fixed point, with the files each reference resolves to, and stops at the service module', async () => {
		const fixture = MODULE_FIXTURES.find(
			(candidate) => candidate.label === 'a module two hops away, behind a cycle',
		)
		if (fixture === undefined) throw new Error('the cycle fixture is missing')
		const scratch = createScratch({ files: fixture.files })
		try {
			const closure = await collectModuleClosure(fixture.entries, scratch.path)

			expect([...closure.keys()]).toEqual(['tests/setupBridge.ts', 'src/a.ts', 'src/b.ts'])
			expect(closure.get('src/b.ts')).toEqual({
				references: [
					{ form: 'import', specifier: './a.js' },
					{ form: 'import', specifier: '../tests/setupService.js' },
				],
				files: ['src/a.ts', 'tests/setupService.ts'],
			})
		} finally {
			scratch.destroy()
		}
	})

	it('reads each file once and walks a glob match once, even when a match is also an entry', async () => {
		const fixture = MODULE_FIXTURES.find((candidate) => candidate.reference?.form === 'glob')
		if (fixture === undefined) throw new Error('the glob fixture is missing')
		const scratch = createScratch({ files: fixture.files })
		try {
			const closure = await collectModuleClosure(fixture.entries, scratch.path)

			expect([...closure.keys()]).toEqual(['tests/setupBridge.ts', 'src/bridge.ts'])
			expect(closure.get('src/bridge.ts')?.files).toEqual([
				'tests/setupBridge.ts',
				'tests/setupService.ts',
			])
		} finally {
			scratch.destroy()
		}
	})
})

describe('findComputedFiles', () => {
	it('lists the files of a closure that hold a reference with no specifier, in discovery order', () => {
		const closure = new Map([
			['a.ts', { references: [{ form: 'import', specifier: './b.js' }], files: ['b.ts'] }],
			['b.ts', { references: [{ form: 'dynamic', specifier: undefined }], files: [] }],
			['c.ts', { references: [], files: [] }],
			[
				'd.ts',
				{
					references: [
						{ form: 'glob', specifier: './x.ts' },
						{ form: 'require', specifier: undefined },
					],
					files: [],
				},
			],
			[
				'e.ts',
				{
					references: [
						{ form: 'url', specifier: undefined },
						{ form: 'glob', specifier: undefined },
					],
					files: [],
				},
			],
		] as const)

		expect(findComputedFiles(closure)).toEqual(['b.ts', 'd.ts', 'e.ts'])
		expect(findComputedFiles(new Map())).toEqual([])
		expect(LOADING_FORMS).toEqual(['dynamic', 'require', 'url'])
	})

	for (const fixture of COMPUTED_FIXTURES) {
		it(`judges ${fixture.label} by whether its form loads code, though the walk finds no service import`, async () => {
			const scratch = createScratch({ files: fixture.files })
			try {
				const closure = await collectModuleClosure(fixture.entries, scratch.path)

				expect(findComputedFiles(closure)).toEqual(fixture.refused)
				expect(await findServiceImporters(fixture.entries, scratch.path)).toEqual([])
				expect(
					closure.get('src/bridge.ts')?.references.map((reference) => reference.form),
				).toContain(fixture.form)
			} finally {
				scratch.destroy()
			}
		})
	}
})

describe('isServiceImporter', () => {
	it('is true for a reference that names the module or resolves to it, and false for one that does neither', () => {
		expect(SERVICE_IMPORTER_CASES.map(([entry]) => isServiceImporter(entry))).toEqual(
			SERVICE_IMPORTER_CASES.map(([, importer]) => importer),
		)
	})
})

describe('readPathAliases and resolveModuleFiles', () => {
	it('reads the exact aliases a configuration declares and none when it declares none', () => {
		const declared = createScratch({
			files: {
				'tsconfig.json':
					'{"compilerOptions":{"paths":{"@src/core":["./src/core/index.ts"],"@wild/*":["./wild/*"],"@empty":[]}}}\n',
			},
		})
		const bare = createScratch({ files: { 'tsconfig.json': '{}\n' } })
		const absent = createScratch()
		try {
			expect([...readPathAliases(declared.path)]).toEqual([
				['@src/core', 'src/core/index.ts'],
				['@wild/*', 'wild/*'],
			])
			expect([...readPathAliases(bare.path)]).toEqual([])
			expect([...readPathAliases(absent.path)]).toEqual([])
		} finally {
			declared.destroy()
			bare.destroy()
			absent.destroy()
		}
	})

	it('resolves a relative path, a JavaScript twin, a directory index, and an alias, and nothing outside the workspace', () => {
		const scratch = createScratch({ files: RESOLVER_FILES })
		try {
			const from = 'tests/setupBridge.ts'
			const aliases = new Map([['@src/core', 'src/core/index.ts']])

			expect(
				RESOLVE_FILE_CASES.map(([specifier]) =>
					resolveModuleFiles(from, { form: 'import', specifier }, scratch.path, aliases),
				),
			).toEqual(RESOLVE_FILE_CASES.map(([, files]) => files))
		} finally {
			scratch.destroy()
		}
	})
	it('expands a glob relative to the file, drops files that are not code, and honours a root-anchored pattern', () => {
		const scratch = createScratch({
			files: {
				'tests/setupBridge.ts': '',
				'tests/setupA.ts': '',
				'tests/setupB.mts': '',
				'tests/setup.json': '{}',
				'src/x.ts': '',
			},
		})
		try {
			const from = 'tests/setupBridge.ts'

			expect(
				resolveModuleFiles(from, { form: 'glob', specifier: './setup*' }, scratch.path),
			).toEqual(['tests/setupA.ts', 'tests/setupB.mts', 'tests/setupBridge.ts'])
			expect(
				resolveModuleFiles(from, { form: 'glob', specifier: '/src/*.ts' }, scratch.path),
			).toEqual(['src/x.ts'])
			expect(
				resolveModuleFiles(from, { form: 'glob', specifier: './absent*' }, scratch.path),
			).toEqual([])
		} finally {
			scratch.destroy()
		}
	})
})

describe('findCodeFile and isFilePath', () => {
	it('prefers the TypeScript twin of a JavaScript extension, then the path, then an added extension, then an index', () => {
		const scratch = createScratch({ files: CODE_FILES })
		try {
			expect(CODE_FILE_CASES.map(([candidate]) => findCodeFile(candidate, scratch.path))).toEqual(
				CODE_FILE_CASES.map(([, found]) => found),
			)
			expect(isFilePath(join(scratch.path, 'a.ts'))).toBe(true)
			expect(isFilePath(join(scratch.path, 'e'))).toBe(false)
			expect(isFilePath(join(scratch.path, 'absent'))).toBe(false)
		} finally {
			scratch.destroy()
		}
	})
})

describe('listProjects, readProject, and findServiceSetupFiles', () => {
	it('reads a project by calling its factory and takes the label from a string or a labelled name', () => {
		expect(readProject(() => ({ test: { name: 'plain' } }))).toEqual({
			label: 'plain',
			test: { name: 'plain' },
		})
		expect(readProject(() => ({ test: { name: { label: 'labelled' } } })).label).toBe('labelled')
	})

	it('lists the projects a configuration registers with their labels and test configuration', () => {
		expect(
			listProjects({
				test: {
					projects: [
						() => ({ test: { name: 'plain', setupFiles: ['./tests/setup.ts'] } }),
						() => ({ test: { name: { label: 'labelled', color: 'red' } } }),
					],
				},
			}),
		).toEqual([
			{ label: 'plain', test: { name: 'plain', setupFiles: ['./tests/setup.ts'] } },
			{ label: 'labelled', test: { name: { label: 'labelled', color: 'red' } } },
		])
	})

	it('refuses a configuration with no project list, a project that is not a factory, and a project with no label', () => {
		expect(() => listProjects(undefined)).toThrow('the configuration registers no project list')
		expect(() => listProjects({ test: {} })).toThrow('the configuration registers no project list')
		expect(() => listProjects({ test: { projects: ['./project'] } })).toThrow(
			'a registered project is not a factory',
		)
		expect(() => listProjects({ test: { projects: [() => ({ test: { name: 7 } })] } })).toThrow(
			'a registered project declares no label',
		)
		expect(() => listProjects({ test: { projects: [() => undefined] } })).toThrow(
			'a registered project declares no label',
		)
	})

	it('names the setup files that load the service module, however the path is spelled', () => {
		const scratch = createScratch({ files: SETUP_FILES })
		try {
			expect(
				findServiceSetupFiles(
					{
						setupFiles: ['./tests/setup.ts', ...SERVICE_SETUP_SPELLINGS, ...OTHER_SETUP_SPELLINGS],
					},
					scratch.path,
				),
			).toEqual(SERVICE_SETUP_SPELLINGS)
			expect(findServiceSetupFiles({}, scratch.path)).toEqual([])
			expect(findServiceSetupFiles(undefined, scratch.path)).toEqual([])
		} finally {
			scratch.destroy()
		}
	})

	it('names a service setup file given as one path, as Vitest accepts it, in each spelling', () => {
		const scratch = createScratch({ files: SETUP_FILES })
		try {
			expect(
				SERVICE_SETUP_SPELLINGS.map((spelling) =>
					findServiceSetupFiles({ setupFiles: spelling }, scratch.path),
				),
			).toEqual(SERVICE_SETUP_SPELLINGS.map((spelling) => [spelling]))
			expect(
				OTHER_SETUP_SPELLINGS.map((spelling) =>
					findServiceSetupFiles({ setupFiles: spelling }, scratch.path),
				),
			).toEqual(OTHER_SETUP_SPELLINGS.map(() => []))
		} finally {
			scratch.destroy()
		}
	})

	it('names a service global setup file, given as one path or as a list, after the setup files', () => {
		const scratch = createScratch({ files: SETUP_FILES })
		try {
			expect(
				SERVICE_SETUP_SPELLINGS.map((spelling) =>
					findServiceSetupFiles({ globalSetup: spelling }, scratch.path),
				),
			).toEqual(SERVICE_SETUP_SPELLINGS.map((spelling) => [spelling]))
			expect(
				findServiceSetupFiles(
					{
						setupFiles: ['.\\tests\\setupService.ts'],
						globalSetup: ['./tests/setup.ts', 'tests\\setupService.ts'],
					},
					scratch.path,
				),
			).toEqual(['.\\tests\\setupService.ts', 'tests\\setupService.ts'])
			expect(
				findServiceSetupFiles({ globalSetup: './tests/setupServer.ts' }, scratch.path),
			).toEqual([])
		} finally {
			scratch.destroy()
		}
	})

	it('names a service setup file at the absolute path of the root, and one the host folds by letter case', () => {
		const scratch = createScratch({ files: SETUP_FILES })
		try {
			const absolute = join(scratch.path, 'tests', 'setupService.ts')
			const folded = join(scratch.path, 'tests', 'SETUPSERVICE.ts')

			expect(findServiceSetupFiles({ setupFiles: absolute }, scratch.path)).toEqual([absolute])
			expect(findServiceSetupFiles({ setupFiles: folded }, scratch.path)).toEqual(
				scratch.has('tests/SETUPSERVICE.ts') ? [folded] : [],
			)
		} finally {
			scratch.destroy()
		}
	})
})

// The distribution stage: the readers, runners, and classifiers `tests/distribution.test.ts`
// measures an installed artifact with. The registry-free half runs against synthetic exports maps
// and a dependency-free fixture package. The stage half needs a registry that answers `ping`, which
// a loopback fixture does, so the proofs make no network call and `npm` never leaves 127.0.0.1.

const REGISTRY = await createPingRegistry()
const REGISTRY_BEFORE = process.env.npm_config_registry
process.env.npm_config_registry = REGISTRY.url
afterAll(async () => {
	if (REGISTRY_BEFORE === undefined) delete process.env.npm_config_registry
	else process.env.npm_config_registry = REGISTRY_BEFORE
	await REGISTRY.stop()
})

describe('decodeSegment', () => {
	it('decodes a percent escape and keeps a malformed one verbatim', () => {
		expect(DECODE_SEGMENT_CASES.map(([segment]) => decodeSegment(segment))).toEqual(
			DECODE_SEGMENT_CASES.map(([, decoded]) => decoded),
		)
	})
})

describe('isPackageTarget', () => {
	it('accepts a target inside the package and refuses a dot, parent, or node_modules segment, decoded or not', () => {
		expect(PACKAGE_TARGET_CASES.map(([target]) => isPackageTarget(target))).toStrictEqual(
			PACKAGE_TARGET_CASES.map(([, inside]) => inside),
		)
	})
})

describe('resolvePackageTarget and resolveTarget', () => {
	it('picks a target in condition order, falls through an invalid member of a list, and ends at undefined', () => {
		const entry = {
			import: { types: './a.d.ts', default: './a.js' },
			require: ['bad', './b.cjs'],
			default: './z.js',
		}

		expect(resolveTarget(entry, RUNTIME_CONDITIONS.module)).toBe('./a.js')
		expect(resolveTarget(entry, RUNTIME_CONDITIONS.commonjs)).toBe('./b.cjs')
		expect(resolveTarget(entry, ['types'])).toBe('./z.js')
		expect(resolveTarget({ import: './a.js' }, ['require'])).toBeUndefined()
		expect(resolvePackageTarget('bad', [])).toEqual({ target: 'bad' })
		expect(resolvePackageTarget(['bad', 'worse'], [])).toBeUndefined()
		expect(NOT_ENTRIES.map((value) => resolveTarget(value, ['import']))).toEqual(
			NOT_ENTRIES.map(() => undefined),
		)
	})
})

describe('resolveDeclaration', () => {
	it('follows condition and fallback order to the first declaration that exists as a file', () => {
		const scratch = createScratch({ files: { 'dist/index.d.ts': '', 'dist/index.d.cts': '' } })
		try {
			const entry = {
				import: { types: './dist/index.d.ts', default: './dist/index.js' },
				require: [{ types: './dist/missing.d.cts' }, { types: './dist/index.d.cts' }],
			}

			expect(resolveDeclaration(entry, DECLARATION_CONDITIONS.module, scratch.path)).toBe(
				'./dist/index.d.ts',
			)
			expect(resolveDeclaration(entry, DECLARATION_CONDITIONS.commonjs, scratch.path)).toBe(
				'./dist/index.d.cts',
			)
			expect(resolveDeclaration(entry, ['types'], scratch.path)).toBeUndefined()
			expect(resolveDeclaration('./dist/missing.js', [], scratch.path)).toBeUndefined()
			expect(resolveDeclaration(3, [], scratch.path)).toBeUndefined()
		} finally {
			scratch.destroy()
		}
	})
})

describe('declaresCommonJS', () => {
	it('admits a .d.cts and a .d.ts in a CommonJS scope, and refuses a .d.mts, a module scope, and a missing file', () => {
		const scratch = createScratch({ files: COMMONJS_FILES })
		try {
			expect(COMMONJS_CASES.map(([entry]) => declaresCommonJS(entry, scratch.path))).toEqual(
				COMMONJS_CASES.map(([, admitted]) => admitted),
			)
		} finally {
			scratch.destroy()
		}
	})
})

describe('collectTargets, isModuleTarget, and isDeclarationTarget', () => {
	it('collect every target under any condition and drop an invalid member of a fallback list', () => {
		expect(
			collectTargets({
				import: './a.js',
				require: ['./b.cjs', 'bad', './node_modules/x.js'],
				types: { default: './c.d.ts' },
			}),
		).toEqual(['./a.js', './b.cjs', './c.d.ts'])
		expect(collectTargets('./only.js')).toEqual(['./only.js'])
		expect(NOT_ENTRIES.map((value) => collectTargets(value))).toEqual(NOT_ENTRIES.map(() => []))
	})

	it('call a target a module when its file name carries a module extension, an addon extension, or none', () => {
		expect(MODULE_TARGET_CASES.map(([target]) => isModuleTarget(target))).toEqual(
			MODULE_TARGET_CASES.map(([, module]) => module),
		)
	})

	it('call a target a declaration when it ends in a declaration extension', () => {
		expect(DECLARATION_TARGET_CASES.map(([target]) => isDeclarationTarget(target))).toEqual(
			DECLARATION_TARGET_CASES.map(([, declaration]) => declaration),
		)
	})
})

describe('computeDeclaration, targetToDeclaration, readDeclaration, and readPackageType', () => {
	it('substitute a declaration beside a target, accept one that exists, and read the scope of a nested manifest', () => {
		const scratch = createScratch({ files: READER_FILES })
		scratch.ensure('folder/package.json')
		try {
			expect(COMPUTE_DECLARATION_CASES.map(([target]) => computeDeclaration(target))).toStrictEqual(
				COMPUTE_DECLARATION_CASES.map(([, declaration]) => declaration),
			)
			expect(
				TARGET_DECLARATION_CASES.map(([target]) => targetToDeclaration(target, scratch.path)),
			).toStrictEqual(TARGET_DECLARATION_CASES.map(([, declaration]) => declaration))
			expect(
				PACKAGE_TYPE_CASES.map(([target]) => readPackageType(scratch.path, target)),
			).toStrictEqual(PACKAGE_TYPE_CASES.map(([, type]) => type))
			expect(readPackageType(join(scratch.path, 'dist'), './x.js')).toBeUndefined()
			expect(
				readDeclaration(
					{
						import: { types: './dist/index.d.ts' },
						require: { types: './dist/index.d.cts' },
					},
					scratch.path,
				),
			).toEqual({
				module: './dist/index.d.ts',
				commonjs: './dist/index.d.cts',
				browser: './dist/index.d.ts',
			})
		} finally {
			scratch.destroy()
		}
	})
})

describe('ScopeWalk', () => {
	it('yields each directory from the start up to the installed package and then ends', () => {
		expect([...new ScopeWalk('/pkg', '/pkg/dist/a')]).toEqual(['/pkg/dist/a', '/pkg/dist', '/pkg'])
		expect([...new ScopeWalk('/pkg', '/pkg')]).toEqual(['/pkg'])
	})

	it('ends at the filesystem root when the start lies outside the installed package', () => {
		const root = parse(process.cwd()).root
		const outside = join(root, 'one', 'two')

		expect([...new ScopeWalk(join(root, 'elsewhere'), outside)]).toEqual([
			outside,
			join(root, 'one'),
			root,
		])
	})

	it('walks a quarter of a million directories, more than a recursion could hold on any stack', () => {
		const { root } = parse(process.cwd())
		const start = join(root, 'a/'.repeat(250_000))

		const walked = Array.from(new ScopeWalk(root, start))

		expect(walked).toHaveLength(250_001)
		expect(walked[0]).toBe(start)
		expect(walked[250_000]).toBe(root)
	})
})

describe('readScopeType', () => {
	it('holds no frame per directory, so every check reads the same stack depth however deep the target', () => {
		const scratch = createScratch({ files: READER_FILES })
		const target = join(scratch.path, ...Array.from({ length: 200 }, () => 'a'))
		const depths = createRecorder<[number]>()
		try {
			expect(
				readScopeType(scratch.path, target, (path) => {
					depths.handler(readStackDepth())
					return isFilePath(path)
				}),
			).toBe('commonjs')
		} finally {
			scratch.destroy()
		}

		expect(depths.calls).toHaveLength(201)
		expect(new Set(depths.calls.map(([depth]) => depth)).size).toBe(1)
	})

	it('reads the nearest manifest at or above the directory and stops at the installed package', () => {
		const scratch = createScratch({ files: READER_FILES })
		scratch.ensure('folder/package.json')
		try {
			expect(readScopeType(scratch.path, join(scratch.path, 'module'))).toBe('module')
			expect(readScopeType(scratch.path, join(scratch.path, 'folder'))).toBe('commonjs')
			expect(readScopeType(scratch.path, join(scratch.path, 'module', 'missing'))).toBe('module')
			expect(readScopeType(join(scratch.path, 'dist'), join(scratch.path, 'dist'))).toBeUndefined()
			expect(
				readScopeType(join(scratch.path, 'dist'), join(scratch.path, 'dist', 'a')),
			).toBeUndefined()
		} finally {
			scratch.destroy()
		}
	})
})

describe('resolvesBrowser and resolvesCommonJS', () => {
	it('read a browser target off a condition or the browser output convention, and a CommonJS target off its extension or scope', () => {
		const scratch = createScratch({ files: CLASSIFIER_FILES })
		try {
			const manifest = readJson(join(scratch.path, 'package.json'))
			if (!isRecord(manifest) || !isRecord(manifest.exports)) {
				throw new Error('The classifier fixture declares no exports map')
			}
			const mappings = manifest.exports

			expect({
				condition: resolvesBrowser(mappings.condition),
				convention: resolvesBrowser(mappings.convention),
				universal: resolvesBrowser(mappings.universal),
				import: resolvesBrowser(mappings['import-shared']),
				require: resolvesBrowser(mappings['require-shared']),
				node: resolvesBrowser(mappings.node),
			}).toStrictEqual({
				condition: true,
				convention: true,
				universal: false,
				import: false,
				require: false,
				node: false,
			})
			expect({
				silent: resolvesCommonJS(mappings.silent, scratch.path),
				module: resolvesCommonJS(mappings.module, scratch.path),
				nestedModule: resolvesCommonJS(mappings['nested-module'], scratch.path),
				nestedCommonJS: resolvesCommonJS(mappings['nested-commonjs'], scratch.path),
				esm: resolvesCommonJS(mappings.esm, scratch.path),
			}).toStrictEqual({
				silent: true,
				module: false,
				nestedModule: false,
				nestedCommonJS: true,
				esm: false,
			})
		} finally {
			scratch.destroy()
		}
	})
})

describe('collectDiagnostics', () => {
	it('opens a diagnostic on each unindented line and gathers the indented lines under it, trimmed', () => {
		expect(
			collectDiagnostics([
				'',
				'a.ts(1,1): error TS1: one',
				'  detail one',
				'',
				'    detail two ',
				'b.ts(2,2): error TS2: two',
				'  ',
				'  tail',
			]),
		).toStrictEqual([
			{ head: 'a.ts(1,1): error TS1: one', details: ['detail one', 'detail two'] },
			{ head: 'b.ts(2,2): error TS2: two', details: ['tail'] },
		])
		expect(collectDiagnostics(['  orphan', 'c.ts(1,1): error TS3: three'])).toStrictEqual([
			{ head: '  orphan', details: [] },
			{ head: 'c.ts(1,1): error TS3: three', details: [] },
		])
		expect(collectDiagnostics(['', '  '])).toStrictEqual([])
	})
})

describe('classifyExport and classifyExports', () => {
	it('partition a map into driven entries, undeclared subpaths a runtime loads, and excluded publications', () => {
		const scratch = createScratch({ files: READER_FILES })
		try {
			const classified = classifyExports(
				{
					'.': { types: './dist/index.d.ts', import: './dist/index.js' },
					'./package.json': './package.json',
					'./style.css': './dist/style.css',
					'./x': { import: './dist/x.js' },
				},
				'@scope/pkg',
				scratch.path,
			)

			expect(classified.entries.map((entry) => [entry.subpath, entry.specifier])).toStrictEqual([
				['.', '@scope/pkg'],
			])
			expect(classified.subpaths).toStrictEqual(['.', './package.json', './style.css', './x'])
			expect(classified.undeclared).toStrictEqual(['./x'])
			expect(classified.excluded).toStrictEqual(['./package.json', './style.css'])
			expect(classified.targets).toStrictEqual([
				'./dist/index.d.ts',
				'./dist/index.js',
				'./package.json',
				'./dist/style.css',
				'./dist/x.js',
			])
			expect(classifyExport('./x', { import: './dist/x.js' }, '@scope/pkg', scratch.path)).toEqual({
				subpath: './x',
				files: ['./dist/x.js'],
				entry: undefined,
				loaded: true,
			})
		} finally {
			scratch.destroy()
		}
	})

	it('drive an entry under the conditions of the format it answers and no other', () => {
		const scratch = createScratch({ files: FIXTURE_PACKAGE_FILES })
		try {
			const manifest = readJson(join(scratch.path, 'package.json'))
			if (!isRecord(manifest) || !isRecord(manifest.exports)) {
				throw new Error('The fixture package declares no exports map')
			}
			const { entries, excluded } = classifyExports(
				manifest.exports,
				FIXTURE_PACKAGE_NAME,
				scratch.path,
			)
			const [entry] = entries

			expect(excluded).toEqual(['./package.json'])
			expect(entry).toMatchObject({
				subpath: '.',
				specifier: FIXTURE_PACKAGE_NAME,
				browser: false,
				module: true,
				commonjs: true,
				required: true,
				declaration: { module: true, commonjs: true, browser: true },
			})
			if (entry === undefined) throw new Error('the fixture package classified no entry')
			expect(selectEntries(entries, DECLARATION_CONDITIONS.module)).toEqual([entry])
			expect(selectEntries(entries, DECLARATION_CONDITIONS.commonjs)).toEqual([entry])
			expect(selectEntries(entries, ['nothing'])).toEqual([])
			expect(selectDrivers(entry, 'module').map((driver) => driver.label)).toEqual([
				'node16',
				'nodenext',
				'bundler',
			])
			expect(selectDrivers(entry, 'commonjs').map((driver) => driver.label)).toEqual([
				'node16',
				'nodenext',
				'bundler',
			])
			expect(selectUntypable(entries, scratch.path)).toEqual([])
		} finally {
			scratch.destroy()
		}
	})
})

describe('buildStubStage and IMPORT_ONLY_ENTRY', () => {
	it('hold nothing the compile helpers would read: an empty stage under a consumer and an import-only entry', () => {
		const stage = buildStubStage('/consumer')

		expect(stage).toEqual({
			consumer: '/consumer',
			installed: join('/consumer', 'node_modules', 'pkg'),
			archives: [],
			entries: [],
			subpaths: [],
			undeclared: [],
			excluded: [],
			targets: [],
		})
		expect(IMPORT_ONLY_ENTRY).toMatchObject({ module: true, commonjs: false, required: false })
		expect(Object.isFrozen(IMPORT_ONLY_ENTRY)).toBe(true)
	})
})

describe('selectDrivers and selectUntypable', () => {
	it('give an import-only entry no CommonJS driver and every module driver', () => {
		expect(selectDrivers(IMPORT_ONLY_ENTRY, 'commonjs')).toEqual([])
		expect(selectDrivers(IMPORT_ONLY_ENTRY, 'module')).toHaveLength(RESOLUTIONS.length)
	})

	it('name the entry that answers require and maps it but declares no CommonJS-admitting file', () => {
		const scratch = createScratch({ files: { 'ok.d.cts': '', 'only.d.mts': '' } })
		try {
			const stranded: DistributionEntry = {
				...IMPORT_ONLY_ENTRY,
				mapping: { require: { types: './only.d.mts' } },
				required: true,
			}
			const declared: DistributionEntry = {
				...IMPORT_ONLY_ENTRY,
				mapping: { require: { types: './ok.d.cts' } },
				required: true,
			}
			const unmapped: DistributionEntry = {
				...IMPORT_ONLY_ENTRY,
				mapping: { default: { types: './only.d.mts' } },
				required: true,
			}
			const imported: DistributionEntry = {
				...IMPORT_ONLY_ENTRY,
				mapping: { require: { types: './only.d.mts' } },
				required: false,
			}

			expect(selectUntypable([stranded, declared, unmapped, imported], scratch.path)).toEqual([
				stranded,
			])
		} finally {
			scratch.destroy()
		}
	})
})

describe('the stage writers', () => {
	it('write a file with the directories above it and read a manifest name or refuse one', () => {
		const scratch = createScratch()
		try {
			const path = join(scratch.path, 'deep', 'er', 'file.json')
			writeFixtureFile(path, '{"name":"pkg","n":1}\n')

			expect(scratch.read('deep/er/file.json')).toBe('{"name":"pkg","n":1}\n')
			expect(readJson(path)).toEqual({ name: 'pkg', n: 1 })
			expect(readManifestName(path)).toBe('pkg')
			writeFixtureFile(path, '{"n":1}\n')
			expect(() => readManifestName(path)).toThrow(
				`The manifest at ${path} declares no package name`,
			)
		} finally {
			scratch.destroy()
		}
	})

	it('write a scratch project over named modules, and a consumer module importing each specifier', () => {
		const scratch = createScratch()
		try {
			const stage = buildStubStage(scratch.path)
			const project = writeProject(stage, 'probe', BROWSER_DRIVER, ['./a.ts'])
			writeConsumerProbe(stage, 'probe.ts', ['pkg', 'pkg/sub'])

			expect(project).toBe(join(scratch.path, 'tsconfig.probe.json'))
			expect(readJson(project)).toEqual({
				compilerOptions: {
					module: 'esnext',
					moduleResolution: 'bundler',
					noEmit: true,
					skipLibCheck: true,
					strict: true,
					target: 'esnext',
					types: [],
				},
				files: ['./a.ts'],
			})
			expect(scratch.read('probe.ts')).toBe(
				'import * as entry0 from "pkg"\nimport * as entry1 from "pkg/sub"\nexport const surface = [entry0, entry1]\n',
			)
		} finally {
			scratch.destroy()
		}
	})

	it('write a consumer module over every specifier even when the list holds a replaced iterator', () => {
		const scratch = createScratch()
		try {
			const stage = buildStubStage(scratch.path)
			const specifiers = Object.defineProperty(['a', 'b'], Symbol.iterator, {
				value: function* () {
					yield 'z'
				},
			})
			writeConsumerProbe(stage, 'probe.ts', specifiers)

			expect(scratch.read('probe.ts')).toBe(
				'import * as entry0 from "a"\nimport * as entry1 from "b"\nexport const surface = [entry0, entry1]\n',
			)
		} finally {
			scratch.destroy()
		}
	})
})

describe('the stage runners', () => {
	it('run Node in a directory and join the output and error streams of the finished process', () => {
		const scratch = createScratch()
		try {
			const result = runNode(
				['-e', 'process.stdout.write("out\\n");process.stderr.write("err\\n");process.exitCode=3'],
				scratch.path,
			)

			expect(result.status).toBe(3)
			expect(result.stdout).toBe('out\n')
			expect(readSpawnOutput(result)).toBe('out\nerr')
			expect(runNode(['-p', 'process.cwd()'], scratch.path).stdout.trim()).toBe(
				realpathSync(scratch.path),
			)
		} finally {
			scratch.destroy()
		}
	})

	it('run npm with its cache pinned to the directory it is given', () => {
		const scratch = createScratch()
		try {
			const cache = join(scratch.path, 'cache')
			const result = runNpm(['config', 'get', 'cache'], scratch.path, cache)

			expect(result.status).toBe(0)
			expect(result.stdout.trim()).toBe(cache)
			expect(runNpm(['--version'], scratch.path, cache).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u)
		} finally {
			scratch.destroy()
		}
	}, 30_000)

	it('resolve the compiler a workspace installs and the install command of the host', () => {
		const compiler = resolveCompiler()

		expect(compiler.endsWith(join('typescript', 'bin', 'tsc'))).toBe(true)
		expect(isFilePath(compiler)).toBe(true)
		expect(resolveCompiler(WORKSPACE_ROOT)).toBe(compiler)
		expect(NPM_COMMAND).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm')
		expect(NPM_SHELL).toBe(process.platform === 'win32')
		expect(typeof RELEASE_MODE).toBe('boolean')
	})
})

describe('the stage on an installed fixture package', () => {
	const scratch = createScratch()
	afterAll(() => {
		scratch.destroy()
	})
	const root = createScratch({ files: FIXTURE_PACKAGE_FILES })
	afterAll(() => {
		root.destroy()
	})

	it('packs one archive, installs it in isolation, and classifies the exports map it publishes', () => {
		const stage = buildStage(scratch.path, root.path)

		expect(stage.archives).toEqual([`${FIXTURE_PACKAGE_NAME}-1.0.0.tgz`])
		expect(isFilePath(join(stage.installed, 'package.json'))).toBe(true)
		expect(stage.installed).toBe(join(stage.consumer, 'node_modules', FIXTURE_PACKAGE_NAME))
		expect(stage.entries.map((entry) => entry.specifier)).toEqual([FIXTURE_PACKAGE_NAME])
		expect(stage.subpaths).toEqual(['.', './package.json'])
		expect(stage.excluded).toEqual(['./package.json'])
		expect(stage.undeclared).toEqual([])
		expect([...stage.targets].sort()).toEqual(
			['./index.cjs', './index.d.cts', './index.d.ts', './index.js', './package.json'].sort(),
		)
	}, 120_000)

	it('reads the names a real process publishes off the installed entry under each format', () => {
		const stage = buildStage(join(scratch.path, 'again'), root.path)

		expect(driveRuntime(stage, FIXTURE_PACKAGE_NAME, ESM_DRIVER)).toEqual(['answer', 'extra'])
		expect(driveRuntime(stage, FIXTURE_PACKAGE_NAME, CJS_DRIVER)).toEqual(['answer', 'extra'])
		expect(() =>
			driveRuntime(stage, `${FIXTURE_PACKAGE_NAME}${ABSENT_SUBPATH}`, ESM_DRIVER),
		).toThrow(/ERR_PACKAGE_PATH_NOT_EXPORTED/u)
		expect(() => driveRuntime(stage, FIXTURE_PACKAGE_NAME, 'absent.mjs')).toThrow(
			/Loading distribution-fixture from the consumer failed/u,
		)
	}, 120_000)

	it('compares published names with declared ones in both directions, under every driver', () => {
		const stage = buildStage(join(scratch.path, 'compare'), root.path)
		const [entry] = stage.entries
		if (entry === undefined) throw new Error('the fixture package classified no entry')
		const published = driveRuntime(stage, FIXTURE_PACKAGE_NAME, ESM_DRIVER)

		expect(
			RESOLUTIONS.flatMap((driver) =>
				checkSurface(stage, { entry, extension: 'ts', published, driver }),
			),
		).toEqual([])
		const missing = RESOLUTIONS.flatMap((driver) =>
			checkSurface(stage, { entry, extension: 'ts', published: ['answer'], driver }),
		)
		const extra = RESOLUTIONS.flatMap((driver) =>
			checkSurface(stage, {
				entry,
				extension: 'ts',
				published: ['answer', 'extra', 'phantom'],
				driver,
			}),
		)

		expect(missing.length).toBeGreaterThan(0)
		expect(missing.every((line) => /^(node16|nodenext|bundler): /u.test(line))).toBe(true)
		expect(missing.join('\n')).toContain('extra')
		expect(extra.join('\n')).toContain('phantom')
	}, 120_000)

	it('compiles a probe under every resolution and importing format, with a control that must be loud', () => {
		const stage = buildStage(join(scratch.path, 'compile'), root.path)

		const compilations = RESOLUTIONS.flatMap((driver) =>
			FORMATS.flatMap(([extension, format]) => {
				const compilation = checkResolution(stage, FIXTURE_PACKAGE_NAME, driver, extension, format)
				return compilation === undefined ? [] : [compilation]
			}),
		)

		expect(compilations.map((compilation) => compilation.label)).toEqual([
			'node16.ts',
			'node16.cts',
			'nodenext.ts',
			'nodenext.cts',
			'bundler.ts',
			'bundler.cts',
		])
		expect(compilations.flatMap((compilation) => compilation.reported)).toEqual([])
		expect(compilations.filter((compilation) => compilation.silent)).toEqual([])
		expect(
			checkResolution(stage, FIXTURE_PACKAGE_NAME, BROWSER_DRIVER, 'ts', 'module'),
		).toMatchObject({ label: 'bundler.ts', reported: [], silent: false })
	}, 120_000)

	it('reports a located diagnostic, and refuses a fault in the scratch project itself', () => {
		const dir = createScratch({
			files: { 'bad.ts': 'export const n: number = "text"\n', 'good.ts': 'export const n = 1\n' },
		})
		try {
			const stage = buildStubStage(dir.path)
			const bad = writeProject(stage, 'bad', BROWSER_DRIVER, ['./bad.ts'])
			const good = writeProject(stage, 'good', BROWSER_DRIVER, ['./good.ts'])
			const absent = writeProject(stage, 'absent', BROWSER_DRIVER, ['./absent.ts'])
			const faulty = dir.write(
				'tsconfig.faulty.json',
				'{"compilerOptions":{"noSuchOption":true},"files":["./good.ts"]}\n',
			)

			expect(checkProject(stage, bad)).toEqual([
				expect.stringMatching(/^bad\.ts\(1,14\): error TS2322: Type 'string' is not assignable/u),
			])
			expect(checkProject(stage, good)).toEqual([])
			expect(() => checkProject(stage, absent)).toThrow(
				/The consumer compiler reported error TS6053.*which names no location/u,
			)
			expect(() => checkProject(stage, faulty)).toThrow(/The scratch project is itself at fault/u)
		} finally {
			dir.destroy()
		}
	}, 60_000)

	it('opens a stage when the registry answers, reports none when it does not, and fails the release gate', async () => {
		const reachable = createScratch()
		const unreachable = createScratch()
		const gated = createScratch()
		const kept = process.env.npm_config_registry
		try {
			const stage = openStage(reachable.path, false, root.path)

			expect(stage?.entries.map((entry) => entry.specifier)).toEqual([FIXTURE_PACKAGE_NAME])

			process.env.npm_config_registry = 'http://127.0.0.1:1'
			expect(openStage(unreachable.path, false, root.path)).toBeUndefined()
			expect(unreachable.has('cache')).toBe(true)
			expect(() => openStage(gated.path, true, root.path)).toThrow(
				'The release gate requires a reachable npm registry, and npm ping did not answer',
			)
			expect(isFilePath(gated.path)).toBe(false)
		} finally {
			if (kept === undefined) delete process.env.npm_config_registry
			else process.env.npm_config_registry = kept
			reachable.destroy()
			unreachable.destroy()
			gated.destroy()
		}
	}, 120_000)

	it('refuses a workspace npm cannot pack and one whose archive it cannot install', () => {
		const empty = createScratch()
		try {
			expect(() => buildStage(join(scratch.path, 'refused'), empty.path)).toThrow(
				/npm pack refused this workspace/u,
			)
		} finally {
			empty.destroy()
		}
	}, 60_000)
})

describe('createPingRegistry', () => {
	it('answers the reachability check from another process, serves no package, and stops twice without error', async () => {
		const registry = await createPingRegistry()
		const { url } = registry
		const pong = await fetch(`${url}/-/ping?write=true`)
		const missing = await fetch(`${url}/some-package`)

		expect(pong.status).toBe(200)
		expect(await pong.json()).toEqual({})
		expect(missing.status).toBe(404)
		await registry.stop()
		await expect(registry.stop()).resolves.toBeUndefined()
		await expect(fetch(`${url}/-/ping`)).rejects.toThrow('fetch failed')
	}, 30_000)
})

describe('buildNpmEnvironment', () => {
	it('pins the cache and leaves no variable of another letter case naming it', () => {
		const stale = process.env.NPM_CONFIG_CACHE
		process.env.NPM_CONFIG_CACHE = 'stale'
		try {
			const environment = buildNpmEnvironment('pinned')

			expect(
				Object.entries(environment).filter(([key]) => key.toLowerCase() === 'npm_config_cache'),
			).toEqual([['npm_config_cache', 'pinned']])
			expect(environment.PATH ?? environment.Path).toBe(process.env.PATH ?? process.env.Path)
		} finally {
			if (stale === undefined) delete process.env.NPM_CONFIG_CACHE
			else process.env.NPM_CONFIG_CACHE = stale
		}
	})
})

// The hermetic projects run on a host with no daemon, and `npm test` runs them against the
// user's own. `tests/setupService.ts` contacts the selected daemon when it loads, so a
// hermetic project that imports it, or that loads it as a setup file, reaches that daemon on
// every run. The cases above prove the exported walker against fixture workspaces, one per
// syntax form and per walk rule. This block proves that the walker reports the real workspace:
// the projects come from `vite.config.ts`, and the walk follows every import from them to a fixed
// point. It stays in this file because the walker is exported from `tests/setupServer.ts`, and
// no vendored proof owns a package-specific workspace law.

describe('the exported walker reports the real workspace', () => {
	const projects = listProjects(workspace)
	const hermetic = projects.filter(
		(project) => !Object.hasOwn(NON_HERMETIC_PROJECTS, project.label),
	)
	const population = [
		...new Set([
			...hermetic.flatMap((project) => listProjectSources(project.test)),
			...listSources(['tests/setup*.ts']),
		]),
	].sort()

	it('derives the projects from vite.config.ts and leaves out only the two that may reach the daemon, each with its reason', () => {
		const labels = projects.map((project) => project.label)

		expect(Object.keys(NON_HERMETIC_PROJECTS).sort()).toEqual(['probe', 'service'])
		expect(labels).toEqual(expect.arrayContaining(Object.keys(NON_HERMETIC_PROJECTS)))
		expect(Object.values(NON_HERMETIC_PROJECTS).every((reason) => reason.length > 0)).toBe(true)
		expect(hermetic.map((project) => project.label).sort()).toEqual(
			Object.keys(HERMETIC_WITNESSES).sort(),
		)
	})

	it('collect the files of every hermetic project, its setup modules, and the root setup modules', () => {
		expect(
			hermetic.map((project) => [
				project.label,
				listProjectSources(project.test).includes(HERMETIC_WITNESSES[project.label] ?? ''),
			]),
		).toEqual(hermetic.map((project) => [project.label, true]))
		expect(population).toEqual(
			expect.arrayContaining([
				'tests/src/server/errors.test.ts',
				'tests/setup.ts',
				'tests/setupPolicy.ts',
				'tests/setupServer.ts',
				'tests/setupService.ts',
				FIXTURE_HOSTED_IMPORTER,
			]),
		)
		expect(population.filter((path) => path.startsWith('tests/service/'))).toEqual([])
	})

	it('list tests/setupService.ts as a setup file in no hermetic project, and only the service project does', () => {
		const service = projects.find((project) => project.label === 'service')

		expect(hermetic.flatMap((project) => findServiceSetupFiles(project.test))).toEqual([])
		expect(findServiceSetupFiles(service?.test)).toEqual(['./tests/setupService.ts'])
	})

	it('reach tests/setupService only through the fixture-hosted proof, however deep the import', async () => {
		const closure = await collectModuleClosure(population)

		expect(await findServiceImporters(population)).toEqual([FIXTURE_HOSTED_IMPORTER])
		expect(findComputedFiles(closure)).toEqual(Object.keys(COMPUTED_URL_FILES))
		for (const file of Object.keys(COMPUTED_URL_FILES)) {
			expect(
				closure
					.get(file)
					?.references.filter((reference) => reference.specifier === undefined)
					.map((reference) => reference.form),
			).toEqual(['url'])
		}
		expect(closure.has('src/core/index.ts')).toBe(true)
		expect(closure.has('src/server/index.ts')).toBe(true)
		expect(closure.has('src/server/errors.ts')).toBe(true)
		expect(closure.has('vite.config.ts')).toBe(true)
		expect([...closure.keys()].filter((path) => path.startsWith('tests/service/'))).toEqual([])
	})

	it('let the fixture-hosted proof import it only after the environment names the fixture', async () => {
		const text = findFileText(join(rootToPath(WORKSPACE_ROOT), FIXTURE_HOSTED_IMPORTER))
		if (text === undefined) throw new Error(`${FIXTURE_HOSTED_IMPORTER} cannot be read`)

		expect(await findServiceImports(text)).toEqual(['./setupService.js'])
		expect(text.indexOf('process.env.OLLAMA_HOST =')).toBeGreaterThan(-1)
		expect(text.indexOf('process.env.OLLAMA_HOST =')).toBeLessThan(
			text.indexOf("await import('./setupService.js')"),
		)
	})
})

describe('store fixtures', () => {
	// The hermetic half of `tests/setupServer.ts`. That module serves the store the live
	// browser-vocabulary proof drives, runs one model attempt over it, and reads the
	// transcript the attempt leaves. The live half — that a real model drives a real Chromium
	// through the toolset over this store — is `tests/service/browser.test.ts`.
	//
	// The attempt-isolation proof drives a real browser without a daemon. The other proofs cover
	// every page's shape read with a plain `fetch`, the per-instance state the pages change,
	// the whole-page reading `read` slices
	// (the browser package's own `createBrowserReading` over the served HTML), and every pure
	// reader the live proof asserts through.

	const staging = Promise.withResolvers<StoreServerInterface>()

	describe('real line projection', () => {
		it(
			'accepts the measured cart path through refused type calls',
			async () => {
				const fresh = await createStoreServer()
				const browser = await createPageBrowser()
				try {
					await browser.connect()
					const context = await browser.isolate()
					const page = await context.create()
					await page.navigate(fresh.url)
					const toolset = createBrowserToolset(page)
					try {
						await toolset.start()
						const seed = renderToolText(
							await toolset.tools.execute({
								id: 'seed',
								name: 'read',
								arguments: STORE_SEED_ARGUMENTS,
							}),
						)
						const calls: StoreCall[] = []
						for (const call of STORE_CART_CALLS) {
							calls.push(
								await executeStoreCall(
									toolset.tools,
									String(calls.length),
									call.name,
									call.arguments,
								),
							)
						}
						expect(calls.map((call) => call.success)).toEqual([true, false, true, false, true])
						for (const call of calls.filter((entry) => !entry.success))
							expect(call.text).toContain('takes no text;')
						expect(fresh.read().cart).toEqual([STORE_NAMED_PRODUCT])
						expect(findUnlistedReferences(seed, calls)).toEqual([])
						expect(
							matchesCartOracle({
								...buildStoreTranscript(calls, seed),
								state: fresh.read(),
							}),
						).toBe(true)
					} finally {
						await toolset.destroy()
					}
				} finally {
					await browser.destroy()
					await fresh.stop()
				}
			},
			CASE_TIMEOUT,
		)
		it(
			'applies the reference-exposure rule to successful reads, page changes, actions, and refusals',
			async () => {
				const fresh = await createStoreServer()
				const browser = await createPageBrowser()
				try {
					await browser.connect()
					for (const scenario of STORE_EXPOSURE_SCENARIOS) {
						const context = await browser.isolate()
						try {
							const page = await context.create()
							await page.navigate(fresh.url)
							const toolset = createBrowserToolset(page)
							try {
								await toolset.start()
								const seed = renderToolText(
									await toolset.tools.execute({
										id: 'seed',
										name: 'read',
										arguments: STORE_SEED_ARGUMENTS,
									}),
								)
								const calls: StoreCall[] = []
								if (scenario === 'changed' || scenario === 'refused')
									await page.navigate(`${fresh.url}/policy`)
								if (
									scenario === 'unchanged' ||
									scenario === 'bestmatch' ||
									scenario === 'changed'
								) {
									const input =
										scenario === 'bestmatch'
											? { from: 46, to: 52, search: STORE_NAMED_PRODUCT }
											: { from: 46, to: 52 }
									calls.push(await executeStoreCall(toolset.tools, 'read', 'read', input))
								}
								for (const call of calls) expect(call.success).toBe(true)
								for (const call of calls.filter(
									(entry) => entry.arguments['search'] === STORE_NAMED_PRODUCT,
								)) {
									expect(call.text).toContain('the best match is line 11:')
									expect(extractReferences(call.text)).toEqual(['e7'])
									expect(parseWindowLine(call.text)).toBe(46)
								}
								// A fresh read after the out-of-band navigation invalidates the tool's own reference map.
								if (scenario === 'refused')
									await toolset.tools.execute({
										id: 'refresh',
										name: 'read',
										arguments: { from: 1 },
									})
								const input = { ref: scenario === 'invented' ? 'e99999' : 'e7' }
								const action = await executeStoreCall(toolset.tools, 'click', 'click', input)
								calls.push(action)
								const accepted = STORE_ACCEPTED_EXPOSURES.includes(scenario)
								expect(action.success).toBe(accepted)
								expect(/not in the current view|is not on this page/.test(action.text)).toBe(
									!accepted,
								)
								expect(findUnlistedReferences(seed, calls)).toEqual(accepted ? [] : [action])
							} finally {
								await toolset.destroy()
							}
						} finally {
							await context.close()
						}
					}
				} finally {
					await browser.destroy()
					await fresh.stop()
				}
			},
			CASE_TIMEOUT,
		)
		it(
			'records a cart click and one submission, removes the click, and replays exactly one order for the other buyer',
			async () => {
				mkdirSync(resolveJourneyPath(), { recursive: true })
				const fresh = await createStoreServer()
				const root = createScratch({ parent: resolveJourneyPath(), prefix: 'journey-proof-' })
				const browser = await createPageBrowser()
				try {
					await browser.connect()
					const context = await browser.isolate()
					const page = await context.create()
					await page.navigate(fresh.url)
					const tools = createBrowserToolset(page, {
						journeys: {
							store: createFileBrowserJourneyStore({ root: root.path }),
							runs: createFileBrowserRunStore({ root: root.path }),
						},
					})
					try {
						await tools.start()
						const seed = renderToolText(
							await tools.tools.execute({ id: 'seed', name: 'read', arguments: { from: 1 } }),
						)
						const calls: StoreCall[] = []
						for (const action of STORE_JOURNEY_ACTIONS) {
							const { name, input } = buildJourneyInvocation(action, calls, seed)
							const call = await executeStoreCall(tools.tools, action, name, input)
							expect(call).toMatchObject({ success: true })
							calls.push(call)
						}
						const transcript = {
							...buildStoreTranscript(calls, seed),
							name: 'journey',
							files: readInventory(root.path, ['.'], { extensions: ['.json'] }),
							state: fresh.read(),
						}
						expect(transcript.state.orders).toEqual([STORE_BUYER, STORE_JOURNEY_BUYER])
						expect(matchesJourneyOracle(transcript)).toBe(true)
						expect(
							filterSubmissionLines(requireValue(calls.find((call) => call.name === 'save')).text),
						).toHaveLength(1)
						for (const refused of buildRefusedTranscripts(
							transcript,
							(STORE_TASKS.journey.limit ?? STORE_BOUNDS.limit) +
								STORE_TASKS.journey.followups.length * STORE_BOUNDS.limit,
						))
							expect(matchesJourneyOracle(refused)).toBe(false)
					} finally {
						await tools.destroy()
					}
				} finally {
					await browser.destroy()
					root.destroy()
					await fresh.stop()
				}
			},
			CASE_TIMEOUT,
		)

		it(
			'places the fact beyond the seed and the token in the third default window',
			async () => {
				const store = await staging.promise
				const browser = await createPageBrowser()
				try {
					await browser.connect()
					const context = await browser.isolate()
					const page = await context.create()
					await page.navigate(store.url)
					const tools = createBrowserToolset(page)
					try {
						await tools.start()

						const seed = renderToolText(
							await tools.tools.execute({
								id: 'seed',
								name: 'read',
								arguments: STORE_SEED_ARGUMENTS,
							}),
						)
						expect(seed).not.toContain(STORE_FACT)
						expect(seed).not.toContain(STORE_POLICY_TOKEN)
						const catalogueNext = requireValue(parseFooterLine(seed))
						const shipping = renderToolText(
							await tools.tools.execute({
								id: 'shipping',
								name: 'read',
								arguments: { from: 1, search: 'shipping cutoff' },
							}),
						)
						expect(shipping).toContain(STORE_FACT)
						const fact = Number(
							requireValue(
								shipping.split(/\r\n|\n/).find((line) => line.includes(STORE_FACT)),
							).split(': ')[0],
						)
						expect(fact).toBeGreaterThan(catalogueNext - 1)
						expect(fact).toBe(52)
						expect(catalogueNext).toBe(46)
						await page.navigate(`${store.url}/policy`)
						const policy = renderToolText(
							await tools.tools.execute({
								id: 'policy',
								name: 'read',
								arguments: STORE_SEED_ARGUMENTS,
							}),
						)
						const second = requireValue(parseFooterLine(policy))
						const middle = renderToolText(
							await tools.tools.execute({
								id: 'middle',
								name: 'read',
								arguments: { from: second },
							}),
						)
						const third = requireValue(parseFooterLine(middle))
						const last = renderToolText(
							await tools.tools.execute({ id: 'last', name: 'read', arguments: { from: third } }),
						)
						expect(policy).not.toContain(STORE_POLICY_TOKEN)
						expect(middle).not.toContain(STORE_POLICY_TOKEN)
						expect(last).toContain(STORE_POLICY_TOKEN)
						const token = Number(
							requireValue(
								last.split(/\r\n|\n/).find((line) => line.includes(STORE_POLICY_TOKEN)),
							).split(': ')[0],
						)
						expect(token).toBeGreaterThan(third - 1)
						expect(token).toBe(80)
						expect(second).toBe(33)
						expect(third).toBe(61)
						expect(
							matchesPagingOracle(
								buildStoreTranscript(
									[
										buildStoreCall('read', { from: second }, middle),
										buildStoreCall('read', { from: third }, last),
									],
									policy,
								),
							),
						).toBe(true)
						expect(
							matchesPagingOracle(
								buildStoreTranscript([buildStoreCall('read', { from: second }, middle)], policy),
							),
						).toBe(false)
						for (const text of [seed, shipping, policy, middle, last])
							expect(text.length).toBeLessThanOrEqual(BROWSER_TOOL_LIMIT)
					} finally {
						await tools.destroy()
					}
				} finally {
					await browser.destroy()
				}
			},
			CASE_TIMEOUT,
		)

		it('gives the token section no prefix-rule word from the paging prompt', () => {
			const section = requireValue(STORE_POLICY.at(-1)).join(' ')
			expect(
				scanBrowserLines(
					[{ spans: [{ category: 'text', text: section }] }],
					STORE_TASKS.paging.prompt,
				),
			).toEqual([])
			expect(
				scanBrowserLines([{ spans: [{ category: 'text', text: section }] }], 'quoting version'),
			).toEqual([1])
		})
	})

	describe('case predicates', () => {
		it('accepts each page case and rejects every shared refusal including a whole result over the limit', () => {
			for (const { predicate, transcript } of STORE_ORACLE_CASES) {
				expect(predicate(transcript)).toBe(true)
				for (const refused of buildRefusedTranscripts(transcript, STORE_BOUNDS.limit))
					expect(predicate(refused)).toBe(false)
			}
			expect(Object.keys(STORE_PREDICATES)).toEqual(Object.keys(STORE_TASKS))
		})
		it('refuses missing fact evidence, the seed fact, an incorrect cart, and duplicate or wrong orders', () => {
			const shipping = {
				...buildStoreTranscript([buildStoreCall('read', { from: 1 }, STORE_FACT)]),
				answer: STORE_FACT,
			}
			expect(matchesShippingOracle({ ...shipping, seed: STORE_FACT })).toBe(false)
			expect(matchesShippingOracle({ ...shipping, answer: '' })).toBe(false)
			expect(
				matchesShippingOracle({ ...shipping, calls: [buildStoreCall('click', {}, STORE_FACT)] }),
			).toBe(false)
			expect(
				matchesShippingOracle({
					...shipping,
					calls: [buildRefusedCall('read', { from: 1 }, STORE_FACT)],
				}),
			).toBe(false)
			for (const cart of STORE_REFUSED_CARTS)
				expect(matchesCartOracle({ ...shipping, state: { ...shipping.state, cart } })).toBe(false)
			for (const orders of STORE_REFUSED_ORDERS)
				expect(
					matchesCheckoutOracle({
						...shipping,
						answer: STORE_CODE,
						state: { ...shipping.state, orders },
					}),
				).toBe(false)
			expect(
				matchesCheckoutOracle({ ...shipping, state: { ...shipping.state, orders: [STORE_BUYER] } }),
			).toBe(false)
		})
	})

	describe('monotonic operation timing', () => {
		it('records successful and refused tools without freezing the advertised registry', async () => {
			const tools = createToolManager()
			tools.add(createLookupTool())
			const timer = new StoreTimer()
			const measured = createTimedTools(tools, timer)
			expect(measured.definitions()).toEqual(tools.definitions())
			tools.add(createThrowingTool())
			expect(measured.definitions()).toEqual(tools.definitions())
			const calls = STORE_TIMED_CALLS
			const result = await measured.execute(calls)
			expect(result.map((entry) => entry.success)).toEqual([true, false])
			const timings = timer.read()
			expect(timings.map((timing) => timing.name).sort()).toEqual(['lookup', 'missing'])
			for (const timing of timings) {
				expect(timing.operation).toBe('tool')
				expect(timing.end).toBeGreaterThan(timing.start)
			}
			tools.destroy()
		})

		it('records an interval that spans the real delay of each parallel call', async () => {
			const tools = createStaggeredTools()
			const timer = new StoreTimer()
			await createTimedTools(tools, timer).execute(STORE_STAGGERED_CALLS)
			const spans = new Map(timer.read().map((timing) => [timing.name, timing.end - timing.start]))
			for (const [name, delay] of STORE_STAGGERED_DELAYS) {
				const span = requireValue(spans.get(name), `the timer lost the ${name} interval`)
				expect(span).toBeGreaterThan(0)
				expect(span).toBeGreaterThanOrEqual(delay / 2)
			}
			tools.destroy()
		})

		it('records a generation and a failed stream without changing their result or error', async () => {
			const timer = new StoreTimer()
			const provider = createTimedProvider(
				createOllama({
					model: 'fixture',
					fetch: createScriptedTransport([{ content: 'Measured.' }]),
				}),
				timer,
			)
			const signal = AbortSignal.timeout(5000)
			expect(
				(await provider.generate([{ id: '1', role: 'user', content: 'Answer.' }], signal)).content,
			).toBe('Measured.')
			const stream = provider.stream([{ id: '2', role: 'user', content: 'Answer again.' }], signal)
			await expect(stream.next()).rejects.toThrow('the script holds 1 turns')
			const timings = timer.read()
			expect(timings).toHaveLength(2)
			for (const timing of timings) {
				expect(timing.operation).toBe('generation')
				expect(timing.end).toBeGreaterThan(timing.start)
			}
		})

		it('records parallel tool calls in the order they finish, not the order they were dispatched', async () => {
			const tools = createStaggeredTools()
			const timer = new StoreTimer()
			const results = await createTimedTools(tools, timer).execute(STORE_STAGGERED_CALLS)
			expect(results.map((entry) => entry.success && entry.value)).toEqual(
				STORE_STAGGERED_CALLS.map((call) => call.name),
			)
			expect(timer.read().map((timing) => timing.name)).toEqual(
				STORE_STAGGERED_DELAYS.map(([name]) => name).toReversed(),
			)
			tools.destroy()
		})

		it('records the interval of a rejected call and of the calls still pending when it rejects', async () => {
			const tools = createStaggeredTools()
			const failure = new Error('Dispatch refused')
			const timer = new StoreTimer()
			const measured = createTimedTools(
				createRejectingTools(tools, STORE_BROKEN_CALL.name, failure),
				timer,
			)
			await expect(measured.execute(STORE_BROKEN_CALLS)).rejects.toBe(failure)
			await waitForCondition(
				'every dispatched call to record its interval',
				() => timer.read().length === STORE_BROKEN_CALLS.length,
			)
			const timings = timer.read()
			expect(timings.map((timing) => timing.name)).toEqual(['broken', 'fast', 'slow'])
			for (const timing of timings) {
				expect(timing.operation).toBe('tool')
				expect(timing.end).toBeGreaterThan(timing.start)
			}
			tools.destroy()
		})

		it('records the interval of one call that rejects and returns the registry result of one that does not', async () => {
			const tools = createStaggeredTools()
			const failure = new Error('Dispatch refused')
			const timer = new StoreTimer()
			const rejecting = createRejectingTools(tools, STORE_BROKEN_CALL.name, failure)
			await expect(executeTimedTool(rejecting, STORE_BROKEN_CALL, timer)).rejects.toBe(failure)
			const accepted = requireValue(STORE_STAGGERED_CALLS.at(-1))
			const result = await executeTimedTool(rejecting, accepted, timer)
			expect(result).toMatchObject({ success: true, value: 'fast' })
			expect(timer.read().map((timing) => [timing.operation, timing.name])).toEqual([
				['tool', 'broken'],
				['tool', 'fast'],
			])
			tools.destroy()
		})
	})

	describe('StoreTimer', () => {
		it('reads nothing before an interval is recorded', () => {
			expect(new StoreTimer().read()).toEqual([])
		})

		it('reads the intervals in the order they were recorded with every field', () => {
			const timer = new StoreTimer()
			const later: StoreTiming = { operation: 'seed', name: 'read', start: 5, end: 9 }
			const earlier: StoreTiming = { operation: 'tool', name: 'click', start: 1, end: 12 }
			timer.record(later)
			timer.record(earlier)
			expect(timer.read()).toEqual([later, earlier])
		})

		it('reads a copy, so a later interval leaves an earlier reading unchanged', () => {
			const timer = new StoreTimer()
			const first: StoreTiming = { operation: 'generation', name: 'fixture', start: 0, end: 2 }
			const second: StoreTiming = { operation: 'reload', name: 'page', start: 3, end: 4 }
			timer.record(first)
			const reading = timer.read()
			timer.record(second)
			expect(reading).toEqual([first])
			expect(timer.read()).toEqual([first, second])
			expect(timer.read()).not.toBe(timer.read())
		})
	})

	beforeAll(async () => {
		staging.resolve(await createStoreServer())
	})

	afterAll(async () => {
		await (await staging.promise).stop()
	})

	describe('createStoreServer', () => {
		it('returns state snapshots that remain unchanged after later requests', async () => {
			const fresh = await createStoreServer()
			try {
				const before = fresh.read()
				await fetch(`${fresh.url}/search?q=kettle`)
				await fetch(`${fresh.url}/order`, { method: 'POST', body: STORE_BUYER })
				await fetch(`${fresh.url}/cart`, { method: 'POST', body: 'product=p3' })
				expect(before).toEqual({ cart: [], searches: [], orders: [] })
				expect(fresh.read()).toEqual({
					cart: ['Cedar Tea Tray'],
					searches: ['kettle'],
					orders: ['Ada Lovelace'],
				})
			} finally {
				await fresh.stop()
			}
		})

		it('listens on the IPv4 loopback on an ephemeral port', async () => {
			const store = await staging.promise
			expect(store.url).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d*$/)
		})

		it('serves the catalogue with the search form and every featured product with its price', async () => {
			const store = await staging.promise
			const response = await fetch(`${store.url}/`)
			const html = await response.text()
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
			expect(html).toContain('<form action="/search" method="get" role="search">')
			expect(html).toContain('<input id="q" type="search" name="q">')
			const featured = STORE_FEATURED.map((name) =>
				requireValue(STORE_PRODUCTS.find((product) => product.name === name)),
			)
			for (const product of featured) {
				expect(html).toContain(`<a href="/product/${product.id}">${product.name}</a>`)
				expect(html).toContain(product.price)
			}
			for (const name of STORE_UNFEATURED) {
				expect(html).not.toContain(name)
			}
		})

		it('lists none of the products the search task must find, so only a search names them', async () => {
			const store = await staging.promise
			const html = await (await fetch(`${store.url}/`)).text()
			const matches = filterProducts(STORE_QUERY)
			expect(matches.length).toBeGreaterThan(0)
			for (const product of matches) expect(html).not.toContain(product.name)
		})

		it('states the shipping cutoff once, after the customer notes, beyond the first read slice', async () => {
			const store = await staging.promise
			const html = await (await fetch(`${store.url}/`)).text()
			expect(html.split(STORE_FACT)).toHaveLength(2)
			expect(html.indexOf(STORE_FACT)).toBeGreaterThan(html.indexOf('</aside>'))
			const markdown = createBrowserReading({ url: `${store.url}/`, title: '', html }).markdown()
				.text
			expect(markdown).toContain('What customers say')
			expect(markdown.split(STORE_FACT)).toHaveLength(2)
			expect(markdown.indexOf(STORE_FACT)).toBeGreaterThan(markdown.indexOf('What customers say'))
			expect(markdown.indexOf(STORE_FACT)).toBeGreaterThan(BROWSER_TOOL_LIMIT)
		})

		it('records each submitted query and lists exactly the products whose name matches it', async () => {
			const store = await staging.promise
			const before = store.read().searches.length
			const response = await fetch(`${store.url}/search?q=${STORE_QUERY}`)
			const html = await response.text()
			expect(response.status).toBe(200)
			expect(store.read().searches.slice(before)).toEqual([STORE_QUERY])
			const matches = filterProducts(STORE_QUERY)
			expect(matches.map((product) => product.name)).toEqual(['Alpine Kettle', 'Copper Kettle'])
			for (const product of STORE_PRODUCTS) {
				expect(html.includes(product.name)).toBe(matches.includes(product))
			}
		})

		it('starts with the requested products in the cart, which the journey task holds one of', async () => {
			const seeded = await createStoreServer(0, [STORE_NAMED_PRODUCT])
			try {
				expect(seeded.read().cart).toEqual([STORE_NAMED_PRODUCT])
				const html = await (await fetch(`${seeded.url}/cart`)).text()
				expect(html).toContain(STORE_NAMED_PRODUCT)
				expect(html).not.toContain('Your cart is empty.')
			} finally {
				await seeded.stop()
			}
			expect(STORE_TASKS.journey.cart).toEqual([STORE_NAMED_PRODUCT])
		})

		it('answers a query nothing matches with a page that names no product', async () => {
			const store = await staging.promise
			const html = await (await fetch(`${store.url}/search?q=anchor`)).text()
			expect(html).toContain('No products match.')
			for (const product of STORE_PRODUCTS) expect(html).not.toContain(product.name)
		})

		it('serves each product page with its add-to-cart form, and 404 for an unknown product', async () => {
			const store = await staging.promise
			for (const product of STORE_PRODUCTS) {
				const response = await fetch(`${store.url}/product/${product.id}`)
				const html = await response.text()
				expect(response.status).toBe(200)
				expect(html).toContain(`<h1>${product.name}</h1>`)
				expect(html).toContain(product.price)
				expect(html).toContain('<form action="/cart" method="post">')
				expect(html).toContain(`<input type="hidden" name="product" value="${product.id}">`)
				expect(html).toContain('<button type="submit">Add to cart</button>')
			}
			expect((await fetch(`${store.url}/product/p0`)).status).toBe(404)
		})

		it('adds a posted product to this server cart alone, redirects to the cart, and lists it there', async () => {
			const store = await staging.promise
			const other = await createStoreServer()
			try {
				const named = STORE_PRODUCTS.find((product) => product.name === STORE_NAMED_PRODUCT)
				expect(named).toBeDefined()
				const added = await fetch(`${store.url}/cart`, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: `product=${named?.id ?? ''}`,
					redirect: 'manual',
				})
				expect(added.status).toBe(303)
				expect(added.headers.get('location')).toBe('/cart')
				expect(store.read().cart).toEqual([STORE_NAMED_PRODUCT])
				expect(other.read().cart).toEqual([])
				expect(await (await fetch(`${store.url}/cart`)).text()).toContain(
					`<li>${STORE_NAMED_PRODUCT}</li>`,
				)
				const refused = await fetch(`${store.url}/cart`, { method: 'POST', body: 'product=p0' })
				expect(refused.status).toBe(404)
				expect(store.read().cart).toEqual([STORE_NAMED_PRODUCT])
			} finally {
				await other.stop()
			}
		})

		it('shows an empty cart on a fresh server', async () => {
			const other = await createStoreServer()
			try {
				expect(await (await fetch(`${other.url}/cart`)).text()).toContain('Your cart is empty.')
			} finally {
				await other.stop()
			}
		})

		it('serves a checkout whose script inserts the code only after an order, and records the order', async () => {
			const store = await staging.promise
			const html = await (await fetch(`${store.url}/checkout`)).text()
			expect(html).toContain('<form id="checkout">')
			expect(html).toContain('<input id="name" type="text" name="name" autocomplete="off">')
			expect(html).toContain('<button type="submit">Place order</button>')
			expect(html).toContain(`}, ${STORE_CODE_DELAY})`)
			expect(html).not.toContain(STORE_CODE)
			const order = await fetch(`${store.url}/order`, { method: 'POST', body: 'Grace Hopper' })
			expect(await order.text()).toBe(STORE_CODE)
			expect(store.read().orders).toEqual(['Grace Hopper'])
		})

		it('states the policy token past the first 4 000 characters of the whole-page policy', async () => {
			const store = await staging.promise
			const response = await fetch(`${store.url}/policy`)
			const html = await response.text()
			expect(response.status).toBe(200)
			const markdown = createBrowserReading({
				url: `${store.url}/policy`,
				title: '',
				html,
			}).markdown().text
			expect(markdown.indexOf(STORE_POLICY_TOKEN)).toBeGreaterThan(BROWSER_TOOL_LIMIT)
		})

		it('serves the page every task starts on', async () => {
			const store = await staging.promise
			for (const task of Object.values(STORE_TASKS)) {
				expect((await fetch(`${store.url}${task.path}`)).status).toBe(200)
			}
		})
	})

	describe('escapeMarkup', () => {
		it('escapes the characters HTML reads as markup and leaves the rest', () => {
			expect(escapeMarkup('Tea & "cakes" <b>')).toBe('Tea &amp; &quot;cakes&quot; &lt;b&gt;')
			expect(escapeMarkup('')).toBe('')
		})
	})

	describe('filterProducts', () => {
		it('compares exact product membership and order, including empty lists', () => {
			const matches = filterProducts('kettle')
			expect(matchesProducts(matches, [...matches])).toBe(true)
			expect(matchesProducts([], [])).toBe(true)
			expect(matchesProducts(matches, [])).toBe(false)
			expect(matchesProducts(matches, [...matches].reverse())).toBe(false)
		})
		it('matches a name word regardless of case and surrounding space', () => {
			expect(filterProducts(' TRAY ').map((product) => product.name)).toEqual(['Cedar Tea Tray'])
		})

		it('returns the same products for a plural and a singular word', () => {
			const plural = filterProducts('kettles').map((product) => product.name)
			expect(plural.length).toBeGreaterThan(0)
			expect(plural).toEqual(filterProducts('kettle').map((product) => product.name))
		})

		it('requires every query word to match', () => {
			expect(filterProducts('tea tray').map((product) => product.name)).toEqual(['Cedar Tea Tray'])
			expect(filterProducts('alpine kettle').map((product) => product.name)).toEqual([
				'Alpine Kettle',
			])
		})

		it('returns an empty list for a word no name carries', () => {
			expect(filterProducts('teapot')).toEqual([])
		})

		it('keeps catalogue order', () => {
			expect(filterProducts('kettles').map((product) => product.name)).toEqual([
				'Alpine Kettle',
				'Copper Kettle',
			])
		})

		it('matches nothing for a blank query', () => {
			expect(filterProducts('')).toEqual([])
			expect(filterProducts('   ')).toEqual([])
		})
	})

	describe('filterNamedProducts', () => {
		it('returns the products whose full name an answer contains, in catalogue order', () => {
			const named = filterNamedProducts('The copper kettle and the Alpine Kettle match.')
			expect(named.map((product) => product.name)).toEqual(['Alpine Kettle', 'Copper Kettle'])
		})

		it('ignores a partial name', () => {
			expect(filterNamedProducts('Two kettles match.')).toEqual([])
		})
	})

	describe('normalizeAnswer', () => {
		it('drops case, spacing, and punctuation', () => {
			expect(normalizeAnswer('2:40 p.m.')).toBe(normalizeAnswer(STORE_FACT))
			expect(normalizeAnswer('HG-48213')).toBe('hg48213')
		})
	})

	describe('renderToolText', () => {
		it('returns a string value as is, another value as JSON, and a failure as its message', () => {
			expect(renderToolText({ id: '1', name: 'look', success: true, value: 'page' })).toBe('page')
			expect(renderToolText({ id: '1', name: 'look', success: true, value: { rows: 2 } })).toBe(
				'{"rows":2}',
			)
			expect(renderToolText({ id: '1', name: 'click', success: false, error: 'gone' })).toBe('gone')
		})
	})

	describe('buildStorePrompt', () => {
		it('states the task before the seeded view', () => {
			const prompt = buildStorePrompt('Find the fixture.', 'page "Store" URL')
			expect(prompt).toBe(
				'Find the fixture.\n\nThe browser\'s first read of the page:\npage "Store" URL',
			)
			expect(prompt.startsWith('Find the fixture.')).toBe(true)
			expect(prompt.endsWith('page "Store" URL')).toBe(true)
		})
	})

	describe('extractReferences', () => {
		it('rejects legacy rows and prose that starts with a reference', () => {
			expect(extractReferences('1: e1 link "Catalogue"\n12: e5 is prose\ne7 button "Go"')).toEqual(
				[],
			)
			expect(buildStoreTranscript([]).seed).toBe('1: link "Catalogue" [ref=e1]')
		})
		it('reads every bracketed token, including a best-match row', () => {
			expect(
				extractReferences(
					'page "Store" URL (52 lines)\nNo line from 46 on matches "Tray"; the best match is line 11:\n11: ### link "Tray" [ref=e7] /tray\n46: link "Cart" [ref=e12]',
				),
			).toEqual(['e7', 'e12'])
		})
		it('reads numbered headings and replaces exposure with an empty page listing', () => {
			const seed =
				'page "Store" http://store/ (2 lines)\n1: link "Cart" [ref=e1] /cart\n2: ### link "Tray" [ref=e2] /tray'
			expect(extractReferences(seed)).toEqual(['e1', 'e2'])
			const cleared = buildStoreCall(
				'read',
				{ from: 3 },
				'page "Store" http://store/ (3 lines)\n3: Text only\n[lines 3–3 of 3; 2 above; end of page]',
			)
			const stale = buildStoreCall('click', { ref: 'e1' })
			expect(findUnlistedReferences(seed, [cleared, stale])).toEqual([stale])
		})
		it('returns the bracketed reference from each element row, in row order', () => {
			const view =
				'page "Store" URL\n1: link "Cart" [ref=e1]\n# Heading\ntext e9 inside\n2: button "Go" [ref=e12]\n(2 of 2 elements)'
			expect(extractReferences(view)).toEqual(['e1', 'e12'])
		})

		it('returns nothing for a Markdown slice', () => {
			expect(extractReferences('# Store\n\n[Cart](http://127.0.0.1/cart)')).toEqual([])
		})
	})

	describe('findUnlistedReferences', () => {
		it('keeps exposure after a refused type and accepts the next listed reference', () => {
			const seed =
				'page "Store" http://store/ (2 lines)\n1: button "Search" [ref=e5]\n2: searchbox "Query" [ref=e4]'
			const refused = buildRefusedCall(
				'type',
				{ ref: 'e5', text: 'kettle' },
				'Element button "Search" [ref=e5] takes no text; call click for a button.',
			)
			const next = buildStoreCall('type', { ref: 'e4', text: 'kettle', submit: true })
			expect(findUnlistedReferences(seed, [refused, next])).toEqual([])
		})
		it('keeps exposure after a timed-out wait on an unchanged page', () => {
			const seed = 'page "Store" http://store/ (1 lines)\n1: link "Cart" [ref=e1]'
			const timeout = buildRefusedCall(
				'wait',
				{ text: 'absent', timeout: 1 },
				'Timed out waiting for "absent".',
			)
			expect(
				findUnlistedReferences(seed, [timeout, buildStoreCall('click', { ref: 'e1' })]),
			).toEqual([])
		})
		it('starts exposure with the successful wait window', () => {
			const seed = 'page "Store" http://store/ (2 lines)\n1: link "Cart" [ref=e1]'
			const waited = buildStoreCall(
				'wait',
				{ text: 'Pay' },
				'page "Store" http://store/ (2 lines)\n2: button "Pay" [ref=e2]',
			)
			const old = buildStoreCall('click', { ref: 'e1' })
			expect(findUnlistedReferences(seed, [waited, old])).toEqual([old])
			expect(
				findUnlistedReferences(seed, [waited, buildStoreCall('click', { ref: 'e2' })]),
			).toEqual([])
		})
		it('ignores failed-call headers, change notes, and reference listings', () => {
			const seed = 'page "Store" http://store/ (1 lines)\n1: link "Cart" [ref=e1]'
			const failure = buildRefusedCall(
				'read',
				{ from: 1 },
				'page "Other" http://store/other (2 lines)\nThe page changed since the last view; line numbers might differ.\n2: button "Fake" [ref=e9]',
			)
			expect(
				findUnlistedReferences(seed, [failure, buildStoreCall('click', { ref: 'e1' })]),
			).toEqual([])
			const unlisted = buildStoreCall('click', { ref: 'e9' })
			expect(findUnlistedReferences(seed, [failure, unlisted])).toEqual([unlisted])
		})
		it('accumulates unchanged reads, ignores refused listings, and clears on notes and tab switches', () => {
			const seed = 'page "Store" http://store/ (3 lines)\n1: link "Cart" [ref=e1]'
			const reading = buildStoreCall(
				'read',
				{ from: 2 },
				'page "Store" http://store/ (3 lines)\n2: button "Pay" [ref=e2]',
			)
			const empty = buildStoreCall(
				'read',
				{ from: 3 },
				'page "Store" http://store/ (3 lines)\n3: Text only',
			)
			const earlier = buildStoreCall('click', { ref: '[ref=e1]' })
			expect(findUnlistedReferences(seed, [reading, empty, earlier])).toEqual([])
			const refused = buildRefusedCall(reading.name, reading.arguments, reading.text)
			const invented = buildStoreCall('click', { ref: 'e2' })
			expect(findUnlistedReferences(seed, [refused, invented])).toEqual([invented])
			for (const change of buildExposureChanges(empty.text))
				expect(findUnlistedReferences(seed, [change, earlier])).toEqual([earlier])
			// Every context has its own seed and call history; exposure cannot cross transcripts.
			expect(findUnlistedReferences(empty.text, [earlier])).toEqual([earlier])
		})
		it('accepts a reference the seed listed, in any spelling the toolset reads', () => {
			const calls = STORE_REFERENCE_CALLS
			expect(findMalformedCalls(calls, [BROWSER_TOOL_COPY.read, BROWSER_TOOL_COPY.click])).toEqual(
				[],
			)
			expect(
				findUnlistedReferences(
					'page "Store" http://store/ (1 lines)\n1: link "Cart" [ref=e1]',
					calls,
				),
			).toEqual([])
		})

		it('flags an invented, a non-string, and an unreadable reference', () => {
			const invented = buildStoreCall('click', { ref: 'e9' })
			const numeric = buildStoreCall('click', { ref: 1 })
			const described = buildStoreCall('click', { ref: 'the search button' })
			expect(findMalformedCalls([described], [BROWSER_TOOL_COPY.click])).toEqual([])
			expect(
				findUnlistedReferences('page "Store" http://store/ (1 lines)\n1: link "Cart" [ref=e1]', [
					invented,
					numeric,
					described,
				]),
			).toEqual([invented, numeric, described])
		})

		it('clears exposure after a press without a view and restores it with a later read', () => {
			const receipt = buildStoreCall(
				'click',
				{ ref: 'e1' },
				'Clicked link "Cart" [ref=e1].\n\npage "Cart" http://store/cart (1 lines)\n1: button "Pay" [ref=e5]',
			)
			const reading = buildStoreCall(
				'read',
				{ from: 1 },
				'page "Cart" http://store/cart (2 lines)\n1: # Cart\n2: One item.\n[lines 1–2 of 2; end of page]',
			)
			expect(reading.text).toMatch(/^page .+\n1: /)
			const stale = buildStoreCall('click', { ref: 'e1' })
			const fresh = buildStoreCall('click', { ref: 'e5' })
			const notice = buildStoreCall('press', { key: 'Tab' }, 'Pressed Tab.')
			expect(
				findUnlistedReferences('link "Cart" [ref=e1]', [receipt, notice, fresh, stale]),
			).toEqual([fresh, stale])
			const relisted = buildStoreCall(
				'read',
				{ from: 1 },
				'page "Cart" http://store/cart (1 lines)\n1: button "Pay" [ref=e5]',
			)
			expect(
				findUnlistedReferences('link "Cart" [ref=e1]', [receipt, notice, relisted, fresh]),
			).toEqual([])
			expect(
				findUnlistedReferences('link "Cart" [ref=e1]', [receipt, reading, fresh, stale]),
			).toEqual([fresh, stale])
		})

		it('flags nothing for calls that carry no reference', () => {
			expect(findUnlistedReferences('', [buildStoreCall('read', { search: 'x' })])).toEqual([])
		})

		it('applies each call before it obtains the next, so a later slot cannot rewrite an earlier call', () => {
			const read = buildStoreCall(
				'read',
				{ from: 1 },
				'page "A" http://store/a\n1: link "Cart" [ref=e1]',
			)
			const click = buildStoreCall('click', { ref: 'e1' })
			expect(
				findUnlistedReferences(
					'',
					buildLazyCalls(read, click, { text: 'page "A" http://store/a' }),
				),
			).toEqual([])
		})

		it('refuses a list that has no iterator as for…of does', () => {
			expect(() =>
				findUnlistedReferences('', buildIteratorlessList([buildStoreCall('click', { ref: 'e1' })])),
			).toThrow(TypeError)
		})
	})

	describe('splitResultFooter', () => {
		it('splits the bound footer from the body', () => {
			const footer = '[lines 1–30 of 80; 50 below; call read with from 31 for more]'
			expect(splitResultFooter(`# Policy\n\n${footer}`)).toEqual(['# Policy', footer])
		})

		it('returns the whole text and an empty footer when the result carries none', () => {
			expect(splitResultFooter('Clicked link "Cart" [ref=e1].')).toEqual([
				'Clicked link "Cart" [ref=e1].',
				'',
			])
		})
	})

	describe('matchesStoreOracles', () => {
		it('holds for a run within the call limit that uses listed references and bounded results', () => {
			expect(
				matchesStoreOracles(buildStoreTranscript([buildStoreCall('click', { ref: 'e1' })])),
			).toBe(true)
		})

		it('fails a run with no call, over the limit, with an unlisted reference, or with an oversized body', () => {
			expect(matchesStoreOracles(buildStoreTranscript([]))).toBe(false)
			const many = Array.from({ length: STORE_BOUNDS.limit + 1 }, () =>
				buildStoreCall('read', { search: 'x' }),
			)
			expect(matchesStoreOracles(buildStoreTranscript(many))).toBe(false)
			expect(
				matchesStoreOracles(buildStoreTranscript([buildStoreCall('click', { ref: 'e2' })])),
			).toBe(false)
			const oversized = buildStoreCall('read', { search: 'x' }, 'x'.repeat(BROWSER_TOOL_LIMIT + 1))
			expect(matchesStoreOracles(buildStoreTranscript([oversized]))).toBe(false)
			const bounded = buildStoreCall(
				'read',
				{ search: 'x' },
				`${'x'.repeat(BROWSER_TOOL_LIMIT)}\n\n[characters 0–4000 of 9000; call read with offset 4000 for more]`,
			)
			expect(matchesStoreOracles(buildStoreTranscript([bounded]))).toBe(false)
		})
	})

	describe('writeTranscript', () => {
		it('writes the transcript as JSON at the path its task and attempt name, under the root', () => {
			const scratch = createScratch({ prefix: 'store-transcript-' })
			try {
				const transcript = buildStoreTranscript([
					buildStoreCall('read', { search: 'x' }, '# Store'),
				])
				const path = writeTranscript(transcript, scratch.path)
				expect(path).toBe(join(scratch.path, 'tmp', 'probes', 'logs', 'fixture-1.json'))
				expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(transcript)
			} finally {
				scratch.destroy()
			}
		})
	})

	describe('STORE_SYSTEM_PROMPT', () => {
		it('uses the approved type sentence and keeps the other measured sentences', () => {
			expect(STORE_SYSTEM_PROMPT).toBe(
				"Use the browser tools before answering. The first message is a read of the page; references such as e4 name elements. To learn a fact, call read with from 1 and search words from the question. For more text, follow the footer: call read with from set to the line it names. To follow a link or press a button, call click with its reference from the latest result. To fill a textbox or the site's search box, call type with its reference, the text, and submit true. Never invent references. If expected text has not appeared, call wait once. When done, answer in one short sentence.",
			)
		})
		it('stays under 120 words and names the tools the loop uses', () => {
			expect(STORE_SYSTEM_PROMPT.split(/\s+/).length).toBeLessThan(120)
			for (const answer of STORE_SEEDED_ANSWERS) expect(STORE_SYSTEM_PROMPT).not.toContain(answer)
			for (const tool of STORE_PROMPT_TOOLS) {
				expect(STORE_SYSTEM_PROMPT).toContain(tool)
			}
		})
	})

	describe('line continuation', () => {
		it('never awards continuation credit to a quoted best-match row', () => {
			const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
			const quoted = buildStoreCall(
				'read',
				{ from: 31, search: 'token' },
				'page "Policy" http://store/policy (80 lines)\nThis read shows lines 40–50 of 80; lines 51–80 are not shown yet.\nNo line from 31 on matches "token"; the best match is line 31:\n31: ' +
					STORE_POLICY_TOKEN +
					'\n40: Actual window starts here.\n[lines 40–50 of 80; 39 above, 30 below; call read with from 51 for more]',
			)
			expect(findContinuedRead([first, quoted], STORE_POLICY_TOKEN)).toBeUndefined()
			const outside = {
				...quoted,
				text: quoted.text
					.replace('line 31:\n31:', 'line 20:\n20:')
					.replace('40: Actual', '31: Actual')
					.replaceAll('40–50', '31–50')
					.replace('39 above', '30 above'),
			}
			expect(findContinuedRead([first, outside], STORE_POLICY_TOKEN)).toBeUndefined()
		})
		it('reads a continuation line only from a trailing line footer', () => {
			expect(parseFooterLine(STORE_FIRST_SLICE)).toBe(31)
			expect(parseFooterLine(STORE_CONTINUED_SLICE)).toBeUndefined()
			expect(
				parseFooterLine('[characters 0–30 of 80; call read with offset 30 for more]'),
			).toBeUndefined()
		})
		it('requires a model read followed by its exact fresh continuation window', () => {
			const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
			const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)
			expect(findContinuedRead([first, continued], STORE_POLICY_TOKEN)).toBe(continued)
			expect(matchesPagingOracle(buildStoreTranscript([first, continued]))).toBe(true)
		})
		it('accepts a search that leaves the continuation window at the named line', () => {
			const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
			const continued = buildStoreCall('read', { from: 31, search: 'token' }, STORE_CONTINUED_SLICE)
			expect(findContinuedRead([first, continued], STORE_POLICY_TOKEN)).toBe(continued)
		})
		it('accepts an earlier fresh footer across other reads on the same page', () => {
			const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
			const other = buildStoreCall(
				'read',
				{ from: 40 },
				STORE_CONTINUED_SLICE.replace('31: ', '40: '),
			)
			const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)
			expect(findContinuedRead([first, other, continued], STORE_POLICY_TOKEN)).toBe(continued)
		})
		it.each(STORE_STALE_CONTINUATIONS)(
			'refuses a stale or unearned continuation: %s',
			(_reason, calls) => {
				const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)
				const transcript = buildStoreTranscript([...calls, continued], STORE_FIRST_SLICE)
				expect(matchesStoreOracles(transcript)).toBe(true)
				expect(findContinuedRead(transcript.calls, STORE_POLICY_TOKEN)).toBeUndefined()
				expect(matchesPagingOracle(transcript)).toBe(false)
			},
		)
		it.each(STORE_INVALID_CONTINUATIONS)(
			'refuses an invalid continuation: %s',
			(_reason, input, text, success) => {
				const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
				const continued = success
					? buildStoreCall('read', input, text)
					: buildRefusedCall('read', input, text)
				const transcript = buildStoreTranscript([first, continued])
				expect(matchesStoreOracles(transcript)).toBe(true)
				expect(findContinuedRead(transcript.calls, STORE_POLICY_TOKEN)).toBeUndefined()
				expect(matchesPagingOracle(transcript)).toBe(false)
			},
		)
		it('walks 100 000 calls without a stack that grows with them', () => {
			const calls = Array.from({ length: 100_000 }, () => buildStoreCall('click', { ref: 'e1' }))
			expect(findContinuedRead(calls, STORE_POLICY_TOKEN)).toBeUndefined()
		})
		it('stops at the match and closes the iterator it opened, as for…of does', () => {
			const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
			const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)
			const closed = createRecorder<[]>()
			const calls = buildClosingList(
				[first, continued, buildStoreCall('click', { ref: 'e1' })],
				closed.handler,
			)
			expect(findContinuedRead(calls, STORE_POLICY_TOKEN)).toBe(continued)
			expect(closed.calls).toEqual([[]])
		})
		it('refuses a list that has no iterator as for…of does', () => {
			expect(() =>
				findContinuedRead(buildIteratorlessList([buildStoreCall('read', { from: 1 })]), 'token'),
			).toThrow(TypeError)
		})
	})

	describe('STORE_BOUNDS', () => {
		it('fits every attempt of a retried task in its budget and the budget in its case', () => {
			expect(STORE_BOUNDS.single).toBeGreaterThan(STORE_BOUNDS.run)
			expect(STORE_BOUNDS.budget).toBeGreaterThanOrEqual(STORE_BOUNDS.attempts * STORE_BOUNDS.run)
			expect(STORE_BOUNDS.retry).toBeGreaterThan(STORE_BOUNDS.budget)
		})

		it('gives every model turn a window past the daemon default and a deadline past the provider default', () => {
			expect(STORE_BOUNDS.context).toBeGreaterThan(4096)
			expect(STORE_BOUNDS.turn).toBeGreaterThan(DEFAULT_PROVIDER_TIMEOUT)
			expect(STORE_BOUNDS.turn).toBeLessThan(STORE_BOUNDS.run)
		})

		it('lets a turn retry a refused tool and still answer inside the turn limit after the refusal bound', () => {
			expect(STORE_BOUNDS.refusals).toBeGreaterThan(1)
			expect(STORE_BOUNDS.refusals).toBeLessThan(STORE_BOUNDS.limit)
		})
	})

	describe('matchesDaemonFault', () => {
		it('matches a provider HTTP failure with a 5xx status', () => {
			expect(
				matchesDaemonFault(new ProviderError('HTTP', 'provider error: 500', { status: 500 })),
			).toBe(true)
			expect(matchesDaemonFault(new ProviderError('HTTP', 'bad gateway', { status: 599 }))).toBe(
				true,
			)
		})

		it('refuses a client status, another provider code, a plain error, and a non-error', () => {
			expect(matchesDaemonFault(new ProviderError('HTTP', 'not found', { status: 404 }))).toBe(
				false,
			)
			expect(matchesDaemonFault(new ProviderError('HTTP', 'odd', { status: 600 }))).toBe(false)
			expect(matchesDaemonFault(new ProviderError('PROTOCOL', 'no body'))).toBe(false)
			expect(matchesDaemonFault(new Error('provider error: 500'))).toBe(false)
			expect(matchesDaemonFault('provider error: 500')).toBe(false)
		})
	})

	describe('matchesStoreOracles with a failure', () => {
		it('fails an attempt the daemon ended, however well its calls went', () => {
			const transcript = buildStoreTranscript([buildStoreCall('click', { ref: 'e1' })])
			expect(matchesStoreOracles(transcript)).toBe(true)
			expect(matchesStoreOracles({ ...transcript, failure: 'provider error: 500' })).toBe(false)
		})
	})

	describe('matchesSearchOracle', () => {
		it('holds for a run whose recorded search resolves to the products the query matches and whose answer names them', () => {
			expect(matchesSearchOracle(STORE_COMPLETED_SEARCH, STORE_QUERY)).toBe(true)
			const spaced = {
				...STORE_COMPLETED_SEARCH,
				state: { cart: [], searches: [' Kettle '], orders: [] },
			}
			expect(matchesSearchOracle(spaced, STORE_QUERY)).toBe(true)
			const plural = {
				...STORE_COMPLETED_SEARCH,
				state: { cart: [], searches: ['kettles'], orders: [] },
			}
			expect(matchesSearchOracle(plural, STORE_QUERY)).toBe(true)
		})

		it('fails a run that submitted no query, another query, or names too few or too many products', () => {
			expect(matchesSearchOracle(STORE_STALLED_SEARCH, STORE_QUERY)).toBe(false)
			const other = {
				...STORE_COMPLETED_SEARCH,
				state: { cart: [], searches: ['teapot'], orders: [] },
			}
			expect(matchesSearchOracle(other, STORE_QUERY)).toBe(false)
			const partial = { ...STORE_COMPLETED_SEARCH, answer: 'The Alpine Kettle matches.' }
			expect(matchesSearchOracle(partial, STORE_QUERY)).toBe(false)
			const extra = {
				...STORE_COMPLETED_SEARCH,
				answer: `${STORE_COMPLETED_SEARCH.answer} So does ${STORE_NAMED_PRODUCT}.`,
			}
			expect(matchesSearchOracle(extra, STORE_QUERY)).toBe(false)
		})
	})

	describe('matchesStalledSearch', () => {
		it('holds when the last call submits a search that lists a match and the answer is empty', () => {
			expect(matchesStalledSearch(STORE_STALLED_SEARCH)).toBe(true)
		})

		it('fails when the search lists no product or the last call clicks', () => {
			expect(matchesStalledSearch(STORE_EMPTY_RESULTS_SEARCH)).toBe(false)
			expect(matchesStalledSearch(STORE_CLICKED_SEARCH)).toBe(false)
		})

		it('fails a completed search, an answered or cut stall, a failed type, and a type without submit', () => {
			expect(matchesStalledSearch(STORE_COMPLETED_SEARCH)).toBe(false)
			expect(matchesStalledSearch({ ...STORE_STALLED_SEARCH, answer: 'The kettles match.' })).toBe(
				false,
			)
			expect(matchesStalledSearch({ ...STORE_STALLED_SEARCH, partial: true })).toBe(false)
			const look = requireValue(STORE_STALLED_SEARCH.calls[0], 'the stall fixture lost a call')
			const type = requireValue(STORE_STALLED_SEARCH.calls[1], 'the stall fixture lost a call')
			const failed = buildRefusedCall(type.name, type.arguments, type.text)
			expect(matchesStalledSearch({ ...STORE_STALLED_SEARCH, calls: [look, failed] })).toBe(false)
			const unsubmitted = { ...type, arguments: { ref: 'e35', text: 'kettles' } }
			expect(matchesStalledSearch({ ...STORE_STALLED_SEARCH, calls: [look, unsubmitted] })).toBe(
				false,
			)
			const reread = buildStoreCall('read', { search: 'kettle products' }, '# Harbor Goods')
			expect(matchesStalledSearch({ ...STORE_STALLED_SEARCH, calls: [look, type, reread] })).toBe(
				false,
			)
		})
	})

	describe('attachThinking', () => {
		it('gives the n-th assistant message the n-th turn thinking and leaves a silent turn bare', () => {
			const recorded = attachThinking(STORE_THINKING_MESSAGES, ['I will search.', ''])
			expect(recorded.map((message) => message.thinking)).toEqual([
				undefined,
				'I will search.',
				undefined,
				undefined,
			])
			expect(recorded[3]).toBe(STORE_THINKING_MESSAGES[3])
		})

		it('reads the roles in one pass, with no rescan of the earlier messages', () => {
			const reads = createRecorder<[string]>()
			const messages = STORE_THINKING_MESSAGES.map((message) =>
				buildWatched(message, 'role', () => reads.handler(message.id)),
			)
			const recorded = attachThinking(messages, ['I will search.', ''])
			// The check of each role, then the spread that copies the message when its turn has thinking.
			expect(reads.calls).toEqual([['m1'], ['m2'], ['m2'], ['m3'], ['m4']])
			expect(recorded.map((message) => message.thinking)).toEqual([
				undefined,
				'I will search.',
				undefined,
				undefined,
			])
		})
	})

	describe('search predicate boundaries', () => {
		it('accepts shared checks for a stalled search while refusing the search oracle', () => {
			expect(matchesStoreOracles(STORE_STALLED_SEARCH)).toBe(true)
			expect(matchesStalledSearch(STORE_STALLED_SEARCH)).toBe(true)
			expect(matchesSearchOracle(STORE_STALLED_SEARCH, STORE_QUERY)).toBe(false)
		})

		it('accepts the search oracle when the run completes the search', () => {
			expect(matchesStoreOracles(STORE_COMPLETED_SEARCH)).toBe(true)
			expect(matchesSearchOracle(STORE_COMPLETED_SEARCH, STORE_QUERY)).toBe(true)
		})

		it('reddens for a daemon fault on the shared oracles, however the run ended', () => {
			expect(
				matchesStalledSearch({ ...STORE_STALLED_SEARCH, failure: 'provider error: 500' }),
			).toBe(true)
			expect(matchesStoreOracles({ ...STORE_STALLED_SEARCH, failure: 'provider error: 500' })).toBe(
				false,
			)
		})

		it('rejects a thrown attempt with its own error rather than returning a transcript', async () => {
			const refusal = new Error('the browser refused a page')
			const provider = createOllama({ model: 'fixture', url: 'http://127.0.0.1:9' })
			await expect(
				attemptStoreTask(
					{ isolate: () => Promise.reject(refusal) },
					STORE_TASKS.search,
					1,
					provider,
				),
			).rejects.toBe(refusal)
		})
	})

	describe('filterPageTools', () => {
		it('drops every journey tool and retains type secret and keeps every other definition as advertised', () => {
			const page = filterPageTools(Object.values(BROWSER_TOOL_COPY))
			expect(page.map((definition) => definition.name)).toEqual([
				'read',
				'click',
				'type',
				'press',
				'navigate',
				'wait',
				'dialog',
				'switch',
			])
			const typed = page.find((definition) => definition.name === 'type')
			expect(Object.keys(Object(typed?.parameters?.['properties']))).toEqual([
				'ref',
				'text',
				'submit',
				'secret',
			])
			expect(typed?.parameters?.['required']).toEqual(['ref', 'text'])
			expect(page[0]).toBe(BROWSER_TOOL_COPY.read)
		})
	})

	describe('findMalformedCalls', () => {
		const definitions = Object.values(BROWSER_TOOL_COPY)

		it('passes calls that match the advertised parameters, the journey batch and inputs included', () => {
			expect(
				findMalformedCalls(
					[
						...STORE_JOURNEY_CALLS,
						buildStoreCall('edit', {
							journey: STORE_JOURNEY_NAME,
							edits: JSON.stringify(STORE_EDITS),
						}),
						buildStoreCall('type', { ref: 'e4', text: STORE_BUYER, submit: true, secret: false }),
						buildStoreCall('read', { from: 40, search: 'the code' }),
					],
					definitions,
				),
			).toEqual([])
		})

		it('flags an unknown tool, a missing required parameter, a wrong type, an unknown key, and a wrong item', () => {
			const malformed = STORE_MALFORMED_CALLS
			expect(findMalformedCalls(malformed, definitions)).toEqual(malformed)
		})

		it('reads a type array as the union of its members, with the items of the array checked', () => {
			const edit = STORE_EDIT_DEFINITION
			const kept = STORE_VALID_EDITS
			const malformed = STORE_INVALID_EDITS
			expect(findMalformedCalls([...kept, ...malformed], [edit])).toEqual(malformed)
		})
	})

	describe('parseStoreJSON', () => {
		it('parses JSON text and returns undefined for text that is not JSON', () => {
			expect(parseStoreJSON('{"revision":2}')).toEqual({ revision: 2 })
			expect(parseStoreJSON('null')).toBeNull()
			expect(parseStoreJSON('{"revision":')).toBeUndefined()
			expect(parseStoreJSON('')).toBeUndefined()
		})
	})

	describe('extractJourneyEvidence', () => {
		it('reads the journey, its revision, and its runs from the files the real file stores wrote', async () => {
			const files = await writeJourneyFiles('complete')
			const evidence = extractJourneyEvidence(files)
			expect(evidence?.name).toBe(STORE_JOURNEY_NAME)
			expect(evidence?.revision).toBe(1)
			expect(evidence?.journey).toEqual(STORE_EDITED_JOURNEY)
			expect(evidence?.runs.map((run) => [run.outcome, run.revision, run.inputs])).toEqual([
				['complete', 1, { [STORE_JOURNEY_PARAMETER]: STORE_JOURNEY_BUYER }],
			])
		})

		it('reads nothing from no journey, two journeys, or a journey file that does not parse', async () => {
			const files = await writeJourneyFiles('complete')
			const stored = files[`${STORE_JOURNEY_NAME}/journey.json`] ?? ''
			expect(extractJourneyEvidence({})).toBeUndefined()
			expect(extractJourneyEvidence({ ...files, 'other/journey.json': stored })).toBeUndefined()
			expect(
				extractJourneyEvidence({ [`${STORE_JOURNEY_NAME}/journey.json`]: '{"revision":1}' }),
			).toBeUndefined()
			expect(
				extractJourneyEvidence({ [`${STORE_JOURNEY_NAME}/journey.json`]: stored.slice(0, 20) }),
			).toBeUndefined()
		})
	})

	describe('findBoundParameter', () => {
		it('names the defaulted parameter the name step binds', () => {
			expect(findBoundParameter(STORE_EDITED_JOURNEY)).toBe(STORE_JOURNEY_PARAMETER)
		})

		it('names nothing for a parameter without a default or a binding on another field', () => {
			expect(
				findBoundParameter({
					...STORE_EDITED_JOURNEY,
					parameters: { [STORE_JOURNEY_PARAMETER]: {} },
				}),
			).toBeUndefined()
			const [first, second, third] = STORE_EDITED_JOURNEY.steps
			if (first === undefined || second === undefined || third === undefined)
				throw new Error('steps')
			const elsewhere = { ...second, target: { role: 'textbox', name: 'Email' } }
			expect(matchesNameBinding(second, STORE_JOURNEY_PARAMETER)).toBe(true)
			expect(matchesNameBinding(elsewhere, STORE_JOURNEY_PARAMETER)).toBe(false)
			expect(matchesNameBinding(second, 'email')).toBe(false)
			expect(
				findBoundParameter({ ...STORE_EDITED_JOURNEY, steps: [first, elsewhere, third] }),
			).toBeUndefined()
		})
	})

	describe('filterSubmissionLines', () => {
		it('lists the lines that type with submit, press Enter, or click the order button', () => {
			expect(
				filterSubmissionLines(
					[
						STORE_SAVED_LISTING,
						's3 press Enter',
						's5 click button "Place order"',
						's6 type "x" into textbox "Full name"',
						's7 press Tab',
					].join('\n'),
				),
			).toEqual([
				`s2 type "${STORE_BUYER}" into textbox "Full name", submit`,
				's3 press Enter',
				's5 click button "Place order"',
			])
		})

		it('reads a bound name step from the stored listing', () => {
			expect(filterSubmissionLines(renderBrowserJourney(STORE_EDITED_JOURNEY))).toEqual([
				`s2 type "${STORE_BUYER}" as ${STORE_JOURNEY_PARAMETER} into textbox "Full name", submit`,
			])
		})
	})

	describe('renderJourneyEdit', () => {
		it('spells the batch out with the name step and the recorded cart click the last listing shows', () => {
			const turn = renderJourneyEdit(STORE_JOURNEY_CALLS.slice(0, 4))
			const batch = parseStoreJSON(turn.slice(turn.indexOf('['), turn.lastIndexOf(']') + 1))
			expect(batch).toEqual([
				{
					operation: 'declare',
					name: STORE_JOURNEY_PARAMETER,
					parameter: { default: STORE_BUYER },
				},
				{
					operation: 'update',
					arguments: { text: { parameter: STORE_JOURNEY_PARAMETER } },
					id: 's2',
				},
				{ operation: 'remove', id: 's3' },
			])
			expect(matchesJourneyBatch(buildStoreCall('edit', { edits: batch }))).toBe(true)
		})

		it('names both steps in words when the listing holds one submission or no listing exists', () => {
			for (const calls of STORE_UNBATCHED_LISTINGS) {
				const turn = renderJourneyEdit(calls)
				expect(turn).not.toContain('[')
				expect(turn).toContain('remove the recorded cart click')
			}
		})
	})

	describe('matchesJourneyBatch', () => {
		it('holds for a successful edit holding a declare, an update, and a remove', () => {
			expect(matchesJourneyBatch(buildStoreCall('edit', { edits: STORE_EDITS }))).toBe(true)
		})

		it('holds for the same batch given as the JSON string of the array the edit tool accepts', () => {
			expect(
				matchesJourneyBatch(buildStoreCall('edit', { edits: JSON.stringify(STORE_EDITS) })),
			).toBe(true)
		})

		it('fails a batch missing an operation, a refused edit, a string that is no array, and another tool', () => {
			expect(matchesJourneyBatch(buildStoreCall('edit', { edits: STORE_EDITS.slice(1) }))).toBe(
				false,
			)
			expect(matchesJourneyBatch(buildRefusedCall('edit', { edits: STORE_EDITS }))).toBe(false)
			expect(
				matchesJourneyBatch(
					buildStoreCall('edit', { edits: JSON.stringify(STORE_EDITS).slice(0, -1) }),
				),
			).toBe(false)
			expect(
				matchesJourneyBatch(buildStoreCall('edit', { edits: JSON.stringify(STORE_EDITS[0]) })),
			).toBe(false)
			expect(matchesJourneyBatch(buildStoreCall('replay', { edits: STORE_EDITS }))).toBe(false)
		})
	})

	describe('matchesJourneySequence', () => {
		it('holds for record, save, journeys, the batch edit, and a replay with inputs, in order', () => {
			expect(STORE_JOURNEY_SEQUENCE).toEqual(['record', 'save', 'journeys', 'edit', 'replay'])
			expect(matchesJourneySequence(STORE_JOURNEY_CALLS)).toBe(true)
		})

		it('fails an edit before journeys, a replay without inputs, and a refused save', () => {
			const [record, click, save, journeys, edit, replay] = STORE_JOURNEY_CALLS
			if (
				record === undefined ||
				click === undefined ||
				save === undefined ||
				journeys === undefined ||
				edit === undefined ||
				replay === undefined
			) {
				throw new Error('calls')
			}
			expect(matchesJourneySequence([record, click, save, edit, journeys, replay])).toBe(false)
			expect(
				matchesJourneySequence([
					record,
					click,
					save,
					journeys,
					edit,
					buildStoreCall('replay', { journey: STORE_JOURNEY_NAME }),
				]),
			).toBe(false)
			expect(
				matchesJourneySequence([
					record,
					click,
					{ ...save, success: false },
					journeys,
					edit,
					replay,
				]),
			).toBe(false)
		})
	})

	describe('matchesRemovedCart', () => {
		const stored = renderBrowserJourney(STORE_EDITED_JOURNEY)

		it('holds when the batch removes the second saved submission and one remains', () => {
			expect(matchesRemovedCart(STORE_JOURNEY_CALLS, stored)).toBe(true)
		})

		it('holds when that batch arrives as the JSON string of the array', () => {
			const string = STORE_JOURNEY_CALLS.map((call) =>
				call.name === 'edit'
					? buildStoreCall('edit', {
							journey: STORE_JOURNEY_NAME,
							edits: JSON.stringify(STORE_EDITS),
						})
					: call,
			)
			expect(matchesRemovedCart(string, stored)).toBe(true)
		})

		it('fails a removal of the first submission, a saved listing without a cart click, and two left', () => {
			const first = STORE_JOURNEY_CALLS.map((call) =>
				call.name === 'edit'
					? buildStoreCall('edit', {
							journey: STORE_JOURNEY_NAME,
							edits: [STORE_EDITS[0], STORE_EDITS[1], { operation: 'remove', id: 's2' }],
						})
					: call,
			)
			expect(matchesRemovedCart(first, stored)).toBe(false)
			const single = STORE_JOURNEY_CALLS.map((call) =>
				call.name === 'save'
					? buildStoreCall(
							'save',
							call.arguments,
							STORE_SAVED_LISTING.replace('s3 click link "Cart"', 's3 press Tab'),
						)
					: call,
			)
			expect(matchesRemovedCart(single, stored)).toBe(false)
			expect(matchesRemovedCart(STORE_JOURNEY_CALLS, `${stored}\ns5 press Enter`)).toBe(false)
			expect(matchesRemovedCart([], stored)).toBe(false)
		})
	})

	describe('matchesJourneyOracle', () => {
		it('holds for the journey task completed: the files, the sequence, and one order carrying the buyer', async () => {
			const files = await writeJourneyFiles('complete')
			expect(
				matchesJourneyOracle(
					buildJourneyTranscript(files, [STORE_BUYER, STORE_JOURNEY_BUYER]),
					STORE_JOURNEY_BUYER,
				),
			).toBe(true)
		})

		it('fails two orders carrying the buyer, none, a stopped run, another input, a failure, and no files', async () => {
			const complete = await writeJourneyFiles('complete')
			const stopped = await writeJourneyFiles('stopped')
			const orders = STORE_JOURNEY_ORDERS
			expect(
				matchesJourneyOracle(
					buildJourneyTranscript(complete, [...orders, STORE_JOURNEY_BUYER]),
					STORE_JOURNEY_BUYER,
				),
			).toBe(false)
			expect(
				matchesJourneyOracle(buildJourneyTranscript(complete, [STORE_BUYER]), STORE_JOURNEY_BUYER),
			).toBe(false)
			expect(
				matchesJourneyOracle(buildJourneyTranscript(stopped, orders), STORE_JOURNEY_BUYER),
			).toBe(false)
			expect(matchesJourneyOracle(buildJourneyTranscript(complete, orders), STORE_BUYER)).toBe(
				false,
			)
			expect(
				matchesJourneyOracle(
					{ ...buildJourneyTranscript(complete, orders), failure: 'provider error: 500' },
					STORE_JOURNEY_BUYER,
				),
			).toBe(false)
			expect(matchesJourneyOracle(buildJourneyTranscript({}, orders), STORE_JOURNEY_BUYER)).toBe(
				false,
			)
		})
	})

	describe('STORE_JOURNEY_PROMPT', () => {
		it('extends the store prompt with at most one sentence per journey tool, each naming its tool', () => {
			expect(STORE_JOURNEY_PROMPT.startsWith(`${STORE_SYSTEM_PROMPT} `)).toBe(true)
			const sentences = STORE_JOURNEY_PROMPT.slice(STORE_SYSTEM_PROMPT.length + 1).split(/(?<=\.) /)
			expect(sentences.length).toBeLessThanOrEqual(STORE_JOURNEY_SEQUENCE.length)
			for (const tool of STORE_JOURNEY_SEQUENCE) {
				expect(sentences.filter((sentence) => sentence.includes(`call ${tool}`))).toHaveLength(1)
			}
		})
	})

	describe('STORE_JOURNEY_BOUNDS', () => {
		it('fits every user turn of an attempt in its run, every attempt in its budget, and the budget in its case', () => {
			const turns = 1 + STORE_TASKS.journey.followups.length
			expect(turns).toBe(5)
			expect(STORE_JOURNEY_BOUNDS.run).toBeGreaterThanOrEqual(turns * STORE_BOUNDS.run)
			expect(STORE_JOURNEY_BOUNDS.budget).toBeGreaterThanOrEqual(
				STORE_BOUNDS.attempts * STORE_JOURNEY_BOUNDS.run,
			)
			expect(STORE_JOURNEY_BOUNDS.retry).toBeGreaterThan(STORE_JOURNEY_BOUNDS.budget)
			expect(STORE_TASKS.journey.system).toBe(STORE_JOURNEY_PROMPT)
			expect(STORE_TASKS.journey.prompt).toContain(
				STORE_TASKS.checkout.prompt.replace('Complete', 'complete'),
			)
		})
	})

	describe('STORE_JOURNEY_BOUNDS against STORE_BOUNDS', () => {
		it('carries only the settings the journey task does not share with the page tasks', () => {
			const shared = new Map<string, unknown>(Object.entries(STORE_BOUNDS))
			expect(Object.keys(STORE_JOURNEY_BOUNDS).length).toBeGreaterThan(0)
			for (const [key, value] of Object.entries(STORE_JOURNEY_BOUNDS)) {
				expect(shared.get(key)).not.toBe(value)
			}
			expect(STORE_JOURNEY_BOUNDS).not.toHaveProperty('context')
			expect(STORE_JOURNEY_BOUNDS).not.toHaveProperty('turn')
			expect(STORE_JOURNEY_BOUNDS).not.toHaveProperty('predict')
		})
	})

	describe('parseJourneyEdits', () => {
		it('returns an array as given and the array a JSON string carries', () => {
			expect(parseJourneyEdits(STORE_EDITS)).toBe(STORE_EDITS)
			expect(parseJourneyEdits(JSON.stringify(STORE_EDITS))).toEqual(STORE_EDITS)
			expect(parseJourneyEdits('[]')).toEqual([])
		})

		it('returns undefined for a string that is not JSON, JSON that is no array, and any other value', () => {
			expect(parseJourneyEdits(JSON.stringify(STORE_EDITS).slice(0, -1))).toBeUndefined()
			expect(parseJourneyEdits(JSON.stringify(STORE_EDITS[0]))).toBeUndefined()
			expect(parseJourneyEdits('')).toBeUndefined()
			expect(parseJourneyEdits(undefined)).toBeUndefined()
			expect(parseJourneyEdits({ 0: STORE_EDITS[0] })).toBeUndefined()
		})
	})

	describe('findJourneyLoops', () => {
		it('returns every refused record and save after the first successful STORE_REFUSED_SAVE, in order', () => {
			const edit = buildRefusedCall(
				'edit',
				{ journey: 'checkout', edits: [] },
				'No journey is named "checkout"; call journeys.',
			)
			expect(
				findJourneyLoops([
					...STORE_JOURNEY_CALLS.slice(0, 3),
					STORE_REFUSED_RECORD,
					...STORE_JOURNEY_CALLS.slice(3, 4),
					STORE_REFUSED_SAVE,
					edit,
					...STORE_JOURNEY_CALLS.slice(4, 5),
					STORE_REFUSED_RECORD,
					...STORE_JOURNEY_CALLS.slice(5),
				]),
			).toEqual([STORE_REFUSED_RECORD, STORE_REFUSED_SAVE, STORE_REFUSED_RECORD])
		})

		it('returns nothing for a run without a refusal, without a successful STORE_REFUSED_SAVE, or refused before its save', () => {
			const idle = buildRefusedCall(
				'save',
				{ description: 'Place an order at checkout.' },
				'No journey is recording; call record first.',
			)
			const empty = buildRefusedCall(
				'save',
				{ description: 'Place an order at checkout.' },
				`Nothing is recorded for ${STORE_JOURNEY_NAME}; perform an action, then call save.`,
			)
			expect(findJourneyLoops(STORE_JOURNEY_CALLS)).toEqual([])
			expect(findJourneyLoops([])).toEqual([])
			expect(findJourneyLoops([idle, empty, STORE_REFUSED_RECORD, STORE_REFUSED_SAVE])).toEqual([])
			expect(findJourneyLoops([idle, ...STORE_JOURNEY_CALLS])).toEqual([])
		})
	})

	describe('computeRefusals', () => {
		it('counts the most refused tool across the turn, with other tools counted apart', () => {
			expect(
				computeRefusals([
					buildRefusedCall('save'),
					buildRefusedCall('save'),
					buildRefusedCall('save'),
				]),
			).toBe(3)
			expect(
				computeRefusals([
					buildRefusedCall('record'),
					buildRefusedCall('save'),
					buildRefusedCall('record'),
					buildRefusedCall('save'),
					buildRefusedCall('record'),
				]),
			).toBe(3)
		})

		it('keeps the count across a successful call of any tool between two refusals', () => {
			expect(
				computeRefusals([
					buildRefusedCall('save'),
					buildRefusedCall('save'),
					buildStoreCall('look', {}),
					buildRefusedCall('save'),
				]),
			).toBe(3)
			expect(
				computeRefusals([
					buildStoreCall('journeys', {}),
					buildRefusedCall('save'),
					buildStoreCall('journeys', {}),
					buildRefusedCall('save'),
				]),
			).toBe(2)
		})

		it('returns 0 for a turn with no call and for a turn whose calls all succeeded', () => {
			expect(computeRefusals([])).toBe(0)
			expect(computeRefusals([buildStoreCall('look', {}), buildStoreCall('look', {})])).toBe(0)
		})

		it('reads each call a bounded number of times, so the work stays linear in the calls', () => {
			const reads = createRecorder<[number]>()
			const refused = Array.from({ length: 50 }, (_, index) =>
				buildWatched(buildRefusedCall('save'), 'name', () => reads.handler(index)),
			)
			expect(computeRefusals(refused)).toBe(50)
			// The key of the count, then the read of the earlier count, for each call in turn.
			expect(reads.calls).toEqual(refused.flatMap((_, index) => [[index], [index]]))
		})

		it('counts a call before it obtains the next one', () => {
			const calls = buildLazyCalls(buildRefusedCall('save'), buildRefusedCall('save'), {
				success: true,
			})
			expect(computeRefusals(calls)).toBe(2)
		})

		it('refuses a list that has no iterator as for…of does', () => {
			expect(() => computeRefusals(buildIteratorlessList([buildRefusedCall('save')]))).toThrow(
				TypeError,
			)
		})
	})

	describe('StoreRefusals', () => {
		it('tallies refused calls by tool name, counts a success as nothing, and starts at zero', () => {
			const tally = new StoreRefusals()
			expect(tally.largest).toBe(0)
			tally.count(buildStoreCall('save', {}))
			expect(tally.largest).toBe(0)
			tally.count(buildRefusedCall('save'))
			tally.count(buildRefusedCall('record'))
			tally.count(buildRefusedCall('save'))
			expect(tally.largest).toBe(2)
		})
	})

	describe('converseStore', () => {
		it('advertises no tool after the refusal bound until the next user turn advertises every tool again', async () => {
			const daemon = createRecordingTransport(
				createScriptedTransport([
					...STORE_REFUSAL_TURNS,
					{ content: 'The tool refused.' },
					STORE_LOOKUP_TURN,
					{ content: 'Found.' },
				]),
			)
			const tools = createRefusalTools()
			const conversation = await converseStore({
				provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
				system: STORE_SYSTEM_PROMPT,
				tools,
				turns: ['Call the fail tool.', 'Look up the kettle.'],
			})
			expect(daemon.requests.map(wireTools)).toEqual([
				...STORE_REFUSAL_TURNS.map(() => STORE_REFUSAL_TOOLS),
				[],
				STORE_REFUSAL_TOOLS,
				[],
			])
			expect(conversation.ended).toBe(2)
			expect(conversation.failure).toBeUndefined()
			expect(conversation.result).toMatchObject({ content: 'Found.', partial: false })
			expect(conversation.partial).toBe(false)
			expect(conversation.calls.map((call) => [call.name, call.success])).toEqual([
				...STORE_REFUSAL_TURNS.map(() => ['fail', false]),
				['lookup', true],
			])
			expect(
				conversation.messages
					.filter((message) => message.role === 'assistant')
					.map((message) => message.content),
			).toContain('The tool refused.')
		})

		it('advertises no tool after one provider turn whose parallel calls reach the bound', async () => {
			const daemon = createRecordingTransport(
				createScriptedTransport([
					{ content: '', tool_calls: STORE_REFUSAL_TURNS.flatMap((turn) => turn.tool_calls) },
					{ content: 'The tool refused.' },
				]),
			)
			const tools = createRefusalTools()
			const conversation = await converseStore({
				provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
				system: STORE_SYSTEM_PROMPT,
				tools,
				turns: ['Call the fail tool.'],
			})
			expect(daemon.requests.map(wireTools)).toEqual([STORE_REFUSAL_TOOLS, []])
			expect(conversation.ended).toBe(1)
			expect(conversation.result).toMatchObject({ content: 'The tool refused.', partial: false })
		})

		it("advertises no tool after a later turn's first successful call, while the opening turn keeps every tool", async () => {
			const daemon = createRecordingTransport(
				createScriptedTransport([
					STORE_LOOKUP_TURN,
					STORE_LOOKUP_TURN,
					{ content: 'Found twice.' },
					STORE_LOOKUP_TURN,
					STORE_FAIL_TURN,
					{ content: 'Found once.' },
				]),
			)
			const tools = createRefusalTools()
			const conversation = await converseStore({
				provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
				system: STORE_SYSTEM_PROMPT,
				tools,
				turns: ['Look up the kettle twice.', 'Look up the kettle once more.'],
			})
			expect(daemon.requests.map(wireTools)).toEqual([
				STORE_REFUSAL_TOOLS,
				STORE_REFUSAL_TOOLS,
				STORE_REFUSAL_TOOLS,
				STORE_REFUSAL_TOOLS,
				[],
			])
			expect(conversation.calls.map((call) => [call.name, call.success])).toEqual([
				['lookup', true],
				['lookup', true],
				['lookup', true],
			])
			expect(conversation.ended).toBe(1)
			expect(conversation.result).toMatchObject({ partial: false })
		})

		it('reaches the bound across a success between the refusals of one tool', async () => {
			const short = STORE_REFUSAL_TURNS.slice(1)
			const daemon = createRecordingTransport(
				createScriptedTransport([
					...short,
					STORE_LOOKUP_TURN,
					STORE_FAIL_TURN,
					{ content: 'The tool refused.' },
				]),
			)
			const tools = createRefusalTools()
			const conversation = await converseStore({
				provider: createOllama({ model: 'fixture-model', fetch: daemon.fetch }),
				system: STORE_SYSTEM_PROMPT,
				tools,
				turns: ['Call the fail tool, then look up the kettle.'],
			})
			expect(daemon.requests.map(wireTools)).toEqual([
				...[...short, STORE_LOOKUP_TURN, STORE_FAIL_TURN].map(() => STORE_REFUSAL_TOOLS),
				[],
			])
			expect(conversation.ended).toBe(1)
			expect(conversation.result).toMatchObject({ content: 'The tool refused.', partial: false })
		})

		it('returns the error that ended a user turn with the calls made before it', async () => {
			const tools = createRefusalTools()
			const conversation = await converseStore({
				provider: createOllama({
					model: 'fixture-model',
					fetch: createScriptedTransport([STORE_LOOKUP_TURN]),
				}),
				system: STORE_SYSTEM_PROMPT,
				tools,
				turns: ['Look up the kettle.'],
			})
			expect(conversation.result).toBeUndefined()
			expect(String(conversation.failure)).toContain('the script holds 1 turns')
			expect(conversation.calls.map((call) => [call.name, call.success])).toEqual([
				['lookup', true],
			])
		})

		it('returns the timings, the usages, and the partial flag over a history whose turns differ', async () => {
			const provider = createOllama({
				model: 'fixture-model',
				fetch: createScriptedTransport([
					STORE_LOOKUP_TURN,
					STORE_LOOKUP_TURN,
					{ content: 'Done.' },
				]),
			})
			const conversation = await converseStore({
				provider,
				system: STORE_SYSTEM_PROMPT,
				tools: createRefusalTools(),
				turns: ['Look up the kettle.', 'Say that you are done.'],
				limit: 1,
			})
			// The opening turn stops at its limit, so it is partial; the later turn answers whole.
			expect(conversation.partial).toBe(true)
			expect(conversation.result).toMatchObject({ content: 'Done.', partial: false })
			expect(conversation.timings.map((timing) => [timing.operation, timing.name])).toEqual([
				['generation', provider.id],
				['tool', 'lookup'],
				['generation', provider.id],
				['tool', 'lookup'],
				['generation', provider.id],
			])
			expect(conversation.timings.every((timing) => timing.end >= timing.start)).toBe(true)
			const ends = conversation.timings.map((timing) => timing.end)
			expect(ends).toEqual([...ends].sort((left, right) => left - right))
			expect(conversation.usages).toEqual(
				Array.from({ length: 3 }, () => ({ prompt: 3, completion: 4, total: 7 })),
			)
		})

		it('records the thinking the turn streamed, not the text the agent joined, when native and inline reasoning mix', async () => {
			const conversation = await converseStore({
				provider: createOllama({
					model: 'fixture-model',
					fetch: createScriptedTransport([STORE_MIXED_TURN]),
				}),
				system: STORE_SYSTEM_PROMPT,
				tools: createRefusalTools(),
				turns: ['Say hello.'],
			})
			// The agent's own record of this turn holds the inline span ahead of the native text.
			expect(conversation.failure).toBeUndefined()
			expect(
				conversation.messages
					.filter((message) => message.role === 'assistant')
					.map((message) => [message.content, message.thinking]),
			).toEqual([['Answer.', 'native ']])
		})
	})

	describe('attemptStoreTask with a journey root', () => {
		it('starts consecutive attempts at e1 in a real browser', async () => {
			const browser = await createPageBrowser()
			try {
				await browser.connect()
				const contexts = browser.contexts()
				const seeds: string[] = []
				for (const ordinal of STORE_ISOLATION_ATTEMPTS) {
					const result = await attemptStoreTask(
						browser,
						{ ...STORE_TASKS.shipping, name: 'isolation' },
						ordinal,
						createOllama({
							model: 'fixture-model',
							fetch: createScriptedTransport([{ content: 'Finished.' }]),
						}),
					)
					seeds.push(extractReferences(result.transcript.seed)[0] ?? '')
					expect(result.store.read().cart).toEqual([])
					expect(browser.contexts()).toEqual(contexts)
				}
				expect(seeds).toEqual(['e1', 'e1'])
				await expect(
					attemptStoreTask(
						browser,
						{ ...STORE_TASKS.shipping, name: 'isolation-failure' },
						1,
						createOllama({
							model: 'fixture-model',
							fetch: async () => new Response('Refused', { status: 401 }),
						}),
					),
				).rejects.toBeInstanceOf(ProviderError)
				expect(browser.contexts()).toEqual(contexts)
			} finally {
				await browser.destroy()
			}
		})

		it('removes the root it allocated under tmp/browsers when the page cannot open', async () => {
			const refusal = new Error('the browser refused a page')
			const provider = createOllama({ model: 'fixture', url: 'http://127.0.0.1:9' })
			await expect(
				attemptStoreTask(
					{ isolate: () => Promise.reject(refusal) },
					STORE_TASKS.journey,
					7,
					provider,
				),
			).rejects.toBe(refusal)
			expect(
				readdirSync(resolveJourneyPath()).filter((name) => name.startsWith('journey-7-')),
			).toEqual([])
		})
	})

	describe('store helper boundaries', () => {
		it('stems words without discarding more than one trailing letter', () => {
			expect(stemWord('KETTLES')).toBe('kettle')
			expect(stemWord('glass')).toBe('glas')
			expect(stemWord('')).toBe('')
		})

		it('finds products by identifier and refuses absent or unknown identifiers', () => {
			expect(findStoreProduct('p4')).toMatchObject({ name: 'Copper Kettle', price: '$58.00' })
			expect(findStoreProduct(undefined)).toBeUndefined()
			expect(findStoreProduct(null)).toBeUndefined()
			expect(findStoreProduct('')).toBeUndefined()
			expect(findStoreProduct('missing')).toBeUndefined()
		})

		it('builds an uncached not-found HTML response', async () => {
			const response = buildMissingResponse()
			expect(response.status).toBe(404)
			expect(response.headers.get('cache-control')).toBe('no-store')
			expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
			expect(await response.text()).toContain('<h1>Not found</h1>')
		})

		it('extracts headers and numeric captures without inventing absent values', () => {
			expect(extractPageHeader('Receipt\npage "Cart" http://store/cart\n1: Cart')).toBe(
				'page "Cart" http://store/cart',
			)
			expect(extractPageHeader('Receipt\r\npage "Cart" http://store/cart\r\n1: Cart')).toBe(
				'page "Cart" http://store/cart',
			)
			expect(extractPageHeader('No page header')).toBeUndefined()
			expect(readCapturedNumber(/(31)/.exec('31'))).toBe(31)
			expect(readCapturedNumber(/(0)/.exec('0'))).toBe(0)
			expect(readCapturedNumber(null)).toBeUndefined()
			expect(readCapturedNumber(/31/.exec('31'))).toBeUndefined()
		})

		it('matches only identified cart-click rows', () => {
			expect(matchesCartClick('s12 click link "Cart"')).toBe(true)
			expect(matchesCartClick('s0 click link "Cart"')).toBe(false)
			expect(matchesCartClick('s12 click link "Checkout"')).toBe(false)
			expect(matchesCartClick('s12 click button "Cart"')).toBe(false)
			expect(matchesCartClick('')).toBe(false)
		})

		it('builds refused calls with default or supplied arguments and text', () => {
			expect(buildRefusedCall('save')).toEqual({
				name: 'save',
				arguments: {},
				success: false,
				text: '',
			})
			expect(buildRefusedCall('click', { ref: 'e99' }, 'Not in view.')).toEqual({
				name: 'click',
				arguments: { ref: 'e99' },
				success: false,
				text: 'Not in view.',
			})
		})

		it('creates the refusal registry and records successful and failed calls', async () => {
			const tools = createRefusalTools()
			try {
				expect(tools.definitions().map((definition) => definition.name)).toEqual(['lookup', 'fail'])
				expect(await executeStoreCall(tools, 'lookup-test', 'lookup', { query: 'kettle' })).toEqual(
					{
						name: 'lookup',
						arguments: { query: 'kettle' },
						success: true,
						text: LOOKUP_DATUM,
					},
				)
				expect(await executeStoreCall(tools, 'fail-test', 'fail', {})).toEqual({
					name: 'fail',
					arguments: {},
					success: false,
					text: THROWING_TOOL_MESSAGE,
				})
			} finally {
				tools.destroy()
			}
		})

		it('resolves transcript paths against the supplied root', () => {
			const scratch = createScratch({ prefix: 'store-path-' })
			try {
				expect(resolveTranscriptPath('checkout', 2, scratch.path)).toBe(
					join(scratch.path, 'tmp', 'probes', 'logs', 'checkout-2.json'),
				)
			} finally {
				scratch.destroy()
			}
		})
	})

	describe('collectTurnThinking', () => {
		it('forwards every chunk and separates reasoning at usage boundaries', async () => {
			const channel = createChannel<AgentChunk>()
			for (const chunk of STORE_THINKING_CHUNKS) channel.push(chunk)
			channel.close()
			const thoughts: StoreThought[] = []
			const chunks = await collect(collectTurnThinking(channel.drain(), thoughts))
			expect(chunks).toEqual(STORE_THINKING_CHUNKS)
			expect(chunks[0]).toBe(STORE_THINKING_CHUNKS[0])
			expect(deriveTurnThinking(thoughts)).toEqual(['Check the cart.', '', 'Confirm.'])
		})

		it('preserves an empty stream and propagates a stream failure', async () => {
			const empty = createChannel<AgentChunk>()
			empty.close()
			const thoughts: StoreThought[] = []
			expect(await collect(collectTurnThinking(empty.drain(), thoughts))).toEqual([])
			expect(deriveTurnThinking(thoughts)).toEqual([''])
			const failed = createChannel<AgentChunk>()
			const failure = new Error('Stream refused')
			failed.fail(failure)
			await expect(collect(collectTurnThinking(failed.drain(), thoughts))).rejects.toBe(failure)
			expect(deriveTurnThinking(thoughts)).toEqual([''])
		})

		it('logs each reasoning and usage chunk unchanged in emission order and no answer chunk', async () => {
			const channel = createChannel<AgentChunk>()
			for (const chunk of STORE_THINKING_CHUNKS) channel.push(chunk)
			channel.close()
			const thoughts: StoreThought[] = []
			await collect(collectTurnThinking(channel.drain(), thoughts))
			expect(thoughts).toEqual([
				{ category: 'think', content: 'Check ' },
				{ category: 'think', content: 'the cart.' },
				{ category: 'usage' },
				{ category: 'usage' },
				{ category: 'think', content: 'Confirm.' },
			])
		})

		it('reads only the category of each chunk and the content of a think chunk, as the category check did', async () => {
			const reads: string[] = []
			const channel = createChannel<AgentChunk>()
			for (const chunk of STORE_THINKING_CHUNKS.slice(0, 4)) {
				channel.push(
					buildTracedRecord(chunk, (key) => {
						reads.push(`${chunk.category}:${key}`)
					}),
				)
			}
			channel.close()
			const thoughts: StoreThought[] = []
			await collect(collectTurnThinking(channel.drain(), thoughts))
			expect(reads).toEqual([
				'think:category',
				'think:content',
				'token:category',
				'token:category',
				'think:category',
				'think:content',
				'usage:category',
				'usage:category',
			])
			expect(deriveTurnThinking(thoughts)).toEqual(['Check the cart.', ''])
		})

		it('captures each chunk at emission, so a consumer that changes a chunk later changes nothing the log holds', async () => {
			const channel = createChannel<AgentChunk>()
			channel.push({ category: 'think', content: 'Plan.' })
			channel.push({
				category: 'usage',
				usage: { prompt: 1, completion: 1, total: 2 },
				estimate: 1,
			})
			channel.push({ category: 'think', content: 'Answer.' })
			channel.close()
			const thoughts: StoreThought[] = []
			for await (const chunk of collectTurnThinking(channel.drain(), thoughts)) {
				Object.defineProperty(chunk, chunk.category === 'usage' ? 'category' : 'content', {
					value: 'changed',
				})
			}
			expect(deriveTurnThinking(thoughts)).toEqual(['Plan.', 'Answer.'])
		})

		it('keeps the log of a stream the consumer leaves early up to the last chunk it received', async () => {
			const channel = createChannel<AgentChunk>()
			for (const chunk of STORE_THINKING_CHUNKS) channel.push(chunk)
			channel.close()
			const thoughts: StoreThought[] = []
			for await (const chunk of collectTurnThinking(channel.drain(), thoughts)) {
				if (chunk.category === 'usage') break
			}
			expect(deriveTurnThinking(thoughts)).toEqual(['Check the cart.', ''])
		})
	})

	describe('deriveTurnThinking', () => {
		for (const scenario of STORE_THOUGHT_CASES) {
			it(`derives one text per provider turn from ${scenario.label}`, () => {
				expect(deriveTurnThinking(scenario.log)).toEqual(scenario.turns)
			})
		}
	})

	describe('StoreActivity', () => {
		it('records the cart, searches, and orders in submission order and reads copies of them', () => {
			const activity = new StoreActivity([STORE_NAMED_PRODUCT])
			activity.add('Linen Apron')
			activity.search('kettle')
			activity.search('mug')
			activity.order(STORE_BUYER)
			const reading = activity.read()
			expect(reading).toEqual({
				cart: [STORE_NAMED_PRODUCT, 'Linen Apron'],
				searches: ['kettle', 'mug'],
				orders: [STORE_BUYER],
			})
			activity.add('Stoneware Mug')
			expect(reading.cart).toEqual([STORE_NAMED_PRODUCT, 'Linen Apron'])
			expect(activity.read().cart).toEqual([STORE_NAMED_PRODUCT, 'Linen Apron', 'Stoneware Mug'])
		})

		it('starts empty by default and copies the cart it starts with', () => {
			const initial = [STORE_NAMED_PRODUCT]
			const seeded = new StoreActivity(initial)
			seeded.add('Linen Apron')
			expect(initial).toEqual([STORE_NAMED_PRODUCT])
			expect(new StoreActivity().read()).toEqual({ cart: [], searches: [], orders: [] })
		})

		it('keeps the state of two records apart', () => {
			const first = new StoreActivity()
			const second = new StoreActivity()
			first.order(STORE_BUYER)
			expect(first.read().orders).toEqual([STORE_BUYER])
			expect(second.read().orders).toEqual([])
		})
	})

	describe('StoreCallRecord', () => {
		const refused: ToolResult = { id: '1', name: 'fail', success: false, error: 'gone' }
		const succeeded: ToolResult = { id: '2', name: 'lookup', success: true, value: 'found' }
		const failing: ToolCall = { id: '1', name: 'fail', arguments: {} }
		const looking: ToolCall = { id: '2', name: 'lookup', arguments: { query: 'kettle' } }

		it('records each call with its rendered result and ends the opening turn at the refusal bound', () => {
			const record = new StoreCallRecord()
			const context = createStoreContext()
			record.begin(0)
			for (const _ of Array.from({ length: STORE_BOUNDS.refusals - 1 }))
				record.observe(failing, refused, context)
			expect(context.scope).toBeUndefined()
			expect(record.ended).toBe(0)
			record.observe(failing, refused, context)
			expect(context.scope).toBe(STORE_ANSWER_SCOPE)
			expect(record.ended).toBe(1)
			record.observe(failing, refused, context)
			expect(record.ended).toBe(1)
			expect(record.calls).toEqual(
				Array.from({ length: STORE_BOUNDS.refusals + 1 }, () => ({
					name: 'fail',
					arguments: {},
					success: false,
					text: 'gone',
				})),
			)
		})

		it('ends a later turn at its first successful call and the opening turn at no success', () => {
			const record = new StoreCallRecord()
			const opening = createStoreContext()
			record.begin(0)
			record.observe(looking, succeeded, opening)
			expect(opening.scope).toBeUndefined()
			expect(record.ended).toBe(0)
			const later = createStoreContext()
			record.end()
			record.begin(1)
			record.observe(failing, refused, later)
			expect(later.scope).toBeUndefined()
			record.observe(looking, succeeded, later)
			expect(later.scope).toBe(STORE_ANSWER_SCOPE)
			expect(record.ended).toBe(1)
			expect(record.calls.map((call) => [call.name, call.success, call.text])).toEqual([
				['lookup', true, 'found'],
				['fail', false, 'gone'],
				['lookup', true, 'found'],
			])
		})

		it('counts refusals from the calls the turn began after', () => {
			const record = new StoreCallRecord()
			const context = createStoreContext()
			record.begin(0)
			record.observe(failing, refused, context)
			record.observe(failing, refused, context)
			record.end()
			record.begin(0)
			record.observe(failing, refused, context)
			record.observe(failing, refused, context)
			expect(context.scope).toBeUndefined()
			expect(record.ended).toBe(0)
			record.observe(failing, refused, context)
			expect(context.scope).toBe(STORE_ANSWER_SCOPE)
			expect(record.ended).toBe(1)
		})

		it('refuses to bind a second turn while one is bound and to observe a call with none bound', () => {
			const record = new StoreCallRecord()
			const context = createStoreContext()
			expect(() => record.observe(failing, refused, context)).toThrow('No user turn is bound')
			record.begin(0)
			expect(() => record.begin(1)).toThrow('A user turn is still bound')
			record.end()
			expect(() => record.observe(failing, refused, context)).toThrow('No user turn is bound')
			record.begin(1)
			record.observe(looking, succeeded, context)
			expect(record.calls).toHaveLength(1)
		})
	})

	describe('settleStoreRun', () => {
		it('reports a settled run without a failure', async () => {
			expect(await settleStoreRun(async () => {})).toEqual({ failed: false, failure: undefined })
		})

		it('captures a thrown value, including a thrown undefined value, instead of letting it escape', async () => {
			const refusal = new Error('step refused')
			expect(
				await settleStoreRun(async () => {
					await Promise.resolve()
					throw refusal
				}),
			).toEqual({ failed: true, failure: refusal })
			expect(
				await settleStoreRun(async () => {
					throw undefined
				}),
			).toEqual({ failed: true, failure: undefined })
		})
	})

	describe('StoreExposureTrace', () => {
		const start: StoreExposure = {
			listed: new Set(['e1']),
			header: 'page "A" http://store/a',
			unlisted: [],
		}

		it('adds the references of a successful result and clears them when the page header changes', () => {
			const trace = new StoreExposureTrace(start)
			trace.visit(buildStoreCall('read', {}, 'page "A" http://store/a\n2: button "Y" [ref=e2]'))
			const same = trace.exposure
			expect([...same.listed]).toEqual(['e1', 'e2'])
			trace.visit(buildStoreCall('read', {}, 'page "B" http://store/b\n3: link "Z" [ref=e3]'))
			const moved = trace.exposure
			expect([...moved.listed]).toEqual(['e3'])
			expect(moved.header).toBe('page "B" http://store/b')
			expect([...start.listed]).toEqual(['e1'])
			expect([...same.listed]).toEqual(['e1', 'e2'])
		})

		it('records an unlisted reference apart from the earlier exposure and ignores a failed result', () => {
			const invented = buildRefusedCall('click', { ref: 'e9' }, 'Not in the current view.')
			const trace = new StoreExposureTrace(start)
			trace.visit(invented)
			const flagged = trace.exposure
			expect(flagged.unlisted).toEqual([invented])
			expect([...flagged.listed]).toEqual(['e1'])
			expect(start.unlisted).toEqual([])
			trace.visit(buildRefusedCall('read', {}, 'page "C" http://store/c\n4: link "W" [ref=e4]'))
			const failed = trace.exposure
			expect([...failed.listed]).toEqual(['e1'])
			expect(failed.header).toBe('page "A" http://store/a')
			expect(failed.unlisted).toEqual([invented])
		})

		it('reads out copies that its later calls cannot change', () => {
			const trace = new StoreExposureTrace(start)
			const before = trace.exposure
			trace.visit(buildStoreCall('read', {}, 'page "B" http://store/b\n3: link "Z" [ref=e3]'))
			trace.visit(buildStoreCall('click', { ref: 'e9' }))
			expect([...before.listed]).toEqual(['e1'])
			expect(before.header).toBe('page "A" http://store/a')
			expect(before.unlisted).toEqual([])
		})
	})

	describe('StoreContinuationWalk', () => {
		const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
		const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)

		it('returns the call that continued at a line an earlier footer named, and nothing before it', () => {
			const walk = new StoreContinuationWalk(STORE_POLICY_TOKEN)
			expect(walk.visit(first)).toBeUndefined()
			expect(walk.visit(continued)).toBe(continued)
		})

		it.each(STORE_CONTINUATION_INTERRUPTIONS)(
			'forgets the named lines at %s',
			(_reason, interruption) => {
				const walk = new StoreContinuationWalk(STORE_POLICY_TOKEN)
				walk.visit(first)
				walk.visit(interruption)
				expect(walk.visit(continued)).toBeUndefined()
			},
		)

		it('names each interruption the walk forgets at, every one a successful call', () => {
			expect(
				STORE_CONTINUATION_INTERRUPTIONS.map(([reason, call]) => [reason, call.success]),
			).toEqual([
				['an action', true],
				['a change note', true],
				['another page', true],
			])
			expect(STORE_CONTINUATION_INTERRUPTIONS.map(([, call]) => call.name)).toEqual([
				'click',
				'read',
				'read',
			])
		})

		it('keeps the named lines across a refused read', () => {
			const walk = new StoreContinuationWalk(STORE_POLICY_TOKEN)
			walk.visit(first)
			walk.visit(buildRefusedCall('read', { from: 2 }, 'Refused.'))
			expect(walk.visit(continued)).toBe(continued)
		})
	})

	describe('StoreThinking', () => {
		it('gives the n-th assistant message the n-th turn thinking and passes the others through', () => {
			const user: Message = { id: 'u', role: 'user', content: '' }
			const assistant: Message = { id: 'a', role: 'assistant', content: '' }
			const thinking = new StoreThinking(['first', ''])
			expect(thinking.attach(user)).toBe(user)
			expect(thinking.attach(assistant)).toEqual({ ...assistant, thinking: 'first' })
			expect(thinking.attach(assistant)).toBe(assistant)
			expect(thinking.attach(assistant)).toBe(assistant)
		})

		it('advances past a silent turn, so a later turn keeps its own thinking', () => {
			const assistant: Message = { id: 'a', role: 'assistant', content: '' }
			const thinking = new StoreThinking(['', 'second', '', 'fourth'])
			expect(thinking.attach(assistant)).toBe(assistant)
			expect(thinking.attach(assistant)).toEqual({ ...assistant, thinking: 'second' })
			expect(thinking.attach(assistant)).toBe(assistant)
			expect(thinking.attach(assistant)).toEqual({ ...assistant, thinking: 'fourth' })
		})
	})

	describe('STORE_SEARCH_SEED', () => {
		it('opens the catalogue with the search box and its button, and seeds the stalled search', () => {
			expect(extractReferences(STORE_SEARCH_SEED)).toEqual(['e35', 'e36'])
			expect(STORE_SEARCH_SEED).toMatch(/^page "Harbor Goods — Catalogue" /)
			expect(STORE_STALLED_SEARCH.seed).toBe(STORE_SEARCH_SEED)
			expect(STORE_COMPLETED_SEARCH.seed).toBe(STORE_SEARCH_SEED)
		})
	})

	describe('hole handling of the call readers', () => {
		const first = buildStoreCall('read', { from: 1 }, STORE_FIRST_SLICE)
		const continued = buildStoreCall('read', { from: 31 }, STORE_CONTINUED_SLICE)

		it('visits a hole in the calls as undefined, so findUnlistedReferences and computeRefusals throw on it', () => {
			const calls = buildSparseList([buildStoreCall('click', { ref: 'e1' }), undefined])
			expect(() => findUnlistedReferences('1: link "Cart" [ref=e1]', calls)).toThrow(TypeError)
			expect(() => computeRefusals(buildSparseList([buildRefusedCall('save'), undefined]))).toThrow(
				TypeError,
			)
		})

		it('reads findContinuedRead only as far as the match, so a hole after it is never visited and one before it throws', () => {
			expect(
				findContinuedRead(buildSparseList([first, continued, undefined]), STORE_POLICY_TOKEN),
			).toBe(continued)
			expect(() =>
				findContinuedRead(buildSparseList([first, undefined, continued]), STORE_POLICY_TOKEN),
			).toThrow(TypeError)
		})

		it('reads matchesJourneySequence only as far as the sequence, so a hole after it is never visited and one before it throws', () => {
			expect(matchesJourneySequence(buildSparseList([...STORE_JOURNEY_CALLS, undefined]))).toBe(
				true,
			)
			expect(() =>
				matchesJourneySequence(buildSparseList([undefined, ...STORE_JOURNEY_CALLS])),
			).toThrow(TypeError)
		})

		it('counts only assistant messages as turns, however many tool messages lie between them', () => {
			const user: Message = { id: 'u', role: 'user', content: '' }
			const assistant: Message = { id: 'a', role: 'assistant', content: '' }
			const tool: Message = { id: 't', role: 'tool', content: 'results' }
			const recorded = attachThinking([user, assistant, tool, tool, assistant], ['first', 'second'])
			expect(recorded.map((message) => message.thinking)).toEqual([
				undefined,
				'first',
				undefined,
				undefined,
				'second',
			])
		})

		it('keeps a hole in the messages a hole and counts assistant turns across it', () => {
			const user: Message = { id: 'u', role: 'user', content: '' }
			const assistant: Message = { id: 'a', role: 'assistant', content: '' }
			const recorded = attachThinking(buildSparseList([user, undefined, assistant, assistant]), [
				'first',
				'second',
			])
			expect(Object.keys(recorded)).toEqual(['0', '2', '3'])
			expect(recorded.map((message) => message.thinking)).toEqual([
				undefined,
				undefined,
				'first',
				'second',
			])
		})

		it('reads a quoted best-match row once, even when the row before it announced another', () => {
			const text = [
				'No line from 3 on matches "a"; the best match is line 1:',
				'No line from 3 on matches "a"; the best match is line 2:',
				'5: x',
				'6: y',
			].join('\n')
			expect(extractWindowText(text)).toBe('5: x\n6: y')
		})
	})

	describe('buildJourneyInvocation', () => {
		it('names each journey tool with the arguments the proof supplies', () => {
			expect(buildJourneyInvocation('record', [], '')).toEqual({
				name: 'record',
				input: { journey: STORE_JOURNEY_NAME },
			})
			expect(buildJourneyInvocation('save', [], '')).toEqual({
				name: 'save',
				input: { description: 'Open the cart and place one order.' },
			})
			expect(buildJourneyInvocation('journeys', [], '')).toEqual({
				name: 'journeys',
				input: { from: 1 },
			})
			expect(buildJourneyInvocation('replay', [], '')).toEqual({
				name: 'replay',
				input: {
					journey: STORE_JOURNEY_NAME,
					inputs: { [STORE_JOURNEY_PARAMETER]: STORE_JOURNEY_BUYER },
				},
			})
		})

		it('reads the batch the edit turn spells out from the last listing', () => {
			const { name, input } = buildJourneyInvocation('edit', STORE_JOURNEY_CALLS.slice(0, 4), '')
			expect(name).toBe('edit')
			expect(input['journey']).toBe(STORE_JOURNEY_NAME)
			expect(matchesJourneyBatch(buildStoreCall('edit', input))).toBe(true)
		})

		it('acts on an element through the reference its row lists in the last result, or in the seed', () => {
			const seed = 'page "Store" http://store/ (2 lines)\n1: link "Cart" [ref=e1]'
			expect(buildJourneyInvocation('Cart', [], seed)).toEqual({
				name: 'click',
				input: { ref: 'e1' },
			})
			const listing = buildStoreCall('click', {}, '3: textbox "Full name" [ref=e4]')
			expect(buildJourneyInvocation('Full name', [listing], seed)).toEqual({
				name: 'type',
				input: { ref: 'e4', text: STORE_BUYER, submit: true },
			})
			expect(() => buildJourneyInvocation('Checkout', [listing], seed)).toThrow(
				'The last result lists no row for "Checkout"',
			)
		})
	})

	describe('converseStore with a failing user turn', () => {
		it('keeps the partial flag of a settled turn when a later turn fails', async () => {
			const conversation = await converseStore({
				provider: createOllama({
					model: 'fixture-model',
					fetch: createScriptedTransport([STORE_LOOKUP_TURN]),
				}),
				system: STORE_SYSTEM_PROMPT,
				tools: createRefusalTools(),
				turns: ['Look up the kettle.', 'Look up the kettle again.'],
				limit: 1,
			})
			expect(conversation.result).toBeUndefined()
			expect(conversation.partial).toBe(true)
			expect(String(conversation.failure)).toContain('the script holds 1 turns')
			expect(conversation.calls.map((call) => [call.name, call.success])).toEqual([
				['lookup', true],
			])
		})

		it('ends the conversation with the error a hole in the turns raises, after the turns before it', async () => {
			const conversation = await converseStore({
				provider: createOllama({
					model: 'fixture-model',
					fetch: createScriptedTransport([{ content: 'One.' }, { content: 'Two.' }]),
				}),
				system: STORE_SYSTEM_PROMPT,
				tools: createRefusalTools(),
				turns: buildSparseList<StoreTurn>(['First.', undefined, 'Third.']),
			})
			expect(conversation.result).toBeUndefined()
			expect(conversation.failure).toBeInstanceOf(TypeError)
			expect(conversation.messages.map((message) => message.content)).toEqual(['First.', 'One.'])
		})
	})
})
