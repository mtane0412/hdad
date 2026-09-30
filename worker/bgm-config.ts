/**
 * BGMの曲と再生の設定
 *
 * 配信で流すBGMの曲の一覧と、「いま流す曲・音量」を管理画面（/bgm/）から受け取って検証し、ストア（KV）に保存する。
 * 鳴らすのは裏方のページ（overlay/backstage/ の ?bgm=true）で、ここは設定の形と保存先だけを扱う。
 * 作りは speech-config.ts と同じで、問題点は最初の1件で止めずにすべて集めてから拒否する（管理画面で一度に直せるようにするため）。
 *
 * 曲の音声は、アラートの素材と同じく R2（MEDIA）に配信者がアップロードしたものを使う（フリーBGMの配布元の多くは
 * 直リンクを禁じているため）。音声の素材1つにつき曲は1つで、素材のIDを曲の識別子として使う。
 * クレジット先のURLは音声の読み先ではなく、視聴者に紹介するための出典である（issue #152 でチャットに出す）。
 *
 * 曲の一覧と「いま流す曲」は別の鍵に置く。曲の一覧はたまにしか直さないが、流す曲と音量は配信中に何度も変えるためである。
 * Jev に曲を選ばせるかの設定（bgm-settings）と、最後に曲を切り替えた時刻（bgm-switched-at）も別の鍵に置く（issue #153）。
 * 切り替えた時刻は、切り替えのすぐあとに Jev が曲を変えないために使う（worker/bgm-jev.ts）。
 *
 * 注意: 流している曲は一覧から消させない。消せてしまうと、裏方のページが流す曲を引けずに黙って無音になる。
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
import { ConfigError, mediaPath, type MediaKind } from './alert-config'
import type { KeyValueStore } from './store'

const TRACKS_KEY = 'bgm-tracks'
const PLAYBACK_KEY = 'bgm-playback'
const SETTINGS_KEY = 'bgm-settings'
const SWITCHED_AT_KEY = 'bgm-switched-at'
/** 問題点のメッセージに出す、何の設定かの名前 */
const TRACKS_SUBJECT = 'BGMの曲'
const PLAYBACK_SUBJECT = 'BGMの再生'
const SETTINGS_SUBJECT = 'BGMの設定'

/** 曲の数の上限。配信で使い分ける数としては十分で、1つの鍵に収まる大きさに保つ */
const MAX_TRACKS = 100
/**
 * 曲名・クレジット表記・クレジット先のURLの長さの上限。
 * 3つを並べた文がチャットの差し込み語 {bgm} になり、Twitchの1通（500文字）に配信者の文言と一緒に収めるため、
 * 追加して364文字（bgm-credit.ts の MAX_BGM_CREDIT_LENGTH）になるように決めてある（issue #152）
 */
export const MAX_TITLE_LENGTH = 60
export const MAX_CREDIT_LENGTH = 100
export const MAX_CREDIT_URL_LENGTH = 200
/** 曲調・流したい場面の長さの上限。Jev に選ばせるときの選択肢の説明になる（issue #153） */
const MAX_DESCRIPTION_LENGTH = 200
const MIN_VOLUME = 0
const MAX_VOLUME = 1
/** クレジット先として受け取るURL。視聴者が開くものなので、スクリプトを動かせる形（javascript: など）を入れさせない */
const CREDIT_URL_PATTERN = /^https?:\/\/\S+$/

/** BGMの曲1つ */
export interface BgmTrack {
  /** 音声の素材のID（R2の鍵）。曲の識別子も兼ねる */
  readonly mediaId: string
  /** 曲名 */
  readonly title: string
  /** クレジット表記（配布元が求める書き方のまま） */
  readonly credit: string
  /** クレジット先のURL。無ければ空文字 */
  readonly creditUrl: string
  /** 曲調。無ければ空文字 */
  readonly mood: string
  /** 流したい場面。無ければ空文字 */
  readonly scene: string
}

/** いま流す曲と音量 */
export interface BgmPlayback {
  /** 流す曲の素材のID。止めているときは null */
  readonly mediaId: string | null
  /** 音量（0〜1） */
  readonly volume: number
}

/** BGMの設定 */
export interface BgmSettings {
  /** 配信の話題や雰囲気に合う曲へ、Jev に切り替えさせるか */
  readonly judgeWithJev: boolean
}

/** 裏方のページへ渡す、いま流している曲 */
export interface BgmNowPlaying {
  /** 流している曲。止めているときは null */
  readonly track: {
    readonly mediaId: string
    readonly title: string
    readonly credit: string
    readonly creditUrl: string
    /** 音声を読むパス（オーバーレイ用キーつき） */
    readonly url: string
  } | null
  readonly volume: number
}

