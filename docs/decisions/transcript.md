# 配信中の文字起こし（`/transcript/`）

配信中の文字起こし（`/transcript/`）はアプリのページ（`src/transcript/transcript-page.tsx`）だが、取り込むのはOBSのブラウザソースに置く中継ページ（`transcript/relay/index.html`）で、アプリのページはそこへ貼るURLを出すだけである（`src/transcript/url.ts` の `relayUrl` に分けてテストする。オーバーレイ用キーはアラートと共通なので、再発行は `/triggers/` に置いたまま増やさない）。のちにこのアプリのページは消し、ポートとURLはコネクターのページ（`/connectors/`）が裏方の1枚として出すようにした（`relayUrl` も消した。[裏方をまとめたページ](./backstage.md#アプリのページをコネクターにまとめる)）。

## つなぎ先はゆかコネNEO

取り込む相手はゆかコネNEOで、**同じPC上のWebSocketサーバー**（既定 `ws://localhost:11901/`）へ中継ページがつなぐ。ゆかコネNEO には外部へ送る仕組みが無いので、PCとWorkerの橋渡しをこのページが受け持つ。

https のページから `ws://` へつなぐのは混在コンテンツにあたるが、ブラウザがループバックを安全な接続元として例外扱いするため通る（OBS内蔵のCEFで実機確認済み。そのため `host` は `localhost` か `127.0.0.1` しか受け取らない）。

つなぐ先を `/textonly` ではなく `/` にするのは、`/textonly` が本文だけのプレーンテキストを返し、重複を防ぐ鍵（`MsgID`）が読めないためである。読むのは母国語（`Text1`）だけで翻訳（`Text2`〜`Text6`）は捨てる（あらすじに要らない）。

中継ページもOBSに載せるページの約束どおりReactもログインも持たず、オーバーレイ用キー（`?key=`）でWorkerに受け付けてもらう。通信を伴わない変換（`message.ts`）とWorkerの呼び出し（`api.ts`。`fetch` を差し替えてテスト）を、WebSocketとDOMを扱う部分（`connection.ts`・`view.ts`・`stage.ts`）から分ける。

## 送らない1件

**暫定の認識（`TextFixed` が偽）は送らない**（何度も書き換わるため）。

**`isDeleted` が真の1件も送らない。** 公式ドキュメントの「実際に消えるタイミングは、`isDeleted` が `true` の別のデータで通知されます」のとおり、これは表示の残り時間（`KeepTime`）が尽きて字幕が消えるときにも届く通常の知らせで、編集者による取り消しと区別できない。取り消しとして扱って記録を消していたため、確定した発話が数秒後にすべて消え、あらすじとサイドスーパーの材料が残らなかった。まれな編集者の取り消しが材料に残るほうを受け入れる（そのため取り消しの受け口は持たない）。

ゆかコネNEO は確定した1件も表示の残り時間（`KeepTime`）を減らしながら繰り返し押し出してくるので、`nextTranscriptState` が送った `MsgID` を覚えて二度目からは送らない。送信に**やり直せる失敗**（`isRetryable`）で失敗した発話は覚えているものから外す（`forgetTranscript`）ので、次に同じ1件が押し出されたときにひとりでに送り直される（やり直しの仕掛けを別に作らない）。本文やキーの誤り（4xx）は送り直しても同じ答えになるので忘れず、押し出しのたびに同じ失敗を繰り返さない（`src/transcript/task.ts` の `startTranscript`）。

## 受け口と保存

受け口は `POST /api/overlay/transcript`（`worker/overlay-routes.ts`。`requireOverlayKey` で守る）、保存は `worker/transcript-store.ts`（`transcripts`。`migrations/0009_transcripts.sql`）である。

**配信中の区切り（`stream_sessions` の `ended_at IS NULL` の行）が無ければ1行も書かず**、捨てたことを応答（`{ recorded: false }`）で中継ページに知らせる（配信の前後に開きっぱなしにするのが普通の使い方なので、捨てるのを失敗にしない）。

結びつけ方は `stream_chat_messages` と同じ1文で、再送は `message_id`（ゆかコネNEO の `MsgID`）の主キーで弾く。同じ `MsgID` で二度呼ばれてもどちらにも `true` を返す（`claimFirstChatOfStream` と同じ考え方である）。

古い行は cron（`worker/collect.ts`。1日より前。配信中の区切りのぶんは残す）が消す。あらすじ（issue #65）の材料にするための一時的な記録なので、配信後には残さない。

## アプリのページで Web Speech API を動かす（issue #189）

ゆかコネNEO が使っている音声認識は Chrome の Web Speech API（「ブラウザ音声認識」）なので、同じものを HDAD のアプリのページで直接動かし、PCに常駐させるもの（ゆかコネNEO と中継の `transcript/relay/`）をなくす。Soniox などの有料の認識を見送った経緯は issue #188〜#192 にある。OBS 内蔵の CEF では Web Speech API が使えないので、認識は Chrome で開いたアプリのページが受け持つ。

**認識はページではなくアプリの枠（`src/app/app.tsx` の `Shell`）が持つ**（`src/transcript/recognition-context.tsx`）。アプリのページはどれも1つの React アプリで、ページを移っても読み込み直さない（`src/app/router.tsx`）ので、枠に置けばどのページを見ていても認識が続く。独立した認識のページにすると、配信中にそのページを開いたままにしておく必要があり、ダッシュボードやコメントのページを見ているあいだ止まってしまう。オン・オフと詳しい様子はコネクターのページの区画（`src/transcript/recognition-section.tsx`）に置き、サイドバーにはオンのあいだだけ状態（`src/transcript/recognition-status.tsx`）を出す（どのページを見ていても、途切れたことに気づけるようにするため）。

- **オン・オフはこのブラウザの localStorage に覚える**（`hdad:transcript-recognition`）。Worker に保存すると、別の端末（スマートフォンなど）で HDAD を開いたときにそこでも認識が始まってしまう
- **認識するのはタブ間の鍵（Web Locks の `hdad-transcript-recognition`）を取れた1つのタブだけにする**。2つのタブが同時に認識すると、同じ発話が別々のメッセージIDで二重に記録される。鍵を待つタブは、認識しているタブが閉じられたら代わりに始める。ほかのタブでのオン・オフは `storage` の出来事で知り、合わせる
- **途切れたらタイマーを挟まずすぐ `start()` を呼び、`getUserMedia` でマイクを開いたままにする**（`src/transcript/recognizer.ts`）。裏に回したタブではタイマーが抑えられてつなぎ直しが遅れ、マイクを使っていないタブは Chrome に凍らされるためである（issue #188 で見立てた対策）。マイクの許可がない・言語が使えないなどの失敗では始め直さず止める。始め直しが1分に30回を超えたときも止める（通信が切れていると、始めてもすぐ終わるのを繰り返して回り続けるため）
- 黙っているだけでも Chrome は数秒ごとに認識を終えるので、つなぎ直しが5秒を超えて戻らないときだけ「途切れています」と出す（`src/transcript/recognition-label.ts`）。つなぎ直すたびに警告を出すと見慣れて見落とす

### 受け口と重複を防ぐ鍵

**受け口はセッションで守る `POST /api/admin/transcripts`（`worker/transcript-routes.ts`）を足す**。ログインしたアプリのページから送るので、オーバーレイ用キーをページに持たせる理由がない。本文の検証と記録は `receiveTranscript` に集め、ゆかコネNEO からの `POST /api/overlay/transcript` もそれを通す（同じ検証を2か所に書かない）。

**メッセージIDは確定した1件ごとに `webspeech:` の後ろへ `crypto.randomUUID()` を付けて作る**（`src/transcript/delivery.ts`）。Web Speech API の結果には ゆかコネNEO の `MsgID` にあたる識別子が無い。認識の区切りと結果の番号を組み合わせる案もあったが、つなぎ直すたびに番号が0から振り直されるので区切りの識別子も持ち回る必要があり、1件ごとに振るほうが単純である。`webspeech:` の印は、並べて動かしているあいだ ゆかコネNEO の `MsgID` と重ならないためである。

ゆかコネNEO と違って同じ1件を押し出し直してくれる相手がいないので、送り直しはページが行う（通信の失敗と 5xx だけを、2秒・5秒・15秒待って同じIDで送り直す。4xx は同じ答えになるので送り直さない）。


## ゆかコネNEO の中継を消した（issue #192）

アプリの枠の音声認識（issue #189）・字幕（issue #190）・翻訳（issue #191）がそろい、HDAD だけで認識・字幕・翻訳の字幕を出せるようになったので、**ゆかコネNEO からの中継を消した**。PC に常駐させるもの（ゆかコネNEO と OBS に置く中継）をなくし、Chrome のウィンドウ1つにするのがねらいである（`docs/principles.md` の方針12）。

消す前に、消してよいと判断する条件を issue #192 に決めた。

- 実配信3回以上で、HDAD の認識が配信の終わりまで途切れずに続いた（途切れても自動でつなぎ直り、配信者が操作しなくてよかった）
- 字幕と翻訳の字幕を、ゆかコネNEO なしで出せた
- あらすじ・章・サイドスーパーの材料（`transcripts`）が、ゆかコネNEO のときと同じ程度に残った

消したもの:

- 中継そのもの（`src/transcript/` の `task.ts`・`connection.ts`・`message.ts`・`stage.ts`・`view.ts`・`url.ts`・`transcript.css`、単独ページ `transcript/relay/`）
- 受け口 `POST /api/overlay/transcript`。送り手が1つになったので、2つの入口で共有していた `receiveTranscript` も `postAdminTranscript` へ畳んだ
- 裏方の `?transcript=`・`?host=`・`?port=` と、コネクターのページの ゆかコネNEO の印とポートの入力欄

**裏方のURLに読み替えを残さない**。`?transcript=false` や `?port=` を含むURLを貼ったままのブラウザソースは、未対応のパラメータとしてページ全体にエラーを出す（`src/core/params.ts`）。既定のまま（ゆかコネNEO に印を付けたまま・既定のポート）コピーしたURLにはどちらも含まれないので、そのまま動く。黙って読み飛ばすと、中継が動かなくなったことに気づけないまま配信してしまう。

メッセージIDの `webspeech:` の印は残した。中継が記録した `MsgID` と重ならないために付けたものだが、送り手が1つになっても IDの出所が読めて困ることはなく、外すと既存のテストと記録の見え方を変えるだけになる。
