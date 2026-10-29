import { usePlugin } from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, untrack } from "solid-js"
import { Sandboxes } from "./contract"
import { sandboxAction, statusTone, type SandboxAction } from "./model"

const REFRESH_INTERVAL_MS = 5_000

export function SandboxPanel(props: { readonly visible: () => boolean }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const client = ctx.main(Sandboxes)
  const lifetime = new AbortController()
  const [documentVisible, setDocumentVisible] = createSignal(!document.hidden)
  const [bridgeError, setBridgeError] = createSignal<string | null>(null)
  const [requestPending, setRequestPending] = createSignal(false)
  const [localActions, setLocalActions] = createSignal<Record<string, SandboxAction | undefined>>({})
  const [actionErrors, setActionErrors] = createSignal<Record<string, string | undefined>>({})
  const [expandedInfo, setExpandedInfo] = createSignal<Record<string, boolean | undefined>>({})
  const detailsPrefix = createUniqueId()
  let pending: Promise<void> | undefined

  const visibilityChanged = () => setDocumentVisible(!document.hidden)
  document.addEventListener("visibilitychange", visibilityChanged)
  onCleanup(() => {
    lifetime.abort()
    document.removeEventListener("visibilitychange", visibilityChanged)
  })

  function refresh(): Promise<void> {
    if (pending) return pending
    setRequestPending(true)
    pending = client.refresh({ signal: lifetime.signal }).then(
      () => {
        if (!lifetime.signal.aborted) setBridgeError(null)
      },
      () => {
        if (!lifetime.signal.aborted) {
          setBridgeError("Cannot reach the sandbox plugin's Desktop main process. Check that the plugin is enabled and Desktop is compatible, then refresh.")
        }
      },
    ).finally(() => {
      pending = undefined
      if (!lifetime.signal.aborted) setRequestPending(false)
    })
    return pending
  }

  createEffect(() => {
    if (!props.visible() || !documentVisible()) return
    void untrack(refresh)
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const state = () => client.state()
  const operation = (id: string) => state()?.operations?.find((item) => item.id === id)
  const pendingAction = (id: string) => {
    const shared = operation(id)
    return localActions()[id] ?? (shared?.pending ? shared.action : undefined)
  }
  const actionError = (id: string) => actionErrors()[id] ?? operation(id)?.error

  async function change(id: string, action: SandboxAction): Promise<void> {
    if (pendingAction(id) || error()) return
    setLocalActions((previous) => ({ ...previous, [id]: action }))
    setActionErrors((previous) => ({ ...previous, [id]: undefined }))
    try {
      await client.change({ id, action }, { signal: lifetime.signal })
    } catch {
      if (!lifetime.signal.aborted) {
        setActionErrors((previous) => ({
          ...previous,
          [id]: `Could not reach Desktop to ${action} the sandbox. Refresh to check its status before trying again.`,
        }))
      }
    } finally {
      if (!lifetime.signal.aborted) setLocalActions((previous) => ({ ...previous, [id]: undefined }))
    }
  }

  const sandboxes = () => state()?.sandboxes ?? []
  const busy = () => requestPending() || state()?.refreshing === true
  const error = () => bridgeError() ?? state()?.error?.message
  const hasResult = () => state()?.updatedAt != null
  const updated = () => {
    const timestamp = state()?.updatedAt
    return timestamp == null ? "" : new Date(timestamp).toLocaleTimeString()
  }

  return (
    <section class="sbx-panel" aria-label="Docker Sandboxes" aria-busy={busy()}>
      <header class="sbx-panel__header">
        <div>
          <h2>Docker Sandboxes</h2>
          <p class="sbx-panel__muted">On this machine</p>
        </div>
        <ui.Button size="small" variant="ghost" busy={busy()} onClick={() => void refresh()}>
          Refresh
        </ui.Button>
      </header>

      <Show when={error()}>
        {(message) => (
          <div class="sbx-panel__error" role="alert">
            <p>{message()}</p>
            <Show when={hasResult()}>
              <p class="sbx-panel__muted">Showing the last successful result; statuses may be out of date.</p>
            </Show>
          </div>
        )}
      </Show>

      <Show when={!hasResult() && !error()}>
        <div class="sbx-panel__empty" role="status">
          <ui.Loader size="normal" />
          <p>Loading sandboxes…</p>
        </div>
      </Show>

      <Show when={hasResult()}>
        <Show when={sandboxes().length > 0} fallback={
          <div class="sbx-panel__empty">
            <ui.Icon name="cube" size="large" />
            <h3>No local sandboxes</h3>
            <p class="sbx-panel__muted">Create a sandbox with sbx, then refresh this panel.</p>
          </div>
        }>
          <ul class="sbx-panel__list">
            <For each={sandboxes()}>
              {(sandbox) => (
                <li class="sbx-panel__card" aria-busy={!!pendingAction(sandbox.id)}>
                  <div class="sbx-panel__row">
                    <div class="sbx-panel__row-side">
                      <h3 title={sandbox.name}>{sandbox.name}</h3>
                      <span class="sbx-panel__badge" data-status={statusTone(sandbox.status)}>
                        <span class="sbx-panel__dot" aria-hidden="true" />
                        {statusTone(sandbox.status) === "running" ? "Running"
                          : statusTone(sandbox.status) === "stopped" ? "Stopped" : sandbox.status}
                      </span>
                    </div>
                    <div class="sbx-panel__actions" role="group" aria-label={`Controls for ${sandbox.name}`}>
                      <button
                        type="button"
                        class="sbx-panel__info"
                        aria-expanded={!!expandedInfo()[sandbox.id]}
                        aria-controls={`${detailsPrefix}-${sandbox.id}`}
                        onClick={() => setExpandedInfo((previous) => ({
                          ...previous, [sandbox.id]: !previous[sandbox.id],
                        }))}
                      >
                        Info
                      </button>
                      <Show when={pendingAction(sandbox.id) ?? sandboxAction(sandbox.status)}>
                        {(action) => (
                          <ui.Button
                            size="small"
                            variant="neutral"
                            busy={!!pendingAction(sandbox.id)}
                            disabled={!!error()}
                            onClick={() => void change(sandbox.id, action())}
                          >
                            {pendingAction(sandbox.id)
                              ? action() === "start" ? "Starting…" : "Stopping…"
                              : action() === "start" ? "Start" : "Stop"}
                          </ui.Button>
                        )}
                      </Show>
                    </div>
                  </div>
                  <div
                    id={`${detailsPrefix}-${sandbox.id}`}
                    class="sbx-panel__details"
                    hidden={!expandedInfo()[sandbox.id]}
                  >
                    <Show when={sandbox.agent}>
                      <p class="sbx-panel__muted">Agent: {sandbox.agent}</p>
                    </Show>
                    <Show when={sandbox.workspaces.length > 0}>
                      <ul class="sbx-panel__workspaces" aria-label="Workspaces">
                        <For each={sandbox.workspaces}>
                          {(workspace) => <li title={workspace}>{workspace}</li>}
                        </For>
                      </ul>
                    </Show>
                    <Show when={!sandbox.agent && sandbox.workspaces.length === 0}>
                      <p class="sbx-panel__muted">No additional details available.</p>
                    </Show>
                  </div>
                  <Show when={actionError(sandbox.id)}>
                    {(message) => <p class="sbx-panel__action-error" role="alert">{message()}</p>}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <footer class="sbx-panel__footer sbx-panel__muted">
          <p>
            Updated {updated()} · refreshes every 5s while visible
            <Show when={state()?.auth} fallback={<span> · authentication unknown</span>}>
              {(auth) => (
                <span
                  class="sbx-panel__auth"
                  data-auth={auth()}
                >{auth() === "authenticated" ? " · signed in" : auth() === "unauthenticated" ? " · signed out" : " · authentication unknown"}</span>
              )}
            </Show>
          </p>
          <Show when={state()?.versions}>
            {(versions) => (
              <p>
                sbx {versions().client ?? "unknown"}<Show when={versions().server}> · daemon {versions().server}</Show>
              </p>
            )}
          </Show>
        </footer>
      </Show>
    </section>
  )
}
