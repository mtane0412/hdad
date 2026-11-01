// @vitest-environment jsdom
/**
 * 同時視聴でタブに差し込む、再生位置の読み取りのテスト（issue #443）
 *
 * startWatchReader は chrome.scripting.executeScript でタブへ差し込まれ、ページの <video> を毎秒読む。
 * 実機（Prime Video）で確かめた形に合わせ、<video> の currentTime と、ページ題名に含まれる alt を持つ大きな画像を読む。
 * chrome.runtime.sendMessage は偽物に差し替え、次を確かめる。
 * - 再生位置と題名・画像を読んで知らせる
 * - 変わらなければ毎秒は知らせず、シークのような飛びはすぐ知らせ、補正のためときどき知らせる
 * - <video> が無ければ再生していないと知らせる
 * - 二重に差し込まれても1つしか動かず、止めたら知らせなくなる
 * - 関数の文字列だけから動かしても動く（Chrome が文字列にして送るため）
 * また、サービスワーカーが受け取った知らせを読み分けられることを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseWatchReaderMessage, startWatchReader, stopWatchReader, WATCH_READER_TARGET } from './watch-reader'

const IMAGE_URL = 'https://images-fe.ssl-images-amazon.com/images/S/pv-target-images/work-image.jpg'
const sendMessage = vi.fn(async () => undefined)

/** ページに <video> を置く（jsdom は再生しないので、値を差し替えて動かす） */
const addVideo = (state: { currentTime: number; paused: boolean; duration?: number; playbackRate?: number }): typeof state => {
  const video = document.createElement('video')
  for (const name of ['currentTime', 'paused', 'duration', 'playbackRate'] as const) {
    Object.defineProperty(video, name, { get: () => state[name] ?? (name === 'duration' ? 7163 : 1) })
  }
  document.body.append(video)
  return state
}

const addImage = (alt: string, width: number, src = IMAGE_URL): void => {
  const image = document.createElement('img')
  image.alt = alt
  image.src = src
  Object.defineProperty(image, 'naturalWidth', { value: width })
  document.body.append(image)
}

const sentPositions = (): unknown[] => sendMessage.mock.calls.map((call: unknown[]) => (call[0] as { position: unknown }).position)

beforeEach(() => {
  vi.useFakeTimers()
  sendMessage.mockClear()
  vi.stubGlobal('chrome', { runtime: { sendMessage } })
  document.title = 'Amazon.co.jp: 湾岸署の映画を観る | Prime Video'
})

afterEach(() => {
  stopWatchReader()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('startWatchReader', () => {
  it('再生位置と、ページ題名に含まれる alt を持つ大きな画像を読んで知らせる', () => {
    addVideo({ currentTime: 34, paused: false })
    addImage('動画を観るなら', 800, 'https://m.media-amazon.com/images/広告.jpg')
    addImage('湾岸署の映画', 1300)
    addImage('', 498, 'https://m.media-amazon.com/images/別の作品.jpg')

    startWatchReader(WATCH_READER_TARGET)

    expect(sendMessage).toHaveBeenCalledWith({
      target: WATCH_READER_TARGET,
      position: { positionSeconds: 34, playing: true, rate: 1, title: '湾岸署の映画', imageUrl: IMAGE_URL },
    })
  })

  it('題名の画像が無ければ、題名と画像は null のまま知らせる', () => {
    addVideo({ currentTime: 34, paused: false })

    startWatchReader(WATCH_READER_TARGET)

    expect(sentPositions()).toEqual([{ positionSeconds: 34, playing: true, rate: 1, title: null, imageUrl: null }])
  })

  it('予想どおりに進んでいるあいだは毎秒知らせない', () => {
    const video = addVideo({ currentTime: 34, paused: false })
    startWatchReader(WATCH_READER_TARGET)
    sendMessage.mockClear()

    for (let second = 1; second <= 5; second += 1) {
      video.currentTime = 34 + second
      vi.advanceTimersByTime(1000)
    }

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('シークで位置が飛んだらすぐ知らせる', () => {
    const video = addVideo({ currentTime: 34, paused: false })
    startWatchReader(WATCH_READER_TARGET)
    sendMessage.mockClear()

    video.currentTime = 45
    vi.advanceTimersByTime(1000)

    expect(sentPositions()).toEqual([expect.objectContaining({ positionSeconds: 45 })])
  })

  it('一時停止したらすぐ知らせる', () => {
    const video = addVideo({ currentTime: 34, paused: false })
    startWatchReader(WATCH_READER_TARGET)
    sendMessage.mockClear()

    video.paused = true
    video.currentTime = 35
    vi.advanceTimersByTime(1000)

    expect(sentPositions()).toEqual([expect.objectContaining({ playing: false })])
  })

  it('変わらなくても30秒ごとに知らせる（送り手のつなぎ直しや時刻のずれを埋めるため）', () => {
    const video = addVideo({ currentTime: 0, paused: false })
    startWatchReader(WATCH_READER_TARGET)
    sendMessage.mockClear()

    for (let second = 1; second <= 30; second += 1) {
      video.currentTime = second
      vi.advanceTimersByTime(1000)
    }

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('<video> が無ければ再生していないと知らせ、現れたら知らせる', () => {
    startWatchReader(WATCH_READER_TARGET)
    expect(sentPositions()).toEqual([null])

    addVideo({ currentTime: 3, paused: false })
    vi.advanceTimersByTime(1000)

    expect(sentPositions()[1]).toEqual(expect.objectContaining({ positionSeconds: 3 }))
  })

  it('<video> が複数あれば、いちばん長いものを本編として読む（作品一覧の短い予告を読まないため）', () => {
    addVideo({ currentTime: 5, paused: false, duration: 30 })
    addVideo({ currentTime: 34, paused: false, duration: 7163 })

    startWatchReader(WATCH_READER_TARGET)

    expect(sentPositions()).toEqual([expect.objectContaining({ positionSeconds: 34 })])
  })

  it('二重に差し込まれても1つしか動かない', () => {
    addVideo({ currentTime: 34, paused: false })

    startWatchReader(WATCH_READER_TARGET)
    startWatchReader(WATCH_READER_TARGET)

    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('止めたら知らせなくなる', () => {
    const video = addVideo({ currentTime: 34, paused: false })
    startWatchReader(WATCH_READER_TARGET)
    sendMessage.mockClear()

    stopWatchReader()
    video.currentTime = 500
    vi.advanceTimersByTime(5000)

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('関数の文字列だけから動かしても動く', () => {
    addVideo({ currentTime: 34, paused: false })
    const rebuilt = new Function(`return (${startWatchReader.toString()})`)() as typeof startWatchReader

    rebuilt(WATCH_READER_TARGET)

    expect(sentPositions()).toEqual([expect.objectContaining({ positionSeconds: 34 })])
  })
})

describe('parseWatchReaderMessage', () => {
  const position = { positionSeconds: 34, playing: true, rate: 1, title: '湾岸署の映画', imageUrl: null }

  it('読み取りからの知らせを読む', () => {
    expect(parseWatchReaderMessage({ target: WATCH_READER_TARGET, position })).toEqual({ position })
    expect(parseWatchReaderMessage({ target: WATCH_READER_TARGET, position: null })).toEqual({ position: null })
  })

  it('あて先が違えば null を返す', () => {
    expect(parseWatchReaderMessage({ target: 'offscreen', position })).toBeNull()
  })

  it('形が違えばエラーにする', () => {
    expect(() => parseWatchReaderMessage({ target: WATCH_READER_TARGET, position: { positionSeconds: '34' } })).toThrow('再生位置の読み取りからの知らせの形が想定と違います')
  })
})
