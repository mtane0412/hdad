/**
 * 拡張のIDの固定のテスト
 *
 * Worker（worker/tab-routes.ts）は、送り手としてつないできた接続の Origin が chrome-extension://<このID> かを確かめる。
 * パッケージ化されていない拡張のIDは、manifest.json に key が無いと読み込んだフォルダの場所で変わってしまうので、
 * 公開鍵（key）を書いて固定してある。key から Chrome と同じ計算でIDを求め、Worker が使うIDと一致することを確かめる
 * （key を書き換えたのにIDを直し忘れると、拡張からの接続がすべて断られるため）。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXTENSION_ID } from './identity'

/** Chrome の計算: 公開鍵（DER）の SHA-256 の先頭16バイトを16進にし、0〜f を a〜p に置き換える */
const extensionIdOf = (base64Key: string): string =>
  createHash('sha256')
    .update(Buffer.from(base64Key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(digit, 16)))

describe('EXTENSION_ID', () => {
  it('manifest.json の key から Chrome が決めるIDと一致する', () => {
    const manifest: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, '../public/manifest.json'), 'utf8'))
    const key = typeof manifest === 'object' && manifest !== null && 'key' in manifest ? manifest.key : undefined

    expect(typeof key).toBe('string')
    expect(extensionIdOf(String(key))).toBe(EXTENSION_ID)
  })
})
