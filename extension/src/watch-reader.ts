/**
 * 同時視聴でタブに差し込む再生位置の読み取りと、そこからサービスワーカーへの知らせの形（issue #443）
 *
 * Prime Video のタブでボタンが押されると、サービスワーカー（background.ts）が startWatchReader を chrome.scripting.executeScript で
 * タブへ差し込む。読み取りは毎秒 <video> を読み、変わったときと30秒ごとにだけ知らせる。
 *
 * 2026-11-01 に実機の Prime Video で次を確かめ、読み方を決めた。
 * - <video>.currentTime は画面の時刻と一致した（33.9 秒が 0:00:34。長さは 7163 秒）。10秒送りでも一致した
 * - 画面の時刻の要素のクラス名は意味のない文字列で、読むと画面の更新で壊れやすい。そのため <video> を読む
 * - 作品の og:image は無い。作品の画像は、ページ題名に含まれる alt（作品名）を持つ幅1300の <img> である
 * その回の情報（issue #443 のあとの追加）も 2026-11-01 に TV アニメで確かめた。
 * - 操作バーの atvwebplayersdk-episode で始まるクラスの要素に「S1 E2 第2話 無愛想な薬師」と出る。バーが隠れると要素ごと消えるので、読めたら覚えておく
 * - 次の回へ進んでも <video>・長さ・URL・ページ題名は変わらず、位置が 0 へ戻るだけである。回の開始から数秒でバーが自動で出る
 * - 合成の mousemove ではバーは出ない（ページを操作して出すことはしない）
 * シークを <video> のイベントで受けずに毎秒の読み取りで見つけるのは、ページの移動で <video> が作り直されても同じ処理で済むため。
 *
 * 注意: startWatchReader と stopWatchReader は文字列にしてタブへ送られるので、関数の外の値（定数を含む）を参照しない。
 * 注意: 広告が本編の位置に含まれるかは確かめられていない（広告の出ない作品で確かめた）。
 */
import type { WatchPosition } from '../../src/tab/watch-position'
import { isRecord } from './guards'

/** 読み取りからの知らせに付けるあて先 */
export const WATCH_READER_TARGET = 'hdad-watch-reader'

/** 読み取りからの知らせ（position が null なら再生していない） */
export interface WatchReaderMessage {
  readonly position: WatchPosition | null
}

/** タブの中で読み取りの状態を置く場所（差し込みをまたいで二重に動かさないため） */
interface WatchReaderScope {
  __hdadWatchReaderTimer?: ReturnType<typeof setInterval>
}

/**
 * 再生位置の読み取りを始める（タブの中で動く）。すでに動いていれば何もしない。
 *
 * @param target 知らせに付けるあて先
 */
