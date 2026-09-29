/**
 * BGMの管理画面の値の変換（form.ts）のテスト
 *
 * 画面（bgm-page.tsx）から分けてテストする（speech/form.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import type { BgmTrack } from './api'
import { describeBgmProblem, newTrackOf, unusedAudioOf, volumeOfPercent, volumePercentOf } from './form'

const 雑談の曲: BgmTrack = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  mood: 'ゆったりしたアコースティック',
  scene: '雑談・作業配信',
}

describe('describeBgmProblem', () => {
  it('Worker が返した項目の位置を、画面に見えている名前に読み替える', () => {
    expect(describeBgmProblem('tracks[0].title: 1〜100文字で指定してください')).toBe('1曲目の曲名: 1〜100文字で指定してください')
    expect(describeBgmProblem('tracks[2].creditUrl: http:// か https:// で始まるURLにしてください（無ければ空欄）')).toBe(
      '3曲目のクレジット先のURL: http:// か https:// で始まるURLにしてください（無ければ空欄）',
    )
    expect(describeBgmProblem('volume: 0〜1 の数で指定してください')).toBe('音量: 0〜1 の数で指定してください')
  })

  it('読み替えられないものはそのまま出す（黙って捨てない）', () => {
    expect(describeBgmProblem('tracks: 100曲以内にしてください')).toBe('tracks: 100曲以内にしてください')
  })
})

describe('音量の百分率', () => {
  it('0〜1 の音量と、スライダーの 0〜100 を行き来する', () => {
    expect(volumePercentOf(0.3)).toBe(30)
    expect(volumeOfPercent(45)).toBe(0.45)
  })

  it('小数の誤差を持ち込まない', () => {
    expect(volumePercentOf(0.29)).toBe(29)
    expect(volumeOfPercent(29)).toBe(0.29)
  })
})

describe('newTrackOf', () => {
  it('上げた音声から曲を作り、ファイル名から拡張子を落として曲名の下書きにする', () => {
    expect(newTrackOf({ id: 'media-moriagari', name: '全力疾走.mp3' })).toEqual({
      mediaId: 'media-moriagari',
      title: '全力疾走',
      credit: '',
      creditUrl: '',
      mood: '',
      scene: '',
    })
  })

  it('拡張子の無いファイル名はそのまま曲名にする', () => {
    expect(newTrackOf({ id: 'media-1', name: 'ひだまり' }).title).toBe('ひだまり')
  })
})

describe('unusedAudioOf', () => {
  it('上げた素材のうち、まだ曲にしていない音声だけを返す', () => {
    const 素材 = [
      { id: 'media-zatsudan', name: 'hidamari.mp3', kind: 'audio' as const },
      { id: 'media-moriagari', name: 'zenryoku.mp3', kind: 'audio' as const },
      { id: 'media-gazou', name: 'kanpai.png', kind: 'image' as const },
    ]

    expect(unusedAudioOf(素材, [雑談の曲]).map((item) => item.id)).toEqual(['media-moriagari'])
  })
})
