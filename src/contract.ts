import { Ipc } from "@opencode/plugin/gui"
import { Schema } from "effect"

export const Sandboxes = Ipc.define({
  // Desktop caches IPC clients/codecs by ID across GUI rebuilds. Bump this version
  // whenever methods or the state schema change, so live windows cannot reuse an old contract.
  id: "opencode-sbx-plugin.sandboxes.v9",
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
    networkPolicy: Schema.NullOr(Schema.Literals(["initialized", "required", "unknown"])),
    policySetup: Schema.Struct({
      preset: Schema.NullOr(Schema.Literals(["balanced", "allow-all", "deny-all"])),
      pending: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
    }),
    login: Schema.NullOr(Schema.Struct({
      url: Schema.NullOr(Schema.String),
      code: Schema.NullOr(Schema.String),
    })),
    secrets: Schema.Array(Schema.Struct({
      name: Schema.String,
      scope: Schema.String,
      type: Schema.Literals(["service", "custom"]),
      placeholder: Schema.NullOr(Schema.String),
    })),
    secretSetup: Schema.Struct({
      pending: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
      success: Schema.NullOr(Schema.String),
    }),
    operations: Schema.Array(Schema.Struct({
      id: Schema.String,
      action: Schema.Literals(["start", "stop", "repair"]),
      pending: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
    })),
    updatedAt: Schema.NullOr(Schema.Number),
    error: Schema.NullOr(Schema.Struct({
      code: Schema.Literals([
        "missing-cli", "timeout", "daemon-restart-required", "command-failed", "invalid-output", "not-signed-in", "network-policy-required",
      ]),
      message: Schema.String,
    })),
  }),
  methods: {
    refresh: {},
    change: { input: Schema.Struct({ id: Schema.String, action: Schema.Literals(["start", "stop", "repair"]) }) },
    startLogin: {},
    initializePolicy: { input: Schema.Literals(["balanced", "allow-all", "deny-all"]) },
    dismissSecretSuccess: {},
    removeSecret: {
      input: Schema.Struct({
        name: Schema.String,
        scope: Schema.String,
        type: Schema.Literals(["service", "custom"]),
        placeholder: Schema.NullOr(Schema.String),
      }),
    },
    setSecret: {
      input: Schema.Struct({
        kind: Schema.Literals(["service", "custom"]),
        name: Schema.String,
        scope: Schema.Literals(["global", "sandbox"]),
        sandbox: Schema.NullOr(Schema.String),
        value: Schema.String,
      }),
    },
  },
})
