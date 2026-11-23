import { Clapperboard, CloudUpload, Download, Sparkles, type LucideIcon } from 'lucide-react'

const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: CloudUpload,
    title: 'Add videos',
    text: 'Drag the footage from your glasses into the window, up to 5 minutes per video.'
  },
  {
    icon: Sparkles,
    title: 'Write your prompt',
    text: 'Tell Gemini what to look for: drops, friends, fireworks…'
  },
  {
    icon: Clapperboard,
    title: 'Review the clips',
    text: 'Gemini suggests the best moments. You reorder and trim them as you like.'
  },
  {
    icon: Download,
    title: 'Export',
    text: 'Ready as a vertical 9:16 video or in any other format.'
  }
]

export function HowItWorks(): React.JSX.Element {
  return (
    <section className="home__section">
      <h2 className="h2">How it works</h2>
      <ol className="how">
        {STEPS.map(({ icon: Icon, title, text }, index) => (
          <li key={title} className="how__step">
            <span className="how__icon" aria-hidden>
              <Icon size={20} strokeWidth={2} />
            </span>
            <span className="how__num">Step {index + 1}</span>
            <strong className="how__title">{title}</strong>
            <span className="how__text">{text}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
