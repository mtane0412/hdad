---
paths:
  - "src/dolls/**"
  - "worker/doll*.ts"
  - "worker/viewer-store.ts"
  - "src/viewers/**"
  - "migrations/*doll*.sql"
---

# 人形（`/dolls/`。視聴者が所持する人形）

視聴者に人形を渡し、所持させる仕組み（issue #418〜#420）。1組は「ふつうの人形」と「スーパー人形（ふつう3つ分の価値）」の2種類で、それぞれ名前と画像（R2 の素材。種類 image）を持つ。比 1:3 は定数で、設定項目にしない。1配信で使う組は「いまの人形」として1組だけ選ぶ（`doll_sets.current`。1 か NULL の UNIQUE）。手持ちは組ごとに配信をまたいで残り、**増減できるのはいまの人形だけ**である。番組名・キャラクター名はコード・docs・issue・PR に書かない。

所持は増減を1件1行で持つ台帳（`doll_ledger`。`migrations/0045_dolls.sql`）で持ち、所持数は合計から出す。鍵は Twitch のユーザーID だけで、`viewers` を指す外部キーにはしない（発言していない人にもトリガーで渡すため）。**台帳に書くのは `worker/doll-store.ts` の `changeDolls` だけ**で、手での増減・トリガー（#419）・ゲームの正解（#420）・今後の使い道はすべてここを通す。`changeDolls` は、いまの人形が無ければ `no-current-set`、減らすだけの所持数が無ければ `not-enough` の `DollChangeError` を投げて記録しない（0 で止めない）。確かめと書き込みは1つの文で行う。きっかけの ID（`source_id`）は UNIQUE で、同じ ID の増減は `duplicate` を返して2度記録しない（Twitch の再送への備え。手での増減は毎回 `manual:<UUID>` を振る）。記録した時点で配信中なら `session_id` を控え、配信外なら NULL のまま持つ。理由（`reason`）の種類は `worker/doll.ts` の `DollReason` が持ち、表の CHECK にはしない。

台帳に記録のある組は消させない（`deleteDollSet` が `in-use`）。組が使っている画像は `worker/admin-routes.ts` の `deleteMedia` が消させない。視聴者の記録を消すとき（`worker/viewer-store.ts` の `deleteViewer`）は、その人の台帳も消す（`deleteDollsOf`）。

検証（名前の空・20文字・画像が無い／画像でない、手での増減は -10〜10 の0でない整数）は `worker/doll.ts` だけが持ち、経路は `worker/doll-routes.ts`。画面は人形のページ（`src/dolls/doll-page.tsx`。組の追加・書き換え・削除と、いまの人形の選び直し。選び直しはその場で保存する）と、視聴者のページの開いた行（`src/dolls/viewer-dolls.tsx`。いまの人形の数と1つずつの受け渡し、前に使った人形の数）。手持ちを見せるのは管理画面だけで、チャットのコマンドや合成ページの演出は持たない。→ `docs/decisions/dolls.md`

利用者向けの説明は `docs/guide/dolls.md`。
