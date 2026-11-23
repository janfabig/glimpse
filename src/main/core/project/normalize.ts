// Migration / normalisation of a project file read from disk. Invalid parts are repaired or
// dropped; states that only make sense while a job runs are reset (no job survives a restart).

import { DEFAULT_BRIEF, DEFAULT_EXPORT_SETTINGS, LIMITS } from '@shared/presets'
import type {
  AnalysisRemedy,
  AnalysisStage,
  BriefSettings,
  ExportRecord,
  Moment,
  PrepareStatus,
  Project,
  RemoteFileRef,
  SpriteInfo,
  VideoAnalysis,
  VideoInfo,
  VideoStatus
} from '@shared/types'
import { clamp, isRecord } from '@shared/util'
import { basename, isAbsolute } from 'node:path'
import { isGeminiFileName, isGeminiFileUri } from '../../contracts'
import { briefHash, legacyBriefHashes, legacyOptionHashes } from '../briefHash'
import { isValidId } from '../ids'
import { JOB_MESSAGES } from '../jobs/messages'
import { DEFAULT_PROJECT_NAME, SCHEMA_VERSION } from './defaults'
import { isFiniteNumber, mergeBrief, mergeExportSettings } from './sanitize'

export const INTERRUPTED_MESSAGE = 'Interrupted'

// A project saved by the German build (before D14) holds that build's status texts. Names in
// English texts are quoted “…” and may hold any word, so they are not tested.
const GERMAN =
  /[äöüß„]|\s[–…]|\b(?:nicht|wurde|konnte|keine?|bitte|du|erneut|gefunden|abgebrochen|unterbrochen|deine?[nmrs]?|ist|sind|und|oder|mit|für|der|das|von|aus)\b/i

/** the text itself, its English version, or undefined for a German text without one */
function fromGermanBuild(value: string): string | undefined {
  if (!GERMAN.test(value.replace(/“[^”]*”/g, ''))) return value
  const missing = /^Die (?:Originaldatei|Datei) „(.+)“ wurde nicht gefunden/.exec(value)
  if (missing) return JOB_MESSAGES.missingOriginal(missing[1])
  const found = /^(\d+) Momente? gefunden$/.exec(value)
  if (found) return JOB_MESSAGES.momentsFound(Number(found[1]))
  const known: Record<string, string> = {
    'Keine passenden Momente gefunden': JOB_MESSAGES.momentsFound(0),
    'Die Vorschau konnte nicht erstellt werden.': JOB_MESSAGES.prepareFailed,
    Abgebrochen: JOB_MESSAGES.cancelled,
    Unterbrochen: INTERRUPTED_MESSAGE
  }
  return known[value]
}

/** analysis stages of a run in progress */
export const RUNNING_STAGES: readonly AnalysisStage[] = [
  'queued',
  'waiting-proxy',
  'uploading',
  'processing',
  'analyzing'
]

const ALL_STAGES: readonly AnalysisStage[] = [
  'idle',
  ...RUNNING_STAGES,
  'done',
  'error',
  'cancelled'
]
const PREPARE_STATES: readonly PrepareStatus[] = ['pending', 'running', 'done', 'error']
const REMEDIES: readonly AnalysisRemedy[] = ['retry', 'settings', 'prepare', 'none']

/** written by a newer app version – never load (and thereby overwrite) it */
export class UnsupportedProjectError extends Error {
  constructor(version: unknown) {
    super(`unsupported project schema version ${String(version)}`)
    this.name = 'UnsupportedProjectError'
  }
}

export interface NormalizeContext {
  /** the project's directory name – authoritative over the id inside the file */
  id: string
  now: string
  newId: () => string
}

type Raw = Record<string, unknown>

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback
const isIso = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
const nonNegative = (value: unknown, fallback: number): number =>
  isFiniteNumber(value) && value >= 0 ? value : fallback
const absoluteOrNull = (value: unknown): string | null =>
  typeof value === 'string' && isAbsolute(value) ? value : null
