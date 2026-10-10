/**
 * コネクターのページ（/connectors/）
 *
 * 外部のサービスとつなぐものをまとめたページ。映すものを持たない裏方（VOICEVOX による読み上げ・
 * Gyazo への配信画面の取り込み・BGM・漢字クイズの時間切れでの OBS の配信の停止）を1つのブラウザソースで動かすための、OBSに貼るURLを出し
 * （issue #108）、その下に各サービスの設定の区画（VOICEVOX・Gyazo・HDAD-tab・Web Speech API）を並べる。
 * Web Speech API の区画は、アプリの枠で動かす音声認識（src/transcript/recognition-context.tsx）のオン・オフと様子を出す
 * （issue #189。認識そのものは枠が持つので、ほかのページに移っても続く）。
 * 裏方そのものは overlay/backstage/index.html が行う（OBSに貼ってあるURLを変えないよう、そちらの名前は裏方のまま）。
 *
 * どの裏方を動かすかは「このブラウザソースが何をするか」という構造の指定なので、Worker には保存せず
 * URLに載せる（合成ページの ?overlay=<名前> と同じ扱い）。読み上げと画面の取り込みの設定は Worker が持ち、
 * それぞれの区画で変える。
 *
 * URLの組み立ては url.ts に分けてテストする。オーバーレイ用キーはアプリの枠から受け取り、
 * 再発行はトリガーのページ（/triggers/）が受け持つ。ブラウザソースの置き方はヘルプボタンの中で案内する。
 *
 * 注意: 裏方をひとつも選んでいないときはURLを出さず、理由を画面に出す（Fail-Fast）。
 */
import { Copy } from 'lucide-react'
import { useId, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { HelpButton } from '@/components/help-button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import type { BotApi } from '@/bot/api'
import type { ScreenAdminApi } from '@/screen/api'
import { ScreenSection } from '@/screen/screen-section'
import type { SpeechApi } from '@/speech/api'
import { SpeechSection } from '@/speech/speech-section'
import { TabSection } from '@/tab/tab-section'
import { RecognitionSection } from '@/transcript/recognition-section'
import { iconButtonName } from '@/core/icon-button'
import { backstageUrl } from './url'

/** ブラウザソースに設定する推奨の大きさ。配信画面には映さないので、状態を読める最小限でよい */
const BACKSTAGE_SIZE = { width: 600, height: 600 }

export interface BackstagePageProps {
  /** オーバーレイ用キー。OBSに貼るURLに入れる */
  overlayKey: string | null
  /** 読み上げの設定の読み書き（VOICEVOX の区画が使う） */
  speechApi: SpeechApi
  /** botの接続状態の読み出し（VOICEVOX の区画が、botを読み上げない人に追加するために使う） */
  botApi: Pick<BotApi, 'status'>
  /** 画面の取り込みの設定の読み書き（Gyazo の区画が使う） */
  screenApi: ScreenAdminApi
}

export const BackstagePage = ({ overlayKey, speechApi, botApi, screenApi }: BackstagePageProps) => (
  <div className="flex flex-col gap-6">
    <BackstageUrlCard overlayKey={overlayKey} />
    <SpeechSection api={speechApi} botApi={botApi} />
    <ScreenSection api={screenApi} />
    <TabSection />
    <RecognitionSection />
  </div>
)

/** 動かす裏方を選び、OBSのブラウザソースに貼るURLを出す */
const BackstageUrlCard = ({ overlayKey }: { overlayKey: string | null }) => {
  const [speech, setSpeech] = useState(true)
  // 画面の取り込みは既定で外す。OBSのWebSocketサーバーと Gyazo のアクセストークンの両方が要るためである
  const [screen, setScreen] = useState(false)
  // BGMも既定で外す。OBSに貼ってある裏方のブラウザソースが、曲を選んだ途端に黙って鳴り出さないようにする
  const [bgm, setBgm] = useState(false)
  // 配信の停止も既定で外す。OBSのWebSocketサーバーの用意が要るうえ、配信を止める力を持つので、選んだときだけ動かす
  const [stop, setStop] = useState(false)
  const actions = usePageActions()
  const urlFieldId = useId()
  const speechFieldId = useId()
  const screenFieldId = useId()
  const bgmFieldId = useId()
  const stopFieldId = useId()

  let url: string
  let urlFailure = ''
  try {
    if (overlayKey === null) throw new Error('オーバーレイ用キーが発行されていません。ログアウトしてログインし直してください')
    url = backstageUrl(window.location.origin, overlayKey, { speech, screen, bgm, stop })
  } catch (error) {
    url = ''
    urlFailure = errorMessage(error)
  }

  const copyUrl = async (): Promise<string> => {
    await navigator.clipboard.writeText(url)
    return 'OBS用のURLをコピーしました'
  }

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>OBS用のURL</CardTitle>
          <CardAction>
            {/* 「表示をオフにしてよい」とは書かない。OBSの「非アクティブ時にソースをシャットダウン」が有効だと、
                非表示にした時点でこのページが閉じられ、読み上げも取り込みも止まってしまう */}
            <HelpButton topic="OBS用のURL">
              <p>選んだものを1つのブラウザソースでまとめて動かします。同じPCの VOICEVOX・OBS につなぐので、OBSと同じPCで開きます。</p>
              <p>
                配信画面には映らないので、見えない位置に置いてかまいません。推奨の大きさは {BACKSTAGE_SIZE.width} × {BACKSTAGE_SIZE.height} px です。
              </p>
              <p>VOICEVOX か BGM を選んだときは、「OBSで音声を制御する」を有効にして音声を配信に乗せます。流すBGMと音量は BGM のページで変えます。</p>
              <p>
                OBS（配信の停止）は、漢字クイズが時間切れになったときに OBS の配信を止めます。OBS のつなぎ先は Gyazo の区画の設定を使います。
              </p>
            </HelpButton>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Checkbox id={speechFieldId} checked={speech} onCheckedChange={(checked) => setSpeech(checked === true)} />
            <Label htmlFor={speechFieldId}>VOICEVOX</Label>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id={screenFieldId} checked={screen} onCheckedChange={(checked) => setScreen(checked === true)} />
            <Label htmlFor={screenFieldId}>Gyazo</Label>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id={bgmFieldId} checked={bgm} onCheckedChange={(checked) => setBgm(checked === true)} />
            <Label htmlFor={bgmFieldId}>BGM</Label>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id={stopFieldId} checked={stop} onCheckedChange={(checked) => setStop(checked === true)} />
            <Label htmlFor={stopFieldId}>OBS（配信の停止）</Label>
          </div>

          {urlFailure === '' ? (
            <>
              <Label htmlFor={urlFieldId}>OBSのブラウザソースに貼るURL</Label>
              <div className="flex gap-2">
                {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
                <Input id={urlFieldId} type="password" readOnly autoComplete="off" value={url} />
                <Button type="button" size="icon" {...iconButtonName('URLをコピー')} disabled={actions.busy} onClick={() => void actions.run(copyUrl)}>
                  <Copy aria-hidden="true" />
                </Button>
              </div>
            </>
          ) : (
            <Alert variant="destructive">
              <AlertTitle>URLを組み立てられません</AlertTitle>
              <AlertDescription>{urlFailure}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
