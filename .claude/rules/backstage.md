---
paths:
  - "src/backstage/**"
  - "overlay/backstage/**"
---

# 裏方をまとめたページ（`overlay/backstage/`）

裏方をまとめたページ（`overlay/backstage/`）は、映すものを持たないページ（読み上げ・文字起こしの中継・画面の取り込み）を1つのブラウザソースにまとめる。合成ページの素材にはしない。動かす裏方はURLで指定し（`?speech=false`・`?transcript=false`・`?screen=true`。画面の取り込みだけは既定で動かさない）、ひとつも動かさないURLは組み立てない（`src/backstage/url.ts`）。1つの裏方の失敗でほかは動かし続ける。→ `docs/decisions/backstage.md`

利用者向けの説明は `docs/guide/backstage.md`。
