/**
 * チャットで推理の音の枠と、音の設定の形
 *
 * ゲームのどの場面で音を鳴らすか（枠）はここで固定し、Worker（worker/chat-deduction-sound.ts の検証）・アプリのページ・合成ページが
 * 同じ一覧を読む（Worker から src/chat-deduction/ を読み込む例外。同じ一覧を2か所に書くと食い違うため）。
 * 保存する設定（枠ごとの素材のID）と、合成ページが受け取る設定（Worker が素材のIDを音声のURLに置き換えたもの）は
 * 同じ形なので、型と読み取りもここに置く（漢字クイズの src/kanji-quiz/sound.ts と同じ作り）。
 *
 * 注意: 通信も DOM も持ち込まない（Worker からも読むため）。
 * 注意: 形が違う設定は補わずに投げる（Fail-Fast）。欠けた枠を「鳴らさない」と読むと、壊れた設定に気づけないため。
 */

/**
 * 音を鳴らす枠。並びはゲームで鳴る順で、アプリのページの並びにも使う。
 * - bgm: ゲームを始めてから、正解者が出るか配信者が打ち切るか制限時間が尽きるまでループで流す
 * - start: ゲームを始めたとき
 * - answered: 質問に答えたとき（はい・いいえ・分からないのどれでも）
 * - wrong: 解答が不正解だったとき
 * - correct: 解答が正解だったとき（ゲームもここで終わる）
 * - stopped: 配信者がゲームを打ち切ったとき・制限時間が尽きたとき（正解者が出ずに終えたとき）
 */
export const CHAT_DEDUCTION_SOUND_SLOTS = ['bgm', 'start', 'answered', 'wrong', 'correct', 'stopped'] as const

export type ChatDeductionSoundSlot = (typeof CHAT_DEDUCTION_SOUND_SLOTS)[number]

/** 音の設定の形。枠ごとの値が何を指すか（素材のIDか音声のURLか）だけが、保存する設定と押し出す設定で違う */
export interface ChatDeductionSound {
  /** 枠ごとの音。鳴らさない枠は null */
  readonly slots: Readonly<Record<ChatDeductionSoundSlot, string | null>>
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
const readSoundShape = (value: unknown, subject: string): ChatDeductionSound => {
  if (!isRecord(value) || !isRecord(value.slots)) throw new Error(`${subject}がありません`)
  const candidate = value.slots
  const slotOf = (slot: ChatDeductionSoundSlot): string | null => {
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
      answered: slotOf('answered'),
      wrong: slotOf('wrong'),
      correct: slotOf('correct'),
      stopped: slotOf('stopped'),
    },
    bgmVolume,
    effectVolume,
  }
}

/**
 * 合成ページが受け取った音の設定を読む。枠ごとの値は音声のURL。
 *
 * @throws 音の設定が無い・枠が欠けている・音量が数でない場合
 */
export const readChatDeductionPlaybackSound = (value: unknown): ChatDeductionSound => readSoundShape(value, 'チャットで推理の音の設定')

/**
 * Worker が返した保存済みの音の設定を読む（アプリのページ）。枠ごとの値は素材のID。
 *
 * @throws 枠が欠けている・音量が数でない場合
 */
export const readChatDeductionSound = (value: unknown): ChatDeductionSound => readSoundShape(value, 'Workerのチャットで推理の音の設定')
