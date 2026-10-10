/**
 * 漢字クイズの音の枠と、音の設定の形
 *
 * 演出のどの場面で音を鳴らすか（枠）はここで固定し、Worker（worker/kanji-quiz-sound.ts の検証）・管理画面・合成ページが
 * 同じ一覧を読む（Worker から src/kanji-quiz/ を読み込む例外。同じ一覧を2か所に書くと食い違うため）。
 * 保存する設定（枠ごとの素材のID）と、合成ページが受け取る設定（Worker が素材のIDを音声のURLに置き換えたもの）は
 * 同じ形なので、型と読み取りもここに置く（市町村紹介の src/town-tour/sound.ts と同じ作り）。
 *
 * 注意: 通信も DOM も持ち込まない（Worker からも読むため）。
 * 注意: 形が違う設定は補わずに投げる（Fail-Fast）。欠けた枠を「鳴らさない」と読むと、壊れた設定に気づけないため。
 */

/**
 * 音を鳴らす枠。並びは演出で鳴る順で、管理画面の並びにも使う。
 * - bgm: 級を出してから、正解者が届くか時間切れになるまでループで流す
 * - start: 級を出したとき（出題の始まり）
 * - countdown: 最後の数秒の大きなカウントダウンが切り替わるたび
 * - correct: 正解者が届いたとき
 * - timeUp: 時間切れになったとき
 */
export const KANJI_QUIZ_SOUND_SLOTS = ['bgm', 'start', 'countdown', 'correct', 'timeUp'] as const

export type KanjiQuizSoundSlot = (typeof KANJI_QUIZ_SOUND_SLOTS)[number]

/** 音の設定の形。枠ごとの値が何を指すか（素材のIDか音声のURLか）だけが、保存する設定と押し出す設定で違う */
export interface KanjiQuizSound {
  /** 枠ごとの音。鳴らさない枠は null */
  readonly slots: Readonly<Record<KanjiQuizSoundSlot, string | null>>
  /** BGM の音量（0〜1） */
  readonly bgmVolume: number
  /** 効果音（BGM 以外の枠すべて）の音量（0〜1） */
  readonly effectVolume: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 音の設定の形をしているかを確かめて読む。
 *
 * @param subject 投げるときの文に出す、何の音の設定か
 * @throws 音の設定が無い・枠が欠けている・音量が数でない場合
 */
const readSoundShape = (value: unknown, subject: string): KanjiQuizSound => {
  if (!isRecord(value) || !isRecord(value.slots)) throw new Error(`${subject}がありません`)
  const candidate = value.slots
  const slotOf = (slot: KanjiQuizSoundSlot): string | null => {
    const sound = candidate[slot]
    if (sound !== null && typeof sound !== 'string') throw new Error(`${subject}に、枠 ${slot} がありません`)
    return sound
  }
  const { bgmVolume, effectVolume } = value
  if (typeof bgmVolume !== 'number' || typeof effectVolume !== 'number') throw new Error(`${subject}に、音量がありません`)
  return {
    slots: {
      bgm: slotOf('bgm'),
      start: slotOf('start'),
      countdown: slotOf('countdown'),
      correct: slotOf('correct'),
      timeUp: slotOf('timeUp'),
    },
    bgmVolume,
    effectVolume,
  }
}

/**
 * 押し出された音の設定を読む（合成ページ）。枠ごとの値は音声のURL。
 *
 * @throws 音の設定が無い・枠が欠けている・音量が数でない場合
 */
export const readKanjiQuizPlaybackSound = (value: unknown): KanjiQuizSound => readSoundShape(value, '押し出された漢字クイズの音の設定')

/**
 * Worker が返した保存済みの音の設定を読む（管理画面）。枠ごとの値は素材のID。
 *
 * @throws 枠が欠けている・音量が数でない場合
 */
export const readKanjiQuizSound = (value: unknown): KanjiQuizSound => readSoundShape(value, 'Workerの漢字クイズの音の設定')
