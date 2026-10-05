/**
 * 読み上げのミュートと、さくらのAI Engine での合成の経路
 *
 * - GET・PUT /api/admin/speech/mute: 下部バーからミュートしているかを読み・切り替える（issue #238）。切り替えたら保存し、
 *   読み上げのページへ押し出す（設定の読み直しの30秒を待たずに、その場で黙らせるため）
 * - GET /api/overlay/speech/mute/socket?key=: 読み上げのページがミュートの押し出しを受け取る WebSocket
 * - POST /api/overlay/speech/check?key=: 起動時の確認。保存済みの話者が使えることを、課金されない読み方の問い合わせで確かめる
 * - POST /api/overlay/speech/synthesis?key=: 読み上げ文1件 { text } を合成し、WAV をそのまま返す
 *
 * 読み上げのページはOBSに載せるページなのでログインを持たず、オーバーレイ用キーで守る（設定の読み出しと同じ）。
 *
 * 注意: 合成先にさくらを選んでいなければ（engine が local なら）409 で断り、さくらは呼ばない。オーバーレイ用キーは
 * 配信画面に映りうるので、さくらを選んでいない配信者に課金を起こさないためである。合成の話者と速度も、要求の本文ではなく
 * 保存済みの設定から取る（設定の持ち主を Worker の1か所にするため）。
 * 注意: 読み上げ文の長さは、読み上げのページが作りうる長さ（SPEECH_TEXT_MAX_LENGTH）までに限る（長いものを黙って切り詰めない）。
 */
import { connectSpeechMuteSocket, pushSpeechMute } from './alert-channel'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { overlayKeyTag } from './overlay-key'
import { loadSpeechMuted, loadSpeechSettings, parseSpeechMute, saveSpeechMuted, SPEECH_TEXT_MAX_LENGTH, type SpeechSettings } from './speech-config'
import { createSakuraTts, type SakuraTts } from './speech-sakura'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * キーを確かめ、合成先にさくらを選んでいることと、APIキーがあることを確かめてから、さくらの呼び出しを組み立てる。
 *
 * @throws HttpError さくらを選んでいない（409）・APIキーが無い（400）場合
 */
const prepareSakura = async (context: Context): Promise<{ settings: SpeechSettings; tts: SakuraTts }> => {
  await requireOverlayKey(context)
  const settings = await loadSpeechSettings(context.env.STORE)
  if (settings.engine !== 'sakura') {
    throw new HttpError(
      STATUS.conflict,
      'speech-engine-not-sakura',
      '読み上げの合成先にさくらのAI Engine が選ばれていません。OBSでこのブラウザソースを再読み込みしてください',
    )
  }
  const apiKey = context.env.SAKURA_AI_API_KEY ?? ''
  if (apiKey === '') {
    throw new HttpError(
      STATUS.badRequest,
      'no-api-key',
      '読み上げの合成先にさくらのAI Engine を選んでいますが、WorkerのシークレットSAKURA_AI_API_KEYが設定されていません',
    )
  }
  return { settings, tts: createSakuraTts({ fetch: context.fetch, apiKey }) }
}

/** さくらの失敗を502にする。理由はそのまま返し、読み上げのページの画面とコンソールで見分けられるようにする */
const asBadGateway = (error: unknown): HttpError =>
  new HttpError(STATUS.badGateway, 'speech-synthesis-failed', error instanceof Error ? error.message : String(error))

/** 本文 { text } を読む。読めなければ400にする */
const readSpeechText = async (request: Request): Promise<string> => {
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const text = isRecord(body) && typeof body.text === 'string' ? body.text : ''
  if (text.trim() === '' || text.length > SPEECH_TEXT_MAX_LENGTH) {
    throw new HttpError(STATUS.badRequest, 'invalid-text', `text は${SPEECH_TEXT_MAX_LENGTH}文字までの空でない文字列にしてください`)
  }
  return text
}

/** POST /api/overlay/speech/check?key=: 保存済みの話者がさくらで使えることを確かめ、204を返す */
export const postSpeechCheck = async (context: Context): Promise<Response> => {
  const { settings, tts } = await prepareSakura(context)
  await tts.checkSpeaker(settings.speaker).catch((error: unknown) => {
    throw asBadGateway(error)
  })
  return new Response(null, { status: STATUS.noContent })
}

/** POST /api/overlay/speech/synthesis?key=: 読み上げ文1件を保存済みの話者と速度で合成し、WAV を返す */
export const postSpeechSynthesis = async (context: Context): Promise<Response> => {
  const { settings, tts } = await prepareSakura(context)
  const text = await readSpeechText(context.request)
  const audio = await tts.synthesize(text, { speaker: settings.speaker, speed: settings.speed }).catch((error: unknown) => {
    throw asBadGateway(error)
  })
  // さくらの合成が返すのは WAV（24kHz・モノラル）だけなので、種類はそのまま WAV として渡す
  return new Response(audio.body, { headers: { 'Content-Type': 'audio/wav' } })
}

/** GET /api/admin/speech/mute: 読み上げをミュートしているか。一度も切り替えていなければミュートしていない */
export const getSpeechMute = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json({ muted: await loadSpeechMuted(context.env.STORE) })
}

/**
 * PUT /api/admin/speech/mute: 読み上げのミュート { muted } を保存し、読み上げのページへ押し出す。
 *
 * 先に保存してから押し出す。押し出しを受け取れなかった読み上げのページも、つなぎ直したときと起動のときに保存済みの値を読むためである。
 * 読み上げのページが開いていなくても成功にする（届け先が無いことは失敗ではないため）。
 *
 * @throws ConfigError muted が真偽値でない場合（index.ts が問題点付きの400にする）
 */
export const putSpeechMute = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const mute = parseSpeechMute(body)
  await saveSpeechMuted(context.env.STORE, mute.muted)
  await pushSpeechMute(context.env.ALERTS, mute)
  return Response.json(mute)
}

/**
 * GET /api/overlay/speech/mute/socket?key=: 読み上げのページからのWebSocketの接続を、ミュートを受け取る接続として配送先へ引き渡す。
 */
export const overlaySpeechMuteSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectSpeechMuteSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}
