'use client';

import React, { useState, useEffect } from 'react';
import { MessageSquare, Bot, UserCheck, ShieldAlert, Filter, Send, RefreshCw, User, Tag, Sparkles } from 'lucide-react';

interface Conversation {
  id: string;
  full_name: string;
  channel: 'telegram' | 'instagram';
  status: string;
  mode: 'auto' | 'approval' | 'suggestion' | 'human';
  detected_language: string;
  detected_intent: string;
  lead_score: number;
  last_message: string;
  last_message_at: string;
}

export default function InboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [messageInput, setMessageInput] = useState<string>('');

  useEffect(() => {
    // Mock initial demo data if database is empty for visual demonstration
    const mockData: Conversation[] = [
      {
        id: '1',
        full_name: 'Anvar Karimov',
        channel: 'telegram',
        status: 'human_attention_required',
        mode: 'human',
        detected_language: 'uz',
        detected_intent: 'refund_request',
        lead_score: 85,
        last_message: 'Manga pulimni qaytarib beringlar, mahsulot yoqmasdi.',
        last_message_at: '01:45',
      },
      {
        id: '2',
        full_name: 'Elena Smirnova',
        channel: 'instagram',
        status: 'ai_handling',
        mode: 'auto',
        detected_language: 'ru',
        detected_intent: 'price_inquiry',
        lead_score: 90,
        last_message: 'Здравствуйте! Сколько стоит доставка в Ташкент?',
        last_message_at: '01:42',
      },
      {
        id: '3',
        full_name: 'John Doe',
        channel: 'telegram',
        status: 'qualified_lead',
        mode: 'auto',
        detected_language: 'en',
        detected_intent: 'product_inquiry',
        lead_score: 95,
        last_message: 'I want to purchase 5 units of your premium software tier.',
        last_message_at: '01:30',
      },
    ];
    setConversations(mockData);
    setSelectedConv(mockData[0]);
  }, []);

  const handleModeToggle = (newMode: 'auto' | 'human') => {
    if (!selectedConv) return;
    const updated = { ...selectedConv, mode: newMode, status: newMode === 'human' ? 'human_handling' : 'ai_handling' };
    setSelectedConv(updated);
    setConversations(prev => prev.map(c => c.id === updated.id ? updated : c));
  };

  const filteredConversations = conversations.filter(c => {
    if (activeFilter === 'attention') return c.status === 'human_attention_required';
    if (activeFilter === 'telegram') return c.channel === 'telegram';
    if (activeFilter === 'instagram') return c.channel === 'instagram';
    return true;
  });

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      {/* Sidebar Navigation */}
      <aside className="w-64 border-r border-slate-800 bg-slate-900/50 p-4 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-2 mb-8 px-2">
            <div className="w-9 h-9 rounded-lg bg-sky-500 flex items-center justify-center font-bold text-white shadow-lg shadow-sky-500/30">
              Y
            </div>
            <div>
              <h1 className="font-bold text-base leading-none">YDeck Operator</h1>
              <span className="text-xs text-sky-400 font-medium">AI Omni-Agent v1.0</span>
            </div>
          </div>

          <nav className="space-y-1">
            <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <MessageSquare className="w-4 h-4" /> Shared Inbox
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 transition">
              <Bot className="w-4 h-4" /> Knowledge Base
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 transition">
              <UserCheck className="w-4 h-4" /> Leads & CRM
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 transition">
              <Sparkles className="w-4 h-4" /> Analytics
            </button>
          </nav>
        </div>

        <div className="p-3 bg-slate-800/40 rounded-xl border border-slate-800 text-xs text-slate-400">
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold text-slate-300">Workspace</span>
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Active</span>
          </div>
          <p className="truncate font-mono">Tashkent Store Hub</p>
        </div>
      </aside>

      {/* Conversation Thread List */}
      <section className="w-96 border-r border-slate-800 bg-slate-900/30 flex flex-col">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="font-bold text-lg">Inbox Threads</h2>
          <button className="p-2 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Filter Pills */}
        <div className="px-4 py-3 flex gap-2 overflow-x-auto border-b border-slate-800/50 text-xs">
          <button onClick={() => setActiveFilter('all')} className={`px-2.5 py-1 rounded-full border transition ${activeFilter === 'all' ? 'bg-sky-500 border-sky-500 text-white' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}>All</button>
          <button onClick={() => setActiveFilter('attention')} className={`px-2.5 py-1 rounded-full border transition ${activeFilter === 'attention' ? 'bg-rose-500 border-rose-500 text-white' : 'border-rose-900/50 text-rose-400 hover:bg-rose-950/30'}`}>Human Needed</button>
          <button onClick={() => setActiveFilter('telegram')} className={`px-2.5 py-1 rounded-full border transition ${activeFilter === 'telegram' ? 'bg-sky-600 border-sky-600 text-white' : 'border-slate-700 text-slate-400'}`}>Telegram</button>
          <button onClick={() => setActiveFilter('instagram')} className={`px-2.5 py-1 rounded-full border transition ${activeFilter === 'instagram' ? 'bg-pink-600 border-pink-600 text-white' : 'border-slate-700 text-slate-400'}`}>Instagram</button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-800/40">
          {filteredConversations.map(conv => (
            <div
              key={conv.id}
              onClick={() => setSelectedConv(conv)}
              className={`p-4 cursor-pointer transition flex flex-col gap-2 ${selectedConv?.id === conv.id ? 'bg-slate-800/80 border-l-4 border-sky-500' : 'hover:bg-slate-900/80'}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm text-slate-200">{conv.full_name}</span>
                <span className="text-xs text-slate-500 font-mono">{conv.last_message_at}</span>
              </div>

              <p className="text-xs text-slate-400 line-clamp-1">{conv.last_message}</p>

              <div className="flex items-center justify-between text-[11px] pt-1">
                <span className={`px-2 py-0.5 rounded-full font-medium ${conv.channel === 'telegram' ? 'bg-sky-500/10 text-sky-400' : 'bg-pink-500/10 text-pink-400'}`}>
                  {conv.channel.toUpperCase()}
                </span>
                
                <span className={`px-2 py-0.5 rounded-full font-semibold ${conv.mode === 'human' ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'}`}>
                  {conv.mode === 'human' ? 'HUMAN OPERATOR' : 'AI AUTO'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Selected Conversation Detail & Chat Composer */}
      {selectedConv ? (
        <main className="flex-1 flex flex-col bg-slate-950">
          {/* Top Bar Header */}
          <header className="p-4 border-b border-slate-800 bg-slate-900/40 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-300 font-bold">
                {selectedConv.full_name[0]}
              </div>
              <div>
                <h3 className="font-bold text-base">{selectedConv.full_name}</h3>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span>Language: <strong className="uppercase text-sky-400">{selectedConv.detected_language}</strong></span>
                  <span>•</span>
                  <span>Intent: <strong className="text-slate-200">{selectedConv.detected_intent}</strong></span>
                </div>
              </div>
            </div>

            {/* AI vs Human Mode Control Toggle */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400 font-medium">Control Mode:</span>
              <div className="bg-slate-900 p-1 rounded-xl border border-slate-800 flex gap-1">
                <button
                  onClick={() => handleModeToggle('auto')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${selectedConv.mode === 'auto' ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/20' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  <Bot className="w-3.5 h-3.5" /> AI Auto
                </button>
                <button
                  onClick={() => handleModeToggle('human')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${selectedConv.mode === 'human' ? 'bg-rose-500 text-white shadow-md shadow-rose-500/20' : 'text-slate-400 hover:text-slate-200'}`}
                >
                  <User className="w-3.5 h-3.5" /> Human Takeover
                </button>
              </div>
            </div>
          </header>

          {/* Attention Banner if Escalated */}
          {selectedConv.status === 'human_attention_required' && (
            <div className="bg-rose-950/60 border-b border-rose-800/80 px-4 py-2.5 flex items-center justify-between text-xs text-rose-200">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-rose-400 animate-pulse" />
                <span><strong>Attention Required:</strong> AI auto-escalated this conversation (Refund request / Low confidence).</span>
              </div>
              <button onClick={() => handleModeToggle('human')} className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white font-semibold rounded-md transition">
                Take Control Now
              </button>
            </div>
          )}

          {/* Chat Messages Log */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            <div className="flex justify-start">
              <div className="bg-slate-800 border border-slate-700/60 p-3.5 rounded-2xl rounded-tl-none max-w-lg text-sm text-slate-200 shadow-sm">
                <p>{selectedConv.last_message}</p>
                <span className="text-[10px] text-slate-500 block mt-1">{selectedConv.last_message_at}</span>
              </div>
            </div>

            <div className="flex justify-end">
              <div className="bg-sky-600/90 p-3.5 rounded-2xl rounded-tr-none max-w-lg text-sm text-white shadow-sm shadow-sky-600/20">
                <p>[AI Agent] Uzbek Latin answer generated from Knowledge Base context.</p>
                <span className="text-[10px] text-sky-200 block mt-1">01:46 • Confidence 98%</span>
              </div>
            </div>
          </div>

          {/* Operator Reply Composer */}
          <footer className="p-4 border-t border-slate-800 bg-slate-900/50">
            <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl p-2 focus-within:border-sky-500 transition">
              <input
                type="text"
                placeholder={selectedConv.mode === 'auto' ? "AI is responding automatically (Switch to Human Takeover to send manual replies)..." : "Type your message as Human Operator..."}
                disabled={selectedConv.mode === 'auto'}
                value={messageInput}
                onChange={e => setMessageInput(e.target.value)}
                className="flex-1 bg-transparent px-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none disabled:opacity-50"
              />
              <button
                disabled={selectedConv.mode === 'auto' || !messageInput.trim()}
                className="p-2.5 rounded-lg bg-sky-500 text-white hover:bg-sky-400 disabled:bg-slate-800 disabled:text-slate-600 transition"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </footer>
        </main>
      ) : (
        <main className="flex-1 flex items-center justify-center text-slate-500 text-sm">
          Select a conversation from the left to start responding
        </main>
      )}
    </div>
  );
}
