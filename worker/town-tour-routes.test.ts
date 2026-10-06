/**
 * 市町村紹介の経路（GET /api/overlay/town-tour）のテスト
 *
 * handleRequest を通して、次の点を確かめる。
 * - オーバーレイ用キーが無ければ断る
 * - 一覧に無いコードは、Wikipedia も LLM も呼ばずに 404 で断る
 * - 一覧のコードなら、対応する記事を Wikipedia から取り、LLM に紹介を作らせ、出典の URL と一緒に返す
 * - 記事が取れない・LLM の応答の形が違うときは 502 で理由を返し、ダッシュボードの失敗の記録にも残す
 *
 * - 合成ページがクイズを流しはじめたら（POST /api/overlay/town-tour/quiz）、一覧のコードの都道府県を正解として出題を開く
 * - 合成ページが紹介を流しきったら（POST /api/overlay/town-tour/visit）、紹介した市町村として記録する（issue #252）
 * - 合成ページの素材「市町村紹介」の WebSocket の接続を、市町村紹介を受け取る接続として配送先へ引き渡す
 * - 管理画面の試し再生（POST /api/admin/town-tour/demo）は、ログインした配信者にだけ、市町村を1つ引いて押し出す
 * - 音の設定（GET・PUT /api/admin/town-tour/sound）は、ログインした配信者にだけ読み書きさせ、音声でない素材を選んだ設定は400で断る
 * - ナレーション（issue #255）の合成（POST /api/overlay/town-tour/narration）は、読み上げる設定のときだけ、保存済みの話者と速度で
 *   さくらのAI Engine に合成させる。設定（GET・PUT /api/admin/town-tour/narration）は、ログインした配信者にだけ読み書きさせる
 *
 * 材料の拾い方と紹介の読み取りは worker/town-wikipedia.test.ts・worker/town-tour.test.ts が確かめるので、ここでは経路の受け渡しだけを見る。
 */
import { describe, expect, it } from 'vitest'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { createFakeTokenVault } from './fake-token-vault'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'
import { listFailures } from './stats-store'
import { DEFAULT_TOWN_TOUR_NARRATION, loadTownTourNarration, saveTownTourNarration } from './town-tour-narration'
import { DEFAULT_TOWN_TOUR_SOUND, loadTownTourSound, saveTownTourSound } from './town-tour-sound'
import { TOWN_TOUR_NARRATION_TEXT_MAX_LENGTH } from '../src/town-tour/narration'
import { recordTownTourVisit } from './town-tour-visits'

const now = Date.parse('2026-10-04T12:00:00Z')
const site = 'https://hdad.example.com'
const overlayKey = 'issued-overlay-key-0123456789abcdefghij'

/** 広島県府中市（一覧のコード 34208。記事名は「府中市 (広島県)」） */
const FUCHU_HIROSHIMA = '34208'

/** LLM が返す、正しい形の紹介 */
const fuchuTour = {
  hook: 'お好み焼きにミンチ肉を使う市',
  points: [
    { label: '名物', text: '約400年の歴史を持つ府中味噌が名物です。' },
    { label: 'ご当地の味', text: 'ミンチ肉を使う「府中焼き」というお好み焼きがあります。' },
  ],
  cue: '府中焼き、食べたことありますか？',
  imageCaption: '',
}

/** 代表画像のある府中市で LLM が返す紹介（写真の説明つき） */
const fuchuTourWithCaption = { ...fuchuTour, imageCaption: '府中市の町並み' }

/** 応答の tour は写真の説明を除いたもの（写真の説明は image の caption として返す） */
const fuchuTourResponse = { hook: fuchuTour.hook, points: fuchuTour.points, cue: fuchuTour.cue }

const createEnv = (aiResponse: string, alertChannel = createFakeAlertChannel()) =>
  ({
    STORE: createFakeStore({ 'overlay-key': overlayKey }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: '12345',
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: alertChannel.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi({ response: aiResponse }),
  }) satisfies Env

/**
 * Wikipedia の API だけに答える通信の代役。渡された URL を控える。
 * 記事の本文の問い合わせには body を、代表画像の情報（prop=imageinfo）の問い合わせには imageInfo を返す
 */
const fakeWikipedia = (body: unknown, imageInfo: { body: unknown; status: number } | null = null) => {
  const urls: URL[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input))
    if (url.hostname !== 'ja.wikipedia.org') throw new Error(`テストで想定していない通信です: ${url.href}`)
    urls.push(url)
    if (url.searchParams.get('prop') !== 'imageinfo') return Response.json(body)
    if (imageInfo === null) throw new Error('このテストでは代表画像の情報を問い合わせません')
    return Response.json(imageInfo.body, { status: imageInfo.status })
  }
  return { fetchImpl, urls }
}