/** 未保存のときの再生の設定。何も流さず、流し始めたときに声を邪魔しない音量にしておく */
export const DEFAULT_BGM_PLAYBACK: BgmPlayback = { mediaId: null, volume: 0.3 }

/** 未保存のときの設定。誤った切り替えは配信の雰囲気を壊すので、Jev に選ばせるのは配信者が入れたときだけにする */
export const DEFAULT_BGM_SETTINGS: BgmSettings = { judgeWithJev: false }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきた曲の一覧を検証し、保存用の形にする。
 *
 * @param input `{ tracks: [...] }`
 * @param kindOfMedia 素材のIDから種類を引く。無い素材なら null
 * @param playingMediaId いま流している曲の素材のID（止めているなら null）。一覧から消させないために使う
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseBgmTracks = (
  input: unknown,
  kindOfMedia: (mediaId: string) => MediaKind | null,
  playingMediaId: string | null,
): BgmTrack[] => {
  if (!isRecord(input) || !Array.isArray(input.tracks)) throw new ConfigError(TRACKS_SUBJECT, ['tracks: 配列で指定してください'])
  if (input.tracks.length > MAX_TRACKS) throw new ConfigError(TRACKS_SUBJECT, [`tracks: ${MAX_TRACKS}曲以内にしてください`])

  const problems: string[] = []
  const seen = new Set<string>()

  const tracks = input.tracks.flatMap((candidate: unknown, index): BgmTrack[] => {
    const at = `tracks[${index}]`
    if (!isRecord(candidate)) {
      problems.push(`${at}: オブジェクトで指定してください`)
      return []
    }
    const before = problems.length

    /** 文字列の項目を読み、前後の空白を落とす。長さが範囲の外なら問題点に積む */
    const readText = (name: keyof BgmTrack, min: number, max: number): string => {
      const value = candidate[name]
      const text = typeof value === 'string' ? value.trim() : ''
      if (typeof value !== 'string' || text.length < min || text.length > max) {
        problems.push(min === 0 ? `${at}.${name}: ${max}文字以内の文字列で指定してください` : `${at}.${name}: ${min}〜${max}文字で指定してください`)
      }
      return text
    }

    const mediaId = typeof candidate.mediaId === 'string' ? candidate.mediaId : ''
    const kind = kindOfMedia(mediaId)
    if (kind === null) problems.push(`${at}.mediaId: 素材「${mediaId}」が存在しません`)
    else if (kind !== 'audio') problems.push(`${at}.mediaId: 素材「${mediaId}」は音声ではありません`)
    else if (seen.has(mediaId)) problems.push(`${at}.mediaId: 素材「${mediaId}」はすでに別の曲に使われています`)
    seen.add(mediaId)

    const title = readText('title', 1, MAX_TITLE_LENGTH)
    const credit = readText('credit', 1, MAX_CREDIT_LENGTH)
    const creditUrl = readText('creditUrl', 0, MAX_CREDIT_URL_LENGTH)
    if (creditUrl !== '' && !CREDIT_URL_PATTERN.test(creditUrl)) {
      problems.push(`${at}.creditUrl: http:// か https:// で始まるURLにしてください（無ければ空欄）`)
    }
    const mood = readText('mood', 0, MAX_DESCRIPTION_LENGTH)
    const scene = readText('scene', 0, MAX_DESCRIPTION_LENGTH)

    if (problems.length > before) return []
    return [{ mediaId, title, credit, creditUrl, mood, scene }]
  })

  if (playingMediaId !== null && !seen.has(playingMediaId)) {
    problems.push(`tracks: 流している曲（素材「${playingMediaId}」）は消せません。先に止めるか別の曲に切り替えてください`)
  }

  if (problems.length > 0) throw new ConfigError(TRACKS_SUBJECT, problems)
  return tracks
}

