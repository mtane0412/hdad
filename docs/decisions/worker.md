# Worker（`worker/`）と失敗の記録

## 経路と守り方

`worker/` は `/api/*` を処理するWorkerのコード（Twitchログイン、トークンの保管と更新、EventSub購読の代行、アラートの設定と素材）で、ブラウザ用の `src/` からは読み込まない。経路の一覧は `worker/index.ts` にあり、経路の処理は `auth-routes.ts`・`admin-routes.ts`・`overlay-routes.ts`（`GET /api/overlay/socket` もここ）・`stats-routes.ts`・`webhook-routes.ts`・`chat-routes.ts` に分けてある。

管理用API（`/api/admin/*`）は `requireAdmin`（セッション＋Origin確認）、オーバーレイ用APIは `requireOverlayKey` で守る。**チャット用API（`/api/chat/*`）だけは守らない**。チャンネル名・バッジ画像・Cheermote はTwitchでも誰でも読める公開情報でスコープも要らず、チャットボックスのURLに合言葉を埋めずに済ませたいためである。対象は常に `TWITCH_BROADCASTER_ID` で、呼び出し側は配信者を指定しない。キーが無い経路なので、取得した内容はKVに1時間貯めてTwitchへの問い合わせを抑える。

## 保存先と記録

Twitchのトークンは応答に含めず、保存先はKV（`STORE`）、素材はR2（`MEDIA`）、配信の記録はD1（`DB`。テーブルは `migrations/`、SQLは `stats-store.ts` に集め、必ずプレースホルダを使う）である。

配信の記録は cron（`worker/index.ts` の `scheduled` → `collect.ts`）が5分おきに集め、失敗は `collection_failures` に記録してから投げる。イベントの件数と配信の開始・終了は、Twitchから直接届くWebhook（`webhook-routes.ts` の `POST /api/eventsub/webhook`。署名を `EVENTSUB_SECRET` で確かめる）で記録し、その購読はログイン時にアプリアクセストークンで揃える（`eventsub-webhook.ts`。失敗してもログインは止めず `collection_failures` に記録する）。

## テストと失敗の扱い

`fetch`・現在時刻・KV・R2・D1は引数で受け取り、テストでは差し替える（代役は `worker/fake-store.ts`・`worker/fake-bucket.ts`・`worker/fake-database.ts`・`worker/fake-alert-channel.ts`。`fake-database.ts` は `node:sqlite` に `migrations/` を適用する）。HTTP APIの失敗は `{ error: { code, message } }` で返す（Fail-Fast）。

## 外へ出る呼び出しの時間制限と、1回の収集の予算

外へ出る呼び出し（Twitch の Helix API・LLM・Gyazo）には時間制限をかける（`worker/timeout.ts`。issue #126）。相手が失敗を返さずに黙り続けると、cron の1回分がそこで止まり、後ろの処理へ進めないためである。制限の値を1つに統一せず相手ごとの定数（10秒・15秒・60秒）にしたのは、値を引くだけの問い合わせと文面を作らせる呼び出しでは、まともに動いているときの応答の速さが1桁違うためである。設定項目にはしていない（配信者が決める理由がない）。

包む場所はクライアントを組み立てる関数の中（`createTwitchClient`・`createGyazoClient`・`createLlm`）にした。`worker/index.ts` で注入する `fetch` を包むと1か所で済むが、相手ごとに値を分けられず、`ad-break-timer.ts`・`overlay-routes.ts` のように別の場所で組み立てるぶんが漏れる。

中断の合図（`AbortSignal`）を渡すだけでなく、待つのをやめる側（`Promise.race`）も持つ。Workers AI のバインディング（`Env.AI` の `run`）は合図を受け取れないので、合図だけでは待つのをやめられない（この場合、呼び出しそのものは止められず、待つのをやめるだけである）。

期限は応答の本文を読み終えるまでかける（`withTimeout` が本文を読み切って同じ形の応答に作り直して返す）。`fetch` はヘッダーが返った時点で約束を果たすので、本文の読み取り（`response.json()`）を期限の外に置くと、相手がヘッダーだけ返して本文を止めたときにそこで止まる。本文まで同じ期限に入れることで、期限による失敗を `TimeoutError` に揃えられる（本文の読み取りが合図で中断されると別の型の失敗になり、本文の誤りを扱う経路に紛れる）。状態コードが 204 などで本文を持てない応答は、作り直さずにそのまま返す。

1回ずつの制限に加えて、収集そのものに時間の予算（`COLLECT_BUDGET_MS`。2分）を持たせた。Gyazo を最大30枚、LLMを4か所ぶん逐次に呼ぶので、遅い相手が続くと1回の収集が積み上がって長くなる（30枚×15秒だけで cron の間隔を超える）。予算は処理の入口で1度見るのではなく、**材料づくりの1つごと**（OCRは1枚ごと、あらすじ・サイドスーパーはそれぞれの前、人物像は1人ごと）に見る。LLMの呼び出しは1回で最大60秒かかるので、入口で1度見るだけでは3つぶん（あらすじ・サイドスーパー・人物像5人）が次の cron の起動に食い込む。予算を過ぎたときに捨てるのは材料づくり（OCRの取得・あらすじ・サイドスーパー・人物像）だけにして、配信の記録と古い記録の掃除は必ず終える。材料はどれも「残っていること自体が、まだ作っていないという印」なので、次の収集でやり直せる。篩（`siftScreenOcr`）は外へ出ないので予算を過ぎても通す（止めると、取れた文字が篩の前で溜まっていくだけになる）。

打ち切ったことは `collection_failures`（`collect-budget-exceeded`）に1行残す。正常な間引きとして黙って飛ばすと、配信者は「あらすじが5分ぶん飛んだ」ことに気づけない。cron そのものは失敗にしない（配信の記録は残せているため）。

cron の1回の実行では複数の仕事（配信の記録・あらすじ・サイドスーパー・人物像）が走るので、無料枠が切れた日には同じ時刻に別々の失敗が並ぶ。そのため `collection_failures` は「時刻と種類」で1行を持つ（`migrations/0012_collection_failures_key.sql`）。時刻だけを主キーにすると、あとの失敗が先の失敗を消してしまう。
