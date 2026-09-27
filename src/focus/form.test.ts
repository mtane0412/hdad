/**
 * 注目コメントの入力欄の値の変換（form.ts）のテスト
 *
 * 追従する相手は、直近の発言の一覧から選べるようにする。一覧は発言ごとの並びなので、
 * 同じ人が何度も発言していれば同じ人が何度も現れる。選択欄に並べる形へ直す部分を
 * 画面から分けて確かめる（src/admin/form.ts・src/speech/form.ts と同じ扱い）。
 */
import { describe, expect, it } from 'vitest'
import type { PickableMessage } from './api'
import { speakersOf } from './form'

/** 直近の発言1件。選択欄に関わる項目だけを変える */
const 発言 = (login: string, displayName: string, at: string): PickableMessage => ({
  messageId: `${login}-${at}`,
  login,
  displayName,
  text: 'こんばんは！',
  at,
})

describe('speakersOf', () => {
  it('発言した人を、新しく発言した順に並べる', () => {
    const messages = [発言('zatsudan_suki', '雑談好き', '2026-09-27T12:11:00.000Z'), 発言('kowai_hanashi', '怖い話す人', '2026-09-27T12:10:00.000Z')]

    expect(speakersOf(messages)).toEqual([
      { login: 'zatsudan_suki', displayName: '雑談好き' },
      { login: 'kowai_hanashi', displayName: '怖い話す人' },
    ])
  })

  it('同じ人が何度も発言していても、選択欄には1回だけ並べる', () => {
    const messages = [
      発言('kowai_hanashi', '怖い話す人', '2026-09-27T12:12:00.000Z'),
      発言('zatsudan_suki', '雑談好き', '2026-09-27T12:11:00.000Z'),
      発言('kowai_hanashi', '怖い話す人', '2026-09-27T12:10:00.000Z'),
    ]

    expect(speakersOf(messages).map((speaker) => speaker.login)).toEqual(['kowai_hanashi', 'zatsudan_suki'])
  })

  it('同じ人は、いちばん新しい発言の表示名で並べる（名前を変えた人を古い名前で出さない）', () => {
    const messages = [発言('kowai_hanashi', '怖い話す人（改名後）', '2026-09-27T12:12:00.000Z'), 発言('kowai_hanashi', '怖い話す人', '2026-09-27T12:10:00.000Z')]

    expect(speakersOf(messages)).toEqual([{ login: 'kowai_hanashi', displayName: '怖い話す人（改名後）' }])
  })

  it('発言が1件も無ければ、誰も並べない', () => {
    expect(speakersOf([])).toEqual([])
  })
})
