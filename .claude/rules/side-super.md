---
paths:
  - "src/side-super/**"
  - "side-super/**"
  - "worker/side-super*.ts"
  - "worker/collect.ts"
  - "worker/overlay-routes.ts"
---

# サイドスーパー（`/side-super/`）

サイドスーパー（`/side-super/`）は配信画面の隅に出しっぱなしにするテロップで、あらすじと同じ機構だが積み上げない。cron（`worker/collect.ts` の `makeSideSuper`）が作り `side_supers` に貯める。文言はちょうど2行（`SIDE_SUPER_LINES`）で、1行目が見出し（14字）・2行目が本文（20字）。外れていたら補わず切り詰めずに投げる（`worker/side-super.ts` の `generateSideSuper`）。配送はポーリング（`GET /api/overlay/side-super`。30秒）で、オーバーレイは `side-super/overlay/index.html`。→ `docs/decisions/side-super.md`

利用者向けの説明は `docs/guide/side-super.md`。
