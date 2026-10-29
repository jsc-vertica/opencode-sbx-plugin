import assert from "node:assert/strict"
import { test } from "node:test"
import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { Sandboxes } from "../src/contract"

test("lifecycle IPC uses a versioned identity distinct from the original read-only bridge", () => {
  assert.equal(Sandboxes.id, "opencode-sbx-plugin.sandboxes.v7")
  for (const previous of ["", ".v2", ".v3", ".v4", ".v5", ".v6"]) {
    assert.notEqual(Sandboxes.id, `opencode-sbx-plugin.sandboxes${previous}`)
  }
})

test("Desktop's ID-keyed client cache cannot reuse the old read-only codecs for lifecycle controls", () => {
  const old = Ipc.define({
    id: "opencode-sbx-plugin.sandboxes.v2",
    state: Schema.Struct({ refreshing: Schema.Boolean }),
    methods: { refresh: {} },
  })
  // Desktop 2.2.2 retains the first methods and state codec for an IPC ID across GUI reloads.
  const cache = new Map<string, { methods: string[]; state: unknown }>()
  const client = (token: { id: string; spec: { methods: object; state?: unknown } }) => {
    const existing = cache.get(token.id)
    if (existing) return existing
    const created = { methods: Object.keys(token.spec.methods), state: token.spec.state }
    cache.set(token.id, created)
    return created
  }
  const before = client(old)
  const after = client(Sandboxes)
  assert.notEqual(after, before)
  assert.deepEqual(before.methods, ["refresh"])
  assert.deepEqual(after.methods, ["refresh", "change", "startLogin", "initializePolicy"])
  assert.equal(after.state, Sandboxes.spec.state)
})

test("the current bridge decodes lifecycle state without dropping the new operation fields", () => {
  const snapshot = {
    sandboxes: [{ id: "one", name: "website", status: "running", agent: "shell", workspaces: [] }],
    refreshing: false,
    versions: { client: "0.50.1", server: "0.50.1" },
    auth: "authenticated",
    networkPolicy: "initialized",
    policySetup: { preset: null, pending: false, error: null },
    login: null,
    operations: [{ id: "one", action: "stop", pending: true, error: null }],
    updatedAt: 123,
    error: null,
  }
  assert.deepEqual(Schema.decodeUnknownSync(Sandboxes.spec.state)(snapshot), snapshot)
})

test("the lifecycle bridge rejects unsupported actions", () => {
  const decode = Schema.decodeUnknownSync(Sandboxes.spec.methods.change.input)
  assert.deepEqual(decode({ id: "one", action: "start" }), { id: "one", action: "start" })
  assert.deepEqual(decode({ id: "one", action: "repair" }), { id: "one", action: "repair" })
  assert.throws(() => decode({ id: "one", action: "delete" }))
})

test("policy initialization IPC accepts only the three explicit presets", () => {
  const decode = Schema.decodeUnknownSync(Sandboxes.spec.methods.initializePolicy.input)
  for (const preset of ["balanced", "allow-all", "deny-all"]) assert.equal(decode(preset), preset)
  for (const invalid of ["reset", "--force", "balanced; other-command", null, {}]) assert.throws(() => decode(invalid))
})

test("the bridge preserves the policy-required state and setup failure", () => {
  const snapshot = {
    sandboxes: [], refreshing: false, versions: null, auth: "authenticated", login: null,
    networkPolicy: "required", policySetup: { preset: "balanced", pending: false, error: "Try again" },
    operations: [], updatedAt: null, error: { code: "network-policy-required", message: "Choose a preset" },
  }
  assert.deepEqual(Schema.decodeUnknownSync(Sandboxes.spec.state)(snapshot), snapshot)
})

test("repair cannot reuse the previous IPC action codec and survives shared operation decoding", () => {
  const previous = Schema.Struct({ id: Schema.String, action: Schema.Literals(["start", "stop"]) })
  const repair = { id: "one", action: "repair" }
  assert.throws(() => Schema.decodeUnknownSync(previous)(repair))
  assert.deepEqual(Schema.decodeUnknownSync(Sandboxes.spec.methods.change.input)(repair), repair)
  const snapshot = {
    sandboxes: [], refreshing: false, versions: null, auth: "authenticated", login: null,
    networkPolicy: "initialized", policySetup: { preset: null, pending: false, error: null },
    operations: [{ ...repair, pending: true, error: null }], updatedAt: 123, error: null,
  }
  assert.deepEqual(Schema.decodeUnknownSync(Sandboxes.spec.state)(snapshot), snapshot)
})
