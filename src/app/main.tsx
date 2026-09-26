/**
 * ページUI（ダッシュボード・ギャラリー・管理画面）の起動
 *
 * index.html の #root にアプリの枠を描く。どのページUIのパスでもこの index.html が返される。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createAdminApi } from '@/admin/api'
import { createBotApi } from '@/bot/api'
import { createLlmApi } from '@/llm/api'
import { createSpeechApi } from '@/speech/api'
import { createStatsApi } from '@/stats/api'
import { createViewerApi } from '@/viewers/api'
import { App } from './app'
import './app.css'

const root = document.getElementById('root')
if (!root) throw new Error('index.html に #root がありません')

// fetch をそのまま渡すと this が外れて Illegal invocation になるブラウザがあるので、包んで渡す
const callWorker: typeof fetch = (input, init) => fetch(input, init)
const api = createAdminApi(callWorker)
const statsApi = createStatsApi(callWorker)
const botApi = createBotApi(callWorker)
const viewerApi = createViewerApi(callWorker)
const speechApi = createSpeechApi(callWorker)
const llmApi = createLlmApi(callWorker)

createRoot(root).render(
  <StrictMode>
    <App api={api} statsApi={statsApi} botApi={botApi} viewerApi={viewerApi} speechApi={speechApi} llmApi={llmApi} />
  </StrictMode>,
)
