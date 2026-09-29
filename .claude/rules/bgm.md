---
paths:
  - "src/bgm/**"
  - "worker/bgm-*.ts"
  - "worker/alert-channel.ts"
---

# BGM（`/bgm/`・裏方の `?bgm=true`）

BGMは配信で流す曲を管理画面（`/bgm/`）で管理し、裏方のページ（`overlay/backstage/` の `?bgm=true`。既定は鳴らさない）がOBSのブラウザソースの音声として鳴らす。**曲の音声は R2（MEDIA）に配信者がアップロードした音声だけを使い**、音声1つにつき曲は1つで、素材のIDを曲の識別子にする。クレジット先のURLは音声の読み先ではなく視聴者に紹介するための出典で、`http(s)://` か空だけを受け取る。曲の一覧（KV `bgm-tracks`）と「いま流す曲・音量」（KV `bgm-playback`）は別の鍵に置き、検証は `worker/bgm-config.ts` だけが持つ。**流している曲は一覧から外させず、BGMの曲に使われている素材は消させない**（黙って無音にしないため）。

**切り替えはポーリングで待たせず押し出す。** 流す曲・音量を変えたら（`PUT /api/admin/bgm/playback`）、流している曲の情報を直したら（`PUT /api/admin/bgm/tracks`）、Worker が「いま流している曲」を `AlertChannel` へ押し出す（`pushBgm`）。**専用の Durable Object は足さず、`AlertChannel` の接続に目印（タグ `alerts`・`bgm`）を付けて配り分ける**（合成ページはBGMをアラートとして読めないため）。裏方のページは開いたときとつなぎ直したときに `GET /api/overlay/bgm` を読み直す。

何をするか（切り替える・音量だけ変える・止める・何もしない）の判断は `src/bgm/change.ts` の `bgmChangeOf` だけが持ち、曲が同じかは素材のIDで見る（曲名を直しただけで頭から流れ直さない）。鳴らすのは `src/bgm/player.ts`（ループ、切り替えは2秒のフェードでつなぐ。次の曲を鳴らせなければ前の曲を流したままにする）。起動の失敗は投げ、配信中の切り替えの1回の失敗では止めずにその裏方の箱に出す。→ `docs/decisions/bgm.md`

利用者向けの説明は `docs/guide/bgm.md`。
