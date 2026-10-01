/**
 * 拡張が信頼する HDAD の置き場所（ビルドのときに HDAD_ORIGINS で渡す）の読み取りのテスト
 *
 * 拡張は、ここで信頼した置き場所の /tab/ にだけストリームIDを渡す（別のサイトの /tab/ に渡すと、
 * そのサイトが映したいタブの映像と音を取り込めてしまうため）。指定が無い・読めないときは、
 * 黙ってどこでも信頼する形に倒さず、ビルドを失敗させる。
 */
import { describe, expect, it } from 'vitest'
import { parseTrustedOrigins } from './origins'

describe('parseTrustedOrigins', () => {
  it('カンマ区切りの置き場所を読む（前後の空白は無視する）', () => {
    expect(parseTrustedOrigins('https://hdad.example.workers.dev, http://localhost:5173')).toEqual([
      'https://hdad.example.workers.dev',
      'http://localhost:5173',
    ])
  })

  it('指定が無ければエラーにする', () => {
    expect(() => parseTrustedOrigins(undefined)).toThrow('HDAD_ORIGINS')
    expect(() => parseTrustedOrigins(' ')).toThrow('HDAD_ORIGINS')
  })

  it('パスまで書かれていたらエラーにする（置き場所は https://ドメイン までにする）', () => {
    expect(() => parseTrustedOrigins('https://hdad.example.workers.dev/tab/')).toThrow('https://hdad.example.workers.dev/tab/')
  })

  it('localhost 以外の http はエラーにする', () => {
    expect(() => parseTrustedOrigins('http://hdad.example.com')).toThrow('http://hdad.example.com')
  })

  it('URL として読めなければエラーにする', () => {
    expect(() => parseTrustedOrigins('hdad.example.workers.dev')).toThrow('hdad.example.workers.dev')
  })
})
