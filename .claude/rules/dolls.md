---
paths:
  - "src/dolls/**"
  - "src/doll-award/**"
  - "worker/doll*.ts"
  - "worker/viewer-store.ts"
  - "src/viewers/**"
  - "migrations/*doll*.sql"
---

# 人形（`/dolls/`。視聴者が所持する人形）

視聴者に人形を渡し、所持させる仕組み（issue #418〜#420）。1組は「ふつうの人形」と「スーパー人形（ふつう3つ分の価値）」の2種類で、それぞれ名前と画像（R2 の素材。種類 image）を持つ。比 1:3 は定数で、設定項目にしない。1配信で使う組は「いまの人形」として1組だけ選ぶ（`doll_sets.current`。1 か NULL の UNIQUE）。手持ちは組ごとに配信をまたいで残り、**増減できるのはいまの人形だけ**である。番組名・キャラクター名はコード・docs・issue・PR に書かない。

所持は増減を1件1行で持つ台帳（`doll_ledger`。`migrations/0045_dolls.sql`）で持ち、所持数は合計から出す。鍵は Twitch のユーザーID だけで、`viewers` を指す外部キーにはしない（発言していない人にもトリガーで渡すため）。その代わり、増減のたびにその時点の表示名を `user_name`（`migrations/0047_doll_ledger_user_name.sql`。`DollChange` の `userName`）に控える。**台帳に書くのは `worker/doll-store.ts` の `changeDolls` だけ**で、手での増減・トリガー（#419）・ゲームの正解（#420）・今後の使い道はすべてここを通す。`changeDolls` は、いまの人形が無ければ `no-current-set`、減らすだけの所持数が無ければ `not-enough` の `DollChangeError` を投げて記録しない（0 で止めない）。確かめと書き込みは1つの文で行う。きっかけの ID（`source_id`）は UNIQUE で、同じ ID の増減は `duplicate` を返して2度記録しない（Twitch の再送への備え。手での増減は毎回 `manual:<UUID>` を振る）。記録した時点で配信中なら `session_id` を控え、配信外なら NULL のまま持つ。理由（`reason`）の種類と、理由ごとに控える項目は `worker/doll.ts` の `DollOrigin` が持ち、表の CHECK にはしない。

トリガーの動作 `dollGrant`（`{ kind, count }`。個数は 1〜`MAX_DOLL_CHANGE`）は、出来事を起こした視聴者に渡す。置けるトリガーは `worker/alert-config.ts` の `DOLL_GRANT_KINDS`（チャットの発言・チャンネルポイント・フォロー・サブスク・レイド。画面は `src/admin/form.ts` の `supportsDollGrant`）で、相手のユーザーIDは `worker/alert-event.ts` の `extract` が読む `userId`（`dollGrantsFor`）。実行は `worker/alert-actions.ts` の `grantMatchedDolls` が bot の接続を見る前に（`grantDolls` を通して）行い、きっかけの ID は `trigger:<通知のメッセージID>:dollGrant:<当てはまった順の位置>` にする（`reserveChatReply` は取らない）。理由は `trigger` で、どのトリガーの項目で渡したかを `trigger_kind`（`migrations/0046_doll_ledger_trigger_kind.sql`）に控える。渡せなければ（いまの人形が無いなど）`doll-grant-failed` を記録する。

チャットで推理と漢字クイズの正解者には、ゲームごとに選んだ人形（`{ kind }`。ふつう・スーパー・渡さない（`null`）。個数は1で固定）を渡す（issue #420）。ゲームの一覧は `worker/doll.ts` の `DOLL_PRIZE_GAMES` で、台帳の理由にもその名前（`chatDeduction`・`kanjiQuiz`）を書く。設定は KV の `doll-prize:<ゲーム>`（ゲームごとに鍵を分ける。未保存なら渡さない）、経路は `GET・PUT /api/admin/doll-prizes/:game`、渡すのは `worker/doll-prize.ts` の `grantDollPrize` だけで（`grantDolls` を通す）、きっかけの ID はゲーム・出題の ID から作る（`chatDeduction:<ゲームのID>`・`kanjiQuiz:<出題のID>`）。呼ぶのはチャットで推理の `worker/chat-deduction-guess.ts`（`solveGame` で正解者が決まったあと）と、漢字クイズの `worker/webhook-routes.ts` の `answerKanjiQuizFromChat`（`answerKanjiQuiz` が正解者を決めた出題のうち試し再生でないもの）。**渡せなくても投げずに `doll-grant-failed` を記録し、ゲームの進行（終了・正解者の押し出し・解説）は止めない**（方針5の例外）。画面は `src/dolls/doll-prize-field.tsx`（選び直したらその場で保存する）で、`/chat-deduction/` の「ゲーム」の区画と、トリガーのページの漢字クイズのカードに置く。

