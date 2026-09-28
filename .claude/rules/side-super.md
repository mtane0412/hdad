---
paths:
  - "src/side-super/**"
  - "worker/side-super*.ts"
  - "worker/collect.ts"
  - "worker/overlay-routes.ts"
---

# サイドスーパー（素材の種類 `sideSuper`）

サイドスーパーは配信画面の隅に出しっぱなしにするテロップの素材（素材の種類 `sideSuper`）で、あらすじと同じ機構だが積み上げない。cron（`worker/collect.ts` の `makeSideSuper`）が作り `side_supers` に貯める。材料は直近の発話・発言・いま画面に出ている文字（`screen_lines`。`.claude/rules/screen.md`）と配信のカテゴリ・タイトルで、画面に新しい文字が現れただけでも作り直す。文言はちょうど2行（`SIDE_SUPER_LINES`）で、1行目が見出し（14字）・2行目が本文（20字）。外れていたら補わず切り詰めずに投げる（`worker/side-super.ts` の `generateSideSuper`）。配送はポーリング（`GET /api/overlay/side-super`。30秒）。寄せる向きは素材のパラメータ（`src/side-super/params.ts`）で、配信者は `/overlay/` で選ぶ（サイドスーパー専用の単独ページと `/side-super/` の画面は issue #107 で消した）。→ `docs/decisions/side-super.md`

利用者向けの説明は `docs/guide/side-super.md`。
