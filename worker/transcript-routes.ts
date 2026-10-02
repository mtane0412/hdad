/**
 * 配信中の文字起こしの受け口
 *
 * 確定した発話を1件受け取り、worker/transcript-store.ts で記録する。送り手はアプリの枠の音声認識
 * （Chrome の Web Speech API。src/transcript/recognizer.ts）で、ログインしたアプリのページから送るので、
 * 配信者のセッションで守る（issue #189）。
 *
 * 配信していなければ記録せず、記録しなかったことを応答で知らせる（送り手が画面に出せるように）。
 * 捨てるのを失敗にしないのは、配信の前後に送り手を動かしたままにしておくのが普通の使い方だからである。
 *
 * 注意: 同じメッセージIDが二度届いても行は増えない（transcripts.message_id が主キー）。
 */
import { HttpError, STATUS, requireAdmin, type Context } from './http'
import { recordTranscript, type Transcript } from './transcript-store'

/**
 * 1件の発話として受け付ける本文の長さの上限（文字数）。
 *
 * 送られてくるのは確定した1文なので、これを超えるのは送り手の誤りか、別のものが
 * 押し込まれているかである。長いものを黙って切り詰めず、拒む（Fail-Fast）。
 */
export const TRANSCRIPT_MAX_LENGTH = 1000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 本文 { messageId, text } を読み、記録する形（前後の空白を落とした本文）にする。読めなければ400にする */
const readTranscript = async (request: Request): Promise<Transcript> => {
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const messageId: unknown = isRecord(body) ? body.messageId : undefined
  if (typeof messageId !== 'string' || messageId === '') {
    throw new HttpError(STATUS.badRequest, 'invalid-message-id', 'messageId は空でない文字列にしてください')
  }
  const text: unknown = isRecord(body) ? body.text : undefined
  if (typeof text !== 'string') {
    throw new HttpError(STATUS.badRequest, 'invalid-text', 'text は空でない文字列にしてください')
  }
  // 空かどうかも長さも、実際に保存する形（前後の空白を落としたもの）で判定する
  const spoken = text.trim()
  if (spoken === '') {
    throw new HttpError(STATUS.badRequest, 'invalid-text', 'text は空でない文字列にしてください')
  }
  if (spoken.length > TRANSCRIPT_MAX_LENGTH) {
    throw new HttpError(STATUS.badRequest, 'text-too-long', `発話は${TRANSCRIPT_MAX_LENGTH}文字までにしてください`)
  }
  return { messageId, text: spoken }
}

/** POST /api/admin/transcripts: アプリのページの音声認識が確定した発話を1件受け取り、記録して { recorded } で答える */
export const postAdminTranscript = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const transcript = await readTranscript(context.request)
  const recorded = await recordTranscript(context.env.DB, transcript, context.now)
  return Response.json({ recorded })
}
