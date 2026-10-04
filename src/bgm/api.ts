/**
 * BGMの読み書き（Workerの呼び出し）
 *
 * BGMの曲の一覧と「いま流す曲・音量」と設定は Worker（KVの bgm-tracks・bgm-playback・bgm-settings）が持ち、2つの経路から読まれる。
 * - 管理画面（/bgm/ のページ）: 配信者のセッションで /api/admin/bgm を読み書きする
 * - 裏方のページ（overlay/backstage/ の ?bgm=true）: オーバーレイ用キーで /api/overlay/bgm を読み、リピートを切っているときは
 *   曲の終わりを /api/overlay/bgm/ended で知らせる（次の曲は Worker が決める）。
 *   切り替えは WebSocket で押し出されてくるので、その文字列の読み取り（parseBgmNowPlaying）もここに置く
 *   （管理画面も、Jev や曲の終わりで変わった曲を映すために同じ押し出しを受け取る）
 * - 合成ページ（overlay/stage/ の素材「市町村紹介」）: 紹介のBGMを鳴らすあいだ、オーバーレイ用キーで /api/overlay/bgm/duck に
 *   「配信のBGMを下げておく長さ」を送る。裏方のページはそれを別の WebSocket で受け取る（parseBgmDuck。issue #245）
 *
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の型はここで定義して形を確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。黙って「何も流していない」に倒すと、壊れていることに気づけない。
 * 注意: 値の検証は Worker（worker/bgm-config.ts）だけが持つ。画面とWorkerで二重に持たない。
 */
import { createCaller, isRecord, readList } from '../core/api'

const ADMIN_PATH = '/api/admin/bgm'
const TRACKS_PATH = '/api/admin/bgm/tracks'
const PLAYBACK_PATH = '/api/admin/bgm/playback'
const SETTINGS_PATH = '/api/admin/bgm/settings'
const SKIP_PATH = '/api/admin/bgm/skip'
const OVERLAY_PATH = '/api/overlay/bgm'
const ENDED_PATH = '/api/overlay/bgm/ended'
const DUCK_PATH = '/api/overlay/bgm/duck'

/** 切り替えを押し出してもらう WebSocket のパス。裏方のページ（task.ts）と合成ページの素材「再生中の曲」と管理画面がつなぐ */
export const BGM_SOCKET_PATH = '/api/overlay/bgm/socket'

/**
 * 配信のBGMを下げる知らせを押し出してもらう WebSocket のパス。裏方のページ（task.ts）だけがつなぐ。
 * 曲の切り替えとは別の経路にするのは、切り替えを受け取る素材「再生中の曲」と管理画面に、読まない知らせを届けないためである
 */
export const BGM_DUCK_SOCKET_PATH = '/api/overlay/bgm/duck/socket'

/** 一度もつながらないまま閉じたときに出す、いちばんありそうな原因 */
export const BGM_SOCKET_HINT = 'BGMの切り替えの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

/** 配信のBGMを下げる知らせの経路が、一度もつながらないまま閉じたときに出す原因 */
export const BGM_DUCK_SOCKET_HINT = '配信のBGMを下げる知らせの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

/** BGMの曲1つ。項目は worker/bgm-config.ts と合わせる */
export interface BgmTrack {
  /** 音声の素材のID。曲の識別子も兼ねる */
  mediaId: string
  /** 曲名 */
  title: string
  /** クレジット表記 */
  credit: string
  /** クレジット先のURL。無ければ空文字 */
  creditUrl: string
  /** 曲調。無ければ空文字 */
  mood: string
  /** 流したい場面。無ければ空文字 */
  scene: string
}

/** いま流す曲と音量と、曲の終わりにどうするか。項目は worker/bgm-config.ts と合わせる */
export interface BgmPlayback {
  /** 流す曲の素材のID。止めているときは null */
  mediaId: string | null
  /** 音量（0〜1） */
  volume: number
  /** 流している曲を繰り返すか。切っていれば、曲の終わりに次の曲へ進む */
  repeat: boolean
  /** 次の曲を一覧の順ではなく、でたらめに選ぶか */
  shuffle: boolean
}

