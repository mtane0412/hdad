/**
 * Viteビルド設定
 *
 * GitHub Pagesはパスごとに実ファイルが必要なため、ギャラリー（index.html）と
 * backgrounds/<id>/index.html のすべてをエントリとするマルチページ構成でビルドする。
 * base を相対パスにしているので、リポジトリ名や独自ドメインが変わっても動作する。
 */
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname
const backgroundsDir = resolve(root, 'backgrounds')

const backgroundEntries = Object.fromEntries(
  readdirSync(backgroundsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [`backgrounds/${entry.name}`, resolve(backgroundsDir, entry.name, 'index.html')]),
)

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: { index: resolve(root, 'index.html'), ...backgroundEntries },
    },
  },
})
