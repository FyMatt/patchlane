/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/webview/**/*.{ts,tsx}"],
  theme: {
    extend: {}
  },
  corePlugins: {
    preflight: false
  },
  plugins: []
};
