/**
 * 市町村紹介で音を鳴らす時刻の表（issue #244）
 *
 * 1件の再生で、どの枠の音をいつ鳴らすかを、再生を始めた時刻・紹介が届いた時刻と音の設定だけから決める。
 * 秒数は場面の進み方（timeline.ts）と同じ定数・同じ流れ（tourSpanOf）から決め、場面と音の時刻がずれないようにする。
 *
 * 描画は経過時間だけから決める約束だが、効果音は「もう鳴らしたか」を覚えないと二重に鳴る。そこで判断（この表と、
 * 時刻を迎えた音を選ぶ dueSoundCues）と、鳴らしたことの記録・Audio 要素の操作（合成ページの stage.ts と sound-player.ts）を分ける。
 *
 * 注意: 通信も DOM も持ち込まない。
 * 注意: 「鳴らさない」にした枠（null）は表に載せない。紹介を作れなかった再生は表を空にする（鳴っている BGM は
 * 再生の終わりに合成ページが止める）。
 */
import { NARRATION_BGM_RATIO, type NarrationClip } from './narration'
import type { TownTourSoundSlot } from './sound'
import { FADE_OUT_MS, JAPAN_HOLD_MS, ZOOM_END_MS, quizEndOf, tourSpanOf, type Playback } from './timeline'

/** 効果音と読み上げを鳴らしてよい遅れの上限（ミリ秒）。これより遅れたら、場面とずれて聞こえるので鳴らさない */
const EFFECT_LATE_LIMIT_MS = 500

/** BGM を鳴らしはじめる行の id。合成ページは、これを鳴らした再生でだけ配信のBGMを下げる（bgm-duck.ts） */
export const BGM_START_CUE_ID = 'bgm'

/** 表の1行。id は1件の再生の中で一意で、鳴らしたことの記録に使う。at は再生を始めてからのミリ秒 */
export type SoundCue =
  /** BGM をループで鳴らしはじめる */
  | { readonly id: string; readonly at: number; readonly type: 'bgmStart'; readonly url: string; readonly volume: number }
  /** 効果音を1回鳴らす */
  | { readonly id: string; readonly at: number; readonly type: 'effect'; readonly url: string; readonly volume: number }
  /** BGM を duration ミリ秒かけて下げ、止める */
  | { readonly id: string; readonly at: number; readonly type: 'bgmFadeOut'; readonly duration: number }
  /** ナレーションの音声を1回鳴らす（issue #255） */
  | { readonly id: string; readonly at: number; readonly type: 'narration'; readonly url: string }
  /**
   * BGM の音量を変える（ナレーションを読み上げるあいだ下げ、読み終えたら戻す）。id が -duck で終わるものが下げる行で、
   * 読み上げと同じく遅れたら行わない（読み上げを鳴らさなかったのに BGM だけ下げない）
   */
  | { readonly id: string; readonly at: number; readonly type: 'bgmVolume'; readonly volume: number }

/**
 * 1件の再生で鳴らす音の表を、鳴らす順に作る。
 *
 * BGM は冒頭のクイズの出だしから鳴らし、始まり・ズーム・着地はクイズを終えた時刻から数える（issue #251。
 * チャットで正解が早く出れば、そのぶん早く鳴る）。
 * 紹介が届く前は、場面の数と流しはじめる時刻が決まらないので、BGM と始まり・ズーム・着地だけを載せる。
 * 届いたら、大見出しと各項目の出だしで「項目ごと」の音を、配信者への振りの出だしで「締め」の音を鳴らす（issue #249）。
 * ナレーションを読み上げる再生では、冒頭の一文を紹介を出しはじめる時刻（着地）に、大見出し・項目・振りをそれぞれの出だしに読み上げ、
 * 読んでいるあいだだけ BGM を NARRATION_BGM_RATIO の割合まで下げる（issue #255）。同じ時刻の行は効果音を先に並べる。
 */
