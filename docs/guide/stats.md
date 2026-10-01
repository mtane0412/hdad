# 配信の記録

Twitchには過去の視聴者数の推移を返すAPIがないため、Worker が cron（`wrangler.jsonc` の `triggers.crons`。5分おき）でいまの値を取得し、Cloudflare D1（`DB`）に貯めます。グラフにできるのは、記録を始めた時点より後の分だけです。D1のデータベースも、KV・R2と同じくデプロイ時に wrangler が自動で作成します（名前は `hdad-db`）。

テーブルの定義は `migrations/` にあり、デプロイとは別に適用します。データベースは最初のデプロイで作られるので、順番は「デプロイ → マイグレーション」です。

```bash
npx wrangler d1 migrations apply DB --remote  # 本番（npm run deploy はこれも行う）
npx wrangler d1 migrations apply DB --local   # ローカル（npm run dev の前に一度）
```

| テーブル | 内容 |
|---|---|
| `stream_sessions` | 配信セッション（Twitchの配信ID・開始と終了の日時・タイトル・カテゴリ・どこまでを章にしたか）。配信中は `ended_at` が `NULL` |
| `viewer_samples` | 配信中の視聴者数（5分おき） |
| `follower_samples` | フォロワー数。前回から変わったときだけ1行追加する |
| `stream_events` | サブスク・ポイント交換・レイドなどのイベントの1件ごとの記録（EventSubのWebhookで受ける。`id` はメッセージIDで、再送を二重に数えない）。配信外のイベントは `session_id` が `NULL` |
| `first_chatters` | 配信の区切りごとに、その配信で最初に発言した人を1行持つ（「その配信で初めての発言」の条件の判定に使う）。1日より古い行は cron が消す（配信中の区切りのぶんは、長く続く配信の途中で初回に戻らないよう消さない） |
| `viewers` | チャットで発言した人を1人1行持つ（初回と最後の発言日時・通算の発言数・最後に見たバッジ・配信者のメモ・AIが作った人物像）。発言そのものは貯めない。古い行を消す仕組みは無く、ずっと残す。「このチャンネルで初めての発言」「前の発言から空いた日数」の条件の判定にも使う |
| `transcripts` | 配信者が喋った内容（ゆかコネNEO の音声認識の結果を中継ページが送ってくる。[配信中の文字起こし](./transcript.md)を参照）。あらすじとサイドスーパーの材料で、配信が終わって1日で cron が消す |
| `stream_chat_messages` | 人物像と章の材料になる、配信中のチャットの本文。配信が終わり、その配信を終わりまで章にし終えたあとに cron が人物像へまとめ、使い終えた行をその場で消す。残った行も7日で消す |
| `stream_chapters` | 配信で何が話されたかの記録。配信を約30分ごとの区間に分け、区間ごとに見出しと要約を1行持つ（下の「配信で何が話されたか」を参照）。材料が消えたあとも残す |
| `screen_captures` | 配信画面を撮った1枚の記録（Gyazo の画像ID・撮った時刻と、そこから読み取った文字。[配信画面の取り込み](./screen.md)を参照）。画像そのものは持たない。配信が終わって1日で cron が消す |
| `collection_failures` | 収集の失敗（30日分） |

1回の収集ではこのほかに、区間が閉じた配信の章を1つ作り（下の「配信で何が話されたか」を参照）、終わった配信の発言から視聴者の人物像を作り（1回5人まで。[視聴者の記録](./viewers.md)を参照）、配信画面を撮った1枚から Gyazo が読み取った文字を取りに行きます（1回30枚まで。[配信画面の取り込み](./screen.md)を参照）。

1回の収集は、Helix の `GET /streams` で配信中かどうかを調べ、配信中ならセッションを開始（続いていれば更新）して視聴者数を1行追加し、配信していなければ開いているセッションを閉じます。続けて `GET /channels/followers` の `total` を記録します。セッションの終了時刻は「配信していないことを最初に確かめた時刻」なので、最大5分遅れます。

配信者がログインしていない・トークンを更新できない・Twitchが失敗を返したときは、黙って飛ばさずに `collection_failures` へ記録し、cron の実行も失敗にします。記録が止まっていたら `GET /api/admin/stats/failures` か、Cloudflareダッシュボードの Worker の Settings > Trigger Events で確かめ、`relogin-required` ならログインし直してください。

