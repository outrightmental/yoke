// esbuild bundles the stylesheet `main.ts` imports for its side effect; this
// tells the type-checker that such an import is a module at all.
declare module '*.css';
