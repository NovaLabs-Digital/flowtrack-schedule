// Node module customization hook (see test-register.mjs) used only when
// running this project's tests under plain `node --test`. Reproduces the
// two pieces of Next.js's webpack resolution that this project's lib/
// modules rely on and that plain Node has no built-in equivalent for:
//
//   1. The "@/*" -> "./*" path alias (from tsconfig.json's "paths").
//   2. Extensionless relative/aliased imports (Next.js's bundler resolves
//      these; native Node ESM requires an explicit, exact extension).
//
// Plus one project-specific shim: the real "server-only" npm package
// unconditionally throws when its index.js runs outside of Next.js's
// webpack pipeline (see test-server-only-shim.mjs for why) — this hook
// redirects that one bare specifier to a local no-op instead.
//
// Nothing here changes how the app itself builds or runs; this hook is
// only ever active under `node --import ./scripts/test-register.mjs`.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SERVER_ONLY_SHIM_URL = pathToFileURL(path.join(PROJECT_ROOT, "scripts", "test-server-only-shim.mjs")).href;

const CANDIDATE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

function resolveExistingFile(basePath) {
  if (existsSync(basePath)) return basePath;
  for (const ext of CANDIDATE_EXTENSIONS) {
    const candidate = basePath + ext;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: SERVER_ONLY_SHIM_URL, shortCircuit: true };
  }

  if (specifier.startsWith("@/")) {
    const target = resolveExistingFile(path.join(PROJECT_ROOT, specifier.slice(2)));
    if (target) {
      return nextResolve(pathToFileURL(target).href, context);
    }
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const importerPath = context.parentURL ? fileURLToPath(context.parentURL) : PROJECT_ROOT;
    const base = path.resolve(path.dirname(importerPath), specifier);
    const target = resolveExistingFile(base);
    if (target && target !== base) {
      return nextResolve(pathToFileURL(target).href, context);
    }
  }

  return nextResolve(specifier, context);
}
