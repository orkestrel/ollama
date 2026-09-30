# Browser

> A Chrome DevTools Protocol automation layer for Chromium-family browsers: an
> environment-agnostic core that drives pages, elements, and readings over an injected transport
> and publishes them as agent tools, an in-page face that drives a DOM document with native APIs,
> and a Node runtime that finds, launches, and connects to the browser itself.

The package has three faces, and each face has one import specifier.

- The core, `@orkestrel/browser`, compiles against `ESNext` and `WebWorker` with no DOM and no Node. `CDPClient` frames CDP messages over an injected `CDPTransportInterface`; `BrowserContext`, `BrowserPage`, and `BrowserFrame` model a browser context, its tabs, and their documents; `page.elements` outlines a page from its accessibility tree and acts on stable element references with trusted input; `frame.read()` captures a document as a `BrowserReadingInterface` value; `page.registry` mirrors the experimental `WebMCP` protocol domain; and `BrowserToolset` publishes all of it as `@orkestrel/tool` tools that an agent calls.
- The in-page face, `@orkestrel/browser/browser`, adds the DOM. `BrowserDOMView` drives a document with `HTMLElement.click()`, native value setters, `form.requestSubmit()`, and `MutationObserver`, and reports what an untrusted event cannot do. `createDocumentToolset` publishes the same vocabulary over that view, and `SocketCDPTransport` carries the core client over the browser's own `WebSocket`, so a worker or an extension page drives a browser over CDP.
- The Node runtime, `@orkestrel/browser/server`, adds `Browser`, which discovers a browser listening on a CDP port, attaches to it, or launches one and reads its endpoint from standard error; `WebSocketCDPTransport`; and a filesystem-backed browser writer.

The in-page face and the Node runtime each import the core, and neither imports the other. Source: [`src/core`](../src/core), [`src/browser`](../src/browser), and [`src/server`](../src/server).

## Surface

### Connect to a browser and drive a page

The following fence connects to a running browser or launches one, opens a page, and clicks an element the page's element manager finds.

```ts
import { createBrowser } from '@orkestrel/browser/server'

const browser = createBrowser({ headless: true })
await browser.connect() // CDP endpoint discovery → connect, else launch
const page = await browser.create({ url: 'https://example.com' })
await (await page.elements.find({ css: '#accept' }))[0]?.click()
const shot = await page.screenshot({ path: './out.png' })
await browser.destroy()
```

### Drive a page with a small model

