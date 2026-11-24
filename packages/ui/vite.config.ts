import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const home = `http://127.0.0.1:${process.env.ISOCLINE_PORT ?? 7480}`;
const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The microphone's audio worklet stays a file of its own: inlined as a data: URL, the page's
    // Content-Security-Policy (default-src 'self') refuses to load it, and no recording can start.
    assetsInlineLimit: (file) => (file.endsWith("capture-worklet.js") ? false : undefined),
    // The main interface, and the Mac app's always-on-top figure.
    rollupOptions: { input: { main: page("index.html"), presence: page("presence.html") } },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The home node accepts only its own Host and Origin; present the proxy as same-origin.
      "/api": {
        target: home,
        changeOrigin: true,
        configure: (proxy) => proxy.on("proxyReq", (request) => request.removeHeader("origin")),
      },
    },
  },
});
