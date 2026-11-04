import type {
	AgentProviderInterface,
	Message,
	ProviderDelta,
	ProviderIncrement,
	ProviderParserInterface,
	ProviderRequest,
	ProviderResult,
	ProviderStreamOptions,
} from '@orkestrel/agent'
import type { ToolDefinition } from '@orkestrel/tool'
import type { OllamaOptions, WireChatRequest } from './types.js'
import { AgentProvider, isProviderError, ProviderError } from '@orkestrel/agent'
import { preview } from '@orkestrel/contract'
import { createNDJSONParser } from '@orkestrel/ndjson'
import { describeFaults } from '@orkestrel/tool'
import {
	DEFAULT_KEEP_ALIVE,
	DEFAULT_OLLAMA_URL,
	OLLAMA_CHAT_PATH,
	OLLAMA_CONTEXT_REMEDY,
} from './constants.js'
import { ollamaOptionsContract } from './contracts.js'
import {
	extractContent,
	extractThinking,
	extractTools,
	extractTruncated,
	extractUsage,
	mapMessages,
	matchesContextRefusal,
	renderDaemonFailure,
	scanOptionFaults,
} from './helpers.js'

/**
 * Implements the Ollama `/api/chat` wire over the shared {@link AgentProvider} engine.
 *
 * @remarks
 * Every request uses NDJSON streaming. The base assembles complete turns, separates
 * reasoning, and bounds requests; this class supplies Ollama framing and projections.
 * Usage comes only from a `done: true` record carrying the token counts. The `done: true`
 * record's `done_reason: 'length'` becomes `truncated: true`. Every body sends `truncate`, `false`
 * by default, so a prompt over the context window refuses instead of losing its earlier turns.
 * The constructor refuses malformed options with code `PROTOCOL`, listing every fault.
 *
 * @example
 * ```ts
 * const provider = new OllamaProvider({ model: 'qwen3.5:2b-q4_K_M' })
 * const result = await provider.generate(messages, abort.signal)
 * ```
 */
export class OllamaProvider extends AgentProvider implements AgentProviderInterface {
	readonly name = 'ollama'
	readonly #model: string
	readonly #keepAlive: string | number
	readonly #think: boolean
	readonly #options: Readonly<Record<string, unknown>> | undefined
	readonly #truncate: boolean
	readonly #shift: boolean | undefined

	constructor(options: OllamaOptions) {
		const faults = scanOptionFaults(ollamaOptionsContract, options, ['fetch', 'headers'])
		if (faults.length > 0)
			throw new ProviderError(
				'PROTOCOL',
				`provider error: refused options\n${describeFaults(faults, ollamaOptionsContract.schema)}`,
				{ cause: { faults } },
			)
		super({
			url: options.url ?? DEFAULT_OLLAMA_URL,
			path: OLLAMA_CHAT_PATH,
			...(options.timeout === undefined ? {} : { timeout: options.timeout }),
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
			...(options.headers === undefined ? {} : { headers: options.headers }),
			...(options.replay === undefined ? {} : { replay: options.replay }),
		})
		this.#model = options.model
		this.#keepAlive = options.keepAlive ?? DEFAULT_KEEP_ALIVE
		this.#think = options.think ?? false
		this.#options = options.options
		this.#truncate = options.truncate ?? false
		this.#shift = options.shift
	}

	/**
	 * Streams a turn, naming the remedy when the daemon refuses a prompt over its context window.
	 *
	 * @param messages - The conversation turns
	 * @param signal - The caller's cancellation bound
	 * @param tools - The advertised tool definitions
	 * @param options - The per-call generation configuration
	 * @returns Content and native thinking deltas followed by the settled result
	 * @throws ProviderError Thrown with code `HTTP` and status 400, its text naming `window`, `num_ctx`, and `truncate`, when the daemon's refusal names the context window
	 */
	override async *stream(
		messages: readonly Message[],
		signal: AbortSignal,
		tools?: readonly ToolDefinition[],
		options?: ProviderStreamOptions,
	): AsyncGenerator<ProviderDelta, ProviderResult> {
		try {
			return yield* super.stream(messages, signal, tools, options)
		} catch (error) {
			if (
				isProviderError(error) &&
				error.code === 'HTTP' &&
				error.status === 400 &&
				matchesContextRefusal(error.message)
			)
				throw new ProviderError('HTTP', `${error.message}; ${OLLAMA_CONTEXT_REMEDY}`, {
					status: 400,
					cause: error,
				})
			throw error
		}
	}