export const soundCuesOf = (playback: Playback): SoundCue[] => {
  const { intro } = playback
  if (intro.status === 'failed') return []
  const { slots, bgmVolume, effectVolume } = playback.call.sound

  /** 枠に音声が選ばれていれば効果音の1行を作る。「鳴らさない」なら作らない */
  const effect = (slot: Exclude<TownTourSoundSlot, 'bgm'>, id: string, at: number): SoundCue[] => {
    const url = slots[slot]
    return url === null ? [] : [{ id, at, type: 'effect', url, volume: effectVolume }]
  }

  const quizEnd = quizEndOf(playback)
  const opening: SoundCue[] = [
    ...(slots.bgm === null ? [] : [{ id: BGM_START_CUE_ID, at: 0, type: 'bgmStart', url: slots.bgm, volume: bgmVolume } as const]),
    ...effect('opening', 'opening', quizEnd),
    ...effect('zoom', 'zoom', quizEnd + JAPAN_HOLD_MS),
    ...effect('landing', 'landing', quizEnd + ZOOM_END_MS),
  ]
  if (intro.status === 'loading') return opening

  const { landing, openingNarration, segments, end } = tourSpanOf(playback, intro)
  // 締めの音は、振りか、振りの代わりに出す共通点（issue #275）の出だしで鳴らす
  const isClosing = ({ line }: (typeof segments)[number]): boolean => line.kind === 'cue' || line.kind === 'bond'
  const items = segments.filter((segment) => !isClosing(segment))
  const cue = segments.find(isClosing)

  /** 読み上げの1行と、BGM を鳴らしていれば読んでいるあいだ下げて戻す2行を作る。読み上げない場面は作らない */
  const narration = (id: string, at: number, clip: NarrationClip | null): SoundCue[] => {
    if (clip === null) return []
    const speak: SoundCue = { id, at, type: 'narration', url: clip.url }
    if (slots.bgm === null) return [speak]
    return [
      speak,
      { id: `${id}-duck`, at, type: 'bgmVolume', volume: bgmVolume * NARRATION_BGM_RATIO },
      { id: `${id}-restore`, at: at + clip.duration, type: 'bgmVolume', volume: bgmVolume },
    ]
  }
  const narrations = [
    ...narration('narration-opening', landing, openingNarration),
    ...segments.flatMap(({ start, narration: clip }, index) => narration(`narration-${index}`, start, clip)),
  ]

  const cues = [
    ...opening,
    ...items.flatMap(({ start }, index) => effect('item', `item-${index}`, start)),
    ...(cue === undefined ? [] : effect('closing', 'closing', cue.start)),
    ...narrations,
    // 終わりに全体を薄くするあいだに合わせて BGM を下げる
    ...(slots.bgm === null ? [] : [{ id: 'bgm-end', at: end - FADE_OUT_MS, type: 'bgmFadeOut', duration: FADE_OUT_MS } as const]),
  ]
  // 鳴らす順（時刻の順）に並べる。並べ替えは安定なので、同じ時刻なら効果音・読み上げ・下げる行の順のまま
  return cues.sort((a, b) => a.at - b.at)
}

/**
 * 時刻を迎えた音のうち、まだ鳴らしていないものを鳴らす順に返す。
 *
 * 確かめるタイマーが遅れた（OBSがページを止めていた など）ときに、過ぎた音をまとめて鳴らさないよう、次のものは返さない。
 * - 時刻から EFFECT_LATE_LIMIT_MS より遅れた効果音・読み上げ・読み上げのための BGM の下げ（遅れて返さなかったものは、その後も返らない）
 * - BGM を下げる時刻を過ぎてからの BGM の鳴らしはじめ
 *
 * @param now 現在時刻（ミリ秒。Date.now() と同じ基準）
 * @param played この再生で鳴らした音の id
 */
export const dueSoundCues = (playback: Playback, now: number, played: ReadonlySet<string>): SoundCue[] => {
  const elapsed = now - playback.startedAt
  const cues = soundCuesOf(playback)
  const bgmEnd = cues.find((cue) => cue.type === 'bgmFadeOut')
  const bgmEnded = bgmEnd !== undefined && bgmEnd.at <= elapsed
  return cues.filter((cue) => {
    if (cue.at > elapsed || played.has(cue.id)) return false
    if (cue.type === 'effect' || cue.type === 'narration' || (cue.type === 'bgmVolume' && cue.id.endsWith('-duck'))) {
      return elapsed - cue.at <= EFFECT_LATE_LIMIT_MS
    }
    if (cue.type === 'bgmStart') return !bgmEnded
    return true
  })
}
