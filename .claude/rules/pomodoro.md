---
paths:
  - "src/pomodoro/**"
  - "worker/pomodoro*.ts"
  - "worker/ad-break-timer.ts"
  - "worker/alarm-actions.ts"
  - "worker/alert-channel.ts"
---

# ポモドーロ（`/pomodoro/`・素材の種類 `pomodoro`）

ポモドーロは25分の作業と5分の休憩を繰り返すタイマーで、長さは `src/pomodoro/phase.ts` の `WORK_MS`・`BREAK_MS` に決め切り、長い休憩は持たない。タイマーは「始めた時刻（`startedAt`）・経過の起点（`anchorAt`。一時停止のぶんだけずらす）・一時停止した時刻（`pausedAt`）」だけを持ち、区間・何本目か・残り時間は現在時刻を渡して `phaseAt` で計算する。**区間の計算は `src/pomodoro/phase.ts` だけが持ち**、合成ページ・アプリのページ・Worker のアラームがすべてこれを呼ぶ（Worker から `src/` を読み込む2例目の例外。1例目は `src/draw/strokes.ts`）。そのためこのファイルは DOM にも通信にも触れず、ほかのファイルを読み込まない。

状態と区切りのアラームは、`AdBreakTimer`（`worker/ad-break-timer.ts`）の別のインスタンス（名前 `pomodoro`）の storage に持ち、中身は `worker/pomodoro-timer.ts` が扱う（`AdBreakTimer` は `/pomodoro/` のパスと、ポモドーロの状態を持つインスタンスのアラームを振り分けるだけ）。KV に置かない（書いた場所と別の場所で古い値が返りうるため）。操作（`POST /api/admin/pomodoro/control` の `start`・`pause`・`resume`・`stop`）もすべてこのインスタンスを通し、今の状態でできない操作は409（`pomodoro-running`・`pomodoro-stopped`・`pomodoro-paused`・`pomodoro-not-paused`）で返す。アラームから擬似イベントのトリガーを動かす文脈の組み立ては `worker/alarm-actions.ts` の `runAlarmActions` を広告の終了と共有する。

区切りでは、トリガー（`pomodoroWorkBegin`・`pomodoroBreakBegin`。擬似イベント `hdad.pomodoro.work_begin`・`hdad.pomodoro.break_begin`、区分「ポモドーロ」）を動かす。差し込み語は `{round}`（何本目か。休憩は直前の作業と同じ番号）と `{minutes}`（始まった区間の長さ）で、相手がいないので `{user}` は持たない（`user` の条件も満たさない）。鍵は `pomodoro:<startedAt>:<round>:<work|break>`。始めたときも1本目の作業の開始として動かすが、配信していなければ動かさない（始めるのは配信の前でもよい）。**配信していないときに区切りを迎えたら、トリガーを動かさずにタイマーを止める**（休憩の前の曲へ戻し、止めたことを押し出す）。

休憩中の BGM は `worker/pomodoro-bgm.ts` が切り替える。休憩の曲は KV `pomodoro-settings`（`worker/pomodoro-config.ts`。BGM の一覧にある曲か `null`）から区切りのたびに読み、休憩の曲は繰り返しで流す。休憩が明けたら（休憩中に止めたときも）休憩の前の「流す曲」と「繰り返すか」だけを戻し、音量とシャッフルは戻さない。どちらも切り替えた時刻を記録するので、Jev の切り替えを控える時間（`BGM_SWITCH_COOLDOWN_MS`。10分）が5分の休憩を覆い、休憩中に Jev が曲を変えない（この関係は `worker/pomodoro-bgm.test.ts` が確かめる。休憩を長くするときは見直す）。

押し出し・BGMの切り替え・トリガーの失敗は投げずに記録する（`pomodoro-push-failed`・`pomodoro-bgm-failed`・`pomodoro-trigger-failed`）。押し出しは始めた・一時停止・再開・止めたときだけで、区切りでは押し出さない。押し出しは `AlertChannel` の目印 `pomodoro`（`pushPomodoro`・`connectPomodoroSocket`）に相乗りする。合成ページ（`src/overlay/stage.ts` の `mountPomodoro`）は、開いたとき・つながるたび・5分おきに `GET /api/overlay/pomodoro` で読み直し（読んでいるあいだに押し出しが届いたら読んだ結果は捨てる）、札（`src/pomodoro/view.ts`）は毎フレーム現在時刻から描く。アプリのページ（`src/pomodoro/pomodoro-page.tsx`）は休憩の曲を選んだらすぐ保存し、保存ボタンを持たない。→ `docs/decisions/pomodoro.md`

利用者向けの説明は `docs/guide/pomodoro.md`。
