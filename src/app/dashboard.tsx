/**
 * ダッシュボード
 *
 * ログイン後に最初に出す画面。いまは素材の種類の案内だけを出す。
 * 配信の記録（視聴者数の推移など）は、Workerが記録を貯める仕組みを入れてからここに足す。
 */
import { buttonVariants } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

/** 素材の種類。カテゴリを増やしたらここに足す */
const CATEGORIES: readonly { name: string; href: string; summary: string }[] = [
  { name: '壁紙', href: '/wallpaper/', summary: '配信画面の背景。色や速さを調整してURLをコピーする。' },
  { name: '時計', href: '/clock/', summary: '配信画面に重ねる時計。表示する項目や色をURLで指定する。' },
  { name: 'チャットボックス', href: '/chat/', summary: 'Twitchのチャット欄を配信画面に重ねる。チャンネル名をURLで指定する。' },
  { name: 'アラート', href: '/admin/', summary: 'チャンネルポイントの交換で画像・動画・音声を流す。素材とトリガーを決めてURLをコピーする。' },
]

export const Dashboard = () => (
  <section aria-labelledby="categories-heading" className="flex flex-col gap-4">
    <h2 id="categories-heading" className="text-lg font-semibold">
      素材の種類
    </h2>
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {CATEGORIES.map((category) => (
        <li key={category.href}>
          <Card className="h-full">
            <CardHeader>
              <CardTitle>{category.name}</CardTitle>
              <CardDescription>{category.summary}</CardDescription>
            </CardHeader>
            <CardFooter className="mt-auto">
              <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={category.href}>
                {category.name}の設定を開く
              </a>
            </CardFooter>
          </Card>
        </li>
      ))}
    </ul>
  </section>
)
