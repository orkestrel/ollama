import type { AgentResult, Message, ProviderInterface } from '@orkestrel/agent'
import type { BrowserJourney, BrowserPageInterface, BrowserRun } from '@orkestrel/browser'
import type { TokenUsage } from '@orkestrel/budget'
import type { ToolManagerInterface } from '@orkestrel/tool'

/** Represents one product the store fixture sells. */
export interface StoreProduct {
	/** The path segment of the product's page, such as `p4`. */
	readonly id: string
	/** The name every page shows for the product. */
	readonly name: string
	/** The price with its currency sign, such as `$58.00`. */
	readonly price: string
	/** The sentence the catalogue and the product page show under the name. */
	readonly blurb: string
	/** True if the catalogue lists the product; false if only a search finds it. */
	readonly featured: boolean
}

/** Represents a running store fixture and the state its pages changed. */
export interface StoreServerInterface {
	/** The loopback origin the store answers on, such as `http://127.0.0.1:54321`. */
	readonly url: string
	/** Returns the names of the products added to the cart, in the order they were added. */
	readCart(): readonly string[]
	/** Returns every query the search form submitted, in submission order. */
	readSearches(): readonly string[]
	/** Returns the name every checkout submitted, in submission order. */
	readOrders(): readonly string[]
	/** Stops the server and releases its port. */
	stop(): Promise<void>
}

/** Represents one tool call a store run dispatched, as the transcript records it. */
export interface StoreCall {
	/** The called tool's name. */
	readonly name: string
	/** The arguments the model supplied. */
	readonly arguments: Readonly<Record<string, unknown>>
	/** True if the tool returned a value; false if it failed. */
	readonly success: boolean
	/** The result text the model received, or the failure's message. */
	readonly text: string
}

/** Records an operation's monotonic start and end in milliseconds. */
export interface StoreTiming {
	readonly operation: 'seed' | 'generation' | 'tool' | 'reload'
	readonly name: string
	readonly start: number
	readonly end: number
}

/** Represents one conversation message as the transcript records it: the message and its thinking. */
export interface StoreMessage extends Message {
	/** The reasoning the provider separated from the answer; absent when the turn surfaced none. */
	readonly thinking?: string
}

/** Represents the record one store run leaves, which the proof's assertions read. */
export interface StoreTranscript {
	/** The task's name, which also names the transcript file. */
	readonly task: string
	/** The attempt number, counted from 1. */
	readonly attempt: number
	/** The system prompt the agent ran with. */
	readonly system: string
	/** The `read` result the first user turn carries. */
	readonly seed: string
	/** The task the first user turn states. */
	readonly prompt: string
	/** Every conversation message after the run, in order; an assistant message carries its turn's thinking. */
	readonly messages: readonly StoreMessage[]
	/** Every tool call the run dispatched, in order, with its result text. */
	readonly calls: readonly StoreCall[]
	/** The run's final answer. */
	readonly answer: string
	/** True if a deadline or limit cut the run short; false otherwise. */
	readonly partial: boolean
	/** The token usage summed over the run's provider calls, when the provider reported it. */
	readonly usage: TokenUsage | undefined
	/** The token usage each provider call reported, in turn order. */
	readonly turns: readonly TokenUsage[]
	/** The run's wall time in milliseconds, from the seeded `read` to the final answer. */
	readonly elapsed: number
	/** What the store recorded when the run ended: the cart, the searches, and the orders. */
	readonly state: StoreState
	/** The message of the error that ended the run early, such as a provider error; absent otherwise. */
	readonly failure: string | undefined
	/**
	 * True if the final answer contains the task's `mention`, false if it does not; absent for a
	 * task with no `mention`. The proof records it and never asserts it.
	 */
	readonly mentioned: boolean | undefined
	/** The monotonic intervals around the seed, generations, and tool calls. */
	readonly timings: readonly StoreTiming[]
	/** How many calls {@link findMalformedCalls} reads as malformed against the advertised tools. */
	readonly violations: number
	/** How many `record` and `save` calls {@link findJourneyLoops} reads as refused after a save. */
	readonly loops: number
	/** How many user turns reached `STORE_BOUNDS.refusals` and went on with no tool advertised. */
	readonly ended: number
	/** Each JSON file the journey stores wrote under the run's root, by its `/`-separated path. */
	readonly files: Readonly<Record<string, string>>
}

