import { describe, expect, it } from 'vitest'
import { estimateExportBytes, outputSize } from './export-size'

const portrait = { width: 1440, height: 1920 }
const landscape = { width: 1920, height: 1080 }

describe('outputSize', () => {
  it('derives the 4K frame from the aspect (short side 2160, even dimensions)', () => {
    expect(outputSize('9:16', portrait)).toEqual({ width: 2160, height: 3840 })
    expect(outputSize('4:5', portrait)).toEqual({ width: 2160, height: 2700 })
    expect(outputSize('1:1', portrait)).toEqual({ width: 2160, height: 2160 })
    expect(outputSize('16:9', portrait)).toEqual({ width: 3840, height: 2160 })
    expect(outputSize('source', portrait)).toEqual({ width: 2160, height: 2880 })
    expect(outputSize('source', landscape)).toEqual({ width: 3840, height: 2160 })
  })

  it('shows the frame media renders for odd source sizes', () => {
    expect(outputSize('source', { width: 1474, height: 1440 })).toEqual({
      width: 2212,
      height: 2160
    })
    // multiplied first: 2160 × (962 / 864) would give 2404.99… and round to 2404
    expect(outputSize('source', { width: 962, height: 864 })).toEqual({ width: 2406, height: 2160 })
    for (const source of [portrait, landscape, { width: 1279, height: 721 }]) {
      for (const aspect of ['source', '9:16', '4:5', '1:1', '16:9'] as const) {
        const { width, height } = outputSize(aspect, source)
        expect([width % 2, height % 2], `${aspect} of ${source.width}×${source.height}`).toEqual([
          0, 0
        ])
      }
    }
  })

  it('assumes 3:4 for "source" while no video is known', () => {
    expect(outputSize('source', null)).toEqual({ width: 2160, height: 2880 })
  })
})

describe('estimateExportBytes', () => {
  it('estimates a 4K minute at about 50 Mbit/s and grows with frame and length', () => {
    const size = estimateExportBytes('9:16', portrait, 60)
    // 2160 × 3840 × 30 fps × 0.2 bit per pixel + 192 kbit/s audio
    expect(size).toBe(Math.ceil(((2160 * 3840 * 30 * 0.2 + 192_000) * 60) / 8))
    expect(size).toBeGreaterThan(350e6)
    expect(size).toBeLessThan(400e6)
    expect(estimateExportBytes('1:1', portrait, 60)).toBeLessThan(size)
    expect(estimateExportBytes('9:16', portrait, 120)).toBeGreaterThan(size)
    expect(estimateExportBytes('9:16', portrait, -5)).toBe(0)
  })
})
