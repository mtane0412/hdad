/**
 * BGMの曲と再生の設定（bgm-config.ts）のテスト
 *
 * 曲の一覧と「いま流す曲・音量」の検証・保存・読み出しを確かめる。特に重要なのは次の点である。
 * - 問題点を最初の1件で止めずにすべて集めること（管理画面で一度に直せるようにするため）
 * - 音声として上げた素材しか曲にできないこと
 * - 流している曲を一覧から消させないこと（配信中に黙って無音にならないように）
 * - Jev に曲を選ばせる設定は既定でオフであること（issue #153）
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import {
  DEFAULT_BGM_PLAYBACK,
  DEFAULT_BGM_SETTINGS,
  loadBgmPlayback,
  loadBgmSettings,
  loadBgmSwitchedAt,
  loadBgmTracks,
  nowPlayingOf,
  playingTrackOf,
  parseBgmPlayback,
  parseBgmSettings,
  parseBgmTracks,
  saveBgmPlayback,
  saveBgmSettings,
  saveBgmSwitchedAt,
  saveBgmTracks,
  type BgmTrack,
} from './bgm-config'
import type { MediaKind } from './alert-config'
import { createFakeStore } from './fake-store'

/** 雑談のときに流したい、落ち着いた曲 */
const casualTrack: BgmTrack = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  mood: 'ゆったりしたアコースティック',
  scene: '雑談・作業配信',
}

/** ゲームで盛り上がったときに流したい曲 */
const hypeTrack: BgmTrack = {
  mediaId: 'media-moriagari',
  title: '全力疾走',
  credit: '音楽: DOVA-SYNDROME',
  creditUrl: 'https://dova-s.jp/',
  mood: 'テンポの速いロック',
  scene: 'ボス戦・盛り上がったとき',
}

/** 上げてある素材の種類。音声のほかに画像も置いてある */
const MEDIA_KINDS = new Map<string, MediaKind>([
  ['media-zatsudan', 'audio'],
  ['media-moriagari', 'audio'],
  ['media-gazou', 'image'],
])
const lookupMediaKind = (mediaId: string): MediaKind | null => MEDIA_KINDS.get(mediaId) ?? null