const records = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : [])
const fraction = (value: unknown): number => (isFiniteNumber(value) ? clamp(value, 0, 1) : 0)

function normalizeSpriteInfo(raw: unknown): SpriteInfo | null {
  if (!isRecord(raw)) return null
  const { columns, intervalSec, tileWidth, tileHeight } = raw
  const positive = [columns, intervalSec, tileWidth, tileHeight].every(
    (v) => isFiniteNumber(v) && v > 0
  )
  return positive
    ? {
        columns: columns as number,
        intervalSec: intervalSec as number,
        tileWidth: tileWidth as number,
        tileHeight: tileHeight as number
      }
    : null
}

function normalizeVideo(raw: Raw): VideoInfo | null {
  if (!isValidId(raw.id) || typeof raw.path !== 'string' || !isAbsolute(raw.path)) return null
  if (!isFiniteNumber(raw.durationSec) || raw.durationSec <= 0) return null
  const spriteInfo = normalizeSpriteInfo(raw.spriteInfo)
  const spritePath = spriteInfo ? absoluteOrNull(raw.spritePath) : null
  return {
    id: raw.id,
    path: raw.path,
    fileName: typeof raw.fileName === 'string' && raw.fileName ? raw.fileName : basename(raw.path),
    sizeBytes: nonNegative(raw.sizeBytes, 0),
    durationSec: raw.durationSec,
    width: nonNegative(raw.width, 0),
    height: nonNegative(raw.height, 0),
    hasAudio: typeof raw.hasAudio === 'boolean' ? raw.hasAudio : true,
    recordedAt: isIso(raw.recordedAt) ? raw.recordedAt : null,
    fingerprint: text(raw.fingerprint, ''),
    proxyPath: absoluteOrNull(raw.proxyPath),
    posterPath: absoluteOrNull(raw.posterPath),
    spritePath,
    spriteInfo: spritePath ? spriteInfo : null
  }
}

function normalizeStatus(raw: unknown, video: VideoInfo): VideoStatus {
  const source = isRecord(raw) ? raw : {}
  const prepareRaw = isRecord(source.prepare) ? source.prepare : {}
  const analysisRaw = isRecord(source.analysis) ? source.analysis : {}

  let prepareStatus = PREPARE_STATES.includes(prepareRaw.status as PrepareStatus)
    ? (prepareRaw.status as PrepareStatus)
    : 'pending'
  // a preparation never survives a restart; "done" without its files must be redone
  if (prepareStatus === 'running') prepareStatus = 'pending'
  if (prepareStatus === 'done' && (!video.proxyPath || !video.spritePath)) prepareStatus = 'pending'
  const prepare: VideoStatus['prepare'] = {
    status: prepareStatus,
    progress:
      prepareStatus === 'done' ? 1 : prepareStatus === 'pending' ? 0 : fraction(prepareRaw.progress)
  }
  if (prepareStatus === 'error') {
    const stored =
      typeof prepareRaw.error === 'string' ? fromGermanBuild(prepareRaw.error) : undefined
    prepare.error = text(stored, JOB_MESSAGES.prepareFailed)
  }

  const stage = ALL_STAGES.includes(analysisRaw.stage as AnalysisStage)
    ? (analysisRaw.stage as AnalysisStage)
    : 'idle'
  const startedAt = isIso(analysisRaw.startedAt) ? analysisRaw.startedAt : undefined
  const finishedAt = isIso(analysisRaw.finishedAt) ? analysisRaw.finishedAt : undefined
  if (RUNNING_STAGES.includes(stage)) {
    return {
      prepare,
      analysis: {
        stage: 'cancelled',
        progress: 0,
        message: INTERRUPTED_MESSAGE,
        ...(startedAt ? { startedAt } : {})
      }
    }
  }
  const analysis: VideoStatus['analysis'] = {
    stage,
    progress: stage === 'done' ? 1 : fraction(analysisRaw.progress)
  }
  const message = typeof analysisRaw.message === 'string' && fromGermanBuild(analysisRaw.message)
  if (typeof message === 'string') analysis.message = message
  const error = typeof analysisRaw.error === 'string' && fromGermanBuild(analysisRaw.error)
  if (typeof error === 'string') analysis.error = error
  // older files have errors without a remedy: unknown, not guessed
  if (stage === 'error' && REMEDIES.includes(analysisRaw.remedy as AnalysisRemedy)) {
    analysis.remedy = analysisRaw.remedy as AnalysisRemedy
  }
  if (startedAt) analysis.startedAt = startedAt
  if (finishedAt) analysis.finishedAt = finishedAt
  return { prepare, analysis }
}

