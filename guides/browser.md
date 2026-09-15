# Browser

> A lightweight Chrome DevTools Protocol automation layer for Chromium-family
> browsers: an environment-agnostic core that drives pages, frames, locators, and
> DOM snapshots over an injected transport, and a Node runtime that finds,
> launches, and connects to the browser itself.

`CDPClient` frames JSON-RPC-shaped CDP messages over the transport, `BrowserContext` and
`BrowserPage` model a CDP browser context and its pages, `BrowserSnapshot` turns a captured DOM
snapshot into navigable serializable data, and `BrowserCodegen` records page interactions for later
script compilation — none of it touching `WebSocket`, `node:*`, or a filesystem, so the same code
runs under Node or in a page. One capability reaches past the protocol: `article()` distills a
captured document to its reader-facing prose through `@orkestrel/html`, selecting content rather
than dumping the whole body's text. The Node pieces are `WebSocketCDPTransport`, a `WebSocket`-backed
CDP transport; `Browser`, which spawns a real Chromium-family process when nothing is already
listening on the CDP endpoint; and a filesystem-backed browser writer. Import the
environment-agnostic core from `@orkestrel/browser` and the Node runtime from
`@orkestrel/browser/server`. Source: [`src/core`](../src/core) (through `@src/core`) and
[`src/server`](../src/server) (through `@src/server`).

## Surface

### Connect to a browser and drive a page

Connect to an already-running browser, or launch one, then open a page and drive it:

```ts
import { createBrowser } from '@orkestrel/browser/server'

const browser = createBrowser({ headless: true })
await browser.connect() // CDP endpoint discovery → connect, else launch
const page = await browser.create({ url: 'https://example.com' })
await page.click('#accept')
const shot = await page.screenshot({ path: './out.png' })
await browser.destroy()
```

### Drive the core client over an injected transport

Drive the CDP client from any environment over a transport that satisfies
`CDPTransportInterface`:

```ts
import { createCDPClient } from '@orkestrel/browser'

const client = createCDPClient({ transport }) // transport: CDPTransportInterface
await client.connect()
const targets = await client.send('Target.getTargets')
await client.close()
```

### Core

#### Factories

| API                     | Kind     | Summary                                                                                  |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `createCDPClient`       | function | Creates a `CDPClientInterface` bound to the given `CDPTransportInterface`.               |
| `createBrowserSnapshot` | function | Creates a navigable `BrowserSnapshotInterface` over decoded `BrowserSnapshotInput` data. |

#### Classes

| API               | Kind  | Summary                                                                                |
| ----------------- | ----- | -------------------------------------------------------------------------------------- |
| `CDPClient`       | class | Provides a lightweight Chrome DevTools Protocol client over a `CDPTransportInterface`. |
| `BrowserContext`  | class | Owns pages and shared state inside one Chromium browser context.                       |
| `BrowserFrame`    | class | Represents one attached document frame, evaluated through its own CDP execution world. |
| `BrowserPage`     | class | Represents a top-level browser page, including its target lifecycle and child frames.  |
| `BrowserCodegen`  | class | Records page navigation and form interactions and compiles replayable scripts.         |
| `BrowserSnapshot` | class | Represents a navigable, serializable browser DOM snapshot.                             |

#### Constants

A `Shape` cell holds the constant's declared type.

| Constant                               | Kind  | Shape                              | Summary                                                                                                                                                                                                                                                          |
| -------------------------------------- | ----- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_DEFAULT_TIMEOUT_MS`           | const | `number`                           | Sets the default timeout for browser connection, requests, and navigation, `30_000` milliseconds.                                                                                                                                                                |
| `BROWSER_WAIT_POLL_INTERVAL_MS`        | const | `number`                           | Sets the poll interval while waiting for a selector to appear, `100` milliseconds.                                                                                                                                                                               |
| `BROWSER_DEFAULT_VIEWPORT_WIDTH`       | const | `number`                           | Sets the default viewport width, `1280` pixels.                                                                                                                                                                                                                  |
| `BROWSER_DEFAULT_VIEWPORT_HEIGHT`      | const | `number`                           | Sets the default viewport height, `720` pixels.                                                                                                                                                                                                                  |
| `BROWSER_CODEGEN_BINDING_NAME`         | const | `string`                           | Names the CDP runtime binding the codegen recorder script calls into, `'__orkestrelBrowserCodegen'`.                                                                                                                                                             |
| `BROWSER_CODEGEN_SOURCE`               | const | `string`                           | Holds the in-page recorder script injected through `Page.addScriptToEvaluateOnNewDocument` and `Runtime.evaluate`.                                                                                                                                               |
| `BASE64_CHARS`                         | const | `string`                           | Holds the index-ordered base64 alphabet used to build `BASE64_LOOKUP`.                                                                                                                                                                                           |
| `BASE64_LOOKUP`                        | const | `Readonly<Record<string, number>>` | Maps each base64 character to its 6-bit value, derived from `BASE64_CHARS`.                                                                                                                                                                                      |
| `BROWSER_RESULT_LIMIT`                 | const | `number`                           | Caps the serialized-character length for an `evaluate()`/`content()` result at `2_500_000`, enforced in-page before the result is returned to CDP.                                                                                                               |
| `BROWSER_RESULT_LIMIT_SENTINEL_PREFIX` | const | `string`                           | Names the distinctive prefix for the in-page result-limit sentinel error, `'[[ORKESTREL_BROWSER_RESULT_LIMIT]]'`, immediately followed by the serialized length.                                                                                                 |
| `BROWSER_RESULT_LIMIT_PATTERN`         | const | `RegExp`                           | Matches the in-page result-limit sentinel error message, anchored immediately after the `Error:` (optionally `Uncaught Error:`) prefix Chromium prepends to a thrown error's description, `/^(?:Uncaught )?Error: \[\[ORKESTREL_BROWSER_RESULT_LIMIT\]\](\d+)/`. |
| `BROWSER_STOP_LOADING_TIMEOUT_MS`      | const | `number`                           | Bounds the best-effort `Page.stopLoading` call issued after a failed `navigate()` at `1_000` milliseconds.                                                                                                                                                       |
| `BROWSER_FRAME_WORLD_NAME`             | const | `string`                           | Names the isolated world used for iframe evaluation, `'__orkestrelBrowserFrame'`.                                                                                                                                                                                |
| `BROWSER_SNAPSHOT_NODE_LIMIT`          | const | `number`                           | Sets the default maximum node count accepted from a decoded CDP DOM snapshot, `100_000`.                                                                                                                                                                         |

#### Errors

| Error                     | Kind  | Signature              | Summary                                                                                                                                                                                                                                      |
| ------------------------- | ----- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserError`            | class | `extends Error`        | Represents the base error for all browser automation operations, carrying the code `BROWSER_ERROR` and a `context` record.                                                                                                                   |
| `BrowserSelectorError`    | class | `extends BrowserError` | Reports that a selector-based lookup or wait timed out without the element appearing, under the code `BROWSER_SELECTOR_ERROR`.                                                                                                               |
| `CDPError`                | class | `extends BrowserError` | Reports that a CDP request received an error response from the remote endpoint, under the code `BROWSER_CDP_ERROR`, with the `method`, the CDP `code`, the `message`, and any `data` in its context.                                         |
| `CDPConnectionError`      | class | `extends BrowserError` | Reports that a CDP request could not be sent or completed because the client was not in a connectable state — not connected, closed while connecting, or the connection dropped mid-request — under the code `BROWSER_CDP_CONNECTION_ERROR`. |
| `CDPTimeoutError`         | class | `extends BrowserError` | Reports that a pending CDP request was not answered within its timeout window, under the code `BROWSER_CDP_TIMEOUT_ERROR`.                                                                                                                   |
| `BrowserResultLimitError` | class | `extends BrowserError` | Reports that an `evaluate()`/`content()` result exceeded `BROWSER_RESULT_LIMIT` and was rejected in-page before it could overflow the CDP transport frame, under the code `BROWSER_RESULT_LIMIT_ERROR`.                                      |

In a guard table a `Shape` cell holds the type the guard narrows to.

| Guard                       | Kind     | Shape                     | Summary                                                  |
| --------------------------- | -------- | ------------------------- | -------------------------------------------------------- |
| `isBrowserError`            | function | `BrowserError`            | Narrows an unknown value to a `BrowserError`.            |
| `isBrowserSelectorError`    | function | `BrowserSelectorError`    | Narrows an unknown value to a `BrowserSelectorError`.    |
| `isCDPError`                | function | `CDPError`                | Narrows an unknown value to a `CDPError`.                |
| `isCDPConnectionError`      | function | `CDPConnectionError`      | Narrows an unknown value to a `CDPConnectionError`.      |
| `isCDPTimeoutError`         | function | `CDPTimeoutError`         | Narrows an unknown value to a `CDPTimeoutError`.         |
| `isBrowserResultLimitError` | function | `BrowserResultLimitError` | Narrows an unknown value to a `BrowserResultLimitError`. |

```ts
try {
	await page.wait('#missing')
} catch (error) {
	if (isBrowserSelectorError(error)) log(error.code)
	else if (isCDPError(error)) log(error.code, error.context)
	else if (isCDPConnectionError(error)) log(error.code)
	else if (isCDPTimeoutError(error)) log(error.code)
	else if (isBrowserResultLimitError(error)) log(error.code, error.context)
	else if (isBrowserError(error)) log(error.code)
}
```

#### Helpers

| API                                | Kind     | Summary                                                                                                                                                                                             |
| ---------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decodeBase64`                     | function | Decodes a base64-encoded string into raw bytes.                                                                                                                                                     |
| `compileGuardedEvaluateExpression` | function | Compiles a `Runtime.evaluate` expression so the in-page code stringifies its own result and throws a recognizable sentinel error before an oversized result would overflow the CDP transport frame. |
| `normalizeCodegenActions`          | function | Normalizes recorded codegen actions, collapsing consecutive `fill` actions on the same selector into the latest value.                                                                              |
| `parseCodegenActionPayload`        | function | Coerces a codegen binding payload string to a `BrowserCodegenAction`, or `undefined` off-shape.                                                                                                     |
| `parseCodegenNavigateAction`       | function | Coerces a `Page.frameNavigated` CDP event to a `navigate` codegen action, or `undefined` off-shape and for every frame but the top-level one.                                                       |
| `compileCodegenScript`             | function | Compiles recorded codegen actions into a replayable JavaScript or TypeScript script.                                                                                                                |
| `readEvaluationResult`             | function | Decodes one CDP `Runtime.evaluate` result, throwing a `BrowserError` on a failed evaluation and a `BrowserResultLimitError` past the guarded result size.                                           |
| `requireBrowserString`             | function | Requires an evaluated browser value to be a string.                                                                                                                                                 |
| `readBrowserFrames`                | function | Decodes a flattened CDP `Page.getFrameTree` result into depth-first frame metadata, skipping every off-shape frame.                                                                                 |
| `compileAttachedWaitExpression`    | function | Compiles an in-page wait for an attached selector.                                                                                                                                                  |
| `compileDetachedWaitExpression`    | function | Compiles an in-page wait for a detached selector.                                                                                                                                                   |
| `compileVisibleWaitExpression`     | function | Compiles an in-page wait for a visible selector.                                                                                                                                                    |
| `compileHiddenWaitExpression`      | function | Compiles an in-page wait for a hidden selector.                                                                                                                                                     |
| `compileClickExpression`           | function | Compiles a strict, visibility-checked click expression.                                                                                                                                             |
| `compileFillExpression`            | function | Compiles a strict, editable fill expression.                                                                                                                                                        |
| `compileSelectExpression`          | function | Compiles a strict select expression.                                                                                                                                                                |
| `parseNumberArray`                 | function | Coerces an unknown value to an all-number array, or `undefined` off-shape.                                                                                                                          |
| `parseSnapshotString`              | function | Coerces one CDP snapshot string-table index to its string, or `undefined` off-shape.                                                                                                                |
| `readRareStringData`               | function | Decodes CDP snapshot sparse string data into a node-index map, skipping every off-shape entry.                                                                                                      |
| `readRareBooleanData`              | function | Decodes CDP snapshot sparse boolean data into a set of node indexes, skipping every off-shape entry.                                                                                                |
| `readRareIntegerData`              | function | Decodes CDP snapshot sparse integer data into a node-index map, skipping every off-shape entry.                                                                                                     |
| `parseBrowserRect`                 | function | Coerces a four-number CSS-pixel rectangle to a `BrowserRect`, or `undefined` off-shape.                                                                                                             |
| `readBrowserAttributes`            | function | Decodes flattened CDP node attributes into a frozen record, skipping every off-shape pair.                                                                                                          |
| `readBrowserSnapshot`              | function | Decodes a CDP `DOMSnapshot.captureSnapshot` result into a serializable `BrowserSnapshotInput`, throwing a `BrowserError` off-shape and a `BrowserResultLimitError` past the configured node limit.  |
| `isBrowserNodeQuery`               | function | Tests whether a browser-node matcher is a declarative query rather than a predicate.                                                                                                                |
| `matchesBrowserNode`               | function | Tests a captured node against a declarative query.                                                                                                                                                  |
| `isBrowserNodeVisible`             | function | Tests whether a captured node has a non-empty rendered layout box.                                                                                                                                  |

```ts
import {
	compileGuardedEvaluateExpression,
	normalizeCodegenActions,
	parseCodegenActionPayload,
	parseCodegenNavigateAction,
	compileCodegenScript,
	readEvaluationResult,
	requireBrowserString,
	readBrowserFrames,
	compileAttachedWaitExpression,
	compileDetachedWaitExpression,
	compileVisibleWaitExpression,
	compileHiddenWaitExpression,
	compileClickExpression,
	compileFillExpression,
	compileSelectExpression,
	parseNumberArray,
	parseSnapshotString,
	readRareStringData,
	readRareBooleanData,
	readRareIntegerData,
	parseBrowserRect,
	readBrowserAttributes,
	readBrowserSnapshot,
	matchesBrowserNode,
	isBrowserNodeVisible,
} from '@orkestrel/browser'

const guarded = compileGuardedEvaluateExpression('document.title', 3_000_000) // wrapped expression string
const actions = normalizeCodegenActions(rawActions)
const action = parseCodegenActionPayload(payload) // BrowserCodegenAction | undefined
const navigate = parseCodegenNavigateAction(frameNavigatedParams)
const script = compileCodegenScript(actions, { language: 'typescript' })
const value = readEvaluationResult(runtimeResult)
const title = requireBrowserString(value, 'Title')
const frames = readBrowserFrames(frameTreeResult)
const attached = compileAttachedWaitExpression('#result', true, 30_000)
const detached = compileDetachedWaitExpression('.spinner', true, 30_000)
const visible = compileVisibleWaitExpression('#result', true, 30_000)
const hidden = compileHiddenWaitExpression('.spinner', true, 30_000)
const click = compileClickExpression('#submit', true)
const fill = compileFillExpression('#query', 'browser', true)
const select = compileSelectExpression('#region', ['us'], true)
const numbers = parseNumberArray([1, 2, 3])
const text = parseSnapshotString(snapshotStrings, 1)
const rareStrings = readRareStringData(rawRareStrings, snapshotStrings)
const rareBooleans = readRareBooleanData(rawRareBooleans)
const rareIntegers = readRareIntegerData(rawRareIntegers)
const rect = parseBrowserRect([0, 0, 100, 40])
const attributes = readBrowserAttributes(rawAttributes, snapshotStrings)
const decoded = readBrowserSnapshot(rawSnapshot, ['display']) // BrowserSnapshotInput
const node = decoded.documents[0].nodes[0]
const id = node.attributes['id']
const article = matchesBrowserNode(node, { name: 'article', visible: true })
const rendered = isBrowserNodeVisible(node)
```

Navigating decoded data is the `BrowserSnapshot` entity's job, not a helper
family's — see [`BrowserSnapshotInterface`](#browsersnapshotinterface) later.

#### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`. An extended interface's name comes before `plus`, with the members it adds after.

