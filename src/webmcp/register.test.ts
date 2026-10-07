/**
 * WebMCP へのツールの登録（register.ts）のテスト
 *
 * ブラウザの document.modelContext の代わりに、registerTool の呼ばれ方を記録する代役を渡す。
 * 確かめること:
 * - WebMCP に対応していないブラウザ（modelContext が無い）では、何も登録せずに「対応していない」と返す
 * - 対応していれば、すべてのツールを同じ AbortSignal で登録する（ログアウトで止めればまとめて消える）
 * - 登録を断られたら、黙らずにエラーにする
 */
import { describe, expect, it } from 'vitest'
import type { WebMCP } from 'webmcp-types'
import { registerTools } from './register'

/** 登録するツール（中身は呼ばれない） */
const tools: WebMCP.ModelContextTool[] = [
  { name: 'get_bgm', description: 'BGMの状態を読む', inputSchema: { type: 'object', properties: {} }, execute: () => '' },
  { name: 'stop_bgm', description: 'BGMを止める', inputSchema: { type: 'object', properties: {} }, execute: () => '' },
]

/** registerTool だけを持つ代役。登録された名前と signal を記録する */
const fakeModelContext = (rejectName?: string) => {
  const registered: { name: string; signal: AbortSignal | undefined }[] = []
  const modelContext = {
    registerTool: async (tool: WebMCP.ModelContextTool, options?: WebMCP.ModelContextRegisterToolOptions) => {
      if (tool.name === rejectName) throw new Error(`${tool.name} はもう登録されています`)
      registered.push({ name: tool.name, signal: options?.signal })
    },
  }
  return { modelContext, registered }
}

describe('registerTools', () => {
  it('modelContext が無いブラウザでは何も登録せず unsupported を返す', async () => {
    expect(await registerTools(undefined, tools, new AbortController().signal)).toBe('unsupported')
  })

  it('すべてのツールを同じ signal で登録し registered を返す', async () => {
    const { modelContext, registered } = fakeModelContext()
    const controller = new AbortController()
    expect(await registerTools(modelContext, tools, controller.signal)).toBe('registered')
    expect(registered).toEqual([
      { name: 'get_bgm', signal: controller.signal },
      { name: 'stop_bgm', signal: controller.signal },
    ])
  })

  it('登録を断られたらエラーにする', async () => {
    const { modelContext } = fakeModelContext('stop_bgm')
    await expect(registerTools(modelContext, tools, new AbortController().signal)).rejects.toThrow(
      'WebMCP にツール stop_bgm を登録できませんでした: stop_bgm はもう登録されています',
    )
  })
})
