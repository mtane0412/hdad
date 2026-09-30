/**
 * コメントビューアーの設定（comment-config.ts）のテスト
 *
 * 配信中に切り替える設定なので URL には入れず、KV に置く。ここで確かめるのは次の点である。
 * - 未保存なら既定の設定（しばらく未読の発言を目立たせる・発話からの自動の既読はしない）を返すこと
 * - 画面から送られた設定を検証して保存し、読み直せること
 * - 形の違う設定は、問題点をすべて集めてから拒むこと
 * - 保存済みの設定が古い形なら、黙って読み替えずに直し方の分かるエラーにすること
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { DEFAULT_COMMENT_SETTINGS, loadCommentSettings, parseCommentSettings, saveCommentSettings } from './comment-config'
import { createFakeStore } from './fake-store'

describe('loadCommentSettings', () => {
  it('未保存なら、しばらく未読の発言を目立たせ、発話からの自動の既読はしない設定を返す', async () => {
    // 目立たせるのは反応し忘れに気づくための機能なので最初から効かせる。自動の既読は OpenRouter の鍵と残高が要るので、配信者が選んだときだけ効かせる
    expect(await loadCommentSettings(createFakeStore())).toEqual({ highlightUnread: true, judgeWithJev: false })
    expect(DEFAULT_COMMENT_SETTINGS).toEqual({ highlightUnread: true, judgeWithJev: false })
  })

  it('保存した設定を読み直せる', async () => {
    const store = createFakeStore()

    await saveCommentSettings(store, { highlightUnread: false, judgeWithJev: true })

    expect(await loadCommentSettings(store)).toEqual({ highlightUnread: false, judgeWithJev: true })
  })

  it('保存済みの設定が古い形（自動の既読の項目が無い）なら、黙って読み替えずに直し方の分かるエラーにする', async () => {
    const store = createFakeStore()
    await store.put('comment-settings', JSON.stringify({ highlightUnread: false }))

    await expect(loadCommentSettings(store)).rejects.toThrow(/古い形.*comment-settings/s)
  })
})

describe('parseCommentSettings', () => {
  it('正しい形の設定を、読めた項目だけの形にして返す', () => {
    // 画面が余計な項目を付けてきても、保存するのは知っている項目だけ
    expect(parseCommentSettings({ highlightUnread: false, judgeWithJev: true, extraField: 'たなか' })).toEqual({ highlightUnread: false, judgeWithJev: true })
  })

  it('オブジェクトでなければ拒む', () => {
    expect(() => parseCommentSettings('目立たせる')).toThrow(ConfigError)
  })

  it('項目が真偽値でなければ、問題点をすべて集めて項目名付きで拒む', () => {
    try {
      parseCommentSettings({ highlightUnread: 'はい', judgeWithJev: 1 })
      expect.unreachable('拒まれるはず')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).problems).toEqual(['highlightUnread: true か false で指定してください', 'judgeWithJev: true か false で指定してください'])
    }
  })
})
