/**
 * Viteビルド設定
 *
 * Workers 静的アセットはパスごとに実ファイルが必要なため、トップ（index.html）・
 * 各カテゴリの一覧（wallpaper/index.html, clock/index.html, chat/index.html）・各素材のページ（<カテゴリ>/<id>/index.html）の
 * すべてをエントリとするマルチページ構成でビルドする。
 * アラート用オーバーレイ（alerts/index.html）と管理画面（admin/index.html）は一覧を持たない単独のページなので、カテゴリとは別にエントリへ足す。
 * base を相対パスにしているので、リポジトリ名や独自ドメインが変わっても動作する。
 *
 * @cloudflare/vite-plugin が `npm run dev` の中で Worker（worker/index.ts）を動かすので、開発サーバーでも /api/* とログインが使える。
 * ビルドの出力は dist/client/（静的アセット）と dist/stream_assets/（Workerとデプロイ用の wrangler.json）に分かれ、
 * `wrangler deploy` は .wrangler/deploy/config.json を通じて後者の設定を使う。
 */
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
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
  // Vitest もこの設定を読むが、テストでは Worker を動かさないので cloudflare() を外す
  plugins: [react(), tailwindcss(), ...(process.env.VITEST ? [] : [cloudflare()])],
  resolve: { alias: { '@': resolve(root, 'src') } },
  // ページの入力はブラウザ用（client）の環境だけに指定する。トップレベルに書くと Worker 用の環境にも適用されてビルドが失敗する
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            index: resolve(root, 'index.html'),
            alerts: resolve(root, 'alerts/index.html'),
            admin: resolve(root, 'admin/index.html'),
            ...categoryEntries,
          },
        },
      },
    },
  },
})
