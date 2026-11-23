// userData layout (docs/ARCHITECTURE.md §4). Pure – the caller supplies the root directories.

import { isAbsolute, join, resolve } from 'node:path'
import { isValidId } from './ids'

export interface AppPaths {
  userData: string
  settingsFile: string
  apiKeyFile: string
  logsDir: string
  logFile: string
  projectsDir: string
  projectDir(projectId: string): string
  projectFile(projectId: string): string
  videoMediaDir(projectId: string, videoId: string): string
  posterFile(projectId: string, videoId: string): string
  proxyFile(projectId: string, videoId: string): string
  /** the lean copy of the proxy that is uploaded to Gemini */
  analysisFile(projectId: string, videoId: string): string
  spriteFile(projectId: string, videoId: string): string
  projectTmpDir(projectId: string): string
  exportWorkDir(projectId: string, exportId: string): string
}

/** ids become directory names – refuse anything that could escape the projects folder */
function safeId(id: string): string {
  if (!isValidId(id)) throw new Error(`invalid id for a path: ${JSON.stringify(id)}`)
  return id
}

export function createAppPaths(userData: string): AppPaths {
  const root = resolve(userData)
  const projectsDir = join(root, 'projects')
  const projectDir = (projectId: string): string => join(projectsDir, safeId(projectId))
  const videoMediaDir = (projectId: string, videoId: string): string =>
    join(projectDir(projectId), 'media', safeId(videoId))
  const projectTmpDir = (projectId: string): string => join(projectDir(projectId), 'tmp')
  return {
    userData: root,
    settingsFile: join(root, 'settings.json'),
    apiKeyFile: join(root, 'gemini-key.bin'),
    logsDir: join(root, 'logs'),
    logFile: join(root, 'logs', 'main.log'),
    projectsDir,
    projectDir,
    projectFile: (projectId) => join(projectDir(projectId), 'project.json'),
    videoMediaDir,
    posterFile: (projectId, videoId) => join(videoMediaDir(projectId, videoId), 'poster.jpg'),
    proxyFile: (projectId, videoId) => join(videoMediaDir(projectId, videoId), 'proxy.mp4'),
    analysisFile: (projectId, videoId) => join(videoMediaDir(projectId, videoId), 'analysis.mp4'),
    spriteFile: (projectId, videoId) => join(videoMediaDir(projectId, videoId), 'sprite.jpg'),
    projectTmpDir,
    exportWorkDir: (projectId, exportId) =>
      join(projectTmpDir(projectId), `export-${safeId(exportId)}`)
  }
}

export const OUTPUT_FOLDER_NAME = 'Glimpse'

/** HC_OUTPUT_DIR (tests) or ~/Movies/Glimpse */
export function resolveDefaultOutputDir(videosDir: string, env: NodeJS.ProcessEnv): string {
  const override = env.HC_OUTPUT_DIR?.trim()
  if (override && isAbsolute(override)) return resolve(override)
  return join(videosDir, OUTPUT_FOLDER_NAME)
}