/** 代表画像のある府中市 (広島県) の記事を返す Wikipedia の応答 */
const fuchuArticleWithImage = {
  query: { pages: [{ ...fuchuArticleOf(), pageimage: 'Fuchu_Hiroshima_view.jpg' }] },
}

/** 府中市 (広島県) の代表画像の情報（作者とライセンス）を返す Wikipedia の応答 */
const fuchuImageInfo = {
  query: {
    pages: [
      {
        title: 'ファイル:Fuchu_Hiroshima_view.jpg',
        imageinfo: [
          {
            thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Fuchu_Hiroshima_view.jpg/1280px-Fuchu_Hiroshima_view.jpg',
            extmetadata: {
              License: { value: 'cc-by-sa-4.0' },
              LicenseShortName: { value: 'CC BY-SA 4.0' },
              Artist: { value: '府中の写真家' },
              ImageDescription: { value: '府中市の眺め' },
            },
          },
        ],
      },
    ],
  },
}

/** 府中市 (広島県) の記事の1ページぶん（代表画像なし） */
function fuchuArticleOf() {
  return {
    pageid: 1,
    title: '府中市 (広島県)',
    extract: ['府中市は、広島県の南東部に位置する市。', '== 名物 ==', '府中味噌 - およそ400年の歴史を持つ味噌。'].join('\n'),
  }
}

/** 府中市 (広島県) の記事を返す Wikipedia の応答（代表画像なし） */
const fuchuArticle = { query: { pages: [fuchuArticleOf()] } }

const invoke = (path: string, env: Env, fetchImpl: typeof fetch, init: RequestInit = {}) =>
  handleRequest(new Request(`${site}${path}`, init), env, {
    fetch: fetchImpl,
    now: () => now,
    wait: async () => {},
    waitUntil: () => {
      throw new Error('このテストでは、応答のあとに続く処理を使いません')
    },
  })

