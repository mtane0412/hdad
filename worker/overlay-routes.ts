/**
 * オーバーレイ用の経路（OBSのブラウザソースから呼ばれる）
 *
 * どれもTwitchのトークンではなくオーバーレイ用キーで守る。素材だけは、管理画面でのプレビューのために配信者のセッションでも読める。
 */
import { connectAlertSocket } from './alert-channel'
import { connectDrawSocket } from './draw-channel'
import { connectTabSocket } from './tab-channel'
import { loadStrokes } from './draw-config'
import { createGyazoClient } from './gyazo'
import { loadFocusTarget } from './focus-config'
import { HttpError, STATUS, hasSession, requireOverlayKey, type Context } from './http'
import { kindOfContentType } from './media'
import { loadOverlayLayout } from './overlay-layout'
import { loadScreenSettings } from './screen-config'
import { isStreaming, recordScreenCapture } from './screen-store'
import { readCurrentSideSuper } from './side-super-store'
import { loadSpeechSettings } from './speech-config'
import { receiveTranscript } from './transcript-routes'

/**
 * GET /api/overlay/socket?key=: オーバーレイからのWebSocketの接続を受け、配送先（Durable Object）へ引き渡す。
 *
 * Twitchからの通知はWebhookでWorkerに届くので、オーバーレイはTwitchへつながず、この接続で
 * 「再生するアラート」だけを受け取る。どのトリガーに当てはまるかの判定はWorkerが受け持つ。
 *
 * 注意: 接続を保持するのは Durable Object で、Workerはキーを確かめて引き渡すだけである。
 */
export const overlaySocket = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectAlertSocket(context.env.ALERTS, context.request)
}

/**
 * GET /api/overlay/draw?key=: 合成ページからのWebSocketの接続を、見るだけとして中継先へ引き渡す。
 *
 * 配信者が描く画面（/draw/）で引いた線がここへ流れてくる。オーバーレイ用キーは配信画面に映りうるので、
 * この接続からは描けない（描く側として受け入れるのは worker/draw-routes.ts の経路だけ）。
 */
export const overlayDrawSocket = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectDrawSocket(context.env.DRAW, context.request, false)
}

/**
 * GET /api/overlay/tab?key=: 合成ページからのWebSocketの接続を、映す側として中継先へ引き渡す。
 *
 * 送り手（拡張）とのあいだで WebRTC の連絡をやりとりする。オーバーレイ用キーは配信画面に映りうるので、
 * この接続から送ったものは送り手にしか届かない（他の合成ページへは配らない。worker/tab-channel.ts）。
 */
export const overlayTabSocket = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectTabSocket(context.env.TAB, context.request, false)
}

/**
 * GET /api/overlay/draw/strokes?key=: 保存されている手書きの線を返す。
 *
 * 合成ページは開いたときにこれを1度読み、それを初期状態として描いてから中継先へつなぐ。中継先は開いている
 * 接続の間だけの通り道なので、これを読まないとブラウザソースを作り直したときに描いたものが消える（issue #133）。
 */
export const getDrawStrokes = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return Response.json({ strokes: await loadStrokes(context.env.STORE) })
}

/** 素材のIDはアップロードのたびに変わり、同じIDの中身は変わらないので、長くキャッシュさせる。キー付きのURLなので共有キャッシュには載せない */
const MEDIA_CACHE_CONTROL = 'private, max-age=31536000, immutable'
/**
 * 素材のURLを直接開かれたときに、素材（SVGなど）に仕込まれたスクリプトをこのサイトの権限で動かさないための指定。
 * img・video・audio の読み込みには影響しない。
 */
const MEDIA_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

