import assert from "node:assert/strict"
import { test } from "node:test"
import { createInventory } from "../src/inventory"
import type { Sandbox, SbxVersions } from "../src/model"
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
  assert.deepEqual(inventory.state(), {
    sandboxes: [], refreshing: false, updatedAt: null, error: null, versions: null, auth: null, networkPolicy: null, login: null,
    secrets: [], secretSetup: { pending: false, error: null, success: null },
  })
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
    sandboxes: [sandbox], refreshing: false, updatedAt: 123, error: null, versions: null, auth: null, networkPolicy: null, login: null,
    secrets: [], secretSetup: { pending: false, error: null, success: null },
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
    sandboxes: [sandbox], refreshing: false, updatedAt: 123, versions: null, auth: null, networkPolicy: null, login: null,
    secrets: [], secretSetup: { pending: false, error: null, success: null },
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

test("a post-action reload waits for an older listing and then fetches a fresh snapshot", async () => {
  const old = deferred<readonly Sandbox[]>()
  let calls = 0
  const inventory = createInventory({
    load: () => ++calls === 1 ? old.promise : Promise.resolve([{ ...sandbox, status: "stopped" }]),
    changed: () => {}, signal: new AbortController().signal,
  })
  const refreshing = inventory.refresh()
  const reloading = inventory.reload()
  await Promise.resolve()
  assert.equal(calls, 1)
  old.resolve([sandbox])
  await Promise.all([refreshing, reloading])
  assert.equal(calls, 2)
  assert.equal(inventory.state().sandboxes[0]?.status, "stopped")
})

test("reads the sbx version once and reuses it for later refreshes", async () => {
  let versionCalls = 0
  const versions: SbxVersions = { client: "0.50.1", server: "0.50.1" }
  const inventory = createInventory({
    load: async () => [],
    versions: async () => { versionCalls++; return versions },
    changed: () => {}, signal: new AbortController().signal, now: () => 123,
  })
  await inventory.refresh()
  await inventory.refresh()
  assert.equal(versionCalls, 1)
  assert.deepEqual(inventory.state().versions, versions)
})

test("a version failure does not fail the inventory refresh", async () => {
  let versionCalls = 0
  const inventory = createInventory({
    load: async () => [sandbox],
    versions: async () => { versionCalls++; throw new Error("version unavailable") },
    changed: () => {}, signal: new AbortController().signal, now: () => 123,
  })
  await inventory.refresh()
  assert.equal(versionCalls, 1)
  assert.equal(inventory.state().versions, null)
  assert.deepEqual(inventory.state().sandboxes, [sandbox])
  assert.equal(inventory.state().error, null)
})

test("reads the authentication state once and reuses it for later refreshes", async () => {
  let authCalls = 0
  const inventory = createInventory({
    load: async () => [],
    diagnostics: async () => { authCalls++; return { auth: "authenticated", networkPolicy: "initialized" } },
    changed: () => {}, signal: new AbortController().signal, now: () => 123,
  })
  await inventory.refresh()
  await inventory.refresh()
  assert.equal(authCalls, 1)
  assert.equal(inventory.state().auth, "authenticated")
})

test("a diagnostics failure does not fail the inventory refresh", async () => {
  let authCalls = 0
  const inventory = createInventory({
    load: async () => [sandbox],
    diagnostics: async () => { authCalls++; throw new Error("diagnose unavailable") },
    changed: () => {}, signal: new AbortController().signal, now: () => 123,
  })
  await inventory.refresh()
  assert.equal(authCalls, 1)
  assert.equal(inventory.state().auth, null)
  assert.deepEqual(inventory.state().sandboxes, [sandbox])
  assert.equal(inventory.state().error, null)
})

