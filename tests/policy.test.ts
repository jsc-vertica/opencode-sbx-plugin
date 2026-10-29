import assert from "node:assert/strict"
import { test } from "node:test"
import { createPolicySetup } from "../src/policy"
import type { NetworkPolicyPreset, NetworkPolicyStatus } from "../src/model"
import { SbxError } from "../src/sbx"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function setup(status: NetworkPolicyStatus = "required") {
  const controller = new AbortController()
  const calls: NetworkPolicyPreset[] = []
  let checks = 0
  let refreshes = 0
  let changes = 0
  const options = {
    check: async (): Promise<NetworkPolicyStatus> => { checks++; return status },
    execute: async (preset: NetworkPolicyPreset) => { calls.push(preset) },
    refresh: async () => { refreshes++ },
    changed: () => { changes++ },
    signal: controller.signal,
  }
  return { options, controller, calls, counts: () => ({ checks, refreshes, changes }) }
}

test("policy setup does nothing until the user explicitly chooses a preset", () => {
  const env = setup()
  const policy = createPolicySetup(env.options)
  assert.deepEqual(policy.state(), { preset: null, pending: false, error: null })
  assert.deepEqual(env.counts(), { checks: 0, refreshes: 0, changes: 0 })
  assert.deepEqual(env.calls, [])
})

test("initializes the selected preset and refreshes before releasing its busy state", async () => {
  for (const preset of ["balanced", "allow-all", "deny-all"] as const) {
    const env = setup()
    const refreshing = deferred<void>()
    const entered = deferred<void>()
    env.options.refresh = () => { entered.resolve(); return refreshing.promise }
    const policy = createPolicySetup(env.options)
    const result = policy.initialize(preset)
    assert.deepEqual(policy.state(), { preset, pending: true, error: null })
    await entered.promise
    assert.deepEqual(env.calls, [preset])
    assert.equal(policy.state().pending, true)
    refreshing.resolve()
    await result
    assert.deepEqual(policy.state(), { preset, pending: false, error: null })
  }
})

test("never replaces or resets a policy that was initialized elsewhere", async () => {
  const env = setup("initialized")
  const policy = createPolicySetup(env.options)
  await policy.initialize("allow-all")
  assert.deepEqual(env.calls, [])
  assert.equal(env.counts().refreshes, 1)
  assert.equal(policy.state().error, null)
})

test("unknown policy status fails closed without changing network access", async () => {
  const env = setup("unknown")
  const policy = createPolicySetup(env.options)
  await policy.initialize("allow-all")
  assert.deepEqual(env.calls, [])
  assert.match(policy.state().error ?? "", /Cannot verify/)
  assert.match(policy.state().error ?? "", /No policy was changed/)
})

test("duplicate and conflicting choices across windows share one initialization", async () => {
  const env = setup()
  const executing = deferred<void>()
  env.options.execute = async (preset) => { env.calls.push(preset); await executing.promise }
  const policy = createPolicySetup(env.options)
  const first = policy.initialize("balanced")
  assert.equal(policy.initialize("allow-all"), first)
  assert.equal(policy.initialize("deny-all"), first)
  executing.resolve()
  await first
  assert.deepEqual(env.calls, ["balanced"])
  assert.equal(env.counts().checks, 1)
})

test("a failed initialization is visible and retryable", async () => {
  const env = setup()
  let fail = true
  env.options.execute = async (preset) => {
    env.calls.push(preset)
    if (fail) throw new SbxError({ code: "timeout", message: "Timed out; refresh before retrying" })
  }
  const policy = createPolicySetup(env.options)
  await policy.initialize("balanced")
  assert.equal(policy.state().pending, false)
  assert.match(policy.state().error ?? "", /Timed out/)
  fail = false
  await policy.initialize("balanced")
  assert.equal(policy.state().error, null)
  assert.equal(env.calls.length, 2)
})

test("check failures do not leak private data or initialize a policy", async () => {
  const env = setup()
  env.options.check = async () => { throw new Error("/private/path secret-token") }
  const policy = createPolicySetup(env.options)
  await policy.initialize("balanced")
  assert.deepEqual(env.calls, [])
  assert.ok(policy.state().error)
  assert.doesNotMatch(policy.state().error ?? "", /private|secret-token/)
})

test("a refresh failure releases the shared busy state", async () => {
  const env = setup()
  env.options.refresh = async () => { throw new Error("private") }
  const policy = createPolicySetup(env.options)
  await policy.initialize("balanced")
  assert.equal(policy.state().pending, false)
  assert.match(policy.state().error ?? "", /refresh the policy status/)
})

test("plugin shutdown prevents queued initialization and further broadcasts", async () => {
  const env = setup()
  const checking = deferred<NetworkPolicyStatus>()
  const entered = deferred<void>()
  env.options.check = () => { entered.resolve(); return checking.promise }
  const policy = createPolicySetup(env.options)
  const result = policy.initialize("balanced")
  await entered.promise
  env.controller.abort()
  checking.resolve("required")
  await result
  await policy.initialize("allow-all")
  assert.deepEqual(env.calls, [])
  assert.equal(env.counts().refreshes, 0)
  assert.equal(env.counts().changes, 1)
})
