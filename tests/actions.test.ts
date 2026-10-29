import assert from "node:assert/strict"
import { test } from "node:test"
import { createSandboxActions } from "../src/actions"
import { sandboxAction, type Sandbox, type SandboxAction } from "../src/model"
import { SbxError } from "../src/sbx"

const stopped: Sandbox = { id: "one", name: "website", status: "stopped", agent: "shell", workspaces: [] }
const running: Sandbox = { ...stopped, status: "running" }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup(sandboxes: readonly Sandbox[] = [stopped]) {
  const controller = new AbortController()
  const calls: { sandbox: Sandbox; action: SandboxAction }[] = []
  let refreshed = 0
  let changed = 0
  const options = {
    load: async () => sandboxes,
    execute: async (sandbox: Sandbox, action: SandboxAction) => { calls.push({ sandbox, action }) },
    refresh: async () => { refreshed++ },
    changed: () => { changed++ },
    signal: controller.signal,
  }
  return { controller, calls, options, counts: () => ({ refreshed, changed }) }
}

test("only known running/stopped statuses offer a lifecycle action", () => {
  assert.equal(sandboxAction("stopped"), "start")
  assert.equal(sandboxAction("RUNNING"), "stop")
  for (const status of ["starting", "stopping", "failed", "unknown", ""]) {
    assert.equal(sandboxAction(status), null)
  }
})

test("starts a stopped sandbox and refreshes the inventory before releasing its busy state", async () => {
  const env = setup()
  const refreshed = deferred<void>()
  const refreshing = deferred<void>()
  env.options.refresh = () => { refreshing.resolve(); return refreshed.promise }
  const actions = createSandboxActions(env.options)
  const result = actions.change(stopped.id, "start")
  assert.deepEqual(actions.state(), [{ id: stopped.id, action: "start", pending: true, error: null }])
  await refreshing.promise
  assert.deepEqual(env.calls, [{ sandbox: stopped, action: "start" }])
  assert.equal(actions.state()[0]?.pending, true)
  refreshed.resolve()
  await result
  assert.deepEqual(actions.state(), [])
})

test("stops a running sandbox", async () => {
  const env = setup([running])
  const actions = createSandboxActions(env.options)
  await actions.change(running.id, "stop")
  assert.deepEqual(env.calls, [{ sandbox: running, action: "stop" }])
  assert.equal(env.counts().refreshed, 1)
})

test("repair executes on both running and stopped sandboxes instead of treating running as a no-op", async () => {
  for (const sandbox of [running, stopped]) {
    const env = setup([sandbox])
    const actions = createSandboxActions(env.options)
    await actions.change(sandbox.id, "repair")
    assert.deepEqual(env.calls, [{ sandbox, action: "repair" }])
    assert.equal(env.counts().refreshed, 1)
    assert.deepEqual(actions.state(), [])
  }
})

test("repair rechecks the ID and uses the latest sandbox name", async () => {
  const renamed = { ...running, name: "renamed-sandbox" }
  const env = setup([renamed])
  await createSandboxActions(env.options).change(running.id, "repair")
  assert.deepEqual(env.calls, [{ sandbox: renamed, action: "repair" }])

  const replacement = setup([{ ...running, id: "replacement" }])
  const actions = createSandboxActions(replacement.options)
  await actions.change(running.id, "repair")
  assert.deepEqual(replacement.calls, [])
  assert.match(actions.state()[0]?.error ?? "", /no longer exists/)
})

test("repair does not run on transitional or unknown sandbox statuses", async () => {
  for (const status of ["starting", "stopping", "unknown", "failed"]) {
    const env = setup([{ ...running, status }])
    const actions = createSandboxActions(env.options)
    await actions.change(running.id, "repair")
    assert.deepEqual(env.calls, [])
    assert.match(actions.state()[0]?.error ?? "", /not running or stopped/)
  }
})

test("repair locks out duplicate repairs and start/stop until its refresh completes", async () => {
  const env = setup([running])
  const refreshing = deferred<void>()
  const entered = deferred<void>()
  env.options.refresh = () => { entered.resolve(); return refreshing.promise }
  const actions = createSandboxActions(env.options)
  const first = actions.change(running.id, "repair")
  await entered.promise
  for (const action of ["repair", "start", "stop"] as const) assert.equal(actions.change(running.id, action), first)
  assert.deepEqual(actions.state(), [{ id: running.id, action: "repair", pending: true, error: null }])
  refreshing.resolve()
  await first
  assert.equal(env.calls.length, 1)
  assert.deepEqual(actions.state(), [])
})

test("repair failures surface on the card and allow retrying", async () => {
  const env = setup([running])
  let failing = true
  env.options.execute = async (sandbox, action) => {
    env.calls.push({ sandbox, action })
    if (failing) throw new SbxError({ code: "command-failed", message: "Could not repair the sandbox." })
  }
  const actions = createSandboxActions(env.options)
  await actions.change(running.id, "repair")
  assert.deepEqual(actions.state(), [{ id: running.id, action: "repair", pending: false, error: "Could not repair the sandbox." }])
  failing = false
  await actions.change(running.id, "repair")
  assert.deepEqual(actions.state(), [])
  assert.equal(env.calls.length, 2)
  assert.equal(env.counts().refreshed, 2)
})

