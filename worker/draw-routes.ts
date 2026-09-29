/**
 * 手書きの線の経路（描く画面から呼ばれる）
 *
 * 配信者が描く画面（/draw/）で引いた線を中継先（worker/draw-channel.ts）へ届けるための入口である。
 * 合成ページ側の入口は、守り方がセッションではなくオーバーレイ用キーなので worker/overlay-routes.ts に置く
 * （注目コメントと同じ置き分け）。
 *
 * 描いたものの保存（PUT /api/admin/draw/strokes）もここにある。中継先は開いている接続の間だけの通り道なので、
 * OBSのブラウザソースを作り直しても描いたものが残るよう、引き終えた線をKVへ写す（worker/draw-config.ts）。
 * 描く画面の背景に敷く配信画面の1枚（GET /api/admin/draw/background）も、描く画面から読むのでここに置く。
 */
import { connectDrawSocket } from './draw-channel'
import { loadStrokes, parseStrokes, saveStrokes } from './draw-config'
import { createGyazoClient } from './gyazo'
import { HttpError, STATUS, requireAdmin, requireSession, type Context } from './http'
import { readLatestScreenCapture } from './screen-store'

/** 配信画面の1枚を指すので、ブラウザや途中の経路に残させない */
const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * GET /api/admin/draw/socket: 描く画面からのWebSocketの接続を、描く側として中継先へ引き渡す。
 *
 * 注意: WebSocketの接続はGETなので、書き換えを伴うメソッドにだけ効く送信元の確認（requireAdmin）が働かない。
 * WebSocketのハンドシェイクはトップレベルの画面遷移ではないので SameSite=Lax のクッキーは別サイトからは付かないが、
 * ブラウザの決まりだけに頼らず、requireAdmin と同じように Origin を自分でも確かめる
 * （別サイトに開かせた接続から配信画面へ描かれないようにする）。
 */
export const drawSocket = async (context: Context): Promise<Response> => {
  await requireSession(context)
  if (context.request.headers.get('Origin') !== context.url.origin) {
    throw new HttpError(STATUS.forbidden, 'cross-origin', '管理画面と同じサイトからの接続だけを受け付けます')
  }
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectDrawSocket(context.env.DRAW, context.request, true)
}

/** GET /api/admin/draw/strokes: 保存されている線。描く画面を開き直したときに、続きから描くために読む */
export const getDrawStrokes = async (context: Context): Promise<Response> => {
  await requireSession(context)
  return Response.json({ strokes: await loadStrokes(context.env.STORE) })
}

/**
 * PUT /api/admin/draw/strokes: 描いたものを検証して保存する（全消しの直後は空の配列を送る）。
 *
 * デバウンスは描く画面の側が持ち（src/draw/save.ts）、ここは受け取ったものを検証して書くだけである。
 *
 * @throws ConfigError 線の形に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putDrawStrokes = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const strokes = parseStrokes(body)
  await saveStrokes(context.env.STORE, strokes)
  return Response.json({ strokes })
}

/**
 * GET /api/admin/draw/background: 描く画面の背景に敷く、最後に撮った配信画面の1枚。
 *
 * 画像は画面の取り込みが Gyazo へ上げたもので、ここは最後に撮った1枚の画像ID（D1 の screen_captures）から
 * 画像そのもののURLを引いて返すだけにする。描く画面のブラウザがそのURLを Gyazo から直接読む（画像は
 * access_policy=anyone で上げている。worker/gyazo.ts）。配信していないあいだは、最後に配信した時点の1枚になる。
 *
 * 描く画面は背景を敷いているあいだ読みに来続けるので、画像IDを印（ETag）にして、手元と同じ1枚なら
 * Gyazo を呼ばずに304を返す。Gyazo を呼ぶのは、新しい1枚が撮られたときだけである。まだ1枚も無ければ204を返す。
 *
 * 注意: Gyazo のアクセストークンが無ければ、黙って「背景なし」にせず失敗させる（Fail-Fast）。
 */
export const getDrawBackground = async (context: Context): Promise<Response> => {
  await requireSession(context)
  const { env, request } = context
  const 最後の1枚 = await readLatestScreenCapture(env.DB)
  if (最後の1枚 === null) return new Response(null, { status: STATUS.noContent, headers: NO_STORE })

  const etag = `"${最後の1枚.imageId}"`
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: STATUS.notModified, headers: { ...NO_STORE, ETag: etag } })

  const accessToken = env.GYAZO_ACCESS_TOKEN
  if (!accessToken) {
    throw new HttpError(
      STATUS.internalServerError,
      'gyazo-token-missing',
      'Gyazo のアクセストークン（GYAZO_ACCESS_TOKEN）が設定されていません。背景に配信画面を敷くには設定してください',
    )
  }
  const url = await createGyazoClient({ accessToken, fetch: context.fetch }).fetchImageUrl(最後の1枚.imageId)
  return Response.json({ imageId: 最後の1枚.imageId, capturedAt: 最後の1枚.capturedAt, url }, { headers: { ...NO_STORE, ETag: etag } })
}
