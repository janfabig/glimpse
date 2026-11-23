// Realistic sample data for the mock API: four projects in different states plus the
// per-scenario "world" (settings, app info, projects, initial view).

import { estimateExportBytes } from '@shared/export-size'
import { DEFAULT_BRIEF, DEFAULT_EXPORT_SETTINGS } from '@shared/presets'
import type {
  AppInfo,
  AppSettings,
  BriefSettings,
  ExportRecord,
  ModelOption,
  Moment,
  Project,
  VideoInfo,
  VideoStatus
} from '@shared/types'
import { autoSelect } from '../../../main/core/selection'
import { briefHash } from '../lib/brief-hash'
import type { InitialView } from './index'
import { MOCK_MESSAGES } from './mock-messages'
import { mockMediaPath, mockSpriteInfo, type MockTheme } from './mock-media'
import type { MockScenario } from './scenarios'

/** main's model catalog (src/main/ai/models.ts), so prices and cost hints match the real app */
export const MOCK_MODELS: ModelOption[] = [
  {
    id: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    description: 'Recommended: fast and accurate, with a free quota',
    recommended: true
  },
  {
    id: 'gemini-4-argon',
    displayName: 'Gemini 4 Argon',
    description: 'Best quality: only with billing turned on, slower and more expensive'
  },
  {
    id: 'gemini-3.6-flash',
    displayName: 'Gemini 3.6 Flash',
    description: 'Solid alternative with a free quota'
  },
  {
    id: 'gemini-3.5-flash-lite',
    displayName: 'Gemini 3.5 Flash-Lite',
    description: 'Low cost: very fast and with a larger daily quota, a little less accurate'
  }
]

export const MOCK_HOME = '/Users/demo'
export const MOCK_OUTPUT_DIR = `${MOCK_HOME}/Movies/Glimpse`

/** [start, length, score, title, reason] */
export type MomentSeed = [number, number, number, string, string]

export interface VideoSeed {
  fileName: string
  durationSec: number
  /** minutes after the project's first recording */
  offsetMin: number
  theme: MockTheme
  landscape?: boolean
  moments: MomentSeed[]
}

const PAROOKAVILLE: VideoSeed[] = [
  {
    fileName: 'VID_20260712_201405.mp4',
    durationSec: 298.4,
    offsetMin: 0,
    theme: 'stage',
    moments: [
      [
        14,
        6.5,
        7,
        'Through the gates with the crew',
        'Everyone cheers while walking through the entrance gate.'
      ],
      [
        63.5,
        5,
        6,
        'View over the grounds',
        'A wide pan across the tents and the Ferris wheel in the evening light.'
      ],
      [
        121,
        7.5,
        8,
        'Toast at the drinks stand',
        'Four cups meet and everyone laughs into the camera.'
      ],
      [205.2, 4.5, 8, 'Confetti at the warm-up', 'The confetti cannon fires and the crowd jumps.'],
      [262, 6, 5, 'Front row at the stage', 'You push your way to the front as the bass kicks in.']
    ]
  },
  {
    fileName: 'VID_20260712_214522.mp4',
    durationSec: 301.2,
    offsetMin: 91,
    theme: 'stage',
    moments: [
      [
        32,
        6,
        7,
        'Lights out, the intro starts',
        'The tension builds: the crowd screams and lights flash.'
      ],
      [88.4, 7.5, 10, 'Bass drop with pyro', 'The drop hits, flames shoot up and everyone jumps.'],
      [140, 5.5, 9, 'Everyone sings the chorus', 'Thousands sing along, a real goosebumps moment.'],
      [199, 4, 8, 'Lisa on shoulders', 'Lisa is lifted up and throws her arms in the air.'],
      [251.6, 8, 7, 'Laser show over the crowd', 'Green lasers fan out over the whole crowd.']
    ]
  },
  {
    fileName: 'VID_20260712_222010.mp4',
    durationSec: 187.6,
    offsetMin: 126,
    theme: 'night',
    moments: [
      [22, 6, 8, 'Ride on the Ferris wheel', 'A view from above of the lit-up grounds.'],
      [75, 5, 6, 'The great fries debate', 'Everyone argues, laughing, about the best sauce.'],
      [140, 4.5, 6, 'Selfie with the crew', 'The group squeezes into the picture, a short cheer.']
    ]
  },
  {
    fileName: 'VID_20260712_230142.mp4',
    durationSec: 296,
    offsetMin: 167,
    theme: 'tent',
    moments: [
      [41, 5.5, 7, 'Strobe storm in the tent', 'Fast flashes of light to the beat, very intense.'],
      [
        118,
        6.5,
        9,
        'Dancing with Max and Ben',
        'You dance in a circle and Max shows his signature move.'
      ],
      [176, 4, 7, 'Hands in the air', 'The whole crowd raises their hands at the break.'],
      [
        240,
        7,
        6,
        'Water from the stage',
        'The DJ sprays water into the crowd and everyone shrieks.'
      ]
    ]
  },
  {
    fileName: 'VID_20260713_000533.mp4',
    durationSec: 244.8,
    offsetMin: 231,
    theme: 'fireworks',
    moments: [
      [
        18,
        8,
        10,
        'Fireworks for the finale',
        'Colourful rockets above the main stage, everyone looks up.'
      ],
      [70, 5, 8, 'Group hug', 'The crew hug each other after the fireworks.'],
      [
        160,
        6,
        5,
        'Glitter on the way home',
        'Leftover confetti glitters in the light of the street lamps.'
      ]
    ]
  }
]

