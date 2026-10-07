/**
 * WebMCP（document.modelContext）へのツールの登録
 *
 * ページUIの操作を、ブラウザのエージェントが呼べるツールとして登録する。登録の解除は WebMCP の仕様どおり
 * AbortSignal で行う（unregisterTool は無い）。すべてのツールを同じ signal で登録するので、アプリの枠が
 * 消える（ログアウトする）ときに1回止めれば、まとめて消える。
 *
 * 注意: modelContext が無いのは「ブラウザが WebMCP に対応していない」（Chrome でも flag か origin trial が要る）
 * ということで、失敗ではない。そのときは何も登録せず 'unsupported' を返す。一方、対応しているのに登録を
 * 断られたときは黙らずに投げる（エージェントから呼べないことに気づけないため）。
 */
import type { WebMCP } from 'webmcp-types'

/** 登録の結果。WebMCP に対応していないブラウザなら 'unsupported' */
export type RegisterResult = 'registered' | 'unsupported'

/** 登録に使う modelContext の部分（テストで代役を渡せるよう、registerTool だけを求める） */
export type ToolRegistry = Pick<WebMCP.ModelContext, 'registerTool'>

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * ツールをすべて登録する。
 *
 * @param modelContext ブラウザの document.modelContext（対応していなければ undefined）
 * @param signal 止めると、登録したツールがすべて消える
 * @throws 登録を断られた場合（どのツールかを文面に入れる）
 */
export const registerTools = async (
  modelContext: ToolRegistry | undefined,
  tools: readonly WebMCP.ModelContextTool[],
  signal: AbortSignal,
): Promise<RegisterResult> => {
  if (modelContext === undefined) return 'unsupported'
  for (const tool of tools) {
    try {
      await modelContext.registerTool(tool, { signal })
    } catch (error) {
      throw new Error(`WebMCP にツール ${tool.name} を登録できませんでした: ${errorMessage(error)}`, { cause: error })
    }
  }
  return 'registered'
}