/** 次の曲・前の曲のどちらへ進めるか */
export type BgmStep = 'next' | 'previous'

/** BGMの設定。項目は worker/bgm-config.ts と合わせる */
export interface BgmSettings {
  /** 配信の話題や雰囲気に合う曲へ、Jev に切り替えさせるか */
  judgeWithJev: boolean
}

/** 裏方のページが受け取る、いま流している曲 */
export interface BgmNowPlaying {
  /** 流している曲。止めているときは null */
  track: {
    mediaId: string
    title: string
    credit: string
    creditUrl: string
    /** 音声を読むパス（オーバーレイ用キーつき） */
    url: string
  } | null
  volume: number
  /** 流している曲を繰り返すか */
  repeat: boolean
  /** 次の曲をでたらめに選ぶか */
  shuffle: boolean
}

const isBgmTrack = (value: unknown): value is BgmTrack =>
  isRecord(value) &&
  typeof value.mediaId === 'string' &&
  typeof value.title === 'string' &&
  typeof value.credit === 'string' &&
  typeof value.creditUrl === 'string' &&
  typeof value.mood === 'string' &&
  typeof value.scene === 'string'

const isBgmPlayback = (value: unknown): value is BgmPlayback =>
  isRecord(value) &&
  (value.mediaId === null || typeof value.mediaId === 'string') &&
  typeof value.volume === 'number' &&
  typeof value.repeat === 'boolean' &&
  typeof value.shuffle === 'boolean'

const isNowPlayingTrack = (value: unknown): value is NonNullable<BgmNowPlaying['track']> =>
  isRecord(value) &&
  typeof value.mediaId === 'string' &&
  typeof value.title === 'string' &&
  typeof value.credit === 'string' &&
  typeof value.creditUrl === 'string' &&
  typeof value.url === 'string'

/** いま流している曲として読む。想定した形でなければエラーにする */
const readNowPlaying = (body: unknown, source: string): BgmNowPlaying => {
  if (
    !isRecord(body) ||
    typeof body.volume !== 'number' ||
    typeof body.repeat !== 'boolean' ||
    typeof body.shuffle !== 'boolean' ||
    !(body.track === null || isNowPlayingTrack(body.track))
  ) {
    throw new Error(`${source}のBGMが想定した形ではありません`)
  }
  return { track: body.track, volume: body.volume, repeat: body.repeat, shuffle: body.shuffle }
}

/** 再生の設定として読む。想定した形でなければエラーにする */
const readPlayback = (value: unknown, path: string): BgmPlayback => {
  if (!isBgmPlayback(value)) throw new Error(`Workerの ${path} の応答の playback が想定した形ではありません`)
  return { mediaId: value.mediaId, volume: value.volume, repeat: value.repeat, shuffle: value.shuffle }
}

/** BGMの設定として読む。想定した形でなければエラーにする */
const readSettings = (value: unknown, path: string): BgmSettings => {
  if (!isRecord(value) || typeof value.judgeWithJev !== 'boolean') throw new Error(`Workerの ${path} の応答の settings が想定した形ではありません`)
  return { judgeWithJev: value.judgeWithJev }
}

/**
 * WebSocket で押し出された文字列を、いま流している曲として読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseBgmNowPlaying = (payload: string): BgmNowPlaying => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出されたBGMの切り替えをJSONとして読めません')
  }
  return readNowPlaying(body, '押し出された切り替え')
}

/** 配信のBGMを下げる知らせ。項目は worker/bgm-config.ts と合わせる */
export interface BgmDuck {
  /** 受け取ってから下げておく長さ（ミリ秒）。0 は「いますぐ戻す」 */
  holdMs: number
}

