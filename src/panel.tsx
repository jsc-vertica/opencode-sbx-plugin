import { usePlugin } from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { Sandboxes } from "./contract"
import { statusTone } from "./model"

const REFRESH_INTERVAL_MS = 5_000

export function SandboxPanel(props: { readonly visible: () => boolean }) {
  const ctx = usePlugin()
  const ui = ctx.ui
  const client = ctx.main(Sandboxes)
  const lifetime = new AbortController()
  const [documentVisible, setDocumentVisible] = createSignal(!document.hidden)
  const [bridgeError, setBridgeError] = createSignal<string | null>(null)
  const [requestPending, setRequestPending] = createSignal(false)
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
  const sandboxes = () => state()?.sandboxes ?? []
  const busy = () => requestPending() || state()?.refreshing === true
  const error = () => bridgeError() ?? state()?.error?.message
  const hasResult = () => state()?.updatedAt != null
  const running = () => sandboxes().filter((sandbox) => statusTone(sandbox.status) === "running").length
  const updated = () => {
    const timestamp = state()?.updatedAt
    return timestamp == null ? "" : new Date(timestamp).toLocaleTimeString()
  }

  return (
    <section class="sbx-panel" aria-label="Docker Sandboxes" aria-busy={busy()}>
      <header class="sbx-panel__header">
        <div>
          <h2>Docker Sandboxes</h2>
          <p class="sbx-panel__muted">On this machine · read-only</p>
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
        <p class="sbx-panel__summary" role="status">
          {sandboxes().length} {sandboxes().length === 1 ? "sandbox" : "sandboxes"} · {running()} running
        </p>
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
                <li class="sbx-panel__card">
                  <div class="sbx-panel__row">
                    <h3 title={sandbox.name}>{sandbox.name}</h3>
                    <span class="sbx-panel__badge" data-status={statusTone(sandbox.status)}>
                      <span class="sbx-panel__dot" aria-hidden="true" />
                      {statusTone(sandbox.status) === "running" ? "Running"
                        : statusTone(sandbox.status) === "stopped" ? "Stopped" : sandbox.status}
                    </span>
                  </div>
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
                </li>
              )}
            </For>
          </ul>
        </Show>
        <footer class="sbx-panel__footer sbx-panel__muted">
          Updated {updated()} · refreshes every 5s while visible
        </footer>
      </Show>
    </section>
  )
}