相手（Twitch・Gyazo・文面を作らせるLLM）が応答を返さないまま黙っているときは、待ち続けずに打ち切ります（Twitchは10秒、Gyazoは15秒、LLMは60秒）。1回の収集そのものにも2分の予算があり、予算を過ぎたときは**配信の記録（視聴者数・フォロワー数）は残したまま**、材料づくり（画面の文字の取得・あらすじ・サイドスーパー・章・人物像）だけを次の収集（5分後）へ回し、`collection_failures` に `collect-budget-exceeded` として記録します。材料は消えないので、次の収集で作り直されます。

保持期間は設けていません。書き込みは1日あたり最大で「視聴者数288行＋フォロワー数288行＋セッションの更新」程度で、D1の無料枠（1日10万行の書き込み・保存5GB）に対して十分小さいためです。

## 配信で何が話されたか（章）

ダッシュボード（`/`）の配信の一覧で「見る」を押すと、視聴者数の推移の下に、その配信で何が話されたかが出ます。配信を約30分ごとの区間に分け、区間ごとに「時刻・見出し・要約」を1章として並べ、最後にその配信の「これまでのあらすじ」（[チャットボット](./bot.md)の `{summary}`）を添えます。

- 章の材料は、その区間に配信者が喋った内容（[配信中の文字起こし](./transcript.md)）・視聴者の発言・画面に新しく現れた文字（[配信画面の取り込み](./screen.md)）です。材料は配信のあと間もなく消えます（文字起こしは1日、発言は人物像を作った時点）が、章は消えずに残ります
- 章は配信中に作ります。区間が閉じてから1分待ち、次の収集（5分おき）で1章ずつ作ります。配信が終わった回では、最後の区間を配信の終わりで切って章にします
- 喋っていない区間（文字起こしが1件も無い区間）は章にしません。視聴者の書き込みや画面の文字だけを材料にすると、それが配信で起きたこととして書かれるためです。ゆかコネNEO を動かし忘れた配信には章が残りません
- 30分のあいだに発話が300件を超えたときは、区間を短く切って残りを次の章に回します
- 章を作るLLMは、[LLM](./llm.md)のページの「配信のあらすじ」の設定を使います（どちらも配信の記録をまとめる箇所で、大きいモデルが要るためです）
- LLMが失敗したときは `collection_failures` に `stream-chapter-failed` として記録し、同じ区間を次の収集で作り直します。作り直せるまでは、その配信の発言から人物像を作りません（人物像を作ると発言が消え、最後の章から視聴者の反応が抜けるためです）。文字起こしが1日で消えたあとは、残りの区間を喋っていない区間として飛ばし、人物像づくりに進みます
- この機能を入れる前に終わった配信には、章がありません

## イベントの件数と、配信の開始・終了（Webhook）

Twitchからの通知は、すべてWorkerがWebhook（`POST /api/eventsub/webhook`）で受け取ります。オーバーレイはTwitchへ直接つながないので、OBSを開いていない間のイベントも数えられ、同じイベントが2回届くこともありません。

- 対象は `channel.subscribe`・`channel.subscription.message`・`channel.channel_points_custom_reward_redemption.add`・`channel.raid`（`stream_events` に1件ずつ記録）と、`stream.online`・`stream.offline`（セッションの開始・終了を cron より正確に記録）、そして `channel.follow` と `channel.ad_break.begin`。フォローは数えません（フォロワー数の推移として cron が記録しているため）が、アラートのトリガーの「チャットに送る」動作のために受け取ります。広告の開始も数えず、トリガー（広告の告知）のために受け取ります
- チャットの発言（`channel.chat.message`）だけは、件数の桁が違うので `stream_events` に記録せず、自動モデレーション・アラートのトリガー・コマンドの応答に回します
- 届いた通知は、記録に加えてアラートのトリガー（[アラート](./alerts.md)を参照）にかけます。当てはまったトリガーが持つ動作ごとに、実行する相手が違います
    - 「アラートを出す」 — アラートをオーバーレイへ押し出します（botの接続は要りません）
    - 「チャットに送る」「AIに文面を作らせて送る」「アナウンスを送る」 — botとしてチャットへ1通送ります
    - 「シャウトアウトを送る」 — botとしてシャウトアウトを1件送ります
    - チャットへ送る4つは、botが未接続なら何もしません
