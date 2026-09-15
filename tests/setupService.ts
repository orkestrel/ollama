import type { ContextFormat, ConversationInterface, Message } from '@orkestrel/agent'
import type { SystemBrowser, SystemBrowserOptions } from '@orkestrel/browser/server'
import { findSystemBrowser } from '@orkestrel/browser/server'
import { isRecord, isString } from '@orkestrel/contract'
import { createOllama, OLLAMA_CHAT_PATH, OllamaProvider } from '@src/core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { env, rootToPath, withScheme, WORKSPACE_ROOT } from './setupServer.js'

/** Names the live daemon and model selected for the service axis. */
export const OLLAMA_CONFIG = Object.freeze({
	host: withScheme(env('OLLAMA_HOST', 'http://localhost:11434')),
	model: env('OLLAMA_MODEL', 'qwen3.5:2b-q4_K_M'),
})

/** Represents the tuning a live Ollama test provider accepts. */
export interface LiveProviderOptions {
	/** The Ollama `num_predict` cap; defaults to `32`. */
	readonly predict?: number
	/** The sampling temperature; defaults to `0` for reproducible fixtures. */
	readonly temperature?: number
	/** The provider's context-framing default; omission leaves framing undefined. */
	readonly format?: ContextFormat
}

/**
 * Builds a concrete provider against the selected live daemon and warmed model.
 *
 * @param options - Optional prediction, temperature, and framing overrides
 * @returns A concrete provider configured for the service axis
 */
export function createLiveOllama(options?: LiveProviderOptions): OllamaProvider {
	return new OllamaProvider({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: { num_predict: options?.predict ?? 32, temperature: options?.temperature ?? 0 },
		...(options?.format === undefined ? {} : { format: options.format }),
	})
}

/**
 * Builds a live summarizer for conversation-compaction scenarios.
 *
 * The fixed summarization instruction is appended as the final user turn because a
 * reasoning chat model may treat a prompt ending on an assistant turn as already
 * answered and emit no digest.
 *
 * @param timeoutMs - The generation deadline in milliseconds
 * @param predict - The summarizer's `num_predict` cap; defaults to `64`
 * @returns A conversation summarizer backed by the warmed live model
 */
export function createLiveSummarizer(
	timeoutMs: number,
	predict = 64,
): (messages: readonly Message[]) => Promise<string> {
	const summarizer = createOllama({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: { num_predict: predict, temperature: 0 },
	})
	return async (messages) =>
		(
			await summarizer.generate(
				[
					...messages,
					{
						id: 'sum',
						role: 'user',
						content: 'Summarize the conversation so far concisely in one sentence.',
					},
				],
				AbortSignal.timeout(timeoutMs),
			)
		).content
}

/**
 * Seeds a conversation with the fixed trip-planning exchange compaction round-trips fold.
 *
 * The seeded turns are long enough that a one-sentence digest is measurably shorter, so a
 * post-compaction `view()` is provably smaller than the seeded one.
 *
 * @param conversation - The conversation to add the turns to
 */
export function seedConversation(conversation: ConversationInterface): void {
	conversation.add([
		{ role: 'user', content: 'My name is Ada and I am planning a trip to Kyoto in spring.' },
		{
			role: 'assistant',
			content: 'Kyoto in spring is lovely — the cherry blossoms peak in early April.',
		},
		{ role: 'user', content: 'I want to visit temples and try traditional food.' },
		{
			role: 'assistant',
			content: 'Fushimi Inari and Kinkaku-ji are must-sees; try kaiseki and yudofu.',
		},
	])
}

/**
 * Checks whether the daemon answers and reports the selected model as installed.
 *
 * @returns `true` only when `/api/tags` succeeds and includes the configured model
 */
