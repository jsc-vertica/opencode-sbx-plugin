import assert from "node:assert/strict"
import { test } from "node:test"
import { createInventory } from "../src/inventory"
import type { Sandbox } from "../src/model"
import { SbxError } from "../src/sbx"

const sandbox: Sandbox = {
  id: "one", name: "website", status: "running", agent: "shell", workspaces: ["/workspace"],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test("does not execute the CLI until a window asks for a refresh", () => {
  let calls = 0
  const inventory = createInventory({
    load: async () => { calls++; return [] }, changed: () => {}, signal: new AbortController().signal,
  })
  assert.equal(calls, 0)
  assert.deepEqual(inventory.state(), { sandboxes: [], refreshing: false, updatedAt: null, error: null })
})

test("shares concurrent refreshes between windows and publishes loading/success", async () => {
  const load = deferred<readonly Sandbox[]>()
  let calls = 0
  let changes = 0
  const inventory = createInventory({
    load: () => { calls++; return load.promise },
    changed: () => { changes++ }, signal: new AbortController().signal, now: () => 123,
  })
  const first = inventory.refresh()
  const second = inventory.refresh()
  assert.equal(first, second)
  assert.equal(inventory.state().refreshing, true)
  await Promise.resolve()
  assert.equal(calls, 1)
  load.resolve([sandbox])
  await first
  assert.equal(changes, 2)
  assert.deepEqual(inventory.state(), {
    sandboxes: [sandbox], refreshing: false, updatedAt: 123, error: null,
  })
})

test("retains the last good inventory after failure and clears errors after recovery", async () => {
  let failing = false
  let clock = 123
  const inventory = createInventory({
    load: async () => {
      if (failing) throw new SbxError({ code: "timeout", message: "Timed out" })
      return [sandbox]
    },
    changed: () => {}, signal: new AbortController().signal, now: () => clock,
  })
  await inventory.refresh()
  failing = true
  await inventory.refresh()
  assert.deepEqual(inventory.state(), {
    sandboxes: [sandbox], refreshing: false, updatedAt: 123,
    error: { code: "timeout", message: "Timed out" },
  })
  failing = false
  clock = 456
  await inventory.refresh()
  assert.equal(inventory.state().error, null)
  assert.equal(inventory.state().updatedAt, 456)
})

test("distinguishes an initial failure from a successfully empty list", async () => {
  const failed = createInventory({
    load: async () => { throw new Error("private error details") },
    changed: () => {}, signal: new AbortController().signal,
  })
  await failed.refresh()
  assert.equal(failed.state().updatedAt, null)
  assert.equal(failed.state().error?.code, "command-failed")
  assert.doesNotMatch(failed.state().error?.message ?? "", /private/)

  const empty = createInventory({
    load: async () => [], changed: () => {}, signal: new AbortController().signal, now: () => 123,
  })
  await empty.refresh()
  assert.equal(empty.state().updatedAt, 123)
  assert.equal(empty.state().error, null)
})

test("handles synchronous loader failures and allows retries", async () => {
  let calls = 0
  const inventory = createInventory({
    load: () => { calls++; throw new Error("failure") },
    changed: () => {}, signal: new AbortController().signal,
  })
  await inventory.refresh()
  await inventory.refresh()
  assert.equal(calls, 2)
  assert.equal(inventory.state().refreshing, false)
})

test("does not load or broadcast after the plugin has stopped", async () => {
  const controller = new AbortController()
  const load = deferred<readonly Sandbox[]>()
  let calls = 0
  let changes = 0
  const inventory = createInventory({
    load: () => { calls++; return load.promise },
    changed: () => { changes++ }, signal: controller.signal,
  })
  const result = inventory.refresh()
  await Promise.resolve()
  controller.abort()
  load.resolve([sandbox])
  await result
  await inventory.refresh()
  assert.equal(calls, 1)
  assert.equal(changes, 1)
  assert.equal(inventory.state().updatedAt, null)
})

test("does not start a queued command if the plugin stops before it runs", async () => {
  const controller = new AbortController()
  let calls = 0
  const inventory = createInventory({
    load: async () => { calls++; return [] }, changed: () => {}, signal: controller.signal,
  })
  const result = inventory.refresh()
  controller.abort()
  await result
  assert.equal(calls, 0)
})