test("rechecks the ID and uses the latest sandbox name, not a stale UI name", async () => {
  const current = { ...stopped, name: "renamed-website" }
  const env = setup([current])
  await createSandboxActions(env.options).change(stopped.id, "start")
  assert.equal(env.calls[0]?.sandbox.name, "renamed-website")
})

test("refuses a deleted sandbox even if another sandbox reused its name", async () => {
  const env = setup([{ ...stopped, id: "replacement" }])
  const actions = createSandboxActions(env.options)
  await actions.change(stopped.id, "start")
  assert.equal(env.calls.length, 0)
  assert.match(actions.state()[0]?.error ?? "", /no longer exists/)
  assert.equal(env.counts().refreshed, 1)
})

test("stale clicks are no-ops when a sandbox already has the requested state", async () => {
  for (const [sandbox, action] of [[running, "start"], [stopped, "stop"]] as const) {
    const env = setup([sandbox])
    const actions = createSandboxActions(env.options)
    await actions.change(sandbox.id, action)
    assert.equal(env.calls.length, 0)
    assert.deepEqual(actions.state(), [])
    assert.equal(env.counts().refreshed, 1)
  }
})

test("does not run lifecycle commands for transitional or unknown statuses", async () => {
  const env = setup([{ ...stopped, status: "starting" }])
  const actions = createSandboxActions(env.options)
  await actions.change(stopped.id, "start")
  assert.equal(env.calls.length, 0)
  assert.match(actions.state()[0]?.error ?? "", /not running or stopped/)
})

test("shares duplicate and conflicting requests across windows without overlapping commands", async () => {
  const env = setup()
  const entered = deferred<void>()
  const executing = deferred<void>()
  env.options.execute = async (sandbox, action) => {
    env.calls.push({ sandbox, action })
    entered.resolve()
    await executing.promise
  }
  const actions = createSandboxActions(env.options)
  const first = actions.change(stopped.id, "start")
  await entered.promise
  assert.equal(actions.change(stopped.id, "start"), first)
  assert.equal(actions.change(stopped.id, "stop"), first)
  assert.equal(env.calls.length, 1)
  executing.resolve()
  await first
  assert.equal(env.counts().refreshed, 1)
})

test("allows independent sandboxes to operate concurrently", async () => {
  const other = { ...stopped, id: "two", name: "other" }
  const env = setup([stopped, other])
  const executing = deferred<void>()
  const entered = deferred<void>()
  env.options.execute = async (sandbox, action) => {
    env.calls.push({ sandbox, action })
    if (env.calls.length === 2) entered.resolve()
    await executing.promise
  }
  const actions = createSandboxActions(env.options)
  const first = actions.change(stopped.id, "start")
  const second = actions.change(other.id, "start")
  await entered.promise
  assert.equal(actions.state().filter((item) => item.pending).length, 2)
  executing.resolve()
  await Promise.all([first, second])
  assert.deepEqual(actions.state(), [])
})

test("reports CLI failures on the affected card, refreshes, and supports retrying", async () => {
  const env = setup()
  let failing = true
  env.options.execute = async () => {
    if (failing) throw new SbxError({ code: "timeout", message: "Operation timed out; refresh to check status." })
  }
  const actions = createSandboxActions(env.options)
  await actions.change(stopped.id, "start")
  assert.deepEqual(actions.state(), [{
    id: stopped.id, action: "start", pending: false, error: "Operation timed out; refresh to check status.",
  }])
  failing = false
  await actions.change(stopped.id, "start")
  assert.deepEqual(actions.state(), [])
  assert.equal(env.counts().refreshed, 2)
})

test("does not leak unexpected internal error messages", async () => {
  const env = setup()
  env.options.load = async () => { throw new Error("/private/path secret-token") }
  const actions = createSandboxActions(env.options)
  await actions.change(stopped.id, "start")
  assert.doesNotMatch(actions.state()[0]?.error ?? "", /private|secret-token/)
  assert.equal(env.calls.length, 0)
})

test("releases the busy state even if the post-action refresh fails", async () => {
  const env = setup()
  env.options.refresh = async () => { throw new Error("unexpected refresh failure") }
  const actions = createSandboxActions(env.options)
  await actions.change(stopped.id, "start")
  assert.equal(actions.state()[0]?.pending, false)
  assert.match(actions.state()[0]?.error ?? "", /refresh the sandbox status/)
})

test("does not execute or publish after plugin shutdown", async () => {
  const env = setup()
  const listing = deferred<readonly Sandbox[]>()
  const entered = deferred<void>()
  env.options.load = () => { entered.resolve(); return listing.promise }
  const actions = createSandboxActions(env.options)
  const result = actions.change(stopped.id, "start")
  await entered.promise
  env.controller.abort()
  listing.resolve([stopped])
  await result
  await actions.change(stopped.id, "start")
  assert.equal(env.calls.length, 0)
  assert.deepEqual(env.counts(), { refreshed: 0, changed: 1 })
})
