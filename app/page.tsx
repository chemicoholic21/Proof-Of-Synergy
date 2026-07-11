"use client";

import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen relative overflow-hidden bg-background">
      <div className="absolute inset-0 -z-10 cyber-bg" />

      <main className="mx-auto w-full max-w-6xl px-6 sm:px-10 lg:px-16 py-10 relative z-10">
        <Header />

        <section className="step-container py-10 sm:py-16">
          <div className="fade-up flex items-center gap-3">
            <span className="h-px w-8 bg-accent/60 hairline-grow" />
            <span className="text-[11px] uppercase tracking-[0.25em] text-ink-soft">
              Proof of Synergy 2.0 · AI Communication Gym
            </span>
          </div>

          <h1 className="heading-font mt-8 block text-[2.5rem] leading-[1.06] tracking-tight text-ink sm:text-[3.5rem] lg:text-[4rem]">
            A gym for how you communicate.
          </h1>

          <p className="fade-up mt-8 max-w-2xl text-base leading-relaxed text-ink-soft sm:text-[17px]">
            Rehearse real conversations with AI partners. Speak naturally in your own language - Sarvam
            transcribes and reads aloud, Gemini holds the conversation, Gemma coaches you in real time,
            and your growth is captured in a Cognee Skill Knowledge Graph that remembers across sessions.
          </p>

          <div className="fade-up mt-9 flex flex-col gap-3 sm:flex-row" style={{ animationDelay: "740ms" }}>
            <Link href="/practice" className="btn-primary px-8 py-3.5 text-base flex items-center justify-center gap-2 w-fit">
              <span>Enter the gym</span>
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
              </svg>
            </Link>
            <Link href="/knowledge-graph" className="btn-ghost px-8 py-3.5 text-base flex items-center justify-center gap-2 w-fit">
              View Skill Knowledge Graph
            </Link>
          </div>

          <div className="mt-16 grid gap-px overflow-hidden border-t border-line sm:grid-cols-3">
            {[
              { k: "Gemini", t: "Live conversation", d: "A realistic partner that adapts to your scenario and pushes back gently." },
              { k: "Gemma", t: "Local coaching", d: "Real-time feedback on fillers, hesitation, structure and confidence." },
              { k: "Cognee", t: "Skill graph", d: "Your communication growth is remembered and builds across every session." },
            ].map((f, i) => (
              <div
                key={f.k}
                className="fade-up border-line pt-5 sm:pr-6 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:pl-6"
                style={{ animationDelay: `${860 + i * 110}ms` }}
              >
                <div className="font-mono text-[11px] tracking-tight text-accent">{f.k}</div>
                <h3 className="heading-font mt-2 text-lg text-ink">{f.t}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{f.d}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function Header() {
  return (
    <header className="mb-6">
      <div className="flex items-center justify-between gap-4 border-b border-line pb-5">
        <Link href="/" className="heading-font text-lg tracking-tight text-ink hover:text-white transition-colors">
          Proof of Synergy
        </Link>
        <nav className="flex items-center gap-5 text-sm">
          <Link href="/practice" className="text-ink border-b border-transparent hover:border-accent pb-0.5 transition-colors">
            Practice
          </Link>
          <Link href="/knowledge-graph" className="text-ink-soft border-b border-transparent hover:border-accent pb-0.5 transition-colors">
            Skill Graph <span className="text-ink-soft">→</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}
