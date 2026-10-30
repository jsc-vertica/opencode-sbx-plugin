import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const bundle = "dist/gui-experimental.cjs"

/** Git installs must not need npm's Git-dependency build/preparation subprocess. */
export async function prepareRelease(source: string, destination: string): Promise<void> {
  const root = resolve(source)
  const output = resolve(destination)
  const inside = relative(root, output)
  if (!inside || inside.split(sep).every((part) => part === "..")) {
    throw new Error("Release output must not overwrite the source checkout or its ancestors")
  }
  if (!inside.startsWith(`..${sep}`) && !isAbsolute(inside) && inside.split(sep)[0] !== ".release") {
    throw new Error("In-checkout release output must be under .release")
  }

  const pkg: Record<string, unknown> = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
  const code = await readFile(resolve(root, bundle))
  if (!code.length) throw new Error("Build the GUI bundle before preparing a release")
  const readme = await readFile(resolve(root, "README.md"))
  const license = await readFile(resolve(root, "LICENSE")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  const allowed = new Set([".git", "package.json", "README.md", "LICENSE", "dist"])
  const entries = await readdir(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return []
  })
  if (entries.some((entry) => !allowed.has(entry))) throw new Error("Release output contains unrelated files")

  // Keep the package name: GUI-only plugin IDs and IPC ownership depend on it.
  // The host supplies every external module; the artifact needs no dependencies,
  // devDependencies, engines, or install/build hooks (including build/prepack).
  const manifest: Record<string, unknown> = {
    name: pkg.name,
    version: pkg.version,
    type: "module",
    exports: { "./gui-experimental": `./${bundle}` },
    files: ["dist", "README.md"],
  }
  for (const key of ["description", "repository", "homepage", "bugs", "author", "license", "os", "cpu"]) {
    if (pkg[key] !== undefined) manifest[key] = pkg[key]
  }
  await mkdir(resolve(output, "dist"), { recursive: true })
  await Promise.all([
    writeFile(resolve(output, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(resolve(output, bundle), code),
    writeFile(resolve(output, "README.md"), readme),
    ...(license ? [writeFile(resolve(output, "LICENSE"), license)] : []),
  ])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const output = resolve(process.argv[2] ?? resolve(root, ".release"))
  await prepareRelease(root, output)
  console.log(`Prebuilt GitHub distribution prepared in ${output}`)
}
