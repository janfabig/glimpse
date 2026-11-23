import { LIMITS } from '@shared/presets'
import { describe, expect, it } from 'vitest'
import {
  absolutePathArg,
  mutationArg,
  optionalApiKeyArg,
  optionalNameArg,
  pathListArg,
  projectIdArg,
  settingsPatchArg,
  startAnalysisOptionsArg,
  urlArg,
  videoIdArg,
  wishArg
} from './validate'

const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `/v/${i}.mp4`)
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `v${i}`)

describe('IPC argument validation', () => {
  // one row per check: deleting any check in validate.ts turns a row red
  it.each([
    ['projectIdArg', 42, 'project', projectIdArg],
    ['projectIdArg', '../etc', 'project', projectIdArg],
    ['projectIdArg', 'a'.repeat(65), 'project', projectIdArg],
    ['videoIdArg', '', 'video', videoIdArg],
    ['videoIdArg', '__proto__', 'video', videoIdArg],
    ['projectIdArg', 'constructor', 'project', projectIdArg],
    ['videoIdArg', 'toString', 'video', videoIdArg],
    // openOriginal: the renderer names a video, never the path of the file to open
    ['videoIdArg', '/Users/demo/Movies/a.mp4', 'video', videoIdArg],
    ['absolutePathArg', 'relative/a.mp4', 'path', absolutePathArg],
    ['absolutePathArg', ['/a.mp4'], 'path', absolutePathArg],
    ['absolutePathArg', '/a\0.mp4', 'path', absolutePathArg],
    ['absolutePathArg', '/' + 'a'.repeat(4096), 'path', absolutePathArg],
    ['pathListArg', '/a.mp4', 'files', pathListArg],
    ['pathListArg', paths(501), 'files', pathListArg],
    ['pathListArg', ['/a.mp4', ''], 'files', pathListArg],
    ['optionalNameArg', { name: 'x' }, 'name', optionalNameArg],
    ['optionalApiKeyArg', 42, 'API key', optionalApiKeyArg],
    ['optionalApiKeyArg', 'k'.repeat(513), 'API key', optionalApiKeyArg],
    ['startAnalysisOptionsArg', 'all', 'analysis', startAnalysisOptionsArg],
    ['startAnalysisOptionsArg', { videoIds: 'all' }, 'videos', startAnalysisOptionsArg],
    ['startAnalysisOptionsArg', { videoIds: ids(501) }, 'videos', startAnalysisOptionsArg],
    ['startAnalysisOptionsArg', { videoIds: ['../x'] }, 'video', startAnalysisOptionsArg],
    ['startAnalysisOptionsArg', { force: 'yes' }, 'analysis', startAnalysisOptionsArg],
    ['wishArg', undefined, 'note', wishArg],
    ['wishArg', ['More crowd.'], 'note', wishArg],
    ['wishArg', ' \n\t ', 'note', wishArg],
    ['wishArg', 'x'.repeat(LIMITS.promptMax + 1), 'note', wishArg],
    ['settingsPatchArg', 'nope', 'settings', settingsPatchArg],
    ['mutationArg', Object.assign([], { type: 'rename' }), 'change', mutationArg],
    ['mutationArg', { type: 7 }, 'change', mutationArg],
    ['mutationArg', { type: 'x'.repeat(41) }, 'change', mutationArg],
    ['urlArg', 42, 'link', urlArg],
    ['urlArg', 'https://x/' + 'a'.repeat(2039), 'link', urlArg]
  ] as const)('%s rejects %j', (_name, value, what, parse) => {
    expect(() => (parse as (v: unknown) => unknown)(value)).toThrow(
      expect.objectContaining({ code: 'invalid', userMessage: `Invalid request. (${what})` })
    )
  })

  it('accepts values right at the limits and keeps only what is allowed', () => {
    expect(projectIdArg('a'.repeat(64))).toBe('a'.repeat(64))
    expect(absolutePathArg('/a/../b.mp4')).toBe('/b.mp4')
    expect(absolutePathArg('/' + 'a'.repeat(4095))).toHaveLength(4096)
    expect(pathListArg([...paths(499), 'relative.mp4'])).toHaveLength(500)
    // 80 characters, not 80 UTF-16 units: no emoji is cut in half
    expect(optionalNameArg('  ' + '🎉'.repeat(90))).toBe('🎉'.repeat(80))
    expect(optionalNameArg('   ')).toBeUndefined()
    expect(optionalApiKeyArg(' ' + 'k'.repeat(510) + ' ')).toBe('k'.repeat(510))
    expect(startAnalysisOptionsArg(null)).toBeUndefined()
    expect(startAnalysisOptionsArg({ videoIds: ids(500), force: true, extra: 1 })).toEqual({
      videoIds: ids(500),
      force: true
    })
    expect(wishArg('  More crowd.\nLess stage. \n')).toBe('More crowd.\nLess stage.')
    expect(wishArg('x'.repeat(LIMITS.promptMax))).toHaveLength(LIMITS.promptMax)
    // what gets trimmed away does not count, as in the dialog (wishProblem)
    expect(wishArg(`${'x'.repeat(LIMITS.promptMax)}${'\n'.repeat(500)}`)).toHaveLength(
      LIMITS.promptMax
    )
    const inherited = Object.create({ apiKey: 'inherited' }) as Record<string, unknown>
    expect(
      settingsPatchArg(Object.assign(inherited, { model: 'm', x: 1, defaultOutputDir: undefined }))
    ).toStrictEqual({ model: 'm' })
    expect(mutationArg({ type: 'x'.repeat(40) })).toEqual({ type: 'x'.repeat(40) })
    expect(urlArg('https://x/' + 'a'.repeat(2038))).toHaveLength(2048)
  })
})
