'use client';

import React from 'react';
import { BarChart3, Clock, CheckCircle2, UserX, Download, ArrowUpRight, TrendingUp } from 'lucide-react';

export default function AnalyticsPage() {
  const metrics = [
    { label: 'Total Conversations', value: '1,248', change: '+14%', icon: BarChart3, color: 'text-sky-400' },
    { label: 'Avg First-Response Time', value: '12s', change: '-40%', icon: Clock, color: 'text-emerald-400' },
    { label: 'AI Resolution Rate', value: '68%', change: '+8%', icon: CheckCircle2, color: 'text-purple-400' },
    { label: 'Human Handoff Rate', value: '18%', change: '-3%', icon: UserX, color: 'text-rose-400' },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Analytics & Performance Dashboard</h1>
          <p className="text-slate-400 text-sm">Real-time metrics across Telegram & Instagram AI channels</p>
        </div>

        <a
          href="/api/leads/export"
          download
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium text-sm transition shadow-lg shadow-sky-600/20"
        >
          <Download className="w-4 h-4" /> Export Qualified Leads (CSV)
        </a>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        {metrics.map((m, idx) => {
          const Icon = m.icon;
          return (
            <div key={idx} className="bg-slate-900/60 border border-slate-800 p-6 rounded-2xl flex flex-col justify-between">
              <div className="flex items-center justify-between mb-4">
                <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider">{m.label}</span>
                <div className={`p-2.5 rounded-xl bg-slate-800 ${m.color}`}>
                  <Icon className="w-5 h-5" />
                </div>
              </div>
              <div>
                <span className="text-3xl font-extrabold text-white">{m.value}</span>
                <span className="ml-2 text-xs font-semibold text-emerald-400 flex items-center inline-flex">
                  <TrendingUp className="w-3 h-3 mr-0.5" /> {m.change}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Analytics Visual Breakdown Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-slate-900/60 border border-slate-800 p-6 rounded-2xl">
          <h3 className="font-bold text-base mb-4">Conversations by Channel</h3>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs mb-1 font-medium">
                <span className="text-sky-400">Telegram Bot (64%)</span>
                <span>798 chats</span>
              </div>
              <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-sky-500 rounded-full" style={{ width: '64%' }}></div>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1 font-medium">
                <span className="text-pink-400">Instagram Direct (36%)</span>
                <span>450 chats</span>
              </div>
              <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-pink-500 rounded-full" style={{ width: '36%' }}></div>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800 p-6 rounded-2xl">
          <h3 className="font-bold text-base mb-4">Customer Language Distribution</h3>
          <div className="space-y-4">
            <div>
              <div className="flex justify-between text-xs mb-1 font-medium">
                <span className="text-emerald-400">Uzbek Latin (58%)</span>
                <span>724 users</span>
              </div>
              <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full" style={{ width: '58%' }}></div>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1 font-medium">
                <span className="text-purple-400">Russian (32%)</span>
                <span>400 users</span>
              </div>
              <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-purple-500 rounded-full" style={{ width: '32%' }}></div>
              </div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1 font-medium">
                <span className="text-amber-400">English (10%)</span>
                <span>124 users</span>
              </div>
              <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 rounded-full" style={{ width: '10%' }}></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
