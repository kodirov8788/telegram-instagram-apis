import Link from 'next/link';
import { MessageSquare, Bot, BarChart3, ShieldCheck, Zap, Globe2 } from 'lucide-react';

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between p-8">
      {/* Navigation Header */}
      <header className="max-w-6xl mx-auto w-full flex items-center justify-between py-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-sky-500 flex items-center justify-center font-bold text-white shadow-lg shadow-sky-500/30 text-xl">
            Y
          </div>
          <div>
            <h1 className="font-extrabold text-lg leading-none">YDeck</h1>
            <span className="text-xs text-sky-400 font-medium">Telegram & Instagram AI Agent</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <Link href="/inbox" className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold text-sm transition shadow-md shadow-sky-600/20">
            Open Shared Inbox
          </Link>
          <Link href="/analytics" className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-sm transition">
            Analytics Dashboard
          </Link>
        </div>
      </header>

      {/* Hero Section */}
      <main className="max-w-4xl mx-auto text-center my-16 space-y-6">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-400 text-xs font-semibold">
          <Zap className="w-3.5 h-3.5" /> Next-Gen AI Customer Communication Platform
        </div>

        <h2 className="text-4xl md:text-6xl font-extrabold tracking-tight text-white leading-tight">
          Automate Telegram & Instagram Sales with Intelligent AI
        </h2>

        <p className="text-slate-400 text-lg max-w-2xl mx-auto">
          Respond to customer questions in <span className="text-sky-400 font-semibold">Uzbek</span>, <span className="text-purple-400 font-semibold">Russian</span>, and <span className="text-amber-400 font-semibold">English</span> in under 30 seconds. Seamlessly transfer complex conversations to human operators.
        </p>

        <div className="pt-6 flex justify-center gap-4">
          <Link href="/inbox" className="px-8 py-3.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-base transition shadow-xl shadow-sky-500/25">
            Launch Shared Inbox UI
          </Link>
          <Link href="/analytics" className="px-8 py-3.5 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-100 font-semibold text-base transition">
            View Analytics
          </Link>
        </div>
      </main>

      {/* Features Grid */}
      <section className="max-w-6xl mx-auto w-full grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
        <div className="p-6 rounded-2xl bg-slate-900/50 border border-slate-800 space-y-3">
          <div className="p-3 w-max rounded-xl bg-sky-500/10 text-sky-400">
            <Globe2 className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-lg">Multilingual RAG Engine</h3>
          <p className="text-slate-400 text-sm">Answers questions strictly using approved company knowledge base with zero hallucination.</p>
        </div>

        <div className="p-6 rounded-2xl bg-slate-900/50 border border-slate-800 space-y-3">
          <div className="p-3 w-max rounded-xl bg-purple-500/10 text-purple-400">
            <Bot className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-lg">AI & Human Control Modes</h3>
          <p className="text-slate-400 text-sm">Toggle between Automatic AI response, Approval draft mode, and instant Human takeover.</p>
        </div>

        <div className="p-6 rounded-2xl bg-slate-900/50 border border-slate-800 space-y-3">
          <div className="p-3 w-max rounded-xl bg-emerald-500/10 text-emerald-400">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-lg">Automated Handoff & Leads</h3>
          <p className="text-slate-400 text-sm">Automatically detects complaints, low confidence, and high-value purchase leads.</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="max-w-6xl mx-auto w-full py-6 border-t border-slate-800 text-center text-xs text-slate-500">
        YDeck AI Customer Communication Agent • MVP v1.0 Production System
      </footer>
    </div>
  );
}
