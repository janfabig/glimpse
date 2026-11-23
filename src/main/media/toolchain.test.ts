import { describe, expect, it, vi } from 'vitest'
import type { ResolveDeps } from './toolchain'
import {
  appFfmpegDirs,
  createToolchainLoader,
  parseEncoderNames,
  parseFfmpegVersion,
  parseHwaccelNames,
  parseShellLookup,
  resolveBinaries
} from './toolchain'

function fakeDeps(
  executables: string[],
  shell: Record<string, string> = {}
): ResolveDeps & {
  lookups: () => number
} {
  let lookups = 0
  return {
    isExecutable: async (path) => executables.includes(path),
    loginShellLookup: async () => {
      lookups++
      return shell
    },
    lookups: () => lookups
  }
}

describe('resolveBinaries', () => {
  it('prefers explicit options over the environment and Homebrew', async () => {
    const deps = fakeDeps(['/x/ffmpeg', '/x/ffprobe', '/e/ffmpeg', '/opt/homebrew/bin/ffmpeg'])
    const resolved = await resolveBinaries(
      { ffmpegPath: '/x/ffmpeg', ffprobePath: '/x/ffprobe' },
      { HC_FFMPEG: '/e/ffmpeg' },
      deps
    )
    expect(resolved).toEqual({ ffmpeg: '/x/ffmpeg', ffprobe: '/x/ffprobe' })
  })

  it('uses HC_FFMPEG/HC_FFPROBE next', async () => {
    const deps = fakeDeps(['/e/ffmpeg', '/e2/ffprobe', '/opt/homebrew/bin/ffmpeg'])
    expect(
      await resolveBinaries({}, { HC_FFMPEG: '/e/ffmpeg', HC_FFPROBE: '/e2/ffprobe' }, deps)
    ).toEqual({
      ffmpeg: '/e/ffmpeg',
      ffprobe: '/e2/ffprobe'
    })
  })

  it('treats an explicit but missing binary as not found', async () => {
    const deps = fakeDeps(['/opt/homebrew/bin/ffmpeg', '/opt/homebrew/bin/ffprobe'])
    expect(await resolveBinaries({ ffmpegPath: '/nope/ffmpeg' }, {}, deps)).toEqual({
      ffmpeg: null,
      ffprobe: '/opt/homebrew/bin/ffprobe'
    })
  })

  it('finds ffprobe next to a custom ffmpeg', async () => {
    const deps = fakeDeps(['/custom/ffmpeg', '/custom/ffprobe', '/opt/homebrew/bin/ffprobe'])
    expect(await resolveBinaries({}, { HC_FFMPEG: '/custom/ffmpeg' }, deps)).toEqual({
      ffmpeg: '/custom/ffmpeg',
      ffprobe: '/custom/ffprobe'
    })
  })

  it('searches /opt/homebrew/bin, then /usr/local/bin, then the login shell PATH', async () => {
    expect(
      await resolveBinaries(
        {},
        {},
        fakeDeps(['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/opt/homebrew/bin/ffprobe'])
      )
    ).toEqual({ ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: '/opt/homebrew/bin/ffprobe' })
    expect(
      await resolveBinaries({}, {}, fakeDeps(['/usr/local/bin/ffmpeg', '/usr/local/bin/ffprobe']))
    ).toEqual({ ffmpeg: '/usr/local/bin/ffmpeg', ffprobe: '/usr/local/bin/ffprobe' })

    const shellOnly = fakeDeps(['/nix/bin/ffmpeg', '/nix/bin/ffprobe'], {
      ffmpeg: '/nix/bin/ffmpeg',
      ffprobe: '/nix/bin/ffprobe'
    })
    expect(await resolveBinaries({}, {}, shellOnly)).toEqual({
      ffmpeg: '/nix/bin/ffmpeg',
      ffprobe: '/nix/bin/ffprobe'
    })
    expect(shellOnly.lookups()).toBe(1)
  })

  it('returns null when nothing is installed', async () => {
    expect(await resolveBinaries({}, {}, fakeDeps([]))).toEqual({ ffmpeg: null, ffprobe: null })
  })

  it('development: the repo’s vendor/ffmpeg comes after the environment and before Homebrew', async () => {
    const everywhere = [
      '/e/ffmpeg',
      '/e/ffprobe',
      '/repo/vendor/ffmpeg/ffmpeg',
      '/repo/vendor/ffmpeg/ffprobe',
      '/opt/homebrew/bin/ffmpeg',
      '/opt/homebrew/bin/ffprobe'
    ]
    const vendorDir = '/repo/vendor/ffmpeg'
    const deps = fakeDeps(everywhere)
    expect(await resolveBinaries({ vendorDir }, {}, deps)).toEqual({
      ffmpeg: '/repo/vendor/ffmpeg/ffmpeg',
      ffprobe: '/repo/vendor/ffmpeg/ffprobe'
    })
    expect(deps.lookups()).toBe(0)
    expect(
      await resolveBinaries(
        { vendorDir },
        { HC_FFMPEG: '/e/ffmpeg', HC_FFPROBE: '/e/ffprobe' },
        deps
      )
    ).toEqual({ ffmpeg: '/e/ffmpeg', ffprobe: '/e/ffprobe' })
    // not fetched yet: Homebrew as before
    expect(
      await resolveBinaries(
        { vendorDir },
        {},
        fakeDeps(['/opt/homebrew/bin/ffmpeg', '/opt/homebrew/bin/ffprobe'])
      )
    ).toEqual({ ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: '/opt/homebrew/bin/ffprobe' })
  })

  describe('the packaged app (bundledDir)', () => {
    const bundledDir = '/Applications/Glimpse.app/Contents/Resources/ffmpeg'
    const own = { ffmpeg: `${bundledDir}/ffmpeg`, ffprobe: `${bundledDir}/ffprobe` }
    const elsewhere = [
      '/x/ffmpeg',
      '/x/ffprobe',
      '/e/ffmpeg',
      '/e/ffprobe',
      '/repo/vendor/ffmpeg/ffmpeg',
      '/repo/vendor/ffmpeg/ffprobe',
      '/opt/homebrew/bin/ffmpeg',
      '/opt/homebrew/bin/ffprobe',
      '/usr/local/bin/ffmpeg',
      '/usr/local/bin/ffprobe',
      '/nix/bin/ffmpeg',
      '/nix/bin/ffprobe'
    ]
    const shell = { ffmpeg: '/nix/bin/ffmpeg', ffprobe: '/nix/bin/ffprobe' }
    // everything that could name another ffmpeg
    const options = {
      bundledDir,
      vendorDir: '/repo/vendor/ffmpeg',
      ffmpegPath: '/x/ffmpeg',
      ffprobePath: '/x/ffprobe'
    }
    const env = { HC_FFMPEG: '/e/ffmpeg', HC_FFPROBE: '/e/ffprobe' }

    it('uses its own copy, whatever the options, the environment and the Mac offer', async () => {
      const deps = fakeDeps([...elsewhere, own.ffmpeg, own.ffprobe], shell)
      expect(await resolveBinaries(options, env, deps)).toEqual(own)
      expect(deps.lookups()).toBe(0)
    })

    it('uses nothing else when its own copy is missing', async () => {
      const deps = fakeDeps(elsewhere, shell)
      expect(await resolveBinaries(options, env, deps)).toEqual({ ffmpeg: null, ffprobe: null })
      // one of the two is gone: the other is not taken from the Mac either
      const half = fakeDeps([...elsewhere, own.ffmpeg], shell)
      expect(await resolveBinaries(options, env, half)).toEqual({
        ffmpeg: own.ffmpeg,
        ffprobe: null
      })
      expect(deps.lookups() + half.lookups()).toBe(0)
    })
  })
})