export async function isOllamaReady(): Promise<boolean> {
	try {
		const response = await fetch(`${OLLAMA_CONFIG.host}/api/tags`, {
			signal: AbortSignal.timeout(5000),
		})
		if (!response.ok) return false
		const body: unknown = await response.json()
		if (!isRecord(body) || !Array.isArray(body.models)) return false
		return body.models.some(
			(model) =>
				isRecord(model) &&
				((isString(model.name) && model.name === OLLAMA_CONFIG.model) ||
					(isString(model.model) && model.model === OLLAMA_CONFIG.model)),
		)
	} catch {
		return false
	}
}

/**
 * Warms the selected model with a one-token chat request.
 *
 * @returns A promise that resolves after the response body has been drained
 * @throws When the daemon cannot be reached or rejects the warmup
 */
export async function warmOllama(): Promise<void> {
	let response: Response
	try {
		response = await fetch(`${OLLAMA_CONFIG.host}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: OLLAMA_CONFIG.model,
				messages: [{ role: 'user', content: 'hi' }],
				stream: false,
				think: false,
				options: { num_predict: 1 },
				keep_alive: '30m',
			}),
			signal: AbortSignal.timeout(120_000),
		})
	} catch (error) {
		throw new Error(
			`Ollama warmup could not reach ${OLLAMA_CONFIG.host} for model ${OLLAMA_CONFIG.model} (${String(error)})`,
			{ cause: error },
		)
	}
	if (!response.ok) {
		throw new Error(
			`Ollama warmup failed (${response.status}) for model ${OLLAMA_CONFIG.model} at ${OLLAMA_CONFIG.host}`,
		)
	}
	await response.text()
}

/** Names the request options for content and usage round-trips. */
export const FAST_OPTIONS = Object.freeze({ num_predict: 8, temperature: 0 })

/** Names the request options for multi-delta streaming round-trips. */
export const STREAM_OPTIONS = Object.freeze({ num_predict: 16, temperature: 0 })

/** Names the request options for tool-call round-trips. */
export const TOOL_OPTIONS = Object.freeze({ num_predict: 32, temperature: 0 })

/** Names the request options for mid-stream abort and deadline round-trips. */
export const ABORT_OPTIONS = Object.freeze({ num_predict: 64, temperature: 0 })

/** Names the request options for seeded deterministic round-trips. */
export const SEED_OPTIONS = Object.freeze({ num_predict: 8, temperature: 0, seed: 42 })

/** Names the request options for native-thinking round-trips. */
export const THINK_OPTIONS = Object.freeze({ num_predict: 8, temperature: 0 })

/**
 * Names the elapsed-time bound every live retry gives the `retryUntil` helper, in milliseconds.
 *
 * @remarks A live attempt is a real generation, so the shipped default budget of 1000 ms would
 * cut a bounded retry short after its first attempt. This value matches the `service` project's
 * own 120000 ms test timeout, which leaves the attempt count as the bound that ends a retry and
 * the runner's timeout as the bound on the wall clock.
 */
export const RETRY_BUDGET = 120_000

/** Names the request options for the two-turn tool-loop recipe. */
export const TOOL_LOOP_OPTIONS = Object.freeze({ num_predict: 64, temperature: 0 })

/**
 * Names the request options for the live page proof's direct daemon turn.
 *
 * @remarks The cap is above `FAST_OPTIONS` because that case asserts the daemon answered the
 * prompt it was given rather than that it answered at all, and a model that opens with a
 * reasoning prefix spends the first few tokens before the answer begins.
 */
export const PAGE_OPTIONS = Object.freeze({ num_predict: 32, temperature: 0 })

// ── Live page proof gates ─────────────────────────────────────────────────────
//
// Every precondition the live page proof needs beyond the daemon, each a hard throw
// naming its own fix. Each resolves on call and none at module load, so this module
// stays importable by its own proof in the `setup` project, which `npm test` runs on
// a host with no browser and no build.

/**
 * Lists the container-safe launch flags the live page proof's browser takes.
 *
 * @remarks
 * Headless Chromium running as root — the common case in a sandboxed container — needs
 * sandboxing off because it requires a non-root user, needs `/dev/shm` bypassed because it
 * is usually too small, and needs the GPU off because none is reachable. Each flag is inert
 * on a developer workstation, so the proof carries one launch recipe rather than a host
 * branch.
 */
export const PAGE_BROWSER_ARGS: readonly string[] = Object.freeze([
	'--no-sandbox',
	'--disable-dev-shm-usage',
	'--disable-gpu',
])

/**
 * Resolves the Chromium-family browser the page proof drives, or throws naming what to install.
 *
 * @param options - Candidate-source overrides; omitted ⇒ full default discovery
 * @returns The discovered browser executable and its classified engine
 * @throws Thrown when no candidate source resolves a browser executable.
 */
export function requirePageBrowser(options?: SystemBrowserOptions): SystemBrowser {
	const found = findSystemBrowser(options)
	if (found === undefined) {
		throw new Error(
			'The page proof requires a Chromium-family browser on this host and found none. ' +
				'Install Chrome or Edge, or point PLAYWRIGHT_EXECUTABLE_PATH or CHROME_PATH at an executable.',
		)
	}
	return found
}

/**
 * Resolves this workspace's built core entry, or throws naming the build that produces it.
 *
 * @param root - The workspace root holding `dist`; defaults to {@link WORKSPACE_ROOT}
 * @returns The absolute path of the built core entry the page's import map serves
 * @throws Thrown when the built core entry is absent.
 * @remarks The page's direct-daemon case imports `@orkestrel/ollama` from this workspace's
 * own build rather than from an installed copy, so an unbuilt tree would fail as a module
 * that does not resolve rather than as the missing build it is.
 */
export function requireBuild(root: URL | string = WORKSPACE_ROOT): string {
	const path = join(rootToPath(root), 'dist', 'src', 'core', 'index.js')
	if (!existsSync(path)) {
		throw new Error(
			`The page proof serves this workspace's built core entry and found none at ${path}; run npm run build`,
		)
	}
	return path
}

