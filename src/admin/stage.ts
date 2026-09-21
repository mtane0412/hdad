/**
 * 管理画面の起動
 *
 * ログイン中かどうかをWorkerに尋ね、未ログインならログインの案内を、ログイン済みなら操作盤
 * （OBS用のURL・素材・トリガー）を出す。画面の状態（素材・報酬・入力中のトリガー）はここで持ち、
 * 一覧の組み立ては view.ts、Workerの呼び出しは api.ts、入力欄の値の変換は form.ts に任せる。
 *
 * 注意: /api/* はWorkerが処理するので、`npm run dev`（Vite）では動かない。`npm run preview:worker` で確かめる。
 * 失敗は黙って無視せず、画面の上部に理由を出す（Fail-Fast）。
 */
import { ApiError, createAdminApi, type MediaItem, type Reward } from './api'
import { describeProblem, overlayUrl, toDraft, toTriggerInput, type TriggerDraft } from './form'
import { renderMediaList, renderTriggerList } from './view'

const NOUN = '管理画面'
const DEFAULT_DURATION_SECONDS = '5'
const DEFAULT_VOLUME_PERCENT = '100'

/** ページに置いてあるはずの要素を取る。なければHTMLとコードが食い違っているので、起動をやめる */
const find = <T extends HTMLElement>(id: string, type: new () => T): T => {
  const node = document.getElementById(id)
  if (!(node instanceof type)) throw new Error(`ページに #${id} の要素がありません`)
  return node
}