describe('GET /api/overlay/town-tour', () => {
  it('オーバーレイ用キーが違えば断る', async () => {
    const { fetchImpl } = fakeWikipedia(fuchuArticle)

    const response = await invoke(`/api/overlay/town-tour?key=wrong-key&code=${FUCHU_HIROSHIMA}`, createEnv(JSON.stringify(fuchuTour)), fetchImpl)

    expect(response.status).toBe(401)
  })

  it('一覧に無いコードは、外を呼ばずに 404 で断る', async () => {
    const env = createEnv(JSON.stringify(fuchuTour))
    const { fetchImpl, urls } = fakeWikipedia(fuchuArticle)

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=99999`, env, fetchImpl)

    expect(response.status).toBe(404)
    expect(urls).toEqual([])
    expect(env.AI.calls).toEqual([])
  })

  it('一覧のコードなら、記事を材料に紹介を作り、出典の URL と一緒に返す', async () => {
    const { fetchImpl, urls } = fakeWikipedia(fuchuArticle)

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}`, createEnv(JSON.stringify(fuchuTour)), fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      code: FUCHU_HIROSHIMA,
      prefecture: '広島県',
      county: '',
      name: '府中市',
      article: { title: '府中市 (広島県)', url: 'https://ja.wikipedia.org/wiki/%E5%BA%9C%E4%B8%AD%E5%B8%82_(%E5%BA%83%E5%B3%B6%E7%9C%8C)' },
      tour: fuchuTourResponse,
      image: null,
      bond: null,
      bondFailure: null,
    })
    // 名前（府中市）ではなく、コードから引いた記事名で取りに行く。代表画像が無いので画像の情報は問い合わせない
    expect(urls.map((url) => url.searchParams.get('titles'))).toEqual(['府中市 (広島県)'])
  })

  it('記事に代表画像があれば、作者とライセンスと、LLM が書いた写真の説明を紹介と一緒に返す', async () => {
    const env = createEnv(JSON.stringify(fuchuTourWithCaption))
    const { fetchImpl, urls } = fakeWikipedia(fuchuArticleWithImage, { body: fuchuImageInfo, status: 200 })

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}`, env, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      tour: fuchuTourResponse,
      image: {
        url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Fuchu_Hiroshima_view.jpg/1280px-Fuchu_Hiroshima_view.jpg',
        artist: '府中の写真家',
        license: 'CC BY-SA 4.0',
        caption: '府中市の町並み',
      },
    })
    expect(urls.map((url) => url.searchParams.get('titles'))).toEqual(['府中市 (広島県)', 'File:Fuchu_Hiroshima_view.jpg'])
    // 写真の説明を書かせるため、画像の情報を取ってから、ファイル名と Commons の説明を LLM に渡す
    const prompt = JSON.stringify(env.AI.calls[0]?.input)
    expect(prompt).toContain('Fuchu_Hiroshima_view.jpg')
    expect(prompt).toContain('府中市の眺め')
  })

  it('代表画像の情報が取れなければ 502 で理由を返し、失敗の記録に残す', async () => {
    const env = createEnv(JSON.stringify(fuchuTour))
    const { fetchImpl } = fakeWikipedia(fuchuArticleWithImage, { body: { error: '混み合っています' }, status: 503 })

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}`, env, fetchImpl)

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'town-tour-failed', message: expect.stringContaining('Fuchu_Hiroshima_view.jpg') } })
    expect(await listFailures(env.DB)).toEqual([expect.objectContaining({ code: 'town-tour-failed' })])
  })

  it('記事が取れなければ 502 で理由を返し、失敗の記録に残す', async () => {
    const env = createEnv(JSON.stringify(fuchuTour))
    const { fetchImpl } = fakeWikipedia({ query: { pages: [{ title: '府中市 (広島県)', missing: true }] } })

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}`, env, fetchImpl)

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'town-tour-failed', message: expect.stringContaining('府中市 (広島県)') } })
    expect(await listFailures(env.DB)).toEqual([expect.objectContaining({ code: 'town-tour-failed' })])
  })

  it('失敗の記録そのものに失敗しても、紹介を作れなかった理由を 502 で返し、記録の失敗も添える', async () => {
    // 前提: データベース（D1）への書き込みが失敗する
    const env = { ...createEnv('府中市は広島県の市です。'), DB: { ...createFakeDatabase(), batch: () => Promise.reject(new Error('D1 が応答しません')) } }
    const { fetchImpl } = fakeWikipedia(fuchuArticle)

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}`, env, fetchImpl)

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('town-tour-failed')
    expect(body.error.message).toContain('JSON')
    expect(body.error.message).toContain('D1 が応答しません')
  })

  it('LLM の応答の形が違えば 502 で理由を返し、失敗の記録に残す', async () => {
    const env = createEnv('府中市は広島県の市です。')
    const { fetchImpl } = fakeWikipedia(fuchuArticle)

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}`, env, fetchImpl)

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'town-tour-failed', message: expect.stringContaining('JSON') } })
    expect(await listFailures(env.DB)).toEqual([expect.objectContaining({ code: 'town-tour-failed' })])
  })
})

describe('GET /api/overlay/town-tour のレイド元との共通点（issue #275）', () => {
  /** 府中市の材料（fuchuArticle）と、7人を連れてきた kenta_dev さんの情報から作った共通点 */
  const kentaBond = {
    townQuote: '府中味噌',
    raiderField: '配信タイトル',
    raiderQuote: '味噌汁',
    bond: '府中味噌と味噌汁配信。どちらも味噌で人を温める、同じ釜の仲間なのです。',
    certificateReason: '本市の府中味噌と同じく味噌で視聴者を温められた功績につき',
  }

  /** kenta_dev さんの Twitch の公開情報 */
  const kentaUser = {
    id: '500',
    login: 'kenta_dev',
    display_name: 'kenta_dev',
    description: '週末に個人開発をしています',
    profile_image_url: 'https://static-cdn.jtvnw.net/kenta.png',
  }
  const kentaChannel = { broadcaster_id: '500', game_name: 'Software and Game Development', title: '味噌汁を飲みながら開発', tags: ['日本語', '個人開発'] }

  /**
   * Wikipedia・Twitch・OpenRouter に答える通信の代役。OpenRouter には bondResponses を順に返し、送られた本文を控える
   *
   * @param users ログイン名で引いたときに Twitch が返すユーザー（空ならいない）
   */
  const fakeServices = (bondResponses: readonly string[], users: readonly unknown[] = [kentaUser]) => {
    const openRouterBodies: unknown[] = []
    const twitchUrls: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === 'ja.wikipedia.org') return Response.json(fuchuArticle)
      if (url.href === 'https://id.twitch.tv/oauth2/token') return Response.json({ access_token: 'test-app-token' })
      if (url.hostname === 'api.twitch.tv') {
        twitchUrls.push(url.href)
        if (url.pathname === '/helix/users') return Response.json({ data: users })
        if (url.pathname === '/helix/channels') return Response.json({ data: [kentaChannel] })
      }
      if (url.hostname === 'openrouter.ai') {
        const body: unknown = JSON.parse(input instanceof Request ? await input.text() : String(init?.body))
        openRouterBodies.push(body)
        const content = bondResponses[openRouterBodies.length - 1]
        if (content === undefined) throw new Error('用意した共通点の応答より多く呼ばれました')
        return Response.json({ choices: [{ message: { role: 'assistant', content } }] })
      }
      throw new Error(`テストで想定していない通信です: ${url.href}`)
    }
    return { fetchImpl, openRouterBodies, twitchUrls }
  }

  /** OpenRouter の鍵を設定した環境 */
  const envWithKey = () => ({ ...createEnv(JSON.stringify(fuchuTour)), OPENROUTER_API_KEY: 'openrouter-test-key' })

  it('レイド元が添えられていれば、Twitch の公開情報を材料に共通点を作り、レイド元の名前とアイコンと一緒に返す', async () => {
    const { fetchImpl, openRouterBodies, twitchUrls } = fakeServices([JSON.stringify(kentaBond)])

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}&raider=kenta_dev&viewers=7`, envWithKey(), fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      tour: fuchuTourResponse,
      bond: {
        raiderName: 'kenta_dev',
        raiderIcon: 'https://static-cdn.jtvnw.net/kenta.png',
        raiderQuote: '味噌汁',
        townQuote: '府中味噌',
        text: kentaBond.bond,
        certificateReason: kentaBond.certificateReason,
      },
      bondFailure: null,
    })
    expect(twitchUrls).toEqual(['https://api.twitch.tv/helix/users?login=kenta_dev', 'https://api.twitch.tv/helix/channels?broadcaster_id=500'])
    // 既定のモデル（推論を止められない）に、軽い推論をかけて頼む。材料には連れてきた人数も入れる
    expect(openRouterBodies[0]).toMatchObject({ model: 'google/gemini-3.8-flash', reasoning: { effort: 'low' } })
    expect(JSON.stringify(openRouterBodies[0])).toContain('連れてきた人数: 7人')
  })

  it('OpenRouter の鍵が無ければ、Twitch も LLM も呼ばずに、共通点なし（失敗でもない）として紹介だけを返す', async () => {
    const env = createEnv(JSON.stringify(fuchuTour))
    const { fetchImpl, openRouterBodies, twitchUrls } = fakeServices([])

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}&raider=kenta_dev&viewers=7`, env, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ tour: fuchuTourResponse, bond: null, bondFailure: null })
    expect(twitchUrls).toEqual([])
    expect(openRouterBodies).toEqual([])
    expect(await listFailures(env.DB)).toEqual([])
  })

  it('材料に無い語句の共通点しか返らなければ、紹介は返したうえで共通点を出さず、理由を返して失敗の記録に残す', async () => {
    const env = envWithKey()
    const invented = JSON.stringify({ ...kentaBond, townQuote: '府中焼き' })
    const { fetchImpl } = fakeServices([invented, invented])

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}&raider=kenta_dev`, env, fetchImpl)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { tour: unknown; bond: unknown; bondFailure: string }
    expect(body.tour).toEqual(fuchuTourResponse)
    expect(body.bond).toBeNull()
    expect(body.bondFailure).toContain('府中焼き')
    expect(await listFailures(env.DB)).toEqual([expect.objectContaining({ code: 'town-tour-bond-failed' })])
  })

  it('そのログイン名の配信者が Twitch にいなければ、共通点を出さず、理由を返して失敗の記録に残す', async () => {
    const env = envWithKey()
    const { fetchImpl } = fakeServices([], [])

    const response = await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}&raider=no_such_user`, env, fetchImpl)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ bond: null, bondFailure: expect.stringContaining('no_such_user') })
    expect(await listFailures(env.DB)).toEqual([expect.objectContaining({ code: 'town-tour-bond-failed' })])
  })

  it('ログイン名か連れてきた人数の形が違えば、外を呼ばずに 400 で断る', async () => {
    const env = envWithKey()
    const { fetchImpl, twitchUrls } = fakeServices([])

    expect((await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}&raider=${encodeURIComponent('名前')}`, env, fetchImpl)).status).toBe(400)
    expect((await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}&raider=kenta_dev&viewers=-1`, env, fetchImpl)).status).toBe(400)
    expect((await invoke(`/api/overlay/town-tour?key=${overlayKey}&code=${FUCHU_HIROSHIMA}&viewers=7`, env, fetchImpl)).status).toBe(400)
    expect(twitchUrls).toEqual([])
    expect(env.AI.calls).toEqual([])
  })
})

describe('POST /api/overlay/town-tour/quiz', () => {
  const noFetch: typeof fetch = async () => {
    throw new Error('このテストでは外へ通信しません')
  }
  const openQuiz = (env: Env, key: string, body: unknown) =>
    invoke(`/api/overlay/town-tour/quiz?key=${key}`, env, noFetch, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('オーバーレイ用キーが違えば断り、出題を開かない', async () => {
    const env = createEnv('')

    const response = await openQuiz(env, 'wrong-key', { quizId: 'quiz-fuchu', code: FUCHU_HIROSHIMA })

    expect(response.status).toBe(401)
    expect(env.DB.sqlite.prepare('SELECT id FROM town_tour_quizzes').all()).toEqual([])
  })

  it('一覧のコードなら、その市町村の都道府県を正解として出題を開く', async () => {
    const env = createEnv('')

    const response = await openQuiz(env, overlayKey, { quizId: 'quiz-fuchu', code: FUCHU_HIROSHIMA })

    expect(response.status).toBe(204)
    expect(env.DB.sqlite.prepare('SELECT id, code, prefecture FROM town_tour_quizzes').all()).toEqual([
      { id: 'quiz-fuchu', code: FUCHU_HIROSHIMA, prefecture: '広島県' },
    ])
  })

  it('一覧に無いコードは 404 で断る', async () => {
    const response = await openQuiz(createEnv(''), overlayKey, { quizId: 'quiz-unknown', code: '99999' })

    expect(response.status).toBe(404)
  })

  it('出題の識別子かコードが欠けていれば 400 で断る', async () => {
    const response = await openQuiz(createEnv(''), overlayKey, { code: FUCHU_HIROSHIMA })

    expect(response.status).toBe(400)
  })
})

describe('POST /api/overlay/town-tour/visit', () => {
  const noFetch: typeof fetch = async () => {
    throw new Error('このテストでは外へ通信しません')
  }
  const recordVisit = (env: Env, key: string, body: unknown) =>
    invoke(`/api/overlay/town-tour/visit?key=${key}`, env, noFetch, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  /** レイドで流しきった広島県府中市の紹介 */
  const fuchuVisit = { code: FUCHU_HIROSHIMA, occasion: 'raid', userName: '山田花子' }

  it('オーバーレイ用キーが違えば断り、記録しない', async () => {
    const env = createEnv('')

    const response = await recordVisit(env, 'wrong-key', fuchuVisit)

    expect(response.status).toBe(401)
    expect(env.DB.sqlite.prepare('SELECT code FROM town_tour_visits').all()).toEqual([])
  })

  it('流しきった紹介を、きっかけと相手の名前と一緒に記録する', async () => {
    const env = createEnv('')

    const response = await recordVisit(env, overlayKey, fuchuVisit)

    expect(response.status).toBe(204)
    expect(env.DB.sqlite.prepare('SELECT code, visited_at, occasion, user_name FROM town_tour_visits').all()).toEqual([
      { code: FUCHU_HIROSHIMA, visited_at: '2026-10-04T12:00:00.000Z', occasion: 'raid', user_name: '山田花子' },
    ])
  })

  it('一覧に無いコードは 404 で断る', async () => {
    const response = await recordVisit(createEnv(''), overlayKey, { ...fuchuVisit, code: '99999' })

    expect(response.status).toBe(404)
  })

  it('きっかけがレイドでもキーワードでもない（試し再生など）・相手の名前が欠けていれば 400 で断る', async () => {
    expect((await recordVisit(createEnv(''), overlayKey, { ...fuchuVisit, occasion: 'demo' })).status).toBe(400)
    expect((await recordVisit(createEnv(''), overlayKey, { code: FUCHU_HIROSHIMA, occasion: 'raid' })).status).toBe(400)
  })

  it('記録に失敗したら 502 で理由を返し、ダッシュボードの失敗の記録に残す', async () => {
    const env = createEnv('')
    env.DB.sqlite.exec('DROP TABLE town_tour_visits')

    const response = await recordVisit(env, overlayKey, fuchuVisit)

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'town-tour-visit-failed' } })
    expect(await listFailures(env.DB)).toMatchObject([{ code: 'town-tour-visit-failed' }])
  })
})

describe('GET /api/overlay/town-tour/socket', () => {
  const noFetch: typeof fetch = async () => {
    throw new Error('このテストでは外へ通信しません')
  }

  it('WebSocketの接続でなければ400にする', async () => {
    const response = await invoke(`/api/overlay/town-tour/socket?key=${overlayKey}`, createEnv(''), noFetch)

    expect(response.status).toBe(400)
  })

  it('WebSocketの接続なら、市町村紹介を受け取る接続として配送先へ引き渡す', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv('', alertChannel)

    const response = await handleRequest(new Request(`${site}/api/overlay/town-tour/socket?key=${overlayKey}`, { headers: { Upgrade: 'websocket' } }), env, {
      fetch: noFetch,
      now: () => now,
      wait: async () => {},
      waitUntil: () => undefined,
    })

    expect(response.status).toBe(200)
    expect(alertChannel.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual(['townTour'])
  })
})

describe('POST /api/admin/town-tour/demo', () => {
  const noFetch: typeof fetch = async () => {
    throw new Error('このテストでは外へ通信しません')
  }

  /** 配信者としてログインした状態で呼ぶ。書き換えなので Origin も付ける（ブラウザが付けるのと同じ） */
  const callAsBroadcaster = async (env: Env): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/town-tour/demo', env, noFetch, {
      method: 'POST',
      headers: { Cookie: `__Host-session=${session}`, Origin: site },
    })
  }

  it('ログインしていなければ401にし、押し出さない', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await invoke('/api/admin/town-tour/demo', createEnv('', alertChannel), noFetch, { method: 'POST', headers: { Origin: site } })

    expect(response.status).toBe(401)
    expect(alertChannel.pushedTownTours).toEqual([])
  })

  it('市町村を1つ引き、試し再生と分かる一文を添えて押し出し、押し出したものを返す', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callAsBroadcaster(createEnv('', alertChannel))

    expect(response.status).toBe(200)
    expect(alertChannel.pushedTownTours).toHaveLength(1)
    expect(alertChannel.pushedTownTours[0]?.headline).toMatch(/^試し再生: 本日は.+をご紹介します$/)
    expect(await response.json()).toEqual(alertChannel.pushedTownTours[0])
  })

  it('これまでの記録を制覇マップの材料として添えるが、試し再生は記録しないので記録するきっかけを持たない', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv('', alertChannel)
    await recordTownTourVisit(env.DB, { code: FUCHU_HIROSHIMA, occasion: 'raid', userName: '山田花子' }, now)

    await callAsBroadcaster(env)

    expect(alertChannel.pushedTownTours[0]?.visited).toEqual([FUCHU_HIROSHIMA])
    expect(alertChannel.pushedTownTours[0]?.visit).toBeNull()
  })

  /** ユーザー名を入れて試し再生を押す。Twitch には users を返させる */
  const callWithUserName = async (env: Env, userName: string, users: readonly unknown[]): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    const twitchFetch: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.href === 'https://id.twitch.tv/oauth2/token') return Response.json({ access_token: 'test-app-token' })
      if (url.hostname === 'api.twitch.tv' && url.pathname === '/helix/users') return Response.json({ data: users })
      throw new Error(`テストで想定していない通信です: ${url.href}`)
    }
    return invoke('/api/admin/town-tour/demo', env, twitchFetch, {
      method: 'POST',
      headers: { Cookie: `__Host-session=${session}`, Origin: site, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName }),
    })
  }

  /** 星野ゆうさんの Twitch の公開情報 */
  const hoshinoUser = {
    id: '600',
    login: 'hoshino_yu',
    display_name: '星野ゆう',
    description: '',
    profile_image_url: 'https://static-cdn.jtvnw.net/hoshino.png',
  }

  it('ユーザー名を入れずに押したら、共通点を作らせず、見本の名前を名誉町民にする', async () => {
    const alertChannel = createFakeAlertChannel()

    await callAsBroadcaster(createEnv('', alertChannel))

    expect(alertChannel.pushedTownTours[0]).toMatchObject({ raider: null, honoraryCitizen: 'レイド元の配信者' })
  })

  it('ユーザー名を入れて押したら、その配信者をレイド元とみなし、共通点を作らせて名誉町民にする（issue #275）', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callWithUserName(createEnv('', alertChannel), 'hoshino_yu', [hoshinoUser])

    expect(response.status).toBe(200)
    expect(alertChannel.pushedTownTours[0]).toMatchObject({ raider: { login: 'hoshino_yu', viewers: null }, honoraryCitizen: '星野ゆう' })
  })

  it('入れたユーザー名の配信者が Twitch にいなければ、押し出さずに 404 で返す（打ち間違いに気づけるように）', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callWithUserName(createEnv('', alertChannel), 'no_such_user', [])

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'unknown-twitch-user', message: expect.stringContaining('no_such_user') } })
    expect(alertChannel.pushedTownTours).toEqual([])
  })

  it('ユーザー名が Twitch のログイン名の形でなければ、押し出さずに 400 で返す', async () => {
    const alertChannel = createFakeAlertChannel()

    const response = await callWithUserName(createEnv('', alertChannel), '星野 ゆう', [hoshinoUser])

    expect(response.status).toBe(400)
    expect(alertChannel.pushedTownTours).toEqual([])
  })

  it('配送先が失敗したら、黙って成功にせず 502 で返す', async () => {
    const response = await callAsBroadcaster(createEnv('', createFakeAlertChannel({ shouldFail: true })))

    expect(response.status).toBe(502)
  })

  it('音を選んでいるのにオーバーレイ用キーが未発行なら、押し出さずに理由つきの409で返す', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv('', alertChannel)
    await env.STORE.delete('overlay-key')
    await saveTownTourSound(env.STORE, { ...DEFAULT_TOWN_TOUR_SOUND, slots: { ...DEFAULT_TOWN_TOUR_SOUND.slots, bgm: 'media-cookie' } })

    const response = await callAsBroadcaster(env)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'overlay-key-missing' } })
    expect(alertChannel.pushedTownTours).toEqual([])
  })

  it('保存した音の設定を、トリガーと同じく音声のURLにして一緒に押し出す（試し再生で聞き比べられるように）', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv('', alertChannel)
    await saveTownTourSound(env.STORE, { ...DEFAULT_TOWN_TOUR_SOUND, slots: { ...DEFAULT_TOWN_TOUR_SOUND.slots, landing: 'media-peta' } })

    await callAsBroadcaster(env)

    expect(alertChannel.pushedTownTours[0]?.sound.slots.landing).toBe(`/api/media/media-peta?key=${overlayKey}`)
  })

  it('ナレーションを読み上げる設定なら、読み上げることを一緒に押し出す（試し再生で声を確かめられるように）', async () => {
    const alertChannel = createFakeAlertChannel()
    const env = createEnv('', alertChannel)

    await callAsBroadcaster(env)
    await saveTownTourNarration(env.STORE, { enabled: true, speaker: 13, speed: 1.1 })
    await callAsBroadcaster(env)

    expect(alertChannel.pushedTownTours.map((call) => call.narration)).toEqual([false, true])
  })
})

describe('POST /api/overlay/town-tour/narration', () => {
  const sakuraApiKey = 'sakura-test-api-key'
  /** 読み上げる設定にし、話者13・速度1.1で保存した環境。APIキーは既定で設定済みにし、null なら設定していないものとする */
  const createNarrationEnv = async (narration = { enabled: true, speaker: 13, speed: 1.1 }, apiKey: string | null = sakuraApiKey) => {
    const env = { ...createEnv(''), SAKURA_AI_API_KEY: apiKey ?? undefined } satisfies Env
    await saveTownTourNarration(env.STORE, narration)
    return env
  }

  /** さくらの代役。送られた要求のURLと本文を記録し、audio_query には読み方を、synthesis には音声を返す */
  const createSakuraFetch = (respond: (url: URL) => Response | undefined = () => undefined) => {
    const sent: { url: URL; body: string }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      sent.push({ url, body: await request.text() })
      const replaced = respond(url)
      if (replaced) return replaced
      if (url.pathname === '/tts/v1/audio_query') return Response.json({ accent_phrases: [], speedScale: 1 })
      if (url.pathname === '/tts/v1/synthesis') return new Response('ナレーターの声（WAV）', { headers: { 'Content-Type': 'audio/wav' } })
      throw new Error(`テストで想定していない通信です: ${request.url}`)
    }
    return { fetchImpl, sent }
  }
  const noNetwork: typeof fetch = async () => {
    throw new Error('このテストでは外へ通信しません')
  }

  const narrate = (env: Env, body: unknown, fetchImpl: typeof fetch = noNetwork, key = overlayKey) =>
    invoke(`/api/overlay/town-tour/narration?key=${key}`, env, fetchImpl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  const errorCodeOf = async (response: Response): Promise<string> => ((await response.json()) as { error: { code: string } }).error.code

  it('オーバーレイ用キーが違えば401を返す（さくらは呼ばない）', async () => {
    const response = await narrate(await createNarrationEnv(), { text: '府中味噌が名物です。' }, noNetwork, 'wrong-key')

    expect(response.status).toBe(401)
  })

  it('読み上げない設定なら409で断る（選んでいない配信者に課金を起こさない）', async () => {
    const env = await createNarrationEnv({ ...DEFAULT_TOWN_TOUR_NARRATION, enabled: false })

    const response = await narrate(env, { text: '府中味噌が名物です。' })

    expect(response.status).toBe(409)
    expect(await errorCodeOf(response)).toBe('town-tour-narration-disabled')
  })

  it('APIキーが設定されていなければ400で断る', async () => {
    const env = await createNarrationEnv(undefined, null)

    const response = await narrate(env, { text: '府中味噌が名物です。' })

    expect(response.status).toBe(400)
    expect(await errorCodeOf(response)).toBe('no-api-key')
  })

  it('保存済みの話者と速度で合成し、音声をそのまま返す（チャットの読み上げの設定は使わない）', async () => {
    const env = await createNarrationEnv()
    const { fetchImpl, sent } = createSakuraFetch()

    const response = await narrate(env, { text: '府中味噌が名物です。' }, fetchImpl)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('audio/wav')
    expect(await response.text()).toBe('ナレーターの声（WAV）')
    expect(sent.map(({ url }) => [url.pathname, url.searchParams.get('speaker')])).toEqual([
      ['/tts/v1/audio_query', '13'],
      ['/tts/v1/synthesis', '13'],
    ])
    expect(sent[0]?.url.searchParams.get('text')).toBe('府中味噌が名物です。')
    expect(JSON.parse(sent[1]?.body ?? '{}')).toMatchObject({ speedScale: 1.1 })
  })

  it('読み上げ文が空か長すぎれば400で断る（さくらは呼ばない）', async () => {
    const env = await createNarrationEnv()

    expect((await narrate(env, { text: '' })).status).toBe(400)
    expect((await narrate(env, { text: 'あ'.repeat(TOWN_TOUR_NARRATION_TEXT_MAX_LENGTH + 1) })).status).toBe(400)
    expect((await narrate(env, { message: '府中味噌が名物です。' })).status).toBe(400)
  })

  it('さくらが失敗を返したら502で、さくらの理由を返す', async () => {
    const env = await createNarrationEnv()
    const { fetchImpl } = createSakuraFetch(() => Response.json({ detail: 'This model is not available.' }, { status: 400 }))

    const response = await narrate(env, { text: '府中味噌が名物です。' }, fetchImpl)

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('town-tour-narration-failed')
    expect(body.error.message).toContain('This model is not available.')
  })
})

describe('GET・PUT /api/admin/town-tour/narration', () => {
  /** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
  const callAsBroadcaster = async (env: Env, init: RequestInit = {}): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/town-tour/narration', env, noNetwork, { ...init, headers: { Cookie: `__Host-session=${session}`, Origin: site } })
  }
  const noNetwork: typeof fetch = async () => {
    throw new Error('このテストでは外へ通信しません')
  }

  it('ログインしていなければ読ませない', async () => {
    const response = await invoke('/api/admin/town-tour/narration', createEnv(''), noNetwork)

    expect(response.status).toBe(401)
  })

  it('未保存なら、読み上げない設定を返す', async () => {
    const response = await callAsBroadcaster(createEnv(''))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(DEFAULT_TOWN_TOUR_NARRATION)
  })

  it('保存した設定を返し、次に読んだときも同じものを返す', async () => {
    const env = createEnv('')
    const narration = { enabled: true, speaker: 13, speed: 1.1 }

    const saved = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify(narration) })
    const loaded = await callAsBroadcaster(env)

    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(narration)
    expect(await loaded.json()).toEqual(narration)
  })

  it('範囲の外の速度は、問題点つきの400で断って保存しない', async () => {
    const env = createEnv('')

    const response = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify({ enabled: true, speaker: 13, speed: 5 }) })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual(['speed: 0.5〜2 の数で指定してください'])
    expect(await loadTownTourNarration(env.STORE)).toEqual(DEFAULT_TOWN_TOUR_NARRATION)
  })
})

describe('GET・PUT /api/admin/town-tour/sound', () => {
  /** 配信者としてログインした状態で呼ぶ。書き換えのときは Origin も付ける（ブラウザが付けるのと同じ） */
  const callAsBroadcaster = async (env: Env, init: RequestInit = {}): Promise<Response> => {
    const session = await createSessionToken(env.TWITCH_BROADCASTER_ID, env.SESSION_SECRET, now)
    return invoke('/api/admin/town-tour/sound', env, noNetwork, { ...init, headers: { Cookie: `__Host-session=${session}`, Origin: site } })
  }
  const noNetwork: typeof fetch = async () => {
    throw new Error('このテストでは外へ通信しません')
  }

  /** BGM（ピアノの曲）と着地の効果音、地図の画像を上げておいた環境 */
  const createEnvWithMedia = async (): Promise<Env> => {
    const env = createEnv('')
    await env.MEDIA.put('media-cookie', new ArrayBuffer(8), { httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { name: 'cookie-cookie.mp3' } })
    await env.MEDIA.put('media-peta', new ArrayBuffer(8), { httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { name: 'peta1.mp3' } })
    await env.MEDIA.put('media-chizu', new ArrayBuffer(8), { httpMetadata: { contentType: 'image/png' }, customMetadata: { name: 'chizu.png' } })
    return env
  }

  const sound = {
    slots: { bgm: 'media-cookie', opening: null, zoom: null, landing: 'media-peta', item: null, closing: null },
    bgmVolume: 0.25,
    effectVolume: 0.8,
  }

  it('ログインしていなければ読ませない', async () => {
    const response = await invoke('/api/admin/town-tour/sound', createEnv(''), noNetwork)

    expect(response.status).toBe(401)
  })

  it('未保存なら、どの枠も鳴らさない設定を返す', async () => {
    const response = await callAsBroadcaster(createEnv(''))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(DEFAULT_TOWN_TOUR_SOUND)
  })

  it('保存した設定を返し、次に読んだときも同じものを返す', async () => {
    const env = await createEnvWithMedia()

    const saved = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify(sound) })
    const loaded = await callAsBroadcaster(env)

    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(sound)
    expect(await loaded.json()).toEqual(sound)
  })

  it('音声でない素材を選んだ設定は、問題点つきの400で断って保存しない', async () => {
    const env = await createEnvWithMedia()

    const response = await callAsBroadcaster(env, { method: 'PUT', body: JSON.stringify({ ...sound, slots: { ...sound.slots, zoom: 'media-chizu' } }) })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { problems: string[] } }
    expect(body.error.problems).toEqual(['slots.zoom: 素材「media-chizu」は音声ではありません'])
    expect(await loadTownTourSound(env.STORE)).toEqual(DEFAULT_TOWN_TOUR_SOUND)
  })
})
