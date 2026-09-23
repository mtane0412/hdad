/**
 * テスト用のLLMの代役
 *
 * Workers AI のバインディング（Env.AI）の代わりに、決められた応答を返す。Worker のテストだけが使う
 * （プロダクションコードからは参照しない）。渡された引数を控えるので、材料が漏れていないかも確かめられる。
 */
import type { TextGenerator } from './ai-chat'

interface 代役の条件 {
  /** 返す文面。省略すると当たり障りのない1文を返す */
  response?: string
  /** true なら呼ばれたときに失敗する（無料枠を使い切った場合などの再現） */
  失敗する?: boolean
}

/** 呼び出しの記録を添えたLLMの代役を作る */
export const createFakeAi = ({ response = 'こんばんは！来てくれてありがとうございます', 失敗する = false }: 代役の条件 = {}): TextGenerator & {
  呼び出し: { model: string; input: Record<string, unknown> }[]
} => {
  const 呼び出し: { model: string; input: Record<string, unknown> }[] = []
  return {
    呼び出し,
    run: (model, input) => {
      呼び出し.push({ model, input })
      if (失敗する) return Promise.reject(new Error('Workers AI の無料枠を使い切りました'))
      return Promise.resolve({ response })
    },
  }
}
