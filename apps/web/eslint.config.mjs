import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// Deliberately CHERRY-PICKED, not preset-based. This config started as a
// hooks-only guard (Next 16 removed `next lint`, and an app-crashing
// Rules-of-Hooks violation shipped undetected) and was later broadened to
// TypeScript bug classes. The philosophy stands: every rule here catches a
// bug class or a genuine smell. We do NOT turn on broad stylistic presets —
// on a codebase this size they bury real signal in noise.
//
// The codebase is clean on all of these (a ~250-finding burn-down was done
// at adoption), so almost everything is an error and gates regressions in
// CI. House idioms: `void` marks intentional fire-and-forget promises,
// `toError`/`errorName` (lib/utils) normalize unknown caught values, and
// fetched JSON is `unknown` until narrowed.
export default tseslint.config(
  {
    // Hooks guard for everything, including any stray js/jsx.
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    // The codebase still carries inline `eslint-disable` comments from the old
    // `next lint` setup (for rules this config doesn't load). Don't treat
    // those now-inert directives as problems.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Crash class: conditional/early-return hook placement.
      "react-hooks/rules-of-hooks": "error",
      // Off on purpose: exhaustive-deps is a warning-grade hint, not a crash
      // class, and would bury the signal we actually care about.
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // Clean today — gate regressions.
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-debugger": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/no-for-in-array": "error",

      // console.info = deliberate operational diagnostics ([Meets] lifecycle
      // logs); console.debug = verbose channels hidden by default in devtools.
      // Bare console.log is the "left over from debugging" tier.
      "no-console": ["error", { allow: ["warn", "error", "info", "debug"] }],
      "prefer-const": ["error", { destructuring: "all" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      // Kept at warn (not error) deliberately — the lint project view and
      // `tsc --noEmit` disagreed on two assertions in this app, so a blanket
      // `--fix` of this rule here must be re-verified with
      // `pnpm run typecheck:web` before committing.
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/unbound-method": ["error", { ignoreStatic: true }],
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },
);
