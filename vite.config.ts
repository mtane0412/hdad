/**
 * Viteビルド設定
 *
 * ページUI（ダッシュボード・管理画面）はトップの index.html ひとつで、パスに応じた中身をアプリ（src/app/）が描く。
 * /overlay/ のように実ファイルのないパスには、Workers 静的アセットが index.html を返す（wrangler.jsonc の not_found_handling）。
 * OBSに載せるページ（素材を重ねる合成ページ overlay/stage/index.html、映すものを持たない裏方をまとめた
 * overlay/backstage/index.html と、その裏方それぞれ speech/reader/index.html）は、
 * パスごとに実ファイルが必要なので、すべてをエントリとするマルチページ構成でビルドする。
 * index.html は /overlay/ などネストしたパスでも返されるので、base は絶対パス（/）にしてアセットをどのパスからでも解決できるようにする。
 *
 * @cloudflare/vite-plugin が `npm run dev` の中で Worker（worker/index.ts）を動かすので、開発サーバーでも /api/* とログインが使える。
 * ビルドの出力は dist/client/（静的アセット）と dist/hdad/（Workerとデプロイ用の wrangler.json）に分かれ、
 * `wrangler deploy` は .wrangler/deploy/config.json を通じて後者の設定を使う。
 */
import { resolve } from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = import.meta.dirname

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
            'speech/reader': resolve(root, 'speech/reader/index.html'),
            'overlay/stage': resolve(root, 'overlay/stage/index.html'),
            'overlay/backstage': resolve(root, 'overlay/backstage/index.html'),
          },
        },
      },
    },
  },
})