/** GET /api/media/:id: 素材の中身を返す。オーバーレイ用キー（?key=）か、配信者のセッションが必要 */
export const media = async (context: Context): Promise<Response> => {
  if (!(await hasSession(context))) await requireOverlayKey(context)

  const id = context.params.id ?? ''
  const object = await context.env.MEDIA.get(id)
  const contentType = object?.httpMetadata?.contentType ?? ''
  if (!object || kindOfContentType(contentType) === null) {
    throw new HttpError(STATUS.notFound, 'media-not-found', `素材「${id}」が存在しません`)
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(object.size),
      'Cache-Control': MEDIA_CACHE_CONTROL,
      'Content-Security-Policy': MEDIA_CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/**
 * POST /api/overlay/transcript: 配信中の文字起こしを1件受け取る。
 *
 * OBSのブラウザソースに置いた中継ページ（transcript/index.html）が、同じPCで動いているゆかコネNEO の
 * 音声認識の結果のうち、確定した発話だけを押し込んでくる。あらすじ（issue #65）の材料になる。
 * 本文の検証と記録は、アプリのページの音声認識の受け口と同じもの（worker/transcript-routes.ts）を通す。
 */
export const postTranscript = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return receiveTranscript(context)
}

/**
 * GET /api/overlay/screen: 配信画面の取り込みのうち、撮るのに要る設定を返す。
 *
 * OBSのブラウザソースに置いた裏方のページ（overlay/backstage/）が、起動のときと、その後は撮るたびに読みに来る
 * （読み上げの設定と同じポーリング）。未保存なら既定の設定が返るので、何も設定していない配信者でも
 * 認証を切った OBS にならつながる。
 *
 * 注意: 上げ先のコレクション（collectionId）は渡さない。撮るのに要らず、上げるのは Worker だからである
 * （渡す必要のないものをオーバーレイ用キーの向こうへ出さない）。
 * 注意: 応答には obs-websocket のパスワードが入る。守り方はオーバーレイ用キーだけなので、キーが漏れると
 * OBSの操作権まで渡ることになる（docs/decisions/screen.md）。
 * 注意: ホストとポートは裏方のページが起動のときにしか使わない（つなぎ先が変わるので、つなぎ直しが要る）。
 * 撮影間隔は、読みに来るたびに次の1枚から効く。
 */
export const getScreen = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const { host, port, password, intervalSeconds } = await loadScreenSettings(context.env.STORE)
  return Response.json({ host, port, password, intervalSeconds })
}

/**
 * 撮った1枚として受け付ける大きさの上限（バイト）。
 *
 * 撮るのは1280幅のプログラムシーン1枚なので、PNGでもこの大きさには収まる（issue #122）。超えるものは
 * 裏方のページの誤りか、別のものが押し込まれているかなので、黙って切り詰めず拒む（Fail-Fast）。
 */
export const SCREEN_MAX_BYTES = 8 * 1024 * 1024

/** 撮った1枚として受け付ける形式。OBS の GetSourceScreenshot が返せるもののうち、Gyazo が読めるもの */
const SCREEN_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const

/**
 * POST /api/overlay/screen: 配信画面を撮った1枚を受け取り、Gyazo へ上げて記録する。
 *
 * OBSのブラウザソースに置いた裏方のページ（overlay/backstage/）が、同じPCで動いている OBS から
 * obs-websocket で現在のプログラムシーンを撮って押し込んでくる。画面に出ている文字を、配信者の発話と
 * 視聴者の発言に続く3つ目の材料にするためである（issue #122）。
 *
 * 配信していなければ Gyazo へ上げず、上げなかったことを応答で知らせる（裏方のページが画面に出せるように）。
 * 上げないのは、配信前の準備画面や配信後のデスクトップを外へ出さないためである。捨てるのを失敗にしないのは、
 * 配信の前後にOBSを開いたままにしておくのが普通の使い方だからである（文字起こしの受け口と同じ考え方）。
 *
 * 注意: 画像そのものはこのサイトに保存しない。Gyazo に上げた画像IDだけを残す（worker/screen-store.ts）。
 * 注意: 上げ先のコレクションは、裏方のページから受け取らずにここで設定から読む。撮る側に持たせると、
 * 貼ったURLや裏方のページの都合で上げ先が変わりうる（上げるのは Worker なので、決めるのも Worker にする）。
 * 注意: Gyazo のアクセストークンが無ければ、黙って捨てずに失敗させる（Fail-Fast）。捨ててしまうと、
 * 材料が貯まっていないことに配信が終わるまで気づけない。
 */
