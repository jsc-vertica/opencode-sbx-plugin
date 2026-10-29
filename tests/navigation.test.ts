import assert from "node:assert/strict"
import { test } from "node:test"
import type { Context, MountedSession } from "@opencode/plugin/gui"
import { openSandboxes } from "../src/navigation"

function context(session?: MountedSession) {
  const opened: unknown[][] = []
  // The launcher needs only these two host operations; other host methods are not used.
  const ctx = {
    sessions: { current: () => session },
    layout: { open: (...args: unknown[]) => { opened.push(args) } },
  } as unknown as Pick<Context, "sessions" | "layout">
  return { ctx, opened }
}

test("a launcher click without a mounted session opens the fallback instead of silently doing nothing", () => {
  const { ctx, opened } = context()
  let dialogs = 0
  openSandboxes(ctx, "opencode-sbx-plugin:sandboxes", () => { dialogs++ })
  assert.equal(dialogs, 1)
  assert.equal(opened.length, 0)
})

test("an active session opens its side panel without opening a dialog", () => {
  const session = { id: "active-session" } as MountedSession
  const { ctx, opened } = context(session)
  openSandboxes(ctx, "opencode-sbx-plugin:sandboxes", () => {
    assert.fail("An active session must use its side panel")
  })
  assert.deepEqual(opened, [["opencode-sbx-plugin:sandboxes", session]])
})

test("the launcher reads the current session on every click, not the session at setup time", () => {
  const session = { id: "new-session" } as MountedSession
  const { ctx, opened } = context()
  let current: MountedSession | undefined
  ctx.sessions.current = () => current
  let dialogs = 0
  const click = () => openSandboxes(ctx, "opencode-sbx-plugin:sandboxes", () => { dialogs++ })
  click()
  current = session
  click()
  assert.equal(dialogs, 1)
  assert.deepEqual(opened, [["opencode-sbx-plugin:sandboxes", session]])
})
