// The Ollama wire leaves — the request projections and the response extractions
// `OllamaProvider` composes. Each is a pure, total function of its parameters: a missing
// or malformed wire field degrades to a sensible default (empty content, no usage, `{}`
// arguments), never a throw, and no value is reached through `as`.

import type { Message, ProviderResult, ThinkSplitterInterface } from '@orkestrel/agent'
import type { TokenUsage } from '@orkestrel/budget'
import type { ToolCall } from '@orkestrel/tool'
import type { WireChatRequest } from './types.js'
import { isNumber, isRecord, isString, parseJSONAs } from '@orkestrel/contract'

/**
 * Maps conversation turns onto the `/api/chat` wire's minimal message shape.
 *
 * @remarks
 * `tool_calls` is emitted only on a turn that replays them and `images` only on a
 * multimodal turn, so an empty optional never reaches the wire.
 *
 * @param messages - The conversation turns to send
 * @returns The wire `messages` array, one entry per turn, in order
 *
 * @example
 * ```ts
 * mapMessages([{ id: '1', role: 'user', content: 'Say hello.' }])
 * // [{ role: 'user', content: 'Say hello.' }]
 * ```
 */
export function mapMessages(messages: readonly Message[]): WireChatRequest['messages'] {
	return messages.map((message) => ({
		role: message.role,
		content: message.content,
		...(message.calls !== undefined && message.calls.length > 0
			? {
					tool_calls: message.calls.map((call) => ({
						function: { name: call.name, arguments: call.arguments },
					})),
				}
			: {}),
		// Forward multimodal image data — Ollama accepts a base64 `images` array on a
		// message, which a vision-capable model receives alongside the text content.
		...(message.images !== undefined && message.images.length > 0
			? { images: [...message.images] }
			: {}),
	}))
}

/**
 * Builds a provider result from a turn's content, reasoning, tool calls, and usage.
 *
 * @remarks
 * Only the present optionals are set: no empty `thinking`, no empty `tools`, and no
 * `usage` unless the wire reported one.
 *
 * @param content - The clean assistant content the splitter accumulated
 * @param thinking - The joined reasoning, empty when the turn produced none
 * @param tools - The tool calls collected across the turn
 * @param usage - The token usage, or `undefined` when the wire reported none
 * @returns The result carrying only its populated fields
 *
 * @example
 * ```ts
 * buildResult('ok', '', [], undefined) // { content: 'ok' }
 * ```
 */
export function buildResult(
	content: string,
	thinking: string,
	tools: readonly ToolCall[],
	usage: TokenUsage | undefined,
): ProviderResult {
	const result: {
		content: string
		thinking?: string
		tools?: readonly ToolCall[]
		usage?: TokenUsage
	} = { content }
	if (thinking.length > 0) result.thinking = thinking
	if (tools.length > 0) result.tools = tools
	if (usage !== undefined) result.usage = usage
	return result
}

/**
 * Extracts the assistant text of one wire record.
 *
 * @param record - One parsed `/api/chat` record — a non-stream body or an NDJSON line
 * @returns The record's `message.content` when it is a string, else `''`
 *
 * @example
 * ```ts
 * extractContent({ message: { content: 'ok' } }) // 'ok'
 * ```
 */
export function extractContent(record: Readonly<Record<string, unknown>>): string {
	const message = Reflect.get(record, 'message')
	if (!isRecord(message)) return ''
	const content = Reflect.get(message, 'content')
	return isString(content) ? content : ''
}

/**
 * Extracts the daemon-side reasoning of one wire record.
 *
 * @remarks
 * `message.thinking` is the `think: true` wire shape. It is read whatever the configured
 * flag says, because a daemon may separate reasoning on its own.
 *
 * @param record - One parsed `/api/chat` record — a non-stream body or an NDJSON line
 * @returns The record's `message.thinking` when it is a string, else `''`
 *
 * @example
 * ```ts
 * extractThinking({ message: { thinking: 'weighing it' } }) // 'weighing it'
 * ```
 */