/** Represents what a store recorded by the end of one run. */
export interface StoreState {
	/** The names of the products in the cart, in the order they were added. */
	readonly cart: readonly string[]
	/** Every submitted query, in submission order. */
	readonly searches: readonly string[]
	/** Every name a checkout submitted, in submission order. */
	readonly orders: readonly string[]
}

/** Represents what {@link runStoreTask} takes. */
export interface StoreRunOptions {
	/** True to advertise and persist journeys; false or omitted for page tools alone. */
	readonly journeys?: boolean
	/** The task's name, which names the transcript file. */
	readonly task: string
	/** The text whose presence in the final answer the transcript notes; omitted ⇒ no note. */
	readonly mention?: string | undefined
	/** The attempt number, counted from 1. */
	readonly attempt: number
	/** The task the first user turn states. */
	readonly prompt: string
	/** The store path the page opens before the seeded `read`, such as `/`. */
	readonly path: string
	/** The model the agent runs. */
	readonly provider: ProviderInterface
	/** The page the toolset drives. */
	readonly page: BrowserPageInterface
	/** The store the page opens. */
	readonly store: StoreServerInterface
	/** The existing directory the journey stores keep their files under. */
	readonly root: string
	/** The system prompt; omitted ⇒ {@link STORE_SYSTEM_PROMPT}. */
	readonly system?: string | undefined
	/** The user turns after the first, each sent when the model ends the previous one; omitted ⇒ none. */
	readonly followups?: readonly StoreTurn[] | undefined
}

/** Builds a user turn from the calls a run made so far. */
export type StoreTurnFunction = (calls: readonly StoreCall[]) => string

/** Represents one user turn: its text, or a function of the calls made so far that returns it. */
export type StoreTurn = string | StoreTurnFunction

/** Represents what {@link converseStore} takes. */
export interface StoreConversationOptions {
	/** The model the agent runs. */
	readonly provider: ProviderInterface
	/** The system prompt the agent runs with. */
	readonly system: string
	/** The tools the agent advertises and dispatches. */
	readonly tools: ToolManagerInterface
	/** The user turns, in order, each sent when the model ends the previous one. */
	readonly turns: readonly StoreTurn[]
}

/** Represents what one store conversation leaves. */
export interface StoreConversation {
	/** The monotonic generation and tool intervals. */
	readonly timings: readonly StoreTiming[]
	/** Every conversation message, in order; an assistant message carries its turn's thinking. */
	readonly messages: readonly StoreMessage[]
	/** Every tool call the agent dispatched, in order, with its result text. */
	readonly calls: readonly StoreCall[]
	/** The token usage each provider call reported, in turn order. */
	readonly usages: readonly TokenUsage[]
	/** The last user turn's result; `undefined` when a user turn ended with an error. */
	readonly result: AgentResult | undefined
	/** True if a deadline or the turn limit cut a user turn short; false otherwise. */
	readonly partial: boolean
	/** How many user turns reached `STORE_BOUNDS.refusals` and went on with no tool advertised. */
	readonly ended: number
	/** The error a user turn ended with; `undefined` when every user turn settled. */
	readonly failure: unknown
}

/** Represents one live store task: the transcript name, the prompt, and the start path. */
export interface StoreTask {
	/** True to advertise journeys; false or omitted for page tools alone. */
	readonly journeys?: boolean
	/** The name the transcript files carry. */
	readonly task: string
	/** The task the first user turn states. */
	readonly prompt: string
	/** The store path the page opens first. */
	readonly path: string
	/** The text whose presence in the final answer the transcript notes; omitted ⇒ no note. */
	readonly mention?: string | undefined
	/** The system prompt; omitted ⇒ {@link STORE_SYSTEM_PROMPT}. */
	readonly system?: string | undefined
	/** The user turns after the first, each sent when the model ends the previous one; omitted ⇒ none. */
	readonly followups?: readonly StoreTurn[] | undefined
}

/** Represents one finished attempt: its transcript and the store it ran against, stopped. */
export interface StoreAttempt {
	/** The attempt's transcript. */
	readonly transcript: StoreTranscript
	/** The store the attempt ran against, whose readers still answer after it stopped. */
	readonly store: StoreServerInterface
}

/** Represents the journey one run saved and the runs of it, as the file stores wrote them. */
export interface StoreJourneyEvidence {
	/** The journey's name, which is its directory under the root. */
	readonly name: string
	/** The revision `journey.json` carries. */
	readonly revision: number | undefined
	/** The journey `journey.json` carries. */
	readonly journey: BrowserJourney
	/** Each `runs/<id>/run.json` of the journey that parses as a run, in path order. */
	readonly runs: readonly BrowserRun[]
}
