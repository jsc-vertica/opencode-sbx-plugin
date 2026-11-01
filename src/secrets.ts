import type { SecretScope, SecretSetup, StoredSecret } from "./model"
import { SbxError } from "./sbx"

interface SecretOptions {
  readonly execute: (kind: "service" | "custom", name: string, scope: SecretScope, sandbox: string | null, value: string) => Promise<void>
  readonly remove: (secret: StoredSecret) => Promise<void>
  readonly refresh: () => Promise<void>
  readonly changed: () => void
  readonly signal: AbortSignal
}

function describe(kind: "service" | "custom", name: string, scope: SecretScope): string {
  return `${kind === "service" ? "Service" : "Custom"} secret "${name}" ${scope === "global" ? "(global)" : "(sandbox)"}`
}

/**
 * One explicit create or removal at a time across windows. The value is forwarded
 * to the main-process bridge call only; it is never kept in shared state.
 */
export function createSecretSetup(options: SecretOptions) {
  let state: SecretSetup = { pending: false, error: null, success: null }
  let pending: Promise<void> | undefined

  function begin(): boolean {
    if (pending) return false
    state = { pending: true, error: null, success: null }
    return true
  }

  function finish(error: string | null, success: string | null): void {
    pending = undefined
    if (!options.signal.aborted) {
      state = { pending: false, error, success }
      options.changed()
    }
  }

  function create(kind: "service" | "custom", name: string, scope: SecretScope, sandbox: string | null, value: string): Promise<void> {
    if (options.signal.aborted) return Promise.resolve()
    if (!value.trim()) {
      state = { pending: false, error: "Enter a secret value before saving.", success: null }
      options.changed()
      return Promise.resolve()
    }
    if (pending) return pending
    begin()
    let error: string | null = null
    let success: string | null = null
    pending = Promise.resolve().then(async () => {
      if (options.signal.aborted) return
      await options.execute(kind, name, scope, sandbox, value)
      success = `${describe(kind, name, scope)} stored.`
    }).catch((cause: unknown) => {
      error = cause instanceof SbxError ? cause.detail.message
        : cause instanceof Error ? cause.message
        : "Could not store the secret. Refresh and try again."
    }).finally(async () => {
      try {
        if (!options.signal.aborted) await options.refresh()
      } catch {
        error ??= "Could not refresh the secret list. Refresh to confirm whether the secret was stored."
      } finally {
        finish(error, success)
      }
    })
    options.changed()
    return pending
  }

  function remove(secret: StoredSecret): Promise<void> {
    if (options.signal.aborted) return Promise.resolve()
    if (pending) return pending
    begin()
    const label = `"${secret.name}" ${secret.scope === "global" ? "(global)" : `(${secret.scope})`}`
    let error: string | null = null
    let success: string | null = null
    pending = Promise.resolve().then(async () => {
      if (options.signal.aborted) return
      await options.remove(secret)
      success = `Removed secret ${label}.`
    }).catch((cause: unknown) => {
      error = cause instanceof SbxError ? cause.detail.message
        : cause instanceof Error ? cause.message
        : "Could not remove the secret. Refresh and try again."
    }).finally(async () => {
      try {
        if (!options.signal.aborted) await options.refresh()
      } catch {
        error ??= "Could not refresh the secret list. Refresh to confirm whether the secret was removed."
      } finally {
        finish(error, success)
      }
    })
    options.changed()
    return pending
  }

  function dismissSuccess(): void {
    if (state.success === null || pending) return
    state = { ...state, success: null }
    options.changed()
  }

  return { state: () => state, create, remove, dismissSuccess }
}