- 同じ通知が再送されても二度は実行しません。失敗した場合もTwitchへは2xxを返して `collection_failures` に `alert-push-failed`・`alert-chat-failed`・`alert-announce-failed`・`alert-aichat-failed`・`alert-shoutout-failed` として記録します（2xx以外だとTwitchが再送し、実行できていた場合に二重になるため）
- 広告の終了は Durable Object のアラームから実行するので、その予約の失敗は `ad-break-end-schedule-failed`、アラームが鳴ってからの失敗は `ad-break-end-failed` として記録します（予約を消したあとなので、再試行では取り返せません）
- 購読は、配信者がログインしたとき（`GET /api/auth/callback`）に揃えます。Webhook宛ての購読はユーザートークンでは作れないので、アプリアクセストークンを発行し、`https://<公開先のドメイン>/api/eventsub/webhook` 宛てに有効な購読がないイベントだけを登録します。失効した購読は消してから登録し直します。**初めてデプロイしたあとは、一度ログインし直してください**（購読はログインのときにしか揃えないためです）
- 購読の登録にTwitchが失敗を返しても、ログインは止めません（ログインできないと失敗の記録を読めなくなるため）。失敗は `collection_failures` に `webhook-subscription-failed` として記録します。購読が失効したという通知（`revocation`）も `subscription-revoked` として記録するので、`GET /api/admin/stats/failures` に出ていたらログインし直してください
- 受け口は誰でも呼べるURLなので、署名（`Twitch-Eventsub-Message-Signature`。`EVENTSUB_SECRET` によるHMAC-SHA256）を確かめ、10分より古い通知と、購読していない種類の通知は拒否します
- `EVENTSUB_SECRET` は `openssl rand -hex 32` で作ります（Twitchの決まりで10〜100文字のASCII）。あとから変えると、登録済みの購読の通知は署名が合わず403になります。変えたときは `twitch api delete eventsub/subscriptions -q id=<購読ID>`（Twitch CLI）などで購読を消してからログインし直してください
- `stream.online` の通知にはタイトルとカテゴリが無いので、セッションは空のタイトルで始まり、次の cron（5分以内）が埋めます。`stream.offline` の直後に Helix がまだ「配信中」と答えた場合は、cron がセッションを開き直し、次の回で閉じ直すので、その配信の終了時刻は最大5分遅れます

Twitchは `https` のURLしかWebhookの宛先として受け付けないので、ローカル（`http://localhost`）ではログインしても購読を登録しません。受け口の動きは [Twitch CLI](https://dev.twitch.tv/docs/cli/) で確かめます。Twitch CLI は IPv4 でしか接続しないので、開発サーバーを `127.0.0.1` で待ち受けさせ（既定の `localhost` は IPv6 だけになることがあります）、`.dev.vars` の `EVENTSUB_SECRET` と同じ値を `-s` に渡します。

```bash
npm run dev -- --host 127.0.0.1
# 購読の確認（challenge）に応答できるか
twitch event verify-subscription channel.raid -F http://127.0.0.1:5173/api/eventsub/webhook -s <EVENTSUB_SECRET>
# 通知を送る（streamup → channel.raid・channel.subscribe・add-redemption → streamdown の順に送ると、配信中のイベントとして記録される）
twitch event trigger streamup -F http://127.0.0.1:5173/api/eventsub/webhook -s <EVENTSUB_SECRET>
twitch event trigger channel.raid -F http://127.0.0.1:5173/api/eventsub/webhook -s <EVENTSUB_SECRET>
twitch event trigger streamdown -F http://127.0.0.1:5173/api/eventsub/webhook -s <EVENTSUB_SECRET>
npx wrangler d1 execute DB --local --command "SELECT * FROM stream_events"
```

## ローカルで収集を試す

ローカルで収集を試すには、`npm run dev` を起動した状態で `curl http://localhost:5173/cdn-cgi/handler/scheduled` を実行し、`npx wrangler d1 execute DB --local --command "SELECT * FROM follower_samples"` で中身を確かめます。

---

開発者向け: この作りにした理由は [Workerと失敗の記録](../decisions/worker.md)・[ダッシュボード](../decisions/dashboard.md) にあります。
