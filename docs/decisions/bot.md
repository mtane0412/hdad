# チャットボット（`/bot/`）

チャットボット（`/bot/`）はアプリのページ（`src/bot/bot-page.tsx`）である。配信者とは別のTwitchアカウント（botアカウント）を接続し、その名前でチャットへ書き込む。

IRCではなく Helix の `POST /helix/chat/messages` を使うので常時接続が要らない（Workerだけで動く）。トークンは役割ごとに別のキーでKVに保管する（`worker/token.ts` の `TokenRole`。配信者は `twitch-token`、botは `twitch-token:bot`）。

## botの接続（2つの道）

botの接続には2つの道がある。認可コードフロー（`/api/auth/login?role=bot`。役割は state に載せて認可画面の往復を渡す。クエリだけで運ぶと戻ってきた時点で書き換えられるため）と、デバイスコードフロー（`/api/admin/bot/device-*`。別の端末でコードを入力する。このアプリのログイン（配信者）とTwitchのログイン（bot）が同じブラウザで取り合いになるのを避けられる）である。どちらも配信者のセッションがある人しか開始・完了できない。

デバイスコードフローの `deviceCode` はKVに置かずブラウザへ返す（KVは反映に最大60秒かかり、直後のポーリングで見つからないことがあるため）。

「まだ認可されていない」は失敗ではないので、`authorization_pending` と `slow_down` だけを待っている状態として扱い、それ以外の失敗は飲み込まない（飲み込むと終わらないポーリングになる）。`slow_down` は `authorization_pending` と区別して返し、次からの問い合わせの間隔を5秒延ばす（RFC 8628。間隔の計算は `src/bot/poll.ts` に分けてテストする）。Workerの呼び出し（`src/bot/api.ts`）は画面から分けてテストする。

## チャットの受信

チャットの受信は EventSub の `channel.chat.message` を Webhook で購読する（`worker/eventsub-webhook.ts`）。購読の条件にある「チャットを読む人」（`user_id`）には配信者自身を指定するので、購読の内容は配信者だけで決まり、botの接続とは無関係である（`syncWebhookSubscriptions` を呼ぶのは配信者のログインのときだけ）。アプリアクセストークンでこの購読を作るには、読む人＝配信者から `user:read:chat` と `user:bot` に加えて、そのチャンネルの `channel:bot`（またはbotがモデレーターにされていること）が要る。配信者自身が読む人なので `channel:bot` をまとめて要求している（`worker/eventsub.ts` の `EXTRA_BROADCASTER_SCOPES` は `channel:bot`・`user:bot`・`moderation:read` の3つ）。

チャットは配信の記録（D1）に書かない（件数の桁が違い、D1の書き込みの枠を食い合うため）。

届いた発言に対しては、自動モデレーションの判定・アラートのトリガーの判定・コマンドの応答をこの順に行う（処分した発言にはトリガーも応答も返さない。bot自身の発言にはどれも行わない）。

発言の読み取りは `worker/chat-command.ts` の `readChatMessage` に集め、アラートのイベントの読み取り（`worker/alert-event.ts` の `extract`）からも呼ぶ（同じ通知を2か所で読み解かないため。そのため引数は通知そのものではなく `event` の中身である）。

## コマンドの応答

コマンドの判定（`worker/chat-command.ts`）は通信を伴わないので分けてテストし、コマンドの一覧は引数で受け取る（保存と検証は `worker/bot-config.ts`、KVのキーは `bot-commands`）。

クールダウンと「応答済みのメッセージID」はD1（`worker/chat-store.ts`）に持ち、どちらもSQLiteの `RETURNING` で「書けたかどうか」を1つの文で受け取る（読んでから書くに分けると、同時に届いた通知の間で判定が食い違う）。鍵の確保はクールダウンの判定より先に行う（逆にすると再送のたびに最後に使った時刻が更新され、いつまでも応答できなくなる）。D1に書くのはコマンドに一致した発言のときだけにする。

bot自身の発言には決して応答しない（応答し続けて止まらなくなる）。応答を送ると決めたあとの送信の失敗は、Twitchへは2xxを返して `collection_failures` に記録する（2xx以外だとTwitchが再送し、送信が成功していた場合に二重投稿になるため）。

## モデレーション

モデレーション操作（BAN・タイムアウト・発言の削除・アナウンス）は `worker/twitch.ts` の `banUser`・`deleteChatMessage`・`sendChatAnnouncement` で行い、botの `moderator:manage:*` と、botがそのチャンネルのモデレーターにされていることの両方が要る。後者は配信者のトークン（`moderation:read`）で `isModerator` を呼んで確かめ、`GET /api/admin/bot` が返す（スコープ不足を「モデレーターでない」と読み替えない）。

自動モデレーション（受け取った発言を自分で決めたルールで処分する）は、判定（`worker/chat-moderation.ts` の `judge`。通信も時刻も持ち込まず、連投の件数は引数で受け取る）・設定の検証と保存（`worker/moderation-config.ts`、KVのキーは `bot-moderation`）・処分の実行（`worker/bot-moderation.ts` の `punishAsBot`）に分ける。

既定は無効（`enabled: false`）で、除外（配信者とモデレーター・VIP・サブスク）はすべて有効にする（誤って処分すると取り返しがつかない。Twitchはモデレーターへの処分を受け付けないため、除外を切ると失敗が積み上がるだけになる）。

URLの判定は設定に正規表現を持ち込まず実装側に固定で持つ（任意の正規表現は検証とReDoSの対策が要るため）。複数のルールに当たったら重い処分（ban > timeout（長いほう）> delete）を採る。連投の判定に使う直近の文面（ハッシュのみ）は `chat_recent_messages`（`migrations/0003_chat_moderation.sql`）に持ち、連投のルールが有効なときだけ書く。連投のルールを1件までに制限しているのは、数える窓を1つに定めるためである。

処分はコマンドの応答より先に判定し、処分した発言には応答しない。タイムアウト・BANでは削除してから `banUser` を呼ぶ（BAN後は削除できない場合がある）。すでにBAN済み・タイムアウト中の409は失敗にせず処分済みとして扱い、それ以外の失敗は `moderation-failed` として記録してTwitchへは2xxを返す。
