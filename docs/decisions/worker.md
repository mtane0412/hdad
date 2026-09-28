# Worker（`worker/`）と失敗の記録

`worker/` は `/api/*` を処理するWorkerのコード（Twitchログイン、トークンの保管と更新、EventSub購読の代行、アラートの設定と素材）。

ブラウザ用の `src/` からは読み込まない。

経路の一覧は `worker/index.ts`、経路の処理は `auth-routes.ts`・`admin-routes.ts`・`overlay-routes.ts`（`GET /api/overlay/socket` もここ）・`stats-routes.ts`・`webhook-routes.ts`・`chat-routes.ts`。

管理用API（`/api/admin/*`）は `requireAdmin`（セッション＋Origin確認）、オーバーレイ用APIは `requireOverlayKey` で守る。

チャット用API（`/api/chat/*`）だけは守らない（チャンネル名・バッジ画像・Cheermote はTwitchでも誰でも読める公開情報で、スコープも要らない。チャットボックスのURLに合言葉を埋めずに済ませるため）。

対象は常に `TWITCH_BROADCASTER_ID` で、呼び出し側は配信者を指定しない。

キーが無い経路なので、取得した内容はKVに1時間貯めてTwitchへの問い合わせを抑える。

Twitchのトークンは応答に含めず、保存先はKV（`STORE`）、素材はR2（`MEDIA`）、配信の記録はD1（`DB`。テーブルは `migrations/`、SQLは `stats-store.ts` に集め、必ずプレースホルダを使う）。

配信の記録は cron（`worker/index.ts` の `scheduled` → `collect.ts`）が5分おきに集め、失敗は `collection_failures` に記録してから投げる。

イベントの件数と配信の開始・終了は、Twitchから直接届くWebhook（`webhook-routes.ts` の `POST /api/eventsub/webhook`。署名を `EVENTSUB_SECRET` で確かめる）で記録し、その購読はログイン時にアプリアクセストークンで揃える（`eventsub-webhook.ts`。失敗してもログインは止めず `collection_failures` に記録する）。

`fetch`・現在時刻・KV・R2・D1は引数で受け取り、テストでは差し替える（代役は `worker/fake-store.ts`・`worker/fake-bucket.ts`・`worker/fake-database.ts`・`worker/fake-alert-channel.ts`。3つめのものは `node:sqlite` に `migrations/` を適用する）。

失敗は `{ error: { code, message } }` で返す（Fail-Fast）。

cron の1回の実行では複数の仕事（配信の記録・あらすじ・サイドスーパー・人物像）が走り、無料枠が切れた日には同じ時刻に別々の失敗が並ぶ。

そのため `collection_failures` は「時刻と種類」で1行を持つ（`migrations/0012_collection_failures_key.sql`）。

時刻だけを主キーにすると、あとの失敗が先の失敗を消してしまう
