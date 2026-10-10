/**
 * 意見ボードの経路（issue #306）
 *
 * 配信者がテーマを出して視聴者のコメントから意見を取り出す機能を、アプリのページ（/opinions/）と合成ページから使う。
 * - GET /api/admin/opinions: 最後に開いたテーマの意見ボードを、隠した意見・人数・もとのコメントを添えて返す
 * - POST /api/admin/opinions/themes: テーマを開き（{ title }）、振り分けのアラームを仕掛ける。ほかのテーマが開いていれば409
 * - POST /api/admin/opinions/themes/:id/close: テーマを締め切り、振り分けのアラームを外す。開いていないテーマなら404
 * - PUT /api/admin/opinions/items/:id: 意見を隠す・隠すのをやめる（{ hidden }）。荒らし対策
 * - GET /api/overlay/opinions: 合成ページへ、人数を含まない意見ボードを返す（オーバーレイ用キー）
 * - GET /api/overlay/opinions/socket: 意見ボードが変わるたびに丸ごと押し出してもらう WebSocket。接続を保持するのはアラートと同じ
 *   Durable Object（worker/alert-channel.ts）で、ここはキーを確かめて引き渡すだけである
 *
 * 開く・締め切る・隠すたびに、いまの意見ボードを丸ごと合成ページへ押し出す（テキストと同じ形）。
 *
 * 注意: 押し出し・アラームの操作に失敗しても、保存は取り消さない。アラームの操作に失敗したときも、先に意見ボードを押し出す。ただし黙って成功にもせず、保存は済んだことを添えて502で返す（方針4）。
 */
import { ConfigError } from './alert-config'
import { connectOpinionSocket, pushOpinions } from './alert-channel'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { parseThemeInput, type OpinionTheme } from './opinion'
import { closeTheme, openTheme, readAdminBoard, readOverlayBoard, setOpinionHidden } from './opinion-store'
import { startOpinionTimer, stopOpinionTimer } from './opinion-timer'
import { overlayKeyTag } from './overlay-key'

/** 経路の :id として受け付ける書式（1以上の整数） */
const ID = /^[1-9][0-9]*$/

const readJson = (context: Context): Promise<unknown> =>
  context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 経路の :id を読む。
 *
 * @throws HttpError IDとして読めなければ、notFound が作る404（そのIDのものは無いので）
 */
const idOf = (context: Context, notFound: (raw: string) => HttpError): number => {
  const raw = context.params.id ?? ''
  if (!ID.test(raw)) throw notFound(raw)
  return Number(raw)
}

const themeNotFound = (raw: string): HttpError =>
  new HttpError(STATUS.notFound, 'opinion-theme-not-open', `テーマ「${raw}」は開いていません（別の窓で締め切られた可能性があります）`)

const opinionNotFound = (raw: string): HttpError => new HttpError(STATUS.notFound, 'opinion-not-found', `意見「${raw}」はありません`)

/**
 * いまの意見ボードを合成ページへ押し出す。
 *
 * @param done 何を済ませたか（失敗の文面に添える）
 * @throws HttpError 押し出せなければ502
 */
const pushCurrentBoard = async (context: Context, done: string): Promise<void> => {
  const board = await readOverlayBoard(context.env.DB)
  try {
    await pushOpinions(context.env.ALERTS, board)
  } catch (error) {
    throw new HttpError(
      STATUS.badGateway,
      'opinion-push-failed',
      `${done}が、合成ページへすぐには送れませんでした。合成ページは5分以内に読み直して映します（${reasonOf(error)}）`,
    )
  }
}

/** GET /api/admin/opinions: 最後に開いたテーマの意見ボード（隠した意見・人数・もとのコメントつき） */
export const getAdminOpinions = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await readAdminBoard(context.env.DB))
}

