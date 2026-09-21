/**
 * Viteビルド設定
 *
 * Workers 静的アセットはパスごとに実ファイルが必要なため、トップ（index.html）・
 * 各カテゴリの一覧（wallpaper/index.html, clock/index.html, chat/index.html）・各素材のページ（<カテゴリ>/<id>/index.html）の
 * すべてをエントリとするマルチページ構成でビルドする。
 * アラート用オーバーレイ（alerts/index.html）は一覧を持たない単独のページなので、カテゴリとは別にエントリへ足す。
 * base を相対パスにしているので、リポジトリ名や独自ドメインが変わっても動作する。
 */
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const root = import.meta.dirname
/** カテゴリ名（＝公開ディレクトリ名）。カテゴリを増やしたらここに足す */
const categories = ['wallpaper', 'clock', 'chat']

/** カテゴリの一覧ページ（<カテゴリ>/index.html）と、配下の素材ページ（<カテゴリ>/<id>/index.html）をエントリにする */
const categoryEntries = Object.fromEntries(
  categories.flatMap((category) => {
    const categoryDir = resolve(root, category)
    const pages = readdirSync(categoryDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [`${category}/${entry.name}`, resolve(categoryDir, entry.name, 'index.html')])
    return [[category, resolve(categoryDir, 'index.html')], ...pages]
  }),
)

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        alerts: resolve(root, 'alerts/index.html'),
        ...categoryEntries,
      },
    },
  },
})
