/**
 * 市町村紹介のナレーション（issue #255）で読み上げる文
 *
 * 紹介の冒頭の一文と、画面に流す場面（大見出し・各項目・配信者への振り。tour.ts の tourLinesOf）を、
 * VOICEVOX のナレーターの声で読み上げる。ここは何を読むかと、合成を頼める文の長さの上限を決める。
 * 合成は合成ページが Worker の POST /api/overlay/town-tour/narration に頼み（api.ts）、Worker はこの上限を超える文を断る
 * （Worker から src/ を読み込む例外。同じ上限を2か所に書くと食い違うため）。
 *
 * 大見出しと振りと共通点（issue #275）は見出し（「この町、実は…」「ところで…」「○○さんとこの町、実は…」）から読み、項目は見出し（「名物」など）を読まずに文だけを読む。
 * 大見出しの見出しは文より先に画面に出る溜めで、読み上げでも溜めにするためである。
 *
 * 設定（読み上げるか・話者・速度。TownTourNarration）の形と読み取りもここに置く（Worker の worker/town-tour-narration.ts の
 * 保存する形と、管理画面が Worker の応答を読むときに使う。同じ形を2か所に書くと食い違うため）。
 *
 * 読み込んだ音声（NarrationClip）の長さで場面の長さを延ばすのは timeline.ts、鳴らす時刻と BGM を下げる時刻を決めるのは
 * sound-cues.ts で、ここはその型と、余白・BGM を下げる割合の定数を持つ。
 *
 * 注意: 通信も DOM も持ち込まない（Worker からも読むため）。
 */
import type { TourLine } from './tour'

/**
 * 合成を頼める読み上げ文の長さの上限（文字数）。
 *
 * 冒頭の一文（レイド元の表示名25文字と市町村の名前を入れたもの）と、LLM が作れる最長の項目（worker/town-tour.ts の
 * MAX_POINT_LENGTH）が収まる長さにする（収まることは worker/town-tour-narration.test.ts が確かめる）。
 * 合成の経路はオーバーレイ用キーで呼べるので、これより長いものは Worker が断って課金を抑える。
 */
export const TOWN_TOUR_NARRATION_TEXT_MAX_LENGTH = 100

/** 市町村紹介のナレーションの設定 */
export interface TownTourNarration {
  /** 読み上げるか */
  readonly enabled: boolean
  /** 話者ID（VOICEVOX のキャラクターとスタイルの組み合わせ） */
  readonly speaker: number
  /** 読み上げ速度（1 が標準） */
  readonly speed: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * Worker が返した保存済みのナレーションの設定を読む（管理画面）。値の範囲は Worker だけが確かめる。
 *
 * @throws 読み上げるか・話者・速度のどれかが欠けている場合（欠けたものを「読み上げない」と読むと、壊れた応答に気づけないため）
 */
export const readTownTourNarration = (value: unknown): TownTourNarration => {
  if (!isRecord(value)) throw new Error('Workerの市町村紹介のナレーションの設定がありません')
  const { enabled, speaker, speed } = value
  if (typeof enabled !== 'boolean' || typeof speaker !== 'number' || typeof speed !== 'number') {
    throw new Error('Workerの市町村紹介のナレーションの設定に、読み上げるか・話者・速度のどれかがありません')
  }
  return { enabled, speaker, speed }
}

/**
 * 読み上げを終えてから次の場面へ進むまでの余白（ミリ秒）。
 * 読み上げが場面の決まった長さに収まらないときに、場面を「読み上げの長さ＋余白」まで延ばす（読み終えてすぐに文を消さないため）
 */
export const NARRATION_TAIL_MS = 800

/** 読み上げているあいだの、紹介の BGM の音量の割合（設定の BGM の音量に掛ける） */
export const NARRATION_BGM_RATIO = 0.4

/** 読み込み終えた読み上げの音声1つ */
export interface NarrationClip {
  /** 鳴らす音声の URL（合成ページが Worker から受け取った音声を指す blob: の URL） */
  readonly url: string
  /** 音声の長さ（ミリ秒） */
  readonly duration: number
}

/**
 * 1件の紹介の、読み込み終えた読み上げの音声。合成できなかった・読み込めなかったものは null で、その場面は文字だけを
 * 決まった長さで流す（配信者が決めた）。lines は画面に流す場面と同じ並び・同じ数
 */
export interface Narration {
  readonly opening: NarrationClip | null
  readonly lines: readonly (NarrationClip | null)[]
}

/** 1件の紹介で読み上げる文。lines は画面に流す場面と同じ並び・同じ数 */
export interface NarrationTexts {
  /** 冒頭の一文（ズームの着地で読む） */
  readonly opening: string
  /** 場面ごとの読み上げる文 */
  readonly lines: readonly string[]
}

/** 場面1つぶんの読み上げる文。項目は見出しを読まず、大見出しと振りと共通点は見出しから読む */
const narrationTextOf = (line: TourLine): string => (line.kind === 'point' ? line.text : `${line.label}${line.text}`)

/**
 * 1件の紹介で読み上げる文を並べる。
 *
 * @param headline 冒頭の一文（呼び出しの headline。都道府県入りのもの）
 * @param lines 画面に流す場面（tour.ts の tourLinesOf）
 */
export const narrationTextsOf = (headline: string, lines: readonly TourLine[]): NarrationTexts => ({
  opening: headline,
  lines: lines.map(narrationTextOf),
})