/**
 * POST /api/admin/opinions/themes: テーマを開き、振り分けのアラームを仕掛けて、意見ボードを押し出す。
 *
 * @throws ConfigError テーマが空・上限を超える場合（index.ts が問題点付きの400にする）
 * @throws HttpError ほかのテーマが開いていれば409。アラームを仕掛けられない・押し出せなければ502
 */
export const postOpinionTheme = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { title } = parseThemeInput(await readJson(context))
  const theme = await openTheme(context.env.DB, title, context.now)
  if (theme === null) {
    throw new HttpError(STATUS.conflict, 'opinion-theme-open', 'ほかのテーマが開いています。締め切ってから新しいテーマを開いてください')
  }
  // アラームを仕掛けられなくても、テーマは開いたので、先に合成ページへ押し出してから失敗を返す（配信画面を古いままにしない）
  const timerError = await startOpinionTimer(context.env.AD_BREAKS).then(
    () => null,
    (error: unknown) => error,
  )
  await pushCurrentBoard(context, 'テーマを開きました')
  if (timerError !== null) {
    throw new HttpError(
      STATUS.badGateway,
      'opinion-timer-failed',
      `テーマを開きましたが、コメントの振り分けを始められませんでした。いったん締め切って開き直してください（${reasonOf(timerError)}）`,
    )
  }
  return Response.json({ theme } satisfies { theme: OpinionTheme }, { status: STATUS.created })
}

/**
 * POST /api/admin/opinions/themes/:id/close: テーマを締め切り、振り分けのアラームを外して、意見ボードを押し出す。
 *
 * まだ振り分けていないコメントは振り分け待ちのまま残す（締め切ったあとは振り分けない）。
 *
 * @throws HttpError 開いていないテーマなら404。押し出せなければ502
 */
export const postCloseOpinionTheme = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = idOf(context, themeNotFound)
  const theme = await closeTheme(context.env.DB, id, context.now)
  if (theme === null) throw themeNotFound(String(id))
  // アラームを外せなくても、テーマは締め切ったので、先に合成ページへ押し出してから失敗を返す（配信画面を古いままにしない）
  const timerError = await stopOpinionTimer(context.env.AD_BREAKS).then(
    () => null,
    (error: unknown) => error,
  )
  await pushCurrentBoard(context, 'テーマを締め切りました')
  if (timerError !== null) {
    // 止められなくても、次のアラームがテーマの締め切りを読んで止まるので、振り分けが続くことはない。黙らずに知らせる
    throw new HttpError(STATUS.badGateway, 'opinion-timer-failed', `テーマを締め切りましたが、振り分けのアラームを外せませんでした（${reasonOf(timerError)}）`)
  }
  return Response.json({ theme } satisfies { theme: OpinionTheme })
}

/**
 * PUT /api/admin/opinions/items/:id: 意見を隠す・隠すのをやめて、意見ボードを押し出す。
 *
 * @throws ConfigError hidden が真偽値でない場合
 * @throws HttpError 無い意見なら404。押し出せなければ502
 */
export const putOpinion = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = idOf(context, opinionNotFound)
  const body = await readJson(context)
  const hidden = typeof body === 'object' && body !== null && 'hidden' in body ? body.hidden : undefined
  if (typeof hidden !== 'boolean') throw new ConfigError('意見', ['hidden は true か false にしてください'])
  if (!(await setOpinionHidden(context.env.DB, id, hidden))) throw opinionNotFound(String(id))
  await pushCurrentBoard(context, hidden ? '意見を隠しました' : '意見を戻しました')
  return new Response(null, { status: STATUS.noContent })
}

/** GET /api/overlay/opinions?key=: 人数を含まない意見ボード */
export const getOverlayOpinions = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return Response.json(await readOverlayBoard(context.env.DB))
}

/** GET /api/overlay/opinions/socket?key=: 合成ページからのWebSocketの接続を、意見ボードを受け取る接続として配送先へ引き渡す */
export const opinionSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectOpinionSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}