test("a signed-out refresh offers sign-in without pretending a login has started", async () => {  let signedIn = false
  const inventory = createInventory({
    load: async () => {
      if (!signedIn) throw new SbxError({ code: "not-signed-in", message: "Not signed in to Docker." })
      return [sandbox]
    },
    changed: () => {}, signal: new AbortController().signal, now: () => 123,
  })
  await inventory.refresh()
  assert.equal(inventory.state().error?.code, "not-signed-in")
  assert.equal(inventory.state().login, null)
  await inventory.refresh()
  assert.equal(inventory.state().login, null, "polling must leave the sign-in button enabled")

  // A non-sign-in failure must not offer login.
  inventory.setLogin(null)
  const failing = createInventory({
    load: async () => { throw new SbxError({ code: "timeout", message: "Timed out" }) },
    changed: () => {}, signal: new AbortController().signal, now: () => 123,
  })
  await failing.refresh()
  assert.equal(failing.state().error?.code, "timeout")
  assert.equal(failing.state().login, null)

  // After confirming in the browser, the next refresh clears the offer.
  inventory.setLogin({ url: "https://login.docker.com/activate?user_code=KSKV-HZRV", code: "KSKV-HZRV" })
  signedIn = true
  await inventory.reload()
  assert.equal(inventory.state().error, null)
  assert.equal(inventory.state().auth === null || inventory.state().auth === "authenticated", true)
  assert.equal(inventory.state().login, null)
})

test("signed-out polling preserves a real pending login but does not recreate a cancelled one", async () => {
  const inventory = createInventory({
    load: async () => { throw new SbxError({ code: "not-signed-in", message: "Not signed in" }) },
    changed: () => {}, signal: new AbortController().signal,
  })
  const login = { url: "https://login.docker.com/activate?user_code=TEST-CODE", code: "TEST-CODE" }
  inventory.setLogin(login)
  await inventory.refresh()
  assert.deepEqual(inventory.state().login, login)

  inventory.setLogin(null)
  await inventory.refresh()
  assert.equal(inventory.state().login, null)
})

test("setLogin publishes immediately and is visible before the next refresh", async () => {
  let changes = 0
  const inventory = createInventory({
    load: async () => [], changed: () => { changes++ }, signal: new AbortController().signal,
  })
  const before = changes
  inventory.setLogin({ url: null, code: null })
  assert.equal(changes, before + 1)
  assert.deepEqual(inventory.state().login, { url: null, code: null })
  inventory.setLogin(null)
  assert.equal(inventory.state().login, null)
})

test("post-login reload rechecks cached diagnostics and exposes missing network policy", async () => {
  let signedIn = false
  let calls = 0
  const inventory = createInventory({
    load: async () => [],
    diagnostics: async () => {
      calls++
      return signedIn
        ? { auth: "authenticated", networkPolicy: "required" }
        : { auth: "unknown", networkPolicy: "initialized" }
    },
    changed: () => {}, signal: new AbortController().signal,
  })
  await inventory.refresh()
  await inventory.refresh()
  assert.equal(calls, 1)
  signedIn = true
  await inventory.reload()
  assert.equal(calls, 2)
  assert.equal(inventory.state().auth, "authenticated")
  assert.equal(inventory.state().networkPolicy, "required")
})

test("missing policy is rechecked while polling and clears after external CLI setup", async () => {
  let initialized = false
  let calls = 0
  const inventory = createInventory({
    load: async () => [sandbox],
    diagnostics: async () => {
      calls++
      return { auth: "authenticated", networkPolicy: initialized ? "initialized" : "required" }
    },
    changed: () => {}, signal: new AbortController().signal,
  })
  await inventory.refresh()
  assert.equal(inventory.state().networkPolicy, "required")
  assert.deepEqual(inventory.state().sandboxes, [sandbox])
  initialized = true
  await inventory.refresh()
  assert.equal(inventory.state().networkPolicy, "initialized")
  await inventory.refresh()
  assert.equal(calls, 2)
})

test("diagnostics and policy-required errors survive a failed sandbox listing", async () => {
  const inventory = createInventory({
    load: async () => { throw new SbxError({ code: "network-policy-required", message: "Choose a preset" }) },
    diagnostics: async () => ({ auth: "authenticated", networkPolicy: "unknown" }),
    changed: () => {}, signal: new AbortController().signal,
  })
  await inventory.refresh()
  assert.equal(inventory.state().networkPolicy, "required")
  assert.equal(inventory.state().auth, "authenticated")
  assert.equal(inventory.state().error?.code, "network-policy-required")
})
