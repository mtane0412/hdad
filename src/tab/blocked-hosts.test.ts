/**
 * 映さないサイトの照合のテスト
 *
 * 次を確かめる。
 * - 登録できるのはホスト名そのもの（小文字・ポートやパスなし）だけである
 * - 映しているページのホスト名は http・https のページからだけ取れる
 * - 登録したホスト名と完全に一致するページだけを映さない（別のサブドメインは映す）
 * - 読めないURLは、映してよいと分からないので映さない側に倒す
 * - Worker の応答から一覧を読み、形が違えばエラーにする
 */
import { describe, expect, it } from 'vitest'
import { hostOfPageUrl, isBlockedUrl, isHostName, parseBlockedHosts } from './blocked-hosts'

describe('isHostName', () => {
  it('ホスト名そのものを受け付ける', () => {
    expect(isHostName('mail.google.com')).toBe(true)
    expect(isHostName('localhost')).toBe(true)
  })

  it('大文字・ポート・パス・ログイン名を含むものや空は受け付けない', () => {
    expect(isHostName('Mail.Google.com')).toBe(false)
    expect(isHostName('example.com:8080')).toBe(false)
    expect(isHostName('example.com/inbox')).toBe(false)
    expect(isHostName('user@example.com')).toBe(false)
    expect(isHostName('https://example.com')).toBe(false)
    expect(isHostName('')).toBe(false)
    expect(isHostName(42)).toBe(false)
  })
})

describe('hostOfPageUrl', () => {
  it('http・https のページからホスト名を取る', () => {
    expect(hostOfPageUrl('https://mail.google.com/mail/u/0/#inbox')).toBe('mail.google.com')
    expect(hostOfPageUrl('http://localhost:5173/overlay/')).toBe('localhost')
  })

  it('ホスト名で登録できないページ（chrome:// など）や読めないURLは null', () => {
    expect(hostOfPageUrl('chrome://settings/')).toBeNull()
    expect(hostOfPageUrl('file:///Users/haishinsha/memo.txt')).toBeNull()
    expect(hostOfPageUrl('URLではない文字列')).toBeNull()
  })
})

describe('isBlockedUrl', () => {
  const hosts = ['mail.google.com', 'bank.example.jp']

  it('登録したホスト名のページは映さない（パスや問い合わせによらない）', () => {
    expect(isBlockedUrl('https://mail.google.com/mail/u/0/#inbox', hosts)).toBe(true)
    expect(isBlockedUrl('http://bank.example.jp/login?next=/accounts', hosts)).toBe(true)
  })

  it('登録していないホスト名のページは映す（同じドメインの別のサブドメインも映す）', () => {
    expect(isBlockedUrl('https://www.google.com/search?q=配信', hosts)).toBe(false)
    expect(isBlockedUrl('https://example.jp/', hosts)).toBe(false)
  })

  it('http・https 以外のページは一覧の対象外なので映す', () => {
    expect(isBlockedUrl('chrome://newtab/', hosts)).toBe(false)
    expect(isBlockedUrl('about:blank', hosts)).toBe(false)
  })

  it('読めないURLは映さない', () => {
    expect(isBlockedUrl('URLではない文字列', hosts)).toBe(true)
  })
})

describe('parseBlockedHosts', () => {
  it('Worker の応答から一覧を読む', () => {
    expect(parseBlockedHosts({ hosts: ['mail.google.com'] })).toEqual(['mail.google.com'])
    expect(parseBlockedHosts({ hosts: [] })).toEqual([])
  })

  it('形が違えばエラーにする（黙って空の一覧にすると、映してはいけないページを映してしまう）', () => {
    expect(() => parseBlockedHosts(null)).toThrow('映さないサイトの一覧の形が想定と違います')
    expect(() => parseBlockedHosts({ hosts: 'mail.google.com' })).toThrow('映さないサイトの一覧の形が想定と違います')
    expect(() => parseBlockedHosts({ hosts: ['Mail.Google.com'] })).toThrow('映さないサイトの一覧の形が想定と違います')
  })
})
