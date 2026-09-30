---
paths:
  - "worker/stream-summary*.ts"
  - "worker/collect.ts"
  - "worker/chat-command.ts"
  - "worker/alert-event.ts"
  - "worker/webhook-routes.ts"
---

# これまでのあらすじ（`{summary}`）

配信の「これまでのあらすじ」（`{summary}`）は cron（`worker/collect.ts` の `summarizeStream`）が5分おきに作り、`stream_summaries` に貯める。毎回ゼロから作り直さず前回のあらすじに積み上げ（`worker/stream-summary.ts` の `buildStreamSummaryPrompt`）、どこまでを材料にしたかは材料ごとに日時とメッセージIDの組で持つ（画面に新しく現れた文字（`screen_lines`）だけは、篩を通して積んだ時刻・画像ID・1枚の中の並びの組。`.claude/rules/screen.md`）。配信者の発話（`transcripts`）が1件も無ければ、視聴者の発言や画面の文字があっても作らない。出し方は差し込み語で、`{summary}` を含む文言があるときだけ読み出す（トリガーでは、文言を持たない `aiChat` の動作があるときも材料として読む。`worker/alert-event.ts` の `requiresStreamSummary`）。あらすじを作り直せた回には、そのあらすじを材料に BGM の自動の切り替え（`.claude/rules/bgm.md`）も呼ぶ（`summarizeStream` は作り直したあらすじを返す）。→ `docs/decisions/stream-summary.md`

利用者向けの説明は `docs/guide/bot.md` の「これまでのあらすじ」。
