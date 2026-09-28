# プロジェクト固有設定

HDAD（Hyperfocus-Driven Assistant Director）。Twitch配信用素材と配信のアシスタント（チャットボット・アラート）のリポジトリ。Vite（マルチページ）+ TypeScript + Canvas 2D。ページUIは React + Tailwind + shadcn/ui へ移行中。Cloudflare Workers の静的アセットで公開する。

## 品質チェックコマンド

```bash
npm run lint        # ESLint（警告ゼロ必須）
npm run type-check  # tsc --noEmit
npm test            # Vitest
npm run dev         # 開発サーバー（@cloudflare/vite-plugin がWorkerも動かすので /api/* とログインが使える）
npm run build       # Viteビルド（dist/client/ と dist/hdad/）
```

## 構成上の約束

- 素材はカテゴリごとに公開ディレクトリ（`wallpaper/` など）とソース（`src/<カテゴリ>/`）を分ける。`src/core/` はカテゴリ横断の共通部品（ギャラリーは `src/core/gallery/`、素材ページの起動は `src/core/mount.ts`、Workerの呼び出しの共通部分は `src/core/api.ts`）。ページUI（ダッシュボード・ギャラリー・管理画面）はトップ `index.html` ひとつのReactアプリ（`src/app/`）で、Twitchログインを前提にサイドバー付きの画面を出す。`/wallpaper/` など実ファイルのないパスには Workers が `index.html` を返し（`wrangler.jsonc` の `not_found_handling`）、アプリがパスに応じた中身を描く。そのため `vite.config.ts` の `base` は `/`
- アプリのページは `src/app/pages.tsx` に登録する（サイドバーの項目・見出し・中身がここから決まる）。ページの移動は `src/app/router.tsx`（History API。ライブラリなし）の `Link` を使い、アプリの外（素材ページ・`/api/*`）は普通の `<a>` で開く。登録のないパスは「見つからない」画面を出す
- ページUIは shadcn/ui（`src/components/ui/`。`npx shadcn@latest add <名前>` で足す。土台は Base UI なので、要素の差し替えは `asChild` ではなく `render`）で統一する。`@/` は `src/` を指す。明暗はOSの設定に従う（`src/app/app.css`）。リンクをボタンの見た目にするときは `Button` ではなく `<a className={buttonVariants()}>` を使う（`Button` は `role="button"` を付けてしまう）。ログインの確認は `src/app/app.tsx` が `/api/me` で行い、失敗したら未ログイン扱いにせずエラーを出す。コンポーネントのテストは `// @vitest-environment jsdom` を付けて Testing Library で書く（jsdom では Base UI の `Slider` のつまみが隠れたままなので、外枠の `role="group"` の名前から探す。`<output>` は `role="status"` を持つ）。OBSに載せる素材ページ（`<カテゴリ>/<id>/`・`alerts/`）には React もログインも持ち込まない
- Workers 静的アセットはパスごとに実ファイルが必要なため、OBSに載せる素材ページはパスごとに用意する。壁紙の背景は `wallpaper/<id>/index.html` と `src/wallpaper/registry.ts` の両方に登録する。時計も同様に `clock/<id>/index.html` と `src/clock/registry.ts` の両方に登録する。カテゴリを増やしたら `vite.config.ts` の `categories` と `src/app/pages.tsx` にも足す
- URLパラメータは `src/core/params.ts` のスキーマで宣言する。不正値は既定値に戻さずエラー表示する（Fail-Fast）
- Workerの型チェックは `tsconfig.worker.json` に分けてある（Cloudflareのランタイムの型（`@cloudflare/workers-types`）はDOMの型と同時に読めないため）。`npm run type-check` は `tsconfig.json`（`src/`）と合わせて両方を走らせる
- フォークした人向けの Deploy to Cloudflare ボタン（`docs/guide/deploy.md`）は、`wrangler.jsonc` のバインディングと `.dev.vars.example` のシークレットを読み、`package.json` の `cloudflare.bindings` の説明を入力欄に添える。リソースやシークレットを足したら `cloudflare.bindings` にも説明を足す（対応は `src/core/deploy-config.test.ts` が検証する）。デプロイのコマンドは `npm run deploy` で、ビルドは含めない（ボタンと Workers Builds が `npm run build` を別に実行するため）
- 描画は経過時間だけから決まる形にする（フレーム間の状態を持たない）。時計は経過時間の代わりに `frame.now`（現在時刻）だけから決める

