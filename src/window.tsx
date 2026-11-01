import { ComposerPill, Style, type Plugin } from "@opencode/plugin/gui"
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

  // A pill in the composer's pill row (above the reasoning/model controls) that
  // jumps to the Docker Sandboxes settings page. Desktop-only by nature: the
  // composer pill row does not render in web clients or subagent sessions.
  ctx.add(ComposerPill, {
    id: "settings",
    order: 90,
    show: (input) => {
      void input
      return {
        icon: "settings-gear",
        label: "Sandboxes",
        title: "Docker Sandboxes settings",
        run: () => ctx.layout.settings(ctx.id),
      }
    },
  })

  ctx.add(Style, css)
  registerSandboxSettings(ctx, () => <View />)
}