| Type                          | Kind      | Shape                                                                                                                                                                                                                                     | Summary                                                                                                                                                                                                                   |
| ----------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CDPTransportEventMap`        | type      | `{ message, close, error }`                                                                                                                                                                                                               | Maps the events emitted by a `CDPTransportInterface` — the raw text pipe a `CDPClientInterface` sends and receives JSON-RPC frames over.                                                                                  |
| `CDPTransportInterface`       | interface | `{ emitter } plus start, send, close`                                                                                                                                                                                                     | Represents the text pipe a `CDPClient` sends and receives JSON-RPC frames over.                                                                                                                                           |
| `CDPClientOptions`            | interface | `{ transport, timeout?, on?, error? }`                                                                                                                                                                                                    | Describes the options for creating a `CDPClient` instance.                                                                                                                                                                |
| `CDPHandler`                  | type      | `(params: Readonly<Record<string, unknown>>) => void`                                                                                                                                                                                     | Receives a subscribed CDP event with its params record.                                                                                                                                                                   |
| `CDPClientEventMap`           | type      | `{ connect, close, drop, error }`                                                                                                                                                                                                         | Maps the events a `CDPClientInterface` emits.                                                                                                                                                                             |
| `CDPTarget`                   | interface | `{ id, category, title, url }`                                                                                                                                                                                                            | Represents one entry of the CDP `Target.getTargets` result.                                                                                                                                                               |
| `CDPClientInterface`          | interface | `{ emitter, connected } plus connect, reconnect, send, subscribe, unsubscribe, close`                                                                                                                                                     | Provides a lightweight Chrome DevTools Protocol client over a `CDPTransportInterface`.                                                                                                                                    |
| `CDPSendOptions`              | interface | `{ session?, timeout? }`                                                                                                                                                                                                                  | Describes the options for one CDP method call.                                                                                                                                                                            |
| `BrowserWriterInterface`      | interface | `{} plus write`                                                                                                                                                                                                                           | Provides a pluggable sink for persisting captured browser bytes to a path.                                                                                                                                                |
| `BrowserViewport`             | interface | `{ width, height, scale?, mobile?, touch?, landscape? }`                                                                                                                                                                                  | Describes the viewport dimensions for a browser page.                                                                                                                                                                     |
| `BrowserWaitUntil`            | type      | `'commit' \| 'load' \| 'domcontentloaded'`                                                                                                                                                                                                | Names the page load condition for navigation — the CDP load event awaited by `navigate()`.                                                                                                                                |
| `BrowserPageOptions`          | interface | `{ on?, error?, url?, viewport?, timeout? }`                                                                                                                                                                                              | Describes the options for creating a `BrowserPage` instance.                                                                                                                                                              |
| `BrowserNavigationOptions`    | interface | `{ condition?, timeout? }`                                                                                                                                                                                                                | Describes the options for page navigation.                                                                                                                                                                                |
| `BrowserActionOptions`        | interface | `{ timeout?, strict?, force?, trial? }`                                                                                                                                                                                                   | Describes the options for element interaction (click, fill, select, wait).                                                                                                                                                |
| `BrowserWaitState`            | type      | `'attached' \| 'detached' \| 'visible' \| 'hidden'`                                                                                                                                                                                       | Names an element state a frame or page can wait for.                                                                                                                                                                      |
| `BrowserWaitOptions`          | interface | `BrowserActionOptions plus { state? }`                                                                                                                                                                                                    | Describes the options for waiting on an element.                                                                                                                                                                          |
| `BrowserScreenshotOptions`    | interface | `{ path?, full?, format?, quality?, clip?, transparent?, animations?, caret?, scale?, mask?, color? }`                                                                                                                                    | Describes the options for taking a page screenshot.                                                                                                                                                                       |
| `BrowserContentResult`        | interface | `{ url, title, html, text }`                                                                                                                                                                                                              | Describes the result of page content extraction.                                                                                                                                                                          |
| `BrowserScreenshotResult`     | interface | `{ bytes, path }`                                                                                                                                                                                                                         | Describes the result of a page screenshot.                                                                                                                                                                                |
| `BrowserCodegenAction`        | type      | `{ action: 'navigate', url } \| { action: 'click', selector } \| { action: 'fill', selector, value } \| { action: 'select', selector, values }`                                                                                           | Represents one recorded browser action captured during a codegen session.                                                                                                                                                 |
| `BrowserCodegenEventMap`      | type      | `{ start, stop, action, clear }`                                                                                                                                                                                                          | Maps the events a `BrowserCodegenInterface` emits.                                                                                                                                                                        |
| `BrowserCodegenOptions`       | interface | `{ on?, error? }`                                                                                                                                                                                                                         | Describes the options for creating a `BrowserCodegen` recorder.                                                                                                                                                           |
| `BrowserCodegenLanguage`      | type      | `'javascript' \| 'typescript'`                                                                                                                                                                                                            | Names the target language for a compiled codegen script.                                                                                                                                                                  |
| `BrowserCodegenScriptOptions` | interface | `{ language? }`                                                                                                                                                                                                                           | Describes the options for compiling recorded actions into a script.                                                                                                                                                       |
| `BrowserCodegenInterface`     | interface | `{ emitter, started } plus start, stop, actions, script, clear, destroy`                                                                                                                                                                  | Records page interactions (navigation, click, fill, select) as a session runs, for later compilation into a replayable script.                                                                                            |
| `BrowserSessionFunction`      | type      | `(frame: string) => Promise<string>`                                                                                                                                                                                                      | Resolves the current CDP session for a frame id.                                                                                                                                                                          |
| `BrowserFrameInfo`            | interface | `{ id, parent, name, url }`                                                                                                                                                                                                               | Describes serializable frame metadata decoded from CDP `Page.getFrameTree`.                                                                                                                                               |
| `BrowserFrameInterface`       | interface | `{ id, parent, name, url, selectors, keyboard, mouse, touch } plus title, content, article, click, fill, select, evaluate, handle, wait, send, subscribe, unsubscribe, save, assert, update`                                              | Provides the operations shared by a top-level page and an iframe document.                                                                                                                                                |
| `BrowserSendOptions`          | interface | `{ timeout? }`                                                                                                                                                                                                                            | Describes the options for one raw CDP method call issued in a frame's target session.                                                                                                                                     |
| `BrowserRect`                 | type      | `readonly [x: number, y: number, width: number, height: number]`                                                                                                                                                                          | Represents a rectangle in CSS pixels: x, y, width, height.                                                                                                                                                                |
| `BrowserLayout`               | interface | `{ bounds, styles, text, paint, offset, scroll, client }`                                                                                                                                                                                 | Describes layout data associated with one captured DOM node.                                                                                                                                                              |
| `BrowserNode`                 | interface | `{ document, frame, index, id, parent, category, name, value, attributes, text, input, checked, selected, clickable, shadow, content, pseudo, source, origin, layout }`                                                                   | Represents one serializable DOM node decoded from a CDP DOM snapshot.                                                                                                                                                     |
| `BrowserDocument`             | interface | `{ index, frame, url, title, nodes, scroll, width, height }`                                                                                                                                                                              | Represents one document captured in a CDP DOM snapshot.                                                                                                                                                                   |
| `BrowserSnapshotInput`        | interface | `{ documents, styles }`                                                                                                                                                                                                                   | Describes the serializable input for a navigable browser snapshot — the form a `BrowserSnapshot` is built from and serializes back to.                                                                                    |
| `BrowserWalkOrder`            | type      | `'depth' \| 'breadth'`                                                                                                                                                                                                                    | Names the structural ordering for a browser snapshot walk.                                                                                                                                                                |
| `BrowserWalkOptions`          | interface | `{ root?, order? }`                                                                                                                                                                                                                       | Describes the options for walking a browser snapshot.                                                                                                                                                                     |
| `BrowserSiblingRelation`      | type      | `'preceding' \| 'following'`                                                                                                                                                                                                              | Names a structural sibling relationship relative to a browser node.                                                                                                                                                       |
| `BrowserSnapshotInterface`    | interface | `BrowserSnapshotInput plus walk, descendants, document, children, parent, siblings, ancestors, common, distance, find, filter, closest, path`                                                                                             | Represents a navigable, serializable snapshot of every document attached to a page, extending `BrowserSnapshotInput` with walking, structural relationships, search, and path derivation over plain `BrowserNode` values. |
| `BrowserSnapshotOptions`      | interface | `{ styles?, paint?, rects?, limit? }`                                                                                                                                                                                                     | Describes the options configuring capture through `BrowserPageInterface` `snapshot()`. The snapshot entity's creation input is `BrowserSnapshotInput`.                                                                    |
| `BrowserNodePredicate`        | type      | `(node: BrowserNode) => boolean`                                                                                                                                                                                                          | Names the predicate form accepted by `BrowserSnapshotInterface` find, filter, and closest methods.                                                                                                                        |
| `BrowserNodeQuery`            | interface | `{ name?, text?, attributes?, frame?, visible?, clickable? }`                                                                                                                                                                             | Describes a declarative browser-node matcher used by `matchesBrowserNode`.                                                                                                                                                |
| `BrowserPageInterface`        | interface | `BrowserFrameInterface plus { emitter, network, navigation, scripts, accessibility, diagnostics, clock, opener, target, closed } plus navigate, reload, back, forward, screenshot, pdf, frame, frames, snapshot, codegen, destroy, close` | Abstracts a single top-level browser page, extending `BrowserFrameInterface` with navigation, screenshots, frame discovery, DOM snapshots, codegen, and target teardown.                                                  |
| `BrowserContextInterface`     | interface | `{ emitter, id, cookies, permissions, storage, emulation } plus page, pages, create, sync, destroy, close`                                                                                                                                | Represents an isolated browser session over a CDP browser context.                                                                                                                                                        |

### Server

Server-side connection lifecycle — discover an already-running browser through
CDP, connect to it, or launch a fresh Chromium-family process:

```ts
import { createBrowser } from '@orkestrel/browser/server'

const browser = createBrowser({ cdp: { port: 9222 } })
const discovery = await browser.discover() // passive probe, no side effects
await browser.connect() // reuses discovery.endpoint if found, else launches
const ctx = browser.context() // the default context (created lazily on `create()`, or eagerly if connect() discovers existing pages)
await browser.destroy() // closes the process and releases resources
```

#### Factories

| API                   | Kind     | Summary                                                                                              |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `createBrowser`       | function | Creates a raw-CDP `BrowserInterface` façade with discovery, connection, and lifecycle management.    |
| `createCDPTransport`  | function | Creates a Node `WebSocket`-backed `CDPTransportInterface` for the given CDP debugger URL.            |
| `createBrowserWriter` | function | Creates a filesystem-backed `BrowserWriterInterface` that persists bytes through `node:fs/promises`. |

#### Classes

| API                     | Kind  | Summary                                                                       |
| ----------------------- | ----- | ----------------------------------------------------------------------------- |
| `Browser`               | class | Discovers, launches, connects to, and owns Chromium-family browser sessions.  |
| `WebSocketCDPTransport` | class | Provides a raw CDP text transport backed by `@orkestrel/websocket`.           |
| `FileBrowserWriter`     | class | Persists captured browser bytes to the filesystem through `node:fs/promises`. |

#### Constants

A `Shape` cell holds the constant's declared type.

| Constant                          | Kind  | Shape                                                | Summary                                                                                                                                                                                                                          |
| --------------------------------- | ----- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_DEFAULT_CDP_PORT`        | const | `number`                                             | Sets the default CDP port probed for an existing browser and used for launches, `9222`.                                                                                                                                          |
| `BROWSER_DEFAULT_HOST`            | const | `string`                                             | Sets the default host probed for an existing browser and used for launches, `'127.0.0.1'`, which avoids `localhost` resolving to `::1` when Chromium binds `127.0.0.1`.                                                          |
| `BROWSER_CDP_PROTOCOL`            | const | `string`                                             | Names the protocol prefix for CDP discovery requests, `'http'`.                                                                                                                                                                  |
| `BROWSER_CDP_VERSION_PATH`        | const | `string`                                             | Names the path appended to the CDP host to fetch version metadata, `'/json/version'`, which is where endpoint discovery reads.                                                                                                   |
| `BROWSER_CDP_LIST_PATH`           | const | `string`                                             | Names the path appended to the CDP host to list open targets — pages, workers, and every other target category Chromium reports — `'/json/list'`.                                                                                |
| `BROWSER_LAUNCH_ARGS`             | const | `readonly string[]`                                  | Lists the flags always passed to a launched browser process, alongside the caller's own.                                                                                                                                         |
| `BROWSER_HEADLESS_ARG`            | const | `string`                                             | Names the flag that enables headless mode on a launched browser process, `'--headless=new'`.                                                                                                                                     |
| `BROWSER_PROFILE_PREFIX`          | const | `string`                                             | Names the prefix for isolated browser profiles created beneath the operating-system temp directory, `'orkestrel-browser-'`.                                                                                                      |
| `BROWSER_KILL_GRACE_MS`           | const | `number`                                             | Bounds each launched-process exit window during TERM-to-KILL teardown at `3_000` milliseconds.                                                                                                                                   |
| `BROWSER_PORT_PROBE_TIMEOUT_MS`   | const | `number`                                             | Bounds the `discover: false` port-occupancy probe before launching at `200` milliseconds, which is short because the probe only needs to detect an already-listening CDP endpoint rather than perform full discovery.            |
| `BROWSER_TRANSPORT_LOSS_DEFER_MS` | const | `number`                                             | Defers once for `50` milliseconds when a transport loss is observed on an owned process, giving a near-simultaneous process-exit event, which libuv may reap slightly later than the socket close, first say over the diagnosis. |
| `BROWSER_PROCESS_EXIT_CAUSE`      | const | `string`                                             | Names the machine-readable error-context cause for an owned browser process exiting, `'process-exit'`.                                                                                                                           |
| `BROWSER_TRANSPORT_LOSS_CAUSE`    | const | `string`                                             | Names the machine-readable error-context cause for a CDP transport disconnecting while its browser remains alive, `'transport-loss'`.                                                                                            |
| `BROWSER_ENV_PATH_KEYS`           | const | `readonly string[]`                                  | Lists the environment variables checked, in order, for an explicit browser executable path override: `PLAYWRIGHT_EXECUTABLE_PATH`, then `CHROME_PATH`.                                                                           |
| `BROWSER_EXECUTABLE_PATHS`        | const | `Readonly<Record<string, readonly string[]>>`        | Lists the well-known Chrome/Chromium/Edge executable paths with no platform-specific root, keyed by `process.platform`, leaving `win32` empty because its roots come from `BROWSER_WINDOWS_SUFFIXES`.                            |
| `BROWSER_WINDOWS_SUFFIXES`        | const | `readonly string[]`                                  | Lists the Windows install-root-relative suffixes for Chrome/Edge/Chromium, joined against each candidate root (`PROGRAMFILES`, `PROGRAMFILES(X86)`, `LOCALAPPDATA`).                                                             |
| `BROWSER_WINDOWS_ROOT_FALLBACKS`  | const | `Readonly<Record<string, string>>`                   | Lists the fallback Windows install roots used when `PROGRAMFILES`, `PROGRAMFILES(X86)`, or `LOCALAPPDATA` is absent.                                                                                                             |
| `BROWSER_EXECUTABLE_NAMES`        | const | `readonly string[]`                                  | Lists the command names probed on PATH when no well-known executable path exists.                                                                                                                                                |
| `BROWSER_STORE_ENV_KEY`           | const | `string`                                             | Names the environment variable that carries an additional Playwright browser store base directory, `'PLAYWRIGHT_BROWSERS_PATH'`.                                                                                                 |
| `BROWSER_STORE_DEFAULT_DIRS`      | const | `readonly string[]`                                  | Lists the well-known Playwright browser store base directories checked in addition to `PLAYWRIGHT_BROWSERS_PATH`, starting with `/opt/pw-browsers`.                                                                              |
| `BROWSER_STORE_CACHE_DIRS`        | const | `Readonly<Record<string, string>>`                   | Names the per-OS default Playwright browser cache directory, relative to the home directory (win32 uses `LOCALAPPDATA` directly).                                                                                                |
| `BROWSER_STORE_LINK_NAME`         | const | `string`                                             | Names the top-level Chromium symlink or binary Playwright maintains inside a browser store base, `'chromium'`.                                                                                                                   |
| `BROWSER_STORE_GLOBS`             | const | `Readonly<Record<string, string>>`                   | Names the glob pattern (relative to a store base) matching a versioned Chromium binary, keyed by `process.platform`.                                                                                                             |
| `BROWSER_ENGINE_HINTS`            | const | `Readonly<Record<BrowserEngine, readonly string[]>>` | Lists the case-insensitive substrings identifying an executable path/name's browser engine, checked by `parseBrowserEngine` in the order `edge` → `chromium` → `chrome`.                                                         |

