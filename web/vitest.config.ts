import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";

export default defineConfig({
  // Mirror the build's Lingui macro transform (see vite.config.ts) so that
  // components importing @lingui/*/macro compile in tests instead of falling
  // through to babel-plugin-macros (which isn't installed).
  plugins: [react({ plugins: [["@lingui/swc-plugin", {}]] })],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
