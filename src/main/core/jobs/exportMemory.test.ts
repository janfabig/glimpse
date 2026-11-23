import { describe, expect, it } from 'vitest'
import { exportMemoryBytes, memoryBudget } from './exportMemory'

const GIB = 1024 ** 3
const MIB = 1024 ** 2
const portrait4k = { width: 2160, height: 3840 }

describe('exportMemoryBytes', () => {
  it('is the encoder for hard cuts, and two open clips more for a crossfade', () => {
    // no ffmpeg run of an export opens more than two clips: the number of clips does not count
    expect(exportMemoryBytes(portrait4k, false)).toBe(2400 * MIB)
    expect(exportMemoryBytes(portrait4k, true)).toBe(2700 * MIB)
    expect(exportMemoryBytes(portrait4k, true)).toBeLessThanOrEqual(memoryBudget(8 * GIB))
  })

  it('scales with the pixels of the frame', () => {
    expect(exportMemoryBytes({ width: 3840, height: 2160 }, false)).toBe(2400 * MIB)
    expect(exportMemoryBytes({ width: 2160, height: 2160 }, true)).toBe(2700 * MIB * 0.5625)
    expect(exportMemoryBytes({ width: 1080, height: 1920 }, false)).toBe(600 * MIB)
  })
})

describe('memoryBudget', () => {
  it('is half of the RAM', () => {
    expect(memoryBudget(8 * GIB)).toBe(4 * GIB)
  })
})
