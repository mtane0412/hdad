---
paths:
  - "src/bgm/**"
  - "worker/bgm-*.ts"
  - "worker/alert-channel.ts"
---

# BGM（`/bgm/`・裏方の `?bgm=true`）

BGMは配信で流す曲を管理画面（`/bgm/`）で管理し、裏方のページ（`overlay/backstage/` の `?bgm=true`。既定は鳴らさない）がOBSのブラウザソースの音声として鳴らす。**曲の音声は R2（MEDIA）に配信者がアップロードした音声だけを使い**、音声1つにつき曲は1つで、素材のIDを曲の識別子にする。クレジット先のURLは音声の読み先ではなく視聴者に紹介するための出典で、`http(s)://` か空だけを受け取る。曲の一覧（KV `bgm-tracks`）と「いま流す曲・音量」（KV `bgm-playback`）は別の鍵に置き、検証は `worker/bgm-config.ts` だけが持つ。**流している曲は一覧から外させず、BGMの曲に使われている素材は消させない**（黙って無音にしないため）。

**切り替えはポーリングで待たせず押し出す。** 流す曲・音量を変えたら（`PUT /api/admin/bgm/playback`）、流している曲の情報を直したら（`PUT /api/admin/bgm/tracks`）、Worker が「いま流している曲」を `AlertChannel` へ押し出す（`pushBgm`）。**専用の Durable Object は追加せず、`AlertChannel` の接続に目印（タグ `alerts`・`bgm`）を付けて配り分ける**（合成ページはBGMをアラートとして読めないため）。裏方のページは開いたときとつなぎ直したときに `GET /api/overlay/bgm` を読み直す。

**クレジットは合成ページの素材「再生中の曲」（種類 `bgm`。`src/bgm/credit-view.ts`・`bgm.css`）とチャットコマンドの差し込み語 `{bgm}`（`worker/bgm-credit.ts`）で見せる。** 素材は裏方と同じ押し出しの接続で切り替えを知り、止めているときは何も映さない。`{bgm}` は止めているときも無応答にせず、流していないと分かる文言に置き換える。曲名・クレジット表記・クレジット先のURLの上限は、`{bgm}` がTwitchの1通に収まるように決めてあるので、上限を変えるときは `MAX_BGM_CREDIT_LENGTH` と応答文の長さの検証（`worker/bot-config.ts`）を合わせて見る。

**Jev による自動の切り替え（`worker/bgm-jev.ts`。既定はオフ、KV `bgm-settings`）は、収集（`worker/collect.ts`）であらすじを作り直せた回だけ呼ぶ。** 曲調・流したい場面を Choice の選択肢の説明にし、いま流している曲も選択肢に入れる（選ばれたら切り替えない）。確信度が `BGM_CONFIDENCE_THRESHOLD` に届かない・止めている・最後の切り替え（KV `bgm-switched-at`。手で流す曲を変えたときも記録する）から `BGM_SWITCH_COOLDOWN_MS` 経っていないときは切り替えない。判定のあいだに配信者が自動の切り替えを切った・手で変えたら上書きしない。失敗は投げ、呼び出し側が `bgm-choice-failed` として記録する。押し出しは管理画面と共通の `worker/bgm-push.ts` を使う。

**再生モードは「いま流す曲・音量」に `repeat`・`shuffle` として持つ（既定はどちらも切った通常の再生）。** リピートを切っているあいだ、裏方のページは曲が終わったら `POST /api/overlay/bgm/ended` で終わった曲を知らせ、Worker がその曲をまだ流していることになっていれば次の曲へ進めて押し出す（裏方を2つ開いていても1回だけ進む）。**次の曲・前の曲の決め方は `worker/bgm-order.ts` の `steppedMediaIdOf` だけが持ち**（一覧の順で最後の次は最初に戻る。シャッフルはいま流している曲以外から選ぶ）、管理画面の「次の曲」「前の曲」（`POST /api/admin/bgm/skip`）も同じものを使う。自動で進んだときは切り替えた時刻を記録しない。管理画面（`/bgm/`）も同じ押し出しにオーバーレイ用キーでつなぎ（`src/bgm/socket.ts`）、プレーヤーと曲の表に映す。

**アプリの再生の状態（保存済みの曲・いま流す曲と音量・自動の切り替えの設定）と押し出しの接続は、アプリの枠の `BgmPlayerProvider`（`src/bgm/player-context.tsx`）だけが持つ。** 下部バー（`src/bgm/bgm-bar.tsx`。再生・停止・前の曲・次の曲・曲名・音量）と `/bgm/` のページの両方がそこを読み、接続を2本張らない。操作の部品は `src/bgm/player-controls.tsx` で共通にする。リピート・シャッフル・Jev はページだけに置き、曲の一覧の入力欄（書きかけ）もページが持つ。押し出しを受け取れていない・キーが無い・操作に失敗したときはバーにも理由を出す。

**ポモドーロの休憩中は、`worker/pomodoro-bgm.ts` が休憩の曲（繰り返し）へ切り替え、休憩が明けたら前の曲と繰り返しの設定へ戻す。** どちらも切り替えた時刻を記録するので、Jev の控える時間が休憩を覆う（`.claude/rules/pomodoro.md`）。

何をするか（切り替える・音量とループを変える・止める・何もしない）の判断は `src/bgm/change.ts` の `bgmChangeOf` だけが持ち、曲が同じかは素材のIDで見る（曲名を直しただけで頭から流れ直さない）。鳴らすのは `src/bgm/player.ts`（リピート中だけループ、切り替えは2秒のフェードでつなぐ。次の曲を鳴らせなければ前の曲を流したままにする）。起動の失敗は投げ、配信中の切り替えの1回の失敗では止めずにその裏方の箱に出す。→ `docs/decisions/bgm.md`

利用者向けの説明は `docs/guide/bgm.md`。
