# 広告の開始と終了（`AdBreakTimer`）

広告（`adBreakBegin`・`adBreakEnd`）もメニュー項目に選べる（文言には広告の長さを差し込む `{duration}` が使える）。

**Twitchには広告の終了に相当する通知が無い**（届くのは開始だけで、そこに長さ（`duration_seconds`）が入っている）。

そのため `adBreakEnd` が展開される `channel.ad_break.end` はTwitchの通知ではなくWorkerが作る擬似イベントで、購読の一覧（`eventsub.ts` の `EVENT_TYPES`）には入らない。

開始を受けた時点で「終わる時刻」（`started_at` + 長さ）を Durable Object（`worker/ad-break-timer.ts` の `AdBreakTimer`。バインディングは `AD_BREAKS`）へ預け、`storage.setAlarm` で起こしてもらってから照合へ回す。

cron（5分おき）では広告（30〜180秒）に間に合わず、応答のあとに待つ手（`Context.waitUntil`）ではどれだけ待てるか保証されないためである。

**この Durable Object は時計であって判定者ではない**（`AlertChannel` が配送者に徹しているのと同じ理由で、設定はアラームが鳴るたびにKVから読み直す）。

預ける中身は開始の通知の `event` そのままで、`extract` は広告の開始と終了を同じ形で読む（終了のときに読む材料はほかに無い）。

終了のトリガーが1件も無ければ預けない（鳴らす先の無いタイマーで Durable Object を起こさない。`hasAlertAction` と同じ考え方）。

予約は1件だけ持ち、鳴ったら消してから実行する（アラームの再試行で同じ告知を二度送らないため。送信そのものの二重防止は `reserveChatReply` の鍵 `<メッセージID>:ad-end:<動作>` が受け持つ）。

予約に失敗してもTwitchへは2xxを返し、`ad-break-end-schedule-failed` として記録する（2xx以外だと再送で開始の告知が二度送られ、終了の告知が1回出ないことより悪い）。

アラームには応答を待たせる相手がいないので、`aiChat` のために後回しにされた処理もそこで待ち切る。

アラームが鳴ってからの失敗は投げずに `ad-break-end-failed` として記録する（予約を消したあとなので、投げて再試行させても空振りし、失敗が誰にも届かないまま消える。`alert-actions.ts` の `recordLateFailure` を共有する）。

広告の購読には配信者の `channel:read:ads` が要るため、**スコープが増えた＝配信者のログインし直しが必要**である。

テストでは保管とアラームを差し替え（`worker/ad-break-timer.test.ts`）、Workerからの予約は `worker/fake-ad-break-timer.ts` で確かめる
