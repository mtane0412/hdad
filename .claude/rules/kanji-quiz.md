---
paths:
  - "src/kanji-quiz/**"
  - "worker/kanji-quiz-*.ts"
  - "src/admin/kanji-quiz-card.tsx"
---

# 漢字クイズ（チャンネルポイントで出題する、熟語の読みのクイズ）

視聴者がチャンネルポイントを交換すると、熟語の読みを問う漢字クイズを合成ページに流し、チャットの回答を判定し、時間切れなら猶予のあと配信を止める（issue #293 の段階1・#300、段階2・#301、段階3・#302）。流すきっかけはトリガーの動作 `kanjiQuiz`（チャンネルポイントの行だけ。`worker/alert-config.ts` で保存時に拒む）と、トリガー画面の試し再生（`POST /api/admin/kanji-quiz/demo`）。

- 問題は自前の問題集 `src/kanji-quiz/problems.json` だけから出す。LLM・辞書からその場で作らない（正答の判定が配信の強制終了に直結するため、読みの誤りを配信者が目で潰す）。1問は熟語・正解の読み（ひらがなだけ。複数可）・級・解説を持つ。LLM に下書きさせてもよいが、入れる前に配信者が確かめる
- `readings` の先頭は想定する読みで、問題の級は、熟語の中で最も上の級の字と、先頭の読みが出題される級（中学で習う読みは4級以上、高校で習う読みは準2級以上）のうち高いほうにする。字の級だけで決めない。2つ目以降には、辞書が見出しに挙げるほかの読みをすべて入れる（漏れると正しく答えても不正解になる）。2つ目以降は、級より上で習う読みでも正解として受け付けるために入れるもので、級を決めない。確かめるときは漢検協会の「漢字ペディア」で字ごとの級と読みの「中」「高」の印を引く
- 級は 10級〜1級（準2級・準1級を含む）の12段階で、識別子（`10`〜`1`・`pre2`・`pre1`）と画面の言い方は `src/kanji-quiz/grade.ts` だけが持つ。級は問題ごとに手で付け、推定させない（漢検の級別漢字表に機械で読める公開データが無いため）
- 問題集の形（読みがひらがなだけ・級が既知の値・熟語の重複なし・どの級にも1問以上）は `src/kanji-quiz/problems.test.ts` が確かめる。読み取りは `problems.ts` の `readKanjiQuizProblems`（Worker も合成ページもこれを通す）
- トリガーの動作は級ごとの出題の重み（`weights`。12の級すべてに0〜100の整数、1つ以上が1以上。判定は `grade.ts` の `isKankenGradeWeights`）を持つ。級1つだけの古い形（`grade`）は `worker/alert-config.ts` の `withKanjiQuizWeights` が読み出しのときだけ重みに読み替え、保存では受け付けない。試し再生は級を1つ選び、`singleGradeWeights` で同じ選び方を通す
- Worker が重みに沿って級を選び、同じ配信で出した回数がいちばん少ない1問を選び（`worker/kanji-quiz-call.ts` の `pickKanjiQuizProblem`。重みのある級の問題が無ければ投げ、ほかの級から出さない）、出題の行を D1 の `kanji_quizzes` に入れてから、交換した人の表示名と一緒に `AlertChannel` の目印 `kanjiQuiz` の接続へ押し出す（`worker/kanji-quiz-issue.ts` の `issueKanjiQuiz`。交換と試し再生の両方がこれを通す）。押し出しの失敗は `kanji-quiz-push-failed`。試し再生は出題させた人を持たない（`requesterName: null`）
- 同じ配信（`stream_sessions` の配信中の区切り）で選んだ熟語は選ばない（回数は `kanji-quiz-store.ts` の `readKanjiQuizWordCounts`）。試し再生で出したものも数え、配信していなければ外さない。出した回数がいちばん少ない問題だけを候補にするので、出し終えた級は外れて残りの級の重みで選び、重みのある級をすべて出し終えたら一巡する（失敗にしない）
- 出題の行は Worker が選んだときに入れ（受付期限は空）、合成ページが流しはじめたら `POST /api/overlay/kanji-quiz/open` で開く（熟語は合成ページから受け取らない）。受け付けるのは熟語が出てから（開いて `GRADE_INTRO_MS` 後）、制限時間に遅れの余裕（`KANJI_QUIZ_GRACE_MS`）を足したところまで。読み書きは `worker/kanji-quiz-store.ts`
- 回答の照合は `worker/kanji-quiz-answer.ts` だけが持つ（前後の空白を除き、カタカナをひらがなに直して、問題集の読みと完全一致。部分一致・ローマ字は受けない）。Webhook（`worker/webhook-routes.ts` の `replyToChatMessage`）は、問題集の読みと一致した発言でだけ D1 を読み、最初の正解者を RETURNING で1人に決めて `type: 'answer'` で同じ接続へ押し出す。配信者の発言も受ける。照らす処理の失敗は黙って不正解にせず `kanji-quiz-answer-failed` として記録し、チャットのほかの処理を続ける
- 級の一覧と問題集は Worker から `src/kanji-quiz/` を読み込む（ポモドーロの `phase.ts` と同じ例外。2か所に書き分けないため）。そのため `grade.ts`・`problems.ts` は DOM と `src/core/` に頼らない
- 演出は流しはじめてからの経過時間と正解者が届いた時刻だけから決める（`scene.ts` の `kanjiQuizSceneAt`）。級 → 熟語が奥から近づく（倍率を `ctx.scale` に渡す。制限時間のあいだ一定の速さで近づきつづけ、時間切れで等倍）→ 制限時間（`ANSWER_LIMIT_MS`。15秒。熟語が出たときから数え、最後の `COUNTDOWN_SECONDS` 秒は大きく出す）→ 正解の読みと解説。正解者が届いたら届いた時刻でカウントダウンを止めて正解者の名前と答えを出す。時間切れの後に届いた正解者は出さない（`acceptsAnswerAt`）。文言は `captions.ts`、描画は `view.ts`（テストを持たない）
- 合成ページの素材の種類は `kanjiQuiz`（`src/overlay/stage.ts` の `mountKanjiQuiz`）。届いた順に1件ずつ流す。押し出されたものの読み取りは `call.ts` の `parseKanjiQuizMessage`（出題は type を持たず、知らせは `answer`・`failure`・`stopping`・`stopCancelled`）。開けなかった・判定を予約できなかったときは素材の箱に出す。プレビューでは `demo.ts` の決まった出題を順にくり返し流し、出題を開かせない
- **時間切れの判定は Worker が持つ**（合成ページの数え方では止めない）。出題を開いたら（`POST /api/overlay/kanji-quiz/open`）受付の締め切りを `AdBreakTimer` の別のインスタンス（名前 `kanji-quiz`。中身は `worker/kanji-quiz-timer.ts`）へ預け、アラームで締め切りに正解者がいなければ停止を始めて猶予（`KANJI_QUIZ_STOP_GRACE_MS`。10秒）を `type: 'stopping'` で押し出し、猶予の終わりにもう一度鳴らして止める。時刻が来たときにすることは `worker/kanji-quiz-stop.ts` が持つ。失敗は投げずに `kanji-quiz-stop-failed` として記録する
- 停止の状態は `kanji_quizzes` の `stop_at`・`stop_cancelled_at`・`stop_sent_at`（`migrations/0032_kanji_quiz_stop.sql`）に持ち、始める・取り消す・鍵を確保するをそれぞれ「まだ書かれていない行」だけを書き換える1つの文で行う（取り消しと停止は一方しか通らず、同じ出題で2回止めない）。猶予を押し出せなければ始めた停止を戻し、止める時刻を仕掛けない（取り消せないまま止めない）
- 試し再生の出題は `rehearsal` を持ち、猶予の演出と取り消しまでは同じ道を通すが止めない（演出の最後に「止めません」と出すのは合成ページ）
- 止める命令は `AlertChannel` の目印 `streamStop` で裏方のページ（`?stop=true`。`src/kanji-quiz/stop-task.ts`）へ押し出し（裏方を2つ開いていても、送れた1つにだけ送る）、受け取る接続が1つも無ければ配送先が409を返して失敗として記録する。裏方は OBS（つなぎ先は画面の取り込みの設定）へ `StopStream` を送り、結果を `POST /api/overlay/kanji-quiz/stop/result` で知らせる（理由があれば記録）
- 猶予は時刻ではなく長さ（`graceMs`）で押し出し、合成ページと下部バーは届いた時刻から自分の時計で数える。合成ページは解説に重ねて帯を出し（`scene.ts` の `kanjiQuizStopBannerAt`。文言は `captions.ts` の `stopBannerLineOf`）、結果を出し終えるまで1回の出題を延ばす
- 下部バーの取り消しボタンは `src/kanji-quiz/stop-bar.tsx`（猶予のあいだだけ出す。猶予は出題ごとに持ち、尽きたものだけを外す）。合成ページと同じ押し出しにオーバーレイ用キーでつなぎ（`socket.ts`）、取り消しは `POST /api/admin/kanji-quiz/stop/cancel`（出題を指定せず、猶予のあいだのものをすべて取り消す）。接続と取り消しはアプリの枠から `KanjiQuizStopDeps` で受け取る
- 音は扱わない

経緯は `docs/decisions/kanji-quiz.md`、使い方は `docs/guide/kanji-quiz.md`。
