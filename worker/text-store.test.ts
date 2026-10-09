/**
 * テキストの読み書き（text-store.ts）のテスト
 *
 * migrations/ のSQLをそのまま適用したメモリ上のSQLite（fake-database.ts）で、次の点を確かめる。
 * - 追加したテキストに新しいIDが振られ、一覧は追加した順に並ぶこと
 * - 持てる数に達していたら、件数の確認と追加を1つの文で行って追加せず null を返すこと（並んだ追加で上限を超えないため）
 * - 書き換えは名前・本文・書き換えた時刻を差し替え、無いIDなら null を返すこと
 * - 同じ名前は、検証のあとで別の窓が先に書いた場合でも、表の制約で拒んで問題点にすること
 * - 自動のテキストは本文を空で追加し、自動へ切り替えても本文と書いた人は変えないこと（本文は LLM が書くため。issue #295）
 * - 手動で保存したときは、本文が変わったときだけ「手で書いた」にすること（LLM の文をそのまま残したなら、人が書いたことにしない）
 * - LLM の本文は、読んだあとに配信者が書き換えていない自動のテキストにだけ書くこと（人が書いた文を機械が黙って上書きしない）
 * - 消したテキストは一覧から消え、消したIDは次に追加したテキストに使い回されないこと
 *   （素材のパラメータが消えたテキストのIDを指したまま、別のテキストを映してしまわないため）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { createFakeDatabase } from './fake-database'
import { MAX_TEXT_COUNT, type TextEntry, type TextInput } from './text'
import { deleteText, insertText, readTexts, saveGeneratedText, updateText } from './text-store'

const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const LATER = Date.parse('2026-10-08T12:30:00.000Z')

/** 手で書くテキストの、指示文を持たない入力 */
const manual = (name: string, body: string): TextInput => ({ name, mode: 'manual', body, instruction: '' })

/** 自動で書き換えるテキストの入力 */
const auto = (name: string, instruction: string): TextInput => ({ name, mode: 'auto', instruction })

let db: ReturnType<typeof createFakeDatabase>

/** テキストを追加し、追加したものを返す（上限に達して追加できなければテストを失敗させる） */
const addText = async (...args: Parameters<typeof insertText>): Promise<TextEntry> => {
  const text = await insertText(...args)
  if (text === null) throw new Error('テキストを追加できませんでした（持てる数に達しています）')
  return text
}

beforeEach(() => {
  db = createFakeDatabase()
})

describe('insertText・readTexts', () => {
  it('追加したテキストにIDを振り、一覧は追加した順に並べる', async () => {
    const goal = await addText(db, manual('目標', 'ログイン画面を作り終える'), NOW)
    const doing = await addText(db, manual('今やってること', 'テストを書いている'), NOW)

    expect(goal).toEqual({
      id: goal.id,
      name: '目標',
      body: 'ログイン画面を作り終える',
      mode: 'manual',
      instruction: '',
      writtenBy: 'human',
      updatedAt: '2026-10-08T12:00:00.000Z',
    })
    expect(doing.id).not.toBe(goal.id)
    expect(await readTexts(db)).toEqual([goal, doing])
  })

  it('持てる数に達していたら追加せず、null を返す', async () => {
    for (let index = 0; index < MAX_TEXT_COUNT; index += 1) await insertText(db, manual(`メモ${index + 1}`, ''), NOW)

    expect(await insertText(db, manual('目標', ''), LATER)).toBeNull()
    expect(await readTexts(db)).toHaveLength(MAX_TEXT_COUNT)
  })

  it('テキストが無ければ空の一覧を返す', async () => {
    expect(await readTexts(db)).toEqual([])
  })
})

describe('updateText', () => {
  it('名前と本文と書き換えた時刻を差し替える', async () => {
    const goal = await addText(db, manual('目標', 'ログイン画面を作り終える'), NOW)

    const updated = await updateText(db, goal.id, manual('今日の目標', 'ログイン画面をデプロイする'), LATER)

    expect(updated).toEqual({ ...goal, name: '今日の目標', body: 'ログイン画面をデプロイする', updatedAt: '2026-10-08T12:30:00.000Z' })
    expect(await readTexts(db)).toEqual([updated])
  })

  it('無いIDなら null を返す', async () => {
    expect(await updateText(db, 999, manual('目標', ''), LATER)).toBeNull()
  })
})

describe('名前の重なり（表の制約）', () => {
  it('追加で同じ名前になったら、名前の問題点として拒む', async () => {
    await insertText(db, manual('目標', ''), NOW)

    await expect(insertText(db, manual('目標', '別の目標'), LATER)).rejects.toThrow(ConfigError)
    await expect(insertText(db, manual('目標', '別の目標'), LATER)).rejects.toMatchObject({ problems: ['name: 「目標」という名前のテキストはもうあります'] })
  })

  it('書き換えで同じ名前になったら、名前の問題点として拒む', async () => {
    await insertText(db, manual('目標', ''), NOW)
    const doing = await addText(db, manual('今やってること', ''), NOW)

    await expect(updateText(db, doing.id, manual('目標', ''), LATER)).rejects.toMatchObject({ problems: ['name: 「目標」という名前のテキストはもうあります'] })
  })
})