The following fence registers the browser vocabulary in a tool manager and hands that manager to an `@orkestrel/agent` loop over a local model. The system prompt is the one the store proof in `@orkestrel/ollama` runs with, using `qwen3.5:2b-q4_K_M` at temperature 0; see [Drive a page with a small model](#drive-a-page-with-a-small-model-1) under Patterns for what each sentence of it does and which tasks it passed.

```ts
import { createAgent } from '@orkestrel/agent'
import { createBrowserToolset } from '@orkestrel/browser'
import { createBrowser } from '@orkestrel/browser/server'
import { createOllama } from '@orkestrel/ollama'
import { createToolManager } from '@orkestrel/tool'

const system =
	'You control a web browser with tools and must call a tool before you answer. ' +
	'The first message shows the page as look returns it; references such as e4 name its elements. ' +
	'To learn a fact, call read with what set to your question; when its result ends by naming an offset, call read again with that offset. ' +
	'To search, call type with the search box reference, the words, and submit true. ' +
	'To press a button or follow a link, call click with its reference from the latest result. Never invent a reference. ' +
	'If text you expect has not appeared, call wait once. ' +
	'When the task is done, answer in one short sentence.'

const browser = createBrowser({ headless: true })
await browser.connect()
const page = await browser.create({ url: 'https://shop.example.test/' })
const toolset = createBrowserToolset(page, { tools: createToolManager() })
await toolset.start()
toolset.tools.tools().map((tool) => tool.name) // ['look', 'read', 'click', 'type', 'press', 'navigate', 'wait']
const agent = createAgent(createOllama({ model: 'qwen3.5:2b-q4_K_M' }), {
	system,
	tools: toolset.tools,
})
agent.context.messages.add({ role: 'user', content: 'What does the Alpine Kettle cost?' })
const result = await agent.generate()
await toolset.destroy()
await browser.destroy()
```

### Core

The core runs wherever a `CDPTransportInterface` reaches a browser. The following fence drives the CDP client over an injected transport.

```ts
import { createCDPClient } from '@orkestrel/browser'

const client = createCDPClient({ transport }) // transport: CDPTransportInterface
await client.connect()
const targets = await client.send('Target.getTargets')
await client.close()
```

#### Factories

The following table lists the core factories.

| API                     | Kind     | Summary                                                                                                                   |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `createCDPClient`       | function | Creates a `CDPClientInterface` bound to the given `CDPTransportInterface`.                                                |
| `createBrowserSnapshot` | function | Creates a navigable `BrowserSnapshotInterface` over decoded `BrowserSnapshotInput` data.                                  |
| `createBrowserReading`  | function | Creates a `BrowserReadingInterface` over a captured document, parsing its HTML one time.                                  |
| `createBrowserToolset`  | function | Creates a `BrowserToolsetInterface` that publishes the browser vocabulary over one page into a `@orkestrel/tool` manager. |

The following fence creates a reading from captured markup and a toolset over a page.

```ts
import {
	createBrowserReading,
	createBrowserSnapshot,
	createBrowserToolset,
} from '@orkestrel/browser'

const reading = createBrowserReading({
	url: 'https://example.com/',
	title: 'Example',
	html: '<nav>Menu</nav><main><p>Body</p></main>',
})
reading.markdown() // { text: 'Body', offset: 0, total: 4 }
const snapshot = createBrowserSnapshot(await page.snapshot()) // navigable again from plain data
const toolset = createBrowserToolset(page)
await toolset.start()
```

#### Classes

The following table lists the core classes. Each implements the behavioral interface of the same name plus `Interface`, which [Methods](#methods) documents.

| API                        | Kind  | Summary                                                                                                                |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------- |
| `BrowserAccessibility`     | class | Captures Chromium Accessibility-domain snapshots for one page.                                                         |
| `BrowserClock`             | class | Controls the Chromium virtual-time budget for deterministic page timers.                                               |
| `BrowserCodegen`           | class | Records page navigation and form interactions and compiles replayable scripts.                                         |
| `BrowserContext`           | class | Owns pages and shared state inside one Chromium browser context.                                                       |
| `BrowserCookieManager`     | class | Performs cookie operations isolated to one browser context.                                                            |
| `BrowserCoverage`          | class | Collects JavaScript precise coverage and CSS rule usage for one page target.                                           |
| `BrowserDiagnostics`       | class | Groups the tracing, coverage, performance, and profiler classes beneath one page.                                      |
| `BrowserEmulationManager`  | class | Applies rendering, identity, location, and network emulation for context pages.                                        |
| `BrowserFrame`             | class | Represents one attached document frame, evaluated through its own CDP execution world.                                 |
| `BrowserHARManager`        | class | Records and replays HTTP archives over one page network manager.                                                       |
| `BrowserKeyboard`          | class | Sends trusted keyboard input through Chromium's CDP Input domain.                                                      |
| `BrowserMouse`             | class | Sends trusted mouse input through Chromium's CDP Input domain.                                                         |
| `BrowserNavigationManager` | class | Parks URL-pattern and network-idle waits on page events and abort signals.                                             |
| `BrowserNetworkManager`    | class | Drives the page-scoped Network and Fetch domain lifecycle.                                                             |
| `BrowserPage`              | class | Represents a top-level browser page, including its target lifecycle and child frames.                                  |
| `BrowserPerformance`       | class | Reads Performance-domain metrics for one frame.                                                                        |
| `BrowserPermissionManager` | class | Applies permission overrides isolated to one browser context.                                                          |
| `BrowserProfiler`          | class | Records sampled JavaScript CPU profiles over one frame's Profiler domain.                                              |
| `BrowserReading`           | class | Represents one captured document, parsed one time and projected to Markdown or plain text in bounded slices.           |
| `BrowserScriptManager`     | class | Installs new-document scripts and promise-based host functions for one page.                                           |
| `BrowserSnapshot`          | class | Represents a navigable, serializable browser DOM snapshot.                                                             |
| `BrowserStorageManager`    | class | Imports, exports, and clears cookie and web-storage state for one browser context.                                     |
| `BrowserToolset`           | class | Publishes the browser vocabulary as `@orkestrel/tool` tools over one view and adopts the view's own tools beside them. |
| `BrowserTouch`             | class | Sends trusted touch input through Chromium's CDP Input domain.                                                         |
| `BrowserTracing`           | class | Captures Chromium traces streamed through the IO domain.                                                               |
| `BrowserTransition`        | class | Runs one asynchronous transition at a time, shared by every caller that joins it.                                      |
| `BrowserWebSocket`         | class | Represents an observable WebSocket connection reconstructed from Network-domain events.                                |
| `CDPClient`                | class | Provides a lightweight Chrome DevTools Protocol client over a `CDPTransportInterface`.                                 |
| `BrowserElement`           | class | Drives a referenced DOM element through its document's isolated world and the page input stream.                       |
| `BrowserElementManager`    | class | Captures accessibility trees and binds stable references to their owning frame sessions.                               |

#### Constants

The following table lists the core constants.

| API                                    | Kind  | Summary                                                                                                                                                                                                                                                          |
| -------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE64_CHARS`                         | const | Holds the index-ordered base64 alphabet used to build `BASE64_LOOKUP`.                                                                                                                                                                                           |
| `BASE64_LOOKUP`                        | const | Maps each base64 character to its 6-bit value, derived from `BASE64_CHARS`.                                                                                                                                                                                      |
| `BROWSER_DEFAULT_TIMEOUT_MS`           | const | Sets the default timeout for browser connection, requests, and navigation, `30_000` milliseconds.                                                                                                                                                                |
| `BROWSER_RESULT_LIMIT`                 | const | Caps the serialized-character length for an `evaluate()`/`read()` result at `2_500_000`, enforced in-page before the result is returned to CDP.                                                                                                                  |
| `BROWSER_RESULT_LIMIT_SENTINEL_PREFIX` | const | Names the distinctive prefix for the in-page result-limit sentinel error, `'[[ORKESTREL_BROWSER_RESULT_LIMIT]]'`, immediately followed by the serialized length.                                                                                                 |
| `BROWSER_RESULT_LIMIT_PATTERN`         | const | Matches the in-page result-limit sentinel error message, anchored immediately after the `Error:` (optionally `Uncaught Error:`) prefix Chromium prepends to a thrown error's description, `/^(?:Uncaught )?Error: \[\[ORKESTREL_BROWSER_RESULT_LIMIT\]\](\d+)/`. |
| `BROWSER_SNAPSHOT_NODE_LIMIT`          | const | Sets the default maximum node count accepted from a decoded CDP DOM snapshot, `100_000`.                                                                                                                                                                         |
| `BROWSER_FRAME_WORLD_NAME`             | const | Names the isolated world used for iframe evaluation, `'__orkestrelBrowserFrame'`.                                                                                                                                                                                |
| `BROWSER_STABLE_FRAME_COUNT`           | const | Sets the number of animation frames whose element bounds must agree before trusted input.                                                                                                                                                                        |
| `BROWSER_KEY_MODIFIERS`                | const | Maps a canonical modifier name to its CDP Input modifier bit value.                                                                                                                                                                                              |
| `BROWSER_MOUSE_BUTTON_MASKS`           | const | Maps each public mouse button to its CDP Input pressed-button bit value.                                                                                                                                                                                         |
| `BROWSER_HAR_CREATOR`                  | const | Names the tool identity embedded in HAR 1.2 documents.                                                                                                                                                                                                           |
| `BROWSER_SCREENSHOT_ATTRIBUTE`         | const | Names the attribute that tags temporary screenshot styles and masks.                                                                                                                                                                                             |
| `BROWSER_STOP_LOADING_TIMEOUT_MS`      | const | Bounds the best-effort `Page.stopLoading` call issued after a failed `navigate()` at `1_000` milliseconds.                                                                                                                                                       |
| `BROWSER_DEFAULT_VIEWPORT_WIDTH`       | const | Sets the default viewport width, `1280` pixels.                                                                                                                                                                                                                  |
| `BROWSER_DEFAULT_VIEWPORT_HEIGHT`      | const | Sets the default viewport height, `720` pixels.                                                                                                                                                                                                                  |
| `BROWSER_CODEGEN_BINDING_NAME`         | const | Names the CDP runtime binding the codegen recorder script calls into, `'__orkestrelBrowserCodegen'`.                                                                                                                                                             |
| `BROWSER_CODEGEN_SOURCE`               | const | Holds the in-page recorder script injected through `Page.addScriptToEvaluateOnNewDocument` and `Runtime.evaluate`.                                                                                                                                               |
| `BROWSER_REGISTRY_ABSENT_CODE`         | const | Identifies the CDP method-not-found response when WebMCP is absent.                                                                                                                                                                                              |
| `BROWSER_REGISTRY_OUTPUT_LIMIT`        | const | Bounds adopted tool JSON output and error messages to 4096 UTF-16 code units.                                                                                                                                                                                    |
| `BROWSER_REFERENCE_PREFIX`             | const | Prefixes stable element references within a browser context.                                                                                                                                                                                                     |
| `BROWSER_OUTLINE_LIMIT`                | const | Bounds the default number of actionable elements in an outline.                                                                                                                                                                                                  |
| `BROWSER_INTERACTIVE_ROLES`            | const | Names accessibility roles that receive actionable outline references.                                                                                                                                                                                            |
| `BROWSER_ELEMENT_REFUSALS`             | const | Maps the first line of each refusal the compiled element functions throw, without its `Error: ` prefix, to the reason and the one-line detail an element action reports it with.                                                                                 |
| `BROWSER_OUTLINE_OMITTED_ROLES`        | const | Names accessibility roles whose own rows add no outline content.                                                                                                                                                                                                 |
| `BROWSER_TEXT_ROLES`                   | const | Names accessibility roles rendered as text without an actionable reference.                                                                                                                                                                                      |
| `BROWSER_TOOL_LIMIT`                   | const | Bounds each tool result and error message at `4_000` UTF-16 code units before its footer.                                                                                                                                                                        |
| `BROWSER_TOOL_TIMEOUT_MS`              | const | Sets the `wait` tool's default and an action receipt's bound on a requested navigation, `5_000` milliseconds.                                                                                                                                                    |
| `BROWSER_TOOL_CAPTURE_MS`              | const | Reserves `1_000` milliseconds of an action receipt's `BROWSER_TOOL_TIMEOUT_MS` deadline for the view capture, so a receipt whose navigation wait reaches its bound still carries the view.                                                                       |
| `BROWSER_TOOL_DEADLINE_NOTE`           | const | Holds the note an action receipt carries in place of the view when the receipt's deadline passed before the view could be captured.                                                                                                                              |
| `BROWSER_TOOL_CHANGED_NOTE`            | const | Holds the note an action receipt carries in place of the view when the page changed under the capture twice: once after the action, and again during the one retry that follows the page's readiness.                                                            |
| `BROWSER_TOOL_CUT_FOOTER`              | const | Holds the clause that ends the footer of a cut result that carries no view: a read note, a tab list, a wait, a page tool's output, or an error message.                                                                                                          |
| `BROWSER_TOOL_VIEW_FOOTER`             | const | Holds the clause that ends the footer of a cut result that carries a view, the result of `look` and of every action, and names `read` as the call that returns the page's text.                                                                                  |
| `BROWSER_TYPED_ROLES`                  | const | Names the accessibility roles the `type` tool writes to: `textbox`, `searchbox`, and `spinbutton` take typed text, and `combobox` and `listbox` take a select control's option or, for a text input with suggestions, typed text.                                |
| `BROWSER_TOOL_TIMEOUT_LIMIT_MS`        | const | Caps the `wait` tool's `timeout` parameter at `30_000` milliseconds.                                                                                                                                                                                             |
| `BROWSER_TOOL_NAMES`                   | const | Names every tool the browser toolset reserves: `look`, `read`, `click`, `type`, `press`, `navigate`, `wait`, `dialog`, `tabs`, and `switch`.                                                                                                                     |
| `BROWSER_TOOL_NAME_PATTERN`            | const | Matches a page tool name the toolset can advertise: 1 to 64 ASCII letters, digits, underscores, and hyphens.                                                                                                                                                     |
| `BROWSER_SCHEMES`                      | const | Names the URL schemes the `navigate` tool accepts by default: `http:` and `https:`.                                                                                                                                                                              |
| `BROWSER_TOOL_COPY`                    | const | Holds the advertised definition of each reserved tool: its description, its JSON Schema parameters, and its annotations.                                                                                                                                         |

#### Errors

Every error carries a machine-readable `code` and an optional `context` record, and each class has a guard. The following table lists the core errors and their guards.

| API                         | Kind     | Summary                                                                                                                                                                                                                                      |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserError`              | class    | Represents the base error for all browser automation operations, carrying the code `BROWSER_ERROR` and a `context` record.                                                                                                                   |
| `BrowserElementError`       | class    | Reports a refused element operation with a reason and a recovery instruction.                                                                                                                                                                |
| `isBrowserElementError`     | function | Checks whether a value is an element refusal.                                                                                                                                                                                                |
| `CDPError`                  | class    | Reports that a CDP request received an error response from the remote endpoint, under the code `BROWSER_CDP_ERROR`, with the `method`, the CDP `code`, the `message`, and any `data` in its context.                                         |
| `CDPConnectionError`        | class    | Reports that a CDP request could not be sent or completed because the client was not in a connectable state — not connected, closed while connecting, or the connection dropped mid-request — under the code `BROWSER_CDP_CONNECTION_ERROR`. |
| `CDPTimeoutError`           | class    | Reports that a pending CDP request was not answered within its timeout window, under the code `BROWSER_CDP_TIMEOUT_ERROR`.                                                                                                                   |
| `BrowserResultLimitError`   | class    | Reports that an `evaluate()`/`read()` result exceeded `BROWSER_RESULT_LIMIT` and was rejected in-page before it could overflow the CDP transport frame, under the code `BROWSER_RESULT_LIMIT_ERROR`.                                         |
| `isBrowserError`            | function | Narrows an unknown value to a `BrowserError`.                                                                                                                                                                                                |
| `isCDPError`                | function | Narrows an unknown value to a `CDPError`.                                                                                                                                                                                                    |
| `isCDPConnectionError`      | function | Narrows an unknown value to a `CDPConnectionError`.                                                                                                                                                                                          |
| `isCDPTimeoutError`         | function | Narrows an unknown value to a `CDPTimeoutError`.                                                                                                                                                                                             |
| `isBrowserResultLimitError` | function | Narrows an unknown value to a `BrowserResultLimitError`.                                                                                                                                                                                     |
| `BrowserConnectionError`    | class    | Reports that a CDP connection, discovery, or launch attempt failed, under the code `BROWSER_CONNECTION_ERROR`.                                                                                                                               |
| `isBrowserConnectionError`  | function | Narrows an unknown value to a `BrowserConnectionError`.                                                                                                                                                                                      |

A `BrowserError` names its refusal in `code`. Among those codes, the toolset refuses an argument a tool cannot take, a parameter the tool does not advertise included, with `BROWSER_TOOLSET_ARGUMENT`, and `type` on an element whose role is not in `BROWSER_TYPED_ROLES` with `BROWSER_TOOLSET_ROLE`; a page refuses a second live page for a target another page holds with `BROWSER_TARGET_HELD`; and a context's `create()` rejects with `BROWSER_PAGE_CLOSED` when the page it created or joined closed before it could return that page.

The following fence narrows a caught value with the guards. `BrowserElementError` carries `context.reason`, one of the `BrowserElementReason` values, and a one-line message that ends `; call look for fresh refs.` for `GONE` alone.

```ts
import {
	isBrowserConnectionError,
	isBrowserElementError,
	isBrowserError,
	isBrowserResultLimitError,
	isCDPConnectionError,
	isCDPError,
	isCDPTimeoutError,
} from '@orkestrel/browser'

try {
	await element.click()
} catch (error) {
	if (isBrowserElementError(error))
		log(error.code, error.context) // { reason: 'OCCLUDED', … }
	else if (isCDPError(error)) log(error.code, error.context)
	else if (isCDPConnectionError(error)) log(error.code)
	else if (isCDPTimeoutError(error)) log(error.code)
	else if (isBrowserResultLimitError(error)) log(error.code, error.context)
	else if (isBrowserConnectionError(error)) log(error.code, error.context)
	else if (isBrowserError(error)) log(error.code)
}
```

#### Helpers

The helpers are pure: they decode protocol payloads, validate options, compile in-page expressions, and render tool text, so each runs without a browser. The following table lists the core helpers, parsers, and compilers.

| API                                      | Kind     | Summary                                                                                                                                                                                             |
| ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compileQueryWaitExpression`             | function | Compiles a mutation-driven wait with one deadline and explicit disconnect ownership.                                                                                                                |
| `compileTextWaitExpression`              | function | Compiles a visible-text wait coalesced by animation frames.                                                                                                                                         |
| `compileSelectFunction`                  | function | Compiles text selection or select-option assignment against the resolved element.                                                                                                                   |
| `compileHitFunction`                     | function | Compiles the descendant hit check for a resolved element.                                                                                                                                           |
| `compileBrowserBindingSource`            | function | Compiles the page-side promise facade for one Runtime binding.                                                                                                                                      |
| `compileBrowserBindingResult`            | function | Compiles delivery of a host binding result to one execution context.                                                                                                                                |
| `compileBrowserBindingCleanup`           | function | Compiles current-document cleanup for one page-side host binding facade.                                                                                                                            |
| `compileScreenshotPreparationExpression` | function | Compiles temporary animation, caret, and mask setup for a screenshot.                                                                                                                               |
| `compileScreenshotCleanupExpression`     | function | Compiles cleanup for temporary screenshot styles and masks.                                                                                                                                         |
| `compileStorageReadExpression`           | function | Compiles an expression that serializes local and session storage.                                                                                                                                   |
| `compileStorageRestoreExpression`        | function | Compiles an expression that restores one origin's web storage.                                                                                                                                      |
| `compileStorageClearExpression`          | function | Compiles an expression that clears local and session storage.                                                                                                                                       |
| `compileGuardedEvaluateExpression`       | function | Compiles a `Runtime.evaluate` expression so the in-page code stringifies its own result and throws a recognizable sentinel error before an oversized result would overflow the CDP transport frame. |
| `compileReadFunction`                    | function | Compiles the in-page function that reads the document's URL, title, and serialized HTML.                                                                                                            |
| `compileCodegenScript`                   | function | Compiles recorded codegen actions into a replayable JavaScript or TypeScript script.                                                                                                                |
| `compileActionabilityFunction`           | function | Compiles the element-side actionability pass used before trusted input.                                                                                                                             |
| `normalizeBrowserName`                   | function | Normalizes an accessible name for display and matching.                                                                                                                                             |
| `filterBrowserOutline`                   | function | Filters document-order outline rows by accessibility role and name.                                                                                                                                 |
| `renderBrowserOutline`                   | function | Renders document-order text and referenced elements with a bounded element count.                                                                                                                   |
| `composeBrowserPoint`                    | function | Composes a frame-local point with its ancestor frame offsets.                                                                                                                                       |
| `normalizeBrowserKey`                    | function | Normalizes named keys and modifier aliases before trusted keyboard input.                                                                                                                           |
| `renderBrowserToolOutput`                | function | Renders tool strings unchanged, content-array text blocks joined, and other values as bounded JSON.                                                                                                 |
| `deriveBrowserToolSchema`                | function | Derives the advertised input schema from an authored one, adding a required `what` parameter when the schema requires nothing.                                                                      |
| `boundBrowserText`                       | function | Bounds a tool string at a character limit, appending a footer that names the cut and the caller's closing clause.                                                                                   |
| `validateBrowserToolArguments`           | function | Refuses a tool call that carries a parameter its definition does not advertise, naming the parameters the tool takes.                                                                               |
| `renderBrowserElement`                   | function | Renders an element as its outline row reads: reference, role, and quoted name.                                                                                                                      |
| `requireBrowserReference`                | function | Requires a tool argument to be an element reference in any spelling `parseBrowserReference` accepts, and returns its canonical form.                                                                |
| `readBrowserToolString`                  | function | Reads a required string argument from a tool call.                                                                                                                                                  |
| `renderBrowserReceipt`                   | function | Renders a tool receipt: the action and its status on one line, the interrupting dialog, then a blank line and the fresh view.                                                                       |
| `decodeBase64`                           | function | Decodes a base64-encoded string into raw bytes.                                                                                                                                                     |
| `encodeBase64`                           | function | Encodes raw bytes as base64 without relying on Node or DOM globals.                                                                                                                                 |
| `textToBytes`                            | function | Encodes UTF-8 text as bytes.                                                                                                                                                                        |
| `bytesToText`                            | function | Decodes UTF-8 bytes as text.                                                                                                                                                                        |
| `browserHeadersToProtocol`               | function | Converts a header record to Fetch-domain name/value entries.                                                                                                                                        |
| `readBrowserHeaders`                     | function | Decodes a Chromium Headers object into string values, skipping every entry that is neither a string nor a finite number.                                                                            |
| `createBrowserHAREntry`                  | function | Builds a standards-shaped HAR 1.2 entry from one observed exchange.                                                                                                                                 |
| `browserHARHeadersToRecord`              | function | Converts HAR name/value headers into a Fetch-domain header record.                                                                                                                                  |
| `validateBrowserHAR`                     | function | Validates the HAR 1.2 fields required for deterministic replay.                                                                                                                                     |
| `matchesBrowserRoute`                    | function | Matches a request against route criteria.                                                                                                                                                           |
| `matchesBrowserURL`                      | function | Matches a URL using Chromium-style `*` and `**` glob segments.                                                                                                                                      |
| `readBrowserScriptIdentifier`            | function | Decodes the `Page.addScriptToEvaluateOnNewDocument` result, throwing a `BrowserError` off-shape.                                                                                                    |
| `validateBrowserPoint`                   | function | Validates viewport input coordinates.                                                                                                                                                               |
| `validateBrowserInputOptions`            | function | Validates the bounded delay, count, and steps of one trusted-input operation.                                                                                                                       |
| `validateBrowserTimeout`                 | function | Validates a public browser timeout before protocol work begins.                                                                                                                                     |
| `validateBrowserViewport`                | function | Validates Chromium viewport metrics.                                                                                                                                                                |
| `validateBrowserEmulationOptions`        | function | Validates context emulation boundaries before partial application.                                                                                                                                  |
| `validateBrowserContextOptions`          | function | Validates isolated-context options before creating remote state.                                                                                                                                    |
| `validateBrowserAccessibilityOptions`    | function | Validates Accessibility-domain snapshot bounds.                                                                                                                                                     |
| `browserPDFToParams`                     | function | Validates and compiles Page.printToPDF parameters.                                                                                                                                                  |
| `browserScreenshotToParams`              | function | Validates and compiles basic Page.captureScreenshot parameters.                                                                                                                                     |
| `validateBrowserRange`                   | function | Validates a finite numeric range.                                                                                                                                                                   |
| `readBrowserAccessibility`               | function | Decodes Accessibility-domain nodes into a flat serializable tree, throwing a `BrowserError` off-shape.                                                                                              |
| `readBrowserAXValue`                     | function | Decodes an Accessibility-domain AXValue, or `undefined` when the record carries none.                                                                                                               |
| `concatBytes`                            | function | Concatenates byte chunks without Node-specific buffers.                                                                                                                                             |
| `readBrowserStreamChunk`                 | function | Decodes one `IO.read` response, throwing a `BrowserError` off-shape.                                                                                                                                |
| `readBrowserScriptCoverage`              | function | Decodes JavaScript precise coverage, throwing a `BrowserError` off-shape.                                                                                                                           |
| `readBrowserStyleCoverage`               | function | Decodes CSS rule usage, throwing a `BrowserError` off-shape.                                                                                                                                        |
| `readBrowserCoverageRanges`              | function | Decodes and normalizes coverage ranges, throwing a `BrowserError` off-shape.                                                                                                                        |
| `readBrowserMetrics`                     | function | Decodes Performance-domain metrics, throwing a `BrowserError` off-shape.                                                                                                                            |
| `readBrowserProfile`                     | function | Decodes one CPU profile, throwing a `BrowserError` off-shape.                                                                                                                                       |
| `readBrowserProfileFrame`                | function | Decodes a CPU profile call frame, throwing a `BrowserError` off-shape.                                                                                                                              |
| `cookieToProtocol`                       | function | Converts a typed cookie input into Chromium protocol fields.                                                                                                                                        |
| `readBrowserCookies`                     | function | Decodes the cookies `Storage.getCookies` returns, throwing a `BrowserError` off-shape.                                                                                                              |
| `readBrowserCookie`                      | function | Decodes one Chromium cookie, throwing a `BrowserError` off-shape.                                                                                                                                   |
| `matchesBrowserCookieURL`                | function | Matches a decoded cookie against one request URL.                                                                                                                                                   |
| `readBrowserStorageOrigin`               | function | Decodes one in-page web-storage snapshot, throwing a `BrowserError` off-shape.                                                                                                                      |
| `readBrowserStorageEntries`              | function | Decodes a list of web-storage entries, throwing a `BrowserError` off-shape.                                                                                                                         |
| `mediaToFeatures`                        | function | Converts typed media preferences to Chromium emulated media features.                                                                                                                               |
| `readBrowserStack`                       | function | Decodes a Chromium runtime stack trace, skipping every off-shape call frame.                                                                                                                        |
| `readBrowserRemoteValue`                 | function | Decodes a Runtime remote object's printable value, falling back to its unserializable form and then its description, or `undefined` when it carries none.                                           |
| `readEvaluationResult`                   | function | Decodes one CDP `Runtime.evaluate` result, throwing a `BrowserError` on a failed evaluation and a `BrowserResultLimitError` past the guarded result size.                                           |
| `requireBrowserString`                   | function | Requires an evaluated browser value to be a string.                                                                                                                                                 |
| `readBrowserWorld`                       | function | Reads the execution context id from a CDP `Page.createIsolatedWorld` reply.                                                                                                                         |
| `extractBrowserSlice`                    | function | Extracts one bounded slice of a projected text, cutting after a line break where one fits.                                                                                                          |
| `normalizeCodegenActions`                | function | Normalizes recorded codegen actions, collapsing consecutive `fill` actions on the same selector into the latest value.                                                                              |
| `readBrowserFrames`                      | function | Decodes a flattened CDP `Page.getFrameTree` result into depth-first frame metadata, skipping every off-shape frame, then appends each attached out-of-process iframe target the tree does not list. |
| `readBrowserQuad`                        | function | Decodes the first `DOM.getContentQuads` quad and its center, throwing a `BrowserError` off-shape.                                                                                                   |
| `extractBrowserChord`                    | function | Extracts a keyboard chord such as `Control+Shift+P` into its parts, throwing a `BrowserError` on an empty chord or an unsupported modifier.                                                         |
| `computeBrowserModifiers`                | function | Computes the CDP Input modifier bitmask.                                                                                                                                                            |
| `computeBrowserButtons`                  | function | Computes the CDP Input pressed-button bitmask.                                                                                                                                                      |
| `keyToBrowserInput`                      | function | Normalizes one key to CDP keyboard event data.                                                                                                                                                      |
| `readRareStringData`                     | function | Decodes CDP snapshot sparse string data into a node-index map, skipping every off-shape entry.                                                                                                      |
| `readRareBooleanData`                    | function | Decodes CDP snapshot sparse boolean data into a set of node indexes, skipping every off-shape entry.                                                                                                |
| `readRareIntegerData`                    | function | Decodes CDP snapshot sparse integer data into a node-index map, skipping every off-shape entry.                                                                                                     |
| `readBrowserAttributes`                  | function | Decodes flattened CDP node attributes into a frozen record, skipping every off-shape pair.                                                                                                          |
| `readBrowserSnapshot`                    | function | Decodes a CDP `DOMSnapshot.captureSnapshot` result into a serializable `BrowserSnapshotInput`, throwing a `BrowserError` off-shape and a `BrowserResultLimitError` past the configured node limit.  |
| `isBrowserNodeQuery`                     | function | Tests whether a browser-node matcher is a declarative query rather than a predicate.                                                                                                                |
| `matchesBrowserNode`                     | function | Tests a captured node against a declarative query.                                                                                                                                                  |
| `isBrowserNodeVisible`                   | function | Tests whether a captured node has a non-empty rendered layout box.                                                                                                                                  |
| `settleBrowserTeardown`                  | function | Awaits every teardown step in order and returns the first failure.                                                                                                                                  |
| `parseBrowserTool`                       | function | Coerces a WebMCP `Tool` object to its browser-domain representation.                                                                                                                                |
| `parseBrowserRemoval`                    | function | Coerces a WebMCP `RemovedTool` object to its document and name key.                                                                                                                                 |
| `parseBrowserInvocation`                 | function | Coerces a WebMCP `toolInvoked` event without parsing its authored input text.                                                                                                                       |
| `parseBrowserInvocationResult`           | function | Coerces a WebMCP `toolResponded` event, preserving output and terminal status.                                                                                                                      |
| `parseBrowserRequest`                    | function | Coerces one `Network.requestWillBeSent` or `Fetch.requestPaused` event to a `BrowserRequest`, or `undefined` off-shape.                                                                             |
| `parseBrowserResponse`                   | function | Coerces one `Network.responseReceived` event to a `BrowserResponse`, or `undefined` off-shape.                                                                                                      |
| `parseBrowserResponseRecord`             | function | Coerces one Chromium response object plus its event identity to a `BrowserResponse`, or `undefined` off-shape.                                                                                      |
| `parseBrowserTiming`                     | function | Coerces Chromium response timing to a `BrowserTiming`, or `undefined` off-shape.                                                                                                                    |
| `parseBrowserTimingRange`                | function | Coerces one named start/end pair of Chromium network timing to a `BrowserTimingRange`, or `undefined` off-shape.                                                                                    |
| `parseBrowserSecurity`                   | function | Coerces Chromium TLS security details to a `BrowserSecurity`, or `undefined` off-shape.                                                                                                             |
| `parseBrowserRequestFailure`             | function | Coerces one `Network.loadingFailed` event to a `BrowserRequestFailure`, or `undefined` off-shape.                                                                                                   |
| `parseBrowserWebSocketFrame`             | function | Coerces one WebSocket frame event to a `BrowserWebSocketFrame`, or `undefined` off-shape.                                                                                                           |
| `parseBrowserBindingCall`                | function | Coerces one Runtime binding invocation to a `BrowserBindingCall`, or `undefined` off-shape.                                                                                                         |
| `parseBrowserAXString`                   | function | Coerces a string-valued Accessibility-domain AXValue to a string, or `undefined` off-shape.                                                                                                         |
| `parseBrowserCookiePartition`            | function | Coerces an optional Chromium cookie partition key to a `BrowserCookiePartition`, or `undefined` off-shape.                                                                                          |
| `parseBrowserConsoleMessage`             | function | Coerces one `Runtime.consoleAPICalled` event to a `BrowserConsoleMessage`, or `undefined` off-shape.                                                                                                |
| `parseBrowserPageError`                  | function | Coerces one `Runtime.exceptionThrown` event to a `BrowserPageError`, or `undefined` off-shape.                                                                                                      |
| `parseBrowserDownloadStart`              | function | Coerces one `Browser.downloadWillBegin` event to a `BrowserDownloadStart`, or `undefined` off-shape.                                                                                                |
| `parseBrowserDownloadProgress`           | function | Coerces one `Browser.downloadProgress` event to a `BrowserDownloadProgress`, or `undefined` off-shape.                                                                                              |
| `parseCodegenActionPayload`              | function | Coerces a codegen binding payload string to a `BrowserCodegenAction`, or `undefined` off-shape.                                                                                                     |
| `parseCodegenNavigateAction`             | function | Coerces a `Page.frameNavigated` CDP event to a `navigate` codegen action, or `undefined` off-shape and for every frame but the top-level one.                                                       |
| `parseNumberArray`                       | function | Coerces an unknown value to an all-number array, or `undefined` off-shape.                                                                                                                          |
| `parseSnapshotString`                    | function | Coerces one CDP snapshot string-table index to its string, or `undefined` off-shape.                                                                                                                |
| `parseBrowserRect`                       | function | Coerces a four-number CSS-pixel rectangle to a `BrowserRect`, or `undefined` off-shape.                                                                                                             |
| `parseBrowserReference`                  | function | Parses the supported element-reference spellings into their canonical form.                                                                                                                         |

The following fence composes the snapshot, codegen, and evaluation helpers around captured CDP payloads.

```ts
import {
	compileCodegenScript,
	compileGuardedEvaluateExpression,
	decodeBase64,
	isBrowserNodeQuery,
	isBrowserNodeVisible,
	matchesBrowserNode,
	normalizeCodegenActions,
	parseBrowserRect,
	parseCodegenActionPayload,
	parseCodegenNavigateAction,
	parseNumberArray,
	parseSnapshotString,
	readBrowserAttributes,
	readBrowserFrames,
	readBrowserSnapshot,
	readEvaluationResult,
	readRareBooleanData,
	readRareIntegerData,
	readRareStringData,
	requireBrowserString,
} from '@orkestrel/browser'

const guarded = compileGuardedEvaluateExpression('document.title', 3_000_000) // wrapped expression string
const actions = normalizeCodegenActions(rawActions)
const action = parseCodegenActionPayload(payload) // BrowserCodegenAction | undefined
const navigate = parseCodegenNavigateAction(frameNavigatedParams)
const script = compileCodegenScript(actions, { language: 'typescript' })
const value = readEvaluationResult(runtimeResult)
const title = requireBrowserString(value, 'Title')
const frames = readBrowserFrames(frameTreeResult)
const bytes = decodeBase64('iVBORw0=') // Uint8Array [137, 80, 78, 71, 13]
const numbers = parseNumberArray([1, 2, 3])
const text = parseSnapshotString(snapshotStrings, 1)
const rareStrings = readRareStringData(rawRareStrings, snapshotStrings)
const rareBooleans = readRareBooleanData(rawRareBooleans)
const rareIntegers = readRareIntegerData(rawRareIntegers)
const rect = parseBrowserRect([0, 0, 100, 40])
const attributes = readBrowserAttributes(rawAttributes, snapshotStrings)
const decoded = readBrowserSnapshot(rawSnapshot, ['display']) // BrowserSnapshotInput
const node = decoded.documents[0].nodes[0]
const query = { name: 'article', visible: true }
if (isBrowserNodeQuery(query)) matchesBrowserNode(node, query)
const rendered = isBrowserNodeVisible(node)
```

Navigating decoded data is the `BrowserSnapshot` entity's job, not a helper family's; see [`BrowserSnapshotInterface`](#browsersnapshotinterface) later.

The following fence composes the element, reading, and tool helpers the element managers and the toolset are built from.

```ts
import {
	BROWSER_TOOL_COPY,
	BROWSER_TOOL_CUT_FOOTER,
	boundBrowserText,
	compileHitFunction,
	compileQueryWaitExpression,
	compileReadFunction,
	compileSelectFunction,
	compileTextWaitExpression,
	composeBrowserPoint,
	deriveBrowserToolSchema,
	extractBrowserSlice,
	filterBrowserOutline,
	normalizeBrowserKey,
	normalizeBrowserName,
	parseBrowserInvocation,
	parseBrowserInvocationResult,
	parseBrowserReference,
	parseBrowserRemoval,
	parseBrowserTool,
	readBrowserToolString,
	readBrowserWorld,
	renderBrowserElement,
	renderBrowserOutline,
	renderBrowserReceipt,
	renderBrowserToolOutput,
	requireBrowserReference,
	validateBrowserToolArguments,
} from '@orkestrel/browser'

parseBrowserReference('[ref=e12]') // 'e12'
parseBrowserReference('x12') // undefined
requireBrowserReference('12') // 'e12'; throws a coded BrowserElementError naming look for 'x12'
normalizeBrowserKey('ctrl+a') // 'Control+a'
normalizeBrowserName('  Place   order ') // 'Place order'
composeBrowserPoint({ x: 10, y: 10 }, [{ x: 100, y: 50 }]) // { x: 110, y: 60 }
extractBrowserSlice('one\ntwo\nthree', 0, 8) // { text: 'one\ntwo\n', offset: 0, total: 13 }
boundBrowserText('x'.repeat(5_000), 4_000, BROWSER_TOOL_CUT_FOOTER) // 4 000 characters, then '\n[characters 0–4000 of 5000; the rest was cut]'
validateBrowserToolArguments(BROWSER_TOOL_COPY.look, { what: 'cart', ref: 'e1' }) // throws BROWSER_TOOLSET_ARGUMENT: 'The look tool takes no ref parameter; call look with what.'
renderBrowserElement(element) // 'e4 button "Place order"'
const rows = filterBrowserOutline(nodes, { role: 'button', name: 'place' })
renderBrowserOutline('https://example.test/cart', 'Cart', rows, 150) // { url, title, text, count, total }
renderBrowserReceipt({ action: 'Clicked e4 button "Place order"', view }) // the receipt line, then the view
renderBrowserToolOutput([{ type: 'text', text: 'Found 3 cars' }]) // 'Found 3 cars'
readBrowserToolString({ what: 'cart' }, 'what') // 'cart'
deriveBrowserToolSchema(undefined) // a schema requiring a what string
const tool = parseBrowserTool(toolsAdded.tools[0]) // BrowserTool | undefined
const removal = parseBrowserRemoval(toolsRemoved.tools[0]) // BrowserToolRemoval | undefined
const invocation = parseBrowserInvocation(toolInvoked) // BrowserInvocation | undefined
const settled = parseBrowserInvocationResult(toolResponded) // BrowserInvocationResult | undefined
const world = readBrowserWorld(createIsolatedWorldResult, 'main') // execution context id
const read = compileReadFunction() // returns { url, title, html } in the isolated world
const hit = compileHitFunction() // tests whether a hit node is the element or inside it
const select = compileSelectFunction(['Large']) // selects the options whose value or label matches
const waitText = compileTextWaitExpression('Order placed', 5_000, 'wait-1')
const waitQuery = compileQueryWaitExpression(5_000, 'wait-2')
```

The following fence composes the page-level helpers behind trusted input, network interception, storage, coverage, and HAR recording.

```ts
import {
	browserHARHeadersToRecord,
	browserHeadersToProtocol,
	browserPDFToParams,
	browserScreenshotToParams,
	bytesToText,
	compileActionabilityFunction,
	compileBrowserBindingCleanup,
	compileBrowserBindingResult,
	compileBrowserBindingSource,
	compileScreenshotCleanupExpression,
	compileScreenshotPreparationExpression,
	compileStorageClearExpression,
	compileStorageReadExpression,
	compileStorageRestoreExpression,
	computeBrowserButtons,
	computeBrowserModifiers,
	concatBytes,
	cookieToProtocol,
	createBrowserHAREntry,
	encodeBase64,
	extractBrowserChord,
	keyToBrowserInput,
	matchesBrowserCookieURL,
	matchesBrowserRoute,
	matchesBrowserURL,
	mediaToFeatures,
	parseBrowserAXString,
	parseBrowserBindingCall,
	parseBrowserConsoleMessage,
	parseBrowserCookiePartition,
	parseBrowserDownloadProgress,
	parseBrowserDownloadStart,
	parseBrowserPageError,
	parseBrowserRequest,
	parseBrowserRequestFailure,
	parseBrowserResponse,
	parseBrowserResponseRecord,
	parseBrowserSecurity,
	parseBrowserTiming,
	parseBrowserTimingRange,
	parseBrowserWebSocketFrame,
	readBrowserAXValue,
	readBrowserAccessibility,
	readBrowserCookie,
	readBrowserCookies,
	readBrowserCoverageRanges,
	readBrowserHeaders,
	readBrowserMetrics,
	readBrowserProfile,
	readBrowserProfileFrame,
	readBrowserQuad,
	readBrowserRemoteValue,
	readBrowserScriptCoverage,
	readBrowserScriptIdentifier,
	readBrowserStack,
	readBrowserStorageEntries,
	readBrowserStorageOrigin,
	readBrowserStreamChunk,
	readBrowserStyleCoverage,
	settleBrowserTeardown,
	textToBytes,
	validateBrowserAccessibilityOptions,
	validateBrowserContextOptions,
	validateBrowserEmulationOptions,
	validateBrowserHAR,
	validateBrowserInputOptions,
	validateBrowserPoint,
	validateBrowserRange,
	validateBrowserTimeout,
	validateBrowserViewport,
} from '@orkestrel/browser'

const bytes = textToBytes('hello')
bytesToText(bytes)
encodeBase64(bytes)
concatBytes([bytes])
browserHeadersToProtocol({ accept: 'application/json' })
browserHARHeadersToRecord([{ name: 'content-type', value: 'text/plain' }])
browserPDFToParams({ landscape: true })
browserScreenshotToParams({ format: 'png' })
compileActionabilityFunction({ visible: true, stable: true })
compileBrowserBindingSource('lookup')
compileBrowserBindingResult('lookup', 'call-1', true, { found: true })
compileBrowserBindingCleanup('lookup')
compileScreenshotPreparationExpression({ animations: false })
compileScreenshotCleanupExpression('1')
compileStorageReadExpression()
compileStorageRestoreExpression({
	origin: 'https://example.com',
	local: [{ name: 'theme', value: 'dark' }],
	session: [],
})
compileStorageClearExpression()
computeBrowserButtons(['left'])
computeBrowserModifiers(['Control'])
cookieToProtocol({ name: 'session', value: 'value', url: 'https://example.com/' })
keyToBrowserInput('Enter')
extractBrowserChord('Control+Enter')
matchesBrowserURL('https://example.com/api', '**/api')
mediaToFeatures({ scheme: 'dark', motion: 'reduce' })

const request = parseBrowserRequest({
	requestId: 'request-1',
	request: { url: 'https://example.com/api', method: 'GET', headers: {} },
})
if (request !== undefined) {
	matchesBrowserRoute(request, { url: '**/api' })
	createBrowserHAREntry(
		{ request, started: Date.now(), response: undefined },
		10,
		undefined,
		'Request failed',
	)
}

const cookie = readBrowserCookie(
	{
		name: 'session',
		value: 'value',
		domain: 'example.com',
		path: '/',
		expires: -1,
		size: 12,
		httpOnly: true,
		secure: true,
		session: true,
		priority: 'Medium',
	},
	0,
)
matchesBrowserCookieURL(cookie, 'https://example.com/')

const payload: unknown = {}
parseBrowserAXString(payload)
readBrowserAXValue(payload)
readBrowserAccessibility(payload)
parseBrowserBindingCall(payload)
parseBrowserConsoleMessage(payload)
parseBrowserCookiePartition(payload)
readBrowserCookies(payload)
readBrowserCoverageRanges([], 0)
parseBrowserDownloadProgress(payload)
parseBrowserDownloadStart(payload)
readBrowserHeaders(payload)
readBrowserMetrics(payload)
parseBrowserPageError(payload)
readBrowserProfile(payload)
readBrowserProfileFrame(payload, 0)
readBrowserQuad(payload)
readBrowserRemoteValue(payload)
parseBrowserRequestFailure(payload)
parseBrowserResponse(payload)
parseBrowserResponseRecord(payload, 'request-1', 'loader-1', undefined, 0)
readBrowserScriptCoverage(payload)
readBrowserScriptIdentifier(payload)
parseBrowserSecurity(payload)
readBrowserStack(payload)
readBrowserStorageEntries([], 'https://example.com', 'local')
readBrowserStorageOrigin(payload, 'https://example.com')
readBrowserStreamChunk(payload)
readBrowserStyleCoverage(payload)
await settleBrowserTeardown(
	async () => undefined,
	async () => undefined,
) // unknown — the value the first failing step threw, or undefined
parseBrowserTiming(payload)
parseBrowserTimingRange(payload, 'dnsStart', 'dnsEnd')
parseBrowserWebSocketFrame(payload)
validateBrowserAccessibilityOptions({ depth: 3 })
validateBrowserInputOptions({ delay: 10, count: 2 })
validateBrowserContextOptions({ origins: ['https://example.com'] })
validateBrowserEmulationOptions({ locale: 'en-US' })
validateBrowserHAR({
	log: { version: '1.2', creator: { name: 'fixture', version: '1' }, entries: [] },
})
validateBrowserPoint({ x: 10, y: 20 })
validateBrowserRange(50, 'quality', 0, 100)
validateBrowserTimeout(1000)
validateBrowserViewport({ width: 1280, height: 720 })
```

#### Types

The following table lists the core types.

| API                                 | Kind      | Summary                                                                                                                                                                                                                   |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CDPTransportEventMap`              | type      | Maps the events emitted by a `CDPTransportInterface` — the raw text pipe a `CDPClientInterface` sends and receives JSON-RPC frames over.                                                                                  |
| `CDPTransportInterface`             | interface | Represents the text pipe a `CDPClient` sends and receives JSON-RPC frames over.                                                                                                                                           |
| `CDPClientEventMap`                 | type      | Maps the events a `CDPClientInterface` emits.                                                                                                                                                                             |
| `CDPClientOptions`                  | interface | Describes the options for creating a `CDPClient` instance.                                                                                                                                                                |
| `CDPSendOptions`                    | interface | Describes the options for one CDP method call.                                                                                                                                                                            |
| `CDPHandler`                        | type      | Receives a subscribed CDP event with its params record.                                                                                                                                                                   |
| `CDPTarget`                         | interface | Represents one entry of the CDP `Target.getTargets` result.                                                                                                                                                               |
| `CDPClientInterface`                | interface | Provides a lightweight Chrome DevTools Protocol client over a `CDPTransportInterface`.                                                                                                                                    |
| `BrowserTransitionFunction`         | type      | Runs the work one `BrowserTransitionInterface` transition performs.                                                                                                                                                       |
| `BrowserTransitionInterface`        | interface | Represents one asynchronous transition shared by every caller that arrives while it runs.                                                                                                                                 |
| `BrowserWriterInterface`            | interface | Provides a pluggable sink for persisting captured browser bytes to a path.                                                                                                                                                |
| `BrowserViewport`                   | interface | Describes the viewport dimensions for a browser page.                                                                                                                                                                     |
| `BrowserWaitUntil`                  | type      | Names the page load condition for navigation — the CDP load event awaited by `navigate()`.                                                                                                                                |
| `BrowserPageOptions`                | interface | Describes the options for creating a `BrowserPage` instance.                                                                                                                                                              |
| `BrowserNavigationOptions`          | interface | Describes the options for page navigation.                                                                                                                                                                                |
| `BrowserNavigationResult`           | interface | Describes the outcome of a top-level navigation command.                                                                                                                                                                  |
| `BrowserNavigationWatch`            | interface | Holds the state retained while correlating navigation with Network events.                                                                                                                                                |
| `BrowserNavigationWait`             | interface | Represents one pending navigation or network-idle wait.                                                                                                                                                                   |
| `BrowserLoaderFunction`             | type      | Reads the loader id of the page's current document, undefined before the first commit.                                                                                                                                    |
| `BrowserNavigationManagerInterface` | interface | Provides URL and network-idle waits associated with one page.                                                                                                                                                             |
| `BrowserInputOptions`               | interface | Describes the options shared by every trusted input operation.                                                                                                                                                            |
| `BrowserClickOptions`               | interface | Describes the options for a trusted mouse click.                                                                                                                                                                          |
| `BrowserDragOptions`                | interface | Describes the options for a trusted mouse drag.                                                                                                                                                                           |
| `BrowserScreenshotOptions`          | interface | Describes the options for taking a page screenshot.                                                                                                                                                                       |
| `BrowserScreenshotResult`           | interface | Describes the result of a page screenshot.                                                                                                                                                                                |
| `BrowserTeardownFunction`           | type      | Runs one teardown step to settlement while the first failure is retained.                                                                                                                                                 |
| `BrowserHandleInterface`            | interface | Represents a remote JavaScript object retained in one frame execution context.                                                                                                                                            |
| `BrowserBindingHandler`             | type      | Runs a host function exposed into page JavaScript.                                                                                                                                                                        |
| `BrowserBindingCall`                | interface | Describes a decoded page-to-host binding call.                                                                                                                                                                            |
| `BrowserScriptManagerInterface`     | interface | Manages initialization scripts and host bindings for one page.                                                                                                                                                            |
| `BrowserScriptEntry`                | interface | Represents one installed new-document script and its optional host binding owner.                                                                                                                                         |
| `BrowserAXNode`                     | interface | Represents one decoded Chromium accessibility node.                                                                                                                                                                       |
| `BrowserAccessibilitySnapshot`      | interface | Describes a serializable accessibility-tree snapshot.                                                                                                                                                                     |
| `BrowserAccessibilityOptions`       | interface | Describes the options for an accessibility snapshot.                                                                                                                                                                      |
| `BrowserAccessibilityInterface`     | interface | Inspects the accessibility tree.                                                                                                                                                                                          |
| `BrowserTracingOptions`             | interface | Describes the options for a Chromium trace capture.                                                                                                                                                                       |
| `BrowserTracingResult`              | interface | Describes the result of a trace capture.                                                                                                                                                                                  |
| `BrowserStreamChunk`                | interface | Represents one decoded IO stream read.                                                                                                                                                                                    |
| `BrowserTracingInterface`           | interface | Drives the trace capture lifecycle.                                                                                                                                                                                       |
| `BrowserCoverageRange`              | interface | Describes a source range reported by JavaScript or CSS coverage.                                                                                                                                                          |
| `BrowserFunctionCoverage`           | interface | Describes function coverage inside one script.                                                                                                                                                                            |
| `BrowserScriptCoverage`             | interface | Describes JavaScript script coverage.                                                                                                                                                                                     |
| `BrowserStyleCoverage`              | interface | Describes CSS stylesheet coverage.                                                                                                                                                                                        |
| `BrowserCoverageOptions`            | interface | Describes the options for a coverage capture.                                                                                                                                                                             |
| `BrowserCoverageResult`             | interface | Describes combined JavaScript and CSS usage.                                                                                                                                                                              |
| `BrowserCoverageInterface`          | interface | Drives the coverage capture lifecycle.                                                                                                                                                                                    |
| `BrowserMetric`                     | interface | Represents one Performance-domain metric.                                                                                                                                                                                 |
| `BrowserProfileFrame`               | interface | Describes a JavaScript call frame from a CPU profile.                                                                                                                                                                     |
| `BrowserProfileNode`                | interface | Represents one node in a sampled CPU profile.                                                                                                                                                                             |
| `BrowserProfile`                    | interface | Describes a sampled CPU profile.                                                                                                                                                                                          |
| `BrowserPerformanceInterface`       | interface | Reads Performance-domain metrics.                                                                                                                                                                                         |
| `BrowserProfilerInterface`          | interface | Drives the sampled CPU profile lifecycle.                                                                                                                                                                                 |
| `BrowserDiagnosticsInterface`       | interface | Groups the diagnostics by capability.                                                                                                                                                                                     |
| `BrowserClockInterface`             | interface | Controls Chromium virtual time for deterministic page timers.                                                                                                                                                             |
| `BrowserPoint`                      | interface | Describes a point in viewport CSS pixels.                                                                                                                                                                                 |
| `BrowserMouseButton`                | type      | Names a mouse button understood by Chromium's Input domain.                                                                                                                                                               |
| `BrowserScreenshotScale`            | type      | Names a screenshot coordinate scale.                                                                                                                                                                                      |
| `BrowserKey`                        | interface | Describes normalized CDP keyboard key data.                                                                                                                                                                               |
| `BrowserChord`                      | interface | Describes a parsed keyboard chord.                                                                                                                                                                                        |
| `BrowserOperationOptions`           | type      | Collects every option a trusted-input operation can carry.                                                                                                                                                                |
| `BrowserKeyboardInterface`          | interface | Provides keyboard input operations bound to one frame target session.                                                                                                                                                     |
| `BrowserMouseInterface`             | interface | Provides mouse input operations bound to one frame target session.                                                                                                                                                        |
| `BrowserTouchInterface`             | interface | Provides touch input operations bound to one frame target session.                                                                                                                                                        |
| `BrowserActionabilityOptions`       | interface | Describes the actionability checks performed before element input.                                                                                                                                                        |
| `BrowserQuad`                       | interface | Describes a decoded content quad and its actionable center.                                                                                                                                                               |
| `BrowserMargin`                     | interface | Describes the paper margin lengths accepted by Chromium print-to-PDF.                                                                                                                                                     |
| `BrowserPDFOptions`                 | interface | Describes the options for printing a Chromium page to PDF.                                                                                                                                                                |
| `BrowserPDFResult`                  | interface | Describes the result of printing a page to PDF.                                                                                                                                                                           |
| `BrowserDialogCategory`             | type      | Names a JavaScript dialog category reported by Chromium.                                                                                                                                                                  |
| `BrowserDialogInterface`            | interface | Represents one active JavaScript dialog.                                                                                                                                                                                  |
| `BrowserFileChooserInterface`       | interface | Represents one intercepted file chooser.                                                                                                                                                                                  |
| `BrowserDownloadStatus`             | type      | Names a download lifecycle phase.                                                                                                                                                                                         |
| `BrowserDownloadEventMap`           | type      | Maps the download progress events.                                                                                                                                                                                        |
| `BrowserDownloadProgress`           | interface | Describes a protocol-neutral download progress update.                                                                                                                                                                    |
| `BrowserDownloadStart`              | interface | Describes a decoded `Browser.downloadWillBegin` event.                                                                                                                                                                    |
| `BrowserDownloadInterface`          | interface | Represents one context download tracked through Chromium's Browser domain.                                                                                                                                                |
| `BrowserConsoleMessage`             | interface | Represents one console API call.                                                                                                                                                                                          |
| `BrowserStackFrame`                 | interface | Represents one browser-side stack frame.                                                                                                                                                                                  |
| `BrowserPageError`                  | interface | Represents one uncaught page exception.                                                                                                                                                                                   |
| `BrowserWorkerCategory`             | type      | Names a worker target category.                                                                                                                                                                                           |
| `BrowserWorkerInterface`            | interface | Represents a script worker attached to a page target.                                                                                                                                                                     |
| `BrowserPageEventMap`               | type      | Maps the typed page, frame, target, and user-visible browser events.                                                                                                                                                      |
| `BrowserRequest`                    | interface | Represents one observed browser request.                                                                                                                                                                                  |
| `BrowserSecurity`                   | interface | Describes the TLS details supplied with a browser response.                                                                                                                                                               |
| `BrowserTimingRange`                | interface | Describes the start/end pair for one network timing phase.                                                                                                                                                                |
| `BrowserTiming`                     | interface | Holds network timing values in milliseconds relative to request time.                                                                                                                                                     |
| `BrowserResponse`                   | interface | Represents one observed browser response.                                                                                                                                                                                 |
| `BrowserRequestFailure`             | interface | Represents one failed browser request.                                                                                                                                                                                    |
| `BrowserWebSocketFrame`             | interface | Describes a WebSocket frame payload.                                                                                                                                                                                      |
| `BrowserWebSocketEventMap`          | type      | Maps the WebSocket lifecycle events.                                                                                                                                                                                      |
| `BrowserWebSocketInterface`         | interface | Represents one observed WebSocket connection.                                                                                                                                                                             |
| `BrowserNetworkEventMap`            | type      | Maps the network events a page's network manager emits.                                                                                                                                                                   |
| `BrowserRouteQuery`                 | interface | Describes route matching criteria. Omitted fields match all values.                                                                                                                                                       |
| `BrowserRouteContinueOptions`       | interface | Describes the overrides supplied when continuing an intercepted request.                                                                                                                                                  |
| `BrowserRouteFulfillOptions`        | interface | Describes the synthetic response supplied when fulfilling an intercepted request.                                                                                                                                         |
| `BrowserRouteInterface`             | interface | Represents one paused Fetch-domain request.                                                                                                                                                                               |
| `BrowserRouteHandler`               | type      | Runs for a matching intercepted request.                                                                                                                                                                                  |
| `BrowserRouteDefinition`            | interface | Represents one installed network route.                                                                                                                                                                                   |
| `BrowserHAROptions`                 | interface | Describes the options for a HAR recording.                                                                                                                                                                                |
| `BrowserHARValue`                   | interface | Represents one name/value pair in an HTTP archive.                                                                                                                                                                        |
| `BrowserHARCookie`                  | interface | Represents one cookie in an HTTP archive.                                                                                                                                                                                 |
| `BrowserHARPost`                    | interface | Describes request body metadata in an HTTP archive.                                                                                                                                                                       |
| `BrowserHARContent`                 | interface | Describes response body metadata in an HTTP archive.                                                                                                                                                                      |
| `BrowserHARRequest`                 | interface | Describes a HAR 1.2 request entry.                                                                                                                                                                                        |
| `BrowserHARResponse`                | interface | Describes a HAR 1.2 response entry.                                                                                                                                                                                       |
| `BrowserHARTimings`                 | interface | Holds HAR 1.2 phase timings in milliseconds.                                                                                                                                                                              |
| `BrowserHAREntry`                   | interface | Represents one completed HTTP exchange in a HAR recording.                                                                                                                                                                |
| `BrowserHARPending`                 | interface | Holds recording state until a request finishes; a new value replaces it on each update.                                                                                                                                   |
| `BrowserHARCreator`                 | interface | Describes the tool identity embedded in an HTTP archive.                                                                                                                                                                  |
| `BrowserHARLog`                     | interface | Describes the HAR 1.2 log object.                                                                                                                                                                                         |
| `BrowserHAR`                        | interface | Describes the standards-shaped HAR 1.2 document produced by the network manager.                                                                                                                                          |
| `BrowserHARReplayOptions`           | interface | Describes HAR replay behavior.                                                                                                                                                                                            |
| `BrowserHARManagerInterface`        | interface | Provides HAR recording and replay operations.                                                                                                                                                                             |
| `BrowserNetworkManagerInterface`    | interface | Provides page-scoped network observation and interception.                                                                                                                                                                |
| `BrowserSameSite`                   | type      | Names a cookie same-site policy understood by Chromium.                                                                                                                                                                   |
| `BrowserCookiePartition`            | interface | Describes a cookie partition key used by CHIPS-partitioned cookies.                                                                                                                                                       |
| `BrowserCookie`                     | interface | Represents one cookie returned from a browser context.                                                                                                                                                                    |
| `BrowserCookieInput`                | interface | Describes the input used to create or replace a browser cookie.                                                                                                                                                           |
| `BrowserCookieFilter`               | interface | Describes optional narrowing criteria for clearing context cookies.                                                                                                                                                       |
| `BrowserCookieManagerInterface`     | interface | Provides cookie operations scoped to one browser context.                                                                                                                                                                 |
| `BrowserPermissionManagerInterface` | interface | Provides permission override operations scoped to one browser context.                                                                                                                                                    |
| `BrowserStorageEntry`               | interface | Represents one key/value pair from web storage.                                                                                                                                                                           |
| `BrowserStorageOrigin`              | interface | Describes an origin-scoped local and session storage snapshot.                                                                                                                                                            |
| `BrowserStorageState`               | interface | Describes a portable browser authentication and storage snapshot.                                                                                                                                                         |
| `BrowserStorageOptions`             | interface | Describes the options for collecting storage state from selected origins.                                                                                                                                                 |
| `BrowserStorageManagerInterface`    | interface | Provides storage-state import, export, and clearing operations.                                                                                                                                                           |
| `BrowserCredentials`                | interface | Describes the HTTP basic-auth credentials applied to context pages.                                                                                                                                                       |
| `BrowserGeolocation`                | interface | Describes a geographic location override.                                                                                                                                                                                 |
| `BrowserMedia`                      | interface | Describes browser color and media feature overrides.                                                                                                                                                                      |
| `BrowserUserAgent`                  | interface | Describes user-agent metadata accepted by Chromium emulation.                                                                                                                                                             |
| `BrowserEmulationOptions`           | interface | Describes network and rendering overrides inherited by context pages.                                                                                                                                                     |
| `BrowserPagesFunction`              | type      | Returns the context's live pages at call time.                                                                                                                                                                            |
| `BrowserEmulationManagerInterface`  | interface | Configures context-scoped emulation.                                                                                                                                                                                      |
| `BrowserProxy`                      | interface | Describes proxy settings used when creating an isolated browser context.                                                                                                                                                  |
| `BrowserDownloadOptions`            | interface | Describes the download policy for a browser context.                                                                                                                                                                      |
| `BrowserContextOptions`             | interface | Describes the options for creating and configuring an isolated browser context.                                                                                                                                           |
| `BrowserContextEventMap`            | type      | Maps the browser-context lifecycle events.                                                                                                                                                                                |
| `BrowserCodegenAction`              | type      | Represents one recorded browser action captured during a codegen session.                                                                                                                                                 |
| `BrowserCodegenEventMap`            | type      | Maps the events a `BrowserCodegenInterface` emits.                                                                                                                                                                        |
| `BrowserCodegenOptions`             | interface | Describes the options for creating a `BrowserCodegen` recorder.                                                                                                                                                           |
| `BrowserCodegenLanguage`            | type      | Names the target language for a compiled codegen script.                                                                                                                                                                  |
| `BrowserCodegenScriptOptions`       | interface | Describes the options for compiling recorded actions into a script.                                                                                                                                                       |
| `BrowserCodegenInterface`           | interface | Records page interactions (navigation, click, fill, select) as a session runs, for later compilation into a replayable script.                                                                                            |
| `BrowserReadOptions`                | interface | Describes the options for one slice of a reading's Markdown or plain-text projection.                                                                                                                                     |
| `BrowserReadResult`                 | interface | Describes one slice of a reading's projection.                                                                                                                                                                            |
| `BrowserEpochFunction`              | type      | Reads the navigation epoch of the frame a reading was captured from.                                                                                                                                                      |
| `BrowserReadingInput`               | interface | Describes the captured document a reading is built from.                                                                                                                                                                  |
| `BrowserReadingInterface`           | interface | Represents one captured document, parsed one time and projected to Markdown or plain text in bounded slices.                                                                                                              |
| `BrowserSessionFunction`            | type      | Resolves the current CDP session for a frame id.                                                                                                                                                                          |
| `BrowserWorldFunction`              | type      | Resolves the isolated-world execution context a page caches for one frame document, creating the world on the given session when none is cached.                                                                          |
| `BrowserElementQuery`               | interface | Describes an accessibility or CSS query within an optional element reference.                                                                                                                                             |
| `BrowserElementWaitOptions`         | interface | Configures an element wait, including whether absence satisfies it.                                                                                                                                                       |
| `BrowserOutlineOptions`             | interface | Configures an outline's element limit and optional subtree.                                                                                                                                                               |
| `BrowserOutline`                    | interface | Carries a document-order outline and its included and available element counts.                                                                                                                                           |
| `BrowserOutlineNode`                | interface | Associates an outline row with its frame, session, and optional actionable reference.                                                                                                                                     |
| `BrowserElementGeometry`            | interface | Retains both session-local and page-composed element geometry.                                                                                                                                                            |
| `BrowserElementSubject`             | interface | Identifies a manager failure without inventing an element reference.                                                                                                                                                      |
| `BrowserElementReason`              | type      | Identifies the refusal an element action reports.                                                                                                                                                                         |
| `BrowserElementRefusal`             | interface | Describes how an element action reports one refusal its compiled in-page check throws: the reason, and the detail that follows the element's name, or `undefined` for the reason's own wording.                           |
| `BrowserReferenceFunction`          | type      | Allocates the next reference from the owning browser context.                                                                                                                                                             |
| `BrowserElementWorldFunction`       | type      | Resolves the page-owned isolated world for a particular frame and session.                                                                                                                                                |
| `BrowserReadinessFunction`          | type      | Waits for the current document's DOM readiness.                                                                                                                                                                           |
| `BrowserElementPointFunction`       | type      | Composes a frame-local point into page coordinates.                                                                                                                                                                       |
| `BrowserElementManagerInput`        | interface | Provides the protocol and ownership boundaries used by a page element manager.                                                                                                                                            |
| `BrowserElementInput`               | interface | Binds an element to its document identity and the page's shared protocol resources.                                                                                                                                       |
| `BrowserReadinessWait`              | interface | Holds the resources of one lifecycle-event readiness wait.                                                                                                                                                                |
| `BrowserElementInterface`           | interface | Provides actions and reading through a stable document element reference.                                                                                                                                                 |
| `BrowserPageElementInterface`       | interface | Provides trusted page input and capture for a referenced element.                                                                                                                                                         |
| `BrowserElementManagerInterface`    | interface | Captures, queries, and retains references to a view's elements.                                                                                                                                                           |
| `BrowserViewInterface`              | interface | Provides the document operations shared by remote and DOM-native views.                                                                                                                                                   |
| `BrowserCallOptions`                | interface | Describes the options every asynchronous page, frame, handle, and worker call accepts.                                                                                                                                    |
| `BrowserToolAnnotation`             | interface | Transliterates the WebMCP protocol's `Annotation` type, retaining its wire spelling.                                                                                                                                      |
| `BrowserTool`                       | interface | Describes a registered WebMCP tool and its owning document.                                                                                                                                                               |
| `BrowserToolRemoval`                | interface | Identifies a removed WebMCP tool by document and name.                                                                                                                                                                    |
| `BrowserInvocation`                 | interface | Describes a WebMCP invocation observed on the protocol.                                                                                                                                                                   |
| `BrowserInvocationResult`           | interface | Carries a terminal WebMCP status and its untrusted output or error.                                                                                                                                                       |
| `BrowserRegistryEventMap`           | type      | Maps registry changes and observed WebMCP invocation events.                                                                                                                                                              |
| `BrowserRegistryOptions`            | interface | Configures registry listeners and listener-error handling.                                                                                                                                                                |
| `BrowserRegistryInterface`          | interface | Mirrors the experimental WebMCP protocol domain for a page.                                                                                                                                                               |
| `BrowserRegistryPending`            | interface | Holds one unsettled registry execution and its resource cleanup.                                                                                                                                                          |
| `BrowserToolName`                   | type      | Names a tool the browser toolset reserves: the seven generic tools, the staged `dialog`, and the opt-in `tabs` and `switch`.                                                                                              |
| `BrowserToolsetReason`              | type      | Names why a toolset declined a page tool.                                                                                                                                                                                 |
| `BrowserToolSourceEventMap`         | type      | Maps the signal a tool source emits when its page's tools change.                                                                                                                                                         |
| `BrowserToolSourceInterface`        | interface | Supplies page-registered tools to a toolset through a contract free of protocol types.                                                                                                                                    |
| `BrowserToolsetEventMap`            | type      | Maps the events a toolset emits.                                                                                                                                                                                          |
| `BrowserToolsetOptions`             | interface | Configures a browser toolset.                                                                                                                                                                                             |
| `BrowserToolsetInterface`           | interface | Publishes the browser vocabulary as tools over one current view and adopts the page's own tools beside them.                                                                                                              |
| `BrowserToolsetHandler`             | type      | Runs one toolset tool inside the toolset's boundary.                                                                                                                                                                      |
| `BrowserToolsetWatch`               | interface | Holds the listeners a toolset attaches to one followed page.                                                                                                                                                              |
| `BrowserReceipt`                    | interface | Describes one tool receipt before rendering.                                                                                                                                                                              |
| `BrowserFrameInfo`                  | interface | Describes serializable frame metadata decoded from CDP `Page.getFrameTree`.                                                                                                                                               |
| `BrowserFrameInterface`             | interface | Provides the operations shared by a top-level page and an iframe document.                                                                                                                                                |
| `BrowserRect`                       | type      | Represents a rectangle in CSS pixels: x, y, width, height.                                                                                                                                                                |
| `BrowserLayout`                     | interface | Describes layout data associated with one captured DOM node.                                                                                                                                                              |
| `BrowserNode`                       | interface | Represents one serializable DOM node decoded from a CDP DOM snapshot.                                                                                                                                                     |
| `BrowserDocument`                   | interface | Represents one document captured in a CDP DOM snapshot.                                                                                                                                                                   |
| `BrowserSnapshotInput`              | interface | Describes the serializable input for a navigable browser snapshot — the form a `BrowserSnapshot` is built from and serializes back to.                                                                                    |
| `BrowserWalkOrder`                  | type      | Names the structural ordering for a browser snapshot walk.                                                                                                                                                                |
| `BrowserWalkOptions`                | interface | Describes the options for walking a browser snapshot.                                                                                                                                                                     |
| `BrowserSiblingRelation`            | type      | Names a structural sibling relationship relative to a browser node.                                                                                                                                                       |
| `BrowserSnapshotInterface`          | interface | Represents a navigable, serializable snapshot of every document attached to a page, extending `BrowserSnapshotInput` with walking, structural relationships, search, and path derivation over plain `BrowserNode` values. |
| `BrowserSnapshotOptions`            | interface | Describes the options configuring capture through `BrowserPageInterface` `snapshot()`. The snapshot entity's creation input is `BrowserSnapshotInput`.                                                                    |
| `BrowserNodePredicate`              | type      | Names the predicate form accepted by `BrowserSnapshotInterface` find, filter, and closest methods.                                                                                                                        |
| `BrowserNodeQuery`                  | interface | Describes a declarative browser-node matcher used by `matchesBrowserNode`.                                                                                                                                                |
| `BrowserPageInterface`              | interface | Abstracts a single top-level browser page, extending `BrowserFrameInterface` with navigation, screenshots, frame discovery, DOM snapshots, codegen, and target teardown.                                                  |
| `BrowserContextInterface`           | interface | Represents an isolated browser session over a CDP browser context.                                                                                                                                                        |

### Server

The Node runtime discovers a browser listening on a CDP port, attaches to it, or launches a Chromium-family process. The following fence probes, connects, and destroys.

```ts
import { createBrowser } from '@orkestrel/browser/server'

const browser = createBrowser({ cdp: { port: 9222 } })
const discovery = await browser.discover() // passive probe, no side effects
await browser.connect() // reuses discovery.endpoint if found, else launches
const ctx = browser.context() // the default context
await browser.destroy() // closes the process and releases resources
```

#### Factories

The following table lists the server factories.

| API                   | Kind     | Summary                                                                                              |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `createBrowser`       | function | Creates a raw-CDP `BrowserInterface` façade with discovery, connection, and lifecycle management.    |
| `createCDPTransport`  | function | Creates a Node `WebSocket`-backed `CDPTransportInterface` for the given CDP debugger URL.            |
| `createBrowserWriter` | function | Creates a filesystem-backed `BrowserWriterInterface` that persists bytes through `node:fs/promises`. |

The following fence builds the Node transport and the filesystem writer that `Browser` composes.

```ts
import { createBrowserWriter, createCDPTransport } from '@orkestrel/browser/server'

const transport = createCDPTransport({ url: 'ws://127.0.0.1:9222/devtools/browser/abc' })
const writer = createBrowserWriter()
await writer.write('shots/hero.png', new Uint8Array([137, 80, 78, 71]))
```

#### Classes

The following table lists the server classes.

| API                     | Kind  | Summary                                                                       |
| ----------------------- | ----- | ----------------------------------------------------------------------------- |
| `Browser`               | class | Discovers, launches, connects to, and owns Chromium-family browser sessions.  |
| `WebSocketCDPTransport` | class | Provides a raw CDP text transport backed by `@orkestrel/websocket`.           |
| `FileBrowserWriter`     | class | Persists captured browser bytes to the filesystem through `node:fs/promises`. |

#### Constants

The following table lists the server constants.

| API                               | Kind  | Summary                                                                                                                                                                                                                          |
| --------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_DEFAULT_CDP_PORT`        | const | Sets the default CDP port probed for an existing browser and used for launches, `9222`.                                                                                                                                          |
| `BROWSER_DEFAULT_HOST`            | const | Sets the default host probed for an existing browser and used for launches, `'127.0.0.1'`, which avoids `localhost` resolving to `::1` when Chromium binds `127.0.0.1`.                                                          |
| `BROWSER_CDP_PROTOCOL`            | const | Names the protocol prefix for CDP discovery requests, `'http'`.                                                                                                                                                                  |
| `BROWSER_CDP_VERSION_PATH`        | const | Names the path appended to the CDP host to fetch version metadata, `'/json/version'`, which is where endpoint discovery reads.                                                                                                   |
| `BROWSER_CDP_LIST_PATH`           | const | Names the path appended to the CDP host to list open targets — pages, workers, and every other target category Chromium reports — `'/json/list'`.                                                                                |
| `BROWSER_LAUNCH_ARGS`             | const | Lists the flags always passed to a launched browser process, alongside the caller's own.                                                                                                                                         |
| `BROWSER_HEADLESS_ARG`            | const | Names the flag that enables headless mode on a launched browser process, `'--headless=new'`.                                                                                                                                     |
| `BROWSER_PROFILE_PREFIX`          | const | Names the prefix for isolated browser profiles created beneath the operating-system temp directory, `'orkestrel-browser-'`.                                                                                                      |
| `BROWSER_KILL_GRACE_MS`           | const | Bounds each launched-process exit window during TERM-to-KILL teardown at `3_000` milliseconds.                                                                                                                                   |
| `BROWSER_PORT_PROBE_TIMEOUT_MS`   | const | Bounds the `discover: false` port-occupancy probe before launching at `200` milliseconds, which is short because the probe only needs to detect an already-listening CDP endpoint rather than perform full discovery.            |
| `BROWSER_DEVTOOLS_PATTERN`        | const | Matches the stderr line Chromium prints when its CDP endpoint accepts connections, and captures the `ws://` endpoint the line names.                                                                                             |
| `BROWSER_DRAIN_INTERVAL_MS`       | const | Sets the interval in milliseconds between liveness probes of a terminated browser process group.                                                                                                                                 |
| `BROWSER_TRANSPORT_LOSS_DEFER_MS` | const | Defers once for `50` milliseconds when a transport loss is observed on an owned process, giving a near-simultaneous process-exit event, which libuv may reap slightly later than the socket close, first say over the diagnosis. |
| `BROWSER_PROCESS_EXIT_CAUSE`      | const | Names the machine-readable error-context cause for an owned browser process exiting, `'process-exit'`.                                                                                                                           |
| `BROWSER_TRANSPORT_LOSS_CAUSE`    | const | Names the machine-readable error-context cause for a CDP transport disconnecting while its browser remains alive, `'transport-loss'`.                                                                                            |
| `BROWSER_ENV_PATH_KEYS`           | const | Lists the environment variables checked, in order, for an explicit browser executable path override: `PLAYWRIGHT_EXECUTABLE_PATH`, then `CHROME_PATH`.                                                                           |
| `BROWSER_EXECUTABLE_PATHS`        | const | Lists the well-known Chrome/Chromium/Edge executable paths with no platform-specific root, keyed by `process.platform`, leaving `win32` empty because its roots come from `BROWSER_WINDOWS_SUFFIXES`.                            |
| `BROWSER_WINDOWS_SUFFIXES`        | const | Lists the Windows install-root-relative suffixes for Chrome/Edge/Chromium, joined against each candidate root (`PROGRAMFILES`, `PROGRAMFILES(X86)`, `LOCALAPPDATA`).                                                             |
| `BROWSER_WINDOWS_ROOT_FALLBACKS`  | const | Lists the fallback Windows install roots used when `PROGRAMFILES`, `PROGRAMFILES(X86)`, or `LOCALAPPDATA` is absent.                                                                                                             |
| `BROWSER_EXECUTABLE_NAMES`        | const | Lists the command names probed on PATH when no well-known executable path exists.                                                                                                                                                |
| `BROWSER_STORE_ENV_KEY`           | const | Names the environment variable that carries an additional Playwright browser store base directory, `'PLAYWRIGHT_BROWSERS_PATH'`.                                                                                                 |
| `BROWSER_STORE_DEFAULT_DIRS`      | const | Lists the well-known Playwright browser store base directories checked in addition to `PLAYWRIGHT_BROWSERS_PATH`, starting with `/opt/pw-browsers`.                                                                              |
| `BROWSER_STORE_CACHE_DIRS`        | const | Names the per-OS default Playwright browser cache directory, relative to the home directory (win32 uses `LOCALAPPDATA` directly).                                                                                                |
| `BROWSER_STORE_LINK_NAME`         | const | Names the top-level Chromium symlink or binary Playwright maintains inside a browser store base, `'chromium'`.                                                                                                                   |
| `BROWSER_ENGINE_HINTS`            | const | Lists the case-insensitive substrings identifying an executable path/name's browser engine, checked by `parseBrowserEngine` in the order `edge` → `chromium` → `chrome`.                                                         |
| `BROWSER_STORE_GLOBS`             | const | Names the glob pattern (relative to a store base) matching a versioned Chromium binary, keyed by `process.platform`.                                                                                                             |

#### Errors

The following table lists the server errors and their guards; `BrowserConnectionError` is a core error, because the in-page transport throws it too.

| API                          | Kind     | Summary                                                                                                                                  |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserNotConnectedError`   | class    | Reports that an operation requiring an active connection was attempted while disconnected, under the code `BROWSER_NOT_CONNECTED_ERROR`. |
| `BrowserDestroyedError`      | class    | Reports that an operation was attempted after the browser wrapper was destroyed, under the code `BROWSER_DESTROYED_ERROR`.               |
| `isBrowserNotConnectedError` | function | Narrows an unknown value to a `BrowserNotConnectedError`.                                                                                |
| `isBrowserDestroyedError`    | function | Narrows an unknown value to a `BrowserDestroyedError`.                                                                                   |

The following fence narrows a failed connection.

```ts
import { isBrowserConnectionError } from '@orkestrel/browser'
import { isBrowserDestroyedError, isBrowserNotConnectedError } from '@orkestrel/browser/server'

try {
	await browser.connect()
} catch (error) {
	if (isBrowserConnectionError(error)) log(error.code, error.context)
	else if (isBrowserNotConnectedError(error)) log(error.code)
	else if (isBrowserDestroyedError(error)) log(error.code)
}
```

#### Helpers

The following table lists the server helpers.

| API                       | Kind     | Summary                                                                                                                                                    |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findSystemBrowsers`      | function | Enumerates every Chrome/Chromium/Edge executable discoverable on this machine, deduplicated by normalized absolute path.                                   |
| `findSystemBrowser`       | function | Locates a Chrome/Chromium/Edge executable on this machine — the first entry of `findSystemBrowsers`.                                                       |
| `parseBrowserEngine`      | function | Classifies an executable path/name into a `BrowserEngine` by case-insensitive hint, checked in the order edge → chromium → chrome.                         |
| `normalizeExecutablePath` | function | Normalizes an executable path for cross-source deduplication (case-insensitive on Windows).                                                                |
| `browserToEngine`         | function | Classifies a `/json/version` `Browser` string into a `BrowserEngine` (`Edg/` → edge, `Chrome/` → chrome, else chromium).                                   |
| `createBrowserProfile`    | function | Resolves a persistent caller profile or creates an isolated temporary one.                                                                                 |
| `removeBrowserProfile`    | function | Removes a library-owned isolated browser profile.                                                                                                          |
| `findEnvOverrides`        | function | Checks the env-override keys (`PLAYWRIGHT_EXECUTABLE_PATH`, `CHROME_PATH`) in order and returns every one that exists.                                     |
| `buildInstallPaths`       | function | Builds the default well-known install-path candidates for a platform, deriving Windows roots from env vars.                                                |
| `buildWindowsRoots`       | function | Derives Windows install roots from env vars, falling back to well-known literals when absent.                                                              |
| `findInstallPaths`        | function | Returns every candidate path that exists on disk, in the given order.                                                                                      |
| `probePathNames`          | function | Probes PATH (`which`/`where`) for every resolvable command name, in the given order.                                                                       |
| `readFirstLine`           | function | Returns the first non-empty line of a command's output, without its surrounding whitespace.                                                                |
| `buildStoreBases`         | function | Builds the default Playwright browser store base directories to search for a managed Chromium.                                                             |
| `findStorePaths`          | function | Searches one store base for the top-level `chromium` link and every `chromium-*` install, highest revision first.                                          |
| `launchBrowserProcess`    | function | Launches a browser process with raw-CDP debugging flags.                                                                                                   |
| `readBrowserEndpoint`     | function | Reads the CDP endpoint a launched browser announces on its standard error.                                                                                 |
| `fetchCDPTargets`         | function | Fetches the current CDP target list from a browser's `/json/list` endpoint, as a `Result` carrying either the targets or a coded `BrowserConnectionError`. |

The following fence composes system-browser discovery, a launch, and the endpoint read that replaces HTTP readiness polling.

```ts
import {
	browserToEngine,
	buildInstallPaths,
	buildStoreBases,
	buildWindowsRoots,
	createBrowserProfile,
	fetchCDPTargets,
	findEnvOverrides,
	findInstallPaths,
	findStorePaths,
	findSystemBrowser,
	findSystemBrowsers,
	launchBrowserProcess,
	normalizeExecutablePath,
	parseBrowserEngine,
	probePathNames,
	readBrowserEndpoint,
	readFirstLine,
	removeBrowserProfile,
} from '@orkestrel/browser/server'

const browsers = findSystemBrowsers() // readonly SystemBrowser[]
const found = findSystemBrowser() // SystemBrowser | undefined — first entry of findSystemBrowsers()
// findSystemBrowsers({ env: {}, paths: [], names: [], stores: [], engine: 'edge' }) — override any candidate source, narrow by engine

parseBrowserEngine('/usr/bin/msedge') // 'edge'
normalizeExecutablePath('/usr/bin/Chrome', process.platform) // string — case-folded on win32 only
browserToEngine('HeadlessChrome/120.0') // 'chrome' — classifies a /json/version Browser string
const profile = await createBrowserProfile()
await removeBrowserProfile(profile)

// The resolution steps findSystemBrowsers composes:
const env = process.env
findEnvOverrides(env) // readonly string[] — every matching override that exists
const roots = buildWindowsRoots(env) // readonly string[] — PROGRAMFILES / PROGRAMFILES(X86) / LOCALAPPDATA
buildInstallPaths('win32', env) // readonly string[] — well-known Chrome/Edge/Chromium paths
findInstallPaths(buildInstallPaths(process.platform, env)) // readonly string[]
probePathNames(['google-chrome', 'msedge'], process.platform) // readonly string[]
readFirstLine('C:\\bin\\chrome.exe\r\nC:\\other\\chrome.exe\r\n') // 'C:\\bin\\chrome.exe' — CRLF-safe
const stores = buildStoreBases(env, process.platform) // readonly string[]
for (const store of stores) findStorePaths(store, process.platform) // readonly string[]
if (found !== undefined) {
	const child = launchBrowserProcess(found.executable, undefined, true) // --remote-debugging-port=0
	const endpoint = await readBrowserEndpoint(child.stderr, AbortSignal.timeout(30_000)) // 'ws://127.0.0.1:PORT/devtools/browser/ID'
	const targets = await fetchCDPTargets(Number(new URL(endpoint).port), 5_000) // Result<readonly CDPTarget[], BrowserError>
}
```

#### Types

The following table lists the server types.

| API                            | Kind      | Summary                                                                                         |
| ------------------------------ | --------- | ----------------------------------------------------------------------------------------------- |
| `BrowserEngine`                | type      | Names a supported browser engine (raw CDP targets Chromium-family browsers only).               |
| `BrowserConnection`            | type      | Names how the browser connection was established.                                               |
| `BrowserStatus`                | type      | Names the lifecycle status of a browser wrapper.                                                |
| `BrowserDiscoveryResult`       | interface | Describes the result of passive browser discovery.                                              |
| `SystemBrowserOptions`         | interface | Describes the options overriding `findSystemBrowsers`'/`findSystemBrowser`'s candidate sources. |
| `SystemBrowser`                | type      | Represents one discovered browser executable on this machine.                                   |
| `BrowserProfileResult`         | interface | Describes the resolved browser profile directory used for a Chromium-family launch.             |
| `BrowserCDPOptions`            | interface | Configures the CDP (Chrome DevTools Protocol) connection.                                       |
| `BrowserEventMap`              | type      | Maps the events a `BrowserInterface` emits.                                                     |
| `BrowserOptions`               | interface | Describes the options for creating a `Browser` instance.                                        |
| `BrowserInterface`             | interface | Wraps a browser with discovery, connection management, and lifecycle control.                   |
| `WebSocketCDPTransportOptions` | interface | Describes the options for creating a `WebSocketCDPTransport` instance.                          |

### Browser

The in-page face drives a DOM document from a realm that survives that document's navigation: a page driving a same-origin `iframe` it owns or a window it opened, or an extension page driving a document through a content script it can re-create. Its view is untrusted: `view.trusted` is `false`, every event an action dispatches itself carries `isTrusted` `false`, and no action grants user activation. The following fence drives a child document and carries the core client over the browser's `WebSocket`.

```ts
import { createCDPClient } from '@orkestrel/browser'
import {
	createBrowserDOMView,
	createDocumentToolset,
	createSocketCDPTransport,
} from '@orkestrel/browser/browser'

const frame = document.createElement('iframe')
document.body.append(frame)
const view = createBrowserDOMView({ document: frame.contentDocument })
await view.elements.outline() // { text: 'page "" about:blank\n(0 of 0 elements)', … }
view.destroy()

const toolset = createDocumentToolset({ document: frame.contentDocument })
await toolset.start()
toolset.tools.tools().map((tool) => tool.name) // ['look', 'read', 'click', 'type', 'wait']

const client = createCDPClient({
	transport: createSocketCDPTransport({ url: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
})
await client.connect() // the browser was started with --remote-allow-origins naming this origin
```

#### Factories

The following table lists the in-page factories.

| API                        | Kind     | Summary                                                                                                                                  |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `createBrowserDOMView`     | function | Creates a view that reads and drives a DOM document without trusted input.                                                               |
| `createDocumentToolset`    | function | Creates a `BrowserToolsetInterface` that publishes the five view tools over a DOM document and adopts a source's page tools beside them. |
| `createSocketCDPTransport` | function | Creates a CDP transport over the browser's native `WebSocket`.                                                                           |

#### Classes

The following table lists the in-page classes. `BrowserDOMView` implements `BrowserDOMViewInterface`, `BrowserDOMElement` implements `BrowserDOMElementInterface`, `BrowserDOMElementManager` implements `BrowserElementManagerInterface`, `BrowserDOMWait` implements `BrowserDOMWaitInterface`, and `SocketCDPTransport` implements `CDPTransportInterface`.

| API                        | Kind  | Summary                                                                                        |
| -------------------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `BrowserDOMView`           | class | Reads and drives a DOM document from a realm that can reach it, without trusted input.         |
| `BrowserDOMWait`           | class | Parks one condition on DOM mutations until it holds, with one deadline and no other timer.     |
| `BrowserDOMElement`        | class | Drives a referenced element of a DOM document without trusted input.                           |
| `BrowserDOMElementManager` | class | Outlines a DOM document from its elements and binds stable references to the interactive ones. |
| `SocketCDPTransport`       | class | Provides a raw CDP text transport over the browser's native `WebSocket`.                       |

#### Constants

The following table lists the in-page constants.

| API                           | Kind  | Summary                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_DOCUMENT_TIMEOUT_MS` | const | Sets the default `wait` deadline for DOM waits in a browser document toolset, `5_000` milliseconds.                                                                                                                                                                                                                                                         |
| `BROWSER_IMPLICIT_ROLES`      | const | Maps an HTML element to the ARIA role the HTML Accessibility API Mappings specification gives it when it carries no `role` attribute.                                                                                                                                                                                                                       |
| `BROWSER_CONTENT_NAMED_ROLES` | const | Names the ARIA roles whose accessible name the accessible-name computation takes from the element's content when no attribute or label names it.                                                                                                                                                                                                            |
| `BROWSER_CONTEXT_TARGETS`     | const | Names the link and form targets that navigate the current browsing context or one of its ancestors. `_blank` opens another browsing context, and any other name targets the browsing context carrying that name, which `matchesBrowserPopup` resolves.                                                                                                      |
| `BROWSER_TYPED_INPUTS`        | const | Names the `input` type states whose value an untrusted `fill` sets as typed text.                                                                                                                                                                                                                                                                           |
| `BROWSER_INTERACTIVE_CONTENT` | const | Selects the HTML interactive content a click inside a `label` can land on without activating the label, as the HTML interactive-content category lists it: `a` with `href`, `audio` and `video` with `controls`, `button`, `details`, `embed`, `iframe`, `img` with `usemap` or `controls`, `input` other than `hidden`, `label`, `select`, and `textarea`. |

#### Errors

The in-page face declares no error class. It throws the core's coded errors: `BrowserElementError` for an element refusal, `BrowserConnectionError` from `SocketCDPTransport`, and `BrowserError` with the codes `BROWSER_DOCUMENT`, `BROWSER_DOCUMENT_OWN`, and `BROWSER_DOCUMENT_DESTROYED` for a document the view refuses or a view that was destroyed. The core guards in [Errors](#errors) narrow each one.

#### Helpers

The helpers compute the accessible role, name, and text of an element and the visibility rules the outline applies. The following table lists them.

| API                         | Kind     | Summary                                                                                                                                                                                                                                           |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isBrowserDocument`         | function | Narrows a value to a `Document` attached to a window.                                                                                                                                                                                             |
| `computeBrowserRole`        | function | Computes the ARIA role of an element from its `role` attribute or its implicit mapping.                                                                                                                                                           |
| `computeBrowserName`        | function | Computes the accessible name of an element, trimmed and whitespace-collapsed.                                                                                                                                                                     |
| `computeBrowserText`        | function | Computes the text an element's content contributes to an accessible name, in the flat tree, trimmed and whitespace-collapsed.                                                                                                                     |
| `readBrowserContent`        | function | Reads the untrimmed text an element's content contributes to an accessible name, in the flat tree.                                                                                                                                                |
| `computeBrowserAlternative` | function | Computes the text one node contributes to an accessible name: its own text alternative, or its content.                                                                                                                                           |
| `matchesBrowserHidden`      | function | Checks whether an element and its subtree are hidden from the rendered page.                                                                                                                                                                      |
| `matchesBrowserInvisible`   | function | Checks whether an element renders nothing visible of its own.                                                                                                                                                                                     |
| `matchesBrowserOmitted`     | function | Checks whether an element sits in an omitted subtree: the element or a flat-tree ancestor that `readBrowserParent` reaches matches `matchesBrowserHidden`, through assigned slots, shadow hosts, and the frame elements of same-origin documents. |
| `readBrowserParent`         | function | Reads an element's parent in the flat tree: the slot it is assigned to in an open shadow root, its parent element, the host of the open shadow root it sits at the top of, or the frame element of its same-origin document.                      |
| `matchesBrowserBlock`       | function | Checks whether an element starts a block of its own, the unit that separates runs of text.                                                                                                                                                        |
| `collectBrowserRoots`       | function | Collects the tree roots a wait observes under a node: the node's own root, then every open shadow root and every same-origin frame document at or beneath it, recursively.                                                                        |
| `matchesBrowserPopup`       | function | Checks whether activating an element opens another browsing context.                                                                                                                                                                              |
| `matchesBrowserActivation`  | function | Checks whether a click on an element activates the `label` that contains it, following the HTML label activation rule.                                                                                                                            |
| `skipBrowserSubtree`        | function | Moves a tree walker past the subtree of its current node.                                                                                                                                                                                         |
| `readBrowserBlock`          | function | Reads the nearest block container of an element, the unit that separates runs of text.                                                                                                                                                            |
| `listenBrowserNavigation`   | function | Subscribes one listener to a window's navigation events until a signal aborts.                                                                                                                                                                    |

The following fence reads one button the page appends to its own document.

```ts
import {
	collectBrowserRoots,
	computeBrowserAlternative,
	computeBrowserName,
	computeBrowserRole,
	computeBrowserText,
	isBrowserDocument,
	listenBrowserNavigation,
	matchesBrowserActivation,
	matchesBrowserBlock,
	matchesBrowserHidden,
	matchesBrowserInvisible,
	matchesBrowserOmitted,
	matchesBrowserPopup,
	readBrowserBlock,
	readBrowserContent,
	readBrowserParent,
	skipBrowserSubtree,
} from '@orkestrel/browser/browser'

const button = document.createElement('button')
button.textContent = 'Save'
document.body.append(button)
if (isBrowserDocument(document)) {
	computeBrowserRole(button) // 'button'
	computeBrowserName(button) // 'Save'
	computeBrowserText(button) // 'Save'
	readBrowserContent(button) // the content that names the element
	computeBrowserAlternative(button.firstChild ?? button) // 'Save'
	matchesBrowserHidden(button) // false
	matchesBrowserInvisible(button) // false
	matchesBrowserOmitted(button) // false
	matchesBrowserBlock(button) // false — an inline-block box is inline
	readBrowserBlock(button, document) // the nearest block ancestor
	readBrowserParent(button) // the parent element, an assigned slot first
	matchesBrowserPopup(button) // whether activating it opens another browsing context
	collectBrowserRoots(document) // the document and every open shadow root and same-origin frame document under it
	const label = button.closest('label')
	if (label !== null) matchesBrowserActivation(button, label)
	const walker = document.createTreeWalker(document.body)
	skipBrowserSubtree(walker) // the node after the current subtree, or null
	const lifetime = new AbortController()
	listenBrowserNavigation(window, () => log('navigated'), lifetime.signal)
}
```

#### Types

The following table lists the in-page types.

| API                             | Kind      | Summary                                                                                 |
| ------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `BrowserDocumentOptions`        | interface | Configures a view that drives one browser document.                                     |
| `BrowserDocumentToolsetOptions` | interface | Configures a toolset that drives one browser document.                                  |
| `BrowserNameContext`            | interface | Carries the accessible-name traversal context.                                          |
| `BrowserDOMElementInterface`    | interface | Provides DOM actions through a stable element reference, without trusted input.         |
| `BrowserDOMViewInterface`       | interface | Provides the document operations of a view that drives a DOM document in its own realm. |
| `BrowserDOMElementManagerInput` | interface | Binds a DOM element manager to the view that owns it.                                   |
| `BrowserDOMElementInput`        | interface | Binds a DOM element to its reference and the manager that minted it.                    |
| `BrowserMutationWait`           | interface | Describes one wait parked on DOM mutations.                                             |
| `BrowserDOMWaitInterface`       | interface | Settles one wait parked on DOM mutations.                                               |
| `SocketCDPTransportOptions`     | interface | Configures a CDP transport over the browser's `WebSocket`.                              |

## Methods

The public methods of each behavioral interface follow, one table per interface; each interface's `readonly` data members stay in its Surface row. The implementing classes and the interfaces they implement are:

- `CDPClient` ↔ `CDPClientInterface`, and `WebSocketCDPTransport` (server) and `SocketCDPTransport` (in-page) ↔ `CDPTransportInterface`;
- `BrowserContext` ↔ `BrowserContextInterface`, `BrowserFrame` ↔ `BrowserFrameInterface`, and `BrowserPage` ↔ `BrowserPageInterface`, which extends both `BrowserFrameInterface` and `BrowserViewInterface`;
- `BrowserElementManager` (core) and `BrowserDOMElementManager` (in-page) ↔ `BrowserElementManagerInterface`, `BrowserElement` ↔ `BrowserPageElementInterface`, and `BrowserDOMElement` ↔ `BrowserDOMElementInterface`, both extending `BrowserElementInterface`;
- `BrowserReading` ↔ `BrowserReadingInterface`, `BrowserRegistry` ↔ `BrowserRegistryInterface`, which also satisfies `BrowserToolSourceInterface`, and `BrowserToolset` ↔ `BrowserToolsetInterface`;
- `BrowserDOMView` ↔ `BrowserDOMViewInterface`, which extends `BrowserViewInterface`, and `BrowserDOMWait` ↔ `BrowserDOMWaitInterface`;
- `BrowserSnapshot` ↔ `BrowserSnapshotInterface`, `BrowserCodegen` ↔ `BrowserCodegenInterface`, `BrowserTransition` ↔ `BrowserTransitionInterface`, and `Browser` ↔ `BrowserInterface`;
- `BrowserWebSocket` ↔ `BrowserWebSocketInterface`, `BrowserDownload` ↔ `BrowserDownloadInterface`, `FileBrowserWriter` ↔ `BrowserWriterInterface`, `BrowserNavigationManager` ↔ `BrowserNavigationManagerInterface`, and `BrowserHandle` ↔ `BrowserHandleInterface`;
- `BrowserScriptManager` ↔ `BrowserScriptManagerInterface`, `BrowserAccessibility` ↔ `BrowserAccessibilityInterface`, `BrowserTracing` ↔ `BrowserTracingInterface`, `BrowserCoverage` ↔ `BrowserCoverageInterface`, `BrowserPerformance` ↔ `BrowserPerformanceInterface`, `BrowserProfiler` ↔ `BrowserProfilerInterface`, `BrowserDiagnostics` ↔ `BrowserDiagnosticsInterface`, and `BrowserClock` ↔ `BrowserClockInterface`;
- `BrowserKeyboard` ↔ `BrowserKeyboardInterface`, `BrowserMouse` ↔ `BrowserMouseInterface`, `BrowserTouch` ↔ `BrowserTouchInterface`, `BrowserDialog` ↔ `BrowserDialogInterface`, `BrowserFileChooser` ↔ `BrowserFileChooserInterface`, and `BrowserWorker` ↔ `BrowserWorkerInterface`;
- `BrowserRoute` ↔ `BrowserRouteInterface`, `BrowserHARManager` ↔ `BrowserHARManagerInterface`, `BrowserNetworkManager` ↔ `BrowserNetworkManagerInterface`, `BrowserCookieManager` ↔ `BrowserCookieManagerInterface`, `BrowserPermissionManager` ↔ `BrowserPermissionManagerInterface`, `BrowserStorageManager` ↔ `BrowserStorageManagerInterface`, and `BrowserEmulationManager` ↔ `BrowserEmulationManagerInterface`.

An interface that extends another repeats every inherited member in its own table, so each table lists the whole callable surface of its interface. `BrowserElementInterface` has no table of its own: its members `click`, `fill`, `select`, `focus`, `read`, and `submit`, which both placements share, are rows of the [`BrowserPageElementInterface`](#browserpageelementinterface) table, and `BrowserDOMElementInterface` adds nothing to them.

#### `CDPTransportInterface`

The text pipe a `CDPClient` sends and receives JSON-RPC frames over. `WebSocketCDPTransport` implements it over a Node `WebSocket`, and `SocketCDPTransport` over the browser's own.

| Method  | Returns         | Summary                                                                                                                                                                       |
| ------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start` | `Promise<void>` | Opens the underlying connection.                                                                                                                                              |
| `send`  | `Promise<void>` | Writes one raw text frame to the connection. Throws a coded `BrowserConnectionError` carrying the transport `url` when called before the connection opens or after it closes. |
| `close` | `Promise<void>` | Closes the underlying connection and releases its resources.                                                                                                                  |

```ts
transport.emitter.on('message', (data) => log(data))
await transport.start()
await transport.send('{"id":1,"method":"Target.getTargets"}')
await transport.close()
```

#### `CDPClientInterface`

Frames JSON-RPC-shaped CDP method calls and events over an injected
`CDPTransportInterface`. `connect` starts the transport and begins
dispatching; `send` issues a CDP method call, taking its session, per-call
timeout, and abort signal in a trailing `CDPSendOptions`; `emitter` reports the client's own
`connect` / `close` / `drop` / `error` transitions;
`subscribe` / `unsubscribe` register or remove a handler for a CDP event
(optionally session-scoped). Subscriptions are client-level registrations,
not connection-level state — they survive `close()` and a subsequent
`reconnect()` / `connect()`, and resume firing after the client reconnects. Calling
`close()` while a `connect()` is still in flight rejects that in-flight
connect attempt.

| Method        | Returns            | Summary                                                                                                                                                                                                                                         |
| ------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`     | `Promise<void>`    | Starts the transport and begins dispatching. Idempotent.                                                                                                                                                                                        |
| `reconnect`   | `Promise<void>`    | Closes the transport and re-establishes it.                                                                                                                                                                                                     |
| `send`        | `Promise<unknown>` | Issues a CDP method call with optional params and a trailing `CDPSendOptions` carrying the `session` to scope it to, a per-call `timeout` overriding the client-wide default, and a `signal` that aborts the call; rejects on timeout or abort. |
| `subscribe`   | `void`             | Registers a handler for a CDP event, optionally session-scoped.                                                                                                                                                                                 |
| `unsubscribe` | `void`             | Removes a handler for a CDP event, optionally session-scoped.                                                                                                                                                                                   |
| `close`       | `Promise<void>`    | Tears down the transport and rejects every pending request.                                                                                                                                                                                     |

```ts
import { createCDPClient } from '@orkestrel/browser'

const client = createCDPClient({ transport })
await client.connect()
const targets = await client.send('Target.getTargets')
const version = await client.send('Browser.getVersion', undefined, {
	signal: AbortSignal.timeout(2_000),
})
const onCreated = (params) => log(params)
client.subscribe('Target.targetCreated', onCreated)
client.unsubscribe('Target.targetCreated', onCreated)
await client.reconnect()
await client.close()
```

#### `BrowserContextInterface`

An isolated browser session over a CDP browser context; follows the manager
accessor pattern (`page(index?)` / `pages()`).

| Method    | Returns                             | Summary                                                                                                                                                                                                                                                                                          |
| --------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `page`    | `BrowserPageInterface \| undefined` | Returns one page by index, or the first page.                                                                                                                                                                                                                                                    |
| `pages`   | `readonly BrowserPageInterface[]`   | Returns every page in creation order.                                                                                                                                                                                                                                                            |
| `create`  | `Promise<BrowserPageInterface>`     | Opens a page in this context.                                                                                                                                                                                                                                                                    |
| `sync`    | `Promise<void>`                     | Synchronizes pages from the given CDP targets, which the server discovers and core never fetches. Performs a destructive diff rather than an additive merge: a page whose target id is missing from `targets` is closed and dropped, and a target that is not yet tracked is attached and added. |
| `destroy` | `Promise<void>`                     | Releases local pages and detaches their sessions without disposing the remote browser context.                                                                                                                                                                                                   |
| `close`   | `Promise<void>`                     | Closes remote pages, disposes the remote browser context, and releases local resources.                                                                                                                                                                                                          |

```ts
const ctx = browser.context()
const page = await ctx?.create({ url: 'https://example.com' })
const all = ctx?.pages() // readonly BrowserPageInterface[]
await ctx?.sync(targets) // reconcile pages from discovered CDP targets
await ctx?.destroy() // local detach
```

#### `BrowserFrameInterface`

Operations shared by a top-level page and an iframe document. Every asynchronous member takes a trailing `BrowserCallOptions` carrying `timeout` and `signal`. `evaluate` runs in the page's main world; `read` and the element managers run in one isolated world per document, which the page drops on `Runtime.executionContextDestroyed` and `Runtime.executionContextsCleared` and creates again on the next call. A child frame follows its attached out-of-process session when Chromium splits the frame into another target.

| Method        | Returns                            | Summary                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | `Promise<string>`                  | Resolves the frame document title.                                                                                                                                                                                                                                                                                                                                                    |
| `read`        | `Promise<BrowserReadingInterface>` | Captures the document URL, title, and HTML in one size-guarded evaluation in the frame's isolated world and returns them as a reading whose `stale` flag tracks later navigations. A frame constructed without an epoch source (a standalone `BrowserFrame` with no `epoch` argument) returns readings whose `stale` stays `false`, because no navigation counter is available to it. |
| `evaluate`    | `Promise<unknown>`                 | Evaluates an expression in the frame execution world under the result-size guard.                                                                                                                                                                                                                                                                                                     |
| `handle`      | `Promise<BrowserHandleInterface>`  | Evaluates an expression by reference and returns a disposable remote object handle.                                                                                                                                                                                                                                                                                                   |
| `send`        | `Promise<unknown>`                 | Issues a raw CDP method in the frame's current target session, with a trailing `BrowserCallOptions` carrying a per-call `timeout` overriding the client-wide default and a `signal` that aborts the call.                                                                                                                                                                             |
| `subscribe`   | `Promise<void>`                    | Subscribes to a CDP event in the frame's current target session.                                                                                                                                                                                                                                                                                                                      |
| `unsubscribe` | `Promise<void>`                    | Removes a frame-session CDP event subscription.                                                                                                                                                                                                                                                                                                                                       |
| `save`        | `Promise<void>`                    | Persists bytes through a page writer; a child frame rejects because it owns no writer.                                                                                                                                                                                                                                                                                                |
| `assert`      | `void`                             | Throws a coded `BrowserError` when the frame can no longer accept protocol work: a frame throws once the CDP client disconnects, and a page also throws once it closes. Every other member here calls it first.                                                                                                                                                                       |
| `update`      | `void`                             | Records an externally observed URL as the frame's current `url`, which a page calls from its own `Page.frameNavigated` handler.                                                                                                                                                                                                                                                       |

```ts
const child = await page.frame('checkout')
const title = await child?.title()
const result = await child?.evaluate('document.readyState', { timeout: 2_000 })
const reading = await child?.read() // BrowserReadingInterface
const handle = await child?.handle('document.body')
await handle?.dispose()
const onLoad = () => log('loaded')
await child?.subscribe('Page.loadEventFired', onLoad)
await child?.unsubscribe('Page.loadEventFired', onLoad)
const root = await child?.send('DOM.getDocument')
const tree = await child?.send('DOM.getDocument', { depth: 1 }, { timeout: 5_000 })
await page.save('./artifact.bin', new Uint8Array([1, 2, 3]))
child?.assert() // throws once the client disconnects, or the page closes
child?.update('https://example.com/checkout') // record a URL observed elsewhere
```

#### `BrowserViewInterface`

The document operations a remote page and a DOM view share, and the contract a `BrowserToolset` drives. `trusted` is `true` for a `BrowserPage` and `false` for a `BrowserDOMView`, and `elements` is the view's element manager.

| Method  | Returns                            | Summary                                                                                                                                                         |
| ------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title` | `Promise<string>`                  | Resolves the document title.                                                                                                                                    |
| `read`  | `Promise<BrowserReadingInterface>` | Captures the document URL, title, and markup as a reading whose `stale` flag tracks later navigations.                                                          |
| `wait`  | `Promise<void>`                    | Resolves when `text` is visible in the document; rejects with a `BrowserError` coded `BROWSER_WAIT_TIMEOUT` at the deadline, and with `signal.reason` on abort. |

The following fence drives a view without knowing its placement.

```ts
async function summarize(view: BrowserViewInterface): Promise<string> {
	await view.wait('Order placed', { timeout: 5_000 })
	const reading = await view.read()
	return `${await view.title()}: ${reading.markdown({ limit: 200 }).text}`
}
```

#### `BrowserPageInterface`

A top-level page. It extends `BrowserFrameInterface` and `BrowserViewInterface`, so its table lists its own operations first and then every inherited member. `trusted` is the constant `true`; `keyboard`, `mouse`, and `touch` dispatch on the page session, whose coordinates Chromium routes into out-of-process frames; and `frames()` lists the frame tree together with every attached out-of-process frame target. The page emits `navigate` with `[url, same]`, `same` being `true` for a same-document navigation, `session` when an out-of-process frame's session attaches, and `popup` for each page it opens.

A page constructed through a context, which passes it a reference allocator, holds its target on the client's connection until it closes, that connection ends, or its setup fails, and the first such page on a connection enables target discovery for it through `Target.setDiscoverTargets`. A second live page for a target another page holds is refused with `BROWSER_TARGET_HELD`. A page constructed directly, as `new BrowserPage(client, target, session)`, holds no target, enables no discovery, and counts as published when its setup completes. A context's `create()` that meets a page another path published for its target joins that page: it applies its `on` hooks, `viewport`, and `url` to that page and resolves with it, and it rejects with `BROWSER_PAGE_CLOSED` when that page closed. A discovered popup is published once, after its opener, through the opener's `popup`, the context's `page` event, and `pages()`. When the page holding a popup's target fails its setup, discovery publishes nothing and attaches nothing; a later `sync()` adds the target as a page, and the opener emits no `popup` for it.

| Method        | Returns                                       | Summary                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait`        | `Promise<void>`                               | Waits for visible text in the main document, rejecting at the deadline or on abort.                                                                                                                                                                                                                                                                                                   |
| `navigate`    | `Promise<BrowserNavigationResult>`            | Goes to a URL, waits for the requested load condition, and returns the final URL with its response correlation.                                                                                                                                                                                                                                                                       |
| `reload`      | `Promise<BrowserNavigationResult>`            | Reloads the page and returns the final URL with its response correlation.                                                                                                                                                                                                                                                                                                             |
| `back`        | `Promise<BrowserNavigationResult>`            | Navigates to the previous history entry, or returns the unchanged URL when none exists.                                                                                                                                                                                                                                                                                               |
| `forward`     | `Promise<BrowserNavigationResult>`            | Navigates to the next history entry, or returns the unchanged URL when none exists.                                                                                                                                                                                                                                                                                                   |
| `screenshot`  | `Promise<BrowserScreenshotResult>`            | Captures PNG or JPEG bytes, optionally full-page and persisted through an injected writer.                                                                                                                                                                                                                                                                                            |
| `pdf`         | `Promise<BrowserPDFResult>`                   | Prints the page to PDF bytes, optionally persisted through the injected writer.                                                                                                                                                                                                                                                                                                       |
| `frame`       | `Promise<BrowserFrameInterface \| undefined>` | Looks up a first-class frame by name or URL.                                                                                                                                                                                                                                                                                                                                          |
| `frames`      | `Promise<readonly BrowserFrameInterface[]>`   | Decodes the flattened frame tree, main frame first.                                                                                                                                                                                                                                                                                                                                   |
| `snapshot`    | `Promise<BrowserSnapshotInterface>`           | Captures and decodes every attached document, shadow root, template content, layout box, and requested computed style.                                                                                                                                                                                                                                                                |
| `codegen`     | `Promise<BrowserCodegenInterface>`            | Starts the action recorder, or returns the running one.                                                                                                                                                                                                                                                                                                                               |
| `destroy`     | `Promise<void>`                               | Releases local resources and detaches without closing the remote target.                                                                                                                                                                                                                                                                                                              |
| `close`       | `Promise<void>`                               | Closes the remote target and releases its resources.                                                                                                                                                                                                                                                                                                                                  |
| `title`       | `Promise<string>`                             | Resolves the frame document title.                                                                                                                                                                                                                                                                                                                                                    |
| `read`        | `Promise<BrowserReadingInterface>`            | Captures the document URL, title, and HTML in one size-guarded evaluation in the frame's isolated world and returns them as a reading whose `stale` flag tracks later navigations. A frame constructed without an epoch source (a standalone `BrowserFrame` with no `epoch` argument) returns readings whose `stale` stays `false`, because no navigation counter is available to it. |
| `evaluate`    | `Promise<unknown>`                            | Evaluates an expression in the frame execution world under the result-size guard.                                                                                                                                                                                                                                                                                                     |
| `handle`      | `Promise<BrowserHandleInterface>`             | Evaluates an expression by reference and returns a disposable remote object handle.                                                                                                                                                                                                                                                                                                   |
| `send`        | `Promise<unknown>`                            | Issues a raw CDP method in the frame's current target session, with a trailing `BrowserCallOptions` carrying a per-call `timeout` overriding the client-wide default and a `signal` that aborts the call.                                                                                                                                                                             |
| `subscribe`   | `Promise<void>`                               | Subscribes to a CDP event in the frame's current target session.                                                                                                                                                                                                                                                                                                                      |
| `unsubscribe` | `Promise<void>`                               | Removes a frame-session CDP event subscription.                                                                                                                                                                                                                                                                                                                                       |
| `save`        | `Promise<void>`                               | Persists bytes through a page writer; a child frame rejects because it owns no writer.                                                                                                                                                                                                                                                                                                |
| `assert`      | `void`                                        | Throws a coded `BrowserError` when the frame can no longer accept protocol work: a frame throws once the CDP client disconnects, and a page also throws once it closes. Every other member here calls it first.                                                                                                                                                                       |
| `update`      | `void`                                        | Records an externally observed URL as the frame's current `url`, which a page calls from its own `Page.frameNavigated` handler.                                                                                                                                                                                                                                                       |

```ts
await page.navigate('https://example.com', { condition: 'idle' })
await page.wait('Welcome', { timeout: 5_000 }) // visible text, parked on a MutationObserver
const reading = await page.read()
await page.reload()
await page.back()
await page.forward()
const heading = await page.title()
const result = await page.evaluate('document.title')
const shot = await page.screenshot({ full: true, format: 'png' })
const pdf = await page.pdf({ landscape: true })
const child = await page.frame('checkout') // BrowserFrameInterface | undefined
const children = await page.frames() // readonly BrowserFrameInterface[]
const snapshot = await page.snapshot({ styles: ['display'], rects: true })
await page.close()
```

#### `BrowserElementManagerInterface`

Captures a view's document as an outline and binds a stable reference to each interactive element it lists. A reference is `e` followed by a positive integer, minted from one counter the browser context owns on CDP and the view owns in the DOM placement, so a number is never reused. A cross-document navigation of the main document drops every reference; a child frame's navigation or detachment drops that frame's references. On CDP the outline reads `Accessibility.getFullAXTree` on the page session and on each out-of-process frame session and waits for the current loader's `DOMContentLoaded`; in the DOM placement it walks the document through open shadow roots and same-origin frames and lists an `option` row under each `select`.

| Method     | Returns                        | Summary                                                                                                                                                         |
| ---------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outline`  | `Promise<BrowserOutline>`      | Captures the view's document as a document-order outline, binding a reference to each interactive element and bounding the referenced rows by `limit`.          |
| `find`     | `Promise<readonly TElement[]>` | Returns the elements matching `query` by role, case-insensitive accessible-name substring, or CSS selector, within an optional referenced element.              |
| `wait`     | `Promise<readonly TElement[]>` | Resolves with the elements matching `query` after a mutation produces a match, or after none matches when `absent` is set; rejects at the deadline or on abort. |
| `element`  | `TElement \| undefined`        | Returns the element a reference names, or `undefined` when the reference is unknown or was dropped.                                                             |
| `elements` | `readonly TElement[]`          | Returns every element the manager holds a reference to.                                                                                                         |
| `clear`    | `void`                         | Drops every reference the manager holds.                                                                                                                        |

The following fence outlines a page, finds by role and name, and waits for an element a later mutation inserts.

```ts
const outline = await page.elements.outline({ limit: 150 }) // { url, title, text, count, total }
log(outline.text) // page "Cart" https://example.test/cart\n# Your cart\ne1 link "Home"\n…
const [save] = await page.elements.find({ role: 'button', name: 'sav' }) // matches "Save"
const [email] = await page.elements.find({ css: 'input[type=email]' })
const [done] = await page.elements.wait({ role: 'status' }, { timeout: 5_000 })
await page.elements.wait({ css: '.spinner' }, { absent: true })
page.elements.element('e1') // BrowserPageElementInterface | undefined
page.elements.elements() // every element the manager holds
page.elements.clear() // drops every reference
```

#### `BrowserPageElementInterface`

One referenced element of a page, acted on through trusted input on the page session. A click scrolls the element into view, checks that it is visible, enabled, and stable across two animation frames, reads its content quad on its own session, hit-tests the quad center, and dispatches a pressed and released mouse event; each step refuses with a coded `BrowserElementError` whose `context.reason` is `GONE`, `HIDDEN`, `OCCLUDED`, `DISABLED`, `UNTRUSTED`, or `UNKNOWN`, and whose message names the next call. For an element inside an out-of-process frame the point is composed through each frame's content box. The `click`, `fill`, `select`, `focus`, `read`, and `submit` rows are the `BrowserElementInterface` members both placements share.

| Method       | Returns                            | Summary                                                                                                                                                                                                                                                                         |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hover`      | `Promise<void>`                    | Moves the pointer onto the element with a trusted mouse event.                                                                                                                                                                                                                  |
| `press`      | `Promise<void>`                    | Focuses the element and presses `key` through a trusted key pair, sending the release even after an abort.                                                                                                                                                                      |
| `upload`     | `Promise<void>`                    | Sets the files of a file input to `files`, as paths the browser reads.                                                                                                                                                                                                          |
| `drag`       | `Promise<void>`                    | Drags the element onto the center of `target` with trusted pointer events.                                                                                                                                                                                                      |
| `quad`       | `Promise<BrowserQuad>`             | Resolves the element's content quad in page coordinates, composed through every frame between the element and the page.                                                                                                                                                         |
| `screenshot` | `Promise<BrowserScreenshotResult>` | Captures the page clipped to the element's box.                                                                                                                                                                                                                                 |
| `click`      | `Promise<void>`                    | Clicks the element, refusing with a coded `BrowserElementError` when it is gone, hidden, covered, or disabled.                                                                                                                                                                  |
| `fill`       | `Promise<void>`                    | Replaces the value of a text control with `value`, dispatching the input events that typing fires.                                                                                                                                                                              |
| `select`     | `Promise<void>`                    | Selects the options of a `select` element whose value or label matches `values`, dispatching `input` and `change`.                                                                                                                                                              |
| `focus`      | `Promise<void>`                    | Moves focus to the element.                                                                                                                                                                                                                                                     |
| `read`       | `Promise<BrowserReadingInterface>` | Captures the element's markup with its document's URL and title as a reading whose `stale` flag tracks later navigations of that document.                                                                                                                                      |
| `submit`     | `Promise<void>`                    | Submits the form the element belongs to. The CDP placement focuses the element and presses Enter through a trusted key pair, sending the release even after an abort; the DOM placement calls the form's `requestSubmit()` and reports the outcome through a `submit` listener. |

The following fence acts on elements the manager found.

```ts
const [size] = await page.elements.find({ role: 'combobox', name: 'Size' })
await size?.select(['Large'])
const [email] = await page.elements.find({ role: 'textbox', name: 'Email' })
await email?.focus()
await email?.fill('sam@example.test')
await email?.press('Tab')
await email?.submit() // a trusted Enter on the control
const [save] = await page.elements.find({ role: 'button', name: 'Save' })
await save?.hover()
await save?.click({ timeout: 5_000 })
const reading = await save?.read() // the element's markup with its document's URL and title
const [file] = await page.elements.find({ css: 'input[type=file]' })
await file?.upload(['./report.pdf'])
const [card, lane] = await page.elements.find({ css: '.card, .lane' })
if (card !== undefined && lane !== undefined) await card.drag(lane)
const quad = await save?.quad() // page coordinates
const shot = await save?.screenshot({ format: 'png' })
```

#### `BrowserReadingInterface`

One captured document, parsed one time and projected to Markdown or to plain text. Each projection runs over `html.distill({ base: url })` by default and over the whole document with `distill: false`, is computed one time per reading and mode, and is cut into slices that share one `total`; the next slice starts at `offset + text.length`. `stale` is derived from the navigation epoch the frame had at capture, which a cross-document navigation, a same-document navigation, and a detachment each advance.

| Method     | Returns             | Summary                                                                                                                                                                              |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `markdown` | `BrowserReadResult` | Returns a slice of the document rendered as Markdown. A bounded slice ends after the last line break in its window when one lies past `offset`, and at `limit` characters otherwise. |
| `text`     | `BrowserReadResult` | Returns a slice of the document rendered as structural plain text, cut by the rule `markdown` applies.                                                                               |

The following fence reads a page in 4 000-character slices.

```ts
const reading = await page.read()
let slice = reading.markdown({ limit: 4_000 })
while (slice.offset + slice.text.length < slice.total && !reading.stale)
	slice = reading.markdown({ offset: slice.offset + slice.text.length, limit: 4_000 })
const whole = reading.text({ distill: false }) // navigation and footer included
```

#### `BrowserRegistryInterface`

The adapter over the experimental `WebMCP` protocol domain, at `page.registry`. `start` subscribes the domain's four events on the page session and then sends `WebMCP.enable`, and resolves `false` when the browser answers `-32601` (method not found), which Chromium 141 does. The registry enables the domain on each out-of-process frame session the page reports, keys its mirror by frame and name, and emits `change`, `invoke`, and `respond`. `adopt` projects every tool as an untrusted `ToolInterface`: `readOnly` maps to `pure`, `consequential` to `consequential`, and a schema that requires nothing gains a required `what` string that is stripped before the invocation.

| Method    | Returns                             | Summary                                                                                   |
| --------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `start`   | `Promise<boolean>`                  | Enables observation; returns `false` only when the protocol domain is absent.             |
| `tool`    | `BrowserTool \| undefined`          | Finds a tool; an omitted frame prefers the main document, then registration order.        |
| `tools`   | `readonly BrowserTool[]`            | Returns every registered tool, including shadowed frame registrations.                    |
| `adopt`   | `Promise<readonly ToolInterface[]>` | Projects tools as untrusted executable tools, omitting optional-what schemas.             |
| `execute` | `Promise<BrowserInvocationResult>`  | Invokes a tool and awaits its terminal event; rejects on abort, invalidation, or timeout. |
| `destroy` | `Promise<void>`                     | Disables every enabled session, unsubscribes, and rejects pending invocations.            |

The following fence mirrors a page's registered tools and invokes one.

```ts
if (await page.registry.start()) {
	page.registry.emitter.on('change', () => log(page.registry.tools().length))
	const search = page.registry.tool('search-cars') // the main frame's registration first
	if (search !== undefined) {
		const result = await page.registry.execute(search, { make: 'Volvo' }, { timeout: 10_000 })
		log(result.status, result.output) // 'Completed', the page's untrusted output
	}
	const tools = await page.registry.adopt() // readonly ToolInterface[]
	await page.registry.destroy()
}
```

#### `BrowserToolSourceInterface`

The contract a toolset adopts page tools through, free of protocol types. `BrowserRegistry` satisfies it with its census; `@orkestrel/mcp`'s `ModelContextInterface` satisfies it structurally without one, so a toolset applies only the name checks to that source's tools.

| Method  | Returns                             | Summary                                                                                      |
| ------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `adopt` | `Promise<readonly ToolInterface[]>` | Projects the page's current tools as executable tools.                                       |
| `tools` | `readonly BrowserTool[]`            | Lists the registered tools, from which a toolset decides the `schema` and `debugging` skips. |

The following fence adopts a source's tools on every `change`.

```ts
source.emitter.on('change', async () => {
	const tools = await source.adopt() // readonly ToolInterface[]
	const census = source.tools?.() // readonly BrowserTool[] | undefined
	log(tools.length, census?.length)
})
```

#### `BrowserToolsetInterface`

Publishes the browser vocabulary as `@orkestrel/tool` tools over one current view and adopts the page's tools beside them. A page-backed toolset advertises `look`, `read`, `click`, `type`, `press`, `navigate`, and `wait`, stages `dialog` while a dialog is open, and with the `context` option adds `tabs` and `switch`; a view-backed toolset advertises `look`, `read`, `click`, `type`, and `wait`. Every tool declares at least one required parameter, every result and error message is cut at `limit` characters plus a footer, and actions run one at a time in first-in, first-out order. `native` holds the generic tools alone, which is what a consumer publishes to a built-in browser agent. [Toolset vocabulary](#toolset-vocabulary) lists each tool and the receipts it returns.

| Method    | Returns         | Summary                                                                                                                                                                                                                                                                                                                          |
| --------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`   | `Promise<void>` | Adds the tools, follows the view, and adopts the page's tools; concurrent calls share one startup. Rejects with a coded `BrowserError` and adds nothing when the manager holds a reserved name under a tool the toolset did not add, and rejects with `the browser session ended` when `destroy()` runs before startup finishes. |
| `destroy` | `Promise<void>` | Stops following the view, rejects queued actions, and removes every tool the toolset added that the manager still holds, then calls the `release` option one time; a second call returns the first call's promise.                                                                                                               |

The following fence starts a toolset over a page and runs one tool through its manager.

```ts
const toolset = createBrowserToolset(page, { context, limit: 4_000 }) // context: BrowserContextInterface
toolset.emitter.on('skip', (name, reason) => log(name, reason)) // 'reserved' | 'held' | 'pattern' | 'schema' | 'debugging'
await toolset.start()
const result = await toolset.tools.execute({ id: '1', name: 'look', arguments: { what: 'cart' } })
await toolset.destroy() // removes the tools it added; the page stays open
```

#### `BrowserSnapshotInterface`

One page capture as navigable data. Its `readonly` members — `documents`
and `styles`, inherited from the Surface `BrowserSnapshotInput` row — are the
entire serialized form; every method that follows derives structure from them on
demand, storing nothing that could drift. Nodes stay
plain `BrowserNode` data — passed in as arguments and handed back unwrapped —
so a snapshot survives `JSON.stringify` and comes back through
`createBrowserSnapshot`. Walks are lazy generators, so `find` stops at the
first match and `filter` stops at its limit.

| Method        | Returns                                 | Summary                                                                                                                                                                   |
| ------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `walk`        | `Generator<BrowserNode, void, unknown>` | Traverses the whole capture, or one subtree when `root` is given and yielded first, in `'depth'` order by default or in `'breadth'` order. Visits each node exactly once. |
| `descendants` | `Generator<BrowserNode, void, unknown>` | Traverses one node's subtree in depth-first order, excluding the node itself.                                                                                             |
| `document`    | `BrowserDocument \| undefined`          | Resolves the captured document a node belongs to.                                                                                                                         |
| `children`    | `readonly BrowserNode[]`                | Returns the direct children of a node, entering a linked iframe's content document.                                                                                       |
| `parent`      | `BrowserNode \| undefined`              | Returns the structural parent of a node, crossing a document boundary to the owning iframe.                                                                               |
| `siblings`    | `readonly BrowserNode[]`                | Returns the structural siblings of a node; `'preceding'` or `'following'` narrows to one side, and omitting the relation returns every sibling but the node itself.       |
| `ancestors`   | `readonly BrowserNode[]`                | Returns the ancestors of a node, nearest first, across document and iframe boundaries.                                                                                    |
| `common`      | `BrowserNode \| undefined`              | Returns the nearest common ancestor of two nodes, counting each node as its own candidate.                                                                                |
| `distance`    | `number \| undefined`                   | Returns the structural edge count between two nodes, or `undefined` when they share no ancestor.                                                                          |
| `find`        | `BrowserNode \| undefined`              | Returns the first node matching a `BrowserNodeQuery` or a `BrowserNodePredicate`.                                                                                         |
| `filter`      | `readonly BrowserNode[]`                | Returns every matching node, bounded by an optional `limit`; a negative or fractional limit throws a coded `BrowserError`.                                                |
| `closest`     | `BrowserNode \| undefined`              | Returns the nearest match from a node through its ancestors, testing the node first.                                                                                      |
| `path`        | `string`                                | Returns a deterministic frame-qualified structural path for one node.                                                                                                     |

```ts
import type { BrowserSnapshotInput } from '@orkestrel/browser'
import { createBrowserSnapshot, matchesBrowserNode } from '@orkestrel/browser'

const captured = await page.snapshot({ styles: ['display'], rects: true })
const stored: BrowserSnapshotInput = JSON.parse(JSON.stringify(captured)) // { documents, styles }
const snapshot = createBrowserSnapshot(stored) // navigable again, same data

const main = snapshot.find({ name: 'main', visible: true }) // declarative query
const heading = snapshot.find((node) => node.name === 'H1') // predicate
const clickable = snapshot.filter({ clickable: true }, 20) // first 20 matches

if (main !== undefined && heading !== undefined) {
	snapshot.document(main)?.url // the document holding a node
	snapshot.children(main) // direct children, entering iframe content
	snapshot.parent(heading) // structural parent, iframe owner included
	snapshot.siblings(heading, 'preceding') // one structural side
	snapshot.ancestors(heading) // nearest-first, across frames
	snapshot.common(main, heading) // nearest shared ancestor
	snapshot.distance(main, heading) // structural edge count
	snapshot.closest(heading, { name: 'section' }) // self, then ancestors
	snapshot.path(heading) // frame("frame-main") > #document:0 > html:1 > ...

	const perLevel = [...snapshot.walk({ root: main, order: 'breadth' })]
	const links = [...snapshot.descendants(main)].filter((node) =>
		matchesBrowserNode(node, { name: 'a', visible: true }),
	) // subtree search: descendants + matchesBrowserNode
}
```

#### `BrowserCodegenInterface`

Records page interactions as a session runs, for later compilation into a replayable script. The recorder reports through a page binding, and `compileCodegenScript` compiles each recorded selector into `(await page.elements.find({ css: SELECTOR }))[0]` followed by the element action.

| Method    | Returns                                    | Summary                                                                                                                                                                         |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`   | `Promise<void>`                            | Begins recording on the page's session. A call after teardown is a silent no-op, because a torn-down recorder cannot be restarted and a fresh one is obtained through the page. |
| `stop`    | `Promise<readonly BrowserCodegenAction[]>` | Stops recording, waits for the session to acknowledge before it detaches so a report already emitted by the page is kept, and returns the captured actions.                     |
| `actions` | `readonly BrowserCodegenAction[]`          | Returns the current normalized action list.                                                                                                                                     |
| `script`  | `string`                                   | Compiles the captured actions into a script.                                                                                                                                    |
| `clear`   | `void`                                     | Resets the captured action list.                                                                                                                                                |
| `destroy` | `Promise<void>`                            | Tears down the recorder and detaches its CDP listeners.                                                                                                                         |

```ts
const codegen = await page.codegen()
await (await page.elements.find({ css: '#next' }))[0]?.click()
const actions = await codegen.stop()
const script = codegen.script({ language: 'typescript' })
codegen.clear() // reset the captured action list
await codegen.destroy()
```

#### `BrowserTransitionInterface`

One asynchronous transition at a time, shared by every caller that joins it
while it runs. An entity keeps its own entry guards — what makes a transition
unnecessary is the entity's own state — and holds one `BrowserTransition` per
transition, so the in-flight identity check is written once instead of once per
lifecycle.

| Method    | Returns      | Summary                                                                                                       |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `execute` | `Promise<T>` | Starts the work when nothing is in flight, and otherwise joins the running transition and returns its result. |

```ts
import { BrowserTransition } from '@orkestrel/browser'

const starting = new BrowserTransition()
await starting.execute(() => transport.start())
const joined = starting.pending // the in-flight promise, or undefined
```

#### `BrowserInterface`

Browser wrapper with discovery, connection management, and lifecycle control. `connect()` tries an explicit `cdp.endpoint`, then passive discovery on `cdp.port`, then a launch whose endpoint it reads from the child's standard error through `readBrowserEndpoint`.

| Method       | Returns                                | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover`   | `Promise<BrowserDiscoveryResult>`      | Probes CDP passively, changing no connection state and neither launching nor attaching, and emits a `discover` event with the result.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `connect`    | `Promise<void>`                        | Establishes a connection through the endpoint, then discovery, then a launch. Idempotent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `adopt`      | `void`                                 | Assumes responsibility for terminating the connected browser.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `disconnect` | `Promise<void>`                        | Detaches the client-side transport while the remote browser keeps running. A merely attached CDP session forgets the endpoint and its ownership becomes `undefined`. A launched or explicitly adopted session retains ownership and its endpoint, so the same instance can reconnect and stays responsible for eventual termination. Transport loss while an owned browser remains alive is resumable the same way.                                                                                                                                                     |
| `context`    | `BrowserContextInterface \| undefined` | Returns one context by index, or the first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `contexts`   | `readonly BrowserContextInterface[]`   | Returns every context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `isolate`    | `Promise<BrowserContextInterface>`     | Creates and registers an isolated CDP context with validated proxy, download, origin, and emulation options.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `create`     | `Promise<BrowserPageInterface>`        | Opens a page in the default context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `destroy`    | `Promise<void>`                        | Releases local resources. A launched browser has the process serving its CDP endpoint terminated and its exit awaited — on POSIX that terminate reaches the launch's whole process group and awaits its drain, and on Windows it terminates one process by identifier, the spawned process or the one a launcher handed the endpoint to — which leaves the profile unlocked before cleanup. An adopted attachment is sent CDP `Browser.close`. A merely attached browser is detached locally and nothing more, because other clients may share its targets. Idempotent. |
| `close`      | `Promise<void>`                        | Shuts the remote browser down: sends CDP `Browser.close` best-effort whether attached or owned, and for an owned browser also awaits the exit of the process serving the CDP endpoint plus its POSIX process-group drain, escalating to a kill only where needed. Then closes every tracked context and page, sending remote `Target.closeTarget` and `disposeBrowserContext` whatever the ownership, before releasing the CDP client. This is the way to shut down a browser the instance does not own and still wants terminated.                                     |

```ts
import { createBrowser } from '@orkestrel/browser/server'

const browser = createBrowser({ profile: './profile', cdp: { port: 9222 } })
browser.emitter.on('connect', (mode) => log(mode))
await browser.connect()
const owned = browser.owned // true for this launched session
const page = await browser.create({ url: 'https://example.com' })
const isolated = await browser.isolate({ emulation: { locale: 'en-US' } })
const all = browser.contexts() // readonly BrowserContextInterface[]
const pid = browser.pid // number | undefined — the process serving the CDP endpoint, when this instance owns one
await browser.disconnect() // retains ownership and endpoint for this persistent launch
await browser.connect() // reconnect the same owner
await isolated.close()
await browser.destroy() // terminates and awaits the owned process
```

#### `BrowserWebSocketInterface`

One WebSocket connection a page's network manager reconstructs from
Network-domain events. The manager owns the connection and drives every method
here; a consumer reads `id` and `url` and subscribes through `emitter`.

| Method     | Returns | Summary                                                                                        |
| ---------- | ------- | ---------------------------------------------------------------------------------------------- |
| `receive`  | `void`  | Reports one received frame. The page's network manager drives it.                              |
| `transmit` | `void`  | Reports one sent frame. The page's network manager drives it.                                  |
| `fail`     | `void`  | Reports a connection fault. The page's network manager drives it.                              |
| `close`    | `void`  | Reports the connection closing and destroys the emitter. The page's network manager drives it. |

```ts
page.network.emitter.on('socket', (socket) => {
	log(socket.id, socket.url)
	socket.emitter.on('receive', (frame) => log(frame.data))
	socket.emitter.on('transmit', (frame) => log(frame.data))
	socket.emitter.on('error', (message) => log(message))
	socket.emitter.on('close', (timestamp) => log(timestamp))
})
// The page's network manager drives the connection from Network-domain events:
socket.receive({ opcode: 1, data: 'pong', masked: false, timestamp: 4 })
socket.transmit({ opcode: 1, data: 'ping', masked: false, timestamp: 3 })
socket.fail('handshake rejected')
socket.close(6)
```

#### `BrowserDownloadInterface`

One context download tracked through Chromium's Browser domain. The owning page
drives `update` from `Browser.downloadProgress`; a consumer calls `abort` and
reads the observed state.

| Method   | Returns         | Summary                                                                                                                                                                     |
| -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abort`  | `Promise<void>` | Aborts the download by sending CDP `Browser.cancelDownload`, and is ignored unless the status is still pending. The status becomes `'aborted'` and the `abort` event fires. |
| `update` | `void`          | Records one step of the download's progress. The owning page drives it.                                                                                                     |

```ts
page.emitter.on('download', (download) => {
	log(download.id, download.url, download.name)
	download.emitter.on('progress', (received, total) => log(received, total))
	download.emitter.on('complete', (path) => log(path))
	download.emitter.on('abort', () => log('aborted'))
})
// The owning page drives progress from Browser.downloadProgress:
download.update({ status: 'pending', received: 512, total: 2_048 })
download.update({ status: 'complete', received: 2_048, total: 2_048, path: './report.pdf' })
await download.abort() // ignored once the download settled
```

#### `BrowserWriterInterface`

The pluggable sink a page persists captured bytes through. Core never touches a
filesystem; server supplies `FileBrowserWriter`.

| Method  | Returns         | Summary                                                                         |
| ------- | --------------- | ------------------------------------------------------------------------------- |
| `write` | `Promise<void>` | Persists the captured bytes to the given path, creating its parent directories. |

```ts
import { FileBrowserWriter } from '@orkestrel/browser/server'

const writer = new FileBrowserWriter()
await writer.write('shots/hero.png', new Uint8Array([137, 80, 78, 71]))
```

#### `BrowserNavigationManagerInterface`

Waits for a navigation the page performs on its own, rather than one the caller started, and for network idle. Each wait parks on a protocol event and an abort signal; `wait` resolves on same-document navigations too, and `idle` on the next `networkIdle` lifecycle event of the current loader.

| Method | Returns           | Summary                                                                                                                                                                   |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait` | `Promise<string>` | Resolves with the URL of the next navigation, same-document ones included, matching the `*` and `**` glob pattern. Rejects on timeout, and with `signal.reason` on abort. |
| `idle` | `Promise<void>`   | Resolves on the next `networkIdle` lifecycle event of the page's current loader. Rejects on timeout, and with `signal.reason` on abort.                                   |

```ts
const navigated = page.navigation.wait('**/checkout')
await (await page.elements.find({ css: '#buy' }))[0]?.click()
log(await navigated)
await page.navigation.idle({ signal: AbortSignal.timeout(10_000) })
```

#### `BrowserHandleInterface`

A retained remote JavaScript object. Release it with `dispose` when done.

| Method       | Returns                                        | Summary                                                                                         |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `value`      | `Promise<unknown>`                             | Reads the object back by value.                                                                 |
| `call`       | `Promise<unknown>`                             | Runs a function declaration with the handle as `this`, by value.                                |
| `property`   | `Promise<BrowserHandleInterface \| undefined>` | Retains one own property as its own handle, or returns `undefined` when the property is absent. |
| `properties` | `Promise<Readonly<Record<string, unknown>>>`   | Reads every own property by value.                                                              |
| `dispose`    | `Promise<void>`                                | Releases the retained remote object. Idempotent.                                                |

```ts
const handle = await page.handle('document.body')
log(await handle.value())
log(await handle.call('function() { return this.tagName }'))
const dataset = await handle.property('dataset')
log(await handle.properties())
await dataset?.dispose()
await handle.dispose()
```

#### `BrowserScriptManagerInterface`

Installs new-document scripts and exposes host functions into page JavaScript.

| Method    | Returns           | Summary                                                                        |
| --------- | ----------------- | ------------------------------------------------------------------------------ |
| `add`     | `Promise<string>` | Installs a script evaluated on every new document, and returns its identifier. |
| `remove`  | `Promise<void>`   | Removes one installed script by identifier.                                    |
| `expose`  | `Promise<void>`   | Binds a host function to a page-global name, callable from page JavaScript.    |
| `revoke`  | `Promise<void>`   | Removes one exposed binding and its installed bridge script.                   |
| `destroy` | `Promise<void>`   | Removes every installed script and binding this manager owns.                  |

```ts
const id = await page.scripts.add('window.__seeded = true')
await page.scripts.expose('add', (a, b) => Number(a) + Number(b))
log(await page.evaluate('add(1, 2)'))
await page.scripts.revoke('add')
await page.scripts.remove(id)
await page.scripts.destroy()
```

#### `BrowserAccessibilityInterface`

Reads the page's accessibility tree as a serializable snapshot.

| Method     | Returns                                 | Summary                                                                        |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `snapshot` | `Promise<BrowserAccessibilitySnapshot>` | Reads the full accessibility tree, optionally pruned to the interesting nodes. |

```ts
const tree = await page.accessibility.snapshot({ interesting: true })
log(tree.nodes.map((node) => node.name))
```

#### `BrowserTracingInterface`

Captures a Chromium trace streamed back through the IO domain.

| Method    | Returns                         | Summary                                                                                           |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `start`   | `Promise<void>`                 | Begins tracing with the given categories. Throws a `BrowserError` when a trace is already active. |
| `stop`    | `Promise<BrowserTracingResult>` | Ends tracing, drains the IO stream, and writes it through the page writer when a path was set.    |
| `destroy` | `Promise<void>`                 | Stops an active trace, discarding any failure, and does nothing when no trace is running.         |

```ts
await page.diagnostics.tracing.start({ screenshots: true })
const trace = await page.diagnostics.tracing.stop() // { bytes, path }
await page.diagnostics.tracing.destroy()
```

#### `BrowserCoverageInterface`

Collects JavaScript precise coverage and CSS rule usage together.

| Method    | Returns                          | Summary                                                                                                                    |
| --------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `start`   | `Promise<void>`                  | Arms the requested domains. Throws a `BrowserError` when collection is already active or when neither domain is requested. |
| `stop`    | `Promise<BrowserCoverageResult>` | Reads the collected usage and disarms every domain it armed.                                                               |
| `destroy` | `Promise<void>`                  | Stops an active collector, discarding any failure, and does nothing when no collection is running.                         |

```ts
await page.diagnostics.coverage.start({ javascript: true, css: true })
const usage = await page.diagnostics.coverage.stop() // { scripts, styles }
await page.diagnostics.coverage.destroy()
```

#### `BrowserPerformanceInterface`

Reads Performance-domain metrics for one frame.

| Method    | Returns                             | Summary                                                                |
| --------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `metrics` | `Promise<readonly BrowserMetric[]>` | Enables the domain, reads every metric, and disables the domain again. |

```ts
const metrics = await page.diagnostics.performance.metrics()
log(metrics.map((metric) => [metric.name, metric.value]))
```

#### `BrowserProfilerInterface`

Records a sampled JavaScript CPU profile.

| Method    | Returns                   | Summary                                                                                        |
| --------- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| `start`   | `Promise<void>`           | Begins sampling, optionally at an explicit positive integer interval in microseconds.          |
| `stop`    | `Promise<BrowserProfile>` | Ends sampling and decodes the profile's nodes, samples, and time deltas.                       |
| `destroy` | `Promise<void>`           | Stops an active profiler, discarding any failure, and does nothing when no profile is running. |

```ts
await page.diagnostics.profiler.start(100)
const profile = await page.diagnostics.profiler.stop() // { start, end, nodes, samples, deltas }
await page.diagnostics.profiler.destroy()
```

#### `BrowserDiagnosticsInterface`

Groups the per-page diagnostics capabilities and owns their teardown. `tracing`,
`coverage`, `performance`, and `profiler` are Surface data members.

| Method    | Returns         | Summary                                                         |
| --------- | --------------- | --------------------------------------------------------------- |
| `destroy` | `Promise<void>` | Tears down every diagnostics capability this page's group owns. |

```ts
await page.diagnostics.destroy()
```

#### `BrowserClockInterface`

Controls Chromium virtual time so page timers become deterministic.

| Method      | Returns         | Summary                                                                                |
| ----------- | --------------- | -------------------------------------------------------------------------------------- |
| `install`   | `Promise<void>` | Takes over the page clock, optionally seeding it with an epoch time.                   |
| `pause`     | `Promise<void>` | Suspends virtual time so no page timer advances.                                       |
| `resume`    | `Promise<void>` | Continues virtual time after a pause.                                                  |
| `advance`   | `Promise<void>` | Moves virtual time forward by the given milliseconds, firing the timers that fall due. |
| `uninstall` | `Promise<void>` | Returns the page to the real clock, and does nothing when no clock was installed.      |

```ts
await page.clock.install(Date.parse('2026-01-01T00:00:00Z'))
await page.clock.pause()
await page.clock.advance(5_000)
await page.clock.resume()
await page.clock.uninstall()
```

#### `BrowserKeyboardInterface`

Sends trusted keyboard input on the page session. Held modifiers persist between calls until released.

| Method   | Returns         | Summary                                                                                                   |
| -------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `down`   | `Promise<void>` | Presses one key and holds it, retaining it in the modifier mask when it is a modifier.                    |
| `up`     | `Promise<void>` | Releases one key, dropping it from the modifier mask even when the release frame fails.                   |
| `press`  | `Promise<void>` | Presses a chord: holds its modifiers, presses and releases its terminal key, then releases the modifiers. |
| `type`   | `Promise<void>` | Types a string as one press and release per character.                                                    |
| `insert` | `Promise<void>` | Inserts composed text in one frame, firing no per-key events.                                             |

```ts
await page.keyboard.down('Shift')
await page.keyboard.up('Shift')
await page.keyboard.press('Control+Enter')
await page.keyboard.type('orkestrel', { delay: 10 })
await page.keyboard.insert('pasted text')
```

#### `BrowserMouseInterface`

Sends trusted mouse input on the page session, tracking the pointer position and the pressed-button mask between calls.

| Method  | Returns         | Summary                                                                                      |
| ------- | --------------- | -------------------------------------------------------------------------------------------- |
| `move`  | `Promise<void>` | Moves the pointer to a point, carrying the pressed buttons.                                  |
| `down`  | `Promise<void>` | Presses a button at the current point, adding it to the pressed mask.                        |
| `up`    | `Promise<void>` | Releases a button at the current point, dropping it from the mask even when the frame fails. |
| `click` | `Promise<void>` | Moves to the given point, presses, optionally delays, and releases.                          |
| `drag`  | `Promise<void>` | Presses at the start, moves in the requested steps to the end, and releases.                 |
| `wheel` | `Promise<void>` | Sends a wheel delta at the current point.                                                    |

```ts
await page.mouse.move({ x: 50, y: 20 })
await page.mouse.down('left')
await page.mouse.up('left')
await page.mouse.click({ x: 50, y: 20 }, { button: 'left', count: 2 })
await page.mouse.drag({ x: 10, y: 10 }, { x: 90, y: 90 }, { steps: 20 })
await page.mouse.wheel({ x: 0, y: -120 })
```

#### `BrowserTouchInterface`

Sends trusted touch input on the page session.

| Method | Returns         | Summary                                                                                 |
| ------ | --------------- | --------------------------------------------------------------------------------------- |
| `tap`  | `Promise<void>` | Dispatches a touch start at the point and a touch end, cancelling the touch on failure. |

```ts
await page.touch.tap({ x: 120, y: 240 })
```

#### `BrowserDialogInterface`

One JavaScript dialog awaiting a decision. `category`, `message`, and `default` are Surface data members. A toolset stages its `dialog` tool from the page's `dialog` event.

| Method    | Returns         | Summary                                                                                  |
| --------- | --------------- | ---------------------------------------------------------------------------------------- |
| `accept`  | `Promise<void>` | Accepts the dialog, optionally supplying prompt text. Throws once the dialog is handled. |
| `dismiss` | `Promise<void>` | Dismisses the dialog. Throws once the dialog is handled.                                 |

```ts
page.emitter.on('dialog', async (dialog) => {
	if (dialog.category === 'prompt') await dialog.accept('Ada')
	else await dialog.dismiss()
})
```

#### `BrowserFileChooserInterface`

One intercepted file input selection. `multiple` is a Surface data member.

| Method    | Returns         | Summary                                                                                                             |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `upload`  | `Promise<void>` | Sets the chosen files. Throws when a single-file chooser is given several, and once the chooser is already handled. |
| `dismiss` | `Promise<void>` | Dismisses the chooser with an empty selection. Throws once the chooser is already handled.                          |

```ts
page.emitter.on('chooser', async (chooser) => {
	if (chooser.multiple) await chooser.upload(['one.txt', 'two.txt'])
	else await chooser.dismiss()
})
```

#### `BrowserWorkerInterface`

A dedicated, shared, or service worker attached through its own flattened
session. `id`, `url`, and `category` are Surface data members.

| Method     | Returns            | Summary                                                                            |
| ---------- | ------------------ | ---------------------------------------------------------------------------------- |
| `evaluate` | `Promise<unknown>` | Evaluates a guarded expression in the worker and returns its value.                |
| `send`     | `Promise<unknown>` | Issues one CDP method call on the worker's session.                                |
| `detach`   | `void`             | Stops driving the worker locally without closing its target.                       |
| `close`    | `Promise<void>`    | Closes the worker target, tolerating a worker that already terminated. Idempotent. |

```ts
page.emitter.on('worker', async (worker) => {
	log(await worker.evaluate('self.location.href'))
	await worker.send('Runtime.enable')
	worker.detach()
	await worker.close()
})
```

#### `BrowserRouteInterface`

One paused request, decided exactly once. `id`, `request`, and `handled` are
Surface data members.

| Method     | Returns         | Summary                                                                                 |
| ---------- | --------------- | --------------------------------------------------------------------------------------- |
| `abort`    | `Promise<void>` | Fails the request with a Chromium error reason, `'Failed'` by default.                  |
| `continue` | `Promise<void>` | Lets the request proceed, optionally overriding its URL, method, headers, or post body. |
| `fulfill`  | `Promise<void>` | Answers the request locally. Throws when the status is not an integer from 100 to 999.  |

```ts
await page.network.route({ url: '**/api' }, async (route) => {
	if (route.handled) return
	await route.fulfill({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' })
})
await page.network.route({ url: '**/slow' }, (route) => route.abort('TimedOut'))
await page.network.route({ url: '**/pass' }, (route) => route.continue({ method: 'POST' }))
```

#### `BrowserHARManagerInterface`

Records observed exchanges as a HAR 1.2 archive and replays one back.
`recording` is a Surface data member.

| Method   | Returns               | Summary                                                                        |
| -------- | --------------------- | ------------------------------------------------------------------------------ |
| `start`  | `Promise<void>`       | Begins recording exchanges, optionally capturing response content.             |
| `stop`   | `Promise<BrowserHAR>` | Ends recording and returns the archive, writing it when a path was given.      |
| `replay` | `Promise<void>`       | Serves matching requests from an archive instead of from the network.          |
| `clear`  | `Promise<void>`       | Drops the recorded entries and any active replay without ending the recording. |

```ts
await page.network.har.start({ content: true })
const har = await page.network.har.stop()
await page.network.har.replay(har, { strict: true })
await page.network.har.clear()
```

#### `BrowserNetworkManagerInterface`

Page-scoped network observation and interception. `emitter` and `har` are
Surface data members. Every method starts the Network domain first, so the page
begins reporting `request` / `response` / `failure` from the first call.

| Method        | Returns               | Summary                                                                           |
| ------------- | --------------------- | --------------------------------------------------------------------------------- |
| `start`       | `Promise<void>`       | Enables the Network domain and subscribes to its events. Idempotent.              |
| `body`        | `Promise<Uint8Array>` | Reads one observed response body as bytes.                                        |
| `text`        | `Promise<string>`     | Reads one observed response body as text.                                         |
| `json`        | `Promise<unknown>`    | Reads one observed response body as parsed JSON.                                  |
| `route`       | `Promise<void>`       | Intercepts requests matching the query and hands each one to the handler.         |
| `unroute`     | `Promise<void>`       | Removes one handler's routes, or every route when given none.                     |
| `headers`     | `Promise<void>`       | Applies extra HTTP headers to every request the page makes.                       |
| `offline`     | `Promise<void>`       | Emulates an offline connection, or restores connectivity.                         |
| `credentials` | `Promise<void>`       | Applies HTTP basic-auth credentials, or clears them when given none.              |
| `destroy`     | `Promise<void>`       | Removes every route, unsubscribes, and disables the domains this manager enabled. |

```ts
await page.network.start()
page.emitter.on('response', async (response) => {
	log(await page.network.body(response.id))
	log(await page.network.text(response.id))
	log(await page.network.json(response.id))
})
const handler = (route) => route.continue()
await page.network.route({ url: '**/api' }, handler)
await page.network.unroute(handler)
await page.network.headers({ 'x-trace': 'on' })
await page.network.offline(true)
await page.network.credentials({ username: 'ada', password: 'secret' })
await page.network.destroy()
```

#### `BrowserCookieManagerInterface`

Cookie state scoped to one browser context.

| Method    | Returns                             | Summary                                                                           |
| --------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| `cookies` | `Promise<readonly BrowserCookie[]>` | Reads the context cookies, optionally narrowed to the given URLs.                 |
| `set`     | `Promise<void>`                     | Writes the given cookies into the context.                                        |
| `clear`   | `Promise<void>`                     | Deletes the context cookies matching the filter, or every cookie when given none. |

```ts
await context.cookies.set([{ name: 'session', value: 'abc', url: 'https://example.com/' }])
log(await context.cookies.cookies(['https://example.com/']))
await context.cookies.clear({ name: 'session' })
```

#### `BrowserPermissionManagerInterface`

Permission overrides scoped to one browser context.

| Method  | Returns         | Summary                                                                        |
| ------- | --------------- | ------------------------------------------------------------------------------ |
| `grant` | `Promise<void>` | Grants each named permission, optionally for one origin, as its own CDP frame. |
| `deny`  | `Promise<void>` | Denies each named permission, optionally for one origin, as its own CDP frame. |
| `clear` | `Promise<void>` | Resets every permission override on the context.                               |

```ts
await context.permissions.grant(['geolocation'], 'https://example.com')
await context.permissions.deny(['notifications'], 'https://example.com')
await context.permissions.clear()
```

#### `BrowserStorageManagerInterface`

Cookie and web-storage state for one browser context, as one serializable value.

| Method    | Returns                        | Summary                                                                 |
| --------- | ------------------------------ | ----------------------------------------------------------------------- |
| `state`   | `Promise<BrowserStorageState>` | Reads the context cookies and the per-origin local and session storage. |
| `restore` | `Promise<void>`                | Writes a previously read state back into the context.                   |
| `clear`   | `Promise<void>`                | Drops the storage of one origin, or of every origin when given none.    |

```ts
const state = await context.storage.state({ origins: ['https://example.com'] })
await context.storage.restore(state)
await context.storage.clear('https://example.com')
```

#### `BrowserEmulationManagerInterface`

Emulation overrides inherited by every page of one context. The offline and
header overrides route through each page's network manager, so applying either
starts that page's Network domain.

| Method   | Returns         | Summary                                                                                  |
| -------- | --------------- | ---------------------------------------------------------------------------------------- |
| `apply`  | `Promise<void>` | Clears the superseded overrides and applies the given ones to every page of the context. |
| `clear`  | `Promise<void>` | Removes every override this manager applied.                                             |
| `attach` | `Promise<void>` | Applies the retained overrides to a newly created page.                                  |

```ts
await context.emulation.apply({ locale: 'fr-FR', offline: true, headers: { 'x-test': 'one' } })
await context.emulation.attach(page)
await context.emulation.clear()
```

#### `BrowserDOMViewInterface`

A view over one DOM document in the realm that runs it. The view follows its window, so a navigation of that window moves it to the window's next document and drops every reference. A reading goes stale on the Navigation API's `navigatesuccess` where the browser ships it, and on `popstate`, `hashchange`, and `pagehide` otherwise. `destroy` releases the listeners, fails pending waits, and makes every later call refuse with `BROWSER_DOCUMENT_DESTROYED`.

| Method    | Returns                            | Summary                                                                                                                                                         |
| --------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `destroy` | `void`                             | Releases the navigation listeners and every element reference.                                                                                                  |
| `title`   | `Promise<string>`                  | Resolves the document title.                                                                                                                                    |
| `read`    | `Promise<BrowserReadingInterface>` | Captures the document URL, title, and markup as a reading whose `stale` flag tracks later navigations.                                                          |
| `wait`    | `Promise<void>`                    | Resolves when `text` is visible in the document; rejects with a `BrowserError` coded `BROWSER_WAIT_TIMEOUT` at the deadline, and with `signal.reason` on abort. |

The following fence reads and waits on a child document.

```ts
const view = createBrowserDOMView({ document: frame.contentDocument })
log(await view.title())
await view.wait('Saved', { timeout: 2_000 }) // a MutationObserver, never a poll
const reading = await view.read()
view.destroy()
```

#### `BrowserDOMWaitInterface`

One wait parked on DOM mutations across a document, its open shadow roots, and its same-origin frame documents. It checks at once, re-checks after each mutation batch and each `load` in an observed root, and settles at its deadline with `BROWSER_WAIT_TIMEOUT`, on a `pagehide` with `GONE`, or on abort with the signal's reason. `roots` is a Surface data member.

| Method    | Returns      | Summary                                                                                                                                  |
| --------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `execute` | `Promise<T>` | Resolves the first value the check returns other than `undefined`, then releases every observer, the deadline timer, and every listener. |

The following fence waits for a status element to appear.

```ts
const wait = new BrowserDOMWait({
	roots: () => collectBrowserRoots(frame.contentDocument),
	check: () => frame.contentDocument.querySelector('[role=status]') ?? undefined,
	timeout: 5_000,
	start: performance.now(),
	subject: 'Status wait',
})
const status = await wait.execute()
```

## Toolset vocabulary

This section holds the words a model reads: the tools a toolset advertises and the receipts they return. `BROWSER_TOOL_COPY` is the source of every name, parameter, annotation, and description in it.

### Tools

A page-backed toolset advertises `look`, `read`, `click`, `type`, `press`, `navigate`, and `wait`, stages `dialog` while a dialog is open, and advertises `tabs` and `switch` when it is given a `context`; a view-backed toolset over a DOM document advertises `look`, `read`, `click`, `type`, and `wait`. Every tool declares at least one required parameter, because a streamed call to a tool that declared none ended the stream with an error in the model runs. The following table lists each tool with its advertised description.

| Tool       | Parameters                                                                               | Annotations                                                                      | Placements                                     | Description                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `look`     | `what` (string, required)                                                                | `pure`, `untrusted`                                                              | CDP and DOM                                    | `Shows the page's text and the elements you can act on, each with a reference like e4. Call it first and after the page changes.` |
| `read`     | `what` (string, required), `offset` (integer, default 0)                                 | `pure`, `untrusted`                                                              | CDP and DOM                                    | `Reads the page's text for what you name. Call it to learn a fact; continue with the offset a cut result names.`                  |
| `click`    | `ref` (string, required)                                                                 | none                                                                             | CDP and DOM                                    | `Clicks the element with that reference.`                                                                                         |
| `type`     | `ref` (string, required), `text` (string, required), `submit` (boolean)                  | none                                                                             | CDP and DOM                                    | `Types into the text control with that reference; set submit to true to submit its form.`                                         |
| `press`    | `key` (string, required)                                                                 | none                                                                             | CDP                                            | `Presses that key or chord, such as Enter or Control+a.`                                                                          |
| `navigate` | `url` (string, required)                                                                 | none                                                                             | CDP                                            | `Opens that absolute web address in the current tab.`                                                                             |
| `wait`     | `text` (string, required), `timeout` (integer seconds, default 5, at most 30)            | `pure`                                                                           | CDP and DOM                                    | `Waits for that text to appear.`                                                                                                  |
| `dialog`   | `accept` (boolean, required), `text` (string)                                            | none                                                                             | CDP, staged while a dialog opens               | `Accept or dismiss the open dialog.`                                                                                              |
| `tabs`     | `what` (string, required)                                                                | `pure`                                                                           | CDP, with `context`                            | `List the open tabs; the current one is marked.`                                                                                  |
| `switch`   | `tab` (string, required)                                                                 | none                                                                             | CDP, with `context`                            | `Switch to a tab from tabs, such as t2.`                                                                                          |
| page tools | the page's input schema, plus a required `what` string when that schema requires nothing | `untrusted` always; `pure` from `readOnly`; `consequential` from `consequential` | CDP through the registry, DOM through a source | the page's own description, advertised as authored under `untrusted`                                                              |

A call to one of the preceding tools that carries a parameter the tool does not advertise is refused before the tool's handler runs, with a `BrowserError` coded `BROWSER_TOOLSET_ARGUMENT` whose message is the receipt: `The look tool takes no ref parameter; call look with what.` `validateBrowserToolArguments` performs that check; a page tool's arguments are the page's to check.

### Receipts

Every action returns a receipt line followed by a blank line and the fresh view, and every result and error message is cut at `limit` characters plus a footer, which closes with `BROWSER_TOOL_VIEW_FOOTER` for a result that carries a view and with `BROWSER_TOOL_CUT_FOOTER` for any other. A `BrowserElementError` message is one line and ends with `; call look for fresh refs.` for `GONE` alone; a refusal that a fresh reference fixes, such as a reference the current view does not hold, names `look` in its own text. In the following table `URL` is an address, `REF` an element reference, `ROLE` and `NAME` its accessible role and name, `TITLE` a document title, `MESSAGE` a page-authored message, and `START`, `END`, and `TOTAL` character positions.

| Situation                                                                              | Text                                                                                                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The view `look` returns, first line                                                    | `page "TITLE" URL`                                                                                                      |
| A heading row, an element row, and a text row                                          | `# NAME`, `REF ROLE "NAME"` with `value="…"`, `[checked]`, `[disabled]`, or `[tool=NAME]` after it, and the text itself |
| The view's last line                                                                   | `(COUNT of TOTAL elements)`                                                                                             |
| A click                                                                                | `Clicked e4 button "Place order".`                                                                                      |
| A click on an element whose role is in `BROWSER_TYPED_ROLES`                           | `Clicked e35 searchbox "Search products"; call type with e35 to enter text.`                                            |
| A click in the DOM placement                                                           | `Clicked e1 button "Save". (untrusted event)`                                                                           |
| An option chosen through `type`                                                        | `Selected "Large" in e2 combobox "Size" (programmatic).`                                                                |
| `type` on an element whose role is not in `BROWSER_TYPED_ROLES`                        | `Element e5 button "Search" takes no text; call click for a button.`                                                    |
| A dialog that opened during the action                                                 | `Clicked e7 button "Delete". A confirm dialog is open: "Delete the draft?"; call dialog.`                               |
| A navigation that committed and has not loaded                                         | `Clicked e3 link "Next"; the page is still loading URL.`                                                                |
| A navigation that was requested and not committed                                      | `Clicked e3 link "Next"; it requested URL and the page did not change.`                                                 |
| The note in place of the view when a capture and its one retry both meet a page change | `(The page changed before the view could be read; call look.)`                                                          |
| A reference the page no longer holds                                                   | `Element e12 is gone because the page changed; call look for fresh refs.`                                               |
| A reference the current view does not hold                                             | `Element e99 is not in the current view; call look for fresh refs.`                                                     |
| Any other element refusal                                                              | `Element e2 is not editable.`                                                                                           |
| A parameter the tool does not advertise                                                | `The look tool takes no ref parameter; call look with what.`                                                            |
| A `read` result with more to read                                                      | `[characters START–END of TOTAL; call read with offset END for more]`                                                   |
| A result that carries a view, cut at the limit                                         | `[characters 0–END of TOTAL; the rest was cut; call read for the page's text]`                                          |
| Any other result or error message cut at the limit                                     | `[characters 0–END of TOTAL; the rest was cut]`                                                                         |
| A tool called after `destroy()`                                                        | `the browser session ended`                                                                                             |

## Relation to WebMCP

WebMCP puts a tool registry on the document, `document.modelContext`, so a page can offer its own capabilities to an agent. This package does not depend on it: the toolset drives any page through its own vocabulary, and `look`, `read`, `click`, `type`, `press`, `navigate`, `wait`, and `dialog` run against a browser that ships no registry. Chrome's intent to experiment (blink-dev, 2026-05-15) targets shipping WebMCP in Chrome 157, so the package adapts to it in both directions and pins that alignment against revision-named mirrors, which [Declared conformance gaps](#declared-conformance-gaps) records. No export is named after WebMCP; an adapter is named in prose.

The following table names each adapter, the contract on each side, and the proof that pins it.

| Adapter                                | This package                                                                                                                                                                                                                                                                                  | WebMCP or `@orkestrel/mcp`                                                                                                                                                                                                                               | Proof                                                                                                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The tool source contract               | `BrowserToolSourceInterface`: an `emitter` emitting `change`, `adopt()`, and an optional `tools()` census, which `createDocumentToolset` takes as `source`                                                                                                                                    | `@orkestrel/mcp`'s `ModelContextInterface`, returned by `createModelContext`, whose `emitter` and `adopt()` satisfy the contract structurally and which carries no census                                                                                | [the type test](../tests/src/browser/types.test.ts) assigns the model context to the contract and refuses a shape without `adopt`; [the composition cases](../tests/src/browser/factories.test.ts) run the installed bridge over this package's double |
| The registry twin's annotation mapping | `BrowserRegistry.adopt()` projects a `BrowserToolAnnotation` onto `@orkestrel/tool`'s annotations: `readOnly` to `pure`, `consequential` to `consequential`, `untrusted` always `true`; a `debugging` tool is skipped by the toolset, and `autosubmit` is retained on the protocol tool alone | the domain's `Annotation` type carries `readOnly`, `untrustedContent`, `consequential`, `debugging`, and `autosubmit`; the specification source's `ToolAnnotations` carries `readOnlyHint`, `untrustedContentHint`, `consequentialHint`, and `debugging` | [the mapping rows](../tests/conformance.test.ts) drive the real `adopt()` over mirror-shaped tools, and [the registry proof](../tests/src/core/BrowserRegistry.test.ts) pins the untrusted mark and the synthetic `what`                               |
| The domain mirror the registry parses  | `parseBrowserTool`, `parseBrowserRemoval`, `parseBrowserInvocation`, and `parseBrowserInvocationResult`; the registry sends `enable`, `disable`, `invokeTool`, and `cancelInvocation` and subscribes `toolsAdded`, `toolsRemoved`, `toolInvoked`, and `toolResponded`                         | the `WebMCP` domain of `browser_protocol.json`: the `Tool`, `Annotation`, and `RemovedTool` types, the `InvocationStatus` values `Completed`, `Canceled`, and `Error`, the four commands, and the four events                                            | [the conformance project](../tests/conformance.test.ts) compares every property the parsers read against [the domain mirror](../tests/mirrors/webmcp-domain-dc2ddf369035.json), and every command and event name the registry uses                     |
| The declarative form                   | the element managers mark a form that a registered tool's `backendNodeId` names (CDP), or that carries a `toolname` attribute (DOM), as `[tool=NAME]` after its role and name                                                                                                                 | the declarative attributes of Chrome's explainer; the specification's declarative section is a TODO at revision `19fc56516057`                                                                                                                           | [the CDP mark](../tests/conformance.test.ts) and [the DOM mark](../tests/src/browser/factories.test.ts) each render `e5 form "Search cars" [tool=search-cars]`                                                                                         |

## Declared conformance gaps

`npm run test:conformance` runs [`tests/conformance.test.ts`](../tests/conformance.test.ts) in Node with the browser disabled, and `npm test` includes it. It starts no browser: it reads three vendored mirrors through [`tests/setupConformance.ts`](../tests/setupConformance.ts), whose reader checks each file's raw-byte SHA-256 against a pinned constant at module load, so a changed byte throws before a row runs. Each row compares one coordinate of an authority with what this package ships and is ruled implement, retain, or exclude; every exclusion names its closer.

The following table records each mirror's upstream, revision, and pin.

| Mirror                                                                                | Upstream                                                                                                                                  | Revision       | SHA-256                                                            |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| [`webmcp-index-19fc56516057.bs`](../tests/mirrors/webmcp-index-19fc56516057.bs)       | the specification source `index.bs` of `webmachinelearning/webmcp`, whole                                                                 | `19fc56516057` | `e6c9b9790fd5cabc11662bbfeb296a6919388d8fd3f23bf7c85258059948b1b9` |
| [`webmcp-webref-e6ba3d7abea7.idl`](../tests/mirrors/webmcp-webref-e6ba3d7abea7.idl)   | webref's `interfaces/webmcp.idl` as `web-platform-tests/wpt` carries it for its `idlharness` case, whole                                  | `e6ba3d7abea7` | `eddabc7932e9fdfe5e7c48efffb6fe4606657c5f45c9799038d361775802f332` |
| [`webmcp-domain-dc2ddf369035.json`](../tests/mirrors/webmcp-domain-dc2ddf369035.json) | the `WebMCP` domain of `json/browser_protocol.json` in `ChromeDevTools/devtools-protocol`, cut at bytes 1404474 to 1415819, end exclusive | `dc2ddf369035` | `13fb565428f1fc1e09bca51b1234536c5c8da77adf0bd952700e6cdbbc4f1bf6` |

The whole protocol file the domain was cut from is pinned without being vendored, at `672d8481c92832907211e85488e216cd5b1a922fde273faff72f7f6cf765899e`. The web-platform-tests `webmcp/` tree at revision `e6ba3d7abea7` is recorded as a listing, [`wpt-webmcp-e6ba3d7abea7.txt`](../tests/mirrors/wpt-webmcp-e6ba3d7abea7.txt). Refresh the mirrors on each version bump of this package and whenever `@orkestrel/mcp`'s bridge advances its reading date: fetch the three files at their upstream heads, record each commit, cut the domain again by byte range, pin the digests again, and rule every row that reddens as implement, retain, or exclude.

**The web-platform-tests cases do not run.** The listing at `e6ba3d7abea7` holds 88 entries, 55 under `webmcp/imperative/` and 28 under `webmcp/declarative/`. Those cases drive a browser's `document.modelContext`, and none of them runs against this package's double, [`tests/fixtures/modelContext.ts`](../tests/fixtures/modelContext.ts). **What it costs:** the double is checked member by member against webref's IDL, and its behavior is checked only by this package's own composition cases. **Closer:** a testharness runner under the Playwright provider that runs those cases against the double.

**The domain's `Tool.stackTrace` is not read.** Every other property of the mirror's `Tool`, `Annotation`, and `RemovedTool` types is one name a parser reads. **What it costs:** an agent never sees where in the page a tool was registered. **Closer:** a developer diagnostics consumer; `stackTrace` is a developer datum, excluded from the agent surface.

**Page tool names follow the providers' rule, not the specification's.** The specification source admits 1 to 128 code points of ASCII alphanumerics, `_`, `-`, and `.`. `BROWSER_TOOL_NAME_PATTERN` admits 1 to 64 of ASCII alphanumerics, `_`, and `-`, the narrowest rule among the model providers the fleet targets, so the toolset skips a page tool named `a.b` or one longer than 64 code points and emits `skip` with `pattern`. **What it costs:** a page tool with such a name is not advertised. **Closer:** the provider charset and bound documented beside `BROWSER_TOOL_NAME_PATTERN` in `src/core/constants.ts`, widened when the providers admit the specification's rule.

**The declarative form runs ahead of the specification source.** The source's declarative section reads "entirely a TODO" at `19fc56516057` and names no `toolname`, `tooldescription`, or `toolautosubmit` attribute, so the `[tool=NAME]` outline mark follows Chrome's explainer. **What it costs:** the mark can drift from the attributes a specification later names. **Closer:** the specification's declarative section.

**webref lags the specification source.** webref's IDL at `e6ba3d7abea7` declares `ontoolchange` alone and three hints, while the source at `19fc56516057` also declares `ontoolactivated`, `ontoolcancel`, and the `debugging` annotation. This package's double declares the source's members, ahead of webref. **What it costs:** the IDL rows compare against the older member list. **Closer:** a webref extraction carrying the source's handlers and the `debugging` annotation.

**`autosubmit` is retained and marked nowhere.** The domain's `Annotation` carries `autosubmit` and the source's `ToolAnnotations` does not, so `BrowserToolAnnotation.autosubmit` keeps the wire value, and no adopted hint and no outline mark carries it. **What it costs:** an agent cannot tell that a page tool submits its form on its own. **Closer:** an `autosubmit` hint in the specification source.

**A `debugging` page tool is not adopted.** The specification marks such a tool for developers, so the toolset skips it with `debugging`, whether it arrives through the registry or through a source census. **What it costs:** none for an agent. **Closer:** an explicit developer-tool opt-in, outside the agent toolset.

**Every page tool is untrusted, whatever its hint.** A page's `untrustedContentHint` of `false` does not lower the mark, because the protocol describes `toolResponded.output` as untrusted and a prompt injection risk, and the conformance project re-reads that description on every run. **What it costs:** a model sees every page tool's output under `untrusted`. **Closer:** none wanted; this is the package's trust boundary.

**The live `WebMCP` domain is unproven on this host.** Chromium 141, the host browser of the service project, answers `WebMCP.enable` with `-32601` and lists no `WebMCP` in `Schema.getDomains`, so [the live service case](../tests/service/browser.test.ts) skips with that reason. Chrome DevTools MCP 1.10.1, read on 2026-09-29, drives the domain on Chrome 150 launched with `--enable-features=WebMCP`. The runtime type of `toolResponded.output` and the code `WebMCP.enable` answers on such a Chrome without the flag are unread; a code other than `-32601` rethrows. **What it costs:** the registry is proven against the in-memory transport, `CDPTestServer`, and the domain mirror, and against no shipping registry. **Closer:** the service project on Chrome 150 or later launched with `--enable-features=WebMCP`.

**The in-page composition runs against a double.** No shipping browser exposes `document.modelContext`, so the composition of `@orkestrel/mcp`'s bridge with `createDocumentToolset` runs against this package's double, and its block for a real registry collects nothing; the absence path asserts that neither `document` nor `navigator` carries a registry, so a registry at either location reddens rather than skips. **What it costs:** the specification's registry location, `Document` in the source against `Navigator` in Chrome's intent, and `executeTool`'s result shape stay unread. **Closer:** a browser that ships `document.modelContext`.

## Contract

These invariants hold across the three faces (`src/core`, `src/browser`, and `src/server`) and this guide. Each names the test that pins it.

1. **Doc ↔ source bijection.** Every row of the `### Core`, `### Server`, and `### Browser` Surface tables is a real export of its face's barrel, and every barrel export appears as a row, exhaustive in each direction; the declarations a barrel does not re-export are the implementation classes [`tests/guides.test.ts`](../tests/guides.test.ts) lists as internal. Every `ts` fence imports only real exports of `@orkestrel/browser`, `@orkestrel/browser/browser`, or `@orkestrel/browser/server`.
2. **Core is environment-agnostic.** `src/core` imports only `@orkestrel/contract`, `@orkestrel/emitter`, `@orkestrel/html`, `@orkestrel/markdown`, and `@orkestrel/tool`: no `node:*`, no `WebSocket`, no DOM, and no filesystem. `@orkestrel/html` and `@orkestrel/markdown` are string-to-tree-to-string work with no host of their own, and `@orkestrel/tool` supplies the `ToolInterface` and `ToolManagerInterface` values the toolset fills, never re-exported. Every CDP method call and event flows through the injected `CDPTransportInterface`. Host-side CDP boundaries use `@orkestrel/contract` guards; raw `typeof` and `instanceof` checks appear only inside compiled expressions that run in the remote page. The `browser → html` edge is one-way, and `BrowserSnapshot` navigates CDP DOM snapshots rather than HTML source, so it never gains rendering, extraction, or distillation. `src/browser` imports the core, `@orkestrel/contract`, and `@orkestrel/emitter`; `src/server` imports the core, `@orkestrel/contract`, `@orkestrel/emitter`, `@orkestrel/websocket`, and `node:*`; neither imports the other. The scoped `check:src:core`, `check:src:browser`, and `check:src:server` projects and [`tests/config.test.ts`](../tests/config.test.ts) pin the boundaries.
3. **The transport is a dumb text pipe.** `CDPTransportInterface` does no JSON framing of its own; `CDPClient` owns request and response correlation, timeouts, abort signals, and event dispatch over the transport's raw `message`, `close`, and `error` events. [`tests/src/core/CDPClient.test.ts`](../tests/src/core/CDPClient.test.ts) pins it.
4. **Captured bytes never touch a filesystem in core.** A page accepts an optional `BrowserWriterInterface`, injected through `BrowserContext`, and calls `write(path, bytes)` only when a screenshot, PDF, trace, or HAR request carries a `path`; the server supplies `createBrowserWriter` through `Browser`. [`tests/src/server/writers/FileBrowserWriter.test.ts`](../tests/src/server/writers/FileBrowserWriter.test.ts) pins the writer.
5. **The server owns the connection lifecycle, and launch readiness is an event.** `Browser.connect()` tries, in order: an explicit `cdp.endpoint`; a passive probe of `{cdp.host}:{cdp.port}` through `discover()`; then a launch. A launch spawns the executable with `--remote-debugging-port` set to `cdp.port`, or to `0` so the operating system picks the port when none is given, with standard error piped, and `readBrowserEndpoint` resolves the `ws://` endpoint from the `DevTools listening on` line the browser prints there, reading across chunk boundaries and draining the stream afterwards. No HTTP request polls for readiness. A found browser is preferred over a launch; `engine` narrows discovery to a preferred engine, and a `BrowserConnectionError` carries the requested `engine` when none matches. `disconnect()` retains process ownership, and `discover: false` probes the port directly and rejects with a coded `BrowserConnectionError` naming an occupied port. [`tests/src/server/Browser.test.ts`](../tests/src/server/Browser.test.ts) resolves a launch with no `GET /json/version` recorded, and [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) pins the endpoint read.
6. **Lifecycle events are observable, never polled.** `BrowserInterface.emitter` fires `idle`, `discover`, `connect`, `disconnect`, `launch`, `page`, `context`, `error`, and `destroy`; `CDPClientInterface.emitter` fires `connect`, `close`, `drop`, and `error`; the codegen emitter is retained and fires `start`, `stop`, `action`, and `clear`. A page fires `navigate` with `[url, same]` for both a cross-document and a same-document navigation, `session` when an out-of-process frame's session attaches, `popup` for each page it opens, and `dialog`, `close`, and the network and worker events; a context fires `page` for each page it publishes, popups included. A page a context constructs holds its target on the client's connection, and the first such page on a connection enables `Target.setDiscoverTargets` for it; a second live page for a held target is refused with `BROWSER_TARGET_HELD`, and a `create()` that meets a page another path published for its target joins that page, or rejects with `BROWSER_PAGE_CLOSED` when that page closed. A page constructed directly holds no target, enables no discovery, and counts as published when its setup completes. A discovered popup is published once, after its opener, through the opener's `popup`, the context's `page`, and `pages()`. Limit: when the page holding a popup's target fails its setup, discovery publishes nothing, and a later `sync()` adds the target without a `popup` from its opener. The registry fires `change`, `invoke`, and `respond`, and the toolset `adopt`, `skip`, and `select`. Every wait parks on a protocol event, a DOM observer, or an abort signal, and a `setTimeout` survives only as a deadline; the one liveness probe with no event source is the bounded drain of a terminated process group, at `BROWSER_DRAIN_INTERVAL_MS` in `src/server`. An external disconnect emits a coded `error` before `disconnect`; transport loss with the process alive is resumable, and a process exit is terminal. [`tests/src/core/BrowserPage.test.ts`](../tests/src/core/BrowserPage.test.ts) and [`tests/src/core/BrowserCodegen.test.ts`](../tests/src/core/BrowserCodegen.test.ts) pin the page and codegen events, and [`tests/src/core/BrowserContext.test.ts`](../tests/src/core/BrowserContext.test.ts) pins target ownership, the joined creation, and popup publication.
7. **Errors carry a machine-readable `code` and an optional `context`.** `BrowserError` is the base; `CDPError`, `CDPConnectionError`, `CDPTimeoutError`, `BrowserResultLimitError`, `BrowserConnectionError`, and `BrowserElementError` (core) narrow protocol, connectivity, timeout, oversized-result, connection, and element faults; `BrowserNotConnectedError` and `BrowserDestroyedError` (server) narrow the lifecycle. `BrowserConnectionError` lives in the core because the in-page `SocketCDPTransport` throws it too. A `BrowserElementError` carries `context.reason`, one of `GONE`, `HIDDEN`, `OCCLUDED`, `DISABLED`, `UNTRUSTED`, and `UNKNOWN`, and a one-line message that ends `; call look for fresh refs.` for `GONE` alone. Each class ships an `is*` guard. [`tests/src/core/errors.test.ts`](../tests/src/core/errors.test.ts) and [`tests/src/server/errors.test.ts`](../tests/src/server/errors.test.ts) pin them.
8. **Oversized results fail clean.** `evaluate()` and `read()` wrap their in-page result with `compileGuardedEvaluateExpression(expression, BROWSER_RESULT_LIMIT)`, which throws the `BROWSER_RESULT_LIMIT_SENTINEL_PREFIX` sentinel before an oversized result could overflow the transport frame; the frame recognizes it through `BROWSER_RESULT_LIMIT_PATTERN` and rejects with a coded `BrowserResultLimitError`, and the connection and the browser process are unaffected. [`tests/service/browser.test.ts`](../tests/service/browser.test.ts) pins both against a real browser.
9. **Codegen normalizes and compiles to a script that runs against the element manager.** `normalizeCodegenActions` collapses consecutive `fill` actions on one selector to the latest value; `compileCodegenScript` emits one `page.navigate(...)` statement per navigation and, per element action, `(await page.elements.find({ css: SELECTOR }))[0]` followed by the element action, as `'javascript'` or `'typescript'` per `BrowserCodegenScriptOptions.language`. [`tests/src/core/compilers.test.ts`](../tests/src/core/compilers.test.ts) pins the output, and [`tests/service/browser.test.ts`](../tests/service/browser.test.ts) replays a recorded `#save` click through its compiled script.
10. **Doc ↔ source method bijection.** Each `## Methods` table lists exactly the call-signature members of its interface, inherited members included, and each implementing class named for its interface exposes no public method its table omits; `BrowserElementInterface` is documented through its members' rows in the `BrowserPageElementInterface` table. Every other export is a function or a data bag. [`tests/guides.test.ts`](../tests/guides.test.ts) pins it.
11. **The WebSocket transports are thin bridges.** `WebSocketCDPTransport` (server) and `SocketCDPTransport` (in-page) connect a `WebSocket` to the CDP debugger URL, race the opening against `timeout` (default `BROWSER_DEFAULT_TIMEOUT_MS`), and bridge the socket's `message`, `close`, and `error` events onto their emitter unchanged. `start()` rejects with a `BrowserConnectionError` carrying the URL on a socket error, a non-open close, or the timeout, and `send` before `start` throws the same coded error. A browser launched without `--remote-allow-origins` naming the caller's origin refuses the in-page handshake. [`tests/src/server/transports/WebSocketCDPTransport.test.ts`](../tests/src/server/transports/WebSocketCDPTransport.test.ts) and [`tests/src/browser/transports/SocketCDPTransport.test.ts`](../tests/src/browser/transports/SocketCDPTransport.test.ts) pin them.
12. **`Browser.destroy()` escalates SIGTERM to SIGKILL; `close()` is graceful.** On POSIX each launch owns an isolated process group, and `destroy()` signals that group, waiting `BROWSER_KILL_GRACE_MS` before `SIGKILL` and the same bounded window after it; on Windows a launch owns no group, so each step signals one process by identifier, and terminating a Chromium browser process takes its subprocesses with it. `close()` sends CDP `Browser.close` first and escalates to the same sequence only when an owned process fails to exit within the grace period. `owned` is `true` for a launched or adopted session, `false` for an active attachment, and `undefined` when no session is represented; `pid` names the process serving the endpoint and stays readable across a `'persistent'` session's `disconnect()`. [`tests/src/server/Browser.test.ts`](../tests/src/server/Browser.test.ts) pins the sequence against a spawned stand-in process.
13. **A launch owns the process that serves its endpoint, through the inherited pipe.** Chrome and Chromium serve the endpoint from the process they spawn. A launcher such as Microsoft Edge on Windows instead re-executes the browser with the same `--remote-debugging-port` and exits 0 before the endpoint answers, and the process it spawned inherits its standard error, so `connect()` treats that clean exit as a hand-off: it keeps reading the same pipe on the same `timeout` budget until the `DevTools listening on` line arrives, then reads the `browser` entry of CDP `SystemInfo.getProcessInfo` and owns the process named there. A nonzero exit or a signal rejects at once with a `BrowserConnectionError` naming the exit; a pipe that closes without the line rejects with the readiness failure; an endpoint that names no browser process rejects after a best-effort `Browser.close`. Whether Edge's Windows launcher passes the pipe on is unread; see limit 25. The launcher hand-off cases in [`tests/src/server/Browser.test.ts`](../tests/src/server/Browser.test.ts) pin the rest.
14. **A snapshot is serializable data plus navigation.** `BrowserSnapshot` holds exactly `documents` and `styles`, so `JSON.stringify(snapshot)` yields `{ documents, styles }` and `createBrowserSnapshot(parsed)` navigates it again; every method takes and returns bare `BrowserNode` values, and containment is derived from `ancestors`. [`tests/src/core/BrowserSnapshot.test.ts`](../tests/src/core/BrowserSnapshot.test.ts) pins it.
15. **A reference names one element for as long as that element exists.** A reference is `e` followed by a positive integer. On CDP every page's element manager mints from one counter its browser context owns and binds the reference to `SESSION:BACKEND`, because backend node ids are per renderer; in the DOM placement the view owns the counter and binds a `WeakRef`. No number is reused within the context. A cross-document navigation of the main frame drops every reference, a child frame's navigation or detachment drops that frame's, and a stale or unknown reference refuses `GONE` or `UNKNOWN` with a message naming `look`. `parseBrowserReference` accepts `e12`, `E12`, `12`, `[e12]`, `ref=e12`, and `[ref=e12]`. [`tests/src/core/elements/BrowserElementManager.test.ts`](../tests/src/core/elements/BrowserElementManager.test.ts), [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts), and [`tests/src/browser/elements/BrowserDOMElementManager.test.ts`](../tests/src/browser/elements/BrowserDOMElementManager.test.ts) pin it.
16. **A reading is captured one time and sliced from one projection.** `frame.read()` issues one size-guarded evaluation in the isolated world; `markdown` and `text` each project the capture one time per mode and cut every slice from it, ending a bounded slice after the last line break in its window when one lies past `offset`. Truncation is derived as `offset + text.length < total`, and `stale` is derived from the navigation epoch, never stored. [`tests/src/core/BrowserReading.test.ts`](../tests/src/core/BrowserReading.test.ts) and [`tests/src/core/BrowserPage.test.ts`](../tests/src/core/BrowserPage.test.ts) pin it.
17. **The registry mirrors the domain and settles every invocation.** `start()` subscribes before it enables, because enabling reports every registered tool; a `-32601` answer unsubscribes and resolves `false`, and any other failure rethrows. `execute` never passes the signal to `invokeTool`, so the invocation id always arrives; an abort or a deadline sends `WebMCP.cancelInvocation` with that id and rejects without waiting for `Canceled`; a navigation or detachment of the tool's frame and `destroy` reject; every terminal status resolves a `BrowserInvocationResult`. A `toolResponded` with an unknown id is held only while an `invokeTool` reply is pending. [`tests/src/core/BrowserRegistry.test.ts`](../tests/src/core/BrowserRegistry.test.ts) pins it.
18. **Actions run one at a time.** The toolset runs actions in first-in, first-out order, and an action holds the queue until its receipt is produced; an action whose signal aborts while queued sends nothing. After a `mousePressed` or `keyDown` is sent, the matching release is sent without the signal, so an abort never leaves a button or key down, and the next action waits for a pending release. Every result and error message is cut at `limit` characters plus a footer. The queue, bounds, and destroy cases in [`tests/src/core/BrowserToolset.test.ts`](../tests/src/core/BrowserToolset.test.ts) pin it.
19. **A dialog interrupts every tool and stages `dialog`.** Every pending step of every tool is raced against the page's `dialog` event, so a tool returns a receipt naming the dialog while the blocked command waits; the `dialog` tool is advertised while the dialog is open and bypasses the queue, and every other tool refuses with a message naming the open dialog and ending `call dialog.` The dialog cases in [`tests/src/core/BrowserToolset.test.ts`](../tests/src/core/BrowserToolset.test.ts) and the P14 and P20 cases in [`tests/service/toolset.test.ts`](../tests/service/toolset.test.ts) pin it.
20. **CDP input is trusted and DOM input is not.** A page's `trusted` is `true`: clicks, keys, and hovers are `Input` events whose `isTrusted` is `true`. A DOM view's `trusted` is `false`: `click` is `HTMLElement.click()`, `fill` is the native value setter plus `input` and `change`, and `submit` is `requestSubmit()` observed by a `submit` listener, so a form that fails validation reports `did not submit` with the field's `validationMessage`. Its `click` and `type` receipts end `(untrusted event)`. It refuses rather than fakes a key press, a navigation, a file chooser, typing into `contenteditable`, a link or form whose target opens another browsing context, a disabled control, and a cross-origin frame. [`tests/src/browser/elements/BrowserDOMElement.test.ts`](../tests/src/browser/elements/BrowserDOMElement.test.ts) and [`tests/service/document.test.ts`](../tests/service/document.test.ts) pin it.
21. **The toolset's names are reserved at `start()`.** `start()` rejects with a coded `BrowserError` and adds nothing when the manager already holds `look`, `read`, `click`, `type`, `press`, `navigate`, `wait`, `dialog`, `tabs`, or `switch` under a tool the toolset did not add, and a page tool under a reserved name is skipped with `reserved`. A consumer that replaces a reserved name after `start()` breaks the path a receipt names, such as `call dialog`. [`tests/src/core/BrowserToolset.test.ts`](../tests/src/core/BrowserToolset.test.ts) pins it.
22. **The in-page toolset never drives its own document by default.** An action that navigates the realm's own document cannot return, so `createBrowserDOMView` and `createDocumentToolset` refuse `globalThis.document` with `BROWSER_DOCUMENT_OWN` unless `own` is `true`. [`tests/src/browser/factories.test.ts`](../tests/src/browser/factories.test.ts) pins it.
23. **Limit: an `alert()` blocks the driven document.** The DOM placement never replaces `window.alert`, `confirm`, or `prompt`, so a click that opens one blocks the driven document's thread and the action does not return until a person answers it; the CDP placement stages `dialog` instead. [`tests/guides.test.ts`](../tests/guides.test.ts) pins that no `src/browser` module assigns those functions.
24. **Limit: a `debugging` page tool is not adopted.** The toolset skips a tool marked `debugging` with `debugging`, whether the flag reaches it through the registry or a source census; `@orkestrel/mcp`'s bridge excludes such tools from `adopt()` unless asked. [`tests/src/core/BrowserToolset.test.ts`](../tests/src/core/BrowserToolset.test.ts) and the skip rows of [`tests/conformance.test.ts`](../tests/conformance.test.ts) pin it.
25. **Limit: the `WebMCP` live proof names its host.** The registry has run against no shipping `WebMCP` domain: the host Chromium 141 answers `-32601`, so [`tests/service/browser.test.ts`](../tests/service/browser.test.ts) skips its live case with that reason while its P15 case asserts `registry.start()` equals whether `Schema.getDomains` lists `WebMCP`. The closer is the service project on Chrome 150 or later launched with `--enable-features=WebMCP`. The stderr hand-off through Microsoft Edge's Windows launcher is unread on this host for the same reason: it needs a Windows host with Edge.

## Patterns

### Automate a page end-to-end

This demonstration launches a headless browser, fills and submits a search form, waits for the
results, and reads the resulting content.

```ts
import { createBrowser } from '@orkestrel/browser/server'

const browser = createBrowser({ headless: true })
await browser.connect()

const page = await browser.create({ url: 'https://example.com' })
const [search] = await page.elements.find({ css: '#search' })
await search?.fill('orkestrel')
const [submit] = await page.elements.find({ css: '#submit' })
await submit?.click()
await page.elements.wait({ css: '#results' })
const reading = await page.read()

await browser.destroy()
```

### Record and replay interactions with codegen

This demonstration records a click and a fill on a page, then compiles the recorded actions into
a replayable script.

```ts
const page = await browser.create({ url: 'https://example.com' })
const codegen = await page.codegen()

const [menu] = await page.elements.find({ css: '#menu' })
await menu?.click()
const [search] = await page.elements.find({ css: '#search' })
await search?.fill('orkestrel')

const actions = await codegen.stop()
const script = codegen.script({ language: 'typescript' })
await codegen.destroy()
```

### Reattach to a running session

A `'persistent'` (profile-backed) launch survives `disconnect()` — the
browser process keeps running, so a later `Browser` can reattach to it through
CDP discovery on the same fixed port. A reattached instance connects as
`'cdp'`, so its own `destroy()` detaches locally and does nothing more — it never sends a
remote close, because another client may still be using the browser:

```ts
import { createBrowser } from '@orkestrel/browser/server'

const port = 9222
const browser = createBrowser({ profile: './profile', cdp: { port } })
await browser.connect() // launches (no browser yet listening on `port`)
const pid = browser.pid // supervise this process externally if desired

await browser.disconnect() // retains ownership without killing the browser

// ...later, in this process or another...
const reattached = createBrowser({ cdp: { port } })
await reattached.connect() // discovers the still-running browser over CDP
const urls = reattached
	.context()
	?.pages()
	.map((page) => page.url) // correct immediately, no navigate() needed
await reattached.destroy() // detaches locally and nothing more; the browser process keeps running
await browser.destroy() // the original owner terminates and awaits its process
```

An ephemeral launch (no `profile`) can also disconnect and reconnect while its
owning `Browser` instance and process remain alive. A transport-loss disconnect
is likewise resumable — the same `browser` instance can `connect()` again
without a fresh `createBrowser()`.

When the original owner is unavailable, a connected CDP client can explicitly
assume responsibility before disconnecting. Ownership is state, not a string
mode: `owned` is `true` for launched/adopted sessions, `false` for an active
attachment, and `undefined` when no session is represented.

```ts
const browser = createBrowser({ cdp: { port } })
await browser.connect()
browser.adopt()
await browser.disconnect()
await browser.connect()
await browser.destroy() // closes the adopted remote browser
```

### Gracefully shut down a reattached session

Use `close()` instead of `destroy()` to terminate a browser this instance
merely attached to (or launched) — it sends CDP
`Browser.close` and, when this instance owns the process, awaits its exit
before falling back to the kill-escalation `destroy()` uses:

```ts
const reattached = createBrowser({ cdp: { port } })
await reattached.connect() // discovers the still-running browser over CDP

await reattached.close() // best-effort CDP Browser.close; because this instance never owned the process, it does not wait for the remote exit
// a further connect() on this instance throws BrowserDestroyedError, same as after destroy()
```

### Drive the core client directly over an injected transport

Useful when embedding in a non-Node environment, or in a test with a fake
transport that satisfies `CDPTransportInterface`.

```ts
import { createCDPClient } from '@orkestrel/browser'

const client = createCDPClient({ transport: myTransport })
await client.connect()

const result = await client.send('Page.navigate', { url: 'https://example.com' })
client.subscribe('Page.frameNavigated', (params) => log(params))

await client.close()
```

### Drive a page with a small model

A 2-billion-parameter model passes browser tasks when the tools and the prompt follow the rules the model runs established: every tool declares at least one required parameter, so `look`, `read`, and `tabs` take `what`; references are spelled `e4` and the parameter descriptions name one; one observation carries text and references in document order; every action's receipt carries the fresh view; and the first turn carries the view, so the model starts from the page rather than from a guess. The system prompt says that the model sees the page only through tools and must call one before it answers, and names the one call for each kind of step: `read` with `what` set to the question and then with the offset its result names to learn a fact, `type` with `submit` to search, `click` with a reference from the latest result to press or follow, and `wait` one time for text that has not appeared.

With that prompt, `qwen3.5:2b-q4_K_M` at temperature 0 with 256 predicted tokens a turn passed four of the five store tasks in `@orkestrel/ollama` on their first attempt against a build of this package packed on 2026-09-30 from the tree this guide describes: read (a fact absent from the seeded view, found by one `read`), click (the cart holding the named product, the receipt showing the cart page), form (the confirmation code read from the receipt after the submit), and paging (a `read` continued at the offset the footer named returning the slice with the token; the model's answer summarised the policy without it, which the proof records and does not assert). The search task is pinned as an expected failure: the model called `click` on the search box, received `Clicked e35 searchbox "Search products"; call type with e35 to enter text.`, and ended its turn empty, in every vocabulary the campaign tried; a click on an element whose role is in `BROWSER_TYPED_ROLES` names `type` as the next call, as [Receipts](#receipts) shows, and the pin reddens when the model completes the flow.

The following fence seeds the first turn with the toolset's own `look` result, the way the store proof in `@orkestrel/ollama` runs each task, and bounds the run to 8 turns.

```ts
import { createAgent } from '@orkestrel/agent'
import { createBrowserToolset } from '@orkestrel/browser'
import { createOllama } from '@orkestrel/ollama'
import { createToolManager } from '@orkestrel/tool'

const system =
	'You control a web browser with tools and must call a tool before you answer. ' +
	'The first message shows the page as look returns it; references such as e4 name its elements. ' +
	'To learn a fact, call read with what set to your question; when its result ends by naming an offset, call read again with that offset. ' +
	'To search, call type with the search box reference, the words, and submit true. ' +
	'To press a button or follow a link, call click with its reference from the latest result. Never invent a reference. ' +
	'If text you expect has not appeared, call wait once. ' +
	'When the task is done, answer in one short sentence.'

const toolset = createBrowserToolset(page, { tools: createToolManager() })
await toolset.start()
try {
	const seeded = await toolset.tools.execute({
		id: 'seed',
		name: 'look',
		arguments: { what: 'the page' },
	})
	const view = seeded.success ? String(seeded.value) : seeded.error
	const agent = createAgent(createOllama({ model: 'qwen3.5:2b-q4_K_M' }), {
		system,
		tools: toolset.tools,
		limit: 8,
	})
	agent.context.messages.add({
		role: 'user',
		content: `Add the Alpine Kettle to the cart.\n\nThe browser shows this page:\n${view}`,
	})
	const result = await agent.generate()
	log(result.content)
} finally {
	await toolset.destroy()
}
```

Read the task's outcome from the page, never from the model's answer: the store proof checks the cart, the submitted query, and the read fact against the page state after each run.

### Host the toolset over MCP

A toolset's manager is an ordinary `@orkestrel/tool` manager, so `@orkestrel/mcp` hosts it for an MCP client. The following fence serves the browser vocabulary over stdio.

```ts
import { createBrowserToolset } from '@orkestrel/browser'
import { createBrowser } from '@orkestrel/browser/server'
import { createMCPServer } from '@orkestrel/mcp'
import { createStdioServer } from '@orkestrel/mcp/server'

const browser = createBrowser({ headless: true })
await browser.connect()
const page = await browser.create({ url: 'https://example.com' })
const toolset = createBrowserToolset(page)
await toolset.start()
const server = createMCPServer({
	identity: { name: 'browser', version: '0.0.19' },
	tools: toolset.tools,
})
await createStdioServer(server).start()
```

The page tools the page registers join the manager as they are adopted and leave it as they are removed, so the client's next `tools/list` sees them.

### Publish native tools to a page

A page that runs a built-in browser agent reads tools from its WebMCP registry, and `@orkestrel/mcp`'s bridge publishes a tool manager there. Publish `toolset.native`, never `toolset.tools`: the manager also holds the page tools the toolset adopted from the same registry, and publishing them would register each one as a proxy of itself. The following fence drives a same-origin child document, adopts that document's page tools through the bridge, and publishes the five generic tools back to it.

```ts
import { createDocumentToolset } from '@orkestrel/browser/browser'
import { createModelContext } from '@orkestrel/mcp/browser'
import { createToolManager } from '@orkestrel/tool'

const driven = frame.contentDocument
const bridge = driven === null ? undefined : createModelContext({ document: driven })
if (driven !== null && bridge !== undefined) {
	const toolset = createDocumentToolset({ document: driven, source: bridge })
	await toolset.start() // adopts the document's registered tools, and again on each change
	const native = createToolManager()
	for (const tool of toolset.native) native.add(tool) // look, read, click, type, wait
	await bridge.publish(native)
}
```

`createModelContext` returns `undefined` on a browser that ships no `document.modelContext`; see [Declared conformance gaps](#declared-conformance-gaps) for what that leaves unproven.

## Tests

The suites run as Vitest projects, each with a fixed scope:

- `src:core` runs [`tests/src/core`](../tests/src/core) in Node against real entities over an in-memory CDP transport whose replies each test scripts; `src:server` runs [`tests/src/server`](../tests/src/server) in Node against spawned stand-in processes and in-process CDP servers; `src:browser` runs [`tests/src/browser`](../tests/src/browser) in Playwright's Chromium, with a browser launched by this package's own `createBrowser` for the socket transport. `npm run test:src` runs all three.
- `guides` runs [`tests/guides.test.ts`](../tests/guides.test.ts) in Node through `npm run test:guides`; `conformance` runs [`tests/conformance.test.ts`](../tests/conformance.test.ts) in Node against the pinned mirrors; `policy`, `config`, `setup`, and `setup:browser` prove the workspace rules, the configuration, and the shared test infrastructure. `npm test` runs every project named so far.
- `service` runs [`tests/service`](../tests/service) against a real Chromium-family browser on the host and is outside `npm test`; `distribution` packs and installs the package and runs from `prepublishOnly`.

The following list names each test file and what it proves.

- [`tests/guides.test.ts`](../tests/guides.test.ts): the three faces' Surface tables against their barrels, each Methods table against its interface and implementing class, every compared summary and titled example against its source, every fence's imports, every relative link, the README pitch against this guide's tagline, the transcribed `Drive a page with a small model` fence run against a scripted page, and the absence of a page-dialog override in `src/browser`.
- [`tests/conformance.test.ts`](../tests/conformance.test.ts): the parsers, commands, events, annotation mapping, skips, and declarative mark against the revision-named `WebMCP` mirrors, and the export scan that keeps `WebMCP` and `ModelContext` out of every exported name.
- [`tests/policy.test.ts`](../tests/policy.test.ts): the workspace rules, including the banned-term sweep over authored Markdown.
- [`tests/config.test.ts`](../tests/config.test.ts): the aliases, the registered projects and their scopes, the target wrappers, and the scripts that gate each proof.
- [`tests/distribution.test.ts`](../tests/distribution.test.ts): the packed archive a consumer installs, its three faces, and their declarations under every module resolution.
- [`tests/setup.test.ts`](../tests/setup.test.ts): the scripted CDP fixtures, the element and registry replies, and the compiled-timer instrument the core suites use.
- [`tests/setupBrowser.test.ts`](../tests/setupBrowser.test.ts): the same-origin probe documents the in-page suites drive.
- [`tests/setupConformance.test.ts`](../tests/setupConformance.test.ts): the mirror reader's digest refusal on a changed byte and the row readers the conformance project uses.
- [`tests/setupGlobal.test.ts`](../tests/setupGlobal.test.ts): the global setup that serves fixtures and launches the browser the in-page suites reach.
- [`tests/setupServer.test.ts`](../tests/setupServer.test.ts): the ports, processes, scratch directories, CDP test server, and fixture pages the server and service suites share.
- [`tests/setupService.test.ts`](../tests/setupService.test.ts): the service project's browser flags, engine selection, and registry reading.
- [`tests/service/browser.test.ts`](../tests/service/browser.test.ts): a real browser's launch, navigation, elements, frames, routes, snapshots, PDF, result limits, reattachment, transport loss, and shutdown; the out-of-process frame click, occlusion, hit-test, stale-reference, reading, and wait proofs; the `WebMCP` domain reading and its live case; and the replay of a codegen recording.
- [`tests/service/toolset.test.ts`](../tests/service/toolset.test.ts): one toolset task end to end through `createToolManager().execute`, the `confirm()` and `beforeunload` dialogs, popups and tabs, and each receipt within its deadline.
- [`tests/service/document.test.ts`](../tests/service/document.test.ts): the built in-page face served into a real page and compared with the CDP outline of the same page, and its untrusted receipts against CDP's trusted ones.
- [`tests/src/core/CDPClient.test.ts`](../tests/src/core/CDPClient.test.ts): JSON-RPC framing, session scoping, timeouts, abort signals, reconnects, and teardown over an in-memory transport.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts): the core factories, including a toolset that fills the supplied manager only at `start()`.
- [`tests/src/core/BrowserContext.test.ts`](../tests/src/core/BrowserContext.test.ts): the context lifecycle, the destructive target diff `sync()` performs, and the popups its pages open.
- [`tests/src/core/BrowserPage.test.ts`](../tests/src/core/BrowserPage.test.ts): navigation, both navigation events, out-of-process frame sessions, readiness, the page input stream, text waits, and popups.
- [`tests/src/core/BrowserFrame.test.ts`](../tests/src/core/BrowserFrame.test.ts): evaluation, readings, handles, sends with timeouts and signals, and the result-size guard of one frame.
- [`tests/src/core/BrowserTransition.test.ts`](../tests/src/core/BrowserTransition.test.ts): the shared in-flight transition every joining caller awaits.
- [`tests/src/core/BrowserReading.test.ts`](../tests/src/core/BrowserReading.test.ts): distilled and whole Markdown and text, line-break slicing with a constant total, and derived staleness.
- [`tests/src/core/BrowserRegistry.test.ts`](../tests/src/core/BrowserRegistry.test.ts): detection, the mirror, invocation settlement, cancellation, adoption, and destroy over the `WebMCP` domain.
- [`tests/src/core/BrowserToolset.test.ts`](../tests/src/core/BrowserToolset.test.ts): the vocabulary, reserved names, dialogs, the action queue, views and tabs, page-tool adoption, bounds, destroy, and the trust marker.
- [`tests/src/core/elements/BrowserElement.test.ts`](../tests/src/core/elements/BrowserElement.test.ts): the ordered trusted click, its refusals, key and pointer releases after an abort, and the remaining element actions.
- [`tests/src/core/elements/BrowserElementManager.test.ts`](../tests/src/core/elements/BrowserElementManager.test.ts): the outline, session-qualified references, invalidation, queries, waits, and the one isolated world per document.
- [`tests/src/core/BrowserHandle.test.ts`](../tests/src/core/BrowserHandle.test.ts): remote-handle retention and disposal.
- [`tests/src/core/compilers.test.ts`](../tests/src/core/compilers.test.ts): the in-page expressions the wait, read, select, hit, screenshot, storage, and codegen compilers emit, with one deadline timer per wait.
- [`tests/src/core/BrowserKeyboard.test.ts`](../tests/src/core/BrowserKeyboard.test.ts): trusted keyboard input and the chord grammar `extractBrowserChord` accepts.
- [`tests/src/core/BrowserMouse.test.ts`](../tests/src/core/BrowserMouse.test.ts): trusted mouse input and the pressed-button mask.
- [`tests/src/core/BrowserTouch.test.ts`](../tests/src/core/BrowserTouch.test.ts): trusted touch input.
- [`tests/src/core/BrowserNetworkManager.test.ts`](../tests/src/core/BrowserNetworkManager.test.ts): request observation, bodies, extra headers, offline mode, and credentials.
- [`tests/src/core/BrowserRoute.test.ts`](../tests/src/core/BrowserRoute.test.ts): interception decided exactly one time by fulfilment, continuation, or abort.
- [`tests/src/core/BrowserHARManager.test.ts`](../tests/src/core/BrowserHARManager.test.ts): HAR recording and replay.
- [`tests/src/core/BrowserWebSocket.test.ts`](../tests/src/core/BrowserWebSocket.test.ts): observed WebSocket frames.
- [`tests/src/core/BrowserDownload.test.ts`](../tests/src/core/BrowserDownload.test.ts): download progress and `abort`.
- [`tests/src/core/BrowserSnapshot.test.ts`](../tests/src/core/BrowserSnapshot.test.ts): snapshot walking, structural relationships, search, paths, and the serializable form.
- [`tests/src/core/BrowserAccessibility.test.ts`](../tests/src/core/BrowserAccessibility.test.ts): accessibility-tree capture.
- [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts): the coercions every protocol parser applies to off-shape input, and the reference spellings `parseBrowserReference` accepts.
- [`tests/src/core/BrowserClock.test.ts`](../tests/src/core/BrowserClock.test.ts): the virtual clock.
- [`tests/src/core/BrowserCoverage.test.ts`](../tests/src/core/BrowserCoverage.test.ts): JavaScript and CSS coverage.
- [`tests/src/core/BrowserProfiler.test.ts`](../tests/src/core/BrowserProfiler.test.ts): the sampled CPU profile.
- [`tests/src/core/BrowserTracing.test.ts`](../tests/src/core/BrowserTracing.test.ts): a trace streamed back through the IO domain.
- [`tests/src/core/BrowserPerformance.test.ts`](../tests/src/core/BrowserPerformance.test.ts): Performance-domain metrics.
- [`tests/src/core/BrowserDiagnostics.test.ts`](../tests/src/core/BrowserDiagnostics.test.ts): the diagnostics teardown, which discards a failure from an already-stopped capability.
- [`tests/src/core/BrowserCookieManager.test.ts`](../tests/src/core/BrowserCookieManager.test.ts): context-scoped cookies.
- [`tests/src/core/BrowserStorageManager.test.ts`](../tests/src/core/BrowserStorageManager.test.ts): context-scoped web storage as one serializable state.
- [`tests/src/core/BrowserPermissionManager.test.ts`](../tests/src/core/BrowserPermissionManager.test.ts): context-scoped permission overrides.
- [`tests/src/core/BrowserEmulationManager.test.ts`](../tests/src/core/BrowserEmulationManager.test.ts): context-scoped emulation and the overrides a later page inherits.
- [`tests/src/core/BrowserScriptManager.test.ts`](../tests/src/core/BrowserScriptManager.test.ts): new-document scripts and host bindings.
- [`tests/src/core/BrowserCodegen.test.ts`](../tests/src/core/BrowserCodegen.test.ts): action recording, its events, and script compilation.
- [`tests/src/core/BrowserDialog.test.ts`](../tests/src/core/BrowserDialog.test.ts): accepting and dismissing a dialog.
- [`tests/src/core/BrowserFileChooser.test.ts`](../tests/src/core/BrowserFileChooser.test.ts): uploading to and dismissing a file chooser.
- [`tests/src/core/BrowserWorker.test.ts`](../tests/src/core/BrowserWorker.test.ts): attached workers.
- [`tests/src/core/BrowserNavigationManager.test.ts`](../tests/src/core/BrowserNavigationManager.test.ts): URL waits across both navigation kinds, network idle, and abort.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts): the pure decoders, validators, and renderers of `src/core`, the receipt and outline formats included.
- [`tests/src/core/errors.test.ts`](../tests/src/core/errors.test.ts): the guard that narrows a caught value to each core error.
- [`tests/src/browser/BrowserDOMView.test.ts`](../tests/src/browser/BrowserDOMView.test.ts): reading, staleness on the Navigation API, following the window, text waits, and destroy.
- [`tests/src/browser/BrowserDOMWait.test.ts`](../tests/src/browser/BrowserDOMWait.test.ts): the mutation-parked wait across frames and shadow roots, its deadline, abort, and `pagehide`.
- [`tests/src/browser/elements/BrowserDOMElement.test.ts`](../tests/src/browser/elements/BrowserDOMElement.test.ts): untrusted click, fill, select, and submit, and each refusal they name.
- [`tests/src/browser/elements/BrowserDOMElementManager.test.ts`](../tests/src/browser/elements/BrowserDOMElementManager.test.ts): the DOM outline, references, bindings, queries, and waits.
- [`tests/src/browser/factories.test.ts`](../tests/src/browser/factories.test.ts): the in-page factories, the own-document refusal, and the composition with `@orkestrel/mcp`'s bridge over this package's WebMCP double.
- [`tests/src/browser/helpers.test.ts`](../tests/src/browser/helpers.test.ts): role, name, text, visibility, and traversal helpers.
- [`tests/src/browser/types.test.ts`](../tests/src/browser/types.test.ts): the structural fit of `@orkestrel/mcp`'s model context to `BrowserToolSourceInterface`, and each in-page class against its core contract.
- [`tests/src/browser/transports/SocketCDPTransport.test.ts`](../tests/src/browser/transports/SocketCDPTransport.test.ts): the in-page socket transport against a real browser, with a browser launched without `--remote-allow-origins` as its control.
- [`tests/src/server/Browser.test.ts`](../tests/src/server/Browser.test.ts): the discover, connect, launch, adopt, disconnect, destroy, and close lifecycle against a spawned stand-in process, the endpoint read from standard error, and the launcher hand-off.
- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts): system-browser discovery, profiles, the endpoint read, and target fetching.
- [`tests/src/server/factories.test.ts`](../tests/src/server/factories.test.ts): the server factories against real files and a real in-process CDP endpoint.
- [`tests/src/server/errors.test.ts`](../tests/src/server/errors.test.ts): the guard that narrows a caught value to each server error.
- [`tests/src/server/integration.test.ts`](../tests/src/server/integration.test.ts): a registry invocation settled from a reply and an event sent in one socket write.
- [`tests/src/server/transports/WebSocketCDPTransport.test.ts`](../tests/src/server/transports/WebSocketCDPTransport.test.ts): the `WebSocket`-backed transport against a real in-process CDP server.
- [`tests/src/server/writers/FileBrowserWriter.test.ts`](../tests/src/server/writers/FileBrowserWriter.test.ts): the filesystem writer that creates its missing parent directories.
