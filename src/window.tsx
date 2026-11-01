import { Style, TitlebarItem, type Plugin } from "@opencode/plugin/gui"
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

  // A titlebar pill: always visible, independent of any open session, and one
  // click away from the Docker Sandboxes settings page.
  ctx.add(TitlebarItem, (): TitlebarItem => ({
    id: "settings",
    label: "Sandboxes",
    title: "Docker Sandboxes settings",
    icon: "cube",
    run: () => ctx.layout.settings(ctx.id),
  }))

  ctx.add(Style, css)
  registerSandboxSettings(ctx, () => <View />)
}
