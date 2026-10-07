// Minimal ambient declarations for the Edge runtime, so the shared Edge
// Function modules can be type-checked by the repo's `tsc --noEmit`.
//
// WHY THIS FILE EXISTS
//
// The Edge runtime is Deno. The repo's typecheck is Node/Expo. Without these
// declarations, every module under supabase/functions/ that touches `Deno` or
// imports from a `jsr:` specifier cannot be included in tsconfig at all — and a
// file that cannot be included is a file that never gets type-checked. That is
// exactly the failure Phase 12 hit: the CSV modules shipped unchecked and the
// deploy failed with BOOT_ERROR while `tsc --noEmit` reported success.
//
// So these declarations are deliberately NARROW. They cover only the surface this
// repo actually uses. They are not a Deno emulator: if a future module reaches
// for a runtime API not declared here, the honest outcome is a type error asking
// for a declaration, not a silent gap.
//
// tests/typecheck-coverage.test.ts asserts that every .ts/.tsx file under
// supabase/functions/ is covered by tsconfig's include list, so narrowing this
// file's surface is safe: an undeclared API fails loudly.

declare namespace Deno {
  /** Only `env.get` is used. Nothing in this repo reads or writes any other env API. */
  const env: {
    get(key: string): string | undefined;
  };

  /** Only used by the Edge Function entry points, which are not type-checked. */
  function serve(handler: (request: Request) => Response | Promise<Response>): void;
}

/**
 * The Supabase client type, imported across the shared modules under a `jsr:`
 * specifier that only resolves inside Deno.
 *
 * tsconfig maps `jsr:@supabase/supabase-js@2` onto the copy in node_modules, so
 * the real published types are used rather than a hand-written approximation.
 */
declare module "jsr:@supabase/supabase-js@2" {
  export * from "@supabase/supabase-js";
}
