import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

import type { SbxVersions } from "./model"

export const Sandboxes = Ipc.define({
  // Desktop caches IPC clients/codecs by ID across GUI rebuilds. Bump this version
  // whenever methods or the state schema change, so live windows cannot reuse an old contract.
  id: "opencode-sbx-plugin.sandboxes.v4",
  state: Schema.Struct({
    sandboxes: Schema.Array(Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: Schema.String,
      agent: Schema.NullOr(Schema.String),
      workspaces: Schema.Array(Schema.String),
    })),
    refreshing: Schema.Boolean,
    versions: Schema.NullOr(Schema.Struct({
      client: Schema.NullOr(Schema.String),
      server: Schema.NullOr(Schema.String),
    })),
    auth: Schema.NullOr(Schema.Literals(["authenticated", "unauthenticated", "unknown"])),
    operations: Schema.Array(Schema.Struct({
      id: Schema.String,
      action: Schema.Literals(["start", "stop"]),
      pending: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
    })),
    updatedAt: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.Struct({
      code: Schema.Literals([
        "missing-cli", "timeout", "daemon-restart-required", "command-failed", "invalid-output",
      ]),
      message: Schema.String,
    })),
  }),
  methods: {
    refresh: {},
    change: { input: Schema.Struct({ id: Schema.String, action: Schema.Literals(["start", "stop"]) }) },
  },
})