const start = async (): Promise<void> => {
  const api = createAdminApi((input, init) => fetch(input, init))

  const notice = find('notice', HTMLElement)
  const failure = find('failure', HTMLElement)
  const overlayUrlField = find('overlay-url', HTMLInputElement)
  const fileField = find('media-file', HTMLInputElement)
  const mediaList = find('media-list', HTMLElement)
  const triggerList = find('trigger-list', HTMLElement)

  let media: MediaItem[] = []
  let rewards: Reward[] = []
  let drafts: TriggerDraft[] = []

  /** 失敗の理由をページ上部に出す。設定の問題点があれば、1行ずつ並べる */
  const showFailure = (error: unknown, lead = ''): void => {
    const message = error instanceof Error ? error.message : String(error)
    const lines =
      error instanceof ApiError && error.problems.length > 0
        ? ['トリガーの設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeProblem(problem)}`)]
        : [`${lead}${message}`]
    notice.textContent = ''
    failure.textContent = lines.join('\n')
    failure.hidden = false
  }

  /** 操作を実行し、終わったら結果を知らせる。失敗したら理由を出す。実行中はボタンを押せなくして二重の送信を防ぐ */
  const run = async (button: HTMLButtonElement | null, action: () => Promise<string>): Promise<void> => {
    failure.hidden = true
    if (button) button.disabled = true
    try {
      notice.textContent = await action()
    } catch (error) {
      showFailure(error)
    } finally {
      if (button) button.disabled = false
    }
  }

  /** ボタンが押されたら操作を実行する。confirmation があれば、実行の前に確かめる */
  const onClick = (id: string, action: () => Promise<string>, confirmation?: string): void => {
    const button = find(id, HTMLButtonElement)
    button.addEventListener('click', () => {
      if (confirmation !== undefined && !window.confirm(confirmation)) return
      void run(button, action)
    })
  }

  const drawMedia = (): void =>
    renderMediaList(mediaList, media, (item) => {
      if (!window.confirm(`素材「${item.name}」を削除しますか？`)) return
      // 削除のボタンは一覧ごと描き直すので、押せなくする対象は渡さない
      void run(null, async () => {
        await api.removeMedia(item.id)
        media = media.filter((other) => other.id !== item.id)
        drawMedia()
        drawTriggers()
        return `素材「${item.name}」を削除しました`
      })
    })

  const drawTriggers = (): void =>
    renderTriggerList(triggerList, {
      drafts,
      media,
      rewards,
      onChange: (index, draft) => {
        drafts = drafts.map((other, position) => (position === index ? draft : other))
      },
      onRemove: (index) => {
        drafts = drafts.filter((_, position) => position !== index)
        drawTriggers()
      },
    })

  const me = await api.me()
  if (me === null) {
    find('login', HTMLElement).hidden = false
    return
  }
  if (me.overlayKey === null) throw new Error('オーバーレイ用キーが発行されていません。ログアウトしてログインし直してください')

  find('login-name', HTMLElement).textContent = me.login
  overlayUrlField.value = overlayUrl(location.origin, me.overlayKey)

  const [loadedMedia, triggers] = await Promise.all([api.media(), api.config()])
  media = loadedMedia
  drafts = triggers.map(toDraft)
  drawMedia()
  drawTriggers()
  find('console', HTMLElement).hidden = false

  onClick('logout', async () => {
    await api.logout()
    location.reload()
    return 'ログアウトしました'
  })

  onClick('copy-url', async () => {
    // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる
    if (!navigator.clipboard) throw new Error('このページではクリップボードを使えません（https か localhost で開いてください）')
    await navigator.clipboard.writeText(overlayUrlField.value)
    return 'OBS用のURLをコピーしました'
  })

  onClick(
    'rotate-key',
    async () => {
      overlayUrlField.value = overlayUrl(location.origin, await api.rotateOverlayKey())
      return 'キーを再発行しました。新しいURLをOBSに貼り替えてください'
    },
    'キーを再発行すると、今のURLは使えなくなります。OBSのURLを貼り替える必要があります。再発行しますか？',
  )

  onClick('upload', async () => {
    const file = fileField.files?.[0]
    if (!file) throw new Error('アップロードするファイルを選んでください')
    const uploaded = await api.upload(file)
    media = [uploaded, ...media]
    fileField.value = ''
    drawMedia()
    drawTriggers()
    return `素材「${uploaded.name}」をアップロードしました`
  })

  onClick('add-trigger', async () => {
    const first = media[0]
    if (!first) throw new Error('先に素材をアップロードしてください')
    drafts = [...drafts, { rewardId: '', mediaId: first.id, durationSeconds: DEFAULT_DURATION_SECONDS, volumePercent: DEFAULT_VOLUME_PERCENT, message: '' }]
    drawTriggers()
    return 'トリガーを足しました。保存するまで反映されません'
  })

  onClick('save-triggers', async () => {
    const inputs = drafts.map((draft, index) => {
      try {
        return toTriggerInput(draft)
      } catch (error) {
        throw new Error(`${index + 1}番目のトリガー: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    })
    const submitted = drafts
    const saved = await api.saveConfig(inputs)
    // 保存を待つ間に入力欄が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    if (drafts !== submitted) return 'トリガーを保存しました。保存中に書き換えた内容はまだ保存されていません'
    drafts = saved.map(toDraft)
    drawTriggers()
    return 'トリガーを保存しました。次の交換から反映されます'
  })

  // 報酬の一覧はTwitchに問い合わせるので、素材や保存済みの設定より失敗しやすい（チャンネルポイントを使えないチャンネルなど）。
  // 失敗しても素材の管理は続けられるよう画面は出し、理由を表示する。報酬を選べない間も「すべての報酬」は選べる
  try {
    rewards = await api.rewards()
    drawTriggers()
  } catch (error) {
    showFailure(error, 'チャンネルポイント報酬の一覧を取得できませんでした: ')
  }
}

start().catch((error: unknown) => {
  // 起動の失敗もページ上部に出す（全画面のエラー表示 showError はOBS向けで、管理画面では使わない）
  const failure = find('failure', HTMLElement)
  failure.textContent = `${NOUN}を表示できません: ${error instanceof Error ? error.message : String(error)}`
  failure.hidden = false
  throw error
})
