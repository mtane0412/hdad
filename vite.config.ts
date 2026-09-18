/**
 * Viteビルド設定
 *
 * GitHub Pagesはパスごとに実ファイルが必要なため、トップ（index.html）・
 * 壁紙ギャラリー（wallpaper/index.html）・wallpaper/<id>/index.html のすべてを
 * エントリとするマルチページ構成でビルドする。
 * base を相対パスにしているので、リポジトリ名や独自ドメインが変わっても動作する。
 */
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname
const wallpaperDir = resolve(root, 'wallpaper')

const wallpaperEntries = Object.fromEntries(
  readdirSync(wallpaperDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [`wallpaper/${entry.name}`, resolve(wallpaperDir, entry.name, 'index.html')]),
)

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        wallpaper: resolve(wallpaperDir, 'index.html'),
        ...wallpaperEntries,
      },
    },
  },
})
