/**
 * 部品の見本ページ（/design/）。
 *
 * データの型ごとの表示部品（src/components/data/）を、すべての状態で並べる。
 * 部品の見た目を変えたときや、新しいページで使う前に、明暗の両方で目で確かめるためのページである。
 * 配信者が配信中に開くページではないので、サイドバーとページを探す窓には出さない（pages.tsx の UNLISTED_PAGES）。本番でも開ける。
 *
 * 注意: 並べる値は見本のための固定の文字で、Workerから読んだデータではない。
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ColorSwatch, Identifier, Quantity, StatusDot, Tag, type TagTone } from '@/components/data/data-display'
import { DataTable, DataTableCell, DataTableGroup, DataTableHead, DataTableHeader, DataTableRow } from '@/components/data/data-table'

/** 種類の札の色と、見本に添える色の名前 */
const TAG_SAMPLES: readonly (readonly [tone: TagTone, name: string])[] = [
  ['orange', '橙'],
  ['blue', '青'],
  ['purple', '紫'],
  ['teal', '青緑'],
  ['pink', '桃'],
  ['green', '緑'],
  ['red', '赤'],
  ['yellow', '黄'],
  ['indigo', '藍'],
  ['gray', '灰'],
]

/** 区画ひとつぶん。見出しと、その部品をいつ使うかの説明を添える */
const Section = ({ title, description, children }: { title: string; description: string; children: React.ReactNode }) => (
  <Card>
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3">{children}</CardContent>
  </Card>
)

export const DesignPage = () => (
  <div className="flex flex-col">
    <Section title="状態（StatusDot）" description="点と短い語。点だけにしない。">
      <StatusDot tone="positive">交換できる</StatusDot>
      <StatusDot tone="attention">挨拶を待っている</StatusDot>
      <StatusDot tone="negative">接続できない</StatusDot>
      <StatusDot tone="neutral">止めている</StatusDot>
    </Section>

    <Section title="識別子（Identifier）" description="ログイン名・ファイル名・キーワードなど、打ち込んだ値そのもの。">
      <Identifier prefix="@">tanenob</Identifier>
      <Identifier>open-door.mp3</Identifier>
      <Identifier>「こんにちは」</Identifier>
    </Section>

    <Section title="数量（Quantity）" description="3桁区切りの等幅の数字と小さな単位。無い値は 0 にせず言葉で書く。">
      <Quantity value={1500} unit="pt" />
      <Quantity value={0} unit="秒" />
      <Quantity value={null} unit="回" absent="制限なし" />
      <Quantity value={null} unit="人" />
    </Section>

    <Section title="色の見本（ColorSwatch）" description="色そのものを値として持つもの（報酬の背景色など）。">
      <ColorSwatch color="#9147FF" label="背景色 #9147FF" />
      <ColorSwatch color="#00C7AC" label="背景色 #00C7AC" />
    </Section>

    <Section title="種類の札（Tag）" description="種類を見分けるための色。良い・悪いの意味は持たせない。">
      {TAG_SAMPLES.map(([tone, name]) => (
        <Tag key={tone} tone={tone}>
          {name}
        </Tag>
      ))}
    </Section>

    <Section title="一覧（DataTable）" description="1項目＝1行。区分の帯に件数を添え、まだ設定していない行は薄く出す。">
      <DataTable label="一覧の見本" columns="minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.4fr)" className="w-full">
        <DataTableHeader>
          <DataTableHead>出来事</DataTableHead>
          <DataTableHead>絞り込み</DataTableHead>
          <DataTableHead align="end">効果</DataTableHead>
        </DataTableHeader>
        <DataTableGroup label="チャット" count="1 / 2">
          <DataTableRow>
            <DataTableCell className="font-medium">決まった人の発言</DataTableCell>
            <DataTableCell>
              <Identifier prefix="@">tanenob</Identifier>
            </DataTableCell>
            <DataTableCell align="end">
              <Tag tone="orange">アラート</Tag>
              <Tag tone="blue">チャット</Tag>
            </DataTableCell>
          </DataTableRow>
          <DataTableRow dimmed>
            <DataTableCell className="font-medium">すべての発言</DataTableCell>
            <DataTableCell />
            <DataTableCell align="end" className="text-xs">
              効果なし
            </DataTableCell>
          </DataTableRow>
        </DataTableGroup>
        <DataTableGroup label="イベント" count="1 / 1">
          <DataTableRow>
            <DataTableCell className="font-medium">レイドされた</DataTableCell>
            <DataTableCell>
              <Quantity value={10} unit="人以上" />
            </DataTableCell>
            <DataTableCell align="end">
              <Tag tone="green">市町村紹介</Tag>
            </DataTableCell>
          </DataTableRow>
        </DataTableGroup>
      </DataTable>
    </Section>
  </div>
)
