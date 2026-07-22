// Stand-in for the real "server-only" package under plain `node --test`.
// The real package's index.js unconditionally throws (it's designed to be
// intercepted by Next.js's webpack config, which swaps it for a no-op on
// the server build and a throwing stub only for an accidental client
// bundle) — neither of those build-time mechanisms exist under plain node,
// so importing it directly would always throw. See test-resolve-hooks.mjs,
// which redirects the bare "server-only" specifier here instead.
export {};
