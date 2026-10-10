---
paths:
  - "src/kanji-quiz/**"
  - "worker/kanji-quiz-*.ts"
  - "src/admin/kanji-quiz-card.tsx"
---

# 漢字クイズ（チャンネルポイントで出題する、熟語の読みのクイズ）

視聴者がチャンネルポイントを交換すると、熟語の読みを問う漢字クイズを合成ページに流す（issue #293 の段階1・#300）。流すきっかけはトリガーの動作 `kanjiQuiz`（チャンネルポイントの行だけ。`worker/alert-config.ts` で保存時に拒む）と、トリガー画面の試し再生（`POST /api/admin/kanji-quiz/demo`）。段階1は回答の判定（#301）と配信の停止（#302）を持たない。

- 問題は自前の問題集 `src/kanji-quiz/problems.json` だけから出す。LLM・辞書からその場で作らない（正答の判定が配信の強制終了に直結するため、読みの誤りを配信者が目で潰す）。1問は熟語・正解の読み（ひらがなだけ。複数可）・級・解説を持つ。LLM に下書きさせてもよいが、入れる前に配信者が確かめる
- `readings` の先頭は想定する読みで、問題の級は、熟語の中で最も上の級の字と、先頭の読みが出題される級（中学で習う読みは4級以上、高校で習う読みは準2級以上）のうち高いほうにする。字の級だけで決めない。2つ目以降には、辞書が見出しに挙げるほかの読みをすべて入れる（漏れると正しく答えても不正解になる）。2つ目以降は、級より上で習う読みでも正解として受け付けるために入れるもので、級を決めない。確かめるときは漢検協会の「漢字ペディア」で字ごとの級と読みの「中」「高」の印を引く
- 級は 10級〜1級（準2級・準1級を含む）の12段階で、識別子（`10`〜`1`・`pre2`・`pre1`）と画面の言い方は `src/kanji-quiz/grade.ts` だけが持つ。級は問題ごとに手で付け、推定させない（漢検の級別漢字表に機械で読める公開データが無いため）
- 問題集の形（読みがひらがなだけ・級が既知の値・熟語の重複なし・どの級にも1問以上）は `src/kanji-quiz/problems.test.ts` が確かめる。読み取りは `problems.ts` の `readKanjiQuizProblems`（Worker も合成ページもこれを通す）
- Worker が級から1問を選び（`worker/kanji-quiz-call.ts` の `pickKanjiQuizProblem`。その級の問題が無ければ投げ、ほかの級から出さない）、交換した人の表示名と一緒に `AlertChannel` の目印 `kanjiQuiz` の接続へ押し出す。押し出しの失敗は `kanji-quiz-push-failed`。試し再生は出題させた人を持たない（`requesterName: null`）
- 級の一覧と問題集は Worker から `src/kanji-quiz/` を読み込む（ポモドーロの `phase.ts` と同じ例外。2か所に書き分けないため）。そのため `grade.ts`・`problems.ts` は DOM と `src/core/` に頼らない
- 演出は流しはじめてからの経過時間だけから決める（`scene.ts` の `kanjiQuizSceneAt`）。級 → 熟語が奥から近づく（倍率を `ctx.scale` に渡す）→ 制限時間（`ANSWER_LIMIT_MS`。熟語が出たときから数え、最後の `COUNTDOWN_SECONDS` 秒は大きく出す）→ 正解の読みと解説。文言は `captions.ts`、描画は `view.ts`（テストを持たない）
- 合成ページの素材の種類は `kanjiQuiz`（`src/overlay/stage.ts` の `mountKanjiQuiz`）。届いた順に1件ずつ流す。プレビューでは `demo.ts` の決まった出題を順にくり返し流す
- 音は段階1では扱わない

経緯は `docs/decisions/kanji-quiz.md`、使い方は `docs/guide/kanji-quiz.md`。
