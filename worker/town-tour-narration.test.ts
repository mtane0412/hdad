/**
 * 市町村紹介のナレーションの設定（town-tour-narration.ts）のテスト
 *
 * 読み上げるかどうか・話者・速度の検証・保存・読み出しを確かめる。特に重要なのは次の点である。
 * - 未保存なら読み上げないこと（さくらのAI Engine は従量課金なので、選ぶまで課金を起こさない）
 * - 問題点を最初の1件で止めずにすべて集めること（管理画面で一度に直せるようにするため）
 * - チャットの読み上げの設定とは別の場所に保存すること（声を分けられるようにするため）
 */
import { describe, expect, it } from 'vitest'
import { TOWN_TOUR_NARRATION_TEXT_MAX_LENGTH, narrationTextsOf } from '../src/town-tour/narration'
import { tourLinesOf } from '../src/town-tour/tour'
import towns from '../src/town-tour/towns.json'
import { ConfigError } from './alert-config'
import { createFakeStore } from './fake-store'
import { loadSpeechSettings } from './speech-config'
import { MAX_CUE_LENGTH, MAX_HOOK_LENGTH, MAX_LABEL_LENGTH, MAX_POINT_LENGTH, MAX_POINTS } from './town-tour'
import { townTourCallOf } from './town-tour-call'
import { DEFAULT_TOWN_TOUR_SOUND } from './town-tour-sound'
import { DEFAULT_TOWN_TOUR_NARRATION, loadTownTourNarration, parseTownTourNarration, saveTownTourNarration } from './town-tour-narration'

/** 検証で投げられた問題点を取り出す */
const problemsOf = (input: unknown): readonly string[] => {
  try {
    parseTownTourNarration(input)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('問題点が無いまま通りました')
}

describe('parseTownTourNarration', () => {
  it('読み上げる・話者・速度がそろっていれば、そのまま保存用の形にする', () => {
    expect(parseTownTourNarration({ enabled: true, speaker: 13, speed: 1.2 })).toEqual({ enabled: true, speaker: 13, speed: 1.2 })
  })

  it('読み上げないにしても、話者と速度は検証して残す（次に読み上げるにしたとき選び直さずに済むように）', () => {
    expect(parseTownTourNarration({ enabled: false, speaker: 2, speed: 0.9 })).toEqual({ enabled: false, speaker: 2, speed: 0.9 })
  })

  it('問題点は最初の1件で止めずに、すべて集めて断る', () => {
    expect(problemsOf({ enabled: 'はい', speaker: 1.5, speed: 3 })).toEqual([
      'enabled: true か false で指定してください',
      'speaker: 0〜100000 の整数で指定してください',
      'speed: 0.5〜2 の数で指定してください',
    ])
  })

  it('オブジェクトでなければ断る', () => {
    expect(problemsOf('ずんだもん')).toEqual(['設定はオブジェクトで指定してください'])
  })
})

describe('loadTownTourNarration・saveTownTourNarration', () => {
  it('未保存なら読み上げない設定を返す', async () => {
    const store = createFakeStore()
    expect(await loadTownTourNarration(store)).toEqual(DEFAULT_TOWN_TOUR_NARRATION)
    expect(DEFAULT_TOWN_TOUR_NARRATION.enabled).toBe(false)
  })

  it('保存した設定を次に読んだときも返し、チャットの読み上げの設定は変えない', async () => {
    const store = createFakeStore()
    const before = await loadSpeechSettings(store)
    await saveTownTourNarration(store, { enabled: true, speaker: 13, speed: 1.1 })
    expect(await loadTownTourNarration(store)).toEqual({ enabled: true, speaker: 13, speed: 1.1 })
    expect(await loadSpeechSettings(store)).toEqual(before)
  })
})

describe('読み上げる文の長さ', () => {
  /** Twitch の表示名の最長（25文字） */
  const longestUserName = 'あ'.repeat(25)

  it('どの市町村のレイドの冒頭の一文も、合成を頼める長さに収まる（合成の経路が断らないように）', () => {
    const longest = Math.max(
      ...towns.map(
        (town) =>
          [...townTourCallOf(town, { occasion: 'raid', userName: longestUserName, viewers: 1 }, DEFAULT_TOWN_TOUR_SOUND, null, 'quiz-1', [], true).headline].length,
      ),
    )
    expect(longest).toBeLessThanOrEqual(TOWN_TOUR_NARRATION_TEXT_MAX_LENGTH)
  })

  it('LLM が作れる最長の大見出し・項目・振りも、合成を頼める長さに収まる', () => {
    const longestTour = {
      hook: 'あ'.repeat(MAX_HOOK_LENGTH),
      points: Array.from({ length: MAX_POINTS }, () => ({ label: 'い'.repeat(MAX_LABEL_LENGTH), text: 'う'.repeat(MAX_POINT_LENGTH) })),
      cue: 'え'.repeat(MAX_CUE_LENGTH),
    }
    const { lines } = narrationTextsOf('冒頭の一文', tourLinesOf(longestTour, '府中市'))
    expect(Math.max(...lines.map((line) => [...line].length))).toBeLessThanOrEqual(TOWN_TOUR_NARRATION_TEXT_MAX_LENGTH)
  })
})