describe('appFfmpegDirs', () => {
  const paths = { resourcesPath: '/A/Glimpse.app/Contents/Resources', appPath: '/repo' }

  it('the packaged app looks only inside itself', () => {
    expect(appFfmpegDirs({ isPackaged: true, ...paths })).toEqual({
      bundledDir: '/A/Glimpse.app/Contents/Resources/ffmpeg'
    })
  })

  it('development and E2E get the repo’s vendor/ffmpeg', () => {
    expect(appFfmpegDirs({ isPackaged: false, ...paths })).toEqual({
      vendorDir: '/repo/vendor/ffmpeg'
    })
  })
})

describe('parsers', () => {
  it('parseShellLookup ignores profile noise', () => {
    const output = 'Welcome back!\n/opt/homebrew/bin/ffmpeg\nffprobe not found\n'
    expect(parseShellLookup(output, ['ffmpeg', 'ffprobe'])).toEqual({
      ffmpeg: '/opt/homebrew/bin/ffmpeg'
    })
  })

  it('parseFfmpegVersion', () => {
    expect(
      parseFfmpegVersion('ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers')
    ).toBe('9.0.2')
    expect(parseFfmpegVersion('ffmpeg version n7.1-24-gabc Copyright')).toBe('n7.1-24-gabc')
    // the build the app ships appends its maker's address: Settings shows the plain version
    expect(
      parseFfmpegVersion('ffmpeg version 9.0.2-https://www.martin-riedl.de Copyright (c) 2000-2026')
    ).toBe('9.0.2')
    expect(parseFfmpegVersion('garbage')).toBeNull()
  })

  it('parseEncoderNames reads the table after the separator', () => {
    const output = [
      'Encoders:',
      ' V..... = Video',
      ' A..... = Audio',
      ' ------',
      ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC',
      ' V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)',
      ' A....D aac                  AAC (Advanced Audio Coding)'
    ].join('\n')
    expect([...parseEncoderNames(output)]).toEqual(['libx264', 'h264_videotoolbox', 'aac'])
  })

  it('parseHwaccelNames', () => {
    expect([...parseHwaccelNames('Hardware acceleration methods:\nvideotoolbox\n\n')]).toEqual([
      'videotoolbox'
    ])
    expect([...parseHwaccelNames('Hardware acceleration methods:\n')]).toEqual([])
  })
})

