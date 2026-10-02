/**
 * コネクターのページの HDAD-tab（タブの映像の Chrome 拡張）の区画
 *
 * Chrome のタブ1枚の映像と音を、合成ページの素材「タブの映像」へ出すための拡張（extension/）を配る。
 * 取り込みと送信は拡張の中（offscreen document）で行うので、このページは配信中に開いておかなくてよい。
 *
 * 拡張はこの区画からダウンロードさせる（GET /api/admin/tab/extension.zip）。Worker がこの置き場所につなぐ設定と権限を
 * 入れて返すので、配信者が置き場所を書かずに済む（issue #168）。
 *
 * 映さないサイト（issue #165）の登録・解除と映す範囲（issue #166）は拡張の右クリックと設定ページで行うので、
 * ここではヘルプボタンの中で仕方を案内するだけにする（拡張が覚えている一覧と食い違わないよう、管理する場所を拡張の1か所にまとめる）。
 */
import { HelpButton } from '@/components/help-button'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/** 拡張の zip。この置き場所につなぐ設定と権限が入る（worker/tab-extension.ts） */
const EXTENSION_ZIP_PATH = '/api/admin/tab/extension.zip'

export const TabSection = () => (
  <Card>
    <CardHeader>
      <CardTitle>HDAD-tab</CardTitle>
      <CardAction>
        <HelpButton topic="HDAD-tab">
          <p>Chrome のタブ1枚の映像と音を、合成オーバーレイの素材「タブの映像」へ送る拡張です。拡張は、ダウンロードした HDAD にだけ送ります。</p>
          <p className="font-medium">入れ方（最初の1回だけ）</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>ダウンロードした zip を展開します（hdad-tab というフォルダができます）</li>
            <li>Chrome で chrome://extensions を開き、「デベロッパー モード」を有効にして「パッケージ化されていない拡張機能を読み込む」から hdad-tab フォルダを選びます（前の版は先に削除します）</li>
          </ol>
          <p className="font-medium">映し方</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>映したいタブで拡張のショートカット（既定は Alt+Shift+T）か、ツールバーの拡張のボタンを押します。別のタブで押すと切り替わり、映しているタブでもう一度押すと止まります</li>
            <li>映さないサイトは、拡張のボタンを右クリックして「このサイトを映さない」で登録します。一覧の管理は右クリックの「オプション」から行います</li>
            <li>一部分だけを映すには、拡張のボタンを右クリックして「映す範囲を選ぶ」を選び、ドラッグで囲んで Enter を押します。戻すには「範囲を外す（タブ全体を映す）」を選びます</li>
          </ul>
        </HelpButton>
      </CardAction>
    </CardHeader>
    <CardContent>
      {/* アプリの外（/api/*）なので Link ではなく普通の a で開く */}
      <a href={EXTENSION_ZIP_PATH} download className={buttonVariants({ variant: 'outline' })}>
        拡張をダウンロード
      </a>
    </CardContent>
  </Card>
)