describe('deleteText', () => {
  it('消したテキストは一覧から消え、消したなら true を返す', async () => {
    const goal = await addText(db, manual('目標', 'ログイン画面を作り終える'), NOW)
    const doing = await addText(db, manual('今やってること', 'テストを書いている'), NOW)

    expect(await deleteText(db, goal.id)).toBe(true)
    expect(await readTexts(db)).toEqual([doing])
  })

  it('無いIDなら false を返す', async () => {
    expect(await deleteText(db, 999)).toBe(false)
  })

  it('消したIDは、次に追加したテキストに使い回さない', async () => {
    await insertText(db, manual('目標', ''), NOW)
    const last = await addText(db, manual('今やってること', ''), NOW)
    await deleteText(db, last.id)

    const added = await addText(db, manual('次にやること', ''), LATER)

    expect(added.id).toBeGreaterThan(last.id)
  })
})

describe('手動・自動の切り替え', () => {
  it('自動のテキストは本文を空で追加し、指示文を持つ', async () => {
    const doing = await addText(db, auto('今やってること', 'いまやっている作業を20字で'), NOW)

    expect(doing).toMatchObject({ body: '', mode: 'auto', instruction: 'いまやっている作業を20字で', writtenBy: 'human' })
  })

  it('自動へ切り替えても、本文と書いた人はそのまま残す', async () => {
    const doing = await addText(db, manual('今やってること', 'テストを書いている'), NOW)

    const updated = await updateText(db, doing.id, auto('今やってること', 'いまやっている作業を20字で'), LATER)

    expect(updated).toMatchObject({ body: 'テストを書いている', mode: 'auto', instruction: 'いまやっている作業を20字で', writtenBy: 'human' })
  })

  it('LLM が書いた本文を変えずに手動へ戻したなら、書いた人は LLM のまま残す', async () => {
    const doing = await addText(db, auto('今やってること', 'いまやっている作業を20字で'), NOW)
    await saveGeneratedText(db, doing.id, 'ログイン画面のテストを書いている', doing.updatedAt, NOW)

    const updated = await updateText(db, doing.id, { ...manual('今やってること', 'ログイン画面のテストを書いている'), instruction: 'いまやっている作業を20字で' }, LATER)

    expect(updated).toMatchObject({ mode: 'manual', writtenBy: 'llm' })
  })

  it('手動で本文を書き換えたら、書いた人を配信者にする', async () => {
    const doing = await addText(db, auto('今やってること', 'いまやっている作業を20字で'), NOW)
    await saveGeneratedText(db, doing.id, 'ログイン画面のテストを書いている', doing.updatedAt, NOW)

    const updated = await updateText(db, doing.id, manual('今やってること', '休憩中'), LATER)

    expect(updated).toMatchObject({ body: '休憩中', mode: 'manual', writtenBy: 'human' })
  })
})

describe('saveGeneratedText', () => {
  it('自動のテキストに LLM の本文を書き、書いた人と時刻を差し替える', async () => {
    const doing = await addText(db, auto('今やってること', 'いまやっている作業を20字で'), NOW)

    const saved = await saveGeneratedText(db, doing.id, 'ログイン画面のテストを書いている', doing.updatedAt, LATER)

    expect(saved).toEqual({ ...doing, body: 'ログイン画面のテストを書いている', writtenBy: 'llm', updatedAt: '2026-10-08T12:30:00.000Z' })
    expect(await readTexts(db)).toEqual([saved])
  })

  it('読んだあとに配信者が書き換えていたら書かずに null を返す', async () => {
    const doing = await addText(db, auto('今やってること', 'いまやっている作業を20字で'), NOW)
    // LLM が本文を作っているあいだに、配信者が指示文を書き換えた
    const edited = await updateText(db, doing.id, auto('今やってること', 'いまの気分を一言で'), LATER)

    expect(await saveGeneratedText(db, doing.id, 'ログイン画面のテストを書いている', doing.updatedAt, LATER + 1)).toBeNull()
    expect(await readTexts(db)).toEqual([edited])
  })

  it('手動のテキストには書かずに null を返す', async () => {
    const goal = await addText(db, manual('目標', 'ログイン画面を作り終える'), NOW)

    expect(await saveGeneratedText(db, goal.id, '勝手に書いた目標', goal.updatedAt, LATER)).toBeNull()
    expect(await readTexts(db)).toEqual([goal])
  })
})
