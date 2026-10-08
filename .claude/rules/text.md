---
paths:
  - "src/text/**"
  - "worker/text*.ts"
  - "worker/alert-channel.ts"
  - "src/overlay/overlay-page.tsx"
  - "src/app/bottom-bar.tsx"
  - "migrations/*texts*.sql"
---

# テキスト（素材の種類 `text`）

テキストは、配信者が自由に書いた文字（「目標」「今やってること」など）をそのまま映す合成ページの素材（素材の種類 `text`。issue #294）。テキストは複数持て、1件は名前と本文を持つ。本文はURLにも素材のパラメータにも入れず、`texts`（`migrations/0029_texts.sql`）に1件1行で持つ（KV は書いた直後に古い値が返りうるので使わない）。検証（名前の空・重なり・文字数、本文の文字数・行数。上限を超えたら切り詰めずに拒む）は `worker/text.ts` の `parseTextInput` だけが持ち、文字数は書記素クラスタで数える。読み書きは `worker/text-store.ts`（検証のあとで別の窓が同じ名前を先に書いたときは、表の `UNIQUE` 制約の失敗を検証と同じ問題点（`duplicateNameError`）にする）、経路と押し出しは `worker/text-routes.ts`。LLM は呼ばない（段階2の自動の書き換えは issue #295）。

素材はどのテキストを映すかをパラメータ `text`（テキストのID。`src/text/params.ts`）に持つ。`OverlayItem` は素材を見分けるIDを持たないため、素材からテキストを指す。IDは `AUTOINCREMENT` で、消したIDを使い回さない（消えたテキストを指したまま別のテキストを映さないため）。管理画面（`/overlay/`）ではIDの入力欄を出さず、テキストの名前の選択欄（`src/overlay/form.ts` の `textOptionsFor`）で選ばせる。

追加・書き換え・削除のたびに、いまの一覧を丸ごと `AlertChannel` の目印 `text`（`pushTexts`・`connectTextSocket`）で合成ページへ押し出す。押し出しに失敗しても保存は取り消さず、保存は済んだことを添えて502（`text-push-failed`）で返す。合成ページ（`src/overlay/stage.ts` の `mountText`）は開いたとき・つながるたび・5分おきに `GET /api/overlay/texts` で読み直し、読んでいるあいだに押し出しが届いたら読んだ結果は捨てる（作業机と同じ）。映すテキストを引くのは `src/text/entry.ts` の `textToShow` だけで、選んでいない・消された場合は札を隠して素材の箱にエラーを出す（黙って空にしない）。本文が空のあいだは札ごと隠す（`src/text/view.ts`）。

入口はアプリのページ（`/texts/`。`src/text/text-page.tsx`。追加・名前の変更・削除・本文の編集。1件ずつ保存する）と、下部バー（`src/text/text-bar.tsx`。本文の書き換えだけ）。どちらも未保存の変更があるあいだは `useUnsavedChanges(true)` を呼ぶ（下部バーは窓を開いて書きかけているあいだだけ。窓を閉じたら書きかけは捨てる）。問題点の表示は `src/text/form.ts` の `textFailureLines`。→ `docs/decisions/text.md`

利用者向けの説明は `docs/guide/text.md`。
