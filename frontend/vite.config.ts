import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

function normalizeBasePath(value: string) {
  const trimmed = (value || "").trim();
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}/`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const basePath = normalizeBasePath(env.VITE_NEWHORIZONS_BASE_PATH || "/newhorizons/");
  return {
    base: basePath,
    plugins: [react()],
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
