# 設計判断の記録

`.claude/CLAUDE.md` には**いま守るべき約束**だけを置き、「なぜ別の案を採らなかったか」「どの失敗を踏んでこうなったか」はここに置く。コードにもコミットメッセージにも残らない判断を、あとから読み返せるようにするためである。

約束を変えたときは `.claude/CLAUDE.md` を直し、変えた理由を対応するファイルに足す。

| ファイル | 話題 |
|---|---|
| [chat.md](chat.md) | チャットボックス（`chat/`） |
| [alerts-overlay.md](alerts-overlay.md) | アラートの配送（`alerts/` と `AlertChannel`） |
| [alerts-triggers.md](alerts-triggers.md) | トリガーの既定メニューと照合 |
| [alerts-actions.md](alerts-actions.md) | トリガーの動作（chat・aiChat・announce・shoutout） |
| [ad-break.md](ad-break.md) | 広告の開始と終了（`AdBreakTimer`） |
| [transcript.md](transcript.md) | 配信中の文字起こし（`/transcript/`） |
| [stream-summary.md](stream-summary.md) | これまでのあらすじ（`{summary}`） |
| [viewers.md](viewers.md) | 視聴者の記録（`/viewers/`） |
| [side-super.md](side-super.md) | サイドスーパー（`/side-super/`） |
| [focus.md](focus.md) | 注目コメント（`/focus/`） |
| [overlay-stage.md](overlay-stage.md) | 素材を重ねる合成ページ（`overlay/stage/`） |
| [overlay-editor.md](overlay-editor.md) | 構成を編集する管理画面（`/overlay/`） |
| [speech.md](speech.md) | チャットの読み上げ（`speech/reader/`） |
| [backstage.md](backstage.md) | 裏方をまとめたページ（`overlay/backstage/`） |
| [llm.md](llm.md) | LLMの呼び先・使用状況・モデルの選択 |
| [triggers-page.md](triggers-page.md) | トリガーの管理画面（`/triggers/`） |
| [bot.md](bot.md) | チャットボット（`/bot/`） |
| [worker.md](worker.md) | Worker（`worker/`）と失敗の記録 |

いずれも 2026-09-28 に `.claude/CLAUDE.md` の「構成上の約束」から原文のまま切り出したもので、文面は issue ごとに積み上がった当時の記述である。
