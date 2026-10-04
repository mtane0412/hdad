# 視聴者の記録（`/viewers/`）

視聴者の記録（`/viewers/`）はアプリのページ（`src/viewers/viewer-page.tsx`）である。

## 何を貯めるか

チャットで発言した人を1人1行でD1（`viewers`。`migrations/0006_viewers.sql`）に持ち、一覧・検索・メモ・削除を受け持つ。

**発言ではなく人を貯める**（チャットの全文は貯めない方針は変えない。1人1行なので数千人でも数MBに収まり、消さずに持てる）。記録の読み書きは `worker/viewer-store.ts`、経路（`GET /api/admin/viewers`・`PATCH`/`DELETE /api/admin/viewers/:userId`）は `worker/viewer-routes.ts` である。

照合の鍵は Twitch のユーザーIDだけで、`login` と `display_name` は本人が変えられるので「最後に見た名前」として持つだけにする（名前で照合すると改名した人が別人として増える）。サブスク・VIPの状態は自前で管理せず、発言の通知に含まれるバッジ（`ChatMessage.badges`）を最後に観測した値として控えるだけにする（自前で持つとTwitch側での変更と必ず食い違う）。

## 「配信者かどうか」を真偽値で持たない

**その人自身のチャンネルの内容（`GET /helix/channels` の最後に配信したカテゴリ・タイトル）も、真偽値ではなく観測した値として持つ**（`last_stream_game`・`last_stream_title`・`channel_checked_at`。`migrations/0015_viewer_channel.sql`）。

「配信者かどうか」を真偽値で持たないのは3つの理由による。

- `last_badges` の `broadcaster` が「このチャンネルの配信者本人」を指すので、`is_broadcaster` のような列を追加すると同じ行の中で語の意味がぶつかる
- Twitchはその真偽を返さない（`broadcaster_type` は partner / affiliate / 空文字の収益化の区分で、アフィリエイト未満の配信者は空文字になる＝偽陰性が多い）。観測できるのは「最後に配信した内容があるか」だけで、これは真偽ではなく程度なので、どこから配信者とみなすかの丸め方を保存の時点で固定しない
- バッジと同じく、Twitch側で変わる状態を自前の真偽値で持つと必ず食い違う（「配信を始めた視聴者」がこれに当たる）

観測した日時を持つことで「調べたが配信した記録が無い」（カテゴリとタイトルが空文字）と「まだ調べていない」（日時が `NULL`。`ViewerChannel` の `null`）を区別でき、真偽値1列ではこの2つが同じ `false` に潰れる。

「配信者らしい」という判断は保存側では行わず使う側（`worker/ai-chat.ts` の `channelDetail`・`/viewers/` の画面）が持ち、3通りの区別の文言は `channelDetail` 1か所に置いて `viewer-summary.ts` と共有する（2か所で書き分けると食い違い、「調べていない人」を「配信していない人」として読ませる）。

観測するのは人物像づくりと同じ cron（`worker/collect.ts` の `observeViewerChannel`。人物像を作る人のぶんだけなので1回に `SUMMARY_BATCH_SIZE` 件まで）で、**発言の受け口には追加しない**（Twitchへ2xxを速く返す道に問い合わせを増やさない）。

観測できなくても人物像づくりは止めず、前の値を残して `viewer-channel-failed` として記録する（**1回の収集ぶんをまとめて1行に記録する**。`collection_failures` は「時刻と種類」で1行しか持てないので、人ごとに記録すると同じ収集の2人目が1人目の理由を上書きして消してしまう）。スコープが要らない経路なので配信者のログインし直しは不要である。

**シャウトアウトをレイド以外のトリガーに広げる根拠にはしない**（相手が配信者だと分かっても、雑談で流れてきた人を番組内で紹介する意味は別の話で、既定メニューにした理由が崩れる）。

## 記録するタイミング

記録するのは `worker/webhook-routes.ts` のチャットの受け口だけで、処分やコマンドの判定より先に行う（処分した発言も記録する。荒らしの履歴も配信者には有用なためである）。bot自身の発言は記録しない。

**発言のたびに書くことになるので、`worker/alert-state.ts` の「条件を使うトリガーが無ければデータベースを触らない」という方針とは意識して違える**が、前回の記録から10分が経つまでは `INSERT ... ON CONFLICT DO UPDATE` の `WHERE` が偽になり1行も書き込まないので、常連が連投しても書き込みの枠を食わない（そのぶん `message_count` の精度は落ちる）。

再送で発言数を二重に増やさないための鍵は `last_message_id` である（`claimFirstChatOfStream` が `message_id` を持つのと同じ考え方）。

## 一覧と画面

一覧は件数が多くなるので全件を返さず、ログイン名の前方一致（索引 `viewers_login` を確実に使わせるため `LIKE` ではなく大小比較で書く）と `before`（最後の発言日時）で50件ずつ読む。部分一致にしないのは索引が効かずD1の `rows read` を食うためである。

