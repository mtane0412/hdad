---
paths:
  - "src/caption/**"
  - "worker/caption-*.ts"
  - "worker/draw-channel.ts"
  - "src/transcript/recognition-context.tsx"
  - "src/transcript/translation-api.ts"
  - "worker/translation*.ts"
  - "src/llm/translation-card.tsx"
---

# 字幕（素材の種類 `caption`）

字幕はアプリの枠の音声認識（`src/transcript/recognition-context.tsx`）が認識した暫定・確定の文を、合成ページの下端に出す素材である（issue #190）。**配る仕組みは手書きの `DrawChannel`（`worker/draw-channel.ts`）を名前 `caption` の別のインスタンスとして使う**（`connectDrawSocket` の `channel` 引数）。新しい Durable Object のクラスは足さない。中継先は中身を読まず、形の確かめは受け取った側の `src/caption/message.ts` の `parseCaptionMessage` だけが持つ。送る側は配信者のセッションで守る `GET /api/admin/caption/socket`（`worker/caption-routes.ts`。`Origin` も自分で確かめる）、見るだけの側はオーバーレイ用キーで守る `GET /api/overlay/caption` である。→ `docs/decisions/caption.md`

**字幕を送るのは Web Locks の鍵を取って認識している1つのタブだけ**で、話している途中の文は変わったときだけ送り、空になったことも送る。確定した文は記録（`POST /api/admin/transcripts`）の応答を待たずに送る。つながっていないあいだの分は貯めずに落とす。送る側の失敗は `captionWarning` としてコネクターのページの区画に出す。

**訳文（issue #191）は確定した文にIDを付けて結び付ける。** アプリの枠は確定した1件ごとに UUID を作って `final` に載せ、直前に確定した2件を文脈として `POST /api/admin/translations`（`worker/translation-routes.ts`。セッションで守る）へ送り、返ってきた訳文を同じIDの `translation` として中継先へ送る。原文は訳を待たずに送り、訳せなかった理由は `translationWarning` としてコネクターのページに出す。暫定の文は訳さない。訳す先は英語だけで設定項目にしない。提供元（訳さない・LLM・m2m100・DeepL）は `worker/translation-config.ts`（KVは `translation-settings`。既定は訳さない）が決め、選ぶ画面は `/llm/` の区画（`src/llm/translation-card.tsx`）である。LLM で訳すときは `worker/llm.ts` に箇所 `translation` を指名する（`.claude/rules/llm.md`）。失敗は黙って別の提供元へ落とさず502で返し、`collection_failures`（`translation-failed`）にも残す。合成ページは訳文を同じIDの確定した行の下に添え、訳文が届いてから `FINAL_LIFETIME_MS` 映す。添える先が消えていれば捨てる。

**行数・消えるまでの時間・位置は設定項目にしない**（`docs/principles.md` の方針1）。数は `src/caption/captions.ts`（`CAPTION_LINES`・`FINAL_LIFETIME_MS`・`INTERIM_LIFETIME_MS`・1行の字数の上限 `CAPTION_MAX_CHARS`・`TRANSLATION_MAX_CHARS`）、見た目は `src/caption/caption.css` だけが持つ。長い行は末尾だけを残して先頭を「…」で落とす（`tailOf`。状態には全文を持ち、切るのは `visibleCaptions` だけ）。映す行は届いた時刻といまの時刻だけから決め（`visibleCaptions`）、合成ページの描画ループが毎フレーム呼ぶ（タイマーを持たない）。

**合成ページの字幕の箱には切断を出さない**（箱は配信画面と同じ大きさに置くので、失敗の表示が配信画面全体を覆う。手書きの issue #174 と同じ）。

利用者向けの説明は `docs/guide/caption.md`。
