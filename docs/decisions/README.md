# 設計判断の記録

`.claude/CLAUDE.md` には**いま守るべき約束**だけを置き、「なぜ別の案を採らなかったか」「どの失敗を踏んでこうなったか」はここに置く。コードにもコミットメッセージにも残らない判断を、あとから読み返せるようにするためである。

約束を変えたときは `.claude/CLAUDE.md` を直し、変えた理由を対応するファイルに追加する。

ここに並ぶ判断を読み直して、繰り返し現れているものを言葉にしたのが [開発方針](../principles.md) である。新しい判断がその並びのどれかと衝突するときは、どちらを直すかをまず決める（方針のほうを直したら、根拠にしている判断の行き先も追加する）。

| ファイル | 話題 |
|---|---|
| [chat.md](chat.md) | チャットボックス（`chat/`） |
| [alerts-overlay.md](alerts-overlay.md) | アラートの配送（`alerts/` と `AlertChannel`） |
| [alerts-triggers.md](alerts-triggers.md) | トリガーの既定メニューと照合 |
| [alerts-actions.md](alerts-actions.md) | トリガーの動作（chat・aiChat・announce・shoutout） |
| [ad-break.md](ad-break.md) | 広告の開始と終了（`AdBreakTimer`） |
| [github-webhook.md](github-webhook.md) | GitHub の Webhook（開発の出来事をトリガーのきっかけにする） |
| [transcript.md](transcript.md) | 配信中の文字起こし（`/transcript/`） |
| [stream-summary.md](stream-summary.md) | これまでのあらすじ（`{summary}`） |
| [stream-chapters.md](stream-chapters.md) | 配信で何が話されたか（章。ダッシュボードの配信の詳細） |
| [stream-title.md](stream-title.md) | 配信タイトルの候補（試験運用。Twitch には書き込まず、候補と Jev の判定を記録する） |
| [viewers.md](viewers.md) | 視聴者の記録（`/viewers/`） |
| [side-super.md](side-super.md) | サイドスーパー（素材の種類 `sideSuper`） |
| [work-log.md](work-log.md) | 作業ログ（素材の種類 `workLog`） |
| [task-desk.md](task-desk.md) | 作業机（素材の種類 `taskDesk`。視聴者の `!task`・`!done`） |
| [text.md](text.md) | テキスト（素材の種類 `text`。配信者が自由に書いた文字） |
| [pomodoro.md](pomodoro.md) | ポモドーロ（`/pomodoro/`・素材の種類 `pomodoro`。区切りのトリガーと休憩中のBGM） |
| [town-tour.md](town-tour.md) | 市町村紹介（レイドとキーワードで流すランダムな市区町村。一覧と日本地図のデータ源・紹介の作り方・素材の流し方） |
| [twister.md](twister.md) | ツイスター（レイドで流す3Dのツイスターゲーム。物理を先に計算して再生する・指示の選び方） |
| [kanji-quiz.md](kanji-quiz.md) | 漢字クイズ（自前の問題集・級を手で付ける・チャンネルポイントにだけ置く） |
| [opinions.md](opinions.md) | 意見ボード（人ではなく意見を単位にする・多数決に見せない・振り分けを積み上げて照合する・アラームで刻む） |
| [comments.md](comments.md) | コメントビューアー（`/comments/`） |
| [focus.md](focus.md) | 注目コメント（素材の種類 `focus`） |
| [wipe.md](wipe.md) | ワイプ（素材の種類 `wipe`。チャットを1件ずつ出し、自分で読み上げる・裏方の読み上げとの二重読みの防ぎ方） |
| [overlay-stage.md](overlay-stage.md) | 素材を重ねる合成ページ（`overlay/stage/`） |
| [overlay-editor.md](overlay-editor.md) | 構成を編集する管理画面（`/overlay/`） |
| [speech.md](speech.md) | チャットの読み上げ（`speech/reader/`） |
| [screen.md](screen.md) | 配信画面の取り込み（`/screen/`） |
| [backstage.md](backstage.md) | 裏方をまとめたページ（`overlay/backstage/`） |
| [bgm.md](bgm.md) | BGM（`/bgm/`・裏方の `?bgm=true`） |
| [llm.md](llm.md) | LLMの呼び先・使用状況・モデルの選択 |
| [triggers-page.md](triggers-page.md) | トリガーの管理画面（`/triggers/`） |
| [rewards.md](rewards.md) | チャンネルポイント報酬（`/rewards/`） |
| [dashboard.md](dashboard.md) | ダッシュボード（`/`） |
| [bot.md](bot.md) | チャットボット（`/bot/`） |
| [page-ui.md](page-ui.md) | ページUIの枠（`src/app/`） |
| [webmcp.md](webmcp.md) | エージェント向けのツール（WebMCP） |
| [worker.md](worker.md) | Worker（`worker/`）と失敗の記録 |
| [docs.md](docs.md) | 利用者向けの説明の置き場（`README.md` と `docs/guide/`） |

各ファイルは「約束」ではなく「その約束にした理由」を書く場所である。読み手が1ファイルだけを読んで分かるように、話題が複数あるときは `##` の見出しで分け、地の文は文どうしをつなげて書く（`.claude/CLAUDE.md` の箇条書きをそのまま並べない）。