const FUSION: VideoSeed[] = [
  {
    fileName: 'VID_20260627_193012.mp4',
    durationSec: 276.2,
    offsetMin: 0,
    theme: 'stage',
    moments: [
      [30, 6, 8, 'Sunset at the stage', 'Golden light over the crowd.'],
      [150, 5, 9, 'Trumpet solo', 'The band plays a solo and everyone cheers.']
    ]
  },
  {
    fileName: 'VID_20260627_224401.mp4',
    durationSec: 300,
    offsetMin: 194,
    theme: 'tent',
    moments: [
      [62, 7, 8, 'Lasers in the hangar', 'Lasers draw patterns on the ceiling.'],
      [201, 5, 7, 'Dancing until morning', 'The crowd parties without a care.']
    ]
  },
  {
    fileName: 'VID_20260628_051520.mp4',
    durationSec: 212.5,
    offsetMin: 585,
    theme: 'city',
    moments: [[40, 8, 9, 'Sunrise at the lake', 'A calm, warm end to the night.']]
  }
]

const LISA: VideoSeed[] = [
  {
    fileName: 'VID_20261024_203355.mp4',
    durationSec: 241.3,
    offsetMin: 0,
    theme: 'night',
    moments: [
      [12, 6, 10, 'Surprise!', 'Lisa walks in and everyone shouts at once.'],
      [98, 5, 8, 'Unwrapping the present', 'Lisa laughs out loud as she unwraps it.'],
      [177, 4.5, 7, 'A toast to Lisa', 'Glasses clink and Tom gives a short speech.']
    ]
  },
  {
    fileName: 'VID_20261024_224410.mp4',
    durationSec: 198.8,
    offsetMin: 130,
    theme: 'night',
    moments: [
      [35, 6, 8, 'Taking over the dance floor', 'The whole group dances to Lisa’s favourite song.'],
      [120, 5, 6, 'Karaoke duet', 'Lisa and Tom sing off-key but with all their heart.']
    ]
  }
]

