/**
 * BGMの曲と再生の設定（bgm-config.ts）のテスト
 *
 * 曲の一覧と「いま流す曲・音量」の検証・保存・読み出しを確かめる。特に重要なのは次の点である。
 * - 問題点を最初の1件で止めずにすべて集めること（管理画面で一度に直せるようにするため）
 * - 音声として上げた素材しか曲にできないこと
 * - 流している曲を一覧から消させないこと（配信中に黙って無音にならないように）
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import {
  DEFAULT_BGM_PLAYBACK,
  loadBgmPlayback,
  loadBgmTracks,
  nowPlayingOf,
  parseBgmPlayback,
  parseBgmTracks,
  saveBgmPlayback,
  saveBgmTracks,
  type BgmTrack,
} from './bgm-config'
import type { MediaKind } from './alert-config'
import { createFakeStore } from './fake-store'

/** 雑談のときに流したい、落ち着いた曲 */
const 雑談の曲: BgmTrack = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  mood: 'ゆったりしたアコースティック',
  scene: '雑談・作業配信',
}

/** ゲームで盛り上がったときに流したい曲 */
const 盛り上がる曲: BgmTrack = {
  mediaId: 'media-moriagari',
  title: '全力疾走',
  credit: '音楽: DOVA-SYNDROME',
  creditUrl: 'https://dova-s.jp/',
  mood: 'テンポの速いロック',
  scene: 'ボス戦・盛り上がったとき',
}

/** 上げてある素材の種類。音声のほかに画像も置いてある */
const 素材の種類 = new Map<string, MediaKind>([
  ['media-zatsudan', 'audio'],
  ['media-moriagari', 'audio'],
  ['media-gazou', 'image'],
])
const 種類を引く = (mediaId: string): MediaKind | null => 素材の種類.get(mediaId) ?? null

/** 投げられた ConfigError の問題点を取り出す */
const 問題点 = (run: () => unknown): readonly string[] => {
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
    expect(parseBgmTracks({ tracks: [雑談の曲, 盛り上がる曲] }, 種類を引く, null)).toEqual([雑談の曲, 盛り上がる曲])
  })

  it('クレジット先のURL・曲調・流したい場面は空でもよい', () => {
    const 最小限の曲 = { ...雑談の曲, creditUrl: '', mood: '', scene: '' }

    expect(parseBgmTracks({ tracks: [最小限の曲] }, 種類を引く, null)).toEqual([最小限の曲])
  })

  it('前後の空白は落として受け取る', () => {
    const 空白つき = { ...雑談の曲, title: '  ひだまりの午後  ', credit: ' 音楽: 甘茶の音楽工房 ' }

    expect(parseBgmTracks({ tracks: [空白つき] }, 種類を引く, null)).toEqual([雑談の曲])
  })

  it('tracks が配列でなければ拒む', () => {
    expect(問題点(() => parseBgmTracks({}, 種類を引く, null))).toEqual(['tracks: 配列で指定してください'])
  })

  it('曲名とクレジット表記が空なら、両方の問題点をまとめて返す', () => {
    const 空の曲 = { ...雑談の曲, title: ' ', credit: '' }

    expect(問題点(() => parseBgmTracks({ tracks: [空の曲] }, 種類を引く, null))).toEqual([
      'tracks[0].title: 1〜100文字で指定してください',
      'tracks[0].credit: 1〜200文字で指定してください',
    ])
  })

  it('クレジット先のURLは http か https のURLに限る', () => {
    const 変なURL = { ...雑談の曲, creditUrl: 'javascript:alert(1)' }

    expect(問題点(() => parseBgmTracks({ tracks: [変なURL] }, 種類を引く, null))).toEqual([
      'tracks[0].creditUrl: http:// か https:// で始まるURLにしてください（無ければ空欄）',
    ])
  })

  it('音声でない素材や、無い素材は曲にできない', () => {
    const 画像の曲 = { ...雑談の曲, mediaId: 'media-gazou' }
    const 無い素材の曲 = { ...盛り上がる曲, mediaId: 'media-nai' }

    expect(問題点(() => parseBgmTracks({ tracks: [画像の曲, 無い素材の曲] }, 種類を引く, null))).toEqual([
      'tracks[0].mediaId: 素材「media-gazou」は音声ではありません',
      'tracks[1].mediaId: 素材「media-nai」が存在しません',
    ])
  })

  it('同じ素材を2曲に使えない', () => {
    const 同じ素材 = { ...盛り上がる曲, mediaId: 雑談の曲.mediaId }

    expect(問題点(() => parseBgmTracks({ tracks: [雑談の曲, 同じ素材] }, 種類を引く, null))).toEqual([
      'tracks[1].mediaId: 素材「media-zatsudan」はすでに別の曲に使われています',
    ])
  })

  it('流している曲は一覧から消させない', () => {
    expect(問題点(() => parseBgmTracks({ tracks: [盛り上がる曲] }, 種類を引く, 雑談の曲.mediaId))).toEqual([
      'tracks: 流している曲（素材「media-zatsudan」）は消せません。先に止めるか別の曲に切り替えてください',
    ])
  })

  it('曲の数に上限がある', () => {
    const 多すぎる = Array.from({ length: 101 }, (_, index) => ({ ...雑談の曲, mediaId: `media-${index}` }))

    expect(問題点(() => parseBgmTracks({ tracks: 多すぎる }, () => 'audio', null))).toEqual(['tracks: 100曲以内にしてください'])
  })
})

