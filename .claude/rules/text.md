---
paths:
  - "src/text/**"
  - "worker/text*.ts"
  - "worker/collect.ts"
  - "worker/alert-channel.ts"
  - "src/overlay/overlay-page.tsx"
  - "src/app/bottom-bar.tsx"
  - "migrations/*texts*.sql"
---

# テキスト（素材の種類 `text`）

テキストは、配信者が自由に書いた文字（「目標」「今やってること」など）をそのまま映す合成ページの素材（素材の種類 `text`。issue #294）。テキストは複数持て、1件は名前・本文・手動／自動の別（`mode`）・指示文（`instruction`）・本文を書いた人（`written_by`。`human`・`llm`）を持つ。本文はURLにも素材のパラメータにも入れず、`texts`（`migrations/0029_texts.sql`・`0030_texts_auto.sql`）に1件1行で持つ（KV は書いた直後に古い値が返りうるので使わない）。検証（名前の空・重なり・文字数、本文の文字数・行数、自動なら指示文が空でないこと。上限を超えたら切り詰めずに拒む）は `worker/text.ts` の `parseTextInput` だけが持ち（本文の上限は LLM の本文と共通の `textBodyProblems`）、文字数は書記素クラスタで数える。読み書きは `worker/text-store.ts`（検証のあとで別の窓が同じ名前を先に書いたときは、表の `UNIQUE` 制約の失敗を検証と同じ問題点（`duplicateNameError`）にする）、経路と押し出しは `worker/text-routes.ts`。

**自動のテキスト**（issue #295）は、cron（`worker/collect.ts` の `rewriteAutoTexts`。サイドスーパーの次）が指示文に沿って LLM（`worker/text-auto.ts`。箇所 `autoText`）に本文を書き直させ、書き直したら一覧を押し出す。材料はサイドスーパーと同じ直近の発話・発言・画面の文字と配信のカテゴリ・タイトルに、手動のテキストの本文を加える。前回 LLM が書いたあと（`written_by` が `llm` のときの `updated_at`）の発話が無ければ呼ばない（発話が1件も無ければ書かない）。LLM の本文は `saveGeneratedText` で、読んだときの `updated_at` のままでまだ自動のテキストにだけ書く（人が書いた文を機械に上書きさせない）。上限を超えた本文は切り詰めずに `text-auto-failed` に記録し、前の本文を残す。**自動の保存では本文を送らず、Worker も本文を書き換えない**（画面が読んだ古い本文で LLM の本文を上書きしないため）。**本文を手で書き換えたら手動にするのは画面**（`src/text/form.ts` の `editBody`。ページも下部バーも通る）で、Worker は送られた `mode` に従う。手動の保存で本文が変わったときだけ `written_by` を `human` にする。

素材はどのテキストを映すかをパラメータ `text`（テキストのID。`src/text/params.ts`）に持つ。`OverlayItem` は素材を見分けるIDを持たないため、素材からテキストを指す。IDは `AUTOINCREMENT` で、消したIDを使い回さない（消えたテキストを指したまま別のテキストを映さないため）。管理画面（`/overlay/`）ではIDの入力欄を出さず、テキストの名前の選択欄（`src/overlay/form.ts` の `textOptionsFor`）で選ばせる。

追加・書き換え・削除のたびに、いまの一覧を丸ごと `AlertChannel` の目印 `text`（`pushTexts`・`connectTextSocket`）で合成ページへ押し出す。押し出しに失敗しても保存は取り消さず、保存は済んだことを添えて502（`text-push-failed`）で返す。合成ページ（`src/overlay/stage.ts` の `mountText`）は開いたとき・つながるたび・5分おきに `GET /api/overlay/texts` で読み直し、読んでいるあいだに押し出しが届いたら読んだ結果は捨てる（作業机と同じ）。映すテキストを引くのは `src/text/entry.ts` の `textToShow` だけで、選んでいない・消された場合は札を隠して素材の箱にエラーを出す（黙って空にしない）。本文が空のあいだは札ごと隠す（`src/text/view.ts`）。

札は素材の箱いっぱいの固定の大きさで描き、枠の見た目はパラメータ `frame`（板・メッセージウィンドウ・テロップ帯・付箋。`src/text/text.css` の `text-board--<値>`）、本文が収まらないときの扱いはパラメータ `overflow`（固定・縮める・流す）で選ばせる。どちらも決まった値から選ぶ種類 `choice`（`src/core/params.ts`）で宣言し、既定値は #294 の見た目（板・固定）にする。縮める倍率と流す動きの計算は `src/text/fit.ts` だけが持ち、要素を測るのは `src/text/view.ts`。測り直し（`refit`）は合成ページが箱の大きさの変化とフォントの読み込みのたびに呼ぶ。

入口はアプリのページ（`/texts/`。`src/text/text-page.tsx`。追加・名前の変更・削除・本文の編集・自動の切り替えと指示文。本文の下に書いた人を出す。1件ずつ保存する）と、下部バー（`src/text/text-bar.tsx`。本文の書き換えだけ。自動のテキストは保存すると手動になることを窓に出す）。どちらも未保存の変更があるあいだは `useUnsavedChanges(true)` を呼ぶ（下部バーは窓を開いて書きかけているあいだだけ。窓を閉じたら書きかけは捨てる）。問題点の表示は `src/text/form.ts` の `textFailureLines`。→ `docs/decisions/text.md`

利用者向けの説明は `docs/guide/text.md`。
