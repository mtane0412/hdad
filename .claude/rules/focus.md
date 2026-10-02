---
paths:
  - "src/focus/**"
  - "worker/focus-*.ts"
---

# 注目コメント（素材の種類 `focus`）

注目コメントは配信者が選んだ視聴者の発言1件を、アイコン・名前・本文の箱で素材の枠の中央に大きく映す素材（素材の種類 `focus`）で、取り上げる1件はコメントビューアー（`/comments/`）の行と流れの上の欄で選び・やめる（注目コメント専用のページ `/focus/` は持たない。単独のオーバーレイも issue #107 で消した）。人に追従する取り上げ方は持たない。選んだ1件は Worker がアイコンのURLを Twitch から引いて添えて保存する（`worker/focus-config.ts`。KVは `focus-comment`。アイコンのURLは画面から受け取らず、引けなければ保存しない）。取り上げる1件はURLに入れず、配送はポーリング（`GET /api/overlay/focus`。10秒）。何を映すかの判断は `src/focus/focused.ts` だけが持ち、モデレーターの操作で映しているものが消えたら映すのをやめる。→ `docs/decisions/focus.md`

利用者向けの説明は `docs/guide/focus.md`。
