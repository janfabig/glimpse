import { randomBytes } from 'node:crypto'

/** ids of projects, videos, moments and exports; also used as directory names */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function newId(): string {
  return randomBytes(8).toString('hex')
}

/**
 * ids also key plain objects (status, analyses, remoteFiles): "__proto__" would replace such an
 * object's prototype, and any other name Object.prototype has ("constructor", "toString", …) reads
 * its function where no entry exists, so those names are refused, and "prototype" with them
 */
export function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ID_PATTERN.test(value) &&
    !(value in Object.prototype) &&
    value !== 'prototype'
  )
}
