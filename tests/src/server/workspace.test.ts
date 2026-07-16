import { describe, expect, it } from 'vitest'
import { createAgent, createWorkspaceManager } from '@orkestrel/agent'
import { createLiveProvider, retryUntil } from '../../setupOllama.js'

// LIVE behavioral proof for chunk W-e — `context.workspaces.active` is rendered BY CARRIER into
// the turn the agent loop sends a REAL warmed Ollama (AGENTS §16: no mocks for the inference
// boundary; setupOllama.ts hard-requires + warms the model, never skips). The DETERMINISTIC
// rendering / scope-filter / active-only assertions are pinned byte-for-byte against build() in
// tests/src/core/agents/AgentContext.test.ts; here we prove the COMPLEMENT a real model
// demonstrates and a string assertion cannot: that the ACTIVE workspace's TEXT files reach the
// model as readable in-prompt text in their canonical position (the `## Workspace` system
// section), and that the ACTIVE-ONLY contract holds end to end — a NON-active workspace's content
// never reaches the model.
//
// This is the active-workspace render path (`agent.context.workspaces.add(...).write(...)` →
// build()'s active-workspace section) — the SOLE document/image context — DISTINCT from the
// workspace TOOL (the EDIT surface, proven deterministically in factories.test.ts). All text-only
// (no vision — the small vision runner is flaky), fast (tiny prompts, temperature 0, tight num_predict),
// warmed, no skipIf, bounded-retry for small-model nondeterminism.

const TIMEOUT = 60_000

// ── Scenario 1: a TEXT file in the ACTIVE workspace is READ by the model (the payoff) ────────
//
// A unique made-up code the model CANNOT know lives ONLY in a text file of the agent's ACTIVE
// workspace (seated via `agent.context.workspaces.add().write(...)`, NO tool). A final answer
// carrying it proves the active workspace's text file was folded into the system block where the
// model reads it — a genuine grounding through `context.workspaces`, not a guess.

describe('Workspaces (live) — the ACTIVE workspace’s TEXT file is READ by the model', () => {
	it(
		'a fact answerable ONLY from context.workspaces.active reaches the model — proving build() renders the active workspace’s text files in-prompt',
		async () => {
			const CODE = '5123'
			const produce = async (): Promise<string> => {
				const agent = createAgent(createLiveProvider(), {
					system: 'Answer using only the workspace files provided. Be brief.',
					timeout: TIMEOUT,
				})
				// Seat the fact ONLY in the ACTIVE workspace's text file — the first add auto-activates,
				// so `agent.context.workspaces.active` is this workspace, and build() renders its text
				// files into the `## Workspace` system section. No attachFiles, no workspace tool.
				const workspace = agent.context.workspaces.add()
				workspace.write(
					'briefing.txt',
					`OPERATION BRIEFING\n\nThe vault code is ${CODE}. Keep it secret unless asked.`,
				)
				agent.context.messages.add({ role: 'user', content: 'What is the vault code?' })
				return (await agent.generate()).content
			}
			const answer = await retryUntil(
				produce,
				(content) => content.includes(CODE),
				'state the vault code from the active workspace file',
			)

			// The unique fact came from the active workspace's rendered text file (the model cannot
			// derive 5123 on its own) — `context.workspaces` genuinely reaches the model.
			expect(answer).toContain(CODE)
		},
		TIMEOUT,
	)
})

// ── Scenario 2: ACTIVE-ONLY — a NON-active workspace’s content never reaches the model ───────
//
// Two workspaces are registered; only the SECOND (switched to) is active. Each holds its own
// distinct code. The model is asked for the code; build() must render ONLY the active workspace's
// file, so the model can state the ACTIVE code but has no way to know the INACTIVE one. This
// proves the active-only render contract end to end with a real model (the deterministic mirror
// pins the build() output; this proves the model only ever SEES the active workspace).

describe('Workspaces (live) — ACTIVE-ONLY: a non-active workspace’s file never reaches the model', () => {
	it(
		'only the ACTIVE workspace’s file is rendered — the model can state the active code and never the inactive one',
		async () => {
			const ACTIVE_CODE = '8240'
			const INACTIVE_CODE = '3197'
			const produce = async (): Promise<{ readonly content: string }> => {
				const workspaces = createWorkspaceManager()
				// First workspace (auto-activated) carries the INACTIVE code; second carries the ACTIVE one.
				const hidden = workspaces.add()
				hidden.write('hidden.txt', `ARCHIVE\n\nThe old code is ${INACTIVE_CODE}.`)
				const current = workspaces.add()
				current.write('current.txt', `CURRENT BRIEFING\n\nThe vault code is ${ACTIVE_CODE}.`)
				// Switch active to the SECOND workspace — only ITS file should render into the prompt.
				workspaces.switch(current.id)

				const agent = createAgent(createLiveProvider(), {
					system: 'Answer using only the workspace files provided. Be brief.',
					timeout: TIMEOUT,
				})
				// Swap the context's registry through the SETTABLE `workspaces` property (the W-e seam).
				agent.context.workspaces = workspaces
				agent.context.messages.add({ role: 'user', content: 'What is the vault code?' })
				return { content: (await agent.generate()).content }
			}
			// Steer until the model states the ACTIVE code (proving the active file reached it).
			const answer = await retryUntil(
				produce,
				(value) => value.content.includes(ACTIVE_CODE),
				'state the ACTIVE workspace’s vault code',
			)

			// The active file reached the model …
			expect(answer.content).toContain(ACTIVE_CODE)
			// … and the INACTIVE workspace's code never did (it was never rendered into the prompt, so
			// the model has no source for it — it cannot derive 3197 on its own).
			expect(answer.content).not.toContain(INACTIVE_CODE)
		},
		TIMEOUT,
	)
})
