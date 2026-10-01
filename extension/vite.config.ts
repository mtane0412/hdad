/**
 * Chrome 拡張（extension/）のビルド設定
 *
 * サービスワーカー（src/background.ts）を1つの ES モジュール（background.js）にまとめ、public/manifest.json と並べて
 * 本体の public/tab-extension/ へ出す。本体のビルドがそれを静的アセットとして配り、Worker
 * （GET /api/admin/tab/extension.zip。worker/tab-extension.ts）が読んで、信頼する置き場所を書いた config.json を
 * 加えた zip にして配信者へ返す。
 *
 * 置き場所はビルドに埋め込まない（公開先のアドレスはアカウントごとに違い、ビルドの時点では分からないため。issue #168）。
 * 本体の npm run dev・npm run build の前に、package.json の predev・prebuild がこのビルドを走らせる。
 */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const here = import.meta.dirname

export default defineConfig({
  root: here,
  publicDir: resolve(here, 'public'),
  build: {
    outDir: resolve(here, '../public/tab-extension'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(here, 'src/background.ts'),
      output: { format: 'es', entryFileNames: 'background.js' },
    },
  },
})