export function extractThinking(record: Readonly<Record<string, unknown>>): string {
	const message = Reflect.get(record, 'message')
	if (!isRecord(message)) return ''
	const thinking = Reflect.get(message, 'thinking')
	return isString(thinking) ? thinking : ''
}

/**
 * Joins a call's two reasoning carriers into the result's `thinking`.
 *
 * @param splitter - The per-call splitter holding the separated in-content spans
 * @param wired - The accumulated wire-side `message.thinking` text
 * @returns The two carriers separated by a blank line, or whichever one is non-empty
 *
 * @example
 * ```ts
 * joinThinking(createThinkSplitter(), 'from the wire') // 'from the wire'
 * ```
 */
export function joinThinking(splitter: ThinkSplitterInterface, wired: string): string {
	if (splitter.thinking.length === 0) return wired
	if (wired.length === 0) return splitter.thinking
	return `${splitter.thinking}\n\n${wired}`
}

/**
 * Extracts the token usage of one wire record.
 *
 * @remarks
 * Both counts must be numbers, which is true of the non-stream body and the stream's
 * `done: true` line. A delta line carries neither, so it yields `undefined`.
 *
 * @param record - One parsed `/api/chat` record — a non-stream body or an NDJSON line
 * @returns The `TokenUsage` shape, or `undefined` when either count is absent
 *
 * @example
 * ```ts
 * extractUsage({ prompt_eval_count: 3, eval_count: 4 })
 * // { prompt: 3, completion: 4, total: 7 }
 * ```
 */
export function extractUsage(record: Readonly<Record<string, unknown>>): TokenUsage | undefined {
	const prompt = Reflect.get(record, 'prompt_eval_count')
	const completion = Reflect.get(record, 'eval_count')
	if (!isNumber(prompt) || !isNumber(completion)) return undefined
	return { prompt, completion, total: prompt + completion }
}

/**
 * Extracts the tool calls of one wire record's `message.tool_calls`.
 *
 * @remarks
 * Each entry narrows to `{ id, name, arguments }`: the entry and its `function` must be
 * records and `name` a string, else the entry is dropped. An id is minted when the wire
 * omits one.
 *
 * @param record - One parsed `/api/chat` record — a non-stream body or an NDJSON line
 * @returns The narrowed tool calls, empty when the record carries none
 *
 * @example
 * ```ts
 * extractTools({ message: { tool_calls: [{ function: { name: 'weather' } }] } })
 * // [{ id: '…', name: 'weather', arguments: {} }]
 * ```
 */
export function extractTools(record: Readonly<Record<string, unknown>>): readonly ToolCall[] {
	const message = Reflect.get(record, 'message')
	if (!isRecord(message)) return []
	const calls = Reflect.get(message, 'tool_calls')
	if (!Array.isArray(calls)) return []
	const out: ToolCall[] = []
	for (const entry of calls) {
		if (!isRecord(entry)) continue
		const callable = Reflect.get(entry, 'function')
		if (!isRecord(callable)) continue
		const name = Reflect.get(callable, 'name')
		if (!isString(name)) continue
		const id = Reflect.get(entry, 'id')
		out.push({
			id: isString(id) ? id : crypto.randomUUID(),
			name,
			arguments: extractArguments(Reflect.get(callable, 'arguments')),
		})
	}
	return out
}

/**
 * Extracts a wire `arguments` value as a record.
 *
 * @remarks
 * Total: an object passes through, a JSON string is parsed when it yields a record, and
 * a malformed string yields `{}` rather than throwing.
 *
 * @param value - The wire's `function.arguments` value, of unknown shape
 * @returns The argument record, or `{}` when the value carries none
 *
 * @example
 * ```ts
 * extractArguments('{"city":"Oslo"}') // { city: 'Oslo' }
 * ```
 */
export function extractArguments(value: unknown): Readonly<Record<string, unknown>> {
	if (isRecord(value)) return value
	if (isString(value)) return parseJSONAs(value, isRecord) ?? {}
	return {}
}
