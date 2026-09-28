# アラートの配送（`alerts/` と `AlertChannel`）

アラート用オーバーレイ（`alerts/`）は一覧を持たない単独のページで、`vite.config.ts` の `categories` ではなく入力に直接足している。

`chat/` と同じく状態（再生待ちの列）を持ち、通信を伴わない変換（`alert.ts`・`queue.ts`）と、DOM・WebSocketを扱う部分（`view.ts`・`socket.ts`・`stage.ts`）を分け、前者をテストする。

**Twitchへは直接つながない**。

Twitchからの通知はすべてWorkerがWebhookで受け、当てはまったアラート（素材のURL・表示時間・音量・置き換え済みの文言）だけを `GET /api/overlay/socket` の接続へ押し出す。

オーバーレイはそれを再生するだけで、トリガーも条件も知らない（`src/alerts/` に照合のコードは無い）。

こうするのは、条件に「その配信で初めての発言か」のようにデータベースの記録からしか決められないものがあるためで、判定は通知のたびに行うので管理画面での変更はOBSの再読み込みなしで反映される。

押し出しの宛先は Durable Object（`worker/alert-channel.ts` の `AlertChannel`。バインディングは `ALERTS`）で、Workerが接続を保持できないために置いている。

接続は Hibernation API（`ctx.acceptWebSocket`）で受け、ping には `setWebSocketAutoResponse` が眠ったまま応える。

**この Durable Object は配送者であって判定者ではない**（設定を持たせると、管理画面での変更がすぐ反映される性質が壊れる）。

オーバーレイを開いていない間のアラートは貯めずに捨てる。

WebSocketの接続（Upgrade）は Cloudflare のランタイムでしか作れないので、テストでは配送の部分（`broadcast`・押し出しの入口）だけを確かめる（`worker/fake-alert-channel.ts`）。

`?demo=true` のサンプル（Alert の一覧）は `demo.ts`。