export const startWatchReader = (target: string): void => {
  const READ_INTERVAL_MILLISECONDS = 1000
  const MILLISECONDS_PER_SECOND = 1000
  /** 変わらなくても知らせる間隔（中継先のつなぎ直しや時刻のずれを埋めるため） */
  const HEARTBEAT_MILLISECONDS = 30000
  /** 予想した位置からこの秒数より離れたら、シークとみなしてすぐ知らせる */
  const DRIFT_SECONDS = 2
  /** 題名の画像とみなす最小の幅（alt が題名に含まれる小さなロゴを除く） */
  const MIN_IMAGE_WIDTH = 300
  /** 合成ページが受け入れる画像の置き場所（文字列でタブへ送るので読み込めない。watch-position.ts との一致はテストが確かめる） */
  const IMAGE_HOST_SUFFIXES = ['.media-amazon.com', '.ssl-images-amazon.com']
  /** 位置がこの秒数より前へ、しかもこの秒数を超えて戻ったら、次の回へ進んだかもしれないとみなす（実機では開始から数秒でバーが出る） */
  const EPISODE_START_SECONDS = 10

  const scope = window as unknown as WatchReaderScope
  if (scope.__hdadWatchReaderTimer !== undefined) return

  const stop = (error: unknown): void => {
    // 拡張が読み込み直されると、このタブからは二度と知らせられない
    console.error('HDAD: 再生位置を知らせられなかったので読み取りを止めます', error)
    clearInterval(scope.__hdadWatchReaderTimer)
    delete scope.__hdadWatchReaderTimer
  }

  let last: WatchPosition | null = null
  let lastAt = 0
  let sentOnce = false
  /** 操作バーから最後に読んだその回の情報（バーが隠れると読めなくなるので覚えておく） */
  let episode: string | null = null
  /** 直前の読み取りの位置（知らせた位置は最大30秒古いので、先頭へ戻ったかの判定には使わない） */
  let previousSeconds = 0

  /** その回の情報を読み直す。前の回の情報を出し続けるより「分からない」を選ぶ */
  const readEpisode = (positionSeconds: number): void => {
    const text = document.querySelector('[class*="atvwebplayersdk-episode"]')?.textContent?.trim()
    if (text !== undefined && text !== '') {
      episode = text
      return
    }
    if (positionSeconds < EPISODE_START_SECONDS && previousSeconds - positionSeconds > EPISODE_START_SECONDS) episode = null
  }

  const readPosition = (): WatchPosition | null => {
    // 作品一覧の短い予告を読まないよう、いちばん長い <video> を本編とする
    const videos = [...document.querySelectorAll('video')].filter((candidate) => Number.isFinite(candidate.duration))
    const video = videos.reduce<HTMLVideoElement | null>((longest, candidate) => (longest === null || candidate.duration > longest.duration ? candidate : longest), null)
    if (video === null) return null
    readEpisode(video.currentTime)
    previousSeconds = video.currentTime
    const images = [...document.images].filter((candidate) => candidate.alt !== '' && document.title.includes(candidate.alt) && candidate.naturalWidth >= MIN_IMAGE_WIDTH)
    const image = images.reduce<HTMLImageElement | null>((largest, candidate) => (largest === null || candidate.naturalWidth > largest.naturalWidth ? candidate : largest), null)
    return {
      positionSeconds: video.currentTime,
      playing: !video.paused,
      rate: video.playbackRate,
      title: image?.alt ?? null,
      episode,
      // 受け入れられない画像を送ると再生位置ごと拒まれるので、画像だけを外す
      imageUrl: image !== null && image.src.startsWith('https://') && IMAGE_HOST_SUFFIXES.some((suffix) => new URL(image.src).hostname.endsWith(suffix)) ? image.src : null,
    }
  }

  /** 前に知らせた内容からの予想と違うか */
  const hasChanged = (next: WatchPosition | null, now: number): boolean => {
    if (!sentOnce) return true
    if (next === null || last === null) return next !== last
    if (next.playing !== last.playing || next.rate !== last.rate || next.title !== last.title || next.episode !== last.episode || next.imageUrl !== last.imageUrl) return true
    const expected = last.positionSeconds + (last.playing ? (last.rate * (now - lastAt)) / MILLISECONDS_PER_SECOND : 0)
    return Math.abs(next.positionSeconds - expected) > DRIFT_SECONDS
  }

  const tick = (): void => {
    const now = Date.now()
    const next = readPosition()
    if (!hasChanged(next, now) && now - lastAt < HEARTBEAT_MILLISECONDS) return
    last = next
    lastAt = now
    sentOnce = true
    try {
      chrome.runtime.sendMessage({ target, position: next }).catch(stop)
    } catch (error) {
      stop(error)
    }
  }

  scope.__hdadWatchReaderTimer = setInterval(tick, READ_INTERVAL_MILLISECONDS)
  tick()
}

/** 再生位置の読み取りを止める（タブの中で動く） */
export const stopWatchReader = (): void => {
  const scope = window as unknown as WatchReaderScope
  clearInterval(scope.__hdadWatchReaderTimer)
  delete scope.__hdadWatchReaderTimer
}

const isShallowPosition = (value: unknown): value is WatchPosition =>
  isRecord(value) &&
  typeof value.positionSeconds === 'number' &&
  typeof value.playing === 'boolean' &&
  typeof value.rate === 'number' &&
  (value.title === null || typeof value.title === 'string') &&
  (value.episode === null || typeof value.episode === 'string') &&
  (value.imageUrl === null || typeof value.imageUrl === 'string')

/**
 * 届いた連絡を読む。形の詳しい検証は offscreen document（src/tab/watch-position.ts の parseWatchPosition）が持つ
 * （サービスワーカーは同じファイルを実行時に読み込めないので、ここは型を確かめるだけにする）。
 *
 * @returns 読み取りからの知らせでなければ null
 * @throws 読み取りからの知らせなのに形が違う場合
 */
export const parseWatchReaderMessage = (value: unknown): WatchReaderMessage | null => {
  if (!isRecord(value) || value.target !== WATCH_READER_TARGET) return null
  if (value.position === null) return { position: null }
  if (!isShallowPosition(value.position)) throw new Error('再生位置の読み取りからの知らせの形が想定と違います')
  return { position: value.position }
}