#### Errors

| Error                      | Kind  | Signature              | Summary                                                                                                                                  |
| -------------------------- | ----- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserConnectionError`   | class | `extends BrowserError` | Reports that a CDP connection, discovery, or launch attempt failed, under the code `BROWSER_CONNECTION_ERROR`.                           |
| `BrowserNotConnectedError` | class | `extends BrowserError` | Reports that an operation requiring an active connection was attempted while disconnected, under the code `BROWSER_NOT_CONNECTED_ERROR`. |
| `BrowserDestroyedError`    | class | `extends BrowserError` | Reports that an operation was attempted after the browser wrapper was destroyed, under the code `BROWSER_DESTROYED_ERROR`.               |

In a guard table a `Shape` cell holds the type the guard narrows to.

| Guard                        | Kind     | Shape                      | Summary                                                   |
| ---------------------------- | -------- | -------------------------- | --------------------------------------------------------- |
| `isBrowserConnectionError`   | function | `BrowserConnectionError`   | Narrows an unknown value to a `BrowserConnectionError`.   |
| `isBrowserNotConnectedError` | function | `BrowserNotConnectedError` | Narrows an unknown value to a `BrowserNotConnectedError`. |
| `isBrowserDestroyedError`    | function | `BrowserDestroyedError`    | Narrows an unknown value to a `BrowserDestroyedError`.    |

```ts
try {
	await browser.connect()
} catch (error) {
	if (isBrowserConnectionError(error)) log(error.code)
	else if (isBrowserNotConnectedError(error)) log(error.code)
	else if (isBrowserDestroyedError(error)) log(error.code)
}
```

#### Helpers

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
| `waitForCDPReady`         | function | Polls a browser's CDP version endpoint until it responds or the timeout elapses.                                                                           |
| `fetchCDPTargets`         | function | Fetches the current CDP target list from a browser's `/json/list` endpoint, as a `Result` carrying either the targets or a coded `BrowserConnectionError`. |

```ts
import {
	createCDPTransport,
	createBrowserWriter,
	findSystemBrowsers,
	findSystemBrowser,
	parseBrowserEngine,
	normalizeExecutablePath,
	browserToEngine,
	createBrowserProfile,
	removeBrowserProfile,
	findEnvOverrides,
	buildInstallPaths,
	buildWindowsRoots,
	findInstallPaths,
	probePathNames,
	readFirstLine,
	buildStoreBases,
	findStorePaths,
	launchBrowserProcess,
	waitForCDPReady,
	fetchCDPTargets,
} from '@orkestrel/browser/server'

const transport = createCDPTransport({ url: 'ws://localhost:9222/devtools/browser/abc' })
const writer = createBrowserWriter()

const browsers = findSystemBrowsers() // readonly SystemBrowser[]
const found = findSystemBrowser() // SystemBrowser | undefined — first entry of findSystemBrowsers()
// findSystemBrowsers({ env: {}, paths: [], names: [], stores: [], engine: 'edge' }) — override any candidate source, narrow by engine

parseBrowserEngine('/usr/bin/msedge') // 'edge'
normalizeExecutablePath('/usr/bin/Chrome', process.platform) // string — case-folded on win32 only
browserToEngine('HeadlessChrome/120.0') // 'chrome' — classifies a /json/version Browser string
const profile = await createBrowserProfile()
await removeBrowserProfile(profile)

// findSystemBrowsers's internal resolution steps, exposed for composition/testing:
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
	const child = launchBrowserProcess(found.executable, 9222, true)
	const debuggerUrl = await waitForCDPReady(9222, 5000)
	const targets = await fetchCDPTargets(9222, 5000) // Result<readonly CDPTarget[], BrowserError>
}
```

#### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| Type                           | Kind      | Shape                                                                                                                                               | Summary                                                                                         |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `BrowserEngine`                | type      | `'chromium' \| 'chrome' \| 'edge'`                                                                                                                  | Names a supported browser engine (raw CDP targets Chromium-family browsers only).               |
| `BrowserConnection`            | type      | `'cdp' \| 'launch' \| 'persistent'`                                                                                                                 | Names how the browser connection was established.                                               |
| `BrowserStatus`                | type      | `'idle' \| 'connecting' \| 'connected' \| 'disconnected' \| 'error'`                                                                                | Names the lifecycle status of a browser wrapper.                                                |
| `BrowserDiscoveryResult`       | interface | `{ endpoint, browser }`                                                                                                                             | Describes the result of passive browser discovery.                                              |
| `SystemBrowserOptions`         | interface | `{ env?, paths?, names?, stores?, engine? }`                                                                                                        | Describes the options overriding `findSystemBrowsers`'/`findSystemBrowser`'s candidate sources. |
| `SystemBrowser`                | type      | `{ executable, engine }`                                                                                                                            | Represents one discovered browser executable on this machine.                                   |
| `BrowserProfileResult`         | interface | `{ path, temporary }`                                                                                                                               | Describes the resolved browser profile directory used for a Chromium-family launch.             |
| `BrowserCDPOptions`            | interface | `{ port?, host?, endpoint?, discover? }`                                                                                                            | Configures the CDP (Chrome DevTools Protocol) connection.                                       |
| `BrowserEventMap`              | type      | `{ idle, discover, connect, disconnect, launch, page, context, error, destroy }`                                                                    | Maps the events a `BrowserInterface` emits.                                                     |
| `BrowserOptions`               | interface | `{ on?, error?, headless?, executable?, profile?, cdp?, timeout?, viewport?, signal?, args?, engine?, browsers? }`                                  | Describes the options for creating a `Browser` instance.                                        |
| `BrowserInterface`             | interface | `{ emitter, engine, status, connection, owned, pid } plus discover, connect, adopt, disconnect, context, contexts, isolate, create, destroy, close` | Wraps a browser with discovery, connection management, and lifecycle control.                   |
| `WebSocketCDPTransportOptions` | interface | `{ on?, error?, url, timeout? }`                                                                                                                    | Describes the options for creating a `WebSocketCDPTransport` instance.                          |

### Extended Chromium automation surface

The focused CDP feature layer is grouped into small classes. Managers expose
single-word operations through `BrowserContextInterface` and
`BrowserPageInterface`; the helpers remain pure so protocol decoding,
validation, scraping, and compilation can be tested without a browser.

#### Extended constants

A `Shape` cell holds the constant's declared type.

| API                            | Kind  | Shape                                          | Summary                                                                                                                                            |
| ------------------------------ | ----- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_HAR_CREATOR`          | const | `{ name, version }`                            | Names the tool identity embedded in HAR 1.2 documents.                                                                                             |
| `BROWSER_KEY_MODIFIERS`        | const | `Readonly<Record<string, number>>`             | Maps a canonical modifier name to its CDP Input modifier bit value.                                                                                |
| `BROWSER_MOUSE_BUTTON_MASKS`   | const | `Readonly<Record<BrowserMouseButton, number>>` | Maps each public mouse button to its CDP Input pressed-button bit value.                                                                           |
| `BROWSER_SCREENSHOT_ATTRIBUTE` | const | `string`                                       | Names the attribute that tags temporary screenshot styles and masks.                                                                               |
| `BROWSER_STABLE_FRAME_COUNT`   | const | `number`                                       | Sets the number of animation frames whose element bounds must agree before trusted input.                                                          |
| `BROWSER_TEST_ID_ATTRIBUTE`    | const | `string`                                       | Names the attribute the semantic test-id selector uses.                                                                                            |
| `BROWSER_VISIBILITY_SOURCE`    | const | `string`                                       | Holds the in-page visibility predicate source, over a `style` computed style and a `rect` bounding box already in scope at the interpolation site. |

#### Extended classes

| API                        | Kind  | Summary                                                                                 |
| -------------------------- | ----- | --------------------------------------------------------------------------------------- |
| `BrowserAccessibility`     | class | Captures Chromium Accessibility-domain snapshots for one page.                          |
| `BrowserClock`             | class | Controls the Chromium virtual-time budget for deterministic page timers.                |
| `BrowserCookieManager`     | class | Performs cookie operations isolated to one browser context.                             |
| `BrowserCoverage`          | class | Collects JavaScript precise coverage and CSS rule usage for one page target.            |
| `BrowserDiagnostics`       | class | Groups the tracing, coverage, performance, and profiler classes beneath one page.       |
| `BrowserEmulationManager`  | class | Applies rendering, identity, location, and network emulation for context pages.         |
| `BrowserHARManager`        | class | Records and replays HTTP archives over one page network manager.                        |
| `BrowserKeyboard`          | class | Sends trusted keyboard input through Chromium's CDP Input domain.                       |
| `BrowserLocator`           | class | Represents a reusable strict semantic locator over one frame.                           |
| `BrowserMouse`             | class | Sends trusted mouse input through Chromium's CDP Input domain.                          |
| `BrowserNavigationManager` | class | Runs URL and page-predicate waits resilient to ordinary navigation events.              |
| `BrowserNetworkManager`    | class | Drives the page-scoped Network and Fetch domain lifecycle.                              |
| `BrowserPerformance`       | class | Reads Performance-domain metrics for one frame.                                         |
| `BrowserPermissionManager` | class | Applies permission overrides isolated to one browser context.                           |
| `BrowserProfiler`          | class | Records sampled JavaScript CPU profiles over one frame's Profiler domain.               |
| `BrowserScriptManager`     | class | Installs new-document scripts and promise-based host functions for one page.            |
| `BrowserSelectorManager`   | class | Creates semantic locators for one frame.                                                |
| `BrowserStorageManager`    | class | Imports, exports, and clears cookie and web-storage state for one browser context.      |
| `BrowserTouch`             | class | Sends trusted touch input through Chromium's CDP Input domain.                          |
| `BrowserTracing`           | class | Captures Chromium traces streamed through the IO domain.                                |
| `BrowserTransition`        | class | Runs one asynchronous transition at a time, shared by every caller that joins it.       |
| `BrowserWebSocket`         | class | Represents an observable WebSocket connection reconstructed from Network-domain events. |

#### Extended helpers

