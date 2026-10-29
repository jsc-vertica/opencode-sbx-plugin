import type { Inventory, Sandbox } from "./model"
import { SbxError } from "./sbx"

export interface InventoryOptions {
  readonly load: () => Promise<readonly Sandbox[]>
  readonly changed: () => void
  readonly signal: AbortSignal
  readonly now?: () => number
}

/** One main-process snapshot and one in-flight command shared by every window. */
export function createInventory(options: InventoryOptions) {
  let state: Inventory = { sandboxes: [], refreshing: false, updatedAt: null, error: null }
  let pending: Promise<void> | undefined
  const now = options.now ?? Date.now

  function refresh(): Promise<void> {
    if (options.signal.aborted) return Promise.resolve()
    if (pending) return pending

    state = { ...state, refreshing: true }
    // Defer load until pending is assigned, including for synchronous failures.
    pending = Promise.resolve().then(() => options.signal.aborted ? [] : options.load()).then(
      (sandboxes) => {
        if (options.signal.aborted) return
        state = { sandboxes, refreshing: false, updatedAt: now(), error: null }
      },
      (error: unknown) => {
        if (options.signal.aborted) return
        state = {
          ...state,
          refreshing: false,
          error: error instanceof SbxError ? error.detail : {
            code: "command-failed",
            message: "Could not refresh sandboxes. Check sbx in a terminal, then try again.",
          },
        }
      },
    ).finally(() => {
      pending = undefined
      if (!options.signal.aborted) options.changed()
    })
    options.changed()
    return pending
  }

  async function reload(): Promise<void> {
    // An action may finish while a pre-action listing is still in flight.
    // Wait for that listing, then request a fresh post-action snapshot.
    await pending
    await refresh()
  }

  return { state: () => state, refresh, reload }
}
