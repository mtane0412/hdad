# 配信中の文字起こし（`/transcript/`）

配信中の文字起こし（`/transcript/`）はアプリのページ（`src/transcript/transcript-page.tsx`）だが、取り込むのはOBSのブラウザソースに置く中継ページ（`transcript/relay/index.html`）で、アプリのページはそこへ貼るURLを出すだけである（`src/transcript/url.ts` の `relayUrl` に分けてテストする。オーバーレイ用キーはアラートと共通なので、再発行は `/triggers/` に置いたまま増やさない）。

## つなぎ先はゆかコネNEO

取り込む相手はゆかコネNEOで、**同じPC上のWebSocketサーバー**（既定 `ws://localhost:11901/`）へ中継ページがつなぐ。ゆかコネNEO には外部へ送る仕組みが無いので、PCとWorkerの橋渡しをこのページが受け持つ。

https のページから `ws://` へつなぐのは混在コンテンツにあたるが、ブラウザがループバックを安全な接続元として例外扱いするため通る（OBS内蔵のCEFで実機確認済み。そのため `host` は `localhost` か `127.0.0.1` しか受け取らない）。

つなぐ先を `/textonly` ではなく `/` にするのは、`/textonly` が本文だけのプレーンテキストを返し、重複を防ぐ鍵（`MsgID`）が読めないためである。読むのは母国語（`Text1`）だけで翻訳（`Text2`〜`Text6`）は捨てる（あらすじに要らない）。

中継ページも素材ページの約束どおりReactもログインも持たず、オーバーレイ用キー（`?key=`）でWorkerに受け付けてもらう。通信を伴わない変換（`message.ts`）とWorkerの呼び出し（`api.ts`。`fetch` を差し替えてテスト）を、WebSocketとDOMを扱う部分（`connection.ts`・`view.ts`・`stage.ts`）から分ける。

## 送らない1件

**暫定の認識（`TextFixed` が偽）は送らない**（何度も書き換わるため）。

**`isDeleted` が真の1件も送らない。** 公式ドキュメントの「実際に消えるタイミングは、`isDeleted` が `true` の別のデータで通知されます」のとおり、これは表示の残り時間（`KeepTime`）が尽きて字幕が消えるときにも届く通常の知らせで、編集者による取り消しと区別できない。取り消しとして扱って記録を消していたため、確定した発話が数秒後にすべて消え、あらすじとサイドスーパーの材料が残らなかった。まれな編集者の取り消しが材料に残るほうを受け入れる（そのため取り消しの受け口は持たない）。

ゆかコネNEO は確定した1件も表示の残り時間（`KeepTime`）を減らしながら繰り返し押し出してくるので、`nextTranscriptState` が送った `MsgID` を覚えて二度目からは送らない。送信に**やり直せる失敗**（`isRetryable`）で失敗した発話は覚えているものから外す（`forgetTranscript`）ので、次に同じ1件が押し出されたときにひとりでに送り直される（やり直しの仕掛けを別に作らない）。本文やキーの誤り（4xx）は送り直しても同じ答えになるので忘れず、押し出しのたびに同じ失敗を繰り返さない（`src/transcript/task.ts` の `startTranscript`）。

## 受け口と保存

受け口は `POST /api/overlay/transcript`（`worker/overlay-routes.ts`。`requireOverlayKey` で守る）、保存は `worker/transcript-store.ts`（`transcripts`。`migrations/0009_transcripts.sql`）である。

**配信中の区切り（`stream_sessions` の `ended_at IS NULL` の行）が無ければ1行も書かず**、捨てたことを応答（`{ recorded: false }`）で中継ページに知らせる（配信の前後に開きっぱなしにするのが普通の使い方なので、捨てるのを失敗にしない）。

結びつけ方は `stream_chat_messages` と同じ1文で、再送は `message_id`（ゆかコネNEO の `MsgID`）の主キーで弾く。同じ `MsgID` で二度呼ばれてもどちらにも `true` を返す（`claimFirstChatOfStream` と同じ考え方である）。

古い行は cron（`worker/collect.ts`。1日より前。配信中の区切りのぶんは残す）が消す。あらすじ（issue #65）の材料にするための一時的な記録なので、配信後には残さない。
