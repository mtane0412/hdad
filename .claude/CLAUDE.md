# プロジェクト固有設定

Twitch配信用素材のリポジトリ。Vite（マルチページ）+ TypeScript + Canvas 2D。Cloudflare Workers の静的アセットで公開する。

## 品質チェックコマンド

```bash
npm run lint        # ESLint（警告ゼロ必須）
npm run type-check  # tsc --noEmit
npm test            # Vitest
npm run build       # Viteビルド（dist/）
```

## 構成上の約束

- 素材はカテゴリごとに公開ディレクトリ（`wallpaper/` など）とソース（`src/<カテゴリ>/`）を分ける。`src/core/` はカテゴリ横断の共通部品（ギャラリーは `src/core/gallery/`、素材ページの起動は `src/core/mount.ts`）。トップ `index.html` はカテゴリ一覧
- Workers 静的アセットはパスごとに実ファイルが必要なため、壁紙の背景は `wallpaper/<id>/index.html` と `src/wallpaper/registry.ts` の両方に登録する。時計も同様に `clock/<id>/index.html` と `src/clock/registry.ts` の両方に登録する。カテゴリを増やしたら `vite.config.ts` の `categories` にも足す
- URLパラメータは `src/core/params.ts` のスキーマで宣言する。不正値は既定値に戻さずエラー表示する（Fail-Fast）
- チャットボックス（`chat/`）だけは canvas ではなくHTML要素で表示し、届いた書き込みという状態を持つ。デザインは `chat/<id>/index.html`・`src/chat/registry.ts`・`src/chat/<id>.css` の3か所に登録する。通信を伴わない変換（`irc.ts`・`event.ts`・`message.ts`・`emotes.ts`）と、DOM・WebSocketを扱う部分（`view.ts`・`connection.ts`・`stage.ts`）を分け、前者をテストする
- アラート用オーバーレイ（`alerts/`）は一覧を持たない単独のページで、`vite.config.ts` の `categories` ではなく入力に直接足している。`chat/` と同じく状態（再生待ちの列）を持ち、通信を伴わない変換（`eventsub.ts`・`trigger.ts`・`queue.ts`）と、DOM・WebSocketを扱う部分（`view.ts`・`connection.ts`・`stage.ts`）を分け、前者をテストする。Workerへの購読の依頼（`subscribe.ts`）は `fetch` を差し替えてテストする。トリガーの設定は `src/alerts/config.ts` に直書き（管理画面ができたら差し替える）
- `worker/` は `/api/*` を処理するWorkerのコード（Twitchログイン、トークンの保管と更新、EventSub購読の代行）。ブラウザ用の `src/` からは読み込まない。Twitchのトークンは応答に含めず、保存先はKV（`STORE`）。`fetch`・現在時刻・KVは引数で受け取り、テストでは差し替える（KVの代役は `worker/fake-store.ts`）。失敗は `{ error: { code, message } }` で返す（Fail-Fast）
- 描画は経過時間だけから決まる形にする（フレーム間の状態を持たない）。時計は経過時間の代わりに `frame.now`（現在時刻）だけから決める