	/**
	 * Creates fresh NDJSON framing state for a call.
	 *
	 * @returns The strict parser that buffers incomplete Ollama records and refuses a line that is not a JSON object
	 */
	frame(): ProviderParserInterface {
		return createNDJSONParser({ strict: true })
	}

	/**
	 * Projects conversation turns and per-call options onto the Ollama request body.
	 *
	 * @remarks
	 * A tool's `title` and `annotations` are never sent: the `/api/chat` tool function
	 * object carries no field for either. `truncate` follows `tools` on every body, and `shift` follows
	 * it only when the constructor option is set.
	 *
	 * @param request - The conversation, advertised tools, and per-call overrides
	 * @returns The `/api/chat` body with streaming enabled
	 * @throws ProviderError Thrown with code `PROTOCOL` for empty `messages`, which Ollama 0.40.14 answers with a model load and no turn
	 */
	encode(request: ProviderRequest): WireChatRequest {
		if (request.messages.length === 0)
			throw new ProviderError(
				'PROTOCOL',
				'provider error: messages is empty, and the daemon answers that with a model load and no turn; pass at least one message',
			)
		return {
			model: this.#model,
			messages: mapMessages(request.messages),
			stream: true,
			keep_alive: this.#keepAlive,
			think: request.options?.think ?? this.#think,
			...(this.#options !== undefined ? { options: this.#options } : {}),
			...(request.options?.schema !== undefined ? { format: request.options.schema } : {}),
			...(request.tools !== undefined && request.tools.length > 0
				? {
						tools: request.tools.map((tool): NonNullable<WireChatRequest['tools']>[number] => ({
							type: 'function',
							function: {
								name: tool.name,
								...(tool.description === undefined ? {} : { description: tool.description }),
								...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
							},
						})),
					}
				: {}),
			truncate: this.#truncate,
			...(this.#shift !== undefined ? { shift: this.#shift } : {}),
		}
	}

	/**
	 * Extracts a record's content, reasoning, tools, completed usage report, and truncation.
	 *
	 * @param record - One parsed Ollama NDJSON record
	 * @returns The turn increment, omitting usage, truncation, and the terminal mark until `done`
	 * @throws ProviderError Thrown with code `PROTOCOL` for an in-band `error`, a `model` other than the configured tag, a `done_reason` of `load`, or a malformed field
	 */
	read(record: Readonly<Record<string, unknown>>): ProviderIncrement {
		const failure = Reflect.get(record, 'error')
		if (failure !== undefined)
			throw new ProviderError(
				'PROTOCOL',
				`provider error: the daemon reported ${renderDaemonFailure(failure)}`,
			)
		const model = Reflect.get(record, 'model')
		if (model !== undefined && model !== this.#model)
			throw new ProviderError(
				'PROTOCOL',
				`provider error: the daemon answered for model ${preview(model)} and this provider names ${preview(this.#model)}; set model to the tag the daemon serves`,
			)
		const done = Reflect.get(record, 'done') === true
		if (done && Reflect.get(record, 'done_reason') === 'load')
			throw new ProviderError(
				'PROTOCOL',
				"provider error: the daemon reported done_reason 'load', a model load with no turn; send at least one message",
			)
		const usage = done ? extractUsage(record) : undefined
		const truncated = done ? extractTruncated(record) : undefined
		return {
			content: extractContent(record),
			thinking: extractThinking(record),
			tools: extractTools(record),
			...(usage === undefined ? {} : { usage }),
			...(truncated === undefined ? {} : { truncated }),
			...(done ? { done } : {}),
		}
	}

	/**
	 * Recovers a final NDJSON record that arrived without its line terminator.
	 *
	 * @param parser - The call's parser holding any unterminated input
	 * @returns The records completed by the final newline
	 */
	finish(parser: ProviderParserInterface): ReadonlyArray<Readonly<Record<string, unknown>>> {
		return parser.parse('\n')
	}
}
