// Preloaded via `node --import ./scripts/test-register.mjs --test ...`
// (see package.json's "test" script). Registers the resolve hook in
// test-resolve-hooks.mjs so test files can import server-only,
// Supabase/Stripe-touching lib/ modules the same way the app itself does
// (the "@/lib/..." alias, plain `import "server-only"`) without needing a
// bundler — Next.js's webpack config resolves both of those specially at
// build time; this hook reproduces just enough of that for plain `node`.
import { register } from "node:module";

register("./test-resolve-hooks.mjs", import.meta.url);
