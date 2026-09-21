# プロジェクト固有設定

Twitch配信用素材のリポジトリ。Vite（マルチページ）+ TypeScript + Canvas 2D。ページUIは React + Tailwind + shadcn/ui へ移行中。Cloudflare Workers の静的アセットで公開する。

## 品質チェックコマンド

```bash
npm run lint        # ESLint（警告ゼロ必須）
npm run type-check  # tsc --noEmit
npm test            # Vitest
npm run build       # Viteビルド（dist/）
```

## 構成上の約束

- 素材はカテゴリごとに公開ディレクトリ（`wallpaper/` など）とソース（`src/<カテゴリ>/`）を分ける。`src/core/` はカテゴリ横断の共通部品（ギャラリーは `src/core/gallery/`、素材ページの起動は `src/core/mount.ts`）。トップ `index.html` はReactのアプリ（`src/app/`）で、Twitchログインを前提にサイドバー付きのダッシュボードを出す
- ページUIは shadcn/ui（`src/components/ui/`。`npx shadcn@latest add <名前>` で足す。土台は Base UI なので、要素の差し替えは `asChild` ではなく `render`）で統一する。`@/` は `src/` を指す。明暗はOSの設定に従う（`src/app/app.css`）。リンクをボタンの見た目にするときは `Button` ではなく `<a className={buttonVariants()}>` を使う（`Button` は `role="button"` を付けてしまう）。ログインの確認は `src/app/app.tsx` が `/api/me` で行い、失敗したら未ログイン扱いにせずエラーを出す。コンポーネントのテストは `// @vitest-environment jsdom` を付けて Testing Library で書く。OBSに載せる素材ページ（`<カテゴリ>/<id>/`・`alerts/`）には React もログインも持ち込まない
- 移行前のページUI（ギャラリー・管理画面）の色・書体・トップバー・ボタン・入力欄は `src/core/ui/ui.css` にまとめ、各ページのCSS（`src/core/gallery/gallery.css`・`src/admin/admin.css`）より先に読み込む。色は変数で持ち、明暗はOSの設定に従う。配信に載る素材側のCSS（`src/core/stage.css`・`src/chat/*.css`・`src/alerts/alerts.css`）からは読み込まない。トップバーは各ページのHTMLに同じものを書いているので、カテゴリを増やしたら全ページのトップバーにも足す
- Workers 静的アセットはパスごとに実ファイルが必要なため、壁紙の背景は `wallpaper/<id>/index.html` と `src/wallpaper/registry.ts` の両方に登録する。時計も同様に `clock/<id>/index.html` と `src/clock/registry.ts` の両方に登録する。カテゴリを増やしたら `vite.config.ts` の `categories` にも足す
- URLパラメータは `src/core/params.ts` のスキーマで宣言する。不正値は既定値に戻さずエラー表示する（Fail-Fast）
- チャットボックス（`chat/`）だけは canvas ではなくHTML要素で表示し、届いた書き込みという状態を持つ。デザインは `chat/<id>/index.html`・`src/chat/registry.ts`・`src/chat/<id>.css` の3か所に登録する。通信を伴わない変換（`irc.ts`・`event.ts`・`message.ts`・`emotes.ts`）と、DOM・WebSocketを扱う部分（`view.ts`・`connection.ts`・`stage.ts`）を分け、前者をテストする
- アラート用オーバーレイ（`alerts/`）は一覧を持たない単独のページで、`vite.config.ts` の `categories` ではなく入力に直接足している。`chat/` と同じく状態（再生待ちの列）を持ち、通信を伴わない変換（`eventsub.ts`・`trigger.ts`・`queue.ts`）と、DOM・WebSocketを扱う部分（`view.ts`・`connection.ts`・`stage.ts`）を分け、前者をテストする。Workerへの購読の依頼（`subscribe.ts`）は `fetch` を差し替えてテストする。トリガーの設定はWorker（`/api/overlay/config`）から通知のたびに取得する（`config.ts`。`fetch` を差し替えてテストする）。`?demo=true` のサンプルは `demo.ts`
- 管理画面（`admin/`）も一覧を持たない単独のページで、`alerts/` と同じく `vite.config.ts` の入力に直接足している。Workerの呼び出し（`api.ts`。`fetch` を差し替えてテストする。`worker/` の型は読み込めないので、応答の型をここで定義して形を確かめる）と入力欄の値の変換（`form.ts`）をテストし、DOMを扱う部分（`view.ts`・`stage.ts`）と分ける。`/api/*` を使うので `npm run dev` では動かず、`npm run preview:worker` で確かめる
- `worker/` は `/api/*` を処理するWorkerのコード（Twitchログイン、トークンの保管と更新、EventSub購読の代行、アラートの設定と素材）。ブラウザ用の `src/` からは読み込まない。経路の一覧は `worker/index.ts`、経路の処理は `auth-routes.ts`・`admin-routes.ts`・`overlay-routes.ts`。管理用API（`/api/admin/*`）は `requireAdmin`（セッション＋Origin確認）、オーバーレイ用APIは `requireOverlayKey` で守る。Twitchのトークンは応答に含めず、保存先はKV（`STORE`）、素材はR2（`MEDIA`）。`fetch`・現在時刻・KV・R2は引数で受け取り、テストでは差し替える（代役は `worker/fake-store.ts`・`worker/fake-bucket.ts`）。失敗は `{ error: { code, message } }` で返す（Fail-Fast）
- 描画は経過時間だけから決まる形にする（フレーム間の状態を持たない）。時計は経過時間の代わりに `frame.now`（現在時刻）だけから決める
