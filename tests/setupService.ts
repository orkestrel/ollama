import type { ContextFormatInterface, MessageInterface } from '@orkestrel/agent'
import { isRecord, isString } from '@orkestrel/contract'
import { createOllama, OllamaProvider } from '@src/server'
import { env, withScheme } from './setupServer.js'

/** The live daemon and model selected for the service axis. */
export const OLLAMA_CONFIG = Object.freeze({
	host: withScheme(env('OLLAMA_HOST', 'http://localhost:11434')),
	model: env('OLLAMA_MODEL', 'qwen3.5:2b-q4_K_M'),
})

/** Tuning for a live Ollama test provider. */
export interface LiveProviderOptions {
	/** The Ollama `num_predict` cap; defaults to `32`. */
	readonly predict?: number
	/** The sampling temperature; defaults to `0` for reproducible fixtures. */
	readonly temperature?: number
	/** The provider's context-framing default; omission leaves framing undefined. */
	readonly format?: ContextFormatInterface
}

/**
 * Build a concrete provider against the selected live daemon and warmed model.
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
 * Build a live summarizer for conversation-compaction scenarios.
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
): (messages: readonly MessageInterface[]) => Promise<string> {
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
 * Check that the daemon answers and reports the selected model as installed.
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
 * Warm the selected model with a one-token chat request.
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

/** Content and usage round-trips. */
export const FAST_OPTIONS = Object.freeze({ num_predict: 8, temperature: 0 })

/** Multi-delta streaming round-trips. */
export const STREAM_OPTIONS = Object.freeze({ num_predict: 16, temperature: 0 })

/** Tool-call round-trips. */
export const TOOL_OPTIONS = Object.freeze({ num_predict: 32, temperature: 0 })

/** Mid-stream abort and deadline round-trips. */
export const ABORT_OPTIONS = Object.freeze({ num_predict: 64, temperature: 0 })

/** Seeded deterministic round-trips. */
export const SEED_OPTIONS = Object.freeze({ num_predict: 8, temperature: 0, seed: 42 })

/** Native-thinking round-trips. */
export const THINK_OPTIONS = Object.freeze({ num_predict: 8, temperature: 0 })

/** Default maximum attempts for bounded model-behavior retries. */
export const ATTEMPTS = 6

/**
 * Retry a live scenario until its semantic condition is satisfied.
 *
 * @typeParam T - The value produced by each attempt
 * @param produce - Execute one live attempt
 * @param satisfied - Decide whether an attempt proves the requested behavior
 * @param description - Describe the behavior in the terminal failure
 * @param attempts - Maximum attempts; defaults to {@link ATTEMPTS}
 * @returns The first value satisfying the condition
 */
export async function retryUntil<T>(
	produce: () => Promise<T>,
	satisfied: (value: T) => boolean,
	description: string,
	attempts = ATTEMPTS,
): Promise<T> {
	let last: T | undefined
	for (let n = 0; n < attempts; n += 1) {
		const value = await produce()
		if (satisfied(value)) return value
		last = value
	}
	throw new Error(
		`model did not ${description} in ${attempts} attempts (final value: ${JSON.stringify(last)})`,
	)
}

/** Two-turn tool-loop request recipe. */
export const TOOL_LOOP_OPTIONS = Object.freeze({ num_predict: 64, temperature: 0 })

if (!(await isOllamaReady())) {
	throw new Error(
		`Ollama service tests require ${OLLAMA_CONFIG.model} at ${OLLAMA_CONFIG.host}; start the daemon and pull the model`,
	)
}
await warmOllama()
