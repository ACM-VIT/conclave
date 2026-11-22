import tseslint from "typescript-eslint";
import conclave from "./scripts/quality/comments/eslint-plugin.mjs";

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
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.build/**",
      "artifacts/**",
      "coverage/**",
      "apps/*",
      "!apps/conclave-skip/",
      "apps/conclave-skip/*",
      "!apps/conclave-skip/Tests/",
      "apps/conclave-skip/Tests/*",
      "!apps/conclave-skip/Tests/Rig/",
    ],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { conclave },
    rules: { "conclave/no-comments": "error" },
  },
  {
    files: [
      "packages/sfu/**/*.{ts,tsx}",
      "packages/ai/**/*.ts",
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
    files: ["packages/ui-tokens/src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: baseRules,
  },
);
