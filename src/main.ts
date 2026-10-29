import { shell } from "electron"
import type { Plugin } from "@opencode/plugin/gui"
import { Sandboxes } from "./contract"
import { createInventory } from "./inventory"
import { createSandboxActions } from "./actions"
import { changeSandbox, listSandboxes, readDiagnostics, readVersions, startLogin } from "./sbx"

export const main: Plugin.MainSetup = (ctx) => {
  const executable = typeof ctx.options.sbxPath === "string" && ctx.options.sbxPath.trim()
    ? ctx.options.sbxPath.trim()
    : "sbx"

  const inventory = createInventory({
    load: () => listSandboxes({ executable, signal: ctx.signal }),
    versions: () => readVersions({ executable, signal: ctx.signal }),
    auth: () => readDiagnostics({ executable, signal: ctx.signal }).then((result) => result.auth),
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

  // One login flow at a time; every window sees the same device code and URL.
  let login: ReturnType<typeof startLogin> | undefined
  const provider = ctx.provide(Sandboxes, {
    state: () => ({ ...inventory.state(), operations: actions.state() }),
    refresh: () => inventory.refresh(),
    change: ({ id, action }) => actions.change(id, action),
    startLogin: () => {
      if (login) return
      login = startLogin({ executable, signal: ctx.signal })
      inventory.setLogin({ url: null, code: null })
      void login.session.then((session) => {
        inventory.setLogin(session)
        if (session.url) shell.openExternal(session.url).catch(() => {})
      })
      void login.done.then((outcome) => {
        login = undefined
        if (outcome === "confirmed") {
          // A confirmed sign-in is worth an immediate refresh; failures surface on the next poll anyway.
          void inventory.reload()
        } else {
          inventory.setLogin(null)
        }
      })
    },
  })
}
