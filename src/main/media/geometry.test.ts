import { describe, expect, it } from 'vitest'
import { evenFloor, evenRound, fitShortSide, sameAspect, targetSize } from './geometry'

const isEven = (n: number): boolean => n % 2 === 0

describe('even helpers', () => {
  it('round to even numbers ≥ 2', () => {
    expect(evenRound(959)).toBe(960)
    expect(evenRound(213.3)).toBe(214)
    expect(evenRound(0.4)).toBe(2)
    expect(evenFloor(641)).toBe(640)
    expect(evenFloor(1)).toBe(2)
  })
})

describe('fitShortSide (proxy size)', () => {
  it.each([
    [
      { width: 1440, height: 1920 },
      { width: 720, height: 960 }
    ],
    [
      { width: 1080, height: 1920 },
      { width: 720, height: 1280 }
    ],
    [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 }
    ],
    [
      { width: 3840, height: 2160 },
      { width: 1280, height: 720 }
    ],
    [
      { width: 2203, height: 2938 },
      { width: 720, height: 960 }
    ],
    [
      { width: 1000, height: 1000 },
      { width: 720, height: 720 }
    ]
  ])('%o → %o', (input, expected) => {
    expect(fitShortSide(input, 720)).toEqual(expected)
  })

  it('never upscales and keeps dimensions even', () => {
    expect(fitShortSide({ width: 640, height: 360 }, 720)).toEqual({ width: 640, height: 360 })
    expect(fitShortSide({ width: 641, height: 361 }, 720)).toEqual({ width: 640, height: 360 })
    expect(fitShortSide({ width: 720, height: 1279 }, 720)).toEqual({ width: 720, height: 1278 })
  })

  it('rejects invalid sizes', () => {
    expect(() => fitShortSide({ width: 0, height: 100 }, 720)).toThrow()
  })
})

describe('targetSize', () => {
  const portrait = { width: 1440, height: 1920 }
  const landscape = { width: 1920, height: 1080 }

  it.each([
    ['9:16', { width: 2160, height: 3840 }],
    ['4:5', { width: 2160, height: 2700 }],
    ['1:1', { width: 2160, height: 2160 }],
    ['16:9', { width: 3840, height: 2160 }]
  ] as const)('%s → %o (4K, whatever the source)', (aspect, size) => {
    expect(targetSize(aspect, landscape, 2160)).toEqual(size)
  })

  it('takes the short side from the caller (the tests render small frames)', () => {
    expect(targetSize('9:16', landscape, 360)).toEqual({ width: 360, height: 640 })
    expect(targetSize('16:9', portrait, 360)).toEqual({ width: 640, height: 360 })
    expect(targetSize('source', portrait, 360)).toEqual({ width: 360, height: 480 })
  })

  it.each([
    [portrait, { width: 2160, height: 2880 }],
    [landscape, { width: 3840, height: 2160 }],
    [
      { width: 1000, height: 1000 },
      { width: 2160, height: 2160 }
    ],
    [
      { width: 1920, height: 817 },
      { width: 5076, height: 2160 }
    ]
  ])('source for %o → %o', (source, size) => {
    expect(targetSize('source', source, 2160)).toEqual(size)
  })

  it('always yields even dimensions', () => {
    for (const source of [
      portrait,
      landscape,
      { width: 1279, height: 721 },
      { width: 333, height: 777 }
    ]) {
      for (const aspect of ['source', '9:16', '4:5', '1:1', '16:9'] as const) {
        for (const shortSide of [2160, 360, 250]) {
          const { width, height } = targetSize(aspect, source, shortSide)
          expect(isEven(width) && isEven(height)).toBe(true)
        }
      }
    }
  })

  it('rejects an invalid source size for "source"', () => {
    expect(() => targetSize('source', { width: 0, height: 0 }, 2160)).toThrow('Invalid video size')
  })
})

describe('sameAspect', () => {
  it('compares with a relative tolerance', () => {
    expect(sameAspect({ width: 1080, height: 1920 }, { width: 720, height: 1280 })).toBe(true)
    expect(sameAspect({ width: 1440, height: 1920 }, { width: 720, height: 1280 })).toBe(false)
  })
})
