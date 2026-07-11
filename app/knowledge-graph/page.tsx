"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SkillGraphExplorer from "@/components/knowledge-graph/SkillGraphExplorer";
import { getLearnerId } from "@/lib/learner";

export default function KnowledgeGraphPage() {
  const [learnerId, setLearnerId] = useState("anon");

  useEffect(() => {
    setLearnerId(getLearnerId());
  }, []);

  return (
    <div className="min-h-screen relative overflow-hidden bg-background">
      <div className="absolute inset-0 -z-10 cyber-bg" />

      <main className="mx-auto w-full max-w-6xl px-6 sm:px-10 lg:px-16 py-10 relative z-10">
        <header className="mb-10">
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

        <div className="mb-8">
          <span className="text-[11px] uppercase tracking-[0.25em] text-ink-soft">Cognee Skill Knowledge Graph</span>
          <h1 className="heading-font mt-3 text-[2.25rem] leading-[1.05] tracking-tight text-ink sm:text-[3rem]">
            Your Skill Graph
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-ink-soft sm:text-[17px]">
            Every practice session is captured here. Skills, communication patterns and coaching moments
            build into a persistent graph that remembers across visits and helps you target what to practise next.
          </p>
        </div>

        <SkillGraphExplorer learnerId={learnerId} />
      </main>
    </div>
  );
}
