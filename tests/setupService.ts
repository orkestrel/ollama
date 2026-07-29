import type {
	AgentResult,
	AgentStreamInterface,
	ContextFormatInterface,
	MessageInterface,
	ProviderInterface,
	ToolCall,
	ToolResult,
} from '@orkestrel/agent'
import type { TokenUsage } from '@orkestrel/budget'
import type { RecordingProxyInterface } from './setupServer.js'
import { isRecord, isString } from '@orkestrel/contract'
import { createOllama, OllamaProvider } from '@src/server'
import { createRecordingProxy as createServerRecordingProxy } from './setupServer.js'

/** Read a non-empty environment variable, or return its fallback. */
export function env(name: string, fallback: string): string {
	const value = process.env[name]
	return value !== undefined && value.length > 0 ? value : fallback
}

/** Normalize an Ollama-style host value to an absolute HTTP URL. */
export function withScheme(value: string): string {
	return value.startsWith('http://') || value.startsWith('https://') ? value : `http://${value}`
}

/** The live daemon and model selected for the service axis. */
export const OLLAMA_CONFIG = Object.freeze({
	host: withScheme(env('OLLAMA_HOST', 'http://localhost:11434')),
	model: env('OLLAMA_MODEL', 'qwen3.5:2b-q4_K_M'),
})

/** Tuning accepted by the live provider fixtures. */
export interface LiveProviderOptions {
	readonly predict?: number
	readonly temperature?: number
	readonly format?: ContextFormatInterface | undefined
}

/** Build a concrete provider against the selected live daemon and model. */
export function createLiveOllama(options?: LiveProviderOptions): OllamaProvider {
	return new OllamaProvider({
		model: OLLAMA_CONFIG.model,
		url: OLLAMA_CONFIG.host,
		options: { num_predict: options?.predict ?? 32, temperature: options?.temperature ?? 0 },
		format: options?.format,
	})
}

/** Build the abstract provider fixture used by live agent tests. */
export function createLiveProvider(options?: LiveProviderOptions): ProviderInterface {
	return createLiveOllama(options)
}

/** Start the recording proxy against the selected live daemon. */
export function createRecordingProxy(): Promise<RecordingProxyInterface> {
	return createServerRecordingProxy(OLLAMA_CONFIG.host)
}

/** Build a live summarizer for conversation-compaction scenarios. */
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

/** Return whether the daemon answers and reports the selected model as installed. */
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

/** Warm the selected model with the smallest useful chat request. */
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

/** Retry a live scenario until its semantic condition is satisfied. */
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

/** A driven tool-call chunk paired with its execution result. */
export interface DrivenTool {
	readonly call: ToolCall
	readonly result: ToolResult
}

/** Drain an agent stream and bucket every observable chunk. */
export async function driveAgent(stream: AgentStreamInterface): Promise<{
	readonly tokens: readonly string[]
	readonly thoughts: readonly string[]
	readonly tools: readonly DrivenTool[]
	readonly usages: readonly TokenUsage[]
	readonly result: AgentResult
}> {
	const tokens: string[] = []
	const thoughts: string[] = []
	const tools: DrivenTool[] = []
	const usages: TokenUsage[] = []
	for await (const chunk of stream.events) {
		if (chunk.type === 'token') tokens.push(chunk.content)
		else if (chunk.type === 'think') thoughts.push(chunk.content)
		else if (chunk.type === 'tool') tools.push({ call: chunk.call, result: chunk.result })
		else usages.push(chunk.usage)
	}
	const result = await stream.result
	return { tokens, thoughts, tools, usages, result }
}

/** Two-turn tool-loop request recipe. */
export const TOOL_LOOP_OPTIONS = Object.freeze({ num_predict: 64, temperature: 0 })

if (!(await isOllamaReady())) {
	throw new Error(
		`Ollama service tests require ${OLLAMA_CONFIG.model} at ${OLLAMA_CONFIG.host}; start the daemon and pull the model`,
	)
}
await warmOllama()
