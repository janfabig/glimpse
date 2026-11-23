/** Small version of the app icon (film frame, play button, highlight sparkle). Fixed colours like the
 * app icon: its own dark tile reads on both themes. */
export function AppMark({ size = 24 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="appmark-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2e2e2e" />
          <stop offset="1" stopColor="#0b0b0b" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="62" height="62" rx="15" fill="url(#appmark-bg)" />
      <rect
        x="1.5"
        y="1.5"
        width="61"
        height="61"
        rx="14.5"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.12"
      />
      <rect
        x="13"
        y="18"
        width="34"
        height="27"
        rx="6"
        fill="none"
        stroke="#c5f03c"
        strokeWidth="3.4"
      />
      <path
        d="M27 25.5v12l9.5-6z"
        fill="#c5f03c"
        stroke="#c5f03c"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M50 8c.6 3.6 1.5 4.5 5 5-3.5.6-4.4 1.5-5 5-.6-3.5-1.5-4.4-5-5 3.5-.5 4.4-1.4 5-5z"
        fill="#fff"
      />
    </svg>
  )
}
