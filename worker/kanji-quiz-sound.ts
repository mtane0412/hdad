/**
 * 漢字クイズの音の設定
 *
 * 漢字クイズの演出の場面ごとに、どの音声を鳴らすかと、BGM・効果音の音量を管理画面（/triggers/）から受け取って検証し、
 * ストア（KV）に保存する。鳴らすのは合成ページの素材「漢字クイズ」で、ここは設定の形と保存先だけを扱う。
 *
 * 鳴らす場所（枠）はコードで固定し、配信者は枠ごとに音声を選ぶだけにする（docs/principles.md の方針1）。
 * 枠の一覧は src/kanji-quiz/sound.ts にあり、管理画面・合成ページと同じものを読む（Worker から src/kanji-quiz/ を読み込む例外）。
 * 音声は配信者が R2（MEDIA）にアップロードしたものを使う（市町村紹介の音（town-tour-sound.ts）と同じく、
 * 公開しているリポジトリに音声を入れられないため）。設定は漢字クイズとして1つだけ持ち、チャンネルポイントのトリガーと試し再生が共有する。
 *
 * 作りは town-tour-sound.ts と同じで、問題点は最初の1件で止めずにすべて集めてから拒否する（管理画面で一度に直せるようにするため）。
 *
 * 注意: 空（null）の枠は「鳴らさない」という配信者の選択であり、ほかの音で埋めない。
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。選ばれている素材は削除させない（admin-routes.ts）。
 */
import { KANJI_QUIZ_SOUND_SLOTS, type KanjiQuizSound, type KanjiQuizSoundSlot } from '../src/kanji-quiz/sound'
import { ConfigError, mediaPath, type MediaKind } from './alert-config'
import type { KeyValueStore } from './store'

export type { KanjiQuizSound }

const SOUND_KEY = 'kanji-quiz-sound'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SOUND_SUBJECT = '漢字クイズの音'
const MIN_VOLUME = 0
const MAX_VOLUME = 1

/**
 * 未保存のときの設定。音声はリポジトリに入れられないので、どの枠も鳴らさない。
 * 音量は市町村紹介（town-tour-sound.ts の DEFAULT_TOWN_TOUR_SOUND）と同じく、BGM は声を邪魔しない大きさにし、効果音は BGM より上げておく
 */
export const DEFAULT_KANJI_QUIZ_SOUND: KanjiQuizSound = {
  slots: { bgm: null, start: null, countdown: null, correct: null, timeUp: null },
  bgmVolume: 0.3,
  effectVolume: 0.6,
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isSlot = (name: string): name is KanjiQuizSoundSlot => KANJI_QUIZ_SOUND_SLOTS.some((slot) => slot === name)

const isVolume = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= MIN_VOLUME && value <= MAX_VOLUME

/**
 * 管理画面から送られてきた音の設定を検証し、保存用の形にする。
 *
 * @param input `{ slots: { bgm, start, countdown, correct, timeUp }, bgmVolume, effectVolume }`
 * @param kindOfMedia 素材のIDから種類を引く。無い素材なら null
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseKanjiQuizSound = (input: unknown, kindOfMedia: (mediaId: string) => MediaKind | null): KanjiQuizSound => {
  if (!isRecord(input)) throw new ConfigError(SOUND_SUBJECT, ['設定はオブジェクトで指定してください'])
  const { slots: candidate, bgmVolume, effectVolume } = input
  if (!isRecord(candidate) || Array.isArray(candidate)) {
    throw new ConfigError(SOUND_SUBJECT, ['slots: 枠ごとの素材をオブジェクトで指定してください'])
  }

  const problems: string[] = []
  const slots = { ...DEFAULT_KANJI_QUIZ_SOUND.slots }
  for (const slot of KANJI_QUIZ_SOUND_SLOTS) {
    const mediaId = candidate[slot]
    if (mediaId === null) continue
    if (typeof mediaId !== 'string') {
      problems.push(`slots.${slot}: 素材のIDか null で指定してください`)
      continue
    }
    const kind = kindOfMedia(mediaId)
    if (kind === null) problems.push(`slots.${slot}: 素材「${mediaId}」が存在しません`)
    else if (kind !== 'audio') problems.push(`slots.${slot}: 素材「${mediaId}」は音声ではありません`)
    else slots[slot] = mediaId
  }
  // 鳴らす場所はコードで決めているので、知らない枠は黙って捨てずに断る（打ち間違いに気づけるように）
  for (const name of Object.keys(candidate)) {
    if (!isSlot(name)) problems.push(`slots.${name}: 知らない枠です`)
  }
  /** 音量を読む。0〜1 の数でなければ問題点に積み、ほかの問題点と一緒に断れるよう仮の値を返す */
  const readVolume = (name: 'bgmVolume' | 'effectVolume', value: unknown): number => {
    if (isVolume(value)) return value
    problems.push(`${name}: ${MIN_VOLUME}〜${MAX_VOLUME} の数で指定してください`)
    return MIN_VOLUME
  }
  const volumes = { bgmVolume: readVolume('bgmVolume', bgmVolume), effectVolume: readVolume('effectVolume', effectVolume) }

  if (problems.length > 0) throw new ConfigError(SOUND_SUBJECT, problems)
  return { slots, ...volumes }
}

export const saveKanjiQuizSound = (store: KeyValueStore, sound: KanjiQuizSound): Promise<void> => store.put(SOUND_KEY, JSON.stringify(sound))

/** 保存済みの音の設定を読む。未保存ならどの枠も鳴らさない */
export const loadKanjiQuizSound = async (store: KeyValueStore): Promise<KanjiQuizSound> => {
  const text = await store.get(SOUND_KEY)
  return text === null ? DEFAULT_KANJI_QUIZ_SOUND : (JSON.parse(text) as KanjiQuizSound)
}

/** その素材がどれかの枠に選ばれているか（選ばれている素材は削除させない） */
export const kanjiQuizSoundUses = (sound: KanjiQuizSound, mediaId: string): boolean =>
  KANJI_QUIZ_SOUND_SLOTS.some((slot) => sound.slots[slot] === mediaId)

/**
 * 合成ページへ押し出す音の設定を組み立てる。素材のIDを、音声を読むパスに置き換える。
 *
 * @param overlayKey オーバーレイ用キー。未発行なら null（どの枠も鳴らさないなら URL を作らないので要らない）
 * @throws 音を選んだ枠があるのにオーバーレイ用キーが未発行の場合（黙って鳴らさずに済ませない）
 */
export const playbackKanjiQuizSoundOf = (sound: KanjiQuizSound, overlayKey: string | null): KanjiQuizSound => {
  const slots = { ...DEFAULT_KANJI_QUIZ_SOUND.slots }
  for (const slot of KANJI_QUIZ_SOUND_SLOTS) {
    const mediaId = sound.slots[slot]
    if (mediaId === null) continue
    if (overlayKey === null) throw new Error('オーバーレイ用キーが未発行のため、漢字クイズの音のURLを作れません。管理画面にログインしてください')
    slots[slot] = mediaPath(mediaId, overlayKey)
  }
  return { slots, bgmVolume: sound.bgmVolume, effectVolume: sound.effectVolume }
}
