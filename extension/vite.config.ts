/**
 * Chrome 拡張（extension/）のビルド設定
 *
 * サービスワーカー（src/background.ts）を1つの ES モジュール（dist/background.js）にまとめ、public/manifest.json を
 * dist/ へ写す。読み込むのは extension/dist/ で、Chrome の「パッケージ化されていない拡張機能を読み込む」で選ぶ
 * （docs/guide/tab.md）。HDAD 本体（vite.config.ts）とは別に `npm run build:extension` でビルドする。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const here = import.meta.dirname

export default defineConfig({
  root: here,
  publicDir: resolve(here, 'public'),
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(here, 'src/background.ts'),
      output: { format: 'es', entryFileNames: 'background.js' },
    },
  },
})