const LISBOA: VideoSeed[] = (
  [
    ['VID_20260914_101204.mp4', 265, 'city'],
    ['VID_20260914_134510.mp4', 301, 'city'],
    ['VID_20260914_183022.mp4', 188, 'city'],
    ['VID_20260915_092311.mp4', 222, 'city'],
    ['VID_20260915_201840.mp4', 296, 'night'],
    ['VID_20260916_120015.mp4', 154, 'city']
  ] as const
).map(([fileName, durationSec, theme], i) => ({
  fileName,
  durationSec,
  offsetMin: i * 300,
  theme,
  landscape: i === 3,
  moments: []
}))

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString()

interface ProjectSpec {
  id: string
  name: string
  folder: string
  seeds: VideoSeed[]
  firstRecording: string
  createdAt: number
  updatedAt: number
  brief?: Partial<BriefSettings>
}

function buildVideo(spec: ProjectSpec, seed: VideoSeed, index: number): VideoInfo {
  const id = `${spec.id}-v${index + 1}`
  const width = seed.landscape ? 1920 : 1440
  const height = seed.landscape ? 1080 : 1920
  const sizeBytes = Math.round(seed.durationSec * 1_310_000)
  const media = (file: string): string => mockMediaPath(seed.theme, id, file)
  return {
    id,
    path: `${MOCK_HOME}/Movies/${spec.folder}/${seed.fileName}`,
    fileName: seed.fileName,
    sizeBytes,
    durationSec: seed.durationSec,
    width,
    height,
    hasAudio: true,
    recordedAt: iso(Date.parse(spec.firstRecording) + seed.offsetMin * 60_000),
    fingerprint: `${sizeBytes}-1752345245000-${id}`,
    proxyPath: media('proxy.mp4'),
    posterPath: media('poster.jpg'),
    spritePath: media('sprite.jpg'),
    spriteInfo: mockSpriteInfo(seed.durationSec, width, height)
  }
}

export function seedMoments(videoId: string, seeds: MomentSeed[]): Moment[] {
  return seeds.map(([start, length, score, title, reason], i) => ({
    id: `${videoId}-m${i + 1}`,
    videoId,
    start,
    end: Math.round((start + length) * 100) / 100,
    title,
    reason,
    score,
    selected: false,
    aiStart: start,
    aiEnd: Math.round((start + length) * 100) / 100
  }))
}

function idleStatus(): VideoStatus {
  return {
    prepare: { status: 'done', progress: 1 },
    analysis: { stage: 'idle', progress: 0 }
  }
}

/** a project whose videos are prepared but not analysed */
function preparedProject(spec: ProjectSpec): Project {
  const videos = spec.seeds.map((seed, i) => buildVideo(spec, seed, i))
  return {
    schemaVersion: 1,
    id: spec.id,
    name: spec.name,
    createdAt: iso(spec.createdAt),
    updatedAt: iso(spec.updatedAt),
    videos,
    status: Object.fromEntries(videos.map((v) => [v.id, idleStatus()])),
    brief: { ...DEFAULT_BRIEF, ...spec.brief },
    analyses: {},
    remoteFiles: {},
    moments: [],
    reelEdited: false,
    exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
    exports: []
  }
}

/** marks one video as analysed with the seeded moments */
function markAnalysed(
  project: Project,
  index: number,
  seed: VideoSeed,
  hash: string,
  model: string
): void {
  const video = project.videos[index]
  const moments = seedMoments(video.id, seed.moments)
  const finished = Date.parse(project.updatedAt) - (project.videos.length - index) * 70_000
  project.moments.push(...moments)
  project.analyses[video.id] = {
    videoId: video.id,
    model,
    briefHash: hash,
    createdAt: iso(finished)
  }
  project.status[video.id].analysis = {
    stage: 'done',
    progress: 1,
    message: MOCK_MESSAGES.momentsFound(moments.length),
    startedAt: iso(finished - 84_000),
    finishedAt: iso(finished)
  }
}

function analysedProject(spec: ProjectSpec, hashFor: HashFn, model: string): Promise<Project> {
  const project = preparedProject(spec)
  return hashFor(project.brief).then((hash) => {
    spec.seeds.forEach((seed, i) => markAnalysed(project, i, seed, hash, model))
    project.moments = autoSelect(project)
    return project
  })
}

