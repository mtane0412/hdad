---
paths:
  - "src/caption/**"
  - "worker/caption-*.ts"
  - "worker/draw-channel.ts"
  - "src/transcript/recognition-context.tsx"
---

# 字幕（素材の種類 `caption`）

字幕はアプリの枠の音声認識（`src/transcript/recognition-context.tsx`）が認識した暫定・確定の文を、合成ページの下端に出す素材である（issue #190）。**配る仕組みは手書きの `DrawChannel`（`worker/draw-channel.ts`）を名前 `caption` の別のインスタンスとして使う**（`connectDrawSocket` の `channel` 引数）。新しい Durable Object のクラスは足さない。中継先は中身を読まず、形の確かめは受け取った側の `src/caption/message.ts` の `parseCaptionMessage` だけが持つ。送る側は配信者のセッションで守る `GET /api/admin/caption/socket`（`worker/caption-routes.ts`。`Origin` も自分で確かめる）、見るだけの側はオーバーレイ用キーで守る `GET /api/overlay/caption` である。→ `docs/decisions/caption.md`

**字幕を送るのは Web Locks の鍵を取って認識している1つのタブだけ**で、話している途中の文は変わったときだけ送り、空になったことも送る。確定した文は記録（`POST /api/admin/transcripts`）の応答を待たずに送る。つながっていないあいだの分は貯めずに落とす。送る側の失敗は `captionWarning` としてコネクターのページの区画に出す。

**行数・消えるまでの時間・位置は設定項目にしない**（`docs/principles.md` の方針1）。数は `src/caption/captions.ts`（`CAPTION_LINES`・`FINAL_LIFETIME_MS`・`INTERIM_LIFETIME_MS`）、見た目は `src/caption/caption.css` だけが持つ。映す行は届いた時刻といまの時刻だけから決め（`visibleCaptions`）、合成ページの描画ループが毎フレーム呼ぶ（タイマーを持たない）。

**合成ページの字幕の箱には切断を出さない**（箱は配信画面と同じ大きさに置くので、失敗の表示が配信画面全体を覆う。手書きの issue #174 と同じ）。

利用者向けの説明は `docs/guide/caption.md`。
