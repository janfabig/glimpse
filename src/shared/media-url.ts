// URLs for local media files served to the renderer by the privileged `hc-media:` protocol (see main/core).

export const MEDIA_SCHEME = 'hc-media'
const PREFIX = `${MEDIA_SCHEME}://local/`

/** absolute file path → hc-media://local/<encoded path> */
export function mediaUrl(absolutePath: string): string {
  return PREFIX + encodeURIComponent(absolutePath)
}
