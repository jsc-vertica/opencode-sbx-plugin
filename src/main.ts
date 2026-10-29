import type { Plugin } from "@opencode/plugin/gui"
import { Sandboxes } from "./contract"
import { createInventory } from "./inventory"
import { listSandboxes } from "./sbx"

export const main: Plugin.MainSetup = (ctx) => {
  const executable = typeof ctx.options.sbxPath === "string" && ctx.options.sbxPath.trim()
    ? ctx.options.sbxPath.trim()
    : "sbx"

  const inventory = createInventory({
    load: () => listSandboxes({ executable, signal: ctx.signal }),
    signal: ctx.signal,
    changed: () => provider.changed(),
  })

  const provider = ctx.provide(Sandboxes, {
    state: () => inventory.state(),
    refresh: () => inventory.refresh(),
  })
}
