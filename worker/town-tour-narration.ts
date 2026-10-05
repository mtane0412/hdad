/**
 * 市町村紹介のナレーションの設定（issue #255）
 *
 * 市町村紹介の冒頭の一文・大見出し・各項目・配信者への振りを VOICEVOX のナレーターの声で読み上げるかどうかと、
 * 読み上げの話者・速度を管理画面（/triggers/ の「市町村紹介」のカード）から受け取って検証し、ストア（KV）に保存する。
 * 合成は合成ページが POST /api/overlay/town-tour/narration で頼み、Worker がこの設定の話者と速度で
 * さくらのAI Engine に合成させる（worker/town-tour-routes.ts）。
 *
 * チャットの読み上げの設定（speech-config.ts。KV の speech-settings）とは別に持つ。ナレーションをチャットの読み上げと
 * 別の声にできるようにするためである（配信者が決めた）。値の範囲はチャットの読み上げと同じにする（同じ VOICEVOX を呼ぶため）。
 *
 * 設定の形（TownTourNarration）は管理画面と同じものを src/town-tour/narration.ts から読む（Worker から src/ を読み込む例外）。
 * 作りは town-tour-sound.ts と同じで、問題点は最初の1件で止めずにすべて集めてから拒否する（管理画面で一度に直せるようにするため）。
 *
 * 注意: さくらのAI Engine は従量課金なので、未保存なら読み上げない。
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
import type { TownTourNarration } from '../src/town-tour/narration'
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

export type { TownTourNarration }

const NARRATION_KEY = 'town-tour-narration'
/** 問題点のメッセージに出す、何の設定かの名前 */
const NARRATION_SUBJECT = '市町村紹介のナレーション'
/** 話者ID（VOICEVOX のキャラクターとスタイルの組み合わせ）。範囲は speech-config.ts と合わせる */
const MIN_SPEAKER = 0
const MAX_SPEAKER = 100000
const MIN_SPEED = 0.5
const MAX_SPEED = 2

/**
 * 未保存のときの設定。読み上げない。
 * 話者IDの 3 は「ずんだもん（ノーマル）」で、チャットの読み上げの既定（DEFAULT_SPEECH_SETTINGS）と同じにしておく
 */
export const DEFAULT_TOWN_TOUR_NARRATION: TownTourNarration = { enabled: false, speaker: 3, speed: 1 }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきたナレーションの設定を検証し、保存用の形にする。
 *
 * @param input `{ enabled, speaker, speed }`
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseTownTourNarration = (input: unknown): TownTourNarration => {
  if (!isRecord(input)) throw new ConfigError(NARRATION_SUBJECT, ['設定はオブジェクトで指定してください'])
  const problems: string[] = []

  const { enabled } = input
  if (typeof enabled !== 'boolean') problems.push('enabled: true か false で指定してください')

  /** 数の項目を読む。範囲の外なら問題点に積み、ほかの問題点と一緒に断れるよう既定の値を返す（保存はしない） */
  const readNumber = (name: 'speaker' | 'speed', min: number, max: number, integer: boolean): number => {
    const value = input[name]
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))) {
      return value
    }
    problems.push(`${name}: ${min}〜${max} の${integer ? '整数' : '数'}で指定してください`)
    return DEFAULT_TOWN_TOUR_NARRATION[name]
  }
  const speaker = readNumber('speaker', MIN_SPEAKER, MAX_SPEAKER, true)
  const speed = readNumber('speed', MIN_SPEED, MAX_SPEED, false)

  if (problems.length > 0 || typeof enabled !== 'boolean') throw new ConfigError(NARRATION_SUBJECT, problems)
  return { enabled, speaker, speed }
}

export const saveTownTourNarration = (store: KeyValueStore, narration: TownTourNarration): Promise<void> =>
  store.put(NARRATION_KEY, JSON.stringify(narration))

/** 保存済みのナレーションの設定を読む。未保存なら読み上げない */
export const loadTownTourNarration = async (store: KeyValueStore): Promise<TownTourNarration> => {
  const text = await store.get(NARRATION_KEY)
  return text === null ? DEFAULT_TOWN_TOUR_NARRATION : (JSON.parse(text) as TownTourNarration)
}
