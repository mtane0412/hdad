# プロジェクト固有設定

HDAD（Hyperfocus-Driven Assistant Director）。Twitch配信用素材と配信のアシスタント（チャットボット・アラート）のリポジトリ。Vite（マルチページ）+ TypeScript + Canvas 2D。ページUIは React + Tailwind + shadcn/ui へ移行中。Cloudflare Workers の静的アセットで公開する。

このツールが目指すものと、これまでの判断から抽出した方針は `docs/principles.md` にある。機能を追加するか・設定項目にするか・汎用化するかで迷ったら先にそこを読む。

## 品質チェックコマンド

```bash
npm run lint        # ESLint（警告ゼロ必須）
npm run type-check  # tsc --noEmit
npm test            # Vitest
npm run dev         # 開発サーバー（@cloudflare/vite-plugin がWorkerも動かすので /api/* とログインが使える）
npm run build       # Viteビルド（dist/client/ と dist/hdad/）
```

## 構成上の約束

### 置き場所

- 素材の種類ごとにソースを分ける（`src/wallpaper/`・`src/clock/`・`src/chat/` など）。素材だけを映す公開ディレクトリは持たない（`docs/decisions/overlay-stage.md`）
- `src/core/` は素材横断の共通部品（canvas の起動は `src/core/mount.ts`、パラメータの宣言と直列化は `params.ts`・`url.ts`、パラメータの入力欄は `fields.tsx`、Workerの呼び出しの共通部分は `api.ts`、アイコンだけのボタンに渡す名前は `icon-button.ts`）
- 素材（壁紙・時計・チャットのデザイン）はレジストリ（`src/<種類>/registry.ts`）に登録すると、合成オーバーレイのデザインの選択欄（`src/overlay/form.ts` の `DESIGNS`）に並ぶ。壁紙と時計はこの登録だけで済み、チャットのデザインは専用のCSSも要る（`.claude/rules/chat.md`）
- OBSに載せるページは Workers 静的アセットの都合でパスごとに実ファイルが必要なので、`vite.config.ts` の入力に追加する。載せるのは合成ページ（`overlay/stage/`）と映すものを持たない裏方（`overlay/backstage/`・`speech/reader/`・`transcript/relay/`）だけにする

### ページUI（`src/app/`）

- ページUI（ダッシュボード・管理画面）はトップ `index.html` ひとつのReactアプリで、Twitchログインを前提にサイドバー付きの画面を出す
- `/overlay/` など実ファイルのないパスには Workers が `index.html` を返し（`wrangler.jsonc` の `not_found_handling`）、アプリがパスに応じた中身を描く。そのため `vite.config.ts` の `base` は `/`
- アプリのページは `src/app/pages.tsx` に登録する（サイドバーの項目・見出し・中身がここから決まる）。登録のないパスは「見つからない」画面を出す
- ページの移動は `src/app/router.tsx`（History API。ライブラリなし）の `Link` を使い、アプリの外（OBSに載せるページ・`/api/*`）は普通の `<a>` で開く
- ログインの確認は `src/app/app.tsx` が `/api/me` で行い、失敗したら未ログイン扱いにせずエラーを出す
- OBSに載せるページ（`overlay/stage/`・`overlay/backstage/` など）には React もログインも持ち込まない

### shadcn/ui

- 見た目は shadcn/ui（`src/components/ui/`。`npx shadcn@latest add <名前>` で追加する）で統一する。土台は Base UI なので、要素の差し替えは `asChild` ではなく `render`
- `@/` は `src/` を指す。明暗はOSの設定に従う（`src/app/app.css`）
- リンクをボタンの見た目にするときは `Button` ではなく `<a className={buttonVariants()}>` を使う（`Button` は `role="button"` を付けてしまう）
- コンポーネントのテストは `// @vitest-environment jsdom` を付けて Testing Library で書く（jsdom では Base UI の `Slider` のつまみが隠れたままなので、外枠の `role="group"` の名前から探す。`<output>` は `role="status"` を持つ）

### 描画とパラメータ

- URLパラメータは `src/core/params.ts` のスキーマで宣言する。不正値は既定値に戻さずエラー表示する（Fail-Fast）
- 描画は経過時間だけから決まる形にする（フレーム間の状態を持たない）。時計は経過時間の代わりに `frame.now`（現在時刻）だけから決める

### 型チェックとデプロイ

- Workerの型チェックは `tsconfig.worker.json` に分けてある（Cloudflareのランタイムの型（`@cloudflare/workers-types`）はDOMの型と同時に読めないため）。`npm run type-check` は `tsconfig.json`（`src/`）と合わせて両方を走らせる
- フォークした人向けの Deploy to Cloudflare ボタン（`docs/guide/deploy.md`）は、`wrangler.jsonc` のバインディングと `.dev.vars.example` のシークレットを読み、`package.json` の `cloudflare.bindings` の説明を入力欄に添える。リソースやシークレットを追加したら `cloudflare.bindings` にも説明を追加する（対応は `src/core/deploy-config.test.ts` が検証する）
- デプロイのコマンドは `npm run deploy` で、ビルドは含めない（ボタンと Workers Builds が `npm run build` を別に実行するため）

