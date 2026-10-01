/**
 * 拡張がタブのストリームIDを送り手のページへ渡す手順のテスト
 *
 * Chrome の API は偽物に差し替え、次を確かめる。
 * - 送り手のページ（信頼する置き場所の、パスが /tab/ のタブ）を受け取り先にしてIDを取り、そのページの URL の # に入れる
 * - 信頼していないサイトの /tab/ には渡さない（渡すと、そのサイトが映したいタブの映像と音を取り込めてしまう）
 * - 送り手のページが無い・複数ある・送り手のページ自身で押されたときは、IDを取らずに理由をバッジで知らせる
 * - 成功したら前に出していた知らせを消す
 */
import { describe, expect, it } from 'vitest'
import { readStreamHash } from '../../src/tab/signal'
import { handOverTab, type ExtensionApi, type TabInfo } from './hand-over'

const slideTab: TabInfo = { id: 7, title: '配信の資料 - Google スライド', url: 'https://docs.google.com/presentation/d/abc' }
const senderTab: TabInfo = { id: 3, title: 'HDAD', url: 'https://hdad.example.workers.dev/tab/' }
/** ビルドのときに HDAD_ORIGINS で渡した、信頼する HDAD の置き場所 */
const trustedOrigins = ['https://hdad.example.workers.dev']

const createApi = (tabs: readonly TabInfo[], options: { failStreamId?: string } = {}) => {
  const requests: { targetTabId: number; consumerTabId: number }[] = []
  const updatedUrls: { tabId: number; url: string }[] = []
  const problems: (string | null)[] = []
  const api: ExtensionApi = {
    listTabs: async () => tabs,
    getMediaStreamId: async (targetTabId, consumerTabId) => {
      requests.push({ targetTabId, consumerTabId })
      if (options.failStreamId !== undefined) throw new Error(options.failStreamId)
      return 'ストリームID-1'
    },
    updateTabUrl: async (tabId, url) => {
      updatedUrls.push({ tabId, url })
    },
    showProblem: async (message) => {
      problems.push(message)
    },
  }
  return { api, requests, updatedUrls, problems }
}

describe('handOverTab', () => {
  it('送り手のページを受け取り先にしてIDを取り、そのページの # に入れる', async () => {
    const { api, requests, updatedUrls } = createApi([slideTab, senderTab])

    await handOverTab(slideTab, api, trustedOrigins)

    expect(requests).toEqual([{ targetTabId: 7, consumerTabId: 3 }])
    expect(updatedUrls).toHaveLength(1)
    const [update] = updatedUrls
    expect(update?.tabId).toBe(3)
    expect(update?.url.startsWith('https://hdad.example.workers.dev/tab/#')).toBe(true)
    expect(readStreamHash(new URL(update?.url ?? '').hash)).toEqual({ streamId: 'ストリームID-1', title: '配信の資料 - Google スライド' })
  })

  it('送り手のページに前の # が残っていても、置き換える', async () => {
    const { api, updatedUrls } = createApi([slideTab, { ...senderTab, url: 'https://hdad.example.workers.dev/tab/#stream=old&title=old' }])

    await handOverTab(slideTab, api, trustedOrigins)

    expect(readStreamHash(new URL(updatedUrls[0]?.url ?? '').hash)?.streamId).toBe('ストリームID-1')
  })

  it('成功したら、前に出していた知らせを消す', async () => {
    const { api, problems } = createApi([slideTab, senderTab])

    await handOverTab(slideTab, api, trustedOrigins)

    expect(problems).toEqual([null])
  })

  it('送り手のページが開かれていなければ、IDを取らずに知らせる', async () => {
    const { api, requests, problems } = createApi([slideTab])

    await handOverTab(slideTab, api, trustedOrigins)

    expect(requests).toEqual([])
    expect(problems).toEqual(['HDAD の「タブの映像」のページ（/tab/）を開いてから押してください'])
  })

  it('パスが /tab/ でないページは、送り手のページと見なさない', async () => {
    const { api, problems } = createApi([slideTab, { id: 9, title: 'ほかのサイト', url: 'https://example.com/tab/settings' }])

    await handOverTab(slideTab, api, trustedOrigins)

    expect(problems).toEqual(['HDAD の「タブの映像」のページ（/tab/）を開いてから押してください'])
  })

  it('信頼していないサイトの /tab/ には渡さない', async () => {
    const { api, requests, problems } = createApi([slideTab, { id: 9, title: '知らないサイト', url: 'https://evil.example.com/tab/' }])

    await handOverTab(slideTab, api, trustedOrigins)

    expect(requests).toEqual([])
    expect(problems).toEqual(['HDAD の「タブの映像」のページ（/tab/）を開いてから押してください'])
  })

  it('送り手のページが複数あれば、どちらへ渡すか決めずに知らせる', async () => {
    const { api, requests, problems } = createApi([slideTab, senderTab, { ...senderTab, id: 4 }])

    await handOverTab(slideTab, api, trustedOrigins)

    expect(requests).toEqual([])
    expect(problems).toEqual(['「タブの映像」のページ（/tab/）が2つ以上開かれています。1つだけにしてください'])
  })

  it('送り手のページ自身で押されたら知らせる', async () => {
    const { api, requests, problems } = createApi([slideTab, senderTab])

    await handOverTab(senderTab, api, trustedOrigins)

    expect(requests).toEqual([])
    expect(problems).toEqual(['「タブの映像」のページ自身は映せません。映したいタブを開いてから押してください'])
  })

  it('IDを取れなければ理由を知らせる', async () => {
    // Chrome の設定画面（chrome://）などは取り込めない
    const { api, updatedUrls, problems } = createApi([{ ...slideTab, url: 'chrome://settings/' }, senderTab], { failStreamId: 'Chrome pages cannot be captured.' })

    await handOverTab({ ...slideTab, url: 'chrome://settings/' }, api, trustedOrigins)

    expect(updatedUrls).toEqual([])
    expect(problems).toEqual(['このタブは映せません: Chrome pages cannot be captured.'])
  })
})
