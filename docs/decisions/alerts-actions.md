# トリガーの動作（chat・aiChat・announce・shoutout）

動作の種類ごとに実行者が違う。

`alert` はオーバーレイが再生し、`chat`・`aiChat`・`announce`・`shoutout` はWorkerがbotとして送る（`announce` は色の付いた帯で、botがモデレーターにされている必要がある）。

## aiChat（LLMに文面を作らせる）

`aiChat` は送る文言ではなく「どう書くか」の指示（`instruction`）を持ち、LLM（`worker/llm.ts`。呼び先は設定で決まる）へ `aiChat` の箇所として文面を作らせて送る。

材料の組み立てと応答の検分は `worker/ai-chat.ts` に分け、LLMを呼ばない `buildPrompt` をテストする。

材料は配信者の指示・イベントの中身（`Extracted`）・`ConditionState`（来訪の別。条件に書かれていなくても調べる）・その人の記録（`viewer-store.ts` の `readViewer`）・いま進んでいる配信のあらすじ（`streamSummary`。指示に書かれていなくても渡す。話の流れを知らないまま文面を作らせないため）で、記録を引く鍵はTwitchのユーザーIDなので、渡せるのはチャットの発言のときだけである（ほかのイベントでは記録なしとして作らせる）。

あらすじと記録は**材料であって指示ではない**ことをプロンプトで明示する（どちらも視聴者の発言を材料にLLMが作ったもので、指示のように書かれた文が混ざりうる）。

材料に書く「無いときの文言」は読み手が違うので視聴者向けのもの（`NO_STREAM_SUMMARY`）と分ける（`NO_STREAM_SUMMARY_MATERIAL`。`ai-chat.ts` から `stream-summary.ts` を読み込むと循環するため、語そのものも共有しない）。

`chat` と `aiChat` は同じトリガーに並べられない（同じ発言に2通返るため、`parseActions` が拒む）。

LLMの応答を待つとTwitchへの2xxが遅れて再送されるので、`Context.waitUntil`（本番では `ExecutionContext.waitUntil`）に預けて応答のあとに走らせる。

応答のあとの失敗は再送で取り返せないので、`recordLateFailure` が鍵の確保も含めて受け止めて記録する（ほかの動作は送信を待ってから応答するので、鍵の確保の失敗は5xxにして再送させればよい）。

**返ってきた文面は信用しない**。

500文字を超えていたら切り詰めずに送るのをやめ、LLMの失敗（無料枠切れを含む）も黙って固定文言に落とさず、どちらも `alert-aichat-failed` として記録する。

## 当てはまった行はすべて実行する

**当てはまった行はすべて実行する**（`worker/alert-event.ts` の `matchedActionsFor`）。

最初に当てはまった1件だけを採ると、固定で並ぶ一覧のうち絞り込みの緩い行（「誰かが発言した」）が細かい行（「初見さんが発言した」）を飲み込み、下の行が永久に動かないまま設定だけが残る（配信者が並び順で回避することになる）。

そのため同じ通知で同じ種類の動作が何度も走るので、再送での二重実行を防ぐ鍵には動作の種類だけでなく**当てはまった順の位置**も混ぜる（`<メッセージID>:<動作>:<位置>`）。

位置は当てはまった動作の並び順なので、同じ設定と同じ通知なら再送でも同じ鍵になる。

オーバーレイへは `alertsFor` が当てはまったトリガーの `alert` の動作だけを「1トリガー = 1アラート」の形にして順に返し、`pushMatchedAlerts` が順に押し出す（`src/alerts/` は動作を知らず、受け取った順に再生待ちの列（`queue.ts`）へ並べる。1つのトリガーが同じ種類の動作を1件までなのはこのため）。

チャットの発言もメニュー項目に選べる（`chat` ほか、視聴者の区分の6項目）。

`alert` の動作は、Workerが押し出す側なのでbotの接続と関係なく動く（`worker/webhook-routes.ts` はチャットの発言でも、botの接続の確認より前にアラートの判定を行う）。

一方 `chat`・`aiChat`・`announce`・`shoutout` は送り主のアカウントが要るため、botを接続しているときだけ動く。

この違いは `/triggers/` の画面で知らせる（`botApi.status()` で接続状態を読む）。

実行はどれも `worker/alert-actions.ts` の `runAlertActions` で、通知の中身の読み取り・照合・文言の差し込みは `worker/alert-event.ts` を通る（受け口から切り出してあるのは、Twitchから届かない擬似イベントを流す広告の終了のタイマー（`worker/ad-break-timer.ts`）からも同じ実行を通すためで、そのため受け取る文脈は `AlertActionContext` としてリクエストに関わる項目（`request`・`url`・`params`）を含まない形に絞っている）。

アラートの押し出しも再送での二重実行を `reserveChatReply`（鍵は `<メッセージID>:alert`）で防ぎ、失敗はTwitchへ2xxを返したうえで `alert-push-failed` として記録する。

素材のURLに付けるオーバーレイ用キーは、アラートを出す動作を持つトリガーがあるときだけKVから読む（`hasAlertAction`）。

## チャットとアナウンスの送信

チャットの送信は `worker/bot-chat.ts` の `sendAsBot`・`announceAsBot`・`shoutoutAsBot` に集め、再送での二重送信は `reserveChatReply` で防ぐ（鍵には動作の種類を混ぜる。混ぜないと、同じ通知でチャットとアナウンスの両方を送るときに片方しか送れない）。

アナウンスは2秒に1回しか送れないので、`announceAsBot` は送る前に `reserveAnnouncementSlot`（`worker/chat-store.ts`。`announcement_slots` に「次に送ってよい時刻」を1行持ち、SQLiteの `RETURNING` で枠を確保する）で自分の順番を取り、`Context.wait` でそこまで待ってから送る（別々の通知が2秒以内に続いても429で失われない）。

待ち時間の上限（4秒）を超えるほど詰まっていれば枠を確保せずに投げ、`alert-announce-failed` として記録する（待つあいだTwitchへ応答を返せないため）。

## シャウトアウト

`shoutout`（シャウトアウト。Twitch組み込みの、相手の配信者を紹介する機能。`worker/twitch.ts` の `sendShoutout`。`POST /helix/chat/shoutouts`）は**レイドのトリガーにだけ置ける**（`parseAlertConfig` が拒み、画面も `src/admin/form.ts` の `supportsShoutout` でレイドの項目にだけ入力欄を出す）。

ほかのイベントの相手は配信者とは限らず、紹介しても意味を持たないためで、すべての項目に出すと意味のない組み合わせを作れてしまう（既定メニューにした理由と同じ）。

配信者が決める項目を持たない動作なので、`StoredShoutoutAction` は `type` だけを持ち、紹介する相手はイベントの中身から決まる。

そのため `Extracted` のレイドに `userId`（`from_broadcaster_user_id`）を足してある。

当てはまった相手を返すのは `shoutoutsFor` で、レイド以外のイベントの `Extracted` が来たら黙って送らずに投げる（Fail-Fast。宛先にできる配信者がいないため）。

スコープは `moderator:manage:shoutouts` で、**増えた＝botの接続し直しが必要**である。

Twitchは間隔を制限している（同じチャンネルから2分に1回、同じ相手には60分に1回）が、**アナウンスのような送信枠の確保はしない**（待てば送れる2秒とは桁が違い、待つあいだTwitchへ応答を返せないため）。

制限に当たると429が返るので、ほかの動作と同じく2xxを返したうえで `alert-shoutout-failed` として記録する。