## 話題ごとの約束（`.claude/rules/`）

画面・素材ごとの約束は `.claude/rules/` に分け、`paths` で指した場所を触るときだけ読み込む。**そこに無い話題をここに書き足さない。** 各ファイルは末尾に、判断の経緯（`docs/decisions/`）と利用者向けの説明（`docs/guide/`）への行き先を書く。

| ファイル | 話題 | 読み込まれる場所 |
|---|---|---|
| `chat.md` | チャットボックス（素材の種類 `chat`） | `src/chat/**` |
| `alerts.md` | アラート（素材・トリガー・動作・広告） | `src/alerts/**`・`worker/alert-*.ts`・`worker/trigger-menu.ts`・`worker/ad-break-timer.ts`・`worker/ai-chat.ts`・`worker/bot-chat.ts`・`worker/webhook-routes.ts` |
| `transcript.md` | 配信中の文字起こし（`/transcript/`） | `src/transcript/**`・`transcript/**`・`worker/transcript-store.ts` |
| `stream-summary.md` | これまでのあらすじ（`{summary}`） | `worker/stream-summary*.ts`・`worker/collect.ts`・`worker/chat-command.ts`・`worker/alert-event.ts`・`worker/webhook-routes.ts` |
| `viewers.md` | 視聴者の記録（`/viewers/`） | `src/viewers/**`・`worker/viewer-*.ts`・`worker/stream-chat-store.ts`・`worker/webhook-routes.ts`・`worker/collect.ts`・`worker/ai-chat.ts`・`migrations/*viewer*.sql` |
| `side-super.md` | サイドスーパー（素材の種類 `sideSuper`） | `src/side-super/**`・`worker/side-super*.ts`・`worker/collect.ts`・`worker/overlay-routes.ts` |
| `comments.md` | コメントビューアー（`/comments/`） | `src/comments/**`・`worker/comment-*.ts` |
| `focus.md` | 注目コメント（`/focus/`・素材の種類 `focus`） | `src/focus/**`・`worker/focus-*.ts` |
| `draw.md` | 手書き（`/draw/`・素材の種類 `draw`） | `src/draw/**`・`worker/draw-*.ts`・`src/core/socket.ts` |
| `overlay.md` | 合成ページと構成の管理画面（`overlay/stage/`・`/overlay/`） | `src/overlay/**`・`overlay/**`・`worker/overlay-*.ts` |
| `speech.md` | チャットの読み上げ（`speech/reader/`） | `src/speech/**`・`speech/**`・`worker/speech-config.ts` |
| `backstage.md` | 裏方をまとめたページ（`overlay/backstage/`） | `src/backstage/**`・`overlay/backstage/**` |
| `bgm.md` | BGM（`/bgm/`・裏方の `?bgm=true`） | `src/bgm/**`・`worker/bgm-*.ts`・`worker/alert-channel.ts` |
| `screen.md` | 配信画面の取り込み（`/screen/`） | `src/screen/**`・`worker/screen-*.ts`・`worker/gyazo.ts` |
| `llm.md` | LLMの呼び先・使用状況・モデルの選択（判定用の Jev を含む） | `src/llm/**`・`worker/llm*.ts`・`worker/jev*.ts`・`worker/ai-chat.ts`・`worker/side-super.ts`・`worker/viewer-summary.ts`・`worker/stream-summary.ts` |
| `dashboard.md` | ダッシュボード（`/`） | `src/stats/**`・`worker/stats-*.ts` |
| `triggers-page.md` | トリガーの管理画面（`/triggers/`） | `src/admin/**` |
| `bot.md` | チャットボット（`/bot/`） | `src/bot/**`・`worker/auth-routes.ts`・`worker/token.ts`・`worker/webhook-routes.ts`・`worker/bot-*.ts`・`worker/chat-*.ts`・`worker/moderation-config.ts`・`worker/eventsub*.ts` |
| `worker.md` | Worker（`worker/`）と失敗の記録 | `worker/**` |
| `implementation.md` | 判定・検証の置き場とテストの分け方（話題をまたぐ） | `src/**`・`worker/**` |

## 設計判断の記録（`docs/decisions/`）

`.claude/CLAUDE.md` と `.claude/rules/` には**いま守るべき約束**だけを書く。「なぜ別の案を採らなかったか」「どの失敗を踏んでこうなったか」は `docs/decisions/<話題>.md` に書き、約束からは行き先だけを指す。

- 約束が変わったら約束のほうを直し、変えた理由を対応する `docs/decisions/` のファイルに追加する
- 新しい話題は `.claude/rules/` にファイルを作り（`paths` を必ず書く）、経緯は `docs/decisions/` に置く
- このファイルは毎回のセッションで全文が読み込まれるので、理由も話題ごとの詳細も書かない

## 利用者向けの説明（`README.md` と `docs/guide/`）

配信者が読む使い方は `docs/guide/<話題>.md` に機能ごとに書く。`README.md` は入口（何ができるか・使いはじめ方・文書への行き先・開発コマンドの要約・ライセンス）だけに保ち、機能の詳細を追加しない。機能を追加したら `docs/guide/` の該当ファイルと `docs/guide/README.md` の一覧を直す。経緯は `docs/decisions/docs.md`。
