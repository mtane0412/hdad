/**
 * Viteビルド設定
 *
 * ページUI（ダッシュボード・ギャラリー・管理画面）はトップの index.html ひとつで、パスに応じた中身をアプリ（src/app/）が描く。
 * /wallpaper/ のように実ファイルのないパスには、Workers 静的アセットが index.html を返す（wrangler.jsonc の not_found_handling）。
 * OBSに載せる素材のページ（<カテゴリ>/<id>/index.html）とアラート用オーバーレイ（alerts/index.html）は、パスごとに実ファイルが必要なので、
 * すべてをエントリとするマルチページ構成でビルドする。
 * index.html は /wallpaper/ などネストしたパスでも返されるので、base は絶対パス（/）にしてアセットをどのパスからでも解決できるようにする。
 *
 * @cloudflare/vite-plugin が `npm run dev` の中で Worker（worker/index.ts）を動かすので、開発サーバーでも /api/* とログインが使える。
 * ビルドの出力は dist/client/（静的アセット）と dist/hdad/（Workerとデプロイ用の wrangler.json）に分かれ、
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

/** カテゴリ配下の素材ページ（<カテゴリ>/<id>/index.html）をエントリにする */
const categoryEntries = Object.fromEntries(
  categories.flatMap((category) => {
    const categoryDir = resolve(root, category)
    return readdirSync(categoryDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [`${category}/${entry.name}`, resolve(categoryDir, entry.name, 'index.html')])
  }),
)

export default defineConfig({
  base: '/',
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
            transcript: resolve(root, 'transcript/index.html'),
            ...categoryEntries,
          },
        },
      },
    },
  },
})
