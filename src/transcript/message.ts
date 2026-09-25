/**
 * ゆかりねっとコネクターNEO（ゆかコネNEO）から届いた音声認識の結果の読み取りと、送る対象の選別
 *
 * ゆかコネNEO はPC上にWebSocketサーバーを立て、認識の途中経過も含めて1件ずつ押し出してくる
 * （エンドポイント `/`。公式ドキュメント: https://nmori.github.io/yncneo-Docs/v3.0/tech/tech_api_neo/）。
 * このモジュールは、そこから届いた文字列を Worker へ送る値に変換するところだけを受け持つ。
 * WebSocket も DOM も持たないので、そのままテストできる（chat/message.ts と同じ分け方）。
 *
 * つなぐ先を `/textonly` ではなく `/` にしているのは、`/textonly` が本文だけのプレーンテキストを返し、
 * 重複を防ぐ鍵（MsgID）が読めないためである。
 *
 * 注意: `isDeleted` が真の1件は Worker へ何も伝えない。公式ドキュメントに「実際に消えるタイミングは、
 * isDeleted が true の別のデータで通知されます」とあるとおり、これは表示時間（KeepTime）が尽きて字幕が
 * 消えるときにも届く通常の知らせであり、編集者による取り消しとは区別できない。取り消しとして扱うと、
 * 記録した発話が数秒後にすべて消えてしまい、あらすじ・サイドスーパーの材料が残らない。
 * まれな編集者の取り消しが材料に残るほうを受け入れる（材料は cron が1日で消す一時的な記録である）。
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
  /** 送る対象にならない1件（暫定の認識・本文が空の発話・表示を消す知らせ） */
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
  // 表示を消す知らせは確定より先に見る。本文や TextFixed を伴わないことがあるので、読まずに済ませる
  if (deleted) return { kind: 'ignored' }

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
 * 注意: 覚える件数は配信中に増え続けるが、確定文は1分に数件なので、長い配信でも数百件にとどまる。
 */
export interface TranscriptState {
  /** すでに送ったメッセージIDの集合 */
  readonly handled: ReadonlySet<string>
}

/** 何も受け取っていない状態 */
export const EMPTY_TRANSCRIPT_STATE: TranscriptState = { handled: new Set() }

/** 読み解いた1件に対して、Worker へ向けて実際に行うこと */
export interface TranscriptAction {
  readonly kind: 'send'
  readonly messageId: string
  readonly text: string
}

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

  if (state.handled.has(update.messageId)) return { state, action: null }
  const handled = new Set(state.handled)
  handled.add(update.messageId)
  return { state: { handled }, action: { kind: 'send', messageId: update.messageId, text: update.text } }
}

/**
 * 覚えている発話を1件忘れる。
 *
 * 送信に失敗したときに呼ぶ。ゆかコネNEO は確定したあとの1件を、表示の残り時間（KeepTime）が尽きるまで
 * 繰り返し押し出してくるので、忘れておけば次の1件でひとりでに送り直される（やり直しの仕掛けを別に作らずに済む）。
 */
export const forgetTranscript = (state: TranscriptState, messageId: string): TranscriptState => {
  if (!state.handled.has(messageId)) return state
  const handled = new Set(state.handled)
  handled.delete(messageId)
  return { handled }
}
