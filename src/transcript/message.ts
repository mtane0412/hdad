/**
 * ゆかりねっとコネクターNEO（ゆかコネNEO）から届いた音声認識の結果の読み取りと、送る対象の選別
 *
 * ゆかコネNEO はPC上にWebSocketサーバーを立て、認識の途中経過も含めて1件ずつ押し出してくる
 * （エンドポイント `/`。公式ドキュメント: https://nmori.github.io/yncneo-Docs/v3.0/tech/tech_api_neo/）。
 * このモジュールは、そこから届いた文字列を Worker へ送る値に変換するところだけを受け持つ。
 * WebSocket も DOM も持たないので、そのままテストできる（chat/message.ts と同じ分け方）。
 *
 * つなぐ先を `/textonly` ではなく `/` にしているのは、`/textonly` が本文だけのプレーンテキストを返し、
 * 重複を防ぐ鍵（MsgID）も取り消し（isDeleted）も読めないためである。
 *
 * 読み取るのは母国語（Text1）だけで、翻訳（Text2〜Text6）は捨てる。あらすじ（issue #65）の材料には要らない。
 *
 * 注意: 読めないデータを既定値へ黙って倒さず、必ずエラーにする（Fail-Fast）。呼び出し側は、その1件を
 * 飛ばしたうえで原因を画面に出す（OBSのブラウザソースではコンソールを見られないため）。
 */

/** ゆかコネNEO から届いた1件を読み解いた結果 */
export type TranscriptUpdate =
  /** 確定した発話。Worker へ送る対象 */
  | { readonly kind: 'spoken'; readonly messageId: string; readonly text: string }
  /** 取り消された発話。すでに送っていれば取り消しを伝える */
  | { readonly kind: 'deleted'; readonly messageId: string }
  /** 送る対象にならない1件（暫定の認識・本文が空の発話） */
  | { readonly kind: 'ignored' }

/** 届いたデータを読み取れなかったことを表すエラー */
export class TranscriptMessageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscriptMessageError'
  }
}

const readRecord = (data: string): Record<string, unknown> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    throw new TranscriptMessageError('ゆかコネNEO から届いたデータをJSONとして読み取れませんでした')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TranscriptMessageError('ゆかコネNEO から届いたデータがオブジェクトではありません')
  }
  return parsed as Record<string, unknown>
}

/**
 * 届いた1件を読み解く。
 *
 * @param data WebSocket で届いた文字列（ゆかコネNEO の `/` エンドポイントのJSON）
 * @throws {TranscriptMessageError} JSONとして読めない・必要な項目が無い・項目の型が違う場合
 */
export const readTranscriptMessage = (data: string): TranscriptUpdate => {
  const record = readRecord(data)

  const messageId = record.MsgID
  if (typeof messageId !== 'string' || messageId === '') {
    throw new TranscriptMessageError('ゆかコネNEO から届いたデータに MsgID がありません（重複を防ぐ鍵に使うため必須です）')
  }

  const deleted = record.isDeleted
  if (typeof deleted !== 'boolean') {
    throw new TranscriptMessageError(`ゆかコネNEO から届いたデータの isDeleted が真偽値ではありません（MsgID: ${messageId}）`)
  }
  // 取り消しは確定より先に見る。暫定のまま取り消された発話も、送っていなければ何もしないだけで済む
  if (deleted) return { kind: 'deleted', messageId }

  const fixed = record.TextFixed
  if (typeof fixed !== 'boolean') {
    throw new TranscriptMessageError(`ゆかコネNEO から届いたデータの TextFixed が真偽値ではありません（MsgID: ${messageId}）`)
  }

  const text = record.Text1
  if (typeof text !== 'string') {
    throw new TranscriptMessageError(`ゆかコネNEO から届いたデータの Text1 が文字列ではありません（MsgID: ${messageId}）`)
  }

  // 暫定の認識は何度も書き換わるので送らない
  if (!fixed) return { kind: 'ignored' }

  const trimmed = text.trim()
  return trimmed === '' ? { kind: 'ignored' } : { kind: 'spoken', messageId, text: trimmed }
}

/**
 * 送る対象を選ぶために覚えておくもの。
 *
 * ゆかコネNEO は確定したあとの1件も、表示の残り時間（KeepTime）を減らしながら繰り返し押し出してくる。
 * そのまま送ると同じ発話を何度も送ることになるので、送ったメッセージIDを覚えて二度目からは送らない。
 * Worker 側でも主キーで弾くが（migrations の transcripts.message_id）、無駄な呼び出しをそもそも出さない。
 *
 * 注意: 取り消したメッセージIDも覚えたままにする。忘れると、取り消しのあとに届き直した同じ1件を送り直してしまう。
 * 注意: 覚える件数は配信中に増え続けるが、確定文は1分に数件なので、長い配信でも数百件にとどまる。
 */
export interface TranscriptState {
  /** すでに送ったか、送ったうえで取り消したメッセージIDの集合 */
  readonly handled: ReadonlySet<string>
}

/** 何も受け取っていない状態 */
export const EMPTY_TRANSCRIPT_STATE: TranscriptState = { handled: new Set() }

/** 読み解いた1件に対して、Worker へ向けて実際に行うこと */
export type TranscriptAction =
  /** この発話を送る */
  | { readonly kind: 'send'; readonly messageId: string; readonly text: string }
  /** 送り済みの発話の取り消しを伝える */
  | { readonly kind: 'remove'; readonly messageId: string }

/**
 * 読み解いた1件を状態に取り込み、行うことを決める。
 *
 * @returns 取り込んだあとの状態と、行うこと（何もしないなら null）
 */
export const nextTranscriptState = (
  state: TranscriptState,
  update: TranscriptUpdate,
): { readonly state: TranscriptState; readonly action: TranscriptAction | null } => {
  if (update.kind === 'ignored') return { state, action: null }

  if (update.kind === 'deleted') {
    // 送っていない発話（暫定のまま消えたもの）の取り消しは、伝える相手に記録が無いので何もしない
    if (!state.handled.has(update.messageId)) return { state, action: null }
    return { state, action: { kind: 'remove', messageId: update.messageId } }
  }

  if (state.handled.has(update.messageId)) return { state, action: null }
  const handled = new Set(state.handled)
  handled.add(update.messageId)
  return { state: { handled }, action: { kind: 'send', messageId: update.messageId, text: update.text } }
}
