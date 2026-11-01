import { Style, type Plugin } from "@opencode/plugin/gui"
import { SandboxPanel } from "./panel"
import { registerSandboxSettings } from "./navigation"
import css from "./panel.css?inline"
import { ErrorBoundary } from "solid-js"

export const setup: Plugin.Setup = (ctx) => {
  function View() {
    const ui = ctx.ui
    return (
      <ErrorBoundary fallback={(_error, reset) => (
        <section class="sbx-panel" role="alert">
          <p>Docker Sandboxes could not render. Try again, or reload the plugin in Settings → Extensions → Plugins.</p>
          <ui.Button size="small" onClick={reset}>Try again</ui.Button>
        </section>
      )}>
        {/* Desktop mounts a settings page only while its tab is active. */}
        <SandboxPanel visible={() => true} />
      </ErrorBoundary>
    )
  }

  ctx.add(Style, css)
  registerSandboxSettings(ctx, () => <View />)
}