function normalizeAnalysis(raw: unknown, videoId: string, now: string): VideoAnalysis | null {
  if (!isRecord(raw) || typeof raw.briefHash !== 'string' || typeof raw.model !== 'string') {
    return null
  }
  return {
    videoId,
    model: raw.model,
    briefHash: raw.briefHash,
    createdAt: isIso(raw.createdAt) ? raw.createdAt : now
  }
}

function normalizeRemoteFile(raw: unknown): RemoteFileRef | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.uri !== 'string') return null
  // anything else was not written by an upload: dropped, the video is simply uploaded again
  if (!isGeminiFileName(raw.name) || !isGeminiFileUri(raw.uri)) return null
  return {
    name: raw.name,
    uri: raw.uri,
    mimeType: text(raw.mimeType, 'video/mp4'),
    expiresAt: isIso(raw.expiresAt) ? raw.expiresAt : null,
    proxyFingerprint: text(raw.proxyFingerprint, '')
  }
}

function normalizeMoment(raw: Raw, video: VideoInfo | undefined, id: string): Moment | null {
  if (!video || !isFiniteNumber(raw.start) || !isFiniteNumber(raw.end)) return null
  const start = clamp(raw.start, 0, video.durationSec)
  const end = clamp(raw.end, 0, video.durationSec)
  if (end - start < LIMITS.minMomentSec - 1e-9) return null
  // `origin` of older versions is not read: their own clips are clips like Gemini's now
  const moment: Moment = {
    id,
    videoId: video.id,
    start,
    end,
    title: text(raw.title, 'Moment'),
    reason: text(raw.reason, ''),
    score: isFiniteNumber(raw.score) ? clamp(Math.round(raw.score), 1, 10) : 5,
    selected: raw.selected === true
  }
  if (isFiniteNumber(raw.aiStart) && isFiniteNumber(raw.aiEnd) && raw.aiEnd > raw.aiStart) {
    moment.aiStart = clamp(raw.aiStart, 0, video.durationSec)
    moment.aiEnd = clamp(raw.aiEnd, 0, video.durationSec)
  }
  const before = isRecord(raw.autoTrimmedFrom) ? raw.autoTrimmedFrom : null
  if (before && isFiniteNumber(before.start) && isFiniteNumber(before.end)) {
    const from = {
      start: clamp(before.start, 0, video.durationSec),
      end: clamp(before.end, 0, video.durationSec)
    }
    if (from.end - from.start >= LIMITS.minMomentSec) moment.autoTrimmedFrom = from
  }
  return moment
}

function normalizeExport(raw: Raw, id: string, now: string): ExportRecord | null {
  if (typeof raw.path !== 'string' || !isAbsolute(raw.path)) return null
  return {
    id,
    path: raw.path,
    createdAt: isIso(raw.createdAt) ? raw.createdAt : now,
    durationSec: nonNegative(raw.durationSec, 0),
    clipCount: Math.round(nonNegative(raw.clipCount, 0)),
    sizeBytes: nonNegative(raw.sizeBytes, 0)
  }
}

/** keeps valid, unique ids; replaces missing or duplicate ones */
function uniqueIds(newId: () => string): (value: unknown) => string {
  const used = new Set<string>()
  return (value) => {
    const id = isValidId(value) && !used.has(value) ? value : newId()
    used.add(id)
    return id
  }
}

