import { usePlugin } from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, createUniqueId, onCleanup, untrack } from "solid-js"
import { Sandboxes } from "./contract"
import { SECRET_SERVICES, sandboxAction, statusTone, type NetworkPolicyPreset, type SandboxAction, type SecretScope } from "./model"

type PanelTab = "sandboxes" | "secrets"

const REFRESH_INTERVAL_MS = 5_000
// Predefined "zeldoc" plus the CLI's service list; the user can still type any custom name.
const SECRET_NAME_PRESETS = ["zeldoc", ...SECRET_SERVICES] as const
const POLICY_PRESETS: readonly { id: NetworkPolicyPreset; title: string; description: string }[] = [
  { id: "balanced", title: "Balanced (recommended)", description: "Allow common AI services, package registries, and development services; other destinations require approval." },
  { id: "allow-all", title: "Allow all", description: "Allow all outbound TCP traffic. This is the least restrictive preset." },
  { id: "deny-all", title: "Deny all (Locked Down)", description: "No baseline allow rules. Destinations need your approval or an allow rule from you or a kit." },
]

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
  const [selectedPolicy, setSelectedPolicy] = createSignal<NetworkPolicyPreset | null>(null)
  const [policyRequestPending, setPolicyRequestPending] = createSignal(false)
  const [policyError, setPolicyError] = createSignal<string | null>(null)
  const [secretName, setSecretName] = createSignal<string>("zeldoc")
  const [customSecretName, setCustomSecretName] = createSignal<string>("")
  const [secretScope, setSecretScope] = createSignal<SecretScope>("global")
  const [secretSandbox, setSecretSandbox] = createSignal<string>("")
  const [secretValue, setSecretValue] = createSignal<string>("")
  const [secretRequestPending, setSecretRequestPending] = createSignal(false)
  const [secretError, setSecretError] = createSignal<string | null>(null)
  const [activeTab, setActiveTab] = createSignal<PanelTab>("sandboxes")
  const tabs: readonly { id: PanelTab; label: string }[] = [
    { id: "sandboxes", label: "Sandboxes" },
    { id: "secrets", label: "Secrets" },
  ]
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
    if (action !== "stop" && (policyRequired() || policyBusy())) return
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
  const signedOut = () => state()?.error?.code === "not-signed-in"
  const login = () => state()?.login ?? null
  const policyRequired = () => state()?.networkPolicy === "required"
  const policyBusy = () => policyRequestPending() || state()?.policySetup.pending === true
  const policyFailure = () => policyError() ?? state()?.policySetup.error
  async function initializePolicy(): Promise<void> {
    const preset = selectedPolicy()
    if (!preset || policyBusy()) return
    setPolicyRequestPending(true)
    setPolicyError(null)
    try {
      await client.initializePolicy(preset, { signal: lifetime.signal })
    } catch {
      if (!lifetime.signal.aborted) setPolicyError("Cannot reach Desktop to initialize the network policy. Refresh before retrying.")
    } finally {
      if (!lifetime.signal.aborted) setPolicyRequestPending(false)
    }
  }
  async function removeStoredSecret(secret: { name: string; scope: string; type: "service" | "custom"; placeholder: string | null }): Promise<void> {
    if (secretBusy() || error()) return
    setSecretRequestPending(true)
    setSecretError(null)
    try {
      await client.removeSecret(secret, { signal: lifetime.signal })
    } catch {
      if (!lifetime.signal.aborted) setSecretError("Cannot reach Desktop to remove the secret. Refresh before retrying.")
    } finally {
      if (!lifetime.signal.aborted) setSecretRequestPending(false)
    }
  }
  const hasResult = () => state()?.updatedAt != null
  const updated = () => {
    const timestamp = state()?.updatedAt
    return timestamp == null ? "" : new Date(timestamp).toLocaleTimeString()
  }

  const secrets = () => state()?.secrets ?? []
  const secretSetup = () => state()?.secretSetup
  const secretBusy = () => secretRequestPending() || secretSetup()?.pending === true
  const secretFailure = () => secretError() ?? secretSetup()?.error
  const secretSuccess = () => secretSetup()?.success
  const chosenSecretName = () => secretName() === "__custom__" ? customSecretName().trim() : secretName()
  const secretSandboxInvalid = () => secretScope() === "sandbox" && !secretSandbox().trim()
  async function storeSecret(): Promise<void> {
    if (secretBusy() || error()) return
    const name = chosenSecretName()
    const kind = secretName() === "__custom__" ? "custom" as const : SECRET_SERVICES.includes(secretName() as never) ? "service" as const : "custom" as const
    if (!name) {
      setSecretError("Enter a secret name.")
      return
    }
    if (secretSandboxInvalid()) {
      setSecretError("Enter the sandbox name to scope this secret to, or choose the global scope.")
      return
    }
    setSecretRequestPending(true)
    setSecretError(null)
    try {
      await client.setSecret({
        kind,
        name,
        scope: secretScope(),
        sandbox: secretScope() === "sandbox" ? secretSandbox().trim() : null,
        value: secretValue(),
      }, { signal: lifetime.signal })
      setSecretValue("")
    } catch {
      if (!lifetime.signal.aborted) setSecretError("Cannot reach Desktop to store the secret. Refresh before retrying.")
    } finally {
      if (!lifetime.signal.aborted) setSecretRequestPending(false)
    }
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

      <div class="sbx-panel__tabs" role="tablist" aria-label="Docker Sandboxes sections">
        <For each={tabs}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              id={`${detailsPrefix}-tab-${tab.id}`}
              class="sbx-panel__tab"
              aria-selected={activeTab() === tab.id}
              aria-controls={`${detailsPrefix}-panel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
              <Show when={tab.id === "secrets" && secrets().length > 0}>
                <span class="sbx-panel__tab-count">{secrets().length}</span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <Show when={error()}>
        {(message) => (
          <div class="sbx-panel__error" role="alert">
            <p>{message()}</p>
            <Show when={signedOut()}>
              <div class="sbx-panel__login">
                <ui.Button size="small" variant="contrast" busy={!!login()} onClick={() => void client.startLogin({ signal: lifetime.signal }).catch(() => {})}>
                  {login() ? "Waiting for sign-in…" : "Sign in to Docker"}
                </ui.Button>
                <Show when={login()}>
                  {(session) => (
                    <p class="sbx-panel__muted">
                      <Show when={session().code} fallback="Complete the sign-in in your browser.">
                        Device code <strong>{session().code}</strong> — confirm in the opened browser tab.
                      </Show>
                    </p>
                  )}
                </Show>
              </div>
            </Show>
            <Show when={hasResult()}>
              <p class="sbx-panel__muted">Showing the last successful result; statuses may be out of date.</p>
            </Show>
          </div>
        )}
      </Show>

      <Show when={!signedOut() && (policyRequired() || policyBusy()) && activeTab() === "sandboxes"}>
        <section class="sbx-panel__error" aria-label="Network policy setup">
          <h3>Choose a network policy</h3>
          <p id={`${detailsPrefix}-policy-scope`} class="sbx-panel__muted">
            This one-time choice applies to all local sandboxes on this machine. Organization policies still take precedence. Existing policies are never reset here.
          </p>
          <fieldset class="sbx-panel__policy" disabled={policyBusy()} aria-describedby={`${detailsPrefix}-policy-scope`}>
            <legend>Outbound network access</legend>
            <For each={POLICY_PRESETS}>
              {(preset) => (
                <label class="sbx-panel__policy-option">
                  <input
                    type="radio"
                    name={`${detailsPrefix}-network-policy`}
                    value={preset.id}
                    checked={(policyBusy() ? state()?.policySetup.preset ?? selectedPolicy() : selectedPolicy()) === preset.id}
                    onChange={() => setSelectedPolicy(preset.id)}
                  />
                  <span><strong>{preset.title}</strong><span class="sbx-panel__muted">{preset.description}</span></span>
                </label>
              )}
            </For>
          </fieldset>
          <ui.Button size="small" variant="contrast" disabled={!selectedPolicy()} busy={policyBusy()} onClick={() => void initializePolicy()}>
            {policyBusy() ? "Applying policy…" : "Apply network policy"}
          </ui.Button>
          <p class="sbx-panel__muted">Starting sandboxes is disabled until setup is complete. After applying a policy, click Start to retry.</p>
        </section>
      </Show>

      <Show when={!signedOut() && policyFailure()}>
        {(message) => <div class="sbx-panel__error" role="alert">{message()}</div>}
      </Show>

      <Show when={!signedOut() && activeTab() === "secrets"}>
        <section id={`${detailsPrefix}-panel-secrets`} role="tabpanel" aria-labelledby={`${detailsPrefix}-tab-secrets`} class="sbx-panel__secrets" aria-label="Service secrets">
          <h3>Service secrets</h3>
          <p id={`${detailsPrefix}-secrets-help`} class="sbx-panel__muted">
            Global secrets apply to every sandbox. Scoped secrets only apply to a single sandbox.
          </p>
          <Show when={secretFailure()}>
            {(message) => <div class="sbx-panel__error" role="alert">{message()}</div>}
          </Show>
          <Show when={secretSuccess()}>
            {(message) => (
              <div class="sbx-panel__secret-success" role="status">
                <span>{message()}</span>
                <button
                  type="button"
                  class="sbx-panel__info"
                  aria-label="Dismiss"
                  onClick={() => client.dismissSecretSuccess().catch(() => {})}
                >Dismiss</button>
              </div>
            )}
          </Show>
          <div class="sbx-panel__secret-form" aria-describedby={`${detailsPrefix}-secrets-help`}>
            <label class="sbx-panel__secret-field">
              <span>Secret</span>
              <select
                value={secretName()}
                disabled={secretBusy()}
                onChange={(event) => setSecretName(event.currentTarget.value)}
              >
                {SECRET_NAME_PRESETS.map((preset) => <option value={preset}>{preset}</option>)}
                <option value="__custom__">Custom…</option>
              </select>
            </label>
            <Show when={secretName() === "__custom__"}>
              <label class="sbx-panel__secret-field">
                <span>Custom name</span>
                <input
                  type="text"
                  value={customSecretName()}
                  placeholder="e.g. zeldoc"
                  disabled={secretBusy()}
                  onInput={(event) => setCustomSecretName(event.currentTarget.value)}
                />
              </label>
            </Show>
            <label class="sbx-panel__secret-field">
              <span>Scope</span>
              <select
                value={secretScope()}
                disabled={secretBusy()}
                onChange={(event) => setSecretScope(event.currentTarget.value as SecretScope)}
              >
                <option value="global">Global</option>
                <option value="sandbox">Sandbox</option>
              </select>
            </label>
            <Show when={secretScope() === "sandbox"}>
              <label class="sbx-panel__secret-field">
                <span>Sandbox name</span>
                <input
                  type="text"
                  value={secretSandbox()}
                  placeholder="e.g. my-sandbox"
                  disabled={secretBusy()}
                  onInput={(event) => setSecretSandbox(event.currentTarget.value)}
                  list={`${detailsPrefix}-sandbox-names`}
                />
              </label>
              <datalist id={`${detailsPrefix}-sandbox-names`}>
                <For each={sandboxes()}>{(sandbox) => <option value={sandbox.name} />}</For>
              </datalist>
            </Show>
            <label class="sbx-panel__secret-field">
              <span>Value</span>
              <input
                type="password"
                value={secretValue()}
                placeholder="Secret value"
                disabled={secretBusy()}
                autocomplete="off"
                onInput={(event) => setSecretValue(event.currentTarget.value)}
              />
            </label>
            <div class="sbx-panel__secret-submit">
              <ui.Button
                size="small"
                variant="contrast"
                busy={secretBusy()}
                disabled={secretBusy() || !chosenSecretName()}
                onClick={() => void storeSecret()}
              >
                {secretBusy() ? "Saving…" : "Save"}
              </ui.Button>
            </div>
          </div>
          <Show when={secrets().length > 0}>
            <table class="sbx-panel__secret-table">
              <caption class="sbx-panel__muted">Stored secrets</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Type</th>
                  <th scope="col"><span class="sbx-visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                <For each={secrets()}>
                  {(secret) => (
                    <tr>
                      <td>{secret.name}</td>
                      <td>{secret.scope === "global" ? "global" : secret.scope}</td>
                      <td>{secret.type}</td>
                      <td class="sbx-panel__secret-actions">
                        <button
                          type="button"
                          class="sbx-panel__info"
                          disabled={secretBusy()}
                          aria-label={`Remove secret ${secret.name} (${secret.scope})`}
                          onClick={() => void removeStoredSecret(secret)}
                        >Remove</button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </section>
      </Show>

      <Show when={activeTab() === "sandboxes"}>
        <div id={`${detailsPrefix}-panel-sandboxes`} role="tabpanel" aria-labelledby={`${detailsPrefix}-tab-sandboxes`}>
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
                      <ui.Tooltip value="Re-run sandbox setup to repair the MCP gateway. Also starts stopped sandboxes.">
                        <ui.Button
                          size="small"
                          variant="neutral"
                          busy={pendingAction(sandbox.id) === "repair"}
                          disabled={!!pendingAction(sandbox.id) || !!error() || policyRequired() || policyBusy() || !sandboxAction(sandbox.status)}
                          onClick={() => void change(sandbox.id, "repair")}
                        >
                          {pendingAction(sandbox.id) === "repair" ? "Repairing…" : "Repair"}
                        </ui.Button>
                      </ui.Tooltip>
                      <Show when={sandboxAction(sandbox.status)}>
                        {(action) => (
                          <ui.Button
                            size="small"
                            variant="neutral"
                            busy={pendingAction(sandbox.id) === action()}
                            disabled={!!pendingAction(sandbox.id) || !!error() || (action() === "start" && (policyRequired() || policyBusy()))}
                            onClick={() => void change(sandbox.id, action())}
                          >
                            {pendingAction(sandbox.id) === action()
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
        </div>
      </Show>
    </section>
  )
}
