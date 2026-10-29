import { sandboxAction, type Sandbox, type SandboxAction, type SandboxOperation } from "./model"
import { SbxError } from "./sbx"

interface ActionOptions {
  readonly load: () => Promise<readonly Sandbox[]>
  readonly execute: (sandbox: Sandbox, action: SandboxAction) => Promise<void>
  readonly refresh: () => Promise<void>
  readonly changed: () => void
  readonly signal: AbortSignal
}

class ActionError extends Error {}

/** Locks each sandbox across windows, rechecks its identity/status, and refreshes after every action. */
export function createSandboxActions(options: ActionOptions) {
  const operations = new Map<string, SandboxOperation>()
  const pending = new Map<string, Promise<void>>()

  function change(id: string, action: SandboxAction): Promise<void> {
    if (options.signal.aborted) return Promise.resolve()
    const existing = pending.get(id)
    if (existing) return existing

    operations.set(id, { id, action, pending: true, error: null })
    let message: string | null = null
    const result = Promise.resolve().then(async () => {
      if (options.signal.aborted) return
      // Do not trust a stale row or accept an arbitrary name from the renderer.
      const sandboxes = await options.load()
      if (options.signal.aborted) return
      const sandbox = sandboxes.find((item) => item.id === id)
      if (!sandbox) throw new ActionError("This sandbox no longer exists. Refresh the inventory before trying again.")
      const available = sandboxAction(sandbox.status)
      if (!available) throw new ActionError("This sandbox is not running or stopped. Refresh to check its status before trying again.")
      // A stale click must never toggle a sandbox back in the opposite direction.
      if (available === action) await options.execute(sandbox, action)
    }).catch((error: unknown) => {
      if (options.signal.aborted) return
      message = error instanceof SbxError ? error.detail.message
        : error instanceof ActionError ? error.message : `Could not ${action} the sandbox. Refresh to check its status before trying again.`
    }).finally(async () => {
      try {
        if (!options.signal.aborted) await options.refresh()
      } catch {
        message ??= "Could not refresh the sandbox status after this action. Refresh to check its status before trying again."
      } finally {
        pending.delete(id)
        if (!options.signal.aborted) {
          if (message) operations.set(id, { id, action, pending: false, error: message })
          else operations.delete(id)
          options.changed()
        }
      }
    })
    pending.set(id, result)
    options.changed()
    return result
  }

  return { state: () => Array.from(operations.values()), change }
}
