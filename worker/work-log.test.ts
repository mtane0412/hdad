/**
 * 作業ログの1行の組み立て（work-log.ts）のテスト
 *
 * 開発の出来事（コミットの push・PR のマージ）と章を、合成ページの素材「作業ログ」に並べる1行へ直す部分を確かめる。
 * 機械が作った章と実際に起きた出来事を見分けられるよう、種類（kind）が取り違えられないことを特に確かめる。
 */
import { describe, expect, it } from 'vitest'
import { chapterEntryOf, devEventOf } from './work-log'

describe('devEventOf', () => {
  it('コミットの push は、最後のコミットのメッセージの1行目を本文にした「commit」にする', () => {
    expect(
      devEventOf({
        event: 'github.push',
        userName: 'mtane0412',
        userLogin: 'mtane0412',
        repository: 'hdad',
        branch: 'feature/work-log',
        commitMessage: '作業ログの素材を足す',
      }),
    ).toEqual({ kind: 'commit', text: '作業ログの素材を足す' })
  })

  it('PR のマージは、番号とタイトルを本文にした「merge」にする', () => {
    expect(
      devEventOf({
        event: 'github.pull_request.merged',
        userName: 'mtane0412',
        userLogin: 'mtane0412',
        repository: 'hdad',
        title: '今日の作業ログを配信画面に出す',
        number: 213,
      }),
    ).toEqual({ kind: 'merge', text: '#213 今日の作業ログを配信画面に出す' })
  })

  it('開発の出来事でないもの（チャットの発言など）は null にする', () => {
    expect(devEventOf({ event: 'channel.chat.message', userName: '視聴者', userLogin: 'viewer', text: 'こんにちは' })).toBeNull()
  })
})

describe('chapterEntryOf', () => {
  it('章は、区間の始まりを時刻にし、見出しを本文にした「chapter」にする（要約は出さない）', () => {
    expect(
      chapterEntryOf({ startedAt: '2026-10-03T12:00:00.000Z', endedAt: '2026-10-03T12:30:00.000Z', title: 'Webhookの署名を確かめる', summary: '長い要約' }),
    ).toEqual({ id: 'chapter:2026-10-03T12:00:00.000Z', kind: 'chapter', at: '2026-10-03T12:00:00.000Z', text: 'Webhookの署名を確かめる' })
  })
})
