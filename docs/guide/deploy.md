# デプロイ

Cloudflare Workers で公開します。設定は `wrangler.jsonc` にあり、Viteのビルド出力（`dist/client/`）を静的アセットとして配信し、`/api/*` だけを Worker のコード（`worker/`）で処理します。

## フォークして自分の配信で使う（Deploy to Cloudflare）

下のボタンを押すと、このリポジトリがあなたのGitHubアカウントにフォークされ、Cloudflareが `wrangler.jsonc` を読んでKV（`STORE`）・R2（`MEDIA`）・D1（`DB`）を作り、`.dev.vars.example` にある5つのシークレットの入力を求めたうえで、デプロイまで行います（入力欄に出る説明は `package.json` の `cloudflare.bindings` に書いてあります）。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mtane0412/hdad)

押す前に、次の2つを済ませてください。

1. **R2を有効にする** — Cloudflareダッシュボードの Storage & databases > R2 で一度チェックアウトします。無料枠（保存10GB・転送無料）だけを使う場合でも支払い方法の登録を求められますが、無料枠内なら請求は発生しません
2. **Twitchのアプリを登録する** — [Twitch開発者コンソール](https://dev.twitch.tv/console/apps)でアプリを作り、クライアントIDとクライアントシークレットを控えます。OAuthのリダイレクトURLは公開先のドメインが決まってからでよいので、ここでは仮の値（`http://localhost:5173/api/auth/callback` など）で構いません。あわせて配信者のTwitchユーザーID（数字）を調べます（[Twitch CLI](https://dev.twitch.tv/docs/cli/) なら `twitch api get users -q login=<ログイン名>`）

ボタンを押したあとは、次の順で仕上げます。

1. 画面の案内に従ってリソースを作り、5つのシークレット（`TWITCH_CLIENT_ID`・`TWITCH_CLIENT_SECRET`・`TWITCH_BROADCASTER_ID`・`SESSION_SECRET`・`EVENTSUB_SECRET`）を入力してデプロイする
2. 公開されたURL（`https://hdad.<サブドメイン>.workers.dev/`）を控え、Twitch開発者コンソールのアプリのOAuthのリダイレクトURLを `https://<控えたドメイン>/api/auth/callback` に変える
3. 公開されたURLを開き、「Twitchでログイン」から配信者のアカウントでログインする。`TWITCH_BROADCASTER_ID` と異なるアカウントは拒否されます。このログインで、配信の記録のためのWebhook宛ての購読も揃います
4. `/media/` で素材をアップロードし、`/triggers/` でトリガーを決めて、OBS用のURLをコピーする

以降は、フォークしたリポジトリの `main` へpushするたびに Workers Builds がビルドとデプロイを行います。

## 自分でリポジトリを接続する場合

ボタンを使わずに接続することもできます。初回だけ次の設定が必要です。

1. Cloudflareダッシュボードの Workers & Pages で「Import a repository」を選び、このリポジトリを接続する
2. ビルドコマンドに `npm run build`、デプロイコマンドに `npm run deploy` を指定する（`npm run deploy` はデプロイに続けて、[配信の記録](./stats.md)のテーブルのマイグレーションも適用します）
3. `.dev.vars.example` にある5つのシークレットを、`npx wrangler secret put <名前>` かダッシュボードの Settings > Variables and Secrets で設定する
4. 公開されたURL（`https://hdad.<サブドメイン>.workers.dev/`）を開いて表示を確認する

手元から直接デプロイする場合は、`npx wrangler login` のあとに `npm run build && npm run deploy` を実行します（`npm run deploy` 自体はビルドを行いません。Workers Builds とDeployボタンがビルドを別に実行するため、二重にビルドしないようにしてあります）。

`.github/workflows/ci.yml` はLint・型チェック・テスト・ビルドと `wrangler deploy --dry-run` による設定の検証だけを行い、デプロイはしません。

## Twitchログイン（`/api/*`）の設定

チャンネルポイントなどのイベントを受け取るには配信者のTwitchトークンが必要です。Worker がTwitchログインを受け持ち、トークンを Cloudflare KV（`STORE`）に保管します。トークンはブラウザにもOBSのURLにも出しません。アラートの素材は Cloudflare R2（`MEDIA`）に置きます。KVの名前空間とR2のバケットは、デプロイ時に wrangler が自動で作成します。

アラートをオーバーレイへ押し出すために、Worker は Durable Object（`ALERTS`）を1つ使います。Worker 自身は接続を保持できないためで、OBSのブラウザソースとのWebSocketの接続はこの Durable Object が持ちます。入力を求められることはなく、`wrangler.jsonc` の `migrations` の指定からデプロイ時に作られます。接続は Hibernation（待っている間は課金されない仕組み）で保持するので、配信中つなぎっぱなしでも無料枠に収まります。

R2は無料枠（保存10GB・転送無料）だけを使う場合でも、デプロイの前に一度、Cloudflareダッシュボードの Storage & databases > R2 でR2を有効にする必要があります（支払い方法の登録を求められますが、無料枠内なら請求は発生しません）。

1. [Twitch開発者コンソール](https://dev.twitch.tv/console/apps)でアプリを登録し、OAuthのリダイレクトURLに `https://<公開先のドメイン>/api/auth/callback` を指定する（ローカルで試す場合は `http://localhost:5173/api/auth/callback`（`npm run dev`）と `http://localhost:8787/api/auth/callback`（`npm run preview:worker`）も追加する）
2. `.dev.vars.example` にある5つのシークレット（`TWITCH_CLIENT_ID`・`TWITCH_CLIENT_SECRET`・`TWITCH_BROADCASTER_ID`・`SESSION_SECRET`・`EVENTSUB_SECRET`）を、`npx wrangler secret put <名前>` またはダッシュボードの Settings > Variables and Secrets で設定する。ローカルでは `.dev.vars.example` を `.dev.vars` にコピーして値を入れ、`npm run dev` で起動する
3. `https://<公開先のドメイン>/` を開き、「Twitchでログイン」から配信者のアカウントでログインする。`TWITCH_BROADCASTER_ID` と異なるアカウントは拒否される。ログインを終えるとトップ（ダッシュボード）に戻る

| API | 役割 |
|---|---|
| `GET /api/auth/login` | Twitchの認可ページへ送る。`?role=bot` を付けるとチャットボット用のスコープで送る（配信者のセッションが必要） |
| `GET /api/auth/callback` | トークンを保管し、オーバーレイ用キーを発行（発行済みなら維持）し、配信の記録のためのWebhook宛ての購読を揃えて、セッションを開始し、トップ（`/`。ダッシュボード）へ送る |
| `POST /api/auth/logout` | セッションを終える |
| `GET /api/me` | ログイン中の配信者とオーバーレイ用キーを返す（要セッション） |
| `POST /api/eventsub/webhook` | Twitchから届くEventSubの通知を受け、イベントの件数と配信の開始・終了を記録する（Twitchの署名を `EVENTSUB_SECRET` で確かめる） |
| `GET /api/overlay/socket?key=` | アラート用オーバーレイからのWebSocketの接続を受け、当てはまったアラート（素材のURL・表示時間・音量・文言）を押し出す（要オーバーレイ用キー） |
| `POST /api/overlay/transcript` | 文字起こしの中継ページから確定した発話を1件受け取り、配信中なら記録する（配信していなければ記録せず、記録しなかったことを応答で返す。要オーバーレイ用キー） |
| `GET /api/overlay/side-super` | いま出すサイドスーパーの文言を返す（cron が作って貯めたものをそのまま返し、ここでLLMは呼ばない。配信していない・まだ作っていないときは空の行を返す。要オーバーレイ用キー） |
| `GET /api/overlay/speech` | チャットの読み上げの設定を返す（未保存なら既定の設定。読み上げのページが起動のときと30秒おきに読む。要オーバーレイ用キー） |
| `GET /api/overlay/screen` | 配信画面の取り込みのうち、撮るのに要る設定（OBSへのつなぎ先・パスワード・撮る間隔）を返す（上げ先のコレクションは渡さない。未保存なら既定の設定。裏方のページが起動のときと撮るたびに読む。要オーバーレイ用キー） |
| `POST /api/overlay/screen` | 裏方のページが撮った画面を1枚（`image/png` か `image/jpeg` の本文そのもの、8MiBまで）受け取り、配信中なら Gyazo（設定にコレクションがあればそこ）へ上げて画像IDを記録する（配信していなければ上げず、上げなかったことを応答で返す。`GYAZO_ACCESS_TOKEN` が無ければ500。要オーバーレイ用キー） |
| `GET /api/overlay/focus` | いま取り上げている注目コメントを返す（取り上げていなければ `target` は `null`。要オーバーレイ用キー） |
| `GET /api/overlay/draw?key=` | 合成ページからのWebSocketの接続を受け、配信者が描く画面で引いた線を届ける（この接続からは描けない。要オーバーレイ用キー） |
| `GET /api/overlay/draw/strokes` | 保存されている手書きの線を返す。合成ページが起動のときに1度読み、それを初期状態として描く（要オーバーレイ用キー） |
| `GET /api/overlay/layout` | 合成オーバーレイの構成（どのオーバーレイにどの素材をどこへ置くか）を返す。合成ページが起動のときに読む（要オーバーレイ用キー） |
| `GET /api/chat/channel` | このWorkerが扱う配信者のチャンネル名を返す（**キーもセッションも要らない**。チャットボックスと読み上げが接続先を知るために読む） |
| `GET /api/chat/badges` | チャットの公式バッジ画像の一覧を返す（キー不要。KVに1時間貯める） |
| `GET /api/chat/cheermotes` | Cheermote（ビッツの絵）の一覧を返す（キー不要。KVに1時間貯める） |
| `GET /api/media/<素材ID>?key=` | 素材の中身を返す（要オーバーレイ用キー、または配信者のセッション） |
| `GET`・`PUT /api/admin/config` | アラートの設定の取得・保存（要セッション） |
| `GET`・`POST /api/admin/media` | 素材の一覧・アップロード（要セッション） |
| `DELETE /api/admin/media/<素材ID>` | 素材の削除。トリガーに使われている素材は409で拒否する（要セッション） |
| `POST /api/admin/overlay-key` | オーバーレイ用キーの再発行。古いキーを含むURLは使えなくなる（要セッション） |
| `GET /api/admin/bot` | チャットボットの接続状態（ログイン名・ユーザーID・不足しているスコープ・モデレーターかどうか）。トークンは返さない（要セッション） |
| `DELETE /api/admin/bot` | チャットボットの切断（Workerが持つトークンを消す。要セッション） |
| `POST /api/admin/bot/messages` | 本文 `{ "message": 送る文言 }` を受け取り、botの名前で配信チャンネルのチャットへ送る（要セッション） |
| `POST /api/admin/bot/device-code` | 別の端末で接続するためのコードを発行する（デバイスコードフロー。要セッション） |
| `POST /api/admin/bot/device-token` | 本文 `{ "deviceCode": 発行されたコード }` を受け取り、トークンに交換する。まだ認可されていなければ `{ "status": "pending" }` を返す（要セッション） |
| `GET`・`PUT /api/admin/bot/commands` | チャットのコマンドの取得・保存（要セッション） |
| `GET`・`PUT /api/admin/bot/moderation` | チャットの自動モデレーションの設定の取得・保存（要セッション） |
| `GET`・`PUT /api/admin/speech` | チャットの読み上げの設定の取得・保存（要セッション） |
| `GET`・`PUT /api/admin/screen` | 配信画面の取り込みの設定の取得・保存（要セッション） |
| `GET`・`PUT /api/admin/overlay/layout` | 合成オーバーレイの構成（オーバーレイと素材）の取得・保存（要セッション） |
| `GET /api/admin/draw/socket` | 描く画面からのWebSocketの接続を受け、引いた線を合成ページへ中継する（同じサイトからの接続だけを受け付ける。要セッション） |
| `GET`・`PUT /api/admin/draw/strokes` | 手書きで描いたものの取得・保存（描く画面が線を1本引き終えてから数秒まとめて保存する。要セッション） |
| `GET`・`PUT /api/admin/focus` | 注目コメント（いま取り上げているもの）の取得・保存（要セッション） |
| `GET /api/admin/focus/messages` | 取り上げる発言を選ぶための、いま進んでいる配信の直近の発言の一覧（要セッション） |
| `GET`・`PUT /api/admin/llm` | LLMの提供元とモデルの設定の取得・保存（要セッション） |
| `GET /api/admin/llm/models` | その提供元で選べるモデルの一覧（`?provider=`。要セッション） |
| `GET /api/admin/llm/usage` | LLMを呼んだ回数・トークン数・実費の日ごとのまとめ（要セッション） |
| `GET /api/admin/llm/credits` | OpenRouter の残高（`OPENROUTER_API_KEY` が無ければ400。要セッション） |
| `GET /api/admin/rewards` | 配信者のチャンネルポイント報酬の一覧（ID・名前・必要ポイント）。管理画面でトリガーの報酬を選ぶのに使う（要セッション） |
| `GET /api/admin/viewers` | 視聴者の記録の一覧（最後に発言した順）。`?search`（ログイン名の前方一致）・`?before`（この日時より前に発言した人）・`?limit`（1〜200。既定50）で絞る（要セッション） |
| `PATCH /api/admin/viewers/<ユーザーID>` | 本文 `{ "note": メモ }` を受け取り、その人へのメモを保存する（2000文字まで。要セッション） |
| `DELETE /api/admin/viewers/<ユーザーID>` | 視聴者の記録の削除（本人から求められたときに応じるためのもの。要セッション） |
| `GET /api/admin/stats/sessions` | 配信セッションの一覧（新しい順に100件まで）。平均・最大視聴者数、フォロワー増減、イベントの種類ごとの件数つき（要セッション） |
| `GET /api/admin/stats/sessions/<配信ID>` | 配信セッションと、視聴者数の時系列（要セッション） |
| `GET /api/admin/stats/followers` | フォロワー数の時系列。値が変わった時点だけが並ぶ（要セッション） |
| `GET /api/admin/stats/failures` | 記録の収集の失敗の一覧（新しい順に50件まで。要セッション） |

失敗は `{ "error": { "code", "message" } }` の形で返します。受け取るイベントを増やす場合は `worker/eventsub.ts` の `EVENT_TYPES` に足します（スコープが増えたら配信者の再ログインが必要です）。

---

開発者向け: この作りにした理由は [Workerと失敗の記録](../decisions/worker.md) にあります。