/**
 * WebSocket で押し出された文字列を、配信のBGMを下げる知らせとして読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseBgmDuck = (payload: string): BgmDuck => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出された配信のBGMを下げる知らせをJSONとして読めません')
  }
  if (!isRecord(body) || typeof body.holdMs !== 'number') throw new Error('押し出された配信のBGMを下げる知らせが想定した形ではありません')
  return { holdMs: body.holdMs }
}

/** 管理画面からの読み書き */
export interface BgmApi {
  /** 曲の一覧と、いま流す曲・音量と、BGMの設定を読む */
  load(): Promise<{ tracks: BgmTrack[]; playback: BgmPlayback; settings: BgmSettings }>
  /** 曲の一覧をまるごと置き換えて保存する。検証はWorkerが行う */
  saveTracks(tracks: readonly BgmTrack[]): Promise<BgmTrack[]>
  /** 流す曲と音量とリピート・シャッフルを保存する。Workerが裏方のページへ押し出す */
  savePlayback(playback: BgmPlayback): Promise<BgmPlayback>
  /** 次の曲・前の曲へ進めてもらう（どの曲にするかは Worker が決める）。Workerが裏方のページへ押し出す */
  skip(step: BgmStep): Promise<BgmPlayback>
  /** BGMの設定を保存する。検証はWorkerが行う */
  saveSettings(settings: BgmSettings): Promise<BgmSettings>
}

/** 裏方のページ・合成ページからの読み書き */
export interface BgmOverlayApi {
  /** いま流している曲を読む */
  read(): Promise<BgmNowPlaying>
  /** 流していた曲が終わったことを知らせ、いま流している曲（次の曲へ進めたなら進めた先）を受け取る */
  ended(mediaId: string): Promise<BgmNowPlaying>
  /** 配信のBGMを holdMs ミリ秒のあいだ下げるよう、裏方のページへ知らせてもらう（0 は戻す）。合成ページの市町村紹介が呼ぶ */
  duck(holdMs: number): Promise<void>
}

/**
 * 管理画面からの読み書きを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const createBgmApi = (fetchImpl: typeof fetch): BgmApi => {
  const call = createCaller(fetchImpl)
  const send = (method: 'PUT' | 'POST', path: string, body: unknown) =>
    call(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const put = (path: string, body: unknown) => send('PUT', path, body)

  return {
    load: async () => {
      const body = await call(ADMIN_PATH)
      return {
        tracks: readList(body, 'tracks', isBgmTrack),
        playback: readPlayback(isRecord(body) ? body.playback : undefined, ADMIN_PATH),
        settings: readSettings(isRecord(body) ? body.settings : undefined, ADMIN_PATH),
      }
    },
    saveTracks: async (tracks) => readList(await put(TRACKS_PATH, { tracks }), 'tracks', isBgmTrack),
    savePlayback: async (playback) => {
      const body = await put(PLAYBACK_PATH, playback)
      return readPlayback(isRecord(body) ? body.playback : undefined, PLAYBACK_PATH)
    },
    skip: async (step) => {
      const body = await send('POST', SKIP_PATH, { step })
      return readPlayback(isRecord(body) ? body.playback : undefined, SKIP_PATH)
    },
    saveSettings: async (settings) => {
      const body = await put(SETTINGS_PATH, settings)
      return readSettings(isRecord(body) ? body.settings : undefined, SETTINGS_PATH)
    },
  }
}

/**
 * 裏方のページ・合成ページからの読み書きを組み立てる。
 *
 * 裏方のページはOBSに載せるページなのでログインを持たず、オーバーレイ用キー（URLの ?key=）で Worker に受け付けてもらう。
 *
 * @param fetchImpl 通信の実装
 * @param key オーバーレイ用キー
 */
export const createBgmOverlayApi = (fetchImpl: typeof fetch, key: string): BgmOverlayApi => {
  const call = createCaller(fetchImpl)
  const query = `?key=${encodeURIComponent(key)}`

  return {
    read: async () => readNowPlaying(await call(`${OVERLAY_PATH}${query}`), `Workerの ${OVERLAY_PATH} の応答`),
    ended: async (mediaId) => {
      const body = await call(`${ENDED_PATH}${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaId }),
      })
      return readNowPlaying(body, `Workerの ${ENDED_PATH} の応答`)
    },
    duck: async (holdMs) => {
      await call(`${DUCK_PATH}${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ holdMs }) })
    },
  }
}
