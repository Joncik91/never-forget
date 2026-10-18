// Minimal declarations for the two host globals this library uses. Both exist
// in every supported runtime (Node >= 18, Deno, Bun, modern browsers). Declared
// here instead of pulling in @types/node so Node-only APIs cannot creep in.
declare function structuredClone<T>(value: T): T;
declare const console: { error(...data: unknown[]): void };
