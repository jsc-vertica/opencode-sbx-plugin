import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

export const Sandboxes = Ipc.define({
  id: "opencode-sbx-plugin.sandboxes",
  state: Schema.Struct({
    sandboxes: Schema.Array(Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: Schema.String,
      agent: Schema.NullOr(Schema.String),
      workspaces: Schema.Array(Schema.String),
    })),
    refreshing: Schema.Boolean,
    updatedAt: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.Struct({
      code: Schema.Literals([
        "missing-cli", "timeout", "daemon-restart-required", "command-failed", "invalid-output",
      ]),
      message: Schema.String,
    })),
  }),
  methods: { refresh: {} },
})
