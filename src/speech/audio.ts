/**
 * 合成した音声の再生
 *
 * VOICEVOX から受け取った wav を鳴らし、鳴り終わるまで待つ。DOM（Audio 要素）を扱うため、
 * 読み上げ文の組み立て（text.ts）や合成の呼び出し（voicevox.ts）とは分けてテストの対象外にしている
 * （src/alerts/view.ts と同じ分け方）。
 *
 * 注意: 音量は再生する側で与える（合成しなおさずに変えられるようにするため。読み上げ速度は声の高さが
 * 変わってしまうので合成の時点で指定する ＝ voicevox.ts が持つ）。
 * 作った Blob のURLは、鳴り終わっても失敗しても止められても必ず捨てる（配信中は何百回も鳴るため、溜めると漏れる）。
 * 下部バーでミュートしたときは、鳴っている途中の1件もその場で止める（issue #238。止めたら鳴り終わったのと同じく解決する）。
 */

/**
 * 音声を1件鳴らし、鳴り終わったら解決する。
 *
 * @param audio VOICEVOX が返した wav
 * @param volume 音量（0〜1）
 * @param signal 途中で止める合図。止めたらその場で音を止めて解決する
 * @throws 再生できなかった場合（ブラウザが音の自動再生を拒んだ場合を含む）
 */
export const playSpeech = (audio: Blob, volume: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(audio)
    const player = new Audio(url)
    player.volume = volume

    const finish = (error?: Error): void => {
      signal.removeEventListener('abort', stop)
      URL.revokeObjectURL(url)
      if (error) reject(error)
      else resolve()
    }
    const stop = (): void => {
      player.pause()
      finish()
    }
    if (signal.aborted) {
      finish()
      return
    }
    signal.addEventListener('abort', stop)

    player.addEventListener('ended', () => finish())
    player.addEventListener('error', () => finish(new Error('読み上げの音声を再生できませんでした')))
    // OBSのブラウザソースでは自動再生が許されるが、普通のブラウザのタブでは操作前の再生を拒まれることがある
    player.play().catch((error: unknown) => finish(new Error(`読み上げの音声を再生できませんでした: ${String(error)}`)))
  })
