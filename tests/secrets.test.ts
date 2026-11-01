import assert from "node:assert/strict"
import { test } from "node:test"
import { createSecretSetup } from "../src/secrets"

test("a successful create publishes success, refreshes, and clears the value path", async () => {
  const executed: Array<{ kind: string; name: string; scope: string; sandbox: string | null; value: string }> = []
  let refreshed = 0
  let changes = 0
  const setup = createSecretSetup({
    execute: async (kind, name, scope, sandbox, value) => {
      executed.push({ kind, name, scope, sandbox, value })
    },
    refresh: async () => { refreshed++ },
    changed: () => { changes++ },
    signal: new AbortController().signal,
  })
  await setup.create("custom", "zeldoc", "sandbox", "my-sandbox", "value-1")
  assert.deepEqual(executed, [{ kind: "custom", name: "zeldoc", scope: "sandbox", sandbox: "my-sandbox", value: "value-1" }])
  assert.equal(refreshed, 1)
  assert.equal(setup.state().pending, false)
  assert.equal(setup.state().error, null)
  assert.match(setup.state().success ?? "", /zeldoc/)
  assert.ok(changes > 0)
  // The value is intentionally not kept anywhere in shared state.
  assert.ok(!JSON.stringify(setup.state()).includes("value-1"))
  setup.dismissSuccess()
  assert.equal(setup.state().success, null)
})

test("a create failure is reported and still refreshes; empty values are refused locally", async () => {
  let refreshed = 0
  let executed = 0
  const setup = createSecretSetup({
    execute: async () => {
      executed++
      throw new Error("boom")
    },
    refresh: async () => { refreshed++ },
    changed: () => {},
    signal: new AbortController().signal,
  })
  await setup.create("service", "github", "global", null, "value")
  assert.equal(executed, 1)
  assert.equal(refreshed, 1)
  assert.match(setup.state().error ?? "", /boom/)
  assert.equal(setup.state().success, null)
  await setup.create("service", "github", "global", null, "  ")
  assert.equal(executed, 1, "an empty value must not run the CLI")
  assert.match(setup.state().error ?? "", /Enter a secret value/)
})

test("overlapping creates share one operation; shutdown blocks new ones", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let executed = 0
  const controller = new AbortController()
  const setup = createSecretSetup({
    execute: async () => {
      executed++
      await gate
    },
    refresh: async () => {},
    changed: () => {},
    signal: controller.signal,
  })
  const first = setup.create("service", "github", "global", null, "one")
  const second = setup.create("service", "openai", "global", null, "two")
  assert.equal(first, second, "concurrent creates share the in-flight operation")
  assert.equal(setup.state().pending, true)
  release()
  await first
  assert.equal(executed, 1, "the second create must not run a second CLI command")
  controller.abort()
  await setup.create("service", "github", "global", null, "three")
  assert.equal(executed, 1, "a stopped plugin must not execute further commands")
})
