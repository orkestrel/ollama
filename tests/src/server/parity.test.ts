// Compile-time-only gate against the official `ollama` client's wire types. A red
// here means the Ollama wire contract moved — do NOT loosen these assertions to
// make it pass. The failing gate is `npm run check` (root tsc); the vitest
// runtime pass here is incidental — `expectTypeOf` is a no-op at runtime.

import { describe, expectTypeOf, it } from 'vitest'
import type { WireChatRequest } from '@src/server'
import type { ChatRequest, ChatResponse, Message, Tool, ToolCall } from 'ollama'

describe('official ollama type parity (compile-time gate)', () => {
	// --- Request-send parity ---------------------------------------------------
	// We assert the SUBSET we SEND is compatible with the official ChatRequest's
	// corresponding field — not full equality, so official additions we ignore
	// don't false-fail. If an official key we rely on is renamed/removed, the
	// index access itself fails tsc, which is the intended drift signal.

	it('model field we send is accepted by the official ChatRequest type', () => {
		expectTypeOf<WireChatRequest['model']>().toExtend<ChatRequest['model']>()
	})

	// Compared field-by-field (rather than whole-object assignability) because our
	// `messages` elements use `readonly`/`ReadonlyArray` throughout while the
	// official `Message`'s array fields are mutable — a readonly array is never
	// assignable to a mutable one, which is a variance artifact, not real drift.
	type WireMessage = WireChatRequest['messages'][number]

	it('message shape we send is accepted by the official Message type', () => {
		expectTypeOf<WireMessage['role']>().toExtend<Message['role']>()
		expectTypeOf<WireMessage['content']>().toExtend<Message['content']>()
	})

	it('tool_calls shape we send is accepted by the official Message type', () => {
		expectTypeOf<NonNullable<WireMessage['tool_calls']>[number]['function']['name']>().toExtend<
			NonNullable<Message['tool_calls']>[number]['function']['name']
		>()
		expectTypeOf<
			NonNullable<WireMessage['tool_calls']>[number]['function']['arguments']
		>().toExtend<NonNullable<Message['tool_calls']>[number]['function']['arguments']>()
	})

	it('image shape we send is accepted by the official Message type', () => {
		expectTypeOf<NonNullable<WireMessage['images']>[number]>().toExtend<
			NonNullable<Message['images']>[number]
		>()
	})

	it('stream flag we send is accepted by the official ChatRequest type', () => {
		expectTypeOf<WireChatRequest['stream']>().toExtend<Required<ChatRequest>['stream']>()
	})

	it('keep_alive we send is accepted by the official ChatRequest type', () => {
		expectTypeOf<WireChatRequest['keep_alive']>().toExtend<Required<ChatRequest>['keep_alive']>()
	})

	it('think flag we send is a boolean, matching the official contract', () => {
		expectTypeOf<WireChatRequest['think']>().toExtend<boolean>()
	})

	// `options` is an intentionally opaque passthrough bag (see types.ts) — a
	// nominal `Options` interface can never structurally satisfy a
	// `Record<string, unknown>` target, so the meaningful direction here is that
	// whatever the official `Partial<Options>` shape allows still fits our opaque
	// bag; the index access on `ChatRequest['options']` still gates a
	// renamed/removed official field.
	it('options bag we send accepts whatever the official ChatRequest options allow', () => {
		expectTypeOf<Required<ChatRequest>['options']>().toExtend<Readonly<Record<string, unknown>>>()
	})

	it('tools we send are accepted by the official Tool type', () => {
		expectTypeOf<Required<WireChatRequest>['tools'][number]>().toExtend<Tool>()
	})

	it('format (structured-output schema) we send is accepted by the official ChatRequest type', () => {
		expectTypeOf<WireChatRequest['format']>().toExtend<ChatRequest['format']>()
	})

	// --- Response-read parity ---------------------------------------------------
	// Every field our provider READS via @orkestrel/contract guards on `unknown`,
	// declared locally here (there is no src type for it) and checked against the
	// official ChatResponse/Message/ToolCall shapes as currently installed.

	interface ReadChatResponse {
		readonly message: {
			readonly content: string
			readonly thinking?: string
			readonly tool_calls?: ReadonlyArray<{
				readonly function: { readonly name: string; readonly arguments: unknown }
				readonly id?: string
			}>
		}
		readonly done: boolean
		readonly prompt_eval_count: number
		readonly eval_count: number
	}

	// Read-side direction throughout: the runtime value actually IS the official
	// shape, so the gate is that the official field is assignable INTO our
	// declared read type (a renamed/removed/incompatible official field fails the
	// index access or the assignability check).

	it('response content we read is accepted by our declared read type', () => {
		expectTypeOf<ChatResponse['message']['content']>().toExtend<
			ReadChatResponse['message']['content']
		>()
	})

	it('response thinking field we read is accepted by our declared read type', () => {
		expectTypeOf<Required<Message>['thinking']>().toExtend<
			Required<ReadChatResponse['message']>['thinking']
		>()
	})

	it('response tool_call name we read is accepted by our declared read type', () => {
		expectTypeOf<ToolCall['function']['name']>().toExtend<
			Required<ReadChatResponse['message']>['tool_calls'][number]['function']['name']
		>()
	})

	// The provider reads `arguments` as `unknown` and narrows it via
	// `@orkestrel/contract` guards at runtime — the safe compile-time direction is
	// that whatever the official (loosely-typed) response actually contains is
	// assignable into our conservative `unknown` read type, not the reverse.
	it('response tool_call arguments we read is accepted by our declared read type', () => {
		expectTypeOf<ToolCall['function']['arguments']>().toExtend<
			Required<ReadChatResponse['message']>['tool_calls'][number]['function']['arguments']
		>()
	})

	it('response done flag we read is accepted by our declared read type', () => {
		expectTypeOf<ChatResponse['done']>().toExtend<ReadChatResponse['done']>()
	})

	it('response prompt_eval_count we read is accepted by our declared read type', () => {
		expectTypeOf<ChatResponse['prompt_eval_count']>().toExtend<
			ReadChatResponse['prompt_eval_count']
		>()
	})

	it('response eval_count we read is accepted by our declared read type', () => {
		expectTypeOf<ChatResponse['eval_count']>().toExtend<ReadChatResponse['eval_count']>()
	})
})
