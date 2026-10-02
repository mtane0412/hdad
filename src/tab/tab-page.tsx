/**
 * タブの映像のページ（/tab/）
 *
 * Chrome のタブ1枚の映像と音を、合成ページの素材「タブの映像」へ出すための拡張（extension/）を配り、使い方を案内する。
 * 取り込みと送信は拡張の中（offscreen document）で行うので、このページは配信中に開いておかなくてよい
 * （以前はこのページが送り手で、開いたままにしないと映らなかった）。
 *
 * 拡張はこのページからダウンロードさせる（GET /api/admin/tab/extension.zip）。Worker がこの置き場所につなぐ設定と権限を
 * 入れて返すので、配信者が置き場所を書かずに済む（issue #168）。
 *
 * 映さないサイト（issue #165）の登録・解除は拡張（ボタンの右クリックと拡張の設定ページ）で行うので、ここでは仕方を案内するだけにする
 * （拡張が覚えている一覧と食い違わないよう、一覧を管理する場所を拡張の1か所にまとめる）。
 * 映す範囲（issue #166）も、映しているタブの上で選ぶので拡張の右クリックで行い、ここでは仕方を案内するだけにする。
 */
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/** 拡張の zip。この置き場所につなぐ設定と権限が入る（worker/tab-extension.ts） */
const EXTENSION_ZIP_PATH = '/api/admin/tab/extension.zip'

export const TabPage = () => (
  <div className="flex flex-col gap-6">
    <Card>
      <CardHeader>
        <CardTitle>拡張を入れる</CardTitle>
        <CardDescription>はじめに一度だけ行います。拡張は、いま開いている HDAD にだけタブの映像を送ります。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* アプリの外（/api/*）なので Link ではなく普通の a で開く */}
        <a href={EXTENSION_ZIP_PATH} download className={buttonVariants({ variant: 'outline', className: 'self-start' })}>
          拡張をダウンロード
        </a>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>ダウンロードした zip を展開します（hdad-tab というフォルダができます）</li>
          <li>Chrome で chrome://extensions を開き、右上の「デベロッパー モード」を有効にします</li>
          <li>「パッケージ化されていない拡張機能を読み込む」を押し、hdad-tab フォルダを選びます</li>
          <li>前の版を入れていたときは、前の版を削除してから読み込みます</li>
        </ol>
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>映すタブの選び方</CardTitle>
        <CardDescription>このページは開いておかなくてかまいません。Chrome で HDAD にログインしていれば映せます。</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>映したいタブを開きます</li>
          <li>拡張のショートカット（既定は Alt+Shift+T）を押すか、ツールバーの拡張のボタンを押します。映しているあいだ、ボタンに「ON」が出ます</li>
          <li>別のタブで同じ操作をすると、そのタブに切り替わります</li>
          <li>映しているタブでもう一度押すと、映すのをやめます</li>
        </ol>
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>映さないサイト</CardTitle>
        <CardDescription>
          映しているタブが登録したサイトへ移ると、拡張は合成ページへ送るのを止め（ボタンに「止」が出ます）、映してよいページへ戻ると再開します。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>開いているサイトを登録するには、拡張のボタンを右クリックして「このサイトを映さない」を選びます。登録済みのサイトでは同じ場所が「このサイトを映す」になり、選ぶと外れます</li>
          <li>一覧を見る・まだ開いていないサイトをホスト名で登録する・消すには、拡張のボタンの右クリックの「オプション」から設定を開きます</li>
        </ul>
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>映す範囲を絞る</CardTitle>
        <CardDescription>タブの一部分だけを、合成オーバーレイに置いた箱に合わせて大きく映せます。範囲は1つだけで、別のタブに切り替えるとタブ全体に戻ります。</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>映しているタブを開いたまま、拡張のボタンを右クリックして「映す範囲を選ぶ」を選びます</li>
          <li>ページが暗くなったら、映したい範囲をドラッグで囲み、Enter を押します（Esc でやめます）。選んでいるあいだの画面も配信に映ります</li>
          <li>タブ全体に戻すには、拡張のボタンを右クリックして「範囲を外す（タブ全体を映す）」を選びます</li>
        </ol>
      </CardContent>
    </Card>
  </div>
)
