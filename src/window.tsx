import { Command, MenuItem, Panel, Style, type PanelTab, type Plugin } from "@opencode/plugin/gui"
import { SandboxPanel } from "./panel"
import { openSandboxes } from "./navigation"
import css from "./panel.css?inline"
import { ErrorBoundary } from "solid-js"

export const setup: Plugin.Setup = (ctx) => {
  const key = `${ctx.id}:sandboxes`
  const tab: PanelTab = {
    id: "sandboxes",
    title: "Docker Sandboxes",
    closable: "compact",
    fallback: true,
  }

  function View(props: { readonly visible: () => boolean }) {
    const ui = ctx.ui
    return (
      <ErrorBoundary fallback={(_error, reset) => (
        <section class="sbx-panel" role="alert">
          <p>Docker Sandboxes could not render. Try again, or reload the plugin in Settings → Extensions → Plugins.</p>
          <ui.Button size="small" onClick={reset}>Try again</ui.Button>
        </section>
      )}>
        <SandboxPanel visible={props.visible} />
      </ErrorBoundary>
    )
  }

  function open() {
    openSandboxes(ctx, key, () => {
      const ui = ctx.ui
      ctx.dialogs.open(() => (
        <ui.Dialog title="Docker Sandboxes" size="large">
          <View visible={() => true} />
        </ui.Dialog>
      ))
    })
  }

  ctx.add(Style, css)
  ctx.add(Panel, {
    id: "sandboxes",
    region: "side",
    mobile: {
      title: "Docker Sandboxes",
      order: 45,
      kind: "menu",
      icon: "cube",
    },
    list: (input) => input.open.includes(tab.id) ? [tab] : [],
    render: (props) => (
      <View visible={() => ctx.layout.narrow() || ctx.layout.state(key, props.session) === "visible"} />
    ),
  })
  ctx.add(Command, (): Command => ({
    id: "open",
    title: "Open Docker Sandboxes",
    description: "Show the sandbox inventory on this machine",
    keywords: "sbx docker sandbox containers status",
    group: "Docker Sandboxes",
    enabled: ctx.app.platform === "desktop",
    run: open,
  }))
  ctx.add(MenuItem, (): MenuItem => {
    const session = ctx.sessions.current()
    return {
      id: "open",
      menu: "session.panel",
      title: "Docker Sandboxes",
      description: "Local sandbox status",
      icon: "cube",
      keybind: `${ctx.id}.open`,
      opened: !!session && ctx.layout.state(key, session) !== "closed",
      run: open,
    }
  })
}
