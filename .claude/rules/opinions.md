---
paths:
  - "src/opinions/**"
  - "worker/opinion*.ts"
  - "worker/webhook-routes.ts"
  - "worker/comment-feed.ts"
  - "worker/alert-channel.ts"
  - "worker/ad-break-timer.ts"
  - "migrations/*opinion*.sql"
---

# 意見ボード（`/opinions/`・素材の種類 `opinions`）

意見ボードは、配信者が出したテーマについて視聴者がチャットに書いたコメントから LLM が意見を取り出し、論点（観点）ごとに並べて映す機能（issue #306。いどばたビジョンにならう。続きは #307 観点の提案・#308 取りこぼしの救い出しと論点の統合・#309 配信後のまとめ）。**多数決に見せない**: 合成ページへは人数を渡さず（`readOverlayBoard`）、論点の大きさ・並びを人数で変えず（6つの同じ枠に作った順。論点の中は新しい順）、意見は賛否ではなく札の種類（`OPINION_KINDS`: 課題・解決策・問い・気づき）で区別する。中央の「いま紹介している意見」は人数ではなく作った順に回す（`src/opinions/entry.ts` の `spotlightAt`）。人数は管理画面（`readAdminBoard`）にだけ出す。

テーマ・論点・意見・コメントは D1（`migrations/0033_opinions.sql`）に持ち、読み書きは `worker/opinion-store.ts` だけが行う。開いているテーマは1つだけで、開くときの確かめは1つの文で行う（`openTheme`）。締め切ったテーマも、次を開くまで合成ページに映し続ける（最後に開いたテーマを読む）。

コメントは、チャットの受け口（`worker/webhook-routes.ts` の `recordOpinionCommentFromChat`。自動モデレーションと `stream_chat_messages` の記録のあと）が、テーマを開いているときだけ貯める（出していなければ通知の断片も読み解かない）。断片と返信先の読み取りはコメントビューアーと共有する（`worker/comment-feed.ts` の `readChatBody`）。コマンド・エモートだけ・短い反応は規則で落とし（`worker/opinion.ts` の `dropReasonOf`。返信は短くても落とさない）、理由を付けて `dropped` として残す。失敗は投げずに `opinion-record-failed` として記録する。

振り分けは `AdBreakTimer` の別のインスタンス（名前 `opinions`。`worker/opinion-timer.ts`）のアラームが、テーマを開いているあいだ `OPINION_SORT_INTERVAL_MS`（45秒）ごとに1回分（`worker/opinion-run.ts` の `runOpinionSorting`）を進める。同じ人が `MERGE_GAP_MS`（20秒）以内に続けて書いたコメントは1つの発言につなげ、続きを待つ（`readyUtterances`）。渡せる発言が無ければ LLM を呼ばない。LLM（箇所 `opinionSort`。`worker/opinion-sort.ts`）には、いまの論点と意見（隠したものも含む）と新しい発言をラベル（C・T・O）付きで渡し、発言ごとに ignore・join・new を返させる。過去の振り分けは作り直さない。**返事は `parseOpinionSorting` だけが照合し**（発言の漏れ・重なり・知らないラベル・種類・文字数・論点の数）、外れたら切り詰めず補わずに拒む。拒んだ回と LLM を呼べなかった回の発言は `failed` にして `opinion-sort-failed` を記録する（振り分け待ちに残さない）。振り分けの結果は `applySorting` が1つの batch で書く（作った意見は `first_comment_id` で指す）。

開く・締め切る・振り分ける・隠すたびに、意見ボードを丸ごと `AlertChannel` の目印 `opinions`（`pushOpinions`・`connectOpinionSocket`）で押し出す。経路（`worker/opinion-routes.ts`）の押し出しの失敗は保存を取り消さずに502（`opinion-push-failed`）、振り分けの押し出しの失敗は `opinion-push-failed` として記録する。合成ページ（`src/overlay/stage.ts` の `mountOpinions`）は開いたとき・つながるたび・5分おきに `GET /api/overlay/opinions` で読み直し、読んでいるあいだに押し出しが届いたら読んだ結果は捨てる（作業机と同じ）。表示は `src/opinions/view.ts`（札は意見のIDごとに使い回す）、見た目は `src/opinions/opinions.css`。

アプリのページ（`/opinions/`。`src/opinions/opinion-page.tsx`）は、テーマの開始と締め切り（確かめてから）、意見の隠す・戻す、意見ごとの人数ともとのコメントを出し、15秒おきに読み直す。入力しかけのテーマがあるあいだは `useUnsavedChanges(true)` を呼ぶ。→ `docs/decisions/opinions.md`

利用者向けの説明は `docs/guide/opinions.md`。
