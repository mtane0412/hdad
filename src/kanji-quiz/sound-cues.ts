/**
 * 漢字クイズで音を鳴らす時刻の表
 *
 * 1回の出題で、どの枠の音をいつ鳴らすかを、音の設定と正解者が届いた時刻（流しはじめてからの経過時間）だけから決める。
 * 秒数は場面の進み方（scene.ts）と同じ定数から決め、場面と音の時刻がずれないようにする。
 * - BGM と「出題」は流しはじめ（級を出したとき）に鳴らす
 * - 「カウントダウン」は最後の COUNTDOWN_SECONDS 秒の大きな数字が切り替わるたびに鳴らす
 * - 正解者が届いたら「正解」、届かなければ時間切れの時刻に「時間切れ」を鳴らす
 * - BGM は正解者が届いた時刻か時間切れの時刻で、KANJI_QUIZ_BGM_FADE_OUT_MS かけて下げて止める（結果の音を際立たせるため、解説のあいだは流さない）
 *
 * 描画は経過時間だけから決める約束だが、効果音は「もう鳴らしたか」を覚えないと二重に鳴る。そこで判断（この表と、
 * 時刻を迎えた音を選ぶ dueKanjiQuizSoundCues）と、鳴らしたことの記録・Audio 要素の操作（合成ページの stage.ts と sound-player.ts）を分ける
 * （市町村紹介の src/town-tour/sound-cues.ts と同じ分け方）。
 *
 * 注意: 通信も DOM も持ち込まない。
 * 注意: 「鳴らさない」にした枠（null）は表に載せない。
 */
import { ANSWER_LIMIT_MS, COUNTDOWN_SECONDS, GRADE_INTRO_MS } from './scene'
import type { KanjiQuizSound } from './sound'

/** BGM を下げて止める長さ（ミリ秒）。正解・時間切れの音を際立たせるよう短くする */
export const KANJI_QUIZ_BGM_FADE_OUT_MS = 500
/** 効果音を鳴らしてよい遅れの上限（ミリ秒）。これより遅れたら、場面とずれて聞こえるので鳴らさない */
const EFFECT_LATE_LIMIT_MS = 500
const MS_PER_SECOND = 1_000
/** 時間切れの時刻（流しはじめてから） */
const TIME_UP_AT = GRADE_INTRO_MS + ANSWER_LIMIT_MS

/** BGM を鳴らしはじめる行の id。合成ページは、これを鳴らした出題でだけ配信の BGM を下げる */
export const KANJI_QUIZ_BGM_START_CUE_ID = 'bgm'

/** 表の1行。id は1回の出題の中で一意で、鳴らしたことの記録に使う。at は流しはじめてからのミリ秒 */
export type KanjiQuizSoundCue =
  /** BGM をループで鳴らしはじめる */
  | { readonly id: string; readonly at: number; readonly type: 'bgmStart'; readonly url: string; readonly volume: number }
  /** 効果音を1回鳴らす */
  | { readonly id: string; readonly at: number; readonly type: 'effect'; readonly url: string; readonly volume: number }
  /** BGM を duration ミリ秒かけて下げ、止める */
  | { readonly id: string; readonly at: number; readonly type: 'bgmFadeOut'; readonly duration: number }

/** BGM を下げはじめる時刻。正解者が届いていればその時刻、届いていなければ時間切れの時刻 */
const bgmEndOf = (answeredAfterMs: number | null): number => answeredAfterMs ?? TIME_UP_AT

/**
 * 1回の出題で鳴らす音の表を、鳴らす順に作る。
 *
 * @param answeredAfterMs 流しはじめてから正解者が届くまでの経過時間（scene.ts の acceptsAnswerAt が受け入れたもの）。届いていなければ null
 */
