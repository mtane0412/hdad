/**
 * 管理画面のセッション（session.ts）のテスト
 *
 * セッションは署名付きの文字列としてクッキーに入れる。改ざん・期限切れ・別の秘密鍵による署名を
 * 受け付けないことが重要（受け付けると、配信者以外が管理用APIを使えてしまう）。
 */
import { describe, expect, it } from 'vitest'
import { SESSION_TTL_SECONDS, createSessionToken, verifySessionToken } from './session'

const 秘密鍵 = 'テスト用のセッション秘密鍵'
const 発行時刻 = Date.UTC(2026, 8, 21, 12, 0, 0)

describe('セッショントークン', () => {
  it('発行したトークンを検証すると、ユーザーIDが取り出せる', async () => {
    const token = await createSessionToken('12345', 秘密鍵, 発行時刻)
    expect(await verifySessionToken(token, 秘密鍵, 発行時刻 + 1000)).toBe('12345')
  })

  it('期限を過ぎたトークンは無効になる', async () => {
    const token = await createSessionToken('12345', 秘密鍵, 発行時刻)
    const 期限切れの時刻 = 発行時刻 + SESSION_TTL_SECONDS * 1000 + 1000
    expect(await verifySessionToken(token, 秘密鍵, 期限切れの時刻)).toBeNull()
  })

  it('ユーザーIDを書き換えたトークンは無効になる', async () => {
    const token = await createSessionToken('12345', 秘密鍵, 発行時刻)
    const 改ざんしたトークン = token.replace('12345', '99999')
    expect(await verifySessionToken(改ざんしたトークン, 秘密鍵, 発行時刻)).toBeNull()
  })

  it('別の秘密鍵で署名したトークンは無効になる', async () => {
    const token = await createSessionToken('12345', '別の秘密鍵', 発行時刻)
    expect(await verifySessionToken(token, 秘密鍵, 発行時刻)).toBeNull()
  })

  it('形式が崩れた文字列は無効になる', async () => {
    expect(await verifySessionToken('', 秘密鍵, 発行時刻)).toBeNull()
    expect(await verifySessionToken('12345', 秘密鍵, 発行時刻)).toBeNull()
    expect(await verifySessionToken('12345.期限ではない.署名', 秘密鍵, 発行時刻)).toBeNull()
  })
})
