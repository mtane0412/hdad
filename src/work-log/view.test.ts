// @vitest-environment jsdom
/**
 * 作業ログの表示（view.ts）のテスト
 *
 * 配信画面に出しっぱなしにするものなので、次の3点を確かめる。
 * - 機械（LLM）が作った章の見出しと、実際に起きた出来事（コミット・マージ）を、種類の印で見分けられること（方針11）
 * - 行が増えても、すでに映している行の要素は作り直さないこと（作り直すと出現のアニメーションが全行で走る）
 * - 行が無いあいだは何も映さないこと（OBSでは透過の枠だけが残るため）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkLogEntry } from './entry'
import { createWorkLogView } from './view'

const commit: WorkLogEntry = { id: 'github:delivery-1', kind: 'commit', at: '2026-10-03T12:10:00.000Z', text: '署名の確認を足す' }
const chapter: WorkLogEntry = { id: 'chapter:2026-10-03T12:00:00.000Z', kind: 'chapter', at: '2026-10-03T12:00:00.000Z', text: 'Webhookの署名を確かめる' }
const merge: WorkLogEntry = { id: 'github:delivery-2', kind: 'merge', at: '2026-10-03T12:40:00.000Z', text: '#212 GitHub の Webhook を受ける' }

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = ''
  root = document.createElement('div')
  document.body.append(root)
})

/** 映している行を「印｜本文」の形で上から並べる */
const shownLines = (): string[] =>
  [...root.querySelectorAll('.work-log-entry')].map(
    (line) => `${line.querySelector('.work-log-mark')?.textContent ?? ''}｜${line.querySelector('.work-log-text')?.textContent ?? ''}`,
  )

describe('createWorkLogView', () => {
  it('渡された順に1行ずつ、種類の印と本文を出す（章には機械が作ったと分かる印を付ける）', () => {
    createWorkLogView(root).setEntries([merge, commit, chapter])

    expect(shownLines()).toEqual(['マージ｜#212 GitHub の Webhook を受ける', 'コミット｜署名の確認を足す', 'AIのまとめ｜Webhookの署名を確かめる'])
    expect([...root.querySelectorAll<HTMLElement>('.work-log-entry')].map((line) => line.dataset.kind)).toEqual(['merge', 'commit', 'chapter'])
  })

  it('時刻を datetime 付きの time 要素で出す', () => {
    createWorkLogView(root).setEntries([merge])

    expect(root.querySelector('time')?.getAttribute('datetime')).toBe(merge.at)
  })

  it('行が増えても、すでに映している行の要素はそのまま使う', () => {
    const view = createWorkLogView(root)
    view.setEntries([commit])
    const shownCommit = root.querySelector('.work-log-entry')

    view.setEntries([merge, commit])

    expect(root.querySelectorAll('.work-log-entry')[1]).toBe(shownCommit)
  })

  it('行が無いあいだは何も映さない', () => {
    const view = createWorkLogView(root)
    view.setEntries([commit])
    view.setEntries([])

    expect(root.querySelectorAll('.work-log-entry')).toHaveLength(0)
  })
})
