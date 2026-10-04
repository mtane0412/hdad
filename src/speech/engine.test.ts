/**
 * 合成先の見分け（engine.ts）のテスト
 *
 * 読み上げのページは、合成先とつなぎ先を起動のときにしか使えない。設定を読み直したときに
 * 「OBSの再読み込みが要るほど変わったか」を、つなぎ先の比較で見分ける。
 */
import { describe, expect, it } from 'vitest'
import { speechEndpointOf } from './engine'

describe('speechEndpointOf', () => {
  it('ローカルなら、ポートを変えるとつなぎ先が変わる', () => {
    expect(speechEndpointOf({ engine: 'local', host: 'localhost', port: 50021 })).not.toBe(
      speechEndpointOf({ engine: 'local', host: 'localhost', port: 50022 }),
    )
  })

  it('ローカルなら、ホストを変えるとつなぎ先が変わる', () => {
    expect(speechEndpointOf({ engine: 'local', host: 'localhost', port: 50021 })).not.toBe(
      speechEndpointOf({ engine: 'local', host: '127.0.0.1', port: 50021 }),
    )
  })

  it('さくらなら、ホストとポートを変えてもつなぎ先は変わらない（さくらはホストとポートを使わないため）', () => {
    expect(speechEndpointOf({ engine: 'sakura', host: 'localhost', port: 50021 })).toBe(
      speechEndpointOf({ engine: 'sakura', host: '127.0.0.1', port: 50022 }),
    )
  })

  it('合成先を変えたら、つなぎ先も変わる（OBSの再読み込みが要る）', () => {
    expect(speechEndpointOf({ engine: 'sakura', host: 'localhost', port: 50021 })).not.toBe(
      speechEndpointOf({ engine: 'local', host: 'localhost', port: 50021 }),
    )
  })
})
