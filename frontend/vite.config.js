import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
function normalizeBasePath(value) {
    var trimmed = (value || "").trim();
    if (!trimmed || trimmed === "/")
        return "/";
    return "/".concat(trimmed.replace(/^\/+|\/+$/g, ""), "/");
}
export default defineConfig(function (_a) {
    var mode = _a.mode;
    var env = loadEnv(mode, ".", "");
    var basePath = normalizeBasePath(env.VITE_NEWHORIZONS_BASE_PATH || "/newhorizons/");
    return {
        base: basePath,
        plugins: [react()],
        build: {
            outDir: "dist",
            emptyOutDir: true,
        },
    };
});
