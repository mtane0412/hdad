/**
 * 意見の札の種類（課題・解決策・問い・気づき）を、ページUIの種類の札（Tag）で出す部品。
 *
 * 札の色は、合成ページの札（opinions.css の data-kind ごとの色）と同じ系統のトークンにする。
 * 配信画面で見た札と管理画面の札を、色でも結びつけられるようにするためである。
 * 色は種類を見分けるためだけのもので、良い・悪いの意味は持たせない（多数決や評価に見せない。.claude/rules/opinions.md）。
 */
import { Tag, type TagTone } from '@/components/data/data-display'
import { OPINION_KIND_LABELS, type OpinionKind } from './entry'

/** 札の種類ごとの色。合成ページの札の色（課題=橙・解決策=青・問い=紫・気づき=青緑）に合わせる */
const OPINION_KIND_TONES: Readonly<Record<OpinionKind, TagTone>> = {
  issue: 'orange',
  solution: 'blue',
  question: 'purple',
  insight: 'teal',
}

export const OpinionKindTag = ({ kind }: { kind: OpinionKind }) => <Tag tone={OPINION_KIND_TONES[kind]}>{OPINION_KIND_LABELS[kind]}</Tag>