export const postScreen = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const { request, env, now } = context

  const contentType = (request.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  if (!SCREEN_CONTENT_TYPES.includes(contentType as (typeof SCREEN_CONTENT_TYPES)[number])) {
    throw new HttpError(
      STATUS.unsupportedMediaType,
      'invalid-content-type',
      `本文は ${SCREEN_CONTENT_TYPES.join(' か ')} にしてください（受け取ったのは「${contentType}」です）`,
    )
  }

  // 本文を読む前に、申告された長さで拒めるものは拒む（大きなものをWorkerのメモリに載せないため）。
  // 申告が無いことも、正しいとも限らないので、読んだあとの長さでも確かめる
  const declaredLength = Number(request.headers.get('Content-Length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > SCREEN_MAX_BYTES) {
    throw new HttpError(STATUS.payloadTooLarge, 'image-too-large', `撮った1枚は ${SCREEN_MAX_BYTES} バイトまでにしてください`)
  }

  const image = await request.arrayBuffer()
  if (image.byteLength === 0) {
    throw new HttpError(STATUS.badRequest, 'empty-image', '本文が空です。撮った画像をそのまま送ってください')
  }
  if (image.byteLength > SCREEN_MAX_BYTES) {
    throw new HttpError(STATUS.payloadTooLarge, 'image-too-large', `撮った1枚は ${SCREEN_MAX_BYTES} バイトまでにしてください`)
  }

  // 上げる前に配信中かを見る。上げてから捨てると、配信前の準備画面まで Gyazo に残ってしまう
  if (!(await isStreaming(env.DB, now))) return Response.json({ recorded: false, imageId: null })

  const accessToken = env.GYAZO_ACCESS_TOKEN
  if (!accessToken) {
    throw new HttpError(
      STATUS.internalServerError,
      'gyazo-token-missing',
      'Gyazo のアクセストークン（GYAZO_ACCESS_TOKEN）が設定されていません。画面の取り込みを使うには設定してください',
    )
  }

  const extension = contentType === 'image/png' ? 'png' : 'jpg'
  const { collectionId } = await loadScreenSettings(env.STORE)
  const gyazo = createGyazoClient({ accessToken, fetch: context.fetch })
  const { imageId } = await gyazo.upload(new Blob([image], { type: contentType }), `screen.${extension}`, { collectionId })

  const recorded = await recordScreenCapture(env.DB, imageId, now)
  return Response.json({ recorded, imageId })
}

/**
 * GET /api/overlay/side-super: いま出すサイドスーパーの文言を返す。
 *
 * OBSのブラウザソースに置いたオーバーレイ（side-super/index.html）が定期的に読みに来る。
 * 文言は cron（worker/collect.ts）が5分おきに作って貯めてあるものをそのまま返すだけで、ここでLLMは呼ばない。
 *
 * 配信していない・まだ作っていないときは失敗にせず、空の行を返す（オーバーレイは何も映さない）。
 * 配信の前後にOBSを開いたままにするのが普通の使い方なので、文言が無いことは失敗ではない
 * （文字起こしの受け口が配信外の発話を捨てるのを失敗にしないのと同じ考え方）。
 */
export const getSideSuper = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const sideSuper = await readCurrentSideSuper(context.env.DB, context.now)
  return Response.json({ lines: sideSuper?.lines ?? [], updatedAt: sideSuper?.updatedAt ?? null })
}

/**
 * GET /api/overlay/speech: チャットの読み上げの設定を返す。
 *
 * OBSのブラウザソースに置いた読み上げのページ（speech/reader/）が、起動のときと、その後は定期的に読みに来る
 * （サイドスーパーと同じポーリング。押し出しを使うほどの即時性は要らない）。未保存なら既定の設定が返るので、
 * 何も設定していない配信者でも読み上げは動く。
 *
 * 注意: ホストとポートは読み上げのページが起動のときにしか使わない（つなぎ先が変わるので、つなぎ直しが要る）。
 * それ以外の項目は、読みに来るたびに次の1件から効く。
 */
export const getSpeech = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return Response.json(await loadSpeechSettings(context.env.STORE))
}

/**
 * GET /api/overlay/focus: いま取り上げている注目コメント（アイコン・名前・本文）を返す。
 *
 * 合成ページの素材「注目コメント」が定期的に読みに来る（サイドスーパーと同じポーリング。押し出しを使う
 * ほどの即時性は要らない）。取り上げていなければ target は null で、合成ページは何も映さない。
 */
export const getFocus = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return Response.json({ target: await loadFocusTarget(context.env.STORE) })
}

/**
 * GET /api/overlay/layout: 合成オーバーレイの構成（どのオーバーレイにどの素材をどこへ置くか）を返す。
 *
 * OBSのブラウザソースに置いた合成ページ（overlay/stage/index.html）が起動のときに読む。オーバーレイの絞り込み
 * （?overlay=）はページ側が行うので、ここは保存されている構成をそのまま返す。
 *
 * 注意: 素材のパラメータはクエリ文字列のまま返す。解析するのはページ側（src/core/params.ts）で、
 * Worker は素材のスキーマを知らない。
 */
export const getLayout = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  return Response.json(await loadOverlayLayout(context.env.STORE))
}
