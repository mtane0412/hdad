/**
 * テキストの経路
 *
 * 配信者が自由に書いた文字（合成ページの素材「テキスト」。issue #294）を、アプリのページ（/texts/）・下部バーと合成ページから使う。
 * - GET /api/admin/texts: テキストを追加した順に返す
 * - POST /api/admin/texts: テキストを検証して追加する（{ name, mode, body, instruction }。自動なら body は読まない）
 * - PUT /api/admin/texts/:id: テキストの名前・手動／自動の別・指示文（手動なら本文も）を検証して書き換える（同上）
 * - DELETE /api/admin/texts/:id: テキストを消す
 * - GET /api/overlay/texts: テキストの一覧を返す（オーバーレイ用キー）。開いたとき・つなぎ直したとき・定期的に読む
 * - GET /api/overlay/texts/socket: テキストが変わるたびに一覧を丸ごと押し出してもらう WebSocket。接続を保持するのはアラートと同じ
 *   Durable Object（worker/alert-channel.ts）で、ここはキーを確かめて引き渡すだけである
 *
 * 追加・書き換え・削除のたびに、いまの一覧を丸ごと合成ページへ押し出す（作業机と同じ形）。
 *
 * 注意: 押し出しに失敗しても、保存は取り消さない（合成ページは5分おきに読み直すので、いずれ映る）。ただし黙って成功にもせず、
 *   保存は済んだことを添えて502で返す（方針4）。
 */
import { connectTextSocket, pushTexts } from './alert-channel'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { overlayKeyTag } from './overlay-key'
import { MAX_TEXT_COUNT, parseTextInput, type TextEntry } from './text'
import { deleteText, insertText, readTexts, updateText } from './text-store'

/** 経路の :id として受け付ける書式（1以上の整数） */
const TEXT_ID = /^[1-9][0-9]*$/

const readJson = (context: Context): Promise<unknown> =>
  context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })

const notFound = (raw: string): HttpError => new HttpError(STATUS.notFound, 'text-not-found', `テキスト「${raw}」はありません（別の窓で消された可能性があります）`)

/**
 * 経路の :id をテキストのIDとして読む。
 *
 * @throws HttpError IDとして読めなければ404（そのIDのテキストは無いので）
 */
const textIdOf = (context: Context): number => {
  const raw = context.params.id ?? ''
  if (!TEXT_ID.test(raw)) throw notFound(raw)
  return Number(raw)
}

/**
 * いまのテキストの一覧を合成ページへ押し出す。
 *
 * @throws HttpError 押し出せなければ502（保存は済んでいることを文面に添える）
 */
const pushCurrentTexts = async (context: Context): Promise<void> => {
  const texts = await readTexts(context.env.DB)
  try {
    await pushTexts(context.env.ALERTS, { texts })
  } catch (error) {
    throw new HttpError(
      STATUS.badGateway,
      'text-push-failed',
      `保存しましたが、合成ページへすぐには送れませんでした。合成ページは5分以内に読み直して映します（${error instanceof Error ? error.message : String(error)}）`,
    )
  }
}

/** GET /api/admin/texts: テキストを追加した順に返す */
export const getTexts = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ texts: await readTexts(context.env.DB) })
}

/**
 * POST /api/admin/texts: テキストを検証して追加し、合成ページへ一覧を押し出す。
 *
 * @throws ConfigError 名前・本文に問題がある場合（index.ts が問題点付きの400にする）
 * @throws HttpError 持てる数を超える場合は409
 */
export const postText = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body = await readJson(context)
  const texts = await readTexts(context.env.DB)
  const input = parseTextInput(
    body,
    texts.map((text) => text.name),
  )
  // 件数の確認は追加と同じ文の中で行う（読んだ一覧で数えると、並んだ追加で上限を超えるため）
  const text = await insertText(context.env.DB, input, context.now)
  if (text === null) {
    throw new HttpError(STATUS.conflict, 'too-many-texts', `テキストは${MAX_TEXT_COUNT}件までです。使っていないものを消してから追加してください`)
  }
  await pushCurrentTexts(context)
  return Response.json({ text } satisfies { text: TextEntry }, { status: STATUS.created })
}

/**
 * PUT /api/admin/texts/:id: テキストの名前と本文を検証して書き換え、合成ページへ一覧を押し出す。
 *
 * @throws ConfigError 名前・本文に問題がある場合（名前の重なりは、そのテキスト自身を除いて見る）
 * @throws HttpError そのテキストが無ければ404
 */
export const putText = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = textIdOf(context)
  const body = await readJson(context)
  const texts = await readTexts(context.env.DB)
  if (!texts.some((text) => text.id === id)) throw notFound(String(id))
  const input = parseTextInput(
    body,
    texts.filter((text) => text.id !== id).map((text) => text.name),
  )
  const text = await updateText(context.env.DB, id, input, context.now)
  // 読んでから書くまでのあいだに別の窓で消された場合
  if (text === null) throw notFound(String(id))
  await pushCurrentTexts(context)
  return Response.json({ text } satisfies { text: TextEntry })
}

/**
 * DELETE /api/admin/texts/:id: テキストを消し、合成ページへ一覧を押し出す。
 *
 * 消したテキストを映している素材は、合成ページで箱にエラーを出す（黙って空にしない）。
 *
 * @throws HttpError そのテキストが無ければ404
 */
export const removeText = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const id = textIdOf(context)
  if (!(await deleteText(context.env.DB, id))) throw notFound(String(id))
  await pushCurrentTexts(context)
  return new Response(null, { status: STATUS.noContent })
}

/** GET /api/overlay/texts?key=: テキストの一覧 */
export const getOverlayTexts = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return Response.json({ texts: await readTexts(context.env.DB) })
}

/** GET /api/overlay/texts/socket?key=: 合成ページからのWebSocketの接続を、テキストの一覧を受け取る接続として配送先へ引き渡す */
export const textSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectTextSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}
