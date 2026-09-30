/**
 * obs-websocket のやりとりの読み書き（src/screen/protocol.ts）のテスト
 *
 * 確かめるのは次の4点である。
 * - 認証の応答が obs-websocket の決めた手順（SHA256 を2段、どちらも Base64）で作られること
 * - Hello・Identified・要求への応答を見分けられること
 * - 要求が失敗したときに、その理由を添えたエラーになること（黙って空の画像を返さない）
 * - 撮れた画像（data: のURL）を送れる形（Blob）に直せること
 *
 * 認証の期待値は、obs-websocket の仕様（Base64(SHA256(Base64(SHA256(パスワード + ソルト)) + チャレンジ))）から
 * Node.js の crypto で別に求めたものである（実装を読み写したものではない）。
 */
import { describe, expect, it } from 'vitest'
import { authenticationOf, imageOfDataUrl, readObsMessage } from './protocol'

describe('authenticationOf', () => {
  it('obs-websocket の手順どおりの応答を作る', async () => {
    const response = await authenticationOf(
      'supersecretpassword',
      '82XFG0Vwvv1/2W0CPhFHqBLjNmpVmiHyf2jgXvE9tXY=',
      '+IxH4CnCiqpX1LHSSBMwXcJTqQmFgP2WPtG5DKFm0Ng=',
    )

    expect(response).toBe('hY4oGqUDmbbdTUQAuID/7reTHXLzdQlpDRqPf0p+yKk=')
  })

  it('同じパスワードでも、チャレンジが変われば応答も変わる', async () => {
    const firstResponse = await authenticationOf('パスワード', 'c2FsdA==', 'Y2hhbGxlbmdlMQ==')
    const nextResponse = await authenticationOf('パスワード', 'c2FsdA==', 'Y2hhbGxlbmdlMg==')

    expect(firstResponse).not.toBe(nextResponse)
  })
})

describe('readObsMessage', () => {
  it('Hello を、認証が要るかどうかとともに読む', () => {
    const message = readObsMessage(
      JSON.stringify({
        op: 0,
        d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1, authentication: { challenge: 'チャレンジ', salt: 'ソルト' } },
      }),
    )

    expect(message).toEqual({ type: 'hello', authentication: { challenge: 'チャレンジ', salt: 'ソルト' } })
  })

  it('認証が要らない Hello も読む', () => {
    const message = readObsMessage(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1 } }))

    expect(message).toEqual({ type: 'hello', authentication: null })
  })

  it('Identified を読む', () => {
    expect(readObsMessage(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }))).toEqual({ type: 'identified' })
  })

  it('成功した要求への応答を、要求のIDと中身とともに読む', () => {
    const message = readObsMessage(
      JSON.stringify({
        op: 7,
        d: { requestType: 'GetCurrentProgramScene', requestId: '1', requestStatus: { result: true, code: 100 }, responseData: { sceneName: 'ゲーム' } },
      }),
    )

    expect(message).toEqual({ type: 'response', requestId: '1', data: { sceneName: 'ゲーム' }, error: null })
  })

  it('失敗した要求への応答には、理由を添える', () => {
    const message = readObsMessage(
      JSON.stringify({
        op: 7,
        d: { requestType: 'GetSourceScreenshot', requestId: '2', requestStatus: { result: false, code: 600, comment: '存在しないソースです' } },
      }),
    )

    expect(message).toEqual({
      type: 'response',
      requestId: '2',
      data: null,
      error: 'GetSourceScreenshot が失敗しました（コード 600）: 存在しないソースです',
    })
  })

  it('関心のないもの（イベントなど）は無視できる形で返す', () => {
    expect(readObsMessage(JSON.stringify({ op: 5, d: { eventType: 'CurrentProgramSceneChanged' } }))).toEqual({ type: 'other' })
  })

  it('読めないものはエラーにする（黙って無視しない）', () => {
    expect(() => readObsMessage('JSONではない')).toThrow()
  })
})

describe('imageOfDataUrl', () => {
  it('data: のURLを、送れる形（Blob）に直す', async () => {
    // PNGの先頭8バイトを Base64 にしたもの
    const image = imageOfDataUrl('data:image/png;base64,iVBORw0KGgo=')

    expect(image.type).toBe('image/png')
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
  })

  it('data: のURLでなければエラーにする', () => {
    expect(() => imageOfDataUrl('https://example.com/screen.png')).toThrow()
  })
})
