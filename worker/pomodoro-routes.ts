/**
 * ポモドーロの経路
 *
 * ポモドーロのタイマー（issue #208）を、アプリのページ（/pomodoro/）と合成ページの素材「ポモドーロ」から使う。
 * - GET /api/admin/pomodoro: いまのタイマーと、休憩の曲の設定を返す
 * - PUT /api/admin/pomodoro/settings: 休憩の曲を検証して保存する
 * - POST /api/admin/pomodoro/control: タイマーを操作する（{ command: 'start' | 'pause' | 'resume' | 'stop' }）
 * - GET /api/overlay/pomodoro: いまのタイマーを返す（オーバーレイ用キー）。開いたとき・つなぎ直したとき・定期的に読む
 * - GET /api/overlay/pomodoro/socket: タイマーが変わるたびに押し出してもらう WebSocket。接続を保持するのはアラートと同じ
 *   Durable Object（worker/alert-channel.ts）で、ここはキーを確かめて引き渡すだけである
 *
 * タイマーの状態と区切りのアラームは Durable Object（worker/pomodoro-timer.ts）が持ち、ここは受け渡すだけである。
 */
import { connectPomodoroSocket } from './alert-channel'
import { loadBgmTracks } from './bgm-config'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { overlayKeyTag } from './overlay-key'
import { loadPomodoroSettings, parsePomodoroSettings, savePomodoroSettings } from './pomodoro-config'
import { POMODORO_COMMANDS, controlPomodoro, readPomodoroTimer, type PomodoroCommand } from './pomodoro-timer'

const readJson = (context: Context): Promise<unknown> =>
  context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

const isCommand = (value: unknown): value is PomodoroCommand => POMODORO_COMMANDS.some((command) => command === value)

/** GET /api/admin/pomodoro: いまのタイマー（止めていれば null）と、休憩の曲の設定 */
export const getPomodoro = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { env } = context
  const { timer } = await readPomodoroTimer(env.AD_BREAKS)
  return Response.json({ timer, settings: await loadPomodoroSettings(env.STORE) })
}

/**
 * PUT /api/admin/pomodoro/settings: 休憩の曲を検証して保存する。
 *
 * @throws ConfigError BGMの一覧に無い曲の場合（index.ts が問題点付きの400にする）
 */
export const putPomodoroSettings = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { env } = context
  const body = await readJson(context)
  const tracks = await loadBgmTracks(env.STORE)
  const settings = parsePomodoroSettings(
    body,
    tracks.map((track) => track.mediaId),
  )
  await savePomodoroSettings(env.STORE, settings)
  return Response.json({ settings })
}

/**
 * POST /api/admin/pomodoro/control: タイマーを操作し、操作したあとのタイマーを返す。
 *
 * @throws HttpError 知らない操作なら400、今の状態でできない操作なら409
 */
export const postPomodoroControl = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body = await readJson(context)
  const command = typeof body === 'object' && body !== null && 'command' in body ? body.command : undefined
  if (!isCommand(command)) {
    throw new HttpError(STATUS.badRequest, 'invalid-command', `command は ${POMODORO_COMMANDS.join('・')} のどれかで指定してください`)
  }
  return Response.json(await controlPomodoro(context.env.AD_BREAKS, command))
}

/** GET /api/overlay/pomodoro?key=: いまのタイマー（止めていれば null） */
export const getOverlayPomodoro = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return Response.json(await readPomodoroTimer(context.env.AD_BREAKS))
}

/** GET /api/overlay/pomodoro/socket?key=: 合成ページからのWebSocketの接続を、タイマーを受け取る接続として配送先へ引き渡す */
export const pomodoroSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectPomodoroSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}
