import type { Diagnostics, Inventory, InventoryError, SbxVersions, Sandbox, StoredSecret } from "./model"
import { SbxError } from "./sbx"

export interface InventoryOptions {
  readonly load: () => Promise<readonly Sandbox[]>
  readonly versions?: () => Promise<SbxVersions>
  readonly diagnostics?: () => Promise<Diagnostics>
  readonly secrets?: () => Promise<readonly StoredSecret[]>
  readonly changed: () => void
  readonly signal: AbortSignal
  readonly now?: () => number
}

/** One main-process snapshot and one in-flight command shared by every window. */
export function createInventory(options: InventoryOptions) {
  let state: Inventory = {
    sandboxes: [], refreshing: false, updatedAt: null, error: null, versions: null, auth: null, networkPolicy: null, login: null,
    secrets: [], secretSetup: { pending: false, error: null, success: null },
  }
  let pending: Promise<void> | undefined
  let diagnosticsStale = true
  const now = options.now ?? Date.now

  function setLogin(login: Inventory["login"]): void {
    state = { ...state, login }
    options.changed()
  }

  function refresh(): Promise<void> {
    if (options.signal.aborted) return Promise.resolve()
    if (pending) return pending

    state = { ...state, refreshing: true }
    // Defer load until pending is assigned, including for synchronous failures.
    pending = Promise.resolve().then(async () => {
      if (options.signal.aborted) {
        return { sandboxes: [], versions: state.versions, auth: state.auth, networkPolicy: state.networkPolicy, secrets: state.secrets }
      }
      // Reuse initialized diagnostics during normal polling, but recheck after
      // login/actions and while setup is missing (including external CLI setup).
      const versions = options.versions && state.versions === null
        ? await options.versions().catch(() => null)
        : state.versions
      const diagnostics = options.diagnostics && (diagnosticsStale || state.networkPolicy !== "initialized")
        ? await options.diagnostics().catch(() => null)
        : null
      if (options.signal.aborted) return { sandboxes: [], versions, auth: state.auth, networkPolicy: state.networkPolicy, secrets: state.secrets }
      if (diagnostics) diagnosticsStale = false
      // Diagnostics must survive a failed listing, e.g. immediately after login.
      state = { ...state, versions, ...(diagnostics ?? {}) }
      // Secrets are cheap to refresh and must reflect external CLI changes, so
      // they are reloaded on every refresh; a failure keeps the last listing.
      const secrets = options.secrets
        ? await options.secrets().catch(() => state.secrets)
        : state.secrets
      state = { ...state, secrets }
      return { sandboxes: await options.load(), versions, auth: state.auth, networkPolicy: state.networkPolicy, secrets }
    }).then(
      (result) => {
        if (options.signal.aborted) return
        // A successful listing clears the sign-in offer; a failed one keeps it.
        state = {
          ...result,
          refreshing: false,
          updatedAt: now(),
          error: null,
          login: null,
          // Preserve in-flight form state across successful refreshes.
          secretSetup: state.secretSetup,
        }
      },
      (error: unknown) => {
        if (options.signal.aborted) return
        const detail = error instanceof SbxError ? error.detail : {
          code: "command-failed" as const,
          message: "Could not refresh sandboxes. Check sbx in a terminal, then try again.",
        }
        state = {
          ...state,
          refreshing: false,
          error: detail,
          networkPolicy: detail.code === "network-policy-required" ? "required" : state.networkPolicy,
          // The error code offers sign-in; only startLogin may mark a flow as
          // pending. Inventing a session here disables the button before a click.
          login: state.login,
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
    diagnosticsStale = true
    await refresh()
  }

  function setSecretSetup(setup: Inventory["secretSetup"]): void {
    state = { ...state, secretSetup: setup }
    options.changed()
  }

  return { state: () => state, refresh, reload, setLogin, setSecretSetup }
}