/**
 * 管理画面から送られてきた「いま流す曲・音量」を検証する。
 *
 * @param input `{ mediaId: string | null, volume: number }`
 * @param trackMediaIds 一覧にある曲の素材のID
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseBgmPlayback = (input: unknown, trackMediaIds: readonly string[]): BgmPlayback => {
  if (!isRecord(input)) throw new ConfigError(PLAYBACK_SUBJECT, ['設定はオブジェクトで指定してください'])

  const problems: string[] = []

  const { mediaId, volume } = input
  if (mediaId !== null && (typeof mediaId !== 'string' || !trackMediaIds.includes(mediaId))) {
    problems.push(`mediaId: 素材「${String(mediaId)}」の曲は一覧にありません`)
  }
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < MIN_VOLUME || volume > MAX_VOLUME) {
    problems.push(`volume: ${MIN_VOLUME}〜${MAX_VOLUME} の数で指定してください`)
  }

  if (problems.length > 0) throw new ConfigError(PLAYBACK_SUBJECT, problems)
  return { mediaId: mediaId as string | null, volume: volume as number }
}

/**
 * 管理画面から送られてきたBGMの設定を検証する。
 *
 * @param input `{ judgeWithJev: boolean }`
 * @throws ConfigError 問題がある場合
 */
export const parseBgmSettings = (input: unknown): BgmSettings => {
  if (!isRecord(input)) throw new ConfigError(SETTINGS_SUBJECT, ['設定はオブジェクトで指定してください'])
  const { judgeWithJev } = input
  if (typeof judgeWithJev !== 'boolean') throw new ConfigError(SETTINGS_SUBJECT, ['judgeWithJev: true か false で指定してください'])
  return { judgeWithJev }
}

export const saveBgmTracks = (store: KeyValueStore, tracks: readonly BgmTrack[]): Promise<void> => store.put(TRACKS_KEY, JSON.stringify(tracks))

/** 保存済みの曲の一覧を読む。未保存なら空 */
export const loadBgmTracks = async (store: KeyValueStore): Promise<BgmTrack[]> => {
  const text = await store.get(TRACKS_KEY)
  return text === null ? [] : (JSON.parse(text) as BgmTrack[])
}

export const saveBgmPlayback = (store: KeyValueStore, playback: BgmPlayback): Promise<void> =>
  store.put(PLAYBACK_KEY, JSON.stringify(playback))

/** 保存済みの再生の設定を読む。未保存なら何も流さない */
export const loadBgmPlayback = async (store: KeyValueStore): Promise<BgmPlayback> => {
  const text = await store.get(PLAYBACK_KEY)
  return text === null ? DEFAULT_BGM_PLAYBACK : (JSON.parse(text) as BgmPlayback)
}

export const saveBgmSettings = (store: KeyValueStore, settings: BgmSettings): Promise<void> =>
  store.put(SETTINGS_KEY, JSON.stringify(settings))

/** 保存済みのBGMの設定を読む。未保存なら Jev に選ばせない */
export const loadBgmSettings = async (store: KeyValueStore): Promise<BgmSettings> => {
  const text = await store.get(SETTINGS_KEY)
  return text === null ? DEFAULT_BGM_SETTINGS : (JSON.parse(text) as BgmSettings)
}

/** 流す曲を切り替えた時刻（ミリ秒）を記録する。手で切り替えたときも Jev が切り替えたときも記録する */
export const saveBgmSwitchedAt = (store: KeyValueStore, at: number): Promise<void> => store.put(SWITCHED_AT_KEY, String(at))

/** 最後に流す曲を切り替えた時刻（ミリ秒）を読む。まだ一度も記録していなければ null */
export const loadBgmSwitchedAt = async (store: KeyValueStore): Promise<number | null> => {
  const text = await store.get(SWITCHED_AT_KEY)
  return text === null ? null : Number(text)
}

/**
 * いま流している曲を一覧から引く。止めているときは null。
 *
 * @throws 流す曲が一覧に無い場合（保存のときに防いでいるので、起きたら壊れている。黙って止めない）
 */
export const playingTrackOf = (tracks: readonly BgmTrack[], playback: BgmPlayback): BgmTrack | null => {
  if (playback.mediaId === null) return null
  const track = tracks.find((candidate) => candidate.mediaId === playback.mediaId)
  if (!track) throw new Error(`素材「${playback.mediaId}」の曲が一覧にありません（流す曲に選ばれています）`)
  return track
}

/**
 * 裏方のページへ渡す「いま流している曲」を組み立てる。
 *
 * @param overlayKey オーバーレイ用キー。音声のURLに付ける
 * @throws 流す曲が一覧に無い場合（保存のときに防いでいるので、起きたら壊れている。黙って止めない）
 */
export const nowPlayingOf = (tracks: readonly BgmTrack[], playback: BgmPlayback, overlayKey: string): BgmNowPlaying => {
  const track = playingTrackOf(tracks, playback)
  if (track === null) return { track: null, volume: playback.volume }
  return {
    track: { mediaId: track.mediaId, title: track.title, credit: track.credit, creditUrl: track.creditUrl, url: mediaPath(track.mediaId, overlayKey) },
    volume: playback.volume,
  }
}
