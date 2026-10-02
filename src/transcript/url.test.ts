/**
 * ゆかコネNEO のポート番号の検証（url.ts）のテスト
 *
 * 裏方をまとめたページのURL（src/backstage/url.ts）が、入力されたポートをこれで確かめる。
 */
import { describe, expect, it } from 'vitest'
import { assertTranscriptPort, DEFAULT_TRANSCRIPT_PORT } from './url'

describe('assertTranscriptPort', () => {
  it('既定のポートと、範囲の両端は通す', () => {
    expect(() => assertTranscriptPort(DEFAULT_TRANSCRIPT_PORT)).not.toThrow()
    expect(() => assertTranscriptPort(1)).not.toThrow()
    expect(() => assertTranscriptPort(65535)).not.toThrow()
  })

  it('数として読めない値は、既定へ黙って戻さずエラーにする', () => {
    expect(() => assertTranscriptPort(Number.NaN)).toThrow(/ポート/)
  })

  it('範囲の外と整数でない値はエラーにする', () => {
    expect(() => assertTranscriptPort(0)).toThrow(/ポート/)
    expect(() => assertTranscriptPort(65536)).toThrow(/ポート/)
    expect(() => assertTranscriptPort(11901.5)).toThrow(/ポート/)
  })
})
