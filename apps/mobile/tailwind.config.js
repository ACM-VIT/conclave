/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ["./src/**/*.{js,jsx,ts,tsx}"],
    presets: [require("nativewind/preset")],
    theme: {
        extend: {
            fontFamily: {
                sans: ["PolySans-Regular", "sans-serif"],
                "polysans-slim": ["PolySans-Slim"],
                "polysans-regular": ["PolySans-Regular"],
                "polysans-medium": ["PolySans-Medium"],
                "polysans-bold": ["PolySans-Bold"],
                mono: ["PolySans-Mono", "monospace"],
                wide: ["PolySans-Wide"],
            },
        },
    },
    plugins: [],
}
