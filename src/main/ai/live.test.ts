// End-to-end check against the real Gemini API. Opt-in only – it uploads a clip and uses quota:
//   GEMINI_API_KEY=… npm run test:live
//   (= HC_LIVE_GEMINI=1 GEMINI_API_KEY=… npx vitest run src/main/ai/live.test.ts)
// GEMINI_API_KEY alone is not enough (it is also the app's key fallback, see liveGeminiKey).
// Costs a fraction of a cent: a 30 s synthetic clip at 1 fps.
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RemoteFileRef } from '@shared/types'
import { describe, expect, it } from 'vitest'
import type { AnalyzeStage } from '../contracts'
import { createMediaService } from '../media'
import { FFMPEG } from '../media/testHelpers'
import { createAnalyzer, DEFAULT_MODEL } from './index'
import { liveGeminiKey } from './testSupport'

const exec = promisify(execFile)
const API_KEY = liveGeminiKey()

/**
 * 30 s, encoded like our proxy (H.264 720p, 30 fps, 1 s GOP, AAC stereo, faststart):
 * 10 s red in silence, 10 s blue with a 1 kHz beep, 10 s green in silence.
 */
async function makeBeepVideo(path: string): Promise<void> {
  // prettier-ignore
  await exec(FFMPEG, [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=30:d=10',
    '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=30:d=10',
    '-f', 'lavfi', '-i', 'color=c=green:s=1280x720:r=30:d=10',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=10',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=10',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=10',
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v];' +
      '[4:a]aformat=channel_layouts=stereo[beep];' +
      '[3:a][beep][5:a]concat=n=3:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-profile:v', 'high',
    '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    path
  ])
}

describe.skipIf(!API_KEY)('Gemini live (HC_LIVE_GEMINI=1 + GEMINI_API_KEY)', () => {
  it(
    'finds the beeping part of a synthetic video',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'hc-ai-live-'))
      const remoteFiles: RemoteFileRef[] = []
      const analyzer = createAnalyzer({ fake: false })
      try {
        const proxy = join(dir, 'beep.mp4')
        await makeBeepVideo(proxy)
        // what the app uploads: the analysis copy of the proxy
        const proxyPath = join(dir, 'analysis.mp4')
        await createMediaService().makeAnalysisCopy(proxy, proxyPath, {})
        const stages: AnalyzeStage[] = []
        const result = await analyzer.analyze({
          apiKey: API_KEY ?? '',
          model: process.env.GEMINI_MODEL ?? DEFAULT_MODEL,
          video: {
            proxyPath,
            proxyFingerprint: `live-${Date.now()}`,
            durationSec: 30,
            fileName: 'beep-test.mp4',
            recordedAt: null
          },
          brief: { prompt: 'Find the part where it beeps', targetDurationSec: null },
          remoteFile: null,
          onRemoteFile: (ref) => remoteFiles.push(ref),
          onStage: (stage) => {
            if (stages.at(-1) !== stage) stages.push(stage)
          }
        })

        console.info('[live] moments', JSON.stringify(result.moments), 'usage', result.usage)
        expect(stages).toEqual(['uploading', 'processing', 'analyzing'])
        expect(result.remoteFile.name).toMatch(/^files\//)
        expect(remoteFiles).toEqual([result.remoteFile])
        expect(result.moments.some((m) => m.end > 10 && m.start < 20)).toBe(true)
      } finally {
        // the app keeps an upload for the next analysis; this test leaves nothing with Google
        for (const ref of remoteFiles) await analyzer.deleteRemoteFile(API_KEY ?? '', ref.name)
        await rm(dir, { recursive: true, force: true })
      }
    },
    10 * 60_000
  )
})
