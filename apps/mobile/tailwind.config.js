/** @type {import('tailwindcss').Config} */
// Shared brand tokens (single source: packages/ui-tokens). CJS bridge because
// this config is evaluated by plain Node and cannot load the TS token source.
const uiTokens = require("../../packages/ui-tokens/tailwind-tokens.cjs");

module.exports = {
    content: ["./src/**/*.{js,jsx,ts,tsx}"],
    presets: [require("nativewind/preset")],
    theme: {
        extend: {
            colors: {
                ...uiTokens.colors,
            },
            borderRadius: {
                ...uiTokens.borderRadius,
            },
            fontFamily: {
                sans: ["PolySans-Regular", "sans-serif"],
                "polysans-slim": ["PolySans-Slim"],
                "polysans-regular": ["PolySans-Regular"],
                "polysans-medium": ["PolySans-Medium"],
                "polysans-bold": ["PolySans-Bold"],
                wide: ["PolySans-Wide"],
            },
        },
    },
    plugins: [],
}
