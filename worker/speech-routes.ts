/**
 * さくらのAI Engine での合成の経路（OBSに置いた読み上げのページから呼ばれる）
 *
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
import { HttpError, STATUS, requireOverlayKey, type Context } from './http'
import { loadSpeechSettings, SPEECH_TEXT_MAX_LENGTH, type SpeechSettings } from './speech-config'
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
