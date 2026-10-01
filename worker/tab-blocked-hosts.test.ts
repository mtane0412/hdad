/**
 * 映さないサイトの一覧の保存（KV）のテスト
 *
 * 次を確かめる。
 * - 未保存なら空の一覧を返す
 * - 登録したホスト名が一覧に加わり、同じホスト名を二度登録しても重ならない
 * - ホスト名でないもの（大文字・パス付き・URL）は保存せずに拒む
 * - 消したホスト名が一覧から外れ、無いホスト名を消してもエラーにならない
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { createFakeStore } from './fake-store'
import { addBlockedHost, loadBlockedHosts, removeBlockedHost } from './tab-blocked-hosts'

describe('映さないサイトの一覧', () => {
  it('未保存なら空の一覧を返す', async () => {
    expect(await loadBlockedHosts(createFakeStore())).toEqual([])
  })

  it('登録したホスト名が一覧に加わる（同じホスト名は重ならない）', async () => {
    const store = createFakeStore()

    await addBlockedHost(store, 'mail.google.com')
    await addBlockedHost(store, 'bank.example.jp')
    const hosts = await addBlockedHost(store, 'mail.google.com')

    expect(hosts).toEqual(['mail.google.com', 'bank.example.jp'])
    expect(await loadBlockedHosts(store)).toEqual(['mail.google.com', 'bank.example.jp'])
  })

  it('ホスト名でないものは保存せずに拒む', async () => {
    const store = createFakeStore()

    for (const input of ['Mail.Google.com', 'mail.google.com/mail', 'https://mail.google.com', '', 42]) {
      await expect(addBlockedHost(store, input)).rejects.toBeInstanceOf(ConfigError)
    }
    expect(await loadBlockedHosts(store)).toEqual([])
  })

  it('消したホスト名が一覧から外れる（無いホスト名を消してもエラーにしない）', async () => {
    const store = createFakeStore()
    await addBlockedHost(store, 'mail.google.com')
    await addBlockedHost(store, 'bank.example.jp')

    expect(await removeBlockedHost(store, 'mail.google.com')).toEqual(['bank.example.jp'])
    expect(await removeBlockedHost(store, 'never-registered.example.com')).toEqual(['bank.example.jp'])
  })
})
