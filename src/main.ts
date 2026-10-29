import type { Plugin } from "@opencode/plugin/gui"
import { Sandboxes } from "./contract"
import { createInventory } from "./inventory"
import { createSandboxActions } from "./actions"
import { changeSandbox, listSandboxes, readVersions } from "./sbx"

export const main: Plugin.MainSetup = (ctx) => {
  const executable = typeof ctx.options.sbxPath === "string" && ctx.options.sbxPath.trim()
    ? ctx.options.sbxPath.trim()
    : "sbx"

  const inventory = createInventory({
    load: () => listSandboxes({ executable, signal: ctx.signal }),
    versions: () => readVersions({ executable, signal: ctx.signal }),
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

  const provider = ctx.provide(Sandboxes, {
    state: () => ({ ...inventory.state(), operations: actions.state() }),
    refresh: () => inventory.refresh(),
    change: ({ id, action }) => actions.change(id, action),
  })
}