ページの作り（`usePageActions`・確認は `AlertDialog`・Workerの呼び出しは `src/viewers/api.ts` に分けてテスト）は `/triggers/`・`/media/` と同じである。

## 人物像（summary）

人物像（`summary`。`migrations/0008_viewer_summaries.sql`）は配信者が書く `note` とは別の列に持ち、画面でも別々に出す（機械の推測と人が書いたものを混ぜない。画面からは書き換えられない）。作るのは cron（`worker/collect.ts` の `summarizeViewers`）で、材料はその人がその配信で話した本文である。

そのため**配信中のあいだだけはチャットの本文も貯める**（`stream_chat_messages`。`worker/stream-chat-store.ts`）。「チャットの全文は貯めない」という方針の、意識して設けた例外で、集計値だけでは人物像を作れないためである。貯めるのは配信中の区切り（`stream_sessions` の `ended_at IS NULL` の行）があるときだけで、結びつけ方は `stream_events` と同じ1文である（再送は `message_id` の主キーで弾く）。

材料にするのは**終わった配信のぶんだけ**で（配信中に作ると残りの発言が入らない）、人物像を作り終えた人の材料はその場で消す。さらに、その配信を終わりまで章にし終えるまで待つ（`stream_sessions.chaptered_until`。先に人物像を作ると発言が消え、最後の章から視聴者の反応が抜けるため。`docs/decisions/stream-chapters.md`）。材料が残っていること自体が「まだ作っていない」という印なので、済んだかどうかの列を持たない。

1回の cron で作るのは5人まで（`SUMMARY_BATCH_SIZE`。Workers AI の無料枠と、Workers のサブリクエストの上限への歯止め）。LLMを呼べなかった失敗ではそこで打ち切って `viewer-summary-failed` として記録し、材料は消さずに次の収集でやり直す（枠切れなら後続も必ず失敗するので、同じ失敗を人数分積まない）。返ってきた人物像そのものの問題（空・長すぎる。`ViewerSummaryContentError`）ではその人だけ飛ばして次へ進む（打ち切ると、発言の多い順の列の先頭をその人が塞ぎ続ける）。

視聴者の記録を消すときは、まだ人物像にしていない本文も配信中のぶんまで含めて一緒に消す（`deleteViewer`）。この失敗で収集そのものは止めない（LLMが使えない日に配信の記録まで止まらないためである）。

作った人物像は `ai-chat.ts` の材料にも渡す。作りは文面づくり（`ai-chat.ts`）と同じで、LLMを呼ばない `buildSummaryPrompt` をテストし、呼び先は `worker/llm.ts` に `viewerSummary` の箇所として任せる（モデルの選択と応答の読み取りは `llm.ts` が持つ）。

## モデレーションで消された発言は材料から消す（issue #202）

`stream_chat_messages` は人物像だけでなく、サイドスーパー・あらすじ（`{summary}` で公開チャットに出る）・章立ての材料にもなる。モデレーターが消した発言（個人情報の書き込み・差別語・スパムなど）が残ると、配信画面や公開チャットに出るLLMの出力に混ざりうる。そこで次の2つを行う。

- **Twitch から削除の通知が届いたら、行を消す**（`worker/webhook-routes.ts` の `applyModerationToStreamChat` → `worker/stream-chat-store.ts` の `removeModeratedStreamChat`）。発言の削除（`channel.chat.message_delete`）はその発言の行を、ある人の発言の一掃（`channel.chat.clear_user_messages`）とチャットのクリア（`channel.chat.clear`）は配信中の配信の行を消す。範囲は作業机（`removeModeratedTasks`）と揃えた。消し損ねたら握りつぶさずに投げて Twitch に再送させる（消すのは何度行っても同じ結果になるため）。
- **自動モデレーションで処分した発言は、はじめから貯めない**（`replyToChatMessage` で、貯めるのを処分の判定のあとに移した）。処分しても Twitch からは削除の通知が届くが、処分の呼び出しが失敗したときや、通知より先に cron が材料を読んだときにも混ざらないようにするためである。

**印（`removed_at` 列）を付けて読み出しで除く案は採らなかった。** 荒らしの履歴を配信者に残すのは視聴者の記録（`viewers` の1人1行。発言数・最後の発言日時など）の役目で、こちらは処分の前に書いたまま変えない。`stream_chat_messages` の本文はその履歴に使っておらず、消された本文を手元に持ち続ける理由が無い。印にすると、読み出す5か所（`listSummaryTargets`・`readViewerMessages`・`readSessionChatSince`・`readRecentSessionChat`・章立ての `readChapterLines`）すべてに条件を足す必要があり、1か所でも忘れると材料に戻ってしまう。マイグレーションも要らない。