describe('parseBgmPlayback', () => {
  const 曲の素材 = [雑談の曲.mediaId, 盛り上がる曲.mediaId]

  it('一覧にある曲と音量を受け取る', () => {
    expect(parseBgmPlayback({ mediaId: 雑談の曲.mediaId, volume: 0.4 }, 曲の素材)).toEqual({ mediaId: 雑談の曲.mediaId, volume: 0.4 })
  })

  it('止めるときは mediaId に null を送る', () => {
    expect(parseBgmPlayback({ mediaId: null, volume: 0.4 }, 曲の素材)).toEqual({ mediaId: null, volume: 0.4 })
  })

  it('一覧にない曲と範囲の外の音量は、両方の問題点をまとめて返す', () => {
    expect(問題点(() => parseBgmPlayback({ mediaId: 'media-nai', volume: 1.5 }, 曲の素材))).toEqual([
      'mediaId: 素材「media-nai」の曲は一覧にありません',
      'volume: 0〜1 の数で指定してください',
    ])
  })

  it('オブジェクトでなければ拒む', () => {
    expect(問題点(() => parseBgmPlayback('雑談の曲', 曲の素材))).toEqual(['設定はオブジェクトで指定してください'])
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

    await saveBgmTracks(store, [雑談の曲])
    await saveBgmPlayback(store, { mediaId: 雑談の曲.mediaId, volume: 0.2 })

    expect(await loadBgmTracks(store)).toEqual([雑談の曲])
    expect(await loadBgmPlayback(store)).toEqual({ mediaId: 雑談の曲.mediaId, volume: 0.2 })
  })
})

describe('nowPlayingOf', () => {
  it('流している曲の情報に、オーバーレイ用キーつきの音声のURLを添える', () => {
    expect(nowPlayingOf([雑談の曲, 盛り上がる曲], { mediaId: 盛り上がる曲.mediaId, volume: 0.5 }, 'overlay-key')).toEqual({
      track: {
        mediaId: 盛り上がる曲.mediaId,
        title: '全力疾走',
        credit: '音楽: DOVA-SYNDROME',
        creditUrl: 'https://dova-s.jp/',
        url: '/api/media/media-moriagari?key=overlay-key',
      },
      volume: 0.5,
    })
  })

  it('止めているときは track が null', () => {
    expect(nowPlayingOf([雑談の曲], { mediaId: null, volume: 0.5 }, 'overlay-key')).toEqual({ track: null, volume: 0.5 })
  })

  it('流す曲が一覧に無ければ、黙って止めずに投げる', () => {
    expect(() => nowPlayingOf([雑談の曲], { mediaId: 'media-nai', volume: 0.5 }, 'overlay-key')).toThrow('素材「media-nai」の曲が一覧にありません')
  })
})