/**
 * Older builds hashed more than the trimmed prompt and the model: the clip lengths and the analysis
 * quality (options that are gone), the oldest ones the prompt as typed. An analysis made for exactly
 * the stored brief gets the current hash, so the update does not make every analysed video stale;
 * so does one made for the same prompt with other values of those options.
 */
function migrateLegacyHashes(
  analyses: Project['analyses'],
  brief: BriefSettings,
  storedBrief: unknown
): void {
  if (!isRecord(storedBrief)) return
  // only for a file that still holds the removed options – it is written back without them
  const hadOptions = 'analysisQuality' in storedBrief
  const anyOptions = new Map<string, Set<string>>()
  for (const analysis of Object.values(analyses)) {
    const { model } = analysis
    const current = briefHash(brief, model)
    if (analysis.briefHash === current) continue
    const legacy = legacyBriefHashes(brief.prompt, storedBrief, model)
    if (legacy.includes(analysis.briefHash)) analysis.briefHash = current
    else if (hadOptions) {
      if (!anyOptions.has(model)) anyOptions.set(model, legacyOptionHashes(brief.prompt, model))
      if (anyOptions.get(model)?.has(analysis.briefHash)) analysis.briefHash = current
    }
  }
}

/** Repairs a parsed project file. Throws for non-objects and for newer schema versions. */
export function normalizeProject(raw: unknown, ctx: NormalizeContext): Project {
  if (!isRecord(raw)) throw new Error('project file does not contain an object')
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION) {
    if (!isFiniteNumber(raw.schemaVersion) || raw.schemaVersion > SCHEMA_VERSION) {
      throw new UnsupportedProjectError(raw.schemaVersion)
    }
  }

  const videos: VideoInfo[] = []
  for (const entry of records(raw.videos)) {
    const video = normalizeVideo(entry)
    if (video && !videos.some((v) => v.id === video.id || v.path === video.path)) videos.push(video)
  }
  const byId = new Map(videos.map((video) => [video.id, video]))

  const statusRaw = isRecord(raw.status) ? raw.status : {}
  const analysesRaw = isRecord(raw.analyses) ? raw.analyses : {}
  const remoteRaw = isRecord(raw.remoteFiles) ? raw.remoteFiles : {}
  const status: Project['status'] = {}
  const analyses: Project['analyses'] = {}
  const remoteFiles: Project['remoteFiles'] = {}
  for (const video of videos) {
    status[video.id] = normalizeStatus(statusRaw[video.id], video)
    const analysis = normalizeAnalysis(analysesRaw[video.id], video.id, ctx.now)
    if (analysis) analyses[video.id] = analysis
    const remote = normalizeRemoteFile(remoteRaw[video.id])
    if (remote) remoteFiles[video.id] = remote
  }

  const momentIds = uniqueIds(ctx.newId)
  const moments: Moment[] = []
  for (const entry of records(raw.moments)) {
    const moment = normalizeMoment(entry, byId.get(entry.videoId as string), momentIds(entry.id))
    if (moment) moments.push(moment)
  }
  const exportIds = uniqueIds(ctx.newId)
  const exports: ExportRecord[] = []
  for (const entry of records(raw.exports)) {
    const record = normalizeExport(entry, exportIds(entry.id), ctx.now)
    if (record) exports.push(record)
  }

  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : ''
  const createdAt = isIso(raw.createdAt) ? raw.createdAt : ctx.now
  const brief = mergeBrief(DEFAULT_BRIEF, raw.brief, 'lenient')
  migrateLegacyHashes(analyses, brief, raw.brief)
  return {
    schemaVersion: SCHEMA_VERSION,
    id: ctx.id,
    name: name || DEFAULT_PROJECT_NAME,
    createdAt,
    updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : createdAt,
    videos,
    status,
    brief,
    analyses,
    remoteFiles,
    moments,
    // older files: the reel counts as automatic until the user edits it
    reelEdited: raw.reelEdited === true,
    exportSettings: mergeExportSettings(DEFAULT_EXPORT_SETTINGS, raw.exportSettings, 'lenient'),
    exports
  }
}
