/**
 * ページUI（トップ）の起動
 *
 * index.html の #root にアプリの枠を描く。Workerの呼び出しには管理画面と同じ api.ts を使う。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createAdminApi } from '@/admin/api'
import { App } from './app'
import './app.css'

const root = document.getElementById('root')
if (!root) throw new Error('index.html に #root がありません')

// fetch をそのまま渡すと this が外れて Illegal invocation になるブラウザがあるので、包んで渡す
const api = createAdminApi((input, init) => fetch(input, init))

createRoot(root).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
)
