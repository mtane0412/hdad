---
paths:
  - "src/backstage/**"
  - "overlay/backstage/**"
---

# 裏方をまとめたページ（`overlay/backstage/`）とコネクターのページ（`/connectors/`）

裏方をまとめたページ（`overlay/backstage/`）は、映すものを持たないページ（読み上げ・画面の取り込み・BGM・漢字クイズの時間切れでの配信の停止）を1つのブラウザソースにまとめる。合成ページの素材にはしない。動かす裏方はURLで指定し（`?speech=false`・`?screen=true`・`?bgm=true`・`?stop=true`。画面の取り込みとBGMと配信の停止は既定で動かさない）、ひとつも動かさないURLは組み立てない（`src/backstage/url.ts`）。1つの裏方の失敗でほかは動かし続ける。

URLを出すのはアプリのコネクターのページ（`/connectors/`。`src/backstage/backstage-page.tsx`）で、外部のサービスとつなぐものの設定（VOICEVOX・Gyazo の区画、HDAD-tab の配布、Web Speech API による文字起こしのオン・オフ）も同じページに並べる。**項目はサービスの名前（VOICEVOX・Gyazo・HDAD-tab・Web Speech API。配信の停止は「OBS（配信の停止）」）で呼び、説明文は並べない**。初めて使うときに要る説明はヘルプボタン（`src/components/help-button.tsx`）の中に入れる。OBSに貼ってある URL を変えないよう、OBS側のページの名前（`overlay/backstage/`）とソースの置き場所（`src/backstage/`）は裏方のまま。→ `docs/decisions/backstage.md`

利用者向けの説明は `docs/guide/backstage.md`。
