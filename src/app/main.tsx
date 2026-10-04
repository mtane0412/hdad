/**
 * ページUI（ダッシュボード・管理画面）の起動
 *
 * index.html の #root にアプリの枠を描く。どのページUIのパスでもこの index.html が返される。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createAdminApi } from '@/admin/api'
import { createBgmApi } from '@/bgm/api'
import { connectBgmWatch } from '@/bgm/socket'
import { createPomodoroApi } from '@/pomodoro/api'
import { connectPomodoroWatch } from '@/pomodoro/socket'
import { createBotApi } from '@/bot/api'
import { createDrawApi } from '@/draw/api'
import { createCommentApi } from '@/comments/api'
import { createFocusApi } from '@/focus/api'
import { createLlmApi } from '@/llm/api'
import { createOverlayLayoutAdminApi } from '@/overlay/admin-api'
import { createScreenAdminApi } from '@/screen/api'
import { createSpeechApi } from '@/speech/api'
import { createStatsApi } from '@/stats/api'
import { createViewerApi } from '@/viewers/api'
import { createAppTranscriptApi } from '@/transcript/api'
import { browserRecognitionDeps } from '@/transcript/recognition-context'
import { createTranslationApi } from '@/transcript/translation-api'
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
const screenApi = createScreenAdminApi(callWorker)
const focusApi = createFocusApi(callWorker)
const commentApi = createCommentApi(callWorker)
const drawApi = createDrawApi(callWorker)
const llmApi = createLlmApi(callWorker)
const overlayApi = createOverlayLayoutAdminApi(callWorker)
const bgmApi = createBgmApi(callWorker)
const pomodoroApi = createPomodoroApi(callWorker)
const recognitionDeps = browserRecognitionDeps(createAppTranscriptApi(callWorker), createTranslationApi(callWorker))

createRoot(root).render(
  <StrictMode>
    <App api={api} statsApi={statsApi} botApi={botApi} viewerApi={viewerApi} speechApi={speechApi} screenApi={screenApi} focusApi={focusApi} commentApi={commentApi} drawApi={drawApi} llmApi={llmApi} overlayApi={overlayApi} bgmApi={bgmApi} pomodoroApi={pomodoroApi} recognitionDeps={recognitionDeps} connectBgm={connectBgmWatch} connectPomodoro={connectPomodoroWatch} />
  </StrictMode>,
)
