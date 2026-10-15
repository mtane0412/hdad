---
paths:
  - "src/chat-deduction/**"
  - "worker/chat-deduction-*.ts"
  - "worker/reward-routes.ts"
  - "migrations/*chat_deduction*.sql"
---

# チャットで推理（`/chat-deduction/`）

視聴者がチャンネルポイントの「質問」（はい／いいえで答えられる問い）を繰り返して答え（人物・場所・出来事・もの）を絞り込み、「解答」で当てるゲーム。段階1（issue #375）は問題集の形・ゲームの開始と終了・報酬の作成と切り替え、段階2（#376）は質問の受け口と LLM の回答・上限・返金、段階3（#377）は解答の照合と正解での終了で、続きは #378（合成ページの素材）。参考にした既存のゲームの名前はリポジトリに書かない。

- 問題集は `src/chat-deduction/problems.json` だけが持ち、LLM にその場で作らせない。1問は ID（英小文字・数字・ハイフン）・区分・正解（画面の表記）・別名（解答の照合に使う）・事実メモ（質問に答える LLM の材料）を持つ。形の確かめは `problems.ts` の `readChatDeductionProblems`（問題集のテストは `problems.test.ts`）。区分の識別子と画面の言い方は `category.ts` だけが持つ。Worker もページも `problem-set.ts` の `CHAT_DEDUCTION_PROBLEMS` を読む（Worker から `src/` を読み込む例外。DOM と `src/core/` に頼らない）
- 視聴者の入口はチャンネルポイントの「質問」「解答」の2つの報酬だけにする。報酬は `/chat-deduction/` から HDAD が作り（`worker/chat-deduction-rewards.ts` の `createChatDeductionRewards`。交換できない・ユーザー入力あり・待ち行列に入れる形）、ID を KV の `chat-deduction-rewards` に控える。既存の報酬は選ばせない（Twitch が交換できるかどうかの切り替えを許すのは同じ Client ID で作った報酬だけのため）。「解答」を作れなければ作った「質問」を消してから投げる。必要ポイントと説明は `/rewards/` で変えられ、チャットで推理の報酬は `/rewards/` から消させない（`reward-in-use`）
- ゲームは D1 の `chat_deduction_games`（`migrations/0039_chat_deduction_games.sql`）に持ち、読み書きは `worker/chat-deduction-store.ts` だけが行う。開催中は1つだけで、開始の確かめは1つの文（`startGame`）で行う。終わり方（`end_reason`）は `stopped`（配信者が打ち切った）と `solved`（正解者が出た。#377）
- 開始（`POST /api/admin/chat-deduction/games`）は行を作ってから2つの報酬を交換できるようにする（`twitch.ts` の `setCustomRewardEnabled`。`is_enabled` だけを送り、配信者が変えたほかの項目を上書きしない）。切り替えに失敗したら行を消し（`cancelGame`）、報酬を交換できない状態へ戻してから502にする。戻せなかったことも黙らずメッセージに添える
- 終了（`POST /api/admin/chat-deduction/games/:id/end`）は先に2つの報酬を交換できないようにし、成功してから行を終える。切り替えに失敗したらゲームを開催中のまま残して502にする（交換できるまま終わったことにしない）
- 質問の受け口は `worker/chat-deduction-question.ts` の `handleChatDeductionRedemption`（`worker/webhook-routes.ts` がアラートのトリガーのあとに呼ぶ）。自分のチャンネルの「質問」の報酬の交換だけを受け、行は D1 の `chat_deduction_questions`（`migrations/0040_chat_deduction_questions.sql`）に持つ。交換のIDを鍵に行を作るのと、受け付けるかどうか（開催中のゲーム `no-game`・1問あたりの上限 `limit`・同じ人の待ち時間 `cooldown`）の判断を1つの文（`reserveQuestion`）で行い、行がもうあれば再送として何もしない。上限は定数 `CHAT_DEDUCTION_QUESTION_LIMITS`（30件・60秒）で、数えるのは答え待ちと答えた質問だけ（ポイントを返した質問は数えない）
- LLM（箇所 `chatDeductionAnswer`。`worker/chat-deduction-answer.ts`）と交換の更新は Twitch へ2xxを返したあと（`waitUntil`）に行う。材料は正解・区分・事実メモと質問だけ。**返事は `parseChatDeductionAnswer` だけが照合し**（2行・1行目が はい／いいえ／分からない・1文は `MAX_REPLY_LENGTH`（60文字）まで・1文に正解か別名を含まない）、外れたら切り詰めず補わずに拒む。答えられたら `answerQuestion` で書いて交換を FULFILLED、答えられなければ `failQuestion` で理由を残し `chat-deduction-answer-failed` を記録して CANCELED、受け付けなかった質問は LLM を呼ばずに CANCELED にする（`twitch.ts` の `updateRedemptionStatus`。返金を持たない `/rewards/` の方針の、この報酬に限った例外）。交換を更新するトークン（`getManageToken`）は LLM より先に取り、取れなければ LLM を呼ばずに答え待ちの質問を `failQuestion` で閉じる。交換を更新できなければ `chat-deduction-redemption-failed` を記録し、D1 の答えは書き戻さない
- 解答の受け口は `worker/chat-deduction-guess.ts` の `receiveChatDeductionGuess`（`handleChatDeductionRedemption` が「解答」の報酬の交換を振り分ける）。行は D1 の `chat_deduction_guesses`（`migrations/0041_chat_deduction_guesses.sql`）に持ち、交換のIDを鍵に行を作るのと開催中のゲームの確かめを1つの文（`reserveGuess`）で行う。**正誤は `src/chat-deduction/guess.ts` の `isCorrectChatDeductionGuess` だけが決め**（解答と別名の両方を `normalizeChatDeductionGuess` で揃えて完全一致。LLM は使わない）、正解なら `solveGame` が1つのトランザクションで正解者を1人に決めてゲームを `solved` で終える。照合までにゲームが終わっていた正解は `closed` で受け付けない。ゲームを終えてから2つの報酬を交換できないようにし（打ち切りの経路と逆の順。正解を報酬の切り替えの成否で取り消さない）、切り替えに失敗したら `chat-deduction-rewards-failed` を記録して交換の更新は続ける。正解・不正解は FULFILLED、受け付けなかった解答（`no-game`・`closed`）は CANCELED
- 経路は `worker/chat-deduction-routes.ts`。アプリのページは `src/chat-deduction/chat-deduction-page.tsx`（問題集を引数で受け取る）、Worker の呼び出しは `api.ts`。問題を選ぶ欄には正解が出る

経緯は `docs/decisions/chat-deduction.md`、使い方は `docs/guide/chat-deduction.md`。