/**
 * Checks that the daemon answers a cross-origin preflight for the page's own origin.
 *
 * @param origin - The page origin the daemon must permit, such as `http://127.0.0.1:54321`
 * @throws Thrown when the preflight cannot be made, is refused, or permits another origin.
 * @remarks The relay case never needs this, because the page and the relay share one origin.
 * The direct case does: the page dials the daemon from an ephemeral loopback origin, so the
 * browser sends an `OPTIONS` preflight first and the daemon decides it. A host where that
 * preflight fails is a host where the guide's direct-daemon claim is false, so the failure is
 * a throw naming `OLLAMA_ORIGINS` rather than a skip.
 */
export async function requireDaemonOrigin(origin: string): Promise<void> {
	const url = `${OLLAMA_CONFIG.host}${OLLAMA_CHAT_PATH}`
	let response: Response
	try {
		response = await fetch(url, {
			method: 'OPTIONS',
			headers: {
				origin,
				'access-control-request-method': 'POST',
				'access-control-request-headers': 'content-type',
			},
			signal: AbortSignal.timeout(10_000),
		})
	} catch (error) {
		throw new Error(
			`The page proof could not preflight ${url} for origin ${origin} (${String(error)}); start the daemon`,
			{ cause: error },
		)
	}
	const allowed = response.headers.get('access-control-allow-origin')
	if (!response.ok || (allowed !== origin && allowed !== '*')) {
		throw new Error(
			`The Ollama daemon at ${OLLAMA_CONFIG.host} refuses the page origin ${origin} ` +
				`(status ${String(response.status)}, access-control-allow-origin ${String(allowed)}); ` +
				'set OLLAMA_ORIGINS to include that origin and restart the daemon',
		)
	}
}

if (!(await isOllamaReady())) {
	throw new Error(
		`Ollama service tests require ${OLLAMA_CONFIG.model} at ${OLLAMA_CONFIG.host}; start the daemon and pull the model`,
	)
}
await warmOllama()
