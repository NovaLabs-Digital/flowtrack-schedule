// Test-only (test-db/capacity_fixes.test.ts): like scripts/test-tsx-load-hook.mjs,
// but also matches .tsx URLs that carry a query string, which is how
// node:test's mock.module() addresses a module it replaces.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export async function load(url, context, nextLoad) {
  const clean = url.split("?")[0];
  if (clean.startsWith("file:") && clean.endsWith(".tsx")) {
    const fileName = fileURLToPath(clean);
    const source = await readFile(fileName, "utf8");
    const out = ts.transpileModule(source, {
      fileName,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
