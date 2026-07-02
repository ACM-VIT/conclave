import tseslint from "typescript-eslint";

// Lint policy for the TypeScript workspace packages (apps/web has its own
// config with the same philosophy). Deliberately cherry-picked: every rule
// here catches a bug class or a genuine smell — no broad stylistic presets,
// which would flood a codebase this size with noise.
//
// Everything is an error: the packages are clean on all of these, so they
// gate regressions in CI. Untrusted network input (express req.body, socket
// payloads, fetched JSON) is narrowed once at the boundary via
// packages/sfu/utilities/untrusted.ts instead of flowing through as `any`.

// Syntax-level rules — no type information needed.
const baseRules = {
  eqeqeq: ["error", "smart"],
  "no-var": "error",
  "prefer-const": ["error", { destructuring: "all" }],
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-debugger": "error",
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/ban-ts-comment": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      ignoreRestSiblings: true,
    },
  ],
};

// Type-aware rules — the async bug classes tsc and grep cannot see. A dropped
// promise in the SFU is a silent failure or an unhandled rejection in prod.
const typedRules = {
  "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
  "@typescript-eslint/no-misused-promises": [
    "error",
    { checksVoidReturn: { attributes: false } },
  ],
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/only-throw-error": "error",
  "@typescript-eslint/prefer-promise-reject-errors": "error",
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/no-for-in-array": "error",
  "@typescript-eslint/switch-exhaustiveness-check": "error",
  "@typescript-eslint/unbound-method": ["error", { ignoreStatic: true }],
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-argument": "error",
  "@typescript-eslint/no-unsafe-return": "error",
};

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "apps/**"],
  },
  {
    // Packages with a tsconfig — full type-aware linting.
    files: [
      "packages/sfu/**/*.{ts,tsx}",
      "packages/meeting-core/src/**/*.ts",
      "packages/meeting-core/test/**/*.ts",
      "packages/apps-sdk/src/**/*.{ts,tsx}",
      "packages/shared-browser/src/**/*.ts",
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: { ...baseRules, ...typedRules },
  },
  {
    // ui-tokens has no tsconfig (source-consumed tokens + primitives):
    // syntax-level rules only.
    files: ["packages/ui-tokens/src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: baseRules,
  },
);
