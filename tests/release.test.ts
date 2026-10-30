import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { prepareRelease } from "../scripts/prepare-release"

async function fixture(t: TestContext) {
  const base = await mkdtemp("/tmp/opencode/sbx-release-test-")
  t.after(() => rm(base, { recursive: true, force: true }))
  const source = join(base, "source")
  const output = join(base, "output")
  await mkdir(join(source, "dist"), { recursive: true })
  await writeFile(join(source, "dist/gui-experimental.cjs"), "module.exports = { default: {} }\n")
  await writeFile(join(source, "README.md"), "Test documentation\n")
  await writeFile(join(source, "HANDOFF.md"), "Machine-specific debugging details\n")
  await writeFile(join(source, "package.json"), JSON.stringify({
    name: "opencode-sbx-plugin", version: "0.1.0", description: "Test plugin",
    repository: { type: "git", url: "git+https://github.com/jsc-vertica/opencode-sbx-plugin.git" },
    scripts: { build: "vite build", prepack: "npm run build", prepare: "npm run build" },
    dependencies: { effect: "4.0.6" }, devDependencies: { electron: "44.9.1" }, engines: { node: ">=22.12.0" },
  }))
  return { source, output }
}

test("prebuilt Git distribution preserves identity and bundle without Git preparation triggers", async (t) => {
  const { source, output } = await fixture(t)
  await prepareRelease(source, output)
  const pkg = JSON.parse(await readFile(join(output, "package.json"), "utf8"))
  assert.equal(pkg.name, "opencode-sbx-plugin")
  assert.equal(pkg.version, "0.1.0")
  assert.deepEqual(pkg.exports, { "./gui-experimental": "./dist/gui-experimental.cjs" })
  for (const key of ["scripts", "dependencies", "devDependencies", "engines", "workspaces"]) assert.equal(pkg[key], undefined)
  assert.deepEqual((await readdir(output)).sort(), ["README.md", "dist", "package.json"])
  assert.deepEqual(await readFile(join(output, "dist/gui-experimental.cjs")), await readFile(join(source, "dist/gui-experimental.cjs")))
  assert.equal(await readFile(join(source, "HANDOFF.md"), "utf8"), "Machine-specific debugging details\n")
})

test("release generation copies license metadata and LICENSE when present", async (t) => {
  const { source, output } = await fixture(t)
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"))
  await writeFile(join(source, "package.json"), JSON.stringify({ ...pkg, license: "MIT" }))
  await writeFile(join(source, "LICENSE"), "Test license\n")
  await prepareRelease(source, output)
  assert.equal(JSON.parse(await readFile(join(output, "package.json"), "utf8")).license, "MIT")
  assert.equal(await readFile(join(output, "LICENSE"), "utf8"), "Test license\n")
})

test("regenerating a release preserves its Git checkout and updates the artifact", async (t) => {
  const { source, output } = await fixture(t)
  await mkdir(join(output, ".git"), { recursive: true })
  await writeFile(join(output, ".git/config"), "keep this checkout")
  await prepareRelease(source, output)
  await writeFile(join(source, "dist/gui-experimental.cjs"), "new bundle")
  await prepareRelease(source, output)
  assert.equal(await readFile(join(output, ".git/config"), "utf8"), "keep this checkout")
  assert.equal(await readFile(join(output, "dist/gui-experimental.cjs"), "utf8"), "new bundle")
})

test("release generation refuses the source directory, its ancestors, or another source subdirectory", async (t) => {
  const { source } = await fixture(t)
  for (const output of [source, join(source, ".."), join(source, "dist"), join(source, "src")]) {
    await assert.rejects(prepareRelease(source, output), /must not overwrite|must be under/)
  }
  await prepareRelease(source, join(source, ".release"))
})

test("release generation refuses unrelated files in the destination", async (t) => {
  const { source, output } = await fixture(t)
  await mkdir(output)
  await writeFile(join(output, "user-work.txt"), "keep me")
  await assert.rejects(prepareRelease(source, output), /unrelated files/)
  assert.equal(await readFile(join(output, "user-work.txt"), "utf8"), "keep me")
})

test("release generation refuses an empty GUI bundle", async (t) => {
  const { source, output } = await fixture(t)
  await writeFile(join(source, "dist/gui-experimental.cjs"), "")
  await assert.rejects(prepareRelease(source, output), /Build the GUI bundle/)
  await assert.rejects(readdir(output), { code: "ENOENT" })
})