台帳に記録のある組は消させない（`deleteDollSet` が `in-use`）。組が使っている画像は `worker/admin-routes.ts` の `deleteMedia` が消させない。視聴者の記録を消すとき（`worker/viewer-store.ts` の `deleteViewer`）は、その人の台帳も消す（`deleteDollsOf`）。

検証（名前の空・20文字・画像が無い／画像でない、手での増減は -10〜10 の0でない整数）は `worker/doll.ts` だけが持ち、経路は `worker/doll-routes.ts`。画面は人形のページ（`src/dolls/doll-page.tsx`。組の追加・書き換え・削除と、いまの人形の選び直し。選び直しはその場で保存する）と、視聴者のページの開いた行（`src/dolls/viewer-dolls.tsx`。いまの人形の数と1つずつの受け渡し、前に使った人形の数）。→ `docs/decisions/dolls.md`

**自動で渡したとき（トリガーとゲームの正解者）だけ、合成ページの素材「人形の獲得」（素材の種類 `dollAward`）に演出を出す**。2つの経路はどちらも `worker/doll-award.ts` の `grantDolls` を通し、`changeDolls` が `applied` を返したときだけ（再送の `duplicate` では出さない）、視聴者の表示名と、いまの人形のうち渡した種類の名前・画像（`mediaPath` でオーバーレイ用キーつきのURLにする）と個数（`DollAwardCall`）を `AlertChannel` の目印 `dollAward`（`pushDollAward`・`connectDollAwardSocket`。経路は `GET /api/overlay/doll-award/socket`）で押し出す。渡せなければ押し出さずに投げ（記録は呼び出し側の `doll-grant-failed`）、渡せたあとの押し出しの失敗（オーバーレイ用キーが無い・配送先の失敗）は投げずに `doll-award-failed` を記録して渡したことは取り消さない。手での増減（`/viewers/`）は `grantDolls` を通さず、演出を出さない。合成ページ（`src/overlay/stage.ts` の `mountDollAward`）は届いた順に1件ずつ出し（`src/doll-award/view.ts`。`SHOW_MS` だけ出して消す。スーパー人形は `doll-award--super` で見分ける。大きさはすべて素材の箱を基準にし（`container-type: size` と `cq*` の単位。配信画面の `vw`・`vh`・`vmin` は使わない。`src/doll-award/styles.test.ts` が確かめる）、箱を小さくして隅に置けば中身も縮む。文言は `caption.ts`、形の確かめは `call.ts` で、画像は `/api/media/` の URL だけを受け付ける）、下部バーの「演出を消す」で出している1件を消す。プレビューのサンプルは `demo.ts`（画像は埋め込みの図形）。

**同じ素材に、1人ぶんのいまの人形の所持数（`standing`）と、いまの人形の点数のランキング（`ranking`）も出す**。押し出すものは `type`（`award`・`standing`・`ranking`）で見分ける判別共用体（`worker/doll-award.ts` の `DollAwardMessage`・`src/doll-award/call.ts` の `parseDollAwardMessage`）で、同じ目印・同じ順番待ちに並べる（ランキングだけ `RANKING_SHOW_MS` で長く出す）。押し出すのは `worker/doll-standing.ts`（`showDollStanding`・`showDollRanking`）だけで、出せなければ投げる。点数はふつう＝1・スーパー＝`SUPER_DOLL_VALUE`（`worker/doll.ts`）で、上位 `DOLL_RANKING_LIMIT` 人まで、同点は同じ順位（`readDollRanking`。並びはスーパーの多い順）。名前は `viewers.display_name` を先に、無ければ台帳に控えた最後の `user_name` を使い、どちらも無い人がいれば黙って飛ばさずに投げる。出し方は2つで、視聴者のチャットの組み込みのコマンド `!人形`・`!人形ランキング`（`worker/doll-command.ts`。登録したコマンドと作業机より先に見て、bot は要らない。再送は `reserveChatReply` の `<発言ID>:dolls`、続けての発言は `consumeCooldown` で所持数は人ごと・ランキングは全体で `DOLL_COMMAND_COOLDOWN_SECONDS` 空ける。出せなければ投げずに `doll-show-failed` を記録する。同じ名前は `worker/bot-config.ts` が登録させない）と、管理画面の `POST /api/admin/viewers/:userId/dolls/show`（`/viewers/` の開いた行の「配信画面に出す」）・`POST /api/admin/doll-ranking/show`（`/dolls/` の「ランキングを配信画面に出す」。どちらも、いまの人形が無ければ409、出せなければ502）である。

利用者向けの説明は `docs/guide/dolls.md`。
