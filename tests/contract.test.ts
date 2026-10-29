import assert from "node:assert/strict"
import { test } from "node:test"
import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { Sandboxes } from "../src/contract"

test("lifecycle IPC uses a versioned identity distinct from the original read-only bridge", () => {
  assert.equal(Sandboxes.id, "opencode-sbx-plugin.sandboxes.v2")
  assert.notEqual(Sandboxes.id, "opencode-sbx-plugin.sandboxes")
})

test("Desktop's ID-keyed client cache cannot reuse the old read-only codecs for lifecycle controls", () => {
  const old = Ipc.define({
    id: "opencode-sbx-plugin.sandboxes",
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
  assert.deepEqual(after.methods, ["refresh", "change"])
  assert.equal(after.state, Sandboxes.spec.state)
})

test("the current bridge decodes lifecycle state without dropping the new operation fields", () => {
  const snapshot = {
    sandboxes: [{ id: "one", name: "website", status: "running", agent: "shell", workspaces: [] }],
    refreshing: false,
    operations: [{ id: "one", action: "stop", pending: true, error: null }],
    updatedAt: 123,
    error: null,
  }
  assert.deepEqual(Schema.decodeUnknownSync(Sandboxes.spec.state)(snapshot), snapshot)
})

test("the lifecycle bridge rejects unsupported actions", () => {
  const decode = Schema.decodeUnknownSync(Sandboxes.spec.methods.change.input)
  assert.deepEqual(decode({ id: "one", action: "start" }), { id: "one", action: "start" })
  assert.throws(() => decode({ id: "one", action: "delete" }))
})
