/**
 * タブの取り込み（capture.ts）が Chrome へ渡す指定のテスト
 *
 * Chrome はタブの取り込みで、大きさの指定が次の条件をすべて満たすときだけ、タブの縦横比のまま映像を送る
 * （ANY_WITHIN_LIMIT）。満たさないと上限の大きさに固定し、縦横比の違う分を黒い帯で埋めてしまう（FIXED_RESOLUTION）。
 * - 最小の幅・高さが 1 より大きい
 * - 最小の大きさの縦横比と、上限の大きさの縦横比が違う
 * 判定は Chromium の media_stream_constraints_util_video_content.cc（SelectResolutionPolicyFromCandidates）による。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureTab } from './capture'

/** getUserMedia に渡された映像の指定を取り出す */
const captureVideoConstraints = async (): Promise<Record<string, string | number>> => {
  const getUserMedia = vi.fn().mockResolvedValue({ getVideoTracks: () => [], getTracks: () => [] })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  await captureTab('拡張から届いたストリームID')
  const [constraints] = getUserMedia.mock.calls[0] as [{ video: { mandatory: Record<string, string | number> } }]
  return constraints.video.mandatory
}

/** Chromium と同じく、縦横比を 100 倍して切り捨てた整数で比べる */
const approxAspectRatio = (width: number, height: number): number => Math.trunc((100 * width) / height)

describe('captureTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('最小の幅と高さを 1 より大きく指定する（そうしないと Chrome は大きさを固定して黒い帯を入れる）', async () => {
    const video = await captureVideoConstraints()
    expect(video.minWidth).toBeGreaterThan(1)
    expect(video.minHeight).toBeGreaterThan(1)
  })

  it('最小の大きさと上限の大きさで縦横比を変える（同じだと Chrome は縦横比を固定して黒い帯を入れる）', async () => {
    const video = await captureVideoConstraints()
    expect(approxAspectRatio(Number(video.minWidth), Number(video.minHeight))).not.toBe(
      approxAspectRatio(Number(video.maxWidth), Number(video.maxHeight)),
    )
  })
})
