---
paths:
  - "src/admin/**"
---

# トリガーの管理画面（`/triggers/`）

トリガーの管理画面（`/triggers/`。`src/admin/trigger-page.tsx`）では配信者はトリガーを作らない。起きうる出来事が区分（チャット・イベント・開発・ポモドーロ）ごとに固定で並び、そこに効果（動作）を追加する（`form.ts` の `menuGroups` がそのまま画面の構成になる）。効果をひとつも持たない行は保存しないので、有効・無効の印も「トリガーを外す」操作も持たない。差し込み語は文言の欄ごとに押して入れるボタンで並べる（`MessageField`）。ページは「トリガー」（一覧）・「演出の設定」（市町村紹介・ツイスター・ペロペロ・VRM・漢字クイズの、1つだけ持ち保存も別のカード）・「配信画面への出し方」のタブに分ける。一覧の行は「出来事｜絞り込み｜効果」の3列で、絞り込みは `form.ts` の `rowParam`（型の付いた値）、効果は `rowActions`（種類と名前）から作り、型の部品（`.claude/rules/design.md`）で出す。区分は件数の付いた帯にする。素材の追加と削除は `/media/`（`src/admin/media-page.tsx`）に分け、どちらも `src/admin/page-actions.tsx` の `usePageActions` を使う。→ `docs/decisions/triggers-page.md`

利用者向けの説明は `docs/guide/alerts.md` の「アラートの設定と素材」。
