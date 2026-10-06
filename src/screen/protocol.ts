/**
 * obs-websocket（v5）のやりとりの読み書き
 *
 * OBS は動かしているPCの上に WebSocket サーバーを立てる（既定のポートは 4455。ツール > WebSocket サーバー設定）。
 * ここは「届いた1件（要求への応答とイベント）をどう読むか」「認証の応答をどう作るか」「撮れた画像をどう送れる形に直すか」だけを受け持ち、
 * 接続とつなぎ直しは connection.ts に任せる（src/transcript/ と同じ分け方）。
 *
 * 認証は obs-websocket が決めたチャレンジ応答である。パスワードとソルトを SHA256 にかけて Base64 にしたものを
 * 「秘密」とし、それにチャレンジをつないで同じことをもう一度行う。WebCrypto で足りるので、ライブラリは入れない。
 *
 * 注意: 読めないものは黙って無視せずエラーにする（Fail-Fast）。押し込まれたものを読み飛ばすと、
 * 撮れていないことに配信が終わるまで気づけない。
 */

/** このページが話せる obs-websocket のRPCの版。v5 の現行は 1 */
export const OBS_RPC_VERSION = 1

/** obs-websocket のオペコード（https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md） */
const OP = {
  hello: 0,
  identify: 1,
  identified: 2,
  event: 5,
  request: 6,
  requestResponse: 7,
} as const

/** 認証を求められたときに渡される値 */
export interface ObsAuthenticationChallenge {
  readonly challenge: string
  readonly salt: string
}

/** 読み取った1件。関心のないものは 'other' にまとめる */
export type ObsMessage =
  | { readonly type: 'hello'; readonly authentication: ObsAuthenticationChallenge | null }
  | { readonly type: 'identified' }
  | { readonly type: 'response'; readonly requestId: string; readonly data: Record<string, unknown> | null; readonly error: string | null }
  /** OBS の側で起きた出来事（InputMuteStateChanged など）。data は eventData で、無ければ空 */
  | { readonly type: 'event'; readonly eventType: string; readonly data: Record<string, unknown> }
  | { readonly type: 'other' }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** バイト列を Base64 の文字列にする */
const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

/** 文字列を SHA256 にかけ、Base64 にして返す */
const sha256Base64 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return toBase64(new Uint8Array(digest))
}

/**
 * 認証の応答を作る。
 *
 * @param password OBSの WebSocket サーバー設定で決めたパスワード
 * @param salt Hello に添えられてきたソルト
 * @param challenge Hello に添えられてきたチャレンジ
 */
export const authenticationOf = async (password: string, salt: string, challenge: string): Promise<string> =>
  sha256Base64((await sha256Base64(password + salt)) + challenge)

/**
 * 届いた1件を読む。
 *
 * @throws JSONとして読めない、または op を持たない場合
 */
export const readObsMessage = (data: string): ObsMessage => {
  const parsed: unknown = JSON.parse(data)
  if (!isRecord(parsed) || typeof parsed.op !== 'number') {
    throw new Error('OBS から届いたものに op がありません')
  }
  const payload = isRecord(parsed.d) ? parsed.d : {}

  if (parsed.op === OP.hello) {
    const authentication = isRecord(payload.authentication) ? payload.authentication : null
    if (authentication === null) return { type: 'hello', authentication: null }
    const { challenge, salt } = authentication
    if (typeof challenge !== 'string' || typeof salt !== 'string') {
      throw new Error('OBS の Hello の authentication に challenge か salt がありません')
    }
    return { type: 'hello', authentication: { challenge, salt } }
  }

  if (parsed.op === OP.identified) return { type: 'identified' }

  if (parsed.op === OP.requestResponse) {
    const requestId = payload.requestId
    if (typeof requestId !== 'string') throw new Error('OBS の応答に requestId がありません')
    const status = isRecord(payload.requestStatus) ? payload.requestStatus : {}
    if (status.result === true) {
      return { type: 'response', requestId, data: isRecord(payload.responseData) ? payload.responseData : {}, error: null }
    }
    const requestType = typeof payload.requestType === 'string' ? payload.requestType : '要求'
    const comment = typeof status.comment === 'string' ? status.comment : '（理由は添えられていません）'
    return { type: 'response', requestId, data: null, error: `${requestType} が失敗しました（コード ${String(status.code)}）: ${comment}` }
  }

  if (parsed.op === OP.event) {
    const eventType = payload.eventType
    if (typeof eventType !== 'string') throw new Error('OBS のイベントに eventType がありません')
    return { type: 'event', eventType, data: isRecord(payload.eventData) ? payload.eventData : {} }
  }

  return { type: 'other' }
}

/** 名乗り（Identify）を組み立てる。パスワードを使わないときは authentication を載せない */
export const identifyMessage = (authentication: string | null): string =>
  JSON.stringify({ op: OP.identify, d: { rpcVersion: OBS_RPC_VERSION, ...(authentication === null ? {} : { authentication }) } })

/** 要求（Request）を組み立てる */
export const requestMessage = (requestType: string, requestId: string, requestData: Record<string, unknown> = {}): string =>
  JSON.stringify({ op: OP.request, d: { requestType, requestId, requestData } })

/** data: のURLの形。GetSourceScreenshot は "data:image/png;base64,..." の形で画像を返す */
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.+)$/

/**
 * OBS が返した画像（data: のURL）を、Worker へ送れる形（Blob）に直す。
 *
 * @throws data: のURLとして読めない場合
 */
export const imageOfDataUrl = (dataUrl: string): Blob => {
  const matched = DATA_URL_PATTERN.exec(dataUrl)
  if (!matched) throw new Error('OBS が返した画像を data: のURLとして読めませんでした')
  const [, contentType = '', base64 = ''] = matched
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: contentType })
}
