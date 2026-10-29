import type { NetworkPolicyPreset, NetworkPolicyStatus, PolicySetup } from "./model"
import { SbxError } from "./sbx"

interface PolicyOptions {
  readonly check: () => Promise<NetworkPolicyStatus>
  readonly execute: (preset: NetworkPolicyPreset) => Promise<void>
  readonly refresh: () => Promise<void>
  readonly changed: () => void
  readonly signal: AbortSignal
}

/** One explicit initialization at a time across windows; never resets existing policy. */
export function createPolicySetup(options: PolicyOptions) {
  let state: PolicySetup = { preset: null, pending: false, error: null }
  let pending: Promise<void> | undefined

  function initialize(preset: NetworkPolicyPreset): Promise<void> {
    if (options.signal.aborted) return Promise.resolve()
    if (pending) return pending
    state = { preset, pending: true, error: null }
    let error: string | null = null
    pending = Promise.resolve().then(async () => {
      if (options.signal.aborted) return
      const status = await options.check()
      if (options.signal.aborted || status === "initialized") return
      if (status !== "required") {
        error = "Cannot verify whether network policy setup is needed. Refresh or run `sbx diagnose` in a terminal. No policy was changed."
        return
      }
      await options.execute(preset)
    }).catch((cause: unknown) => {
      error = cause instanceof SbxError ? cause.detail.message
        : "Could not initialize the network policy. Refresh to check its status before retrying."
    }).finally(async () => {
      try {
        if (!options.signal.aborted) await options.refresh()
      } catch {
        error ??= "Could not refresh the policy status. Refresh before retrying setup."
      } finally {
        pending = undefined
        if (!options.signal.aborted) {
          state = { preset, pending: false, error }
          options.changed()
        }
      }
    })
    options.changed()
    return pending
  }

  return { state: () => state, initialize }
}
