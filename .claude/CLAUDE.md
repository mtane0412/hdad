# プロジェクト固有設定

Twitch配信用素材のリポジトリ。Vite（マルチページ）+ TypeScript + Canvas 2D。ページUIは React + Tailwind + shadcn/ui へ移行中。Cloudflare Workers の静的アセットで公開する。

## 品質チェックコマンド

```bash
npm run lint        # ESLint（警告ゼロ必須）
npm run type-check  # tsc --noEmit
npm test            # Vitest
npm run dev         # 開発サーバー（@cloudflare/vite-plugin がWorkerも動かすので /api/* とログインが使える）
npm run build       # Viteビルド（dist/client/ と dist/stream_assets/）
```

## 構成上の約束

- 素材はカテゴリごとに公開ディレクトリ（`wallpaper/` など）とソース（`src/<カテゴリ>/`）を分ける。`src/core/` はカテゴリ横断の共通部品（ギャラリーは `src/core/gallery/`、素材ページの起動は `src/core/mount.ts`、Workerの呼び出しの共通部分は `src/core/api.ts`）。ページUI（ダッシュボード・ギャラリー・管理画面）はトップ `index.html` ひとつのReactアプリ（`src/app/`）で、Twitchログインを前提にサイドバー付きの画面を出す。`/wallpaper/` など実ファイルのないパスには Workers が `index.html` を返し（`wrangler.jsonc` の `not_found_handling`）、アプリがパスに応じた中身を描く。そのため `vite.config.ts` の `base` は `/`
- アプリのページは `src/app/pages.tsx` に登録する（サイドバーの項目・見出し・中身がここから決まる）。ページの移動は `src/app/router.tsx`（History API。ライブラリなし）の `Link` を使い、アプリの外（素材ページ・`/api/*`）は普通の `<a>` で開く。登録のないパスは「見つからない」画面を出す
- ページUIは shadcn/ui（`src/components/ui/`。`npx shadcn@latest add <名前>` で足す。土台は Base UI なので、要素の差し替えは `asChild` ではなく `render`）で統一する。`@/` は `src/` を指す。明暗はOSの設定に従う（`src/app/app.css`）。リンクをボタンの見た目にするときは `Button` ではなく `<a className={buttonVariants()}>` を使う（`Button` は `role="button"` を付けてしまう）。ログインの確認は `src/app/app.tsx` が `/api/me` で行い、失敗したら未ログイン扱いにせずエラーを出す。コンポーネントのテストは `// @vitest-environment jsdom` を付けて Testing Library で書く（jsdom では Base UI の `Slider` のつまみが隠れたままなので、外枠の `role="group"` の名前から探す。`<output>` は `role="status"` を持つ）。OBSに載せる素材ページ（`<カテゴリ>/<id>/`・`alerts/`）には React もログインも持ち込まない
- Workers 静的アセットはパスごとに実ファイルが必要なため、OBSに載せる素材ページはパスごとに用意する。壁紙の背景は `wallpaper/<id>/index.html` と `src/wallpaper/registry.ts` の両方に登録する。時計も同様に `clock/<id>/index.html` と `src/clock/registry.ts` の両方に登録する。カテゴリを増やしたら `vite.config.ts` の `categories` と `src/app/pages.tsx` にも足す
- URLパラメータは `src/core/params.ts` のスキーマで宣言する。不正値は既定値に戻さずエラー表示する（Fail-Fast）
- チャットボックス（`chat/`）だけは canvas ではなくHTML要素で表示し、届いた書き込みという状態を持つ。デザインは `chat/<id>/index.html`・`src/chat/registry.ts`・`src/chat/<id>.css` の3か所に登録する。各デザインのCSSは先頭で `src/chat/common.css` を `@import` する（返信元・時刻・初見／おかえり・サブスク継続月数・ビッツ・Cheermote など、デザインによらず同じ役割で添える小さな要素の見た目をそこに置く）。通信を伴わない変換（`irc.ts`・`event.ts`・`message.ts`・`emotes.ts`・`cheermotes.ts`）と、DOM・WebSocketを扱う部分（`view.ts`・`connection.ts`・`stage.ts`）を分け、前者をテストする。`view.ts` だけは組み立てるHTML構造が増えたため、`// @vitest-environment jsdom` を付けて要素・クラス・属性を確かめる（jsdom には `Element.animate` が無いので差し替える）。チャットは匿名IRC（`justinfan`）でつなぐためトークンを持たず、トークンが要る公式バッジ画像と Cheermote だけを Worker の公開API（`/api/chat/*`）から取る（`badges.ts`・`cheermotes.ts`）。取得に失敗しても表示は止めず、`addNotice` で画面に知らせる
- アラート用オーバーレイ（`alerts/`）は一覧を持たない単独のページで、`vite.config.ts` の `categories` ではなく入力に直接足している。`chat/` と同じく状態（再生待ちの列）を持ち、通信を伴わない変換（`eventsub.ts`・`trigger.ts`・`queue.ts`）と、DOM・WebSocketを扱う部分（`view.ts`・`connection.ts`・`stage.ts`）を分け、前者をテストする。Workerへの購読の依頼（`subscribe.ts`）は `fetch` を差し替えてテストする。トリガーの設定はWorker（`/api/overlay/config`）から通知のたびに取得する（`config.ts`。`fetch` を差し替えてテストする）。`?demo=true` のサンプルは `demo.ts`
- ダッシュボード（`/`）はアプリのページ（`src/stats/stats-page.tsx`）。Workerが貯めた配信の記録（`/api/admin/stats/*`）を読み、期間（7・30・90日）の概要・フォロワー数の推移・配信の一覧を出す。配信を選ぶとその配信の視聴者数の推移を読み込んで一覧の中に出す。Workerの呼び出し（`src/stats/api.ts`）と集計・整形（`src/stats/summary.ts`）は画面から分けてテストする。グラフは shadcn の `chart`（Recharts）で、色は明暗のどちらでも読める `--chart-2` を使う。日時はブラウザのタイムゾーンで出し、記録が無い値は「—」と書いて0と区別する
- 管理画面（`/admin/`）はアプリのページ（`src/admin/admin-page.tsx`）。ログインの確認とログアウトはアプリの枠が受け持ち、オーバーレイ用キーは枠から受け取る（再発行したら枠へ知らせる）。Workerの呼び出し（`api.ts`。呼び出しと失敗の扱いは `src/core/api.ts` に任せ、`fetch` を差し替えてテストする。`worker/` の型は読み込めないので、応答の型をここで定義して形を確かめる）と入力欄の値の変換（`form.ts`）は画面から分けてテストする。確認は `window.confirm` ではなく `AlertDialog` で行う。`/api/*` は `npm run dev` の中でも動く
- `worker/` は `/api/*` を処理するWorkerのコード（Twitchログイン、トークンの保管と更新、EventSub購読の代行、アラートの設定と素材）。ブラウザ用の `src/` からは読み込まない。経路の一覧は `worker/index.ts`、経路の処理は `auth-routes.ts`・`admin-routes.ts`・`overlay-routes.ts`・`stats-routes.ts`・`webhook-routes.ts`・`chat-routes.ts`。管理用API（`/api/admin/*`）は `requireAdmin`（セッション＋Origin確認）、オーバーレイ用APIは `requireOverlayKey` で守る。チャット用API（`/api/chat/*`）だけは守らない（バッジ画像と Cheermote はTwitchでも誰でも読める公開情報で、スコープも要らない。チャットボックスのURLに合言葉を埋めずに済ませるため）。代わりに取得した内容をKVに1時間貯め、キーの無い経路がTwitchへの問い合わせを増やさないようにする。Twitchのトークンは応答に含めず、保存先はKV（`STORE`）、素材はR2（`MEDIA`）、配信の記録はD1（`DB`。テーブルは `migrations/`、SQLは `stats-store.ts` に集め、必ずプレースホルダを使う）。配信の記録は cron（`worker/index.ts` の `scheduled` → `collect.ts`）が5分おきに集め、失敗は `collection_failures` に記録してから投げる。イベントの件数と配信の開始・終了は、Twitchから直接届くWebhook（`webhook-routes.ts` の `POST /api/eventsub/webhook`。署名を `EVENTSUB_SECRET` で確かめる）で記録し、その購読はログイン時にアプリアクセストークンで揃える（`eventsub-webhook.ts`。失敗してもログインは止めず `collection_failures` に記録する）。`fetch`・現在時刻・KV・R2・D1は引数で受け取り、テストでは差し替える（代役は `worker/fake-store.ts`・`worker/fake-bucket.ts`・`worker/fake-database.ts`。最後のものは `node:sqlite` に `migrations/` を適用する）。失敗は `{ error: { code, message } }` で返す（Fail-Fast）
- 描画は経過時間だけから決まる形にする（フレーム間の状態を持たない）。時計は経過時間の代わりに `frame.now`（現在時刻）だけから決める
