import type {
	AgentProviderInterface,
	ProviderIncrement,
	ProviderParserInterface,
	ProviderRequest,
} from '@orkestrel/agent'
import type { OllamaOptions, WireChatRequest } from './types.js'
import { AgentProvider } from '@orkestrel/agent'
import { createNDJSONParser } from '@orkestrel/ndjson'
import { DEFAULT_KEEP_ALIVE, DEFAULT_OLLAMA_URL, OLLAMA_CHAT_PATH } from './constants.js'
import {
	extractContent,
	extractThinking,
	extractTools,
	extractTruncated,
	extractUsage,
	mapMessages,
} from './helpers.js'

/**
 * Implements the Ollama `/api/chat` wire over the shared {@link AgentProvider} engine.
 *
 * @remarks
 * Every request uses NDJSON streaming. The base assembles complete turns, separates
 * reasoning, and bounds requests; this class supplies Ollama framing and projections.
 * Usage comes only from a `done: true` record carrying the token counts. The `done: true`
 * record's `done_reason: 'length'` becomes `truncated: true`.
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
	readonly #truncate: boolean | undefined
	readonly #shift: boolean | undefined

	constructor(options: OllamaOptions) {
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
		this.#truncate = options.truncate
		this.#shift = options.shift
	}

	/**
	 * Creates fresh NDJSON framing state for a call.
	 *
	 * @returns The parser that buffers incomplete Ollama records
	 */
	frame(): ProviderParserInterface {
		return createNDJSONParser()
	}

	/**
	 * Projects conversation turns and per-call options onto the Ollama request body.
	 *
	 * @remarks
	 * A tool's `title` and `annotations` are never sent: the `/api/chat` tool function
	 * object carries no field for either. `truncate` and `shift` follow `tools` and appear only
	 * when the constructor option is set, so `false` survives and omission leaves the body unchanged.
	 *
	 * @param request - The conversation, advertised tools, and per-call overrides
	 * @returns The `/api/chat` body with streaming enabled
	 */
	encode(request: ProviderRequest): WireChatRequest {
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
			...(this.#truncate !== undefined ? { truncate: this.#truncate } : {}),
			...(this.#shift !== undefined ? { shift: this.#shift } : {}),
		}
	}

	/**
	 * Extracts a record's content, reasoning, tools, completed usage report, and truncation.
	 *
	 * @param record - One parsed Ollama NDJSON record
	 * @returns The turn increment, omitting usage and truncation until `done`
	 */
	read(record: Readonly<Record<string, unknown>>): ProviderIncrement {
		const done = Reflect.get(record, 'done') === true
		const usage = done ? extractUsage(record) : undefined
		const truncated = done ? extractTruncated(record) : undefined
		return {
			content: extractContent(record),
			thinking: extractThinking(record),
			tools: extractTools(record),
			...(usage === undefined ? {} : { usage }),
			...(truncated === undefined ? {} : { truncated }),
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
