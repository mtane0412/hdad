/**
 * チャットで推理で鳴らす音の判断
 *
 * 合成ページは、前に映していた一覧と新しく受け取った一覧（board.ts）を比べ、どの音を鳴らすかをここで決める。
 * - 押し出しで届いた一覧なら、ゲームを始めた・質問に答えた・解答の正誤を決めた・打ち切った（制限時間が尽きたときも）ことに合う効果音を鳴らす
 * - 読み直した一覧と、合成ページを開いて最初に受け取った一覧では、効果音を鳴らさない（つなぎ直すたびに昔のカードの音が鳴らないように）
 * - BGM は、ゲームを開催しているあいだだけ流す。読み直しでも合わせる（開催中に合成ページを開き直しても流れ、見逃した終わりでも止まるように）
 *
 * 漢字クイズ（src/kanji-quiz/sound-cues.ts）は経過時間から鳴らす時刻を決めるが、このゲームは長さが決まっておらず、場面は
 * Worker の押し出しで進むので、時刻ではなく一覧の差から決める。Audio 要素の操作は sound-player.ts、鳴らすきっかけは stage.ts の mountChatDeduction が持つ。
 *
 * 注意: 通信も DOM も持ち込まない。
 * 注意: 「鳴らさない」にした枠（null）は返さない。
 */
import type { ChatDeductionBoard, ChatDeductionCard } from './board'
import type { ChatDeductionSoundSlot } from './sound'

/** BGM を下げて止める長さ（ミリ秒）。正解・打ち切りの効果音を際立たせるよう短くする（漢字クイズと同じ） */
export const CHAT_DEDUCTION_BGM_FADE_OUT_MS = 500

/**
 * 配信の BGM を下げておく長さ（ミリ秒）。ゲームの BGM を流しているあいだ、CHAT_DEDUCTION_BGM_DUCK_RENEW_MS おきに送り直す。
 * 長さを区切るのは、合成ページが閉じられても配信の BGM が下がったまま残らないようにするため（裏方が長さの終わりに自分で戻す）。
 * Worker が受け付ける上限（5分）より短くする
 */
export const CHAT_DEDUCTION_BGM_DUCK_HOLD_MS = 120_000

/** 配信の BGM を下げておく知らせを送り直す間隔（ミリ秒）。送り直しが1回届かなくても戻らないよう、下げておく長さの半分にする */
export const CHAT_DEDUCTION_BGM_DUCK_RENEW_MS = CHAT_DEDUCTION_BGM_DUCK_HOLD_MS / 2

/** 鳴らす音1つ */
export type ChatDeductionSoundCue =
  /** BGM をループで鳴らしはじめる（鳴らしている BGM があれば替える） */
  | { readonly type: 'bgmStart'; readonly url: string; readonly volume: number }
  /** 流している BGM の音量だけを変える（頭から流し直さない） */
  | { readonly type: 'bgmVolume'; readonly volume: number }
  /** 効果音を1回鳴らす */
  | { readonly type: 'effect'; readonly url: string; readonly volume: number }
  /** BGM を duration ミリ秒かけて下げ、止める */
  | { readonly type: 'bgmFadeOut'; readonly duration: number }

/**
 * その一覧のときに流しておく BGM の音声の URL を返す。開催中のゲームが無い・BGM を「鳴らさない」にしたなら null。
 * 合成ページは、これが null でないあいだ配信の BGM を下げておく。
 */
export const chatDeductionBgmUrlOf = (board: ChatDeductionBoard): string | null =>
  board.game !== null && board.game.endedAt === null ? board.sound.slots.bgm : null

/** カードを見分ける鍵。質問と解答は別々に番号を振るので、種類と ID の組で見分ける */
const cardKeyOf = (card: ChatDeductionCard): string => `${card.kind}-${card.id}`

/** カードに合う効果音の枠 */
const slotOfCard = (card: ChatDeductionCard): ChatDeductionSoundSlot => {
  if (card.kind === 'question') return 'answered'
  return card.correct ? 'correct' : 'wrong'
}

/**
 * 押し出しで届いた一覧で、前の一覧から進んだ場面に合う効果音の枠を、鳴らす順に返す。
 * ゲームを始めた → 増えたカード（一覧の順）→ 打ち切った の順にする。正解で終えたときは、正解のカードの音だけを鳴らす。
 */
const effectSlotsOf = (previous: ChatDeductionBoard, next: ChatDeductionBoard): ChatDeductionSoundSlot[] => {
  const { game } = next
  if (game === null) return []
  const sameGame = previous.game?.id === game.id
  const seen = new Set(sameGame ? previous.cards.map(cardKeyOf) : [])
  const startedNow = !sameGame && game.endedAt === null
  // 正解者が出ずに終えた（配信者の打ち切りか、制限時間が尽きた）ときに打ち切りの音を鳴らす
  const stoppedNow = sameGame && previous.game?.endedAt === null && (game.endReason === 'stopped' || game.endReason === 'timeout')
  return [
    ...(startedNow ? (['start'] as const) : []),
    ...next.cards.filter((card) => !seen.has(cardKeyOf(card))).map(slotOfCard),
    ...(stoppedNow ? (['stopped'] as const) : []),
  ]
}

/**
 * 前の一覧から新しい一覧へ替えるときに鳴らす音を、鳴らす順に返す（効果音を先に、BGM の切り替えを後に）。
 *
 * @param previous 前に映していた一覧。合成ページを開いて最初の一覧なら null（効果音を鳴らさない）
 * @param next 新しく受け取った一覧
 * @param announce 押し出しで届いた一覧なら true。読み直した一覧なら false（効果音を鳴らさない）
 */
export const chatDeductionSoundCuesOf = (previous: ChatDeductionBoard | null, next: ChatDeductionBoard, announce: boolean): ChatDeductionSoundCue[] => {
  const { slots, effectVolume, bgmVolume } = next.sound
  const effects: ChatDeductionSoundCue[] = (announce && previous !== null ? effectSlotsOf(previous, next) : []).flatMap((slot) => {
    const url = slots[slot]
    return url === null ? [] : [{ type: 'effect', url, volume: effectVolume } as const]
  })

  const playingBgm = previous === null ? null : chatDeductionBgmUrlOf(previous)
  const nextBgm = chatDeductionBgmUrlOf(next)
  if (nextBgm === playingBgm) {
    // 同じ曲のまま音量だけを選び直した設定が届いたら、流している曲の音量を合わせる
    const volumeChanged = nextBgm !== null && previous !== null && previous.sound.bgmVolume !== bgmVolume
    return volumeChanged ? [...effects, { type: 'bgmVolume', volume: bgmVolume }] : effects
  }
  if (nextBgm === null) return [...effects, { type: 'bgmFadeOut', duration: CHAT_DEDUCTION_BGM_FADE_OUT_MS }]
  return [...effects, { type: 'bgmStart', url: nextBgm, volume: bgmVolume }]
}
