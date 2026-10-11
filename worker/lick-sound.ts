/**
 * ペロペロの効果音の設定（issue #340）
 *
 * ペロペロで舌がアイコンに触れるたびに鳴らす効果音（ジュルジュル・ペチャペチャ）の音声と音量を、管理画面（/triggers/）から受け取って検証し、
 * ストア（KV）に保存する。鳴らすのは合成ページの素材「ペロペロ」で、ここは設定の形と保存先だけを扱う。
 * 設定はペロペロとして1つだけ持ち、トリガーと試し再生が共有する。
 *
 * 音声は配信者が R2（MEDIA）にアップロードしたものを使う（ツイスターの BGM（twister-sound.ts）と同じく、
 * 公開しているリポジトリに音声を入れられないため）。作りも twister-sound.ts と同じで、問題点はすべて集めてから拒否する。
 *
 * 注意: 効果音が空（null）なのは「鳴らさない」という配信者の選択であり、ほかの音で埋めない。
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。選ばれている素材は削除させない（admin-routes.ts）。
 * 注意: 形は合成ページの読み取り（src/lick/sound.ts）と合わせる。worker/ から src/ の型は読み込まない約束なので、ここで持ち直す。
 */
import { ConfigError, mediaPath, type MediaKind } from './alert-config'
import type { KeyValueStore } from './store'

/** 効果音の設定の形。sound が何を指すか（素材のIDか音声のURLか）だけが、保存する設定と押し出す設定で違う */
interface SoundShape {
  /** 舌がアイコンに触れるたびに鳴らす効果音。鳴らさないなら null */
  readonly sound: string | null
  /** 効果音の音量（0〜1） */
  readonly volume: number
}

/** 保存する効果音の設定。sound は音声の素材のID */
export type LickSound = SoundShape

/** 合成ページへ押し出す効果音の設定。sound は音声のURL（オーバーレイ用キーつき） */
export type LickPlaybackSound = SoundShape

const SOUND_KEY = 'lick-sound'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SOUND_SUBJECT = 'ペロペロの効果音'
const MIN_VOLUME = 0
const MAX_VOLUME = 1

/**
 * 未保存のときの設定。音声はリポジトリに入れられないので効果音は鳴らさない。
 * 音量は、BGM（声を邪魔しない 0.3）より目立たせたい演出の音なので少し大きめにする
 */
export const DEFAULT_LICK_SOUND: LickSound = { sound: null, volume: 0.6 }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきた効果音の設定を検証し、保存用の形にする。
 *
 * @param input `{ sound: 素材のID | null, volume }`
 * @param kindOfMedia 素材のIDから種類を引く。無い素材なら null
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseLickSound = (input: unknown, kindOfMedia: (mediaId: string) => MediaKind | null): LickSound => {
  if (!isRecord(input) || Array.isArray(input)) throw new ConfigError(SOUND_SUBJECT, ['設定はオブジェクトで指定してください'])
  const { sound, volume } = input

  const problems: string[] = []
  const readSound = (): string | null => {
    if (sound === null) return null
    if (typeof sound !== 'string') {
      problems.push('sound: 素材のIDか null で指定してください')
      return null
    }
    const kind = kindOfMedia(sound)
    if (kind === null) problems.push(`sound: 素材「${sound}」が存在しません`)
    else if (kind !== 'audio') problems.push(`sound: 素材「${sound}」は音声ではありません`)
    return sound
  }
  const mediaId = readSound()
  const isVolume = typeof volume === 'number' && Number.isFinite(volume) && volume >= MIN_VOLUME && volume <= MAX_VOLUME
  if (!isVolume) problems.push(`volume: ${MIN_VOLUME}〜${MAX_VOLUME} の数で指定してください`)

  if (!isVolume || problems.length > 0) throw new ConfigError(SOUND_SUBJECT, problems)
  return { sound: mediaId, volume }
}

export const saveLickSound = (store: KeyValueStore, sound: LickSound): Promise<void> => store.put(SOUND_KEY, JSON.stringify(sound))

/** 保存済みの効果音の設定を読む。未保存なら効果音を鳴らさない */
export const loadLickSound = async (store: KeyValueStore): Promise<LickSound> => {
  const text = await store.get(SOUND_KEY)
  return text === null ? DEFAULT_LICK_SOUND : (JSON.parse(text) as LickSound)
}

/** その素材が効果音に選ばれているか（選ばれている素材は削除させない） */
export const lickSoundUses = (sound: LickSound, mediaId: string): boolean => sound.sound === mediaId

/**
 * 合成ページへ押し出す効果音の設定を組み立てる。素材のIDを、音声を読むパスに置き換える。
 *
 * @param overlayKey オーバーレイ用キー。未発行なら null（効果音を鳴らさないなら URL を作らないので要らない）
 * @throws 効果音を選んでいるのにオーバーレイ用キーが未発行の場合（黙って鳴らさずに済ませない）
 */
export const playbackLickSoundOf = (sound: LickSound, overlayKey: string | null): LickPlaybackSound => {
  if (sound.sound === null) return { sound: null, volume: sound.volume }
  if (overlayKey === null) throw new Error('オーバーレイ用キーが未発行のため、ペロペロの効果音のURLを作れません。管理画面にログインしてください')
  return { sound: mediaPath(sound.sound, overlayKey), volume: sound.volume }
}
