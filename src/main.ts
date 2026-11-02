import type { Plugin } from "@opencode/plugin/gui"
import { Sandboxes } from "./contract"
import { createInventory } from "./inventory"
import { createSandboxActions } from "./actions"
import { createPolicySetup } from "./policy"
import { changeSandbox, initializeNetworkPolicy, listSandboxes, listSecrets, readDiagnostics, readVersions, removeSecret, setCustomSecret, setServiceSecret, startLogin } from "./sbx"
import { createSecretSetup } from "./secrets"

export const main: Plugin.MainSetup = (ctx) => {
  const executable = typeof ctx.options.sbxPath === "string" && ctx.options.sbxPath.trim()
    ? ctx.options.sbxPath.trim()
    : "sbx"

  const inventory = createInventory({
    load: () => listSandboxes({ executable, signal: ctx.signal }),
    versions: () => readVersions({ executable, signal: ctx.signal }),
    diagnostics: () => readDiagnostics({ executable, signal: ctx.signal }),
    secrets: () => listSecrets({ executable, signal: ctx.signal }),
    signal: ctx.signal,
    changed: () => provider.changed(),
  })

  const policy = createPolicySetup({
    check: () => readDiagnostics({ executable, signal: ctx.signal }).then((result) => result.networkPolicy),
    execute: (preset) => initializeNetworkPolicy({ executable, signal: ctx.signal }, preset),
    refresh: () => inventory.reload(),
    signal: ctx.signal,
    changed: () => provider.changed(),
  })

  const actions = createSandboxActions({
    load: () => listSandboxes({ executable, signal: ctx.signal }),
    execute: (sandbox, action) => changeSandbox({ executable, signal: ctx.signal }, sandbox, action),
    refresh: () => inventory.reload(),
    signal: ctx.signal,
    changed: () => provider.changed(),
  })

  const secrets = createSecretSetup({
    execute: (kind, name, scope, sandbox, value) =>
      kind === "service"
        ? setServiceSecret({ executable, signal: ctx.signal }, name, scope, sandbox, value)
        : setCustomSecret({ executable, signal: ctx.signal }, name, scope, sandbox, value),
    remove: (secret) => removeSecret({ executable, signal: ctx.signal }, secret),
    refresh: () => inventory.reload(),
    signal: ctx.signal,
    changed: () => provider.changed(),
  })

  // One login flow at a time; every window sees the same device code and URL.
  let login: ReturnType<typeof startLogin> | undefined
  const provider = ctx.provide(Sandboxes, {
    state: () => ({ ...inventory.state(), operations: actions.state(), policySetup: policy.state() }),
    refresh: () => inventory.refresh(),
    change: ({ id, action }) => actions.change(id, action),
    initializePolicy: (preset) => policy.initialize(preset),
    setSecret: (input) => {
      const setup = secrets.state()
      if (!setup.pending && !inventory.state().secretSetup.pending) {
        inventory.setSecretSetup({ ...setup, pending: true, error: null, success: null })
      }
      return secrets.create(input.kind, input.name, input.scope, input.sandbox, input.value).then(() => {
        inventory.setSecretSetup(secrets.state())
      })
    },
    dismissSecretSuccess: () => {
      secrets.dismissSuccess()
      inventory.setSecretSetup(secrets.state())
    },
    removeSecret: (input) => {
      return secrets.remove(input).then(() => {
        inventory.setSecretSetup(secrets.state())
      })
    },
    startLogin: () => {
      if (login) return
      login = startLogin({ executable, signal: ctx.signal })
      inventory.setLogin({ url: null, code: null })
      void login.session.then((session) => {
        // sbx login opens the browser itself; the panel only displays the URL and code.
        inventory.setLogin(session)
      })
      void login.done.then((outcome) => {
        login = undefined
        inventory.setLogin(null)
        if (outcome === "confirmed") {
          // A confirmed sign-in is worth an immediate refresh; failures surface on the next poll anyway.
          void inventory.reload()
        }
      })
    },
  })
}
