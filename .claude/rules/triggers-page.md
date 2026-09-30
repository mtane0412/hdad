---
paths:
  - "src/admin/**"
---

# トリガーの管理画面（`/triggers/`）

トリガーの管理画面（`/triggers/`。`src/admin/trigger-page.tsx`）では配信者はトリガーを作らない。起きうる出来事が区分（チャット・イベント）ごとに固定で並び、そこに効果（動作）を追加する（`form.ts` の `menuGroups` がそのまま画面の構成になる）。効果をひとつも持たない行は保存しないので、有効・無効の印も「トリガーを外す」操作も持たない。差し込み語は文言の欄ごとに押して入れるボタンで並べる（`MessageField`）。素材の追加と削除は `/media/`（`src/admin/media-page.tsx`）に分け、どちらも `src/admin/page-actions.tsx` の `usePageActions` を使う。→ `docs/decisions/triggers-page.md`

利用者向けの説明は `docs/guide/alerts.md` の「アラートの設定と素材」。
