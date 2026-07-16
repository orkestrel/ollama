// Compile-time-only gate against the official `ollama` client's wire types. A red
// here means the Ollama wire contract moved and OllamaProvider must be revisited —
// do NOT loosen these assertions to make it pass. This file is `.test-d.ts` on
// purpose: `npm run check` (root tsc, which includes `tests/`) type-checks it, but
// neither vitest project's `**/*.test.ts` glob matches it, so it never executes
// against a live daemon, and `src/` never imports `ollama` at runtime.

import type { WireChatRequest } from '@src/server'
import type { ChatRequest, ChatResponse, Message, Tool, ToolCall } from 'ollama'

type Expect<T extends true> = T
type Extends<A, B> = A extends B ? true : false

// --- Request-send parity -----------------------------------------------------
// We assert the SUBSET we SEND is compatible with the official ChatRequest's
// corresponding field — not full equality, so official additions we ignore don't
// false-fail. If an official key we rely on is renamed/removed, the index access
// itself fails tsc, which is the intended drift signal.

type _model = Expect<Extends<WireChatRequest['model'], ChatRequest['model']>>

// Compared field-by-field (rather than whole-object assignability) because our
// `messages` elements use `readonly`/`ReadonlyArray` throughout while the
// official `Message`'s array fields are mutable — a readonly array is never
// assignable to a mutable one, which is a variance artifact, not real drift.
type WireMessage = WireChatRequest['messages'][number]
type _msgRole = Expect<Extends<WireMessage['role'], Message['role']>>
type _msgContent = Expect<Extends<WireMessage['content'], Message['content']>>
type _msgToolCallName = Expect<
	Extends<
		NonNullable<WireMessage['tool_calls']>[number]['function']['name'],
		NonNullable<Message['tool_calls']>[number]['function']['name']
	>
>
type _msgToolCallArguments = Expect<
	Extends<
		NonNullable<WireMessage['tool_calls']>[number]['function']['arguments'],
		NonNullable<Message['tool_calls']>[number]['function']['arguments']
	>
>
type _msgImage = Expect<
	Extends<NonNullable<WireMessage['images']>[number], NonNullable<Message['images']>[number]>
>
type _stream = Expect<Extends<WireChatRequest['stream'], Required<ChatRequest>['stream']>>
type _keepAlive = Expect<
	Extends<WireChatRequest['keep_alive'], Required<ChatRequest>['keep_alive']>
>
type _think = Expect<Extends<WireChatRequest['think'], boolean>>
// `options` is an intentionally opaque passthrough bag (see types.ts) — a nominal
// `Options` interface can never structurally satisfy a `Record<string, unknown>`
// target, so the meaningful direction here is that whatever the official
// `Partial<Options>` shape allows still fits our opaque bag; the index access on
// `ChatRequest['options']` still gates a renamed/removed official field.
type _options = Expect<Extends<Required<ChatRequest>['options'], Readonly<Record<string, unknown>>>>
type _tools = Expect<Extends<Required<WireChatRequest>['tools'][number], Tool>>

// --- Response-read parity -----------------------------------------------------
// Every field our provider READS via @orkestrel/contract guards on `unknown`,
// declared locally here (there is no src type for it) and checked against the
// official ChatResponse/Message/ToolCall shapes as currently installed.

interface ReadChatResponse {
	readonly message: {
		readonly content: string
		readonly thinking?: string
		readonly tool_calls?: readonly {
			readonly function: { readonly name: string; readonly arguments: unknown }
			readonly id?: string
		}[]
	}
	readonly done: boolean
	readonly prompt_eval_count: number
	readonly eval_count: number
}

// Read-side direction throughout: the runtime value actually IS the official
// shape, so the gate is that the official field is assignable INTO our declared
// read type (a renamed/removed/incompatible official field fails the index
// access or the assignability check).
type _readContent = Expect<
	Extends<ChatResponse['message']['content'], ReadChatResponse['message']['content']>
>
type _readThinking = Expect<
	Extends<Required<Message>['thinking'], Required<ReadChatResponse['message']>['thinking']>
>
type _readToolCallName = Expect<
	Extends<
		ToolCall['function']['name'],
		Required<ReadChatResponse['message']>['tool_calls'][number]['function']['name']
	>
>
// The provider reads `arguments` as `unknown` and narrows it via
// `@orkestrel/contract` guards at runtime — the safe compile-time direction is
// that whatever the official (loosely-typed) response actually contains is
// assignable into our conservative `unknown` read type, not the reverse.
type _readToolCallArguments = Expect<
	Extends<
		ToolCall['function']['arguments'],
		Required<ReadChatResponse['message']>['tool_calls'][number]['function']['arguments']
	>
>
type _readDone = Expect<Extends<ChatResponse['done'], ReadChatResponse['done']>>
type _readPromptEvalCount = Expect<
	Extends<ChatResponse['prompt_eval_count'], ReadChatResponse['prompt_eval_count']>
>
type _readEvalCount = Expect<Extends<ChatResponse['eval_count'], ReadChatResponse['eval_count']>>
