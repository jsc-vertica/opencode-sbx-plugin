import assert from "node:assert/strict"
import { test } from "node:test"
import type { Context, MountedSession, PanelState } from "@opencode/plugin/gui"
import { createSandboxLauncher, openSandboxes } from "../src/navigation"

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

test("the launcher is a stable item with a live opened getter, not a row-replacing reactive factory", () => {
  let session: MountedSession | undefined
  let sessionReads = 0
  let state: PanelState = "closed"
  let clicks = 0
  const ctx = {
    id: "opencode-sbx-plugin",
    sessions: { current: () => { sessionReads++; return session } },
    layout: { state: () => state },
  } as unknown as Pick<Context, "id" | "sessions" | "layout">
  const launcher = createSandboxLauncher(ctx, `${ctx.id}:sandboxes`, () => { clicks++ })
  assert.equal(typeof launcher, "object")
  assert.equal(sessionReads, 0, "registration must not subscribe to session or focus changes")
  assert.equal(typeof Object.getOwnPropertyDescriptor(launcher, "opened")?.get, "function")
  assert.equal(launcher.opened, false)
  assert.equal(launcher.keybind, "opencode-sbx-plugin.open")

  session = { id: "active-session" } as MountedSession
  for (const next of ["closed", "open", "active", "visible"] as const) {
    state = next
    assert.equal(launcher.opened, next !== "closed")
  }
  // The same item's getter follows session changes without another factory call.
  session = { id: "another-session" } as MountedSession
  state = "closed"
  assert.equal(launcher.opened, false)
  launcher.run()
  assert.equal(clicks, 1)
})
