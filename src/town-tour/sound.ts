/**
 * 市町村紹介の音の枠と、音の設定の形（issue #243）
 *
 * 演出のどの場面で音を鳴らすか（枠）はここで固定し、Worker（worker/town-tour-sound.ts の検証）・管理画面・合成ページが
 * 同じ一覧を読む（Worker から src/ を読み込む例外。同じ一覧を2か所に書くと食い違うため）。
 * 保存する設定（枠ごとの素材のID）と、合成ページが受け取る設定（Worker が素材のIDを音声のURLに置き換えたもの）は
 * 同じ形なので、型と読み取りもここに置く（管理画面と合成ページが Worker の応答を読むときに使う）。
 *
 * 注意: 通信も DOM も持ち込まない（Worker からも読むため）。
 * 注意: 形が違う設定は補わずに投げる（Fail-Fast）。欠けた枠を「鳴らさない」と読むと、壊れた設定に気づけないため。
 */

/**
 * 音を鳴らす枠。並びは演出で鳴る順で、管理画面の並びにも使う。
 * - bgm: 紹介のあいだループで流す
 * - opening: 日本全体を映した瞬間
 * - zoom: 市町村へ寄り始めたとき
 * - landing: ズームが終わり、形を塗り終えたとき
 * - item: 大見出しと各項目が出るたび
 * - closing: 配信者への振りが出たとき
 */
export const TOWN_TOUR_SOUND_SLOTS = ['bgm', 'opening', 'zoom', 'landing', 'item', 'closing'] as const

export type TownTourSoundSlot = (typeof TOWN_TOUR_SOUND_SLOTS)[number]

/** 音の設定の形。枠ごとの値が何を指すか（素材のIDか音声のURLか）だけが、保存する設定と押し出す設定で違う */
interface SoundShape {
  /** 枠ごとの音。鳴らさない枠は null */
  readonly slots: Readonly<Record<TownTourSoundSlot, string | null>>
  /** BGM の音量（0〜1） */
  readonly bgmVolume: number
  /** 効果音（BGM 以外の枠すべて）の音量（0〜1） */
  readonly effectVolume: number
}

/** 保存する音の設定。枠ごとの値は、鳴らす音声の素材のID */
export type TownTourSound = SoundShape

/** 合成ページへ押し出す音の設定。枠ごとの値は、音声のURL（オーバーレイ用キーつき） */
export type TownTourPlaybackSound = SoundShape

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 音の設定の形をしているかを確かめて読む。
 *
 * @param subject 投げるときの文に出す、何の音の設定か
 * @throws 音の設定が無い・枠が欠けている・音量が数でない場合
 */
const readSoundShape = (value: unknown, subject: string): SoundShape => {
  if (!isRecord(value) || !isRecord(value.slots)) throw new Error(`${subject}がありません`)
  const candidate = value.slots
  const slotOf = (slot: TownTourSoundSlot): string | null => {
    const sound = candidate[slot]
    if (sound !== null && typeof sound !== 'string') throw new Error(`${subject}に、枠 ${slot} がありません`)
    return sound
  }
  const { bgmVolume, effectVolume } = value
  if (typeof bgmVolume !== 'number' || typeof effectVolume !== 'number') throw new Error(`${subject}に、音量がありません`)
  return {
    slots: {
      bgm: slotOf('bgm'),
      opening: slotOf('opening'),
      zoom: slotOf('zoom'),
      landing: slotOf('landing'),
      item: slotOf('item'),
      closing: slotOf('closing'),
    },
    bgmVolume,
    effectVolume,
  }
}

/**
 * 押し出された音の設定を読む（合成ページ）。
 *
 * @throws 音の設定が無い・枠が欠けている・音量が数でない場合
 */
export const readPlaybackSound = (value: unknown): TownTourPlaybackSound => readSoundShape(value, '押し出された市町村紹介の音の設定')

/**
 * Worker が返した保存済みの音の設定を読む（管理画面）。
 *
 * @throws 枠が欠けている・音量が数でない場合
 */
export const readTownTourSound = (value: unknown): TownTourSound => readSoundShape(value, 'Workerの市町村紹介の音の設定')
