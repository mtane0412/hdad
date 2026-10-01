/**
 * Chrome 拡張（extension/）のビルド設定
 *
 * サービスワーカー（src/background.ts）を1つの ES モジュール（dist/background.js）にまとめ、public/manifest.json を
 * dist/ へ写す。読み込むのは extension/dist/ で、Chrome の「パッケージ化されていない拡張機能を読み込む」で選ぶ
 * （docs/guide/tab.md）。HDAD 本体（vite.config.ts）とは別に `npm run build:extension` でビルドする。
 *
 * 信頼する HDAD の置き場所は、環境変数 HDAD_ORIGINS で渡してもらい、確かめたうえで __HDAD_ORIGINS__ として埋め込む
 * （src/origins.ts）。指定が無ければビルドを失敗させる。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { ORIGINS_ENV, parseTrustedOrigins } from './src/origins'

const here = import.meta.dirname

export default defineConfig({
  root: here,
  define: { __HDAD_ORIGINS__: JSON.stringify(parseTrustedOrigins(process.env[ORIGINS_ENV])) },
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
