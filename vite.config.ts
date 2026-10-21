import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

// 静的ファイルだけで動くアプリ。base を相対にして GitHub Pages 等のサブパスでも動くようにする
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    {
      // 以前の版のアプリは apps-script.gs を読みに来るので、同じ中身を旧名でも置いておく
      name: "apps-script-legacy-name",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "apps-script.gs", source: readFileSync("public/apps-script.txt", "utf8") });
      },
    },
  ],
  build: { outDir: "dist", emptyOutDir: true },
});
