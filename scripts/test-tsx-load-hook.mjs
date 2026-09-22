// Test-only module customization hook that lets `node --test` import a real
// .tsx component (Node cannot load .tsx natively). It transpiles the file with
// the project's own TypeScript (types stripped, JSX -> react/jsx-runtime) and
// changes nothing else. Deliberately NOT part of scripts/test-register.mjs: a
// test that needs it opts in with
//   register("<path>/scripts/test-tsx-load-hook.mjs", import.meta.url)
// before dynamically importing the component, so no other test is affected.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".tsx")) {
    const fileName = fileURLToPath(url);
    const source = await readFile(fileName, "utf8");
    const out = ts.transpileModule(source, {
      fileName,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