/** 投げられた ConfigError の問題点を取り出す */
const problemsOf = (run: () => unknown): readonly string[] => {
  try {
    run()
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('ConfigError が投げられませんでした')
}

describe('parseBgmTracks', () => {
  it('正しい曲の一覧はそのまま受け取る', () => {
    expect(parseBgmTracks({ tracks: [casualTrack, hypeTrack] }, lookupMediaKind, null)).toEqual([casualTrack, hypeTrack])
  })

  it('クレジット先のURL・曲調・流したい場面は空でもよい', () => {
    const minimalTrack = { ...casualTrack, creditUrl: '', mood: '', scene: '' }

    expect(parseBgmTracks({ tracks: [minimalTrack] }, lookupMediaKind, null)).toEqual([minimalTrack])
  })

  it('前後の空白は落として受け取る', () => {
    const paddedTrack = { ...casualTrack, title: '  ひだまりの午後  ', credit: ' 音楽: 甘茶の音楽工房 ' }

    expect(parseBgmTracks({ tracks: [paddedTrack] }, lookupMediaKind, null)).toEqual([casualTrack])
  })

  it('tracks が配列でなければ拒む', () => {
    expect(problemsOf(() => parseBgmTracks({}, lookupMediaKind, null))).toEqual(['tracks: 配列で指定してください'])
  })

  it('曲名とクレジット表記が空なら、両方の問題点をまとめて返す', () => {
    const emptyTrack = { ...casualTrack, title: ' ', credit: '' }

    expect(problemsOf(() => parseBgmTracks({ tracks: [emptyTrack] }, lookupMediaKind, null))).toEqual([
      'tracks[0].title: 1〜60文字で指定してください',
      'tracks[0].credit: 1〜100文字で指定してください',
    ])
  })

  it('クレジット先のURLは200文字まで（チャットの1通に曲名・クレジット表記と一緒に収めるため）', () => {
    const longUrl = { ...casualTrack, creditUrl: `https://example.com/${'a'.repeat(181)}` }

    expect(problemsOf(() => parseBgmTracks({ tracks: [longUrl] }, lookupMediaKind, null))).toEqual(['tracks[0].creditUrl: 200文字以内の文字列で指定してください'])
  })

  it('クレジット先のURLは http か https のURLに限る', () => {
    const invalidUrl = { ...casualTrack, creditUrl: 'javascript:alert(1)' }

    expect(problemsOf(() => parseBgmTracks({ tracks: [invalidUrl] }, lookupMediaKind, null))).toEqual([
      'tracks[0].creditUrl: http:// か https:// で始まるURLにしてください（無ければ空欄）',
    ])
  })

  it('音声でない素材や、無い素材は曲にできない', () => {
    const imageTrack = { ...casualTrack, mediaId: 'media-gazou' }
    const missingMediaTrack = { ...hypeTrack, mediaId: 'media-nai' }

    expect(problemsOf(() => parseBgmTracks({ tracks: [imageTrack, missingMediaTrack] }, lookupMediaKind, null))).toEqual([
      'tracks[0].mediaId: 素材「media-gazou」は音声ではありません',
      'tracks[1].mediaId: 素材「media-nai」が存在しません',
    ])
  })

  it('同じ素材を2曲に使えない', () => {
    const duplicateMediaTrack = { ...hypeTrack, mediaId: casualTrack.mediaId }

    expect(problemsOf(() => parseBgmTracks({ tracks: [casualTrack, duplicateMediaTrack] }, lookupMediaKind, null))).toEqual([
      'tracks[1].mediaId: 素材「media-zatsudan」はすでに別の曲に使われています',
    ])
  })

  it('流している曲は一覧から消させない', () => {
    expect(problemsOf(() => parseBgmTracks({ tracks: [hypeTrack] }, lookupMediaKind, casualTrack.mediaId))).toEqual([
      'tracks: 流している曲（素材「media-zatsudan」）は消せません。先に止めるか別の曲に切り替えてください',
    ])
  })

  it('曲の数に上限がある', () => {
    const tooManyTracks = Array.from({ length: 101 }, (_, index) => ({ ...casualTrack, mediaId: `media-${index}` }))

    expect(problemsOf(() => parseBgmTracks({ tracks: tooManyTracks }, () => 'audio', null))).toEqual(['tracks: 100曲以内にしてください'])
  })
})

describe('parseBgmPlayback', () => {
  const trackMediaIds = [casualTrack.mediaId, hypeTrack.mediaId]

  it('一覧にある曲と音量を受け取る', () => {
    expect(parseBgmPlayback({ mediaId: casualTrack.mediaId, volume: 0.4 }, trackMediaIds)).toEqual({ mediaId: casualTrack.mediaId, volume: 0.4 })
  })

  it('止めるときは mediaId に null を送る', () => {
    expect(parseBgmPlayback({ mediaId: null, volume: 0.4 }, trackMediaIds)).toEqual({ mediaId: null, volume: 0.4 })
  })

  it('一覧にない曲と範囲の外の音量は、両方の問題点をまとめて返す', () => {
    expect(problemsOf(() => parseBgmPlayback({ mediaId: 'media-nai', volume: 1.5 }, trackMediaIds))).toEqual([
      'mediaId: 素材「media-nai」の曲は一覧にありません',
      'volume: 0〜1 の数で指定してください',
    ])
  })

  it('オブジェクトでなければ拒む', () => {
    expect(problemsOf(() => parseBgmPlayback('雑談の曲', trackMediaIds))).toEqual(['設定はオブジェクトで指定してください'])
  })
})

describe('保存と読み出し', () => {
  it('未保存なら、曲は空で、何も流さない', async () => {
    const store = createFakeStore()

    expect(await loadBgmTracks(store)).toEqual([])
    expect(await loadBgmPlayback(store)).toEqual(DEFAULT_BGM_PLAYBACK)
    expect(DEFAULT_BGM_PLAYBACK.mediaId).toBeNull()
  })

  it('保存した曲と再生の設定を読み出せる', async () => {
    const store = createFakeStore()

    await saveBgmTracks(store, [casualTrack])
    await saveBgmPlayback(store, { mediaId: casualTrack.mediaId, volume: 0.2 })

    expect(await loadBgmTracks(store)).toEqual([casualTrack])
    expect(await loadBgmPlayback(store)).toEqual({ mediaId: casualTrack.mediaId, volume: 0.2 })
  })
})

describe('nowPlayingOf', () => {
  it('流している曲の情報に、オーバーレイ用キーつきの音声のURLを添える', () => {
    expect(nowPlayingOf([casualTrack, hypeTrack], { mediaId: hypeTrack.mediaId, volume: 0.5 }, 'overlay-key')).toEqual({
      track: {
        mediaId: hypeTrack.mediaId,
        title: '全力疾走',
        credit: '音楽: DOVA-SYNDROME',
        creditUrl: 'https://dova-s.jp/',
        url: '/api/media/media-moriagari?key=overlay-key',
      },
      volume: 0.5,
    })
  })

  it('止めているときは track が null', () => {
    expect(nowPlayingOf([casualTrack], { mediaId: null, volume: 0.5 }, 'overlay-key')).toEqual({ track: null, volume: 0.5 })
  })

  it('流す曲が一覧に無ければ、黙って止めずに投げる', () => {
    expect(() => nowPlayingOf([casualTrack], { mediaId: 'media-nai', volume: 0.5 }, 'overlay-key')).toThrow('素材「media-nai」の曲が一覧にありません')
  })
})

describe('playingTrackOf', () => {
  it('流している曲を一覧から引く', () => {
    expect(playingTrackOf([casualTrack, hypeTrack], { mediaId: hypeTrack.mediaId, volume: 0.5 })).toEqual(hypeTrack)
  })

  it('止めているときは null（止めているのは正常な状態なので投げない）', () => {
    expect(playingTrackOf([casualTrack], { mediaId: null, volume: 0.5 })).toBeNull()
  })

  it('流す曲が一覧に無ければ、黙って止めずに投げる', () => {
    expect(() => playingTrackOf([casualTrack], { mediaId: 'media-nai', volume: 0.5 })).toThrow('素材「media-nai」の曲が一覧にありません')
  })
})

describe('parseBgmSettings', () => {
  it('Jev に曲を選ばせるかを受け取る', () => {
    expect(parseBgmSettings({ judgeWithJev: true })).toEqual({ judgeWithJev: true })
  })

  it('true か false でなければ拒む', () => {
    expect(() => parseBgmSettings({ judgeWithJev: 'はい' })).toThrow(ConfigError)
    expect(() => parseBgmSettings(null)).toThrow(ConfigError)
  })
})

describe('BGMの設定の保存と読み出し', () => {
  it('未保存なら、Jev に曲を選ばせない（誤った切り替えは配信の雰囲気を壊すため、既定はオフ）', async () => {
    expect(DEFAULT_BGM_SETTINGS).toEqual({ judgeWithJev: false })
    expect(await loadBgmSettings(createFakeStore())).toEqual({ judgeWithJev: false })
  })

  it('保存した設定を読み出せる', async () => {
    const store = createFakeStore()
    await saveBgmSettings(store, { judgeWithJev: true })
    expect(await loadBgmSettings(store)).toEqual({ judgeWithJev: true })
  })
})

describe('最後に曲を切り替えた時刻', () => {
  it('まだ一度も記録していなければ null', async () => {
    expect(await loadBgmSwitchedAt(createFakeStore())).toBeNull()
  })

  it('記録した時刻を読み出せる', async () => {
    const store = createFakeStore()
    const switchedAt = Date.parse('2026-09-29T12:00:00Z')
    await saveBgmSwitchedAt(store, switchedAt)
    expect(await loadBgmSwitchedAt(store)).toBe(switchedAt)
  })
})
