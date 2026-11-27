import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import conclave, { vendoredIgnores } from "../../scripts/quality/comments/eslint-plugin.mjs";

// Server text can carry words people typed; ServerError keeps it out of telemetry.
const callSafetyRestrictions = [
  {
    selector:
      "NewExpression[callee.name='Error']:matches([arguments.0.property.name='error'], [arguments.0.expression.property.name='error'], [arguments.0.left.property.name='error'], [arguments.0.left.expression.property.name='error'])",
    message:
      "Wrap server error text in ServerError (lib/server-error.ts) so telemetry drops it.",
  },
  {
    selector:
      "CallExpression[callee.object.name='console'][callee.property.name='error']:matches([arguments.0.value=/^\\[Meets\\]/], [arguments.0.quasis.0.value.raw=/^\\[Meets\\]/])",
    message:
      "Log call failures with logCallError (lib/call-error-capture.ts) and a label from lib/call-log-labels.ts, so they reach telemetry.",
  },
];

const mediaOwnershipRestrictions = [
  {
    selector:
      "CallExpression[callee.property.name=/^(getUserMedia|getDisplayMedia)$/]",
    message:
      "Capture media with captureUserMedia or captureDisplayMedia from lib/media-captures, so ending the call releases it.",
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(createMediaStreamDestination|captureStream)$/]",
    message:
      "Create derived tracks with createHeldDestination or captureHeldCanvas from lib/media-captures, so ending the call stops them.",
  },
  {
    selector: "NewExpression[callee.name=/^(GeneratorCtor|MediaStreamTrackGenerator)$/]",
    message:
      "Create track generators with createHeldTrackGenerator from lib/media-captures, so ending the call stops them.",
  },
  {
    selector: "CallExpression[callee.property.name='clone'][arguments.length=0]",
    message:
      "Clone media tracks with holdClone from lib/media-captures, so ending the call stops the clone.",
  },
];

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      ".open-next/**",
      ".wrangler/**",
      "out/**",
      "next-env.d.ts",
      ...vendoredIgnores("apps/web/"),
    ],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { conclave },
    rules: { "conclave/no-comments": "error" },
  },
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
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
      "react-hooks/rules-of-hooks": "error",
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
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-debugger": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/no-for-in-array": "error",

      "no-console": ["error", { allow: ["warn", "error", "info", "debug"] }],
      "no-restricted-syntax": ["error", ...callSafetyRestrictions],
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
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/app/lib/media-captures.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...callSafetyRestrictions, ...mediaOwnershipRestrictions],
    },
  },
  {
    files: ["src/**/*.{js,jsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...mediaOwnershipRestrictions],
    },
  },
);
