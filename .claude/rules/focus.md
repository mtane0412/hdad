---
paths:
  - "src/focus/**"
  - "worker/focus-*.ts"
---

# 注目コメント（`/focus/`・素材の種類 `focus`）

注目コメントは視聴者の発言1件を大きく映す素材（素材の種類 `focus`）で、取り上げるものを決める画面が `/focus/` である（注目コメント専用の単独ページは issue #107 で消した。画面はURLを配らず `/overlay/` へ案内する）。取り上げ方は人に追従する `viewer` と発言1件を固定する `message` の2通りで、1つの保存先（`worker/focus-config.ts`。KVは `focus-target`）に持つ。取り上げる相手はURLに入れず、配送はポーリング（`GET /api/overlay/focus`。10秒）。何を映すかの判断は `src/focus/focused.ts` だけが持ち、モデレーターの操作で映しているものが消えたら映すのをやめる。→ `docs/decisions/focus.md`

利用者向けの説明は `docs/guide/focus.md`。
