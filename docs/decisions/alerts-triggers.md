# トリガーの既定メニューと照合

トリガーは「既定メニューの項目」（`kind` と、その項目が要求するパラメータ1つ）と「動作」（`worker/alert-config.ts` の `actions`）からなる。

**イベント種別と条件を自由に組み合わせる形は採らない。** このツールは Firebot のような汎用ノーコードを目指していないためで、組み合わせを画面で組み立てさせると、「初見さんに反応したい」だけでも2段の手順が要り、意味を持たない組み合わせも作れてしまう。

メニュー項目は13種類（`worker/trigger-menu.ts` の `TRIGGER_KINDS`）で、`newViewer`（初めて来た人の発言）・`comeback`（`days` 日以上空いた人の発言。1〜365の整数）・`welcome`（その配信で最初の発言）・`everyMessage`（すべての発言）・`keyword`（`contains`。大文字小文字を区別しない部分一致）・`fromUser`（`login`。大文字小文字を区別しない）・`reward`（`rewardId`。`null` はすべての報酬）・`follow`・`subscribe`・`resubscribe`・`raid`・`adBreakBegin`／`adBreakEnd`（`automatic`。`null` は自動・手動のどちらでも）である。

## 挨拶は排他にする

**最初の3つは「挨拶」（`GREETING_KINDS`）で、1通の発言に当てはまるのは最も細かい1つだけである**（`alert-event.ts` の `applyGreetingRule`）。初めて来た人の発言は必ず「その配信で最初の発言」でもあり、久しぶりの人の発言もそうなので、すべて発動させると挨拶が二重・三重に飛ぶ。

優先順位は `GREETING_KINDS` の並びで決め、保存されている並びには頼らない（KVを手で直しても挨拶が入れ替わらないため）。**`everyMessage` は挨拶に入れない**（読み上げや効果音は初めて来た人の発言でも鳴ってほしいため）。

挨拶の絞り込みは動作の種類をまたいで効かせる必要があるので、当てはまるトリガーを決めるのは動作の種類ごとではなく1回だけにしてある（`matchedTriggers`）。動作ごとに選ぶと、初めて来た人にAIチャット・その配信で最初の人にチャットを付けたときに両方送られてしまう。

「絞り込まない」をメニュー項目ではなくパラメータの `null` で表すのは、項目を増やさずに済ませるためで、展開すると条件を持たない形になる。

## 展開と照合

項目からイベント種別と条件への展開は `worker/trigger-menu.ts` の `expandSource`（`alert-config.ts` の `resolveTrigger` が動作を添えて `ResolvedTrigger` にする）だけが行い、**照合（`worker/alert-event.ts` の `matches`）と要否の判定は展開後の形しか見ない**。メニュー項目を増やしても照合を書き換えずに済み、「判定は `matches` だけが持つ」という約束も守れるためである。

条件（`StoredCondition`）は展開の結果として内部にだけ現れ、1つのメニュー項目が持つ条件は0件か1件である。

## 条件の状態（ConditionState）

`firstChatOfStream`・`firstChatEver`・`returningAfter` は通知の中身では決まらないので、照合を純粋な関数のままにするため、呼び出し側が先に調べて `ConditionState` として渡す（`worker/alert-state.ts` の `resolveConditionState`。`chat-moderation.ts` の `judge` が連投の件数を引数で受け取るのと同じ作りである）。`aiChat` の動作があるイベントでは、メニュー項目が要求していなくても調べる（来訪の別を知らないまま文面を作らせないため。`requiresFirstChatOfStream`・`requiresChatHistory` がその要否を返す）。

判定と記録は `worker/chat-store.ts` の `claimFirstChatOfStream` が1文で行う（`first_chatters`。`migrations/0005_first_chatters.sql`）。配信の区切りは `stream_sessions` の配信中の行で、配信中の行が無ければ初回と判定せず記録も残さない（テスト配信のたびに鳴らないため）。行は発言のIDを持ち、同じ発言について何度問い合わせても同じ答えを返す（Twitch自身が同じ通知を再送することがあり、再送で false を返すと1通目が途中で失敗していた場合にアラートが鳴らなくなる）。古い行は cron（`worker/collect.ts`。1日より前）が消す。

### 初見の判定にTwitchのAPIは使えない

IRCのタグ（`first-msg`・`returning-chatter`）にはあり、チャットボックス（`src/chat/message.ts`）はそれを読んで「初見」「おかえり」を出しているが、トリガーの判定に使う EventSub の `channel.chat.message` にはこの項目が無い（`message_type` の `user_intro` は視聴者が自己紹介として送ったときの種別で、初回発言の印ではない）。そのため自前の記録を使う。

`firstChatEver` と `returningAfter` は視聴者の記録（`viewers`）から決まるので、`worker/viewer-store.ts` の `readChatHistory` が1回の読み出しで両方を答える（使うトリガーが無ければ読まない。要否は `alert-event.ts` の `requiresChatHistory`）。テーブルを増やさず `viewers` に2列を足している（`migrations/0007_viewer_chat_history.sql`）。`first_message_id` はその行を作った発言のIDで、これが今の発言のIDと同じなら初めてと答える（再送で答えを変えないため）。`previous_seen_at` は `last_seen_at` を上書きする前の値で、記録を更新した発言（`last_message_id` が一致）の間隔をここから数える。

**判定は発言を記録したあとに行う**（`worker/webhook-routes.ts` は `recordViewerMessage` を照合より先に呼ぶ）。順序を入れ替えると間隔が読めなくなる。記録しなかった発言（10分の間引き）では `last_seen_at` から今までを数えるので、久しぶりの発言に続く連投で二度当てはまらない。

## 古い形の設定は読み替えない

保存済みの設定が古い形（`event` と `conditions` を直接持つ形、動作に分ける前の形）なら `loadAlertConfig` が読み替えずにエラーにする（Fail-Fast。開発中で後方互換を保つ必要がないため、暗黙の読み替えを増やさない）。

管理画面（`GET /api/admin/config`）もこの読み出しを通るので画面からは直せない。KVの `alert-config` を消してから入れ直す（エラーの文面がその手だてと、見つかった項目の名前を示す）。
