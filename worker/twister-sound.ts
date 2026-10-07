/**
 * ツイスターの BGM の設定
 *
 * ツイスター（issue #272）の対戦のあいだ流す BGM の音声と音量を、管理画面（/triggers/）から受け取って検証し、
 * ストア（KV）に保存する。鳴らすのは合成ページの素材「ツイスター」で、ここは設定の形と保存先だけを扱う。
 * 設定はツイスターとして1つだけ持ち、レイドのトリガーと試し再生が共有する。
 *
 * 音声は配信者が R2（MEDIA）にアップロードしたものを使う（市町村紹介の音（town-tour-sound.ts）と同じく、
 * 公開しているリポジトリに音声を入れられないため）。作りも town-tour-sound.ts と同じで、問題点はすべて集めてから拒否する。
 *
 * 注意: BGM が空（null）なのは「流さない」という配信者の選択であり、ほかの音で埋めない。
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。選ばれている素材は削除させない（admin-routes.ts）。
 * 注意: 形は合成ページの読み取り（src/twister/sound.ts）と合わせる。worker/ から src/ の型は読み込まない約束なので、ここで持ち直す。
 */
import { ConfigError, mediaPath, type MediaKind } from './alert-config'
import type { KeyValueStore } from './store'

/** BGM の設定の形。bgm が何を指すか（素材のIDか音声のURLか）だけが、保存する設定と押し出す設定で違う */
interface SoundShape {
  /** 対戦のあいだ流す BGM。流さないなら null */
  readonly bgm: string | null
  /** BGM の音量（0〜1） */
  readonly bgmVolume: number
}

/** 保存する BGM の設定。bgm は音声の素材のID */
export type TwisterSound = SoundShape

/** 合成ページへ押し出す BGM の設定。bgm は音声のURL（オーバーレイ用キーつき） */
export type TwisterPlaybackSound = SoundShape

const SOUND_KEY = 'twister-sound'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SOUND_SUBJECT = 'ツイスターの BGM'
const MIN_VOLUME = 0
const MAX_VOLUME = 1

/**
 * 未保存のときの設定。音声はリポジトリに入れられないので BGM は流さない。
 * 音量は市町村紹介の BGM（town-tour-sound.ts の DEFAULT_TOWN_TOUR_SOUND）と同じく声を邪魔しない大きさにする
 */
export const DEFAULT_TWISTER_SOUND: TwisterSound = { bgm: null, bgmVolume: 0.3 }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきた BGM の設定を検証し、保存用の形にする。
 *
 * @param input `{ bgm: 素材のID | null, bgmVolume }`
 * @param kindOfMedia 素材のIDから種類を引く。無い素材なら null
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseTwisterSound = (input: unknown, kindOfMedia: (mediaId: string) => MediaKind | null): TwisterSound => {
  if (!isRecord(input) || Array.isArray(input)) throw new ConfigError(SOUND_SUBJECT, ['設定はオブジェクトで指定してください'])
  const { bgm, bgmVolume } = input

  const problems: string[] = []
  const readBgm = (): string | null => {
    if (bgm === null) return null
    if (typeof bgm !== 'string') {
      problems.push('bgm: 素材のIDか null で指定してください')
      return null
    }
    const kind = kindOfMedia(bgm)
    if (kind === null) problems.push(`bgm: 素材「${bgm}」が存在しません`)
    else if (kind !== 'audio') problems.push(`bgm: 素材「${bgm}」は音声ではありません`)
    return bgm
  }
  const mediaId = readBgm()
  const isVolume = typeof bgmVolume === 'number' && Number.isFinite(bgmVolume) && bgmVolume >= MIN_VOLUME && bgmVolume <= MAX_VOLUME
  if (!isVolume) problems.push(`bgmVolume: ${MIN_VOLUME}〜${MAX_VOLUME} の数で指定してください`)

  if (!isVolume || problems.length > 0) throw new ConfigError(SOUND_SUBJECT, problems)
  return { bgm: mediaId, bgmVolume }
}

export const saveTwisterSound = (store: KeyValueStore, sound: TwisterSound): Promise<void> => store.put(SOUND_KEY, JSON.stringify(sound))

/** 保存済みの BGM の設定を読む。未保存なら BGM を流さない */
export const loadTwisterSound = async (store: KeyValueStore): Promise<TwisterSound> => {
  const text = await store.get(SOUND_KEY)
  return text === null ? DEFAULT_TWISTER_SOUND : (JSON.parse(text) as TwisterSound)
}

/** その素材が BGM に選ばれているか（選ばれている素材は削除させない） */
export const twisterSoundUses = (sound: TwisterSound, mediaId: string): boolean => sound.bgm === mediaId

/**
 * 合成ページへ押し出す BGM の設定を組み立てる。素材のIDを、音声を読むパスに置き換える。
 *
 * @param overlayKey オーバーレイ用キー。未発行なら null（BGM を流さないなら URL を作らないので要らない）
 * @throws BGM を選んでいるのにオーバーレイ用キーが未発行の場合（黙って流さずに済ませない）
 */
export const playbackTwisterSoundOf = (sound: TwisterSound, overlayKey: string | null): TwisterPlaybackSound => {
  if (sound.bgm === null) return { bgm: null, bgmVolume: sound.bgmVolume }
  if (overlayKey === null) throw new Error('オーバーレイ用キーが未発行のため、ツイスターの BGM のURLを作れません。管理画面にログインしてください')
  return { bgm: mediaPath(sound.bgm, overlayKey), bgmVolume: sound.bgmVolume }
}