export const kanjiQuizSoundCuesOf = (sound: KanjiQuizSound, answeredAfterMs: number | null): KanjiQuizSoundCue[] => {
  const { slots, bgmVolume, effectVolume } = sound
  const bgmEnd = bgmEndOf(answeredAfterMs)

  /** 枠に音声が選ばれていれば効果音の1行を作る。「鳴らさない」なら作らない */
  const effect = (slot: 'start' | 'countdown' | 'correct' | 'timeUp', id: string, at: number): KanjiQuizSoundCue[] => {
    const url = slots[slot]
    return url === null ? [] : [{ id, at, type: 'effect', url, volume: effectVolume }]
  }

  // 大きな数字が COUNTDOWN_SECONDS → 1 と切り替わる時刻。正解者が届いた後のものは鳴らさない
  const countdowns = Array.from({ length: COUNTDOWN_SECONDS }, (_, index) => COUNTDOWN_SECONDS - index)
    .map((second) => ({ second, at: TIME_UP_AT - second * MS_PER_SECOND }))
    .filter(({ at }) => at < bgmEnd)
    .flatMap(({ second, at }) => effect('countdown', `countdown-${second}`, at))

  return [
    ...(slots.bgm === null ? [] : [{ id: KANJI_QUIZ_BGM_START_CUE_ID, at: 0, type: 'bgmStart', url: slots.bgm, volume: bgmVolume } as const]),
    ...effect('start', 'start', 0),
    ...countdowns,
    ...(answeredAfterMs === null ? effect('timeUp', 'timeUp', TIME_UP_AT) : effect('correct', 'correct', answeredAfterMs)),
    ...(slots.bgm === null ? [] : [{ id: 'bgm-end', at: bgmEnd, type: 'bgmFadeOut', duration: KANJI_QUIZ_BGM_FADE_OUT_MS } as const]),
  ]
}

/**
 * 時刻を迎えた音のうち、まだ鳴らしていないものを鳴らす順に返す。
 *
 * 確かめるタイマーが遅れた（OBSがページを止めていた など）ときに、過ぎた音をまとめて鳴らさないよう、次のものは返さない。
 * - 時刻から EFFECT_LATE_LIMIT_MS より遅れた効果音（遅れて返さなかったものは、その後も返らない）
 * - BGM を下げる時刻を過ぎてからの BGM の鳴らしはじめ
 *
 * @param elapsedMs 流しはじめてからの経過時間
 * @param answeredAfterMs 流しはじめてから正解者が届くまでの経過時間。届いていなければ null
 * @param played この出題で鳴らした音の id
 */
export const dueKanjiQuizSoundCues = (
  sound: KanjiQuizSound,
  elapsedMs: number,
  answeredAfterMs: number | null,
  played: ReadonlySet<string>,
): KanjiQuizSoundCue[] => {
  const bgmEnded = bgmEndOf(answeredAfterMs) <= elapsedMs
  return kanjiQuizSoundCuesOf(sound, answeredAfterMs).filter((cue) => {
    if (cue.at > elapsedMs || played.has(cue.id)) return false
    if (cue.type === 'effect') return elapsedMs - cue.at <= EFFECT_LATE_LIMIT_MS
    if (cue.type === 'bgmStart') return !bgmEnded
    return true
  })
}

/**
 * 配信の BGM を、いまから下げておく長さ（ミリ秒）を決める。
 *
 * 合成ページは BGM を鳴らしはじめたときと正解者が届いたときに、この長さを Worker 経由で裏方のページへ送る。
 * 裏方は受け取ってからその長さが過ぎたら自分で戻すので、合成ページが閉じられても配信の BGM は下がったまま残らない
 * （市町村紹介の src/town-tour/bgm-duck.ts と同じ仕組み）。
 *
 * @param elapsedMs 流しはじめてからの経過時間
 * @param answeredAfterMs 流しはじめてから正解者が届くまでの経過時間。届いていなければ null
 * @returns 下げておく長さ（整数のミリ秒）。0 は「すぐ戻す」。BGM の枠が空なら下げないので null
 */
export const kanjiQuizBgmDuckHoldOf = (sound: KanjiQuizSound, elapsedMs: number, answeredAfterMs: number | null): number | null => {
  if (sound.slots.bgm === null) return null
  // Worker は整数しか受け付けない。切り捨てるとクイズの BGM が消える前に配信の BGM が戻るので切り上げる
  return Math.max(0, Math.ceil(bgmEndOf(answeredAfterMs) + KANJI_QUIZ_BGM_FADE_OUT_MS - elapsedMs))
}