| API                                      | Kind     | Summary                                                                                                                                                   |
| ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browserHARHeadersToRecord`              | function | Converts HAR name/value headers into a Fetch-domain header record.                                                                                        |
| `browserHeadersToProtocol`               | function | Converts a header record to Fetch-domain name/value entries.                                                                                              |
| `browserPDFToParams`                     | function | Validates and compiles Page.printToPDF parameters.                                                                                                        |
| `browserScreenshotToParams`              | function | Validates and compiles basic Page.captureScreenshot parameters.                                                                                           |
| `bytesToText`                            | function | Decodes UTF-8 bytes as text.                                                                                                                              |
| `compileActionabilityFunction`           | function | Compiles the element-side actionability pass used before trusted input.                                                                                   |
| `compileAttachedLocatorWaitExpression`   | function | Compiles an attached-state locator wait.                                                                                                                  |
| `compileBrowserBindingCleanup`           | function | Compiles current-document cleanup for one page-side host binding facade.                                                                                  |
| `compileBrowserBindingResult`            | function | Compiles delivery of a host binding result to one execution context.                                                                                      |
| `compileBrowserBindingSource`            | function | Compiles the page-side promise facade for one Runtime binding.                                                                                            |
| `compileDetachedLocatorWaitExpression`   | function | Compiles a detached-state locator wait.                                                                                                                   |
| `compileFunctionWaitExpression`          | function | Compiles an auto-retrying in-page predicate wait.                                                                                                         |
| `compileHiddenLocatorWaitExpression`     | function | Compiles a hidden-state locator wait.                                                                                                                     |
| `compileLocatorExpression`               | function | Compiles a deep locator query returning its first match.                                                                                                  |
| `compileLocatorListExpression`           | function | Compiles a deep, shadow-aware locator query returning every match.                                                                                        |
| `compileScreenshotCleanupExpression`     | function | Compiles cleanup for temporary screenshot styles and masks.                                                                                               |
| `compileScreenshotPreparationExpression` | function | Compiles temporary animation, caret, and mask setup for a screenshot.                                                                                     |
| `compileStorageClearExpression`          | function | Compiles an expression that clears local and session storage.                                                                                             |
| `compileStorageReadExpression`           | function | Compiles an expression that serializes local and session storage.                                                                                         |
| `compileStorageRestoreExpression`        | function | Compiles an expression that restores one origin's web storage.                                                                                            |
| `compileVisibleLocatorWaitExpression`    | function | Compiles a visible-state locator wait.                                                                                                                    |
| `computeBrowserButtons`                  | function | Computes the CDP Input pressed-button bitmask.                                                                                                            |
| `computeBrowserModifiers`                | function | Computes the CDP Input modifier bitmask.                                                                                                                  |
| `concatBytes`                            | function | Concatenates byte chunks without Node-specific buffers.                                                                                                   |
| `cookieToProtocol`                       | function | Converts a typed cookie input into Chromium protocol fields.                                                                                              |
| `createBrowserHAREntry`                  | function | Builds a standards-shaped HAR 1.2 entry from one observed exchange.                                                                                       |
| `encodeBase64`                           | function | Encodes raw bytes as base64 without relying on Node or DOM globals.                                                                                       |
| `extractBrowserChord`                    | function | Extracts a keyboard chord such as `Control+Shift+P` into its parts, throwing a `BrowserError` on an empty chord or an unsupported modifier.               |
| `keyToBrowserInput`                      | function | Normalizes one key to CDP keyboard event data.                                                                                                            |
| `matchesBrowserCookieURL`                | function | Matches a decoded cookie against one request URL.                                                                                                         |
| `matchesBrowserRoute`                    | function | Matches a request against route criteria.                                                                                                                 |
| `matchesBrowserURL`                      | function | Matches a URL using Chromium-style `*` and `**` glob segments.                                                                                            |
| `mediaToFeatures`                        | function | Converts typed media preferences to Chromium emulated media features.                                                                                     |
| `parseBrowserAXString`                   | function | Coerces a string-valued Accessibility-domain AXValue to a string, or `undefined` off-shape.                                                               |
| `parseBrowserBindingCall`                | function | Coerces one Runtime binding invocation to a `BrowserBindingCall`, or `undefined` off-shape.                                                               |
| `parseBrowserConsoleMessage`             | function | Coerces one `Runtime.consoleAPICalled` event to a `BrowserConsoleMessage`, or `undefined` off-shape.                                                      |
| `parseBrowserCookiePartition`            | function | Coerces an optional Chromium cookie partition key to a `BrowserCookiePartition`, or `undefined` off-shape.                                                |
| `parseBrowserDownloadProgress`           | function | Coerces one `Browser.downloadProgress` event to a `BrowserDownloadProgress`, or `undefined` off-shape.                                                    |
| `parseBrowserDownloadStart`              | function | Coerces one `Browser.downloadWillBegin` event to a `BrowserDownloadStart`, or `undefined` off-shape.                                                      |
| `parseBrowserPageError`                  | function | Coerces one `Runtime.exceptionThrown` event to a `BrowserPageError`, or `undefined` off-shape.                                                            |
| `parseBrowserRequest`                    | function | Coerces one `Network.requestWillBeSent` or `Fetch.requestPaused` event to a `BrowserRequest`, or `undefined` off-shape.                                   |
| `parseBrowserRequestFailure`             | function | Coerces one `Network.loadingFailed` event to a `BrowserRequestFailure`, or `undefined` off-shape.                                                         |
| `parseBrowserResponse`                   | function | Coerces one `Network.responseReceived` event to a `BrowserResponse`, or `undefined` off-shape.                                                            |
| `parseBrowserResponseRecord`             | function | Coerces one Chromium response object plus its event identity to a `BrowserResponse`, or `undefined` off-shape.                                            |
| `parseBrowserSecurity`                   | function | Coerces Chromium TLS security details to a `BrowserSecurity`, or `undefined` off-shape.                                                                   |
| `parseBrowserTiming`                     | function | Coerces Chromium response timing to a `BrowserTiming`, or `undefined` off-shape.                                                                          |
| `parseBrowserTimingRange`                | function | Coerces one named start/end pair of Chromium network timing to a `BrowserTimingRange`, or `undefined` off-shape.                                          |
| `parseBrowserWebSocketFrame`             | function | Coerces one WebSocket frame event to a `BrowserWebSocketFrame`, or `undefined` off-shape.                                                                 |
| `readBrowserAXValue`                     | function | Decodes an Accessibility-domain AXValue, or `undefined` when the record carries none.                                                                     |
| `readBrowserAccessibility`               | function | Decodes Accessibility-domain nodes into a flat serializable tree, throwing a `BrowserError` off-shape.                                                    |
| `readBrowserCookie`                      | function | Decodes one Chromium cookie, throwing a `BrowserError` off-shape.                                                                                         |
| `readBrowserCookies`                     | function | Decodes the cookies `Storage.getCookies` returns, throwing a `BrowserError` off-shape.                                                                    |
| `readBrowserCoverageRanges`              | function | Decodes and normalizes coverage ranges, throwing a `BrowserError` off-shape.                                                                              |
| `readBrowserHeaders`                     | function | Decodes a Chromium Headers object into string values, skipping every entry that is neither a string nor a finite number.                                  |
| `readBrowserMetrics`                     | function | Decodes Performance-domain metrics, throwing a `BrowserError` off-shape.                                                                                  |
| `readBrowserProfile`                     | function | Decodes one CPU profile, throwing a `BrowserError` off-shape.                                                                                             |
| `readBrowserProfileFrame`                | function | Decodes a CPU profile call frame, throwing a `BrowserError` off-shape.                                                                                    |
| `readBrowserQuad`                        | function | Decodes the first `DOM.getContentQuads` quad and its center, throwing a `BrowserError` off-shape.                                                         |
| `readBrowserRemoteValue`                 | function | Decodes a Runtime remote object's printable value, falling back to its unserializable form and then its description, or `undefined` when it carries none. |
| `readBrowserScriptCoverage`              | function | Decodes JavaScript precise coverage, throwing a `BrowserError` off-shape.                                                                                 |
| `readBrowserScriptIdentifier`            | function | Decodes the `Page.addScriptToEvaluateOnNewDocument` result, throwing a `BrowserError` off-shape.                                                          |
| `readBrowserStack`                       | function | Decodes a Chromium runtime stack trace, skipping every off-shape call frame.                                                                              |
| `readBrowserStorageEntries`              | function | Decodes a list of web-storage entries, throwing a `BrowserError` off-shape.                                                                               |
| `readBrowserStorageOrigin`               | function | Decodes one in-page web-storage snapshot, throwing a `BrowserError` off-shape.                                                                            |
| `readBrowserStreamChunk`                 | function | Decodes one `IO.read` response, throwing a `BrowserError` off-shape.                                                                                      |
| `readBrowserStyleCoverage`               | function | Decodes CSS rule usage, throwing a `BrowserError` off-shape.                                                                                              |
| `settleBrowserTeardown`                  | function | Awaits every teardown step in order and returns the first failure.                                                                                        |
| `textToBytes`                            | function | Encodes UTF-8 text as bytes.                                                                                                                              |
| `validateBrowserAccessibilityOptions`    | function | Validates Accessibility-domain snapshot bounds.                                                                                                           |
| `validateBrowserContextOptions`          | function | Validates isolated-context options before creating remote state.                                                                                          |
| `validateBrowserEmulationOptions`        | function | Validates context emulation boundaries before partial application.                                                                                        |
| `validateBrowserHAR`                     | function | Validates the HAR 1.2 fields required for deterministic replay.                                                                                           |
| `validateBrowserInputOptions`            | function | Validates the bounded delay, count, steps, and position of one trusted-input operation.                                                                   |
| `validateBrowserPoint`                   | function | Validates viewport input coordinates.                                                                                                                     |
| `validateBrowserRange`                   | function | Validates a finite numeric range.                                                                                                                         |
| `validateBrowserTimeout`                 | function | Validates a public browser timeout before protocol work begins.                                                                                           |
| `validateBrowserViewport`                | function | Validates Chromium viewport metrics.                                                                                                                      |

The pure helpers can be composed around captured CDP payloads without creating
a browser entity. This compact fixture sketch intentionally shows every
helper family; production callers normally use the managers, which invoke
these decoders and compilers internally.

```ts
import {
	browserHARHeadersToRecord,
	browserHeadersToProtocol,
	browserPDFToParams,
	browserScreenshotToParams,
	bytesToText,
	compileActionabilityFunction,
	compileAttachedLocatorWaitExpression,
	compileBrowserBindingCleanup,
	compileBrowserBindingResult,
	compileBrowserBindingSource,
	compileDetachedLocatorWaitExpression,
	compileFunctionWaitExpression,
	compileHiddenLocatorWaitExpression,
	compileLocatorExpression,
	compileLocatorListExpression,
	compileScreenshotCleanupExpression,
	compileScreenshotPreparationExpression,
	compileStorageClearExpression,
	compileStorageReadExpression,
	compileStorageRestoreExpression,
	compileVisibleLocatorWaitExpression,
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

const query = { selector: 'css', value: 'main' }
const bytes = textToBytes('hello')
bytesToText(bytes)
encodeBase64(bytes)
concatBytes([bytes])
browserHeadersToProtocol({ accept: 'application/json' })
browserHARHeadersToRecord([{ name: 'content-type', value: 'text/plain' }])
browserPDFToParams({ landscape: true })
browserScreenshotToParams({ format: 'png' })
compileActionabilityFunction({ visible: true, stable: true })
compileLocatorListExpression(query)
compileLocatorExpression(query)
compileAttachedLocatorWaitExpression(query, true, 1000)
compileDetachedLocatorWaitExpression(query, true, 1000)
compileVisibleLocatorWaitExpression(query, true, 1000)
compileHiddenLocatorWaitExpression(query, true, 1000)
compileFunctionWaitExpression('() => document.readyState === "complete"', 1000)
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

#### Extended types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`. An extended interface's name comes before `plus`, with the members it adds after.

| API                                 | Kind      | Shape                                                                                                                                                                                                                                          | Summary                                                                                        |
| ----------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `BrowserAXNode`                     | interface | `{ id, parent, children, backend, frame, ignored, role, name, description, value, properties }`                                                                                                                                                | Represents one decoded Chromium accessibility node.                                            |
| `BrowserAccessibilityInterface`     | interface | `{} plus snapshot`                                                                                                                                                                                                                             | Inspects the accessibility tree.                                                               |
| `BrowserAccessibilityOptions`       | interface | `{ root?, depth? }`                                                                                                                                                                                                                            | Describes the options for an accessibility snapshot.                                           |
| `BrowserAccessibilitySnapshot`      | interface | `{ roots, nodes }`                                                                                                                                                                                                                             | Describes a serializable accessibility-tree snapshot.                                          |
| `BrowserActionabilityOptions`       | interface | `{ visible?, stable?, events?, enabled?, editable?, position? }`                                                                                                                                                                               | Describes the actionability checks performed before locator input.                             |
| `BrowserBindingCall`                | interface | `{ id, name, args, context }`                                                                                                                                                                                                                  | Describes a decoded page-to-host binding call.                                                 |
| `BrowserBindingHandler`             | type      | `(...args: unknown[]) => unknown \| Promise<unknown>`                                                                                                                                                                                          | Runs a host function exposed into page JavaScript.                                             |
| `BrowserChord`                      | interface | `{ modifiers, key }`                                                                                                                                                                                                                           | Describes a parsed keyboard chord.                                                             |
| `BrowserClickOptions`               | interface | `BrowserInputOptions plus { button?, count? }`                                                                                                                                                                                                 | Describes the options for a trusted mouse click.                                               |
| `BrowserClockInterface`             | interface | `{ installed } plus install, pause, resume, advance, uninstall`                                                                                                                                                                                | Controls Chromium virtual time for deterministic page timers.                                  |
| `BrowserConsoleMessage`             | interface | `{ level, text, values, timestamp, stack }`                                                                                                                                                                                                    | Represents one console API call.                                                               |
| `BrowserContextEventMap`            | type      | `{ page, close }`                                                                                                                                                                                                                              | Maps the browser-context lifecycle events.                                                     |
| `BrowserContextOptions`             | interface | `{ on?, error?, proxy?, origins?, downloads?, emulation? }`                                                                                                                                                                                    | Describes the options for creating and configuring an isolated browser context.                |
| `BrowserCookie`                     | interface | `{ name, value, domain, path, expires, http, secure, site, partition }`                                                                                                                                                                        | Represents one cookie returned from a browser context.                                         |
| `BrowserCookieFilter`               | interface | `{ name?, domain?, path? }`                                                                                                                                                                                                                    | Describes optional narrowing criteria for clearing context cookies.                            |
| `BrowserCookieInput`                | interface | `{ name, value, url?, domain?, path?, expires?, http?, secure?, site?, priority?, partition? }`                                                                                                                                                | Describes the input used to create or replace a browser cookie.                                |
| `BrowserCookieManagerInterface`     | interface | `{} plus cookies, set, clear`                                                                                                                                                                                                                  | Provides cookie operations scoped to one browser context.                                      |
| `BrowserCookiePartition`            | interface | `{ site, ancestor? }`                                                                                                                                                                                                                          | Describes a cookie partition key used by CHIPS-partitioned cookies.                            |
| `BrowserCoverageInterface`          | interface | `{ active } plus start, stop, destroy`                                                                                                                                                                                                         | Drives the coverage capture lifecycle.                                                         |
| `BrowserCoverageOptions`            | interface | `{ javascript?, css?, detailed? }`                                                                                                                                                                                                             | Describes the options for a coverage capture.                                                  |
| `BrowserCoverageRange`              | interface | `{ start, end, count }`                                                                                                                                                                                                                        | Describes a source range reported by JavaScript or CSS coverage.                               |
| `BrowserCoverageResult`             | interface | `{ scripts, styles }`                                                                                                                                                                                                                          | Describes combined JavaScript and CSS usage.                                                   |
| `BrowserCredentials`                | interface | `{ username, password }`                                                                                                                                                                                                                       | Describes the HTTP basic-auth credentials applied to context pages.                            |
| `BrowserDiagnosticsInterface`       | interface | `{ tracing, coverage, performance, profiler } plus destroy`                                                                                                                                                                                    | Groups the diagnostics by capability.                                                          |
| `BrowserDialogCategory`             | type      | `'alert' \| 'confirm' \| 'prompt' \| 'beforeunload'`                                                                                                                                                                                           | Names a JavaScript dialog category reported by Chromium.                                       |
| `BrowserDialogInterface`            | interface | `{ category, message, default } plus accept, dismiss`                                                                                                                                                                                          | Represents one active JavaScript dialog.                                                       |
| `BrowserDownloadEventMap`           | type      | `{ progress, complete, cancel }`                                                                                                                                                                                                               | Maps the download progress events.                                                             |
| `BrowserDownloadInterface`          | interface | `{ emitter, id, url, name, status, received, total, path } plus cancel, update`                                                                                                                                                                | Represents one context download tracked through Chromium's Browser domain.                     |
| `BrowserDownloadOptions`            | interface | `{ path, named? }`                                                                                                                                                                                                                             | Describes the download policy for a browser context.                                           |
| `BrowserDownloadProgress`           | interface | `{ status, received, total, path? }`                                                                                                                                                                                                           | Describes a protocol-neutral download progress update.                                         |
| `BrowserDownloadStart`              | interface | `{ id, url, name, frame }`                                                                                                                                                                                                                     | Describes a decoded `Browser.downloadWillBegin` event.                                         |
| `BrowserDownloadStatus`             | type      | `'pending' \| 'complete' \| 'cancelled'`                                                                                                                                                                                                       | Names a download lifecycle phase.                                                              |
| `BrowserDragOptions`                | interface | `BrowserInputOptions plus { button?, steps? }`                                                                                                                                                                                                 | Describes the options for a trusted mouse drag.                                                |
| `BrowserEmulationManagerInterface`  | interface | `{} plus apply, clear, attach`                                                                                                                                                                                                                 | Configures context-scoped emulation.                                                           |
| `BrowserEmulationOptions`           | interface | `{ viewport?, user?, locale?, timezone?, geolocation?, media?, offline?, headers?, credentials? }`                                                                                                                                             | Describes network and rendering overrides inherited by context pages.                          |
| `BrowserFileChooserInterface`       | interface | `{ multiple } plus upload, cancel`                                                                                                                                                                                                             | Represents one intercepted file chooser.                                                       |
| `BrowserFunctionCoverage`           | interface | `{ name, ranges, block }`                                                                                                                                                                                                                      | Describes function coverage inside one script.                                                 |
| `BrowserGeolocation`                | interface | `{ latitude, longitude, accuracy? }`                                                                                                                                                                                                           | Describes a geographic location override.                                                      |
| `BrowserHAR`                        | interface | `{ log }`                                                                                                                                                                                                                                      | Describes the standards-shaped HAR 1.2 document produced by the network manager.               |
| `BrowserHARContent`                 | interface | `{ size, mimeType, text?, encoding? }`                                                                                                                                                                                                         | Describes response body metadata in an HTTP archive.                                           |
| `BrowserHARCookie`                  | interface | `BrowserHARValue plus { path?, domain?, expires?, httpOnly?, secure? }`                                                                                                                                                                        | Represents one cookie in an HTTP archive.                                                      |
| `BrowserHARCreator`                 | interface | `{ name, version }`                                                                                                                                                                                                                            | Describes the tool identity embedded in an HTTP archive.                                       |
| `BrowserHAREntry`                   | interface | `{ startedDateTime, time, request, response, cache, timings }`                                                                                                                                                                                 | Represents one completed HTTP exchange in a HAR recording.                                     |
| `BrowserHARLog`                     | interface | `{ version, creator, entries }`                                                                                                                                                                                                                | Describes the HAR 1.2 log object.                                                              |
| `BrowserHARManagerInterface`        | interface | `{ recording } plus start, stop, replay, clear`                                                                                                                                                                                                | Provides HAR recording and replay operations.                                                  |
| `BrowserHAROptions`                 | interface | `{ path?, content? }`                                                                                                                                                                                                                          | Describes the options for a HAR recording.                                                     |
| `BrowserHARPending`                 | interface | `{ request, started, response }`                                                                                                                                                                                                               | Holds recording state until a request finishes; a new value replaces it on each update.        |
| `BrowserHARPost`                    | interface | `{ mimeType, text }`                                                                                                                                                                                                                           | Describes request body metadata in an HTTP archive.                                            |
| `BrowserHARReplayOptions`           | interface | `{ fallback? }`                                                                                                                                                                                                                                | Describes HAR replay behavior.                                                                 |
| `BrowserHARRequest`                 | interface | `{ method, url, httpVersion, cookies, headers, queryString, postData?, headersSize, bodySize }`                                                                                                                                                | Describes a HAR 1.2 request entry.                                                             |
| `BrowserHARResponse`                | interface | `{ status, statusText, httpVersion, cookies, headers, content, redirectURL, headersSize, bodySize }`                                                                                                                                           | Describes a HAR 1.2 response entry.                                                            |
| `BrowserHARTimings`                 | interface | `{ blocked, dns, connect, send, wait, receive, ssl }`                                                                                                                                                                                          | Holds HAR 1.2 phase timings in milliseconds.                                                   |
| `BrowserHARValue`                   | interface | `{ name, value }`                                                                                                                                                                                                                              | Represents one name/value pair in an HTTP archive.                                             |
| `BrowserHandleInterface`            | interface | `{ id } plus value, call, property, properties, dispose`                                                                                                                                                                                       | Represents a remote JavaScript object retained in one frame execution context.                 |
| `BrowserInputOptions`               | interface | `{ delay? }`                                                                                                                                                                                                                                   | Describes the options shared by every trusted input operation.                                 |
| `BrowserKey`                        | interface | `{ key, code, text, number }`                                                                                                                                                                                                                  | Describes normalized CDP keyboard key data.                                                    |
| `BrowserKeyboardInterface`          | interface | `{} plus down, up, press, type, insert`                                                                                                                                                                                                        | Provides keyboard input operations bound to one frame target session.                          |
| `BrowserLocatorClickOptions`        | interface | `BrowserPointerOptions plus BrowserClickOptions`                                                                                                                                                                                               | Describes the options for a locator click, combining element resolution with mouse input.      |
| `BrowserLocatorDragOptions`         | interface | `BrowserPointerOptions plus BrowserDragOptions`                                                                                                                                                                                                | Describes the options for a locator drag, combining element resolution with mouse input.       |
| `BrowserLocatorFilter`              | interface | `{ text?, exact?, visible? }`                                                                                                                                                                                                                  | Describes a declarative locator filter applied after selector resolution.                      |
| `BrowserLocatorInterface`           | interface | `{ frame, query } plus locator, filter, first, last, item, count, all, click, fill, select, check, uncheck, hover, focus, press, type, clear, wait, text, texts, html, value, attribute, visible, enabled, editable, screenshot, upload, drag` | Represents a reusable strict locator over one frame.                                           |
| `BrowserLocatorTypeOptions`         | interface | `BrowserActionOptions plus BrowserInputOptions`                                                                                                                                                                                                | Describes the options for locator keyboard entry, combining element resolution with key input. |
| `BrowserMargin`                     | interface | `{ top?, right?, bottom?, left? }`                                                                                                                                                                                                             | Describes the paper margin lengths accepted by Chromium print-to-PDF.                          |
| `BrowserMedia`                      | interface | `{ output?, scheme?, contrast?, motion?, colors? }`                                                                                                                                                                                            | Describes browser color and media feature overrides.                                           |
| `BrowserMetric`                     | interface | `{ name, value }`                                                                                                                                                                                                                              | Represents one Performance-domain metric.                                                      |
| `BrowserMouseButton`                | type      | `'left' \| 'middle' \| 'right' \| 'back' \| 'forward'`                                                                                                                                                                                         | Names a mouse button understood by Chromium's Input domain.                                    |
| `BrowserMouseInterface`             | interface | `{} plus move, down, up, click, drag, wheel`                                                                                                                                                                                                   | Provides mouse input operations bound to one frame target session.                             |
| `BrowserNavigationManagerInterface` | interface | `{} plus wait, until`                                                                                                                                                                                                                          | Provides URL and in-page predicate waits associated with one page.                             |
| `BrowserNavigationResult`           | interface | `{ url, response, same }`                                                                                                                                                                                                                      | Describes the outcome of a top-level navigation command.                                       |
| `BrowserNavigationWait`             | interface | `{ pattern, timer, resolve, reject }`                                                                                                                                                                                                          | Represents one pending URL-pattern wait.                                                       |
| `BrowserNavigationWaitOptions`      | interface | `{ timeout? }`                                                                                                                                                                                                                                 | Describes the options for URL and predicate waits.                                             |
| `BrowserNavigationWatch`            | interface | `{ responses }`                                                                                                                                                                                                                                | Holds the state retained while correlating navigation with Network events.                     |
| `BrowserNetworkEventMap`            | type      | `{ request, response, failure, finish, socket }`                                                                                                                                                                                               | Maps the network events a page's network manager emits.                                        |
| `BrowserNetworkManagerInterface`    | interface | `{ emitter, har } plus start, body, text, json, route, unroute, headers, offline, credentials, destroy`                                                                                                                                        | Provides page-scoped network observation and interception.                                     |
| `BrowserOperationOptions`           | type      | `BrowserPointerOptions & BrowserClickOptions & BrowserDragOptions`                                                                                                                                                                             | Collects every option a trusted-input operation can carry.                                     |
| `BrowserPDFOptions`                 | interface | `{ path?, landscape?, background?, scale?, width?, height?, margin?, ranges?, header?, footer?, tagged?, outline? }`                                                                                                                           | Describes the options for printing a Chromium page to PDF.                                     |
| `BrowserPDFResult`                  | interface | `{ bytes, path }`                                                                                                                                                                                                                              | Describes the result of printing a page to PDF.                                                |
| `BrowserPageError`                  | interface | `{ message, stack, timestamp }`                                                                                                                                                                                                                | Represents one uncaught page exception.                                                        |
| `BrowserPageEventMap`               | type      | `{ navigate, attach, detach, popup, dialog, chooser, download, console, error, crash, worker, request, response, failure, socket, close }`                                                                                                     | Maps the typed page, frame, target, and user-visible browser events.                           |
| `BrowserPagesFunction`              | type      | `() => readonly BrowserPageInterface[]`                                                                                                                                                                                                        | Returns the context's live pages at call time.                                                 |
| `BrowserPerformanceInterface`       | interface | `{} plus metrics`                                                                                                                                                                                                                              | Reads Performance-domain metrics.                                                              |
| `BrowserPermissionManagerInterface` | interface | `{} plus grant, deny, clear`                                                                                                                                                                                                                   | Provides permission override operations scoped to one browser context.                         |
| `BrowserPoint`                      | interface | `{ x, y }`                                                                                                                                                                                                                                     | Describes a point in viewport CSS pixels.                                                      |
| `BrowserPointerOptions`             | interface | `BrowserActionOptions plus { position? }`                                                                                                                                                                                                      | Describes the options for a locator operation that aims at a point inside the element.         |
| `BrowserProfile`                    | interface | `{ start, end, nodes, samples, deltas }`                                                                                                                                                                                                       | Describes a sampled CPU profile.                                                               |
| `BrowserProfileFrame`               | interface | `{ function, script, url, line, column }`                                                                                                                                                                                                      | Describes a JavaScript call frame from a CPU profile.                                          |
| `BrowserProfileNode`                | interface | `{ id, frame, hit, children }`                                                                                                                                                                                                                 | Represents one node in a sampled CPU profile.                                                  |
| `BrowserProfilerInterface`          | interface | `{ active } plus start, stop, destroy`                                                                                                                                                                                                         | Drives the sampled CPU profile lifecycle.                                                      |
| `BrowserProxy`                      | interface | `{ server, bypass? }`                                                                                                                                                                                                                          | Describes proxy settings used when creating an isolated browser context.                       |
| `BrowserQuad`                       | interface | `{ points, center }`                                                                                                                                                                                                                           | Describes a decoded content quad and its actionable center.                                    |
| `BrowserQuery`                      | interface | `{ selector, value, name?, exact?, parent?, filter?, index? }`                                                                                                                                                                                 | Describes a serializable selector query, including optional ancestry and filtering.            |
| `BrowserRequest`                    | interface | `{ id, loader, frame, url, method, headers, post, resource, timestamp, walltime, redirect }`                                                                                                                                                   | Represents one observed browser request.                                                       |
| `BrowserRequestFailure`             | interface | `{ id, error, cancelled, blocked }`                                                                                                                                                                                                            | Represents one failed browser request.                                                         |
| `BrowserResponse`                   | interface | `{ id, loader, frame, url, status, phrase, headers, mime, protocol, address, port, cached, worker, timestamp, timing, security }`                                                                                                              | Represents one observed browser response.                                                      |
| `BrowserRoleOptions`                | interface | `{ name?, exact? }`                                                                                                                                                                                                                            | Describes the options for role-based locator creation.                                         |
| `BrowserRouteContinueOptions`       | interface | `{ url?, method?, headers?, post? }`                                                                                                                                                                                                           | Describes the overrides supplied when continuing an intercepted request.                       |
| `BrowserRouteDefinition`            | interface | `{ query, handler }`                                                                                                                                                                                                                           | Represents one installed network route.                                                        |
| `BrowserRouteFulfillOptions`        | interface | `{ status?, phrase?, headers?, body? }`                                                                                                                                                                                                        | Describes the synthetic response supplied when fulfilling an intercepted request.              |
| `BrowserRouteHandler`               | type      | `(route: BrowserRouteInterface) => void \| Promise<void>`                                                                                                                                                                                      | Runs for a matching intercepted request.                                                       |
| `BrowserRouteInterface`             | interface | `{ id, request, handled } plus abort, continue, fulfill`                                                                                                                                                                                       | Represents one paused Fetch-domain request.                                                    |
| `BrowserRouteQuery`                 | interface | `{ url?, method?, resource? }`                                                                                                                                                                                                                 | Describes route matching criteria. Omitted fields match all values.                            |
| `BrowserSameSite`                   | type      | `'Strict' \| 'Lax' \| 'None'`                                                                                                                                                                                                                  | Names a cookie same-site policy understood by Chromium.                                        |
| `BrowserScreenshotScale`            | type      | `'css' \| 'device'`                                                                                                                                                                                                                            | Names a screenshot coordinate scale.                                                           |
| `BrowserScriptCoverage`             | interface | `{ id, url, functions }`                                                                                                                                                                                                                       | Describes JavaScript script coverage.                                                          |
| `BrowserScriptEntry`                | interface | `{ source, binding }`                                                                                                                                                                                                                          | Represents one installed new-document script and its optional host binding owner.              |
| `BrowserScriptManagerInterface`     | interface | `{} plus add, remove, expose, revoke, destroy`                                                                                                                                                                                                 | Manages initialization scripts and host bindings for one page.                                 |
| `BrowserSecurity`                   | interface | `{ protocol, issuer, from, to }`                                                                                                                                                                                                               | Describes the TLS details supplied with a browser response.                                    |
| `BrowserSelector`                   | type      | `'css' \| 'role' \| 'text' \| 'label' \| 'placeholder' \| 'testId'`                                                                                                                                                                            | Names a selector axis supported by `BrowserSelectorManagerInterface`.                          |
| `BrowserSelectorManagerInterface`   | interface | `{} plus css, role, text, label, placeholder, testId`                                                                                                                                                                                          | Groups the locator factories by selector semantics.                                            |
| `BrowserStackFrame`                 | interface | `{ url, function, line, column }`                                                                                                                                                                                                              | Represents one browser-side stack frame.                                                       |
| `BrowserStorageEntry`               | interface | `{ name, value }`                                                                                                                                                                                                                              | Represents one key/value pair from web storage.                                                |
| `BrowserStorageManagerInterface`    | interface | `{} plus state, restore, clear`                                                                                                                                                                                                                | Provides storage-state import, export, and clearing operations.                                |
| `BrowserStorageOptions`             | interface | `{ origins? }`                                                                                                                                                                                                                                 | Describes the options for collecting storage state from selected origins.                      |
| `BrowserStorageOrigin`              | interface | `{ origin, local, session }`                                                                                                                                                                                                                   | Describes an origin-scoped local and session storage snapshot.                                 |
| `BrowserStorageState`               | interface | `{ cookies, origins }`                                                                                                                                                                                                                         | Describes a portable browser authentication and storage snapshot.                              |
| `BrowserStreamChunk`                | interface | `{ bytes, eof }`                                                                                                                                                                                                                               | Represents one decoded IO stream read.                                                         |
| `BrowserStyleCoverage`              | interface | `{ id, ranges }`                                                                                                                                                                                                                               | Describes CSS stylesheet coverage.                                                             |
| `BrowserTeardownFunction`           | type      | `() => Promise<unknown>`                                                                                                                                                                                                                       | Runs one teardown step to settlement while the first failure is retained.                      |
| `BrowserTextOptions`                | interface | `{ exact? }`                                                                                                                                                                                                                                   | Describes the options for text-like locator creation.                                          |
| `BrowserTiming`                     | interface | `{ request, proxy, dns, connect, ssl, send, receive }`                                                                                                                                                                                         | Holds network timing values in milliseconds relative to request time.                          |
| `BrowserTimingRange`                | interface | `{ start, end }`                                                                                                                                                                                                                               | Describes the start/end pair for one network timing phase.                                     |
| `BrowserTouchInterface`             | interface | `{} plus tap`                                                                                                                                                                                                                                  | Provides touch input operations bound to one frame target session.                             |
| `BrowserTracingInterface`           | interface | `{ active } plus start, stop, destroy`                                                                                                                                                                                                         | Drives the trace capture lifecycle.                                                            |
| `BrowserTracingOptions`             | interface | `{ path?, categories?, screenshots?, sampling? }`                                                                                                                                                                                              | Describes the options for a Chromium trace capture.                                            |
| `BrowserTracingResult`              | interface | `{ bytes, path }`                                                                                                                                                                                                                              | Describes the result of a trace capture.                                                       |
| `BrowserTransitionFunction`         | type      | `() => Promise<T>`                                                                                                                                                                                                                             | Runs the work one `BrowserTransitionInterface` transition performs.                            |
| `BrowserTransitionInterface`        | interface | `{ pending } plus execute`                                                                                                                                                                                                                     | Represents one asynchronous transition shared by every caller that arrives while it runs.      |
| `BrowserUploadOptions`              | interface | `BrowserActionOptions plus { files }`                                                                                                                                                                                                          | Describes the options for setting files on a file input.                                       |
| `BrowserUserAgent`                  | interface | `{ value, language?, platform? }`                                                                                                                                                                                                              | Describes user-agent metadata accepted by Chromium emulation.                                  |
| `BrowserWebSocketEventMap`          | type      | `{ receive, transmit, error, close }`                                                                                                                                                                                                          | Maps the WebSocket lifecycle events.                                                           |
| `BrowserWebSocketFrame`             | interface | `{ opcode, data, masked, timestamp }`                                                                                                                                                                                                          | Describes a WebSocket frame payload.                                                           |
| `BrowserWebSocketInterface`         | interface | `{ emitter, id, url } plus receive, transmit, fail, close`                                                                                                                                                                                     | Represents one observed WebSocket connection.                                                  |
| `BrowserWorkerCategory`             | type      | `'worker' \| 'service_worker' \| 'shared_worker'`                                                                                                                                                                                              | Names a worker target category.                                                                |
| `BrowserWorkerInterface`            | interface | `{ id, url, category } plus evaluate, send, detach, close`                                                                                                                                                                                     | Represents a script worker attached to a page target.                                          |

## Methods

The public methods of the layer's behavioral interfaces — every call-signature
member listed (their `readonly` data members stay Surface rows). The Core and
Server tables come first, then one table per behavioral interface the Extended
Chromium automation surface introduces, in source declaration order. Each
implementing class exposes exactly its interface's methods: `CDPClient` ↔
`CDPClientInterface`, `BrowserContext` ↔ `BrowserContextInterface`,
`BrowserFrame` ↔ `BrowserFrameInterface`, `BrowserPage` ↔
`BrowserPageInterface`, `BrowserSnapshot` ↔ `BrowserSnapshotInterface`,
`BrowserCodegen` ↔ `BrowserCodegenInterface`, `BrowserTransition` ↔
`BrowserTransitionInterface`, `Browser` ↔
`BrowserInterface`, `BrowserWebSocket` ↔ `BrowserWebSocketInterface`,
`BrowserDownload` ↔ `BrowserDownloadInterface`, `WebSocketCDPTransport` ↔
`CDPTransportInterface`, `FileBrowserWriter` ↔ `BrowserWriterInterface`,
`BrowserNavigationManager` ↔ `BrowserNavigationManagerInterface`,
`BrowserHandle` ↔ `BrowserHandleInterface`, `BrowserScriptManager` ↔
`BrowserScriptManagerInterface`, `BrowserAccessibility` ↔
`BrowserAccessibilityInterface`, `BrowserTracing` ↔ `BrowserTracingInterface`,
`BrowserCoverage` ↔ `BrowserCoverageInterface`, `BrowserPerformance` ↔
`BrowserPerformanceInterface`, `BrowserProfiler` ↔ `BrowserProfilerInterface`,
`BrowserDiagnostics` ↔ `BrowserDiagnosticsInterface`, `BrowserClock` ↔
`BrowserClockInterface`, `BrowserLocator` ↔ `BrowserLocatorInterface`,
`BrowserSelectorManager` ↔ `BrowserSelectorManagerInterface`,
`BrowserKeyboard` ↔ `BrowserKeyboardInterface`, `BrowserMouse` ↔
`BrowserMouseInterface`, `BrowserTouch` ↔ `BrowserTouchInterface`,
`BrowserDialog` ↔ `BrowserDialogInterface`, `BrowserFileChooser` ↔
`BrowserFileChooserInterface`, `BrowserWorker` ↔ `BrowserWorkerInterface`,
`BrowserRoute` ↔ `BrowserRouteInterface`, `BrowserHARManager` ↔
`BrowserHARManagerInterface`, `BrowserNetworkManager` ↔
`BrowserNetworkManagerInterface`, `BrowserCookieManager` ↔
`BrowserCookieManagerInterface`, `BrowserPermissionManager` ↔
`BrowserPermissionManagerInterface`, `BrowserStorageManager` ↔
`BrowserStorageManagerInterface`, `BrowserEmulationManager` ↔
`BrowserEmulationManagerInterface`.

#### `CDPTransportInterface`

The text pipe a `CDPClient` sends and receives JSON-RPC frames over.

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
dispatching; `send` issues a CDP method call, taking its session and per-call
timeout in a trailing `CDPSendOptions`; `emitter` reports the client's own
`connect` / `close` / `drop` / `error` transitions;
`subscribe` / `unsubscribe` register or remove a handler for a CDP event
(optionally session-scoped). Subscriptions are client-level registrations,
not connection-level state — they survive `close()` and a subsequent
`reconnect()` / `connect()`, and resume firing once reconnected. Calling
`close()` while a `connect()` is still in flight rejects that in-flight
connect attempt.

| Method        | Returns            | Summary                                                                                                                                                                                              |
| ------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`     | `Promise<void>`    | Starts the transport and begins dispatching. Idempotent.                                                                                                                                             |
| `reconnect`   | `Promise<void>`    | Closes the transport and re-establishes it.                                                                                                                                                          |
| `send`        | `Promise<unknown>` | Issues a CDP method call with optional params and a trailing `CDPSendOptions` carrying the `session` to scope it to and a per-call `timeout` overriding the client-wide default; rejects on timeout. |
| `subscribe`   | `void`             | Registers a handler for a CDP event, optionally session-scoped.                                                                                                                                      |
| `unsubscribe` | `void`             | Removes a handler for a CDP event, optionally session-scoped.                                                                                                                                        |
| `close`       | `Promise<void>`    | Tears down the transport and rejects every pending request.                                                                                                                                          |

```ts
import { createCDPClient } from '@orkestrel/browser'

const client = createCDPClient({ transport })
await client.connect()
const targets = await client.send('Target.getTargets')
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

Operations shared by a top-level page and an iframe document. Child-frame
evaluation uses a named isolated world and automatically follows an attached
out-of-process iframe session when Chromium splits the frame into another
target.

| Method        | Returns                           | Summary                                                                                                                                                                                                         |
| ------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`       | `Promise<string>`                 | Resolves the frame document title.                                                                                                                                                                              |
| `content`     | `Promise<BrowserContentResult>`   | Extracts the URL, title, HTML, and visible text under the result-size guards.                                                                                                                                   |
| `article`     | `Promise<string>`                 | Distills the frame HTML to reader-facing plain text, with boilerplate and hidden regions pruned.                                                                                                                |
| `click`       | `Promise<void>`                   | Clicks a CSS-selector match, strict by default and requiring it visible and enabled.                                                                                                                            |
| `fill`        | `Promise<void>`                   | Fills an editable input or contenteditable element, strict by default, dispatching input and change events.                                                                                                     |
| `select`      | `Promise<void>`                   | Selects options on an enabled `select` element, strict by default.                                                                                                                                              |
| `evaluate`    | `Promise<unknown>`                | Evaluates an expression in the frame execution world under the result-size guard.                                                                                                                               |
| `handle`      | `Promise<BrowserHandleInterface>` | Evaluates an expression by reference and returns a disposable remote object handle.                                                                                                                             |
| `wait`        | `Promise<void>`                   | Waits for a selector to reach the attached, detached, visible, or hidden state.                                                                                                                                 |
| `send`        | `Promise<unknown>`                | Issues a raw CDP method in the frame's current target session, with a trailing `BrowserSendOptions` carrying a per-call `timeout` overriding the client-wide default.                                           |
| `subscribe`   | `Promise<void>`                   | Subscribes to a CDP event in the frame's current target session.                                                                                                                                                |
| `unsubscribe` | `Promise<void>`                   | Removes a frame-session CDP event subscription.                                                                                                                                                                 |
| `save`        | `Promise<void>`                   | Persists bytes through a page writer; a child frame rejects because it owns no writer.                                                                                                                          |
| `assert`      | `void`                            | Throws a coded `BrowserError` when the frame can no longer accept protocol work: a frame throws once the CDP client disconnects, and a page also throws once it closes. Every other member here calls it first. |
| `update`      | `void`                            | Records an externally observed URL as the frame's current `url`, which a page calls from its own `Page.frameNavigated` handler.                                                                                 |

```ts
const child = await page.frame('checkout')
const title = await child?.title()
await child?.wait('form', { state: 'visible' })
await child?.fill('[name=email]', 'ada@example.com')
await child?.click('button[type=submit]')
await child?.select('select', ['business'])
const content = await child?.content()
const article = await child?.article() // its own HTML capture, distilled to plain text
const result = await child?.evaluate('document.readyState')
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

#### `BrowserPageInterface`

A top-level page. Its page/target-specific operations come first, then every
member it inherits from `BrowserFrameInterface`, whose own behavior the
preceding table states.

| Method        | Returns                                       | Summary                                                                                                                                                                                                         |
| ------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate`    | `Promise<BrowserNavigationResult>`            | Goes to a URL, waits for the requested load condition, and returns the final URL with its response correlation.                                                                                                 |
| `reload`      | `Promise<BrowserNavigationResult>`            | Reloads the page and returns the final URL with its response correlation.                                                                                                                                       |
| `back`        | `Promise<BrowserNavigationResult>`            | Navigates to the previous history entry, or returns the unchanged URL when none exists.                                                                                                                         |
| `forward`     | `Promise<BrowserNavigationResult>`            | Navigates to the next history entry, or returns the unchanged URL when none exists.                                                                                                                             |
| `screenshot`  | `Promise<BrowserScreenshotResult>`            | Captures PNG or JPEG bytes, optionally full-page and persisted through an injected writer.                                                                                                                      |
| `pdf`         | `Promise<BrowserPDFResult>`                   | Prints the page to PDF bytes, optionally persisted through the injected writer.                                                                                                                                 |
| `frame`       | `Promise<BrowserFrameInterface \| undefined>` | Looks up a first-class frame by name or URL.                                                                                                                                                                    |
| `frames`      | `Promise<readonly BrowserFrameInterface[]>`   | Decodes the flattened frame tree, main frame first.                                                                                                                                                             |
| `snapshot`    | `Promise<BrowserSnapshotInterface>`           | Captures and decodes every attached document, shadow root, template content, layout box, and requested computed style.                                                                                          |
| `codegen`     | `Promise<BrowserCodegenInterface>`            | Starts the action recorder, or returns the running one.                                                                                                                                                         |
| `destroy`     | `Promise<void>`                               | Releases local resources and detaches without closing the remote target.                                                                                                                                        |
| `close`       | `Promise<void>`                               | Closes the remote target and releases its resources.                                                                                                                                                            |
| `title`       | `Promise<string>`                             | Resolves the frame document title.                                                                                                                                                                              |
| `content`     | `Promise<BrowserContentResult>`               | Extracts the URL, title, HTML, and visible text under the result-size guards.                                                                                                                                   |
| `article`     | `Promise<string>`                             | Distills the frame HTML to reader-facing plain text, with boilerplate and hidden regions pruned.                                                                                                                |
| `click`       | `Promise<void>`                               | Clicks a CSS-selector match, strict by default and requiring it visible and enabled.                                                                                                                            |
| `fill`        | `Promise<void>`                               | Fills an editable input or contenteditable element, strict by default, dispatching input and change events.                                                                                                     |
| `select`      | `Promise<void>`                               | Selects options on an enabled `select` element, strict by default.                                                                                                                                              |
| `evaluate`    | `Promise<unknown>`                            | Evaluates an expression in the frame execution world under the result-size guard.                                                                                                                               |
| `handle`      | `Promise<BrowserHandleInterface>`             | Evaluates an expression by reference and returns a disposable remote object handle.                                                                                                                             |
| `wait`        | `Promise<void>`                               | Waits for a selector to reach the attached, detached, visible, or hidden state.                                                                                                                                 |
| `send`        | `Promise<unknown>`                            | Issues a raw CDP method in the frame's current target session, with a trailing `BrowserSendOptions` carrying a per-call `timeout` overriding the client-wide default.                                           |
| `subscribe`   | `Promise<void>`                               | Subscribes to a CDP event in the frame's current target session.                                                                                                                                                |
| `unsubscribe` | `Promise<void>`                               | Removes a frame-session CDP event subscription.                                                                                                                                                                 |
| `save`        | `Promise<void>`                               | Persists bytes through a page writer; a child frame rejects because it owns no writer.                                                                                                                          |
| `assert`      | `void`                                        | Throws a coded `BrowserError` when the frame can no longer accept protocol work: a frame throws once the CDP client disconnects, and a page also throws once it closes. Every other member here calls it first. |
| `update`      | `void`                                        | Records an externally observed URL as the frame's current `url`, which a page calls from its own `Page.frameNavigated` handler.                                                                                 |

```ts
await page.navigate('https://example.com')
await page.reload()
await page.back()
await page.forward()
const heading = await page.title()
await page.click('#submit')
await page.fill('#name', 'Ada')
await page.select('#lang', ['en'])
const content = await page.content()
const result = await page.evaluate('document.title')
const shot = await page.screenshot({ full: true, format: 'png' })
const pdf = await page.pdf({ landscape: true })
const child = await page.frame('checkout') // BrowserFrameInterface | undefined
const children = await page.frames() // readonly BrowserFrameInterface[]
const snapshot = await page.snapshot({ styles: ['display'], rects: true })
await page.close()
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

Records page interactions as a session runs, for later compilation into a
replayable script.

| Method    | Returns                                    | Summary                                                                                                                                                                         |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`   | `Promise<void>`                            | Begins recording on the page's session. A call after teardown is a silent no-op, because a torn-down recorder cannot be restarted and a fresh one is obtained through the page. |
| `stop`    | `Promise<readonly BrowserCodegenAction[]>` | Stops recording and returns the captured actions.                                                                                                                               |
| `actions` | `readonly BrowserCodegenAction[]`          | Returns the current normalized action list.                                                                                                                                     |
| `script`  | `string`                                   | Compiles the captured actions into a script.                                                                                                                                    |
| `clear`   | `void`                                     | Resets the captured action list.                                                                                                                                                |
| `destroy` | `Promise<void>`                            | Tears down the recorder and detaches its CDP listeners.                                                                                                                         |

```ts
const codegen = await page.codegen()
await page.click('#next')
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

Browser wrapper with discovery, connection management, and lifecycle control.
Connection strategy (executed by `connect()`): explicit `cdp.endpoint` →
passive discovery on `cdp.port` → launch a new process.

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
drives `update` from `Browser.downloadProgress`; a consumer calls `cancel` and
reads the observed state.

| Method   | Returns         | Summary                                                                                                  |
| -------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| `cancel` | `Promise<void>` | Sends CDP `Browser.cancelDownload` for this download, and is ignored unless the status is still pending. |
| `update` | `void`          | Records one step of the download's progress. The owning page drives it.                                  |

```ts
page.emitter.on('download', (download) => {
	log(download.id, download.url, download.name)
	download.emitter.on('progress', (received, total) => log(received, total))
	download.emitter.on('complete', (path) => log(path))
	download.emitter.on('cancel', () => log('cancelled'))
})
// The owning page drives progress from Browser.downloadProgress:
download.update({ status: 'pending', received: 512, total: 2_048 })
download.update({ status: 'complete', received: 2_048, total: 2_048, path: './report.pdf' })
await download.cancel() // ignored once the download settled
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

Waits for a navigation the page performs on its own, rather than one the caller
started.

| Method  | Returns            | Summary                                                                                                  |
| ------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `wait`  | `Promise<string>`  | Resolves with the URL of the next navigation matching the `*` and `**` glob pattern. Rejects on timeout. |
| `until` | `Promise<unknown>` | Polls an expression in the page until it returns a truthy value, and resolves with that value.           |

```ts
const navigated = page.navigation.wait('**/checkout')
await page.click('#buy')
log(await navigated)
await page.navigation.until('document.readyState === "complete"')
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

#### `BrowserLocatorInterface`

A lazily resolved element query. Every accessor returns a new locator rather than
mutating this one, and every action re-resolves the query before acting.

| Method       | Returns                                       | Summary                                                                                     |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `locator`    | `BrowserLocatorInterface`                     | Narrows to a descendant matching the CSS selector.                                          |
| `filter`     | `BrowserLocatorInterface`                     | Narrows to the matches satisfying the filter.                                               |
| `first`      | `BrowserLocatorInterface`                     | Narrows to the first match.                                                                 |
| `last`       | `BrowserLocatorInterface`                     | Narrows to the last match.                                                                  |
| `item`       | `BrowserLocatorInterface`                     | Narrows to the match at the given index.                                                    |
| `count`      | `Promise<number>`                             | Counts the current matches.                                                                 |
| `all`        | `Promise<readonly BrowserLocatorInterface[]>` | Resolves one indexed locator per current match.                                             |
| `click`      | `Promise<void>`                               | Clicks the match with trusted input after its actionability checks pass.                    |
| `fill`       | `Promise<void>`                               | Replaces the match's value with the given text.                                             |
| `select`     | `Promise<void>`                               | Selects the given option values on the match.                                               |
| `check`      | `Promise<void>`                               | Clicks the match unless it already reports checked.                                         |
| `uncheck`    | `Promise<void>`                               | Clicks the match unless it already reports unchecked.                                       |
| `hover`      | `Promise<void>`                               | Moves trusted pointer input over the match.                                                 |
| `focus`      | `Promise<void>`                               | Gives the match keyboard focus.                                                             |
| `press`      | `Promise<void>`                               | Focuses the match and presses one key or chord.                                             |
| `type`       | `Promise<void>`                               | Focuses the match and types the value one key at a time.                                    |
| `clear`      | `Promise<void>`                               | Empties the match's value.                                                                  |
| `wait`       | `Promise<void>`                               | Waits until the match reaches the requested state. Rejects on timeout.                      |
| `text`       | `Promise<string>`                             | Reads the first match's rendered text.                                                      |
| `texts`      | `Promise<readonly string[]>`                  | Reads the rendered text of every match.                                                     |
| `html`       | `Promise<string>`                             | Reads the first match's inner HTML.                                                         |
| `value`      | `Promise<string>`                             | Reads the first match's form value.                                                         |
| `attribute`  | `Promise<string \| undefined>`                | Reads one attribute of the first match, or returns `undefined` when the match carries none. |
| `visible`    | `Promise<boolean>`                            | Reports whether the first match renders a non-empty box.                                    |
| `enabled`    | `Promise<boolean>`                            | Reports whether the first match accepts input.                                              |
| `editable`   | `Promise<boolean>`                            | Reports whether the first match accepts typed text.                                         |
| `screenshot` | `Promise<BrowserScreenshotResult>`            | Captures the first match's box, persisting it through the page writer when a path is given. |
| `upload`     | `Promise<void>`                               | Sets the file selection on the matched file input.                                          |
| `drag`       | `Promise<void>`                               | Drags the match onto the target locator with trusted pointer input.                         |

```ts
const rows = page.selectors.role('row')
log(await rows.count())
const first = rows.first()
const last = rows.last()
const second = rows.item(1)
const named = rows.filter({ text: 'Ada' }).locator('td')
for (const row of await rows.all()) log(await row.text())
log(await named.texts(), await named.html(), await named.value())
log(await named.attribute('data-id'))
log(await named.visible(), await named.enabled(), await named.editable())
await named.wait({ state: 'visible' })
await named.click()
await named.hover()
await named.focus()
await named.fill('Ada')
await named.clear()
await named.type('Grace')
await named.press('Enter')
await named.select(['us'])
await named.check()
await named.uncheck()
await named.upload({ files: ['./avatar.png'] })
await named.screenshot({ path: './row.png' })
await first.drag(last)
```

#### `BrowserSelectorManagerInterface`

Creates one locator per selector semantics. Every accessor is pure — it builds a
query and performs no protocol call.

| Method        | Returns                   | Summary                                                            |
| ------------- | ------------------------- | ------------------------------------------------------------------ |
| `css`         | `BrowserLocatorInterface` | Locates by CSS selector.                                           |
| `role`        | `BrowserLocatorInterface` | Locates by ARIA role, optionally by accessible name and exactness. |
| `text`        | `BrowserLocatorInterface` | Locates by rendered text, optionally exact.                        |
| `label`       | `BrowserLocatorInterface` | Locates a labelled control by its label text, optionally exact.    |
| `placeholder` | `BrowserLocatorInterface` | Locates an input by its placeholder text, optionally exact.        |
| `testId`      | `BrowserLocatorInterface` | Locates by the test-id attribute.                                  |

```ts
await page.selectors.css('#hero').click()
await page.selectors.role('button', { name: 'Save', exact: true }).click()
await page.selectors.text('Continue').click()
await page.selectors.label('Email', { exact: true }).fill('ada@example.com')
await page.selectors.placeholder('Search').fill('browser')
await page.selectors.testId('checkout').click()
```

#### `BrowserKeyboardInterface`

Sends trusted keyboard input on the frame's own session. Held modifiers persist
between calls until released.

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

Sends trusted mouse input on the frame's own session, tracking the pointer
position and the pressed-button mask between calls.

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

Sends trusted touch input on the frame's own session.

| Method | Returns         | Summary                                                                                 |
| ------ | --------------- | --------------------------------------------------------------------------------------- |
| `tap`  | `Promise<void>` | Dispatches a touch start at the point and a touch end, cancelling the touch on failure. |

```ts
await page.touch.tap({ x: 120, y: 240 })
```

#### `BrowserDialogInterface`

One JavaScript dialog awaiting a decision. `category`, `message`, and `default`
are Surface data members.

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

| Method   | Returns         | Summary                                                                                                             |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `upload` | `Promise<void>` | Sets the chosen files. Throws when a single-file chooser is given several, and once the chooser is already handled. |
| `cancel` | `Promise<void>` | Clears the selection. Throws once the chooser is already handled.                                                   |

```ts
page.emitter.on('chooser', async (chooser) => {
	if (chooser.multiple) await chooser.upload(['one.txt', 'two.txt'])
	else await chooser.cancel()
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

## Contract

These invariants hold across the browser layer (`src/core` + `src/server`) ↔ `browser.md`:

1. **Doc ↔ source bijection.** Every `function` / `class` / `const` /
   `interface` / `type` / error row in the `### Core` and `### Server`
   `## Surface` tables is a real export of the browser layer (`src/core` or
   `src/server`), and every export of either appears as a Surface row —
   exhaustive in each direction.
2. **Core is environment-agnostic.** `src/core` imports only
   `@orkestrel/emitter`, `@orkestrel/contract`, and `@orkestrel/html` — no
   `node:*`, no `WebSocket`, no filesystem. `@orkestrel/html` is string → AST →
   string work with no host of its own, so `article()` distills a captured
   document without leaving core: `content()` and `article()` share one
   size-guarded `outerHTML` capture, and `article()` evaluates nothing else —
   no URL, no title, no body text. Every CDP method call
   and event flows through the injected `CDPTransportInterface`; core never
   assumes a runtime.
   Host-side CDP boundaries use `@orkestrel/contract` total guards for
   records, arrays, strings, finite numbers, integers, booleans, errors, and
   class instances. Synchronous JSON and URL operations cross through
   `parseJSON` or `attempt`; asynchronous `try` / `catch` remains only where
   promise rejection and transactional cleanup must be coordinated. Raw
   `typeof` and `instanceof` checks appear only inside compiled expressions
   that execute in the remote page, where host package imports are
   unavailable.
   The `browser → html` edge is one-way and stays that way: `@orkestrel/browser`
   must never become a dependency of `@orkestrel/html`. `BrowserSnapshot`
   navigates CDP DOM snapshots rather than HTML source, so it never moves into
   `@orkestrel/html`. Nor does the snapshot entity ever gain rendering,
   extraction, or distillation — `article()` on the frame is where distillation
   lives, and it is the only place it lives.
3. **The transport is a dumb text pipe.** `CDPTransportInterface` does no
   JSON framing of its own — `CDPClient` owns request/response correlation
   (`id`), timeout handling, and event dispatch (global + session-scoped
   subscriptions) over the transport's raw `message` / `close` / `error`
   events.
4. **Captured bytes never touch a filesystem in core.** A page accepts an
   optional `BrowserWriterInterface`, injected through `BrowserContext`, and
   calls `write(path, bytes)` only when a screenshot, PDF, trace, or HAR
   request carries a `path`; the server supplies `createBrowserWriter`, an
   `fs`-backed implementation, through `Browser`.
5. **Server owns the connection lifecycle.** `Browser.connect()` tries, in
   order: an explicit `cdp.endpoint`; a passive probe of
   `{cdp.host}:{cdp.port}` (defaulting to `127.0.0.1:{cdp.port}` through
   `BROWSER_DEFAULT_HOST`) (`discover()`); then launching a new browser
   process with raw-CDP flags
   (`findSystemBrowser` / `launchBrowserProcess` / `waitForCDPReady`). A
   found existing browser is preferred over a fresh launch. `engine` is
   classified through `parseBrowserEngine` (explicit `executable`) or the
   discovered `SystemBrowser`'s engine (launch) or `browserToEngine` on the
   discovered `/json/version` browser string (CDP discovery); `BrowserOptions.engine`
   narrows `findSystemBrowser` discovery to a preferred engine when launching,
   and the thrown `BrowserConnectionError` carries the requested `engine` in
   `context` when no matching browser is found; launch discovery also consults
   `BrowserOptions.browsers` candidate-source overrides when given. A
   `disconnect()` on either kind of launch retains process ownership without
   killing it — the same instance can reconnect through the retained endpoint
   and remains responsible for termination. `BrowserCDPOptions.discover`
   (default `true`) set to `false` skips passive discovery and probes the
   port directly, rejecting with a coded `BrowserConnectionError` naming the
   occupied port if something is already listening there, rather than
   silently attaching to it.
6. **Lifecycle events are observable, never inferred from state polling.**
   `BrowserInterface.emitter` fires `idle` / `discover` / `connect` /
   `disconnect` / `launch` / `page` / `context` / `error` / `destroy`; `BrowserCodegenInterface.emitter`
   fires `start` / `stop` / `action` / `clear`; `CDPClientInterface.emitter`
   fires `connect` / `close` / `drop` / `error`. Each isolates a listener throw
   through `@orkestrel/emitter`'s emitter, never a domain event. An external
   disconnect (transport loss while an owned process stays alive, or the
   owned process exiting on its own) always emits a coded `error` before
   `disconnect`; transport loss with the process still alive is resumable —
   the browser is not killed and the same `Browser` instance can `connect()`
   again (for example, rediscovering it over CDP), while a process exit is terminal
   for that instance.
7. **Errors carry a machine-readable `code` + optional `context`.**
   `BrowserError` (core) is the base; `BrowserSelectorError` / `CDPError` /
   `CDPConnectionError` / `CDPTimeoutError` / `BrowserResultLimitError` (core)
   narrow selector, protocol, connectivity, timeout, and oversized-result
   faults; `BrowserConnectionError` / `BrowserNotConnectedError` /
   `BrowserDestroyedError` (server) narrow connection-lifecycle faults. Each
   ships an `is*` type guard.
8. **Oversized evaluate/content results fail clean, never crash the session.**
   `BrowserPage.evaluate()` wraps its expression with
   `compileGuardedEvaluateExpression(expression, BROWSER_RESULT_LIMIT)`, and
   `.content()` wraps its HTML (`outerHTML`) and its visible-text
   (`innerText`) sub-evaluations the same way — only `title` and `url` are
   not size-guarded. `article()` shares that one HTML capture and so inherits
   its guard exactly: an oversized document fails `content()` and `article()`
   identically. It does not inherit the body-text guard, because it never
   evaluates `innerText` — a document whose visible text alone exceeds the
   limit fails `content()` while `article()` still returns.
   The guard stringifies the in-page result and throws a
   `BROWSER_RESULT_LIMIT_SENTINEL_PREFIX` (`[[ORKESTREL_BROWSER_RESULT_LIMIT]]`)
   followed by the serialized length before an oversized result could
   overflow the CDP transport frame; `BrowserPage` recognizes that
   sentinel (`BROWSER_RESULT_LIMIT_PATTERN`) and rejects with a coded
   `BrowserResultLimitError` instead — the underlying CDP connection and
   browser process are unaffected. The crash-safety guarantee therefore
   applies to `evaluate()`, to both the HTML and text fields of `.content()`,
   and to `article()`'s HTML capture.
9. **Codegen normalizes and compiles deterministically.**
   `normalizeCodegenActions` collapses consecutive `fill`s on the same
   selector to the latest value (including `contenteditable` fills, captured
   the same way as inputs/textareas); `compileCodegenScript` emits one
   `page.<action>(...)` statement per normalized action, `'javascript'`
   (bare `async function run(page) {...}`) or `'typescript'`
   (`import('@orkestrel/browser').BrowserPageInterface`-typed) per
   `BrowserCodegenScriptOptions.language` (default `'javascript'`).
10. **Doc ↔ source method bijection.** The `## Methods` tables list exactly
    the public methods of each behavioral interface — `CDPTransportInterface`,
    `CDPClientInterface`, `BrowserContextInterface`, `BrowserFrameInterface`,
    `BrowserPageInterface`, `BrowserSnapshotInterface`,
    `BrowserCodegenInterface`, `BrowserTransitionInterface`,
    `BrowserInterface`, `BrowserWebSocketInterface`,
    `BrowserDownloadInterface`, `BrowserWriterInterface`,
    `BrowserNavigationManagerInterface`, `BrowserHandleInterface`,
    `BrowserScriptManagerInterface`, `BrowserAccessibilityInterface`,
    `BrowserTracingInterface`, `BrowserCoverageInterface`,
    `BrowserPerformanceInterface`, `BrowserProfilerInterface`,
    `BrowserDiagnosticsInterface`, `BrowserClockInterface`,
    `BrowserLocatorInterface`, `BrowserSelectorManagerInterface`,
    `BrowserKeyboardInterface`, `BrowserMouseInterface`,
    `BrowserTouchInterface`, `BrowserDialogInterface`,
    `BrowserFileChooserInterface`, `BrowserWorkerInterface`,
    `BrowserRouteInterface`, `BrowserHARManagerInterface`,
    `BrowserNetworkManagerInterface`, `BrowserCookieManagerInterface`,
    `BrowserPermissionManagerInterface`, `BrowserStorageManagerInterface`,
    `BrowserEmulationManagerInterface` — exhaustive in each direction, and each
    implementing class (`WebSocketCDPTransport`, `CDPClient`, `BrowserContext`,
    `BrowserFrame`, `BrowserPage`, `BrowserSnapshot`, `BrowserCodegen`,
    `BrowserTransition`, `Browser`, `BrowserWebSocket`, `BrowserDownload`,
    `FileBrowserWriter`, `BrowserNavigationManager`, `BrowserHandle`,
    `BrowserScriptManager`, `BrowserAccessibility`, `BrowserTracing`,
    `BrowserCoverage`, `BrowserPerformance`, `BrowserProfiler`,
    `BrowserDiagnostics`, `BrowserClock`, `BrowserLocator`,
    `BrowserSelectorManager`, `BrowserKeyboard`, `BrowserMouse`,
    `BrowserTouch`, `BrowserDialog`, `BrowserFileChooser`, `BrowserWorker`,
    `BrowserRoute`, `BrowserHARManager`, `BrowserNetworkManager`,
    `BrowserCookieManager`, `BrowserPermissionManager`,
    `BrowserStorageManager`, `BrowserEmulationManager`) exposes the same public
    methods, no more.
    `BrowserPageInterface` extends `BrowserFrameInterface`, so its table
    repeats every inherited member and points at the frame's own table for the
    behavior. Every remaining export is a function or a data bag rather than a
    behavioral interface with methods — the factories, `decodeBase64` /
    `compileGuardedEvaluateExpression` / `parseCodegenActionPayload` /
    `parseCodegenNavigateAction` / `compileCodegenScript` / `findSystemBrowser` /
    `launchBrowserProcess` / `waitForCDPReady` / `fetchCDPTargets` are
    functions; the options interfaces / event maps / results / `CDPTarget` /
    `BrowserViewport` are data bags — so they contribute no `## Methods` row.
11. **The WebSocket CDP transport is a thin bridge (`src/server`).**
    `WebSocketCDPTransport` connects a Node `WebSocket` to the given CDP
    debugger URL, races the connection attempt against `timeout`
    (default `BROWSER_DEFAULT_TIMEOUT_MS`), and bridges the socket's
    `message` / `close` / `error` events onto its `CDPTransportEventMap`
    emitter unchanged (no framing of its own). `start()` rejects with a
    `BrowserConnectionError` (URL in `context`) on socket error, non-open
    close, or timeout — never a bare error.
12. **`Browser.destroy()` escalates SIGTERM → SIGKILL; `close()` is graceful.**
    On POSIX, each launch owns an isolated process group so Chromium
    subprocesses cannot outlive their parent and keep writing the profile.
    `destroy()` sends `SIGTERM` to the process serving the endpoint, which on
    POSIX means that process's whole group; if it has not exited or the group
    has not drained after `BROWSER_KILL_GRACE_MS`, the same target is
    force-killed with `SIGKILL` and given the same bounded exit window.
    On Windows a launch owns no process group, so each step signals one process
    by identifier. Node ignores the signal name there and terminates that
    process abruptly, so the `SIGTERM` step is already an uncatchable terminate
    and the `SIGKILL` step repeats the terminate only when the process is still
    running after the grace period. Terminating a Chromium browser process
    takes its renderer, GPU, and utility subprocesses with it, so that single
    signal drains the tree the launch created.
    `close()` instead sends CDP `Browser.close` first (best-effort, whether
    the process is owned or merely CDP-attached) and only escalates to the
    same kill sequence if an owned process fails to exit within the grace
    period — the graceful path for shutting down a browser this instance may
    not own. In the worst case an owned, unresponsive process tree makes
    `close()` apply `BROWSER_KILL_GRACE_MS` after `Browser.close`, again after
    `SIGTERM`, and again after `SIGKILL`.
    `BrowserInterface.owned` is `true` for a launched or explicitly adopted
    session, `false` for an active attachment, and `undefined` when no session
    is represented. `BrowserInterface.pid` is the id of the process serving the
    session's CDP endpoint; it stays readable across a `'persistent'` session's
    `disconnect()` and only becomes `undefined` after `destroy()`/`close()` or
    an observed process exit — never on `disconnect()` alone. It is
    `undefined` from the start on a plain CDP attach (`connection === 'cdp'`),
    which never owns a process.
13. **A launch owns the process that serves its endpoint, not the process it
    spawned.** Those are the same process for Chrome and Chromium, whose
    spawned process is the browser. Microsoft Edge on Windows instead
    re-executes itself with the same `--remote-debugging-port` and exits 0
    before the endpoint answers, so `connect()` treats that clean exit as a
    hand-off rather than a death: it keeps waiting for the endpoint on the same
    `timeout` budget, then reads the `browser` entry of CDP
    `SystemInfo.getProcessInfo` and owns the process named there. That process
    is what `pid` reports and what `destroy()` terminates, and the isolated
    profile is removable because nothing in the tree still holds it. The
    failure path is unchanged: a spawned process that exits with a nonzero code
    or a signal rejects immediately with a `BrowserConnectionError` naming the
    exit, a clean exit that produces no endpoint within `timeout` rejects with
    the readiness failure, and an endpoint that names no browser process
    rejects after a best-effort CDP `Browser.close`, rather than owning a
    browser it cannot terminate.
14. **A snapshot is serializable data plus navigation.** `BrowserSnapshot`
    holds exactly the `BrowserSnapshotInput` members `documents` and `styles`, so
    `JSON.stringify(snapshot)` yields `{ documents, styles }` and nothing else,
    and `createBrowserSnapshot(parsed)` turns that JSON back into a navigable
    entity whose walks and `path()` results match the original's. Navigation
    reads plain data: every method takes and returns bare `BrowserNode` values,
    never a wrapper node entity, and the constructor copies and freezes the
    `documents` and `styles` arrays so a caller's later mutation cannot reach the
    snapshot. Containment
    is derived, not declared — a node contains a candidate exactly when
    `snapshot.ancestors(candidate)` includes it — so no membership flag or
    `contains`-style member can drift from the ancestry walk.

## Patterns

### Automate a page end-to-end

This demonstration launches a headless browser, fills and submits a search form, waits for the
results, and reads the resulting content.

```ts
import { createBrowser } from '@orkestrel/browser/server'

const browser = createBrowser({ headless: true })
await browser.connect()

const page = await browser.create({ url: 'https://example.com' })
await page.fill('#search', 'orkestrel')
await page.click('#submit')
await page.wait('#results')
const content = await page.content()

await browser.destroy()
```

### Record and replay interactions with codegen

This demonstration records a click and a fill on a page, then compiles the recorded actions into
a replayable script.

```ts
const page = await browser.create({ url: 'https://example.com' })
const codegen = await page.codegen()

await page.click('#menu')
await page.fill('#search', 'orkestrel')

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
	.map((page) => page.url) // correct immediately, no navigate()/content() needed
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

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` and `src/server` bijection over value and type exports, each `## Methods` table against its interface's call-signature members, and the equality gate: every `Summary` cell against its declaration's description paragraph, the titled `Connect to a browser and drive a page` fence against the `@example` block of that title (pinned so the titled pair cannot be retired silently), and the README pitch against this guide's tagline.
- [`tests/src/core/CDPClient.test.ts`](../tests/src/core/CDPClient.test.ts) and [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) — the JSON-RPC framing, session scoping, timeout, reconnect, and teardown paths of `CDPClient` over an in-memory transport, and the factories that build it.
- [`tests/src/core/BrowserContext.test.ts`](../tests/src/core/BrowserContext.test.ts), [`tests/src/core/BrowserPage.test.ts`](../tests/src/core/BrowserPage.test.ts), [`tests/src/core/BrowserFrame.test.ts`](../tests/src/core/BrowserFrame.test.ts), and [`tests/src/core/BrowserTransition.test.ts`](../tests/src/core/BrowserTransition.test.ts) — the context, page, and frame lifecycles, the destructive target diff `sync()` performs, and the shared transition every joining caller awaits.
- [`tests/src/core/BrowserLocator.test.ts`](../tests/src/core/BrowserLocator.test.ts), [`tests/src/core/BrowserSelectorManager.test.ts`](../tests/src/core/BrowserSelectorManager.test.ts), [`tests/src/core/BrowserHandle.test.ts`](../tests/src/core/BrowserHandle.test.ts), and [`tests/src/core/compilers.test.ts`](../tests/src/core/compilers.test.ts) — strict semantic location, remote-handle retention and disposal, and the in-page expressions the click, fill, select, wait, and visibility compilers emit.
- [`tests/src/core/BrowserKeyboard.test.ts`](../tests/src/core/BrowserKeyboard.test.ts), [`tests/src/core/BrowserMouse.test.ts`](../tests/src/core/BrowserMouse.test.ts), and [`tests/src/core/BrowserTouch.test.ts`](../tests/src/core/BrowserTouch.test.ts) — trusted keyboard, mouse, and touch input, the modifier and pressed-button masks they carry, and the chord grammar `extractBrowserChord` accepts.
- [`tests/src/core/BrowserNetworkManager.test.ts`](../tests/src/core/BrowserNetworkManager.test.ts), [`tests/src/core/BrowserRoute.test.ts`](../tests/src/core/BrowserRoute.test.ts), [`tests/src/core/BrowserHARManager.test.ts`](../tests/src/core/BrowserHARManager.test.ts), [`tests/src/core/BrowserWebSocket.test.ts`](../tests/src/core/BrowserWebSocket.test.ts), and [`tests/src/core/BrowserDownload.test.ts`](../tests/src/core/BrowserDownload.test.ts) — request observation, interception and fulfilment, HAR recording and replay, observed WebSocket frames, and download progress.
- [`tests/src/core/BrowserSnapshot.test.ts`](../tests/src/core/BrowserSnapshot.test.ts), [`tests/src/core/BrowserAccessibility.test.ts`](../tests/src/core/BrowserAccessibility.test.ts), and [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts) — snapshot walking, structural relationships, search, and paths; accessibility-tree capture; and the coercions every protocol parser applies to off-shape input.
- [`tests/src/core/BrowserClock.test.ts`](../tests/src/core/BrowserClock.test.ts), [`tests/src/core/BrowserCoverage.test.ts`](../tests/src/core/BrowserCoverage.test.ts), [`tests/src/core/BrowserProfiler.test.ts`](../tests/src/core/BrowserProfiler.test.ts), [`tests/src/core/BrowserTracing.test.ts`](../tests/src/core/BrowserTracing.test.ts), [`tests/src/core/BrowserPerformance.test.ts`](../tests/src/core/BrowserPerformance.test.ts), and [`tests/src/core/BrowserDiagnostics.test.ts`](../tests/src/core/BrowserDiagnostics.test.ts) — the virtual clock and the diagnostics capabilities beneath one page, including the teardown that discards a failure from an already-stopped capability.
- [`tests/src/core/BrowserCookieManager.test.ts`](../tests/src/core/BrowserCookieManager.test.ts), [`tests/src/core/BrowserStorageManager.test.ts`](../tests/src/core/BrowserStorageManager.test.ts), [`tests/src/core/BrowserPermissionManager.test.ts`](../tests/src/core/BrowserPermissionManager.test.ts), and [`tests/src/core/BrowserEmulationManager.test.ts`](../tests/src/core/BrowserEmulationManager.test.ts) — the context-scoped cookie, web-storage, permission, and emulation overrides, and the overrides a newly created page inherits.
- [`tests/src/core/BrowserScriptManager.test.ts`](../tests/src/core/BrowserScriptManager.test.ts), [`tests/src/core/BrowserCodegen.test.ts`](../tests/src/core/BrowserCodegen.test.ts), [`tests/src/core/BrowserDialog.test.ts`](../tests/src/core/BrowserDialog.test.ts), [`tests/src/core/BrowserFileChooser.test.ts`](../tests/src/core/BrowserFileChooser.test.ts), [`tests/src/core/BrowserWorker.test.ts`](../tests/src/core/BrowserWorker.test.ts), and [`tests/src/core/BrowserNavigationManager.test.ts`](../tests/src/core/BrowserNavigationManager.test.ts) — init scripts and host bindings, action recording and script compilation, dialog and file-chooser handling, attached workers, and the URL and predicate waits that survive ordinary navigation events.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) and [`tests/src/core/errors.test.ts`](../tests/src/core/errors.test.ts) — the pure decoders, validators, and compilers of `src/core`, and the guards that narrow a caught value to each core error.
- [`tests/src/server/Browser.test.ts`](../tests/src/server/Browser.test.ts), [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts), [`tests/src/server/factories.test.ts`](../tests/src/server/factories.test.ts), and [`tests/src/server/errors.test.ts`](../tests/src/server/errors.test.ts) — the discover, connect, launch, adopt, disconnect, destroy, and close lifecycle against a spawned stand-in process; system-browser discovery, profile resolution, and CDP readiness polling; and the guards that narrow a caught value to each server error.
- [`tests/src/server/transports/WebSocketCDPTransport.test.ts`](../tests/src/server/transports/WebSocketCDPTransport.test.ts) and [`tests/src/server/writers/FileBrowserWriter.test.ts`](../tests/src/server/writers/FileBrowserWriter.test.ts) — the `WebSocket`-backed transport against a real in-process CDP server, and the filesystem writer that creates its missing parent directories.
