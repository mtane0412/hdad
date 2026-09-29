/**
 * コメントビューアーの設定（comment-config.ts）のテスト
 *
 * 配信中に切り替える設定なので URL には入れず、KV に置く。ここで確かめるのは次の点である。
 * - 未保存なら既定の設定（しばらく未読の発言を目立たせる）を返すこと
 * - 画面から送られた設定を検証して保存し、読み直せること
 * - 形の違う設定は、問題点をすべて集めてから拒むこと
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { DEFAULT_COMMENT_SETTINGS, loadCommentSettings, parseCommentSettings, saveCommentSettings } from './comment-config'
import { createFakeStore } from './fake-store'

describe('loadCommentSettings', () => {
  it('未保存なら、しばらく未読の発言を目立たせる設定を返す（反応し忘れに気づくための機能なので、最初から効かせる）', async () => {
    expect(await loadCommentSettings(createFakeStore())).toEqual({ highlightUnread: true })
    expect(DEFAULT_COMMENT_SETTINGS).toEqual({ highlightUnread: true })
  })

  it('保存した設定を読み直せる', async () => {
    const store = createFakeStore()

    await saveCommentSettings(store, { highlightUnread: false })

    expect(await loadCommentSettings(store)).toEqual({ highlightUnread: false })
  })
})

describe('parseCommentSettings', () => {
  it('正しい形の設定を、読めた項目だけの形にして返す', () => {
    // 画面が余計な項目を付けてきても、保存するのは知っている項目だけ
    expect(parseCommentSettings({ highlightUnread: false, 余計な項目: 'たなか' })).toEqual({ highlightUnread: false })
  })

  it('オブジェクトでなければ拒む', () => {
    expect(() => parseCommentSettings('目立たせる')).toThrow(ConfigError)
  })

  it('highlightUnread が真偽値でなければ、項目名の付いた問題点で拒む', () => {
    try {
      parseCommentSettings({ highlightUnread: 'はい' })
      expect.unreachable('拒まれるはず')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).problems).toEqual(['highlightUnread: true か false で指定してください'])
    }
  })
})
