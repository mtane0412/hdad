/**
 * BGMの経路（/api/admin/bgm・/api/overlay/bgm）
 *
 * 管理画面（/bgm/）が曲の一覧と「いま流す曲・音量」を読み書きし、裏方のページ（overlay/backstage/ の ?bgm=true）が
 * いま流している曲を受け取る。流す曲や音量を変えたら、アラートの配送先（worker/alert-channel.ts）を通して
 * 裏方のページへすぐに押し出す（ポーリングで待たせると、配信中の切り替えが数十秒遅れるため。issue #151）。
 *
 * 裏方のページは開いたときとつなぎ直したときに GET /api/overlay/bgm を読み、以後は押し出しを待つ。
 *
 * 注意: 値の検証は worker/bgm-config.ts だけが持つ（画面とWorkerで二重に持たない。speech-config.ts と同じ）。
 * 注意: 押し出しの失敗は握りつぶさず、管理画面へ失敗として返す（保存は済んでいるので、裏方のページはつなぎ直したときに
 * 新しい曲を読む。それでも配信者が「切り替わったはず」と思い込まないよう、失敗は知らせる）。
 */
import { connectBgmSocket, pushBgm } from './alert-channel'
import {
  loadBgmPlayback,
  loadBgmTracks,
  nowPlayingOf,
  parseBgmPlayback,
  parseBgmTracks,
  saveBgmPlayback,
  saveBgmTracks,
  type BgmPlayback,
  type BgmTrack,
} from './bgm-config'
import { HttpError, requireAdmin, requireOverlayKey, STATUS, type Context } from './http'
import { listMedia } from './media'
import { loadOverlayKey } from './overlay-key'

/** 本文をJSONとして読む。読めなければ400にする */
const readJson = (context: Context): Promise<unknown> =>
  context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

/** いま流している曲を裏方のページへ押し出す */
const pushNowPlaying = async (context: Context, tracks: readonly BgmTrack[], playback: BgmPlayback): Promise<void> => {
  const overlayKey = await loadOverlayKey(context.env.STORE)
  // キーはログインのときに発行されるので、管理画面から呼ばれている以上は必ずある。無ければ壊れているので黙らない
  if (overlayKey === null) throw new Error('オーバーレイ用キーが未発行のため、BGMの音声のURLを作れません')
  await pushBgm(context.env.ALERTS, nowPlayingOf(tracks, playback, overlayKey))
}

/** GET /api/admin/bgm: 曲の一覧と、いま流す曲・音量。未保存なら曲は空で何も流していない */
export const getBgm = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { STORE } = context.env
  return Response.json({ tracks: await loadBgmTracks(STORE), playback: await loadBgmPlayback(STORE) })
}

/**
 * PUT /api/admin/bgm/tracks: 曲の一覧を検証して保存する。
 *
 * 流している曲の情報（曲名・クレジット）を直したときに裏方のページの表示と食い違わないよう、
 * 何かを流しているあいだは保存のあとに押し出す。
 *
 * @throws ConfigError 一覧に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putBgmTracks = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body = await readJson(context)
  const { env } = context

  const kinds = new Map((await listMedia(env.MEDIA)).map((item) => [item.id, item.kind]))
  const playback = await loadBgmPlayback(env.STORE)
  const tracks = parseBgmTracks(body, (mediaId) => kinds.get(mediaId) ?? null, playback.mediaId)
  await saveBgmTracks(env.STORE, tracks)
  if (playback.mediaId !== null) await pushNowPlaying(context, tracks, playback)
  return Response.json({ tracks })
}

/**
 * PUT /api/admin/bgm/playback: 流す曲（止めるなら null）と音量を検証して保存し、裏方のページへ押し出す。
 *
 * @throws ConfigError 一覧に無い曲・範囲の外の音量の場合（index.ts が問題点付きの400にする）
 */
export const putBgmPlayback = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body = await readJson(context)
  const { env } = context

  const tracks = await loadBgmTracks(env.STORE)
  const playback = parseBgmPlayback(
    body,
    tracks.map((track) => track.mediaId),
  )
  await saveBgmPlayback(env.STORE, playback)
  await pushNowPlaying(context, tracks, playback)
  return Response.json({ playback })
}

/**
 * GET /api/overlay/bgm?key=: いま流している曲を返す。
 *
 * 裏方のページが開いたときと、押し出しの接続をつなぎ直したときに読む（つながっていない間の切り替えを取りこぼさないため）。
 */
export const getOverlayBgm = async (context: Context): Promise<Response> => {
  const overlayKey = await requireOverlayKey(context)
  const { STORE } = context.env
  return Response.json(nowPlayingOf(await loadBgmTracks(STORE), await loadBgmPlayback(STORE), overlayKey))
}

/**
 * GET /api/overlay/bgm/socket?key=: 裏方のページからのWebSocketの接続を、BGMの切り替えを受け取る接続として配送先へ引き渡す。
 */
export const overlayBgmSocket = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectBgmSocket(context.env.ALERTS, context.request)
}
