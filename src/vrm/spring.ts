/**
 * 揺れ物（SpringBone）を1コマで進める時間
 *
 * 髪や服の揺れ（three-vrm の SpringBone）は前のコマの状態から次の状態を計算するので、描画は経過時間だけから決める約束
 * （docs/decisions/rendering.md）の例外になる（issue #359）。コマが落ちたときに破綻しないよう、1コマで進める時間に上限を設ける。
 * OBS がソースを隠していたあいだや負荷が高いあいだにコマが落ちても、揺れ物は上限の時間だけ進んで少し遅れて追いつくだけになり、
 * 大きな時間差で一度に計算して髪が跳ね飛ぶことはない。
 *
 * 注意: 揺れ物そのものは前の状態から決まるので、時刻ごとの姿をテストで確かめられない。ここでは進める時間の決め方だけをテストする。
 */

/** 1コマで揺れ物を進める時間の上限（秒）。30fps の1コマぶん */
export const MAX_SPRING_STEP_SECONDS = 1 / 30

/**
 * 前のコマからの時間差を、揺れ物を進める時間（秒）にする。
 *
 * @param previousMs 前のコマを描いた時刻（ミリ秒）。最初のコマなら null
 * @param nowMs このコマを描く時刻（ミリ秒）
 * @returns 0 以上 MAX_SPRING_STEP_SECONDS 以下の秒数。最初のコマと時刻が戻ったときは 0
 */
export const springStepSeconds = (previousMs: number | null, nowMs: number): number => {
  if (previousMs === null) return 0
  return Math.min(Math.max(0, (nowMs - previousMs) / 1000), MAX_SPRING_STEP_SECONDS)
}
