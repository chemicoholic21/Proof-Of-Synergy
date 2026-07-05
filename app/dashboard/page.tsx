"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import CareerDashboard from "@/components/memory/CareerDashboard";
import { getCandidateId, setCandidateName } from "@/lib/candidate";

const COMPANIES = ["", "Google", "Amazon", "Meta", "Stripe", "Microsoft", "Netflix", "Uber"];

function DashboardInner() {
  const params = useSearchParams();
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [company, setCompany] = useState<string>(params.get("company") ?? "");
  const [seeding, setSeeding] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setCandidateId(params.get("c") || getCandidateId());
  }, [params]);

  async function loadDemo() {
    setSeeding(true);
    try {
      const id = "demo-aarav";
      setCandidateName("Aarav Sharma", id);
      await fetch("/api/memory/seed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId: id, name: "Aarav Sharma" }) });
      setCandidateId(id);
      setReloadKey((k) => k + 1);
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div className="min-h-screen relative overflow-hidden">
      <div className="cyber-bg" />
      <div className="cyber-glow-1" />
      <div className="cyber-glow-2" />
      <main className="mx-auto w-full max-w-6xl px-6 sm:px-10 lg:px-16 py-10 relative z-10">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-300">← Interview</Link>
            <h1 className="heading-font text-3xl font-black text-white mt-1">Career Memory</h1>
            <p className="text-sm text-zinc-400">Persistent career intelligence, powered by Cognee.</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-zinc-500">Prep for</label>
            <select
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              className="rounded-lg border border-zinc-800 bg-black/40 px-3 py-1.5 text-sm text-zinc-200"
            >
              {COMPANIES.map((c) => (
                <option key={c} value={c}>
                  {c || "Any company"}
                </option>
              ))}
            </select>
            <button onClick={loadDemo} disabled={seeding} className="btn-ghost text-xs px-4 py-2 border-purple-500/30 text-purple-300 hover:bg-purple-950/20">
              {seeding ? "Seeding…" : "Load demo"}
            </button>
          </div>
        </div>

        {candidateId ? (
          <CareerDashboard key={`${candidateId}-${company}-${reloadKey}`} candidateId={candidateId} company={company || null} />
        ) : (
          <div className="glass-card p-8 text-center text-zinc-400">
            <p>No candidate memory found in this browser.</p>
            <button onClick={loadDemo} disabled={seeding} className="btn-primary mt-4 px-6 py-3 text-sm">
              {seeding ? "Loading demo…" : "Load the 6-month demo journey"}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen grid place-items-center text-zinc-500">Loading…</div>}>
      <DashboardInner />
    </Suspense>
  );
}
