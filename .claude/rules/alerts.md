---
paths:
  - "src/alerts/**"
  - "worker/alert-*.ts"
  - "worker/trigger-menu.ts"
  - "worker/ad-break-timer.ts"
  - "worker/ai-chat.ts"
  - "worker/bot-chat.ts"
  - "worker/webhook-routes.ts"
---

# アラート（素材・トリガー・動作・広告）

アラートは合成ページの素材の種類 `alerts` として映す（アラート専用の単独ページは issue #107 で消した）。素材はTwitchへ直接つながない。判定はすべてWorkerが行い、当てはまったアラートだけを Durable Object（`worker/alert-channel.ts` の `AlertChannel`。配送者であって判定者ではない）経由で `GET /api/overlay/socket` の接続へ押し出す。`src/alerts/` は受け取った順に再生待ちの列（`queue.ts`）へ並べるだけで、トリガーも条件も知らない。組み立ては `src/overlay/stage.ts` の `mountAlerts`。→ `docs/decisions/alerts-overlay.md`

トリガーは「既定メニューの項目」（`worker/trigger-menu.ts` の `TRIGGER_KINDS`。13種類）と「動作」（`worker/alert-config.ts` の `actions`）からなり、イベント種別と条件を自由に組み合わせる形は採らない。項目からイベント種別と条件への展開は `expandSource` だけが行い、照合（`worker/alert-event.ts` の `matches`）は展開後の形しか見ない。挨拶（`GREETING_KINDS`）は1通の発言に最も細かい1つだけが当てはまる。通知の中身から決まらない条件は呼び出し側が調べて `ConditionState` として渡す（`worker/alert-state.ts`）。保存済みの設定が古い形なら `loadAlertConfig` が読み替えずにエラーにする。→ `docs/decisions/alerts-triggers.md`

当てはまった行はすべて実行する（`worker/alert-event.ts` の `matchedActionsFor`）。実行は `worker/alert-actions.ts` の `runAlertActions` に集め、再送での二重実行は `reserveChatReply`（鍵に動作の種類と当てはまった順の位置を混ぜる）で防ぐ。`alert` は合成ページの素材が再生し、`chat`・`aiChat`・`announce`・`shoutout` はWorkerがbotとして送る（`shoutout` はレイドのトリガーにだけ置ける）。`aiChat` は `worker/ai-chat.ts` が材料を組み立ててLLMに文面を作らせ、返ってきた文面は検分する。Twitchへ2xxを返したあとの失敗は `recordLateFailure` が記録する。→ `docs/decisions/alerts-actions.md`

広告の終了に相当する通知はTwitchに無いので、`channel.ad_break.end` はWorkerが作る擬似イベントである。開始を受けたら終わる時刻を Durable Object（`worker/ad-break-timer.ts` の `AdBreakTimer`。時計であって判定者ではない）へ預け、`storage.setAlarm` で起こしてもらってから照合へ回す。→ `docs/decisions/ad-break.md`

利用者向けの説明は `docs/guide/alerts.md`（トリガーの決め方と素材のアップロードもここ）。
