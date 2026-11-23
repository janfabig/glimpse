// Imported first by src/main/index.ts so the userData override, the app name and the start-up
// hardening (debug switches, TLS override) are in place before any other module (or Electron
// itself) touches the profile or the network.

import { app } from 'electron'
import {
  applyAppIdentity,
  LEGACY_APP_NAME,
  moveLegacyUserData,
  stripDebugSwitches
} from './appIdentity'

/** the HC_USER_DATA_DIR profile in use, or null for the user's real profile */
export const userDataOverride = applyAppIdentity(app, process.env)

/** the projects of the app's former name moved over at this start (index.ts logs it) */
export const movedLegacyData = userDataOverride === null && moveLegacy(app.getPath('userData'))

function moveLegacy(userData: string): boolean {
  try {
    return moveLegacyUserData(userData)
  } catch (err) {
    // the app still starts; the old folder keeps whatever did not move
    console.error(`Glimpse: could not move the data of the former name ${LEGACY_APP_NAME}`, err)
    return false
  }
}

// not tied to HC_E2E: any program that starts the packaged app can set an environment variable
if (!stripDebugSwitches(app.commandLine, { packaged: app.isPackaged })) {
  console.error('Glimpse: debug and launcher switches are not allowed in the packaged app')
  process.exit(1)
}
// Node reads it on every TLS connect: another program could set it and read the key via a proxy
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