## 話題ごとの約束（`.claude/rules/`）

画面・素材ごとの約束は `.claude/rules/` に分け、`paths` で指した場所を触るときだけ読み込む。**そこに無い話題をここに書き足さない。**

| ファイル | 話題 | 読み込まれる場所 |
|---|---|---|
| `chat.md` | チャットボックス（`chat/`） | `src/chat/**`・`chat/**` |
| `alerts.md` | アラート（`alerts/`・トリガー・動作・広告） | `src/alerts/**`・`alerts/**`・`worker/alert-*.ts`・`worker/trigger-menu.ts`・`worker/ad-break-timer.ts`・`worker/ai-chat.ts`・`worker/bot-chat.ts`・`worker/webhook-routes.ts` |
| `transcript.md` | 配信中の文字起こし（`/transcript/`） | `src/transcript/**`・`transcript/**`・`worker/transcript-store.ts` |
| `stream-summary.md` | これまでのあらすじ（`{summary}`） | `worker/stream-summary*.ts`・`worker/collect.ts`・`worker/chat-command.ts`・`worker/alert-event.ts`・`worker/webhook-routes.ts` |
| `viewers.md` | 視聴者の記録（`/viewers/`） | `src/viewers/**`・`worker/viewer-*.ts`・`worker/stream-chat-store.ts`・`worker/webhook-routes.ts`・`worker/collect.ts`・`worker/ai-chat.ts`・`migrations/*viewer*.sql` |
| `side-super.md` | サイドスーパー（`/side-super/`） | `src/side-super/**`・`side-super/**`・`worker/side-super*.ts`・`worker/collect.ts`・`worker/overlay-routes.ts` |
| `focus.md` | 注目コメント（`/focus/`） | `src/focus/**`・`focus/**`・`worker/focus-*.ts` |
| `overlay.md` | 合成ページと構成の管理画面（`overlay/stage/`・`/overlay/`） | `src/overlay/**`・`overlay/**`・`worker/overlay-*.ts` |
| `speech.md` | チャットの読み上げ（`speech/reader/`） | `src/speech/**`・`speech/**`・`worker/speech-config.ts` |
| `backstage.md` | 裏方をまとめたページ（`overlay/backstage/`） | `src/backstage/**`・`overlay/backstage/**` |
| `llm.md` | LLMの呼び先・使用状況・モデルの選択 | `src/llm/**`・`worker/llm*.ts`・`worker/ai-chat.ts`・`worker/side-super.ts`・`worker/viewer-summary.ts`・`worker/stream-summary.ts` |
| `dashboard.md` | ダッシュボード（`/`） | `src/stats/**`・`worker/stats-*.ts` |
| `triggers-page.md` | トリガーの管理画面（`/triggers/`） | `src/admin/**` |
| `bot.md` | チャットボット（`/bot/`） | `src/bot/**`・`worker/auth-routes.ts`・`worker/token.ts`・`worker/webhook-routes.ts`・`worker/bot-*.ts`・`worker/chat-*.ts`・`worker/moderation-config.ts`・`worker/eventsub*.ts` |
| `worker.md` | Worker（`worker/`）と失敗の記録 | `worker/**` |

## 設計判断の記録（`docs/decisions/`）

`.claude/CLAUDE.md` と `.claude/rules/` には**いま守るべき約束**だけを書く。「なぜ別の案を採らなかったか」「どの失敗を踏んでこうなったか」は `docs/decisions/<話題>.md` に書き、約束からは行き先だけを指す。

- 約束が変わったら約束のほうを直し、変えた理由を対応する `docs/decisions/` のファイルに足す
- 新しい話題は `.claude/rules/` にファイルを作り（`paths` を必ず書く）、経緯は `docs/decisions/` に置く
- このファイルは毎回のセッションで全文が読み込まれるので、理由も話題ごとの詳細も書かない

## 利用者向けの説明（`README.md` と `docs/guide/`）

配信者が読む使い方は `docs/guide/<話題>.md` に機能ごとに書く。`README.md` は入口（何ができるか・使いはじめ方・文書への行き先・開発コマンドの要約・ライセンス）だけに保ち、機能の詳細を足さない。機能を足したら `docs/guide/` の該当ファイルと `docs/guide/README.md` の一覧を直す。経緯は `docs/decisions/docs.md`。