describe('createToolchainLoader', () => {
  it('development: names the command that fetches a missing ffmpeg', async () => {
    const loader = createToolchainLoader({ env: {} }, fakeDeps([]))
    expect(await loader.status()).toEqual({
      ok: false,
      ffmpegPath: null,
      ffprobePath: null,
      version: null,
      hardwareEncoders: [],
      error: 'ffmpeg was not found. In the project folder, run: node scripts/fetch-ffmpeg.mjs'
    })
    await expect(loader.ready()).rejects.toMatchObject({ code: 'no-ffmpeg', name: 'MediaError' })
  })

  it('the packaged app: a missing or broken own ffmpeg means a damaged app, no command', async () => {
    const bundledDir = '/nowhere/Glimpse.app/Contents/Resources/ffmpeg'
    const damaged =
      'Glimpse is damaged: the ffmpeg inside the app is missing or does not start. ' +
      'Replace the app with a fresh copy of Glimpse.'
    const missing = createToolchainLoader({ bundledDir, env: {} }, fakeDeps([]))
    expect(await missing.status()).toMatchObject({ ok: false, ffmpegPath: null, error: damaged })
    await expect(missing.ready()).rejects.toMatchObject({ code: 'no-ffmpeg', message: damaged })
    // "executable", but the files cannot be started
    const broken = createToolchainLoader(
      { bundledDir, env: {} },
      fakeDeps([`${bundledDir}/ffmpeg`, `${bundledDir}/ffprobe`])
    )
    expect(await broken.status()).toMatchObject({
      ok: false,
      ffmpegPath: `${bundledDir}/ffmpeg`,
      ffprobePath: `${bundledDir}/ffprobe`,
      error: damaged
    })
  })

  it('retries detection after a failure (e.g. ffmpeg installed while the app runs)', async () => {
    const executables: string[] = []
    const deps: ResolveDeps = {
      isExecutable: vi.fn(async (path: string) => executables.includes(path)),
      loginShellLookup: async () => ({})
    }
    const loader = createToolchainLoader(
      { ffmpegPath: '/x/ffmpeg', ffprobePath: '/x/ffprobe' },
      deps
    )
    expect((await loader.status()).ok).toBe(false)
    executables.push('/x/ffmpeg')
    await loader.status()
    expect(deps.isExecutable).toHaveBeenCalledWith('/x/ffmpeg')
    expect(vi.mocked(deps.isExecutable).mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('flags a binary that exists but cannot run', async () => {
    const loader = createToolchainLoader(
      { ffmpegPath: '/usr/bin/false', ffprobePath: '/usr/bin/false', hardwareAcceleration: false },
      fakeDeps(['/usr/bin/false'])
    )
    const status = await loader.status()
    expect(status.ok).toBe(false)
    expect(status.error).toBe(
      'ffmpeg was found but does not start. In the project folder, run: node scripts/fetch-ffmpeg.mjs'
    )
  })
})