function exportRecord(project: Project, id: string, createdAt: number): ExportRecord {
  const stamp = new Date(createdAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const name =
    `${project.name} – Highlights ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-` +
    `${pad(stamp.getDate())} ${pad(stamp.getHours())}.${pad(stamp.getMinutes())}.mp4`
  const selected = project.moments.filter((m) => m.selected)
  const durationSec = selected.reduce((sum, m) => sum + m.end - m.start, 0)
  return {
    id,
    path: `${MOCK_OUTPUT_DIR}/${name}`,
    createdAt: iso(createdAt),
    durationSec: Math.round(durationSec * 10) / 10,
    clipCount: selected.length,
    sizeBytes: estimateExportBytes(project.exportSettings.aspect, null, durationSec)
  }
}

type HashFn = (brief: BriefSettings) => Promise<string>

// ---------------------------------------------------------------------------
// World per scenario
// ---------------------------------------------------------------------------

export interface MockWorld {
  settings: AppSettings
  appInfo: AppInfo
  projects: Project[]
  initial: InitialView
  /** seeded AI results per video id, used when the mock "analyses" a video */
  momentSeeds: Map<string, MomentSeed[]>
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export async function buildWorld(scenario: MockScenario, now = Date.now()): Promise<MockWorld> {
  const noKey = scenario === 'nokey' || scenario === 'keyunreadable'
  const settings: AppSettings = {
    model: MOCK_MODELS[0].id,
    hasApiKey: !noKey,
    apiKeySource: noKey ? null : 'keychain',
    // like main once decrypting the stored key failed
    ...(scenario === 'keyunreadable' ? { apiKeyUnreadable: true } : {}),
    // like main once Google rejected the stored key (e.g. deleted in AI Studio)
    ...(scenario === 'keyrejected' ? { apiKeyRejected: true } : {}),
    defaultOutputDir: MOCK_OUTPUT_DIR,
    fakeAi: false
  }
  // like main: the data folder keeps the app's old name
  const userDataDir = `${MOCK_HOME}/Library/Application Support/Glimpse`
  const appInfo: AppInfo = {
    version: '0.1.0',
    userDataDir,
    logFile: `${userDataDir}/logs/main.log`,
    ffmpeg:
      scenario === 'noffmpeg'
        ? {
            ok: false,
            ffmpegPath: null,
            ffprobePath: null,
            version: null,
            hardwareEncoders: [],
            error: MOCK_MESSAGES.noFfmpeg
          }
        : scenario === 'ffmpegbroken'
          ? {
              // the packaged app whose own ffmpeg does not start: a damaged app
              ok: false,
              ffmpegPath: '/Applications/Glimpse.app/Contents/Resources/ffmpeg/ffmpeg',
              ffprobePath: '/Applications/Glimpse.app/Contents/Resources/ffmpeg/ffprobe',
              version: null,
              hardwareEncoders: [],
              error: MOCK_MESSAGES.damagedApp
            }
          : {
              ok: true,
              ffmpegPath: '/Applications/Glimpse.app/Contents/Resources/ffmpeg/ffmpeg',
              ffprobePath: '/Applications/Glimpse.app/Contents/Resources/ffmpeg/ffprobe',
              version: '9.0.2',
              hardwareEncoders: ['h264_videotoolbox']
            }
  }
  const hashFor: HashFn = (brief) => briefHash(brief, settings.model)
  const momentSeeds: MockWorld['momentSeeds'] = new Map()

  const parookavilleSpec: ProjectSpec = {
    id: 'parookaville',
    name: 'Parookaville 2026',
    folder: 'Parookaville',
    seeds: PAROOKAVILLE,
    firstRecording: '2026-07-12T18:14:05.000Z',
    createdAt: now - 3 * DAY,
    updatedAt: now - 2 * HOUR
  }
  const specs: ProjectSpec[] = [
    parookavilleSpec,
    {
      id: 'lisa',
      name: 'Lisa’s birthday',
      folder: 'Lisa 30',
      seeds: LISA,
      firstRecording: '2026-10-24T18:33:55.000Z',
      createdAt: now - 6 * DAY,
      updatedAt: now - 1 * DAY - 3 * HOUR,
      brief: { targetDurationSec: 30 }
    },
    {
      id: 'fusion',
      name: 'Fusion Festival',
      folder: 'Fusion',
      seeds: FUSION,
      firstRecording: '2026-06-27T17:30:12.000Z',
      createdAt: now - 40 * DAY,
      updatedAt: now - 9 * DAY
    },
    {
      id: 'lisboa',
      name: 'Lisbon trip',
      folder: 'Lisbon',
      seeds: LISBOA,
      firstRecording: '2026-09-14T08:12:04.000Z',
      createdAt: now - 47 * DAY,
      updatedAt: now - 46 * DAY,
      brief: { targetDurationSec: 90 }
    }
  ]
  for (const spec of specs) {
    spec.seeds.forEach((seed, i) => {
      if (seed.moments.length > 0) momentSeeds.set(`${spec.id}-v${i + 1}`, seed.moments)
    })
  }

  const parookaville = await buildParookaville(
    scenario,
    parookavilleSpec,
    hashFor,
    settings.model,
    now
  )
  const lisa = await analysedProject(specs[1], hashFor, settings.model)
  const fusion = await analysedProject(specs[2], hashFor, settings.model)
  fusion.exports.push(exportRecord(fusion, 'fusion-e1', now - 9 * DAY))
  const lisboa = preparedProject(specs[3])

  const projects = scenario === 'nokey' ? [] : [parookaville, lisa, fusion, lisboa]
  return { settings, appInfo, projects, initial: initialView(scenario, parookaville), momentSeeds }
}

async function buildParookaville(
  scenario: MockScenario,
  spec: ProjectSpec,
  hashFor: HashFn,
  model: string,
  now: number
): Promise<Project> {
  if (scenario === 'videos' || scenario === 'previewfailed') {
    const project = preparedProject({
      ...spec,
      updatedAt: now - MIN,
      // an older project: 45 s, a target length the options do not have
      brief: scenario === 'previewfailed' ? { targetDurationSec: 45 } : undefined
    })
    const states: [VideoStatus['prepare']['status'], number][] =
      scenario === 'videos'
        ? [
            ['done', 1],
            ['done', 1],
            ['running', 0.62],
            ['pending', 0],
            ['pending', 0]
          ]
        : [
            ['done', 1],
            ['done', 1],
            ['error', 0],
            ['error', 0],
            ['error', 0]
          ]
    project.videos.forEach((video, i) => {
      const [status, progress] = states[i]
      project.status[video.id].prepare = { status, progress }
      if (status !== 'done') {
        video.proxyPath = null
        video.spritePath = null
        video.spriteInfo = null
      }
    })
    if (scenario === 'previewfailed') {
      // only the filmstrip failed (the proxy is there: Gemini can still analyse it), one original
      // was moved away, the other could not be converted
      const [, , filmstrip, gone, broken] = project.videos
      filmstrip.proxyPath = mockMediaPath(spec.seeds[2].theme, filmstrip.id, 'proxy.mp4')
      project.status[filmstrip.id].prepare.error = MOCK_MESSAGES.spriteFailed
      project.status[gone.id].prepare.error = MOCK_MESSAGES.missingOriginal(gone.fileName)
      project.status[broken.id].prepare.error = MOCK_MESSAGES.proxyFailed
    }
    return project
  }
  if (scenario === 'brief') return preparedProject({ ...spec, updatedAt: now - MIN })
  if (scenario === 'analyzing') {
    const project = preparedProject({ ...spec, updatedAt: now - 10_000 })
    const hash = await hashFor(project.brief)
    markAnalysed(project, 0, spec.seeds[0], hash, model)
    markAnalysed(project, 1, spec.seeds[1], hash, model)
    const started = iso(now - 50_000)
    const [, , v3, v4, v5] = project.videos
    project.status[v3.id].analysis = {
      stage: 'analyzing',
      progress: 0.4,
      message: 'Gemini is looking for the best moments…',
      startedAt: started
    }
    project.status[v4.id].analysis = {
      stage: 'uploading',
      progress: 0.55,
      message: 'Uploading…',
      startedAt: started
    }
    project.status[v5.id].analysis = {
      stage: 'error',
      progress: 0,
      error: MOCK_MESSAGES.quotaMinute,
      remedy: 'retry',
      startedAt: started,
      finishedAt: iso(now - 20_000)
    }
    return project
  }
  if (scenario === 'analysisfailed') {
    // a festival day on the free tier: the daily quota ran out after two videos
    const project = preparedProject({ ...spec, updatedAt: now - 30_000 })
    const hash = await hashFor(project.brief)
    markAnalysed(project, 0, spec.seeds[0], hash, model)
    markAnalysed(project, 1, spec.seeds[1], hash, model)
    project.moments = autoSelect(project)
    const started = iso(now - 120_000)
    for (const video of project.videos.slice(2)) {
      project.status[video.id].analysis = {
        stage: 'error',
        progress: 0,
        error: MOCK_MESSAGES.quotaDay,
        remedy: 'settings',
        startedAt: started,
        finishedAt: iso(now - 40_000)
      }
    }
    return project
  }
  const project = await analysedProject(spec, hashFor, model)
  trimByHand(project)
  if (scenario === 'done') {
    project.exports.push(exportRecord(project, 'parookaville-e1', now - DAY - 2 * HOUR))
    project.exports.push(exportRecord(project, 'parookaville-e2', now - 20_000))
  }
  return project
}

/**
 * The user has worked on the reel: the drop clip starts a second later. An edited reel stays as it
 * is when videos are analysed again (and re-analysing asks first).
 */
function trimByHand(project: Project): void {
  const drop = project.moments.find((m) => m.title === 'Bass drop with pyro')
  if (!drop) return
  drop.start = Math.round((drop.start + 1) * 100) / 100
  project.reelEdited = true
}

function initialView(scenario: MockScenario, project: Project): InitialView {
  const firstSelected = project.moments.find((m) => m.selected)?.id
  const selectedCount = project.moments.filter((m) => m.selected).length
  switch (scenario) {
    case 'settings':
    case 'keyunreadable':
    case 'keyrejected':
      return { settingsOpen: true }
    case 'videos':
    case 'previewfailed':
      return { projectId: project.id, step: 'videos' }
    case 'brief':
      return { projectId: project.id, step: 'brief' }
    case 'analyzing':
    case 'analysisfailed':
      return { projectId: project.id, step: 'analysis' }
    case 'review':
      return { projectId: project.id, step: 'review', activeMomentId: firstSelected }
    case 'export':
      return { projectId: project.id, step: 'export' }
    case 'exporting':
      return {
        projectId: project.id,
        step: 'export',
        exportProgress: {
          projectId: project.id,
          exportId: 'mock-export',
          phase: 'rendering',
          progress: 0.46,
          currentClip: 4,
          clipCount: selectedCount,
          message: `Rendering clip 4 of ${selectedCount}…`
        }
      }
    case 'done': {
      const record = project.exports[project.exports.length - 1]
      return {
        projectId: project.id,
        step: 'export',
        exportProgress: {
          projectId: project.id,
          exportId: record?.id ?? 'mock-export',
          phase: 'done',
          progress: 1,
          clipCount: selectedCount,
          outputPath: record?.path,
          message: 'Done!'
        }
      }
    }
    default:
      return {}
  }
}
