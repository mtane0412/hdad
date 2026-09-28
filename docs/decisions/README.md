# 設計判断の記録

`.claude/CLAUDE.md` には**いま守るべき約束**だけを置き、「なぜ別の案を採らなかったか」「どの失敗を踏んでこうなったか」はここに置く。コードにもコミットメッセージにも残らない判断を、あとから読み返せるようにするためである。

約束を変えたときは `.claude/CLAUDE.md` を直し、変えた理由を対応するファイルに足す。

ここに並ぶ判断を読み直して、繰り返し現れているものを言葉にしたのが [開発方針](../principles.md) である。新しい判断がその並びのどれかと衝突するときは、どちらを直すかをまず決める（方針のほうを直したら、根拠にしている判断の行き先も足す）。

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
| [side-super.md](side-super.md) | サイドスーパー（素材の種類 `sideSuper`） |
| [focus.md](focus.md) | 注目コメント（`/focus/`） |
| [overlay-stage.md](overlay-stage.md) | 素材を重ねる合成ページ（`overlay/stage/`） |
| [overlay-editor.md](overlay-editor.md) | 構成を編集する管理画面（`/overlay/`） |
| [speech.md](speech.md) | チャットの読み上げ（`speech/reader/`） |
| [backstage.md](backstage.md) | 裏方をまとめたページ（`overlay/backstage/`） |
| [llm.md](llm.md) | LLMの呼び先・使用状況・モデルの選択 |
| [triggers-page.md](triggers-page.md) | トリガーの管理画面（`/triggers/`） |
| [dashboard.md](dashboard.md) | ダッシュボード（`/`） |
| [bot.md](bot.md) | チャットボット（`/bot/`） |
| [worker.md](worker.md) | Worker（`worker/`）と失敗の記録 |
| [docs.md](docs.md) | 利用者向けの説明の置き場（`README.md` と `docs/guide/`） |

各ファイルは「約束」ではなく「その約束にした理由」を書く場所である。読み手が1ファイルだけを読んで分かるように、話題が複数あるときは `##` の見出しで分け、地の文は文どうしをつなげて書く（`.claude/CLAUDE.md` の箇条書きをそのまま並べない）。
