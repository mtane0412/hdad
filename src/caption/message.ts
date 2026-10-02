/**
 * 字幕のやりとり（アプリの枠 → 字幕の中継先 → 合成ページ）
 *
 * アプリの枠の音声認識（src/transcript/recognition-context.tsx）が送り、合成ページの字幕の素材が受け取るのは、
 * この形の文字列だけである（issue #190）。中継先（worker/draw-channel.ts の DrawChannel を caption の名前で使う）は
 * 中身を読まないので、形の確かめは受け取った側がここで行う。
 *
 * - interim: 話している途中の文。認識が書き換わるたびに届く。空文字は「話している途中の文が無くなった」
 *   （話し終えた・認識が途切れた）ことを表す
 * - final: 確定した文。中身のある発話だけが届く
 *
 * 注意: 想定した形でなければエラーにする。黙って捨てると、字幕が出ない原因に気付けない。
 */

/** 話している途中の文 */
export interface CaptionInterim {
  readonly type: 'interim'
  readonly text: string
}

/** 確定した文 */
export interface CaptionFinal {
  readonly type: 'final'
  readonly text: string
}

/** アプリの枠から合成ページへ流れる1通 */
export type CaptionMessage = CaptionInterim | CaptionFinal

/**
 * 1通の本文の長さの上限。確定した発話の記録の上限（worker/transcript-routes.ts の TRANSCRIPT_MAX_LENGTH）に合わせる。
 * worker/ はブラウザ用のコードから読み込まない約束なので、数はここで持ち直す。
 */
export const CAPTION_MAX_LENGTH = 1000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isText = (value: unknown): value is string => typeof value === 'string' && value.length <= CAPTION_MAX_LENGTH

/**
 * 届いた1通を読み取る。
 *
 * @param payload WebSocketで届いた文字列
 * @throws JSONとして読めない場合、知らない種類の場合、想定した形でない場合
 */
export const parseCaptionMessage = (payload: string): CaptionMessage => {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    throw new Error('字幕を読み取れませんでした（JSONとして読めません）')
  }
  if (isRecord(value) && isText(value.text)) {
    if (value.type === 'interim') return { type: 'interim', text: value.text }
    if (value.type === 'final' && value.text !== '') return { type: 'final', text: value.text }
  }
  throw new Error('字幕の形が想定と違います')
}
