import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";

// Deliberately MINIMAL. Next 16 removed `next lint` and this app had no ESLint,
// which is how an app-crashing Rules-of-Hooks violation (a hook placed after an
// early `return`) shipped undetected. This config exists to catch exactly that
// class in CI — nothing more. We do NOT turn on a broad ruleset (the unlinted
// codebase would flood with style noise); only `rules-of-hooks` is an error.
export default [
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    // The codebase still carries inline `eslint-disable` comments from the old
    // `next lint` setup (for rules this minimal config doesn't load). Don't
    // treat those now-inert directives as problems — only real hooks violations
    // should fail this guard.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Off on purpose: exhaustive-deps is a warning-grade hint, not a crash
      // class, and would bury the signal we actually care about.
      "react-hooks/exhaustive-deps": "off",
    },
  },
];
